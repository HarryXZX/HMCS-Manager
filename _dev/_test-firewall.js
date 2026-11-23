#!/usr/bin/env node
'use strict';
/**
 * lib/firewall.js 自测。
 *
 * 用一个假的 spawnSync 顶替真实命令：模拟「管理员 / 非管理员」「规则存在 / 不存在」
 * 「端口变更」「规则被外部删掉」等场景，验证状态文件与命令调用是否对得上。
 * 不会真的改系统防火墙。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = path.join(os.tmpdir(), 'hmcs-fw-test-' + process.pid);
fs.rmSync(HOME, { recursive: true, force: true });
process.env.HMCS_HOME = HOME;

const fw = require('../lib/firewall');
const paths = require('../lib/paths');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  × ' + name + (extra ? '  → ' + extra : '')); }
}

// ---------------------------------------------------------------- 假执行器
let calls = [];
const world = { elevated: true, rules: new Set(), failAdd: false };

function fake(cmd, args) {
  const line = [cmd, ...args].join(' ');
  calls.push(line);
  const ok = (out = '') => ({ status: 0, stdout: out, stderr: '' });
  const no = (out = '') => ({ status: 1, stdout: '', stderr: out });

  if (cmd === 'fltmc') return world.elevated ? ok() : no('Access is denied.');
  if (cmd === 'net') return world.elevated ? ok() : no('Access is denied.');

  if (cmd === 'netsh') {
    const s = args.join(' ');
    if (s.includes('add rule')) {
      if (world.failAdd) return no('The requested operation requires elevation.');
      const m = /localport=(\d+)/.exec(s);
      if (m) world.rules.add(Number(m[1]));
      return ok('Ok.\n');
    }
    if (s.includes('delete rule')) {
      if (!world.rules.size) return no('No rules match the specified criteria.');
      world.rules.clear();
      return ok('Ok.\n');
    }
    if (s.includes('show rule')) {
      return world.rules.size ? ok('Rule Name: HMCS-WebUI\n') : no('No rules match the specified criteria.');
    }
  }
  return no('unexpected: ' + line);
}

const install = () => { fw.__setRunner(fake); calls = []; };
const stateOf = () => {
  try { return JSON.parse(fs.readFileSync(fw.STATE_FILE, 'utf8')); } catch { return {}; }
};
const reset = () => { world.rules.clear(); fs.rmSync(fw.STATE_FILE, { force: true }); };

// ---------------------------------------------------------------- 1. 探测
console.log('\n[1] 探测与命令构造');
install();
const d = fw.detect(true);
check('Windows 识别为 netsh', d.backend === 'netsh' && d.active === true, JSON.stringify(d));
check('管理员身份被识别', d.elevated === true);
check('netsh add 命令正确', fw.rawArgs('netsh', 'add', 8720).join(' ').includes('localport=8720'));
check('netsh delete 按固定规则名', fw.rawArgs('netsh', 'del', 8720).includes('name=HMCS-WebUI'));
check('ufw add 带 comment', fw.rawArgs('ufw', 'add', 8720).join(' ').includes('comment HMCS-WebUI'));
check('ufw delete 带 --force', fw.rawArgs('ufw', 'del', 8720).includes('--force'));
check('firewalld 用 permanent 端口', fw.rawArgs('firewalld', 'add', 8720).includes('--add-port=8720/tcp'));
const isWin = process.platform === 'win32';
check('手动命令前缀符合平台', isWin
  ? !fw.manualCommand('ufw', 'add', 8720).startsWith('sudo ')
  : fw.manualCommand('ufw', 'add', 8720).startsWith('sudo '));

// ---------------------------------------------------------------- 2. 开启公网
console.log('\n[2] 开启公网访问 → 放行');
reset(); install();
let r = fw.sync({ host: '0.0.0.0', port: 8720 });
check('返回 ok 且 changed', r.ok === true && r.changed === true, JSON.stringify(r.actions));
check('状态文件记录 8720', stateOf().port === 8720 && stateOf().backend === 'netsh');
check('假防火墙里有 8720', world.rules.has(8720));
check('确实执行了 add rule', calls.some(c => c.includes('add rule') && c.includes('localport=8720')));

// ---------------------------------------------------------------- 3. 幂等
console.log('\n[3] 重复同步 → 跳过');
const before = calls.length;
r = fw.sync({ host: '0.0.0.0', port: 8720 });
check('第二次 skipped', r.skipped === true && r.changed === false);
const adds = calls.slice(before).filter(c => c.includes('add rule')).length;
check('没有再执行 add rule', adds === 0, 'adds=' + adds);

// ---------------------------------------------------------------- 4. 端口变更
console.log('\n[4] 改端口 → 删旧加新');
r = fw.sync({ host: '0.0.0.0', port: 9000 });
check('返回 changed', r.changed === true);
check('旧端口已移除、新端口已加', !world.rules.has(8720) && world.rules.has(9000), JSON.stringify([...world.rules]));
check('状态文件跟到 9000', stateOf().port === 9000);

// ---------------------------------------------------------------- 5. 改回仅本机
console.log('\n[5] 改回仅本机 → 收回规则');
r = fw.sync({ host: '127.0.0.1', port: 9000 });
check('返回 changed', r.changed === true);
check('规则已被删除', world.rules.size === 0, JSON.stringify([...world.rules]));
check('状态文件已清空', !stateOf().port);
check('再次同步直接跳过', fw.sync({ host: '127.0.0.1', port: 9000 }).skipped === true);

// ---------------------------------------------------------------- 6. 非管理员
console.log('\n[6] 非管理员 → needsPrivilege + 手动命令');
reset(); world.elevated = false; world.failAdd = true; install();
r = fw.sync({ host: '0.0.0.0', port: 8720 });
check('未成功', r.ok === false && r.needsPrivilege === true);
check('没有写入状态文件（避免误以为已放行）', !stateOf().port);
check('给出了手动命令', (r.manual || []).some(x => x.includes('localport=8720')), JSON.stringify(r.manual));
check('有可读的 warning', /防火墙/.test(r.warning || ''), r.warning);

// ---------------------------------------------------------------- 7. 规则被外部删掉
console.log('\n[7] 规则被外部清除 → 自动重建');
reset(); world.elevated = true; world.failAdd = false; install();
fw.sync({ host: '0.0.0.0', port: 8720 });
world.rules.clear();               // 模拟被安全软件清掉
r = fw.sync({ host: '0.0.0.0', port: 8720 });
check('检测到缺失并重建', r.changed === true && world.rules.has(8720), JSON.stringify(r.actions));

// ---------------------------------------------------------------- 8. 状态与描述
console.log('\n[8] status / describe');
const st = fw.status({ host: '0.0.0.0', port: 8720 });
check('inSync 为真', st.inSync === true, JSON.stringify(st));
check('describe 提到已放行', /已放行/.test(fw.describe({ host: '0.0.0.0', port: 8720 })));
check('仅本机 describe 不提「已放行」', !/已放行/.test(fw.describe({ host: '127.0.0.1', port: 8720 })),
  fw.describe({ host: '127.0.0.1', port: 8720 }));
check('statePort 读到 8720', fw.statePort() === 8720);

// ---------------------------------------------------------------- 9. removeAll
console.log('\n[9] removeAll');
r = fw.removeAll();
check('移除成功', r.ok === true && r.removed === true, JSON.stringify(r));
check('规则与状态都清空', world.rules.size === 0 && !stateOf().port);

// ---------------------------------------------------------------- 收尾
fw.__resetRunner();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + (fail ? `✗ ${fail} 项失败 / ${pass + fail}` : `✓ 全部通过（${pass} 项）`) + '\n');
process.exitCode = fail ? 1 : 0;
