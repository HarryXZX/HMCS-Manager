'use strict';
/**
 * 端到端验证：模拟 IGD 网关（HTTP + SSDP 组播响应）→ 驱动 HMCS 的 UPnP API
 * 只用临时端口 8799 启动一份 app.js，不干扰 8720 上的正式实例。
 */
const http = require('http');
const dgram = require('dgram');
const { spawn } = require('child_process');

const APP_PORT = 8799;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const mappings = [];
let httpPort = 0;

const DESC = port => `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>http://127.0.0.1:${port}/</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <friendlyName>HY 测试路由器</friendlyName>
    <manufacturer>TestVendor</manufacturer>
    <modelName>Model-X1</modelName>
    <deviceList><device>
      <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
      <deviceList><device>
        <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
        <serviceList><service>
          <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
          <serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId>
          <controlURL>/ctl/ip</controlURL>
          <eventSubURL>/evt/ip</eventSubURL>
          <SCPDURL>/ip.xml</SCPDURL>
        </service></serviceList>
      </device></deviceList>
    </device></deviceList>
  </device>
</root>`;

const tag = (xml, n) => { const m = xml.match(new RegExp('<' + n + '>([\\s\\S]*?)</' + n + '>')); return m ? m[1] : ''; };
const ok = (a, b) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>`
  + `<u:${a}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">${b}</u:${a}Response></s:Body></s:Envelope>`;
const err = (c, d) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>`
  + `<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">`
  + `<errorCode>${c}</errorCode><errorDescription>${d}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;

const srv = http.createServer((req, res) => {
  if (req.url === '/desc.xml') {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(DESC(httpPort));
  }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const action = (body.match(/<u:(\w+) xmlns:u=/) || [])[1] || '';
    const send = (code, xml) => { res.writeHead(code, { 'Content-Type': 'text/xml' }); res.end(xml); };
    if (action === 'GetExternalIPAddress') return send(200, ok(action, '<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>'));
    if (action === 'AddPortMapping') {
      const ext = Number(tag(body, 'NewExternalPort'));
      const proto = tag(body, 'NewProtocol');
      if (mappings.some(m => m.externalPort === ext && m.protocol === proto)) return send(500, err(718, 'ConflictInMappingEntry'));
      mappings.push({
        externalPort: ext, internalPort: Number(tag(body, 'NewInternalPort')), protocol: proto,
        internalClient: tag(body, 'NewInternalClient'), description: tag(body, 'NewPortMappingDescription'),
        lease: Number(tag(body, 'NewLeaseDuration')), enabled: true,
      });
      return send(200, ok(action, ''));
    }
    if (action === 'DeletePortMapping') {
      const ext = Number(tag(body, 'NewExternalPort'));
      const proto = tag(body, 'NewProtocol');
      const i = mappings.findIndex(m => m.externalPort === ext && m.protocol === proto);
      if (i < 0) return send(500, err(714, 'NoSuchEntryInArray'));
      mappings.splice(i, 1);
      return send(200, ok(action, ''));
    }
    if (action === 'GetGenericPortMappingEntry') {
      const m = mappings[Number(tag(body, 'NewPortMappingIndex'))];
      if (!m) return send(500, err(713, 'SpecifiedArrayIndexInvalid'));
      return send(200, ok(action, `<NewRemoteHost></NewRemoteHost><NewExternalPort>${m.externalPort}</NewExternalPort>`
        + `<NewProtocol>${m.protocol}</NewProtocol><NewInternalPort>${m.internalPort}</NewInternalPort>`
        + `<NewInternalClient>${m.internalClient}</NewInternalClient><NewEnabled>1</NewEnabled>`
        + `<NewPortMappingDescription>${m.description}</NewPortMappingDescription>`
        + `<NewLeaseDuration>${m.lease}</NewLeaseDuration>`));
    }
    send(500, err(401, 'Invalid Action'));
  });
});

let ssdp;
function startSsdp() {
  ssdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  ssdp.on('error', e => { console.log('  [mock] SSDP 监听失败:', e.message); });
  ssdp.bind(1900, () => {
    try { ssdp.addMembership('239.255.255.250'); } catch (e) { console.log('  [mock] 加入组播失败:', e.message); }
    try { ssdp.setMulticastLoopback(true); } catch { /* ignore */ }
    console.log('  [mock] SSDP 已监听 1900');
  });
  ssdp.on('message', (msg, rinfo) => {
    const t = msg.toString('utf8');
    if (!/^M-SEARCH/i.test(t)) return;
    const st = (t.match(/ST:\s*(.+)/i) || [])[1] || 'upnp:rootdevice';
    const res = ['HTTP/1.1 200 OK', 'CACHE-CONTROL: max-age=120', `ST: ${st.trim()}`,
      `USN: uuid:mock-igd::${st.trim()}`, 'EXT:', 'SERVER: Test/1.0 UPnP/1.1 MockIGD/1.0',
      `LOCATION: http://127.0.0.1:${httpPort}/desc.xml`, '', ''].join('\r\n');
    try { ssdp.send(Buffer.from(res), rinfo.port, rinfo.address); } catch { /* ignore */ }
  });
}

