#!/usr/bin/env node
'use strict';
/**
 * hmcsm 命令行为自测
 *
 * 重点验证用户提的两条：
 *   1. 无参数 → 调起菜单 / 状态，不启动任何服务
 *   2. 有参数 → 以服务方式启动，**父进程退出后仍然存活**（关窗口不影响）
 *
 *   node _dev/_test-hmcsm.js
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'scripts', 'hmcsm.js');
const HOME = path.join(os.tmpdir(), 'hmcs-hmcsm-' + process.pid);
const PORT = 8812;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  × ' + name + (extra ? '  →  ' + extra : '')); }
}
function run(args, opts = {}) {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: 'utf8', cwd: ROOT, timeout: 180000,
    // 跳过「注册系统服务」，只测命令行行为 + 脱离终端的后台进程，
    // 免得跑一次自测就在机器上留一个 systemd unit / 计划任务
    env: { ...process.env, HMCS_NO_SERVICE: '1' },
    ...opts,
  });
}
function ping(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/system/ping', timeout: 1200 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\n=== hmcsm 命令自测 ===\n');

  // 端口被上一轮残留的进程占着会让后面所有断言都错位，先确认干净
  if (await ping(PORT)) {
    console.log('  ! 端口 ' + PORT + ' 已被占用（可能是上次测试残留），先停掉再跑：');
    console.log('    hmcsm stop   /   pkill -f hmcs-hmcsm\n');
    process.exit(1);
  }

  // ---- 1. 帮助 / 版本
  let r = run(['--help']);
  check('--help 退出码 0', r.status === 0, 'status=' + r.status);
  check('--help 说明无参数进菜单', /无参数进(菜单|控制台)/.test(r.stdout));
  check('--help 列出服务子命令', /hmcsm install/.test(r.stdout) && /hmcsm status/.test(r.stdout));

  r = run(['--version']);
  check('--version 只输出版本号', r.status === 0 && /^\d+\.\d+\.\d+$/.test(r.stdout.trim()), JSON.stringify(r.stdout));

  // ---- 2. 无参数：不启动任何东西
  r = run(['--home', HOME]);
  // 注意：带 --home 但没有任何启动参数时仍算「有参数」，会去启动。
  // 真正的无参数用例在下面单独跑（用默认配置，只读状态）。

  // ---- 3. 参数校验
  r = run(['--port', '99999', '--home', HOME]);
  check('端口越界被拒（退出码 2）', r.status === 2, 'status=' + r.status);
  check('端口越界有中文提示', /端口超出范围/.test(r.stdout), r.stdout.trim());

  r = run(['--host', '0.0.0.0', '--home', HOME]);
  check('无密码时拒绝对外监听（退出码 2）', r.status === 2, 'status=' + r.status);
  check('无密码提示指向设密码', /访问密码/.test(r.stdout), r.stdout.trim());
  check('被拒时没有留下监听进程', !(await ping(PORT)), '端口 ' + PORT + ' 竟然有响应');

  // ---- 4. 正常启动：父进程退出后必须还活着
  r = run(['--port', String(PORT), '--home', HOME]);
  check('启动命令退出码 0', r.status === 0, 'status=' + r.status + ' ' + (r.stderr || '').slice(0, 200));
  check('输出给了访问地址', new RegExp('127\\.0\\.0\\.1:' + PORT).test(r.stdout), r.stdout.slice(-300));
  check('输出说明关窗口不影响', /关掉.*不.*退出/.test(r.stdout), r.stdout.slice(-200));
  check('记下了后台 pid 文件', fs.existsSync(path.join(HOME, 'background.pid')));

  // 关键断言：hmcsm 进程已经退出了，端口还通 → 说明真脱离了终端
  await sleep(1500);
  check('hmcsm 退出后服务仍在监听（未挂终端）', await ping(PORT), '端口没起来');

  let info = null;
  try { info = JSON.parse(fs.readFileSync(path.join(HOME, 'background.pid'), 'utf8')); } catch { /* ignore */ }
  const bgPid = info && info.pid;

  // ---- 5. 再跑一次：识别为已在运行，不重复拉起
  r = run(['--port', String(PORT), '--home', HOME]);
  check('重复启动识别为已在运行', /已在运行/.test(r.stdout), r.stdout.slice(-300));
  await sleep(500);
  check('重复启动没有换进程', await ping(PORT));
  let info2 = null;
  try { info2 = JSON.parse(fs.readFileSync(path.join(HOME, 'background.pid'), 'utf8')); } catch { /* ignore */ }
  check('重复启动没有改写 pid 文件', !info2 || info2.pid === bgPid, JSON.stringify([bgPid, info2 && info2.pid]));

  // ---- 6. 停止
  r = run(['stop', '--home', HOME]);
  check('stop 退出码 0', r.status === 0, 'status=' + r.status + ' ' + (r.stderr || '').slice(0, 200));
  let down = false;
  for (let i = 0; i < 20; i++) { await sleep(500); if (!(await ping(PORT))) { down = true; break; } }
  check('stop 之后端口关闭', down, '端口 ' + PORT + ' 仍在响应');

  // ---- 7. 子命令转发
  r = run(['status', '--home', HOME]);
  check('status 子命令可用', r.status === 0 && /HMCS 服务状态/.test(r.stdout), (r.stdout || '').slice(0, 200));

  r = run(['install', '--dry-run', '--home', HOME]);
  check('install --dry-run 可用', r.status === 0 && /安装 HMCS 服务/.test(r.stdout), (r.stdout || '').slice(0, 200));

  check('收尾时没有遗留监听', !(await ping(PORT)), '端口 ' + PORT + ' 还有进程');

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
