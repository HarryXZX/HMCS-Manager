'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const yaml = require('js-yaml');

const { PUBLIC_DIR, readSettings, writeSettings, APP_DIR, SETTINGS_FILE, REGISTRY_FILE, DEFAULT_SERVERS_DIR } = require('./lib/paths');
const java = require('./lib/java');
const sources = require('./lib/sources');
const instances = require('./lib/instances');
const proc = require('./lib/proc');
const fsx = require('./lib/fsx');
const props = require('./lib/props');
const worlds = require('./lib/worlds');
const modrinth = require('./lib/modrinth');
const upnp = require('./lib/upnp');
const eula = require('./lib/eula');
const fsbrowse = require('./lib/fsbrowse');

// ------------------------------------------------------------------ 工具
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  const max = limit || 12 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > max) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new Error('JSON 解析失败'); }
}

function instOf(id) { return instances.get(id); }
function dirOf(id) { return instances.dirOf(id); }

function instanceView(inst) {
  const rt = proc.statusOf(inst.id);
  let world;
  try { world = worlds.currentWorld(inst); } catch { world = { exists: false }; }
  const p = props.readProps(dirOf(inst.id));
  const parsed = props.parse(p.text);
  const eu = eula.read(dirOf(inst.id));
  return {
    ...inst,
    dir: dirOf(inst.id),
    missing: instances.missing(inst),
    runtime: rt,
    world,
    port: Number(parsed.map['server-port'] || inst.port || 25565),
    motd: parsed.map.motd || '',
    onlineMode: String(parsed.map['online-mode'] || '').toLowerCase() === 'true',
    levelName: parsed.map['level-name'] || inst.worldName,
    coreExists: fs.existsSync(path.join(dirOf(inst.id), inst.coreFile)),
    upnp: upnpCfg(inst),
    // 以 eula.txt 的真实内容为准，而不是 instance.json 里的缓存值
    eula: {
      accepted: eu.accepted,
      exists: eu.exists,
      url: eu.url,
      file: eu.file,
      text: eu.raw,
      updatedAt: eu.mtime ? new Date(eu.mtime).toISOString() : '',
    },
  };
}

// ------------------------------------------------------------------ UPnP
const HOOKED = new Set();
const UPNP_PROTOCOLS = ['TCP', 'UDP', 'BOTH'];

function upnpCfg(inst) {
  const u = inst.upnp || {};
  const ext = Number(u.externalPort);
  return {
    auto: !!u.auto,
    externalPort: ext >= 1 && ext <= 65535 ? ext : 0,
    protocol: UPNP_PROTOCOLS.includes(u.protocol) ? u.protocol : 'TCP',
    lease: Number.isFinite(Number(u.lease)) ? Math.max(0, Number(u.lease)) : 0,
  };
}

function serverPortOf(inst) {
  try {
    const parsed = props.parse(props.readProps(dirOf(inst.id)).text);
    return Number(parsed.map['server-port'] || inst.port || 25565);
  } catch { return Number(inst.port || 25565); }
}

const protocolList = p => (p === 'BOTH' ? ['TCP', 'UDP'] : [String(p || 'TCP').toUpperCase()]);

