#!/usr/bin/env node
'use strict';
/**
 * hmcsm —— HMCS 的统一命令行入口
 *
 *   hmcsm                      打开服务管理（安装）菜单
 *   hmcsm --port 8800          以「服务」方式启动，端口写进配置
 *   hmcsm --host 0.0.0.0       同上，允许外部访问（需先设密码）
 *   hmcsm stop|start|restart|status|install|uninstall|enable|disable|open
 *
 * 两条硬规则：
 *   1. 无参数 → 调起安装/服务管理菜单，不启动任何进程；
 *   2. 有参数 → 交给服务管理器拉起（Windows 计划任务 / systemd / launchd），
 *      或退化成独立后台进程。**绝不在当前终端前台跑**，
 *      所以关掉这个窗口不会把控制面板一起带走。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app.js');
const SERVICE = path.join(__dirname, 'service.js');
const NODE = process.execPath;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ------------------------------------------------------------------ 输出
const paint = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: s => paint('1', s), dim: s => paint('2', s),
  green: s => paint('32', s), yellow: s => paint('33', s),
  cyan: s => paint('36', s), red: s => paint('31', s),
};
const say = s => console.log(s === undefined ? '' : s);
const ok = s => say('  ' + c.green('✓') + ' ' + s);
const warn = s => say('  ' + c.yellow('!') + ' ' + s);
const bad = s => say('  ' + c.red('×') + ' ' + s);
const dim = s => c.dim(s);

// ------------------------------------------------------------------ 参数
/**
 * --home 必须在 require('../lib/paths') 之前落进环境变量，
 * 否则配置目录已经按默认位置算完了。
 */
function preParseHome(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--home') {
      const v = argv[i + 1];
      if (v) process.env.HMCS_HOME = path.resolve(v);
    } else if (a.startsWith('--home=')) {
      const v = a.slice('--home='.length);
      if (v) process.env.HMCS_HOME = path.resolve(v);
    }
  }
}
preParseHome(process.argv.slice(2));

const paths = require('../lib/paths');
const pkg = require('../package.json');

const SUBCOMMANDS = new Set([
  'install', 'uninstall', 'start', 'stop', 'restart',
  'enable', 'disable', 'status', 'open', 'menu',
]);

/** 只摘出需要落盘的项，其余原样透传给 app.js */
function parseBoot(argv) {
  const o = { port: 0, host: '', home: '', pass: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : null;
    const val = () => (inline !== null ? inline : (argv[++i] || ''));
    if (key === '--port' || key === '-p') o.port = Number(val());
    else if (key === '--host' || key === '-H') o.host = val();
    else if (key === '--home') o.home = val();
    else o.pass.push(a);
  }
  return o;
}

const isLoopback = h => h === '127.0.0.1' || h === '::1' || h === 'localhost';

// 自测用：强制跳过「注册系统服务」这条路，直接走后台进程，
// 免得跑一次测试就往机器上装一个 systemd unit / 计划任务。
const NO_SERVICE = process.env.HMCS_NO_SERVICE === '1';

// ------------------------------------------------------------------ 小程序
const sleep = ms => new Promise(r => setTimeout(r, ms));

function runService(args, { inherit = true } = {}) {
  return spawnSync(process.execPath, [SERVICE, ...args], {
    cwd: ROOT,
    stdio: inherit ? 'inherit' : 'pipe',
    encoding: 'utf8',
    timeout: 180000,
  });
}

