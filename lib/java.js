'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { readSettings, DATA_DIR } = require('./paths');

const CACHE = { at: 0, list: [] };

/** 本工具自动下载的运行时放这里：<DATA_DIR>/jvm/<jdk-xxx>/bin/java */
function managedDir() {
  return path.join(DATA_DIR, 'jvm');
}

function candidates() {
  const out = [];
  const push = (p, source) => {
    if (!p) return;
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push({ path: p, source }); } catch { /* ignore */ }
  };

  push(readSettings().javaPath, '设置指定');

  const isWin = process.platform === 'win32';
  const bin = dir => path.join(dir, 'bin', isWin ? 'java.exe' : 'java');

  // 本工具自动下载的运行时（ensureMajor 下载到这里，macOS 布局是 Contents/Home）
  const managed = managedDir();
  for (const d of safeReaddir(managed)) {
    push(path.join(managed, d, 'bin', isWin ? 'java.exe' : 'java'), '自动下载');
    push(path.join(managed, d, 'Contents', 'Home', 'bin', 'java'), '自动下载');
  }

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

    // 逐盘扫描。装在 D:\Program Files\Android\Android Studio\jbr（JBR 25）这类
    // 非 C 盘的运行时此前扫不到，导致「明明有 Java 25 却检测不到」。
    const pf = [];
    for (let code = 65; code <= 90; code++) {
      const root = String.fromCharCode(code) + ':\\';
      try { if (!fs.statSync(root).isDirectory()) continue; } catch { continue; }
      pf.push(path.join(root, 'Program Files'), path.join(root, 'Program Files (x86)'));
    }
    for (const p of pf) {
      // 常见 JDK 发行版目录 + IDE 自带 JBR
      for (const sub of ['Microsoft', 'Java', 'Eclipse Adoptium', 'Zulu', 'BellSoft',
        'Amazon Corretto', 'AdoptOpenJDK', 'Semeru', 'Android', 'JetBrains']) {
        const r = path.join(p, sub);
        for (const d of safeReaddir(r)) {
          push(path.join(r, d, 'bin', 'java.exe'), d);
          push(path.join(r, d, 'jbr', 'bin', 'java.exe'), d);
        }
      }
      // JetBrains 的老命名 space / 直接铺在 Program Files 下的
      push(path.join(p, 'Android', 'Android Studio', 'jbr', 'bin', 'java.exe'), 'Android Studio JBR');
    }
    // 用户目录安装的 Android Studio（不带管理员权限的默认位置）
    const localAs = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Android', 'Android Studio', 'jbr', 'bin', 'java.exe');
    push(localAs, 'Android Studio JBR');
  } else {
    // macOS / Linux
    const home = os.homedir();
    if (process.env.JAVA_HOME) push(bin(process.env.JAVA_HOME), 'JAVA_HOME');

    const roots = ['/Library/Java/JavaVirtualMachines', '/usr/lib/jvm', '/usr/java', '/opt/java',
      '/opt/homebrew/opt', path.join(home, 'opt')];
    for (const r of roots) {
      for (const d of safeReaddir(r)) {
        push(path.join(r, d, 'Contents', 'Home', 'bin', 'java'), d);
        push(path.join(r, d, 'bin', 'java'), d);
      }
    }

    // 用户在自家目录里装的 JDK：IntelliJ 的 .jdks、SDKMAN、mise、jabba
    for (const r of [path.join(home, '.jdks'), path.join(home, '.sdkman', 'candidates', 'java'),
      path.join(home, '.local', 'share', 'mise', 'installs', 'java'),
      path.join(home, '.jabba', 'jdk')]) {
      for (const d of safeReaddir(r)) {
        push(path.join(r, d, 'Contents', 'Home', 'bin', 'java'), d);
        push(path.join(r, d, 'bin', 'java'), d);
      }
    }

    // IDE 自带的 JBR（macOS 用户常靠 Android Studio 的 JBR 25 跑 26.x）
    const ideJbr = ['/opt/android-studio/jbr', '/opt/idea/jbr',
      '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
      '/Applications/IntelliJ IDEA.app/Contents/jbr/Contents/Home'];
    for (const p of ideJbr) push(bin(p), 'IDE 内置 JBR');
    // JetBrains Toolbox：apps/<产品>/<渠道>/<构建>/jbr
    const tb = path.join(home, '.local', 'share', 'JetBrains', 'Toolbox', 'apps');
    for (const app of safeReaddir(tb)) {
      for (const ch of safeReaddir(path.join(tb, app))) {
        for (const b of safeReaddir(path.join(tb, app, ch))) {
          push(bin(path.join(tb, app, ch, b, 'jbr')), 'JetBrains Toolbox');
        }
      }
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
    // /usr/bin/java 与 /bin/java 常是同一个文件（符号链接），按真实路径去重
    let key = c.path;
    try { key = fs.realpathSync(c.path); } catch { /* 用原路径 */ }
    key = key.toLowerCase();
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

/** Windows 上刚探测完的 java.exe / 杀毒扫描都可能短暂占用目录，rename/rm 需要重试 */
function withRetry(fn, label) {
  return new Promise((resolve, reject) => {
    const tryOnce = (left) => {
      try { resolve(fn()); }
      catch (e) {
        if (left > 0 && /^(EPERM|EBUSY|EACCES)$/.test(e.code || '')) {
          // 不能 unref：等待期间可能没有其它活动句柄，unref 会让进程直接退出
          setTimeout(() => tryOnce(left - 1), 600);
        } else reject(new Error(`${label}: ${e.message}`));
      }
    };
    tryOnce(10);
  });
}

function probe(javaPath) {
  return new Promise(resolve => {
    const cb = (err, stdout, stderr) => {
      const text = (stderr || '') + (stdout || '');
      const m = text.match(/version "([^"]+)"/) || text.match(/openjdk (\S+)/i);
      if (!m) return resolve({ path: javaPath, version: '', major: 0, ok: false });
      const version = m[1];
      const major = parseInt(String(version).split('.')[0].replace(/^1$/, ''), 10) || 0;
      const realMajor = String(version).startsWith('1.') ? parseInt(String(version).split('.')[1], 10) : major;
      resolve({ path: javaPath, version, major: realMajor, ok: true });
    };
    try {
      // 不可执行/损坏的文件在 Windows 上会同步抛异常（不是走回调），必须兜住
      execFile(javaPath, ['-version'], { timeout: 8000, windowsHide: true }, cb);
    } catch {
      resolve({ path: javaPath, version: '', major: 0, ok: false });
    }
  });
}

async function list(force) {
  if (!force && Date.now() - CACHE.at < 60000 && CACHE.list.length) return CACHE.list;
  const cands = candidates();
  const probed = [];
  const seenMajor = new Set();
  for (const c of cands.slice(0, 48)) {
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

// ------------------------------------------------------------ 自动下载（Adoptium Temurin）

/** 下载任务状态（供 /api/java 与前端展示进度） */
const TASK = { running: false, major: 0, phase: '', received: 0, total: 0, error: '' };
const PENDING = new Map(); // major -> Promise，并发启动去重

function taskStatus() {
  return { ...TASK };
}

function plat() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function archName() {
  if (process.arch === 'arm64') return 'aarch64';
  return 'x64';
}

/** Adoptium 直链。image_type 优先 jre（服务端只要运行时，体积小一半），没有就回退 jdk */
function adoptiumUrl(major, imageType) {
  return `https://api.adoptium.net/v3/binary/latest/${major}/ga/${plat()}/${archName()}/${imageType}/hotspot/normal/eclipse`;
}

/**
 * 缺少指定大版本的 Java 时，自动下载一个 Temurin 运行时到 <DATA_DIR>/jvm。
 * - Windows 走 zip（adm-zip 解压），macOS/Linux 走 tar.gz（系统 tar 解压）
 * - 下载/解压后用 probe() 实测版本，绝不「装完就当成功」
 * @returns {Promise<{path,version,major}>} 可直接使用的运行时信息
 */
async function ensureMajor(major, opts = {}) {
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const probeFn = opts._probe || probe; // 测试注入用
  const want = Number(major) || 21;
  if (want < 8 || want > 40) throw new Error('不合理的 Java 大版本: ' + want);

  // 已有就不用下：先看探测列表，再直接查 managed 目录（列表可能还在缓存期）
  const all = await list(true);
  let ok = all.filter(j => j.major >= want).sort((a, b) => a.major - b.major)[0];
  if (!ok) {
    const isWin = process.platform === 'win32';
    for (const d of safeReaddir(managedDir())) {
      const jb = path.join(managedDir(), d, 'bin', isWin ? 'java.exe' : 'java');
      if (!fs.existsSync(jb)) continue;
      const info = await probeFn(jb);
      if (info.ok && info.major >= want) { ok = { ...info, source: '自动下载' }; break; }
    }
  }
  if (ok) return ok;

  if (PENDING.has(want)) return PENDING.get(want);
  const p = (async () => {
    Object.assign(TASK, { running: true, major: want, phase: '准备下载', received: 0, total: 0, error: '' });
    try {
      const base = managedDir();
      fs.mkdirSync(base, { recursive: true });
      const imageType = (process.platform === 'win32') ? 'zip' : 'tar.gz';
      const ext = imageType;
      const tmpArchive = path.join(base, `.dl-temurin-${want}.${ext}`);
      const tmpDir = path.join(base, `.tmp-temurin-${want}-${Date.now()}`);

      let lastErr = null;
      // 先试 jre（小），404/失败再试 jdk
      for (const it of ['jre', 'jdk']) {
        try {
          onLog(`开始下载 Temurin ${it.toUpperCase()} ${want}（${plat()}-${archName()}）……`);
          const { download } = require('./sources');
          await download(adoptiumUrl(want, it), tmpArchive, {
            onProgress: ({ received, total }) => {
              TASK.received = received;
              TASK.total = total;
              TASK.phase = '下载中';
              const mb = n => (n / 1048576).toFixed(1);
              onLog(`下载中 ${mb(received)}MB${total ? ' / ' + mb(total) + 'MB' : ''}`);
            },
          });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          onLog(`${it} 下载失败：${e.message}`);
          try { fs.unlinkSync(tmpArchive); } catch { /* ignore */ }
        }
      }
      if (lastErr) throw new Error('下载失败：' + lastErr.message);

      TASK.phase = '解压中';
      TASK.received = 0; TASK.total = 0;
      onLog('下载完成，正在解压……');
      fs.mkdirSync(tmpDir, { recursive: true });
      if (process.platform === 'win32') {
        const AdmZip = require('adm-zip');
        new AdmZip(tmpArchive).extractAllTo(tmpDir, true);
      } else {
        await new Promise((ok2, bad) => execFile('tar', ['-xzf', tmpArchive, '-C', tmpDir],
          { timeout: 300000 }, (e) => (e ? bad(e) : ok2())));
      }
      try { fs.unlinkSync(tmpArchive); } catch { /* ignore */ }

      // 压缩包里通常只有一层顶层目录（jdk-25.0.1+11 / jdk-25.0.1+11-jre）
      let entries = safeReaddir(tmpDir);
      let src = entries.length === 1 ? path.join(tmpDir, entries[0]) : tmpDir;
      const javaBin = path.join(src, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (!fs.existsSync(javaBin)) throw new Error('压缩包结构异常：找不到 bin/java');

      const info = await probeFn(javaBin);
      if (!info.ok || info.major < want) {
        throw new Error(`下载的运行时版本异常（${info.version || '未知'}），需要 ${want}+`);
      }

      const dest = path.join(base, path.basename(src));
      if (fs.existsSync(dest)) {
        await withRetry(() => fs.rmSync(dest, { recursive: true, force: true }), '清理旧目录失败');
      }
      await withRetry(() => fs.renameSync(src, dest), '落位运行时目录失败');
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      const finalBin = path.join(dest, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');

      CACHE.at = 0; // 让 list() 重扫
      const relisted = await list(true);
      const found = relisted.find(j => j.path === finalBin || j.path.toLowerCase() === finalBin.toLowerCase());
      TASK.phase = '完成';
      onLog(`Java ${info.major}（${info.version}）已就绪：${dest}`);
      return found || { path: finalBin, version: info.version, major: info.major, source: '自动下载' };
    } catch (e) {
      TASK.error = e.message;
      throw e;
    } finally {
      TASK.running = false;
    }
  })().finally(() => PENDING.delete(want));
  PENDING.set(want, p);
  return p;
}

module.exports = { list, pick, requiredMajor, probe, candidates, ensureMajor, taskStatus, managedDir, adoptiumUrl };
