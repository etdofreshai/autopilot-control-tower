import http from 'node:http';
import { promises as fs } from 'node:fs';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const PORT = Number(process.env.PORT || 8787);
const HOSTNAME = os.hostname();
const MAX_FILE_BYTES = 512 * 1024;

const STAGES = ['plan', 'assign', 'build', 'review', 'integrate', 'learn'];
const STOP_FILES = ['STOP_AUTOPILOT', 'STOP_AFTER_CURRENT_LOOP', 'STOP_ETL_AUTOPILOT', 'STOP_ETL_PARALLEL'];
const REQUEST_FILES = ['.autopilot/request.md', 'docs/AUTOPILOT.md', 'docs/PROJECT_AUTOPILOT.md', 'state/autopilot.md', 'README.md'];
const DOC_FILES = [
  'README.md',
  '.autopilot/program.md',
  '.autopilot/task-taxonomy.md',
  '.autopilot/evals.md',
  '.autopilot/models/README.md',
  'docs/AUTOPILOT.md',
  'docs/AUTOPILOT_SUPERVISOR.md',
  'docs/PROJECT_AUTOPILOT.md',
  'docs/SPEC.md',
  'state/autopilot.md',
];

function projectKey(host, repoPath) { return `${host}:${path.resolve(repoPath)}`; }
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}
function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function readJson(p, fallback = null) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; } }
async function writeJson(p, value) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(value, null, 2) + '\n'); }

function validateProject(host, repoPath) {
  if (!host || !repoPath) throw Object.assign(new Error('host and repoPath are required'), { status: 400 });
  // In this MVP, host is a project-identity label. The deployed container operates
  // on mounted local paths; future versions can route by host to remote agents.
  if (!path.isAbsolute(repoPath)) throw Object.assign(new Error('repoPath must be absolute'), { status: 400 });
  if (repoPath.includes('\0')) throw Object.assign(new Error('invalid repoPath'), { status: 400 });
  return path.resolve(repoPath);
}

async function defaultProjects() {
  const candidates = [
    ['/app', 'Autopilot Control Tower container'],
    ['/openclaw/.openclaw/tmp/Wolfenstein 3D port', 'Wolfenstein 3D port'],
    ['/openclaw/.openclaw/tmp/etl-scripting-language', 'ETL scripting language'],
    ['/openclaw/.openclaw/tmp/autopilot-control-tower', 'Autopilot Control Tower workspace'],
  ];
  const out = [];
  for (const [repoPath, name] of candidates) if (await exists(repoPath)) out.push({ host: HOSTNAME, repoPath, name, key: projectKey(HOSTNAME, repoPath) });
  return out;
}
async function loadProjects() {
  const stored = await readJson(PROJECTS_FILE, null);
  if (Array.isArray(stored?.projects)) return stored.projects;
  const seeded = await defaultProjects();
  await writeJson(PROJECTS_FILE, { projects: seeded });
  return seeded;
}

