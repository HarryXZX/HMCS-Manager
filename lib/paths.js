'use strict';
/**
 * 路径与设置（多平台）
 *
 * 程序目录只放代码（app.js / lib / public），所有可变数据都在系统用户目录：
 *
 *   平台        配置（settings.json / instances.json）          数据（servers/）
 *   Windows     %APPDATA%\HMCS                                  %APPDATA%\HMCS
 *   macOS       ~/Library/Application Support/HMCS               ~/Library/Application Support/HMCS
 *   Linux       ${XDG_CONFIG_HOME:-~/.config}/HMCS               ${XDG_DATA_HOME:-~/.local/share}/HMCS
 *
 * Linux 按 XDG Base Directory 规范拆成两个目录：配置小、备份轻；servers/ 常是几十 GB 存档，
 * 归到 data 目录才不会被打包 / 同步工具当成配置一起搬。
 * 环境变量 HMCS_HOME 可以把两者统一指到同一个自定义目录。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_NAME = 'HYCX MC Server Manager';
const APP_SHORT = 'HMCS';
const DIR_NAME = 'HMCS';          // 目录名
const LEGACY_DIR_NAME = 'HYServ'; // 改名前的目录名，首次启动自动迁走

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

/**
 * 平台判定。HMCS_PLATFORM 仅用于跨平台自测（在 Windows 上模拟 linux / darwin 的路径行为），
 * 正常使用不要设置。
 */
function platform() {
  const p = String(process.env.HMCS_PLATFORM || process.platform).toLowerCase();
  if (p === 'win' || p === 'windows' || p === 'win32') return 'win32';
  if (p === 'mac' || p === 'macos' || p === 'darwin') return 'darwin';
  return 'linux';
}

