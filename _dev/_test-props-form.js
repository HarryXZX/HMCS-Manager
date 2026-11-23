#!/usr/bin/env node
'use strict';
/**
 * server.properties 表单模式 —— 回归自测
 *
 * 复现：配置页侧栏点「server.properties」，导航项用的是文件名，而 props 表单
 * 分支认的是哨兵值 'props'。于是掉进 YAML 文件树：js-yaml 把整个 .properties
 * 读成一个长字符串，表单控件全没了，只剩一坨纯文本；点「重载」又因 cfgTarget
 * 仍「合法」而一直回不到表单；保存还会用 yaml.dump 把文件彻底毁掉。
 *
 * 守的点：
 *   A. 源码层：cfgTarget 归一化、导航用 'props'、renderFileConfig 短路 .properties、
 *      重载只重读当前视图、后端拒绝把 .properties 当 YAML 解析/结构化保存
 *   B. API 层：临时实例真实请求，确认 kind=props/data=null、结构化保存被拒且文件不变、
 *      文本模式仍可写、普通 YAML 仍可表单编辑、专用表单保存不丢注释/反斜杠
 *   C. 前端运行层：DOM 桩加载 public/app.js，模拟旧状态 / 点导航 / 点重载，
 *      断言 #cfg-main 里始终是表单控件（data-k=...），不再是一坨纯文本
 *
 * 全程用临时 HMCS_HOME + 临时端口，不碰用户真实配置与正在运行的服务。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app.js');
const PORT = Number(process.env.TEST_PROPS_PORT || 8801);
const HOME = path.join(os.tmpdir(), 'hmcs-props-test-' + process.pid);
const SERVER_DIR = path.join(HOME, 'fake-server');
const PROPS_FILE = path.join(SERVER_DIR, 'server.properties');

const PROPS_TEXT = `#Minecraft server properties
#Mon Nov 23 13:12:58 CST 2026
motd=zxk你好
server-port=25565
level-type=minecraft\\:normal
online-mode=true
max-players=20
view-distance=10
`;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = `http://127.0.0.1:${PORT}`;
let TOKEN = '';

async function req(p, opts = {}) {
  const init = { ...opts, headers: { 'x-hmcs-control': TOKEN, ...(opts.headers || {}) } };
  const r = await fetch(BASE + p, init);
  let data = {};
  const text = await r.text();
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  return { status: r.status, data, text };
}
const put = (p, obj) => req(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// ---------------------------------------------------------------- 准备临时环境
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(SERVER_DIR, { recursive: true });
fs.writeFileSync(PROPS_FILE, PROPS_TEXT, 'utf8');
fs.writeFileSync(path.join(SERVER_DIR, 'eula.txt'), 'eula=true\n', 'utf8');
fs.writeFileSync(path.join(SERVER_DIR, 'test.yml'), 'a: 1\nb: true\n', 'utf8');
fs.writeFileSync(path.join(HOME, 'instances.json'), JSON.stringify({
  version: 2,
  instances: [{
    id: 'hycraft', name: 'HYCraft', type: 'vanilla', mcVersion: '26.3',
    coreFile: 'server-26.3.jar', worldName: 'world', port: 25565, memory: '2G',
    eula: true, dir: SERVER_DIR,
  }],
}, null, 2), 'utf8');

// ---------------------------------------------------------------- A. 源码断言
console.log('\n[A] 源码层');
const FE = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const BE = fs.readFileSync(APP, 'utf8');
check('viewConfig 把历史值 server.properties 归一化为 props',
  /state\.cfgTarget === 'server\.properties'\) state\.cfgTarget = 'props'/.test(FE));
check('导航项对 props 使用哨兵值 data-cfg="props"',
  /targetOf = f => \(f\.kind === 'props' \? 'props' : f\.file\)/.test(FE) &&
  /data-cfg="\$\{esc\(targetOf\(f\)\)\}"/.test(FE));
check('点击导航也把文件名落回 props',
  /b\.dataset\.cfg === 'server\.properties' \? 'props'/.test(FE));
check('renderFileConfig 对 .properties 直接短路回专用表单',
  /if \(\\\/\.properties\$\/i\.test\(file\)\) \{ state\.cfgTarget = 'props'; return renderPropsForm\(i\); \}/.test(FE) ||
  FE.includes("if (/\\.properties$/i.test(file)) { state.cfgTarget = 'props'; return renderPropsForm(i); }"));
check('props 表单有「文本模式」和「重载」按钮',
  FE.includes('id="cfg-raw">文本模式') && FE.includes('id="cfg-reload">重载'));
check('props 表单的重载只重读表单本身',
  FE.includes("$('#cfg-reload').onclick = () => renderPropsForm(i);"));
check('YAML 表单的重载只重读当前文件',
  FE.includes("$('#cfg-reload').onclick = () => renderFileConfig(i, file);"));
check('EULA 的重载只重读 EULA',
  FE.includes("$('#eu-reload').onclick = () => renderEula(i);"));
check('非对象/非数组数据不再画成文本，也不给保存按钮',
  FE.includes("data.data === null || typeof data.data !== 'object'"));
check('后端 GET 识别 .properties 并拒绝 YAML 解析',
  BE.includes("const isProps = /\\.properties$/i.test(rel);") && BE.includes("error = 'server.properties 不是 YAML/JSON"));
check('后端 PUT 拒绝按 YAML/JSON 结构保存 .properties',
  BE.includes("if (isProps) throw new Error('server.properties 不能按 YAML/JSON 结构保存"));
check('后端 PUT 允许空的 raw（文本模式清空文件）',
  /if \(typeof body\.raw === 'string'\) out = body\.raw;/.test(BE));

// ---------------------------------------------------------------- B. API 断言
async function testApi() {
  console.log('\n[B] API 层（临时实例）');
  const r0 = await req('/api/instances/hycraft/config/properties');
  check('专用表单接口可用', r0.status === 200 && r0.data.exists === true, JSON.stringify(r0.data).slice(0, 120));
  check('values 保留中文 motd', r0.data.values && r0.data.values.motd === 'zxk你好', JSON.stringify(r0.data.values && r0.data.values.motd));
  check('values 保留反斜杠 level-type', r0.data.values && r0.data.values['level-type'] === 'minecraft\\:normal');
  check('专用表单返回 schema', Array.isArray(r0.data.schema) && r0.data.schema.length > 0);

  const f = await req('/api/instances/hycraft/config/file?file=server.properties');
  check('config/file 把 .properties 标记为 props', f.status === 200 && f.data.kind === 'props', JSON.stringify(f.data.kind));
  check('不再返回一整坨字符串当表单数据', f.data.data === null, JSON.stringify(f.data.data).slice(0, 100));
  check('返回明确原因而不是「解析失败」', /不是 YAML\/JSON/.test(f.data.error || ''), f.data.error);
  check('原文仍完整交给文本模式', f.data.raw === PROPS_TEXT);

  const before = fs.readFileSync(PROPS_FILE, 'utf8');
  const bad = await put('/api/instances/hycraft/config/file', { file: 'server.properties', data: { a: 1 } });
  check('结构化保存 .properties 被拒绝', bad.status >= 400, 'status=' + bad.status);
  check('被拒后文件一字未改', fs.readFileSync(PROPS_FILE, 'utf8') === before);

  const rawPut = await put('/api/instances/hycraft/config/file', { file: 'server.properties', raw: PROPS_TEXT + 'hmcs-test=1\n' });
  check('文本模式仍可保存 .properties', rawPut.status === 200 && rawPut.data.ok === true, JSON.stringify(rawPut.data));
  check('文本模式写入生效', fs.readFileSync(PROPS_FILE, 'utf8').includes('hmcs-test=1'));
  const empty = await put('/api/instances/hycraft/config/file', { file: 'server.properties', raw: '' });
  check('文本模式允许清空内容', empty.status === 200 && fs.readFileSync(PROPS_FILE, 'utf8') === '');
  fs.writeFileSync(PROPS_FILE, PROPS_TEXT, 'utf8'); // 还原

  const y = await req('/api/instances/hycraft/config/file?file=test.yml');
  check('普通 YAML 仍可表单解析', y.status === 200 && y.data.data && y.data.data.a === 1, JSON.stringify(y.data.data));
  const yp = await put('/api/instances/hycraft/config/file', { file: 'test.yml', data: { a: 2, b: true } });
  check('普通 YAML 仍可结构化保存', yp.status === 200 && yp.data.ok === true);
  check('YAML 保存值正确', fs.readFileSync(path.join(SERVER_DIR, 'test.yml'), 'utf8').includes('a: 2'));

  const sv = await put('/api/instances/hycraft/config/properties', { values: { motd: '改过了', 'server-port': '25566' } });
  check('专用表单保存成功', sv.status === 200 && sv.data.ok === true);
  const after = fs.readFileSync(PROPS_FILE, 'utf8');
  check('注释与顺序保留', after.startsWith('#Minecraft server properties') && after.indexOf('motd=') < after.indexOf('online-mode='));
  check('反斜杠值未被改写', after.includes('level-type=minecraft\\:normal'));
  check('未提交的键没丢', after.includes('max-players=20'));
  check('新值已落盘', after.includes('motd=改过了') && after.includes('server-port=25566'));
}

// ---------------------------------------------------------------- C. 前端运行层
function mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    dataset: {}, style: {}, children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); } },
    onclick: null, onchange: null, onkeydown: null, oninput: null,
    appendChild(c) { this.children.push(c); return c; },
    remove() {}, focus() {}, blur() {},
    click() { if (this.onclick) return this.onclick({ target: this, stopPropagation() {}, preventDefault() {} }); },
    setAttribute(k, v) { this[k] = String(v); },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return mkEl('div'); }, querySelectorAll() { return []; },
    closest() { return mkEl('div'); },
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20 }; },
  };
  return el;
}

async function testFrontend() {
  console.log('\n[C] 前端运行层（DOM 桩）');
  const cache = new Map();
  const sel = s => { if (!cache.has(s)) cache.set(s, mkEl(s)); return cache.get(s); };
  const navProps = mkEl('button'); navProps.dataset.cfg = 'props';
  const navEula = mkEl('button'); navEula.dataset.cfg = 'eula.txt';
  const NAV = [navProps, navEula];
  const errors = [];

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    URLSearchParams, URL, Date, Math, JSON, Promise, Number, String, Boolean, Array, Object, Error, RegExp,
    TextDecoder, Blob: class {},
    localStorage: { getItem: k => (k === 'hmcs.inst' ? 'hycraft' : null), setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    location: {
      search: '?tab=config', hash: '#config', protocol: 'http:', hostname: '127.0.0.1',
      host: '127.0.0.1:' + PORT, port: String(PORT), pathname: '/', href: BASE + '/',
      replace(u) { this.href = u; }, assign(u) { this.href = u; }, reload() {},
    },
    document: {
      querySelector: sel,
      querySelectorAll: s => (s === '[data-cfg]' ? NAV : []),
      createElement: mkEl, addEventListener() {}, body: mkEl('body'),
    },
    fetch: async (u, init) => fetch(String(u).startsWith('http') ? String(u) : BASE + String(u), init),
    alert: () => {}, addEventListener() {}, innerWidth: 1440, innerHeight: 900,
    confirm: () => true, prompt: () => 'x',
    EventSource: class { constructor() {} close() {} addEventListener() {} },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  process.on('unhandledRejection', e => errors.push('unhandledRejection: ' + (e && e.message || e)));

  const code = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'public/app.js' });
  await sleep(1800); // 等 boot()

  const run = expr => vm.runInContext(expr, sandbox);
  const mainHtml = () => String(sel('#cfg-main').innerHTML || '');
  const isForm = h => /class="field"/.test(h) && /data-k="server-port"/.test(h) && !/无法用表单编辑/.test(h);
  const instExpr = 'state.boot.instances.find(x=>x.id==="hycraft")';

  check('boot() 拿到了实例数据', run('!!state.boot && !!state.boot.instances') === true, String(run('JSON.stringify(state.boot && Object.keys(state.boot))')).slice(0, 120));

  // 1) 正常进入配置页：props 表单
  run(`state.tab='config'; state.cfgTarget='props'; renderView()`);
  await sleep(700);
  check('首次进入 = 表单模式', isForm(mainHtml()), mainHtml().replace(/\s+/g, ' ').slice(0, 160));

  // 2) 旧状态 / URL 传进来的文件名：归一化回表单
  run(`state.cfgTarget='server.properties'; renderView()`);
  await sleep(700);
  check('历史 cfgTarget=server.properties 被归一化回表单', isForm(mainHtml()) && run('state.cfgTarget') === 'props',
    'cfgTarget=' + run('state.cfgTarget'));
  check('侧栏 server.properties 按钮高亮', run("state.cfgTarget === 'props'") === true);

  // 3) 点侧栏「server.properties」导航按钮（现在 data-cfg="props"）
  navProps.onclick && navProps.onclick({ target: navProps, stopPropagation() {}, preventDefault() {} });
  await sleep(700);
  check('点击导航后仍是表单模式', isForm(mainHtml()), mainHtml().replace(/\s+/g, ' ').slice(0, 160));

  // 4) 就算有人直接调 renderFileConfig('server.properties')，也要被短路回表单
  run(`renderFileConfig(${instExpr}, 'server.properties')`);
  await sleep(700);
  check('renderFileConfig 传入 .properties 被短路回表单', isForm(mainHtml()));

  // 5) 表单模式里的「重载」按钮：重读后还是表单（用户抱怨的点）
  const reload = sel('#cfg-reload');
  check('表单模式绑定了「重载」按钮', typeof reload.onclick === 'function');
  if (reload.onclick) { await reload.onclick(); await sleep(700); }
  check('点「重载」后仍是表单，不再降级成纯文本', isForm(mainHtml()), mainHtml().replace(/\s+/g, ' ').slice(0, 160));
  check('表单模式绑定了「文本模式」按钮', typeof sel('#cfg-raw').onclick === 'function');

  // 6) 普通 YAML 文件仍能走表单树（没被 .properties 短路误伤）
  run(`renderFileConfig(${instExpr}, 'test.yml')`);
  await sleep(700);
  check('普通 YAML 仍显示表单树', /id="cfg-tree"/.test(mainHtml()), mainHtml().replace(/\s+/g, ' ').slice(0, 160));
  check('YAML 重载只重读当前文件', typeof sel('#cfg-reload').onclick === 'function');

  check('前端运行期间没有未处理异常', errors.length === 0, errors.join(' | '));
}

// ---------------------------------------------------------------- 主流程
(async () => {
  const child = spawn(process.execPath, [APP, '--port', String(PORT), '--host', '127.0.0.1', '--home', HOME], {
    cwd: ROOT, env: { ...process.env, HMCS_HOME: HOME }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', d => logs.push(String(d)));
  child.stderr.on('data', d => logs.push(String(d)));

  const cleanup = () => {
    try { child.kill(); } catch { /* ignore */ }
    fs.rmSync(HOME, { recursive: true, force: true });
  };

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/system/ping')).ok) { up = true; break; } } catch { /* 还没起来 */ }
    await sleep(200);
  }
  if (!up) {
    console.error('临时服务没起来：\n' + logs.join('').slice(-1200));
    cleanup(); process.exit(1);
  }
  try { TOKEN = fs.readFileSync(path.join(HOME, 'control.token'), 'utf8').trim(); } catch { /* 本机免密即可 */ }

  try {
    await testApi();
    await testFrontend();
  } catch (e) {
    fail++; console.error('  FAIL 测试异常: ' + e.stack);
  }

  cleanup();
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
  console.log('全部通过 ✔');
})().catch(e => { console.error(e); process.exit(1); });
