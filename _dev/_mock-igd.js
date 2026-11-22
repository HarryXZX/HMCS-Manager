'use strict';
/**
 * 独立的模拟 IGD 网关：HTTP(SOAP) + SSDP 组播响应
 * 仅用于本地界面/接口验证，不接触真实路由器。
 * 用法：node _mock-igd.js   （Ctrl+C 退出）
 */
const http = require('http');
const dgram = require('dgram');

const mappings = [
  { externalPort: 8080, internalPort: 80, protocol: 'TCP', internalClient: '192.168.1.20', description: 'NAS 管理', lease: 0, enabled: true },
];
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
    if (action === 'GetStatusInfo') return send(200, ok(action, '<NewConnectionStatus>Connected</NewConnectionStatus><NewUptime>1234</NewUptime><NewLastConnectionError>ERROR_NONE</NewLastConnectionError>'));
    if (action === 'AddPortMapping') {
      const ext = Number(tag(body, 'NewExternalPort'));
      const proto = tag(body, 'NewProtocol');
      if (mappings.some(m => m.externalPort === ext && m.protocol === proto)) return send(500, err(718, 'ConflictInMappingEntry'));
      mappings.push({
        externalPort: ext, internalPort: Number(tag(body, 'NewInternalPort')), protocol: proto,
        internalClient: tag(body, 'NewInternalClient'), description: tag(body, 'NewPortMappingDescription'),
        lease: Number(tag(body, 'NewLeaseDuration')), enabled: true,
      });
      console.log(`[mock] + ${proto} ${ext} -> ${tag(body, 'NewInternalClient')}:${tag(body, 'NewInternalPort')}`);
      return send(200, ok(action, ''));
    }
    if (action === 'DeletePortMapping') {
      const ext = Number(tag(body, 'NewExternalPort'));
      const proto = tag(body, 'NewProtocol');
      const i = mappings.findIndex(m => m.externalPort === ext && m.protocol === proto);
      if (i < 0) return send(500, err(714, 'NoSuchEntryInArray'));
      mappings.splice(i, 1);
      console.log(`[mock] - ${proto} ${ext}`);
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

srv.listen(0, '127.0.0.1', () => {
  httpPort = srv.address().port;
  console.log('模拟网关 HTTP 端口:', httpPort);
  const ssdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  ssdp.on('error', e => console.log('SSDP 错误:', e.message));
  ssdp.bind(1900, () => {
    try { ssdp.addMembership('239.255.255.250'); } catch (e) { console.log('加入组播失败:', e.message); }
    console.log('SSDP 监听 1900，等待 M-SEARCH…');
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
});
