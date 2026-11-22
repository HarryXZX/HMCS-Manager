'use strict';
const http = require('http');
const upnp = require('../lib/upnp');

// ---- 模拟一台 IGD 网关 ----
const state = { mappings: [], calls: [], failLease: false };

const DESC = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>http://127.0.0.1:PORT/</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <friendlyName>HY 测试路由器</friendlyName>
    <manufacturer>TestVendor</manufacturer>
    <modelName>Model-X1</modelName>
    <deviceList>
      <device>
        <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
        <deviceList>
          <device>
            <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
            <serviceList>
              <service>
                <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
                <serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId>
                <controlURL>/ctl/ip</controlURL>
                <eventSubURL>/evt/ip</eventSubURL>
                <SCPDURL>/ip.xml</SCPDURL>
              </service>
            </serviceList>
          </device>
        </deviceList>
      </device>
    </deviceList>
  </device>
</root>`;

function findTag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1] : '';
}

function soapOk(action, body) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>`
    + `<u:${action}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">${body}</u:${action}Response>`
    + `</s:Body></s:Envelope>`;
}
function soapErr(code, desc) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>`
    + `<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>`
    + `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode>`
    + `<errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
}

const srv = http.createServer((req, res) => {
  if (req.url === '/desc.xml') {
    const port = srv.address().port;
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(DESC.replace('PORT', port));
  }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const action = (body.match(/<u:(\w+) xmlns:u=/) || [])[1] || '';
    state.calls.push({ action, soapAction: req.headers.soapaction });
    const send = (code, xml) => { res.writeHead(code, { 'Content-Type': 'text/xml' }); res.end(xml); };

    if (action === 'GetExternalIPAddress') {
      return send(200, soapOk(action, '<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>'));
    }
    if (action === 'AddPortMapping') {
      const lease = Number(findTag(body, 'NewLeaseDuration'));
      const ext = Number(findTag(body, 'NewExternalPort'));
      const proto = findTag(body, 'NewProtocol');
      if (state.failLease && lease !== 0) return send(500, soapErr(725, 'OnlyPermanentLeasesSupported'));
      if (state.mappings.some(m => m.externalPort === ext && m.protocol === proto)) {
        return send(500, soapErr(718, 'ConflictInMappingEntry'));
      }
      state.mappings.push({
        externalPort: ext,
        internalPort: Number(findTag(body, 'NewInternalPort')),
        protocol: proto,
        internalClient: findTag(body, 'NewInternalClient'),
        description: findTag(body, 'NewPortMappingDescription'),
        lease,
        enabled: true,
      });
      return send(200, soapOk(action, ''));
    }
    if (action === 'DeletePortMapping') {
      const ext = Number(findTag(body, 'NewExternalPort'));
      const proto = findTag(body, 'NewProtocol');
      const i = state.mappings.findIndex(m => m.externalPort === ext && m.protocol === proto);
      if (i < 0) return send(500, soapErr(714, 'NoSuchEntryInArray'));
      state.mappings.splice(i, 1);
      return send(200, soapOk(action, ''));
    }
    if (action === 'GetGenericPortMappingEntry') {
      const idx = Number(findTag(body, 'NewPortMappingIndex'));
      const m = state.mappings[idx];
      if (!m) return send(500, soapErr(713, 'SpecifiedArrayIndexInvalid'));
      return send(200, soapOk(action,
        `<NewRemoteHost></NewRemoteHost><NewExternalPort>${m.externalPort}</NewExternalPort>`
        + `<NewProtocol>${m.protocol}</NewProtocol><NewInternalPort>${m.internalPort}</NewInternalPort>`
        + `<NewInternalClient>${m.internalClient}</NewInternalClient><NewEnabled>1</NewEnabled>`
        + `<NewPortMappingDescription>${m.description}</NewPortMappingDescription>`
        + `<NewLeaseDuration>${m.lease}</NewLeaseDuration>`));
    }
    send(500, soapErr(401, 'Invalid Action'));
  });
});

