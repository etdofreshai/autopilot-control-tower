import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 18787;
let cp;
let dataDir;
async function start(extraEnv = {}) {
  dataDir = extraEnv.DATA_DIR || await mkdtemp(path.join(tmpdir(), 'act-data-'));
  cp = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, DATA_DIR: dataDir, ...extraEnv, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server start timeout')), 3000);
    cp.stdout.on('data', d => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
    cp.on('exit', code => reject(new Error('server exited ' + code)));
  });
}
async function stop() { if (cp) cp.kill('SIGTERM'); if (dataDir) await rm(dataDir, { recursive: true, force: true }); cp = undefined; dataDir = undefined; }
async function post(path, body) {
  return fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
}

test('health and projects endpoints', async (t) => {
  await start();
  t.after(async () => { await stop(); });
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).then(r => r.json());
  assert.equal(health.ok, true);
  assert.match(health.version, /persistent-projects/);
  const projects = await fetch(`http://127.0.0.1:${PORT}/api/projects`).then(r => r.json());
  assert.ok(Array.isArray(projects.projects));
});

test('missing project can be created from the API', async (t) => {
  await start();
  t.after(async () => { await stop(); });
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
  t.after(async () => { await stop(); });
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


test('real OpenClaw agent start records async run output', async (t) => {
  const binDir = await mkdtemp(path.join(tmpdir(), 'act-bin-'));
  t.after(() => rm(binDir, { recursive: true, force: true }));
  const fake = path.join(binDir, 'fake-openclaw');
  await writeFile(fake, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ reply: "FAKE_AGENT_OK" }));\n', 'utf8');
  await chmod(fake, 0o755);
  await start({ OPENCLAW_BIN: fake, OPENCLAW_AGENT_RUNS: '1', OPENCLAW_AGENT_TOKEN: 'test-token' });
  t.after(async () => { await stop(); });
  const projects = await fetch(`http://127.0.0.1:${PORT}/api/projects`).then(r => r.json());
  const p = projects.projects[0];
  const configured = await post('/api/config', { host: p.host, repoPath: p.repoPath, intent: 'Fake agent smoke test', agentId: 'test-agent' });
  assert.equal(configured.agentId, 'test-agent');
  const run = await fetch(`http://127.0.0.1:${PORT}/api/agent/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': 'test-token' }, body: JSON.stringify({ host: p.host, repoPath: p.repoPath }) }).then(r => r.json());
  assert.equal(run.status, 'running');
  for (let i = 0; i < 20; i++) {
    const snap = await fetch(`http://127.0.0.1:${PORT}/api/project?host=${encodeURIComponent(p.host)}&repoPath=${encodeURIComponent(p.repoPath)}`).then(r => r.json());
    const found = snap.loop.agentRuns.find(x => x.id === run.id);
    if (found?.status === 'succeeded') {
      assert.match(found.output, /FAKE_AGENT_OK/);
      return;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.fail('agent run did not complete');
});
