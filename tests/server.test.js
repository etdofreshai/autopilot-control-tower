import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

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

test('health and projects endpoints', async (t) => {
  await start();
  t.after(stop);
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).then(r => r.json());
  assert.equal(health.ok, true);
  const projects = await fetch(`http://127.0.0.1:${PORT}/api/projects`).then(r => r.json());
  assert.ok(Array.isArray(projects.projects));
});
