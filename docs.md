# Architecture Notes

## Identity

Every API request that targets a project passes:

```json
{ "host": "233b25d7bf4b", "repoPath": "/absolute/path/to/repo" }
```

This gives each project a stable key while allowing shared learning across projects.

## Visible loop

The UI intentionally keeps one simple loop:

```text
PLAN → ASSIGN → BUILD → REVIEW → INTEGRATE → LEARN
```

Complex behavior such as model council, retries, conflict repair, usage throttling, notification policy, and prompt self-improvement should render as details inside these six stages.

## Learning scopes

Future learning records should support scopes:

- global
- host
- project
- model
- prompt pattern
- task category
- task size
- workflow stage

Measured outcomes should outweigh model self-claims.
