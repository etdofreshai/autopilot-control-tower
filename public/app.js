const $ = sel => document.querySelector(sel);
const state = { projects: [], current: null, snapshot: null, dir: '.', file: 'README.md', tab: 'overview', live: null, rendering: false };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body.error || body);
  return body;
}
function esc(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function qs(p) { return new URLSearchParams(p).toString(); }
function shortModel(m='') { return String(m).split('/').at(-1) || m; }

async function init() {
  try { const h = await api('/api/health'); $('#health').textContent = h.host; $('#health').className = 'pill good'; } catch { $('#health').textContent = 'offline'; $('#health').className = 'pill bad'; }
  await loadProjects();
  $('#refresh').onclick = () => refreshCurrent();
  $('#addProject').onsubmit = addProject;
  const preferred = state.projects.find(p => p.repoPath.includes('etl-scripting-language')) || state.projects.find(p => p.host === 'dokploy' && p.repoPath === '/app') || state.projects[0];
  if (preferred) selectProject(preferred.key);
  setInterval(refreshCurrent, 15000);
}
async function loadProjects() {
  const data = await api('/api/projects'); state.projects = data.projects || [];
  $('#projects').innerHTML = state.projects.map(p => `<button class="project ${p.key===state.current?'active':''}" data-key="${esc(p.key)}"><strong>${esc(p.name || p.repoPath.split('/').pop())}</strong><br><span class="muted mono">${esc(p.host)}:${esc(p.repoPath)}</span></button>`).join('');
  document.querySelectorAll('.project').forEach(b => b.onclick = () => selectProject(b.dataset.key));
}
async function addProject(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const item = await api('/api/projects', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ host: location.hostname || 'local', name: fd.get('name'), repoPath: fd.get('repoPath') }) });
  e.target.reset(); await loadProjects(); selectProject(item.key);
}
async function selectProject(key) { state.current = key; state.dir='.'; state.file='README.md'; await loadProjects(); await refreshCurrent(); }
function currentProject() { return state.projects.find(p => p.key === state.current); }
async function refreshCurrent() {
  const p = currentProject(); if (!p || state.rendering) return;
  const y = window.scrollY;
  try {
    state.snapshot = await api(`/api/project?${qs({host:p.host, repoPath:p.repoPath})}`);
    renderDashboard({ preserveScroll: y });
  } catch (e) { $('#dashboard').innerHTML = `<div class="card"><h2>Error</h2><p>${esc(e.message)}</p></div>`; }
}
async function control(action) {
  const p = currentProject();
  await api('/api/control', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ host:p.host, repoPath:p.repoPath, action }) });
  await refreshCurrent();
}
function setTab(tab) { state.tab = tab; renderDashboard(); }

