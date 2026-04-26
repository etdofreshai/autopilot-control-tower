# Autopilot Control Tower

A small control panel for running a real OpenClaw loop against a project repo.

The control model is intentionally simple:

- **Running** — the server periodically launches real OpenClaw agent runs for the current request.
- **Stopped** — no new runs are launched.

There is no simulated mode in the dashboard and no separate “start an agent, then start a loop” workflow. Set the request, choose the model/agent id if needed, and press **Start loop** or **Stop loop**.

## Run locally

```bash
npm start
# open http://localhost:8787
```

## Required OpenClaw agent bridge

Set these on the server/container before allowing loop launches:

- `OPENCLAW_AGENT_RUNS=1`
- `OPENCLAW_AGENT_TOKEN=<private launch token>` — required; sent by the browser as `x-agent-token`
- `OPENCLAW_HOME=/openclaw` — defaults this way in Docker so the OpenClaw CLI can use the mounted OpenClaw volume/config
- optional: `OPENCLAW_BIN`, `OPENCLAW_AGENT_ID`, `OPENCLAW_AGENT_THINKING`, `OPENCLAW_AGENT_TIMEOUT`

## API sketch

- `GET /api/health` — service status
- `GET /api/projects` — list tracked projects
- `POST /api/projects` — add a project by absolute path
- `GET /api/project?host=...&repoPath=...` — get git + loop state
- `POST /api/config` — set request, model, and optional OpenClaw agent id
- `POST /api/autopilot` — start/stop the real OpenClaw loop
- `GET /api/agent/log?id=...` — inspect a run log
- `GET /api/files` / `GET /api/file` — lightweight repo browser

Loop state is stored locally in `data/loop-state.json` and ignored by git.
