'use strict';
/**
 * 防火墙同步 —— 切换「公网访问」（监听地址 / 端口）时一并放行或收回入站规则。
 *
 * 光把 Node 监听从 127.0.0.1 改成 0.0.0.0 是不够的：Windows Defender 防火墙、
 * ufw / firewalld 默认会拦掉外部发起的入站连接，结果就是「界面显示已开放，
 * 但局域网根本连不上」。所以开关公网访问必须连带改防火墙。
 *
 * 平台策略
 *   Windows   netsh advfirewall，规则名固定 HMCS-WebUI（无空格，避开 netsh 引号坑）
 *   Linux     ufw（优先）→ firewalld；两者都没启用就跳过（本来也没拦）
 *   macOS     默认不拦端口，跳过，只给出提示
 *
 * 幂等：状态文件 <配置目录>/firewall-state.json 记录「HMCS 亲手建过的规则」。
 *   目标与现状一致就直接跳过，不重复跑外部命令；端口变了先删旧端口再加新端口；
 *   切回 127.0.0.1 则把规则撤掉。规则只按自己的名字 / 自己记过的端口删，
 *   不会误伤别人配置的规则。
 *
 * 权限：改防火墙需要管理员 / root。这里不擅自弹 UAC、不阻塞启动，
 *   失败时返回 needsPrivilege + 可直接复制的手动命令，由调用方（菜单 / CLI）决定
 *   要不要提权重试。后端进程常跑在 SYSTEM / root 下，通常一次就成。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const RULE_NAME = 'HMCS-WebUI';
const STATE_FILE = path.join(paths.CONFIG_DIR, 'firewall-state.json');

// 自测可注入假 runner，模拟别的平台 / 权限，不需要真的动防火墙
let runner = spawnSync;
let detectCache = null;
function __setRunner(fn) { runner = fn; detectCache = null; }
function __resetRunner() { runner = spawnSync; detectCache = null; }

function run(cmd, args, timeout = 8000) {
  let r;
  try {
    r = runner(cmd, args, { encoding: 'utf8', timeout, windowsHide: true });
  } catch (e) {
    return { code: -1, out: '', err: '', error: e.message };
  }
  return {
    code: r && r.status === null ? -1 : (r ? r.status : -1),
    out: String((r && r.stdout) || ''),
    err: String((r && r.stderr) || ''),
    error: r && r.error ? r.error.message : '',
  };
}

const hasCmd = name => run('sh', ['-c', 'command -v ' + name], 5000).code === 0;
const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

/** Windows 是否处于已提升的令牌下（只用于展示/提示，成败仍以命令返回码为准） */
function isElevatedWin() {
  if (!IS_WIN) return isRoot();
  if (run('fltmc', [], 5000).code === 0) return true;
  return run('net', ['session'], 5000).code === 0;
}

/** 需要 root 的命令：已是 root 直接跑，否则试一次免密 sudo -n */
function privileged(cmd, args) {
  if (IS_WIN || isRoot()) return { cmd, args, viaSudo: false };
  return { cmd: 'sudo', args: ['-n', cmd, ...args], viaSudo: true };
}

/**
 * 探测本机用的是哪套防火墙。
 * active=false 表示「当前没有东西拦入站」，此时放行规则无意义，直接跳过。
 */
function detect(force = false) {
  // 菜单每次刷新、后端每次 bootstrap 都会问一遍，探测结果短时缓存即可，
  // 免得反复拉起 fltmc / ufw status。自测注入 runner 时会清掉缓存。
  if (!force && detectCache && Date.now() - detectCache.at < 5000) return detectCache.value;
  const value = detectNow();
  detectCache = { at: Date.now(), value };
  return value;
}

