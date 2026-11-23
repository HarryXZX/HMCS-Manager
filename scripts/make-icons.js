#!/usr/bin/env node
'use strict';
/**
 * 从一张像素画 PNG 生成整套站点图标。
 *
 *   node scripts/make-icons.js [源PNG路径]
 *
 * 默认源图是 public/brand/HYCX-MC.png（已随仓库提供），输出全部落在 public/。
 * 换 logo 时把新图覆盖到那个位置再跑一次即可，不需要 Photoshop，也不引入依赖。
 *
 * 为什么自己写 PNG 编解码：项目依赖只有 js-yaml / adm-zip，装 sharp 之类
 * 就为了缩几张图不值当；而且像素画必须用最近邻（nearest-neighbor），
 * 浏览器默认的双线性插值会把方块边缘糊成一团。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const SRC = path.resolve(process.argv[2] || path.join(PUB, 'brand', 'HYCX-MC.png'));
const BG = [11, 15, 20]; // --bg，用于 maskable / apple-touch-icon 的背景

// ------------------------------------------------------------------ PNG 基础
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** 解 8bit 非隔行 RGB / RGBA PNG，统一返回 RGBA */
function decodePNG(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('不是 PNG 文件');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!w || !h) throw new Error('PNG 缺少 IHDR');
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error('只支持 8bit、非隔行的 RGB / RGBA PNG');
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const rows = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = raw.slice(p, p + stride); p += stride;
    const cur = rows.slice(y * stride, (y + 1) * stride);
    const prev = y ? rows.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (ft !== 0) throw new Error('未知 PNG 行过滤器 ' + ft);
      cur[x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    if (bpp === 4) rows.copy(rgba, j, i * 4, i * 4 + 4);
    else { rgba[j] = rows[i * 3]; rgba[j + 1] = rows[i * 3 + 1]; rgba[j + 2] = rows[i * 3 + 2]; rgba[j + 3] = 255; }
  }
  return { w, h, rgba };
}

function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter none，像素画压缩率已经很高
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 最近邻缩放；pad=0.8 时把图案缩到 80% 居中，四周补背景（maskable 图标） */
function resize(src, size, { pad = 1, flatten = false } = {}) {
  const inner = Math.round(size * pad);
  const offset = Math.floor((size - inner) / 2);
  const dst = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const j = (y * size + x) * 4;
      const inside = x >= offset && x < offset + inner && y >= offset && y < offset + inner;
      let r = BG[0], g = BG[1], b = BG[2], a = 255;
      if (inside) {
        // 取源块中心，避免浮点边界把像素取歪
        const sx = Math.min(src.w - 1, Math.floor((x - offset + 0.5) * src.w / inner));
        const sy = Math.min(src.h - 1, Math.floor((y - offset + 0.5) * src.h / inner));
        const k = (sy * src.w + sx) * 4;
        r = src.rgba[k]; g = src.rgba[k + 1]; b = src.rgba[k + 2]; a = src.rgba[k + 3];
      }
      if (flatten && a < 255) { // 合成到深色底，iOS 桌面图标不能有透明
        const t = a / 255;
        r = Math.round(r * t + BG[0] * (1 - t));
        g = Math.round(g * t + BG[1] * (1 - t));
        b = Math.round(b * t + BG[2] * (1 - t));
        a = 255;
      }
      dst[j] = r; dst[j + 1] = g; dst[j + 2] = b; dst[j + 3] = a;
    }
  }
  return { w: size, h: size, rgba: dst };
}

/** ICO：Vista 起允许条目直接内嵌 PNG，不用自己画 BMP 位图 */
function buildICO(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = entries.map(e => {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size; d[1] = d[0];
    d.writeUInt16LE(1, 4);   // planes
    d.writeUInt16LE(32, 6);  // bit count
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.png.length;
    return d;
  });
  return Buffer.concat([head, ...dir, ...entries.map(e => e.png)]);
}

// ------------------------------------------------------------------ 生成
function main() {
  if (!fs.existsSync(SRC)) {
    console.error('找不到源图：' + SRC);
    process.exit(1);
  }
  const srcBuf = fs.readFileSync(SRC);
  const src = decodePNG(srcBuf);
  if (src.w !== src.h) console.warn('提示：源图不是正方形，输出会被拉伸成方块');

  fs.mkdirSync(path.join(PUB, 'brand'), { recursive: true });
  const brandFile = path.join(PUB, 'brand', 'HYCX-MC.png');
  if (path.resolve(SRC) !== path.resolve(brandFile)) fs.copyFileSync(SRC, brandFile);

  const write = (name, img) => {
    const buf = encodePNG(img.w, img.h, img.rgba);
    fs.writeFileSync(path.join(PUB, name), buf);
    return buf;
  };

  const png = {};
  for (const size of [16, 32, 48, 64, 180, 192, 512]) {
    png[size] = encodePNG(size, size, resize(src, size, { flatten: size >= 180 }).rgba);
  }
  fs.writeFileSync(path.join(PUB, 'favicon-16.png'), png[16]);
  fs.writeFileSync(path.join(PUB, 'favicon-32.png'), png[32]);
  fs.writeFileSync(path.join(PUB, 'favicon-48.png'), png[48]);
  fs.writeFileSync(path.join(PUB, 'apple-touch-icon.png'), png[180]);
  fs.writeFileSync(path.join(PUB, 'icon-192.png'), png[192]);
  fs.writeFileSync(path.join(PUB, 'icon-512.png'), png[512]);

  for (const size of [192, 512]) {
    const m = resize(src, size, { pad: 0.78, flatten: true });
    fs.writeFileSync(path.join(PUB, `icon-maskable-${size}.png`), encodePNG(size, size, m.rgba));
  }

  fs.writeFileSync(path.join(PUB, 'favicon.ico'), buildICO([
    { size: 16, png: png[16] }, { size: 32, png: png[32] },
    { size: 48, png: png[48] }, { size: 64, png: png[64] },
  ]));

  const manifest = {
    id: '/',
    name: 'HMCS Manager · Minecraft 服务端管理器',
    short_name: 'HMCS',
    description: '本地 Minecraft 服务端管理器',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0b0f14',
    theme_color: '#0b0f14',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  fs.writeFileSync(path.join(PUB, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // 源图透明像素统计：全是 255 就说明可以直接当桌面图标用
  let minA = 255, colors = new Set();
  for (let i = 0; i < src.w * src.h; i++) {
    const k = i * 4;
    if (src.rgba[k + 3] < minA) minA = src.rgba[k + 3];
    if (colors.size < 64) colors.add(`${src.rgba[k]},${src.rgba[k + 1]},${src.rgba[k + 2]},${src.rgba[k + 3]}`);
  }
  console.log(`源图 ${src.w}×${src.h}，最小 alpha=${minA}，取样颜色数=${colors.size}`);
  for (const f of fs.readdirSync(PUB).filter(f => /^(favicon|icon-|apple-touch|manifest)/.test(f))) {
    console.log('  ' + f.padEnd(28) + fs.statSync(path.join(PUB, f)).size + ' B');
  }
  console.log('  brand/HYCX-MC.png' + ' '.repeat(10) + fs.statSync(brandFile).size + ' B');
}

if (require.main === module) main();

module.exports = { decodePNG, encodePNG, resize, buildICO, crc32, chunk };
