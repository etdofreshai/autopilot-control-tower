const $ = sel => document.querySelector(sel);
const state = { projects: [], current: null, snapshot: null, dir: '.', file: 'README.md', tab: 'loop', rendering: false };
const CLIENT_SESSION = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function scrubClient(value, depth = 0) {
  if (depth > 3) return '[depth-limit]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}…truncated(${value.length})` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => scrubClient(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = /token|secret|password|authorization|cookie|key/i.test(k) ? '[redacted]' : scrubClient(v, depth + 1);
  }
  return out;
}
async function clientLog(event, details = {}, level = 'info') {
  const payload = { ts: new Date().toISOString(), level, event, session: CLIENT_SESSION, path: location.pathname, details: scrubClient(details) };
  try {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      const ok = navigator.sendBeacon('/api/client-log', new Blob([body], { type: 'application/json' }));
      if (ok) return;
    }
    await fetch('/api/client-log', { method:'POST', headers:{'content-type':'application/json'}, body, keepalive: true });
  } catch {}
}
async function api(path, opts = {}) {
  const started = performance.now();
  const method = opts.method || 'GET';
  clientLog('api.request.start', { method, path });
  try {
    const res = await fetch(path, opts);
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : await res.text();
    clientLog('api.request.finish', { method, path, status: res.status, durationMs: Math.round(performance.now() - started) }, res.ok ? 'info' : 'error');
    if (!res.ok) throw new Error(body.error || body);
    return body;
  } catch (e) {
    clientLog('api.request.error', { method, path, durationMs: Math.round(performance.now() - started), error: e.message }, 'error');
    throw e;
  }
}
window.addEventListener('error', e => clientLog('window.error', { message: e.message, source: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack }, 'error'));
window.addEventListener('unhandledrejection', e => clientLog('window.unhandledrejection', { reason: e.reason?.message || String(e.reason), stack: e.reason?.stack }, 'error'));
function esc(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function qs(p) { return new URLSearchParams(p).toString(); }
function currentProject() { return state.projects.find(p => p.key === state.current); }
function scoreClass(score) { return score >= 80 ? 'good' : score >= 50 ? 'warn' : 'bad'; }

async function init() {
  clientLog('ui.init.start', { userAgent: navigator.userAgent });
  try { const h = await api('/api/health'); $('#health').textContent = h.version; $('#health').className = 'pill good'; } catch { $('#health').textContent = 'offline'; $('#health').className = 'pill bad'; }
  $('#refresh').onclick = refreshCurrent;
  $('#addProject').onsubmit = addProject;
  await loadProjects();
  const saved = localStorage.getItem('autopilot.currentProject');
  const initial = state.projects.find(p => p.key === saved)?.key || state.projects[0]?.key;
  if (initial) selectProject(initial);
  clientLog('ui.init.complete', { projectCount: state.projects.length, current: state.current });
}
async function loadProjects() {
  const data = await api('/api/projects'); state.projects = data.projects || [];
  $('#projects').innerHTML = state.projects.map(p => `<button class="project ${p.key===state.current?'active':''}" data-key="${esc(p.key)}"><strong>${esc(p.name || p.repoPath.split('/').pop())}</strong><br><span class="muted mono">${esc(p.repoPath)}</span></button>`).join('');
  document.querySelectorAll('.project').forEach(b => b.onclick = () => selectProject(b.dataset.key));
}
async function addProject(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const item = await api('/api/projects', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name: fd.get('name'), repoPath: fd.get('repoPath') }) });
  e.target.reset(); await loadProjects(); selectProject(item.key);
}
async function selectProject(key) { clientLog('ui.project.select', { key }); state.current = key; localStorage.setItem('autopilot.currentProject', key); state.dir='.'; state.file='README.md'; await loadProjects(); await refreshCurrent(); }
async function refreshCurrent() {
  const p = currentProject(); if (!p || state.rendering) return;
  try { state.snapshot = await api(`/api/project?${qs({host:p.host, repoPath:p.repoPath})}`); renderDashboard(); }
  catch (e) { $('#dashboard').innerHTML = `<div class="card"><h2>Error</h2><p>${esc(e.message)}</p></div>`; }
}
function setTab(tab) { clientLog('ui.tab.select', { tab }); state.tab = tab; renderDashboard(); }

