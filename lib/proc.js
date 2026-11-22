'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const java = require('./java');
const instances = require('./instances');
const eula = require('./eula');

const MAX_LINES = 4000;
const RT = new Map();
const EXIT_HOOKS = new Map();

/** 注册进程退出回调（用于 UPnP 映射回收等），返回取消函数 */
function onExit(id, fn) {
  if (!EXIT_HOOKS.has(id)) EXIT_HOOKS.set(id, new Set());
  EXIT_HOOKS.get(id).add(fn);
  return () => { const s = EXIT_HOOKS.get(id); if (s) s.delete(fn); };
}

function fireExit(id, code) {
  const hooks = EXIT_HOOKS.get(id);
  if (!hooks) return;
  for (const fn of [...hooks]) {
    try { Promise.resolve(fn(code)).catch(() => {}); } catch { /* ignore */ }
  }
}

function rt(id) {
  if (!RT.has(id)) {
    RT.set(id, { id, child: null, status: 'stopped', lines: [], clients: new Set(), startedAt: 0, exitCode: null, javaPath: '', error: '' });
  }
  return RT.get(id);
}

function strip(s) {
  return String(s)
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')          // 所有 CSI 序列（含光标控制）
    .replace(/\u001b\][^\u0007]*\u0007/g, '')          // OSC 序列
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\r/g, '')
    .replace(/^[>\s]*>\s*/, '')                        // Paper 控制台提示符
    .replace(/\s+$/, '');
}

/** 优先按 UTF-8 解码；出现替换符时回退 GBK（中文 Windows 下的旧核心） */
function decodeLine(buf) {
  const s = buf.toString('utf8');
  if (!s.includes('\ufffd')) return s;
  try { return new TextDecoder('gbk').decode(buf); } catch { return s; }
}

function push(id, line) {
  const r = rt(id);
  r.lines.push(line);
  if (r.lines.length > MAX_LINES) r.lines.splice(0, r.lines.length - MAX_LINES);
  broadcast(r, 'log', { line });
}

function broadcast(r, event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of r.clients) {
    try { res.write(data); } catch { r.clients.delete(res); }
  }
}

function setStatus(id, status) {
  const r = rt(id);
  r.status = status;
  broadcast(r, 'status', { status, startedAt: r.startedAt, exitCode: r.exitCode });
}

function statusOf(id) {
  const r = rt(id);
  return { status: r.status, startedAt: r.startedAt, exitCode: r.exitCode, error: r.error, javaPath: r.javaPath };
}

function runningIds() {
  return [...RT.values()].filter(r => r.status !== 'stopped').map(r => r.id);
}

