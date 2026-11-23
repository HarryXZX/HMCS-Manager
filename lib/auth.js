'use strict';
/**
 * 访问控制：密码哈希、会话、登录限流、本地控制令牌
 *
 * 只依赖 node:crypto，不引第三方库。要点：
 *
 *  1. 密码用 scrypt(N=16384,r=8,p=1) 加盐哈希，校验走 timingSafeEqual，
 *     不保存明文，也不保存可逆摘要。
 *  2. 会话令牌是 32 字节随机数，落在 Cookie 里；配置文件里只存它的 SHA-256，
 *     即使 sessions.json 泄漏也换不出可用 Cookie。
 *  3. 改密码后所有旧会话立即失效（比较会话创建时间与 auth.updatedAt）。
 *  4. 登录失败按来源 IP 计数并指数退避锁定，抵御在线爆破。
 *  5. control.token 是留给本机运维脚本（服务注册、CLI 停止）的凭据，
 *     权限 0600，只有本机同用户能读。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG_DIR } = require('./paths');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };
const COOKIE_NAME = 'hmcs_sid';
const SESSION_FILE = path.join(CONFIG_DIR, 'sessions.json');
const CONTROL_FILE = path.join(CONFIG_DIR, 'control.token');

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

// ------------------------------------------------------------------ 密码
/** @returns {string} scrypt$N$r$p$saltB64$hashB64 */
function hashPassword(password) {
  const pw = String(password);
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * @param {string} password 待校验密码
 * @param {string} stored   hashPassword 的产物
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // 参数被改坏或刻意放大时直接拒绝，避免拿登录接口当 CPU 炸弹
  if (!(N >= 1024 && N <= 1 << 20) || !(r >= 1 && r <= 32) || !(p >= 1 && p <= 16)) return false;
  let salt, expect;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expect = Buffer.from(parts[5], 'base64');
  } catch { return false; }
  if (!salt.length || !expect.length) return false;
  let key;
  try {
    key = crypto.scryptSync(String(password), salt, expect.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
  } catch { return false; }
  return key.length === expect.length && crypto.timingSafeEqual(key, expect);
}

/**
 * 密码强度门槛。只挡真正不能当密码的输入，不做复杂度教条，
 * 但把「太短」和「明显弱」的点出来。
 * @returns {{ok:boolean, reason?:string}}
 */
function checkPasswordPolicy(password) {
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD) return { ok: false, reason: `密码至少 ${MIN_PASSWORD} 位` };
  if (pw.length > MAX_PASSWORD) return { ok: false, reason: `密码最多 ${MAX_PASSWORD} 位` };
  if (/^\s+$/.test(pw)) return { ok: false, reason: '密码不能全是空格' };
  const weak = ['12345678', '123456789', '1234567890', 'password', 'passw0rd', 'admin123', 'qwertyui', 'abc12345', '11111111', '88888888'];
  if (weak.includes(pw.toLowerCase())) return { ok: false, reason: '这个密码太常见，换一个' };
  if (/^(.)\1+$/.test(pw)) return { ok: false, reason: '密码不能是同一个字符重复' };
  return { ok: true };
}

// ------------------------------------------------------------------ 会话
/** @type {Map<string, {exp:number, created:number, ip:string, ua:string}>} */
const sessions = new Map();
let loaded = false;

function loadSessions() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const now = Date.now();
    for (const s of raw.sessions || []) {
      if (s && typeof s.id === 'string' && s.exp > now) {
        sessions.set(s.id, { exp: s.exp, created: s.created || 0, ip: s.ip || '', ua: s.ua || '' });
      }
    }
  } catch { /* 首次运行或文件损坏，按空会话处理 */ }
}

function saveSessions() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const data = { v: 1, sessions: [...sessions].map(([id, s]) => ({ id, ...s })) };
    const tmp = SESSION_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, SESSION_FILE);
  } catch { /* 配置目录只读时退化为仅内存会话 */ }
}

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * 新建会话
 * @returns {{token:string, exp:number}}
 */
function createSession(req, days) {
  loadSessions();
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = Math.max(1, Number(days) || 7) * 24 * 3600 * 1000;
  const now = Date.now();
  const exp = now + ttl;

  // 顺手清理过期项，并给总量设上限，避免无限增长
  for (const [id, s] of sessions) if (s.exp <= now) sessions.delete(id);
  while (sessions.size >= 200) {
    const oldest = [...sessions].sort((a, b) => a[1].created - b[1].created)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }

  sessions.set(sha256(token), {
    exp, created: now,
    ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 200),
  });
  saveSessions();
  return { token, exp };
}

/**
 * 取当前请求的有效会话
 * @param {import('http').IncomingMessage} req
 * @param {number} notBefore 早于该时间创建的会话视为失效（改密码后全体下线）
 */
