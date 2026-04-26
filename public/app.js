const $ = sel => document.querySelector(sel);
const state = { projects: [], current: null, snapshot: null, dir: '.', file: 'README.md' };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body.error || body);
  return body;
}
function esc(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function qs(p) { return new URLSearchParams(p).toString(); }

async function init() {
  try { const h = await api('/api/health'); $('#health').textContent = h.host; $('#health').className = 'pill good'; } catch { $('#health').textContent = 'offline'; $('#health').className = 'pill bad'; }
  await loadProjects();
  $('#refresh').onclick = () => refreshCurrent();
  $('#addProject').onsubmit = addProject;
  if (state.projects[0]) selectProject(state.projects[0].key);
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
  const p = currentProject(); if (!p) return;
  try {
    state.snapshot = await api(`/api/project?${qs({host:p.host, repoPath:p.repoPath})}`);
    renderDashboard();
  } catch (e) { $('#dashboard').innerHTML = `<div class="card"><h2>Error</h2><p>${esc(e.message)}</p></div>`; }
}
async function control(action) {
  const p = currentProject();
  await api('/api/control', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ host:p.host, repoPath:p.repoPath, action }) });
  await refreshCurrent();
}
function renderDashboard() {
  const s = state.snapshot, p = currentProject();
  $('#dashboard').innerHTML = `
    <section class="card">
      <div class="toolbar" style="justify-content:space-between;align-items:start">
        <div><h2 style="margin:0">${esc(p.name)}</h2><p class="muted mono">${esc(s.key)}</p></div>
        <div class="toolbar">
          <button class="warn" data-control="stop-after-current-wave">Stop after wave</button>
          <button class="danger" data-control="stop-now">Stop now</button>
          <button data-control="resume">Resume / clear stops</button>
        </div>
      </div>
    </section>
    <section class="grid">
      <div class="metric"><b>${esc(s.loop.current)}</b><span>current state</span></div>
      <div class="metric"><b>${s.waveCount}</b><span>waves recorded</span></div>
      <div class="metric"><b>${esc(s.git.head)}</b><span>${esc(s.git.branch)} head</span></div>
      <div class="metric"><b>${s.git.dirtyFiles ?? '?'}</b><span>dirty files</span></div>
    </section>
    <section class="card"><h2>Visible loop</h2><div class="loop">${s.loop.stages.map(stageCard).join('')}</div></section>
    <section class="split">
      <div class="card"><h2>Recent waves</h2>${wavesTable(s.recentWaves)}</div>
      <div class="card"><h2>Recent commits</h2><div class="stack">${s.git.recentCommits.map(c=>`<div class="mono">${esc(c)}</div>`).join('') || '<p class="muted">No commits found.</p>'}</div></div>
    </section>
    <section class="card"><h2>Repo browser</h2><div id="browser" class="filegrid"><div class="filelist muted">loading…</div><pre class="preview"></pre></div></section>
  `;
  document.querySelectorAll('[data-control]').forEach(b => b.onclick = () => control(b.dataset.control));
  loadBrowser();
}
function stageCard(x) { return `<div class="stage ${esc(x.status)}"><h3>${esc(x.stage)}</h3><span class="pill">${esc(x.status)}</span><p>${esc(x.summary)}</p></div>`; }
function wavesTable(waves=[]) {
  if (!waves.length) return '<p class="muted">No wave summaries yet.</p>';
  return `<table class="table"><thead><tr><th>Wave</th><th>Status</th><th>Models</th><th>Duration</th><th>Merge/Test</th></tr></thead><tbody>${waves.map(w=>`<tr><td class="mono">${esc(w.id)}</td><td>${esc(w.status)}</td><td>${esc((w.models||[]).map(m=>m.split('/').at(-1)).join(', '))}</td><td>${w.elapsedSeconds}s</td><td>${w.mergedCount} merged / rc ${w.verificationRc}</td></tr>`).join('')}</tbody></table>`;
}
async function loadBrowser() {
  const p = currentProject();
  const entries = await api(`/api/files?${qs({host:p.host, repoPath:p.repoPath, dir:state.dir})}`);
  const list = $('#browser .filelist');
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
