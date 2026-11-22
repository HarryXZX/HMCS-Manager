'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UA = { 'User-Agent': 'HMCS/0.1 (local server manager; +https://localhost)' };
const CACHE = new Map();

async function httpJson(url, ttl) {
  const now = Date.now();
  const hit = CACHE.get(url);
  if (hit && now - hit.at < (ttl || 300000)) return hit.data;
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`);
      const data = await res.json();
      CACHE.set(url, { at: now, data });
      return data;
    } catch (e) {
      last = e;
      if (attempt < 3) await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
  throw new Error(`请求失败：${last && last.message}（${url}）`);
}

async function download(url, dest, opts) {
  const { sha = '', algo = 'sha256', onProgress } = opts || {};
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';

  // 部分镜像（比如 Fabric 现场打包的 jar）连接很慢或偶发超时，重试两次
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(url, { headers: UA, redirect: 'follow' });
      break;
    } catch (e) {
      if (attempt >= 3) throw new Error(`下载失败：${e.message}（${url}）`);
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  const hash = crypto.createHash(algo);
  const out = fs.createWriteStream(tmp);
  let received = 0;
  for await (const chunk of res.body) {
    out.write(chunk);
    hash.update(chunk);
    received += chunk.length;
    if (onProgress) onProgress({ received, total });
  }
  await new Promise((ok, bad) => out.end(err => (err ? bad(err) : ok())));
  if (sha) {
    const got = hash.digest('hex');
    if (got.toLowerCase() !== String(sha).toLowerCase()) {
      fs.unlinkSync(tmp);
      throw new Error('校验失败（文件可能不完整）: ' + got);
    }
  }
  fs.renameSync(tmp, dest);
  return dest;
}

// ------------------------------------------------------------ Vanilla（Mojang 官方）
async function vanillaVersions() {
  const m = await httpJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 600000);
  return {
    latest: m.latest,
    versions: m.versions.map(v => ({ id: v.id, type: v.type, time: v.releaseTime })),
  };
}

async function vanillaResolve(id) {
  const m = await httpJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 600000);
  const v = m.versions.find(x => x.id === id);
  if (!v) throw new Error('Mojang 没有这个版本: ' + id);
  const meta = await httpJson(v.url, 3600000);
  const s = meta.downloads && meta.downloads.server;
  if (!s) throw new Error('该版本没有官方服务端下载（可能是快照/远古版本）: ' + id);
  return { url: s.url, fileName: `server-${id}.jar`, sha: s.sha1, algo: 'sha1', size: s.size, kind: 'vanilla' };
}

// ------------------------------------------------------------ Paper（fill v3）
async function paperVersions() {
  const d = await httpJson('https://fill.papermc.io/v3/projects/paper', 600000);
  const out = [];
  for (const [group, arr] of Object.entries(d.versions || {})) {
    for (const v of arr) out.push({ id: v, type: group === v ? 'release' : 'rc', group });
  }
  return { versions: out };
}

async function paperResolve(id) {
  const b = await httpJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(id)}/builds/latest`, 120000);
  const dl = b.downloads && (b.downloads['server:default'] || Object.values(b.downloads)[0]);
  if (!dl) throw new Error('Paper 未找到可下载构建: ' + id);
  return {
    url: dl.url,
    fileName: dl.name,
    sha: dl.checksums && dl.checksums.sha256,
    algo: 'sha256',
    size: dl.size,
    build: b.id,
    channel: b.channel,
    kind: 'paper',
  };
}

// ------------------------------------------------------------ Purpur
async function purpurVersions() {
  const d = await httpJson('https://api.purpurmc.org/v2/purpur', 600000);
  return { versions: (d.versions || []).slice().reverse().map(v => ({ id: v, type: 'release' })) };
}

async function purpurResolve(id) {
  const d = await httpJson(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(id)}/latest`, 120000);
  if (!d.build) throw new Error('Purpur 未找到该版本构建: ' + id);
  return {
    url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(id)}/${d.build}/download`,
    fileName: `purpur-${id}-${d.build}.jar`,
    kind: 'purpur',
    build: d.build,
  };
}

// ------------------------------------------------------------ Fabric
async function fabricVersions() {
  const list = await httpJson('https://meta.fabricmc.net/v2/versions/game', 600000);
  return { versions: list.filter(v => v.stable).map(v => ({ id: v.version, type: 'release' })) };
}

async function fabricResolve(id) {
  // 服务端 jar 的下载地址必须带 loader + installer 两个版本号，三段式地址会 404
  // （两个 meta 请求串行发，并发访问 meta.fabricmc.net 容易超时）
  const loaders = await httpJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(id)}`, 600000);
  const installers = await httpJson('https://meta.fabricmc.net/v2/versions/installer', 600000).catch(() => []);
  const stable = loaders.filter(l => l.loader && l.loader.stable);
  const loader = (stable[0] || loaders[0]);
  if (!loader) throw new Error('Fabric 没有该版本的 loader: ' + id);
  const lv = loader.loader.version;
  const inst = Array.isArray(installers) ? (installers.find(i => i.stable) || installers[0]) : null;
  const iv = inst ? inst.version : '1.1.2';
  return {
    // 这个地址由 Fabric 现场打包，首次请求可能要等 1-2 分钟
    url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(id)}/${encodeURIComponent(lv)}/${encodeURIComponent(iv)}/server/jar`,
    fileName: 'fabric-server-launch.jar',
    kind: 'fabric',
    loaderVersion: lv,
  };
}

// ------------------------------------------------------------ Forge / NeoForge（安装器）
async function neoforgeResolve(id) {
  const d = await httpJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', 600000);
  const all = (d.versions || []).filter(v => v.startsWith(id + '.') || v.startsWith(id + '-'));
  if (!all.length) throw new Error('NeoForge 没有匹配 ' + id + ' 的版本');
  const v = all[all.length - 1];
  return {
    url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar`,
    fileName: `neoforge-${v}-installer.jar`,
    kind: 'neoforge',
    loaderVersion: v,
    installer: true,
  };
}

const PROVIDERS = {
  vanilla: { label: '原版 Vanilla（Mojang 官方）', versions: vanillaVersions, resolve: vanillaResolve, note: '官方服务端，无插件支持' },
  paper: { label: 'Paper（高性能，支持插件）', versions: paperVersions, resolve: paperResolve, note: 'Bukkit/Spigot 插件生态，推荐' },
  purpur: { label: 'Purpur（Paper 分支，可调项更多）', versions: purpurVersions, resolve: purpurResolve, note: '兼容 Paper 插件' },
  fabric: { label: 'Fabric（模组，支持 Carpet 等）', versions: fabricVersions, resolve: fabricResolve, note: '服务端模组，插件需 Fabric 版' },
};

async function listVersions(type) {
  const p = PROVIDERS[type];
  if (!p) throw new Error('未知服务端类型: ' + type);
  if (!p.versions) return { versions: [] };
  return p.versions();
}

async function resolveDownload(type, mcVersion) {
  const p = PROVIDERS[type];
  if (!p) throw new Error('未知服务端类型: ' + type);
  return p.resolve(mcVersion);
}

module.exports = { PROVIDERS, listVersions, resolveDownload, download, httpJson };