const assert = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else { console.log('  ✗ ' + msg); process.exitCode = 1; }
};

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}/`;
  try {
    console.log('== 1. 描述解析 ==');
    const xml = await new Promise(r => http.get(base + 'desc.xml', res => {
      let d = ''; res.on('data', c => (d += c)); res.on('end', () => r(d));
    }));
    const gw = upnp._parseDescription(xml, base + 'desc.xml');
    assert(!!gw, '找到 WANIPConnection 服务');
    assert(gw.friendlyName === 'HY 测试路由器', 'friendlyName 解析正确: ' + gw.friendlyName);
    assert(gw.serviceType === 'urn:schemas-upnp-org:service:WANIPConnection:1', 'serviceType 正确');
    assert(gw.controlUrl === base + 'ctl/ip', 'controlURL 绝对化正确: ' + gw.controlUrl);

    console.log('== 2. 外网 IP ==');
    const ip = await upnp.getExternalIp(gw);
    assert(ip === '203.0.113.7', 'GetExternalIPAddress = ' + ip);

    console.log('== 3. 添加映射 ==');
    const added = await upnp.addMapping(gw, { externalPort: 25565, internalPort: 25565, internalClient: '192.168.1.10', protocol: 'tcp', description: 'HMCS 测试' });
    assert(added.protocol === 'TCP', '协议归一化为 TCP');
    assert(state.mappings.length === 1, '网关侧已写入 1 条映射');
    assert(state.mappings[0].internalClient === '192.168.1.10', '内网 IP 正确传入');
    assert(state.calls.find(c => c.action === 'AddPortMapping').soapAction === '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"', 'SOAPAction 头正确');

    console.log('== 4. 端口冲突自动覆盖 ==');
    const again = await upnp.addMapping(gw, { externalPort: 25565, internalPort: 25565, internalClient: '192.168.1.99', protocol: 'TCP', description: 'HMCS 覆盖' });
    assert(state.mappings.length === 1, '没有产生重复条目（先删后加）');
    assert(state.mappings[0].internalClient === '192.168.1.99', '映射已被覆盖到新内网 IP');
    assert(again.externalPort === 25565, '返回外网端口正确');

    console.log('== 5. 列表遍历 ==');
    await upnp.addMapping(gw, { externalPort: 19132, protocol: 'UDP', internalPort: 19132, internalClient: '192.168.1.10' });
    const list = await upnp.listMappings(gw);
    assert(list.length === 2, '读到 2 条映射（713 结束遍历）');
    assert(list.some(m => m.protocol === 'UDP' && m.externalPort === 19132), 'UDP 条目存在');

    console.log('== 6. 租期不支持时回退 0 ==');
    state.failLease = true;
    state.mappings = [];
    const r2 = await upnp.addMapping(gw, { externalPort: 25566, internalPort: 25566, lease: 3600, internalClient: '192.168.1.10' });
    assert(r2.lease === 0, '租期自动回退为 0（永久）');
    assert(state.mappings[0].lease === 0, '网关侧记录租期为 0');
    state.failLease = false;

    console.log('== 7. 删除映射 ==');
    await upnp.deleteMapping(gw, { externalPort: 25566, protocol: 'TCP' });
    assert(!state.mappings.some(m => m.externalPort === 25566), '已删除 25566');
    let err714 = null;
    try { await upnp.deleteMapping(gw, { externalPort: 25566, protocol: 'TCP' }); } catch (e) { err714 = e; }
    assert(err714 && err714.upnpCode === 714, '重复删除返回 714 且被翻译: ' + (err714 && err714.message));

    console.log('== 8. 参数校验 ==');
    let bad = null;
    try { await upnp.addMapping(gw, { externalPort: 70000 }); } catch (e) { bad = e.message; }
    assert(/1-65535/.test(bad || ''), '非法端口被拒绝: ' + bad);

    console.log('== 9. 本机 IPv4 ==');
    const lip = await upnp.localIpv4();
    assert(/^\d+\.\d+\.\d+\.\d+$/.test(lip) && lip !== '0.0.0.0', '取到本机 IP: ' + lip);
  } catch (e) {
    console.log('  ✗ 异常: ' + e.message);
    process.exitCode = 1;
  } finally {
    srv.close();
    console.log(process.exitCode ? '\n存在失败项' : '\n全部通过');
  }
});
