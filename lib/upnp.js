'use strict';

/**
 * 零依赖 UPnP IGD（Internet Gateway Device）客户端
 *
 * 流程：
 *  1. SSDP M-SEARCH（239.255.255.250:1900）发现网关
 *  2. 拉取 LOCATION 指向的 device description XML
 *  3. 在 XML 里找 WANIPConnection / WANPPPConnection 服务及其 controlURL
 *  4. 用 SOAP 调 AddPortMapping / DeletePortMapping / GetExternalIPAddress / GetGenericPortMappingEntry
 *
 * 只做端口映射需要的部分，不依赖任何第三方库。
 */

const dgram = require('dgram');
const http = require('http');
const https = require('https');
const os = require('os');
const { URL } = require('url');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const USER_AGENT = 'HMCS/1.0 UPnP/1.1';

const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
  'upnp:rootdevice',
];

// 虚拟网卡：Radmin / VMware / VirtualBox / Hyper-V / WSL / Docker / VPN 等。
// 它们会抢走 Windows 的默认组播出口，导致 M-SEARCH 根本没发到真实路由器上。
const VIRTUAL_IFACE = /radmin|vmware|virtualbox|vbox|hyper-?v|vethernet|wsl|docker|br-|tap-|tun\d|vpn|zerotier|tailscale|wireguard|npcap|loopback|bluetooth|蓝牙|虚拟|teredo|isatap|6to4/i;

// ---------------------------------------------------------------- XML
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const stripNs = name => String(name).replace(/^[^:]+:/, '').toLowerCase();

function findTagEnd(s, start) {
  let quote = '';
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

/** 极简 XML 解析：够解析 UPnP description / SOAP 响应即可 */
function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const s = String(xml || '');
  let i = 0;

  const appendText = t => {
    if (!t) return;
    const node = stack[stack.length - 1];
    node.text += decodeEntities(t);
  };

  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { appendText(s.slice(i)); break; }
    if (lt > i) appendText(s.slice(i, lt));

    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt);
      i = e < 0 ? s.length : e + 3; continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt);
      appendText(s.slice(lt + 9, e < 0 ? s.length : e));
      i = e < 0 ? s.length : e + 3; continue;
    }
    if (s.startsWith('<?', lt)) {
      const e = s.indexOf('?>', lt);
      i = e < 0 ? s.length : e + 2; continue;
    }
    if (s.startsWith('<!', lt)) {
      const e = s.indexOf('>', lt);
      i = e < 0 ? s.length : e + 1; continue;
    }

    const gt = findTagEnd(s, lt);
    if (gt < 0) { appendText(s.slice(lt)); break; }
    const raw = s.slice(lt + 1, gt);
    i = gt + 1;

    if (raw.startsWith('/')) {
      const name = stripNs(raw.slice(1).trim());
      for (let k = stack.length - 1; k > 0; k--) {
        if (stripNs(stack[k].name) === name) { stack.length = k; break; }
      }
      continue;
    }

    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const sp = body.search(/\s/);
    const name = (sp < 0 ? body : body.slice(0, sp)).trim();
    const attrs = {};
    const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(sp < 0 ? '' : body.slice(sp)))) {
      attrs[m[1]] = decodeEntities(m[3] != null ? m[3] : m[4]);
    }
    const node = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

const localName = name => String(name).replace(/^[^:]+:/, '');

function childNodes(node, name) {
  if (!node) return [];
  return node.children.filter(c => stripNs(c.name) === String(name).toLowerCase());
}
function firstNode(node, name) { return childNodes(node, name)[0] || null; }
function textOf(node, name) {
  const c = firstNode(node, name);
  return c ? c.text.trim() : '';
}
function findAll(node, name, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (stripNs(c.name) === String(name).toLowerCase()) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
/** 深度优先取第一个同名节点的文本（SOAP 响应/错误体用） */
function deepText(node, name) {
  const c = findAll(node, name)[0];
  return c ? c.text.trim() : '';
}
/** 文档元素：<root>（description）或 <s:Envelope>（SOAP） */
function documentElement(doc) {
  return doc.children.find(c => !/^#/.test(c.name)) || doc;
}

// ---------------------------------------------------------------- SSDP
function parseHeaders(text) {
  const out = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** 枚举可用的 IPv4 网卡（排除回环与 APIPA） */
function ipv4Interfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue;
      out.push({
        name,
        address: a.address,
        netmask: a.netmask || '',
        virtual: VIRTUAL_IFACE.test(name),
      });
    }
  }
  return out;
}

