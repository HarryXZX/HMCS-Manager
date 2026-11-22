'use strict';
/**
 * 路径与设置
 *
 * 程序目录只放代码（app.js / lib / public），所有可变数据都在系统用户目录：
 *   Windows : %APPDATA%\HMCS
 *   macOS   : ~/Library/Application Support/HMCS
 *   Linux   : $XDG_CONFIG_HOME/HMCS（默认 ~/.config/HMCS）
 * 三者都能用环境变量 HMCS_HOME 覆盖。
 *
 *   ├─ settings.json    应用设置（含服务端实例默认存放目录、客户端根目录）
 *   ├─ instances.json   实例注册表（记录每个实例的真实磁盘路径）
 *   └─ servers/         默认的服务端实例存放目录（可在设置里改成任意位置）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_NAME = 'HYCX MC Server Manager';
const APP_SHORT = 'HMCS';
const DIR_NAME = 'HMCS';          // 数据目录名
const LEGACY_DIR_NAME = 'HYServ'; // 改名前的数据目录名，首次启动自动迁走

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

/** 各平台的「应用数据根目录」 */
function dataRoot() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}

function resolveAppDir() {
  const custom = process.env.HMCS_HOME || process.env.HYSERV_HOME;
  if (custom && String(custom).trim()) return path.resolve(String(custom).trim());
  return path.join(dataRoot(), DIR_NAME);
}

const APP_DIR = resolveAppDir();
const LEGACY_APP_DIR = path.join(dataRoot(), LEGACY_DIR_NAME);
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const REGISTRY_FILE = path.join(APP_DIR, 'instances.json');
const DEFAULT_SERVERS_DIR = path.join(APP_DIR, 'servers');

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
  fs.mkdirSync(APP_DIR, { recursive: true });
}

/** 把 JSON 文件里所有以 from 开头的字符串（绝对路径）改写成 to 开头 */
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

/**
 * 改名后首次启动：把旧版 %APPDATA%\HYServ 整体搬到 %APPDATA%\HMCS。
 * 目录是同一分区，rename 几乎瞬时；搬完必须重写注册表/设置里的绝对路径，
 * 否则实例还指着旧目录会全部变成「目录缺失」。
 */
function migrateAppDir() {
  if (APP_DIR !== path.join(dataRoot(), DIR_NAME)) return false;   // 用户自定义目录，不动
  if (fs.existsSync(APP_DIR)) return false;
  if (!fs.existsSync(LEGACY_APP_DIR)) return false;

  try {
    fs.renameSync(LEGACY_APP_DIR, APP_DIR);
  } catch {
    return false;   // 被占用或跨盘，放弃迁移，用户仍可用 HMCS_HOME 指回去
  }

  for (const file of [REGISTRY_FILE, SETTINGS_FILE]) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { data, changed } = rewritePrefix(raw, LEGACY_APP_DIR, APP_DIR);
      if (changed) fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch { /* 单个文件坏了不影响启动 */ }
  }
  console.log(`[${APP_SHORT}] 数据目录已从 ${LEGACY_APP_DIR} 迁移到 ${APP_DIR}`);
  return true;
}

migrateAppDir();

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
  fs.mkdirSync(APP_DIR, { recursive: true });
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
  APP_NAME, APP_SHORT, DIR_NAME,
  ROOT, PUBLIC_DIR, APP_DIR, SETTINGS_FILE, REGISTRY_FILE,
  DEFAULT_SERVERS_DIR, LEGACY_SERVERS_DIR, LEGACY_SETTINGS_FILE, LEGACY_APP_DIR,
  readSettings, writeSettings, serversDir, ensureDirs, DEFAULT_SETTINGS,
};
