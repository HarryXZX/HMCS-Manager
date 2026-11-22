'use strict';

/**
 * eula.txt 读写。
 *
 * 原版服务端首次启动会生成：
 *   #By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).
 *   #Sun Nov 22 17:43:52 CST 2026
 *   eula=true
 * 只要文件里出现 eula=true 就视为已同意，注释内容服务端不解析，但保留原样更接近原版行为。
 */

const fs = require('fs');
const path = require('path');

const EULA_FILE = 'eula.txt';
const EULA_URL = 'https://aka.ms/MinecraftEULA';

const HEADER = '#By changing the setting below to TRUE you are indicating your agreement to our EULA (' + EULA_URL + ').';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 近似 Java 的 Date.toString()：Sun Nov 22 17:43:52 CST 2026 */
function dateStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  let tz = '';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d)
      .find(x => x.type === 'timeZoneName');
    tz = part && part.value ? part.value : '';
  } catch { /* ignore */ }
  return `${DAYS[d.getDay()]} ${MONS[d.getMonth()]} ${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${tz} ${d.getFullYear()}`.replace(/\s+/g, ' ').trim();
}

function fileOf(dir) { return path.join(dir, EULA_FILE); }

/** 判断一段文本是否表示「已同意」 */
function isAccepted(text) {
  return /^\s*eula\s*=\s*true\s*$/im.test(String(text || ''));
}

/**
 * 读取状态
 * @param {string} dir 实例目录
 */
function read(dir) {
  const file = fileOf(dir);
  let raw = '';
  let exists = false;
  let mtime = 0;
  try {
    if (fs.existsSync(file)) {
      raw = fs.readFileSync(file, 'utf8');
      exists = true;
      mtime = fs.statSync(file).mtimeMs;
    }
  } catch { /* 读取失败按不存在处理 */ }
  return {
    accepted: isAccepted(raw),
    exists,
    raw,
    file: EULA_FILE,
    path: file,
    url: EULA_URL,
    mtime,
  };
}

/** 生成默认内容（与原版一致的两行注释 + eula=xxx） */
function build(accepted) {
  return `${HEADER}\n#${dateStamp()}\neula=${accepted ? 'true' : 'false'}\n`;
}

/**
 * 写入同意状态。保留原有注释行，只改 eula= 那一行；没有则新建。
 * @param {string} dir
 * @param {boolean} accepted
 */
function write(dir, accepted) {
  const file = fileOf(dir);
  let text = '';
  try { if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8'); } catch { /* ignore */ }

  const value = accepted ? 'true' : 'false';

  if (!text.trim()) {
    text = build(accepted);
  } else {
    // 早期版本写出的裸文件只有一行 eula=xxx，补上原版注释头（服务端只认 eula= 那一行）
    if (!/^\s*#/m.test(text) && /^\s*eula\s*=/im.test(text)) {
      text = `${HEADER}\n#${dateStamp()}\n${text}`;
    }
    if (/^\s*eula\s*=/im.test(text)) {
      text = text.replace(/^\s*eula\s*=.*$/im, `eula=${value}`);
    } else {
      const tail = text.endsWith('\n') ? '' : '\n';
      text = text + tail + `eula=${value}\n`;
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return read(dir);
}

/** 直接覆盖原始内容（文本模式），写完回读真实状态 */
function writeRaw(dir, raw) {
  const file = fileOf(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, String(raw == null ? '' : raw), 'utf8');
  return read(dir);
}

module.exports = { read, write, writeRaw, build, isAccepted, dateStamp, fileOf, EULA_FILE, EULA_URL };
