#!/usr/bin/env node
'use strict';
/**
 * HMCS 服务管理（Windows 计划任务 / Linux systemd / macOS launchd）
 *
 * 用法：
 *   node scripts/service.js            交互菜单
 *   node scripts/service.js install    注册服务并启动
 *   node scripts/service.js uninstall  卸载服务
 *   node scripts/service.js start|stop|restart
 *   node scripts/service.js enable|disable   开机自启开关
 *   node scripts/service.js status
 *
 * 选项：
 *   --port N          覆盖监听端口（写进 settings.json，不是启动参数）
 *   --host ADDR       覆盖监听地址，默认沿用 settings.json
 *   --no-autostart    安装后不开机自启
 *   --user            Linux/macOS：装成当前用户的服务（不需要 root）
 *   --system          Linux/macOS：强制系统级服务（需要 root/sudo）
 *
 * 设计说明：
 *   - Windows 没有免依赖的真·服务宿主（写 SCM 需要原生模块）。这里用
 *     「计划任务 + SYSTEM 账户 + ONSTART」，效果等价：开机即起、无窗口、不依赖登录。
 *     同时把 --home 固定成安装者的数据目录，否则 SYSTEM 的 %APPDATA% 会另起一套配置。
 *   - Linux 用 systemd，普通用户可用 --user 模式（配合 linger 实现开机自启）。
 *   - 停止一律先走 HTTP 优雅关闭，让 Minecraft 服务端把存档写完，再兜底强杀。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');
const INSTALL = require('./install-state');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app.js');
const NODE = process.execPath;

const WIN_TASK = 'HMCS';
const LINUX_UNIT = 'hmcs';
const MAC_LABEL = 'com.hycx.hmcs';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ------------------------------------------------------------------ 参数
function parseArgs(argv) {
  const o = { cmd: '', port: 0, host: '', autostart: true, scope: '', yes: false, dryRun: false, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') o.port = Number(argv[++i]);
    else if (a === '--host') o.host = argv[++i] || '';
    else if (a === '--no-autostart') o.autostart = false;
    else if (a === '--autostart') o.autostart = true;
    else if (a === '--user') o.scope = 'user';
    else if (a === '--system') o.scope = 'system';
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--dry-run') o.dryRun = true;
    // 给 hmcsm 之类的调用方用：只打一行 JSON，别掺人脸面话
    else if (a === '--json') o.json = true;
    else if (!a.startsWith('-')) rest.push(a);
  }
  o.cmd = rest[0] || 'menu';
  return o;
}
const ARGS = parseArgs(process.argv.slice(2));

// ------------------------------------------------------------------ 用户与目录
/**
 * 解析「服务应该以谁的身份跑」。
 * sudo 下 process.getuid() 是 0，但配置目录必须落在真实用户家目录，
 * 否则会凭空多出一份 /root/.config/HMCS。
 */
function resolveOwner() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const sudoUser = String(process.env.SUDO_USER || '').trim();
  if (!IS_WIN && uid === 0 && sudoUser && sudoUser !== 'root') {
    const info = lookupUser(sudoUser);
    if (info) return { ...info, viaSudo: true };
  }
  if (IS_WIN) return { name: process.env.USERNAME || '', home: os.homedir(), uid: -1 };
  return { name: process.env.USER || os.userInfo().username, home: os.homedir(), uid };
}

function lookupUser(name) {
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf8').split('\n');
    for (const line of passwd) {
      const f = line.split(':');
      if (f[0] === name && f.length >= 6) {
        return { name: f[0], home: f[5] || `/home/${f[0]}`, uid: Number(f[2]) };
      }
    }
  } catch { /* 没有 /etc/passwd 就放弃，退回环境变量 */ }
  return null;
}

const OWNER = resolveOwner();
// 让 lib/paths 按真实用户的家目录解析配置位置
if (!IS_WIN && OWNER.home) process.env.HOME = OWNER.home;
const paths = require('../lib/paths');
const pkg = require('../package.json');

const SETTINGS = paths.readSettings();
const CONFIG_DIR = paths.CONFIG_DIR;
const DATA_DIR = paths.DATA_DIR;
const LOG_DIR = path.join(DATA_DIR, 'logs');

/**
 * 服务里写死的启动参数。
 * 装好之后再跑 status/stop，不该再去猜端口——settings.json 里的 port 可能已经被改过，
 * 而正在运行的是注册时那一个。
 */
const STATE_FILE = path.join(CONFIG_DIR, 'service.json');

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; }
}

function writeState(obj) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch { /* 配置目录只读时不影响服务本身 */ }
}

const SAVED = readState();

// 端口 / 监听地址以 settings.json 为准（启动参数里不再带它们）。
// SAVED 是安装时的存档，只作为 settings.json 缺失时的兜底，不能反过来压住新配置。
const PORT = Number(ARGS.port) || Number(SETTINGS.port) || Number(SAVED.port) || 8720;
const HOST = String(ARGS.host || SETTINGS.host || SAVED.host || '127.0.0.1');
const LOCAL_ONLY = HOST === '127.0.0.1' || HOST === '::1';
// systemd 的 --user 只有当前用户能装；root 默认装系统级
const SCOPE = IS_WIN
  ? 'machine'
  : (ARGS.scope || (typeof process.getuid === 'function' && process.getuid() === 0 ? 'system' : 'user'));

