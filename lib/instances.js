'use strict';
/**
 * 实例注册表
 *
 * 实例本身是一个独立目录（核心 jar + server.properties + world…），可以放在任意磁盘位置。
 * 具体放在哪儿只记在系统目录的 instances.json 里，程序目录不再保存任何实例信息。
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const {
  APP_DIR, REGISTRY_FILE, DEFAULT_SERVERS_DIR, LEGACY_SERVERS_DIR,
  readSettings,
} = require('./paths');
const sources = require('./sources');
const props = require('./props');
const eula = require('./eula');

let REG = null;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 首次运行时把程序目录 servers/ 下的旧实例导入注册表（文件原地不动） */
function importLegacy(reg) {
  let ents = [];
  try { ents = fs.readdirSync(LEGACY_SERVERS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return 0; }
  let n = 0;
  for (const d of ents) {
    const dir = path.join(LEGACY_SERVERS_DIR, d.name);
    const meta = readJson(path.join(dir, 'instance.json'), null);
    if (!meta || !meta.id) continue;
    if (reg.instances.some(x => x.id === meta.id || samePath(x.dir, dir))) continue;
    reg.instances.push({ ...meta, dir });
    n++;
  }
  if (n) console.log(`[HMCS] 已接管程序目录下的 ${n} 个旧实例（文件保持原位置）`);
  return n;
}

function load() {
  if (REG) return REG;
  fs.mkdirSync(APP_DIR, { recursive: true });
  let reg = readJson(REGISTRY_FILE, null);
  const fresh = !reg || !Array.isArray(reg.instances);
  if (fresh) reg = { version: 2, instances: [] };
  // 老实例没有 dir 字段的话用程序目录下的同名文件夹兜底
  for (const it of reg.instances) {
    if (!it.dir) it.dir = path.join(LEGACY_SERVERS_DIR, it.id);
  }
  REG = reg;
  // 只在第一次运行时接管程序目录 servers/ 里的旧实例，之后完全以注册表为准
  if (!reg.legacyImported) {
    importLegacy(REG);
    REG.legacyImported = true;
    flush();
  } else if (fresh) {
    flush();
  }
  return REG;
}

function flush() {
  fs.mkdirSync(APP_DIR, { recursive: true });
  const tmp = REGISTRY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(REG, null, 2), 'utf8');
  fs.renameSync(tmp, REGISTRY_FILE);
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = p => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function list() {
  const reg = load();
  const out = reg.instances.slice();
  out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return out;
}

function get(id) {
  const inst = load().instances.find(x => x.id === id);
  if (!inst) { const e = new Error('实例不存在: ' + id); e.status = 404; throw e; }
  return inst;
}

function has(id) { return load().instances.some(x => x.id === id); }

/** 实例的真实磁盘目录（实例不存在时按默认目录拼一个，便于报错显示） */
function dirOf(id) {
  const inst = load().instances.find(x => x.id === id);
  if (inst && inst.dir) return inst.dir;
  return path.join(readSettings().serversDir || DEFAULT_SERVERS_DIR, id);
}

function save(inst) {
  if (!inst || !inst.id) throw new Error('实例缺少 id');
  if (!inst.dir) inst.dir = path.join(readSettings().serversDir || DEFAULT_SERVERS_DIR, inst.id);
  inst.updatedAt = new Date().toISOString();
  const reg = load();
  const i = reg.instances.findIndex(x => x.id === inst.id);
  if (i >= 0) reg.instances[i] = { ...reg.instances[i], ...inst };
  else reg.instances.push(inst);
  flush();
  return i >= 0 ? reg.instances[i] : inst;
}

function slug(name) {
  const s = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || ('server-' + crypto.randomBytes(2).toString('hex'));
}

/** 解析实例的父目录：显式传入 > 设置里的 serversDir > 默认系统目录 */
function parentDirFor(input) {
  const raw = String((input && input.dir) || '').trim();
  if (raw && path.isAbsolute(raw)) return path.resolve(raw);
  const s = readSettings();
  return path.resolve(s.serversDir || DEFAULT_SERVERS_DIR);
}

function freePort(start) {
  return new Promise(resolve => {
    let port = start || 25565;
    const tryPort = () => {
      const srv = net.createServer();
      srv.once('error', () => { port++; if (port < start + 200) tryPort(); else resolve(start); });
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '127.0.0.1');
    };
    tryPort();
  });
}