const results = [];
function check(cond, msg) { results.push(!!cond); console.log((cond ? '  ✓ ' : '  ✗ ') + msg); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function j(path, opts) {
  const r = await fetch(BASE + path, opts);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = { error: t }; }
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}
const post = (path, body) => j(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  httpPort = srv.address().port;
  console.log('模拟网关 HTTP 端口:', httpPort);

  const app = spawn(process.execPath, ['app.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, HMCS_PORT: String(APP_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[app] ' + d));
  app.stderr.on('data', d => process.stdout.write('[app:err] ' + d));

  const cleanup = () => { try { app.kill(); } catch {} try { srv.close(); } catch {} try { ssdp.close(); } catch {} };
  process.on('exit', cleanup);

  // 等后端就绪
  let boot = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try { boot = await j('/api/bootstrap'); break; } catch { /* retry */ }
  }
  if (!boot) { console.log('后端未启动'); cleanup(); process.exit(1); }
  console.log('后端就绪，实例数:', boot.instances.length);

  const inst = boot.instances[0];
  if (!inst) { console.log('没有实例可测'); cleanup(); process.exit(1); }
  const id = inst.id;
  console.log('测试实例:', id, '端口', inst.port);

  startSsdp();
  await sleep(600);

  console.log('== 1. 通过 SSDP 发现网关 ==');
  await post('/api/upnp/discover', {});
  const st = await j(`/api/upnp/status?instId=${encodeURIComponent(id)}&probe=1&force=1`);
  check(st.gateway && st.gateway.friendlyName === 'HY 测试路由器', '发现网关: ' + (st.gateway && st.gateway.friendlyName) + (st.gatewayError ? ' | 错误: ' + st.gatewayError : ''));
  check(st.externalIp === '203.0.113.7', '外网 IP: ' + st.externalIp);
  check(/^\d+\.\d+\.\d+\.\d+$/.test(st.localIp), '本机 IP: ' + st.localIp);

  console.log('== 2. 手动映射 TCP+UDP ==');
  const m1 = await post('/api/upnp/map', { instId: id, externalPort: 25599, protocol: 'BOTH', lease: 0 });
  check(m1.added.length === 2, '同时建立 TCP+UDP 两条: ' + m1.added.map(a => a.protocol).join(','));
  check(mappings.length === 2, '网关侧共 2 条映射');

  console.log('== 3. 网关映射表回读 ==');
  const st2 = await j(`/api/upnp/status?instId=${encodeURIComponent(id)}&probe=1`);
  check(st2.mappings.length === 2, '读到 ' + st2.mappings.length + ' 条');
  check(st2.mappings.every(m => m.externalPort === 25599), '外网端口均为 25599');
  check(st2.instance.externalPort === 25599 && st2.instance.protocol === 'BOTH', '实例已记住 25599 / BOTH');

  console.log('== 4. 按端口删除 ==');
  const u1 = await post('/api/upnp/unmap', { instId: id, externalPort: 25599 });
  check(u1.removed.length === 2, '删除 2 条');
  check(mappings.length === 0, '网关侧已清空');

  console.log('== 5. 自动映射：随服务端启动建立 ==');
  await post('/api/upnp/auto', { instId: id, auto: true, externalPort: 0, protocol: 'BOTH', lease: 0 });
  await post(`/api/instances/${encodeURIComponent(id)}/start`, { memory: '2G', acceptEula: true });
  let running = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const b = await j('/api/bootstrap');
    const cur = b.instances.find(x => x.id === id);
    if (cur && cur.runtime.status === 'running') { running = true; break; }
  }
  check(running, '服务端已进入 running');
  await sleep(1500);
  const autoMapped = mappings.filter(m => m.internalPort === inst.port);
  check(autoMapped.length === 2, '自动建立映射 2 条 → 内网端口 ' + inst.port + '（实际 ' + autoMapped.length + '）');
  const logs = await (await fetch(`${BASE}/api/instances/${encodeURIComponent(id)}/logs?limit=200`)).text();
  check(/UPnP 端口映射已建立/.test(logs), '控制台有 UPnP 成功日志');

  console.log('== 6. 自动映射：随服务端停止移除 ==');
  await post(`/api/instances/${encodeURIComponent(id)}/stop`, {});
  let stopped = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const b = await j('/api/bootstrap');
    const cur = b.instances.find(x => x.id === id);
    if (cur && cur.runtime.status === 'stopped') { stopped = true; break; }
  }
  check(stopped, '服务端已停止');
  await sleep(1500);
  check(mappings.length === 0, '退出后网关映射已清理（剩余 ' + mappings.length + '）');
  const logs2 = await (await fetch(`${BASE}/api/instances/${encodeURIComponent(id)}/logs?limit=200`)).text();
  check(/已随服务端停止而移除/.test(logs2), '控制台有清理日志');

  console.log('== 7. 无网关时的错误处理 ==');
  ssdp.close();
  await sleep(200);
  await post('/api/upnp/discover', {});
  const st3 = await j(`/api/upnp/status?instId=${encodeURIComponent(id)}&probe=1&force=1`);
  if (st3.gateway) {
    // 本机真的有 UPnP 路由器时，关掉假网关也会发现真实网关，这一步无法构造「无网关」
    console.log('  · 跳过（本机存在真实网关：' + st3.gateway.friendlyName + '），无网关分支由模块自测覆盖');
  } else {
    check(!!st3.gatewayError, '网关消失后返回可读错误: ' + st3.gatewayError);
    check(!!st3.hint, '附带排查提示');
  }

  console.log('== 8. 实例上不残留映射记录 ==');
  const b2 = await j('/api/bootstrap');
  const cur = b2.instances.find(x => x.id === id);
  check((cur.upnp.added || []).length === 0, 'upnp.added 已清空');

  // 复位：别把 auto 开关留在测试实例上
  await post('/api/upnp/auto', { instId: id, auto: false, externalPort: 0, protocol: 'TCP', lease: 0 });
  console.log('  · 已复位 auto=false');

  cleanup();
  const failed = results.filter(x => !x).length;
  console.log(failed ? `\n有 ${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('异常:', e.message); cleanup(); process.exit(1); });
