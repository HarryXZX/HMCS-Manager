#!/usr/bin/env node
'use strict';
/**
 * 站点图标（品牌图标 / favicon / PWA）自测
 *
 * 守的点：
 *   1) 所有产物存在，且是能被解析的合法 PNG / ICO
 *   2) 缩放用的是最近邻：512→512 必须逐像素一致，小图里同一色块内不能出现杂色
 *   3) ICO 目录项的 offset / length 真的指向内嵌 PNG（写错就是某些 Windows 版本白图标）
 *   4) manifest 合法、引用的图标都在、HTML 里不再残留旧的内联 SVG favicon
 *   5) 后端静态白名单 + MIME 配齐（有 X-Content-Type-Options: nosniff，类型错了浏览器直接拒收）
 *   6) 真的起一个实例，把每个图标 HTTP 请求一遍
 *   7) make-icons.js 可重复运行且结果稳定
 *
 * 用法：node _dev/_test-icons.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const icons = require('../scripts/make-icons');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const APP = path.join(ROOT, 'app.js');
const MAKER = path.join(ROOT, 'scripts', 'make-icons.js');
const PORT = Number(process.env.TEST_ICON_PORT || 8788);

let failed = 0;
function check(name, cond, detail = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || !detail ? '' : '  → ' + detail));
  if (!cond) failed++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const rel = f => path.join(PUB, f);

const PNG_FILES = {
  'brand/HYCX-MC.png': 512,
  'favicon-16.png': 16,
  'favicon-32.png': 32,
  'favicon-48.png': 48,
  'apple-touch-icon.png': 180,
  'icon-192.png': 192,
  'icon-512.png': 512,
  'icon-maskable-192.png': 192,
  'icon-maskable-512.png': 512,
};

function get(port, p) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', timeout: 5000 }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', buf: Buffer.concat(chunks) }));
    });
    r.on('error', e => resolve({ status: 0, type: '', buf: Buffer.from(e.message) }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, type: '', buf: Buffer.from('timeout') }); });
    r.end();
  });
}

async function main() {
  console.log('\n== 图标文件与二进制结构 ==');
  for (const [f, size] of Object.entries(PNG_FILES)) {
    check(f + ' 存在', fs.existsSync(rel(f)));
    if (!fs.existsSync(rel(f))) continue;
    const b = fs.readFileSync(rel(f));
    check('  PNG 签名合法', b.slice(0, 8).toString('hex') === '89504e470d0a1a0a');
    const img = icons.decodePNG(b);
    check('  尺寸 ' + size + '×' + size, img.w === size && img.h === size, `${img.w}×${img.h}`);
    check('  RGBA 缓冲完整', img.rgba.length === size * size * 4);
  }

  const src = icons.decodePNG(fs.readFileSync(rel('brand/HYCX-MC.png')));
  const big = icons.decodePNG(fs.readFileSync(rel('icon-512.png')));
  check('512 输出与源图逐像素一致（最近邻、无插值）', Buffer.compare(src.rgba, big.rgba) === 0);

  // 8×8 色块 → 16×16 时每 2×2 应该是纯色
  const small = icons.decodePNG(fs.readFileSync(rel('favicon-16.png')));
  let blocksPure = true;
  for (let y = 0; y < 8 && blocksPure; y++) {
    for (let x = 0; x < 8; x++) {
      const px = (yy, xx) => small.rgba.slice((yy * 16 + xx) * 4, (yy * 16 + xx) * 4 + 4).toString('hex');
      const c = px(y * 2, x * 2);
      if (px(y * 2 + 1, x * 2) !== c || px(y * 2, x * 2 + 1) !== c || px(y * 2 + 1, x * 2 + 1) !== c) {
        blocksPure = false; break;
      }
    }
  }
  check('16×16 里每个 2×2 色块仍是纯色（像素风没糊）', blocksPure);
  const mask = icons.decodePNG(fs.readFileSync(rel('icon-maskable-192.png')));
  const corner = mask.rgba.slice(0, 4);
  check('maskable 图标四周留了背景安全区', corner[0] === 11 && corner[1] === 15 && corner[2] === 20 && corner[3] === 255,
    corner.toString('hex'));

  console.log('\n== favicon.ico ==');
  const ico = fs.readFileSync(rel('favicon.ico'));
  check('ICO 头 magic 正确', ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1);
  const count = ico.readUInt16LE(4);
  check('内嵌 4 个尺寸 (16/32/48/64)', count === 4, String(count));
  const want = [16, 32, 48, 64];
  for (let i = 0; i < count; i++) {
    const d = 6 + 16 * i;
    const size = ico[d] || 256;
    const len = ico.readUInt32LE(d + 8);
    const off = ico.readUInt32LE(d + 12);
    const entry = ico.slice(off, off + len);
    const okSize = size === want[i];
    const okPng = entry.slice(0, 8).toString('hex') === '89504e470d0a1a0a' && entry.readUInt32BE(16) === size;
    check(`  第 ${i + 1} 项 ${size}px 指向合法 PNG`, okSize && okPng && off + len <= ico.length,
      `size=${size} len=${len} off=${off}`);
  }

  console.log('\n== manifest 与页面引用 ==');
  const mf = JSON.parse(fs.readFileSync(rel('manifest.webmanifest'), 'utf8'));
  check('manifest 是合法 JSON', !!mf && typeof mf === 'object');
  check('名称 / 启动地址 / 独立窗口', mf.short_name === 'HMCS' && mf.start_url === '/' && mf.display === 'standalone');
  check('主题色与站点一致', mf.theme_color === '#0b0f14' && mf.background_color === '#0b0f14');
  check('图标项齐全（any + maskable × 2 尺寸）', mf.icons.length === 4 && mf.icons.some(i => i.purpose === 'maskable'));
  for (const i of mf.icons) check('  引用的 ' + i.src + ' 存在', fs.existsSync(rel(i.src.replace(/^\//, ''))));

  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const login = fs.readFileSync(path.join(PUB, 'login.html'), 'utf8');
  for (const [label, s] of [['index.html', html], ['login.html', login]]) {
    check(label + ' 引用 favicon.ico', /rel="icon" href="\/favicon\.ico"/.test(s));
    check(label + ' 引用 apple-touch-icon', /rel="apple-touch-icon"/.test(s));
    check(label + ' 引用 manifest', /rel="manifest" href="\/manifest\.webmanifest"/.test(s));
    check(label + ' 侧栏 / 品牌处换成图片 logo', /<img class="mark" src="\/brand\/HYCX-MC\.png"/.test(s));
    check(label + ' 旧内联 SVG 图标已移除', !/data:image\/svg\+xml/.test(s));
  }
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  check('style.css 保留像素渲染', /image-rendering:pixelated/.test(css));
  check('login.html 保留像素渲染', /image-rendering:pixelated/.test(login));

  const appjs = fs.readFileSync(APP, 'utf8');
  check('静态白名单包含 .webmanifest', /STATIC_ALLOW[\s\S]{0,200}\.webmanifest/.test(appjs));
  check('MIME 表包含 manifest 类型', /'\.webmanifest': 'application\/manifest\+json/.test(appjs));

  console.log('\n== 生成脚本幂等 ==');
  const before = Object.keys(PNG_FILES).concat(['favicon.ico', 'manifest.webmanifest'])
    .map(f => [f, sha(fs.readFileSync(rel(f)))]);
  const run = spawnSync(process.execPath, [MAKER], { encoding: 'utf8' });
  check('make-icons.js 重复运行退出码 0', run.status === 0, run.stderr || '');
  let stable = true;
  for (const [f, h] of before) if (sha(fs.readFileSync(rel(f))) !== h) stable = false;
  check('重复生成后所有文件字节不变', stable);

  console.log('\n== HTTP 静态资源（起临时实例） ==');
  const home = path.join(require('os').tmpdir(), 'hmcs-icons-test-' + process.pid);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  const logFd = fs.openSync(path.join(home, 'app.log'), 'a');
  const child = spawn(process.execPath, [APP, '--home', home, '--port', String(PORT), '--host', '127.0.0.1', '--log-file'], {
    cwd: ROOT, stdio: ['ignore', logFd, logFd], windowsHide: true,
    env: { ...process.env, HMCS_PORT: '', HMCS_HOST: '' },
  });
  let up = false;
  for (let i = 0; i < 60; i++) {
    const r = await get(PORT, '/api/system/ping');
    if (r.status === 200) { up = true; break; }
    await sleep(250);
  }
  check('临时实例已启动', up);
  if (up) {
    const cases = [
      ['/favicon.ico', 'image/x-icon', 'ico'],
      ['/favicon-16.png', 'image/png', 'png'],
      ['/favicon-32.png', 'image/png', 'png'],
      ['/favicon-48.png', 'image/png', 'png'],
      ['/apple-touch-icon.png', 'image/png', 'png'],
      ['/icon-192.png', 'image/png', 'png'],
      ['/icon-512.png', 'image/png', 'png'],
      ['/icon-maskable-192.png', 'image/png', 'png'],
      ['/brand/HYCX-MC.png', 'image/png', 'png'],
      ['/manifest.webmanifest', 'application/manifest+json', 'json'],
    ];
    for (const [p, type, kind] of cases) {
      const r = await get(PORT, p);
      let bodyOk = r.status === 200;
      if (kind === 'png') bodyOk &&= r.buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
      if (kind === 'ico') bodyOk &&= r.buf.readUInt16LE(2) === 1;
      if (kind === 'json') { try { JSON.parse(r.buf.toString('utf8')); } catch { bodyOk = false; } }
      check(`${p} → 200 + ${type}`, r.status === 200 && r.type.startsWith(type) && bodyOk,
        `status=${r.status} type=${r.type} len=${r.buf.length}`);
    }
    const page = await get(PORT, '/');
    check('首页仍能正常返回', page.status === 200 && page.buf.includes(Buffer.from('HMCS Manager')));
  }
  try { child.kill(); } catch { /* ignore */ }
  await sleep(300);
  fs.closeSync(logFd);
  fs.rmSync(home, { recursive: true, force: true });

  console.log(`\n${failed ? 'FAILED ' + failed : '全部通过'}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