async function upnpApply(inst, opts = {}) {
  const cfg = upnpCfg(inst);
  const internalPort = serverPortOf(inst);
  const externalPort = Number(opts.externalPort) > 0 ? Number(opts.externalPort) : (cfg.externalPort || internalPort);
  const protocol = opts.protocol || cfg.protocol;
  const lease = Number.isFinite(Number(opts.lease)) ? Math.max(0, Number(opts.lease)) : cfg.lease;

  if (!(externalPort >= 1 && externalPort <= 65535)) throw new Error('外网端口必须在 1-65535 之间');

  const { gateway } = await upnp.discover(opts.force ? { force: true } : {});

  // 先清掉本实例之前登记的条目，避免换端口/换协议后留下僵尸映射
  await upnpRemove(inst, { quiet: true });

  const added = [];
  for (const proto of protocolList(protocol)) {
    const r = await upnp.addMapping(gateway, {
      externalPort,
      internalPort,
      protocol: proto,
      description: 'HMCS ' + inst.name,
      lease,
    });
    added.push({
      protocol: r.protocol,
      externalPort: r.externalPort,
      internalPort: r.internalPort,
      internalClient: r.internalClient,
      lease: r.lease,
    });
  }

  inst.upnp = {
    ...cfg,
    ...(opts.remember ? { externalPort, protocol: UPNP_PROTOCOLS.includes(protocol) ? protocol : cfg.protocol, lease } : {}),
    added,
    lastError: '',
    lastSync: new Date().toISOString(),
  };
  instances.save(inst);

  let externalIp = '';
  try { externalIp = await upnp.getExternalIp(gateway); } catch { /* 部分网关不支持，忽略 */ }

  return { added, externalIp, gateway: { friendlyName: gateway.friendlyName, modelName: gateway.modelName } };
}

async function upnpRemove(inst, opts = {}) {
  const added = (inst.upnp && Array.isArray(inst.upnp.added)) ? inst.upnp.added : [];
  if (!added.length) return { removed: [] };
  let gateway;
  try { ({ gateway } = await upnp.discover({})); } catch (e) {
    if (!opts.quiet) throw e;
    return { removed: [], error: e.message };
  }

  const removed = [];
  for (const item of added) {
    try {
      await upnp.deleteMapping(gateway, { externalPort: item.externalPort, protocol: item.protocol });
      removed.push(item);
    } catch (e) {
      // 714 = 已不存在，视为成功
      if (e.upnpCode === 714) removed.push(item);
      else if (!opts.quiet) throw e;
    }
  }
  inst.upnp = { ...(inst.upnp || {}), added: [], lastSync: new Date().toISOString() };
  instances.save(inst);
  return { removed };
}

function upnpAutoStart(inst) {
  const cfg = upnpCfg(inst);
  if (!cfg.auto) return;
  upnpApply(inst, {}).then(r => {
    // 竞态保护：映射建好时进程可能已经退出了，别留下永久残留
    if (proc.statusOf(inst.id).status === 'stopped') {
      try { upnpRemove(instOf(inst.id), { quiet: true }).catch(() => {}); } catch { /* ignore */ }
      return;
    }
    const desc = r.added.map(a => `${a.protocol} ${a.externalPort} → ${a.internalClient}:${a.internalPort}`).join('，');
    proc.push(inst.id, `[HMCS] UPnP 端口映射已建立：${desc}${r.externalIp ? '（公网 IP ' + r.externalIp + '）' : ''}`);
  }).catch(e => {
    try {
      const cur = instOf(inst.id);
      cur.upnp = { ...(cur.upnp || {}), lastError: e.message, lastSync: new Date().toISOString() };
      instances.save(cur);
    } catch { /* 实例可能已被删除 */ }
    proc.push(inst.id, '[HMCS] UPnP 端口映射失败：' + e.message);
  });
}

function upnpAutoStop(instId) {
  let inst;
  try { inst = instOf(instId); } catch { return; }
  if (!upnpCfg(inst).auto) return;
  upnpRemove(inst, { quiet: true }).then(r => {
    if (r.removed && r.removed.length) proc.push(instId, '[HMCS] UPnP 端口映射已随服务端停止而移除');
  }).catch(() => {});
}

// ------------------------------------------------------------------ 路由
const routes = [];
function register(method, pattern, handler) {
  const segs = pattern.split('/').filter(Boolean);
  routes.push({ method, segs, handler });
}

