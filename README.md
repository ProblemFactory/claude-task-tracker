# claude-task-tracker

Passive task tracking for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Observes your conversations via hooks, uses AI to infer task creation/progress/completion, and maintains a global task database with a web dashboard.

**No manual input needed** — tasks are created and updated automatically as you work.

## How it works

```
Claude Code session
  ├── SessionStart hook → injects active tasks as context
  ├── UserPromptSubmit hook → sends transcript to worker for analysis
  └── Stop hook → final analysis of completed session

Worker (persistent background process)
  ├── Reads conversation transcript (JSONL)
  ├── Summarizes new messages since last analysis
  ├── Sends to Claude (via Agent SDK) for task inference
  ├── Updates global task database
  └── Serves web dashboard
```

Tasks are **global** — not tied to a specific folder or session. The AI recognizes when different sessions work on the same feature and links them together.

## Installation

### Prerequisites

- Node.js >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- The `@anthropic-ai/claude-agent-sdk` must be available (automatically found if any globally-installed package depends on it)

### Install

```bash
# Clone the repo
git clone https://github.com/ProblemFactory/claude-task-tracker.git
cd claude-task-tracker

# Install hooks into Claude Code
node bin/cli.mjs install
```

That's it. The worker starts automatically on your next Claude Code session.

### Verify

```bash
node bin/cli.mjs status
```

### Uninstall

```bash
node bin/cli.mjs uninstall
node bin/cli.mjs stop
```

## Usage

Once installed, the tracker runs silently in the background. Open the dashboard to see your tasks:

```bash
node bin/cli.mjs dashboard
# or visit http://localhost:37778
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `install` | Install hooks into `~/.claude/settings.json` |
| `uninstall` | Remove hooks |
| `status` | Show worker status, hook status, task counts |
| `start` | Start the worker manually |
| `stop` | Stop the worker |
| `dashboard` | Open the dashboard in your browser |

### Dashboard Features

- Task list grouped by status (In Progress, Open, Blocked, Done)
- Filter by status, priority, project/tag
- Full-text search across task titles and notes
- Activity stream showing recent task changes
- Settings panel for configuring the tracker

## Configuration

Settings are stored in `~/.claude/task-tracker/config.json`. You can edit this file directly, use environment variables, or configure via the dashboard settings panel.

### Config file

```json
{
  "port": 37778,
  "host": "0.0.0.0",
  "model": "sonnet",
  "analysisTimeout": 25000,
  "minDeltaChars": 2000,
  "autoRefreshInterval": 15000
}
```

### Environment variables

Every config key can be overridden with a `TASK_TRACKER_` prefix:

```bash
TASK_TRACKER_PORT=8080
TASK_TRACKER_MODEL=haiku
TASK_TRACKER_HOST=127.0.0.1
```

### All options

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `37778` | Worker HTTP port |
| `host` | `0.0.0.0` | Bind address (`0.0.0.0` for LAN, `127.0.0.1` for local) |
| `model` | `sonnet` | Claude model for analysis |
| `analysisTimeout` | `25000` | Max wait for AI response (ms) |
| `maxTurns` | `1` | Max conversation turns for analysis |
| `minDeltaChars` | `2000` | Skip analysis if conversation delta is shorter |
| `minSummaryChars` | `100` | Skip if summarized text is too short |
| `maxPromptChars` | `12000` | Truncate conversation in AI prompt |
| `maxSummaryChars` | `15000` | Max chars for message summarization |
| `recentLinksLimit` | `50` | Session links returned by API |
| `recentSessionsLimit` | `10` | Sessions shown in TASKS.md |
| `recentCompletedLimit` | `20` | Completed tasks shown in TASKS.md |
| `autoRefreshInterval` | `15000` | Dashboard auto-refresh interval (ms) |

## Architecture

```
~/.claude/task-tracker/
├── config.json         # User configuration
├── data.json           # Task database
├── TASKS.md            # Auto-generated markdown view
├── worker.pid          # PID file for worker lifecycle
├── debug.log           # Debug log
└── observer-sessions/  # Temp dir for SDK sessions (auto-cleaned)
```

### Data model

- **Tasks**: `{ id, title, status, priority, notes, tags, createdAt, updatedAt, completedAt }`
- **Session Links**: Track which sessions created/progressed/completed which tasks
- **Analysis State**: Per-session byte offset for incremental transcript reading

### How analysis works

1. Hook sends `transcript_path` to worker on each user message
2. Worker reads new JSONL lines since last analysis (byte offset tracking)
3. Messages are summarized (user/assistant text, tool names, brief results)
4. Summary + current open tasks are sent to Claude for inference
5. AI returns JSON with task updates and new tasks
6. Results are applied to the database and TASKS.md is regenerated

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard HTML |
| `/health` | GET | Worker health check |
| `/api/tasks` | GET | List tasks (query: `?tag=`, `?status=`, `?project=`) |
| `/api/context` | GET | Active tasks for session injection |
| `/api/analyze` | POST | Submit transcript for analysis |
| `/api/config` | GET | Current configuration |
| `/api/config` | POST | Update configuration |
| `/shutdown` | POST | Stop the worker |

## License

MIT
