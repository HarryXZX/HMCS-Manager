#!/usr/bin/env node
'use strict';
/**
 * 服务安装状态探测 回归测试
 *
 * 覆盖：PowerShell 探测标记解析、schtasks 归类、多源交叉判定、
 *       status --json 解析（含告警噪声 / 非零退出 / spawn 失败）、
 *       以及用假证据跑完整 CLI 链路（不触发 PowerShell / schtasks）。
 *
 * 全程只读 + 临时环境变量，不会安装/卸载/启停任何服务。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const I = require(path.join(ROOT, 'scripts', 'install-state'));
const SERVICE = path.join(ROOT, 'scripts', 'service.js');
const HMC = path.join(ROOT, 'scripts', 'hmcsm.js');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
};
const section = s => console.log('\n[' + s + ']');

const saved = { backend: 'schtasks', installedAt: '2026-11-23T10:30:44.513Z', autostart: true };
const unavail = { kind: 'unavailable', state: '', detail: 'cmdlet 不可用' };
const absent = { kind: 'absent', state: '', detail: '' };
const st = s => ({ kind: 'state', state: s, detail: '' });

// ---------------------------------------------------------------- 1
section('1. PowerShell 探测输出解析');
{
  let r = I.parsePowerShellProbe({ out: 'HMCS_STATE=Ready', code: 0 });
  check('精确状态 Ready', r.kind === 'state' && r.state === 'Ready', JSON.stringify(r));

  r = I.parsePowerShellProbe({ out: 'HMCS_STATE=Running', code: 0 });
  check('精确状态 Running', r.kind === 'state' && r.state === 'Running');

  r = I.parsePowerShellProbe({ out: 'HMCS_STATE=Disabled', code: 0 });
  check('精确状态 Disabled', r.kind === 'state' && r.state === 'Disabled');

  r = I.parsePowerShellProbe({ out: '某条警告\nHMCS_STATE=Queued\n', code: 0 });
  check('多行噪声中取标记行', r.kind === 'state' && r.state === 'Queued', JSON.stringify(r));

  r = I.parsePowerShellProbe({ out: 'HMCS_ABSENT', code: 0 });
  check('明确不存在 → absent', r.kind === 'absent');

  r = I.parsePowerShellProbe({ out: 'HMCS_UNAVAILABLE', code: 0 });
  check('cmdlet 不可用 → unavailable', r.kind === 'unavailable');

  r = I.parsePowerShellProbe({ out: '', code: 1 });
  check('空输出不能当成 absent（旧 bug 核心）', r.kind === 'unavailable', JSON.stringify(r));

  r = I.parsePowerShellProbe({ out: 'MISSING', code: 0 });
  check('旧式裸 MISSING 不再被信任', r.kind === 'unavailable', JSON.stringify(r));

  r = I.parsePowerShellProbe({ out: 'HMCS_STATE=Bogus', code: 0 });
  check('未知状态值 → unavailable', r.kind === 'unavailable');

  r = I.parsePowerShellProbe({ out: 'HMCS_STATE=Ready', code: 0, error: 'spawn EPERM' });
  check('spawn 报错优先判 unavailable', r.kind === 'unavailable');
}

// ---------------------------------------------------------------- 2
section('2. schtasks /Query 归类');
{
  check('退出码 0 → exists', I.classifySchtasks({ code: 0, out: '任务名: HMCS' }) === 'exists');
  check('中文「系统找不到」→ absent', I.classifySchtasks({ code: 1, err: '错误: 系统找不到指定的文件。' }) === 'absent');
  check('英文 cannot find → absent', I.classifySchtasks({ code: 1, out: 'ERROR: The system cannot find the file specified.' }) === 'absent');
  check('「找不到」→ absent', I.classifySchtasks({ code: 1, err: '找不到' }) === 'absent');
  check('权限被拒不能当成不存在', I.classifySchtasks({ code: 1, err: 'Permission denied' }) === 'unavailable');
  check('spawn error → unavailable', I.classifySchtasks({ code: -1, error: 'blocked' }) === 'unavailable');
  check('无结果对象 → unavailable', I.classifySchtasks(null) === 'unavailable');
}

// ---------------------------------------------------------------- 3
section('3. 多源交叉判定');
{
  let d = I.resolveWindowsInstall({ ps: st('Ready'), taskFile: false, saved: null, schtasks: 'unavailable' });
  check('实时 Ready → 已安装且确定', d.installed && d.reliable && !d.uncertain, JSON.stringify(d));
  check('Real source 标注实时查询', /实时查询/.test(d.source), d.source);

  d = I.resolveWindowsInstall({ ps: st('Running'), taskFile: null, saved: null, schtasks: 'unavailable' });
  check('Running → running=true', d.running === true);
  check('Running → 自启开启', d.autostart === true);

  d = I.resolveWindowsInstall({ ps: st('Disabled'), taskFile: null, saved: null, schtasks: 'unavailable' });
  check('Disabled → 已安装但不自启', d.installed && !d.autostart, JSON.stringify(d));

  // 用户实际遇到的场景：查询接口不可用，但 service.json 有安装存档
  d = I.resolveWindowsInstall({ ps: unavail, taskFile: null, saved, schtasks: 'unavailable' });
  check('★ 查询失败 + 有存档 → 已安装（不再误报未安装）', d.installed === true, JSON.stringify(d));
  check('★ 明确标注未确认', d.uncertain === true && d.reliable === false);
  check('★ 依据写明安装存档', /存档/.test(d.source), d.source);
  check('★ autostart 沿存档', d.autostart === true);

  // 任务定义文件是铁证
  d = I.resolveWindowsInstall({ ps: absent, taskFile: true, saved: null, schtasks: 'unavailable' });
  check('★ 实时说没有但任务文件在 → 已安装', d.installed === true, JSON.stringify(d));
  check('★ 依据任务定义文件', /任务定义文件/.test(d.source), d.source);

  d = I.resolveWindowsInstall({ ps: unavail, taskFile: true, saved: null, schtasks: 'exists' });
  check('任务文件 + schtasks 命中 → 已安装且确定', d.installed && !d.uncertain, JSON.stringify(d));

  // 真没装：实时明确 absent + 文件明确不存在
  d = I.resolveWindowsInstall({ ps: absent, taskFile: false, saved: null, schtasks: 'absent' });
  check('明确不存在 → 未安装且确定', !d.installed && d.reliable && !d.uncertain, JSON.stringify(d));

  d = I.resolveWindowsInstall({ ps: absent, taskFile: false, saved, schtasks: 'absent' });
  check('任务被手工删了 → 以实时查询为准判未安装', !d.installed && d.reliable, JSON.stringify(d));
  check('存档过期有提示', /过期/.test(d.raw), d.raw);

  // 什么都没有：如实说不知道，而不是假称未安装
  d = I.resolveWindowsInstall({ ps: unavail, taskFile: null, saved: null, schtasks: 'unavailable' });
  check('全查不了且无存档 → uncertain=true', d.uncertain === true, JSON.stringify(d));
  check('全查不了不声称可靠', d.reliable === false);

  d = I.resolveWindowsInstall({ ps: unavail, taskFile: false, saved: null, schtasks: 'exists' });
  check('schtasks 命中即可判已安装', d.installed === true, JSON.stringify(d));

  const savedOff = { ...saved, autostart: false };
  d = I.resolveWindowsInstall({ ps: unavail, taskFile: null, saved: savedOff, schtasks: 'unavailable' });
  check('存档不自启 → autostart=false', d.autostart === false, JSON.stringify(d));
}

// ---------------------------------------------------------------- 4
section('4. status --json 输出解析');
{
  const good = JSON.stringify({ ok: true, installed: true, running: false, autostart: true, canInstall: false });
  let r = I.parseProbeOutput(good, 0, '');
  check('单行 JSON 正常解析', r.installed === true && !r.probeFailed);

  r = I.parseProbeOutput('警告: 某模块加载失败\n' + good, 0, '');
  check('前面有噪声行仍能解析', r.installed === true && !r.probeFailed, JSON.stringify(r));

  r = I.parseProbeOutput('正在查询…\n' + good + '\n', 0, '');
  check('末尾空行不影响', r.installed === true);

  r = I.parseProbeOutput('', 0, 'spawn EPERM');
  check('spawn 失败 → probeFailed', r.probeFailed === true && r.installed === false, JSON.stringify(r));

  r = I.parseProbeOutput('不是 JSON', 0, '');
  check('非 JSON 输出 → probeFailed（不再静默 null）', r.probeFailed === true, JSON.stringify(r));

  r = I.parseProbeOutput(good, 2, '');
  check('非零退出码 → probeFailed', r.probeFailed === true, JSON.stringify(r));
  check('非零退出码仍保留解析到的 installed', r.installed === true);

  r = I.parseProbeOutput('[1,2,3]', 0, '');
  check('无关 JSON 数组不算状态', r.probeFailed === true);

  r = I.parseProbeOutput('{"ok":true,"probeFailed":true,"installed":false}', 0, '');
  check('上游自报 probeFailed 能被识别', r.probeFailed === true);
}

// ---------------------------------------------------------------- 5
section('5. 完整 CLI 链路（注入假证据，不触发任何外部命令）');
{
  const runCli = (script, args, evidence) => spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, HMCS_TEST_TASK_EVIDENCE: JSON.stringify(evidence) },
  });

  // 场景 A：用户当前遇到的 —— 查询接口不可用，有安装存档
  const evA = { ps: unavail, taskFile: null, saved, schtasks: 'unavailable' };
  let r = runCli(SERVICE, ['status', '--json'], evA);
  check('service.js status --json 退出码 0', r.status === 0, String(r.stderr || '').slice(0, 200));
  let j = null;
  try { j = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch { /* handled below */ }
  check('★ CLI 输出 installed=true（修复前是 false）', j && j.installed === true, String(r.stdout || '').slice(0, 300));
  check('★ CLI 输出 installUncertain=true', j && j.installUncertain === true);
  check('★ CLI 输出判定依据', j && /存档/.test(j.installSource || ''), j && j.installSource);
  check('CLI 未把查询失败说成「未安装」', j && !/未安装/.test(j.raw || ''), j && j.raw);

  // 场景 B：实时查询正常返回 Ready
  const evB = { ps: st('Ready'), taskFile: false, saved: null, schtasks: 'unavailable' };
  r = runCli(SERVICE, ['status', '--json'], evB);
  try { j = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch { j = null; }
  check('实时 Ready → installed=true 且确定', j && j.installed === true && j.installUncertain === false, String(r.stdout || '').slice(0, 300));
  check('实时 Ready → 依据实时查询', j && /实时查询/.test(j.installSource || ''));

  // 场景 C：确实没装
  const evC = { ps: absent, taskFile: false, saved: null, schtasks: 'absent' };
  r = runCli(SERVICE, ['status', '--json'], evC);
  try { j = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch { j = null; }
  check('确实没装 → installed=false 且确定', j && j.installed === false && j.installUncertain === false, String(r.stdout || '').slice(0, 300));

  // 人类可读输出
  r = runCli(SERVICE, ['status'], evA);
  const human = String(r.stdout || '');
  check('人类可读状态含「判定依据」', /判定依据/.test(human), human.slice(0, 300));
  check('人类可读状态含「实时状态未确认」', /实时状态未确认/.test(human));
  check('人类可读状态不误写「安装 否」', !/安装\s+否/.test(human), human.slice(0, 300));

  // 遥控器入口
  r = runCli(HMC, ['status'], evA);
  const hmcOut = String(r.stdout || '');
  check('hmcsm status 显示「是」', /安装\s+是/.test(hmcOut), hmcOut.slice(0, 400));
  check('hmcsm status 显示判定依据', /判定依据/.test(hmcOut));
}

// ---------------------------------------------------------------- 6
section('6. 源码接线静态断言');
{
  const svc = fs.readFileSync(SERVICE, 'utf8');
  const menu = fs.readFileSync(path.join(ROOT, 'scripts', 'menu.js'), 'utf8');
  const hmc = fs.readFileSync(HMC, 'utf8');
  const state = fs.readFileSync(path.join(ROOT, 'scripts', 'install-state.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const svcCode = svc.replace(/^\s*\*.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  check('旧的一刀切 catch MISSING 已移除', !/catch\s*\{\s*'MISSING'\s*\}/.test(svcCode));
  check('不再用 -ErrorAction Stop 一刀切', !/-ErrorAction Stop/.test(svcCode));
  check('service.js 接入 resolveWindowsInstall', /INSTALL\.resolveWindowsInstall/.test(svc));
  check('service.js 读任务定义文件', /readTaskFile/.test(svc));
  check('service.js 使用安装存档 SAVED', /saved:\s*SAVED/.test(svc));
  check('--json 输出 installSource', /installSource:\s*d\.installSource/.test(svc));
  check('--json 输出 installUncertain', /installUncertain/.test(svc));
  check('menu.js 用 parseProbeOutput', /INSTALL\.parseProbeOutput/.test(menu));
  check('hmcsm.js 用 parseProbeOutput', /INSTALL\.parseProbeOutput/.test(hmc));
  check('menu.js 状态区分「状态未知」', /状态未知/.test(menu));
  check('hmcsm.js 有 probeFailed 保守分支', /probeFailed/.test(hmc));
  check('纯逻辑模块含判定表', /resolveWindowsInstall/.test(state));
  check('版本号 0.3.12', pkg.version === '0.3.12', pkg.version);
  // 本次热修复不得触碰服务端本体
  check('新逻辑模块在 scripts/ 下（不碰 app.js）', fs.existsSync(path.join(ROOT, 'scripts', 'install-state.js')));
}

// ---------------------------------------------------------------- 7
section('7. 启动决策语义（回归：installed 只用于展示，uncertain 用于决策）');
{
  check('实时确认已安装 → 交给服务管理器',
    I.shouldUseServiceManager({ installed: true, installUncertain: false }) === true);
  check('★ 存档佐证但不确定 → 不交给服务管理器（否则 schtasks /Run 必失败）',
    I.shouldUseServiceManager({ installed: true, installUncertain: true }) === false);
  check('probeFailed → 不交给服务管理器',
    I.shouldUseServiceManager({ installed: true, probeFailed: true }) === false);
  check('未安装 → 不交给服务管理器',
    I.shouldUseServiceManager({ installed: false }) === false);
  check('空对象 / null → false',
    I.shouldUseServiceManager({}) === false && I.shouldUseServiceManager(null) === false);
  check('Linux/mac 实时判定同样适用（无 uncertain 字段）',
    I.shouldUseServiceManager({ installed: true, running: false }) === true);

  const svc = fs.readFileSync(path.join(ROOT, 'scripts', 'service.js'), 'utf8');
  const menu = fs.readFileSync(path.join(ROOT, 'scripts', 'menu.js'), 'utf8');
  const hmc = fs.readFileSync(path.join(ROOT, 'scripts', 'hmcsm.js'), 'utf8');

  check('cmdStart 用 shouldUseServiceManager 决策', /INSTALL\.shouldUseServiceManager\(d\)/.test(svc));
  check('★ 存在直接拉起 app.js 的后台兜底', /startAsBackground/.test(svc) && /spawnDetached/.test(svc));
  check('★ 服务管理器失败会自动回退', /自动回退/.test(svc));
  check('cmdStart 不再单纯按 installed 分支', !/if \(!d\.installed\) \{[\s\S]{0,200}spawnDetached/.test(svc));
  check('menu actStart 用决策函数', /INSTALL\.shouldUseServiceManager\(st\)/.test(menu));
  check('menu actRestart 用决策函数', /const useSvc = INSTALL\.shouldUseServiceManager\(st\)/.test(menu));
  check('hmcsm bootByService 用决策函数', /INSTALL\.shouldUseServiceManager\(p\)/.test(hmc));
  check('hmcsm 对「已装但不确定」跳过自动注册', /p\.installed && p\.installUncertain/.test(hmc));
  check('卸载对「仅存档佐证」容错', /installUncertain/.test(svc) && /计划任务已不存在/.test(svc));
}

console.log('\n' + '='.repeat(48));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exit(1);
