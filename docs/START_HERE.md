# Start here: current project documentation

Scope: the `saint-elms-fire-app` pnpm monorepo, repository state through PR #130 (2026-10-18).
These documents describe the checked-in code; deployed revisions and live health are separate —
the configured hosted entry points are listed in [HANDOVER.md](../HANDOVER.md) §12, and a URL in
that table is not a health report.

| Doc | Covers |
| --- | --- |
| [../README.md](../README.md) | Product pitch, architecture, local quickstart |
| [../HANDOVER.md](../HANDOVER.md) | Runbook: setup, demo accounts, demo script, auth/offline, data and backup, troubleshooting, hosted entry points |
| [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md) | Short demo walkthrough, local or hosted |
| [agentic-layer.md](agentic-layer.md) | Teachers, tools, chat-turn harness, source attribution, model plumbing |
| [knowledge-graph.md](knowledge-graph.md) | Course sky, second brain, Brain view, mastery, the proposal pipeline |
| [hosted-seat.md](hosted-seat.md) | Engine on a public URL: env, gates, sessions, served UI |
| [session-orchestrator.md](session-orchestrator.md) | Hosted workspace lifecycle: leases, pinned demos, teardown |
| [model-gateway.md](model-gateway.md) | The authenticated model proxy for hosted engines |
| [object-store.md](object-store.md) | The S3-compatible vault store and sync |
| [deploy-render.md](deploy-render.md) | Uni/gateway/search/store deployment configuration |
| [deploy-vercel.md](deploy-vercel.md) | The separate web-app build, portal hand-off, self-serve demo |
| [../AGENTS.md](../AGENTS.md) | Contributor invariants, commands, Git workflow |

The documents linked here are tracked. `docs/internal/` is gitignored and is not part of this index.
[CLOUD_SEAT_NOTES.md](CLOUD_SEAT_NOTES.md) is historical engineering context: dated observations,
machine ids and ops-scratchpad references there may be obsolete and are not deploy instructions —
no scripts from those notes are supplied by the tracked docs.