async function start(inst, opts) {
  const r = rt(inst.id);
  if (r.child) throw new Error('该实例已在运行');
  const dir = instances.dirOf(inst.id);
  const core = path.join(dir, inst.coreFile);
  if (!fs.existsSync(core)) throw new Error('核心文件缺失: ' + inst.coreFile);

  const eu = eula.read(dir);
  if (!eu.accepted) {
    if (!opts || !opts.acceptEula) {
      const e = new Error('尚未同意 Minecraft EULA（eula.txt）。请在启动面板勾选同意，或到「配置 → eula.txt」里同意后重试。');
      e.code = 'EULA';
      e.status = 409;
      throw e;
    }
    eula.write(dir, true);
    inst.eula = true;
    instances.save(inst);
  }

  const j = await java.pick(inst.mcVersion, opts && opts.javaPath);
  if (!j) throw new Error('没有找到可用的 Java 运行时');
  const need = java.requiredMajor(inst.mcVersion);
  if (j.major < need) throw new Error(`Java 版本过低：${inst.mcVersion} 需要 Java ${need}+，当前 ${j.major}（${j.path}）`);

  const memory = (opts && opts.memory) || inst.memory || '2G';
  const jvmArgs = ((opts && opts.jvmArgs) || inst.jvmArgs || '').split(/\s+/).filter(Boolean);
  // 中文 Windows 下 java 默认用 GBK 写控制台，统一强制 UTF-8，避免中文日志与命令乱码
  const encArgs = [
    '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
    '-Dstdin.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8',
  ];
  const args = [`-Xms${memory}`, `-Xmx${memory}`, ...encArgs, ...jvmArgs, '-jar', core, 'nogui'];

  r.error = '';
  r.exitCode = null;
  r.javaPath = j.path;
  r.startedAt = Date.now();
  setStatus(inst.id, 'starting');
  push(inst.id, `[HMCS] ${j.path} (Java ${j.version})`);
  push(inst.id, `[HMCS] ${args.join(' ')}`);

  const child = spawn(j.path, args, { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  r.child = child;

  let buf = Buffer.alloc(0);
  const onData = chunk => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let idx;
    while ((idx = buf.indexOf(10)) >= 0) {
      const raw = buf.subarray(0, idx);
      buf = buf.subarray(idx + 1);
      const line = strip(decodeLine(raw));
      if (!line) continue;
      push(inst.id, line);
      if (/Done \(.*\)! For help/.test(line) || /Done \([\d.]+s\)!/.test(line)) setStatus(inst.id, 'running');
      if (/You need to agree to the EULA/.test(line)) {
        push(inst.id, '[HMCS] 服务端要求同意 EULA，请勾选同意后重启');
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', err => {
    r.error = err.message;
    push(inst.id, '[HMCS] 启动失败: ' + err.message);
    setStatus(inst.id, 'stopped');
  });

  child.on('exit', code => {
    r.child = null;
    r.exitCode = code;
    push(inst.id, `[HMCS] 进程退出，退出码 ${code}`);
    setStatus(inst.id, 'stopped');
    fireExit(inst.id, code);
  });

  // 10 秒内没进入 running 就保持 starting 状态提示
  setTimeout(() => {
    if (r.status === 'starting') push(inst.id, '[HMCS] 仍在启动中……首次启动需要生成世界，可能耗时较久');
  }, 12000).unref?.();

  return { ok: true, java: j.path, args };
}

function send(id, line) {
  const r = rt(id);
  if (!r.child || !r.child.stdin.writable) throw new Error('服务端未运行');
  push(id, '> ' + line);
  r.child.stdin.write(line + '\n');
}

async function stop(id) {
  const r = rt(id);
  if (!r.child) throw new Error('服务端未运行');
  if (r.status === 'stopping') return { ok: true };
  setStatus(id, 'stopping');
  push(id, '[HMCS] 发送 stop 指令，等待安全关闭……');
  try { r.child.stdin.write('stop\n'); } catch { /* ignore */ }
  const pid = r.child.pid;
  const timer = setTimeout(() => {
    if (r.child) {
      push(id, '[HMCS] 30 秒未退出，强制结束进程');
      try { r.child.kill(); } catch { /* ignore */ }
      setTimeout(() => { if (r.child) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } } }, 3000).unref?.();
    }
  }, 30000);
  timer.unref?.();
  return { ok: true };
}

function subscribe(id, res) {
  const r = rt(id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: status\ndata: ${JSON.stringify({ status: r.status, startedAt: r.startedAt, exitCode: r.exitCode })}\n\n`);
  for (const line of r.lines.slice(-800)) {
    res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);
  }
  r.clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20000);
  res.on('close', () => { clearInterval(ping); r.clients.delete(res); });
}

function logsText(id, limit) {
  return rt(id).lines.slice(-(limit || 2000)).join('\n');
}

function clearLogs(id) {
  const r = rt(id);
  r.lines = [];
  broadcast(r, 'log', { line: '[HMCS] 控制台已清空（不删除 logs/latest.log）' });
}

module.exports = { start, stop, send, subscribe, logsText, clearLogs, statusOf, runningIds, push, setStatus, onExit };
