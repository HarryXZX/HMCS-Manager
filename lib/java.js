'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { readSettings } = require('./paths');

const CACHE = { at: 0, list: [] };

function candidates() {
  const out = [];
  const push = (p, source) => {
    if (!p) return;
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push({ path: p, source }); } catch { /* ignore */ }
  };

  push(readSettings().javaPath, '设置指定');

  const isWin = process.platform === 'win32';
  const bin = dir => path.join(dir, 'bin', isWin ? 'java.exe' : 'java');

  if (isWin) {
    // Mojang 官方运行时（启动器下载）
    const rt = path.join(process.env.APPDATA || '', '.minecraft', 'runtime');
    if (fs.existsSync(rt)) {
      for (const a of safeReaddir(rt)) {
        const base = path.join(rt, a);
        push(path.join(base, 'bin', 'java.exe'), 'Mojang ' + a);
        push(path.join(base, 'windows-x64', a, 'bin', 'java.exe'), 'Mojang ' + a);
        for (const b of safeReaddir(path.join(base, 'windows-x64'))) {
          push(path.join(base, 'windows-x64', b, 'bin', 'java.exe'), 'Mojang ' + b);
        }
      }
    }

    if (process.env.JAVA_HOME) push(bin(process.env.JAVA_HOME), 'JAVA_HOME');

    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean);
    const roots = [];
    for (const p of pf) {
      roots.push(path.join(p, 'Microsoft'), path.join(p, 'Java'), path.join(p, 'Eclipse Adoptium'),
        path.join(p, 'Zulu'), path.join(p, 'BellSoft'), path.join(p, 'JetBrains'),
        path.join(p, 'Android', 'Android Studio', 'jbr'));
    }
    for (const r of roots) {
      for (const d of safeReaddir(r)) {
        push(path.join(r, d, 'bin', 'java.exe'), d);
        push(path.join(r, d, 'jbr', 'bin', 'java.exe'), d);
      }
    }
  } else {
    // macOS / Linux
    if (process.env.JAVA_HOME) push(bin(process.env.JAVA_HOME), 'JAVA_HOME');

    const roots = ['/Library/Java/JavaVirtualMachines', '/usr/lib/jvm', '/usr/java', '/opt/java', '/opt/homebrew/opt'];
    for (const r of roots) {
      for (const d of safeReaddir(r)) {
        push(path.join(r, d, 'Contents', 'Home', 'bin', 'java'), d);
        push(path.join(r, d, 'bin', 'java'), d);
      }
    }
    // Homebrew 的 openjdk 经常是符号链接
    for (const p of ['/opt/homebrew/opt/openjdk/bin/java', '/usr/local/opt/openjdk/bin/java',
      '/opt/homebrew/opt/openjdk@21/bin/java', '/usr/local/opt/openjdk@21/bin/java']) {
      push(p, 'Homebrew');
    }
  }

  // PATH 上的 java（Windows 用 ; 分隔，其它系统用 :）
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    const t = d.trim();
    if (t) push(isWin ? path.join(t, 'java.exe') : path.join(t, 'java'), 'PATH');
  }

  const uniq = [];
  const seen = new Set();
  for (const c of out) {
    const key = c.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }
  return uniq;
}

function safeReaddir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

function probe(javaPath) {
  return new Promise(resolve => {
    execFile(javaPath, ['-version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      const text = (stderr || '') + (stdout || '');
      const m = text.match(/version "([^"]+)"/) || text.match(/openjdk (\S+)/i);
      if (!m) return resolve({ path: javaPath, version: '', major: 0, ok: false });
      const version = m[1];
      const major = parseInt(String(version).split('.')[0].replace(/^1$/, ''), 10) || 0;
      const realMajor = String(version).startsWith('1.') ? parseInt(String(version).split('.')[1], 10) : major;
      resolve({ path: javaPath, version, major: realMajor, ok: true });
    });
  });
}

async function list(force) {
  if (!force && Date.now() - CACHE.at < 60000 && CACHE.list.length) return CACHE.list;
  const cands = candidates();
  const probed = [];
  const seenMajor = new Set();
  for (const c of cands.slice(0, 24)) {
    const info = await probe(c.path);
    if (!info.ok) continue;
    const key = info.major + '|' + info.path.toLowerCase();
    if (seenMajor.has(key)) continue;
    seenMajor.add(key);
    probed.push({ ...info, source: c.source });
  }
  probed.sort((a, b) => b.major - a.major);
  CACHE.at = Date.now();
  CACHE.list = probed;
  return probed;
}

function requiredMajor(mcVersion) {
  const v = String(mcVersion || '');
  if (/^2[6-9]\./.test(v)) return 25;      // 26.x -> Java 25
  if (/^1\.2[1-9]/.test(v)) return 21;
  if (/^1\.20\.(5|6)/.test(v)) return 21;
  if (/^1\.18|^1\.19/.test(v)) return 17;
  if (/^1\.17/.test(v)) return 16;
  return 21;
}

async function pick(mcVersion, preferred) {
  const all = await list();
  if (preferred) {
    const exact = all.find(j => j.path.toLowerCase() === String(preferred).toLowerCase());
    if (exact) return exact;
  }
  const need = requiredMajor(mcVersion);
  const okList = all.filter(j => j.major >= need).sort((a, b) => a.major - b.major);
  if (okList.length) return okList[0];
  return all[0] || null;
}

module.exports = { list, pick, requiredMajor, probe };