/**
 * 在指定网卡上发 M-SEARCH。
 * 关键：必须 setMulticastInterface，否则多网卡机器上组播会从错误的网卡出去。
 * 每个 ST 发两轮，避免无线网络下丢 UDP 组播包。
 */
function searchOnInterface(iface, sts, timeoutMs) {
  return new Promise(resolve => {
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
    catch { return resolve([]); }

    const found = new Map();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* ignore */ }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, timeoutMs);

    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!/^HTTP\/1\.[01]\s+200/i.test(text)) return;
      const h = parseHeaders(text);
      if (!h.location) return;
      const key = h.location.toLowerCase();
      if (found.has(key)) return;
      found.set(key, {
        location: h.location,
        server: h.server || '',
        usn: h.usn || '',
        st: h.st || '',
        from: rinfo.address,
        iface: iface.address,
        ifaceName: iface.name,
      });
    });
    sock.on('error', () => { clearTimeout(timer); finish(); });

    sock.bind(() => {
      try { sock.setMulticastInterface(iface.address); } catch { /* 部分虚拟网卡不支持 */ }
      try { sock.setMulticastTTL(2); } catch { /* ignore */ }

      const jobs = [];
      for (let round = 0; round < 2; round++) {
        sts.forEach((st, idx) => jobs.push({ st, at: round * 1300 + idx * 80 }));
      }
      jobs.sort((a, b) => a.at - b.at);

      for (const j of jobs) {
        setTimeout(() => {
          if (done) return;
          const msg = Buffer.from([
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            `MX: ${Math.max(1, Math.round(timeoutMs / 1000))}`,
            `ST: ${j.st}`,
            'USER-AGENT: ' + USER_AGENT,
            '', '',
          ].join('\r\n'));
          try { sock.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR); } catch { /* ignore */ }
        }, j.at);
      }
    });
  });
}

/**
 * 分轮搜索：先只走物理网卡，没结果再把虚拟网卡也加上重试一次。
 * 返回所有响应（按 LOCATION 去重）+ 实际尝试过的网卡，便于排障。
 */
async function discoverSSDP(opts = {}) {
  const sts = opts.sts || SEARCH_TARGETS;
  const timeoutMs = opts.timeout || 2600;
  const ifaces = ipv4Interfaces();
  if (!ifaces.length) return { hits: [], tried: [], ifaces, timeoutMs };

  let primary = '';
  try { primary = await localIpv4(); } catch { /* ignore */ }
  const score = i => (i.address === primary ? 2 : 0) + (i.virtual ? 0 : 1);
  const ordered = [...ifaces].sort((a, b) => score(b) - score(a));

  const plan = [ordered.filter(i => !i.virtual), ordered].filter(p => p.length);
  const seen = new Map();
  const tried = [];

  for (const list of plan) {
    const pending = list.filter(i => !tried.includes(i.address));
    if (!pending.length) continue;
    pending.forEach(i => tried.push(i.address));
    const results = await Promise.all(pending.map(i => searchOnInterface(i, sts, timeoutMs)));
    for (const arr of results) {
      for (const h of arr) {
        const k = h.location.toLowerCase();
        if (!seen.has(k)) seen.set(k, h);
      }
    }
    if (seen.size) break;
  }

  return { hits: [...seen.values()], tried, ifaces, timeoutMs, primary };
}


// ---------------------------------------------------------------- HTTP 取 description
function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('地址无效: ' + url)); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Connection: 'close', Accept: '*/*' },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + url));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求网关描述超时')));
    req.on('error', e => reject(new Error(`无法访问网关描述地址（${u.host}）：${e.message}`)));
    req.end();
  });
}

function resolveUrl(base, rel) {
  if (!rel) return '';
  try { return new URL(rel, base).toString(); } catch { return rel; }
}

// ---------------------------------------------------------------- 网关描述
const MAPPING_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

