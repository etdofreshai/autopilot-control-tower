# Autopilot Control Tower SPEC

## 1. Purpose

Autopilot Control Tower is a small web application for making long-running OpenClaw agent work observable, controllable, and self-improving.

At its core, it lets a user:

1. Track one or more local project repositories.
2. Set a durable request/intent for a project.
3. Start or stop a background OpenClaw loop.
4. Launch a batch of supervisor variants for that intent.
5. Watch real OpenClaw runs complete.
6. Compare run evidence.
7. Persist learnings and prompt improvements for future cycles.

The product is intentionally simple at the surface: one project selector, one loop control, one request field, run history, learnings, evaluations, and a lightweight repo browser.

## 2. Product model

### 2.1 Top-level concept

The application is a control panel for a real OpenClaw loop, not a simulation dashboard.

The intended user-visible loop is:

```text
PLAN → ASSIGN → BUILD → REVIEW → INTEGRATE → LEARN
```

The current code maps that concept to the following internal stages:

```text
request → overseer → supervisors → subagents → evaluate → improve
```

In the real background loop, most manual stages are compressed into a single scheduled cycle:

```text
project intent
  → make supervisor variants
  → launch real OpenClaw agent runs
  → parse final reports
  → score/evaluate each run
  → compare supervisor batch
  → append learnings and prompt rules
  → wait until next interval
```

### 2.2 Main entities

- **Project**: a tracked local repository identified by `(host, absolute repoPath)`.
- **Loop state**: durable per-project state: request, prompts, run status, metrics, evaluations, learnings, history, notification settings, and scheduler settings.
- **Supervisor variant**: a generated strategy prompt variant (`A`, `B`, `C`, etc.) competing on the same request.
- **Sub-agent role prompt**: conceptual sub-agent roles embedded in each supervisor variant.
- **Agent run**: a real spawned OpenClaw process with a run id, session id, output log, status, and parsed final report.
- **Evaluation**: derived score/evidence record from one real run or one supervisor batch.
- **Learning**: durable claim backed by extracted run evidence.
- **Prompt revision**: appended rule or prompt improvement derived from missing validation, missing next step, push blockers, or batch output.

## 3. Repository structure

```text
.
├── Dockerfile
├── README.md
├── SPEC.md
├── docs.md
├── package.json
├── .autopilot/
│   ├── evals.md
│   ├── program.md
│   ├── task-taxonomy.md
│   └── models/README.md
├── data/
│   ├── projects.json
│   ├── loop-state.json          # ignored in git; runtime state
│   └── agent-runs/*.log         # ignored in git; run logs
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── src/
│   └── server.js
└── tests/
    └── server.test.js
```

## 4. Runtime architecture

### 4.1 Server

`src/server.js` is a dependency-light Node HTTP server. It does not use Express.

Responsibilities:

- Serve static frontend assets from `public/`.
- Expose JSON/text API endpoints under `/api/*`.
- Maintain projects and loop state in JSON files.
- Validate project identity and safe filesystem paths.
- Run git status and repo scaffolding commands.
- Launch real OpenClaw agent processes.
- Append per-run logs.
- Parse OpenClaw JSON/text output into final reply text.
- Derive scores, evaluations, gaps, and prompt improvements.
- Run a periodic scheduler that starts supervisor batches when projects are due.
- Optionally send Telegram/OpenClaw notifications through the `openclaw message send` CLI.

### 4.2 Frontend

`public/index.html`, `public/app.js`, and `public/style.css` implement a plain browser UI with no frontend framework.

Responsibilities:

- Load health/version and project list.
- Select a tracked project.
- Add a local project by absolute path.
- Render loop status, metrics, config form, learnings, evaluation, agent runs, git status, history, and files.
- Start/stop the background loop.
- Prompt for and store the OpenClaw launch token in browser `localStorage`.
- Send client-side event/error logs to `/api/client-log`.
- Browse and preview repository files.
- Offer safe creation of missing repos under approved temp locations.

### 4.3 Storage

The app stores state in local JSON files, selected by `resolveDataDir()`:

