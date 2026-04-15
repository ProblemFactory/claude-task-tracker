# claude-task-tracker

Passive task tracking plugin for Claude Code. Observes conversations via hooks, uses AI (Agent SDK) to infer task lifecycle, stores in SQLite, serves a web dashboard.

## Project Structure

```
plugin/                          # Plugin source (Claude Code installs from here)
├── .claude-plugin/plugin.json   # Plugin metadata (name, version, author)
├── hooks/hooks.json             # Hook definitions (SessionStart, UserPromptSubmit, Stop)
├── src/
│   ├── worker.mjs               # Persistent HTTP server (port from config, default 37778)
│   ├── hook.mjs                 # Thin hook handler: reads stdin JSON, POSTs to worker
│   ├── config.mjs               # Config: file (~/.claude/task-tracker/config.json) + env vars
│   ├── store.mjs                # SQLite via node:sqlite (DatabaseSync, WAL mode)
│   ├── ai.mjs                   # Transcript JSONL reader + message summarizer
│   └── dashboard.html           # Single-page dark-theme dashboard with settings modal
├── bin/cli.mjs                  # CLI: status/start/stop/dashboard
└── package.json
.claude-plugin/marketplace.json  # Marketplace definition for `claude plugins` system
```

## Runtime Data

All at `~/.claude/task-tracker/`:
- `tasks.db` — SQLite database (tasks, session_links, analysis_state tables)
- `config.json` — User config overrides
- `TASKS.md` — Auto-generated markdown view
- `worker.pid` — PID file for lifecycle management
- `debug.log` — Worker + hook logs
- `observer-sessions/` — Temp SDK session dir (auto-cleaned after each analysis)

## Key Architecture Decisions

- **Hooks, not MCP** — Must be passive observation. MCP tools require the main Claude to actively call them, which it will forget to do. Hooks fire automatically on every event.
- **Worker service pattern** — Hook is a short-lived process (stdin→POST→exit). Worker is a persistent background process that queues analysis jobs, runs AI, and serves the dashboard.
- **Agent SDK for AI calls** — Uses `@anthropic-ai/claude-agent-sdk` query() function (same auth as Claude Code, ToS-compliant). SDK found by scanning global node_modules. Fallback via createRequire() for CJS packages.
- **Incremental transcript analysis** — Tracks byte offset per session. Only reads new JSONL lines since last analysis. Avoids re-processing.
- **Observer session isolation** — SDK query() gets `cwd: observer-sessions/` to prevent polluting user's project directories with session files.
- **SQLite over JSON** — Switched from data.json to node:sqlite (Node >= 22) for indexed queries and no full-file rewrite on every operation. Auto-migrates from data.json on first run.
- **Subtask hierarchy** — Tasks have `parentId` field. AI prompt instructs to break large tasks into subtasks. Parent auto-completes when all subtasks are done. Max 2 levels deep.
- **Global tasks** — Tasks are NOT tied to folders. AI matches work to existing tasks by semantic similarity across sessions and projects.

## Development Notes

- Hook commands use `${CLAUDE_PLUGIN_ROOT}` env var for portable paths
- Dashboard served as static HTML from `src/dashboard.html`, loaded via `import.meta.url`
- Config priority: env vars (`TASK_TRACKER_*`) > config.json > defaults
- Worker binds to `0.0.0.0` by default (LAN accessible). Change `host` config for local-only.
- Analysis skipped if conversation delta < `minDeltaChars` (default 2000) to avoid noise
- All AI disallowed tools: Bash, Read, Write, Edit, Grep, Glob, WebFetch, WebSearch, TodoWrite, NotebookEdit, Agent

## Distribution

Published as Claude Code plugin:
```bash
claude plugins marketplace add ProblemFactory/claude-task-tracker
claude plugins install claude-task-tracker@ProblemFactory
```

Update:
```bash
claude plugins marketplace update ProblemFactory
claude plugins update claude-task-tracker@ProblemFactory
```

GitHub: https://github.com/ProblemFactory/claude-task-tracker

## Common Tasks

- **Test changes locally**: Kill worker (`curl -X POST localhost:37778/shutdown`), run `node plugin/src/worker.mjs`, check dashboard
- **Check logs**: `tail -f ~/.claude/task-tracker/debug.log`
- **Inspect DB**: `sqlite3 ~/.claude/task-tracker/tasks.db ".tables"` / `.schema` / `SELECT * FROM tasks;`
- **Bump version**: Update in both `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