function parseDescription(xml, location) {
  const doc = parseXml(xml);
  const rootEl = documentElement(doc);
  const urlBaseRaw = textOf(rootEl, 'URLBase');
  const base = urlBaseRaw ? urlBaseRaw : location;
  const dev = firstNode(rootEl, 'device') || rootEl;

  const services = [];
  for (const svc of findAll(doc, 'service')) {
    const serviceType = textOf(svc, 'serviceType');
    const controlURL = textOf(svc, 'controlURL');
    if (!serviceType || !controlURL) continue;
    services.push({
      serviceType,
      serviceId: textOf(svc, 'serviceId'),
      controlUrl: resolveUrl(base, controlURL),
    });
  }

  // 优先精确匹配 WANIPConnection，其次 WANPPPConnection（PPPoE 拨号）
  let mapping = null;
  for (const t of MAPPING_TYPES) {
    mapping = services.find(s => s.serviceType === t);
    if (mapping) break;
  }
  if (!mapping) mapping = services.find(s => /WANIPConnection|WANPPPConnection/i.test(s.serviceType));
  if (!mapping) return null;

  return {
    location,
    base,
    friendlyName: textOf(dev, 'friendlyName') || '(未命名网关)',
    modelName: textOf(dev, 'modelName') || '',
    modelNumber: textOf(dev, 'modelNumber') || '',
    manufacturer: textOf(dev, 'manufacturer') || '',
    serviceType: mapping.serviceType,
    controlUrl: mapping.controlUrl,
  };
}

// ---------------------------------------------------------------- SOAP
const ERRORS = {
  401: '网关不支持该操作（Invalid Action）',
  402: '参数无效（Invalid Args）',
  501: '网关执行失败（Action Failed）',
  606: '网关拒绝该操作（未授权，可能需要在路由器里关闭「禁止客户端配置」）',
  714: '该映射不存在（可能已被删除或租期到期）',
  715: '不支持指定来源 IP',
  716: '不支持指定外网端口',
  718: '外网端口已被其它映射占用（ConflictInMappingEntry）',
  724: '内网端口与外网端口必须相同',
  725: '此路由器只支持永久租期（lease 必须为 0）',
  729: '此路由器不支持指定客户端 IP',
  732: '此路由器不支持端口映射（可能只支持 WANPPPConnection）',
};

function buildEnvelope(serviceType, action, args) {
  const body = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join('');
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
    + 's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body>`
    + '</s:Envelope>';
}

function soapRequest(controlUrl, serviceType, action, args, timeoutMs = 7000) {
  const body = buildEnvelope(serviceType, action, args);
  const DBG = !!process.env.HMCS_UPNP_DEBUG;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(controlUrl); } catch { return reject(new Error('网关控制地址无效：' + controlUrl)); }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${serviceType}#${action}"`,
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
      'User-Agent': USER_AGENT,
    };
    if (DBG) {
      console.error('[upnp] ->', action, controlUrl);
      console.error('[upnp] headers', JSON.stringify(headers));
      console.error('[upnp] body', body);
    }
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers,
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (DBG) console.error('[upnp] <-', res.statusCode, text);
        if (res.statusCode >= 300) {
          const doc = parseXml(text);
          const code = Number(deepText(doc, 'errorCode')) || 0;
          const desc = deepText(doc, 'errorDescription');
          const e = new Error(ERRORS[code] || desc || ('网关返回 HTTP ' + res.statusCode + '（' + action + '）'));
          e.upnpCode = code;
          e.upnpDesc = desc;
          e.status = 502;
          e.raw = text.slice(0, 800);
          return reject(e);
        }
        const doc = parseXml(text);
        const resp = findAll(doc, action + 'Response')[0]
          || findAll(doc, 'Body')[0] || doc;
        const out = {};
        for (const c of resp.children) out[localName(c.name)] = c.text.trim();
        resolve(out);
      });
    });
    req.on('timeout', () => req.destroy(new Error('网关响应超时（可能不支持本次操作）')));
    req.on('error', e => reject(new Error('无法连接网关控制地址：' + e.message)));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- 本机地址
function fallbackIpv4() {
  const ifaces = os.networkInterfaces();
  const all = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      all.push(a.address);
    }
  }
  const priv = all.find(ip => /^192\.168\./.test(ip))
    || all.find(ip => /^10\./.test(ip))
    || all.find(ip => /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
  return priv || all[0] || '127.0.0.1';
}

