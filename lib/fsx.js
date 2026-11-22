'use strict';
const fs = require('fs');
const path = require('path');

const TEXT_EXT = new Set(['.properties', '.yml', '.yaml', '.json', '.json5', '.txt', '.conf', '.cfg', '.toml', '.md', '.log', '.sh', '.bat', '.cmd', '.ini', '.mcfunction', '.csv', '.html', '.js', '.ts', '.xml']);
const MAX_TEXT = 2 * 1024 * 1024;

function safeResolve(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, rel || '.');
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(withSep)) {
    const e = new Error('非法路径: ' + rel);
    e.status = 400;
    throw e;
  }
  return target;
}

function isEditable(name, size) {
  const ext = path.extname(String(name)).toLowerCase();
  return TEXT_EXT.has(ext) && size <= MAX_TEXT;
}

function listDir(root, rel) {
  const abs = safeResolve(root, rel);
  if (!fs.existsSync(abs)) { const e = new Error('目录不存在: ' + rel); e.status = 404; throw e; }
  if (!fs.statSync(abs).isDirectory()) { const e = new Error('不是目录: ' + rel); e.status = 400; throw e; }
  const entries = [];
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, d.name);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    const link = st.isSymbolicLink();
    let real = st;
    if (link) { try { real = fs.statSync(full); } catch { real = st; } }
    const isDir = real.isDirectory();
    entries.push({
      name: d.name,
      path: path.posix.join(String(rel || '').replace(/\\/g, '/'), d.name).replace(/^\/+/, ''),
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : real.size,
      mtime: real.mtime.toISOString(),
      link,
      linkTarget: link ? fs.readlinkSync(full) : '',
      editable: !isDir && isEditable(d.name, real.size),
    });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return entries;
}

function readText(root, rel) {
  const abs = safeResolve(root, rel);
  const st = fs.statSync(abs);
  if (st.size > MAX_TEXT) throw new Error('文件过大，无法在编辑器中打开（>2MB）');
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new Error('二进制文件，无法作为文本编辑');
  return { content: buf.toString('utf8'), size: st.size, mtime: st.mtime.toISOString() };
}

function writeText(root, rel, content) {
  const abs = safeResolve(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content), 'utf8');
  return { ok: true, path: rel };
}

function mkdir(root, rel) {
  fs.mkdirSync(safeResolve(root, rel), { recursive: true });
  return { ok: true };
}

function rename(root, from, to) {
  const a = safeResolve(root, from);
  const b = safeResolve(root, to);
  if (fs.existsSync(b)) throw new Error('目标已存在: ' + to);
  fs.renameSync(a, b);
  return { ok: true };
}

function remove(root, rel) {
  const abs = safeResolve(root, rel);
  if (!fs.existsSync(abs)) return { ok: true };
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) { fs.unlinkSync(abs); return { ok: true, link: true }; }
  fs.rmSync(abs, { recursive: true, force: true });
  return { ok: true };
}

function statOf(root, rel) {
  const abs = safeResolve(root, rel);
  const st = fs.lstatSync(abs);
  return { size: st.size, mtime: st.mtime.toISOString(), isDir: st.isDirectory(), link: st.isSymbolicLink() };
}

module.exports = { safeResolve, listDir, readText, writeText, mkdir, rename, remove, statOf, isEditable };
