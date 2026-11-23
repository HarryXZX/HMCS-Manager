'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { spawn } = require('child_process');
const yaml = require('js-yaml');

// ------------------------------------------------------------------ 命令行参数
/**
 * 只认少量参数，够服务脚本与排障用：
 *   --port 8720        覆盖监听端口（settings.json 里也有）
 *   --host 0.0.0.0     覆盖监听地址
 *   --home DIR         指定配置 / 数据根目录（等价于 HMCS_HOME，服务脚本用来钉死路径）
 *   --log-file         强制把日志写进 <数据目录>/logs/manager.log
 *   --allow-insecure   监听非回环地址但没设密码时，仍允许启动（不建议）
 *
 * 必须在 require('./lib/paths') 之前解析：--home 决定配置目录，
 * 而 paths 在模块加载时就把目录算好了。
 */
function parseArgs(argv) {
  const out = { port: 0, host: '', home: '', logFile: false, allowInsecure: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : '';
    const val = () => (inline || argv[++i] || '');
    if (key === '--port' || key === '-p') out.port = Number(val());
    else if (key === '--host' || key === '-H') out.host = val();
    else if (key === '--home') out.home = val();
    else if (key === '--log-file') out.logFile = true;
    else if (key === '--allow-insecure') out.allowInsecure = true;
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.home) process.env.HMCS_HOME = path.resolve(ARGS.home);

const paths = require('./lib/paths');
const { PUBLIC_DIR, readSettings, writeSettings, CONFIG_DIR, APP_DIR, SETTINGS_FILE, REGISTRY_FILE, DEFAULT_SERVERS_DIR, normalizeHost, isLoopbackHost } = paths;
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
const auth = require('./lib/auth');
const selfmap = require('./lib/selfmap');
const logger = require('./lib/logger');
const firewall = require('./lib/firewall');
const pkg = require('./package.json');
// 没有控制台时（注册成服务）自动落盘，否则日志会全部丢掉
logger.init({ toFile: ARGS.logFile || !process.stdout.isTTY });


// ------------------------------------------------------------------ 工具
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

/** 运行期状态：真正生效的端口 / 地址（可能与 settings.json 不同，CLI 参数优先） */
const RUNTIME = {
  port: 0,
  host: '127.0.0.1',
  startedAt: Date.now(),
  shuttingDown: false,
};

/**
 * 统一安全响应头。
 * 管理界面不能被别的站点用 iframe 嵌进去（防点击劫持），
 * 响应类型不许嗅探，Referer 不外泄带端口的地址。
 */
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
}


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

// ------------------------------------------------------------------ 访问控制
/**
 * 登录豁免的接口：登录页自己要用的几个，以及给运维脚本探活的 ping。
 * 其余一切 /api/ 都过 authState 判定。
 */
const AUTH_FREE_PATHS = new Set(['/api/auth/state', '/api/auth/login', '/api/auth/logout', '/api/system/ping']);

/** settings.auth 的对外视图（绝不带哈希） */
function publicAuth(a) {
  return {
    enabled: !!(a && a.enabled && a.hash),
    onlyRemote: !a || a.onlyRemote !== false,
    trustProxy: !!(a && a.trustProxy),
    passwordSet: !!(a && a.hash),
    sessionDays: (a && a.sessionDays) || 7,
    updatedAt: (a && a.updatedAt) || '',
    sessions: auth.sessionCount(),
  };
}

/**
 * 判定当前请求是否已通过认证。
 * 三种通行证：本机来源（onlyRemote 时）、有效会话 Cookie、本机控制令牌。
 */
function authState(req) {
  const a = readSettings().auth || {};
  const ip = auth.clientIp(req, a.trustProxy);
  const local = auth.isLoopback(ip);
  const enabled = !!(a.enabled && a.hash);
  const notBefore = a.updatedAt ? Date.parse(a.updatedAt) || 0 : 0;
  const session = enabled ? auth.sessionOf(req, notBefore) : null;
  const control = auth.checkControl(req);
  const exempt = enabled && a.onlyRemote !== false && local;
  return {
    enabled, local, ip, session, control, exempt,
    onlyRemote: a.onlyRemote !== false,
    trustProxy: !!a.trustProxy,
    passwordSet: !!a.hash,
    authed: !enabled || exempt || !!session || control,
    requiresLogin: enabled && !exempt && !session && !control,
  };
}

/**
 * 防跨站请求伪造：SameSite=Lax 已挡住绝大多数场景，
 * 这里再校验一次 Origin，非浏览器客户端（无 Origin）放行。
 */
