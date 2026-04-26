import http from 'node:http';
import { promises as fs } from 'node:fs';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const STATE_FILE = path.join(DATA_DIR, 'loop-state.json');
const AGENT_RUNS_DIR = path.join(DATA_DIR, 'agent-runs');
const PORT = Number(process.env.PORT || 8787);
const HOSTNAME = os.hostname();
const MAX_FILE_BYTES = 512 * 1024;
const STAGES = ['request', 'overseer', 'supervisors', 'subagents', 'evaluate', 'improve'];
const AGENT_RUNS_ENABLED = ['1', 'true', 'yes'].includes(String(process.env.OPENCLAW_AGENT_RUNS || '').toLowerCase());
const AGENT_RUN_TOKEN = process.env.OPENCLAW_AGENT_TOKEN || '';

const DEFAULT_OVERSEER_PROMPT = `You are Autopilot Overseer. Keep your role simple and stable: receive the user request, spawn a small set of supervisor variants, assign each supervisor the same intent, and compare their final results. Do not do the project work yourself.`;

const DEFAULT_SUPERVISOR_PROMPT = `You are Autopilot Supervisor. Your job is to satisfy the user's intent in one shot whenever possible.\n\nProcess:\n1. Convert the request into clear acceptance criteria.\n2. Decide what supervisor strategy should be used for this request.\n3. Spawn focused sub-agents with precise role prompts.\n4. Evaluate both the supervisor strategy and the sub-agent guidance.\n5. Integrate sub-agent results into one coherent deliverable.\n6. If feedback or evaluation shows a gap, update the supervisor prompt and sub-agent guidance so the next one-shot attempt is better.`;

function projectKey(host, repoPath) { return `${host}:${path.resolve(repoPath)}`; }
function now() { return new Date().toISOString(); }
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body, null, 2)); }
function text(res, status, body, type = 'text/plain; charset=utf-8') { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); }
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function readJson(p, fallback) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; } }
async function writeJson(p, value) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(value, null, 2) + '\n'); }
function validateProject(host, repoPath) {
  if (!host || !repoPath) throw Object.assign(new Error('host and repoPath are required'), { status: 400 });
  if (!path.isAbsolute(repoPath)) throw Object.assign(new Error('repoPath must be absolute'), { status: 400 });
  if (repoPath.includes('\0')) throw Object.assign(new Error('invalid repoPath'), { status: 400 });
  return path.resolve(repoPath);
}

async function defaultProjects() {
  const candidates = [['/app', 'Autopilot Control Tower container'], ['/openclaw/.openclaw/tmp/autopilot-control-tower', 'Autopilot Control Tower workspace'], ['/home/node/.openclaw/tmp/autopilot-control-tower', 'Autopilot Control Tower repo']];
  const out = [];
  for (const [repoPath, name] of candidates) if (await exists(repoPath)) out.push({ host: HOSTNAME, repoPath, name, key: projectKey(HOSTNAME, repoPath) });
  return out;
}
async function loadProjects() {
  const stored = await readJson(PROJECTS_FILE, null);
  if (Array.isArray(stored?.projects)) return stored.projects;
  const projects = await defaultProjects(); await writeJson(PROJECTS_FILE, { projects }); return projects;
}
async function loadState() { const state = await readJson(STATE_FILE, { projects: {} }); state.projects ||= {}; return state; }
async function saveProjectState(key, projectState) { const all = await loadState(); all.projects[key] = projectState; await writeJson(STATE_FILE, all); return projectState; }
function blankLoop() {
  return {
    intent: '',
    model: 'gpt-5.5',
    agentId: '',
    overseerPrompt: DEFAULT_OVERSEER_PROMPT,
    supervisorPrompt: DEFAULT_SUPERVISOR_PROMPT,
    variantCount: 3,
    status: 'not configured',
    stage: 'request',
    cycle: 0,
    score: 0,
    supervisorScore: 0,
    subAgentScore: 0,
    metrics: { correctness: 0, cost: 0, requests: 0, duration: 0 },
    weights: { correctness: 0.7, cost: 0.1, requests: 0.1, duration: 0.1 },
    oneShot: null,
    variants: [],
    evaluations: [],
    learnings: [],
    promptRevisions: [],
    history: [],
    agentRuns: [],
    updatedAt: now(),
  };
}
function normalizedLoop(all, key) { return { ...blankLoop(), ...(all.projects?.[key] || {}) }; }