function sessionOf(req, notBefore) {
  loadSessions();
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw) return null;
  const id = sha256(raw);
  const s = sessions.get(id);
  if (!s) return null;
  if (s.exp <= Date.now()) { sessions.delete(id); saveSessions(); return null; }
  if (notBefore && s.created < notBefore) return null;
  return { id, ...s };
}

function destroySession(req) {
  loadSessions();
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw) return false;
  const ok = sessions.delete(sha256(raw));
  if (ok) saveSessions();
  return ok;
}

/** 改密码后踢掉所有会话（可保留当前这台） */
function destroyAllSessions(exceptReq) {
  loadSessions();
  let keep = null;
  if (exceptReq) {
    const raw = parseCookies(exceptReq.headers.cookie)[COOKIE_NAME];
    if (raw) keep = sha256(raw);
  }
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (id === keep) { s.created = now; continue; }
    sessions.delete(id);
  }
  saveSessions();
}

function sessionCount() {
  loadSessions();
  const now = Date.now();
  let n = 0;
  for (const s of sessions.values()) if (s.exp > now) n++;
  return n;
}

// ------------------------------------------------------------------ Cookie
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

/**
 * @param {string} token
 * @param {number} maxAgeSec 秒；0 表示立即过期
 * @param {boolean} secure 走 HTTPS 时加 Secure，禁止明文回传
 */
function cookieHeader(token, maxAgeSec, secure) {
  const bits = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  bits.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

function clearCookieHeader(secure) {
  return cookieHeader('', 0, secure);
}

// ------------------------------------------------------------------ 来源判定
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

function isLoopback(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (LOOPBACK.has(s)) return true;
  return /^127\./.test(s);
}

/** 真实来源 IP；只有显式信任反向代理时才读 X-Forwarded-For */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf.replace(/^::ffff:/, '');
  }
  return String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function isHttps(req, trustProxy) {
  if (req.socket && req.socket.encrypted) return true;
  if (!trustProxy) return false;
  return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

// ------------------------------------------------------------------ 登录限流
const attempts = new Map();   // ip -> {fails, first, until}
const WINDOW_MS = 15 * 60 * 1000;
const FREE_FAILS = 5;

function pruneAttempts() {
  const now = Date.now();
  for (const [ip, a] of attempts) {
    if (a.until && a.until <= now && now - a.first > WINDOW_MS) attempts.delete(ip);
    else if (!a.until && now - a.first > WINDOW_MS) attempts.delete(ip);
  }
}

/** @returns {number} 还需等待的秒数，0 表示未锁定 */
function lockRemaining(ip) {
  pruneAttempts();
  const a = attempts.get(ip);
  if (!a || !a.until) return 0;
  const left = a.until - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** 记一次失败，返回本次触发的锁定秒数（0 表示未锁定） */
function noteFail(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now - a.first > WINDOW_MS) a = { fails: 0, first: now, until: 0 };
  a.fails += 1;
  if (a.fails >= FREE_FAILS) {
    const over = a.fails - FREE_FAILS;
    const sec = Math.min(30 * 60, 60 * Math.pow(2, over));
    a.until = now + sec * 1000;
  }
  attempts.set(ip, a);
  return a.until > now ? Math.ceil((a.until - now) / 1000) : 0;
}

function noteOk(ip) { attempts.delete(ip); }

/** 本轮还剩几次尝试机会（用于登录页提示） */
function attemptsLeft(ip) {
  pruneAttempts();
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW_MS) return FREE_FAILS;
  return Math.max(0, FREE_FAILS - a.fails);
}

// ------------------------------------------------------------------ 控制令牌
let cachedToken = '';

/**
 * 本机运维凭据：注册服务、脚本优雅停止都要用它调用 /api/system/*，
 * 不需要也不应该把管理密码写进脚本。
 */
function controlToken() {
  if (cachedToken) return cachedToken;
  try {
    const t = fs.readFileSync(CONTROL_FILE, 'utf8').trim();
    if (t.length >= 32) { cachedToken = t; return t; }
  } catch { /* 不存在则生成 */ }
  cachedToken = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONTROL_FILE, cachedToken, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(CONTROL_FILE, 0o600); } catch { /* Windows 无 POSIX 权限 */ }
  } catch { /* 只读目录时退化为进程内有效 */ }
  return cachedToken;
}

/** 常量时间校验控制令牌 */
function checkControl(req) {
  const given = String(req.headers['x-hmcs-control'] || '');
  if (!given) return false;
  const expect = controlToken();
  const a = Buffer.from(given);
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  COOKIE_NAME, MIN_PASSWORD, MAX_PASSWORD,
  hashPassword, verifyPassword, checkPasswordPolicy,
  createSession, sessionOf, destroySession, destroyAllSessions, sessionCount,
  parseCookies, cookieHeader, clearCookieHeader,
  isLoopback, clientIp, isHttps,
  lockRemaining, noteFail, noteOk, attemptsLeft,
  controlToken, checkControl,
};
