'use strict';
/**
 * 前端冒烟测试：用极简 DOM 桩跑一遍 public/app.js 的启动与各标签页渲染，
 * 捕获 ReferenceError / TypeError 之类的运行时错误（不检查视觉）。
 * 用法：node _dev/_ui-smoke.js [基址]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = process.argv[2] || 'http://127.0.0.1:8720';

function mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    dataset: {}, style: {}, children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    onclick: null, onchange: null, onkeydown: null, oninput: null,
    appendChild(c) { this.children.push(c); return c; },
    remove() {}, focus() {}, blur() {}, click() { if (this.onclick) return this.onclick({ target: this, stopPropagation() {}, preventDefault() {} }); },
    addEventListener() {}, removeEventListener() {},
    querySelector(s) { return mkEl(s); },
    querySelectorAll() { return []; },
    closest() { return mkEl('div'); },
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20 }; },
  };
  return el;
}

const cache = new Map();
function sel(s) {
  if (!cache.has(s)) cache.set(s, mkEl(s));
  return cache.get(s);
}

const errors = [];
const store = new Map([['hmcs.inst', '']]);

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  URLSearchParams, URL, Date, Math, JSON, Promise, Number, String, Boolean, Array, Object, Error, RegExp,
  TextDecoder, Blob: class {},
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  navigator: { clipboard: { writeText: async () => {} } },
  location: { search: '?tab=' + (process.env.SMOKE_TAB || 'overview'), href: BASE + '/' },
  document: {
    querySelector: sel,
    querySelectorAll: () => [],
    createElement: mkEl,
    addEventListener() {},
    body: mkEl('body'),
  },
  fetch: (u, init) => {
    const url = String(u).startsWith('http') ? String(u) : BASE + String(u);
    return fetch(url, init);
  },
  alert: () => {},
  confirm: () => true,
  prompt: () => 'x',
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.EventSource = class { constructor() { this.close = () => {}; } addEventListener() {} };

process.on('unhandledRejection', e => { errors.push('unhandledRejection: ' + (e && e.message || e)); });
process.on('uncaughtException', e => { errors.push('uncaughtException: ' + e.message); });

const file = path.resolve(__dirname, '../public/app.js');
const code = fs.readFileSync(file, 'utf8');

(async () => {
  try {
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'public/app.js' });
  } catch (e) {
    errors.push('顶层执行失败: ' + e.stack);
  }

  await new Promise(r => setTimeout(r, 2500)); // 等 boot() 完成

  const view = sel('#view');
  const html = String(view.innerHTML || '');
  if (!html) errors.push('视图为空（#view innerHTML 没有被写入）');
  if (/载入失败/.test(html)) errors.push('#view 显示「载入失败」');
  if (/无法连接后端/.test(html)) errors.push('#view 显示「无法连接后端」');

  // 依次切到其它标签页（直接改 location 无法触发，改为点击 tab 不可行，这里靠 URL 参数逐个跑）
  const checks = [
    ['目录选择器', () => sel('#s-sdir-pick')],
  ];
  for (const [name, fn] of checks) {
    const el = fn();
    if (!el.onclick) console.log(`  ! ${name} 未绑定点击事件（可能当前不在设置页）`);
  }

  // 可选：真实触发某个按钮的点击回调
  if (process.env.SMOKE_CLICK) {
    const btn = sel(process.env.SMOKE_CLICK);
    if (!btn.onclick) {
      errors.push(process.env.SMOKE_CLICK + ' 没有绑定点击事件');
    } else {
      try {
        await btn.onclick({ target: btn, stopPropagation() {}, preventDefault() {} });
        await new Promise(r => setTimeout(r, 1500));
        console.log('  已点击 ' + process.env.SMOKE_CLICK);
      } catch (e) {
        errors.push('点击 ' + process.env.SMOKE_CLICK + ' 抛错: ' + e.message);
      }
    }
  }

  console.log('---- 结果 ----');
  console.log('视图长度:', html.length);
  if (process.env.SMOKE_DUMP) { fs.writeFileSync(process.env.SMOKE_DUMP, html, 'utf8'); console.log('已写出:', process.env.SMOKE_DUMP); }
  console.log('片段:', html.replace(/\s+/g, ' ').slice(0, 220));
  if (errors.length) {
    console.log('发现 ' + errors.length + ' 个问题:');
    for (const e of errors) console.log('  - ' + e);
    process.exit(1);
  }
  console.log('没有运行时错误');
})();