function match(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.segs.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.segs.length; i++) {
      const s = r.segs[i];
      if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i]);
      else if (s !== parts[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

// ------------------------------------------------------------------ API
register('GET', '/api/bootstrap', async (req, res) => {
  let settings = readSettings();
  const clients = fsbrowse.detectClients();

  // 首次运行：把探测到的客户端目录写进设置，开箱即用（之后完全由用户在设置里维护）
  if (!settings.clientRoots.length && !settings.clientRootsDetected) {
    settings = writeSettings({
      clientRoots: clients.map(c => c.path),
      clientRootsDetected: true,
    });
  }

  const javaList = await java.list();
  const list = instances.list().map(instanceView);
  sendJson(res, 200, {
    settings,
    paths: {
      ...fsbrowse.roots(),
      serversDir: settings.serversDir || DEFAULT_SERVERS_DIR,
      appDir: APP_DIR,
      settingsFile: SETTINGS_FILE,
      registryFile: REGISTRY_FILE,
    },
    clients,
    clientInfo: (settings.clientRoots || []).map(fsbrowse.describeRoot),
    extraInfo: (settings.extraWorldDirs || []).map(p => ({ path: path.resolve(p), exists: fs.existsSync(p) })),
    java: javaList,
    instances: list,
    providers: Object.entries(sources.PROVIDERS).map(([id, p]) => ({ id, label: p.label, note: p.note })),
    running: proc.runningIds(),
  });
});

register('GET', '/api/instances/:id', async (req, res, p) => {
  sendJson(res, 200, instanceView(instOf(p.id)));
});

register('POST', '/api/instances', async (req, res) => {
  const body = await readJson(req);
  const inst = await instances.create(body, {});
  sendJson(res, 201, { ok: true, instance: instanceView(inst) });
});

// 导入磁盘上已有的服务端目录（不下载、不复制）
register('POST', '/api/instances/import', async (req, res) => {
  const body = await readJson(req);
  const inst = instances.importDir(body);
  sendJson(res, 201, { ok: true, instance: instanceView(inst) });
});

register('DELETE', '/api/instances/:id', async (req, res, p, q) => {
  const inst = instOf(p.id);
  if (proc.statusOf(p.id).status !== 'stopped') throw new Error('请先停止服务端再删除实例');
  // 默认只从列表移除，只有明确要求时才删磁盘文件
  const deleteFiles = q.get('files') === '1';
  try { await upnpRemove(inst, { quiet: true }); } catch { /* 网关不可达时不影响删除 */ }
  const r = instances.remove(p.id, { deleteFiles });
  sendJson(res, 200, r);
});

register('PUT', '/api/instances/:id', async (req, res, p) => {
  const body = await readJson(req);
  const inst = instances.update(p.id, body);
  sendJson(res, 200, { ok: true, instance: instanceView(inst) });
});

register('POST', '/api/instances/:id/start', async (req, res, p) => {
  const inst = instOf(p.id);
  const body = await readJson(req);
  if (body.world && body.world.source) {
    await worlds.attach(inst, body.world);
  }
  const r = await proc.start(inst, body);
  if (!HOOKED.has(inst.id)) {
    HOOKED.add(inst.id);
    proc.onExit(inst.id, () => upnpAutoStop(inst.id));
  }
  upnpAutoStart(inst);
  sendJson(res, 200, r);
});

register('POST', '/api/instances/:id/stop', async (req, res, p) => {
  instOf(p.id);
  const r = await proc.stop(p.id);
  sendJson(res, 200, r);
});

register('POST', '/api/instances/:id/command', async (req, res, p) => {
  instOf(p.id);
  const body = await readJson(req);
  if (!body.line) throw new Error('命令为空');
  proc.send(p.id, String(body.line).replace(/[\r\n]+/g, ' '));
  sendJson(res, 200, { ok: true });
});

register('GET', '/api/instances/:id/console', async (req, res, p) => {
  instOf(p.id);
  proc.subscribe(p.id, res);
});

register('GET', '/api/instances/:id/logs', async (req, res, p, q) => {
  instOf(p.id);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(proc.logsText(p.id, Number(q.get('limit') || 2000)));
});

register('POST', '/api/instances/:id/logs/clear', async (req, res, p) => {
  instOf(p.id);
  proc.clearLogs(p.id);
  sendJson(res, 200, { ok: true });
});

// ---- 文件
register('GET', '/api/instances/:id/files', async (req, res, p, q) => {
  instOf(p.id);
  sendJson(res, 200, { path: q.get('path') || '', entries: fsx.listDir(dirOf(p.id), q.get('path') || '') });
});

register('GET', '/api/instances/:id/file', async (req, res, p, q) => {
  instOf(p.id);
  sendJson(res, 200, fsx.readText(dirOf(p.id), q.get('path')));
});

register('PUT', '/api/instances/:id/file', async (req, res, p, q) => {
  instOf(p.id);
  const body = await readJson(req);
  const rel = body.path || q.get('path');
  if (!rel) throw new Error('缺少 path');
  sendJson(res, 200, fsx.writeText(dirOf(p.id), rel, body.content || ''));
});

register('POST', '/api/instances/:id/mkdir', async (req, res, p) => {
  instOf(p.id);
  const body = await readJson(req);
  sendJson(res, 200, fsx.mkdir(dirOf(p.id), body.path));
});

register('POST', '/api/instances/:id/rename', async (req, res, p) => {
  instOf(p.id);
  const body = await readJson(req);
  sendJson(res, 200, fsx.rename(dirOf(p.id), body.from, body.to));
});

register('DELETE', '/api/instances/:id/entry', async (req, res, p, q) => {
  instOf(p.id);
  const rel = q.get('path');
  if (!rel) throw new Error('缺少 path');
  sendJson(res, 200, fsx.remove(dirOf(p.id), rel));
});

register('POST', '/api/instances/:id/upload', async (req, res, p, q) => {
  instOf(p.id);
  const rel = q.get('path') || '';
  const name = q.get('name');
  if (!name) throw new Error('缺少文件名');
  const target = fsx.safeResolve(dirOf(p.id), path.posix.join(rel, name));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await new Promise((ok, bad) => {
    const ws = fs.createWriteStream(target);
    req.pipe(ws);
    ws.on('finish', ok);
    ws.on('error', bad);
    req.on('error', bad);
  });
  sendJson(res, 200, { ok: true, size: fs.statSync(target).size });
});

register('GET', '/api/instances/:id/raw', async (req, res, p, q) => {
  instOf(p.id);
  const rel = q.get('path');
  const abs = fsx.safeResolve(dirOf(p.id), rel);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw new Error('文件不存在');
  const name = path.basename(abs);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': fs.statSync(abs).size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  fs.createReadStream(abs).pipe(res);
});

// ---- 配置
register('GET', '/api/instances/:id/config/properties', async (req, res, p) => {
  instOf(p.id);
  const { text, exists } = props.readProps(dirOf(p.id));
  const parsed = props.parse(text);
  sendJson(res, 200, { exists, values: parsed.map, schema: props.SCHEMA, raw: text });
});

register('PUT', '/api/instances/:id/config/properties', async (req, res, p) => {
  instOf(p.id);
  const body = await readJson(req);
  const { text } = props.readProps(dirOf(p.id));
  const next = props.apply(text, body.values || {});
  fs.writeFileSync(path.join(dirOf(p.id), 'server.properties'), next, 'utf8');
  const inst = instOf(p.id);
  if (body.values['level-name']) { inst.worldName = body.values['level-name']; instances.save(inst); }
  sendJson(res, 200, { ok: true, raw: next });
});

const CONFIG_FILES = [
  'bukkit.yml', 'spigot.yml', 'commands.yml', 'permissions.yml', 'help.yml',
  'config/paper-global.yml', 'config/paper-world-defaults.yml', 'config/paper-global.json',
  'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json',
];

// ---- EULA
function eulaView(dir) {
  const s = eula.read(dir);
  return {
    accepted: s.accepted,
    exists: s.exists,
    file: s.file,
    path: s.path,
    url: s.url,
    text: s.raw,
    updatedAt: s.mtime ? new Date(s.mtime).toISOString() : '',
    // 未同意时服务端会拒绝启动，前端据此显示提示与禁用启动
    blocksStart: !s.accepted,
  };
}

register('GET', '/api/instances/:id/eula', async (req, res, p) => {
  instOf(p.id);
  sendJson(res, 200, eulaView(dirOf(p.id)));
});

register('PUT', '/api/instances/:id/eula', async (req, res, p) => {
  const inst = instOf(p.id);
  const dir = dirOf(p.id);
  const body = await readJson(req);

  let out;
  if (typeof body.text === 'string') {
    // 文本模式：原样写入，状态以文件内容为准
    out = eula.writeRaw(dir, body.text);
  } else if (typeof body.accepted === 'boolean') {
    out = eula.write(dir, body.accepted);
  } else {
    throw new Error('缺少参数：accepted（布尔）或 text（字符串）');
  }

  // instance.json 里的 eula 字段保持同步，便于概览页与创建流程判断
  inst.eula = out.accepted;
  instances.save(inst);
  if (proc.statusOf(inst.id).status !== 'stopped') {
    proc.push(inst.id, `[HMCS] eula.txt 已更新为 eula=${out.accepted ? 'true' : 'false'}（重启后生效）`);
  }
  sendJson(res, 200, eulaView(dir));
});

register('GET', '/api/instances/:id/config/list', async (req, res, p) => {
  instOf(p.id);
  const dir = dirOf(p.id);
  const eu = eula.read(dir);
  const items = [{ file: eula.EULA_FILE, exists: eu.exists, size: eu.raw.length, kind: 'eula', accepted: eu.accepted }];
  for (const f of CONFIG_FILES) {
    const abs = path.join(dir, f);
    items.push({ file: f, exists: fs.existsSync(abs), size: fs.existsSync(abs) ? fs.statSync(abs).size : 0, kind: f.endsWith('.json') ? 'json' : 'yaml' });
  }
  // 额外把根目录与 config 目录下的 yml/json 也列出来
  for (const sub of ['', 'config']) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isFile() || e.name === 'server.properties') continue;
      if (['instance.json', 'usercache.json'].includes(e.name)) continue;
      if (!/\.(yml|yaml|json)$/i.test(e.name)) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (!items.some(x => x.file === rel)) items.push({ file: rel, exists: true, size: fs.statSync(path.join(d, e.name)).size, kind: /\.json$/i.test(e.name) ? 'json' : 'yaml' });
    }
  }
  sendJson(res, 200, { files: items });
});

