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
│   ├── store.mjs                # SQLite via node:sqlite (DatabaseSync, WAL mode) + chroma sync hooks
│   ├── ai.mjs                   # Transcript JSONL reader + message summarizer
│   ├── chroma.mjs               # Minimal MCP stdio client for chroma-mcp subprocess (embeddings)
│   ├── search.mjs               # BM25 ranker (fallback when chroma unavailable)
│   ├── tools.mjs                # In-process MCP tools (search/get/tree/list) exposed to AI
│   └── dashboard.html           # Single-page dark-theme dashboard with settings modal
├── bin/cli.mjs                  # CLI: status/start/stop/dashboard
└── package.json
.claude-plugin/marketplace.json  # Marketplace definition for `claude plugins` system
```

## Runtime Data

All at `~/.claude/task-tracker/`:
- `tasks.db` — SQLite database (tasks, session_links, analysis_state tables)
- `chroma/` — Local vector DB managed by `uvx chroma-mcp` subprocess
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
- **Observer session isolation** — SDK query() gets `cwd: observer-sessions/` to prevent polluting user's project directories with session files. Cleanup is recursive (handles `subagents/` subdirs).
- **Self-loop prevention** — Three-layer defense against infinite hook→worker→SDK→hook loops: (1) SDK sessions have all tools disallowed, (2) SDK runs in isolated cwd, (3) hook checks `input.cwd.startsWith(observerCwd)` using the exact path from worker `/health`. No substring matching — avoids false positives on user projects.
- **SQLite over JSON** — Switched from data.json to node:sqlite (Node >= 22) for indexed queries and no full-file rewrite on every operation. Auto-migrates from data.json on first run.
- **Subtask hierarchy** — Tasks have `parentId` field. AI prompt instructs to break large tasks into subtasks. Dashboard renders recursively — arbitrary depth supported (v1.7.0+). Parent completion is AI-decided, not auto-inferred (v1.7.1+), to avoid prematurely closing long-term container tasks.
- **Global tasks** — Tasks are NOT tied to folders. AI matches work to existing tasks by semantic similarity across sessions and projects. Context field stores rich descriptions to improve matching.
- **5-level origin tracking** — Distinguishes user_initiated, user_confirmed, user_implicit, agent_pending, agent_ignored. `origin_reason` is append-only — each transition appends a dated line (`[date] old → new: evidence`), preserving full classification history. `origin` field reflects current state; click the badge in dashboard to see the full history popover.
- **Rich task metadata** — category (bugfix/feature/refactor/research/devops/review/docs/support), context (why task exists, what's involved, key files, decisions), context_append on updates for evolving history. Metadata corrections: AI can update title/tags/category/priority via updates when conversation reveals stale values (v1.6.3+).
- **Datetime prompt injection** — Every AI prompt includes `Current date and time: YYYY-MM-DD HH:MM:SS UTC` to prevent AI from hallucinating dates from training data. Note prefixes use full timestamp `[YYYY-MM-DD HH:MM]`.
- **Auto-restart on update** — Hook reads plugin.json version, compares with worker /health version. Mismatch triggers automatic shutdown + respawn. Users never need manual restarts after `claude plugins update`.
- **Reparenting** — AI can move existing tasks under a new parent when it discovers they're part of a larger goal. Uses `parent_id: "NEW:Parent Title"` in updates, resolved after new tasks are created.
- **Dashboard filters** — Six independent filters: Project (from session cwd), Status, Tag (from task.tags), Priority, Origin, Category. All AND-combined. Status pill counts reflect other active filters. Project filter propagates through task family (parent matches if any descendant matches).
- **Expand state preserved across refresh** — Dashboard auto-refreshes every 15s, but task card expansions, subtask expansions, and notes toggles are preserved using `data-task-id` attributes.
- **Semantic retrieval pipeline** (v1.8.x) — Analysis prompt no longer dumps all open tasks. Pipeline:
  1. **HyDE** — conversation summary goes through Haiku which extracts 3-5 task-themed noun phrases
  2. **Chroma query** — phrases embedded by chromadb's default `all-MiniLM-L6-v2` (via `uvx chroma-mcp` Python subprocess, fully local, no API)
  3. **Candidate merge** — top-K semantic hits ∪ project-local tasks ∪ active in-progress top-level tasks ∪ family tree expansion
  4. **AI tools (optional)** — in-process MCP server exposes `search_tasks` / `get_task` / `get_task_tree` / `list_tasks` so Sonnet can dig deeper when candidate list is insufficient
  Fallback: if `uvx` is missing, BM25 ranker (`search.mjs`) is available but worker currently keeps candidate set without chroma; tools still expose hybrid search. Auto-backfill existing tasks on worker startup. `createTask`/`updateTask` fire-and-forget re-index when indexed fields change.

## Development Notes

- Hook commands use `${CLAUDE_PLUGIN_ROOT}` env var for portable paths
- Dashboard served as static HTML from `src/dashboard.html`, loaded via `import.meta.url`
- Config priority: env vars (`TASK_TRACKER_*`) > config.json > defaults
- Worker binds to `0.0.0.0` by default (LAN accessible). Change `host` config for local-only.
- Analysis skipped if conversation delta < `minDeltaChars` (default 2000) to avoid noise
- All AI disallowed tools: Bash, Read, Write, Edit, Grep, Glob, WebFetch, WebSearch, TodoWrite, NotebookEdit, Agent
- `language` config: 'auto' (match user's language) or explicit (e.g. 'Chinese')
- Version bump required for every release: both `plugin/.claude-plugin/plugin.json` AND `.claude-plugin/marketplace.json`
- Schema migrations in `migrateSchema()` run on every startup, adding new columns with defaults for existing DBs
- **Optional deps**: `uvx` (from `uv`) enables chroma-mcp for embeddings. `zod` (sibling to SDK in node_modules) enables MCP tools. Both degrade gracefully if missing.
- When `mcpServers` is passed to SDK `query()`, `maxTurns` auto-bumps to ≥5 so AI has room to iterate on tool calls
- HyDE uses `haiku` model (hardcoded), analysis uses `cfg.model` (default `sonnet`). Haiku is cheap enough that every analysis runs HyDE.

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