function originOk(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    return !host || o.host === host;
  } catch { return false; }
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
  const st = authState(req);
  sendJson(res, 200, {
    version: pkg.version,
    settings,
    auth: {
      ...publicAuth(settings.auth),
      authed: st.authed,
      requiresLogin: st.requiresLogin,
      local: st.local,
      ip: st.ip,
    },
    net: {
      bind: { host: RUNTIME.host, port: RUNTIME.port, localOnly: isLoopbackHost(RUNTIME.host) },
      urls: [
        `http://127.0.0.1:${RUNTIME.port}`,
        ...(isLoopbackHost(RUNTIME.host) ? [] : selfmap.lanAddresses(RUNTIME.port).map(a => a.url)),
      ],
      selfUpnp: selfmap.status({ port: RUNTIME.port }),
      // 轻量：只读状态文件，不在这里跑 netsh / ufw 探测
      firewall: {
        rule: firewall.RULE_NAME,
        port: firewall.statePort(),
        needed: !isLoopbackHost(RUNTIME.host),
      },
      logFile: logger.LOG_FILE,
    },
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

// ---- 访问控制 / 远程访问
register('GET', '/api/auth/state', async (req, res) => {
  const st = authState(req);
  const s = readSettings();
  sendJson(res, 200, {
    ...publicAuth(s.auth),
    authed: st.authed,
    requiresLogin: st.requiresLogin,
    local: st.local,
    ip: st.ip,
    viaControlToken: st.control,
    bind: { host: RUNTIME.host, port: RUNTIME.port, localOnly: isLoopbackHost(RUNTIME.host) },
  });
});

register('POST', '/api/auth/login', async (req, res) => {
  const a = readSettings().auth || {};
  if (!a.enabled || !a.hash) return sendJson(res, 200, { ok: true, disabled: true, authed: true });

  const ip = auth.clientIp(req, a.trustProxy);
  const locked = auth.lockRemaining(ip);
  if (locked) {
    res.setHeader('Retry-After', String(locked));
    return sendJson(res, 429, { error: `尝试过于频繁，请 ${locked} 秒后再试`, retryAfter: locked });
  }

  const body = await readJson(req);
  const pw = String(body.password == null ? '' : body.password);
  if (!pw) { const e = new Error('请输入密码'); e.status = 400; throw e; }

  if (!auth.verifyPassword(pw, a.hash)) {
    const sec = auth.noteFail(ip);
    if (sec) {
      res.setHeader('Retry-After', String(sec));
      console.warn(`[HMCS] 登录失败触发锁定：${ip}（${sec} 秒）`);
      return sendJson(res, 429, { error: `密码错误次数过多，请 ${sec} 秒后再试`, retryAfter: sec });
    }
    const left = auth.attemptsLeft(ip);
    return sendJson(res, 401, { error: '密码错误', attemptsLeft: left });
  }

  auth.noteOk(ip);
  const { token, exp } = auth.createSession(req, a.sessionDays);
  res.setHeader('Set-Cookie', auth.cookieHeader(token, (exp - Date.now()) / 1000, auth.isHttps(req, a.trustProxy)));
  console.log(`[HMCS] 登录成功：${ip}`);
  sendJson(res, 200, { ok: true, authed: true, expiresAt: new Date(exp).toISOString() });
});

register('POST', '/api/auth/logout', async (req, res) => {
  const a = readSettings().auth || {};
  auth.destroySession(req);
  res.setHeader('Set-Cookie', auth.clearCookieHeader(auth.isHttps(req, a.trustProxy)));
  sendJson(res, 200, { ok: true });
});

// 设置 / 修改密码
register('PUT', '/api/auth/password', async (req, res) => {
  const a = readSettings().auth || {};
  const body = await readJson(req);
  const next = String(body.password == null ? '' : body.password);
  const cur = String(body.current == null ? '' : body.current);
  const ip = auth.clientIp(req, a.trustProxy);

  // 已有密码时先验旧密码：会话被劫持也不能直接改掉密码把人锁在门外
  if (a.hash) {
    const locked = auth.lockRemaining(ip);
    if (locked) {
      res.setHeader('Retry-After', String(locked));
      const e = new Error(`尝试过于频繁，请 ${locked} 秒后再试`); e.status = 429; throw e;
    }
    if (!cur) { const e = new Error('请输入当前密码'); e.status = 400; throw e; }
    if (!auth.verifyPassword(cur, a.hash)) {
      auth.noteFail(ip);
      const e = new Error('当前密码不正确'); e.status = 401; throw e;
    }
    auth.noteOk(ip);
  }

  const pol = auth.checkPasswordPolicy(next);
  if (!pol.ok) { const e = new Error(pol.reason); e.status = 400; throw e; }

  const updatedAt = new Date().toISOString();
  writeSettings({ auth: { ...a, enabled: true, hash: auth.hashPassword(next), updatedAt } });

  // 旧会话全部作废，再给当前浏览器发一张新的，免得刚改完就被自己踢出去
  auth.destroyAllSessions(null);
  const { token, exp } = auth.createSession(req, a.sessionDays || 7);
  res.setHeader('Set-Cookie', auth.cookieHeader(token, (exp - Date.now()) / 1000, auth.isHttps(req, a.trustProxy)));
  console.log(`[HMCS] 访问密码已更新（${ip}），旧会话已全部失效`);
  sendJson(res, 200, { ok: true, auth: publicAuth(readSettings().auth), expiresAt: new Date(exp).toISOString() });
});

/**
 * 本机运维通道：改密码 / 开关校验 / 改免密范围，**不需要旧密码**。
 *
 * 给 `hmcsm` 的菜单用。面板可能根本没登录，甚至密码已经忘了 —— 但本机进程能读到
 * <配置目录>/control.token（0600，只有本机同一用户可读），那本来就等价于
 * 「能改这台机器的配置」，再要一遍旧密码只是仪式感。
 *
 * 双保险：只接受回环来源 + 常量时间比对 token。改完立即作废所有会话，
 * 且不需要重启进程（readSettings 每次都读文件，新哈希下一次校验就生效）。
 */
register('POST', '/api/auth/local', async (req, res) => {
  const cur = readSettings().auth || {};
  const ip = auth.clientIp(req, cur.trustProxy);
  if (!auth.isLoopback(ip)) { const e = new Error('这个接口只允许在本机调用'); e.status = 403; throw e; }
  if (!auth.checkControl(req)) { const e = new Error('控制令牌无效（control.token 不匹配）'); e.status = 403; throw e; }

  const body = await readJson(req);
  const a = { ...(readSettings().auth || {}) };
  const actions = [];

  if (body.clear === true) {
    if (!isLoopbackHost(readSettings().host)) {
      const e = new Error('监听地址不是「仅本机」，清掉密码后程序会拒绝重启。先把它改成 127.0.0.1 再来');
      e.status = 400; throw e;
    }
    a.hash = '';
    a.enabled = false;
    actions.push('已关闭密码访问');
  } else if (body.password !== undefined) {
    const pw = String(body.password == null ? '' : body.password);
    const pol = auth.checkPasswordPolicy(pw);
    if (!pol.ok) { const e = new Error(pol.reason); e.status = 400; throw e; }
    a.hash = auth.hashPassword(pw);
    a.enabled = true;
    actions.push('访问密码已更新');
  }

  if (typeof body.enabled === 'boolean') {
    if (body.enabled && !a.hash) { const e = new Error('还没有设置密码，无法启用校验'); e.status = 400; throw e; }
    a.enabled = body.enabled;
    actions.push(body.enabled ? '密码校验已开启' : '密码校验已关闭（保留密码）');
  }
  if (typeof body.onlyRemote === 'boolean') {
    a.onlyRemote = body.onlyRemote;
    actions.push(body.onlyRemote ? '本机免密已开启（仅远程需要密码）' : '所有访问都需要密码');
  }

  if (!actions.length) { const e = new Error('没有要修改的项'); e.status = 400; throw e; }

  a.updatedAt = new Date().toISOString();
  writeSettings({ auth: a });
  if (body.password !== undefined || body.clear === true || body.enabled === false) {
    // 密码变了 / 校验关了 → 旧会话必须立刻作废，否则等于没改
    auth.destroyAllSessions(null);
  }
  console.log(`[HMCS] 本机命令修改了访问控制（${ip}）：${actions.join('，')}`);
  sendJson(res, 200, { ok: true, changes: actions, auth: publicAuth(readSettings().auth) });
});

// 开关与范围
register('PUT', '/api/auth/options', async (req, res) => {
  const a = readSettings().auth || {};
  const body = await readJson(req);
  const next = { ...a };

  if (typeof body.enabled === 'boolean') {
    if (body.enabled && !a.hash) { const e = new Error('请先设置访问密码'); e.status = 400; throw e; }
    if (!body.enabled && a.hash) {
      // 关闭防护属于降级操作，必须验密码
      const cur = String(body.current == null ? '' : body.current);
      if (!cur) { const e = new Error('关闭密码访问需要输入当前密码'); e.status = 400; throw e; }
      if (!auth.verifyPassword(cur, a.hash)) { const e = new Error('当前密码不正确'); e.status = 401; throw e; }
      auth.destroyAllSessions(null);
    }
    next.enabled = body.enabled;
  }
  if (typeof body.onlyRemote === 'boolean') next.onlyRemote = body.onlyRemote;
  if (typeof body.trustProxy === 'boolean') next.trustProxy = body.trustProxy;
  if (body.sessionDays !== undefined) {
    const d = Number(body.sessionDays);
    if (!(d >= 1 && d <= 90)) { const e = new Error('保持登录天数需在 1-90 之间'); e.status = 400; throw e; }
    next.sessionDays = d;
  }

  writeSettings({ auth: next });
  sendJson(res, 200, { ok: true, auth: publicAuth(readSettings().auth) });
});

// ---- 管理器自身端口（远程访问）
register('GET', '/api/net/self', async (req, res, p, q) => {
  const st = selfmap.status({ port: RUNTIME.port });
  const out = {
    ...st,
    bind: { host: RUNTIME.host, port: RUNTIME.port, localOnly: isLoopbackHost(RUNTIME.host) },
    externalUrl: '',
    gateway: null,
    gatewayError: '',
  };

  if (q.get('probe') === '1') {
    try {
      const d = await upnp.discover({});
      out.gateway = { friendlyName: d.gateway.friendlyName, modelName: d.gateway.modelName };
      try { out.externalIp = await upnp.getExternalIp(d.gateway); } catch { /* 网关不支持 */ }
      const ext = st.added.find(x => x.protocol === 'TCP') || st.added[0];
      if (out.externalIp && ext) out.externalUrl = `http://${out.externalIp}:${ext.externalPort}`;
    } catch (e) {
      out.gatewayError = e.message;
    }
  }
  out.ready = !!(st.added && st.added.length);
  out.hint = out.bind.localOnly
    ? '当前只监听本机 127.0.0.1，端口映射建好也访问不到。先把「监听地址」改成外部可访问。'
    : '';
  sendJson(res, 200, out);
});

// 保存开关（auto / 外网端口 / 协议 / 租期）
register('PUT', '/api/net/self', async (req, res) => {
  const body = await readJson(req);
  const cur = selfmap.cfg();
  const ext = Number(body.externalPort);
  const next = {
    ...cur,
    ...(typeof body.auto === 'boolean' ? { auto: body.auto } : {}),
    ...(body.externalPort !== undefined ? { externalPort: ext >= 1 && ext <= 65535 ? ext : 0 } : {}),
    ...(body.protocol !== undefined ? { protocol: ['TCP', 'UDP'].includes(body.protocol) ? body.protocol : cur.protocol } : {}),
    ...(body.lease !== undefined && Number.isFinite(Number(body.lease)) ? { lease: Math.max(0, Number(body.lease)) } : {}),
  };
  if (next.auto && isLoopbackHost(RUNTIME.host)) {
    const e = new Error('当前只监听 127.0.0.1，端口映射没有意义。请先把监听地址改为「允许外部访问」'); e.status = 400; throw e;
  }
  writeSettings({ selfUpnp: next });
  sendJson(res, 200, { ok: true, self: selfmap.status({ port: RUNTIME.port }) });
});

register('POST', '/api/net/selfmap', async (req, res) => {
  const body = await readJson(req);
  if (isLoopbackHost(RUNTIME.host)) {
    const e = new Error('当前只监听 127.0.0.1，先改监听地址再映射'); e.status = 400; throw e;
  }
  try {
    const r = await selfmap.apply({
      port: RUNTIME.port,
      externalPort: body.externalPort,
      protocol: body.protocol,
      lease: body.lease,
      force: !!body.force,
      remember: body.remember !== false,
    });
    const st = selfmap.status({ port: RUNTIME.port });
    sendJson(res, 200, {
      ok: true, ...r,
      externalUrl: r.externalIp ? `http://${r.externalIp}:${(r.added[0] || {}).externalPort}` : '',
      self: st,
    });
  } catch (e) {
    selfmap.noteError(e.message);
    throw e;
  }
});

register('POST', '/api/net/unmap', async (req, res) => {
  const r = await selfmap.remove({});
  sendJson(res, 200, { ok: true, ...r, self: selfmap.status({ port: RUNTIME.port }) });
});

// ---- 系统（服务脚本 / 排障）
register('GET', '/api/system/ping', async (req, res) => {
  // 换了端口以后，还停在旧地址的页面要能探到新进程是不是起来了，
  // 这就得允许跨源读这个端点。它是免鉴权的探活接口，只给非敏感字段：
  // 跨源请求不返回 pid / 版本，避免随便哪个网页都能指纹识别本机面板。
  const origin = req.headers.origin || '';
  const sameOrigin = !origin || origin.replace(/^https?:\/\//i, '').toLowerCase() === String(req.headers.host || '').toLowerCase();
  const body = { ok: true, app: 'HMCS', port: RUNTIME.port };
  if (sameOrigin) {
    body.version = pkg.version;
    body.pid = process.pid;
  } else {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  sendJson(res, 200, body);
});

register('GET', '/api/system/info', async (req, res) => {
  const s = readSettings();
  sendJson(res, 200, {
    app: pkg.version,
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    startedAt: new Date(RUNTIME.startedAt).toISOString(),
    uptimeSec: Math.round((Date.now() - RUNTIME.startedAt) / 1000),
    bind: { host: RUNTIME.host, port: RUNTIME.port, localOnly: isLoopbackHost(RUNTIME.host) },
    urls: [
      `http://127.0.0.1:${RUNTIME.port}`,
      ...(isLoopbackHost(RUNTIME.host) ? [] : selfmap.lanAddresses(RUNTIME.port).map(a => a.url)),
    ],
    configDir: CONFIG_DIR,
    dataDir: paths.DATA_DIR,
    settingsFile: SETTINGS_FILE,
    logFile: logger.LOG_FILE,
    home: os.homedir(),
    auth: publicAuth(s.auth),
    running: proc.runningIds(),
  });
});

register('GET', '/api/system/log', async (req, res, p, q) => {
  const n = Math.min(2000, Math.max(20, Number(q.get('lines') || 200)));
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(logger.tail(n) || '(暂无日志文件内容。控制台模式下日志只输出到终端)');
});

/**
 * 本机运维：同步 / 收回防火墙规则。
 *
 * 菜单是「遥控器」，改完监听配置后优先让正在运行的服务进程（多半有 SYSTEM / root）
 * 去写防火墙，省得为每个小操作都弹一次 UAC。同样只认回环来源 + control token。
 */
register('POST', '/api/system/firewall', async (req, res) => {
  const s = readSettings();
  const ip = auth.clientIp(req, s.auth && s.auth.trustProxy);
  if (!auth.isLoopback(ip)) { const e = new Error('这个接口只允许在本机调用'); e.status = 403; throw e; }
  if (!auth.checkControl(req)) { const e = new Error('控制令牌无效（control.token 不匹配）'); e.status = 403; throw e; }

  const body = await readJson(req);
  const host = body.host !== undefined ? normalizeHost(body.host) : normalizeHost(s.host);
  const port = body.port !== undefined ? Number(body.port) : (Number(s.port) || RUNTIME.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const e = new Error('端口必须在 1-65535 之间'); e.status = 400; throw e;
  }
  const onLog = msg => console.log(msg);
  const result = body.remove === true
    ? firewall.removeAll({ onLog })
    : firewall.sync({ host, port, force: body.force === true, onLog });
  sendJson(res, 200, result);
});

register('POST', '/api/system/shutdown', async (req, res) => {
  sendJson(res, 200, { ok: true, stopping: proc.runningIds().length });
  setTimeout(() => { gracefulShutdown('API 请求'); }, 120);
});

/**
 * 一键重启：改完监听地址 / 端口后直接生效，不用回命令行。
 * 返回时先给客户端一个明确的响应，再延后 150ms 才真的动手，
 * 否则连接会在响应写完之前被 closeAllConnections 掐断，前端只能看到网络错误。
 */
register('POST', '/api/system/restart', async (req, res) => {
  const stopping = proc.runningIds().length;
  sendJson(res, 200, {
    ok: true,
    restarting: true,
    stopping,
    host: normalizeHost(readSettings().host),
    port: Number(readSettings().port) || RUNTIME.port,
  });
  setTimeout(() => { restartSelf('API 请求（重启）'); }, 150);
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
  if (typeof body.logToFile === 'boolean') patch.logToFile = body.logToFile;

  // 监听地址与端口：都属于「下次启动生效」，这里只做校验与落盘
  if (body.host !== undefined) {
    const h = normalizeHost(body.host);
    if (!/^[0-9a-fA-F:.]+$/.test(h)) { const e = new Error('监听地址格式不正确'); e.status = 400; throw e; }
    if (!isLoopbackHost(h)) {
      const a = readSettings().auth || {};
      if (!a.enabled || !a.hash) {
        const e = new Error('对外开放前请先设置访问密码（安全设置 → 访问密码），否则管理面板等于裸奔');
        e.status = 400; throw e;
      }
    }
    patch.host = h;
  }
  if (body.port !== undefined) {
    const p = Number(body.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) { const e = new Error('端口必须在 1-65535 之间'); e.status = 400; throw e; }
    patch.port = p;
  }

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

  const prev = readSettings();
  const next = writeSettings(patch);
  const restartRequired = next.port !== RUNTIME.port || normalizeHost(next.host) !== RUNTIME.host;

  // 开关公网访问 / 改端口时，一并写防火墙。按「目标配置」同步：
  // 规则提前放好没坏处，等重启后就正好对上；点「撤销改动」时又会收回。
  // 只有监听配置真的变了才跑，改内存 / 目录之类的保存不受影响。
  const netChanged = (patch.host !== undefined && patch.host !== prev.host) ||
    (patch.port !== undefined && patch.port !== prev.port);
  let firewallResult = null;
  if (netChanged) {
    try {
      firewallResult = firewall.sync({
        host: next.host, port: Number(next.port) || RUNTIME.port,
        onLog: s => console.log(s),
      });
    } catch (e) {
      firewallResult = { ok: false, needsPrivilege: true, manual: [], warning: '防火墙同步异常：' + e.message };
    }
  }
  sendJson(res, 200, { ok: true, settings: next, restartRequired, firewall: firewallResult });
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
const STATIC_ALLOW = new Set(['.html', '.css', '.js', '.svg', '.png', '.ico', '.woff2', '.map']);

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : (pathname === '/login' ? '/login.html' : pathname);
  const abs = path.join(PUBLIC_DIR, rel.replace(/^\/+/, ''));
  const ext = path.extname(abs).toLowerCase();
  if (!abs.startsWith(PUBLIC_DIR) || !STATIC_ALLOW.has(ext) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // 前端页面与脚本每次都要拿新的，避免改完刷新还是老界面
    'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
  });
  fs.createReadStream(abs).pipe(res);
}

// ------------------------------------------------------------------ 启动
const server = http.createServer(async (req, res) => {
  securityHeaders(res);

  let u;
  try { u = new URL(req.url, 'http://127.0.0.1'); }
  catch { return sendJson(res, 400, { error: '非法请求' }); }

  let pathname;
  try { pathname = decodeURIComponent(u.pathname); }
  catch { return sendJson(res, 400, { error: '非法路径' }); }

  if (!originOk(req)) return sendJson(res, 403, { error: '跨站请求被拒绝' });

  const st = authState(req);

  if (!pathname.startsWith('/api/')) {
    // 页面本身不含敏感数据，但未登录时不该让用户对着空面板干等，直接送登录页
    if (pathname === '/' || pathname === '/index.html' || pathname === '/login') {
      const target = pathname === '/login' ? '/' : u.pathname + u.search;
      if (st.requiresLogin && pathname !== '/login') {
        res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(target) });
        return res.end();
      }
      if (!st.requiresLogin && pathname === '/login') {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
    }
    return serveStatic(req, res, pathname);
  }

  if (st.requiresLogin && !AUTH_FREE_PATHS.has(pathname)) {
    return sendJson(res, 401, { error: '需要登录后才能访问', authRequired: true, auth: publicAuth(readSettings().auth) });
  }

  if (RUNTIME.shuttingDown && pathname !== '/api/system/ping') {
    return sendJson(res, 503, { error: 'HMCS 正在关闭中' });
  }

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

// 长连接（SSE 控制台）在关闭时不该拖住进程
server.keepAliveTimeout = 70000;
server.headersTimeout = 75000;

/** 优雅关闭：先让 Minecraft 服务端执行 stop，再收自身端口 */
async function gracefulShutdown(reason, code = 0) {
  if (RUNTIME.shuttingDown) return;
  RUNTIME.shuttingDown = true;
  const ids = proc.runningIds();
  console.log(`[HMCS] 收到停止请求（${reason}）${ids.length ? `，正在安全关闭 ${ids.length} 个服务端…` : ''}`);

  if (ids.length) {
    await Promise.all(ids.map(id => proc.stopAndWait(id, 60000).catch(() => false)));
  }
  try { await selfmap.remove({ quiet: true }); } catch { /* 网关不可达就算了 */ }

  try { server.close(); } catch { /* ignore */ }
  if (server.closeAllConnections) server.closeAllConnections();
  setTimeout(() => process.exit(code), 400).unref();
  // 兜底：4 秒内没退干净就硬退，避免服务管理器等到超时
  setTimeout(() => process.exit(code), 4000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

/** 端口被占用时给出可直接照做的排查提示 */
function portBusyHint(port) {
  console.error(`端口 ${port} 已被其他程序占用。HMCS 使用固定端口，不会自动换端口。`);
  if (process.platform === 'win32') {
    console.error(`  查占用进程：netstat -ano | findstr :${port}   然后 taskkill /PID <PID> /F`);
  } else {
    console.error(`  查占用进程：lsof -i :${port}   或   ss -lptn 'sport = :${port}'`);
  }
  console.error('  或者换个端口启动：node app.js --port 8721（同时要改 settings.json 或服务配置）');
}

function start() {
  const s = readSettings();
  const port = Number(ARGS.port || process.env.HMCS_PORT || s.port || 8720);
  const host = normalizeHost(ARGS.host || process.env.HMCS_HOST || s.host);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`端口 ${port} 不合法，必须是 1-65535 的整数`);
    process.exit(2);
  }
  if (ARGS.port || ARGS.host) {
    console.log(`[HMCS] 命令行覆盖监听参数：${host}:${port}`);
  }

  // 监听非回环地址而没设密码，等于把管理面板（含文件管理、控制台）公开到网络上
  if (!isLoopbackHost(host)) {
    const a = s.auth || {};
    if (!a.enabled || !a.hash) {
      if (!ARGS.allowInsecure) {
        console.error('');
        console.error('拒绝启动：监听地址是 ' + host + '，但还没有设置访问密码。');
        console.error('管理面板能执行任意服务器指令、读写实例文件，公网暴露必须带认证。');
        console.error('');
        console.error('  做法一：先用 127.0.0.1 启动，在「设置 → 安全与远程访问」里设好密码，再改监听地址；');
        console.error('  做法二：确实不需要密码（例如只在受控内网），加 --allow-insecure 启动。');
        console.error('');
        process.exit(2);
      }
      console.warn('[HMCS] 警告：未设置密码且对外监听（--allow-insecure），任何能访问该端口的人都能控制本机服务端');
    }
  }

  RUNTIME.port = port;
  RUNTIME.host = host;

  // 命令行给的监听参数本来就优先级最高，顺手同步进 settings.json。
  // 不同步的话，界面上「目标值」会是一份陈旧配置：明明在跑 9000，界面显示 8720 待生效，
  // 点一下重启反而跳回 8720 —— 说不清到底听谁的。同步之后
  // 「界面显示的目标值 == 重启后的实际值」这个前提永远成立。
  if (ARGS.port || ARGS.host) {
    try {
      const patch = {};
      if (ARGS.port) patch.port = port;
      if (ARGS.host) patch.host = host;
      writeSettings(patch);
      console.log(`[HMCS] 命令行监听参数已同步到 settings.json（${host}:${port}）`);
    } catch (e) {
      console.warn('[HMCS] 命令行监听参数无法写入 settings.json：' + e.message);
    }
  }

  // 提前把控制令牌写好：服务脚本要在任何请求之前就能拿到它来做优雅停止
  try { auth.controlToken(); } catch { /* 只读目录时退化为仅进程内有效 */ }

  // 「一键重启」时新进程会被立刻拉起，此时老进程可能还没释放端口。
  // 只有带这个环境变量（即新进程由 restartSelf 拉起）才重试等端口，正常启动仍然是立刻报错。
  const HANDOFF = process.env.HMCS_RESTART_HANDOFF === '1';
  let listenTries = 0;
  let up = false;

  const onListening = () => {
    // 交接期间下面会反复 listen 重试。Node 的 listen(port, host, cb) 是把 cb 挂到 'listening' 上，
    // 每重试一次就多挂一个；端口一被释放，所有回调同时触发 —— 日志被刷十几遍、
    // selfmap 会把同一条 UPnP 规则建十几遍。这里必须幂等。
    if (up) return;
    up = true;
    const localOnly = isLoopbackHost(host);
    console.log('');
    console.log('HYCX MC Server Manager (HMCS) v' + pkg.version + ' 已启动');
    console.log('  本机访问  http://127.0.0.1:' + port);
    if (!localOnly) {
      for (const a of selfmap.lanAddresses(port)) console.log('  局域网    ' + a.url + '  (' + a.iface + ')');
      const au = readSettings().auth;
      console.log('  外部访问  需要密码（' + (au.onlyRemote ? '远程必填，本机免密' : '所有访问都需登录') + '）');
    } else {
      console.log('  监听地址  ' + host + '（仅本机；要让局域网/外网访问请改设置里的监听地址）');
    }
    console.log('  配置目录  ' + CONFIG_DIR);
    console.log('  日志文件  ' + (logger.LOG_FILE || '(未启用)'));
    console.log('');

    const url = `http://127.0.0.1:${port}`;
    try {
      fs.writeFileSync(path.join(CONFIG_DIR, 'last-url.txt'), url, 'utf8');
    } catch { /* 配置目录只读时不影响启动 */ }

    // 公网访问必须连带放行防火墙。服务进程常跑在 SYSTEM / root 下，
    // 这里按「实际监听值」做一次幂等同步，覆盖服务 / 后台 / 手动等所有启动路径；
    // 权限不够也只记日志，不拦着面板启动。
    setImmediate(() => {
      try {
        firewall.sync({ host, port, onLog: s => console.log(s) });
      } catch (e) {
        console.warn('[HMCS] 防火墙同步异常：' + e.message);
      }
    });

    const selfUpnp = readSettings().selfUpnp || {};
    if (selfUpnp.auto && !localOnly) {
      selfmap.apply({ port }).then(r => {
        const ext = (r.added[0] || {}).externalPort;
        console.log(`[HMCS] 已把 WebUI 端口映射到网关：${r.added.map(a => a.protocol + ' ' + a.externalPort + ' → ' + a.internalClient + ':' + a.internalPort).join('，')}`);
        if (r.externalIp) console.log(`[HMCS] 外部访问地址  http://${r.externalIp}:${ext}`);
      }).catch(e => {
        console.error('[HMCS] 自动端口映射失败：' + e.message);
        selfmap.noteError(e.message);
      });
    }
  };

  const onListenError = err => {
    if (err.code === 'EADDRINUSE' && HANDOFF && listenTries < 240) {
      listenTries++;
      if (listenTries === 1) console.log(`[HMCS] 等待上一个进程释放端口 ${port}…`);
      setTimeout(() => {
        server.once('error', onListenError);
        // 不再传 onListening：第一次 listen 时已经挂上了，重复挂会叠出多个回调
        try { server.listen(port, host); } catch { /* 下一轮再试 */ }
      }, 250);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      portBusyHint(port);
      process.exit(1);
    }
    if (err.code === 'EACCES') {
      console.error(`没有权限监听端口 ${port}（1024 以下的端口需要 root / 管理员）`);
      process.exit(2);
    }
    console.error('启动失败:', err.message);
    process.exit(1);
  };

  server.once('error', onListenError);
  server.listen(port, host, onListening);
}

/**
 * 重启自己（改完监听地址 / 端口后不用去命令行手动起）
 *
 * 两种托管方式分开处理：
 *  - systemd（有 INVOCATION_ID）：直接退出，靠 unit 里的 Restart=always 拉起。
 *    自己 spawn 的副本会被 systemd 的 KillMode 一起收走，反而起不来。
 *  - 其它情况（手动运行 / Windows 计划任务 / launchd）：现场拉起一个自己的副本，
 *    参数原样继承（--home / --log-file 必须带上，否则数据目录会跑偏），再从容退出。
 */
/**
 * 给「新进程」准备的参数：原样继承，但必须摘掉监听参数。
 *
 * 为什么不能照抄 process.argv：命令行参数的优先级高于 settings.json，
 * 而重启的唯一目的就是让刚保存的 host/port 生效。
 * 若原进程是用 `--port 8720`（或 HMCS_PORT 环境变量）起的，
 * 照抄过去新进程还是监听 8720，界面上的「重启后生效」黄条就永远消不掉。
 * 同理，`--home` / `--log-file` / `--allow-insecure` 必须保留，否则数据目录会跑偏。
 */
function relaunchArgs() {
  const raw = process.argv.slice(1);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (key === '--port' || key === '-p' || key === '--host' || key === '-H') {
      if (!a.includes('=')) i++; // 顺带吃掉它的值
      continue;
    }
    out.push(a);
  }
  return out;
}

/** 新进程的环境：同样要摘掉会压低 settings 的监听变量 */
function relaunchEnv() {
  const env = { ...process.env, HMCS_RESTART_HANDOFF: '1' };
  delete env.HMCS_PORT;
  delete env.HMCS_HOST;
  return env;
}

function restartSelf(reason) {
  if (process.env.INVOCATION_ID) {
    // systemd 的 ExecStart 不带监听参数（写完设置就靠 settings.json），
    // 靠 unit 里的 Restart=always 拉起新进程即可。
    console.log('[HMCS] 重启：由 systemd 拉起新进程');
    gracefulShutdown(reason, 0);
    return { mode: 'systemd' };
  }

  const args = relaunchArgs();
  if (ARGS.port || ARGS.host || process.env.HMCS_PORT || process.env.HMCS_HOST) {
    console.log('[HMCS] 重启：丢弃命令行 / 环境变量里的监听参数，改以 settings.json 为准');
  }

  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      // 新进程的 stdout 不是 TTY，logger 会自动落盘到 <数据目录>/logs/manager.log
      stdio: 'ignore',
      windowsHide: true,
      env: relaunchEnv(),
    });
  } catch (e) {
    console.error('[HMCS] 拉起新进程失败：' + e.message);
    return { mode: 'failed', error: e.message };
  }

  const pid = child.pid || 0;
  console.log('[HMCS] 已拉起新进程 pid=' + pid + '，端口释放后自动接管');

  // 关键：不能拉起新进程就撒手不管。
  // 新进程要是启动即崩（配置错误、Node 被删、端口被别的程序抢了），
  // 老进程又已经退出，面板就彻底没了。这里等它 1.8 秒：
  //   - 还活着（哪怕正在等端口）→ 自己退出，把端口让出去
  //   - 已经挂了 → 什么都不做，继续用旧配置服务，错误在日志里
  let dead = false;
  const markDead = why => {
    if (dead) return;
    dead = true;
    console.error('[HMCS] 重启中止：新进程没有活下来（' + why + '），继续用当前进程提供服务');
  };
  child.once('exit', (code, signal) => markDead(signal ? '信号 ' + signal : '退出码 ' + code));
  child.once('error', e => markDead(e.message));
  child.unref();

  setTimeout(() => {
    if (dead) return;
    gracefulShutdown(reason, 0);
  }, 1800).unref();
  return { mode: 'spawn', pid };
}

start();