register('GET', '/api/instances/:id/config/file', async (req, res, p, q) => {
  instOf(p.id);
  const rel = q.get('file');
  const abs = fsx.safeResolve(dirOf(p.id), rel);
  if (!fs.existsSync(abs)) return sendJson(res, 200, { file: rel, exists: false, raw: '', data: null, kind: rel.endsWith('.json') ? 'json' : 'yaml' });
  const raw = fs.readFileSync(abs, 'utf8');
  let data = null, error = '';
  try { data = rel.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw); } catch (e) { error = e.message; }
  sendJson(res, 200, { file: rel, exists: true, raw, data, error, kind: rel.endsWith('.json') ? 'json' : 'yaml' });
});

register('PUT', '/api/instances/:id/config/file', async (req, res, p) => {
  instOf(p.id);
  const body = await readJson(req);
  const abs = fsx.safeResolve(dirOf(p.id), body.file);
  let out = '';
  if (typeof body.raw === 'string' && body.raw.length) out = body.raw;
  else if (body.data !== undefined) {
    out = body.file.endsWith('.json')
      ? JSON.stringify(body.data, null, 2)
      : yaml.dump(body.data, { lineWidth: 140, noRefs: true, sortKeys: false });
  } else throw new Error('缺少内容');
  if (fs.existsSync(abs)) fs.copyFileSync(abs, abs + '.hmcs.bak');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, out, 'utf8');
  sendJson(res, 200, { ok: true, raw: out });
});