function runGit(repo, args, timeoutMs = 4000) {
  return new Promise(resolve => {
    const cp = spawn('git', ['-c', 'safe.directory=*', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { cp.kill('SIGKILL'); resolve({ rc: 124, out, err: err + 'timeout' }); }, timeoutMs);
    cp.stdout.on('data', d => out += d); cp.stderr.on('data', d => err += d);
    cp.on('close', rc => { clearTimeout(t); resolve({ rc, out, err }); }); cp.on('error', e => { clearTimeout(t); resolve({ rc: 1, out, err: String(e) }); });
  });
}
async function gitStatus(repo) {
  const [head, branch, dirty, recent] = await Promise.all([runGit(repo, ['rev-parse', '--short', 'HEAD']), runGit(repo, ['branch', '--show-current']), runGit(repo, ['status', '--porcelain']), runGit(repo, ['log', '--oneline', '-6'])]);
  return { head: head.rc === 0 ? head.out.trim() : 'unknown', branch: branch.rc === 0 ? branch.out.trim() : 'unknown', dirtyFiles: dirty.rc === 0 ? dirty.out.split('\n').filter(Boolean).length : null, recentCommits: recent.rc === 0 ? recent.out.split('\n').filter(Boolean) : [] };
}
function loopCards(loop) { return STAGES.map(stage => ({ stage, status: stage === loop.stage ? 'active' : STAGES.indexOf(stage) < STAGES.indexOf(loop.stage) ? 'done' : 'pending', summary: stageSummary(stage, loop) })); }
function stageSummary(stage, loop) {
  if (stage === 'request') return loop.intent ? 'User intent captured for one-shot attempt.' : 'Capture the user request.';
  if (stage === 'overseer') return 'Static overseer spawns supervisor variants; it does not do project work.';
  if (stage === 'supervisors') return `${loop.variants.length || loop.variantCount} supervisor variant(s) competing on the same request.`;
  if (stage === 'subagents') return 'Each supervisor spawns and manages its own sub-agent team.';
  if (stage === 'evaluate') return `Overall ${loop.score}/100 · correctness ${loop.metrics?.correctness || 0}/100 · duration ${loop.metrics?.duration || 0}/100.`;
  return `${loop.promptRevisions.length} prompt/guidance revision(s).`;
}
function acceptanceCriteria(intent) {
  const trimmed = intent.trim();
  return [
    'The delivered result directly addresses the user request.',
    'The supervisor decomposes work into clear sub-agent prompts only when useful.',
    'The final answer is integrated, not a pile of worker outputs.',
    trimmed.length > 80 ? `Preserve this specific intent: ${trimmed.slice(0, 220)}` : 'Ask for more detail only if the intent is unsafe or impossible.',
  ];
}
function makeVariants(loop) {
  const styles = ['Direct one-shot supervisor', 'Planner/integrator supervisor', 'Evaluation-first supervisor'];
  const subRoles = ['Acceptance criteria analyst', 'Builder / implementer', 'Reviewer / gap finder'];
  return Array.from({ length: Math.max(1, Math.min(6, Number(loop.variantCount || 3))) }, (_, i) => ({
    id: String.fromCharCode(65 + i),
    strategy: styles[i] || `Supervisor strategy ${i + 1}`,
    supervisorPrompt: `${loop.supervisorPrompt}\n\nSupervisor variant ${String.fromCharCode(65 + i)}: ${styles[i] || 'Try a distinct supervision strategy.'}`,
    subAgents: subRoles.map((role, j) => ({
      id: `${String.fromCharCode(65 + i)}${j + 1}`,
      role,
      prompt: `${role}: help Supervisor ${String.fromCharCode(65 + i)} satisfy the user's intent in one shot. Be concrete, terse, and evaluation-oriented.`,
      score: 0,
      finding: '',
    })),
    resultSummary: `Prototype ${styles[i] || 'supervisor'} run generated from supervisor prompt.`,
    supervisorScore: 0,
    subAgentScore: 0,
    metrics: { correctness: 0, cost: 0, requests: 0, duration: 0 },
    usage: { estimatedTokens: 0, requestCount: 0, durationSeconds: 0, estimatedCostUsd: 0 },
    score: 0,
  }));
}
function runId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function shortText(s, max = 2400) { s = String(s || ''); return s.length > max ? s.slice(0, max) + `\n…truncated (${s.length} chars)` : s; }
function parseOpenClawJson(out) {
  try { return JSON.parse(out); } catch {}
  let fallback = null;
  for (let i = out.indexOf('{'); i >= 0; i = out.indexOf('{', i + 1)) {
    const candidate = out.slice(i).trim();
    try {
      const parsed = JSON.parse(candidate);
      if (openClawReply(parsed, '') !== '') return parsed;
      fallback ||= parsed;
    } catch {}
  }
  return fallback;
}
function openClawReply(parsed, out) {
  return parsed?.reply || parsed?.text || parsed?.message || parsed?.result || parsed?.finalAssistantVisibleText || parsed?.finalAssistantRawText || parsed?.data?.finalAssistantVisibleText || parsed?.turn?.finalAssistantVisibleText || out;
}
async function appendRunLog(id, chunk) { await fs.mkdir(AGENT_RUNS_DIR, { recursive: true }); await fs.appendFile(path.join(AGENT_RUNS_DIR, `${id}.log`), chunk); }
async function updateAgentRun(projectKeyValue, id, patch) {
  const all = await loadState();
  const loop = normalizedLoop(all, projectKeyValue);
  const runs = loop.agentRuns || [];
  const idx = runs.findIndex(r => r.id === id);
  if (idx >= 0) runs[idx] = { ...runs[idx], ...patch, updatedAt: now() };
  else runs.unshift({ id, ...patch, updatedAt: now() });
  loop.agentRuns = runs.slice(0, 30);
  all.projects[projectKeyValue] = loop;
  await writeJson(STATE_FILE, all);
  return loop;
}
function requireAgentAuth(req) {
  if (!AGENT_RUNS_ENABLED) throw Object.assign(new Error('Real OpenClaw agent runs are disabled on this server. Set OPENCLAW_AGENT_RUNS=1 and OPENCLAW_AGENT_TOKEN to enable them.'), { status: 503 });
  if (!AGENT_RUN_TOKEN) throw Object.assign(new Error('OPENCLAW_AGENT_TOKEN is required before enabling public agent launches.'), { status: 503 });
  const auth = req.headers.authorization || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
  const supplied = req.headers['x-agent-token'] || bearer;
  if (supplied !== AGENT_RUN_TOKEN) throw Object.assign(new Error('agent launch token required'), { status: 401 });
}
async function startAgentRun(host, repoPath, body = {}) {
  const repo = validateProject(host, repoPath);
  if (!(await exists(repo))) throw Object.assign(new Error('repoPath does not exist'), { status: 400 });
  const key = projectKey(host, repo);
  const loop = normalizedLoop(await loadState(), key);
  const id = runId();
  const message = String(body.message || loop.intent || '').trim();
  if (!message) throw Object.assign(new Error('Set an intent or provide a message before starting an agent.'), { status: 400 });
  const agentId = String(body.agentId || loop.agentId || process.env.OPENCLAW_AGENT_ID || '').trim();
  const thinking = String(body.thinking || process.env.OPENCLAW_AGENT_THINKING || 'medium');
  const timeout = String(body.timeoutSeconds || process.env.OPENCLAW_AGENT_TIMEOUT || '900');
  const sessionId = String(body.sessionId || `autopilot-${id}`);
  const prompt = [
    `You are a real OpenClaw agent run launched by Autopilot Control Tower.`,
    `Project repo: ${repo}`,
    `User request / intent:`,
    message,
    ``,
    `Work directly in that repo when the request calls for code or file changes. Return a concise final report with files changed, validation performed, blockers, and next recommendation.`
  ].join('\n');
  const bin = process.env.OPENCLAW_BIN || 'openclaw';
  const args = ['agent', '--session-id', sessionId, '--message', prompt, '--thinking', thinking, '--timeout', timeout, '--json'];
  if (agentId) args.splice(1, 0, '--agent', agentId);
  const entry = { id, ts: now(), status: 'running', repoPath: repo, agentId: agentId || 'default', sessionId, thinking, timeoutSeconds: Number(timeout), message: shortText(message, 1000), logFile: path.join(AGENT_RUNS_DIR, `${id}.log`) };
  loop.agentRuns = [entry, ...(loop.agentRuns || [])].slice(0, 30);
  loop.status = 'agent running'; loop.stage = 'subagents'; loop.updatedAt = now();
  await saveProjectState(key, loop);
  await appendRunLog(id, `$ ${bin} ${args.map(a => JSON.stringify(a)).join(' ')}\n\n`);
  const child = spawn(bin, args, { cwd: repo, env: { ...process.env, HOME: process.env.OPENCLAW_HOME || process.env.HOME || '/openclaw' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; appendRunLog(id, d).catch(()=>{}); });
  child.stderr.on('data', d => { err += d; appendRunLog(id, d).catch(()=>{}); });
  child.on('error', e => updateAgentRun(key, id, { status: 'failed', error: String(e), completedAt: now() }).catch(()=>{}));
  child.on('close', rc => {
    const combined = `${out}\n${err}`;
    const parsed = parseOpenClawJson(combined);
    const reply = openClawReply(parsed, combined);
    updateAgentRun(key, id, { status: rc === 0 ? 'succeeded' : 'failed', rc, completedAt: now(), output: shortText(reply, 6000), error: shortText(err, 3000), rawJson: parsed ? parsed : undefined }).catch(()=>{});
  });
  return entry;
}
async function getAgentRunLog(id) {
  const safe = String(id || '').replace(/[^a-z0-9-]/gi, '');
  if (!safe) throw Object.assign(new Error('id required'), { status: 400 });
  return fs.readFile(path.join(AGENT_RUNS_DIR, `${safe}.log`), 'utf8');
}

function weightedScore(metrics, weights) {
  return Math.round(
    metrics.correctness * weights.correctness +
    metrics.cost * weights.cost +
    metrics.requests * weights.requests +
    metrics.duration * weights.duration
  );
}
function evaluateVariants(loop) {
  const criteria = acceptanceCriteria(loop.intent);
  const weights = loop.weights || { correctness: 0.7, cost: 0.1, requests: 0.1, duration: 0.1 };
  const promptStrength = Math.min(22, Math.floor(loop.supervisorPrompt.length / 100));
  const intentStrength = loop.intent.trim().length > 20 ? 24 : 8;
  const variants = (loop.variants.length ? loop.variants : makeVariants(loop)).map((v, i) => {
    const subAgents = (v.subAgents || []).map((sa, j) => ({
      ...sa,
      score: Math.min(100, intentStrength + 18 + j * 4 + Math.min(loop.cycle * 3, 12)),
      finding: `${sa.role} produced guidance for Supervisor ${v.id}.`,
    }));
    const usage = {
      estimatedTokens: 900 + i * 350 + subAgents.length * 450,
      requestCount: 1 + subAgents.length,
      durationSeconds: 45 + i * 12 + subAgents.length * 18,
      estimatedCostUsd: Number((0.004 + i * 0.002 + subAgents.length * 0.003).toFixed(3)),
    };
    const subAgentScore = Math.round(subAgents.reduce((n, sa) => n + sa.score, 0) / Math.max(1, subAgents.length));
    const supervisorScore = Math.min(100, intentStrength + promptStrength + 20 + i * 5 + Math.min(loop.cycle * 4, 16));
    const correctness = Math.round(supervisorScore * 0.65 + subAgentScore * 0.35);
    const metrics = {
      correctness,
      cost: Math.max(0, 100 - Math.round(usage.estimatedCostUsd * 1800)),
      requests: Math.max(0, 100 - usage.requestCount * 8),
      duration: Math.max(0, 100 - Math.round(usage.durationSeconds / 2)),
    };
    const score = weightedScore(metrics, weights);
    return { ...v, subAgents, supervisorScore, subAgentScore, metrics, usage, score };
  });
  const best = variants.reduce((a, b) => b.score > a.score ? b : a, variants[0]);
  const gaps = [];
  if (best.metrics.correctness < 85) gaps.push('Correctness is the highest-weight metric: improve acceptance criteria, integration, and review.');
  if (best.metrics.cost < 80) gaps.push('Cost/tokens are high; reduce redundant sub-agent work.');
  if (best.metrics.requests < 80) gaps.push('Too many requests; use fewer or more focused sub-agents.');
  if (best.metrics.duration < 80) gaps.push('Duration is high; prefer faster supervisor/sub-agent handoffs.');
  if (!loop.supervisorPrompt.toLowerCase().includes('sub-agent')) gaps.push('Prompt should explicitly explain how to spawn and manage sub-agents.');
  return { ts: now(), cycle: loop.cycle, criteria, weights, variants, bestVariant: best.id, score: best.score, supervisorScore: best.supervisorScore, subAgentScore: best.subAgentScore, metrics: best.metrics, usage: best.usage, gaps, summary: best.score >= 85 ? 'Hierarchy performs well across correctness, cost, requests, and duration.' : 'Use the comparison to improve the hierarchy prompts and sub-agent guidance.' };
}
function revisePrompt(loop, ev) {
  const additions = [
    'Before final delivery, score your result against the acceptance criteria from 0-100.',
    'If using sub-agents, assign each one a narrow role, explicit output contract, and review criteria.',
    'The supervisor should compare sub-agent outputs, resolve conflicts, and integrate them into one final answer.',
    'Prefer completing the user intent in one shot; ask follow-up questions only for hard blockers.',
  ];
  const missing = additions.filter(line => !loop.supervisorPrompt.includes(line));
  if (!missing.length && !ev?.gaps?.length) return loop.supervisorPrompt;
  return `${loop.supervisorPrompt.trim()}\n\nLearned supervisor rules:\n${missing.map(x => `- ${x}`).join('\n') || `- ${ev.gaps[0]}`}`;
}
async function configureLoop(host, repoPath, patch) {
  const repo = validateProject(host, repoPath); const key = projectKey(host, repo); const current = normalizedLoop(await loadState(), key);
  const next = { ...current, intent: String(patch.intent ?? current.intent ?? ''), model: String(patch.model ?? current.model ?? 'gpt-5.5'), agentId: String(patch.agentId ?? current.agentId ?? ''), overseerPrompt: String(patch.overseerPrompt ?? current.overseerPrompt ?? DEFAULT_OVERSEER_PROMPT), supervisorPrompt: String(patch.supervisorPrompt ?? current.supervisorPrompt ?? DEFAULT_SUPERVISOR_PROMPT), variantCount: Number(patch.variantCount || current.variantCount || 3), status: 'ready', stage: 'request', updatedAt: now() };
  next.history = [...(current.history || []), { ts: now(), event: 'configured', intent: next.intent, model: next.model, variantCount: next.variantCount }].slice(-100);
  return saveProjectState(key, next);
}
async function stepLoop(host, repoPath) {
  const repo = validateProject(host, repoPath); const key = projectKey(host, repo); const loop = normalizedLoop(await loadState(), key);
  if (!loop.intent.trim()) throw Object.assign(new Error('Set an intent before running the loop.'), { status: 400 });
  const history = [...(loop.history || [])];
  if (loop.stage === 'request') {
    loop.oneShot = { ts: now(), intent: loop.intent, model: loop.model, acceptanceCriteria: acceptanceCriteria(loop.intent), overseerPrompt: loop.overseerPrompt, supervisorPrompt: loop.supervisorPrompt };
    loop.stage = 'overseer'; loop.status = 'running'; history.push({ ts: now(), event: 'request-captured', criteria: loop.oneShot.acceptanceCriteria });
  } else if (loop.stage === 'overseer') {
    loop.variants = makeVariants(loop); loop.stage = 'supervisors'; history.push({ ts: now(), event: 'overseer-spawned-supervisors', variants: loop.variants.map(v => v.id) });
  } else if (loop.stage === 'supervisors') {
    loop.variants = (loop.variants.length ? loop.variants : makeVariants(loop)).map(v => ({ ...v, resultSummary: `${v.strategy} prepared a supervision plan and sub-agent team.` }));
    loop.stage = 'subagents'; history.push({ ts: now(), event: 'supervisors-prepared-subagents', supervisorCount: loop.variants.length, subAgentCount: loop.variants.reduce((n, v) => n + (v.subAgents?.length || 0), 0) });
  } else if (loop.stage === 'subagents') {
    loop.variants = (loop.variants.length ? loop.variants : makeVariants(loop)).map(v => ({ ...v, resultSummary: `${v.strategy} managed its sub-agents and produced a candidate one-shot result.` }));
    loop.stage = 'evaluate'; history.push({ ts: now(), event: 'subagents-ran', supervisorCount: loop.variants.length, subAgentCount: loop.variants.reduce((n, v) => n + (v.subAgents?.length || 0), 0) });
  } else if (loop.stage === 'evaluate') {
    const ev = evaluateVariants(loop); loop.variants = ev.variants; loop.score = ev.score; loop.supervisorScore = ev.supervisorScore; loop.subAgentScore = ev.subAgentScore; loop.metrics = ev.metrics; loop.evaluations = [...(loop.evaluations || []), ev].slice(-50); loop.stage = 'improve'; history.push({ ts: now(), event: 'evaluated', bestVariant: ev.bestVariant, score: ev.score, metrics: ev.metrics, usage: ev.usage, supervisorScore: ev.supervisorScore, subAgentScore: ev.subAgentScore, gaps: ev.gaps });
  } else {
    const ev = loop.evaluations.at(-1); const before = loop.supervisorPrompt; loop.supervisorPrompt = revisePrompt(loop, ev); loop.cycle += 1;
    const changed = before !== loop.supervisorPrompt; if (changed) loop.promptRevisions = [...(loop.promptRevisions || []), { ts: now(), cycle: loop.cycle, fromScore: loop.score, reason: ev?.gaps?.[0] || 'Improve one-shot reliability.' }].slice(-50);
    loop.learnings = [...(loop.learnings || []), { ts: now(), cycle: loop.cycle, claim: ev?.summary || 'Compare one-shot variants to improve supervisor behavior.', score: loop.score }].slice(-50);
    loop.stage = 'request'; history.push({ ts: now(), event: 'prompt-improved', changed, cycle: loop.cycle });
  }
  loop.history = history.slice(-100); loop.updatedAt = now(); return saveProjectState(key, loop);
}
async function scanProject(host, repoPath) {
  const repo = validateProject(host, repoPath);
  const key = projectKey(host, repo);
  if (!(await exists(repo))) return { key, host, repoPath: repo, missing: true, canCreate: canCreateRepo(repo), message: 'This project path does not exist yet.' };
  const state = normalizedLoop(await loadState(), key);
  return { key, host, repoPath: repo, missing: false, git: await gitStatus(repo), loop: state, stages: loopCards(state) };
}
function canCreateRepo(repo) {
  const allowed = ['/openclaw/.openclaw/tmp', '/home/node/.openclaw/tmp', '/tmp'];
  return allowed.some(base => repo === base || repo.startsWith(base + path.sep));
}
async function createProjectRepo(host, repoPath, name = '') {
  const repo = validateProject(host, repoPath);
  if (!canCreateRepo(repo)) throw Object.assign(new Error('For safety, new repos can only be created under /openclaw/.openclaw/tmp, /home/node/.openclaw/tmp, or /tmp.'), { status: 400 });
  if (await exists(repo)) return await scanProject(host, repo);
  await fs.mkdir(repo, { recursive: true });
  const title = name || path.basename(repo);
  await fs.writeFile(path.join(repo, 'README.md'), `# ${title}\n\nCreated by Autopilot Control Tower.\n`, 'utf8');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n.env\n.DS_Store\n', 'utf8');
  await runGit(repo, ['init'], 10000);
  await runGit(repo, ['add', 'README.md', '.gitignore'], 10000);
  await runGit(repo, ['commit', '-m', 'Initial project scaffold'], 10000);
  return await scanProject(host, repo);
}
async function listRepoDir(host, repoPath, dir = '.') { const repo = validateProject(host, repoPath); const full = path.resolve(repo, dir); if (!full.startsWith(repo)) throw Object.assign(new Error('path escapes repo'), { status: 400 }); const entries = await fs.readdir(full, { withFileTypes: true }); return entries.filter(e => !['.git', 'node_modules'].includes(e.name)).map(e => ({ name: e.name, path: path.relative(repo, path.join(full, e.name)) || '.', type: e.isDirectory() ? 'dir' : 'file' })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)); }
async function readRepoFile(host, repoPath, file) { const repo = validateProject(host, repoPath); const full = path.resolve(repo, file || 'README.md'); if (!full.startsWith(repo)) throw Object.assign(new Error('path escapes repo'), { status: 400 }); const stat = await fs.stat(full); if (stat.isDirectory()) throw Object.assign(new Error('path is a directory'), { status: 400 }); if (stat.size > MAX_FILE_BYTES) throw Object.assign(new Error('file too large for preview'), { status: 413 }); return fs.readFile(full, 'utf8'); }
async function readBody(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } }); req.on('error', reject); }); }
async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, host: HOSTNAME, version: '0.4.0-real-openclaw-agents', agentRunsEnabled: AGENT_RUNS_ENABLED, agentRunsAuth: Boolean(AGENT_RUN_TOKEN) });
  if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, { projects: await loadProjects() });
  if (url.pathname === '/api/projects' && req.method === 'POST') { const body = await readBody(req); const host = body.host || HOSTNAME; const repoPath = validateProject(host, body.repoPath); const projects = await loadProjects(); const item = { host, repoPath, name: body.name || path.basename(repoPath), key: projectKey(host, repoPath) }; await writeJson(PROJECTS_FILE, { projects: projects.filter(p => p.key !== item.key).concat(item) }); return json(res, 200, item); }
  if (url.pathname === '/api/project') return json(res, 200, await scanProject(url.searchParams.get('host'), url.searchParams.get('repoPath')));
  if (url.pathname === '/api/project/create' && req.method === 'POST') { const body = await readBody(req); return json(res, 200, await createProjectRepo(body.host, body.repoPath, body.name)); }
  if (url.pathname === '/api/config' && req.method === 'POST') { const body = await readBody(req); return json(res, 200, await configureLoop(body.host, body.repoPath, body)); }
  if (url.pathname === '/api/step' && req.method === 'POST') { const body = await readBody(req); return json(res, 200, await stepLoop(body.host, body.repoPath)); }
  if (url.pathname === '/api/agent/start' && req.method === 'POST') { requireAgentAuth(req); const body = await readBody(req); return json(res, 200, await startAgentRun(body.host, body.repoPath, body)); }
  if (url.pathname === '/api/agent/log') return text(res, 200, await getAgentRunLog(url.searchParams.get('id')));
  if (url.pathname === '/api/files') return json(res, 200, { entries: await listRepoDir(url.searchParams.get('host'), url.searchParams.get('repoPath'), url.searchParams.get('dir') || '.') });
  if (url.pathname === '/api/file') return text(res, 200, await readRepoFile(url.searchParams.get('host'), url.searchParams.get('repoPath'), url.searchParams.get('file')));
  return json(res, 404, { error: 'not found' });
}
async function serveStatic(req, res, url) { if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); } const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); const full = path.resolve(ROOT, 'public', file); if (!full.startsWith(path.resolve(ROOT, 'public'))) return text(res, 403, 'forbidden'); if (!fssync.existsSync(full)) return text(res, 404, 'not found'); const ext = path.extname(full); const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'application/javascript; charset=utf-8' : 'application/octet-stream'; return text(res, 200, await fs.readFile(full, 'utf8'), type); }
const server = http.createServer(async (req, res) => { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); try { if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url); return await serveStatic(req, res, url); } catch (e) { return json(res, e.status || 500, { error: e.message || String(e) }); } });
server.listen(PORT, '0.0.0.0', () => console.log(`Autopilot Control Tower listening on :${PORT}`));
