#!/usr/bin/env node
'use strict';
/**
 * 「启动时自动映射」为什么没生效 —— 回归自测
 *
 * 复现的场景：用户在设置页勾了「启动时自动映射」，后来监听地址被改回
 * 127.0.0.1。启动时 selfUpnp.auto && !localOnly 不成立 → 静默跳过；
 * 界面上开关还勾着、状态只写「当前没有映射」，完全没有原因，看起来就是坏了。
 *
 * 守的点：
 *   1) status() 能根据实际 bind host 算出 blocked + 可执行的 hint
 *   2) auto 与监听地址两步可以任意顺序：仅本机时保存 auto 不该 400
 *   3) bootstrap / /api/net/self 都把 hint 带给界面
 *   4) 启动时日志明确说明「本次未建立映射」及修复办法
 *   5) hmcsm / 菜单启动不再把 settings 的 host:port 当命令行参数回传
 *
 * 全程使用临时配置目录，不会碰真实路由器，也不会改用户配置。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app.js');
const PORT = Number(process.env.TEST_SELFMAP_PORT || 8787);
const HOME = path.join(os.tmpdir(), 'hmcs-selfmap-test-' + process.pid);

// 必须在 require lib/paths 之前设置，否则配置目录已经算完了
process.env.HMCS_HOME = HOME;
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const paths = require('../lib/paths');
const selfmap = require('../lib/selfmap');
const launch = require('../scripts/launch');

let failed = 0;
function check(name, cond, detail = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || !detail ? '' : '  → ' + detail));
  if (!cond) failed++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(port, method, p, body) {
  return new Promise(resolve => {
    const payload = body !== undefined ? JSON.stringify(body) : '';
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
    if (r.json && r.json.ok) return true;
    await sleep(250);
  }
  return false;
}

const SELF = {
  auto: true, externalPort: PORT, protocol: 'TCP', lease: 0,
  added: [], lastError: '', lastSync: '',
};

async function main() {
  console.log('\n== status()：把「为什么没生效」算出来 ==');
  paths.writeSettings({ host: '127.0.0.1', port: PORT, publicUrl: '', selfUpnp: SELF });

  let st = selfmap.status({ port: PORT, bindHost: '127.0.0.1' });
  check('auto + 仅本机监听 → blocked=true', st.blocked === true);
  check('hint 点明 127.0.0.1 和修复步骤', /127\.0\.0\.1/.test(st.hint) && /监听地址/.test(st.hint) && /重启/.test(st.hint), st.hint);
  check('ready=false，没有假装映射已建立', st.ready === false && st.added.length === 0);

  st = selfmap.status({ port: PORT, bindHost: '0.0.0.0' });
  check('换成外部监听后不再 blocked', st.blocked === false);
  check('未建立映射时仍给可执行的下一步', /立即映射|重启/.test(st.hint), st.hint);

  paths.writeSettings({ selfUpnp: { ...SELF, auto: false } });
  st = selfmap.status({ port: PORT, bindHost: '127.0.0.1' });
  check('auto 关闭时不多嘴（hint 为空）', st.hint === '' && st.blocked === false);

  console.log('\n== 启动参数：不再把 settings 的 host/port 回传 ==');
  const a = launch.buildArgs({ recordPort: PORT, recordHost: '0.0.0.0' });
  check('菜单 / hmcsm 启动不带 --host / --port',
    !a.includes('--host') && !a.includes('--port') && a.includes('--log-file'), a.join(' '));
  const b = launch.buildArgs({ port: 8800, host: '0.0.0.0' });
  check('用户显式给的参数仍然传入', b.includes('--port') && b.includes('8800') && b.includes('--host'));
  const c = launch.buildArgs({ home: HOME, extraArgs: ['--allow-insecure'] });
  check('--home 与其它参数不受影响', c.includes('--home') && c.includes('--allow-insecure'));

  console.log('\n== 起临时实例：接口与启动日志 ==');
  // 恢复 auto=true，且保持仅本机监听（不会真的去路由器建映射）
  paths.writeSettings({ selfUpnp: SELF });
  const logFile = path.join(HOME, 'app.log');
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [APP, '--home', HOME, '--log-file'], {
    cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true,
    env: { ...process.env, HMCS_PORT: '', HMCS_HOST: '' },
  });
  const up = await waitPing(PORT);
  check('临时实例已启动', up);
  if (!up) {
    try { child.kill(); } catch { /* ignore */ }
    fs.closeSync(fd);
    console.log('\nFAILED ' + failed + '\n');
    process.exit(1);
  }

  const put = await req(PORT, 'PUT', '/api/net/self', { auto: true, externalPort: PORT, protocol: 'TCP' });
  check('仅本机监听时保存 auto 不再 400', put.status === 200, `status=${put.status} body=${put.body.slice(0, 160)}`);
  check('  PUT 返回 blocked + hint', !!(put.json && put.json.self && put.json.self.blocked && put.json.hint));
  check('  auto 确实落盘', selfmap.cfg().auto === true);

  const boot = await req(PORT, 'GET', '/api/bootstrap');
  const ns = boot.json && boot.json.net && boot.json.net.selfUpnp;
  check('bootstrap 带上 hint（设置页读的就是它）', !!(ns && ns.hint && /127\.0\.0\.1/.test(ns.hint)),
    ns ? ns.hint : 'net.selfUpnp 缺失');
  check('bootstrap 标出 blocked', !!(ns && ns.blocked === true));

  const self = await req(PORT, 'GET', '/api/net/self');
  check('/api/net/self 的 hint 不再是空话', !!(self.json && self.json.hint && /监听地址/.test(self.json.hint)));

  const manual = await req(PORT, 'POST', '/api/net/selfmap', {});
  check('手动映射在仅本机时仍有 400 门禁（合理保留）', manual.status === 400, `status=${manual.status}`);

  await sleep(400);
  const log = fs.readFileSync(logFile, 'utf8');
  check('启动日志明确写出「本次未建立映射」', /已开启「启动时自动映射」/.test(log) && /本次未建立映射/.test(log));
  check('启动日志给出修复办法', /监听地址/.test(log) && /重启/.test(log));
  check('不再出现误导性的「命令行覆盖监听参数」', !/命令行覆盖监听参数/.test(log));

  try { child.kill(); } catch { /* ignore */ }
  await sleep(300);
  fs.closeSync(fd);
  fs.rmSync(HOME, { recursive: true, force: true });

  console.log(`\n${failed ? 'FAILED ' + failed : '全部通过'}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