// ---- 世界
register('GET', '/api/worlds', async (req, res, p, q) => {
  sendJson(res, 200, { worlds: worlds.scan(q.get('force') === '1') });
});

register('POST', '/api/instances/:id/world/attach', async (req, res, p) => {
  const inst = instOf(p.id);
  const body = await readJson(req);
  const r = await worlds.attach(inst, body);
  sendJson(res, 200, { ...r, instance: instanceView(instOf(p.id)) });
});

register('POST', '/api/instances/:id/world/detach', async (req, res, p) => {
  const inst = instOf(p.id);
  sendJson(res, 200, { ...worlds.detach(inst), instance: instanceView(instOf(p.id)) });
});

// ---- 插件
register('GET', '/api/plugins/search', async (req, res, p, q) => {
  const id = q.get('instId');
  const inst = id ? instOf(id) : null;
  const out = await modrinth.search(q.get('q') || '', {
    mcVersion: q.get('mc') || (inst && inst.mcVersion),
    type: q.get('type') || (inst && inst.type),
  });
  sendJson(res, 200, out);
});

register('GET', '/api/plugins/versions', async (req, res, p, q) => {
  const id = q.get('instId');
  const inst = id ? instOf(id) : null;
  const list = await modrinth.versions(q.get('id'), {
    mcVersion: q.get('mc') || (inst && inst.mcVersion),
    type: q.get('type') || (inst && inst.type),
  });
  sendJson(res, 200, { versions: list });
});

