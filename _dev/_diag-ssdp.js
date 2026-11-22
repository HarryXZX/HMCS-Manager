'use strict';
// 诊断：对比「不指定网卡」与「逐网卡指定」两种组播发送方式
const dgram = require('dgram');
const os = require('os');

const SSDP = '239.255.255.250';
const PORT = 1900;

function ifaceList() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ name, address: a.address });
    }
  }
  return out;
}

function search({ iface, st, label, wait = 3000 }) {
  return new Promise(resolve => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const got = [];
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      try { sock.close(); } catch {}
      resolve(got);
    };
    const timer = setTimeout(finish, wait);
    sock.on('message', (msg, rinfo) => {
      const t = msg.toString('utf8');
      got.push({ from: rinfo.address + ':' + rinfo.port, head: t.split('\r\n')[0], loc: (t.match(/LOCATION:\s*(\S+)/i) || [])[1] || '', st: (t.match(/\r\nST:\s*(.+)/i) || [])[1] || '' });
    });
    sock.on('error', e => { clearTimeout(timer); finish(); });
    sock.bind(() => {
      if (iface) { try { sock.setMulticastInterface(iface); } catch (e) { console.log('  setMulticastInterface 失败:', e.message); } }
      try { sock.setMulticastTTL(2); } catch {}
      const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP}:${PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
      try { sock.send(msg, 0, msg.length, PORT, SSDP); } catch (e) { console.log('  send 失败:', e.message); }
    });
  });
}

(async () => {
  const ifs = ifaceList();
  console.log('本机网卡:', ifs.map(i => `${i.name}=${i.address}`).join(' | '));
  console.log();

  console.log('=== A. 不指定网卡（当前代码的行为，仅 upnp:rootdevice）===');
  let r = await search({ st: 'upnp:rootdevice', wait: 3200 });
  console.log('   收到响应:', r.length);
  r.slice(0, 5).forEach(x => console.log('   ', x.from, x.st, x.loc));

  console.log();
  console.log('=== B. 不指定网卡，ST: ssdp:all ===');
  r = await search({ st: 'ssdp:all', wait: 3200 });
  console.log('   收到响应:', r.length);
  r.slice(0, 5).forEach(x => console.log('   ', x.from, x.st, x.loc));

  console.log();
  for (const i of ifs) {
    console.log(`=== C. 指定网卡 ${i.name} (${i.address})，ST: ssdp:all ===`);
    r = await search({ iface: i.address, st: 'ssdp:all', wait: 3200 });
    console.log('   收到响应:', r.length);
    r.slice(0, 6).forEach(x => console.log('   ', x.from, x.st, x.loc));
    console.log();
  }
})();
