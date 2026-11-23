'use strict';
/**
 * 运行日志落盘
 *
 * 注册成服务（systemd / 计划任务）后没有控制台，stdout 会被丢掉。
 * 这里把 console 的几路输出同时写进 <数据目录>/logs/manager.log，
 * 并按大小滚动，方便出问题时回看。
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const { DATA_DIR } = require('./paths');

const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'manager.log');
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

let stream = null;
let size = 0;
let patched = false;

function rotateIfNeeded() {
  if (size < MAX_BYTES) return;
  try { stream.end(); } catch { /* ignore */ }
  stream = null;
  try {
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch { /* 磁盘忙或权限不足，继续往原文件写 */ }
  size = 0;
}

function ensureStream() {
  if (stream) return stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    size = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    rotateIfNeeded();
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a', mode: 0o600 });
    stream.on('error', () => { stream = null; });
  } catch { stream = null; }
  return stream;
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function write(level, args) {
  const s = ensureStream();
  if (!s) return;
  const text = `[${stamp()}] [${level}] ${util.format(...args)}\n`;
  try {
    s.write(text);
    size += Buffer.byteLength(text);
    rotateIfNeeded();
  } catch { /* ignore */ }
}

const original = { log: console.log.bind(console), error: console.error.bind(console), warn: console.warn.bind(console) };

/**
 * @param {{toFile:boolean}} opts toFile=false 时只保留控制台输出；可在运行中再次调用升级为落盘
 */
function init(opts = {}) {
  if (!opts.toFile || patched) return;
  patched = true;

  console.log = (...a) => { original.log(...a); write('INFO', a); };
  console.error = (...a) => { original.error(...a); write('ERROR', a); };
  console.warn = (...a) => { original.warn(...a); write('WARN', a); };

  process.on('uncaughtException', err => {
    console.error('[fatal] 未捕获异常:', err && err.stack || err);
    // 交给默认处理器，保持原有行为（退出码非 0）
  });
  process.on('unhandledRejection', reason => {
    console.error('[fatal] 未处理的 Promise 拒绝:', reason && reason.stack || reason);
  });
}

/** 读最近多少行（设置页「运行日志」用） */
function tail(lines = 200) {
  try {
    if (!fs.existsSync(LOG_FILE)) return '';
    const max = Math.min(1024 * 1024, Math.max(4096, lines * 400));
    const stat = fs.statSync(LOG_FILE);
    const start = Math.max(0, stat.size - max);
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(stat.size - start);
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8');
    const arr = text.split(/\r?\n/);
    if (start > 0) arr.shift();
    return arr.slice(-lines).join('\n');
  } catch { return ''; }
}

module.exports = { init, tail, LOG_FILE, LOG_DIR };