function renderDashboard() {
  state.rendering = true;
  const p = currentProject();
  if (state.snapshot?.missing) return renderMissingProject(p, state.snapshot);
  $('#dashboard').innerHTML = `
    <section class="card hero">
      <div>
        <p class="eyebrow">${esc(p.repoPath)}</p>
        <h2>${esc(p.name)}</h2>
        <p class="muted">A three-level research loop: static overseer spawns supervisors, supervisors manage sub-agents, then weighted metrics pick the best hierarchy.</p>
      </div>
      <div class="toolbar">
        <button data-start-agent>Start real OpenClaw agent</button>
        <button data-start-loop>Start background loop</button>
        <button data-stop-loop>Stop loop</button>
        <button data-step>Run simulated loop step</button>
      </div>
    </section>
    <div class="tabs">${['loop','variants','history','files'].map(t => `<button class="tab ${state.tab===t?'active':''}" data-tab="${t}">${t}</button>`).join('')}</div>
    <div id="tabBody">${renderTab()}</div>`;
  document.querySelector('[data-step]').onclick = runStep;
  document.querySelector('[data-start-agent]').onclick = startAgent;
  document.querySelector('[data-start-loop]').onclick = startBackgroundLoop;
  document.querySelector('[data-stop-loop]').onclick = stopBackgroundLoop;
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  const f = $('#intentForm'); if (f) f.onsubmit = saveConfig;
  if (state.tab === 'files') loadBrowser();
  state.rendering = false;
}
function renderMissingProject(p, s) {
  state.rendering = true;
  $('#dashboard').innerHTML = `
    <section class="card hero">
      <div>
        <p class="eyebrow">${esc(s.repoPath)}</p>
        <h2>${esc(p.name || 'Missing project')}</h2>
        <p class="muted">This project is tracked, but the repo folder does not exist yet.</p>
      </div>
    </section>
    <section class="card">
      <h2>Create this repo?</h2>
      <p>The Control Tower can create the folder, initialize git, and add a starter README so this project becomes usable.</p>
      <p class="muted mono">${esc(s.repoPath)}</p>
      ${s.canCreate ? '<div class="toolbar"><button data-create-repo>Create repo here</button></div>' : '<p class="pill bad">This path is outside the safe create locations.</p>'}
    </section>`;
  const b = document.querySelector('[data-create-repo]');
  if (b) b.onclick = createRepo;
  state.rendering = false;
}
async function createRepo() {
  const p = currentProject();
  if (!confirm(`Create a new git repo at ${p.repoPath}?`)) return;
  await api('/api/project/create', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ host:p.host, repoPath:p.repoPath, name:p.name }) });
  await refreshCurrent();
}
function renderTab() {
  if (state.tab === 'history') return renderHistory();
  if (state.tab === 'variants') return renderVariants();
  if (state.tab === 'files') return `<section class="card"><h2>Repo browser</h2><div id="browser" class="filegrid"><div class="filelist muted">loading…</div><pre class="preview"></pre></div></section>`;
  return renderLoop();
}
function renderLoop() {
  const s = state.snapshot, l = s.loop;
  return `
    <section class="grid metrics">
      <div class="metric"><b>${esc(l.stage)}</b><span>current stage</span></div>
      <div class="metric"><b>${esc(l.model)}</b><span>supervisor model</span></div>
      <div class="metric"><b class="${scoreClass(l.score)}">${l.score}</b><span>weighted overall / 100</span></div>
      <div class="metric"><b>${l.metrics?.correctness || 0}</b><span>correctness / 100</span></div>
      <div class="metric"><b>${l.autopilot?.enabled ? 'on' : 'off'}</b><span>background loop</span></div>
    </section>
    <section class="card">
      <h2>Inputs</h2>
      <form id="intentForm" class="config-grid">
        <label class="wide">User request / intent<textarea name="intent" rows="4" placeholder="What should Autopilot complete in one shot?">${esc(l.intent)}</textarea></label>
        <label class="wide">Overseer prompt<textarea name="overseerPrompt" rows="4">${esc(l.overseerPrompt || '')}</textarea></label>
        <label class="wide">Supervisor system prompt<textarea name="supervisorPrompt" rows="8">${esc(l.supervisorPrompt || '')}</textarea></label>
        <label>Model<input name="model" placeholder="gpt-5.5, opus, GLM..." value="${esc(l.model)}"></label>
        <label>A/B variants<input name="variantCount" type="number" min="1" max="6" value="${esc(l.variantCount || 3)}"></label>
        <label>OpenClaw agent id<input name="agentId" placeholder="blank = default agent" value="${esc(l.agentId || '')}"></label>
        <label>Loop mode<select name="loopMode"><option value="simulated" ${l.autopilot?.mode !== 'agent' ? 'selected' : ''}>Simulated steps</option><option value="agent" ${l.autopilot?.mode === 'agent' ? 'selected' : ''}>Real OpenClaw agents</option></select></label>
        <label>Loop interval seconds<input name="loopIntervalSeconds" type="number" min="10" value="${esc(l.autopilot?.intervalSeconds || 300)}"></label>
        <div class="toolbar align-end"><button>Save lab setup</button><button type="button" onclick="startAgent()">Start real agent</button><button type="button" onclick="startBackgroundLoop()">Start loop</button><button type="button" onclick="stopBackgroundLoop()">Stop loop</button><button type="button" onclick="runStep()">Run simulated step</button></div>
      </form>
    </section>
    <section class="card"><h2>Background loop</h2>${autopilotStatus(l.autopilot)}</section>
    <section class="card"><h2>Visible loop</h2><div class="loop">${s.stages.map(stageCard).join('')}</div></section>
    <section class="card"><h2>Real OpenClaw agent runs</h2>${agentRuns(l.agentRuns)}</section>
    <section class="split">
      <div class="card"><h2>Acceptance criteria</h2>${criteriaList(l.oneShot?.acceptanceCriteria)}</div>
      <div class="card"><h2>Latest comparison</h2>${evaluation(l.evaluations.at(-1))}<h3>Learnings</h3>${learningList(l.learnings)}</div>
    </section>
    <section class="card"><h2>Repo status</h2><p class="mono muted">${esc(s.git.branch)} @ ${esc(s.git.head)} · ${s.git.dirtyFiles ?? '?'} dirty file(s)</p>${(s.git.recentCommits||[]).map(c=>`<div class="mono">${esc(c)}</div>`).join('')}</section>`;
}

