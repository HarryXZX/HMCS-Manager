#!/usr/bin/env node
'use strict';
/**
 * 「公网访问地址（域名 / 反代）用户自己填」自测
 *
 * 这个字段只影响两件事：显示哪个地址、改端口重启后跳到哪。
 * 所以测试要守的是：
 *   1) 写法能归一（不带协议自动补 http://、去掉尾部斜杠、大小写域名）
 *   2) 危险写法必须拒绝（javascript: / data: / ftp: / 带账号密码 / 带查询串）
 *      —— 这个值会被直接拿去做 location.replace，放开等于给自己开后门
 *   3) 落盘、bootstrap、/api/system/info 三处读到的是同一个归一值
 *   4) 清空以后回到「按当前 IP + 端口」，不留残影
 *   5) 改这个字段不需要重启（restartRequired 必须为 false）
 *
 * 用法：node _dev/_test-publicurl.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app.js');
const HMCSM = path.join(ROOT, 'scripts', 'hmcsm.js');
const BASE = Number(process.env.TEST_PORT || 8794);

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
      host: '127.0.0.1', port, path: p, method, timeout: 5000,
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

async function waitPing(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await req(port, 'GET', '/api/system/ping');
    if (r.json && r.json.ok) return r.json;
    await sleep(300);
  }
  return null;
}

function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

function seedHome(home) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
    host: '127.0.0.1', port: BASE, publicUrl: '',
    auth: { enabled: false, onlyRemote: true, hash: '', sessionDays: 7 },
  }, null, 2), 'utf8');
}

function readSettingsFile(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')); } catch { return null; }
}

(async () => {
  console.log('\n== 公网访问地址（域名） ==');

  // ============================================================
  // 1. 归一化与拒绝规则（纯函数，不起进程）
  // ============================================================
  console.log('\n-- 1. 地址归一化 --');
  const paths = require('../lib/paths');
  const norm = v => { try { return paths.normalizePublicUrl(v); } catch { return 'ERR'; } };
  const rejects = v => { try { paths.normalizePublicUrl(v); return false; } catch { return true; } };

  check('不带协议自动补 http://', norm('mc.example.com') === 'http://mc.example.com', norm('mc.example.com'));
  check('带端口原样保留', norm('mc.example.com:8720') === 'http://mc.example.com:8720', norm('mc.example.com:8720'));
  check('https 保留协议', norm('https://mc.example.com') === 'https://mc.example.com', norm('https://mc.example.com'));
  check('尾部斜杠去掉', norm('https://mc.example.com/') === 'https://mc.example.com', norm('https://mc.example.com/'));
  check('域名转小写', norm('https://MC.Example.COM') === 'https://mc.example.com', norm('https://MC.Example.COM'));
  check('保留一级路径并去尾斜杠', norm('https://mc.example.com/hmcs/') === 'https://mc.example.com/hmcs', norm('https://mc.example.com/hmcs/'));
  check('空值归一为空串', norm('') === '' && norm('   ') === '');
  check('拒绝 javascript:', rejects('javascript:alert(1)') && rejects('javascript://x/%0aalert(1)'));
  check('拒绝 data:', rejects('data:text/html,<script>alert(1)</script>'));
  check('拒绝 ftp:', rejects('ftp://mc.example.com'));
  check('拒绝带账号密码', rejects('https://user:pass@mc.example.com'));
  check('拒绝带查询串 / 片段', rejects('https://mc.example.com/?a=1') && rejects('https://mc.example.com/#x'));
  check('拒绝空格 / 尖括号', rejects('mc example.com') && rejects('<script>mc.example.com'));
  check('publicOrigin 取出 scheme://host:port', paths.publicOrigin('https://mc.example.com/hmcs') === 'https://mc.example.com', paths.publicOrigin('https://mc.example.com/hmcs'));
  check('publicBasePath 取出路径前缀', paths.publicBasePath('https://mc.example.com/hmcs/') === '/hmcs', paths.publicBasePath('https://mc.example.com/hmcs/'));

  // ============================================================
  // 2. 接口：保存 / 读回 / 清空
  // ============================================================
  const port = BASE;
  if (!(await portFree(port))) { console.log(`  端口 ${port} 被占用，先关掉再跑`); process.exit(1); }
  const home = path.join(os.tmpdir(), 'hmcs-publicurl');
  seedHome(home);

  const logFile = path.join(os.tmpdir(), 'hmcs-publicurl.log');
  try { fs.rmSync(logFile, { force: true }); } catch { /* ignore */ }
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [APP, '--home', home, '--port', String(port), '--log-file'], {
    cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, HMCS_PORT: '', HMCS_HOST: '' },
  });

  const up = await waitPing(port);
  check('面板正常启动', !!up, '等待 ping 超时');
  if (!up) { try { child.kill(); } catch { /* ignore */ } process.exit(1); }

  console.log('\n-- 2. 接口保存与读回 --');
  const boot0 = await req(port, 'GET', '/api/bootstrap');
  check('默认 publicUrl 为空', boot0.json && boot0.json.net && boot0.json.net.publicUrl === '', JSON.stringify(boot0.json && boot0.json.net));
  check('默认地址列表只有本机 / 局域网', boot0.json && boot0.json.net.urls[0] === `http://127.0.0.1:${port}`, JSON.stringify(boot0.json && boot0.json.net.urls));

  const put1 = await req(port, 'PUT', '/api/settings', { publicUrl: 'mc.example.com' });
  check('保存域名返回 200', put1.status === 200, put1.body);
  check('保存后归一成 http://mc.example.com', put1.json && put1.json.settings.publicUrl === 'http://mc.example.com', put1.body);
  check('改域名不需要重启（restartRequired=false）', put1.json && put1.json.restartRequired === false, put1.body);
  check('落盘的是归一值', readSettingsFile(home).publicUrl === 'http://mc.example.com', JSON.stringify(readSettingsFile(home).publicUrl));

  const boot1 = await req(port, 'GET', '/api/bootstrap');
  check('bootstrap 读到 publicUrl', boot1.json && boot1.json.net.publicUrl === 'http://mc.example.com', JSON.stringify(boot1.json && boot1.json.net.publicUrl));
  check('bootstrap 地址列表把域名排第一', boot1.json && boot1.json.net.urls[0] === 'http://mc.example.com', JSON.stringify(boot1.json && boot1.json.net.urls));

  const info1 = await req(port, 'GET', '/api/system/info');
  check('/api/system/info 也带域名（命令行 status 用的就是它）', info1.json && info1.json.urls[0] === 'http://mc.example.com', JSON.stringify(info1.json && info1.json.urls));

  const put2 = await req(port, 'PUT', '/api/settings', { publicUrl: 'https://MC.Example.COM/hmcs/' });
  check('带路径 / 大写 / 尾斜杠也能归一', put2.json && put2.json.settings.publicUrl === 'https://mc.example.com/hmcs', put2.body);

  console.log('\n-- 3. 非法值必须拒绝 --');
  for (const bad of ['ftp://mc.example.com', 'javascript:alert(1)', 'data:text/html,x', 'https://a:b@mc.example.com', 'mc example.com']) {
    const r = await req(port, 'PUT', '/api/settings', { publicUrl: bad });
    check('拒绝 ' + bad + '（400）', r.status === 400, `status=${r.status} ${r.body.slice(0, 80)}`);
  }
  check('非法值没把已保存的地址冲掉', readSettingsFile(home).publicUrl === 'https://mc.example.com/hmcs', JSON.stringify(readSettingsFile(home).publicUrl));

  console.log('\n-- 4. 清空 --');
  const put3 = await req(port, 'PUT', '/api/settings', { publicUrl: '' });
  check('清空返回 200 且值为空', put3.status === 200 && put3.json && put3.json.settings.publicUrl === '', put3.body);
  const boot2 = await req(port, 'GET', '/api/bootstrap');
  check('清空后地址列表回到本机地址', boot2.json && boot2.json.net.urls[0] === `http://127.0.0.1:${port}`, JSON.stringify(boot2.json && boot2.json.net.urls));

  // ============================================================
  // 3. 命令行：hmcsm url
  // ============================================================
  console.log('\n-- 5. hmcsm url --');
  const env = { ...process.env, HMCS_HOME: home };
  const set = spawnSync(process.execPath, [HMCSM, 'url', 'mc.hycxit.top:8720', '--home', home], { encoding: 'utf8', env });
  check('hmcsm url <地址> 执行成功', set.status === 0, set.stderr || set.stdout);
  check('命令行写入的是归一值', readSettingsFile(home).publicUrl === 'http://mc.hycxit.top:8720', JSON.stringify(readSettingsFile(home).publicUrl));

  const shown = spawnSync(process.execPath, [HMCSM, 'url', '--home', home], { encoding: 'utf8', env });
  check('hmcsm url 能显示当前地址', /http:\/\/mc\.hycxit\.top:8720/.test(shown.stdout), shown.stdout);

  const cleared = spawnSync(process.execPath, [HMCSM, 'url', 'off', '--home', home], { encoding: 'utf8', env });
  check('hmcsm url off 能清除', cleared.status === 0 && readSettingsFile(home).publicUrl === '', cleared.stdout + JSON.stringify(readSettingsFile(home).publicUrl));

  const rejected = spawnSync(process.execPath, [HMCSM, 'url', 'ftp://x.com', '--home', home], { encoding: 'utf8', env });
  check('hmcsm url 拒绝非法协议（退出码 1）', rejected.status === 1 && readSettingsFile(home).publicUrl === '', `status=${rejected.status} ${rejected.stdout}`);

  try { await req(port, 'POST', '/api/system/shutdown'); } catch { /* ignore */ }
  await sleep(1200);
  try { child.kill(); } catch { /* ignore */ }
  fs.rmSync(home, { recursive: true, force: true });

  console.log('');
  if (failed) { console.log(`  ${failed} 项失败`); process.exit(1); }
  console.log('  全部通过');
})().catch(e => { console.error(e); process.exit(1); });
