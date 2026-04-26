# Autopilot Control Tower

An experimental, local-first research lab for improving Autopilot's three-level hierarchy: **overseer → supervisors → sub-agents**.

The goal is not generic project management. The goal is to make Autopilot better at taking a user request and completing it correctly in **one shot** whenever possible.

```text
user request + overseer prompt + supervisor model/prompt
  → static overseer receives the request
  → overseer spawns Supervisor A/B/C variants
  → each supervisor spawns and guides its own sub-agent team
  → sub-agents perform assigned task slices
  → hierarchy is scored on correctness, cost/tokens, request count, and duration
  → supervisor prompt and sub-agent guidance rules are revised
  → repeat with feedback or new requests
```

## Key idea

Parallelism is allowed again, but only as **evaluation/research parallelism**:

- not "throw many agents at production work"
- yes "try multiple supervisor/sub-agent strategies and compare which gets closest to the user's intent"

The experiment has three roles:

1. **Overseer** — simple/static; only spawns supervisor variants and compares outcomes.
2. **Supervisors** — competing strategies for satisfying the same user request.
3. **Sub-agents** — do the task slices each supervisor assigns.

The experiment asks two main questions:

1. What supervisor prompt produces the best one-shot result?
2. What guidance helps that supervisor spawn/manage better sub-agents?

The top-level lab can spawn Supervisor A/B/C variants. Each supervisor owns a candidate prompt strategy, delegates to its own sub-agent team, integrates their work, evaluates the result, and teaches the next prompt revision.

## Current inputs

Each project has:

- **User request / intent** — what Autopilot should complete in one shot
- **Overseer prompt** — intentionally simple/static spawning policy
- **Supervisor model** — the model used by supervisor variants
- **Supervisor system prompt** — the prompt being improved
- **A/B variant count** — how many supervisor strategies to compare

## Evaluation metrics

Weighted overall score defaults to:

- **Correctness** — 70%; highest priority
- **Cost / token efficiency** — 10%
- **Request count** — 10%
- **Duration** — 10%

Correctness should dominate. If correctness is close, cheaper/faster/fewer-request hierarchies win.

Loop state is stored locally in `data/loop-state.json` and ignored by git.

## Run locally

```bash
npm start
# open http://localhost:8787
```

## API sketch

- `GET /api/projects` — list tracked local projects
- `POST /api/projects` — add a local project by absolute path
- `GET /api/project?host=...&repoPath=...` — get git + supervisor lab state
- `POST /api/config` — set intent, model, overseer prompt, supervisor prompt, and variant count
- `POST /api/step` — advance one hierarchy-learning step
- `GET /api/files` / `GET /api/file` — lightweight repo browser

This is still a prototype. The simulated loop remains available, and the dashboard can now launch real OpenClaw agent runs when explicitly enabled.

## Real OpenClaw agent bridge

Set these on the server/container before allowing dashboard launches:

- `OPENCLAW_AGENT_RUNS=1`
- `OPENCLAW_AGENT_TOKEN=<private launch token>` — required; sent by the browser as `x-agent-token`
- `OPENCLAW_HOME=/openclaw` — defaults this way in Docker so the OpenClaw CLI can use the mounted OpenClaw volume/config
- optional: `OPENCLAW_BIN`, `OPENCLAW_AGENT_ID`, `OPENCLAW_AGENT_THINKING`, `OPENCLAW_AGENT_TIMEOUT`

The public start endpoint is intentionally disabled unless both `OPENCLAW_AGENT_RUNS=1` and `OPENCLAW_AGENT_TOKEN` are set.
