#!/usr/bin/env node
'use strict';
/**
 * 「改完监听地址 / 端口 → 点立即重启 → 新配置真的生效」自测
 *
 * 覆盖界面黄条会永远挂着的几种真实成因：
 *   1) 启动时带了 --port / --host（命令行优先于 settings.json），重启又把参数原样继承
 *   2) 启动时带了 HMCS_PORT / HMCS_HOST 环境变量，重启又把环境继承
 *   3) 只改 host 不改端口
 *
 * 判定标准：重启后 /api/bootstrap 的 net.bind 必须等于 settings.json 里的 host/port。
 * 只要不等，界面上「重启后生效」的黄条就会一直挂着 —— 这就是本测试要守的东西。
 *
 * 用法：node _dev/_test-rebind.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app.js');
const BASE = Number(process.env.TEST_PORT || 8796);

let failed = 0;
function check(name, cond, detail = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || !detail ? '' : '  → ' + detail));
  if (!cond) failed++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(port, method, p, body) {
  return new Promise(resolve => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      host: '127.0.0.1', port, path: p, method, timeout: 4000,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, body: b, json: j }); });
    });
    r.on('error', e => resolve({ status: 0, body: e.message, json: null }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout', json: null }); });
    if (payload) r.write(payload);
    r.end();
  });
}

async function ping(port) {
  const r = await req(port, 'GET', '/api/system/ping');
  return r.json || null;
}

/** 需要看响应头时用这个（req 只留了 body） */
function rawGet(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', timeout: 4000, headers }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => {
        const h = Object.entries(res.headers).map(([k, v]) => k + ': ' + v).join('\n');
        resolve({ status: res.statusCode, headers: h, body: b });
      });
    });
    r.on('error', e => resolve({ status: 0, headers: '', body: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, headers: '', body: 'timeout' }); });
    r.end();
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

function startApp(port, home, { env = {}, args = [] } = {}) {
  const out = path.join(os.tmpdir(), 'hmcs-rebind-' + port + '.log');
  try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
  const fd = fs.openSync(out, 'a');
  const argv = [APP, '--home', home, '--log-file', ...args];
  if (port) argv.push('--port', String(port));
  const child = spawn(process.execPath, argv, {
    cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true,
    env: { ...process.env, HMCS_PORT: '', HMCS_HOST: '', ...env },
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

/** 造一个「已经设好密码」的配置，让对外开放的改动能通过校验 */
function seedHome(home) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
    host: '127.0.0.1', port: BASE,
    auth: { enabled: true, onlyRemote: true, hash: 'scrypt$16384$8$1$00$00', sessionDays: 7 },
  }, null, 2), 'utf8');
}

async function stopAll(child, port) {
  try { await req(port, 'POST', '/api/system/shutdown'); } catch { /* ignore */ }
  await sleep(1200);
  try { child.kill(); } catch { /* ignore */ }
}