1. `DATA_DIR` env var, if writable.
2. `$OPENCLAW_HOME/.openclaw/tmp/autopilot-control-tower/data`, if writable.
3. Bundled `data/` directory.

At startup, the selected persistent data directory is seeded with bundled `projects.json` and `loop-state.json` if missing.

Atomic JSON writes are performed by writing a temporary file and renaming it into place. Per-file write queues prevent overlapping JSON writes. Per-project update queues prevent overlapping mutation of the same project state.

## 5. Environment configuration

### 5.1 Server settings

- `PORT` — HTTP port, default `8787`.
- `DATA_DIR` — preferred writable data directory.
- `OPENCLAW_HOME` — home directory used by OpenClaw CLI and persistent data fallback. Docker default: `/openclaw`.
- `PROJECT_HOST` / `APP_HOST` — default host identity. In production fallback is `dokploy`; otherwise OS hostname.
- `LOG_LEVEL` — `debug`, `info`, `warn`, or `error`. Default `debug`.
- `AUTOPILOT_LOOP_TICK_MS` — scheduler poll interval. Default `5000`, minimum enforced by code is `1000`.

### 5.2 Real agent launch settings

- `OPENCLAW_AGENT_RUNS=1` — required to enable real launch endpoints.
- `OPENCLAW_AGENT_TOKEN` — required shared secret for starting/enabling real agent launches.
- `OPENCLAW_BIN` — CLI binary to execute. Default `openclaw`.
- `OPENCLAW_AGENT_ID` — default OpenClaw agent id, optional.
- `OPENCLAW_AGENT_THINKING` — default thinking level. Default `medium`.
- `OPENCLAW_AGENT_TIMEOUT` — default run timeout seconds. Default `900`.

### 5.3 Notification settings

- `AUTOPILOT_NOTIFY_CHANNEL` — default notification channel. Default `telegram`.
- `AUTOPILOT_NOTIFY_TARGET` — default target. Falls back to `TELEGRAM_NOTIFY_TARGET`, then `telegram:-5146898162`.
- `AUTOPILOT_NOTIFY_EVERY` — summary notification cadence. Default `5` completed runs.

## 6. Security and safety model

### 6.1 Agent launch authorization

Starting/enabling the real loop requires:

- `OPENCLAW_AGENT_RUNS` truthy (`1`, `true`, or `yes`).
- `OPENCLAW_AGENT_TOKEN` set on the server.
- Client supplies the token as either:
  - `x-agent-token`, or
  - `Authorization: Bearer <token>`.

Stopping the loop (`enabled: false`) does not require the token.

### 6.2 Project path validation

Every project-targeted API request requires:

```json
{ "host": "...", "repoPath": "/absolute/path/to/repo" }
```

Validation rules:

- `host` and `repoPath` are required.
- `repoPath` must be absolute.
- NUL bytes are rejected.
- Paths are resolved with `path.resolve()`.

### 6.3 Repo browsing safety

`/api/files` and `/api/file` resolve paths under the project root and reject path traversal when the final path does not start with the repo root.

File previews are limited to `512 KiB`.

Directory listings hide `.git` and `node_modules`.

### 6.4 Repo creation safety

Missing repos can only be created under:

- `/openclaw/.openclaw/tmp`
- `/home/node/.openclaw/tmp`
- `/tmp`

Creation initializes a folder, starter `README.md`, `src/`, `.gitignore`, `git init`, initial add, and initial commit.

### 6.5 Logging scrubbing

Server and client logs scrub keys matching sensitive words such as token, secret, password, authorization, cookie, and key. Long strings and deep objects are truncated.

## 7. Data model

### 7.1 Project record

Stored in `data/projects.json`:

```json
{
  "projects": [
    {
      "host": "dokploy",
      "repoPath": "/app",
      "name": "Autopilot Control Tower container",
      "key": "dokploy:/app"
    }
  ]
}
```

Project key format:

```text
<host>:<absolute repoPath>
```

### 7.2 Loop-state file

Stored in `data/loop-state.json`:

```json
{
  "projects": {
    "host:/absolute/repo": { "...loop state...": true }
  }
}
```

