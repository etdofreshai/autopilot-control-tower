# Autopilot Control Tower Program

Mission: make overnight agent work observable, controllable, and self-improving.

Visible loop: PLAN → ASSIGN → BUILD → REVIEW → INTEGRATE → LEARN.

Design rules:
- Host + absolute directory path is the project key.
- Keep the frontend loop simple even when internals become smarter.
- Prefer larger story-sized work with acceptance checks over tiny commits.
- Learn from outcomes: prompts, model fit, task size, workflow, repo constraints, and notification policy.
- Separate claims from evidence.
