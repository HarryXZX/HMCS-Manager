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

function spawnDetached(opts = {}) {
  const port = Number(opts.port) || 0;
  const host = String(opts.host || '');
  const home = String(opts.home || '');
  const extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs.slice() : [];

  const args = [APP];
  if (port) args.push('--port', String(port));
  if (host) args.push('--host', host);
  if (home) args.push('--home', home);
  args.push(...extraArgs);
  if (!args.includes('--log-file')) args.push('--log-file');

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
      JSON.stringify({ pid: child.pid, port, host, startedAt: new Date().toISOString() }, null, 2),
      { encoding: 'utf8', mode: 0o600 });
  } catch { /* 只读目录不影响运行 */ }

  return { ok: true, pid: child.pid, port };
}

module.exports = { spawnDetached, APP, ROOT };
