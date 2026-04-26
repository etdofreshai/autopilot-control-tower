# Autopilot Control Tower

A local-first web control tower for OpenClaw autopilot repos.

It monitors projects by **host + absolute directory path**, summarizes waves/runs/logs, exposes pause/stop/resume controls, previews repo files, and stores shared learnings for better model assignment, prompt design, task sizing, and workflow efficiency.

## Run locally

```bash
npm start
# open http://localhost:8787
```

Default seed projects are ET's two tmp autopilot repos if they exist.

## Project key

```json
{ "host": "<hostname>", "repoPath": "/absolute/path/to/repo" }
```