// ------------------------------------------------------------------ 权限探测
/** Windows 上 fltmc 需要管理员，非管理员返回 5；net session 依赖 Server 服务，只作兜底 */
function isAdmin() {
  if (IS_WIN) {
    if (run('fltmc', []).code === 0) return true;
    if (run('net', ['session']).code === 0) return true;
    return false;
  }
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function canWriteDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    // 目录还不存在时看最近的已存在祖先
    let cur = dir;
    for (let i = 0; i < 12; i++) {
      cur = path.dirname(cur);
      if (cur === path.dirname(cur)) break;
      if (fs.existsSync(cur)) {
        try { fs.accessSync(cur, fs.constants.W_OK); return true; } catch { return false; }
      }
    }
    return false;
  }
}

/**
 * 当前身份能不能真的把服务装上去。
 * hmcsm 靠这个决定：无参数启动时是「交给服务管理器」还是「退化成独立后台进程」。
 */
function canInstall() {
  if (IS_WIN) return isAdmin();
  if (IS_MAC) return canWriteDir(path.dirname(MAC_PLIST));
  // Linux：系统级要 root，用户级要能写 ~/.config/systemd/user
  return SCOPE === 'system' ? isAdmin() : canWriteDir(UNIT_USER);
}

// ------------------------------------------------------------------ 输出
const useColor = process.stdout.isTTY && (!IS_WIN || !!process.env.WT_SESSION || !!process.env.TERM_PROGRAM);
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: s => paint('1', s),
  dim: s => paint('2', s),
  green: s => paint('32', s),
  yellow: s => paint('33', s),
  red: s => paint('31', s),
  cyan: s => paint('36', s),
};
const say = (...a) => console.log(...a);
const ok = s => say(c.green('✓ ') + s);
const warn = s => say(c.yellow('! ') + s);
const bad = s => say(c.red('✗ ') + s);
const line = () => say(c.dim('─'.repeat(58)));

function die(msg, code = 1) {
  bad(msg);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeout || 30000,
    env: { ...process.env, ...(opts.env || {}) },
    input: opts.input,
  });
  return {
    code: r.status === null ? -1 : r.status,
    out: String(r.stdout || '').trim(),
    err: String(r.stderr || '').trim(),
    error: r.error ? r.error.message : '',
  };
}

/** 需要 sudo 的命令：本身已是 root 就直接跑，否则尝试 sudo -n，最后提示手工执行 */
function runPrivileged(cmd, args) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (uid === 0) return run(cmd, args);
  const r = run('sudo', ['-n', cmd, ...args]);
  if (r.code === 0) return r;
  if (/password|terminal|tty|askpass/i.test(r.err + r.error)) {
    return { code: 127, out: '', err: '需要管理员权限，请用 sudo 重新运行本脚本', error: '' };
  }
  return r;
}

// ------------------------------------------------------------------ HTTP 探活 / 优雅停止
/**
 * 探测端口候选。
 *
 * settings.json 里的端口不一定等于**正在跑**的端口：用户改完端口还没重启服务时，
 * 进程还蹲在旧端口上。只认配置值的话，stop 会以为「没在运行」→ 直接 SIGKILL，
 * Minecraft 存档就白写了。所以把 last-url.txt（程序启动时写的实际地址）也算上。
 */
function lastRunPort() {
  try {
    const u = fs.readFileSync(path.join(CONFIG_DIR, 'last-url.txt'), 'utf8').trim();
    const m = u.match(/:(\d+)\/?$/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}
const PROBE_PORTS = [...new Set([PORT, lastRunPort()].filter(p => Number(p) > 0))];

function httpJson(pathname, { method = 'GET', token = '', timeout = 2500, body = null, port = PORT } = {}) {
  return new Promise(resolve => {
    const headers = {};
    if (token) headers['X-HMCS-Control'] = token;
    let payload = null;
    if (body) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout }, res => {
      const chunks = [];
      res.on('data', ch => chunks.push(ch));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, timeout: true }); });
    req.on('error', () => resolve({ ok: false }));
    if (payload) req.write(payload);
    req.end();
  });
}

function controlToken() {
  try { return fs.readFileSync(path.join(CONFIG_DIR, 'control.token'), 'utf8').trim(); } catch { return ''; }
}

/** 谁在应答就用谁：返回实际端口，都没有则 0 */
async function livePort() {
  for (const p of PROBE_PORTS) {
    const r = await httpJson('/api/system/ping', { timeout: 900, port: p });
    if (r.ok) return p;
  }
  return 0;
}