If a project has no state, `blankLoop()` supplies defaults.

### 7.3 Loop state shape

Important fields:

```json
{
  "intent": "",
  "model": "gpt-5.5",
  "agentId": "",
  "overseerPrompt": "...",
  "supervisorPrompt": "...",
  "variantCount": 3,
  "status": "not configured",
  "stage": "request",
  "cycle": 0,
  "score": 0,
  "supervisorScore": 0,
  "subAgentScore": 0,
  "metrics": {
    "correctness": 0,
    "cost": 0,
    "requests": 0,
    "duration": 0
  },
  "weights": {
    "correctness": 0.7,
    "cost": 0.1,
    "requests": 0.1,
    "duration": 0.1
  },
  "oneShot": null,
  "variants": [],
  "evaluations": [],
  "learnings": [],
  "promptRevisions": [],
  "supervisorPromptHistory": [],
  "subAgentPromptHistory": [],
  "history": [],
  "agentRuns": [],
  "notifications": {
    "enabled": true,
    "channel": "telegram",
    "target": "telegram:-5146898162",
    "onStart": true,
    "onFinish": true,
    "every": 5
  },
  "autopilot": {
    "enabled": false,
    "mode": "agent",
    "intervalSeconds": 300,
    "lastTickAt": "",
    "nextRunAt": "",
    "lastError": ""
  },
  "updatedAt": "ISO timestamp"
}
```

### 7.4 Agent run record

```json
{
  "id": "run id",
  "ts": "ISO timestamp",
  "status": "running | succeeded | failed",
  "repoPath": "/absolute/repo",
  "agentId": "default or configured id",
  "sessionId": "autopilot-...",
  "thinking": "medium",
  "timeoutSeconds": 900,
  "message": "user intent",
  "batchId": "batch id",
  "variantId": "A",
  "strategy": "Direct one-shot supervisor",
  "logFile": "data/agent-runs/<id>.log",
  "rc": 0,
  "completedAt": "ISO timestamp",
  "output": "parsed final report text",
  "error": "stderr if failed",
  "warnings": "stderr if succeeded",
  "rawJson": {}
}
```

The state keeps the latest 30 run records per project.

### 7.5 Evaluation record

Real-run evaluation records include:

```json
{
  "ts": "ISO timestamp",
  "cycle": 0,
  "source": "real-agent-run",
  "runId": "...",
  "sessionId": "...",
  "score": 90,
  "metrics": { "correctness": 90, "cost": 70, "requests": 85, "duration": 75 },
  "summary": "...",
  "evidence": {
    "filesChanged": [],
    "validation": [],
    "blockers": "None reported",
    "nextRecommendation": "..."
  },
  "gaps": []
}
```

Supervisor-batch evaluation records include:

```json
{
  "source": "supervisor-batch",
  "batchId": "...",
  "bestVariant": "B",
  "score": 90,
  "runs": [
    {
      "id": "...",
      "variantId": "A",
      "strategy": "...",
      "status": "succeeded",
      "score": 85,
      "validationPassed": true,
      "changed": true,
      "next": "..."
    }
  ],
  "gaps": []
}
```

## 8. API specification

### 8.1 `GET /api/health`

Returns service and runtime status.

Response:

```json
{
  "ok": true,
  "host": "container-hostname",
  "projectHost": "dokploy",
  "dataDir": "/path/to/data",
  "version": "0.8.0-real-loop-supervisor-batch-self-improving",
  "agentRunsEnabled": true,
  "agentRunsAuth": true,
  "loopTickMs": 5000
}
```

### 8.2 `GET /api/projects`

Returns tracked projects.

### 8.3 `POST /api/projects`

Adds or replaces a project record.

Request:

```json
{
  "host": "optional; defaults to server project host",
  "repoPath": "/absolute/path/to/repo",
  "name": "optional display name"
}
```

Response: the saved project item.

### 8.4 `GET /api/project?host=...&repoPath=...`

Scans a project and returns:

- project identity
- missing/canCreate status if path does not exist
- git status if path exists
- normalized loop state
- stage cards for UI

