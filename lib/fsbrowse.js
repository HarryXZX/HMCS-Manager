'use strict';
/**
 * 文件系统浏览（给 WebUI 的目录选择器用）+ 客户端实例探测
 * 只做「列目录 / 建目录 / 打开资源管理器」，不做任何删除操作。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { APP_DIR, CONFIG_DIR, DATA_DIR, DEFAULT_SERVERS_DIR, readSettings, platform } = require('./paths');

const SKIP = /^(\$Recycle\.Bin|System Volume Information|Recovery|Config\.Msi|hiberfil\.sys|pagefile\.sys|swapfile\.sys)$/i;

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function drives() {
  const out = [];
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c) + ':\\';
      if (isDir(d)) out.push({ name: d, path: d });
    }
  } else {
    out.push({ name: '/', path: '/' });
  }
  return out;
}

/** Linux 的桌面/文档/下载目录名可能被本地化成中文等，从 xdg-user-dirs 配置里读 */
function xdgUserDir(key, home) {
  try {
    const conf = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'user-dirs.dirs');
    const txt = fs.readFileSync(conf, 'utf8');
    const m = txt.match(new RegExp('^XDG_' + key + '_DIR="([^"]+)"', 'm'));
    if (m) return m[1].replace(/^\$HOME/, home);
  } catch { /* 没配置就用默认英文名 */ }
  const fallback = { DESKTOP: 'Desktop', DOCUMENTS: 'Documents', DOWNLOAD: 'Downloads' }[key];
  return fallback ? path.join(home, fallback) : home;
}

