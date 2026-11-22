'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  boot: null,
  instId: localStorage.getItem('hmcs.inst') || '',
  tab: 'overview',
  es: null,
  filesPath: '',
  cfgTarget: 'props',
  cfgFile: '',
  cfgData: null,
  cfgRaw: '',
  cfgKind: 'yaml',
  timer: null,
};

// ---------------------------------------------------------------- 基础
async function api(path, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (init.body && typeof init.body !== 'string' && !(init.body instanceof Blob)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text || ('HTTP ' + res.status) }; }
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

async function fetchText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; el.style.transition = '.2s'; }, 3600);
  setTimeout(() => el.remove(), 4000);
}

function modal({ title, body, foot, wide }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">
    <div class="modal-head"><b>${esc(title)}</b><div style="flex:1"></div><button class="btn sm ghost" data-close>关闭</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">${foot || ''}</div>
  </div>`;
  root.classList.add('on');
  const close = () => { root.classList.remove('on'); root.innerHTML = ''; };
  $$('[data-close]', root).forEach(b => b.onclick = close);
  root.onclick = e => { if (e.target === root) close(); };
  return { close, root };
}

function confirmBox(msg) {
  return new Promise(resolve => {
    const m = modal({
      title: '确认操作',
      body: `<div style="font-size:13.5px;line-height:1.7">${msg}</div>`,
      foot: `<button class="btn" data-no>取消</button><button class="btn danger" data-yes>确认</button>`,
    });
    $('[data-no]', m.root).onclick = () => { m.close(); resolve(false); };
    $('[data-yes]', m.root).onclick = () => { m.close(); resolve(true); };
  });
}

const fmtSize = n => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
};
const fmtTime = s => s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-';
function duration(from) {
  if (!from) return '-';
  const ms = Date.now() - from;
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h ? `${h} 小时 ${m % 60} 分` : `${m} 分 ${Math.floor((ms % 60000) / 1000)} 秒`;
}

const inst = () => (state.boot?.instances || []).find(i => i.id === state.instId) || null;

// ---------------------------------------------------------------- 目录选择 / 打开
async function openDir(p) {
  if (!p) return;
  try { await api('/api/reveal', { method: 'POST', body: { path: p } }); }
  catch (e) { toast(e.message, 'err'); }
}

/**
 * 目录选择器：服务端实例目录、客户端根目录都靠它选
 * @returns {Promise<string|null>} 选中的目录，取消返回 null
 */
function pickDir({ title = '选择目录', start = '', hint = '' } = {}) {
  return new Promise(resolve => {
    const paths = state.boot?.paths || {};
    let cur = start || paths.home || '';
    const m = modal({
      title,
      wide: true,
      body: `
        <div class="dirbar">
          <button class="btn sm" id="pk-up" title="上级目录">↑</button>
          <input id="pk-path" placeholder="直接输入路径后回车，例如 D:\\MinecraftServers">
          <button class="btn sm" id="pk-go">转到</button>
          <button class="btn sm" id="pk-mk">新建文件夹</button>
        </div>
        <div class="dirbar" id="pk-mkrow" style="display:none">
          <input id="pk-mkname" placeholder="新文件夹名称">
          <button class="btn sm primary" id="pk-mkok">创建</button>
          <button class="btn sm ghost" id="pk-mkno">取消</button>
        </div>
        <div class="dir-quick" id="pk-quick"></div>
        <div class="dir-list" id="pk-list"><div class="muted" style="padding:12px">载入中…</div></div>
        <div class="tip" style="margin-top:10px">${esc(hint || '单击文件夹进入，选中后点右下角「选择此目录」。')}</div>`,
      foot: `<button class="btn" data-close>取消</button><button class="btn primary" id="pk-ok">选择此目录</button>`,
    });
    const $r = sel => $(sel, m.root);
    const listEl = $r('#pk-list');

    const quicks = [
      ...(paths.drives || []).map(d => ({ name: d.name, path: d.path })),
      ...(paths.quick || []),
    ];
    $r('#pk-quick').innerHTML = quicks.map(q =>
      `<button class="chip quick" data-q="${esc(q.path)}">${esc(q.name)}</button>`).join('');
    $$('.quick', m.root).forEach(b => b.onclick = () => load(b.dataset.q));

    const renderDirs = (r) => {
      if (r.error) { listEl.innerHTML = `<div class="muted" style="padding:12px">${esc(r.error)}</div>`; return; }
      if (!r.dirs.length) { listEl.innerHTML = `<div class="muted" style="padding:12px">这个目录下没有子文件夹</div>`; return; }
      listEl.innerHTML = r.dirs.map(d => `
        <div class="dir-item" data-p="${esc(d.path)}">
          <span class="ico">▸</span>
          <span class="nm">${esc(d.name)}</span>
          ${d.link ? '<span class="tag">链接</span>' : ''}
          <span class="spacer"></span>
          <span class="faint" style="font-size:11px">进入</span>
        </div>`).join('');
      $$('.dir-item', listEl).forEach(el => el.onclick = () => load(el.dataset.p));
    };

    const load = async (p) => {
      listEl.innerHTML = '<div class="muted" style="padding:12px"><span class="spin"></span> 读取中…</div>';
      try {
        const r = await api('/api/fs/browse?path=' + encodeURIComponent(p || ''));
        cur = r.path || '';
        $r('#pk-path').value = cur;
        renderDirs(r);
      } catch (e) {
        listEl.innerHTML = `<div class="muted" style="padding:12px">${esc(e.message)}</div>`;
      }
    };

    $r('#pk-up').onclick = () => {
      if (!cur) return;
      const r = api('/api/fs/browse?path=' + encodeURIComponent(cur)).then(x => x.parent).catch(() => '');
      r.then(parent => load(parent || ''));
    };
    $r('#pk-go').onclick = () => { const v = $r('#pk-path').value.trim(); if (v) load(v); };
    $r('#pk-path').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $r('#pk-go').click(); } };
    $r('#pk-mk').onclick = () => { $r('#pk-mkrow').style.display = 'flex'; $r('#pk-mkname').focus(); };
    $r('#pk-mkno').onclick = () => { $r('#pk-mkrow').style.display = 'none'; $r('#pk-mkname').value = ''; };
    $r('#pk-mkok').onclick = async () => {
      const name = $r('#pk-mkname').value.trim().replace(/[\\/:*?"<>|]/g, '_');
      if (!name) { toast('请输入文件夹名', 'err'); return; }
      if (!cur) { toast('请先进入一个目录', 'err'); return; }
      try {
        const sep = cur.includes('/') && !cur.includes('\\') ? '/' : '\\';
        const r = await api('/api/fs/mkdir', { method: 'POST', body: { path: cur.replace(/[\\/]+$/, '') + sep + name } });
        $r('#pk-mkrow').style.display = 'none';
        $r('#pk-mkname').value = '';
        await load(r.path);
        toast('已创建：' + r.path);
      } catch (e) { toast(e.message, 'err'); }
    };
    $r('#pk-ok').onclick = () => {
      if (!cur) { toast('请先选择一个目录', 'err'); return; }
      m.close(); resolve(cur);
    };

    load(cur);
  });
}

/** 删除实例：默认只移除记录，勾选后才删磁盘文件 */
function deleteInstance(id) {
  const i = (state.boot?.instances || []).find(x => x.id === id);
  if (!i) return;
  const running = (i.runtime?.status || 'stopped') !== 'stopped';
  const m = modal({
    title: '删除实例 · ' + i.name,
    body: `
      <div class="kv-box">
        <div><span class="faint">名称</span><b>${esc(i.name)}</b></div>
        <div><span class="faint">核心</span>${esc(i.typeLabel || i.type)} · ${esc(i.mcVersion)}</div>
        <div><span class="faint">目录</span><span class="mono" style="word-break:break-all">${esc(i.dir || '')}</span></div>
      </div>
      ${running ? `<div class="warn-box">服务端正在运行，请先在顶部点「停止」，再删除实例。</div>` : ''}
      <label class="switch" style="margin-top:14px"><input type="checkbox" id="del-files"> 同时删除磁盘上的实例目录</label>
      <div class="tip" style="margin-top:6px">
        不勾选：只从列表移除，目录里的核心、配置、插件、世界全部保留在磁盘上，随时可以重新添加。<br>
        勾选：连同核心 jar 与实例内的世界一起删除，<b style="color:#ff9a94">不可恢复</b>。
        世界如果是指向客户端存档的链接，只会删掉链接本身，不会动客户端存档。
      </div>
      <div class="tip" id="del-arm" style="margin-top:6px;color:#ff9a94"></div>`,
    foot: `<button class="btn" data-close>取消</button><button class="btn danger" id="del-ok" ${running ? 'disabled' : ''}>删除</button>`,
  });
  const okBtn = $('#del-ok', m.root);
  let armed = false;
  $('#del-files', m.root).onchange = () => {
    armed = false;
    okBtn.textContent = '删除';
    $('#del-arm', m.root).textContent = '';
  };
  okBtn.onclick = async () => {
    const files = $('#del-files', m.root).checked;
    // 删文件的路径要求点两次，避免手滑
    if (files && !armed) {
      armed = true;
      okBtn.textContent = '确认删除（含磁盘文件）';
      $('#del-arm', m.root).textContent = '⚠ 再点一次就会把 ' + (i.dir || '该目录') + ' 整个删除，不可恢复。';
      return;
    }
    okBtn.disabled = true;
    try {
      const r = await api(`/api/instances/${i.id}?files=${files ? 1 : 0}`, { method: 'DELETE' });
      m.close();
      if (state.instId === i.id) state.instId = '';
      await boot();
      toast(r.warning || (r.deleted ? '实例与磁盘文件已删除' : '已从列表移除，文件保留在 ' + r.dir), r.warning ? 'warn' : '');
    } catch (e) {
      toast(e.message, 'err');
      okBtn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------- 载入
async function boot() {
  state.boot = await api('/api/bootstrap');
  if (!inst() && state.boot.instances.length) state.instId = state.boot.instances[0].id;
  localStorage.setItem('hmcs.inst', state.instId);
  render();
}

async function refresh(keepView = true) {
  try {
    state.boot = await api('/api/bootstrap');
    renderSidebar(); renderTabs(); renderTopbar();
    if (!keepView) renderView();
  } catch { /* 静默 */ }
}

function render() {
  renderSidebar(); renderTabs(); renderTopbar(); renderView();
}

function renderSidebar() {
  const list = state.boot?.instances || [];
  $('#inst-count').textContent = list.length ? `${list.length} 个` : '';
  $('#inst-list').innerHTML = list.map(i => {
    const st = i.runtime?.status || 'stopped';
    const dot = st === 'running' ? 'on' : (st === 'starting' || st === 'stopping') ? 'starting' : '';
    return `<div class="inst-item ${i.id === state.instId ? 'active' : ''} ${i.missing ? 'missing' : ''}" data-id="${esc(i.id)}">
      <span class="dot ${dot}"></span>
      <div class="meta"><div class="nm">${esc(i.name)}${i.missing ? ' <span class="tag" style="color:#ff9a94;border-color:#4a2020">目录失效</span>' : ''}</div>
      <div class="sub">${esc(i.type)} · ${esc(i.mcVersion)} · :${i.port}</div></div>
      <button class="inst-del" data-del="${esc(i.id)}" title="删除实例">×</button>
    </div>`;
  }).join('') || `<div style="padding:16px 10px;color:var(--faint);font-size:12.5px;line-height:1.7">还没有服务器。<br>点下方按钮新建，核心可直接从官方 / PaperMC 下载。</div>`;
  $$('#inst-list .inst-item').forEach(el => el.onclick = () => {
    state.instId = el.dataset.id;
    localStorage.setItem('hmcs.inst', state.instId);
    state.filesPath = ''; state.cfgTarget = 'props'; state.cfgFile = '';
    disconnectConsole();
    render();
  });
  $$('#inst-list [data-del]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    deleteInstance(b.dataset.del);
  });
}

function renderTabs() {
  $$('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === state.tab);
    t.onclick = () => { state.tab = t.dataset.tab; renderTabs(); renderView(); };
  });
  $('#tabs').classList.toggle('disabled', !inst());
}

function renderTopbar() {
  const i = inst();
  if (!i) {
    $('#tb-title').textContent = 'HMCS Manager';
    $('#tb-sub').textContent = '选择一个服务器实例，或新建一个';
    $('#tb-chips').innerHTML = '';
    $('#tb-actions').innerHTML = '';
    return;
  }
  const st = i.runtime?.status || 'stopped';
  const map = { stopped: ['已停止', ''], starting: ['启动中', 'amber'], running: ['运行中', 'green'], stopping: ['停止中', 'amber'] };
  const [label, cls] = map[st] || ['未知', ''];
  $('#tb-title').textContent = i.name;
  $('#tb-sub').textContent = `${i.typeLabel || i.type} · Minecraft ${i.mcVersion}${i.build ? ' · build ' + i.build : ''}`;
  $('#tb-chips').innerHTML = `
    <span class="chip ${cls}"><span class="dot" style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block"></span>${label}</span>
    <span class="chip blue">:${i.port}</span>
    ${i.eula && !i.eula.accepted ? `<span class="chip" style="color:#ff9a94;border-color:#5c2020" title="未同意 Minecraft EULA，服务端无法启动">EULA 未同意</span>` : ''}
    ${i.upnp && i.upnp.auto ? `<span class="chip">UPnP 自动</span>` : ''}
    ${i.world?.exists ? `<span class="chip">世界 ${esc(i.world.name)}</span>` : ''}
  `;
  const running = st === 'running' || st === 'starting';
  $('#tb-actions').innerHTML = `
    ${running
      ? `<button class="btn" id="tb-stop" ${st === 'stopping' ? 'disabled' : ''}>停止</button>`
      : `<button class="btn primary" id="tb-start">启动</button>`}
    <button class="btn ghost" id="tb-refresh" title="刷新">刷新</button>
  `;
  const bStart = $('#tb-start'); if (bStart) bStart.onclick = openStartDialog;
  const bStop = $('#tb-stop'); if (bStop) bStop.onclick = async () => {
    bStop.disabled = true;
    try { await api(`/api/instances/${i.id}/stop`, { method: 'POST', body: {} }); toast('已发送停止指令'); }
    catch (e) { toast(e.message, 'err'); bStop.disabled = false; }
  };
  $('#tb-refresh').onclick = () => refresh(false);
}

// ---------------------------------------------------------------- 视图分发
async function renderView() {
  const view = $('#view');
  const i = inst();
  if (!i) {
    view.innerHTML = `<div class="empty"><div><h2>还没有服务器实例</h2>
      <p>支持原版（Mojang）、Paper、Purpur、Fabric 核心，直接在线下载；也可以导入磁盘上已有的服务端目录。</p>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <button class="btn primary" id="empty-new">新建服务器</button>
        <button class="btn" id="empty-import">导入已有服务端</button>
      </div></div></div>`;
    $('#empty-new').onclick = openNewDialog;
    $('#empty-import').onclick = openImportDialog;
    return;
  }
  view.innerHTML = `<div class="muted">载入中…</div>`;
  try {
    if (state.tab === 'overview') await viewOverview(i);
    else if (state.tab === 'console') await viewConsole(i);
    else if (state.tab === 'files') await viewFiles(i);
    else if (state.tab === 'config') await viewConfig(i);
    else if (state.tab === 'plugins') await viewPlugins(i);
    else if (state.tab === 'world') await viewWorld(i);
    else if (state.tab === 'network') await viewNetwork(i);
    else if (state.tab === 'settings') await viewSettings(i);
  } catch (e) {
    view.innerHTML = `<div class="card" style="border-color:#4a2020"><b>载入失败</b><div class="hint">${esc(e.message)}</div></div>`;
  }
}

// ---------------------------------------------------------------- 概览
async function viewOverview(i) {
  const logs = await fetchText(`/api/instances/${i.id}/logs?limit=12`).catch(() => '');
  const st = i.runtime?.status || 'stopped';
  const needEula = !i.eula?.accepted;
  $('#view').innerHTML = `
    ${i.missing ? `<div class="section"><div class="card" style="border-color:#5c2020">
      <b style="color:#ff9a94">实例目录不存在</b>
      <div class="hint">记录的位置是 <span class="mono">${esc(i.dir || '')}</span>，但磁盘上没有这个目录。
        可能是被手动移动或删除了。你可以把它移回原位，或者删掉这条记录重新添加。</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn" id="ov-browse-parent">去添加新的存放位置</button>
        <button class="btn danger" id="ov-del2">移除这条记录</button>
      </div>
    </div></div>` : ''}
    ${needEula ? `<div class="section"><div class="card" style="border-color:#5c2020">
      <b style="color:#ff9a94">尚未同意 Minecraft EULA —— 这个实例无法启动</b>
      <div class="hint">Minecraft 服务端启动时必须读到 <code>eula.txt</code> 里的 <code>eula=true</code>，否则会直接退出。
        同意是 Mojang 的要求，Vanilla / Paper / Purpur / Fabric 都一样。</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn primary" id="ov-eula">去同意 EULA</button>
        <a class="btn" href="${esc(i.eula?.url || 'https://aka.ms/MinecraftEULA')}" target="_blank" rel="noopener">查看 EULA 原文</a>
      </div>
    </div></div>` : ''}
    <div class="section">
      <div class="grid">
        <div class="card"><h3>核心</h3><div class="big">${esc(i.type)}</div>
          <div class="hint">${esc(i.coreFile)}${i.build ? ' · build ' + i.build : ''}${i.loaderVersion ? ' · loader ' + i.loaderVersion : ''}</div></div>
        <div class="card"><h3>Minecraft 版本</h3><div class="big">${esc(i.mcVersion)}</div>
          <div class="hint">需要 Java ${i.type === 'fabric' ? '21+' : (String(i.mcVersion).startsWith('26') ? '25+' : '21+')}</div></div>
        <div class="card"><h3>监听端口</h3><div class="big">${i.port}</div><div class="hint">正版验证：${i.onlineMode ? '开启' : '关闭'}</div></div>
        <div class="card"><h3>世界</h3><div class="big">${esc(i.world?.name || i.worldName || 'world')}</div>
          <div class="hint">${i.world?.link ? '链接到 · ' + esc(i.world.linkTarget) : (i.world?.exists ? '实例内目录' : '尚未生成')}</div></div>
        <div class="card"><h3>内存上限</h3><div class="big">${esc(i.memory || '2G')}</div><div class="hint">JVM -Xmx</div></div>
        <div class="card"><h3>运行状态</h3><div class="big">${st === 'running' ? '运行中' : st === 'stopped' ? '已停止' : '启动中'}</div>
          <div class="hint">${st === 'running' ? '已运行 ' + duration(i.runtime.startedAt) : '启动后在此显示运行时长'}</div></div>
        <div class="card"><h3>实例目录</h3><div class="mono" style="font-size:12px;word-break:break-all;line-height:1.6;margin-top:2px">${esc(i.dir || '')}</div>
          <div class="hint">${i.missing ? '<span style="color:#ff9a94">目录不存在</span>' : '实例文件都在这里'}</div></div>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>快捷操作</h2></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="ov-files">打开文件管理</button>
        <button class="btn" id="ov-cfg">编辑 server.properties</button>
        <button class="btn" id="ov-world">更换世界 / 链接存档</button>
        <button class="btn" id="ov-open">打开实例目录</button>
        <button class="btn" id="ov-open-cfg">配置目录</button>
        <button class="btn" id="ov-copy">复制实例路径</button>
        <button class="btn danger" id="ov-del" style="margin-left:auto">删除实例</button>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>最近日志</h2><div class="spacer"></div><button class="btn sm ghost" id="ov-more">查看控制台</button></div>
      <div class="card" style="padding:0"><pre class="mono" style="margin:0;padding:12px 14px;max-height:260px;overflow:auto;color:#9fb0c0;white-space:pre-wrap">${esc(logs || '（尚无日志，启动后这里会实时刷新）')}</pre></div>
    </div>`;
  $('#ov-files').onclick = () => { state.tab = 'files'; renderTabs(); renderView(); };
  $('#ov-cfg').onclick = () => { state.tab = 'config'; state.cfgTarget = 'props'; renderTabs(); renderView(); };
  if ($('#ov-eula')) $('#ov-eula').onclick = () => { state.tab = 'config'; state.cfgTarget = 'eula.txt'; renderTabs(); renderView(); };
  $('#ov-world').onclick = () => { state.tab = 'world'; renderTabs(); renderView(); };
  $('#ov-more').onclick = () => { state.tab = 'console'; renderTabs(); renderView(); };
  $('#ov-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(i.dir || ''); } catch { /* ignore */ }
    toast('已复制：' + (i.dir || ''));
  };
  $('#ov-open').onclick = () => openDir(i.dir);
  $('#ov-open-cfg').onclick = () => openDir(state.boot?.paths?.appDir || '');
  if ($('#ov-browse-parent')) $('#ov-browse-parent').onclick = () => { state.tab = 'settings'; renderTabs(); renderView(); };
  if ($('#ov-del2')) $('#ov-del2').onclick = () => deleteInstance(i.id);
  $('#ov-del').onclick = () => deleteInstance(i.id);
}

// ---------------------------------------------------------------- 控制台
async function viewConsole(i) {
  $('#view').innerHTML = `
    <div class="console-wrap">
      <div class="filebar">
        <span class="chip ${i.runtime?.status === 'running' ? 'green' : ''}">${i.runtime?.status === 'running' ? '运行中' : '未运行'}</span>
        <span class="faint mono">${esc(i.coreFile)}</span>
        <div style="flex:1"></div>
        <button class="btn sm ghost" id="c-clear">清屏</button>
        <button class="btn sm ghost" id="c-logs">下载 latest.log</button>
      </div>
      <div id="console"></div>
      <div class="console-input">
        <input id="c-input" placeholder="输入服务端命令，例如 say hello / op 玩家名 / stop" ${i.runtime?.status === 'running' ? '' : 'disabled'}>
        <button class="btn" id="c-send" ${i.runtime?.status === 'running' ? '' : 'disabled'}>发送</button>
      </div>
    </div>`;
  await connectConsole(i);
  $('#c-input').onkeydown = e => { if (e.key === 'Enter') sendConsole(i); };
  $('#c-send').onclick = () => sendConsole(i);
  $('#c-clear').onclick = async () => { $('#console').innerHTML = ''; await api(`/api/instances/${i.id}/logs/clear`, { method: 'POST', body: {} }).catch(() => {}); };
  $('#c-logs').onclick = () => { window.location = `/api/instances/${i.id}/raw?path=${encodeURIComponent('logs/latest.log')}`; };
}

async function sendConsole(i) {
  const el = $('#c-input');
  const line = el.value.trim();
  if (!line) return;
  el.value = '';
  try { await api(`/api/instances/${i.id}/command`, { method: 'POST', body: { line } }); }
  catch (e) { toast(e.message, 'err'); }
}

function appendConsole(line) {
  const box = $('#console');
  if (!box) return;
  const div = document.createElement('span');
  div.className = 'ln' + (/WARN|警告/.test(line) ? ' warn' : '') + (/ERROR|SEVERE|错误/.test(line) ? ' err' : '') + (/^\[HMCS\]/.test(line) ? ' hys' : '');
  div.textContent = line;
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.appendChild(div);
  if (stick) box.scrollTop = box.scrollHeight;
}

async function connectConsole(i) {
  disconnectConsole();
  const history = await fetchText(`/api/instances/${i.id}/logs?limit=400`).catch(() => '');
  if (!$('#console')) return;
  if (history) history.split('\n').forEach(appendConsole);
  const es = new EventSource(`/api/instances/${i.id}/console`);
  es.addEventListener('log', ev => { try { appendConsole(JSON.parse(ev.data).line); } catch { /* ignore */ } });
  es.addEventListener('status', ev => {
    try {
      const d = JSON.parse(ev.data);
      const input = $('#c-input');
      if (input) input.disabled = d.status !== 'running';
      const btn = $('#c-send'); if (btn) btn.disabled = d.status !== 'running';
      if (d.status === 'stopped') { refresh(true); renderTopbar(); }
    } catch { /* ignore */ }
  });
  state.es = es;
}

function disconnectConsole() {
  if (state.es) { state.es.close(); state.es = null; }
}

// ---------------------------------------------------------------- 文件
async function viewFiles(i) {
  const p = state.filesPath;
  const data = await api(`/api/instances/${i.id}/files?path=${encodeURIComponent(p)}`);
  const parts = p.split('/').filter(Boolean);
  const crumbs = [`<a href="#" data-go="">根目录</a>`].concat(parts.map((s, idx) => `<span>/</span><a href="#" data-go="${esc(parts.slice(0, idx + 1).join('/'))}">${esc(s)}</a>`));
  const rows = data.entries.map(e => `
    <tr class="${e.type === 'dir' ? 'dir' : ''} ${e.link ? 'link' : ''}">
      <td style="width:26px" class="file-icon">${e.type === 'dir' ? '▸' : '·'}</td>
      <td class="nm" data-open="${esc(e.path)}" data-type="${e.type}" data-editable="${e.editable ? 1 : 0}">${esc(e.name)}${e.link ? ' <span class="tag">链接</span>' : ''}</td>
      <td class="right mono faint" style="width:96px">${e.type === 'dir' ? '-' : fmtSize(e.size)}</td>
      <td class="mono faint" style="width:170px">${fmtTime(e.mtime)}</td>
      <td style="width:170px">
        <div class="act">
          ${e.type === 'file' ? `<button class="btn sm ghost" data-dl="${esc(e.path)}">下载</button>` : ''}
          <button class="btn sm ghost" data-ren="${esc(e.path)}">改名</button>
          <button class="btn sm ghost" data-del="${esc(e.path)}" data-dir="${e.type === 'dir' ? 1 : 0}">删除</button>
        </div>
      </td>
    </tr>`).join('');

  $('#view').innerHTML = `
    <div class="filebar">
      <button class="btn sm" id="f-up" ${p ? '' : 'disabled'}>上一级</button>
      <button class="btn sm" id="f-refresh">刷新</button>
      <button class="btn sm" id="f-mkdir">新建文件夹</button>
      <button class="btn sm" id="f-upload">上传文件</button>
      <input type="file" id="f-file" style="display:none" multiple>
      <div style="flex:1"></div>
      <span class="faint" style="font-size:12px">${data.entries.length} 项</span>
    </div>
    <div class="crumbs">${crumbs.join(' ')}</div>
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th></th><th>名称</th><th class="right">大小</th><th>修改时间</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="faint" style="padding:22px;text-align:center">空目录</td></tr>`}</tbody>
      </table>
    </div>
    <div class="faint" style="margin-top:8px;font-size:12px">提示：world 若是链接，会标记「链接」，其内容来自你选择的存档，删除链接不会删除真实存档。</div>`;

  $$('[data-go]').forEach(a => a.onclick = e => { e.preventDefault(); state.filesPath = a.dataset.go; renderView(); });
  $('#f-up').onclick = () => { state.filesPath = parts.slice(0, -1).join('/'); renderView(); };
  $('#f-refresh').onclick = () => renderView();
  $('#f-mkdir').onclick = async () => {
    const name = prompt('新文件夹名称');
    if (!name) return;
    try { await api(`/api/instances/${i.id}/mkdir`, { method: 'POST', body: { path: [p, name].filter(Boolean).join('/') } }); renderView(); }
    catch (e) { toast(e.message, 'err'); }
  };
  $('#f-upload').onclick = () => $('#f-file').click();
  $('#f-file').onchange = async e => {
    for (const f of e.target.files) {
      try {
        await fetch(`/api/instances/${i.id}/upload?path=${encodeURIComponent(p)}&name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
        toast('已上传 ' + f.name);
      } catch (err) { toast('上传失败: ' + f.name, 'err'); }
    }
    renderView();
  };
  $$('[data-open]').forEach(td => td.onclick = () => {
    const path = td.dataset.open;
    if (td.dataset.type === 'dir') { state.filesPath = path; renderView(); }
    else if (td.dataset.editable === '1') openEditor(i, path);
    else window.location = `/api/instances/${i.id}/raw?path=${encodeURIComponent(path)}`;
  });
  $$('[data-dl]').forEach(b => b.onclick = () => { window.location = `/api/instances/${i.id}/raw?path=${encodeURIComponent(b.dataset.dl)}`; });
  $$('[data-ren]').forEach(b => b.onclick = async () => {
    const from = b.dataset.ren;
    const base = from.split('/').pop();
    const next = prompt('新名称', base);
    if (!next || next === base) return;
    const to = from.split('/').slice(0, -1).concat(next).join('/');
    try { await api(`/api/instances/${i.id}/rename`, { method: 'POST', body: { from, to } }); renderView(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-del]').forEach(b => b.onclick = async () => {
    const path = b.dataset.del;
    if (!await confirmBox(`确认删除 <b>${esc(path)}</b> ？${b.dataset.dir === '1' ? '<br><span class="muted">目录会被递归删除。</span>' : ''}`)) return;
    try { await api(`/api/instances/${i.id}/entry?path=${encodeURIComponent(path)}`, { method: 'DELETE' }); renderView(); toast('已删除'); }
    catch (e) { toast(e.message, 'err'); }
  });
}

async function openEditor(i, path) {
  const data = await api(`/api/instances/${i.id}/file?path=${encodeURIComponent(path)}`);
  const m = modal({
    title: path,
    wide: true,
    body: `<textarea class="editor" id="ed" spellcheck="false">${esc(data.content)}</textarea>
      <div class="faint" style="font-size:11.5px;margin-top:6px">${fmtSize(data.size)} · 修改于 ${fmtTime(data.mtime)} · 保存会直接写入磁盘</div>`,
    foot: `<button class="btn" data-close>取消</button><button class="btn primary" id="ed-save">保存</button>`,
  });
  $('#ed-save', m.root).onclick = async () => {
    try {
      await api(`/api/instances/${i.id}/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: { path, content: $('#ed', m.root).value } });
      toast('已保存'); m.close();
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ---------------------------------------------------------------- 配置
async function viewConfig(i) {
  const list = await api(`/api/instances/${i.id}/config/list`);
  const eulaItem = list.files.find(f => f.kind === 'eula') || { file: 'eula.txt', exists: false, kind: 'eula', accepted: false };
  const items = [{ file: 'server.properties', exists: true, kind: 'props' }, ...list.files.filter(f => f.kind !== 'eula')];
  if (state.cfgTarget !== 'props' && state.cfgTarget !== 'eula.txt' && !items.some(f => f.file === state.cfgTarget)) state.cfgTarget = 'props';

  const nav = items.map(f => `<button data-cfg="${esc(f.file)}" class="${state.cfgTarget === f.file ? 'active' : ''}">
      ${esc(f.file)}${f.exists ? '' : ' <span class="faint">·未生成</span>'}</button>`).join('');
  const navEula = `<button data-cfg="eula.txt" class="${state.cfgTarget === 'eula.txt' ? 'active' : ''}">
      eula.txt <span class="chip ${eulaItem.accepted ? 'green' : ''}" style="margin-left:4px">${eulaItem.accepted ? '已同意' : '未同意'}</span></button>`;

  $('#view').innerHTML = `
    <div class="cfg-layout">
      <div>
        <div class="cfg-nav">
          <div class="grp">协议</div>
          ${navEula}
          <div class="grp">服务器</div>
          ${nav}
        </div>
      </div>
      <div id="cfg-main"><div class="muted">载入中…</div></div>
    </div>`;

  $$('[data-cfg]').forEach(b => b.onclick = () => {
    state.cfgTarget = b.dataset.cfg;
    if (state.cfgTarget !== 'props') state.cfgFile = state.cfgTarget;
    renderView();
  });

  if (state.cfgTarget === 'props') await renderPropsForm(i);
  else if (state.cfgTarget === 'eula.txt') await renderEula(i);
  else await renderFileConfig(i, state.cfgTarget);
}

// ---------------------------------------------------------------- EULA
async function renderEula(i) {
  const box = $('#cfg-main');
  let d;
  try { d = await api(`/api/instances/${i.id}/eula`); }
  catch (e) { box.innerHTML = `<div class="card"><b>读取 eula.txt 失败</b><div class="hint">${esc(e.message)}</div></div>`; return; }

  let textMode = false;

  const paint = () => {
    if (textMode) {
      box.innerHTML = `
        <div class="filebar">
          <span class="chip">TEXT</span>
          <span class="faint mono">eula.txt</span>
          <div style="flex:1"></div>
          <button class="btn sm ghost" id="eu-form">返回表单</button>
          <button class="btn primary" id="eu-tsave">保存</button>
        </div>
        <div class="card" style="padding:0;overflow:hidden">
          <textarea id="eu-text" spellcheck="false" style="width:100%;min-height:300px;border:0;background:transparent;color:inherit;font-family:ui-monospace,Consolas,'Cascadia Mono',monospace;font-size:13px;line-height:1.7;padding:14px;resize:vertical;outline:none">${esc(d.text)}</textarea>
        </div>
        <div class="faint" style="margin-top:8px;font-size:12px">
          直接编辑文件原文，保存后以文件内容为准：只有出现 <code>eula=true</code> 这一行才算已同意，注释行随意。
        </div>`;
      $('#eu-form').onclick = () => { textMode = false; paint(); };
      $('#eu-tsave').onclick = async () => {
        try {
          d = await api(`/api/instances/${i.id}/eula`, { method: 'PUT', body: { text: $('#eu-text').value } });
          toast(d.accepted ? '已保存，当前状态：已同意' : '已保存，当前状态：未同意');
          await refresh(false);
        } catch (e) { toast(e.message, 'err'); }
      };
      return;
    }

    const on = d.accepted;
    box.innerHTML = `
      <div class="filebar">
        <span class="chip ${on ? 'green' : ''}">${on ? '已同意' : '未同意'}</span>
        <span class="faint mono">${esc(d.file)}</span>
        <div style="flex:1"></div>
        <button class="btn sm ghost" id="eu-raw">文本模式</button>
        <button class="btn sm ghost" id="eu-reload">重载</button>
      </div>

      ${on ? `<div class="card" style="border-color:#1f4a2c;margin-bottom:12px">
          <b style="color:#6cc98a">当前已同意 Minecraft EULA</b>
          <div class="hint">eula.txt 中为 <code>eula=true</code>，服务端可以正常启动。${d.updatedAt ? '最后修改：' + fmtTime(d.updatedAt) : ''}</div>
        </div>`
        : `<div class="card" style="border-color:#5c2020;margin-bottom:12px">
          <b style="color:#ff9a94">未同意 EULA —— 服务端会拒绝启动</b>
          <div class="hint">Minecraft 服务端在启动时检查 eula.txt，没有 <code>eula=true</code> 会直接退出（日志提示 “You need to agree to the EULA”）。
            这是 Mojang 的强制要求，任何服务端实现（Vanilla / Paper / Purpur / Fabric）都一样。</div>
        </div>`}

      <div class="section">
        <div class="section-head"><h2>最终用户许可协议</h2>
          <div class="desc">Minecraft EULA</div></div>
        <div class="card">
          <div class="hint" style="margin-bottom:14px">
            勾选下方复选框表示你已阅读并同意
            <a href="${esc(d.url)}" target="_blank" rel="noopener">Minecraft 最终用户许可协议</a>
            （<span class="mono">${esc(d.url)}</span>）。本工具不会替你同意——这一步必须由你本人确认，
            写入后立即生效，重启服务端即可。
          </div>
          <label class="switch"><input type="checkbox" id="eu-check" ${on ? 'checked' : ''}>
            我已阅读并同意 Minecraft EULA</label>
          <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center">
            <button class="btn primary" id="eu-save">${on ? '保存' : '同意并写入'}</button>
            <button class="btn danger" id="eu-revoke" ${on ? '' : 'disabled'}>撤销同意</button>
            <div style="flex:1"></div>
            <span class="faint" style="font-size:12px">文件：<span class="mono">${esc(d.path || d.file)}</span></span>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h2>文件内容</h2><div class="desc">eula.txt</div></div>
        <div class="card" style="padding:0">
          <pre class="mono" style="margin:0;padding:14px;white-space:pre-wrap;color:#9fb0c0;max-height:240px;overflow:auto">${esc(d.text || '（文件尚未生成，同意后会按原版格式创建）')}</pre>
        </div>
        <div class="faint" style="margin-top:8px;font-size:12px">
          撤销同意只会把这一行改成 <code>eula=false</code>，不会删除文件；之后服务端将无法启动，直到重新同意。
        </div>
      </div>`;

    $('#eu-raw').onclick = () => { textMode = true; paint(); };
    $('#eu-reload').onclick = () => renderView();
    $('#eu-save').onclick = async () => {
      const want = $('#eu-check').checked;
      if (!want && !on) { toast('未勾选，无需保存'); return; }
      if (!want && on) { toast('若要撤销同意，请点右侧「撤销同意」', 'err'); return; }
      try {
        d = await api(`/api/instances/${i.id}/eula`, { method: 'PUT', body: { accepted: true } });
        toast('已写入 eula=true，服务端现在可以启动');
        await refresh(false);
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#eu-revoke').onclick = async () => {
      if (!await confirmBox('撤销同意后服务端将无法启动，确定吗？<br><span class="muted">eula.txt 会改为 eula=false，文件本身保留。</span>')) return;
      try {
        d = await api(`/api/instances/${i.id}/eula`, { method: 'PUT', body: { accepted: false } });
        toast('已撤销，eula=false');
        await refresh(false);
      } catch (e) { toast(e.message, 'err'); }
    };
  };

  paint();
}

async function renderPropsForm(i) {
  const data = await api(`/api/instances/${i.id}/config/properties`);
  const groups = data.schema.map(g => g.group);
  const fieldHtml = (f) => {
    const val = data.values[f.key] ?? '';
    let ctl;
    if (f.type === 'bool') {
      ctl = `<label class="switch"><input type="checkbox" data-k="${f.key}" data-type="bool" ${String(val).toLowerCase() === 'true' ? 'checked' : ''}> ${String(val).toLowerCase() === 'true' ? 'true' : 'false'}</label>`;
    } else if (f.type === 'enum') {
      ctl = `<select data-k="${f.key}" data-type="enum">${f.options.map(o => `<option value="${esc(o)}" ${String(val) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else {
      ctl = `<input type="${f.type === 'int' ? 'number' : 'text'}" data-k="${f.key}" data-type="${f.type}" value="${esc(val)}">`;
    }
    return `<div class="field" data-fkey="${esc(f.key)}">
      <label>${esc(f.label)}<span class="desc">${esc(f.key)}<br>${esc(f.desc || '')}</span></label>
      <div class="ctl">${ctl}</div></div>`;
  };
  const sections = data.schema.map(g => `
    <div class="section" data-group="${esc(g.group)}">
      <div class="section-head"><h2>${esc(g.group)}</h2></div>
      <div class="card">${g.fields.map(fieldHtml).join('')}</div>
    </div>`).join('');
  const extraKeys = Object.keys(data.values).filter(k => !data.schema.some(g => g.fields.some(f => f.key === k)));

  $('#cfg-main').innerHTML = `
    <div class="filebar">
      <input id="cfg-search" placeholder="搜索配置项…" style="width:240px">
      <div style="flex:1"></div>
      <span class="faint" style="font-size:12px">${data.exists ? '' : '文件尚不存在，保存后会生成'}</span>
      <button class="btn primary" id="cfg-save">保存</button>
    </div>
    ${sections}
    ${extraKeys.length ? `<div class="section"><div class="section-head"><h2>其他键</h2><div class="desc">未在常用清单中，可直接编辑原始值</div></div>
      <div class="card">${extraKeys.map(k => `<div class="field"><label>${esc(k)}<span class="desc">原样保留</span></label>
        <div class="ctl"><input type="text" data-k="${esc(k)}" data-type="text" value="${esc(data.values[k])}"></div></div>`).join('')}</div></div>` : ''}
    <div class="faint" style="font-size:12px">保存只改动你修改的键，注释与顺序保持原样。修改端口 / 世界名后需重启生效。</div>`;

  $('#cfg-search').oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    $$('[data-fkey]').forEach(el => {
      el.style.display = !q || el.dataset.fkey.toLowerCase().includes(q) || el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  };
  $('#cfg-save').onclick = async () => {
    const values = {};
    $$('[data-k]').forEach(el => {
      if (el.type === 'checkbox') values[el.dataset.k] = el.checked ? 'true' : 'false';
      else values[el.dataset.k] = el.value;
    });
    try {
      await api(`/api/instances/${i.id}/config/properties`, { method: 'PUT', body: { values } });
      toast('server.properties 已保存'); refresh(true); renderTopbar();
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function renderFileConfig(i, file) {
  const data = await api(`/api/instances/${i.id}/config/file?file=${encodeURIComponent(file)}`);
  state.cfgKind = data.kind;
  state.cfgFile = file;
  state.cfgData = data.data;
  state.cfgRaw = data.raw;

  if (!data.exists) {
    $('#cfg-main').innerHTML = `<div class="card"><b>${esc(file)}</b> 尚未生成。
      <div class="hint">启动一次服务端后会自动生成；也可以现在新建。</div>
      <button class="btn" id="cfg-create" style="margin-top:10px">新建空文件</button></div>`;
    $('#cfg-create').onclick = async () => {
      await api(`/api/instances/${i.id}/config/file`, { method: 'PUT', body: { file, raw: data.kind === 'json' ? '[]\n' : '{}\n' } });
      renderView();
    };
    return;
  }
  if (data.error) {
    $('#cfg-main').innerHTML = `<div class="card" style="border-color:#4a2020"><b>解析失败</b><div class="hint">${esc(data.error)}</div>
      <button class="btn" id="cfg-rawmode" style="margin-top:10px">改用文本编辑</button></div>`;
    $('#cfg-rawmode').onclick = () => rawEditor(i, file, data.raw);
    return;
  }

  $('#cfg-main').innerHTML = `
    <div class="filebar">
      <span class="chip blue">${data.kind.toUpperCase()}</span>
      <span class="faint mono">${esc(file)}</span>
      <div style="flex:1"></div>
      <button class="btn sm ghost" id="cfg-raw">文本模式</button>
      <button class="btn sm ghost" id="cfg-reload">重载</button>
      <button class="btn primary" id="cfg-save">保存</button>
    </div>
    <div class="card tree" id="cfg-tree"></div>
    <div class="faint" style="margin-top:8px;font-size:12px">表单模式会重写文件（YAML 注释会丢失）；需要保留注释请用「文本模式」。</div>`;

  renderTree($('#cfg-tree'), state.cfgData, []);
  $('#cfg-raw').onclick = () => rawEditor(i, file, state.cfgRaw);
  $('#cfg-reload').onclick = () => renderView();
  $('#cfg-save').onclick = async () => {
    try {
      await api(`/api/instances/${i.id}/config/file`, { method: 'PUT', body: { file, data: state.cfgData } });
      toast('已保存（原文件备份为 .hmcs.bak）'); renderView();
    } catch (e) { toast(e.message, 'err'); }
  };
}

function rawEditor(i, file, raw) {
  const m = modal({
    title: file + '（文本模式）',
    wide: true,
    body: `<textarea class="editor" id="ed" spellcheck="false">${esc(raw)}</textarea>`,
    foot: `<button class="btn" data-close>取消</button><button class="btn primary" id="raw-save">保存</button>`,
  });
  $('#raw-save', m.root).onclick = async () => {
    try {
      await api(`/api/instances/${i.id}/config/file`, { method: 'PUT', body: { file, raw: $('#ed', m.root).value } });
      toast('已保存'); m.close(); renderView();
    } catch (e) { toast(e.message, 'err'); }
  };
}

const getPath = (obj, path) => path.reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, val) {
  let o = obj;
  for (let k = 0; k < path.length - 1; k++) o = o[path[k]];
  o[path[path.length - 1]] = val;
}

function renderTree(container, node, path) {
  container.innerHTML = '';
  const isObj = node && typeof node === 'object' && !Array.isArray(node);

  if (Array.isArray(node)) {
    node.forEach((v, idx) => {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.innerHTML = `<div class="tree-key">[${idx}]</div><div class="tree-val"></div>
        <div class="kv-actions"><button class="btn sm ghost" data-del>删除</button></div>`;
      const valBox = $('.tree-val', row);
      if (v && typeof v === 'object') {
        const child = document.createElement('div');
        child.className = 'tree-children';
        valBox.appendChild(child);
        renderTree(child, v, path.concat(idx));
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = v == null ? '' : String(v);
        input.oninput = () => { node[idx] = coerce(input.value); };
        valBox.appendChild(input);
      }
      $('[data-del]', row).onclick = () => { node.splice(idx, 1); renderTree(container, node, path); };
      container.appendChild(row);
    });
    const add = document.createElement('div');
    add.className = 'tree-add';
    add.innerHTML = `<button class="btn sm ghost">+ 添加一项</button>`;
    add.firstElementChild.onclick = () => { node.push(''); renderTree(container, node, path); };
    container.appendChild(add);
    return;
  }

  if (isObj) {
    Object.keys(node).forEach(key => {
      const v = node[key];
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.innerHTML = `<div class="tree-key">${esc(key)}</div><div class="tree-val"></div>
        <div class="kv-actions"><button class="btn sm ghost" data-del>删除</button></div>`;
      const valBox = $('.tree-val', row);
      if (v && typeof v === 'object') {
        const child = document.createElement('div');
        child.className = 'tree-children';
        valBox.appendChild(child);
        renderTree(child, v, path.concat(key));
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = v == null ? '' : String(v);
        input.oninput = () => { node[key] = coerce(input.value); };
        valBox.appendChild(input);
      }
      $('[data-del]', row).onclick = () => { delete node[key]; renderTree(container, node, path); };
      container.appendChild(row);
    });
    if (path.length) {
      const add = document.createElement('div');
      add.className = 'tree-add';
      add.innerHTML = `<button class="btn sm ghost">+ 添加键</button>`;
      add.firstElementChild.onclick = () => {
        const k = prompt('键名');
        if (!k) return;
        node[k] = '';
        renderTree(container, node, path);
      };
      container.appendChild(add);
    }
    return;
  }

  container.textContent = String(node);
}

function coerce(v) {
  const t = String(v).trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);
  return v;
}

// ---------------------------------------------------------------- 插件
async function viewPlugins(i) {
  if (i.type === 'vanilla') {
    $('#view').innerHTML = `<div class="card"><b>原版服务端不支持插件</b><div class="hint">若需要插件生态，请新建 Paper / Purpur 实例；Fabric 实例对应的是服务端模组。</div></div>`;
    return;
  }
  const inst2 = await api(`/api/plugins/installed?instId=${i.id}`);
  $('#view').innerHTML = `
    <div class="filebar">
      <input id="p-q" placeholder="搜索插件（EssentialsX、WorldEdit、LuckPerms…）" style="width:320px">
      <button class="btn" id="p-search">搜索</button>
      <div style="flex:1"></div>
      <span class="chip blue">${esc(i.type)} · ${esc(i.mcVersion)}</span>
    </div>
    <div class="section">
      <div class="section-head"><h2>已安装</h2><div class="desc">${esc(inst2.dir)}/ · ${inst2.items.length} 个</div></div>
      <div class="card" style="padding:0"><table>
        <thead><tr><th>文件</th><th class="right">大小</th><th>时间</th><th></th></tr></thead>
        <tbody>${inst2.items.map(f => `<tr><td class="mono">${esc(f.name)}</td><td class="right mono faint">${fmtSize(f.size)}</td>
          <td class="mono faint">${fmtTime(f.mtime)}</td>
          <td class="right"><button class="btn sm ghost" data-pdel="${esc(f.name)}">删除</button></td></tr>`).join('')
          || `<tr><td colspan="4" class="faint" style="padding:18px;text-align:center">还没有安装插件</td></tr>`}</tbody>
      </table></div>
    </div>
    <div class="section">
      <div class="section-head"><h2>搜索结果</h2><div class="desc">数据来自 Modrinth</div></div>
      <div id="p-results" class="plug-grid"><div class="muted">输入关键词后搜索</div></div>
    </div>`;

  const doSearch = async () => {
    const q = $('#p-q').value.trim();
    $('#p-results').innerHTML = `<div class="muted"><span class="spin"></span> 搜索中…</div>`;
    try {
      const r = await api(`/api/plugins/search?instId=${i.id}&q=${encodeURIComponent(q)}`);
      if (r.note) { $('#p-results').innerHTML = `<div class="muted">${esc(r.note)}</div>`; return; }
      $('#p-results').innerHTML = r.hits.map(h => `
        <div class="plug">
          ${h.icon ? `<img src="${esc(h.icon)}" alt="" loading="lazy">` : `<div style="width:40px;height:40px;border-radius:8px;background:#1a2430"></div>`}
          <div class="body">
            <div class="nm">${esc(h.title)}</div>
            <div class="ds">${esc(h.description)}</div>
            <div class="foot"><span>${esc(h.author)}</span><span>·</span><span>${(h.downloads / 1000).toFixed(1)}k 下载</span>
              <div style="flex:1"></div><button class="btn sm primary" data-pin="${esc(h.id)}" data-name="${esc(h.title)}">安装</button></div>
          </div>
        </div>`).join('') || `<div class="muted">没有匹配的插件</div>`;
      $$('[data-pin]').forEach(b => b.onclick = () => openPluginVersions(i, b.dataset.pin, b.dataset.name));
    } catch (e) { $('#p-results').innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  };
  $('#p-search').onclick = doSearch;
  $('#p-q').onkeydown = e => { if (e.key === 'Enter') doSearch(); };
  $$('[data-pdel]').forEach(b => b.onclick = async () => {
    if (!await confirmBox(`删除插件 <b>${esc(b.dataset.pdel)}</b>？`)) return;
    try {
      await api(`/api/instances/${i.id}/entry?path=${encodeURIComponent(inst2.dir + '/' + b.dataset.pdel)}`, { method: 'DELETE' });
      toast('已删除'); renderView();
    } catch (e) { toast(e.message, 'err'); }
  });
}

async function openPluginVersions(i, projectId, name) {
  const m = modal({ title: '安装 · ' + name, wide: true, body: `<div class="muted"><span class="spin"></span> 获取可用版本…</div>`, foot: `<button class="btn" data-close>关闭</button>` });
  try {
    const r = await api(`/api/plugins/versions?id=${encodeURIComponent(projectId)}&instId=${i.id}`);
    if (!r.versions.length) { $('.modal-body', m.root).innerHTML = '<div class="muted">没有找到适配当前版本的文件</div>'; return; }
    $('.modal-body', m.root).innerHTML = `
      <div class="pick-list">${r.versions.slice(0, 40).map((v, idx) => `
        <label class="pick ${idx === 0 ? 'sel' : ''}">
          <input type="radio" name="pv" value="${esc(v.id)}" ${idx === 0 ? 'checked' : ''}>
          <div style="flex:1">
            <div class="nm">${esc(v.versionNumber)} <span class="tag">${esc((v.gameVersions || []).slice(0, 3).join(', '))}</span></div>
            <div class="sub">${esc((v.loaders || []).join(' / '))} · ${fmtTime(v.date)} · ${fmtSize(v.files[0]?.size || 0)}</div>
          </div>
        </label>`).join('')}</div>
      <div class="faint" style="margin-top:8px;font-size:12px">默认选中最新且适配此 MC 版本的构建</div>`;
    $('.modal-foot', m.root).innerHTML = `<button class="btn" data-close>取消</button><button class="btn primary" id="pv-ok">下载并安装</button>`;
    $$('[data-close]', m.root).forEach(b => b.onclick = m.close);
    $('#pv-ok', m.root).onclick = async () => {
      const sel = $('input[name=pv]:checked', m.root);
      try {
        $('#pv-ok', m.root).disabled = true;
        $('#pv-ok', m.root).innerHTML = '<span class="spin"></span> 下载中…';
        const res = await api('/api/plugins/install', { method: 'POST', body: { instId: i.id, projectId, versionId: sel.value } });
        toast('已安装 ' + res.file); m.close(); renderView();
      } catch (e) { toast(e.message, 'err'); $('#pv-ok', m.root).disabled = false; $('#pv-ok', m.root).textContent = '重试'; }
    };
  } catch (e) {
    $('.modal-body', m.root).innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------- 世界
async function viewWorld(i) {
  const data = await api('/api/worlds');
  const cur = i.world || {};
  const clientRoots = state.boot?.settings?.clientRoots || [];
  $('#view').innerHTML = `
    ${clientRoots.length ? '' : `<div class="section"><div class="card" style="border-color:#5c451a">
      <b style="color:#f0c674">还没有添加客户端实例</b>
      <div class="hint">世界面板会从客户端实例（.minecraft 目录）里读取存档，用来给服务端做链接或复制。
        先去设置里添加一个，或让 HMCS 自动检测本机的启动器目录。</div>
      <div style="margin-top:12px"><button class="btn primary" id="w-goset">去添加客户端实例</button></div>
    </div></div>`}
    <div class="section">
      <div class="section-head"><h2>当前世界</h2><div class="spacer"></div>
        ${cur.link ? `<button class="btn sm" id="w-detach">断开链接</button>` : ''}
        <button class="btn sm" id="w-refresh">重新扫描</button>
      </div>
      <div class="card">
        ${cur.exists ? `
          <div style="display:flex;gap:24px;flex-wrap:wrap">
            <div><div class="faint" style="font-size:11.5px">世界名</div><div class="mono" style="font-size:15px">${esc(cur.name)}</div></div>
            <div><div class="faint" style="font-size:11.5px">DataVersion</div><div class="mono" style="font-size:15px">${cur.dataVersion} ${cur.versionName ? `<span class="tag">${esc(cur.versionName)}</span>` : ''}</div></div>
            <div><div class="faint" style="font-size:11.5px">来源</div><div class="mono" style="font-size:13px">${cur.link ? esc(cur.linkTarget) : '实例内真实目录'}</div></div>
          </div>` : `<div class="muted">实例内还没有世界目录，首次启动会自动生成，或从下方列表链接一个已有存档。</div>`}
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>本机已有存档</h2><div class="desc">来自客户端实例 / 版本隔离目录，可直接链接，不必拷贝</div></div>
      <div class="card" style="padding:0;overflow:auto">
        <table>
          <thead><tr><th>世界</th><th>版本</th><th>来源</th><th class="right">大小</th><th>修改时间</th><th></th></tr></thead>
          <tbody>${data.worlds.map(w => `
            <tr>
              <td><div style="font-size:13px">${esc(w.name)} ${w.isLink ? '<span class="tag">已是链接</span>' : ''}</div>
                  <div class="faint mono" style="font-size:11px">${esc(w.path)}</div></td>
              <td class="mono">${w.dataVersion || '-'} ${w.versionName ? `<span class="tag">${esc(w.versionName)}</span>` : ''}</td>
              <td class="faint" style="font-size:11.5px">${esc(w.origin)}</td>
              <td class="right mono faint">${fmtSize(w.size)}${w.truncated ? '+' : ''}</td>
              <td class="mono faint">${fmtTime(w.mtime)}</td>
              <td class="right" style="white-space:nowrap">
                <button class="btn sm" data-link="${esc(w.path)}" data-name="${esc(w.name)}">链接</button>
                <button class="btn sm ghost" data-copy="${esc(w.path)}" data-name="${esc(w.name)}">复制</button>
              </td>
            </tr>`).join('') || `<tr><td colspan="6" class="faint" style="padding:20px;text-align:center">没有扫描到存档</td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="faint" style="margin-top:8px;font-size:12px">
        链接 = 服务端直接读写该存档本身（同一份数据，双向同步）；复制 = 复制一份到实例内，之后互不影响。
        若世界版本高于服务端版本，服务端将无法加载。
      </div>
    </div>`;

  $('#w-refresh').onclick = async () => { await api('/api/worlds?force=1'); renderView(); };
  if ($('#w-goset')) $('#w-goset').onclick = () => { state.tab = 'settings'; renderTabs(); renderView(); };
  const detach = $('#w-detach');
  if (detach) detach.onclick = async () => {
    if (!await confirmBox('断开链接只会移除链接，真实存档不会被删除。继续？')) return;
    try { await api(`/api/instances/${i.id}/world/detach`, { method: 'POST', body: {} }); toast('已断开'); refresh(false); renderView(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const attach = async (source, name, mode) => {
    try {
      const r = await api(`/api/instances/${i.id}/world/attach`, { method: 'POST', body: { source, worldName: name, mode } });
      toast(`${mode === 'copy' ? '已复制' : '已链接'}：${r.worldName}`);
      await refresh(false); renderView();
    } catch (e) { toast(e.message, 'err'); }
  };
  $$('[data-link]').forEach(b => b.onclick = async () => {
    const name = prompt('在服务端使用的世界目录名', b.dataset.name);
    if (!name) return;
    await attach(b.dataset.link, name, 'link');
  });
  $$('[data-copy]').forEach(b => b.onclick = async () => {
    const name = prompt('复制到服务端的目录名', b.dataset.name);
    if (!name) return;
    toast('开始复制，较大存档需要等待…', 'warn');
    await attach(b.dataset.copy, name, 'copy');
  });
}

// ---------------------------------------------------------------- 网络 / UPnP
function isPrivateIp(ip) {
  if (!ip) return false;
  return /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)   // 运营商级 NAT 100.64/10
    || /^169\.254\./.test(ip);
}

const fmtLease = n => (!n ? '永久' : n >= 3600 ? (n / 3600) + ' 小时' : n + ' 秒');

async function viewNetwork(i) {
  const view = $('#view');
  view.innerHTML = `<div class="card"><span class="spin"></span> 正在探测支持 UPnP 的网关…</div>`;

  let st;
  try {
    st = await api(`/api/upnp/status?instId=${encodeURIComponent(i.id)}&probe=1`);
  } catch (e) {
    view.innerHTML = `<div class="card" style="border-color:#4a2020"><b>探测失败</b><div class="hint">${esc(e.message)}</div></div>`;
    return;
  }

  const cfg = st.instance || { auto: false, externalPort: 0, protocol: 'TCP', lease: 0 };
  const gw = st.gateway;
  const serverPort = st.serverPort || i.port;
  const addedKeys = new Set((st.added || []).map(a => a.protocol + '/' + a.externalPort));
  const cgnat = isPrivateIp(st.externalIp);

  const gwSection = gw
    ? `<div class="grid">
        <div class="card"><h3>网关设备</h3><div class="big">${esc(gw.friendlyName)}</div>
          <div class="hint">${esc([gw.manufacturer, gw.modelName].filter(Boolean).join(' · ') || '—')}</div>
          ${gw.iface ? `<div class="hint">通过网卡 ${esc(gw.iface)}（${esc(gw.ifaceIp)}）发现</div>` : ''}</div>
        <div class="card"><h3>本机内网地址</h3><div class="big mono">${esc(st.localIp)}</div>
          <div class="hint">映射会把外网端口转到这个地址</div></div>
        <div class="card"><h3>公网 IP</h3><div class="big mono">${esc(st.externalIp || '未知')}</div>
          <div class="hint">${cgnat ? '<span style="color:#e3b341">这是内网/CGNAT 地址，外网仍无法直连</span>' : (st.externalError ? esc(st.externalError) : '由网关上报')}</div></div>
        <div class="card"><h3>服务端端口</h3><div class="big">${serverPort}</div>
          <div class="hint">来自 server.properties 的 server-port</div></div>
      </div>`
    : `<div class="card" style="border-color:#4a2020">
        <b>没有发现可用的 UPnP 网关</b>
        <div class="hint">${esc(st.gatewayError || '未知原因')}</div>
        ${st.hint ? `<div class="hint">${esc(st.hint)}</div>` : ''}
        ${(st.interfaces || []).length ? `<div class="hint" style="margin-top:10px"><b>本机网卡</b></div>
        <div class="hint mono" style="font-size:12px;line-height:1.9">${(st.interfaces || []).map(f => {
          const d = (st.diag && st.diag.ifaces || []).find(x => x.address === f.address);
          const sent = d ? (d.tried ? '已发送' : '未发送') : '未发送';
          return `${esc(f.name)}　${esc(f.address)}　${f.virtual ? '<span class="tag">虚拟网卡</span>' : ''}　${sent}`;
        }).join('<br>')}</div>` : ''}
        <div class="hint">手动转发：在路由器管理页面把 TCP ${serverPort} 转发到本机 ${esc(st.localIp)}:${serverPort}，效果与自动映射完全一致。</div>
      </div>`;

  const rows = (st.mappings || []).map(m => {
    const mine = m.internalClient === st.localIp;
    const hys = addedKeys.has(m.protocol + '/' + m.externalPort);
    return `<tr>
      <td class="mono">${esc(m.protocol)}</td>
      <td class="mono">${m.externalPort}</td>
      <td class="mono">${esc(m.internalClient)}:${m.internalPort}</td>
      <td>${esc(m.description || '-')} ${hys ? '<span class="tag">HMCS</span>' : ''} ${mine && !hys ? '<span class="tag">本机</span>' : ''}</td>
      <td class="mono faint">${fmtLease(m.lease)}</td>
      <td class="right"><button class="btn sm ghost" data-udel="${m.externalPort}" data-uproto="${esc(m.protocol)}">删除</button></td>
    </tr>`;
  }).join('');

  view.innerHTML = `
    <div class="section">
      <div class="section-head"><h2>网关</h2>
        <div class="desc">${st.cached ? '（缓存结果，5 分钟内有效）' : ''}</div>
        <div class="spacer"></div>
        <button class="btn sm ghost" id="net-redetect">重新检测</button>
      </div>
      ${gwSection}
      ${cgnat ? `<div class="card" style="margin-top:10px;border-color:#5c451a">
        <b style="color:#f0c674">当前出口不是公网 IPv4</b>
        <div class="hint">网关上报的公网地址 ${esc(st.externalIp)} 属于私有段或运营商级 NAT（CGNAT）。这种情况下路由器上的端口映射对外不可达，朋友仍然连不上，需要向运营商申请公网 IP，或改用 IPv6 / 内网穿透。</div>
      </div>` : ''}
    </div>

    <div class="section" style="max-width:820px">
      <div class="section-head"><h2>端口转发</h2><div class="desc">通过 UPnP 让网关自动开放端口</div></div>
      <div class="card">
        <div class="form-2">
          <div class="form-row"><label>内网端口（服务端监听）</label>
            <input value="${serverPort}" disabled>
            <div class="tip">在「配置 → server.properties」里修改 server-port</div></div>
          <div class="form-row"><label>外网端口</label>
            <input id="net-ext" type="number" min="1" max="65535" value="${cfg.externalPort || ''}" placeholder="${serverPort}（与外网端口相同）">
            <div class="tip">留空表示与内网端口相同；被占用时可换成 25566 之类</div></div>
        </div>
        <div class="form-2">
          <div class="form-row"><label>协议</label>
            <select id="net-proto">
              <option value="TCP" ${cfg.protocol === 'TCP' ? 'selected' : ''}>TCP（Java 版联机只需要这个）</option>
              <option value="UDP" ${cfg.protocol === 'UDP' ? 'selected' : ''}>UDP</option>
              <option value="BOTH" ${cfg.protocol === 'BOTH' ? 'selected' : ''}>TCP + UDP</option>
            </select></div>
          <div class="form-row"><label>租期</label>
            <select id="net-lease">
              ${[0, 3600, 21600, 86400].map(v => `<option value="${v}" ${Number(cfg.lease) === v ? 'selected' : ''}>${fmtLease(v)}</option>`).join('')}
            </select>
            <div class="tip">部分路由器只支持「永久」，会自动回退</div></div>
        </div>
        <label class="switch"><input type="checkbox" id="net-auto" ${cfg.auto ? 'checked' : ''}>
          随服务端启动自动映射，停止时自动移除</label>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center">
          <button class="btn primary" id="net-map">立即建立映射</button>
          <button class="btn" id="net-unmap" ${(st.added || []).length ? '' : 'disabled'}>移除本实例映射</button>
          <div style="flex:1"></div>
          <span class="faint" style="font-size:12px">${(st.added || []).length
            ? '已映射：' + st.added.map(a => `${a.protocol} ${a.externalPort} → ${a.internalClient}:${a.internalPort}`).join('，')
            : '当前没有由 HMCS 建立的映射'}</span>
        </div>
        ${st.lastError ? `<div class="hint" style="color:#ffb4b0">上次失败：${esc(st.lastError)}</div>` : ''}
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>网关端口映射表</h2>
        <div class="desc">${st.mappingError ? esc(st.mappingError) : '只读，最多显示 40 条；删除会直接改动路由器配置'}</div></div>
      <div class="card" style="padding:0;overflow:auto">
        <table>
          <thead><tr><th>协议</th><th>外网端口</th><th>内网目标</th><th>描述</th><th>租期</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="6" class="faint" style="padding:20px;text-align:center">${gw ? '网关没有返回映射表（部分型号不支持读取）' : '需要先检测到网关'}</td></tr>`}</tbody>
        </table>
      </div>
      <div class="faint" style="margin-top:8px;font-size:12px">
        提示：映射成功后仍然连不上，多半是 Windows 防火墙拦截了 java.exe 的入站连接；允许后即可。
        UPnP 只影响局域网内的网关，不会改变 HMCS 自身的 WebUI 监听（它固定只监听 127.0.0.1）。
      </div>
    </div>`;

  const collect = () => ({
    externalPort: Number($('#net-ext').value) || 0,
    protocol: $('#net-proto').value,
    lease: Number($('#net-lease').value) || 0,
  });

  $('#net-redetect').onclick = async () => {
    const b = $('#net-redetect');
    b.disabled = true; b.textContent = '检测中…';
    try { await api('/api/upnp/discover', { method: 'POST', body: {} }); renderView(); }
    catch (e) { toast(e.message, 'err'); b.disabled = false; b.textContent = '重新检测'; }
  };

  $('#net-auto').onchange = async e => {
    try {
      await api('/api/upnp/auto', { method: 'POST', body: { instId: i.id, auto: e.target.checked, ...collect() } });
      toast(e.target.checked ? '已开启：启动服务端时自动映射' : '已关闭自动映射');
      await refresh(true); renderTopbar();
    } catch (err) { toast(err.message, 'err'); e.target.checked = !e.target.checked; }
  };

  $('#net-map').onclick = async () => {
    const b = $('#net-map');
    b.disabled = true;
    b.innerHTML = '<span class="spin"></span> 映射中…';
    try {
      const r = await api('/api/upnp/map', { method: 'POST', body: { instId: i.id, ...collect(), remember: true } });
      const desc = r.added.map(a => `${a.protocol} ${a.externalPort} → ${a.internalClient}:${a.internalPort}`).join('，');
      toast('映射已建立：' + desc);
      if (r.externalIp) toast('公网地址：' + r.externalIp);
      await refresh(true); renderView();
    } catch (e) {
      toast(e.message, 'err');
      b.disabled = false; b.textContent = '立即建立映射';
    }
  };

  $('#net-unmap').onclick = async () => {
    if (!await confirmBox('删除由 HMCS 为该实例建立的映射？<br><span class="muted">只删除本工具登记过的条目，不影响路由器上的其它转发规则。</span>')) return;
    try {
      const r = await api('/api/upnp/unmap', { method: 'POST', body: { instId: i.id } });
      toast('已移除 ' + (r.removed || []).length + ' 条映射');
      await refresh(true); renderView();
    } catch (e) { toast(e.message, 'err'); }
  };

  $$('[data-udel]').forEach(b => b.onclick = async () => {
    const port = b.dataset.udel;
    const proto = b.dataset.uproto;
    if (!await confirmBox(`从路由器删除映射 <b>${esc(proto)} ${port}</b>？`)) return;
    try {
      await api('/api/upnp/unmap', { method: 'POST', body: { instId: i.id, externalPort: Number(port), protocol: proto } });
      toast('已删除'); renderView();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ---------------------------------------------------------------- 设置
async function viewSettings(i) {
  const s = state.boot.settings || {};
  const paths = state.boot.paths || {};
  const javaList = state.boot.java || [];
  const tpl = state.tab;
  let serversDir = s.serversDir || paths.defaultServersDir || '';
  let clientRoots = [...(s.clientRoots || [])];
  let extraDirs = [...(s.extraWorldDirs || [])];

  // 客户端目录的存档数量由后端统计，避免浏览器去猜
  const infoMap = new Map();
  for (const c of (state.boot.clientInfo || [])) infoMap.set(c.path.toLowerCase(), c);

  $('#view').innerHTML = `
    <div class="section" style="max-width:860px">
      <div class="section-head"><h2>存储位置</h2><div class="desc">配置全部放在系统用户目录，程序目录只留代码</div></div>
      <div class="card">
        <div class="form-row"><label>服务端实例存放目录（新建实例默认放这里）</label>
          <div class="path-row">
            <input id="s-sdir" value="${esc(serversDir)}" spellcheck="false">
            <button class="btn sm" id="s-sdir-pick">选择目录…</button>
            <button class="btn sm ghost" id="s-sdir-open">打开</button>
          </div>
          <div class="tip">已有实例保留各自的原始路径，不受这里影响；新建时还可以单独指定。<br>
            想放到别的盘（比如 <span class="mono">D:\\MinecraftServers</span>）在这里改一次就行。</div>
        </div>
        <div class="form-row"><label>配置目录（settings.json / instances.json）</label>
          <div class="path-row">
            <input value="${esc(paths.appDir || '')}" readonly spellcheck="false">
            <button class="btn sm ghost" id="s-app-open">打开</button>
          </div>
          <div class="tip">已从程序目录迁移到 <span class="mono">%APPDATA%\\HMCS</span>，程序目录被移动到别处也不会丢配置。</div>
        </div>
      </div>
    </div>

    <div class="section" style="max-width:860px">
      <div class="section-head"><h2>客户端实例</h2><div class="desc">「世界」面板从这里读取存档和版本号</div></div>
      <div class="card">
        <div id="s-clients"></div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn sm" id="s-add-client">+ 添加客户端目录</button>
          <button class="btn sm ghost" id="s-detect">自动检测</button>
        </div>
        <div class="tip">每个 .minecraft 根目录会自动扫描 <span class="mono">saves</span> 与 <span class="mono">versions/&lt;版本&gt;/saves</span>；
          Prism / Modrinth / CurseForge 这类启动器的实例目录也能直接加。</div>
      </div>
    </div>

    <div class="section" style="max-width:860px">
      <div class="section-head"><h2>额外存档目录</h2><div class="desc">不放在客户端实例里的存档</div></div>
      <div class="card">
        <div id="s-extra"></div>
        <button class="btn sm" id="s-add-extra" style="margin-top:12px">+ 添加目录</button>
      </div>
    </div>

    <div class="section" style="max-width:860px">
      <div class="section-head"><h2>运行环境</h2></div>
      <div class="card">
        <div class="form-row"><label>默认 Java（留空自动挑选满足版本要求的最高版本）</label>
          <select id="s-java"><option value="">自动选择</option>
            ${javaList.map(j => `<option value="${esc(j.path)}" ${s.javaPath === j.path ? 'selected' : ''}>Java ${j.major}（${esc(j.version)}）· ${esc(j.source)}</option>`).join('')}
          </select>
          <div class="tip">当前探测到 ${javaList.length} 个运行时；Minecraft 26.x 需要 Java 25，1.21.x 需要 Java 21。</div>
        </div>
        <div class="form-row"><label>默认内存上限（-Xmx）</label><input id="s-mem" value="${esc(s.memory || '2G')}">
          <div class="tip">例如 2G / 4G；新建实例时的默认值</div></div>
        <div class="form-row"><label>WebUI 端口</label><input id="s-port" type="number" value="${s.port}" disabled>
          <div class="tip">修改后需重启 HMCS 生效（改配置目录里的 settings.json）</div></div>
      </div>
    </div>

    <div class="section" style="max-width:860px">
      <div class="section-head"><h2>关于</h2></div>
      <div class="card">
        <div class="mono" style="font-size:12.5px;line-height:1.9">
          HMCS · 本地 Minecraft 服务端管理器<br>
          核心来源：Mojang 官方 / PaperMC(fill v3) / Purpur / Fabric Meta<br>
          插件来源：Modrinth<br>
          服务只监听 127.0.0.1，不对外网开放
        </div>
      </div>
    </div>

    <div class="save-bar" style="max-width:860px">
      <span class="faint" style="font-size:12px">目录列表的增删即时生效；实例目录、Java、内存改动需点保存</span>
      <button class="btn primary" id="s-save">保存设置</button>
    </div>`;

  const renderClients = () => {
    const box = $('#s-clients');
    if (!clientRoots.length) {
      box.innerHTML = '<div class="muted" style="padding:8px 0">还没有添加客户端实例。点下面的「自动检测」，或手动选择 .minecraft 目录。</div>';
      return;
    }
    box.innerHTML = clientRoots.map(p => {
      const info = infoMap.get(p.toLowerCase()) || {};
      const badge = info.exists === false
        ? '<span class="tag" style="color:#ff9a94;border-color:#4a2020">目录不存在</span>'
        : info.isClient
          ? `<span class="tag">${info.saves || 0} 个存档 · ${info.versions || 0} 个版本</span>`
          : '<span class="tag" style="color:#f0c674;border-color:#5c451a">未发现 saves/</span>';
      return `<div class="list-row">
        <div class="li-main"><div class="nm mono">${esc(p)}</div>
          <div class="sub">${info.exists === false ? '路径不可用，扫描时会被跳过' : '客户端根目录'}</div></div>
        ${badge}
        <button class="btn sm ghost" data-rm-client="${esc(p)}">移除</button>
      </div>`;
    }).join('');
    $$('[data-rm-client]', box).forEach(b => b.onclick = () => {
      saveLists({ clientRoots: clientRoots.filter(x => x !== b.dataset.rmClient) }, '已移除该目录');
    });
  };

  const renderExtra = () => {
    const box = $('#s-extra');
    if (!extraDirs.length) { box.innerHTML = '<div class="muted" style="padding:8px 0">没有额外目录</div>'; return; }
    box.innerHTML = extraDirs.map(p => `
      <div class="list-row">
        <div class="li-main"><div class="nm mono">${esc(p)}</div><div class="sub">扫描 level.dat</div></div>
        <button class="btn sm ghost" data-rm-extra="${esc(p)}">移除</button>
      </div>`).join('');
    $$('[data-rm-extra]', box).forEach(b => b.onclick = () => {
      saveLists({ extraWorldDirs: extraDirs.filter(x => x !== b.dataset.rmExtra) }, '已移除该目录');
    });
  };

  renderClients();
  renderExtra();

  const dedupe = arr => [...new Set(arr.map(x => x.trim()).filter(Boolean))];
  const syncFromBoot = () => {
    const su = state.boot.settings || {};
    clientRoots = [...(su.clientRoots || [])];
    extraDirs = [...(su.extraWorldDirs || [])];
    infoMap.clear();
    for (const c of (state.boot.clientInfo || [])) infoMap.set(c.path.toLowerCase(), c);
  };
  // 目录列表改动即时生效（需要后端重新统计存档数），其余输入走底部保存
  const saveLists = async (body, okMsg) => {
    try {
      await api('/api/settings', { method: 'PUT', body });
      await refresh(true);
      syncFromBoot();
      renderClients();
      renderExtra();
      if (okMsg) toast(okMsg);
    } catch (e) { toast(e.message, 'err'); }
  };

  $('#s-sdir-pick').onclick = async () => {
    const p = await pickDir({ title: '选择服务端实例存放目录', start: serversDir, hint: '新建的服务端实例会放到这个目录下的子文件夹里。' });
    if (p) $('#s-sdir').value = p;
  };
  $('#s-sdir-open').onclick = () => openDir($('#s-sdir').value.trim());
  $('#s-app-open').onclick = () => openDir(paths.appDir || '');

  $('#s-add-client').onclick = async () => {
    const p = await pickDir({ title: '添加客户端实例目录', start: clientRoots[0] || '', hint: '选择 .minecraft 目录，或某个启动器实例的目录（含 saves 的那一层）。' });
    if (!p) return;
    if (clientRoots.some(x => x.toLowerCase() === p.toLowerCase())) { toast('这个目录已经在列表里了', 'warn'); return; }
    await saveLists({ clientRoots: dedupe([...clientRoots, p]) }, '已添加客户端目录');
  };

  $('#s-add-extra').onclick = async () => {
    const p = await pickDir({ title: '添加额外存档目录', start: extraDirs[0] || '' });
    if (!p) return;
    if (extraDirs.some(x => x.toLowerCase() === p.toLowerCase())) { toast('这个目录已经在列表里了', 'warn'); return; }
    await saveLists({ extraWorldDirs: dedupe([...extraDirs, p]) }, '已添加存档目录');
  };

  $('#s-detect').onclick = async () => {
    let data;
    try { data = await api('/api/clients'); } catch (e) { toast(e.message, 'err'); return; }
    const list = data.clients || [];
    if (!list.length) { toast('没有探测到常见的客户端目录，可以手动添加', 'warn'); return; }
    const has = p => clientRoots.some(x => x.toLowerCase() === p.toLowerCase());
    const m2 = modal({
      title: '自动检测到的客户端目录',
      wide: true,
      body: list.map((c, idx) => `
        <label class="pick" style="cursor:pointer">
          <input type="checkbox" data-i="${idx}" ${has(c.path) ? 'checked disabled' : 'checked'}>
          <div style="flex:1;min-width:0">
            <div class="nm">${esc(c.kind || '客户端根目录')}</div>
            <div class="sub mono" style="word-break:break-all">${esc(c.path)}</div>
            <div class="sub">${c.saves || 0} 个存档 · ${c.versions || 0} 个版本${has(c.path) ? ' · 已在列表' : ''}</div>
          </div>
        </label>`).join(''),
      foot: '<button class="btn" data-close>取消</button><button class="btn primary" id="dt-add">添加所选</button>',
    });
    $('#dt-add', m2.root).onclick = async () => {
      const picked = $$('input[data-i]', m2.root).filter(x => x.checked && !x.disabled).map(x => list[Number(x.dataset.i)].path);
      m2.close();
      if (!picked.length) return;
      await saveLists({ clientRoots: dedupe([...clientRoots, ...picked]) }, '已添加 ' + picked.length + ' 个客户端目录');
    };
  };

  $('#s-save').onclick = async () => {
    const btn = $('#s-save');
    btn.disabled = true;
    try {
      const r = await api('/api/settings', {
        method: 'PUT',
        body: {
          javaPath: $('#s-java').value,
          memory: $('#s-mem').value.trim() || '2G',
          serversDir: $('#s-sdir').value.trim() || serversDir,
          clientRoots,
          extraWorldDirs: extraDirs,
        },
      });
      state.boot.settings = r.settings;
      toast('设置已保存');
      await refresh(true);
      if (tpl === state.tab) await renderView();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  };
}

// ---------------------------------------------------------------- 新建实例
async function openNewDialog() {
  const providers = state.boot.providers || [];
  const m = modal({
    title: '新建服务器',
    wide: true,
    body: `
      <div class="form-row"><label>名称</label><input id="n-name" placeholder="例如：26.3 生存服"></div>
      <div class="form-2">
        <div class="form-row"><label>核心类型</label>
          <select id="n-type">${providers.map(p => `<option value="${p.id}" data-note="${esc(p.note)}">${esc(p.label)}</option>`).join('')}</select>
          <div class="tip" id="n-note"></div>
        </div>
        <div class="form-row"><label>Minecraft 版本</label>
          <select id="n-ver"><option>载入中…</option></select>
          <div class="tip" id="n-vtip"></div>
        </div>
      </div>
      <div class="form-2">
        <div class="form-row"><label>内存上限</label><input id="n-mem" value="${esc(state.boot.settings.memory || '2G')}"></div>
        <div class="form-row"><label>正版验证</label>
          <select id="n-online"><option value="0">关闭（离线 / 外置登录）</option><option value="1">开启（仅正版）</option></select>
        </div>
      </div>
      <div class="form-row"><label>存放位置</label>
        <div class="path-row">
          <input id="n-dir" value="${esc(state.boot.settings.serversDir || state.boot.paths?.defaultServersDir || '')}" spellcheck="false">
          <button class="btn sm" id="n-dir-pick">选择目录…</button>
        </div>
        <div class="tip">会在这个目录下新建同名子文件夹（例如 <span class="mono">D:\\MinecraftServers\\生存服</span>）。</div>
      </div>
      <label class="switch" style="margin-top:4px"><input type="checkbox" id="n-eula"> 我已阅读并同意 Minecraft EULA</label>
      <div class="tip" style="margin-top:8px">核心会直接从官方 / 第三方源下载，首次启动还会生成世界，耗时取决于版本与网络。</div>`,
    foot: `<button class="btn" data-close>取消</button><button class="btn primary" id="n-ok">创建并下载</button>`,
  });

  const typeSel = $('#n-type', m.root);
  const verSel = $('#n-ver', m.root);
  const noteEl = $('#n-note', m.root);
  const vt = $('#n-vtip', m.root);

  const loadVersions = async () => {
    const type = typeSel.value;
    noteEl.textContent = providers.find(p => p.id === type)?.note || '';
    verSel.innerHTML = '<option>载入中…</option>';
    vt.textContent = '';
    try {
      const r = await api(`/api/sources/versions?type=${type}`);
      const list = (r.versions || []).filter(v => /release/i.test(v.type) || !v.type).slice(0, 60);
      const releases = list.length ? list : (r.versions || []).slice(0, 60);
      verSel.innerHTML = releases.map(v => `<option value="${esc(v.id)}">${esc(v.id)}</option>`).join('') || '<option value="">无可用版本</option>';
      if (r.latest) { vt.textContent = '最新正式版：' + (r.latest.release || ''); verSel.value = r.latest.release || verSel.value; }
      if (type === 'fabric') vt.textContent = '将使用最新稳定版 Fabric Loader';
    } catch (e) { verSel.innerHTML = `<option value="">${esc(e.message)}</option>`; }
  };
  typeSel.onchange = loadVersions;
  await loadVersions();

  $('#n-dir-pick', m.root).onclick = async () => {
    const start = $('#n-dir', m.root).value.trim() || state.boot.paths?.serversDir || '';
    const p = await pickDir({ title: '选择实例存放位置', start, hint: '实例文件夹会建在这个目录下。' });
    if (p) $('#n-dir', m.root).value = p;
  };

  $('#n-ok', m.root).onclick = async () => {
    const name = $('#n-name', m.root).value.trim();
    if (!name) { toast('请填写名称', 'err'); return; }
    const btn = $('#n-ok', m.root);
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 下载核心…';
    try {
      const r = await api('/api/instances', {
        method: 'POST',
        body: {
          name,
          type: typeSel.value,
          mcVersion: verSel.value,
          memory: $('#n-mem', m.root).value.trim(),
          onlineMode: $('#n-online', m.root).value === '1',
          eula: $('#n-eula', m.root).checked,
          dir: $('#n-dir', m.root).value.trim(),
        },
      });
      m.close();
      toast('已创建：' + r.instance.name);
      state.instId = r.instance.id;
      localStorage.setItem('hmcs.inst', state.instId);
      state.tab = 'overview';
      await boot();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.textContent = '重试';
    }
  };
}

// ---------------------------------------------------------------- 导入已有服务端
async function openImportDialog() {
  const m = modal({
    title: '导入已有服务端',
    body: `
      <div class="form-row"><label>服务端目录</label>
        <div class="path-row">
          <input id="im-dir" placeholder="包含 server.jar / paper.jar 的目录" spellcheck="false">
          <button class="btn sm" id="im-pick">选择目录…</button>
        </div>
        <div class="tip">就地接管：不复制、不下载，核心、插件、世界都留在原位置，HMCS 只负责启动和管理它。</div>
      </div>
      <div class="form-row"><label>显示名称（可选）</label><input id="im-name" placeholder="留空则用文件夹名"></div>
      <div class="tip">目录里必须有服务端核心 jar（paper.jar / server.jar / fabric-server-launch.jar 等）。</div>`,
    foot: `<button class="btn" data-close>取消</button><button class="btn primary" id="im-ok">导入</button>`,
  });
  $('#im-pick', m.root).onclick = async () => {
    const p = await pickDir({ title: '选择要导入的服务端目录', start: $('#im-dir', m.root).value.trim() || state.boot.paths?.home || '' });
    if (p) $('#im-dir', m.root).value = p;
  };
  $('#im-ok', m.root).onclick = async () => {
    const dir = $('#im-dir', m.root).value.trim();
    if (!dir) { toast('请选择服务端目录', 'err'); return; }
    const btn = $('#im-ok', m.root);
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 导入中…';
    try {
      const r = await api('/api/instances/import', { method: 'POST', body: { dir, name: $('#im-name', m.root).value.trim() } });
      m.close();
      state.instId = r.instance.id;
      localStorage.setItem('hmcs.inst', state.instId);
      state.tab = 'overview';
      await boot();
      toast('已导入：' + r.instance.name);
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.textContent = '重试';
    }
  };
}

// ---------------------------------------------------------------- 启动弹窗（含世界选择）
async function openStartDialog() {
  const i = inst();
  if (!i) return;
  const javaList = state.boot.java || [];
  const needJava = String(i.mcVersion).startsWith('26') ? 25 : 21;
  const m = modal({
    title: '启动 · ' + i.name,
    wide: true,
    body: `
      <div class="form-2">
        <div class="form-row"><label>内存上限</label><input id="st-mem" value="${esc(i.memory || '2G')}"></div>
        <div class="form-row"><label>Java 运行时</label>
          <select id="st-java"><option value="">自动（需 ${needJava}+）</option>
            ${javaList.map(j => `<option value="${esc(j.path)}">Java ${j.major} · ${esc(j.short || j.source)}</option>`).join('')}
          </select></div>
      </div>
      <div class="form-row"><label>额外 JVM 参数（可选）</label><input id="st-jvm" value="${esc(i.jvmArgs || '')}" placeholder="-XX:+UseG1GC"></div>
      <div class="form-row"><label>本次使用的世界</label>
        <div class="pick-list" id="st-worlds"><div class="muted" style="padding:10px">载入存档列表…</div></div>
        <div class="tip">默认使用当前世界；选择其它存档会先建立链接（不复制），服务端与客户端仍然共用同一份数据。</div>
      </div>
      <div class="form-row"><label>Minecraft EULA</label>
        <label class="switch"><input type="checkbox" id="st-eula" ${i.eula?.accepted ? 'checked' : ''}>
          ${i.eula?.accepted ? '已同意（eula.txt 为 eula=true）' : '勾选表示我已阅读并同意 Minecraft EULA'}</label>
        <div class="tip">未同意时服务端无法启动${i.eula?.accepted ? '' : '，勾选后启动时会写入 eula.txt'} ·
          <a href="${esc(i.eula?.url || 'https://aka.ms/MinecraftEULA')}" target="_blank" rel="noopener">查看 EULA 原文</a>
          · 也可到「配置 → eula.txt」详细查看与撤销</div>
      </div>`,
    foot: `<button class="btn" data-close>取消</button><button class="btn primary" id="st-ok">启动服务端</button>`,
  });

  let worldPick = null;
  try {
    const data = await api('/api/worlds');
    const curName = i.world?.link ? i.world.linkTarget : '';
    const cur = `<label class="pick sel"><input type="radio" name="w" value="__cur" checked>
        <div><div class="nm">保持当前世界（${esc(i.world?.name || i.worldName || 'world')}）</div>
        <div class="sub">${curName ? esc(curName) : '实例内目录'}</div></div></label>`;
    const rows = data.worlds.slice(0, 40).map(w => `
      <label class="pick"><input type="radio" name="w" value="${esc(w.path)}" data-name="${esc(w.name)}">
        <div style="flex:1"><div class="nm">${esc(w.name)} <span class="tag">${esc(w.versionName || ('DV ' + w.dataVersion))}</span></div>
        <div class="sub">${esc(w.origin)} · ${fmtSize(w.size)} · ${fmtTime(w.mtime)}</div></div></label>`).join('');
    $('#st-worlds', m.root).innerHTML = cur + rows || cur;
    $$('input[name=w]', m.root).forEach(r => r.onchange = () => {
      $$('.pick', m.root).forEach(p => p.classList.remove('sel'));
      r.closest('.pick').classList.add('sel');
      worldPick = r.value === '__cur' ? null : { source: r.value, worldName: r.dataset.name, mode: 'link' };
    });
  } catch (e) {
    $('#st-worlds', m.root).innerHTML = `<div class="muted" style="padding:10px">存档扫描失败：${esc(e.message)}</div>`;
  }

  $('#st-ok', m.root).onclick = async () => {
    const btn = $('#st-ok', m.root);
    if (!$('#st-eula', m.root).checked && !i.eula?.accepted) {
      toast('需要先勾选同意 Minecraft EULA 才能启动', 'err');
      return;
    }
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 启动中…';
    try {
      await api(`/api/instances/${i.id}/start`, {
        method: 'POST',
        body: {
          memory: $('#st-mem', m.root).value.trim(),
          jvmArgs: $('#st-jvm', m.root).value.trim(),
          javaPath: $('#st-java', m.root).value,
          acceptEula: $('#st-eula', m.root).checked,
          world: worldPick || undefined,
        },
      });
      m.close();
      toast('服务端启动中，切换到「控制台」查看进度');
      state.tab = 'console';
      await refresh(true); renderTabs(); renderTopbar(); renderView();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.textContent = '重试';
    }
  };
}

// ---------------------------------------------------------------- 事件绑定
$('#btn-new').onclick = openNewDialog;
$('#btn-import').onclick = openImportDialog;

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { const root = $('#modal-root'); if (root.classList.contains('on')) { root.classList.remove('on'); root.innerHTML = ''; } }
});

(async function main() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('tab')) state.tab = q.get('tab');
    if (q.get('inst')) state.instId = q.get('inst');
    if (q.get('cfg')) state.cfgTarget = q.get('cfg');
    await boot();
    state.timer = setInterval(() => refresh(true), 8000);
  } catch (e) {
    $('#view').innerHTML = `<div class="card"><b>无法连接后端</b><div class="hint">${esc(e.message)}<br>请确认 app.js 正在运行（启动.bat）</div></div>`;
  }
})();