async function create(input, hooks) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('请填写服务器名称');
  const type = String(input.type || 'paper');
  const mcVersion = String(input.mcVersion || '').trim();
  if (!mcVersion) throw new Error('请选择 Minecraft 版本');
  if (!sources.PROVIDERS[type]) throw new Error('不支持的服务端类型: ' + type);

  const parent = parentDirFor(input);
  try { fs.mkdirSync(parent, { recursive: true }); } catch (e) { throw new Error('无法创建实例目录: ' + parent + '（' + e.message + '）'); }
  try { fs.accessSync(parent, fs.constants.W_OK); } catch { throw new Error('实例目录不可写: ' + parent); }

  let id = slug(name);
  let n = 2;
  while (has(id) || fs.existsSync(path.join(parent, id))) { id = slug(name) + '-' + n; n++; }
  const dir = path.join(parent, id);
  const createdNow = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });

  if (hooks && hooks.log) hooks.log('实例目录: ' + dir);
  let dl;
  try {
    dl = await sources.resolveDownload(type, mcVersion);
    if (hooks && hooks.log) hooks.log(`解析到 ${type} ${mcVersion}${dl.build ? ' build ' + dl.build : ''}${dl.loaderVersion ? ' loader ' + dl.loaderVersion : ''}`);
    const corePath = path.join(dir, dl.fileName);
    await sources.download(dl.url, corePath, {
      sha: dl.sha,
      algo: dl.algo || 'sha256',
      onProgress: hooks && hooks.progress,
    });
    if (hooks && hooks.log) hooks.log('核心下载完成: ' + dl.fileName);
  } catch (e) {
    // 下载失败时别留下空壳目录
    if (createdNow) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    throw e;
  }
  const corePath = path.join(dir, dl.fileName);

  const port = await freePort(Number(input.port) || 25565);
  const worldName = String(input.worldName || 'world');

  eula.write(dir, !!input.eula);
  props.ensureProps(dir, { 'level-name': worldName, 'server-port': String(port), 'online-mode': input.onlineMode ? 'true' : 'false' });
  for (const sub of ['plugins', 'mods', 'logs']) fs.mkdirSync(path.join(dir, sub), { recursive: true });

  const inst = {
    id,
    name,
    dir,
    type,
    typeLabel: sources.PROVIDERS[type].label,
    mcVersion,
    coreFile: dl.fileName,
    coreSize: fs.statSync(corePath).size,
    build: dl.build || null,
    loaderVersion: dl.loaderVersion || null,
    worldName,
    port,
    memory: String(input.memory || '2G'),
    jvmArgs: String(input.jvmArgs || ''),
    eula: !!input.eula,
    createdAt: new Date().toISOString(),
  };
  save(inst);
  return get(id);
}

/** 删除前确认这确实是一个 Minecraft 服务端目录，避免用户误选目录后被一锅端 */
function looksLikeServerDir(dir, inst) {
  if (!dir || !fs.existsSync(dir)) return false;
  const marks = [
    inst && inst.coreFile,
    'server.properties', 'eula.txt', 'plugins', 'mods',
    'logs', 'bukkit.yml', 'spigot.yml', 'config',
  ].filter(Boolean);
  return marks.some(m => fs.existsSync(path.join(dir, m)));
}