Response shape:

```json
{
  "key": "host:/repo",
  "host": "host",
  "repoPath": "/repo",
  "missing": false,
  "git": {
    "head": "abc1234",
    "branch": "main",
    "dirtyFiles": 2,
    "recentCommits": []
  },
  "loop": {},
  "stages": []
}
```

### 8.5 `POST /api/project/create`

Creates a missing repo in a safe location and returns the same shape as `/api/project`.

Request:

```json
{
  "host": "host",
  "repoPath": "/safe/absolute/path",
  "name": "Display Name"
}
```

### 8.6 `POST /api/config`

Updates project loop configuration.

Request fields:

```json
{
  "host": "host",
  "repoPath": "/repo",
  "intent": "durable request",
  "model": "gpt-5.5",
  "agentId": "optional OpenClaw agent id",
  "overseerPrompt": "optional override",
  "supervisorPrompt": "optional override",
  "variantCount": 3,
  "notifications": {
    "target": "telegram:-5146898162",
    "every": 5
  }
}
```

Response: updated loop state.

Notes:

- The frontend currently sends `overseerPrompt` and `supervisorPrompt`, but the visible form does not render prompt fields. Missing form values are ignored because server config falls back to current prompt values.
- Setting a new supervisor prompt records a `manual-config` prompt history entry.

### 8.7 `POST /api/autopilot`

Enables or disables the background real agent loop.

Start request:

```http
POST /api/autopilot
x-agent-token: <OPENCLAW_AGENT_TOKEN>
content-type: application/json
```

```json
{
  "host": "host",
  "repoPath": "/repo",
  "enabled": true,
  "runNow": true,
  "intervalSeconds": 300,
  "notificationTarget": "telegram:-5146898162",
  "notifyEvery": 5
}
```

Stop request:

```json
{
  "host": "host",
  "repoPath": "/repo",
  "enabled": false
}
```

Response: updated loop state.

Important behavior:

- Server forces `mode: "agent"`; simulated mode from old clients is ignored.
- Enabling requires the launch token.
- Disabling does not kill already-running agent processes; it prevents future launches.

### 8.8 `GET /api/agent/log?id=...`

Returns the raw text log file for a run id.

Run id is sanitized to alphanumeric/hyphen characters before file lookup.

### 8.9 `POST /api/client-log`

Receives frontend telemetry/error logs and writes them to server stdout as structured logs.

### 8.10 `GET /api/files?host=...&repoPath=...&dir=...`

Lists repository directory entries, excluding `.git` and `node_modules`.

### 8.11 `GET /api/file?host=...&repoPath=...&file=...`

Returns a text preview of a file under the repo root.

Limits:

- Rejects directories.
- Rejects files over `512 KiB`.
- Rejects path traversal outside the repo.

## 9. Core flows

### 9.1 App startup

1. Server resolves and seeds `DATA_DIR`.
2. Server starts HTTP listener on `PORT`.
3. Server schedules `tickAutopilots()`:
   - first tick after 1 second
   - repeated every `LOOP_TICK_MS`
4. Browser loads `/`.
5. `app.js` calls `/api/health` and `/api/projects`.
6. Browser selects saved project from `localStorage`, or first project.
7. Browser calls `/api/project` and renders dashboard.

### 9.2 Add project

1. User enters name and absolute repo path.
2. Frontend posts to `/api/projects`.
3. Server validates path, builds key, replaces existing project with same key if present.
4. Frontend reloads project list and selects the new project.
5. If the path is missing, the UI offers safe repo creation when allowed.

### 9.3 Configure request

1. User edits request/intent, model, agent id, loop interval, notification target, and summary cadence.
2. Frontend posts intent/model/agentId/notifications to `/api/config`.
3. Server writes updated loop state:
   - status `ready`
   - stage `request`
   - history event `configured`
4. Frontend refreshes `/api/project`.

Note: model is currently stored and displayed, but `startAgentRun()` does not pass model to the `openclaw agent` CLI. Agent id, thinking, and timeout are used.

### 9.4 Start loop

