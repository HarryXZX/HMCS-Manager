#!/usr/bin/env node
'use strict';
/**
 * 服务安装状态判定 —— 纯逻辑，零副作用，可直接 require 做单测。
 *
 * 为什么单独抽出来：
 *   以前 `WIN.state()` 用一句 `try { Get-ScheduledTask ... } catch { 'MISSING' }`
 *   把「任务确实不存在」和「PowerShell 被策略禁用 / 权限不足 / cmdlet 不存在 /
 *   spawn 失败」全部吞成同一个 MISSING，于是明明装过（service.json 里有
 *   installedAt）也会显示「未安装」。遥控器就此误判，进而可能重复注册服务。
 *
 * 这里的规则是：**只有拿到明确的「不存在」证据才能说未安装**；
 * 查询手段失效时要么用旁路证据（任务定义文件 / 安装存档）判定，
 * 要么如实标注「无法确认」，绝不静默当成未安装。
 */

/** 解析 PowerShell 探测输出。固定 ASCII 标记，避开中文/英文本地化差异。 */
function parsePowerShellProbe(r) {
  const res = { kind: 'unavailable', state: '', detail: '' };
  const err = String((r && r.error) || '');
  if (err) { res.detail = 'spawn 失败: ' + err; return res; }
  const out = String((r && r.out) || '');
  const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  // 从后往前找标记行：PowerShell 可能夹带 profile/警告噪声
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.startsWith('HMCS_STATE=')) {
      const s = l.slice('HMCS_STATE='.length).trim();
      if (['Ready', 'Running', 'Disabled', 'Queued'].includes(s)) {
        return { kind: 'state', state: s, detail: '' };
      }
      res.detail = '未知状态值: ' + s;
      return res;
    }
    if (l === 'HMCS_ABSENT') return { kind: 'absent', state: '', detail: '' };
    if (l === 'HMCS_UNAVAILABLE') {
      res.detail = 'Get-ScheduledTask 不可用';
      return res;
    }
  }
  res.detail = '没有识别到探测标记（退出码 ' + (r && r.code) + '）';
  return res;
}

/** schtasks /Query 的归类：exists / absent / unavailable */
function classifySchtasks(r) {
  if (!r) return 'unavailable';
  if (r.error) return 'unavailable';
  if (r.code === 0) return 'exists';
  const text = String(r.out || '') + ' ' + String(r.err || '');
  if (/cannot find|找不到|不存在|does not exist|no scheduled task|系统找不到/i.test(text)) return 'absent';
  return 'unavailable';
}

/**
 * 多源交叉判定 Windows 计划任务是否已安装。
 *
 * @param {object} e
 * @param {{kind:string,state:string}} e.ps        PowerShell 探测结果
 * @param {boolean|null} e.taskFile                任务定义文件：true 有 / false 明确没有 / null 读不到
 * @param {object|null}  e.saved                  service.json 安装存档
 * @param {string}       e.schtasks               schtasks 归类
 * @returns {{state:string, installed:boolean, running:boolean, autostart:boolean,
 *            source:string, reliable:boolean, uncertain:boolean, raw:string}}
 */
function resolveWindowsInstall(e) {
  const ps = e.ps || { kind: 'unavailable' };
  const taskFile = e.taskFile === undefined ? null : e.taskFile;
  const sch = e.schtasks || 'unavailable';
  const saved = !!(e.saved && (e.saved.installedAt || e.saved.backend === 'schtasks'));
  const savedAutostart = !!(e.saved && e.saved.autostart !== false);

  const make = (o) => Object.assign({
    state: 'UNKNOWN', installed: false, running: false, autostart: false,
    source: '', reliable: false, uncertain: true, raw: '无法确定',
  }, o);

  // 1) 实时查询拿到精确状态 —— 最高置信度
  if (ps.kind === 'state') {
    const st = ps.state;
    return make({
      state: st, installed: true, running: st === 'Running',
      autostart: st !== 'Disabled',
      source: '计划任务实时查询', reliable: true, uncertain: false,
      raw: st,
    });
  }

  // 2) 任务定义文件是铁证：不需要任何外部程序、不需要提权。
  //    权限隔离下 PowerShell 看不到 SYSTEM 建的任务是常见现象，文件仍在。
  if (taskFile === true) {
    const st = sch === 'exists' ? 'Ready' : (savedAutostart ? 'Ready' : 'Disabled');
    return make({
      state: st, installed: true, running: false, autostart: savedAutostart,
      source: '任务定义文件', reliable: true, uncertain: ps.kind === 'absent',
      raw: ps.kind === 'absent'
        ? '已安装（任务定义文件存在；实时查询接口看不到，运行状态未确认）'
        : '已安装（依据任务定义文件）',
    });
  }

  // 3) 明确「不存在」 + 文件也确实不存在 —— 可以笃定说没装（存档已过期）
  if (ps.kind === 'absent' && taskFile === false) {
    return make({
      state: 'MISSING', installed: false, reliable: true, uncertain: false,
      source: '计划任务实时查询', raw: '未安装' + (saved ? '（安装存档已过期，以实时查询为准）' : ''),
    });
  }

  // 4) schtasks 明确查到了任务
  if (sch === 'exists') {
    return make({
      state: 'Ready', installed: true, autostart: savedAutostart,
      source: 'schtasks 查询', reliable: true, uncertain: ps.kind !== 'state',
      raw: '已安装（依据 schtasks 查询）',
    });
  }

  // 5) 实时查询手段全部失效：不能再把「查不到」说成「没装」。
  //    service.json 由 install 写入、uninstall 删除，是可靠的安装痕迹。
  if (saved) {
    return make({
      state: savedAutostart ? 'Ready' : 'Disabled', installed: true,
      autostart: savedAutostart,
      source: '安装存档（实时状态无法确认）', reliable: false, uncertain: true,
      raw: '已安装（依据安装存档；当前身份无法查询计划任务，运行状态未确认）',
    });
  }

  // 6) 无存档、又查不了：如实说不知道，而不是假称未安装
  return make({
    state: 'UNKNOWN', installed: false, reliable: false, uncertain: true,
    source: '无法查询', raw: '无法确认（查询接口不可用，且没有安装存档）',
  });
}

/**
 * 解析 `service.js status --json` 的输出。
 *
 * 旧实现只取最后一行 JSON.parse，任何告警/堆栈混进 stdout、子进程非零退出、
 * spawn 报错都会静默返回 null → 调用方 `installed: !!undefined` = false，
 * 界面直接写「未安装」，连一句「查询失败」都没有。改为倒序扫描可解析行，
 * 并显式给出 probeFailed 让调用方显示「状态未知」。
 */
function parseProbeOutput(stdout, exitCode, error) {
  const failed = (reason) => ({
    ok: false, probeFailed: true, installed: false, running: false,
    autostart: false, canInstall: false, kind: '', raw: '状态查询失败',
    reason, installUncertain: true, installSource: '无法查询',
  });

  if (error) return failed('子进程启动失败: ' + String(error));
  const lines = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let parsed = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      if (o && typeof o === 'object' && (typeof o.installed === 'boolean' || o.ok === true || o.probeFailed)) {
        parsed = o;
        break;
      }
    } catch { /* 不是 JSON，继续往上找 */ }
  }
  if (!parsed) return failed('输出中没有可解析的状态 JSON');
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return Object.assign(failed('状态命令退出码 ' + exitCode), parsed, { probeFailed: true, installUncertain: true });
  }
  return parsed;
}

module.exports = {
  parsePowerShellProbe,
  classifySchtasks,
  resolveWindowsInstall,
  parseProbeOutput,
};