function detectNow() {
  if (IS_WIN) {
    return { backend: 'netsh', active: true, elevated: isElevatedWin(), reason: '' };
  }
  if (IS_MAC) {
    return {
      backend: 'none', active: false, elevated: false,
      reason: 'macOS 默认允许传入连接到已监听端口；若在「系统设置 → 网络 → 防火墙」里开了「阻止所有传入连接」，请手动放行 node',
    };
  }
  if (hasCmd('ufw')) {
    const r = run('ufw', ['status']);
    if (r.code === 0 && /Status:\s*active/i.test(r.out)) {
      return { backend: 'ufw', active: true, elevated: isRoot(), reason: '' };
    }
    return { backend: 'none', active: false, elevated: false, reason: 'ufw 已安装但状态为 inactive，当前不拦入站，无需放行' };
  }
  if (hasCmd('firewall-cmd')) {
    const r = run('firewall-cmd', ['--state']);
    if (r.code === 0 && /running/i.test(r.out)) {
      return { backend: 'firewalld', active: true, elevated: isRoot(), reason: '' };
    }
    return { backend: 'none', active: false, elevated: false, reason: 'firewalld 未运行，无需放行' };
  }
  return {
    backend: 'none', active: false, elevated: false,
    reason: '未检测到 ufw / firewalld；若用了自定义 iptables / nftables 策略，需手动放行 TCP 端口',
  };
}

// ---------------------------------------------------------------- 命令构造
const BIN = { netsh: 'netsh', ufw: 'ufw', firewalld: 'firewall-cmd' };

function rawArgs(backend, op, port) {
  if (backend === 'netsh') {
    return op === 'add'
      ? ['advfirewall', 'firewall', 'add', 'rule', `name=${RULE_NAME}`, 'dir=in',
        'action=allow', 'protocol=TCP', `localport=${port}`, 'profile=any']
      : ['advfirewall', 'firewall', 'delete', 'rule', `name=${RULE_NAME}`];
  }
  if (backend === 'ufw') {
    // --force 让 delete 在非交互下不弹 "Proceed with operation (y|n)?"
    return op === 'add'
      ? ['--force', 'allow', `${port}/tcp`, 'comment', RULE_NAME]
      : ['--force', 'delete', 'allow', `${port}/tcp`, 'comment', RULE_NAME];
  }
  if (backend === 'firewalld') {
    return op === 'add'
      ? ['--permanent', `--add-port=${port}/tcp`]
      : ['--permanent', `--remove-port=${port}/tcp`];
  }
  return [];
}

/** 返回可直接复制给人执行的命令（已带 sudo 前缀） */
function manualCommand(backend, op, port) {
  const a = rawArgs(backend, op, port);
  if (!a.length) return '';
  const line = [BIN[backend], ...a.map(x => (/\s/.test(x) ? `"${x}"` : x))].join(' ');
  return IS_WIN ? line : `sudo ${line}`;
}

function manualHints(backend, op, port) {
  const hints = [];
  const main = manualCommand(backend, op, port);
  if (main) hints.push(main);
  if (backend === 'firewalld') hints.push('sudo firewall-cmd --reload');
  if (IS_WIN) hints.unshift('用管理员身份打开 PowerShell / 终端后执行：');
  return hints;
}

/** 执行一条防火墙操作；「规则本来就不存在」的删除算成功 */
function invoke(backend, op, port) {
  const { cmd, args, viaSudo } = privileged(BIN[backend], rawArgs(backend, op, port));
  const r = run(cmd, args);
  const text = (r.out + '\n' + r.err).trim();
  let ok = r.code === 0;

  if (!ok && op === 'del') {
    // 目标状态（没有规则）已经达成，不算失败
    if (/no rules match|could not delete|non-existent|does not exist|not found|rule.*not.*exist/i.test(text)) ok = true;
  }
  let reload = null;
  if (ok && backend === 'firewalld') {
    const rl = privileged('firewall-cmd', ['--reload']);
    const rr = run(rl.cmd, rl.args);
    reload = { ok: rr.code === 0, detail: (rr.out + rr.err).trim().slice(0, 200) };
  }
  return {
    op, port, ok, viaSudo,
    command: [cmd, ...args].join(' '),
    code: r.code,
    detail: text.slice(0, 300),
    reload,
  };
}

