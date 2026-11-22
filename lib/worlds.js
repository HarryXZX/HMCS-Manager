'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const { readSettings } = require('./paths');
const instances = require('./instances');
const proc = require('./proc');
const props = require('./props');

const SCAN_CACHE = { at: 0, data: null };
const DV_INDEX = { at: 0, map: {} };

/** 读 level.dat 的 DataVersion（gzip + 字节搜索，不依赖 NBT 全解析） */
function dataVersion(worldDir) {
  const lv = path.join(worldDir, 'level.dat');
  if (!fs.existsSync(lv)) return 0;
  try {
    const buf = zlib.gunzipSync(fs.readFileSync(lv));
    const pat = Buffer.from('DataVersion', 'ascii');
    for (let i = 0; i < buf.length - 15; i++) {
      if (buf[i] !== pat[0]) continue;
      if (buf.compare(pat, 0, pat.length, i, i + pat.length) !== 0) continue;
      const off = i + pat.length;
      const v = buf.readInt32BE(off);
      if (v > 1000 && v < 100000) return v;
    }
  } catch { /* 损坏或未压缩 */ }
  return 0;
}

function dirSize(dir, cap) {
  let total = 0, files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try { total += fs.statSync(full).size; } catch { /* ignore */ }
        files++;
        if (files > (cap || 20000)) return { total, truncated: true, files };
      }
    }
  }
  return { total, truncated: false, files };
}