register('POST', '/api/plugins/install', async (req, res) => {
  const body = await readJson(req);
  const inst = instOf(body.instId);
  const r = await modrinth.install(inst, body.projectId, body.versionId);
  sendJson(res, 200, r);
});

register('GET', '/api/plugins/installed', async (req, res, p, q) => {
  const inst = instOf(q.get('instId'));
  sendJson(res, 200, { items: modrinth.installed(inst), dir: path.basename(modrinth.pluginDirOf(inst)) });
});

// ---- 网络（UPnP 端口转发）
function gatewayView(gw) {
  if (!gw) return null;
  return {
    friendlyName: gw.friendlyName,
    modelName: gw.modelName,
    manufacturer: gw.manufacturer,
    serviceType: gw.serviceType,
    controlUrl: gw.controlUrl,
    iface: gw.ifaceName || '',
    ifaceIp: gw.iface || '',
  };
}

register('GET', '/api/upnp/status', async (req, res, p, q) => {
  const id = q.get('instId');
  const inst = id ? instOf(id) : null;
  const probe = q.get('probe') === '1';
  const force = q.get('force') === '1';

  const out = {
    probed: probe,
    serverPort: inst ? serverPortOf(inst) : null,
    instance: inst ? upnpCfg(inst) : null,
    added: (inst && inst.upnp && inst.upnp.added) || [],
    lastError: (inst && inst.upnp && inst.upnp.lastError) || '',
    lastSync: (inst && inst.upnp && inst.upnp.lastSync) || '',
    gateway: null,
    localIp: await upnp.localIpv4(),
    // 发现网关后会改写成「到网关的出口地址」，端口映射必须用这个
    externalIp: '',
    gatewayError: '',
    hint: '',
    diag: null,
    interfaces: upnp.ipv4Interfaces().map(i => ({ name: i.name, address: i.address, virtual: i.virtual })),
    mappings: [],
  };

  if (!probe) {
    try {
      const d = await upnp.discover({});
      out.gateway = gatewayView(d.gateway);
      out.cached = d.cached;
      out.localIp = await upnp.localIpFor(d.gateway.controlUrl);
    } catch (e) { out.gatewayError = e.message; out.hint = e.hint || ''; }
    out.diag = upnp.diag();
    return sendJson(res, 200, out);
  }

  try {
    const d = await upnp.discover(force ? { force: true } : {});
    out.gateway = gatewayView(d.gateway);
    out.localIp = await upnp.localIpFor(d.gateway.controlUrl);
    const [ip, list] = await Promise.allSettled([
      upnp.getExternalIp(d.gateway),
      upnp.listMappings(d.gateway, 40),
    ]);
    if (ip.status === 'fulfilled') out.externalIp = ip.value;
    else out.externalError = ip.reason.message;
    if (list.status === 'fulfilled') out.mappings = list.value;
    else out.mappingError = list.reason.message;
  } catch (e) {
    out.gatewayError = e.message;
    out.hint = e.hint || '';
  }
  out.diag = upnp.diag();
  sendJson(res, 200, out);
});