1. User clicks Start loop.
2. Frontend prompts for OpenClaw agent launch token if missing from `localStorage`.
3. Frontend first saves current config via `/api/config`.
4. Frontend posts `/api/autopilot` with token, `enabled: true`, `runNow: true`, interval, and notification settings.
5. Server verifies launch feature and token.
6. Server normalizes notification settings.
7. Server sets:
   - `autopilot.enabled = true`
   - `autopilot.mode = "agent"`
   - `autopilot.nextRunAt = now()` when `runNow` is true
   - status `autopilot agent loop enabled`
8. Scheduler picks it up on the next tick.

### 9.5 Scheduler tick

For each tracked project:

1. Validate project path.
2. Skip if another tick for the same key is already active.
3. Load loop state and normalize autopilot settings.
4. Return if autopilot is disabled.
5. Return if `nextRunAt` is in the future.
6. If any agent run is still running:
   - push `nextRunAt` out by up to 60 seconds
   - avoid launching a new batch
7. If intent is empty:
   - record `autopilot error`
   - set `lastError`
   - schedule next attempt
8. Otherwise:
   - set `lastTickAt = now`
   - set `nextRunAt = now + intervalSeconds`
   - start a supervisor batch for the current intent.

### 9.6 Supervisor batch launch

1. `startSupervisorBatch()` creates variants with `makeVariants()`.
2. Default strategies:
   - A: Direct one-shot supervisor
   - B: Planner/integrator supervisor
   - C: Evaluation-first supervisor
3. Each variant has the same default sub-agent role prompts:
   - Acceptance criteria analyst
   - Builder / implementer
   - Reviewer / gap finder
4. For each variant, call `startAgentRun()` with:
   - same user intent
   - shared batch id
   - variant-specific supervisor prompt
   - session id `<base>-<batchId>-<variantId>`
5. Append history event `supervisor-batch-started`.
6. Status becomes `supervisor batch running` / `agent running`.

### 9.7 Real OpenClaw agent run launch

1. Server validates repo exists.
2. Server resolves message from request body or loop intent.
3. Server resolves agent id, thinking, timeout, session id, and supervisor prompt.
4. Server constructs a full prompt containing:
   - Control Tower launch identity
   - Project repo path
   - Supervisor variant metadata
   - User request/intent
   - Supervisor prompt
   - Instructions to operate as supervisor, spawn sub-agents when helpful, integrate results, and suggest prompt improvements
   - Requirement to return sections:
     - Files changed
     - Validation
     - Blockers
     - Next
     - Supervisor prompt improvements
     - Sub-agent prompt improvements
5. Server spawns:

```text
openclaw agent [--agent <agentId>] --session-id <sessionId> --message <prompt> --thinking <thinking> --timeout <timeout> --json
```

6. Stdout/stderr are appended to `data/agent-runs/<id>.log`.
7. On start, optional notification is sent.
8. Run record is inserted at the front of `agentRuns`.

### 9.8 Agent completion and real-run learning

When the spawned OpenClaw process exits:

1. Server parses combined stdout/stderr as JSON when possible.
2. Server extracts final reply text from known OpenClaw JSON fields, falling back to raw output.
3. Server updates run record:
   - `status: succeeded` if exit code 0, else `failed`
   - `rc`, `completedAt`, output/error/warnings/rawJson
4. `applyRealRunLearning()` extracts evidence from final report:
   - bullets after `Files changed`
   - bullets after `Validation`
   - first line after `Next`
   - first line after `Blockers`
   - validation pass signal using regex (`passed`, `passing`, `0 fail`, etc.)
   - blocker/no-blocker signal
   - changed/no-changed signal
5. Score is calculated:
   - failed run: `25`
   - successful run base: `50`
   - +25 if validation appears passed
   - +10 if no blockers
   - +10 if files changed
   - +5 if next recommendation exists
   - capped at `100`
6. Metrics are updated:
   - correctness = score
   - cost = 70
   - requests = 85
   - duration = 75
7. Append evaluation, learning, and possible prompt revisions.
8. Stage becomes `improve` and cycle increments.
9. Optional finish/every-N notifications are sent.