/** 扫描本机启动器目录，得到 DataVersion -> 版本名 映射 */
function versionIndex() {
  if (Date.now() - DV_INDEX.at < 600000) return DV_INDEX.map;
  const map = {};
  const settings = readSettings();
  const jars = [];

  for (const root of settings.clientRoots || []) {
    const vdir = path.join(root, 'versions');
    let subs = [];
    try { subs = fs.readdirSync(vdir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { /* skip */ }
    for (const s of subs) {
      try {
        const files = fs.readdirSync(path.join(vdir, s)).filter(f => f.toLowerCase().endsWith('.jar'));
        if (files.length) jars.push(path.join(vdir, s, files.sort((a, b) => fs.statSync(path.join(vdir, s, b)).size - fs.statSync(path.join(vdir, s, a)).size)[0]));
      } catch { /* skip */ }
    }
  }
  for (const inst of instances.list()) {
    const p = path.join(inst.dir, inst.coreFile);
    if (fs.existsSync(p)) jars.push(p);
  }

  for (const jar of jars.slice(0, 30)) {
    try {
      const z = new AdmZip(jar);
      const text = z.readAsText('version.json');
      if (!text) continue;
      const v = JSON.parse(text);
      if (v.world_version && v.id) map[v.world_version] = v.id;
    } catch { /* 非 MC jar */ }
  }
  DV_INDEX.at = Date.now();
  DV_INDEX.map = map;
  return map;
}

function worldMeta(dir, origin) {
  const dv = dataVersion(dir);
  const idx = versionIndex();
  let st = null;
  try { st = fs.lstatSync(dir); } catch { /* ignore */ }
  const isLink = !!st && st.isSymbolicLink();
  let linkTarget = '';
  if (isLink) { try { linkTarget = fs.readlinkSync(dir); } catch { /* ignore */ } }
  const sz = dirSize(dir, 20000);
  return {
    name: path.basename(dir),
    path: dir,
    origin,
    dataVersion: dv,
    versionName: idx[dv] || (dv ? '' : '未知'),
    size: sz.total,
    truncated: sz.truncated,
    mtime: (st ? st.mtime : new Date()).toISOString(),
    isLink,
    linkTarget,
  };
}

function walkWorlds(dir, origin, depthLeft, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  if (ents.some(e => e.isFile() && e.name === 'level.dat')) {
    out.push(worldMeta(dir, origin));
    return;
  }
  if (depthLeft <= 0) return;
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    walkWorlds(path.join(dir, e.name), origin, depthLeft - 1, out);
  }
}

function installWorlds() {
  const out = [];
  for (const inst of instances.list()) {
    if (!inst.dir) continue;
    const w = path.join(inst.dir, inst.worldName || 'world');
    if (!fs.existsSync(w)) continue;
    const m = worldMeta(w, '服务器实例：' + inst.name);
    m.instanceId = inst.id;
    out.push(m);
  }
  return out;
}

function scan(force) {
  if (!force && SCAN_CACHE.data && Date.now() - SCAN_CACHE.at < 30000) return SCAN_CACHE.data;
  const settings = readSettings();
  const out = [];
  const seen = new Set();

  for (const root of settings.clientRoots || []) {
    const saves = path.join(root, 'saves');
    if (fs.existsSync(saves)) { const tmp = []; walkWorlds(saves, '客户端存档：' + root, 1, tmp); tmp.forEach(w => { if (!seen.has(w.path.toLowerCase())) { seen.add(w.path.toLowerCase()); out.push(w); } }); }
    const versions = path.join(root, 'versions');
    if (fs.existsSync(versions)) {
      for (const d of fs.readdirSync(versions, { withFileTypes: true }).filter(x => x.isDirectory())) {
        const sv = path.join(versions, d.name, 'saves');
        if (fs.existsSync(sv)) {
          const tmp = [];
          walkWorlds(sv, '版本隔离：' + d.name, 1, tmp);
          tmp.forEach(w => { if (!seen.has(w.path.toLowerCase())) { seen.add(w.path.toLowerCase()); out.push(w); } });
        }
      }
    }
  }

  for (const extra of settings.extraWorldDirs || []) {
    if (!extra || !fs.existsSync(extra)) continue;
    const tmp = [];
    walkWorlds(extra, '自定义目录：' + extra, 2, tmp);
    tmp.forEach(w => { if (!seen.has(w.path.toLowerCase())) { seen.add(w.path.toLowerCase()); out.push(w); } });
  }

  for (const w of installWorlds()) { if (!seen.has(w.path.toLowerCase())) { seen.add(w.path.toLowerCase()); out.push(w); } }

  out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  SCAN_CACHE.at = Date.now();
  SCAN_CACHE.data = out;
  return out;
}

function currentWorld(inst) {
  const dir = instances.dirOf(inst.id);
  const w = path.join(dir, inst.worldName || 'world');
  if (!fs.existsSync(w)) return { name: inst.worldName, exists: false, link: false, dataVersion: 0 };
  const st = fs.lstatSync(w);
  const link = st.isSymbolicLink();
  return {
    name: path.basename(w),
    path: w,
    exists: true,
    link,
    linkTarget: link ? fs.readlinkSync(w) : '',
    dataVersion: dataVersion(w),
    versionName: versionIndex()[dataVersion(w)] || '',
  };
}

async function attach(inst, opts) {
  const { source, mode, worldName } = opts;
  if (proc.statusOf(inst.id).status !== 'stopped') throw new Error('请先停止服务端再更换世界');
  if (!source || !fs.existsSync(source)) throw new Error('存档路径不存在: ' + source);
  if (!fs.existsSync(path.join(source, 'level.dat'))) throw new Error('该目录不是有效的世界（缺少 level.dat）');

  const name = String(worldName || path.basename(source)).replace(/[\\/:*?"<>|]/g, '_').trim() || 'world';
  const target = path.join(instances.dirOf(inst.id), name);

  if (fs.existsSync(target)) {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) fs.unlinkSync(target);
    else {
      const empty = fs.readdirSync(target).length === 0;
      if (!empty) throw new Error(`目标目录已存在且非空：${name}。请换一个世界名，或先在「文件」里删除它。`);
      fs.rmdirSync(target);
    }
  }

  if (mode === 'copy') {
    await fs.promises.cp(source, target, { recursive: true, force: true, errorOnExist: false });
  } else if (process.platform === 'win32') {
    // NTFS 目录联接：不需要管理员权限，客户端/服务端都能正常读写
    fs.symlinkSync(source, target, 'junction');
  } else {
    // macOS / Linux 用符号链接，效果一致
    fs.symlinkSync(source, target, 'dir');
  }

  props.ensureProps(instances.dirOf(inst.id), { 'level-name': name });
  inst.worldName = name;
  instances.save(inst);
  SCAN_CACHE.at = 0;

  return {
    ok: true,
    mode: mode === 'copy' ? 'copy' : 'link',
    worldName: name,
    target,
    dataVersion: dataVersion(target),
  };
}

function detach(inst) {
  if (proc.statusOf(inst.id).status !== 'stopped') throw new Error('请先停止服务端');
  const w = path.join(instances.dirOf(inst.id), inst.worldName || 'world');
  if (!fs.existsSync(w)) return { ok: true, removed: false };
  const st = fs.lstatSync(w);
  if (!st.isSymbolicLink()) throw new Error('当前世界是实例内的真实目录，不是链接；如需更换请在「文件」里处理');
  fs.unlinkSync(w);
  SCAN_CACHE.at = 0;
  return { ok: true, removed: true };
}

module.exports = { scan, currentWorld, attach, detach, dataVersion, versionIndex };
