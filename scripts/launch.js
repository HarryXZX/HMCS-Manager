'use strict';
/**
 * 把一个 HMCS 副本拉起成「脱离终端的独立进程」。
 *
 * 两种场景共用：
 *   1. hmcsm 有参数启动，但系统服务这条路走不通（没管理员权限 / 注册失败）；
 *   2. 菜单里点「启动」，而服务还没安装。
 *
 * detached + stdio:'ignore' 之后，父进程和这个控制台退出都不会把它带走
 * （Windows 上是 DETACHED_PROCESS，POSIX 上是 setsid）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('../lib/paths');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app.js');

/** 只把用户显式给的监听参数写进命令行；单独导出方便自测断言 */
function buildArgs(opts = {}) {
  const args = [APP];
  if (Number(opts.port)) args.push('--port', String(Number(opts.port)));
  if (opts.host) args.push('--host', String(opts.host));
  if (opts.home) args.push('--home', String(opts.home));
  args.push(...(Array.isArray(opts.extraArgs) ? opts.extraArgs : []));
  if (!args.includes('--log-file')) args.push('--log-file');
  return args;
}

function spawnDetached(opts = {}) {
  // port / host 只有「用户这次显式给的」才变成 --port / --host。
  // 早期版本把 settings.json 里的值也当命令行参数传，app.js 会把命令行参数
  // 反向写回 settings.json —— 界面里刚改的监听地址，用菜单启动一次就被旧值盖回去。
  const port = Number(opts.port) || 0;
  const host = String(opts.host || '');
  // 这两个只写进 background.pid 供排障查看，不参与进程启动参数
  const recordPort = Number(opts.recordPort) || port || Number(paths.readSettings().port) || 8720;
  const recordHost = String(opts.recordHost || host || paths.readSettings().host || '127.0.0.1');

  const args = buildArgs(opts);

  // 环境里残留的监听变量会压过 settings.json，跟命令行参数同样的坑，一并摘掉
  const env = { ...process.env, HMCS_BACKGROUND: '1' };
  delete env.HMCS_PORT;
  delete env.HMCS_HOST;

  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  child.unref();

  try {
    fs.mkdirSync(paths.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(paths.CONFIG_DIR, 'background.pid'),
      JSON.stringify({ pid: child.pid, port: recordPort, host: recordHost, startedAt: new Date().toISOString() }, null, 2),
      { encoding: 'utf8', mode: 0o600 });
  } catch { /* 只读目录不影响运行 */ }

  return { ok: true, pid: child.pid, port: recordPort };
}

module.exports = { spawnDetached, buildArgs, APP, ROOT };