### 9.9 Supervisor batch learning

After each run completion, `applySupervisorBatchLearning()` checks whether all runs in the same batch are no longer running.

When a batch is complete:

1. Score each run again using `realRunFacts()`.
2. Pick best run by score.
3. Append a `supervisor-batch` evaluation containing each variant score and evidence flags.
4. Extract bullets from the best output under:
   - `Supervisor prompt improvements`
   - `Sub-agent prompt improvements`
5. Append missing supervisor improvement bullets to `loop.supervisorPrompt` as learned rules.
6. If no supervisor bullets exist and validation was unclear, append a default validation-evidence rule.
7. Add prompt revision and supervisor prompt history if the prompt changed.
8. Add sub-agent prompt improvements/history.
9. Append learning and history event `supervisor-batch-evaluated`.
10. Stage becomes `improve` and cycle increments.

### 9.10 Stop loop

1. User clicks Stop loop.
2. Frontend posts `/api/autopilot` with `enabled: false`.
3. Server disables scheduler for that project and clears `nextRunAt`.
4. Existing child processes are not killed by this operation.

### 9.11 Notifications

Notifications are sent by executing:

```text
openclaw message send --channel <channel> --target <target> --message <text>
```

Notification types:

- Start notification when a run launches.
- Finish notification when a run completes.
- Every-N summary based on completed run count.

Notification text includes project title, run id, repo path or score, validation status, first summary line, and next recommendation when available.

## 10. Scoring and evaluation details

### 10.1 Real-run facts

`realRunFacts(reply, rc)` derives:

- `files`: bullets under `Files changed`
- `validation`: bullets under `Validation`
- `next`: first non-empty line under `Next`
- `blockers`: first non-empty line under `Blockers`
- `validationPassed`: regex-based boolean
- `noBlockers`: true if blockers missing or text indicates none/no blockers
- `changed`: true if files list is non-empty and not `None`
- `score`: numeric quality score
- `text`: truncated final report
- `lower`: lowercase final report for rule checks

### 10.2 Weighted simulated evaluation

The code still contains a manual/simulated step path:

- `stepLoop()`
- `evaluateVariants()`
- `revisePrompt()`

This path scores generated variants using prompt length, intent length, sub-agent counts, estimated usage, and weights. It is currently not exposed by an API route or frontend control. It appears to be legacy scaffolding from an earlier dashboard mode, but it documents the conceptual stage flow.

## 11. Frontend screens and interactions

### 11.1 Layout

- Sticky header with app title, refresh button, and health/version pill.
- Left sidebar project list and add-project form.
- Main dashboard with selected project content.

### 11.2 Tabs

- `loop`: main control panel.
- `history`: JSON history audit trail.
- `files`: repo browser and file preview.

### 11.3 Loop tab sections

- Metrics:
  - loop status
  - active agent yes/no
  - model
  - interval
- Loop control form:
  - request/intent
  - model
  - OpenClaw agent id
  - loop interval seconds
  - Telegram notify target
  - summary every N runs
- Status:
  - autopilot enabled/stopped
  - last/next run timestamps
  - last error
  - notification target/cadence
- Learnings/self-improvement:
  - latest learning claims
  - latest prompt revisions
- Latest evaluation:
  - score
  - best supervisor
  - metric breakdown
  - gaps
- Real OpenClaw runs:
  - run status/id
  - message
  - agent/session/timestamps
  - output/error
- Repo status:
  - branch, head, dirty file count, recent commits

### 11.4 Browser telemetry

The frontend logs:

- init start/complete/errors
- API request start/finish/error
- tab/project selection
- config save start/complete
- window errors and unhandled promise rejections

The logs are best-effort and sent through `sendBeacon` when available.

## 12. Git and filesystem behavior

### 12.1 Git status

For existing repos, server runs:

- `git rev-parse --short HEAD`
- `git branch --show-current`
- `git status --porcelain`
- `git log --oneline -6`

All git commands use `-c safe.directory=*`.

### 12.2 Repo scaffold