/** 实际查一下规则在不在（给 status / 菜单显示用） */
function present(backend, port) {
  if (backend === 'netsh') {
    const r = run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE_NAME}`]);
    return r.code === 0 && r.out.includes(RULE_NAME);
  }
  if (backend === 'ufw') {
    const r = run('ufw', ['status']);
    return r.code === 0 && new RegExp(`${port}/tcp`, 'i').test(r.out) && /ALLOW/i.test(r.out);
  }
  if (backend === 'firewalld') {
    const r = privileged('firewall-cmd', ['--permanent', `--query-port=${port}/tcp`]);
    return run(r.cmd, r.args).code === 0;
  }
  return null;
}

// ---------------------------------------------------------------- 状态文件
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { backend: String(s.backend || ''), port: Number(s.port) || 0, updatedAt: s.updatedAt || '' };
  } catch {
    return { backend: '', port: 0, updatedAt: '' };
  }
}

function writeState(backend, port) {
  try {
    fs.mkdirSync(paths.CONFIG_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      backend, port, rule: RULE_NAME, updatedAt: new Date().toISOString(),
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch { /* 只读目录：不影响运行，只是下次会再同步一次 */ }
}

// ---------------------------------------------------------------- 对外主入口
/**
 * 按目标监听配置同步防火墙。同步、幂等、失败不影响调用方。
 * @param {object} o  { host, port, force, onLog }
 * @returns {{ok, needed, backend, active, changed, skipped, reason, warning,
 *            needsPrivilege, manual, actions, state}}
 */
function sync({ host, port, force = false, onLog = null } = {}) {
  const needed = !paths.isLoopbackHost(host);
  const d = detect();
  const log = s => { if (typeof onLog === 'function') onLog(s); };
  const res = {
    ok: true, needed, backend: d.backend, active: d.active, changed: false, skipped: false,
    reason: d.reason || '', warning: '', needsPrivilege: false,
    manual: [], actions: [], state: readState(),
  };

  if (!d.active) {
    res.skipped = true;
    if (!needed) res.reason = '仅本机监听，无需防火墙放行';
    // 即使现在没启用防火墙，若之前建过规则也要尝试清掉，别留垃圾
    if (res.state.port && BIN[res.state.backend]) {
      const rm = invoke(res.state.backend || d.backend, 'del', res.state.port);
      res.actions.push(rm);
      if (rm.ok) { writeState('', 0); res.state = { backend: '', port: 0 }; res.changed = true; }
      else log('[HMCS] 清理旧防火墙规则失败：' + rm.detail);
    }
    return res;
  }

  const state = res.state;
  const wantPort = needed ? Number(port) : 0;
  const sameBackend = state.backend === d.backend;

  // 「仅本机 + 从没建过规则」是最常见的启动场景，一条外部命令都不用跑
  if (!force && wantPort === 0 && state.port === 0) {
    res.skipped = true;
    res.reason = '仅本机监听，无需放行';
    return res;
  }

  // 幂等命中：目标与已记录的一致就不必再动；但先确认规则真的还在，
  // 被安全软件 / 组策略清掉的话要能自动补回来。
  if (!force && sameBackend && state.port === wantPort) {
    const missing = wantPort > 0 && present(d.backend, wantPort) === false;
    if (!missing) {
      res.skipped = true;
      res.reason = needed ? `已放行 TCP ${port} 入站` : '仅本机监听，无需放行';
      return res;
    }
    log('[HMCS] 防火墙规则已不在（可能被外部清除），正在重建');
  }

  // 1) 撤掉旧规则。netsh 按固定名删（即使状态文件丢了也不会留下重复规则）；
  //    Linux 只能按状态文件记下的旧端口删，没记录就跳过。
  const oldBackend = sameBackend ? d.backend : (state.backend || d.backend);
  if (state.port || d.backend === 'netsh') {
    const rm = invoke(oldBackend, 'del', state.port || Number(port));
    res.actions.push(rm);
    if (!rm.ok) log('[HMCS] 删除旧防火墙规则失败：' + rm.detail);
    else res.changed = true;
  }

  // 2) 需要对外访问 → 加一条入站放行
  if (needed) {
    const add = invoke(d.backend, 'add', Number(port));
    res.actions.push(add);
    if (add.ok) {
      writeState(d.backend, Number(port));
      res.state = { backend: d.backend, port: Number(port) };
      res.changed = true;
      log(`[HMCS] 防火墙已放行 TCP ${port} 入站（${d.backend}，规则 ${RULE_NAME}）`);
    } else {
      res.ok = false;
      res.needsPrivilege = true;
      res.manual = manualHints(d.backend, 'add', Number(port));
      res.warning = `防火墙未能自动放行 TCP ${port}（需要管理员 / root 权限），外部可能仍连不上`;
      log('[HMCS] ' + res.warning + '：' + add.detail);
    }
  } else if (res.actions.every(a => a.ok)) {
    // 撤回成功才把状态清空；删失败就保留记录，下次还会重试
    writeState('', 0);
    res.state = { backend: '', port: 0 };
  }

  if (!res.reason && !res.warning) res.reason = needed ? `已放行 TCP ${port} 入站` : '已收回放行规则';
  return res;
}

/** 撤掉所有 HMCS 建过的规则（卸载服务 / 手动关公网时用） */
function removeAll({ onLog = null } = {}) {
  const state = readState();
  const d = detect();
  const backend = state.backend || d.backend;
  if (!backend || backend === 'none' || !state.port) {
    return { ok: true, removed: false, reason: '没有 HMCS 建过的防火墙规则' };
  }
  const rm = invoke(backend, 'del', state.port);
  if (rm.ok) {
    writeState('', 0);
    if (typeof onLog === 'function') onLog(`[HMCS] 已移除防火墙规则 ${RULE_NAME}`);
  }
  return { ok: rm.ok, removed: rm.ok, action: rm, reason: rm.ok ? '' : rm.detail };
}

/** 供菜单 / CLI 显示现状 */
function status({ host, port } = {}) {
  const d = detect();
  const state = readState();
  const needed = !paths.isLoopbackHost(host);
  let exists = null;
  if (d.active && state.port) exists = present(d.backend, state.port);
  const desiredPort = needed ? Number(port) : 0;
  // 仅本机监听时「没有规则」就是同步状态，不必要求 backend 相同
  const inSync = !d.active
    ? !state.port
    : (state.port === desiredPort &&
      (desiredPort === 0 || (state.backend === d.backend && exists !== false)));
  return { ...d, rule: RULE_NAME, state, needed, desiredPort, exists, inSync };
}

/** 一行中文描述，给菜单状态区用 */
function describe({ host, port } = {}) {
  const st = status({ host, port });
  if (!st.active) return st.needed ? '未启用（当前无入站拦截）' : '无需放行（仅本机监听）';
  if (!st.needed) return st.state.port ? '待收回（重启后清理）' : '未放行（仅本机监听）';
  if (st.state.port === Number(port) && st.exists !== false) return `已放行 TCP ${port}`;
  return `未放行 TCP ${port}${st.elevated ? '' : '（需管理员 / root）'}`;
}

/** 只读状态文件，零外部命令，给 bootstrap 之类按次调用的热路径用 */
function statePort() { return readState().port; }

module.exports = {
  RULE_NAME, STATE_FILE,
  sync, removeAll, status, describe, detect, present, statePort,
  manualCommand, manualHints, rawArgs,
  __setRunner, __resetRunner,
};
