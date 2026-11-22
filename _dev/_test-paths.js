'use strict';
/**
 * 跨平台路径测试：用 HMCS_PLATFORM 在 Windows 上模拟 win32 / darwin / linux，
 * 校验配置目录、数据目录、servers 默认位置，以及 Linux 的 XDG 拆分迁移。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PATHS = path.join(__dirname, '..', 'lib', 'paths.js');
const BASE = path.join(os.tmpdir(), 'hmcs-path-test-' + Date.now());

let fail = 0;
function check(name, got, want) {
  const ok = path.resolve(String(got)) === path.resolve(String(want));
  console.log((ok ? '  ok    ' : '  FAIL  ') + name);
  if (!ok) {
    console.log('          got  ' + got);
    console.log('          want ' + want);
    fail++;
  }
}
function truthy(name, v) {
  console.log((v ? '  ok    ' : '  FAIL  ') + name);
  if (!v) fail++;
}

function probe(env) {
  const code = `const p=require(${JSON.stringify(PATHS)});`
    + `console.log(JSON.stringify({c:p.CONFIG_DIR,d:p.DATA_DIR,s:p.DEFAULT_SERVERS_DIR}));`;
  const out = execFileSync(process.execPath, ['-e', code], {
    env: { ...process.env, HMCS_HOME: '', HYSERV_HOME: '', XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

console.log('=== Windows ===');
{
  const app = path.join(BASE, 'win', 'AppData', 'Roaming');
  const r = probe({ HMCS_PLATFORM: 'win32', APPDATA: app });
  check('配置目录 = %APPDATA%\\HMCS', r.c, path.join(app, 'HMCS'));
  check('数据目录与配置同处', r.d, path.join(app, 'HMCS'));
  check('默认实例目录 = 数据目录/servers', r.s, path.join(app, 'HMCS', 'servers'));
}

console.log('=== macOS ===');
{
  const home = path.join(BASE, 'mac');
  const r = probe({ HMCS_PLATFORM: 'darwin', USERPROFILE: home, HOME: home, APPDATA: '' });
  const want = path.join(home, 'Library', 'Application Support', 'HMCS');
  check('配置目录 = ~/Library/Application Support/HMCS', r.c, want);
  check('数据目录同处', r.d, want);
  check('默认实例目录', r.s, path.join(want, 'servers'));
}

console.log('=== Linux（XDG 拆分）===');
{
  const home = path.join(BASE, 'lin', 'home');
  const xc = path.join(BASE, 'lin', 'config');
  const xd = path.join(BASE, 'lin', 'data');
  const r = probe({ HMCS_PLATFORM: 'linux', USERPROFILE: home, HOME: home, XDG_CONFIG_HOME: xc, XDG_DATA_HOME: xd, APPDATA: '' });
  check('配置目录 = $XDG_CONFIG_HOME/HMCS', r.c, path.join(xc, 'HMCS'));
  check('数据目录 = $XDG_DATA_HOME/HMCS', r.d, path.join(xd, 'HMCS'));
  check('默认实例目录 = 数据目录/servers', r.s, path.join(xd, 'HMCS', 'servers'));

  // 未设 XDG_* 时回落到 ~/.config 与 ~/.local/share
  const r2 = probe({ HMCS_PLATFORM: 'linux', USERPROFILE: home, HOME: home, APPDATA: '' });
  check('回落配置 ~/.config/HMCS', r2.c, path.join(home, '.config', 'HMCS'));
  check('回落数据 ~/.local/share/HMCS', r2.d, path.join(home, '.local', 'share', 'HMCS'));
}

console.log('=== HMCS_HOME 覆盖（不分平台）===');
{
  const custom = path.join(BASE, 'custom');
  for (const plat of ['win32', 'darwin', 'linux']) {
    const r = probe({ HMCS_PLATFORM: plat, HMCS_HOME: custom });
    check(plat + ' 配置 = HMCS_HOME', r.c, custom);
    check(plat + ' 数据 = HMCS_HOME', r.d, custom);
  }
}

console.log('=== Linux 从旧布局（config/servers）自动迁移 ===');
{
  const home = path.join(BASE, 'lin2', 'home');
  const xc = path.join(BASE, 'lin2', 'config');
  const xd = path.join(BASE, 'lin2', 'data');
  const oldServers = path.join(xc, 'HMCS', 'servers');
  const demo = path.join(oldServers, 'demo');

  fs.mkdirSync(demo, { recursive: true });
  fs.writeFileSync(path.join(demo, 'server.properties'), 'server-port=25565\n');
  fs.writeFileSync(path.join(xc, 'HMCS', 'settings.json'), JSON.stringify({
    serversDir: oldServers, clientRoots: [], extraWorldDirs: [],
  }, null, 2));
  fs.writeFileSync(path.join(xc, 'HMCS', 'instances.json'), JSON.stringify({
    version: 2, instances: [{ id: 'demo', dir: demo, name: 'demo' }],
  }, null, 2));

  const env = { HMCS_PLATFORM: 'linux', USERPROFILE: home, HOME: home, XDG_CONFIG_HOME: xc, XDG_DATA_HOME: xd, APPDATA: '' };
  probe(env);
  truthy('实例目录搬到了 XDG data', fs.existsSync(path.join(xd, 'HMCS', 'servers', 'demo', 'server.properties')));
  truthy('旧位置已清空', !fs.existsSync(demo));

  const reg = JSON.parse(fs.readFileSync(path.join(xc, 'HMCS', 'instances.json'), 'utf8'));
  check('注册表 dir 已重写', reg.instances[0].dir, path.join(xd, 'HMCS', 'servers', 'demo'));
  const set = JSON.parse(fs.readFileSync(path.join(xc, 'HMCS', 'settings.json'), 'utf8'));
  check('settings.serversDir 已重写', set.serversDir, path.join(xd, 'HMCS', 'servers'));
}

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log('');
console.log(fail === 0 ? '全部通过' : (fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