function quickPlaces() {
  const home = os.homedir();
  const p = platform();
  const list = [{ name: '用户目录', path: home }];

  if (p === 'win32') {
    list.push(
      { name: '桌面', path: path.join(home, 'Desktop') },
      { name: '文档', path: path.join(home, 'Documents') },
      { name: '下载', path: path.join(home, 'Downloads') },
      { name: 'AppData\\Roaming', path: process.env.APPDATA || path.join(home, 'AppData', 'Roaming') },
    );
  } else if (p === 'darwin') {
    list.push(
      { name: '桌面', path: path.join(home, 'Desktop') },
      { name: '文稿', path: path.join(home, 'Documents') },
      { name: '下载', path: path.join(home, 'Downloads') },
      { name: 'Application Support', path: path.join(home, 'Library', 'Application Support') },
    );
  } else {
    list.push(
      { name: '主目录', path: home },
      { name: '桌面', path: xdgUserDir('DESKTOP', home) },
      { name: '文档', path: xdgUserDir('DOCUMENTS', home) },
      { name: '下载', path: xdgUserDir('DOWNLOAD', home) },
    );
  }

  list.push({ name: 'HMCS 配置目录', path: CONFIG_DIR });
  if (DATA_DIR !== CONFIG_DIR) list.push({ name: 'HMCS 数据目录', path: DATA_DIR });
  // 显示实际生效的实例目录（设置里可能改过），默认目录不同时再单列一条
  const activeServers = readSettings().serversDir || DEFAULT_SERVERS_DIR;
  list.push({ name: 'HMCS 实例目录', path: activeServers });
  if (path.resolve(activeServers) !== path.resolve(DEFAULT_SERVERS_DIR)) {
    list.push({ name: 'HMCS 默认实例目录', path: DEFAULT_SERVERS_DIR });
  }

  const seen = new Set();
  return list.filter(x => {
    if (!x.path || !isDir(x.path)) return false;
    const k = x.path.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function roots() {
  return {
    home: os.homedir(),
    appDir: APP_DIR,
    configDir: CONFIG_DIR,
    dataDir: DATA_DIR,
    defaultServersDir: DEFAULT_SERVERS_DIR,
    serversDir: readSettings().serversDir || DEFAULT_SERVERS_DIR,
    drives: drives(),
    quick: quickPlaces(),
  };
}

/** 列出一个目录下的子目录 */
function listDirs(target) {
  const p = target && String(target).trim() ? path.resolve(String(target).trim()) : '';
  if (!p) return { path: '', parent: '', dirs: [] };

  let st;
  try { st = fs.statSync(p); } catch { const e = new Error('目录不存在: ' + p); e.status = 400; throw e; }
  if (!st.isDirectory()) { const e = new Error('不是目录: ' + p); e.status = 400; throw e; }

  let entries = [];
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch (e) {
    return { path: p, parent: path.dirname(p), dirs: [], error: '无法读取该目录（' + (e.code || e.message) + '）' };
  }

  const dirs = [];
  for (const e of entries) {
    if (SKIP.test(e.name)) continue;
    const full = path.join(p, e.name);
    let isD = e.isDirectory();
    let link = e.isSymbolicLink();
    let target2 = '';
    if (link) {
      try { target2 = fs.readlinkSync(full); } catch { /* ignore */ }
      isD = isDir(full);
    }
    if (!isD) continue;
    dirs.push({ name: e.name, path: full, link, target: target2 });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const parent = path.dirname(p);
  return { path: p, parent: parent === p ? '' : parent, dirs };
}

function mkdirp(p) {
  const abs = path.resolve(String(p || '').trim());
  if (!abs) { const e = new Error('缺少路径'); e.status = 400; throw e; }
  fs.mkdirSync(abs, { recursive: true });
  return { ok: true, path: abs };
}

function reveal(p) {
  const abs = path.resolve(String(p || '').trim());
  if (!fs.existsSync(abs)) { const e = new Error('路径不存在: ' + abs); e.status = 400; throw e; }
  const open = (cmd, args) => new Promise(resolve => {
    try { execFile(cmd, args, { windowsHide: true }, () => resolve(true)); } catch { resolve(false); }
  });
  if (process.platform === 'win32') {
    // explorer 打开目录时退出码可能是 1，忽略即可
    execFile('explorer.exe', [abs], { windowsHide: true }, () => {});
  } else if (process.platform === 'darwin') {
    open('open', [abs]);
  } else {
    open('xdg-open', [abs]);
  }
  return { ok: true, path: abs };
}

// ------------------------------------------------------------------ 客户端实例探测

function countSaves(root) {
  const saves = path.join(root, 'saves');
  let n = 0;
  try {
    for (const e of fs.readdirSync(saves, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (fs.existsSync(path.join(saves, e.name, 'level.dat'))) n++;
      if (n > 500) break;
    }
  } catch { /* 没有 saves */ }
  return n;
}

function countVersions(root) {
  try {
    return fs.readdirSync(path.join(root, 'versions'), { withFileTypes: true }).filter(e => e.isDirectory()).length;
  } catch { return 0; }
}

function isClientRoot(dir) {
  return ['saves', 'versions', 'options.txt', 'launcher_profiles.json', 'launcher_accounts.json']
    .some(f => fs.existsSync(path.join(dir, f)));
}

function describe(root, kind) {
  return {
    path: root,
    name: path.basename(root) === '.minecraft' ? `.minecraft（${path.basename(path.dirname(root)) || root}）` : path.basename(root),
    kind,
    saves: countSaves(root),
    versions: countVersions(root),
  };
}

/** 多实例启动器（Prism / MultiMC / Modrinth / CurseForge）的容器目录 → 每个子目录是一个实例 */
function expandContainer(dir, kind, push) {
  let subs = [];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { return; }
  for (const s of subs) {
    const base = path.join(dir, s.name);
    const inner = path.join(base, '.minecraft');
    if (isClientRoot(inner)) push(inner, kind + ' · ' + s.name);
    else if (isClientRoot(base)) push(base, kind + ' · ' + s.name);
  }
}

/**
 * 探测本机可能存在的 Minecraft 客户端目录
 * 结果只是建议，用户可以在设置里自行添加 / 删除
 */
function detectClients() {
  const home = os.homedir();
  const plat = platform();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const appSupport = path.join(home, 'Library', 'Application Support');
  const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const out = [];
  const seen = new Set();
  const push = (dir, kind) => {
    const abs = path.resolve(dir);
    if (!isClientRoot(abs)) return;
    const k = abs.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(describe(abs, kind || '客户端根目录'));
  };

  // 1) 官方启动器 / 通用 .minecraft（各平台路径都试一遍，不存在的会被过滤掉）
  const simple = [
    [path.join(appdata, '.minecraft'), '官方启动器 / 通用 .minecraft'],
    [path.join(home, '.minecraft'), '用户目录下的 .minecraft'],
    [path.join(appSupport, 'minecraft'), 'macOS 官方启动器'],
    [path.join(xdgData, 'minecraft'), 'Linux 官方启动器'],
    [path.join(home, '.var', 'app', 'com.mojang.Minecraft', '.minecraft'), 'Flatpak 启动器'],
  ];
  for (const [dir, k] of simple) push(dir, k);

  // 2) 多实例启动器：容器目录随平台不同
  const containers = [];
  if (plat === 'win32') {
    containers.push(
      [path.join(appdata, 'PrismLauncher', 'instances'), 'Prism 实例'],
      [path.join(appdata, 'MultiMC', 'instances'), 'MultiMC 实例'],
      [path.join(appdata, 'com.modrinth.theseus', 'profiles'), 'Modrinth App 实例'],
    );
  } else if (plat === 'darwin') {
    containers.push(
      [path.join(appSupport, 'PrismLauncher', 'instances'), 'Prism 实例'],
      [path.join(appSupport, 'ModrinthApp', 'profiles'), 'Modrinth App 实例'],
      [path.join(appSupport, 'com.modrinth.theseus', 'profiles'), 'Modrinth App 实例'],
    );
  } else {
    containers.push(
      [path.join(xdgData, 'PrismLauncher', 'instances'), 'Prism 实例'],
      [path.join(xdgData, 'multimc', 'instances'), 'MultiMC 实例'],
      [path.join(xdgData, 'MultiMC', 'instances'), 'MultiMC 实例'],
      [path.join(xdgData, 'ModrinthApp', 'profiles'), 'Modrinth App 实例'],
      [path.join(home, '.var', 'app', 'io.github.PrismLauncher_PrismLauncher', 'data', 'PrismLauncher', 'instances'), 'Prism（Flatpak）'],
    );
  }
  // CurseForge 桌面版：Windows / Linux 在用户目录，macOS 在文稿里
  containers.push(
    [path.join(home, 'curseforge', 'minecraft', 'Instances'), 'CurseForge 实例'],
    [path.join(home, 'Documents', 'curseforge', 'minecraft', 'Instances'), 'CurseForge 实例'],
  );
  for (const [dir, kind] of containers) expandContainer(dir, kind, push);

  // 3) Windows 扫各磁盘根目录；mac / Linux 扫用户目录下的常见文件夹
  if (plat === 'win32') {
    for (const d of drives()) {
      const base = d.path;
      push(path.join(base, '.minecraft'), `磁盘根目录 ${base}`);
      push(path.join(base, 'Minecraft', '.minecraft'), `Minecraft 文件夹`);
      push(path.join(base, 'Games', '.minecraft'), `Games 文件夹`);
    }
  } else {
    for (const name of ['Minecraft', 'Games', 'minecraft']) {
      push(path.join(home, name, '.minecraft'), '用户目录下的 ' + name);
      push(path.join(home, name), '用户目录下的 ' + name);
    }
  }

  // 4) 用户已配置的目录（保证已在用的也会出现在建议里，便于管理）
  const s = readSettings();
  for (const r of s.clientRoots || []) push(r, '已配置');

  return out;
}

/** 单个目录的信息（给设置页展示用） */
function describeRoot(p) {
  const abs = path.resolve(String(p || ''));
  const exists = isDir(abs);
  return {
    path: abs,
    exists,
    isClient: exists && isClientRoot(abs),
    saves: exists ? countSaves(abs) : 0,
    versions: exists ? countVersions(abs) : 0,
  };
}

module.exports = { roots, listDirs, mkdirp, reveal, detectClients, isClientRoot, countSaves, describeRoot };