(async () => {
  console.log('\n== 重启后新配置是否生效 ==');
  const ports = [BASE, BASE + 1, BASE + 2, BASE + 3];
  for (const p of ports) {
    if (!(await portFree(p))) { console.log(`  端口 ${p} 被占用，先关掉再跑`); process.exit(1); }
  }

  // ============================================================
  // 场景 1：启动时被 --port 钉住，设置里改成另一个端口
  // ============================================================
  console.log('\n-- 场景 1：CLI --port 覆盖 + 设置改端口 --');
  const home1 = path.join(os.tmpdir(), 'hmcs-rebind-a');
  seedHome(home1);
  const A = startApp(BASE, home1, { args: ['--allow-insecure'] });
  const aUp = await waitPing(BASE, 15000);
  check('A 正常启动', !!aUp, '等待 ping 超时');
  if (!aUp) { A.kill(); process.exit(1); }

  const put1 = await req(BASE, 'PUT', '/api/settings', { port: BASE + 1 });
  check('保存新端口返回 restartRequired', put1.status === 200 && put1.json && put1.json.restartRequired === true, put1.body);
  await req(BASE, 'POST', '/api/system/restart');

  const moved = await waitPing(BASE + 1, 30000, aUp.pid);
  check('新端口真的开始监听（黄条能消失）', !!moved, `端口 ${BASE + 1} 一直没起来`);
  if (moved) {
    const boot = await req(BASE + 1, 'GET', '/api/bootstrap');
    const bind = boot.json && boot.json.net && boot.json.net.bind;
    check('bind.port 等于 settings.port', !!bind && Number(bind.port) === BASE + 1, JSON.stringify(bind));
  } else {
    const still = await ping(BASE);
    console.log('        旧端口仍由 pid ' + (still && still.pid) + ' 监听（重启没换端口）');
  }
  await stopAll(A, moved ? BASE + 1 : BASE);

  // ============================================================
  // 场景 2：启动时被 HMCS_PORT 环境变量钉住
  // ============================================================
  console.log('\n-- 场景 2：HMCS_PORT 环境变量 + 设置改端口 --');
  const home2 = path.join(os.tmpdir(), 'hmcs-rebind-b');
  seedHome(home2);
  const B = startApp(BASE + 2, home2, { env: { HMCS_PORT: String(BASE + 2) }, args: ['--allow-insecure'] });
  const bUp = await waitPing(BASE + 2, 15000);
  check('B 正常启动', !!bUp, '等待 ping 超时');
  if (!bUp) { B.kill(); process.exit(1); }

  await req(BASE + 2, 'PUT', '/api/settings', { port: BASE + 3 });
  await req(BASE + 2, 'POST', '/api/system/restart');
  const moved2 = await waitPing(BASE + 3, 30000, bUp.pid);
  check('换端口后新进程不再被环境变量拽回旧端口', !!moved2, `端口 ${BASE + 3} 一直没起来`);
  await stopAll(B, moved2 ? BASE + 3 : BASE + 2);

  // ============================================================
  // 场景 3：只改监听地址（127.0.0.1 → 0.0.0.0）
  // ============================================================
  console.log('\n-- 场景 3：只改监听地址 --');
  const home3 = path.join(os.tmpdir(), 'hmcs-rebind-c');
  seedHome(home3);
  const C = startApp(BASE, home3, { args: ['--allow-insecure'] });
  const cUp = await waitPing(BASE, 15000);
  check('C 正常启动', !!cUp, '等待 ping 超时');
  if (!cUp) { C.kill(); process.exit(1); }

  const put3 = await req(BASE, 'PUT', '/api/settings', { host: '0.0.0.0' });
  check('保存 0.0.0.0 成功', put3.status === 200 && put3.json && put3.json.settings.host === '0.0.0.0', put3.body);
  await req(BASE, 'POST', '/api/system/restart');

  const back = await waitPing(BASE, 30000, cUp.pid);
  check('重启后端口恢复服务', !!back, '等待新进程超时');
  if (back) {
    const boot = await req(BASE, 'GET', '/api/bootstrap');
    const bind = boot.json && boot.json.net && boot.json.net.bind;
    const saved = boot.json && boot.json.settings && boot.json.settings.host;
    check('bind.host 变成 0.0.0.0', !!bind && bind.host === '0.0.0.0', JSON.stringify(bind));
    check('运行值 = 保存值（界面不会继续提示重启）', !!bind && bind.host === saved, `bind=${bind && bind.host} settings=${saved}`);
  }
  await stopAll(C, BASE);

  // ============================================================
  // 场景 4：跨端口探活（前端换了端口要能读到新进程）
  // 不带 Origin = 同源，必须带 pid；带别的 Origin = 跨源，必须有 CORS 头且不给 pid
  // ============================================================
  console.log('\n-- 场景 4：ping 的跨源探活 --');
  const home4 = path.join(os.tmpdir(), 'hmcs-rebind-d');
  seedHome(home4);
  const E = startApp(BASE, home4, { args: ['--allow-insecure'] });
  const eUp = await waitPing(BASE, 15000);
  check('E 正常启动', !!eUp, '等待 ping 超时');
  if (eUp) {
    const same = await req(BASE, 'GET', '/api/system/ping');
    check('同源 ping 返回 pid', !!(same.json && same.json.pid), same.body);

    const cross = await rawGet(BASE, '/api/system/ping', { origin: 'http://127.0.0.1:9999' });
    check('跨源 ping 带 Access-Control-Allow-Origin', /access-control-allow-origin: http:\/\/127\.0\.0\.1:9999/i.test(cross.headers), cross.headers);
    check('跨源 ping 不回 pid / 版本', !!/"ok":true/.test(cross.body) && !/"pid"/.test(cross.body) && !/"version"/.test(cross.body), cross.body);
    check('跨源 ping 仍带 port（前端靠它确认已切到新端口）', new RegExp('"port":' + BASE).test(cross.body), cross.body);
  }
  await stopAll(E, BASE);

  for (const d of [home1, home2, home3, home4]) fs.rmSync(d, { recursive: true, force: true });

  console.log(failed ? `\n${failed} 项失败\n` : '\n全部通过\n');
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('测试异常:', e);
  process.exit(1);
});