/** 取本机到指定目标的出口 IPv4（UDP connect 不会真的发包，只让系统选路） */
function localIpToward(target) {
  return new Promise(resolve => {
    let sock;
    try { sock = dgram.createSocket('udp4'); } catch { return resolve(fallbackIpv4()); }
    let done = false;
    const finish = ip => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* ignore */ }
      resolve(ip || fallbackIpv4());
    };
    sock.on('error', () => finish(fallbackIpv4()));
    try {
      sock.connect(53, target, () => {
        try { finish(sock.address().address); } catch { finish(fallbackIpv4()); }
      });
    } catch { finish(fallbackIpv4()); }
  });
}

/** 取本机在默认路由出口网卡上的 IPv4 */
function localIpv4() { return localIpToward('223.5.5.5'); }

/**
 * 取「到某个地址」的本机 IPv4。
 *
 * 这一点很关键：不少家用网关（华为、部分 TP-Link）在 AddPortMapping 时会校验
 * NewInternalClient 必须等于控制连接的真实源 IP，否则返回 402 Invalid Args。
 * 多网卡机器（有线 + WiFi + VPN）连公网 DNS 的出口，和连路由器的出口可能不是同一张网卡，
 * 所以必须按「网关地址」去探路，而不是一律连公网 DNS。
 *
 * @param {string} target 网关 IP 或 controlUrl
 */
function localIpFor(target) {
  if (!target) return localIpv4();
  let host = String(target);
  if (/^https?:\/\//i.test(host)) {
    try { host = new URL(host).hostname; } catch { /* 用原串 */ }
  }
  return localIpToward(host);
}

// ---------------------------------------------------------------- 对外接口
let cache = { at: 0, gateway: null };
let lastDiag = null;      // 最近一次发现过程，供 /api/upnp/status 展示
const CACHE_MS = 5 * 60 * 1000;

/**
 * 发现网关。结果缓存 5 分钟。
 * @param {{force?: boolean, timeout?: number, all?: boolean}} opts
 */
async function discover(opts = {}) {
  const now = Date.now();
  if (!opts.force && cache.gateway && now - cache.at < CACHE_MS) {
    return { gateway: cache.gateway, cached: true, searched: 0 };
  }
  if (!opts.force && cache.gateway === null && now - cache.at < 60 * 1000) {
    const e = new Error('未发现支持 UPnP 的网关（路由器可能关闭了 UPnP，或本机不在同一网段）');
    e.status = 502;
    e.cached = false;
    e.diag = lastDiag;
    e.hint = '刚刚已搜索过一次，60 秒内不重复发送 SSDP 查询；可点「重新检测」强制重试。';
    throw e;
  }

  // 抓取每个候选设备的描述，挑出真正带端口映射服务的
  const resolveGateways = async (hits) => {
    const byLocation = new Map();
    for (const h of hits) {
      const k = h.location.toLowerCase();
      if (!byLocation.has(k)) byLocation.set(k, h);
    }
    const gateways = [];
    for (const h of byLocation.values()) {
      try {
        const xml = await httpGet(h.location);
        const gw = parseDescription(xml, h.location);
        if (gw) gateways.push({ ...gw, server: h.server, iface: h.iface, ifaceName: h.ifaceName });
      } catch { /* 单个设备失败不影响其它 */ }
    }
    return { byLocation, gateways };
  };

  // 第一轮：定向 ST；第二轮（找不到网关时）：ssdp:all —— 部分路由器只认这个
  let res = await discoverSSDP({ timeout: opts.timeout });
  let found = await resolveGateways(res.hits);
  if (!found.gateways.length) {
    const all = await discoverSSDP({ timeout: opts.timeout, sts: ['ssdp:all'] });
    res = {
      ...all,
      tried: [...new Set([...res.tried, ...all.tried])],
      primary: all.primary || res.primary,
      hits: [...res.hits, ...all.hits],
    };
    found = await resolveGateways(res.hits);
  }

  lastDiag = {
    at: new Date().toISOString(),
    ifaces: res.ifaces.map(i => ({ name: i.name, address: i.address, virtual: i.virtual, tried: res.tried.includes(i.address) })),
    primaryIp: res.primary || '',
    responses: found.byLocation.size,
    devices: [...found.byLocation.values()].map(h => ({ location: h.location, iface: h.ifaceName, server: h.server, st: h.st })),
    timeoutMs: res.timeoutMs,
  };

  if (!found.gateways.length) {
    cache = { at: now, gateway: null };
    const triedText = res.tried.length ? `已尝试网卡：${res.tried.join('、')}` : '未找到可用网卡';
    let msg;
    if (!found.byLocation.size) {
      msg = `未发现任何 UPnP 设备（${triedText}）`;
    } else {
      msg = `发现 ${found.byLocation.size} 个 UPnP 设备，但都不提供 WANIPConnection/WANPPPConnection 端口映射服务`;
    }
    const e = new Error(msg);
    e.status = 502;
    e.diag = lastDiag;
    e.hint = !found.byLocation.size
      ? '排查顺序：① 路由器管理页确认 UPnP 已开启（部分路由器叫「NAT-PMP/UPnP 即插即用」）；② 确认本机与路由器同一网段；③ 若装了 VPN / 虚拟机网卡，可能抢占组播出口，本工具已自动逐网卡重试，仍失败可临时禁用它们再试；④ Windows 防火墙若拦截 node.exe 的出站也会导致失败。'
      : '这台设备可能只是 NAS / 路由器桥接端口，不具备端口映射能力。若你有两层设备（光猫 + 路由器），请在外层光猫上也开启 UPnP。';
    throw e;
  }

  const { gateways } = found;

  // 优先：与默认路由同网卡发现的 > 提供 WANIPConnection 的
  const primaryIp = res.primary || '';
  gateways.sort((a, b) => {
    const pa = a.iface === primaryIp ? 1 : 0;
    const pb = b.iface === primaryIp ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const ia = /WANIPConnection/i.test(a.serviceType) ? 1 : 0;
    const ib = /WANIPConnection/i.test(b.serviceType) ? 1 : 0;
    return ib - ia;
  });

  const gateway = gateways[0];
  cache = { at: now, gateway };
  return { gateway, cached: false, searched: found.byLocation.size };
}