async function isUp() {
  return (await livePort()) > 0;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ 启动参数
/**
 * 启动参数
 *
 * 端口与监听地址**故意不写进启动参数**：命令行优先级高于 settings.json，
 * 一旦写死，用户在界面里改完设置、点「重启」也还是被老参数压住，
 * 表现就是「设置保存了但永远不生效」。
 * 安装时把 PORT / HOST 写进 settings.json，之后由程序自己读，
 * 界面改动 + 一键重启就能真正生效。
 */
/**
 * 要不要把配置目录钉进启动参数（--home）。
 *
 * Windows：服务跑在 SYSTEM 账户下，%APPDATA% 与安装者不同，必须钉死；
 * 其它平台：只在用了 HMCS_HOME（配置+数据合并到同一个自定义目录）时才需要钉，
 * 因为服务进程里没有这个环境变量。正常情况靠 XDG 自己就能算对 ——
 * 乱钉反而会把 ~/.local/share/HMCS 并到 ~/.config/HMCS，
 * 表现就是「装完服务，原来的实例和存档全不见了」。
 */
const PIN_HOME = IS_WIN || !!String(process.env.HMCS_HOME || '').trim();

function execArgs() {
  const args = [APP, '--log-file'];
  if (PIN_HOME) args.push('--home', CONFIG_DIR);
  return args;
}

function quoteWin(s) { return /[\s"]/.test(s) ? `"${s}"` : s; }

// ================================================================== Windows
const WIN_CACHE = { at: 0, value: null };

const WIN = {
  /** 任务定义文件：纯文件读取，不用外部程序、不用提权，是最硬的存在性证据 */
  taskFilePath() {
    const sysroot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    return path.join(sysroot, 'System32', 'Tasks', WIN_TASK);
  },

  /** true 存在 / false 明确不存在 / null 读不到（权限！不能当成不存在） */
  readTaskFile() {
    try { return fs.statSync(WIN.taskFilePath()).isFile() ? true : false; }
    catch (e) { return e && e.code === 'ENOENT' ? false : null; }
  },

  /**
   * 关键修复：旧代码用 try/catch 把任何异常一律吞成 MISSING，
   * 任何异常（PowerShell 被策略禁用、cmdlet 不存在、权限不足、spawn 失败）
   * 都会被吞成 MISSING，于是「查不了」被当成「没安装」。
   * 现在先确认 cmdlet 存在，再用 SilentlyContinue 区分「任务不存在」与「接口不可用」，
   * 输出固定 ASCII 标记，避开中英文系统本地化差异。
   */
  probePowerShell() {
    const script = "$ErrorActionPreference='SilentlyContinue'; "
      + "if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) { 'HMCS_UNAVAILABLE' } "
      + "else { $t=@(Get-ScheduledTask -TaskName '" + WIN_TASK + "' -ErrorAction SilentlyContinue); "
      + "if ($t.Count -eq 0) { 'HMCS_ABSENT' } else { 'HMCS_STATE=' + $t[0].State } }";
    return INSTALL.parsePowerShellProbe(run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]));
  },

  probeSchtasks() {
    return INSTALL.classifySchtasks(run('schtasks', ['/Query', '/TN', WIN_TASK]));
  },

  /** 多源交叉判定；同一次进程里短缓存，避免 enabled() 连查两次外部命令 */
  resolve() {
    // 自测注入口：用假证据跑完整 CLI 链路，不触发 PowerShell / schtasks。
    // 沙箱和 CI 里这两个外部命令常被策略禁用，注入后仍可验证遥控器显示。
    const fake = String(process.env.HMCS_TEST_TASK_EVIDENCE || '').trim();
    if (fake) {
      try {
        const v = INSTALL.resolveWindowsInstall(JSON.parse(fake));
        WIN_CACHE.value = v;
        WIN_CACHE.at = Date.now();
        return v;
      } catch { /* 无效 JSON 就按真实采集走 */ }
    }
    if (WIN_CACHE.value && Date.now() - WIN_CACHE.at < 800) return WIN_CACHE.value;
    const ps = WIN.probePowerShell();
    const taskFile = WIN.readTaskFile();
    let sch = 'unavailable';
    // 精确状态已拿到、或旁路证据已足够定性时，不再多跑一次外部命令
    if (ps.kind !== 'state' && !(ps.kind === 'absent' && taskFile === false) && taskFile !== true) {
      sch = WIN.probeSchtasks();
    }
    const value = INSTALL.resolveWindowsInstall({ ps, taskFile, saved: SAVED, schtasks: sch });
    WIN_CACHE.value = value;
    WIN_CACHE.at = Date.now();
    return value;
  },

  invalidate() { WIN_CACHE.at = 0; WIN_CACHE.value = null; },

  /** 兼容旧调用点（uninstall/start/hardStop/enabled 都拿它和 'MISSING' 比） */
  state() {
    return WIN.resolve().state;
  },

  install() {
    const tr = [quoteWin(NODE), quoteWin(APP), '--log-file', '--home', quoteWin(CONFIG_DIR)].join(' ');
    const args = ['/Create', '/TN', WIN_TASK, '/TR', tr, '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F'];
    const r = run('schtasks', args);
    if (r.code !== 0) {
      die('注册计划任务失败：' + (r.err || r.out || r.error || '未知错误') +
        '\n  提示：请用「以管理员身份运行」打开终端后重试。');
    }
    WIN.invalidate();
    return true;
  },

  uninstall() {
    if (WIN.state() === 'MISSING') return false;
    run('schtasks', ['/End', '/TN', WIN_TASK]);
    const r = run('schtasks', ['/Delete', '/TN', WIN_TASK, '/F']);
    if (r.code !== 0) throw new Error(r.err || r.out || '删除计划任务失败');
    WIN.invalidate();
    return true;
  },

  start() {
    const st = WIN.state();
    if (st === 'MISSING') throw new Error('服务还没安装，先运行安装');
    const wasDisabled = st === 'Disabled';
    // 禁用状态下无法手动运行：临时启用，跑起来后再恢复禁用（禁用不影响已在运行的实例）
    if (wasDisabled) run('schtasks', ['/Change', '/TN', WIN_TASK, '/ENABLE']);
    const r = run('schtasks', ['/Run', '/TN', WIN_TASK]);
    if (r.code !== 0) {
      if (wasDisabled) run('schtasks', ['/Change', '/TN', WIN_TASK, '/DISABLE']);
      throw new Error(r.err || r.out || '启动失败');
    }
    // 注意不能 unref：否则命令结束后进程立刻退出，这个「恢复禁用」永远不执行，
    // 结果就是「关掉自启」被一次手工启动悄悄改回「开」。
    if (wasDisabled) setTimeout(() => run('schtasks', ['/Change', '/TN', WIN_TASK, '/DISABLE']), 4000);
  },

  hardStop() {
    const st = WIN.state();
    if (st === 'MISSING') return;
    run('schtasks', ['/End', '/TN', WIN_TASK]);
    // 计划任务里的 node 若是被 End 掉，父进程消失后子 Java 可能残留，这里不做额外处理：
    // 优雅关闭路径已经把 Minecraft 停干净了，走到这条分支说明它本来就没响应
  },

  enable() {
    const r = run('schtasks', ['/Change', '/TN', WIN_TASK, '/ENABLE']);
    if (r.code !== 0) throw new Error(r.err || r.out || '开启开机自启失败');
    WIN.invalidate();
  },
  disable() {
    const r = run('schtasks', ['/Change', '/TN', WIN_TASK, '/DISABLE']);
    if (r.code !== 0) throw new Error(r.err || r.out || '关闭开机自启失败');
    WIN.invalidate();
  },
  enabled() {
    return WIN.state() !== 'Disabled' && WIN.state() !== 'MISSING';
  },
  describe() {
    const d = WIN.resolve();
    return {
      installed: d.installed,
      running: d.running,
      autostart: d.installed && d.autostart,
      canInstall: canInstall(),
      raw: d.raw,
      installSource: d.source,
      installUncertain: d.uncertain,
      kind: `计划任务「${WIN_TASK}」（SYSTEM / 开机启动）`,
    };
  },
};

// ================================================================== Linux systemd
const UNIT_SYSTEM = `/etc/systemd/system/${LINUX_UNIT}.service`;
const UNIT_USER = path.join(OWNER.home || os.homedir(), '.config', 'systemd', 'user', `${LINUX_UNIT}.service`);

function unitPath() { return SCOPE === 'system' ? UNIT_SYSTEM : UNIT_USER; }

function systemctl(args) {
  return SCOPE === 'system' ? runPrivileged('systemctl', args) : run('systemctl', ['--user', ...args]);
}

function unitText() {
  const home = OWNER.home || os.homedir();
  const lines = [
    '[Unit]',
    'Description=HYCX MC Server Manager (HMCS)',
    'Documentation=https://github.com/HarryXZX/HMCS-Manager',
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=180',
    'StartLimitBurst=6',
    '',
    '[Service]',
    'Type=simple',
  ];
  if (SCOPE === 'system') lines.push(`User=${OWNER.name}`, `Group=${groupOf(OWNER.name)}`);
  lines.push(
    `WorkingDirectory=${ROOT}`,
    `Environment=HOME=${home}`,
    `Environment=XDG_CONFIG_HOME=${home}/.config`,
    `Environment=XDG_DATA_HOME=${home}/.local/share`,
    `Environment=LANG=${process.env.LANG || 'C.UTF-8'}`,
    `ExecStart=${NODE} ${APP} --log-file${PIN_HOME ? ' --home "' + CONFIG_DIR + '"' : ''}`,
    // 用 always 而不是 on-failure：界面上的「一键重启」在 systemd 下是主动 exit(0)，
    // 交给 systemd 拉起；on-failure 会把它当成正常退出，服务就再也不回来了。
    'Restart=always',
    'RestartSec=5',
    // 退出码 2 = 配置错误（端口占用、对外监听没密码），重启也没用，别死循环
    'RestartPreventExitStatus=2',
    'KillSignal=SIGTERM',
    // 优雅关闭会依次等待 Minecraft 写盘，60 秒兜底留 75 秒
    'TimeoutStopSec=80',
    'KillMode=mixed',
    'LimitNOFILE=65535',
    '',
    '[Install]',
    SCOPE === 'system' ? 'WantedBy=multi-user.target' : 'WantedBy=default.target',
    '',
  );
  return lines.join('\n');
}

function groupOf(user) {
  try {
    const r = run('id', ['-gn', user]);
    if (r.code === 0 && r.out) return r.out.trim();
  } catch { /* ignore */ }
  return user;
}

const LINUX = {
  install() {
    const target = unitPath();
    const text = unitText();
    const dir = path.dirname(target);
    if (SCOPE === 'system') {
      const mk = runPrivileged('mkdir', ['-p', dir]);
      if (mk.code !== 0) throw new Error(mk.err || '无法创建目录 ' + dir);
      const tmp = path.join(os.tmpdir(), `hmcs-${Date.now()}.service`);
      fs.writeFileSync(tmp, text, 'utf8');
      const cp = runPrivileged('cp', [tmp, target]);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      if (cp.code !== 0) throw new Error(cp.err || '写入 unit 文件失败');
      runPrivileged('chmod', ['644', target]);
      const rl = runPrivileged('systemctl', ['daemon-reload']);
      if (rl.code !== 0) throw new Error(rl.err || 'systemctl daemon-reload 失败');
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
      const rl = run('systemctl', ['--user', 'daemon-reload']);
      if (rl.code !== 0) throw new Error(rl.err || 'systemctl --user daemon-reload 失败');
      // 没有 linger 时用户服务只在登录期间存在，开机自启等于空话
      if (ARGS.autostart) {
        const ling = run('loginctl', ['enable-linger', OWNER.name]);
        if (ling.code !== 0) warn('未能开启 linger（loginctl enable-linger ' + OWNER.name + '），重启后需要登录一次才会启动');
      }
    }
    return target;
  },

  uninstall() {
    const target = unitPath();
    if (!fs.existsSync(target) && SCOPE !== 'system') return false;
    systemctl(['stop', LINUX_UNIT]);
    systemctl(['disable', LINUX_UNIT]);
    if (SCOPE === 'system') runPrivileged('rm', ['-f', target]);
    else { try { fs.unlinkSync(target); } catch { /* ignore */ } }
    systemctl(['daemon-reload']);
    return true;
  },

  start() {
    const r = systemctl(['start', LINUX_UNIT]);
    if (r.code !== 0) throw new Error(r.err || 'systemctl start 失败');
  },
  stop() { systemctl(['stop', LINUX_UNIT]); },
  hardStop() { systemctl(['kill', '--signal=SIGKILL', LINUX_UNIT]); },
  enable() {
    const r = systemctl(['enable', LINUX_UNIT]);
    if (r.code !== 0) throw new Error(r.err || 'systemctl enable 失败');
    if (SCOPE === 'user') run('loginctl', ['enable-linger', OWNER.name]);
  },
  disable() {
    const r = systemctl(['disable', LINUX_UNIT]);
    if (r.code !== 0) throw new Error(r.err || 'systemctl disable 失败');
  },
  enabled() {
    const r = systemctl(['is-enabled', LINUX_UNIT]);
    return r.out.trim() === 'enabled' || r.out.trim() === 'static' || r.out.trim() === 'alias';
  },
  active() {
    const r = systemctl(['is-active', LINUX_UNIT]);
    return r.out.trim() === 'active';
  },
  describe() {
    const installed = SCOPE === 'system' ? fs.existsSync(UNIT_SYSTEM) : fs.existsSync(UNIT_USER);
    const active = installed ? LINUX.active() : false;
    const enabled = installed ? LINUX.enabled() : false;
    return {
      installed, running: active, autostart: enabled, canInstall: canInstall(),
      raw: installed ? `${active ? 'active' : 'inactive'} / ${enabled ? 'enabled' : 'disabled'}` : '未安装',
      kind: `systemd ${SCOPE === 'system' ? '系统服务' : '用户服务'}（${unitPath()}）`,
    };
  },
};

// ================================================================== macOS launchd
const MAC_PLIST = path.join(OWNER.home, 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);

function plistText(runAtLoad = true) {
  const logs = path.join(LOG_DIR, 'launchd.log');
  const args = [NODE, APP, '--log-file'];
  if (PIN_HOME) args.push('--home', CONFIG_DIR);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xmlEscape(OWNER.home)}</string>
  </dict>
  <key>RunAtLoad</key>${runAtLoad ? '<true/>' : '<false/>'}
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(logs)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logs)}</string>
</dict>
</plist>
`;
}

function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
}

const MAC = {
  install() {
    fs.mkdirSync(path.dirname(MAC_PLIST), { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(MAC_PLIST)) run('launchctl', ['unload', MAC_PLIST]);
    fs.writeFileSync(MAC_PLIST, plistText(ARGS.autostart), 'utf8');
    const r = run('launchctl', ['load', '-w', MAC_PLIST]);
    if (r.code !== 0) throw new Error(r.err || 'launchctl load 失败');
    return MAC_PLIST;
  },
  uninstall() {
    if (!fs.existsSync(MAC_PLIST)) return false;
    run('launchctl', ['unload', '-w', MAC_PLIST]);
    try { fs.unlinkSync(MAC_PLIST); } catch { /* ignore */ }
    return true;
  },
  start() {
    const r = run('launchctl', ['load', '-w', MAC_PLIST]);
    if (r.code !== 0) throw new Error(r.err || 'launchctl load 失败');
  },
  stop() { run('launchctl', ['unload', MAC_PLIST]); },
  hardStop() { run('launchctl', ['stop', MAC_LABEL]); },
  /** 开机自启 = plist 里的 RunAtLoad。改它不需要卸载服务，避免「关自启把服务也停了」 */
  enable() {
    if (!fs.existsSync(MAC_PLIST)) throw new Error('服务还没安装');
    fs.writeFileSync(MAC_PLIST, plistText(true), 'utf8');
    if (!run('launchctl', ['list']).out.includes(MAC_LABEL)) return MAC.start();
  },
  disable() {
    if (!fs.existsSync(MAC_PLIST)) throw new Error('服务还没安装');
    fs.writeFileSync(MAC_PLIST, plistText(false), 'utf8');
  },
  loaded() {
    return run('launchctl', ['list']).out.split('\n').some(l => l.trim().endsWith(MAC_LABEL));
  },
  enabled() {
    try { return /<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(fs.readFileSync(MAC_PLIST, 'utf8')); }
    catch { return false; }
  },
  describe() {
    const installed = fs.existsSync(MAC_PLIST);
    const loaded = installed && MAC.loaded();
    const autostart = installed && MAC.enabled();
    return {
      installed, running: loaded, autostart, canInstall: canInstall(),
      raw: installed ? (loaded ? '已加载' : '未加载') + (autostart ? ' / 开机自启' : ' / 不自启') : '未安装',
      kind: `launchd LaunchAgent（${MAC_PLIST}）`,
    };
  },
};

const BACKEND = IS_WIN ? WIN : (IS_MAC ? MAC : LINUX);

// ================================================================== 动作
async function cmdStatus() {
  const d = BACKEND.describe();
  // 用「实际在跑的端口」探测，而不是配置里的端口：改完端口还没重启时两者不同
  const live = await livePort();
  const ping = { ok: live > 0 };
  const info = ping.ok ? await httpJson('/api/system/info', { timeout: 2500, port: live }) : { ok: false };
  const logFile = path.join(LOG_DIR, 'manager.log');

  // --json：给 hmcsm 之类的调用方用，格式别乱改，只打一行
  if (ARGS.json) {
    say(JSON.stringify({
      ok: true,
      version: pkg.version,
      port: PORT,
      host: HOST,
      livePort: live,
      localOnly: LOCAL_ONLY,
      serviceFile: SCOPE === 'system' ? UNIT_SYSTEM : SCOPE === 'user' ? UNIT_USER : IS_WIN ? WIN_TASK : MAC_PLIST,
      installed: d.installed,
      running: d.running,
      autostart: d.autostart,
      installSource: d.installSource || '',
      installUncertain: !!d.installUncertain,
      canInstall: !!d.canInstall,
      kind: d.kind,
      raw: d.raw,
      up: ping.ok,
      pid: info.ok ? info.data.pid : 0,
      bind: info.ok ? info.data.bind || null : null,
      urls: info.ok && Array.isArray(info.data.urls) ? info.data.urls : [],
      authEnabled: !!(info.ok ? info.data.auth && info.data.auth.enabled : SETTINGS.auth && SETTINGS.auth.enabled),
      configDir: CONFIG_DIR,
      dataDir: DATA_DIR,
      logFile: fs.existsSync(logFile) ? logFile : '',
    }));
    return;
  }

  line();
  say(c.bold('  HMCS 服务状态'));
  line();
  say('  方式      ' + d.kind);
  say('  安装      ' + (d.installed ? c.green('是') : c.dim('否'))
    + (d.installUncertain ? c.yellow('  · 实时状态未确认') : ''));
  say('  判定依据  ' + c.dim(d.installSource || '—'));
  say('  运行      ' + ((d.running || ping.ok) ? c.green('运行中') : c.dim('未运行'))
    + c.dim('  (' + d.raw + ')'));
  say('  开机自启  ' + (d.autostart ? c.green('开启') : c.dim('关闭')));
  say('  监听      ' + HOST + ':' + PORT + (LOCAL_ONLY ? c.yellow('  （仅本机）') : ''));
  if (live && live !== PORT) {
    say('  实际在跑  ' + c.yellow('127.0.0.1:' + live) + c.dim('  （端口改过还没重启）'));
  }
  if (ping.ok) {
    if (info.ok) {
      const up = Number(info.data.uptimeSec || 0);
      say('  版本      v' + info.data.app + '  Node ' + info.data.node + '  PID ' + info.data.pid);
      say('  已运行    ' + (up >= 3600 ? `${Math.floor(up / 3600)} 小时 ${Math.floor(up % 3600 / 60)} 分` : `${Math.floor(up / 60)} 分 ${up % 60} 秒`));
      say('  密码      ' + (info.data.auth && info.data.auth.enabled ? c.green('已启用') : c.yellow('未启用')));
      if (Array.isArray(info.data.urls) && info.data.urls.length) say('  访问      ' + info.data.urls.join('  '));
      // 运行中用的是什么，和 settings.json 里想要什么，可能不是一回事
      const bind = info.data.bind || {};
      if (Number(bind.port) && Number(bind.port) !== Number(SETTINGS.port)) {
        say('');
        warn(`正在运行的端口是 ${bind.port}，settings.json 里已经改成 ${SETTINGS.port}。`);
        say('            到管理界面点「立即重启」即可生效（不用重装服务）。');
      }
    } else {
      say('  版本      ' + c.dim('（端口有应答，但需要登录才能读取详情）'));
    }
  } else {
    say('  访问      ' + c.dim('127.0.0.1:' + PORT + ' 无应答'));
  }
  say('  日志      ' + (fs.existsSync(logFile) ? logFile : c.dim('尚未生成')));
  line();
}

async function cmdInstall() {
  line();
  say(c.bold('  安装 HMCS 服务'));
  line();
  say('  方式      ' + (IS_WIN ? `计划任务「${WIN_TASK}」(SYSTEM / 开机启动)`
    : IS_MAC ? `launchd ${MAC_LABEL}`
      : `systemd ${SCOPE === 'system' ? '系统服务' : '用户服务'}`));
  say('  程序      ' + ROOT);
  say('  数据      ' + CONFIG_DIR);
  say('  监听      ' + HOST + ':' + PORT);
  say('  Node      ' + NODE);
  say('  自启      ' + (ARGS.autostart ? '开启' : '关闭'));
  line();

  if (!IS_WIN && SCOPE === 'system' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    die('安装系统级服务需要管理员权限。请改用：\n  sudo node scripts/service.js install\n' +
      '  或者装成当前用户服务（不需要 sudo）：\n  node scripts/service.js install --user');
  }
  if (!LOCAL_ONLY) {
    const a = SETTINGS.auth || {};
    if (!a.enabled || !a.hash) {
      warn('监听地址是 ' + HOST + ' 但还没设置访问密码。服务会因为安全检查直接退出（退出码 2）。');
      warn('先在本机启动一次 HMCS，在「设置 → 安全与远程访问」里设好密码，再回来安装。');
    }
  }

  // 已安装则先停掉，避免端口占用导致新实例起不来
  const before = BACKEND.describe();
  if (ARGS.dryRun) return dryRunPlan();

  // 端口与监听地址落进 settings.json：启动参数里不再出现，之后由程序自己读，
  // 这样在界面改完设置点「重启」就能真正生效
  try {
    paths.writeSettings({ port: PORT, host: HOST });
    say('  已写入    settings.json（port=' + PORT + ', host=' + HOST + '）');
  } catch (e) {
    warn('写 settings.json 失败：' + e.message + '（服务会沿用文件里原有的端口）');
  }

  if (before.installed) {    say(c.dim('  检测到已安装，先停止旧实例…'));
    // 走 cmdStop：systemd / launchd 下必须由服务管理器来停，
    // 否则旧进程刚退出就被 Restart=always 拉回来，和新实例抢端口
    await cmdStop();
  }

  const where = BACKEND.install();
  if (where) say('  已写入    ' + where);
  writeState({
    backend: IS_WIN ? 'schtasks' : (IS_MAC ? 'launchd' : 'systemd'),
    scope: SCOPE,
    port: PORT,
    host: HOST,
    autostart: ARGS.autostart,
    installedAt: new Date().toISOString(),
  });
  await sleep(1200);

  say('');
  say('  正在启动服务…');
  await safeStart();
  await sleep(1500);
  const up = await isUp();
  if (up) ok('服务已启动，管理界面：http://127.0.0.1:' + PORT);
  else warn('服务已注册，但暂时没有响应。看日志：' + path.join(LOG_DIR, 'manager.log'));
  if (ARGS.autostart) {
    try { BACKEND.enable(); ok('开机自启已开启'); }
    catch (e) { warn('开启开机自启失败：' + e.message); }
  } else {
    // 重装时也要显式关掉，否则会把上一轮留下的「已启用」继承下来
    try { BACKEND.disable(); warn('开机自启已关闭（可随时用 enable 打开）'); }
    catch (e) { warn('关闭开机自启失败：' + e.message); }
  }
  say('');
}

function dryRunPlan() {
  line();
  say(c.bold('  演练模式：只打印将要执行的动作，不做任何修改'));
  line();
  say('');

  if (IS_WIN) {
    const tr = [quoteWin(NODE), quoteWin(APP), '--log-file', '--home', quoteWin(CONFIG_DIR)].join(' ');
    say('  写入 settings.json：port=' + PORT + '，host=' + HOST);
    say('  （启动参数里不带端口 —— 以后在界面改完点「重启」才真正生效）');
    say('');
    say('  注册计划任务（开机启动 + SYSTEM 账户，不需要登录）：');
    say(c.cyan('    schtasks /Create /TN ' + WIN_TASK + ' /TR "' + tr + '" /SC ONSTART /RU SYSTEM /RL HIGHEST /F'));
    if (!ARGS.autostart) say(c.cyan('    schtasks /Change /TN ' + WIN_TASK + ' /DISABLE'));
    say('');
    say('  启动  ' + c.cyan('schtasks /Run /TN ' + WIN_TASK));
    say('  停止  ' + c.cyan('POST /api/system/shutdown（优雅，先停 Minecraft）→ schtasks /End /TN ' + WIN_TASK));
    say('  自启  ' + c.cyan('schtasks /Change /TN ' + WIN_TASK + ' /ENABLE|/DISABLE'));
    say('  卸载  ' + c.cyan('schtasks /Delete /TN ' + WIN_TASK + ' /F'));
    return;
  }

  if (IS_MAC) {
    say('  写入 settings.json：port=' + PORT + '，host=' + HOST);
    say('');
    say('  写入 ' + MAC_PLIST + '：');
    say('');
    for (const l of plistText(ARGS.autostart).replace(/\n$/, '').split('\n')) say('    ' + l);
    say('');
    say('  加载  ' + c.cyan('launchctl load -w ' + MAC_PLIST));
    say('  卸载  ' + c.cyan('launchctl unload -w ' + MAC_PLIST));
    return;
  }

  const cmd = SCOPE === 'system' ? 'systemctl' : 'systemctl --user';
  const priv = SCOPE === 'system' && typeof process.getuid === 'function' && process.getuid() !== 0 ? 'sudo ' : '';
  say('  写入 settings.json：port=' + PORT + '，host=' + HOST);
  say('');
  say('  写入 ' + unitPath() + '：');
  say('');
  for (const l of unitText().replace(/\n$/, '').split('\n')) say('    ' + l);
  say('');
  say('  然后执行：');
  say(c.cyan(`    ${priv}${cmd} daemon-reload`));
  say(c.cyan(`    ${priv}${cmd} enable ${LINUX_UNIT}${ARGS.autostart ? '' : '   # 本次安装不开启自启'}`));
  if (SCOPE === 'user' && ARGS.autostart) say(c.cyan(`    loginctl enable-linger ${OWNER.name}`));
  say(c.cyan(`    ${priv}${cmd} start ${LINUX_UNIT}`));
  say('');
  say('  停止  ' + c.cyan(`${priv}${cmd} stop ${LINUX_UNIT}`));
  say('  日志  ' + c.cyan(`${priv}${cmd === 'systemctl' ? '' : 'journalctl --user'} -u ${LINUX_UNIT} -f`));
}

async function safeStart() {
  try { BACKEND.start(); }
  catch (e) { bad(e.message); }
}

async function cmdStart() {
  const d = BACKEND.describe();
  const live = await livePort();
  if (live) {
    warn('HMCS 已经在运行（127.0.0.1:' + live + '）');
    if (live !== PORT) say(c.dim('  但它监听的是旧端口，配置里已经是 ' + PORT + ' —— 用 restart 才能换过来。'));
    return;
  }

  // 没注册服务也能启动：退化成独立后台进程（关终端不影响）。
  // 先装服务再启动太绕了 —— 「启动」本来就该直接能把面板跑起来。
  if (!d.installed) {
    say(c.dim('  服务尚未安装，改为启动独立后台进程（要开机自启再执行 install）…'));
    const r = require('./launch').spawnDetached({ port: PORT, host: HOST });
    if (!r.ok) { bad('后台启动失败：' + r.error); process.exitCode = 1; return; }
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      if (await isUp()) {
        ok('已启动（独立后台进程 pid=' + r.pid + '）：http://127.0.0.1:' + PORT);
        return;
      }
    }
    bad('进程已拉起（pid ' + r.pid + '），但 15 秒内端口没响应，看日志 ' + path.join(LOG_DIR, 'manager.log'));
    process.exitCode = 1;
    return;
  }

  await safeStart();
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await isUp()) { ok('已启动：http://127.0.0.1:' + PORT); return; }
  }
  bad('启动后 10 秒仍无响应，请查看日志 ' + path.join(LOG_DIR, 'manager.log'));
  process.exitCode = 1;
}

/** 等某个端口彻底不响应 */
async function waitDown(port, maxWaitSec = 70) {
  const deadline = Date.now() + maxWaitSec * 1000;
  while (Date.now() < deadline) {
    if (!(await httpJson('/api/system/ping', { timeout: 900, port })).ok) return true;
    await sleep(700);
  }
  return false;
}

async function cmdStop() {
  const d = BACKEND.describe();
  const live = await livePort();
  if (!d.installed && !live) { warn('当前没有在运行'); return; }

  if (d.installed && !IS_WIN) {
    // systemd 是 Restart=always、launchd 是 KeepAlive：让进程自己 exit(0) 的话，
    // 服务管理器几秒后又把它拉起来，表现就是「点了停止，过一会儿又活了」。
    // 所以这里必须走服务管理器自己的 stop（它发 SIGTERM，app 会据此优雅收尾）。
    BACKEND.stop();
  } else if (live) {
    // Windows 计划任务没有重启策略，但 schtasks /End 是强杀。
    // 先请它自己存盘退出（会挨个给 Minecraft 发 stop），超时才 End。
    say('正在请求 HMCS 优雅关闭（会先让 Minecraft 服务端保存并退出）…');
    await httpJson('/api/system/shutdown', { method: 'POST', token: controlToken(), timeout: 5000, port: live });
  }

  if (live && !(await waitDown(live, 70))) {
    warn('70 秒内没有完全退出，强制结束');
    BACKEND.hardStop();
    await sleep(900);
  }
  if (await livePort()) {
    bad('停止失败：端口仍在响应');
    process.exitCode = 1;
    return;
  }
  ok('已停止');
}

async function cmdRestart() {
  await cmdStop();
  await sleep(500);
  await cmdStart();
}

function cmdUninstall() {
  const d = BACKEND.describe();
  if (!d.installed) { warn('服务未安装，无需卸载'); return; }
  BACKEND.uninstall();
  try { fs.unlinkSync(STATE_FILE); } catch { /* 本来就没有 */ }
  ok('服务已卸载（数据与实例文件都保留了）');
}

function cmdEnable() {
  BACKEND.enable();
  ok('开机自启已开启');
}
function cmdDisable() {
  BACKEND.disable();
  ok('开机自启已关闭');
}

// ================================================================== 交互菜单
// 菜单只有一份实现（scripts/menu.js），这里转过去，避免两套菜单长得不一样。
function menu() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'hmcsm.js'), 'menu'], {
    cwd: ROOT, stdio: 'inherit', timeout: 3600000,
  });
  return r.status === null ? 0 : r.status;
}

function openBrowser() {  const url = `http://127.0.0.1:${PORT}`;
  try {
    if (IS_WIN) spawnSync('cmd', ['/c', 'start', '', url], { windowsHide: true });
    else if (IS_MAC) spawnSync('open', [url]);
    else spawnSync('xdg-open', [url], { stdio: 'ignore' });
    ok('已在浏览器打开 ' + url);
  } catch {
    say('请手动打开 ' + url);
  }
}