function renderDashboard(opts = {}) {
  state.rendering = true;
  const s = state.snapshot, p = currentProject();
  $('#dashboard').innerHTML = `
    <section class="card">
      <div class="toolbar" style="justify-content:space-between;align-items:start">
        <div><h2 style="margin:0">${esc(p.name)}</h2><p class="muted mono">${esc(s.key)}</p></div>
        <div class="toolbar">
          <button data-start>Start / continue</button>
          <button class="warn" data-control="stop-after-current-wave">Stop after wave</button>
          <button class="danger" data-control="stop-now">Stop now</button>
          <button data-control="resume">Resume / clear stops</button>
        </div>
      </div>
      <div class="tabs">
        ${['overview','waves','live','prompts','learnings','settings','files'].map(t => `<button class="tab ${state.tab===t?'active':''}" data-tab="${t}">${t}</button>`).join('')}
      </div>
    </section>
    <div id="tabBody">${renderTab()}</div>
  `;
  document.querySelectorAll('[data-control]').forEach(b => b.onclick = () => control(b.dataset.control));
  document.querySelectorAll('[data-start]').forEach(b => b.onclick = () => startJob());
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  if (state.tab === 'files') loadBrowser();
  if (state.tab === 'live') loadLive();
  const sf = document.querySelector('#settingsForm'); if (sf) sf.onsubmit = saveSettings;
  if (opts.preserveScroll != null) requestAnimationFrame(() => window.scrollTo({ top: opts.preserveScroll }));
  state.rendering = false;
}
function renderTab() {
  if (state.tab === 'waves') return renderWaves();
  if (state.tab === 'live') return renderLive();
  if (state.tab === 'prompts') return renderPrompts();
  if (state.tab === 'learnings') return renderLearnings();
  if (state.tab === 'settings') return renderSettings();
  if (state.tab === 'files') return `<section class="card"><h2>Repo browser</h2><div id="browser" class="filegrid"><div class="filelist muted">loading…</div><pre class="preview"></pre></div></section>`;
  return renderOverview();
}
async function startJob() {
  const p = currentProject();
  const request = prompt('Start/continue request:', state.snapshot?.request?.text || 'Continue current autopilot job');
  if (request == null) return;
  const result = await api('/api/start', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ host:p.host, repoPath:p.repoPath, request }) });
  alert(result.message || 'Start requested');
  state.tab = 'live';
  await refreshCurrent();
}
function renderLive() {
  return `<section class="card"><h2>Live view</h2><p class="muted">Short rolling view of the active autopilot log plus Control Tower events. This is meant to prove the job is doing things without spamming Telegram.</p><div class="toolbar"><button onclick="loadLive()">Refresh live log</button><button onclick="startJob()">Start / continue</button></div><div class="split"><div><h3>Log tail <span id="liveFile" class="muted mono"></span></h3><pre id="liveLog" class="preview">loading…</pre></div><div><h3>Control events</h3><pre id="liveEvents" class="preview">loading…</pre></div></div></section>`;
}
async function loadLive() {
  const p = currentProject();
  try {
    state.live = await api(`/api/live?${qs({host:p.host, repoPath:p.repoPath})}`);
    const log = $('#liveLog'), events = $('#liveEvents'), file = $('#liveFile');
    if (file) file.textContent = state.live.logFile || '';
    if (log) log.textContent = state.live.logTail || 'No live log yet.';
    if (events) events.textContent = state.live.eventsTail || 'No control events yet.';
  } catch (e) {
    const log = $('#liveLog'); if (log) log.textContent = e.message;
  }
}
function renderSettings() {
  const s = state.snapshot.settings || {};
  return `<section class="card"><h2>Notification & start settings</h2><p class="muted">This is the policy the Start button records with each run. direct-command starts the configured repo command inside the mounted OpenClaw volume; request-file only records an audit/request file.</p><form id="settingsForm" class="settings-grid">
    <label>Notification policy<select name="notificationPolicy"><option ${s.notificationPolicy==='off'?'selected':''}>off</option><option ${s.notificationPolicy==='start-stop'?'selected':''}>start-stop</option><option ${s.notificationPolicy==='every-wave'?'selected':''}>every-wave</option><option ${s.notificationPolicy==='failures'?'selected':''}>failures</option><option ${s.notificationPolicy==='every-n-waves'?'selected':''}>every-n-waves</option></select></label>
    <label>Notify every N waves<input name="notifyEveryWaves" type="number" min="1" value="${esc(s.notifyEveryWaves || 5)}"></label>
    <label>Telegram target / group<input name="telegramTarget" placeholder="telegram:-123" value="${esc(s.telegramTarget || '')}"></label>
    <label>Start mode<select name="startMode"><option ${s.startMode==='request-file'?'selected':''}>request-file</option><option ${s.startMode==='openclaw-bridge'?'selected':''}>openclaw-bridge</option><option ${s.startMode==='direct-command'?'selected':''}>direct-command</option></select></label>
    <label class="wide">Future start command<textarea name="startCommand" rows="3" placeholder="scripts/project_parallel_autopilot.py ...">${esc(s.startCommand || '')}</textarea></label>
    <div class="wide toolbar"><button>Save settings</button><button type="button" onclick="startJob()">Start / continue with these settings</button></div>
  </form></section>`;
}
async function saveSettings(e) {
  e.preventDefault();
  const p = currentProject(), fd = new FormData(e.target);
  const settings = Object.fromEntries(fd.entries());
  settings.notifyEveryWaves = Number(settings.notifyEveryWaves || 5);
  await api('/api/settings', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ host:p.host, repoPath:p.repoPath, settings }) });
  await refreshCurrent();
}