/** 机器可读的现状：装没装、跑没跑、有没有权限装 */
function probe() {
  const r = runService(['status', '--json'], { inherit: false });
  const out = String((r && r.stdout) || '').trim();
  const last = out.split(/\r?\n/).filter(Boolean).pop() || '';
  try {
    const o = JSON.parse(last);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

function ping(port, host) {
  const h = (!host || host === '0.0.0.0' || host === '::' || host === '[::]') ? '127.0.0.1' : host;
  return new Promise(resolve => {
    const req = http.get({ host: h, port, path: '/api/system/ping', timeout: 1200 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function httpJson(port, pathname, timeout = 2000) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function waitUp(port, host, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await ping(port, host)) return true;
    await sleep(400);
  }
  return false;
}

function isAdmin() {
  if (!IS_WIN) return typeof process.getuid === 'function' && process.getuid() === 0;
  const flt = spawnSync('fltmc', [], { encoding: 'utf8', windowsHide: true });
  if (flt.status === 0) return true;
  const net = spawnSync('net', ['session'], { encoding: 'utf8', windowsHide: true, shell: true });
  return net.status === 0;
}

// ------------------------------------------------------------------ 无参数：调起安装菜单
function openMenu() {
  if (IS_WIN && !isAdmin()) {
    // 菜单第一项就是「安装服务」，那一步需要写计划任务，普通权限必然失败。
    // 直接提权开一个新窗口跑菜单，省得用户点进去报错再回来。
    const q = s => String(s).replace(/'/g, "''");
    const ps = `Start-Process -FilePath '${q(NODE)}' ` +
      `-ArgumentList '"${q(SERVICE)}"','menu' -Verb RunAs`;
    say('  ' + dim('安装 / 卸载服务需要管理员权限，正在请求提权…'));
    say('  ' + dim('（弹出「用户账户控制」时请点「是」）'));
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
    });
    if (r.status === 0) {
      say('');
      ok('已在管理员窗口打开服务管理');
      say('');
      return 0;
    }
    warn('没有提权成功（点了「否」，或这台机器不允许 UAC 提权），改在当前窗口打开');
    say('  ' + dim('当前窗口不是管理员，安装 / 卸载那两项会失败。'));
  }
  const r = runService(['menu']);
  return r.status === null ? 0 : r.status;
}

// ------------------------------------------------------------------ 有参数：以服务方式启动
function applySettings(boot) {
  const patch = {};
  if (Number.isFinite(boot.port) && boot.port > 0) {
    if (boot.port > 65535) {
      bad('端口超出范围：' + boot.port);
      return { error: 'bad-port' };
    }
    patch.port = boot.port;
  }
  if (boot.host) patch.host = boot.host;
  if (!Object.keys(patch).length) return { changed: false, settings: paths.readSettings() };

  const next = { ...paths.readSettings(), ...patch };
  // 和 app.js 的启动检查保持一致，不然注册完服务才现场报错，更难查
  if (!isLoopback(next.host) && !(next.auth && next.auth.enabled)) {
    bad(`要监听 ${next.host}，但还没设置访问密码 —— 程序会拒绝启动（管理面板不能裸奔到公网）。`);
    say('  先运行 ' + c.cyan('hmcsm') + ' 打开管理界面设密码，再回来加 --host。');
    return { error: 'no-password' };
  }
  paths.writeSettings(patch);
  return { changed: true, settings: next };
}

/** 服务路径走不通时的退路：脱离终端的独立进程，关窗口不影响 */
function spawnDetached(boot, settings) {
  const port = settings.port || 8720;
  const args = [APP];
  if (boot.port) args.push('--port', String(boot.port));
  if (boot.host) args.push('--host', boot.host);
  if (boot.home) args.push('--home', boot.home);
  args.push(...boot.pass);
  if (!args.includes('--log-file')) args.push('--log-file');

  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: ROOT,
      // detached + ignore：新进程不挂在当前控制台上，
      // Windows 上是 DETACHED_PROCESS，POSIX 上是 setsid，关终端不会收到 SIGHUP。
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, HMCS_BACKGROUND: '1' },
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  child.unref();

  try {
    fs.mkdirSync(paths.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(paths.CONFIG_DIR, 'background.pid'),
      JSON.stringify({ pid: child.pid, port, host: settings.host, startedAt: new Date().toISOString() }, null, 2),
      { encoding: 'utf8', mode: 0o600 });
  } catch { /* 只读目录不影响运行 */ }

  return { ok: true, pid: child.pid, port };
}

function tailLog(lines = 12) {
  const f = path.join(paths.DATA_DIR, 'logs', 'manager.log');
  try {
    const text = fs.readFileSync(f, 'utf8').trimEnd().split('\n');
    return text.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function printReady({ port, host, mode, info, already }) {
  const urls = (info && Array.isArray(info.urls) && info.urls.length)
    ? info.urls
    : [`http://127.0.0.1:${port}`];
  const lan = urls.filter(u => !/\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(u));
  say('');
  ok('HMCS ' + (already ? '已在运行' : '已启动') + '（' + mode + '）');
  say('  访问      ' + c.bold(urls[0]));
  if (lan.length) say('  局域网    ' + lan.join('  '));
  if (info && info.auth && info.auth.enabled) say('  密码      ' + c.green('已启用（远程访问需要登录）'));
  say('  停止      ' + c.cyan('hmcsm stop'));
  say('  状态      ' + c.cyan('hmcsm status'));
  if (info && info.logFile) say('  日志      ' + info.logFile);
  say('');
  say('  ' + dim('这个窗口可以关掉，服务不会跟着退出。'));
  say('');
}

async function bootByService(boot, settings) {
  const port = Number(settings.port) || 8720;
  const host = String(settings.host || '127.0.0.1');
  const p = probe();

  // 已经按这个端口在跑 → 不折腾
  if (p && p.up && Number(p.bind && p.bind.port) === port && String(p.bind && p.bind.host) === host) {
    printReady({
      port, host, already: true,
      mode: p.installed ? p.kind : '独立后台进程',
      info: await httpJson(port, '/api/system/info'),
    });
    return 0;
  }

  if (NO_SERVICE) {
    return startDetached(boot, settings, port, host, '按 HMCS_NO_SERVICE 要求跳过了系统服务');
  }

  if (p && p.installed) {
    // 服务处于 active 就 restart：改了端口时 start 是空操作，
    // 旧进程会一直蹲在老端口上，看起来像「设置没生效」。
    const running = p.running || p.up;
    say(running ? '  已注册为系统服务，交给它重启…' : '  已注册为系统服务，正在启动…');
    const r = running ? runService(['restart']) : runService(['start']);
    if (!(await waitUp(port, host, 25))) {
      bad('服务操作完成，但 ' + port + ' 端口没有响应');
      const t = tailLog();
      if (t) say(c.dim(t));
      else say('  看日志：' + path.join(paths.DATA_DIR, 'logs', 'manager.log'));
      return 1;
    }
    printReady({ port, host, mode: (probe() || p).kind, info: await httpJson(port, '/api/system/info') });
    return 0;
  }

  // 还没注册：先看这个身份有没有权限装（Windows 装计划任务要管理员），
  // 没权限就别去撞一鼻子灰，直接走后台进程
  if (p && p.canInstall === false) {
    return startDetached(boot, settings, port, host,
      IS_WIN ? '没有管理员权限，注册不了系统服务（开机自启也会失效）' : '当前身份注册不了系统服务');
  }

  say('  还没有注册系统服务，正在注册…');
  const inst = runService(['install', '--yes']);
  if (inst.status === 0 && await waitUp(port, host, 30)) {
    const after = probe();
    printReady({ port, host, mode: (after && after.kind) || '系统服务', info: await httpJson(port, '/api/system/info') });
    return 0;
  }

  return startDetached(boot, settings, port, host, '系统服务注册失败');
}

/** 服务路径走不通时的退路：这个窗口关掉也不会带走进程 */
async function startDetached(boot, settings, port, host, reason) {
  const bg = spawnDetached(boot, settings);
  if (!bg.ok) {
    bad('后台启动失败：' + bg.error);
    return 1;
  }
  if (!(await waitUp(port, host, 25))) {
    bad('进程已拉起（pid ' + bg.pid + '），但 ' + port + ' 端口没有响应');
    const t = tailLog();
    if (t) say(c.dim(t));
    return 1;
  }
  say('');
  warn(reason || '没有注册成系统服务');
  ok('已作为独立后台进程启动  pid=' + bg.pid);
  if (IS_WIN) say('  ' + dim('要开机自启 / 免登录运行：在「以管理员身份运行」的窗口执行 hmcsm install'));
  printReady({ port, host, mode: '独立后台进程', info: await httpJson(port, '/api/system/info') });
  return 0;
}

// ------------------------------------------------------------------ 帮助
function sayHelp() {
  say(`
HMCS · HYCX MC Server Manager  v${pkg.version}

  hmcsm                         打开服务管理菜单（安装 / 卸载 / 起停 / 自启）
  hmcsm --port 8800             以服务方式启动，端口改存为 8800
  hmcsm --host 0.0.0.0          允许局域网 / 外网访问（必须先设密码）
  hmcsm --port 8800 --host 0.0.0.0

服务命令（等价于 install-service.sh / 安装服务.bat 里的同名项）
  hmcsm install                 注册为系统服务并启动
  hmcsm uninstall               卸载服务（保留配置与实例）
  hmcsm start | stop | restart  启动 / 停止 / 重启
  hmcsm enable | disable        开机自启 开 / 关
  hmcsm status                  查看状态
  hmcsm open                    在浏览器打开管理界面

说明
  无参数进菜单，有参数才启动；启动后进程由服务管理器托管，
  不挂在这个终端下，关窗口不影响。
  配置目录  ${paths.CONFIG_DIR}
  程序目录  ${ROOT}
`);
}

// ------------------------------------------------------------------ 入口
async function main() {
  const argv = process.argv.slice(2);

  if (!argv.length) {
    // 非交互（脚本 / 管道里调用）不要卡在菜单上等输入
    if (!process.stdin.isTTY) {
      const r = runService(['status']);
      return r.status === null ? 0 : r.status;
    }
    return openMenu();
  }

  const head = argv[0].toLowerCase();
  if (head === 'help' || head === '--help' || head === '-h') {
    sayHelp();
    return 0;
  }
  if (head === 'version' || head === '--version' || head === '-v') {
    say(pkg.version);
    return 0;
  }
  // 服务子命令：原样交给 service.js，它才是实现方
  if (SUBCOMMANDS.has(head)) {
    const r = runService(argv);
    return r.status === null ? 0 : r.status;
  }

  const boot = parseBoot(argv);
  const applied = applySettings(boot);
  if (applied.error) return 2;
  if (applied.changed) {
    const s = applied.settings;
    ok('已写入配置：' + (s.host || '127.0.0.1') + ':' + s.port);
  }
  return bootByService(boot, applied.settings);
}

main()
  .then(code => { process.exitCode = code || 0; })
  .catch(e => {
    bad(e && e.message ? e.message : String(e));
    process.exitCode = 1;
  });