register('POST', '/api/upnp/discover', async (req, res) => {
  upnp.clearCache();
  sendJson(res, 200, { ok: true });
});

register('POST', '/api/upnp/map', async (req, res) => {
  const body = await readJson(req);
  const inst = instOf(body.instId);
  const r = await upnpApply(inst, {
    externalPort: body.externalPort,
    protocol: body.protocol,
    lease: body.lease,
    remember: body.remember !== false,
    force: !!body.force,
  });
  sendJson(res, 200, {
    ok: true,
    added: r.added,
    externalIp: r.externalIp,
    gateway: r.gateway,
    serverPort: serverPortOf(inst),
    instance: upnpCfg(instOf(inst.id)),
  });
});

register('POST', '/api/upnp/unmap', async (req, res) => {
  const body = await readJson(req);
  const inst = instOf(body.instId);

  // 指定端口：直接删网关上的这一条（可能是历史遗留、不在本实例记录里）
  if (body.externalPort) {
    const externalPort = Number(body.externalPort);
    if (!(externalPort >= 1 && externalPort <= 65535)) throw new Error('外网端口必须在 1-65535 之间');
    const { gateway } = await upnp.discover({});
    const protos = body.protocol ? protocolList(body.protocol) : ['TCP', 'UDP'];
    const removed = [];
    for (const proto of protos) {
      try {
        await upnp.deleteMapping(gateway, { externalPort, protocol: proto });
        removed.push({ protocol: proto, externalPort });
      } catch (e) {
        if (e.upnpCode !== 714) throw e;
      }
    }
    const added = ((inst.upnp && inst.upnp.added) || [])
      .filter(a => !(a.externalPort === externalPort));
    inst.upnp = { ...(inst.upnp || {}), added, lastSync: new Date().toISOString() };
    instances.save(inst);
    return sendJson(res, 200, { ok: true, removed, added });
  }

  const r = await upnpRemove(inst, {});
  sendJson(res, 200, { ok: true, ...r, added: [] });
});

register('POST', '/api/upnp/auto', async (req, res) => {
  const body = await readJson(req);
  const inst = instOf(body.instId);
  const cfg = upnpCfg(inst);
  const ext = Number(body.externalPort);
  inst.upnp = {
    ...(inst.upnp || {}),
    auto: !!body.auto,
    externalPort: ext >= 1 && ext <= 65535 ? ext : 0,
    protocol: UPNP_PROTOCOLS.includes(body.protocol) ? body.protocol : cfg.protocol,
    lease: Number.isFinite(Number(body.lease)) ? Math.max(0, Number(body.lease)) : cfg.lease,
  };
  instances.save(inst);
  sendJson(res, 200, { ok: true, instance: upnpCfg(inst) });
});

// ---- 源 / Java / 设置
register('GET', '/api/sources/versions', async (req, res, p, q) => {
  const data = await sources.listVersions(q.get('type') || 'paper');
  sendJson(res, 200, data);
});

register('GET', '/api/java', async (req, res, p, q) => {
  sendJson(res, 200, { java: await java.list(q.get('force') === '1') });
});