function clearCache() { cache = { at: 0, gateway: null }; lastDiag = null; }
function diag() { return lastDiag; }

async function getExternalIp(gw) {
  const r = await soapRequest(gw.controlUrl, gw.serviceType, 'GetExternalIPAddress', {});
  const ip = r.NewExternalIPAddress || '';
  return ip && ip !== '0.0.0.0' ? ip : '';
}

async function getStatusInfo(gw) {
  const r = await soapRequest(gw.controlUrl, gw.serviceType, 'GetStatusInfo', {});
  return {
    status: r.NewConnectionStatus || '',
    uptime: Number(r.NewUptime || 0),
    lastError: r.NewLastConnectionError || '',
  };
}

function normalizeProtocol(p) {
  const v = String(p || 'TCP').toUpperCase();
  return v === 'UDP' ? 'UDP' : 'TCP';
}

/** 部分路由器按字节截断描述，会切断多字节字符，清掉尾部残留的替换符 */
function cleanDesc(s) {
  return String(s == null ? '' : s).replace(/\uFFFD+$/, '').trim();
}

/**
 * 添加端口映射。
 * @param {object} gw 网关对象
 * @param {{externalPort:number, internalPort:number, internalClient?:string,
 *          protocol?:string, description?:string, lease?:number, overwrite?:boolean}} o
 */