/** 断开世界链接（只删 junction，不动真实存档）后再删目录 */
function removeDir(dir, inst) {
  if (!fs.existsSync(dir)) return { removed: false };
  if (!looksLikeServerDir(dir, inst)) {
    const e = new Error('该目录看起来不是服务端目录（没有 server.properties / eula.txt / 核心文件），已从列表移除但未删除磁盘文件：' + dir);
    e.code = 'NOT_SERVER_DIR';
    throw e;
  }
  const world = path.join(dir, (inst && inst.worldName) || 'world');
  try {
    if (fs.existsSync(world) && fs.lstatSync(world).isSymbolicLink()) fs.unlinkSync(world);
  } catch { /* 链接坏了也无所谓 */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  return { removed: true };
}

/**
 * 删除实例
 * @param {string} id
 * @param {{deleteFiles?: boolean}} opts deleteFiles=true 时连同磁盘目录一起删除
 */
function remove(id, opts = {}) {
  const inst = get(id);
  const dir = inst.dir;
  const reg = load();
  reg.instances = reg.instances.filter(x => x.id !== id);
  flush();

  let deleted = false;
  let warning = '';
  if (opts.deleteFiles) {
    try {
      const r = removeDir(dir, inst);
      deleted = r.removed;
    } catch (e) {
      warning = e.message;
    }
  } else {
    // 保留文件：只删掉我们自己的元数据，避免下次启动又被当作「旧实例」自动导入
    try { fs.unlinkSync(path.join(dir, 'instance.json')); } catch { /* 没有就算了 */ }
  }
  return { ok: true, id, dir, deleted, filesKept: !deleted, warning };
}

function update(id, patch) {
  const inst = get(id);
  const safe = { ...patch };
  delete safe.id;              // id 是主键，不允许改
  delete safe.dir;             // 目录位置走「另存/迁移」，不在这里改
  Object.assign(inst, safe);
  return save(inst);
}

/** 根据核心 jar 文件名推断服务端类型 */
function guessType(jar) {
  const n = String(jar || '').toLowerCase();
  if (/purpur/.test(n)) return 'purpur';
  if (/paper/.test(n)) return 'paper';
  if (/fabric/.test(n)) return 'fabric';
  if (/neoforge/.test(n)) return 'neoforge';
  return 'vanilla';
}

/** 从核心 jar 的 version.json 里读世界版本号，再映射成版本名（失败返回空） */
function readJarVersion(jarPath) {
  try {
    const AdmZip = require('adm-zip');
    const text = new AdmZip(jarPath).readAsText('version.json');
    const v = JSON.parse(text);
    return { id: v.id || '', worldVersion: v.world_version || 0 };
  } catch { return { id: '', worldVersion: 0 }; }
}

/**
 * 导入磁盘上已有的服务端目录（不复制、不下载，就地接管）
 */
function importDir(input) {
  const raw = String((input && input.dir) || '').trim();
  if (!raw) throw new Error('请指定服务端目录');
  if (!path.isAbsolute(raw)) throw new Error('目录必须是绝对路径');
  const dir = path.resolve(raw);
  let st;
  try { st = fs.statSync(dir); } catch { throw new Error('目录不存在: ' + dir); }
  if (!st.isDirectory()) throw new Error('不是目录: ' + dir);
  if (load().instances.some(x => samePath(x.dir, dir))) throw new Error('这个目录已经在列表里了');

  let files = [];
  try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { throw new Error('无法读取目录：' + e.message); }

  // 核心 jar：根目录下体积最大的 jar（排除安装器）
  const jars = files
    .filter(e => e.isFile() && /\.jar$/i.test(e.name) && !/installer/i.test(e.name))
    .map(e => ({ name: e.name, size: (() => { try { return fs.statSync(path.join(dir, e.name)).size; } catch { return 0; } })() }))
    .sort((a, b) => b.size - a.size);
  const core = jars[0] || null;
  if (!core) throw new Error('目录里没有找到服务端核心（*.jar）。如果这是客户端目录，请到「设置 → 客户端实例」添加。');

  const type = guessType(core.name);
  const jv = readJarVersion(path.join(dir, core.name));
  const parsed = props.parse((() => { try { return props.readProps(dir).text; } catch { return ''; } })());
  const port = Number(parsed.map['server-port'] || 25565) || 25565;
  const worldName = parsed.map['level-name'] || 'world';
  const name = String(input.name || '').trim() || path.basename(dir);

  let id = slug(name);
  let n = 2;
  while (has(id)) { id = slug(name) + '-' + n; n++; }

  const inst = {
    id,
    name,
    dir,
    type,
    typeLabel: (sources.PROVIDERS[type] && sources.PROVIDERS[type].label) || type,
    mcVersion: jv.id || String(input.mcVersion || '未知'),
    coreFile: core.name,
    coreSize: core.size,
    build: null,
    loaderVersion: null,
    worldName,
    port,
    memory: String(input.memory || '2G'),
    jvmArgs: '',
    eula: eula.read(dir).accepted,
    imported: true,
    createdAt: new Date().toISOString(),
  };
  save(inst);
  return get(id);
}

function missing(inst) {
  try { return !fs.existsSync(inst.dir); } catch { return true; }
}

module.exports = {
  list, get, has, save, create, remove, update, dirOf, freePort, readJson,
  missing, looksLikeServerDir, parentDirFor, importDir,
};
