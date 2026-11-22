'use strict';
const fs = require('fs');
const path = require('path');
const sources = require('./sources');
const instances = require('./instances');

const UA = { 'User-Agent': 'HMCS/0.1 (local server manager)' };
const BASE = 'https://api.modrinth.com/v2';

const LOADERS = {
  paper: ['paper', 'spigot', 'bukkit'],
  purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
  fabric: ['fabric'],
  vanilla: [],
};

function pluginDirOf(inst) {
  const sub = inst.type === 'fabric' ? 'mods' : 'plugins';
  return path.join(instances.dirOf(inst.id), sub);
}

function installed(inst) {
  const dir = pluginDirOf(inst);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.jar'))
    .map(d => {
      const st = fs.statSync(path.join(dir, d.name));
      return { name: d.name, size: st.size, mtime: st.mtime.toISOString(), sub: path.basename(dir) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function search(q, opts) {
  const { mcVersion, type } = opts || {};
  const loaders = LOADERS[type] || [];
  if (!loaders.length) return { hits: [], note: '原版服务端不支持插件' };

  const facets = [['project_type:plugin'], ['categories:' + loaders[0]]];
  if (mcVersion) facets.push(['versions:' + mcVersion]);
  const url = `${BASE}/search?limit=24&index=relevance&query=${encodeURIComponent(q || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  let data;
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) {
    throw new Error('Modrinth 搜索失败: ' + e.message);
  }
  let hits = data.hits || [];

  // 该 MC 版本下没结果时放宽版本限制
  if (!hits.length && mcVersion) {
    const relaxed = [['project_type:plugin'], ['categories:' + loaders[0]]];
    const r2 = await fetch(`${BASE}/search?limit=24&query=${encodeURIComponent(q || '')}&facets=${encodeURIComponent(JSON.stringify(relaxed))}`, { headers: UA });
    if (r2.ok) hits = (await r2.json()).hits || [];
  }

  return {
    hits: hits.map(h => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      follows: h.follows,
      icon: h.icon_url,
      categories: h.display_categories || h.categories || [],
      versions: h.versions || [],
    })),
  };
}

async function versions(projectId, opts) {
  const { mcVersion, type } = opts || {};
  const loaders = LOADERS[type] || [];
  const qs = new URLSearchParams();
  if (loaders.length) qs.set('loaders', JSON.stringify(loaders));
  if (mcVersion) qs.set('game_versions', JSON.stringify([mcVersion]));
  let res = await fetch(`${BASE}/project/${encodeURIComponent(projectId)}/version?${qs}`, { headers: UA });
  if (!res.ok) throw new Error('Modrinth 版本查询失败: HTTP ' + res.status);
  let list = await res.json();
  if (!list.length && mcVersion) {
    const qs2 = new URLSearchParams();
    if (loaders.length) qs2.set('loaders', JSON.stringify(loaders));
    res = await fetch(`${BASE}/project/${encodeURIComponent(projectId)}/version?${qs2}`, { headers: UA });
    if (res.ok) list = await res.json();
  }
  return list.map(v => ({
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions,
    loaders: v.loaders,
    downloads: v.downloads,
    date: v.date_published,
    changelog: String(v.changelog || '').slice(0, 400),
    files: (v.files || []).map(f => ({ url: f.url, filename: f.filename, primary: f.primary, size: f.size, hashes: f.hashes })),
  }));
}

async function install(inst, projectId, versionId) {
  const list = await versions(projectId, { mcVersion: inst.mcVersion, type: inst.type });
  let ver = null;
  if (versionId) ver = list.find(v => v.id === versionId);
  if (!ver) ver = list[0];
  if (!ver) throw new Error('没有找到可用的插件版本');
  const file = ver.files.find(f => f.primary) || ver.files[0];
  if (!file) throw new Error('该版本没有可下载文件');

  const dir = pluginDirOf(inst);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file.filename);
  const sha512 = file.hashes && file.hashes.sha512;
  await sources.download(file.url, dest, sha512 ? { sha: sha512, algo: 'sha512' } : {});
  return { ok: true, file: file.filename, version: ver.versionNumber, dir: path.basename(dir), projectId };
}

module.exports = { search, versions, install, installed, pluginDirOf, LOADERS };