async function addMapping(gw, o) {
  const ext = Number(o.externalPort);
  const int = Number(o.internalPort || o.externalPort);
  if (!(ext >= 1 && ext <= 65535)) throw new Error('外网端口必须在 1-65535 之间');
  if (!(int >= 1 && int <= 65535)) throw new Error('内网端口必须在 1-65535 之间');
  const protocol = normalizeProtocol(o.protocol);
  // 必须用「到网关」的出口地址：多数网关校验 NewInternalClient == 控制连接源 IP，
  // 多网卡时用连公网 DNS 得到的地址会被拒（402 Invalid Args）
  const client = o.internalClient || await localIpFor(gw.controlUrl);
  let appliedLease = Number.isFinite(Number(o.lease)) ? Math.max(0, Number(o.lease)) : 0;
  const desc = String(o.description || 'HMCS').replace(/[\r\n"]/g, ' ').slice(0, 60);

  const args = {
    NewRemoteHost: '',
    NewExternalPort: ext,
    NewProtocol: protocol,
    NewInternalPort: int,
    NewInternalClient: client,
    NewEnabled: '1',
    NewPortMappingDescription: desc,
    NewLeaseDuration: appliedLease,
  };

  const attempt = a => soapRequest(gw.controlUrl, gw.serviceType, 'AddPortMapping', a);

  // 候选内网地址：优先「到网关的出口地址」，402 时再换本机其它地址试一次。
  // 部分网关校验 NewInternalClient 必须等于它看到的源 IP，多网卡下容易踩。
  const candidates = o.internalClient
    ? [o.internalClient]
    : [client, ...ipv4Interfaces().map(i => i.address).filter(ip => ip !== client)];

  let clientUsed = client;
  const addWith = async (extra) => {
    let lastErr = null;
    for (const ip of candidates) {
      try {
        await attempt({ ...args, ...extra, NewInternalClient: ip });
        clientUsed = ip;
        return;
      } catch (e) {
        lastErr = e;
        if (e.upnpCode !== 402) throw e;   // 换地址也解决不了，直接抛
      }
    }
    throw lastErr;
  };

  try {
    await addWith({});
  } catch (e) {
    // 只支持永久租期
    if (e.upnpCode === 725 && appliedLease !== 0) {
      appliedLease = 0;
      await addWith({ NewLeaseDuration: 0 });
    } else if (e.upnpCode === 718 && o.overwrite !== false) {
      // 端口被旧映射占用：先删同端口同协议的条目再重试
      try {
        await soapRequest(gw.controlUrl, gw.serviceType, 'DeletePortMapping', {
          NewRemoteHost: '', NewExternalPort: ext, NewProtocol: protocol,
        });
      } catch { /* 删除失败也继续尝试覆盖 */ }
      await addWith({});
    } else {
      throw e;
    }
  }

  return { externalPort: ext, internalPort: int, internalClient: clientUsed, protocol, lease: appliedLease, description: desc };
}

async function deleteMapping(gw, o) {
  const ext = Number(o.externalPort);
  const protocol = normalizeProtocol(o.protocol);
  if (!(ext >= 1 && ext <= 65535)) throw new Error('外网端口必须在 1-65535 之间');
  await soapRequest(gw.controlUrl, gw.serviceType, 'DeletePortMapping', {
    NewRemoteHost: '', NewExternalPort: ext, NewProtocol: protocol,
  });
  return { externalPort: ext, protocol };
}

/** 读取网关的端口映射表（最多 limit 条） */
async function listMappings(gw, limit = 40) {
  const items = [];
  for (let i = 0; i < limit; i++) {
    let r;
    try {
      r = await soapRequest(gw.controlUrl, gw.serviceType, 'GetGenericPortMappingEntry', { NewPortMappingIndex: i });
    } catch (e) {
      if (e.upnpCode === 713 || e.upnpCode === 714 || (e.upnpCode === 402 && i > 0)) break;
      if (i === 0) throw e;
      break;
    }
    if (!r.NewExternalPort) break;
    items.push({
      index: i,
      externalPort: Number(r.NewExternalPort) || 0,
      internalPort: Number(r.NewInternalPort) || 0,
      protocol: r.NewProtocol || '',
      internalClient: r.NewInternalClient || '',
      description: cleanDesc(r.NewPortMappingDescription),
      enabled: r.NewEnabled === '1' || r.NewEnabled === 'true',
      lease: Number(r.NewLeaseDuration) || 0,
    });
  }
  return items;
}

/** 一次拿到网关 + 外网 IP + 本机 IP，供 UI 展示 */
async function probe(opts = {}) {
  const { gateway, cached, searched } = await discover(opts);
  const ip = await localIpFor(gateway.controlUrl);
  let externalIp = '';
  let extErr = '';
  try { externalIp = await getExternalIp(gateway); }
  catch (e) { extErr = e.message; }
  return {
    gateway: {
      friendlyName: gateway.friendlyName,
      modelName: gateway.modelName,
      manufacturer: gateway.manufacturer,
      serviceType: gateway.serviceType,
      location: gateway.location,
      controlUrl: gateway.controlUrl,
      iface: gateway.ifaceName || '',
      ifaceIp: gateway.iface || '',
    },
    localIp: ip,
    externalIp,
    externalError: extErr,
    cached,
    searched,
    diag: lastDiag,
  };
}

module.exports = {
  discover, clearCache, diag, probe, discoverSSDP, ipv4Interfaces,
  addMapping, deleteMapping, listMappings, getExternalIp, getStatusInfo,
  localIpv4, localIpFor, normalizeProtocol,
  // 供测试
  _parseXml: parseXml, _parseDescription: parseDescription, _buildEnvelope: buildEnvelope,
};
