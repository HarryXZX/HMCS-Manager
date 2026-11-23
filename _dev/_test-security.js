'use strict';
/**
 * 访问控制 / 端口行为 自测
 *
 *   node _dev/_test-security.js
 *
 * 用临时 HMCS_HOME 起一个独立实例（不动真实配置），逐项断言：
 * 密码设置、会话 Cookie、仅远程免密、跨站拦截、错误次数与锁定、控制令牌、
 * 固定端口（被占用时不漂移）、对外监听但无密码时拒绝启动。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app.js');
const PORT = 8799;
let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tmpHome(tag) {
  const d = path.join(os.tmpdir(), 'hmcs-test-' + tag + '-' + Date.now());
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function startApp(home, extraArgs = [], extraEnv = {}) {
  const child = spawn(process.execPath, [APP, '--port', String(PORT), '--host', '127.0.0.1', '--home', home, ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, HMCS_HOME: home, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', d => logs.push(String(d)));
  child.stderr.on('data', d => logs.push(String(d)));
  return { child, logs };
}

async function waitUp(timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/system/ping`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

async function waitExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise(resolve => {
    const t = setTimeout(() => resolve('timeout'), timeoutMs);
    child.once('exit', code => { clearTimeout(t); resolve(code); });
  });
}

const req = (p, opts = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, opts);

async function json(p, opts = {}) {
  const r = await req(p, opts);
  let data = {};
  try { data = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, data, headers: r.headers };
}

function body(obj, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return { method: 'PUT', headers, body: JSON.stringify(obj) };
}

(async function main() {
  const home = tmpHome('sec');
  console.log('临时数据目录: ' + home);
  const { child, logs } = startApp(home);

  try {
    check('实例启动', await waitUp(), logs.join(''));

    // ---- 默认状态
    let r = await json('/api/bootstrap');
    check('未设密码时 bootstrap 可用', r.status === 200, 'status=' + r.status);
    check('默认 auth.enabled=false', r.data.auth && r.data.auth.enabled === false);
    check('默认只监听 127.0.0.1', r.data.net && r.data.net.bind.localOnly === true, JSON.stringify(r.data.net && r.data.net.bind));
    check('默认端口被固定为 8799', r.data.net && r.data.net.bind.port === PORT);

    const page = await req('/');
    check('未启用密码时首页直接 200', page.status === 200);

    // ---- 对外开放但不设密码，必须被拒
    r = await json('/api/settings', body({ host: '0.0.0.0' }));
    check('无密码时拒绝改成对外监听', r.status === 400, JSON.stringify(r.data));
    check('拒绝理由提到密码', /密码/.test(r.data.error || ''));

    // ---- 设置密码
    r = await json('/api/auth/password', body({ password: 'short' }));
    check('过短密码被拒', r.status === 400, JSON.stringify(r.data));

    r = await json('/api/auth/password', body({ password: '12345678' }));
    check('弱密码被拒', r.status === 400, JSON.stringify(r.data));

    r = await json('/api/auth/password', body({ password: 'HMCS-test-2026' }));
    check('设置密码成功', r.status === 200, JSON.stringify(r.data));
    check('返回 enabled=true', r.data.auth && r.data.auth.enabled === true);
    const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')])[0] || '';
    check('下发会话 Cookie', /hmcs_sid=/.test(cookie), cookie);
    check('Cookie 带 HttpOnly', /HttpOnly/i.test(cookie));
    check('Cookie 带 SameSite', /SameSite=Lax/i.test(cookie));
    check('本地 HTTP 不加 Secure（否则浏览器不会回传）', !/;\s*Secure/i.test(cookie));

    const settingsNow = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    check('settings.json 存的是哈希不是明文', /^scrypt\$/.test(settingsNow.auth.hash) && !JSON.stringify(settingsNow).includes('HMCS-test-2026'));

    // ---- 本机免密（onlyRemote 默认 true）
    r = await json('/api/bootstrap');
    check('本机无 Cookie 仍可访问（onlyRemote）', r.status === 200, 'status=' + r.status);

    // ---- 会话可用
    const sid = cookie.split(';')[0];
    r = await json('/api/system/info', { headers: { Cookie: sid } });
    check('带 Cookie 可访问受保护接口', r.status === 200, 'status=' + r.status);

    // ---- 有密码后允许改对外监听（并且标记需要重启）
    r = await json('/api/settings', body({ host: '0.0.0.0' }, sid));
    check('设了密码后可以改成对外监听', r.status === 200, JSON.stringify(r.data));
    check('改监听地址会提示需要重启', r.data.restartRequired === true);
    r = await json('/api/settings', body({ host: '127.0.0.1' }, sid));
    // 测试用 --port 覆写启动，settings.port 与运行端口不同，restartRequired 必然为 true，这里只校验 host 落盘
    check('可以改回仅本机', r.status === 200 && r.data.settings.host === '127.0.0.1', JSON.stringify(r.data.settings && r.data.settings.host));
    r = await json('/api/settings', body({ port: 70000 }, sid));
    check('非法端口被拒', r.status === 400, JSON.stringify(r.data));

    // ---- 改成所有访问都要密码
    r = await json('/api/auth/options', body({ onlyRemote: false }));
    check('关闭本机免密', r.status === 200, JSON.stringify(r.data));
    r = await json('/api/bootstrap');
    check('无 Cookie 时接口返回 401', r.status === 401, 'status=' + r.status);
    check('401 带 authRequired 标记', r.data.authRequired === true);

    const home2 = await req('/', { redirect: 'manual' });
    check('页面重定向到登录页', home2.status === 302 && /\/login/.test(home2.headers.get('location') || ''), home2.status + ' ' + home2.headers.get('location'));
    const loginPage = await req('/login');
    check('登录页可访问', loginPage.status === 200);

    r = await json('/api/auth/state');
    check('auth/state 免登录可读', r.status === 200 && r.data.enabled === true, 'status=' + r.status);
    check('auth/state 不含哈希', !JSON.stringify(r.data).includes('scrypt$'));

    // ---- 跨站请求
    r = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ password: 'HMCS-test-2026' }),
    });
    check('跨站 Origin 被拒', r.status === 403, 'status=' + r.status);

    // ---- 登录
    r = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}` },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    check('错误密码 401', r.status === 401, 'status=' + r.status);
    check('提示剩余次数', r.data.attemptsLeft === 4, JSON.stringify(r.data));

    r = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'HMCS-test-2026' }),
    });
    check('正确密码登录成功', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
    const cookie2 = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')])[0] || '';
    r = await json('/api/bootstrap', { headers: { Cookie: cookie2.split(';')[0] } });
    check('登录后可访问', r.status === 200, 'status=' + r.status);

    // ---- 控制令牌（服务脚本用）
    const ctl = fs.readFileSync(path.join(home, 'control.token'), 'utf8').trim();
    check('control.token 已生成（32 字节 hex）', /^[0-9a-f]{64}$/.test(ctl), ctl.slice(0, 12));
    r = await json('/api/system/info', { headers: { 'X-HMCS-Control': ctl } });
    check('控制令牌可免密码访问', r.status === 200, 'status=' + r.status);
    r = await json('/api/system/info', { headers: { 'X-HMCS-Control': 'deadbeef' } });
    check('错误控制令牌无效', r.status === 401, 'status=' + r.status);

    // ---- 改密码：要求旧密码 + 旧会话失效
    const before = cookie2.split(';')[0];
    r = await json('/api/auth/password', body({ password: 'HMCS-test-2027' }, before));
    check('改密码必须提供旧密码', r.status === 400, JSON.stringify(r.data));
    r = await json('/api/auth/password', body({ current: 'nope', password: 'HMCS-test-2027' }, before));
    check('旧密码错误时改密码失败', r.status === 401, JSON.stringify(r.data));
    r = await json('/api/auth/password', body({ current: 'HMCS-test-2026', password: 'HMCS-test-2027' }, before));
    check('改密码成功', r.status === 200, JSON.stringify(r.data));
    const cookie3 = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')])[0] || '';
    r = await json('/api/bootstrap', { headers: { Cookie: before } });
    check('改密码后旧会话失效', r.status === 401, 'status=' + r.status);
    r = await json('/api/bootstrap', { headers: { Cookie: cookie3.split(';')[0] } });
    check('改密码后当前浏览器仍在线', r.status === 200, 'status=' + r.status);

    // ---- 退出
    r = await json('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie3.split(';')[0] } });
    check('退出登录成功', r.status === 200);
    r = await json('/api/bootstrap', { headers: { Cookie: cookie3.split(';')[0] } });
    check('退出后 Cookie 失效', r.status === 401, 'status=' + r.status);

    // ---- 错误次数锁定（放最后，会锁住这个 IP）
    let lockedAt = 0;
    for (let i = 0; i < 7; i++) {
      const rr = await json('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-' + i }),
      });
      if (rr.status === 429) { lockedAt = i + 1; break; }
    }
    check('连续错误触发锁定（429）', lockedAt > 0 && lockedAt <= 7, '第 ' + lockedAt + ' 次');

    // ---- 优雅关闭
    r = await json('/api/system/shutdown', { method: 'POST', headers: { 'X-HMCS-Control': ctl } });
    check('控制令牌可发起关闭', r.status === 200);
    const code = await waitExit(child);
    check('进程按优雅流程退出', code === 0, 'exitCode=' + code);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }

  // ---- 固定端口：被占用时不漂移
  console.log('\n固定端口行为');
  const blocker = require('net').createServer();
  await new Promise(res => blocker.listen(PORT, '127.0.0.1', res));
  const home2 = tmpHome('busy');
  const app2 = startApp(home2);
  const code2 = await waitExit(app2.child, 12000);
  blocker.close();
  check('端口被占用时直接退出，不自动换端口', code2 === 1, 'exitCode=' + code2);
  check('给出占用排查提示', /已被其他程序占用/.test(app2.logs.join('')), app2.logs.join('').slice(-200));
  check('没有偷偷监听 8800', !(await fetch(`http://127.0.0.1:${PORT + 1}/api/system/ping`).then(() => true).catch(() => false)));

  // ---- 对外监听但无密码：拒绝启动
  console.log('\n对外监听的安全检查');
  const home3 = tmpHome('insecure');
  const app3 = (() => {
    const c = spawn(process.execPath, [APP, '--port', String(PORT), '--host', '0.0.0.0', '--home', home3], {
      cwd: ROOT, env: { ...process.env, HMCS_HOME: home3 }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    c.stdout.on('data', d => logs.push(String(d)));
    c.stderr.on('data', d => logs.push(String(d)));
    return { child: c, logs };
  })();
  const code3 = await waitExit(app3.child, 12000);
  check('对外监听 + 无密码 → 退出码 2', code3 === 2, 'exitCode=' + code3);
  check('提示说明原因与做法', /还没有设置访问密码/.test(app3.logs.join('')), app3.logs.join('').slice(-300));

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  for (const d of [home, home2, home3]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试脚本异常：', e);
  process.exit(1);
});
