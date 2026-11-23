'use strict';
/**
 * 管理器自身端口的 UPnP 映射
 *
 * 和「服务端实例」的网络页用的是同一套 lib/upnp.js，但对象是 HMCS 自己的 WebUI 端口：
 * 打开设置项后，进程启动时就把 8720 之类的端口登记到网关，外部网络直接访问
 * http://<公网IP>:<外网端口> 就能打开管理界面（当然要过密码）。
 *
 * 注意顺序：必须先把监听地址改成 0.0.0.0，否则映射建好了也没人应答。
 */
const upnp = require('./upnp');
const { readSettings, writeSettings, isLoopbackHost } = require('./paths');

const PROTOCOLS = ['TCP', 'UDP'];
const DESCRIPTION = 'HMCS Manager';

function cfg() {
  const s = readSettings().selfUpnp || {};
  const ext = Number(s.externalPort);
  return {
    auto: !!s.auto,
    externalPort: ext >= 1 && ext <= 65535 ? ext : 0,
    protocol: PROTOCOLS.includes(s.protocol) ? s.protocol : 'TCP',
    lease: Number.isFinite(Number(s.lease)) ? Math.max(0, Number(s.lease)) : 0,
    added: Array.isArray(s.added) ? s.added : [],
    lastError: s.lastError || '',
    lastSync: s.lastSync || '',
  };
}

function patchSelf(patch) {
  const next = { ...cfg(), ...patch };
  writeSettings({ selfUpnp: next });
  return next;
}

/**
 * 建立映射（会先清掉本机登记过的旧条目，避免换端口后留僵尸映射）
 * @param {{port:number, externalPort?:number, protocol?:string, lease?:number, force?:boolean, remember?:boolean}} opts
 */
async function apply(opts = {}) {
  const c = cfg();
  const internalPort = Number(opts.port) > 0 ? Number(opts.port) : Number(readSettings().port);
  if (!(internalPort >= 1 && internalPort <= 65535)) throw new Error('内网端口无效');

  const externalPort = Number(opts.externalPort) > 0
    ? Number(opts.externalPort)
    : (c.externalPort || internalPort);
  if (!(externalPort >= 1 && externalPort <= 65535)) throw new Error('外网端口必须在 1-65535 之间');

  const protocol = PROTOCOLS.includes(opts.protocol) ? opts.protocol : c.protocol;
  const lease = Number.isFinite(Number(opts.lease)) ? Math.max(0, Number(opts.lease)) : c.lease;

  const { gateway } = await upnp.discover(opts.force ? { force: true } : {});
  await remove({ quiet: true });

  const r = await upnp.addMapping(gateway, {
    externalPort,
    internalPort,
    protocol,
    description: DESCRIPTION,
    lease,
  });

  const added = [{
    protocol: r.protocol,
    externalPort: r.externalPort,
    internalPort: r.internalPort,
    internalClient: r.internalClient,
    lease: r.lease,
  }];

  patchSelf({
    ...(opts.remember === false ? {} : { externalPort, protocol, lease }),
    added,
    lastError: '',
    lastSync: new Date().toISOString(),
  });

  let externalIp = '';
  try { externalIp = await upnp.getExternalIp(gateway); } catch { /* 部分网关不实现，忽略 */ }

  return {
    added,
    externalIp,
    gateway: { friendlyName: gateway.friendlyName, modelName: gateway.modelName },
  };
}

/** 删除本机登记过的映射；网关不可达时静默返回 */
async function remove(opts = {}) {
  const c = cfg();
  if (!c.added.length) return { removed: [] };

  let gateway;
  try { ({ gateway } = await upnp.discover({})); }
  catch (e) {
    if (!opts.quiet) throw e;
    patchSelf({ lastError: e.message });
    return { removed: [], error: e.message };
  }

  const removed = [];
  for (const item of c.added) {
    try {
      await upnp.deleteMapping(gateway, { externalPort: item.externalPort, protocol: item.protocol });
      removed.push(item);
    } catch (e) {
      if (e.upnpCode === 714) removed.push(item);   // 714 = 条目已不存在
      else if (!opts.quiet) throw e;
    }
  }
  patchSelf({ added: [], lastSync: new Date().toISOString() });
  return { removed };
}

/** 记一次失败，便于设置页显示原因 */
function noteError(message) {
  patchSelf({ lastError: String(message || ''), lastSync: new Date().toISOString() });
}

/** 本机所有可用的 IPv4 访问地址，给用户抄写用 */
function lanAddresses(port) {
  return upnp.ipv4Interfaces()
    .filter(i => !i.virtual)
    .map(i => ({ iface: i.name, ip: i.address, url: `http://${i.address}:${port}` }));
}

/**
 * 给界面用的状态。bindHost 一定要传**实际监听值**：
 * auto 开着但只监听 127.0.0.1 时，启动时映射会被跳过 —— 以前这里什么都不说，
 * 界面上开关明明勾着、却只显示「当前没有映射」，用户完全不知道为什么没生效。
 */
function status({ port, bindHost } = {}) {
  const c = cfg();
  const p = Number(port) || Number(readSettings().port) || 8720;
  const localOnly = bindHost ? isLoopbackHost(bindHost) : false;
  const blocked = !!c.auto && localOnly;

  let hint = '';
  if (blocked) {
    hint = '已开启「启动时自动映射」，但当前只监听 127.0.0.1，本次启动没有建立映射。'
      + '把「监听地址」改成「允许外部访问」，再点「立即重启」即可生效。';
  } else if (c.auto && !c.added.length && c.lastError) {
    hint = '自动映射上次失败：' + c.lastError + '　可点「立即映射」重试，或看日志排障。';
  } else if (c.auto && !c.added.length) {
    hint = '已开启「启动时自动映射」，但目前没有已建立的映射：点「立即映射」试一次，或重启 HMCS 让它自动建。';
  }

  return {
    ...c,
    port: p,
    addresses: lanAddresses(p),
    localOnly,
    blocked,
    ready: !!(c.added && c.added.length),
    hint,
  };
}

module.exports = { apply, remove, status, cfg, noteError, lanAddresses, DESCRIPTION };