function runGit(repo, args, timeoutMs = 4000) {
  return new Promise(resolve => {
    const cp = spawn('git', ['-c', 'safe.directory=*', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { cp.kill('SIGKILL'); resolve({ rc: 124, out, err: err + 'timeout' }); }, timeoutMs);
    cp.stdout.on('data', d => out += d);
    cp.stderr.on('data', d => err += d);
    cp.on('close', rc => { clearTimeout(t); resolve({ rc, out, err }); });
    cp.on('error', e => { clearTimeout(t); resolve({ rc: 1, out, err: String(e) }); });
  });
}

async function gitStatus(repo) {
  const [head, branch, dirty, recent] = await Promise.all([
    runGit(repo, ['rev-parse', '--short', 'HEAD']),
    runGit(repo, ['branch', '--show-current']),
    runGit(repo, ['status', '--porcelain']),
    runGit(repo, ['log', '--oneline', '-8']),
  ]);
  return {
    head: head.rc === 0 ? head.out.trim() : 'unknown',
    branch: branch.rc === 0 ? branch.out.trim() : 'unknown',
    dirtyFiles: dirty.rc === 0 ? dirty.out.split('\n').filter(Boolean).length : null,
    recentCommits: recent.rc === 0 ? recent.out.split('\n').filter(Boolean) : [],
  };
}

async function listFilesSafe(dir, re = /.*/) {
  try { return (await fs.readdir(dir)).filter(n => re.test(n)).sort(); } catch { return []; }
}
function latestByName(names) { return names.sort().at(-1) || null; }

async function parseWaveSummaries(repo) {
  const logs = path.join(repo, 'logs');
  const names = await listFilesSafe(logs, /^parallel-wave-.*-summary\.json$/);
  const waves = [];
  for (const name of names.slice(-100)) {
    const data = await readJson(path.join(logs, name), null);
    if (!data) continue;
    const results = Array.isArray(data.results) ? data.results : [];
    waves.push({
      id: String(data.wave || name),
      file: `logs/${name}`,
      head: data.head || null,
      base: data.base || null,
      results,
      models: results.map(r => r.model).filter(Boolean),
      elapsedSeconds: results.reduce((m, r) => Math.max(m, Number(r.elapsed || 0)), 0),
      mergedCount: Array.isArray(data.merged) ? data.merged.length : 0,
      issues: Array.isArray(data.issues) ? data.issues : [],
      verificationRc: data.verificationRc,
      verificationTail: data.verificationTail || '',
      status: data.verificationRc === 0 && (!data.issues || data.issues.length === 0) ? 'passed' : (data.verificationRc === 0 ? 'issues' : 'failed'),
      stageDetails: waveStageDetails(data, results),
    });
  }
  return waves;
}

function waveStageDetails(data, results) {
  const models = results.map(r => r.model).filter(Boolean);
  const issues = Array.isArray(data.issues) ? data.issues : [];
  const merged = Array.isArray(data.merged) ? data.merged : [];
  return {
    plan: {
      title: 'Plan',
      summary: `Wave ${data.wave || 'unknown'} continued the active project request from repo autopilot docs/state.`,
      bullets: ['Use project standing instructions and current repo state.', 'Prefer verified progress over uncommitted exploration.'],
      artifacts: ['docs/AUTOPILOT.md', 'state/autopilot.md'],
    },
    assign: {
      title: 'Assign',
      summary: models.length ? `Assigned ${models.length} model worker(s).` : 'No model workers recorded.',
      bullets: models.map((m, i) => `${m} → worker ${i + 1}`),
      artifacts: results.map(r => r.log).filter(Boolean),
    },
    build: {
      title: 'Build',
      summary: `${results.length} worker result(s), max elapsed ${formatDuration(results.reduce((m, r) => Math.max(m, Number(r.elapsed || 0)), 0))}.`,
      bullets: results.map(r => `${r.model || 'model'}: ${r.summary || 'no summary'} (${r.rc === 0 ? 'ok' : `rc=${r.rc}`})`),
      artifacts: results.map(r => r.branch).filter(Boolean),
    },
    review: {
      title: 'Review',
      summary: issues.length ? `${issues.length} issue(s) recorded.` : 'No issues recorded in summary.',
      bullets: issues.length ? issues : ['Implicit review via merge/test gates.'],
      artifacts: [],
    },
    integrate: {
      title: 'Integrate',
      summary: `${merged.length} branch(es) merged; verification rc=${data.verificationRc}.`,
      bullets: [
        ...merged.map(b => `Merged ${b}`),
        data.verificationTail ? `Verification tail: ${String(data.verificationTail).split('\n').filter(Boolean).slice(-3).join(' / ')}` : 'No verification tail recorded.',
      ],
      artifacts: [],
    },
    learn: {
      title: 'Learn',
      summary: issues.length ? 'Learning opportunity: capture failure pattern and assignment fit.' : 'Successful/quiet wave; capture what worked when useful.',
      bullets: issues.length ? ['Record failed worker startup/merge/test patterns.', 'Update model/task-size/prompt learnings if repeated.'] : ['Track model usefulness, task size, prompt clarity, and test discipline.'],
      artifacts: ['.autopilot/learnings.jsonl', '.autopilot/models/'],
    },
  };
}

async function firstExistingText(repo, paths) {
  for (const rel of paths) {
    const full = path.join(repo, rel);
    if (await exists(full)) {
      const raw = await fs.readFile(full, 'utf8').catch(() => '');
      const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
      const text = lines.find(l => !l.startsWith('#')) || lines[0] || '';
      return { path: rel, text: text.slice(0, 600) };
    }
  }
  return { path: null, text: 'No explicit request file yet. Add .autopilot/request.md to make the active request first-class.' };
}

async function projectDocs(repo) {
  const docs = [];
  for (const rel of DOC_FILES) {
    const full = path.join(repo, rel);
    if (!(await exists(full))) continue;
    const raw = await fs.readFile(full, 'utf8').catch(() => '');
    docs.push({ path: rel, title: rel.split('/').at(-1), preview: raw.split('\n').slice(0, 6).join('\n').slice(0, 700) });
  }
  const modelDir = path.join(repo, '.autopilot/models');
  for (const name of await listFilesSafe(modelDir, /\.md$/)) {
    const rel = `.autopilot/models/${name}`;
    if (docs.some(d => d.path === rel)) continue;
    const raw = await fs.readFile(path.join(repo, rel), 'utf8').catch(() => '');
    docs.push({ path: rel, title: name, preview: raw.split('\n').slice(0, 6).join('\n').slice(0, 700) });
  }
  return docs;
}

async function projectLearnings(repo, waves) {
  const file = path.join(repo, '.autopilot/learnings.jsonl');
  const explicit = [];
  if (await exists(file)) {
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    for (const line of raw.split('\n').filter(Boolean).slice(-50)) {
      try { explicit.push(JSON.parse(line)); } catch { explicit.push({ scope: 'note', claim: line }); }
    }
  }
  const recent = waves.slice(-25);
  const total = recent.length || 1;
  const passed = recent.filter(w => w.status === 'passed').length;
  const failed = recent.filter(w => w.status === 'failed' || w.status === 'issues').length;
  const avgElapsed = Math.round(recent.reduce((n, w) => n + Number(w.elapsedSeconds || 0), 0) / total);
  return {
    explicit,
    generated: [
      { scope: 'workflow', claim: `${passed}/${recent.length} recent waves passed cleanly.`, confidence: recent.length ? Math.min(0.9, 0.35 + recent.length / 50) : 0.2, evidence: { recentWaves: recent.length, passed, failed } },
      { scope: 'task-size', claim: `Recent waves average ${formatDuration(avgElapsed)} max worker time; use this to decide whether task slices are too small or too large.`, confidence: recent.length ? 0.55 : 0.2, evidence: { avgElapsedSeconds: avgElapsed } },
      { scope: 'prompt', claim: 'Make the active request explicit in .autopilot/request.md so every run can display what the user asked for.', confidence: 0.8, evidence: { source: 'dashboard gap' } },
    ],
  };
}

async function scanProject(host, repoPath) {
  const repo = validateProject(host, repoPath);
  if (!(await exists(repo))) throw Object.assign(new Error('repoPath does not exist'), { status: 404 });
  const [git, waves, stateNames, logNames, request] = await Promise.all([
    gitStatus(repo),
    parseWaveSummaries(repo),
    listFilesSafe(path.join(repo, 'state')),
    listFilesSafe(path.join(repo, 'logs')),
    firstExistingText(repo, REQUEST_FILES),
  ]);
  const latestWave = waves.at(-1) || null;
  const stopState = {};
  for (const name of STOP_FILES) stopState[name] = await exists(path.join(repo, 'state', name));
  const runningPidFiles = stateNames.filter(n => n.endsWith('.pid'));
  const loop = stageLoop(latestWave, stopState, runningPidFiles);
  return {
    key: projectKey(host, repo), host, repoPath: repo,
    request,
    git,
    latestWave,
    waveCount: waves.length,
    recentWaves: waves.slice(-20).reverse(),
    loop,
    controls: { stopState, runningPidFiles },
    logs: {
      count: logNames.length,
      latestSupervisorLog: latestByName(logNames.filter(n => n.includes('autopilot') && n.endsWith('.log'))),
      latestWaveLog: latestByName(logNames.filter(n => n.includes('wave'))),
    },
    docs: await projectDocs(repo),
    learnings: await projectLearnings(repo, waves),
  };
}

function stageLoop(latestWave, stopState, pidFiles) {
  const stopped = Object.values(stopState).some(Boolean);
  const running = pidFiles.length > 0 && !stopped;
  const stages = STAGES.map(stage => ({ stage, status: 'pending', summary: '' }));
  if (!latestWave) {
    stages[0].status = running ? 'running' : 'pending';
    stages[0].summary = running ? 'Waiting for first wave summary.' : 'No wave summaries yet.';
    return { current: running ? 'plan' : 'idle', stages };
  }
  stages[0].status = 'passed'; stages[0].summary = `Wave ${latestWave.id} selected work.`;
  stages[1].status = 'passed'; stages[1].summary = `${latestWave.models.length} model(s): ${latestWave.models.map(m => String(m).split('/').at(-1)).join(', ')}`;
  stages[2].status = 'passed'; stages[2].summary = `${latestWave.results.length} worker(s), max elapsed ${formatDuration(latestWave.elapsedSeconds)}.`;
  stages[3].status = latestWave.issues.length ? 'failed' : 'passed'; stages[3].summary = latestWave.issues.length ? latestWave.issues.slice(0, 2).join('; ') : 'No issues recorded.';
  stages[4].status = latestWave.verificationRc === 0 ? 'passed' : 'failed'; stages[4].summary = `${latestWave.mergedCount} branch(es) merged; tests rc=${latestWave.verificationRc}.`;
  stages[5].status = 'passed'; stages[5].summary = `History recorded in ${latestWave.file}.`;
  if (running) return { current: 'build', stages };
  if (stopped) return { current: 'blocked', stages };
  return { current: latestWave.status, stages };
}
function formatDuration(s) { s = Number(s || 0); const m = Math.floor(s / 60), sec = s % 60; return m ? `${m}m${sec}s` : `${sec}s`; }

async function listRepoDir(host, repoPath, dir = '.') {
  const repo = validateProject(host, repoPath);
  const full = path.resolve(repo, dir);
  if (!full.startsWith(repo)) throw Object.assign(new Error('path escapes repo'), { status: 400 });
  const entries = await fs.readdir(full, { withFileTypes: true });
  return entries
    .filter(e => !['.git', 'node_modules', '.deps'].includes(e.name))
    .map(e => ({ name: e.name, path: path.relative(repo, path.join(full, e.name)) || '.', type: e.isDirectory() ? 'dir' : 'file' }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}
async function readRepoFile(host, repoPath, file) {
  const repo = validateProject(host, repoPath);
  const full = path.resolve(repo, file || 'README.md');
  if (!full.startsWith(repo)) throw Object.assign(new Error('path escapes repo'), { status: 400 });
  const stat = await fs.stat(full);
  if (stat.isDirectory()) throw Object.assign(new Error('path is a directory'), { status: 400 });
  if (stat.size > MAX_FILE_BYTES) throw Object.assign(new Error('file too large for preview'), { status: 413 });
  return await fs.readFile(full, 'utf8');
}

async function controlProject(host, repoPath, action) {
  const repo = validateProject(host, repoPath);
  const state = path.join(repo, 'state');
  await fs.mkdir(state, { recursive: true });
  const touched = [];
  if (action === 'stop-now' || action === 'pause') {
    for (const name of ['STOP_AUTOPILOT', 'STOP_ETL_AUTOPILOT', 'STOP_ETL_PARALLEL']) { await fs.writeFile(path.join(state, name), new Date().toISOString() + '\n'); touched.push(name); }
  } else if (action === 'stop-after-current-wave') {
    for (const name of ['STOP_AFTER_CURRENT_LOOP']) { await fs.writeFile(path.join(state, name), new Date().toISOString() + '\n'); touched.push(name); }
  } else if (action === 'resume') {
    for (const name of STOP_FILES) { await fs.rm(path.join(state, name), { force: true }); touched.push(`removed:${name}`); }
  } else {
    throw Object.assign(new Error('unknown action'), { status: 400 });
  }
  return { ok: true, action, touched };
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, host: HOSTNAME, version: '0.1.0' });
  if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, { projects: await loadProjects() });
  if (url.pathname === '/api/projects' && req.method === 'POST') {
    const body = await readBody(req); const repoPath = validateProject(body.host || HOSTNAME, body.repoPath);
    const projects = await loadProjects(); const item = { host: body.host || HOSTNAME, repoPath, name: body.name || path.basename(repoPath), key: projectKey(body.host || HOSTNAME, repoPath) };
    const next = projects.filter(p => p.key !== item.key).concat(item); await writeJson(PROJECTS_FILE, { projects: next }); return json(res, 200, item);
  }
  if (url.pathname === '/api/project') return json(res, 200, await scanProject(url.searchParams.get('host'), url.searchParams.get('repoPath')));
  if (url.pathname === '/api/files') return json(res, 200, { entries: await listRepoDir(url.searchParams.get('host'), url.searchParams.get('repoPath'), url.searchParams.get('dir') || '.') });
  if (url.pathname === '/api/file') return text(res, 200, await readRepoFile(url.searchParams.get('host'), url.searchParams.get('repoPath'), url.searchParams.get('file')), 'text/plain; charset=utf-8');
  if (url.pathname === '/api/control' && req.method === 'POST') { const body = await readBody(req); return json(res, 200, await controlProject(body.host, body.repoPath, body.action)); }
  return json(res, 404, { error: 'not found' });
}
function readBody(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } }); req.on('error', reject); }); }

async function serveStatic(req, res, url) {
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
    return res.end();
  }
  let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.resolve(ROOT, 'public', file);
  if (!full.startsWith(path.resolve(ROOT, 'public'))) return text(res, 403, 'forbidden');
  if (!fssync.existsSync(full)) return text(res, 404, 'not found');
  const ext = path.extname(full);
  const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'application/javascript; charset=utf-8' : 'application/octet-stream';
  text(res, 200, await fs.readFile(full, ext === '.png' ? undefined : 'utf8'), type);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    json(res, e.status || 500, { error: e.message || String(e) });
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`Autopilot Control Tower listening on :${PORT}`));
