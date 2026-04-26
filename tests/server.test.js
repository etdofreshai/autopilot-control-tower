import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 18787;
let cp;
async function start() {
  cp = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server start timeout')), 3000);
    cp.stdout.on('data', d => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
    cp.on('exit', code => reject(new Error('server exited ' + code)));
  });
}
async function stop() { if (cp) cp.kill('SIGTERM'); }
async function post(path, body) {
  return fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
}

test('health and projects endpoints', async (t) => {
  await start();
  t.after(stop);
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).then(r => r.json());
  assert.equal(health.ok, true);
  assert.match(health.version, /create-missing-repos/);
  const projects = await fetch(`http://127.0.0.1:${PORT}/api/projects`).then(r => r.json());
  assert.ok(Array.isArray(projects.projects));
});

test('missing project can be created from the API', async (t) => {
  await start();
  t.after(stop);
  const base = await mkdtemp(path.join(tmpdir(), 'act-create-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repoPath = path.join(base, 'md-to-html-preview');
  const missing = await fetch(`http://127.0.0.1:${PORT}/api/project?host=test&repoPath=${encodeURIComponent(repoPath)}`).then(r => r.json());
  assert.equal(missing.missing, true);
  assert.equal(missing.canCreate, true);
  const created = await post('/api/project/create', { host: 'test', repoPath, name: 'Markdown to HTML Preview' });
  assert.equal(created.missing, false);
  assert.equal(created.git.branch, 'master');
});

test('configuring and stepping the supervisor learning loop', async (t) => {
  await start();
  t.after(stop);
  const projects = await fetch(`http://127.0.0.1:${PORT}/api/projects`).then(r => r.json());
  const p = projects.projects[0];
  assert.ok(p, 'seed project exists');

  const configured = await post('/api/config', {
    host: p.host,
    repoPath: p.repoPath,
    intent: 'Use a supervisor prompt to complete user requests in one shot, delegate to sub-agents, compare variants, and improve the prompt.',
    model: 'gpt-5.5',
    variantCount: 3,
  });
  assert.equal(configured.model, 'gpt-5.5');
  assert.equal(configured.variantCount, 3);
  assert.match(configured.overseerPrompt, /Autopilot Overseer/);
  assert.match(configured.supervisorPrompt, /Autopilot Supervisor/);

  let loop = await post('/api/step', { host: p.host, repoPath: p.repoPath });
  assert.equal(loop.stage, 'overseer');
  assert.ok(loop.oneShot.acceptanceCriteria.length >= 3);

  loop = await post('/api/step', { host: p.host, repoPath: p.repoPath });
  assert.equal(loop.stage, 'supervisors');
  assert.equal(loop.variants.length, 3);
  assert.equal(loop.variants[0].subAgents.length, 3);

  loop = await post('/api/step', { host: p.host, repoPath: p.repoPath });
  assert.equal(loop.stage, 'subagents');
  loop = await post('/api/step', { host: p.host, repoPath: p.repoPath });
  assert.equal(loop.stage, 'evaluate');
  loop = await post('/api/step', { host: p.host, repoPath: p.repoPath });
  assert.equal(loop.stage, 'improve');
  assert.ok(loop.score > 0);
  assert.ok(loop.supervisorScore > 0);
  assert.ok(loop.subAgentScore > 0);
  assert.ok(loop.metrics.correctness > 0);
  assert.ok(loop.metrics.duration > 0);
});
