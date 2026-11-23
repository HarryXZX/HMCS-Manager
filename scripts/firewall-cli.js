#!/usr/bin/env node
'use strict';
/**
 * 防火墙命令行入口。
 *
 *   hmcsm firewall                 查看规则状态
 *   hmcsm firewall sync            按 settings.json 同步（开公网就放行，仅本机就收回）
 *   hmcsm firewall on              强制放行当前端口（不管 settings 里的 host）
 *   hmcsm firewall off             撤掉 HMCS 建过的所有规则
 *   hmcsm firewall sync --force    忽略幂等判断，重建规则
 *
 * 也是 Windows 提权时跑的脚本：菜单检测到本地权限不够，就用
 * Start-Process -Verb RunAs 拉起本脚本的 sync，结果写进状态文件，
 * 菜单回来复查状态即可，不需要把提权窗口的输出接回来。
 *
 * --home 必须在 require lib/paths 之前处理，跟 app.js 一样。
 */
const path = require('path');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--home' && argv[i + 1]) { process.env.HMCS_HOME = path.resolve(argv[i + 1]); break; }
  if (argv[i].startsWith('--home=')) { process.env.HMCS_HOME = path.resolve(argv[i].slice(7)); break; }
}

const paths = require('../lib/paths');
const fw = require('../lib/firewall');

const opts = { host: '', port: 0, json: false, force: false };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') opts.json = true;
  else if (a === '--force') opts.force = true;
  else if (a === '--host' || a === '-H') opts.host = argv[++i] || '';
  else if (a.startsWith('--host=')) opts.host = a.slice(7);
  else if (a === '--port' || a === '-p') opts.port = Number(argv[++i]) || 0;
  else if (a.startsWith('--port=')) opts.port = Number(a.slice(7)) || 0;
  else if (a === '--home') i++;
  else if (a.startsWith('--home=')) { /* 上面已处理 */ }
  else rest.push(a);
}
const cmd = (rest[0] || 'status').toLowerCase();
const settings = paths.readSettings();
const host = opts.host || paths.normalizeHost(settings.host);
const port = opts.port || Number(settings.port) || 8720;
const onLog = s => { if (!opts.json) console.log(s); };

let r;
if (cmd === 'status') {
  r = { cmd, ...fw.status({ host, port }), describe: fw.describe({ host, port }) };
} else if (cmd === 'sync') {
  r = { cmd, ...fw.sync({ host, port, force: opts.force, onLog }) };
} else if (cmd === 'on') {
  r = { cmd, ...fw.sync({ host: '0.0.0.0', port, force: opts.force, onLog }) };
} else if (cmd === 'off') {
  r = { cmd, ...fw.removeAll({ onLog }) };
} else {
  r = { cmd, ok: false, error: '未知子命令：' + cmd + '（可用 status / sync / on / off）' };
}

if (opts.json) {
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'status') {
  console.log('');
  console.log('  防火墙规则  ' + r.describe);
  console.log('  规则名称    ' + r.rule);
  console.log('  使用后端    ' + (r.backend === 'none' ? '无（当前不拦入站）' : r.backend));
  console.log('  目标端口    ' + (r.needed ? 'TCP ' + r.desiredPort : '不需要放行（仅本机监听）'));
  console.log('  已建规则    ' + (r.state.port ? `TCP ${r.state.port}（${r.state.backend}）` : '无'));
  if (r.reason) console.log('  说明        ' + r.reason);
  console.log('');
} else if (r.ok === false || r.needsPrivilege) {
  console.log('  × ' + (r.warning || r.error || r.reason || '同步失败'));
  for (const h of r.manual || []) console.log('      ' + h);
  console.log('');
  console.log('  也可以：以管理员 / root 身份运行  hmcsm firewall sync');
} else {
  console.log('  ✓ ' + (r.reason || (r.needed ? `已放行 TCP ${port}` : '已收回放行规则')));
}

process.exitCode = (r.ok === false || r.error) ? 1 : 0;
