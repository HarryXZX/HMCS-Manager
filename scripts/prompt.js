'use strict';
/**
 * 终端交互小工具：普通输入、隐藏输入（密码）、确认。
 *
 * 抽出来是因为 reset-password 和 hmcsm 菜单都要用；
 * 隐藏输入必须自己处理 raw mode（readline 没有这个能力）。
 */
const readline = require('readline');

/** 普通一行输入，空输入回落默认值 */
function ask(question, def = '') {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, ans => {
      rl.close();
      resolve(String(ans == null ? '' : ans).trim() || def);
    });
  });
}

/** 不回显的输入（密码）；非 TTY 直接返回空串，避免把密码写进管道日志 */
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
        if (ch === '\u001b') continue;   // 方向键之类的转义序列，忽略
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** y/N 确认；defaultYes 时变成 Y/n */
async function confirm(question, defaultYes = false) {
  const hint = defaultYes ? ' (Y/n)：' : ' (y/N)：';
  const a = String(await ask(question + hint)).toLowerCase();
  if (!a) return !!defaultYes;
  return a === 'y' || a === 'yes' || a === '是';
}

module.exports = { ask, askHidden, confirm };
