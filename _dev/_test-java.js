#!/usr/bin/env node
'use strict';
/**
 * Java 探测与自动下载 —— 回归自测
 *
 * 守的点：
 *   1) requiredMajor 版本映射（26.x→25，1.21.x→21 等）
 *   2) Windows 探测不再只扫 C 盘：D:\Program Files\Android\Android Studio\jbr（JBR 25）能扫到
 *      （本机回归：这台开发机 AS 就装在 D 盘，扫不到就是真回归）
 *   3) 自动下载的运行时放 <DATA_DIR>/jvm，且会被 candidates()/list() 识别
 *   4) ensureMajor 全流程（下载→解压→验版本→落位）用假 zip + 注入 probe 走通
 *   5) 并发去重：同一个 major 同时 ensure 只下载一次
 *   6) 已存在满足要求的运行时时 ensureMajor 直接复用，不下载
 *   7) taskStatus() 暴露下载状态
 *
 * 全程使用临时配置目录（HMCS_HOME），不碰用户真实配置，也不访问网络
 * （Adoptium 下载被 require 缓存桩替换成复制本地假 zip）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const HOME = path.join(os.tmpdir(), 'hmcs-java-test-' + process.pid);
process.env.HMCS_HOME = HOME; // 必须在 require lib/paths 之前
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const paths = require('../lib/paths');
const java = require('../lib/java');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failed++; console.error(`FAIL  ${name} ${detail}`); }
}

// ---------------------------------------------------------------- 1. requiredMajor
console.log('\n[1] requiredMajor 版本映射');
check('26.x -> 25', java.requiredMajor('26.1') === 25);
check('1.21.4 -> 21', java.requiredMajor('1.21.4') === 21);
check('1.20.6 -> 21', java.requiredMajor('1.20.6') === 21);
check('1.20.4 -> 21（兜底也是 21）', java.requiredMajor('1.20.4') === 21);
check('1.18.2 -> 17', java.requiredMajor('1.18.2') === 17);
check('1.17 -> 16', java.requiredMajor('1.17') === 16);
check('空值 -> 21', java.requiredMajor('') === 21);

// ---------------------------------------------------------------- 2. Windows 多盘扫描
console.log('\n[2] Windows 多盘探测（本机回归）');
const cands = java.candidates();
check('candidates() 返回数组', Array.isArray(cands));
if (process.platform === 'win32') {
  const jbr25 = 'D:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe';
  check('扫到 D 盘 Android Studio JBR 25', cands.some(c => c.path.toLowerCase() === jbr25.toLowerCase()),
    '应包含 ' + jbr25);
  const drives = new Set(cands.map(c => c.path[0].toUpperCase()));
  console.log(`      探测到的候选分布在盘符: ${[...drives].join(', ') || '(无)'}，共 ${cands.length} 个`);
}
// 真实环境（本机）验证一次完整 list()：JBR 25 应该在列表里且 major=25
(async () => {
  const list = await java.list(true);
  check('list() 探测成功', Array.isArray(list));
  if (process.platform === 'win32') {
    const jbr = list.find(j => /Android Studio[\\/]jbr/i.test(j.path));
    check('JBR 25 被识别为 Java 25', !!jbr && jbr.major === 25, jbr ? 'major=' + jbr.major : '没扫到 JBR');
  }

  // ---------------------------------------------------------------- 3. managed dir
  console.log('\n[3] 自动下载目录纳入探测');
  check('managedDir 在 DATA_DIR/jvm 下', java.managedDir() === path.join(paths.DATA_DIR, 'jvm'));
  // 手工放假运行时：目录结构会被扫到（probe 会失败所以不进 list，但 candidates 里有）
  const fake = path.join(java.managedDir(), 'jdk-25.9.9-test');
  fs.mkdirSync(path.join(fake, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), 'fake');
  const cands2 = java.candidates();
  check('candidates() 含自动下载目录里的运行时',
    cands2.some(c => c.path.startsWith(java.managedDir()) && c.source === '自动下载'));
  fs.rmSync(java.managedDir(), { recursive: true, force: true });

  // ---------------------------------------------------------------- 4. ensureMajor 全流程
  console.log('\n[4] ensureMajor 全流程（假 zip + 注入 probe）');
  const AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip'));
  const makeZip = major => {
    const z = new AdmZip();
    z.addFile(`jdk-${major}.9.9+9-jre/bin/${process.platform === 'win32' ? 'java.exe' : 'java'}`, Buffer.from('fake-binary'));
    z.addFile(`jdk-${major}.9.9+9-jre/release`, Buffer.from(`JAVA_VERSION="${major}.0.9"`));
    const zp = path.join(HOME, `fake-temurin-${major}.zip`);
    z.writeZip(zp);
    return zp;
  };
  const topName = m => `jdk-${m}.9.9+9-jre`; // 顶层目录名随请求的 major 变

  // 把 sources.download 桩掉：不管 URL 是什么都「下载」本地假 zip
  const sourcesPath = require.resolve('../lib/sources');
  const realSources = require(sourcesPath);
  let dlCalls = 0;
  require.cache[sourcesPath] = {
    id: sourcesPath, filename: sourcesPath, loaded: true,
    exports: { ...realSources, download: async (url, dest) => {
      dlCalls++;
      // URL 形如 .../binary/latest/39/ga/... 从里面取版本号生成对应的假包
      const m = url.match(/latest\/(\d+)\//);
      fs.copyFileSync(makeZip(m ? Number(m[1]) : 39), dest);
      return dest;
    } },
  };

  const logs = [];
  // 假 probe：从顶层目录名（jdk-39.x）里解析出大版本，保证 ≥ 请求的 want
  const fakeProbe = async p => {
    const m = p.match(/jdk-(\d+)/);
    return m ? { path: p, version: m[1] + '.0.9', major: Number(m[1]), ok: true }
      : { path: p, version: '', major: 0, ok: false };
  };

  // 用 major 39（requiredMajor 上限内、本机必然没有）强制走下载分支
  const r = await java.ensureMajor(39, {
    onLog: l => logs.push(l),
    _probe: fakeProbe,
  });
  check('返回了可用的运行时信息', r && r.major === 39 && r.path, JSON.stringify(r));
  check('下载只发生一次（jre 成功不再试 jdk）', dlCalls === 1, 'dlCalls=' + dlCalls);
  check('落位到 managedDir', r.path.startsWith(java.managedDir()), r.path);
  check('解压出的顶层目录名保留', r.path.includes(topName(39)), r.path);
  check('bin/java 真实存在', fs.existsSync(r.path));
  check('临时文件已清理', !fs.readdirSync(java.managedDir()).some(n => n.startsWith('.tmp-') || n.startsWith('.dl-')));
  check('onLog 有进度输出', logs.some(l => /解压/.test(l)), logs.join(' | '));
  check('taskStatus 已完成', java.taskStatus().phase === '完成' && !java.taskStatus().running);
  check('candidates() 认得下载结果', java.candidates().some(c => c.path.startsWith(java.managedDir())));

  // ---------------------------------------------------------------- 5. 并发去重
  console.log('\n[5] 并发去重');
  dlCalls = 0;
  // 注意 managed 里已有 39，请求 38 会被复用 —— 这里用 40 强制走下载分支
  const p1 = java.ensureMajor(40, { onLog: () => {}, _probe: fakeProbe });
  const p2 = java.ensureMajor(40, { onLog: () => {}, _probe: fakeProbe });
  const [r1, r2] = await Promise.all([p1, p2]);
  check('两次并发 ensure 都拿到结果', r1.major === 40 && r2.major === 40);
  check('实际只下载一次', dlCalls === 1, 'dlCalls=' + dlCalls);

  // ---------------------------------------------------------------- 6. 已存在时复用
  console.log('\n[6] 已存在时直接复用');
  dlCalls = 0;
  // managed 里有 39，请求 38 应直接复用（fakeProbe 能从目录名认出版本）
  const r3 = await java.ensureMajor(38, { _probe: fakeProbe });
  check('不再下载', dlCalls === 0, 'dlCalls=' + dlCalls);
  check('复用了 managedDir 里的运行时', r3.path.startsWith(java.managedDir()), r3.path);
  check('复用的版本可用', r3.major >= 38, 'major=' + r3.major);

  // 恢复真实 sources，避免影响后续（同进程内其它 require）
  require.cache[sourcesPath] = { id: sourcesPath, filename: sourcesPath, loaded: true, exports: realSources };

  // ---------------------------------------------------------------- 7. URL 格式
  console.log('\n[7] Adoptium URL');
  const u = java.adoptiumUrl(25, 'jre');
  check('包含大版本', u.includes('/25/'));
  check('是 binary/latest 直链', /binary\/latest\/25\/ga\//.test(u));
  check('按平台拼 os/arch', /\/(windows|mac|linux)\/(x64|aarch64)\//.test(u), u);

  // ----------------------------------------------------------------
  console.log('\n清理');
  fs.rmSync(HOME, { recursive: true, force: true });
  if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
  console.log('\n全部通过 ✔');
})().catch(e => { console.error('测试异常:', e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