function autopilotStatus(a={}) {
  const cls = a.enabled ? 'good' : 'warn';
  return `<p><span class="pill ${cls}">${a.enabled ? 'enabled' : 'disabled'}</span> <strong>${esc(a.mode || 'simulated')}</strong> every ${esc(a.intervalSeconds || 300)}s</p><p class="muted mono">last tick: ${esc(a.lastTickAt || 'never')} · next run: ${esc(a.nextRunAt || 'not scheduled')}</p>${a.lastError ? `<pre class="mini-pre bad">${esc(a.lastError)}</pre>` : ''}`;
}

function stageCard(x) { return `<div class="stage ${esc(x.status)}"><h3>${esc(x.stage)}</h3><span class="pill">${esc(x.status)}</span><p>${esc(x.summary)}</p></div>`; }
function criteriaList(items=[]) {
  if (!items?.length) return '<p class="muted">Run the request step to derive acceptance criteria.</p>';
  return `<ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
}
function evaluation(ev) {
  if (!ev) return '<p class="muted">No comparison yet.</p>';
  return `<div class="score ${scoreClass(ev.score)}">${ev.score}/100</div><p>${esc(ev.summary)}</p><p><strong>Best supervisor:</strong> ${esc(ev.bestVariant || 'n/a')}</p><p><strong>Correctness:</strong> ${ev.metrics?.correctness || 0}/100 · <strong>Cost:</strong> ${ev.metrics?.cost || 0}/100 · <strong>Requests:</strong> ${ev.metrics?.requests || 0}/100 · <strong>Duration:</strong> ${ev.metrics?.duration || 0}/100</p><p class="muted mono">tokens≈${ev.usage?.estimatedTokens || 0} · requests=${ev.usage?.requestCount || 0} · duration=${ev.usage?.durationSeconds || 0}s · cost≈$${ev.usage?.estimatedCostUsd || 0}</p><ul>${(ev.gaps||[]).map(g=>`<li>${esc(g)}</li>`).join('')}</ul><p class="muted mono">${esc(ev.ts)}</p>`;
}
function learningList(items=[]) {
  if (!items.length) return '<p class="muted">The loop will capture learning after evaluation/replan cycles.</p>';
  return `<ul>${items.slice(-5).reverse().map(x => `<li>${esc(x.claim)} <span class="muted">(${x.score}/100)</span></li>`).join('')}</ul>`;
}
function renderVariants() {
  const l = state.snapshot.loop;
  const variants = l.variants || [];
  return `<section class="card"><h2>Supervisors + sub-agent teams</h2><p class="muted">The overseer spawns supervisor variants. Each supervisor manages sub-agents. Evaluation weighs correctness highest, then cost, requests, and duration.</p><div class="stack">${variants.map(v => `<div class="task"><strong>Supervisor ${esc(v.id)} · ${esc(v.strategy)}</strong><p>${esc(v.resultSummary || '')}</p><p><span class="pill ${scoreClass(v.score || 0)}">overall ${v.score || 0}/100</span> <span class="pill">correctness ${v.metrics?.correctness || 0}</span> <span class="pill">cost ${v.metrics?.cost || 0}</span> <span class="pill">requests ${v.metrics?.requests || 0}</span> <span class="pill">duration ${v.metrics?.duration || 0}</span></p><p class="muted mono">tokens≈${v.usage?.estimatedTokens || 0} · requests=${v.usage?.requestCount || 0} · duration=${v.usage?.durationSeconds || 0}s · cost≈$${v.usage?.estimatedCostUsd || 0}</p><h3>Sub-agent team</h3><ul>${(v.subAgents||[]).map(sa=>`<li><strong>${esc(sa.id)} · ${esc(sa.role)}</strong>: ${esc(sa.prompt)} ${sa.score ? `(${sa.score}/100)` : ''}</li>`).join('')}</ul></div>`).join('') || '<p class="muted">Run through overseer/supervisors/subagents/evaluate to generate variants.</p>'}</div></section>`;
}
function renderHistory() {
  const h = state.snapshot.loop.history || [];
  return `<section class="card"><h2>Loop history</h2><p class="muted">A minimal audit trail of request/overseer/supervisor/sub-agent/evaluation/improvement events.</p><div class="stack">${h.slice().reverse().map(x => `<pre class="mini-pre">${esc(JSON.stringify(x, null, 2))}</pre>`).join('') || '<p class="muted">No history yet.</p>'}</div></section>`;
}
async function saveConfig(e) {
  e.preventDefault();
  clientLog('ui.config.save.start', { current: state.current });
  const p = currentProject(), fd = new FormData(e.target);
  state.snapshot.loop = await api('/api/config', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ host:p.host, repoPath:p.repoPath, intent: fd.get('intent'), model: fd.get('model'), overseerPrompt: fd.get('overseerPrompt'), supervisorPrompt: fd.get('supervisorPrompt'), variantCount: fd.get('variantCount'), agentId: fd.get('agentId') }) });
  await refreshCurrent();
  clientLog('ui.config.save.complete', { current: state.current });
}

async function startBackgroundLoop() {
  const p = currentProject();
  const f = $('#intentForm');
  const fd = f ? new FormData(f) : new FormData();
  const mode = fd.get('loopMode') || state.snapshot.loop.autopilot?.mode || 'simulated';
  const headers = {'content-type':'application/json'};
  if (mode === 'agent') {
    const token = localStorage.getItem('openclawAgentToken') || prompt('OpenClaw agent launch token');
    if (!token) return;
    localStorage.setItem('openclawAgentToken', token);
    headers['x-agent-token'] = token;
  }
  try {
    await api('/api/autopilot', { method:'POST', headers, body: JSON.stringify({ host:p.host, repoPath:p.repoPath, enabled:true, runNow:true, mode, intervalSeconds: fd.get('loopIntervalSeconds') || 300 }) });
    await refreshCurrent();
  } catch (e) { alert(e.message); }
}
async function stopBackgroundLoop() {
  const p = currentProject();
  try {
    await api('/api/autopilot', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ host:p.host, repoPath:p.repoPath, enabled:false }) });
    await refreshCurrent();
  } catch (e) { alert(e.message); }
}

async function startAgent() {
  const p = currentProject();
  clientLog('ui.agent.start.clicked', { project: p?.key });
  const f = $('#intentForm');
  const fd = f ? new FormData(f) : new FormData();
  try {
    const token = localStorage.getItem('openclawAgentToken') || prompt('OpenClaw agent launch token');
    if (!token) return;
    localStorage.setItem('openclawAgentToken', token);
    await api('/api/agent/start', { method:'POST', headers:{'content-type':'application/json', 'x-agent-token': token}, body: JSON.stringify({ host:p.host, repoPath:p.repoPath, message: fd.get('intent') || state.snapshot.loop.intent, agentId: fd.get('agentId') || '' }) });
    await refreshCurrent();
    clientLog('ui.agent.start.complete', { project: p?.key });
  } catch (e) { clientLog('ui.agent.start.error', { error: e.message }, 'error'); alert(e.message); }
}
function agentRuns(runs=[]) {
  if (!runs.length) return '<p class="muted">No real OpenClaw agent runs yet. Use “Start real agent” to launch one from the current intent.</p>';
  return `<div class="stack">${runs.map(r => `<div class="task"><strong>${esc(r.status)} · ${esc(r.id)}</strong><p>${esc(r.message || '')}</p><p class="muted mono">agent=${esc(r.agentId || 'default')} · session=${esc(r.sessionId || '')} · ${esc(r.ts || '')}${r.completedAt ? ` → ${esc(r.completedAt)}` : ''}</p>${r.output ? `<pre class="mini-pre">${esc(r.output)}</pre>` : '<p class="muted">Running… refresh for updates.</p>'}${r.error ? `<pre class="mini-pre bad">${esc(r.error)}</pre>` : ''}</div>`).join('')}</div>`;
}
async function runStep() {
  const p = currentProject();
  clientLog('ui.loop.step.clicked', { project: p?.key, stage: state.snapshot?.loop?.stage });
  try { state.snapshot.loop = await api('/api/step', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ host:p.host, repoPath:p.repoPath }) }); await refreshCurrent(); clientLog('ui.loop.step.complete', { project: p?.key, stage: state.snapshot?.loop?.stage }); }
  catch (e) { clientLog('ui.loop.step.error', { error: e.message }, 'error'); alert(e.message); }
}
async function loadBrowser() {
  const p = currentProject();
  const entries = await api(`/api/files?${qs({host:p.host, repoPath:p.repoPath, dir:state.dir})}`);
  const list = $('#browser .filelist'); if (!list) return;
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

init().catch(e => { clientLog('ui.init.error', { error: e.message, stack: e.stack }, 'error'); document.body.innerHTML = `<pre>${esc(e.stack || e.message)}</pre>`; });