/** 配置根目录 */
function configRoot() {
  const home = os.homedir();
  const p = platform();
  if (p === 'win32') return process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (p === 'darwin') return path.join(home, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}

/** 数据根目录（servers/ 默认放这里；Windows / macOS 与配置同目录） */
function dataRoot() {
  const home = os.homedir();
  const p = platform();
  if (p === 'win32') return process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (p === 'darwin') return path.join(home, 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
}

const CUSTOM_HOME = String(process.env.HMCS_HOME || process.env.HYSERV_HOME || '').trim();
const UNIFIED = !!CUSTOM_HOME;

const CONFIG_DIR = UNIFIED ? path.resolve(CUSTOM_HOME) : path.join(configRoot(), DIR_NAME);
const DATA_DIR = UNIFIED ? path.resolve(CUSTOM_HOME) : path.join(dataRoot(), DIR_NAME);

const APP_DIR = CONFIG_DIR;   // 历史命名，指配置目录
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const REGISTRY_FILE = path.join(CONFIG_DIR, 'instances.json');
const DEFAULT_SERVERS_DIR = path.join(DATA_DIR, 'servers');

const LEGACY_APP_DIR = path.join(configRoot(), LEGACY_DIR_NAME);
// 更早的版本把 settings.json 和 servers/ 放在程序目录下
const LEGACY_SETTINGS_FILE = path.join(ROOT, 'settings.json');
const LEGACY_SERVERS_DIR = path.join(ROOT, 'servers');

const DEFAULT_SETTINGS = {
  port: 8720,
  javaPath: '',
  memory: '2G',
  serversDir: DEFAULT_SERVERS_DIR,
  extraWorldDirs: [],
  clientRoots: [],
  autoAcceptEula: false,
};

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

function ensureDirs() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (DATA_DIR !== CONFIG_DIR) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 把 JSON 里所有以 from 开头的绝对路径改写成 to 开头 */
function rewritePrefix(data, from, to) {
  const norm = s => (typeof s === 'string' ? s.replace(/\\/g, '/').toLowerCase() : '');
  const fromN = norm(from).replace(/\/+$/, '');
  const toN = to.replace(/\\/g, '/').replace(/\/+$/, '');
  let changed = 0;
  const walk = v => {
    if (typeof v === 'string') {
      const n = norm(v);
      if (n === fromN || n.startsWith(fromN + '/')) {
        const rest = v.replace(/\\/g, '/').slice(fromN.length);
        changed++;
        return toN + rest;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { data: walk(data), changed };
}

function rewriteJsonFile(file, from, to) {
  try {
    if (!fs.existsSync(file)) return 0;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { data, changed } = rewritePrefix(raw, from, to);
    if (changed) fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return changed;
  } catch { return 0; }
}

/**
 * 改名后首次启动：把旧的 HYServ 目录搬到 HMCS。
 * 同分区 rename 几乎瞬时；搬完必须重写注册表 / 设置里的绝对路径，
 * 否则实例还指着旧目录会全部变成「目录缺失」。
 */
function migrateAppDir() {
  if (UNIFIED) return false;
  if (fs.existsSync(CONFIG_DIR)) return false;
  if (!fs.existsSync(LEGACY_APP_DIR)) return false;
  try {
    fs.mkdirSync(path.dirname(CONFIG_DIR), { recursive: true });
    fs.renameSync(LEGACY_APP_DIR, CONFIG_DIR);
  } catch {
    return false;   // 被占用或跨盘，放弃迁移，用户仍可用 HMCS_HOME 指回去
  }
  rewriteJsonFile(SETTINGS_FILE, LEGACY_APP_DIR, CONFIG_DIR);
  rewriteJsonFile(REGISTRY_FILE, LEGACY_APP_DIR, CONFIG_DIR);
  console.log(`[${APP_SHORT}] 数据目录已从 ${LEGACY_APP_DIR} 迁移到 ${CONFIG_DIR}`);
  return true;
}

/**
 * Linux：早期版本把 servers/ 放在配置目录里，现在归到 XDG 数据目录。
 * 整块搬过去，并同步改设置与注册表。
 */
function migrateSplitDataDir() {
  if (UNIFIED) return false;
  if (platform() !== 'linux') return false;
  const legacy = path.join(CONFIG_DIR, 'servers');
  if (!fs.existsSync(legacy)) return false;
  if (fs.existsSync(DEFAULT_SERVERS_DIR) && fs.readdirSync(DEFAULT_SERVERS_DIR).length) return false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.renameSync(legacy, DEFAULT_SERVERS_DIR);
  } catch {
    return false;
  }
  rewriteJsonFile(SETTINGS_FILE, legacy, DEFAULT_SERVERS_DIR);
  rewriteJsonFile(REGISTRY_FILE, legacy, DEFAULT_SERVERS_DIR);
  console.log(`[${APP_SHORT}] 实例目录已从 ${legacy} 迁移到 ${DEFAULT_SERVERS_DIR}`);
  return true;
}

/** 把程序目录里的旧 settings.json 迁移到系统目录，旧文件改名为 .migrated 留档 */
function migrateLegacySettings() {
  if (!fs.existsSync(LEGACY_SETTINGS_FILE)) return null;
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(LEGACY_SETTINGS_FILE, 'utf8')); } catch { return null; }
  if (!legacy || typeof legacy !== 'object') return null;
  const next = { ...clone(DEFAULT_SETTINGS), ...legacy };
  if (!next.serversDir) next.serversDir = DEFAULT_SERVERS_DIR;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  try { fs.renameSync(LEGACY_SETTINGS_FILE, LEGACY_SETTINGS_FILE + '.migrated'); } catch { /* 只读目录就算了 */ }
  console.log(`[${APP_SHORT}] 已把 settings.json 迁移到 ` + SETTINGS_FILE);
  return next;
}

migrateAppDir();
migrateSplitDataDir();

function readSettings() {
  ensureDirs();
  if (!fs.existsSync(SETTINGS_FILE)) {
    const migrated = migrateLegacySettings();
    if (migrated) return migrated;
    const fresh = clone(DEFAULT_SETTINGS);
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(fresh, null, 2), 'utf8');
    return fresh;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const out = { ...clone(DEFAULT_SETTINGS), ...raw };
    if (!Array.isArray(out.clientRoots)) out.clientRoots = [];
    if (!Array.isArray(out.extraWorldDirs)) out.extraWorldDirs = [];
    if (!out.serversDir || typeof out.serversDir !== 'string') out.serversDir = DEFAULT_SERVERS_DIR;
    return out;
  } catch {
    return clone(DEFAULT_SETTINGS);
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  if (!Array.isArray(next.clientRoots)) next.clientRoots = [];
  if (!Array.isArray(next.extraWorldDirs)) next.extraWorldDirs = [];
  if (!next.serversDir) next.serversDir = DEFAULT_SERVERS_DIR;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
  return next;
}

/** 当前生效的服务端实例存放目录 */
function serversDir() {
  return readSettings().serversDir || DEFAULT_SERVERS_DIR;
}

module.exports = {
  APP_NAME, APP_SHORT, DIR_NAME, platform,
  ROOT, PUBLIC_DIR,
  APP_DIR, CONFIG_DIR, DATA_DIR,
  SETTINGS_FILE, REGISTRY_FILE,
  DEFAULT_SERVERS_DIR, LEGACY_SERVERS_DIR, LEGACY_SETTINGS_FILE, LEGACY_APP_DIR,
  readSettings, writeSettings, serversDir, ensureDirs, DEFAULT_SETTINGS,
};
