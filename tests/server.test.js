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
  assert.match(health.version, /real-loop/);
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

test('background loop launches real OpenClaw agents only', async (t) => {
  const binDir = await mkdtemp(path.join(tmpdir(), 'act-bin-'));
  t.after(() => rm(binDir, { recursive: true, force: true }));
  const fake = path.join(binDir, 'fake-openclaw');
  await writeFile(fake, '#!/usr/bin/env node\nsetTimeout(() => console.log(JSON.stringify({ reply: "FAKE_LOOP_OK" })), 25);\n', 'utf8');
  await chmod(fake, 0o755);
  await start({ AUTOPILOT_LOOP_TICK_MS: '100', OPENCLAW_BIN: fake, OPENCLAW_AGENT_RUNS: '1', OPENCLAW_AGENT_TOKEN: 'test-token' });
  t.after(async () => { await stop(); });
  const projects = await fetch(`http://127.0.0.1:${PORT}/api/projects`).then(r => r.json());
  const p = projects.projects[0];
  await post('/api/config', { host: p.host, repoPath: p.repoPath, intent: 'Keep improving the project with real agents.', variantCount: 2 });
  const enabled = await fetch(`http://127.0.0.1:${PORT}/api/autopilot`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': 'test-token' }, body: JSON.stringify({ host: p.host, repoPath: p.repoPath, enabled: true, runNow: true, mode: 'simulated', intervalSeconds: 10 }) }).then(r => r.json());
  assert.equal(enabled.autopilot.enabled, true);
  assert.equal(enabled.autopilot.mode, 'agent');
  for (let i = 0; i < 30; i++) {
    const snap = await fetch(`http://127.0.0.1:${PORT}/api/project?host=${encodeURIComponent(p.host)}&repoPath=${encodeURIComponent(p.repoPath)}`).then(r => r.json());
    const run = snap.loop.agentRuns.find(x => /FAKE_LOOP_OK/.test(x.output || '')) || snap.loop.agentRuns[0];
    if (run?.status === 'succeeded' && /FAKE_LOOP_OK/.test(run.output || '')) {
      assert.match(run.output, /FAKE_LOOP_OK/);
      assert.equal(snap.loop.autopilot.enabled, true);
      assert.equal(snap.loop.autopilot.mode, 'agent');
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  assert.fail('background real loop did not launch an agent');
});

