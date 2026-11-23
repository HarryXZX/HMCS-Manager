#!/usr/bin/env node
'use strict';
/**
 * 重置 / 清除访问密码
 *
 * 忘记密码时用。原理是直接改 settings.json 里的哈希，所以只要对配置目录有写权限
 * （等于对这台机器有物理 / 本地访问权限）就能重置——这是本地管理工具的常规语义。
 *
 *   node scripts/reset-password.js            交互式设置新密码
 *   node scripts/reset-password.js --clear    关闭密码访问
 *   node scripts/reset-password.js --password 新密码   非交互（脚本化用）
 */
const fs = require('fs');
const readline = require('readline');
const paths = require('../lib/paths');
const auth = require('../lib/auth');

const args = process.argv.slice(2);
const CLEAR = args.includes('--clear');
const forced = (() => {
  const i = args.indexOf('--password');
  return i >= 0 ? String(args[i + 1] || '') : '';
})();

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, a => { rl.close(); res(String(a || '').trim()); }));
}

/** 不回显的密码输入 */
function askHidden(question) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { resolve(''); return; }
    process.stdout.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const finish = val => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(!!wasRaw);
      stdin.pause();
      process.stdout.write('\n');
      resolve(val);
    };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(buf);
        if (ch === '\u0003') { finish(''); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        if (ch === '\u001b') continue;
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

(async function main() {
  const s = paths.readSettings();
  console.log('');
  console.log('HMCS 访问密码重置');
  console.log('  配置目录  ' + paths.CONFIG_DIR);
  console.log('  当前状态  ' + (s.auth && s.auth.hash ? '已设置密码' : '未设置密码'));
  console.log('');

  if (CLEAR) {
    const yes = forced || (process.stdin.isTTY ? await ask('确认关闭密码访问？(y/N)：') : '');
    if (String(yes).toLowerCase() !== 'y') { console.log('已取消'); return; }
    paths.writeSettings({ auth: { ...s.auth, enabled: false, hash: '', updatedAt: new Date().toISOString() } });
    auth.destroyAllSessions(null);
    console.log('已关闭密码访问。注意：如果 HMCS 正在对外监听，它会因为安全检查无法重启服务，');
    console.log('请先把监听地址改回 127.0.0.1，或者马上再设一个密码。');
    return;
  }

  let pw = forced;
  if (!pw) {
    if (!process.stdin.isTTY) {
      console.error('非交互环境请用：node scripts/reset-password.js --password <新密码>');
      process.exit(1);
    }
    pw = await askHidden('新密码（输入时不显示）：');
    const again = await askHidden('再输一次：');
    if (pw !== again) { console.error('两次输入不一致，未做修改'); process.exit(1); }
  }

  const pol = auth.checkPasswordPolicy(pw);
  if (!pol.ok) { console.error('不满足要求：' + pol.reason); process.exit(1); }

  const updatedAt = new Date().toISOString();
  paths.writeSettings({ auth: { ...s.auth, enabled: true, hash: auth.hashPassword(pw), updatedAt } });
  auth.destroyAllSessions(null);
  console.log('');
  console.log('密码已更新，所有已登录的浏览器都需要重新登录。');
  console.log(s.auth && s.auth.onlyRemote ? '当前策略：仅非本机访问需要密码。' : '当前策略：所有访问都需要密码。');
  console.log('如果 HMCS 正在运行，可执行 `node scripts/service.js restart` 让它彻底重载状态。');
})().catch(e => { console.error('失败：' + e.message); process.exit(1); });