function renderOverview() {
  const s = state.snapshot;
  return `
    <section class="grid">
      <div class="metric"><b>${esc(s.loop.current)}</b><span>current state</span></div>
      <div class="metric"><b>${s.waveCount}</b><span>waves recorded</span></div>
      <div class="metric"><b>${esc(s.git.head)}</b><span>${esc(s.git.branch)} head</span></div>
      <div class="metric"><b>${s.git.dirtyFiles ?? '?'}</b><span>dirty files</span></div>
    </section>
    <section class="split">
      <div class="card"><h2>Active request</h2><p>${esc(s.request?.text || '')}</p><p class="muted mono">source: ${esc(s.request?.path || 'not set')}</p></div>
      <div class="card"><h2>What is being used?</h2>${usageList()}</div>
    </section>
    <section class="card"><h2>Visible loop</h2><div class="loop">${s.loop.stages.map(stageCard).join('')}</div></section>
    <section class="split">
      <div class="card"><h2>Recent waves</h2>${wavesTable(s.recentWaves.slice(0,8))}</div>
      <div class="card"><h2>Recent commits</h2><div class="stack">${s.git.recentCommits.map(c=>`<div class="mono">${esc(c)}</div>`).join('') || '<p class="muted">No commits found.</p>'}</div></div>
    </section>`;
}
function usageList() {
  const s = state.snapshot;
  const models = [...new Set((s.recentWaves || []).flatMap(w => w.models || []))].slice(0, 8);
  return `<ul class="clean">
    <li><strong>Models:</strong> ${models.length ? models.map(shortModel).map(esc).join(', ') : 'none recorded yet'}</li>
    <li><strong>Docs:</strong> ${(s.docs || []).slice(0,4).map(d=>esc(d.path)).join(', ') || 'none found'}</li>
    <li><strong>Logs:</strong> ${s.logs.count} files; latest ${esc(s.logs.latestWaveLog || s.logs.latestSupervisorLog || 'none')}</li>
    <li><strong>Controls:</strong> stop files + mounted repo filesystem</li>
  </ul>`;
}
function stageCard(x) { return `<div class="stage ${esc(x.status)}"><h3>${esc(x.stage)}</h3><span class="pill">${esc(x.status)}</span><p>${esc(x.summary)}</p></div>`; }
function wavesTable(waves=[]) {
  if (!waves.length) return '<p class="muted">No wave summaries yet.</p>';
  return `<table class="table"><thead><tr><th>Wave</th><th>Status</th><th>Models</th><th>Duration</th><th>Merge/Test</th></tr></thead><tbody>${waves.map(w=>`<tr><td class="mono">${esc(w.id)}</td><td>${esc(w.status)}</td><td>${esc((w.models||[]).map(shortModel).join(', '))}</td><td>${w.elapsedSeconds}s</td><td>${w.mergedCount} merged / rc ${w.verificationRc}</td></tr>`).join('')}</tbody></table>`;
}
function renderWaves() {
  const waves = state.snapshot.recentWaves || [];
  if (!waves.length) return '<section class="card"><h2>Waves</h2><p class="muted">No waves yet.</p></section>';
  return `<section class="card"><h2>Wave history</h2><p class="muted">Expand a wave to see the request loop, worker prompts/logs, branches, tests, and learning hooks.</p><div class="stack">${waves.map(waveDetails).join('')}</div></section>`;
}
function waveDetails(w) {
  const details = w.stageDetails || {};
  return `<details class="wave"><summary><strong>Wave ${esc(w.id)}</strong> <span class="pill">${esc(w.status)}</span> <span class="muted">${esc((w.models||[]).map(shortModel).join(', '))} · ${w.elapsedSeconds}s · ${w.mergedCount} merged</span></summary>
    <div class="stage-detail-grid">${['plan','assign','build','review','integrate','learn'].map(k => detailBlock(k, details[k])).join('')}</div>
    <h4>Workers</h4>${workerTable(w.results || [])}
    <h4>Verification</h4><pre class="mini-pre">${esc(w.verificationTail || 'No verification output recorded.')}</pre>
  </details>`;
}
function detailBlock(key, d={}) {
  return `<div class="detail-block"><h3>${esc(d.title || key)}</h3><p>${esc(d.summary || '')}</p><ul>${(d.bullets||[]).slice(0,5).map(b=>`<li>${esc(b)}</li>`).join('')}</ul>${(d.artifacts||[]).length ? `<p class="muted mono">${d.artifacts.map(esc).join(' · ')}</p>` : ''}</div>`;
}
function workerTable(results) {
  if (!results.length) return '<p class="muted">No worker results.</p>';
  return `<table class="table"><thead><tr><th>Model</th><th>RC</th><th>Elapsed</th><th>Summary</th><th>Log</th></tr></thead><tbody>${results.map(r=>`<tr><td>${esc(shortModel(r.model))}</td><td>${esc(r.rc)}</td><td>${esc(r.elapsed)}s</td><td>${esc(r.summary)}</td><td class="mono">${esc(r.log)}</td></tr>`).join('')}</tbody></table>`;
}
function renderPrompts() {
  const docs = state.snapshot.docs || [];
  return `<section class="card"><h2>Prompts & docs</h2><p class="muted">These are the request/context files the loop can show and eventually inject into task assignment.</p><div class="docgrid">${docs.map(d=>`<button class="doccard" onclick="state.tab='files';state.file='${esc(d.path)}';state.dir='.';renderDashboard();setTimeout(loadFile,50)"><strong>${esc(d.path)}</strong><pre>${esc(d.preview)}</pre></button>`).join('') || '<p class="muted">No known docs found.</p>'}</div></section>`;
}
function renderLearnings() {
  const l = state.snapshot.learnings || { explicit: [], generated: [] };
  const cards = [...(l.explicit || []), ...(l.generated || [])];
  return `<section class="card"><h2>Learnings</h2><p class="muted">Living evidence about model fit, prompt patterns, task size, workflow stages, and project-specific constraints.</p><div class="learning-grid">${cards.map(learningCard).join('')}</div></section>`;
}
function learningCard(x) {
  return `<div class="learning"><span class="pill">${esc(x.scope || 'general')}</span><h3>${esc(x.claim || x.summary || 'Learning')}</h3><p class="muted">confidence: ${x.confidence == null ? 'n/a' : esc(Math.round(Number(x.confidence)*100)+'%')}</p><pre>${esc(JSON.stringify(x.evidence || {}, null, 2))}</pre></div>`;
}
async function loadBrowser() {
  const p = currentProject();
  const entries = await api(`/api/files?${qs({host:p.host, repoPath:p.repoPath, dir:state.dir})}`);
  const list = $('#browser .filelist');
  if (!list) return;
  const parent = state.dir === '.' ? '' : `<button class="fileitem" data-dir="${esc(parentDir(state.dir))}">⬆ ..</button>`;
  list.innerHTML = parent + entries.entries.map(e => `<button class="fileitem" data-${e.type === 'dir' ? 'dir' : 'file'}="${esc(e.path)}">${e.type === 'dir' ? '📁' : '📄'} ${esc(e.name)}</button>`).join('');
  list.querySelectorAll('[data-dir]').forEach(b => b.onclick = () => { state.dir = b.dataset.dir || '.'; loadBrowser(); });
  list.querySelectorAll('[data-file]').forEach(b => b.onclick = () => { state.file = b.dataset.file; loadFile(); });
  loadFile().catch(()=>{});
}
function parentDir(d) { const x = d.split('/').filter(Boolean); x.pop(); return x.join('/') || '.'; }
async function loadFile() {
  const p = currentProject(); const pre = $('#browser .preview'); if (!pre) return;
  try { pre.textContent = await api(`/api/file?${qs({host:p.host, repoPath:p.repoPath, file:state.file})}`); }
  catch(e) { pre.textContent = e.message; }
}

init().catch(e => { document.body.innerHTML = `<pre>${esc(e.stack || e.message)}</pre>`; });
