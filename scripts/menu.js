#!/usr/bin/env node
'use strict';
/**
 * HMCS 命令行控制台 —— `hmcsm` 不带参数时进这里。
 *
 * 定位是「遥控器」：每个动作都是一次独立调用
 *   · 服务类动作 → spawnSync(scripts/service.js <子命令>)
 *   · 命令类动作 → spawnSync(scripts/install-cli.js)
 *   · 配置类动作 → 写 settings.json，或调本机运维接口 POST /api/auth/local
 * 所以这个进程什么时候退出都不会影响主进程；主进程没了，这里也能把它重新拉起来。
 *
 * 注意：不要在菜单里 require('../app.js')，那会把面板本身跑进这个终端。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const paths = require('../lib/paths');
const auth = require('../lib/auth');
const firewall = require('../lib/firewall');
const pkg = require('../package.json');
const launch = require('./launch');
const { ask, askHidden, confirm } = require('./prompt');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = path.join(__dirname, 'service.js');
const CLI = path.join(__dirname, 'install-cli.js');
const FWCLI = path.join(__dirname, 'firewall-cli.js');
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
const info = s => say('  ' + c.cyan('·') + ' ' + s);
const line = (ch = '─') => say('  ' + c.dim(ch.repeat(58)));

const logPath = () => path.join(paths.DATA_DIR, 'logs', 'manager.log');
const errText = r => (r && (r.json && r.json.error)) || (r && r.text) || '未知错误';

// ------------------------------------------------------------------ 探测
function runService(args) {
  const r = spawnSync(NODE, [SERVICE, ...args], { cwd: ROOT, stdio: 'inherit', timeout: 240000 });
  return r.status === null ? 0 : r.status;
}

function runCli(args) {
  const r = spawnSync(NODE, [CLI, ...args], { cwd: ROOT, stdio: 'inherit', timeout: 120000 });
  return r.status === null ? 0 : r.status;
}

/** 服务管理器给出的机器可读现状 */
function probe() {
  const r = spawnSync(NODE, [SERVICE, 'status', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  const out = String((r && r.stdout) || '').trim();
  const last = out.split(/\r?\n/).filter(Boolean).pop() || '';
  try {
    const o = JSON.parse(last);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/** 本机 HTTP 调用（带 control token，等价于本机运维身份） */
function api(pathname, { method = 'GET', body = null, port, token = '', timeout = 4000 } = {}) {
  return new Promise(resolve => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = {};
    if (token) headers['x-hmcs-control'] = token;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, timeout, headers }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, text: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, json: null, text: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitUp(port, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const r = await api('/api/system/ping', { port, timeout: 1200 });
    if (r.status === 200 && r.json && r.json.ok) return true;
    await sleep(400);
  }
  return false;
}

/** 一次拿全：配置里的值 + 真正在监听的值 + 服务注册情况 */
async function snapshot() {
  const settings = paths.readSettings();
  const port = Number(settings.port) || 8720;
  const infoRes = await api('/api/system/info', { port, token: auth.controlToken(), timeout: 2500 });
  const d = probe() || {};
  const live = infoRes.status === 200 && infoRes.json && infoRes.json.app ? infoRes.json : null;
  return {
    settings,
    port,
    live,
    bind: live && live.bind ? live.bind : null,
    up: !!live,
    installed: !!d.installed,
    autostart: !!d.autostart,
    kind: d.kind || '',
    canInstall: d.canInstall !== false,
  };
}

const isLoopback = h => paths.isLoopbackHost(h);
const authOf = st => st.settings.auth || {};
const pendingRestart = st => !!st.bind && (pendingHost(st) || pendingPort(st));
const pendingHost = st => String(st.bind.host) !== String(paths.normalizeHost(st.settings.host));
const pendingPort = st => Number(st.bind.port) !== (Number(st.settings.port) || 8720);

// ------------------------------------------------------------------ 状态区
function renderStatus(st) {
  const a = authOf(st);
  const host = paths.normalizeHost(st.settings.host);
  const port = Number(st.settings.port) || 8720;
  const runUrl = st.up && st.bind ? `${st.bind.host}:${st.bind.port}` : '';
  const pwd = a.hash ? (a.enabled ? c.green('已启用') : c.yellow('已设置·未启用')) : c.yellow('未设置');
  const scope = a.onlyRemote === false ? '所有访问都要密码' : '本机免密';
  const svc = st.installed
    ? c.green('已安装') + (st.autostart ? c.green(' · 开机自启') : c.dim(' · 不自启')) + (st.kind ? c.dim('（' + st.kind + '）') : '')
    : c.dim('未安装（当前以独立后台进程运行）');

  say('');
  line();
  say('  ' + c.bold('HYCX MC Server Manager · 命令行控制台') + c.dim('  v' + pkg.version));
  line();
  say('  程序目录  ' + c.dim(ROOT));
  say('  数据目录  ' + c.dim(paths.CONFIG_DIR));
  say('  运行状态  ' + (st.up ? c.green('● 运行中') + '  ' + c.bold(runUrl) : c.dim('○ 未运行')));
  say('  监听配置  ' + c.bold(host + ':' + port) + c.dim('  密码 ' + (a.hash ? '已设' : '未设') + ' · ' + scope));
  say('  访问密码  ' + pwd);
  say('  公网地址  ' + (st.settings.publicUrl ? c.bold(st.settings.publicUrl) : c.dim('未填（按当前 IP + 端口访问）')));
  say('  系统服务  ' + svc);
  say('  防火墙    ' + firewall.describe({ host, port }));
  if (pendingRestart(st)) {
    say('  ' + c.yellow('! 监听配置已改，重启后才生效') + c.dim(`（运行 ${st.bind.host}:${st.bind.port} → 目标 ${host}:${port}）`));
  }
  line();
  say('  ' + c.bold('服务'));
  say('   1) 启动服务            2) 停止服务            3) 重启服务');
  say('  ' + c.bold('系统服务') + c.dim('  注册后开机自动跑，不用登录'));
  say('   4) 安装系统服务        5) 卸载系统服务');
  say('   6) 开启开机自启        7) 关闭开机自启');
  say('  ' + c.bold('hmcsm 命令') + c.dim('  装进 PATH 后任何目录都能直接敲'));
  say('   8) 安装 hmcsm 命令     9) 卸载 hmcsm 命令');
  say('  ' + c.bold('其他'));
  say('  10) 打开管理界面       11) 公网访问与密码      12) 查看详细状态');
  say('  ' + c.dim('  0) 退出'));
  say('');
}

// ------------------------------------------------------------------ 动作：服务
async function actStart(st) {
  if (st.up) { warn('已经在运行：' + st.bind.host + ':' + st.bind.port); return; }
  if (st.installed) { runService(['start']); return; }

  info('服务未安装，改为启动独立后台进程（关掉终端也不影响）…');
  const r = launch.spawnDetached({ port: st.port, host: st.settings.host });
  if (!r.ok) { bad('启动失败：' + r.error); return; }
  if (await waitUp(st.port, 25)) {
    ok(`已启动  pid=${r.pid}  http://127.0.0.1:${st.port}`);
    dimHint(st);
  } else {
    bad('进程已拉起（pid ' + r.pid + '），但 25 秒内端口没响应。看日志：' + logPath());
  }
}

function dimHint(st) {
  if (st.settings.publicUrl) say('    公网    ' + st.settings.publicUrl);
  const lan = [];
  if (!isLoopback(st.settings.host)) {
    for (const a of networkUrls(st.port)) lan.push(a);
  }
  if (lan.length) say('    局域网  ' + lan.join('  '));
  say('  ' + c.dim('  要开机自启：菜单 4) 安装系统服务'));
}

function networkUrls(port) {
  const out = [];
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      out.push(`http://${n.address}:${port}`);
    }
  }
  return out;
}

async function actStop(st) {
  if (!st.up && !st.installed) { warn('当前没有在运行'); return; }
  runService(['stop']);
}

async function actRestart(st) {
  if (!st.up && !st.installed) { await actStart(st); return; }
  if (!st.installed) {
    // 后台进程模式的「重启」= 优雅停 + 再拉一个
    await actStop(st);
    const after = await snapshot();
    if (after.up) { bad('旧进程没停下来，先别重启'); return; }
    await actStart(after);
    return;
  }
  runService(['restart']);
}

async function actInstall(st) {
  if (!st.canInstall) {
    if (IS_WIN) {
      say('  ' + c.dim('安装系统服务需要管理员权限，正在请求提权…'));
      say('  ' + c.dim('（弹出「用户账户控制」时请点「是」）'));
      const code = elevateWin(['install', '--yes']);
      if (code === 0) ok('服务已安装并启动');
      else bad('提权安装没有完成（点了「否」或被策略拦住）。也可以直接右键「以管理员身份运行」→ 安装服务.bat');
      return;
    }
    warn('当前身份装不了系统服务，试试：sudo hmcsm install，或者 hmcsm install --user');
    return;
  }
  runService(['install', '--yes']);
}

async function actUninstall(st) {
  if (!st.installed) { warn('系统服务未安装，无需卸载'); return; }
  if (!(await confirm('  确认卸载系统服务？进程会先停掉，配置与实例文件都保留', false))) { warn('已取消'); return; }
  runService(['uninstall']);
}

async function actEnable(st) {
  if (!st.installed) { warn('还没安装系统服务，先执行 4) 安装系统服务'); return; }
  if (!st.canInstall) { warn('改开机自启需要管理员权限，请在管理员终端里操作'); return; }
  runService(['enable']);
}

async function actDisable(st) {
  if (!st.installed) { warn('还没安装系统服务，本来就不会开机自启'); return; }
  if (!st.canInstall) { warn('改开机自启需要管理员权限，请在管理员终端里操作'); return; }
  runService(['disable']);
}

/** Windows 上单独提权跑一次脚本（只提权这一步，不重开整个菜单） */
function elevateNode(script, args) {
  const q = s => "'" + String(s).replace(/'/g, "''") + "'";
  const argv = [`"${script}"`, ...args.map(a => (/[\s"]/.test(a) ? `"${a}"` : a))];
  const ps = `Start-Process -FilePath ${q(NODE)} -ArgumentList @(${argv.map(q).join(',')}) ` +
    `-Verb RunAs -Wait -WindowStyle Hidden`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', windowsHide: true, timeout: 240000,
  });
  return r.status === null ? 1 : r.status;
}
const elevateWin = args => elevateNode(SERVICE, args);

// ------------------------------------------------------------------ 防火墙
/**
 * 改完公网访问 / 端口后同步防火墙。遥控器不改不了防火墙时，优先让「主机」
 * （正在运行的服务进程，多半是 SYSTEM / root）去写；它也没权限才本地来，
 * Windows 本地权限不够再单独弹一次 UAC 跑 firewall-cli.js sync。
 */
async function applyFirewall(st, host, port) {
  if (st.up) {
    const r = await api('/api/system/firewall', {
      method: 'POST', port: st.bind ? st.bind.port : st.port,
      token: auth.controlToken(), body: { host, port, force: true }, timeout: 15000,
    });
    if (r.status === 200 && r.json && r.json.ok !== false && !r.json.needsPrivilege) {
      showFirewall(r.json);
      return;
    }
  }

  let r = firewall.sync({ host, port, force: true, onLog: s => say('  ' + c.dim(s)) });
  if (r.needsPrivilege && IS_WIN) {
    info('防火墙需要管理员权限，正在请求提权…（UAC 弹窗请点「是」）');
    const args = ['sync', '--host', host, '--port', String(port), '--json'];
    if (process.env.HMCS_HOME) args.push('--home', process.env.HMCS_HOME);
    const code = elevateNode(FWCLI, args);
    const after = firewall.status({ host, port });
    if (code === 0 && after.state.port === Number(port)) {
      ok(`防火墙已放行 TCP ${port}（规则 ${firewall.RULE_NAME}）`);
      return;
    }
  }
  showFirewall(r);
}

function showFirewall(r) {
  if (!r) return;
  if (r.ok === false || r.needsPrivilege) {
    warn(r.warning || r.error || '防火墙未能自动放行，外部可能仍连不上');
    for (const h of r.manual || []) say('      ' + c.dim(h));
    info(IS_WIN ? '也可以：在管理员终端里运行  hmcsm firewall sync'
      : '也可以：sudo hmcsm firewall sync');
    return;
  }
  if (r.skipped && !r.changed) { info('防火墙：' + (r.reason || '无需改动')); return; }
  ok('防火墙：' + (r.reason || (r.needed ? '已放行入站' : '已收回放行规则')));
}

// ------------------------------------------------------------------ 动作：命令 / 界面 / 状态
async function actOpen(st) {
  const port = st.up && st.bind ? st.bind.port : st.port;
  const url = `http://127.0.0.1:${port}`;
  try {
    if (IS_WIN) spawnSync('cmd', ['/c', 'start', '', url], { windowsHide: true });
    else if (IS_MAC) spawnSync('open', [url], { stdio: 'ignore' });
    else spawnSync('xdg-open', [url], { stdio: 'ignore' });
    ok('已在浏览器打开 ' + url);
  } catch {
    info('请手动打开 ' + url);
  }
}

// ------------------------------------------------------------------ 公网访问与密码
async function actAccess() {
  for (;;) {
    const st = await snapshot();
    const a = authOf(st);
    const host = paths.normalizeHost(st.settings.host);
    const port = Number(st.settings.port) || 8720;

    say('');
    line('·');
    say('  ' + c.bold('公网访问与密码'));
    line('·');
    say('  监听地址  ' + c.bold(host + ':' + port) +
      (st.up ? c.dim('   正在运行 ' + st.bind.host + ':' + st.bind.port) : c.dim('   未运行')));
    say('  访问密码  ' + (a.hash
      ? (a.enabled ? c.green('已设置 · 校验开启') : c.yellow('已设置 · 校验关闭'))
      : c.yellow('未设置')));
    say('  免密范围  ' + (a.onlyRemote === false ? '所有访问都要密码' : '仅非本机需要密码（本机 ' + c.dim('127.0.0.1') + ' 免密）'));
    say('  公网地址  ' + (st.settings.publicUrl ? c.bold(st.settings.publicUrl) : c.dim('未填（按当前 IP + 端口访问）')));
    if (pendingRestart(st)) say('  ' + c.yellow('! 监听配置已改，需要重启才生效'));
    say('');
    say('   1) 设置 / 修改访问密码');
    say('   2) 关闭密码访问（清空密码）');
    say('   3) ' + (a.enabled ? '关闭密码校验（保留密码）' : '开启密码校验'));
    say('   4) ' + (a.onlyRemote === false ? '改成「仅非本机需要密码」' : '改成「所有访问都要密码」'));
    say('   5) 监听地址改为 ' + (isLoopback(host) ? '所有网络 0.0.0.0' : '仅本机 127.0.0.1'));
    say('   6) 修改端口（当前 ' + port + '）');
    say('   7) 同步防火墙规则（' + firewall.describe({ host, port }) + '）');
    say('   8) ' + (st.settings.publicUrl ? '修改公网访问地址' : '设置公网访问地址（域名）'));
    say('  ' + c.dim('  0) 返回主菜单'));
    say('');

    const a1 = (await ask('  选择：')).toLowerCase();
    if (!a1 || a1 === '0' || a1 === 'q') return;

    try {
      if (a1 === '1') await setPassword(st);
      else if (a1 === '2') await clearPassword(st);
      else if (a1 === '3') await setEnabled(st, !a.enabled);
      else if (a1 === '4') await setOnlyRemote(st, a.onlyRemote === false);
      else if (a1 === '5') await setHost(st);
      else if (a1 === '6') await setPort(st);
      else if (a1 === '7') await applyFirewall(st, host, port);
      else if (a1 === '8') await setPublicUrl(st);
      else warn('没有这个选项');
    } catch (e) {
      bad(e.message || String(e));
    }
  }
}

/** 调本机运维接口；服务没在跑时直接改配置文件 */
async function applyAuth(st, body, okText) {
  if (st.up) {
    const r = await api('/api/auth/local', {
      method: 'POST', body, port: st.bind ? st.bind.port : st.port, token: auth.controlToken(),
    });
    if (r.status === 200) { ok(okText + '（已立即生效，旧登录会话全部失效）'); return true; }
    if (r.status !== 0) { bad(errText(r)); return false; }
    warn('连不上正在运行的实例（' + errText(r) + '），改为直接写配置文件');
  }

  const cur = paths.readSettings().auth || {};
  const next = { ...cur, updatedAt: new Date().toISOString() };
  if (body.clear === true) { next.hash = ''; next.enabled = false; }
  if (body.password !== undefined) { next.hash = auth.hashPassword(String(body.password)); next.enabled = true; }
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (typeof body.onlyRemote === 'boolean') next.onlyRemote = body.onlyRemote;

  paths.writeSettings({ auth: next });
  if (body.password !== undefined || body.clear === true || body.enabled === false) dropSessions();
  ok(okText + (st.up ? '（下次校验即生效）' : '（下次启动生效）'));
  return true;
}

/** 服务没在跑时，删掉会话文件，下次启动就是干净的 */
function dropSessions() {
  try { fs.unlinkSync(path.join(paths.CONFIG_DIR, 'sessions.json')); } catch { /* 本来就没有 */ }
}

async function setPassword(st) {
  const pw = await askHidden('  新密码（不回显）：');
  if (!pw) { warn('已取消'); return; }
  const again = await askHidden('  再输一次：');
  if (pw !== again) { bad('两次输入不一致，未做修改'); return; }
  const pol = auth.checkPasswordPolicy(pw);
  if (!pol.ok) { bad(pol.reason); return; }
  await applyAuth(st, { password: pw }, '访问密码已更新');
}

async function clearPassword(st) {
  const a = authOf(st);
  if (!a.hash && !a.enabled) { warn('本来就没设密码'); return; }
  if (!isLoopback(paths.normalizeHost(st.settings.host))) {
    bad('当前监听地址不是「仅本机」。先改成 127.0.0.1（选项 5），再清密码，否则程序下次启动会被安全检查拒绝');
    return;
  }
  if (!(await confirm('  确认清空密码？之后本机以外的访问会完全放开', false))) { warn('已取消'); return; }
  await applyAuth(st, { clear: true }, '密码已清除');
}

async function setEnabled(st, on) {
  const a = authOf(st);
  if (on && !a.hash) { bad('还没有密码，先执行 1) 设置 / 修改访问密码'); return; }
  await applyAuth(st, { enabled: on }, on ? '密码校验已开启' : '密码校验已关闭（密码仍保留）');
}

async function setOnlyRemote(st, on) {
  await applyAuth(st, { onlyRemote: on },
    on ? '已改为「仅非本机需要密码」' : '已改为「所有访问都要密码」（含本机）');
}

async function setHost(st) {
  const cur = paths.normalizeHost(st.settings.host);
  const target = isLoopback(cur) ? '0.0.0.0' : '127.0.0.1';
  const a = authOf(st);

  if (target === '0.0.0.0' && !(a.hash && a.enabled)) {
    bad('对外开放必须先有密码：先执行 1) 设置 / 修改访问密码（或 3) 开启密码校验）');
    return;
  }
  if (target === '0.0.0.0') {
    say('  ' + c.yellow('  注意：') + '改完之后局域网 / 公网都能访问这个面板，非本机访问需要登录。');
  }
  paths.writeSettings({ host: target });
  ok('监听地址已保存为 ' + target);
  await applyFirewall(st, target, port);
  await offerRestart(st);
}

async function setPort(st) {
  const cur = Number(st.settings.port) || 8720;
  const raw = await ask('  新端口（1-65535，回车取消）：');
  if (!raw) { warn('已取消'); return; }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) { bad('端口必须是 1-65535 的整数'); return; }
  if (n === cur) { warn('和当前端口一样，没改'); return; }
  if (n < 1024 && !(IS_WIN)) { warn('1024 以下的端口需要 root 权限，普通用户启动会失败'); }
  if (n < 1024 && IS_WIN) { warn('1024 以下的端口通常需要管理员权限'); }
  paths.writeSettings({ port: n });
  ok('端口已保存为 ' + n + '（原 ' + cur + '）');
  await applyFirewall(st, paths.normalizeHost(st.settings.host), n);
  await offerRestart(st);
}

/**
 * 公网访问地址（域名 / 反代）。
 * 只用来显示和「重启后跳到哪」，不参与监听，所以直接写配置文件、不需要重启；
 * 界面下次拉 bootstrap 就会读到新值。
 */
async function setPublicUrl(st) {
  const cur = st.settings.publicUrl || '';
  say('  ' + c.dim('填对外的域名或反向代理地址，例如 mc.example.com、https://mc.example.com；'));
  say('  ' + c.dim('只影响「显示哪个地址」和「改端口重启后跳到哪」，不改变监听，保存即生效。'));
  const raw = await ask('  公网地址' + (cur ? `（当前 ${cur}，回车保留，输入 - 清除）：` : '（回车取消）：'));
  if (!raw) { warn('已取消'); return; }
  if (raw.trim() === '-' || raw.trim() === '0') {
    paths.writeSettings({ publicUrl: '' });
    ok('已清除公网地址，之后按当前 IP + 端口访问');
    return;
  }
  let v;
  try { v = paths.normalizePublicUrl(raw); } catch (e) { bad(e.message); return; }
  paths.writeSettings({ publicUrl: v });
  ok('公网访问地址已保存为 ' + v);
  const s2 = paths.readSettings();
  if (isLoopback(paths.normalizeHost(s2.host))) {
    info('当前只听本机。域名要能访问到面板，需要反代指向 127.0.0.1:' + (Number(s2.port) || 8720));
  } else {
    info('确认 DNS 或端口映射把这个域名指到本机的 ' + (Number(s2.port) || 8720) + ' 端口；防火墙已由菜单 7) 处理');
  }
}

/** 配置改了但没生效时，问一句要不要现在重启 */
async function offerRestart(st) {
  const after = await snapshot();
  if (!pendingRestart(after)) { ok('已生效（' + after.bind.host + ':' + after.bind.port + ' 就是新配置）'); return; }
  if (!after.up) { info('当前没在运行，下次启动就是新配置'); return; }

  const old = after.bind.host + ':' + after.bind.port;
  const next = paths.normalizeHost(after.settings.host) + ':' + (Number(after.settings.port) || 8720);
  say('');
  warn(`需要重启才生效：现在是 ${old}，目标 ${next}`);
  if (!(await confirm('  现在重启 HMCS？（会先让 Minecraft 服务端存盘退出）', true))) {
    info('稍后可以用菜单 3) 重启服务，或界面里的「立即重启」');
    return;
  }
  if (after.installed) runService(['restart']);
  else {
    await actStop(after);
    const mid = await snapshot();
    if (mid.up) { bad('旧进程没能停下，重启中止'); return; }
    await actStart(mid);
  }
}

// ------------------------------------------------------------------ 主循环
async function runMenu() {
  // 自测 / 脚本化：只渲染一次菜单就退出
  const once = process.env.HMCS_MENU_ONCE === '1';

  for (;;) {
    const st = await snapshot();
    renderStatus(st);

    // 自测 / 截图用：只渲染一次就退，不进输入循环
    if (once) return;

    const a = (await ask('  请输入序号（回车 = 退出）：')).toLowerCase();
    if (!a || a === '0' || a === 'q' || a === 'quit' || a === 'exit') {
      say('  ' + c.dim('再见。主进程不受影响，需要时再敲 hmcsm。'));
      say('');
      return;
    }

    try {
      switch (a) {
        case '1': await actStart(st); break;
        case '2': await actStop(st); break;
        case '3': await actRestart(st); break;
        case '4': await actInstall(st); break;
        case '5': await actUninstall(st); break;
        case '6': await actEnable(st); break;
        case '7': await actDisable(st); break;
        case '8':
          if (runCli(['install']) === 0) ok('之后在任何目录敲 hmcsm 都能用（新开的终端生效）');
          break;
        case '9':
          if (await confirm('  确认把 hmcsm 从 PATH 里移除？（当前窗口仍可用）', false)) {
            runCli(['uninstall']);
            info('已移除。之后可直接运行：node ' + path.join('scripts', 'hmcsm.js'));
          } else warn('已取消');
          break;
        case '10': await actOpen(st); break;
        case '11': await actAccess(); break;
        case '12': runService(['status']); break;
        default: warn('没有这个选项');
      }
    } catch (e) {
      bad(e.message || String(e));
    }
  }
}

module.exports = {
  runMenu,
  // 给自测用的原子动作
  actions: {
    snapshot, setPassword, clearPassword, setEnabled, setOnlyRemote, setHost, applyAuth, offerRestart,
  },
};

if (require.main === module) {
  runMenu().catch(e => {
    bad(e && e.message ? e.message : String(e));
    process.exitCode = 1;
  });
}