// ================================================================== 入口
async function main() {
  switch (ARGS.cmd) {
    case 'menu': return menu();
    case 'install': return cmdInstall();
    case 'uninstall': return cmdUninstall();
    case 'start': return cmdStart();
    case 'stop': return cmdStop();
    case 'restart': return cmdRestart();
    case 'enable': return cmdEnable();
    case 'disable': return cmdDisable();
    case 'status': return cmdStatus();
    case 'open': return openBrowser();
    case 'help':
    case '--help':
    case '-h':
      return sayHelp();
    default:
      bad('未知命令：' + ARGS.cmd);
      sayHelp();
      process.exitCode = 2;
  }
}

function sayHelp() {
  say(`
HMCS 服务管理 v${pkg.version}

  node scripts/service.js [命令] [选项]

命令
  (无)        进入交互菜单
  install     注册服务并启动
  uninstall   卸载服务（保留数据与实例）
  start       启动服务
  stop        停止服务（先优雅关闭 Minecraft）
  restart     重启服务
  enable      开启开机自启
  disable     关闭开机自启
  status      查看状态
  open        在浏览器打开管理界面

选项
  --port N        指定监听端口（默认取 settings.json）
  --host ADDR     指定监听地址（默认取 settings.json）
  --no-autostart  安装后不开启开机自启
  --user          Linux/macOS 装成当前用户服务（不需要 sudo）
  --system        Linux/macOS 强制系统级服务（需要 sudo）
`);
}

main().catch(e => {
  bad(e.message || String(e));
  process.exitCode = 1;
});
