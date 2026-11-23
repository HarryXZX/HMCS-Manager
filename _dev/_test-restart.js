#!/usr/bin/env node
'use strict';
/**
 * 重启链路自测
 *
 * 覆盖三件事：
 *   1) 点「立即重启」后，新进程真的接管了端口（pid 变了、服务可用）
 *   2) 新进程启动即崩时，老进程不能跟着退出（否则面板彻底没了）
 *   3) 新进程在 HMCS_RESTART_HANDOFF=1 时会耐心等老进程释放端口
 *
 * 用法：node _dev/_test-restart.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app.js');
const PORT = Number(process.env.TEST_PORT || 8792);
const PORT2 = PORT + 1;

let failed = 0;
function check(name, cond, detail = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || !detail ? '' : '  → ' + detail));
  if (!cond) failed++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ping(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/system/ping', timeout: 1500 }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function post(port, p) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 3000 }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

async function waitPing(port, ms = 30000, notPid = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = await ping(port);
    if (p && p.ok && p.pid !== notPid) return p;
    await sleep(300);
  }
  return null;
}

function startApp(port, home, env = {}, extraArgs = []) {
  const out = path.join(os.tmpdir(), 'hmcs-restart-test-' + port + '.log');
  const fd = fs.openSync(out, 'a');
  const args = [APP, '--home', home, '--log-file', ...extraArgs];
  if (port) args.push('--port', String(port));
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  child.__log = out;
  return child;
}

function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

function readLog(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

(async () => {
  console.log('\n== 重启链路自测 ==');
  for (const p of [PORT, PORT2]) {
    if (!(await portFree(p))) { console.log(`  端口 ${p} 被占用，先关掉占用的程序再跑`); process.exit(1); }
  }

  // ============================================================
  // 场景 1：正常重启 —— 新进程接管端口
  // ============================================================
  console.log('\n-- 场景 1：点「立即重启」--');
  const home1 = path.join(os.tmpdir(), 'hmcs-restart-a');
  fs.rmSync(home1, { recursive: true, force: true });
  const A = startApp(PORT, home1);
  const aUp = await waitPing(PORT, 15000);
  check('A 正常启动', !!aUp, '等待 ping 超时');
  if (!aUp) { A.kill(); process.exit(1); }
  const pidA = aUp.pid;

  const r = await post(PORT, '/api/system/restart');
  check('重启接口返回 200 且声明重启中', r.status === 200 && /"restarting":true/.test(r.body), r.body);

  const after = await waitPing(PORT, 30000, pidA);
  check('重启后端口重新有人监听', !!after, '等待新进程超时');
  check('接管的是新进程（pid 变了）', !!after && after.pid !== pidA, `旧=${pidA} 新=${after && after.pid}`);
  const logA = readLog(A.__log);
  check('日志记录了拉起新进程', /已拉起新进程/.test(logA));

  await post(PORT, '/api/system/shutdown');
  await sleep(1500);
  try { A.kill(); } catch { /* ignore */ }

  // ============================================================
  // 场景 2：新进程启动即崩 —— 老进程必须留下来继续服务
  // 手段：把 settings.json 改成一个「对外开放但没密码」的非法配置，
  // 新进程启动时会走安全检查 exit(2)。
  // ============================================================
  console.log('\n-- 场景 2：新进程起不来时的保护 --');
  const home2 = path.join(os.tmpdir(), 'hmcs-restart-b');
  fs.rmSync(home2, { recursive: true, force: true });
  fs.mkdirSync(home2, { recursive: true });
  const B = startApp(PORT2, home2);
  const bUp = await waitPing(PORT2, 15000);
  check('B 正常启动（合法配置）', !!bUp, '等待 ping 超时');
  if (!bUp) { B.kill(); process.exit(1); }

  const cfgFile = path.join(home2, 'settings.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.host = '0.0.0.0';
  cfg.auth = { enabled: false, onlyRemote: true, hash: '' };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');

  await post(PORT2, '/api/system/restart');
  await sleep(4000);
  const bAfter = await ping(PORT2);
  check('新进程崩了之后，老进程仍在服务', !!bAfter && bAfter.pid === bUp.pid, JSON.stringify(bAfter));
  const logB = readLog(B.__log);
  check('日志说明重启已中止', /重启中止/.test(logB), logB.slice(-300));

  await post(PORT2, '/api/system/shutdown');
  await sleep(1200);
  try { B.kill(); } catch { /* ignore */ }

  // ============================================================
  // 场景 3：端口交接 —— 新进程在端口还被占着时会等，而不是直接报错退出
  // ============================================================
  console.log('\n-- 场景 3：端口交接 --');
  const home3 = path.join(os.tmpdir(), 'hmcs-restart-c');
  fs.rmSync(home3, { recursive: true, force: true });
  const C = startApp(PORT, home3);
  const cUp = await waitPing(PORT, 15000);
  check('C 正常启动', !!cUp, '等待 ping 超时');
  if (!cUp) { C.kill(); process.exit(1); }

  const D = startApp(PORT, home3, { HMCS_RESTART_HANDOFF: '1' });
  await sleep(1200);
  const stillC = await ping(PORT);
  check('D 没有抢端口（C 仍在服务）', stillC && stillC.pid === cUp.pid);
  check('D 还在等（没退出）', D.exitCode === null);

  await post(PORT, '/api/system/shutdown');
  const dUp = await waitPing(PORT, 30000, cUp.pid);
  check('C 退出后 D 接管端口', !!dUp, '等待超时');
  if (dUp) check('接管的是 D', dUp.pid === D.pid, `C=${cUp.pid} D=${D.pid} 实际=${dUp.pid}`);
  check('D 日志里有「等待上一个进程释放端口」', /等待上一个进程释放端口/.test(readLog(D.__log)));

  await post(PORT, '/api/system/shutdown');
  await sleep(1200);
  try { D.kill(); } catch { /* ignore */ }
  try { C.kill(); } catch { /* ignore */ }

  for (const d of [home1, home2, home3]) fs.rmSync(d, { recursive: true, force: true });

  console.log(failed ? `\n${failed} 项失败\n` : '\n全部通过\n');
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('测试异常:', e);
  process.exit(1);
});