register('PUT', '/api/settings', async (req, res) => {
  const body = await readJson(req);
  const patch = {};

  if (typeof body.memory === 'string' && body.memory.trim()) patch.memory = body.memory.trim();
  if (typeof body.javaPath === 'string') patch.javaPath = body.javaPath;
  if (typeof body.autoAcceptEula === 'boolean') patch.autoAcceptEula = body.autoAcceptEula;

  // 服务端实例存放目录：必须是绝对路径，且能创建 / 可写
  if (typeof body.serversDir === 'string' && body.serversDir.trim()) {
    const dir = path.resolve(body.serversDir.trim());
    if (!path.isAbsolute(body.serversDir.trim())) throw new Error('实例目录必须填绝对路径（例如 D:\\MinecraftServers 或 /srv/mc）');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (e) {
      throw new Error('实例目录不可用：' + dir + '（' + e.message + '）');
    }
    patch.serversDir = dir;
  }

  const cleanList = v => [...new Set(
    (Array.isArray(v) ? v : String(v || '').split(/\r?\n/))
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .map(x => path.resolve(x)),
  )];
  if (body.clientRoots !== undefined) { patch.clientRoots = cleanList(body.clientRoots); patch.clientRootsDetected = true; }
  if (body.extraWorldDirs !== undefined) patch.extraWorldDirs = cleanList(body.extraWorldDirs);

  sendJson(res, 200, { ok: true, settings: writeSettings(patch) });
});

// ---- 目录浏览（WebUI 目录选择器）
register('GET', '/api/fs/roots', async (req, res) => {
  sendJson(res, 200, fsbrowse.roots());
});

register('GET', '/api/fs/browse', async (req, res, p, q) => {
  sendJson(res, 200, fsbrowse.listDirs(q.get('path') || ''));
});

register('POST', '/api/fs/mkdir', async (req, res) => {
  const body = await readJson(req);
  sendJson(res, 200, fsbrowse.mkdirp(body.path));
});

register('POST', '/api/reveal', async (req, res) => {
  const body = await readJson(req);
  sendJson(res, 200, fsbrowse.reveal(body.path));
});

// ---- 客户端实例探测（只读建议，是否采用由用户决定）
register('GET', '/api/clients', async (req, res, p, q) => {
  const list = fsbrowse.detectClients();
  const used = new Set((readSettings().clientRoots || []).map(x => path.resolve(x).toLowerCase()));
  sendJson(res, 200, { clients: list.map(c => ({ ...c, added: used.has(path.resolve(c.path).toLowerCase()) })) });
});

// ------------------------------------------------------------------ 静态资源
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const abs = path.join(PUBLIC_DIR, rel.replace(/^\/+/, ''));
  if (!abs.startsWith(PUBLIC_DIR) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(abs).pipe(res);
}

// ------------------------------------------------------------------ 启动
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(u.pathname);
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const hit = match(req.method, pathname);
  if (!hit) return sendJson(res, 404, { error: '接口不存在: ' + req.method + ' ' + pathname });
  try {
    await hit.handler(req, res, hit.params, u.searchParams);
  } catch (e) {
    const code = e.status || 500;
    if (!res.headersSent) sendJson(res, code, { error: e.message || String(e) });
    else res.end();
    if (code >= 500) console.error('[error]', pathname, e.message);
  }
});

function listen(port, attempt) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && attempt < 12) {
      console.log(`端口 ${port} 被占用，尝试 ${port + 1}`);
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log('HYCX MC Server Manager (HMCS) 已启动');
    console.log('  ' + url);
    try {
      fs.writeFileSync(path.join(__dirname, 'last-url.txt'), url, 'utf8');
    } catch { /* 程序目录只读（如 /usr/lib、/opt）时不影响启动 */ }
  });
}

const settings = readSettings();
listen(Number(process.env.HMCS_PORT || settings.port || 8720), 0);