Creating a repo writes:

- `README.md`
- `src/`
- `.gitignore` with `node_modules/`, `.env`, `.DS_Store`

Then runs:

- `git init`
- `git add README.md .gitignore`
- `git commit -m "Initial project scaffold"`

## 13. Docker/deployment

The Dockerfile uses:

- `node:24-alpine`
- installs `git`, `python3`, `bash`
- installs `openclaw@2026.4.24` globally
- workdir `/app`
- copies package, server, public assets, data, and `.autopilot`
- sets:
  - `NODE_ENV=production`
  - `PORT=8787`
  - `OPENCLAW_HOME=/openclaw`
- exposes `8787`
- runs `npm start`

A deployment must mount or provide an OpenClaw home/config at `/openclaw` or set `OPENCLAW_HOME` appropriately, plus set agent launch env vars before allowing starts.

## 14. Tests

`npm test` runs Node's built-in test runner against `tests/server.test.js`.

Covered behavior:

1. Health and projects endpoints respond.
2. Missing projects can be safely created from the API.
3. Background loop launches and evaluates a default three-supervisor batch using a fake OpenClaw binary.

The fake binary emits structured final-report sections so scoring, best-variant comparison, supervisor prompt history, sub-agent prompt history, and prompt learning can be verified.

## 15. Known implementation notes and gaps

- The UI presents the loop as real-only. The server still contains unexposed manual/simulated loop-step functions.
- The README's API sketch is accurate for current public endpoints, but there is no exposed endpoint for `stepLoop()`.
- The stored `model` field is displayed and persisted but is not currently passed to the `openclaw agent` command.
- Stopping the loop does not terminate child OpenClaw processes that are already running.
- Notification sending uses a CLI subprocess and does not require the browser token.
- Default notification target is hard-coded to `telegram:-5146898162` when env vars do not override it.
- The app's durable learning stays inside `loop-state.json`; `.autopilot/program.md` also asks agents to append durable lessons to `/home/node/.openclaw/workspace/LEARNINGS.md`, but the server does not enforce that.
- Path checks use `startsWith(repo)`; for strict hardening, future work should ensure `repo` has a trailing separator when checking child paths to avoid prefix collisions.
- There is no authentication for read-only dashboard/API access; only agent launches are token-gated.

## 16. Requirements to recreate the application

### 16.1 Backend requirements

- Node 20+ ESM project.
- HTTP server serving static files and JSON/text API routes.
- Writable data directory with atomic JSON writes.
- Project registry keyed by host + absolute repo path.
- Per-project loop state defaults and normalization.
- Safe filesystem validation for repo browsing and creation.
- Git status helpers.
- OpenClaw process launcher with stdout/stderr logging.
- Token-gated start/enable path.
- Periodic scheduler for due loops.
- Run output parser for OpenClaw JSON and raw text fallback.
- Final-report evidence extraction from named sections.
- Score/evaluation/learning/prompt-revision persistence.
- Optional notification subprocess.
- Structured scrubbed logging.

### 16.2 Frontend requirements

- Plain browser app or equivalent SPA.
- Project list and add-project form.
- Project dashboard with loop, history, and files tabs.
- Config form for intent/model/agent id/interval/notifications.
- Start/stop controls.
- Token prompt/storage for starts.
- Rendering for status, learnings, latest evaluation, real runs, git status.
- File browser/preview.
- Client telemetry to backend.
- Responsive dark UI.

### 16.3 Data requirements

To run correctly, the app needs:

- `projects.json` with at least one project or discoverable default paths.
- Per-project loop-state records, or ability to create defaults.
- OpenClaw CLI availability when real runs are enabled.
- OpenClaw token and config/home for actual agent launches.
- Optional notification channel/target config.

### 16.4 Agent final report contract

For best scoring and learning, OpenClaw agent final replies should include these exact sections:

```text
Files changed
- ...
Validation
- ...
Blockers
- ...
Next
- ...
Supervisor prompt improvements
- ...
Sub-agent prompt improvements
- ...
```

The scoring and learning system depends heavily on those headings and bullet lists.
