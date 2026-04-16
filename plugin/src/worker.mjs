#!/usr/bin/env node
import http from 'http';
import { readFileSync, writeFileSync, existsSync, unlinkSync, rmdirSync, mkdirSync, appendFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  getAllTasks, getTaskById, getSubtasks, createTask, updateTask, taskExistsByTitle,
  addSessionLink, getRecentLinks, getAnalysisState, setAnalysisState,
  queryTasks, renderMarkdown, DIR
} from './store.mjs';
import { readTranscriptDelta, summarizeMessages } from './ai.mjs';
import { loadConfig, saveConfig, getDefaults } from './config.mjs';

const config = loadConfig();
const PORT = config.port;
const PID_FILE = join(DIR, 'worker.pid');
const LOG = join(DIR, 'debug.log');

// Read version at startup
let WORKER_VERSION = 'unknown';
try {
  const pluginJson = JSON.parse(readFileSync(join(new URL('..', import.meta.url).pathname, '.claude-plugin', 'plugin.json'), 'utf-8'));
  WORKER_VERSION = pluginJson.version;
} catch {}

function log(msg) {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(LOG, `[${new Date().toISOString()}] [worker] ${msg}\n`);
  } catch {}
}

// ── AI via Agent SDK query() ──

let queryFn = null;

async function loadSDK() {
  const candidates = [
    '@anthropic-ai/claude-agent-sdk',
  ];
  try {
    const { execSync } = await import('child_process');
    const globalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    const { readdirSync, existsSync: ex } = await import('fs');
    const { join: pjoin } = await import('path');
    // Top-level global install (npm i -g @anthropic-ai/claude-agent-sdk)
    const topLevel = pjoin(globalRoot, '@anthropic-ai', 'claude-agent-sdk');
    if (ex(topLevel)) candidates.push(topLevel);
    // Nested in other global packages
    for (const pkg of readdirSync(globalRoot).filter(d => !d.startsWith('.'))) {
      const sdkPath = pjoin(globalRoot, pkg, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
      if (ex(sdkPath)) candidates.push(sdkPath);
    }
    for (const scope of readdirSync(globalRoot).filter(d => d.startsWith('@'))) {
      for (const pkg of readdirSync(pjoin(globalRoot, scope))) {
        const sdkPath = pjoin(globalRoot, scope, pkg, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
        if (ex(sdkPath)) candidates.push(sdkPath);
      }
    }
  } catch {}

  for (const loc of candidates) {
    try {
      const mod = await import(loc);
      queryFn = mod.query || mod.default?.query;
      if (queryFn) { log(`Agent SDK loaded from ${loc}`); return true; }
    } catch {}
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const mod = require(loc);
      queryFn = mod.query;
      if (queryFn) { log(`Agent SDK loaded (CJS) from ${loc}`); return true; }
    } catch {}
  }
  log('Agent SDK not found in any location');
  return false;
}

// Queue
const pendingQueue = [];
let processing = false;

async function processQueue() {
  if (processing || !pendingQueue.length) return;
  processing = true;
  while (pendingQueue.length) {
    const job = pendingQueue.shift();
    try { await runAnalysis(job); } catch (e) { log(`Analysis error: ${e.message}`); }
  }
  processing = false;
}

async function runAnalysis(job) {
  const { sessionId, cwd, transcriptPath, isFinal } = job;
  const cfg = loadConfig();
  const state = getAnalysisState(sessionId);
  const { messages, newOffset } = readTranscriptDelta(transcriptPath, state.offset);

  if (!messages.length) return;
  const summary = summarizeMessages(messages);
  if (!isFinal && summary.length < cfg.minDeltaChars) return;
  if (summary.length < cfg.minSummaryChars) return;

  const allTasks = getAllTasks();
  const openTasks = allTasks.filter(t => t.status !== 'done');
  const taskList = openTasks.length
    ? openTasks.map(t => {
        const indent = t.parentId ? '  ' : '';
        const parent = t.parentId ? ` (subtask of #${t.parentId})` : '';
        const subs = getSubtasks(t.id).filter(s => s.status !== 'done');
        const subInfo = subs.length ? ` [${subs.length} active subtasks]` : '';
        const ctx = t.context ? ` — ${t.context.slice(0, 150)}` : '';
        return `${indent}[#${t.id}] "${t.title}" (${t.status}/${t.origin}) [${t.tags.join(',')}]${parent}${subInfo}${ctx}`;
      }).join('\n')
    : '(no tasks yet)';

  const prompt = `You are a task tracker analyzing development conversations. Be thorough — extract as much structured information as possible.

Current date and time: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC

GLOBAL task list — tasks are NOT tied to folders. Same feature may span sessions.
Match work to existing tasks by SEMANTIC similarity. "task" = meaningful work unit.
Don't create tasks for greetings, clarifications, routine git ops.
Only update status with CLEAR evidence.

## Stale task review
ALSO review the existing open tasks below. If the conversation provides evidence that a task is ALREADY DONE (e.g. the feature was completed in a previous session, the bug was fixed, the user mentions it's finished), mark it done in updates. Don't leave tasks in open/in_progress if the conversation clearly shows the work is complete.

## Task fields
- title: 5-15 words, specific and descriptive
- tags: project name, area, technology (multiple encouraged)
- category: bugfix | feature | refactor | research | devops | review | documentation | support
- context: Rich description including ALL of the following that apply:
  * WHY this task exists — what problem, request, or goal triggered it
  * WHAT is being built/fixed/changed — technical specifics
  * WHO/WHAT is involved — services, APIs, libraries, people, teams mentioned
  * KEY FILES touched or discussed — paths, modules, components
  * DEPENDENCIES or BLOCKERS — what this depends on or blocks
  * ACCEPTANCE CRITERIA — how to know when it's done, if mentioned
  * DECISIONS MADE — architectural choices, trade-offs discussed
  Write 2-5 sentences. This field is used to match future conversations to existing tasks, so include distinctive keywords and specifics.
- notes: Factual log entry. For UPDATES, describe what changed this session. Be specific: mention file names, function names, error messages, commands run, decisions made. Each entry should be self-contained.
  DO NOT prepend dates yourself (e.g. don't write "[2025-01-23] foo" or "[2026-04-15] bar"). The system automatically adds the current date. Just write the log content directly.

## Subtasks & Reparenting
Break large tasks into subtasks aggressively. Use parent_id to link.
- If conversation reveals sub-work of an existing task, create subtasks under it.
- Parent status reflects overall progress; subtasks track individual pieces.
- Max 2 levels deep. When ALL subtasks done → mark parent done.
- REPARENTING: If you discover an existing top-level task is actually part of a bigger goal:
  1. Create the new parent task (in new_tasks with parent_id: null)
  2. In updates, set parent_id on the existing task(s) to the new parent's ID placeholder "NEW:title"
     Example: {"task_id":5,"parent_id":"NEW:Migrate entire backend to microservices","notes":"reparented: this is part of the larger migration"}
  The system will resolve "NEW:title" to the actual ID after creating new tasks.

## Origin classification (CRITICAL — be precise)
Each task and update MUST have an origin + origin_reason:

- "user_initiated" — User explicitly asked for this. Evidence: user said "please do X", "I need X", "let's build X"
- "user_confirmed" — Agent proposed it and user explicitly agreed. Evidence: user said "yes", "go ahead", "sounds good", "确定", "好的"
- "user_implicit" — Agent proposed/did it and user continued engaging without objecting. Evidence: user asked follow-up questions about it, used the result, or gave related instructions
- "agent_pending" — Agent proposed or started this, user hasn't responded yet (this is the LAST message in the conversation, no user reply follows)
- "agent_ignored" — Agent proposed this earlier but user's subsequent messages didn't acknowledge it at all

origin_reason: One sentence explaining your classification with specific evidence from the conversation.

For UPDATES to existing tasks: only include origin/origin_reason if the origin actually CHANGES (e.g. agent_pending → user_confirmed because user just engaged). If origin stays the same, OMIT both fields — origin_reason captures WHY the task was originally classified, it must NOT be overwritten with reasons for unrelated later updates.

## Correcting outdated task metadata
If the conversation reveals that a task's title, tags, category, or priority is now WRONG or OUTDATED (e.g. customer name was wrong, scope changed, project misidentified), include corrected fields in the update. Don't leave stale metadata. Examples:
- Task title says "Sierra customer support" but conversation reveals it's actually Ello → update title and tags
- Task tagged "frontend" but turned out to be a backend issue → update tags
- Priority was "normal" but user said it's urgent → update priority

Status: open | in_progress | done | blocked
Priority: low | normal | high

## Current Open Tasks
${taskList}

## Session ${sessionId.slice(0, 8)} at ${cwd}

## Conversation
${summary.slice(0, cfg.maxPromptChars)}

Respond with ONLY JSON:
{"updates":[{"task_id":N,"status":"...","notes":"specific changes","origin":"user_initiated","origin_reason":"evidence","context_append":"new info (optional)","parent_id":null,"title":"only if outdated","tags":["only if outdated"],"category":"only if outdated","priority":"only if changed"}],"new_tasks":[{"title":"...","status":"in_progress","priority":"normal","tags":["project","area","tech"],"category":"feature","context":"Rich: why it exists + what's involved + key files + decisions. 2-5 sentences.","notes":"[date] what happened","parent_id":null,"origin":"user_initiated","origin_reason":"evidence"}],"session_summary":"one line"}
${cfg.language && cfg.language !== 'auto' ? `\nIMPORTANT: Write ALL text fields in ${cfg.language}.` : '\nIMPORTANT: Write all text fields in the SAME language the user uses in the conversation.'}`;

  if (!queryFn) { log('No SDK available, skipping analysis'); return; }

  const result = await analyzeWithSDK(prompt);
  if (result) {
    applyResult(result, sessionId, cwd);
    setAnalysisState(sessionId, newOffset);
    renderMarkdown();
    log(`Analyzed: ${result.updates?.length || 0} updates, ${result.new_tasks?.length || 0} new. "${result.session_summary || ''}"`);
  }
}

async function analyzeWithSDK(prompt) {
  const cfg = loadConfig();
  return new Promise(async (resolve) => {
    const timeout = setTimeout(() => { log('SDK timeout'); resolve(null); }, cfg.analysisTimeout);
    try {
      const sessionsDir = join(DIR, 'observer-sessions');
      mkdirSync(sessionsDir, { recursive: true });
      const iter = queryFn({
        prompt,
        options: {
          model: cfg.model,
          maxTurns: cfg.maxTurns,
          cwd: sessionsDir,
          disallowedTools: ['Bash','Read','Write','Edit','Grep','Glob','WebFetch','WebSearch','TodoWrite','NotebookEdit','Agent'],
        },
      });
      let fullText = '';
      for await (const msg of iter) {
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') fullText += block.text;
          }
        }
      }
      clearTimeout(timeout);
      cleanObserverSessions(sessionsDir);
      resolve(parseJSON(fullText));
    } catch (e) {
      clearTimeout(timeout);
      log(`SDK error: ${e.message}`);
      resolve(null);
    }
  });
}

function cleanObserverSessions(sessionsDir) {
  try {
    // SDK creates sessions in ~/.claude/projects/<encoded-cwd>/
    // The encoded name replaces path separators with dashes
    const encodedName = sessionsDir.replace(/\//g, '-').replace(/^-/, '');
    const projDir = join(homedir(), '.claude', 'projects', encodedName);
    for (const dir of [sessionsDir, projDir]) {
      if (!existsSync(dir)) continue;
      // Recursively clean .jsonl/.json files including subagents/ subdirs
      cleanDirRecursive(dir);
    }
  } catch (e) {
    log(`Cleanup error: ${e.message}`);
  }
}

function cleanDirRecursive(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      cleanDirRecursive(full);
      // Remove empty dirs (like subagents/)
      try { if (!readdirSync(full).length) rmdirSync(full); } catch {}
    } else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json') || entry.name.endsWith('.meta.json')) {
      try { unlinkSync(full); } catch {}
    }
  }
}

function parseJSON(raw) {
  let json = (raw || '').trim();
  if (json.startsWith('```')) json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  try { return JSON.parse(json); } catch {}
  const m = json.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

function applyResult(result, sessionId, cwd) {
  const now = new Date().toISOString();
  const today = now.slice(0, 16).replace('T', ' ');

  const VALID_ORIGINS = ['user_initiated', 'user_confirmed', 'user_implicit', 'agent_pending', 'agent_ignored'];

  // Create new tasks first so we can resolve "NEW:title" references in updates
  const newTitleToId = {};
  for (const n of result.new_tasks || []) {
    if (!n.title) continue;
    if (taskExistsByTitle(n.title)) continue;
    const parentId = n.parent_id && getTaskById(n.parent_id) ? n.parent_id : null;
    let tags = n.tags || [];
    if (parentId && !tags.length) {
      const parent = getTaskById(parentId);
      if (parent?.tags?.length) tags = [...parent.tags];
    }
    const origin = VALID_ORIGINS.includes(n.origin) ? n.origin : 'user_initiated';
    const id = createTask({
      title: n.title, status: n.status || 'open', priority: n.priority || 'normal',
      notes: n.notes ? `[${today}] ${n.notes}` : '', tags, parentId,
      origin, originReason: n.origin_reason || '',
      category: n.category || '', context: n.context || '',
    });
    newTitleToId[n.title] = id;
    addSessionLink({ taskId: id, sessionId, project: cwd, role: 'created', summary: n.notes });
  }

  // Then apply updates (can reference newly created tasks via "NEW:title")
  for (const u of result.updates || []) {
    const task = getTaskById(u.task_id);
    if (!task) continue;
    const updates = {};
    if (u.status) updates.status = u.status;
    if (u.notes) updates.notes = (task.notes ? task.notes + '\n' : '') + `[${today}] ${u.notes}`;
    if (u.status === 'done') updates.completedAt = now;
    // Metadata corrections
    if (u.title && typeof u.title === 'string' && u.title.trim() && u.title !== task.title) updates.title = u.title.trim();
    if (Array.isArray(u.tags) && u.tags.length) updates.tags = u.tags;
    if (u.category && typeof u.category === 'string' && u.category !== task.category) updates.category = u.category;
    if (u.priority && ['low','normal','high'].includes(u.priority)) updates.priority = u.priority;
    // Reparenting: resolve "NEW:title" to actual ID, or use numeric parent_id
    if (u.parent_id != null) {
      if (typeof u.parent_id === 'string' && u.parent_id.startsWith('NEW:')) {
        const title = u.parent_id.slice(4);
        const resolved = newTitleToId[title];
        if (resolved) updates.parentId = resolved;
      } else if (typeof u.parent_id === 'number' && getTaskById(u.parent_id)) {
        updates.parentId = u.parent_id;
      }
    }
    // Append new context discovered this session
    if (u.context_append) {
      updates.context = (task.context ? task.context + ' ' : '') + u.context_append;
    }
    // Origin transitions: only update reason when origin actually changes
    // origin_reason should preserve the ORIGINAL evidence for why this task was created/classified
    if (u.origin && VALID_ORIGINS.includes(u.origin) && task.origin !== 'user_initiated' && u.origin !== task.origin) {
      updates.origin = u.origin;
      if (u.origin_reason) updates.origin_reason = u.origin_reason;
    }
    updateTask(task.id, updates);
    addSessionLink({ taskId: task.id, sessionId, project: cwd, role: u.status === 'done' ? 'completed' : 'progressed', summary: u.notes });
  }

  // Auto-complete parents when all subtasks are done
  for (const u of result.updates || []) {
    if (u.status === 'done') {
      const task = getTaskById(u.task_id);
      if (task?.parentId) {
        const siblings = getSubtasks(task.parentId);
        if (siblings.length && siblings.every(t => t.status === 'done')) {
          const parent = getTaskById(task.parentId);
          if (parent && parent.status !== 'done') {
            updateTask(parent.id, {
              status: 'done', completedAt: now,
              notes: (parent.notes ? parent.notes + '\n' : '') + `[${today}] All subtasks completed`,
            });
            addSessionLink({ taskId: parent.id, sessionId, project: cwd, role: 'completed', summary: 'All subtasks completed' });
          }
        }
      }
    }
  }
}

// ── HTTP Server ──

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
  });
}

const DASHBOARD_PATH = join(new URL('.', import.meta.url).pathname, 'dashboard.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204;
    res.end();
    return;
  }

  // Dashboard UI
  if (url.pathname === '/' && req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html');
    try { res.end(readFileSync(DASHBOARD_PATH)); } catch { res.statusCode = 500; res.end('Dashboard not found'); }
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/health' && req.method === 'GET') {
    res.end(JSON.stringify({ status: 'ok', pid: process.pid, uptime: process.uptime(), sdkLoaded: !!queryFn, version: WORKER_VERSION, observerCwd: join(DIR, 'observer-sessions') }));
    return;
  }

  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body?.session_id || !body?.transcript_path) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'missing session_id or transcript_path' }));
      return;
    }
    pendingQueue.push({
      sessionId: body.session_id,
      cwd: body.cwd || '',
      transcriptPath: body.transcript_path,
      isFinal: body.is_final || false,
    });
    processQueue();
    res.end(JSON.stringify({ status: 'queued', queue_length: pendingQueue.length }));
    return;
  }

  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    const cfg = loadConfig();
    const tag = url.searchParams.get('tag');
    const status = url.searchParams.get('status');
    const project = url.searchParams.get('project');
    const tasks = queryTasks({ tag, status, project });
    const sessionLinks = getRecentLinks(cfg.recentLinksLimit);
    res.end(JSON.stringify({ tasks, sessionLinks }));
    return;
  }

  if (url.pathname === '/api/context' && req.method === 'GET') {
    const active = getAllTasks().filter(t => t.status !== 'done');
    if (!active.length) { res.end(JSON.stringify({ context: null })); return; }
    const roots = active.filter(t => !t.parentId);
    const lines = [];
    for (const t of roots) {
      lines.push(`- #${t.id} ${t.title} (${t.status}) [${t.tags.join(', ')}]`);
      const subs = active.filter(s => s.parentId === t.id);
      for (const s of subs) lines.push(`  - #${s.id} ${s.title} (${s.status})`);
    }
    const orphans = active.filter(t => t.parentId && !roots.some(r => r.id === t.parentId));
    for (const t of orphans) lines.push(`- #${t.id} ${t.title} (${t.status}) [${t.tags.join(', ')}]`);
    res.end(JSON.stringify({ context: `# Active Tasks (task-tracker)\n${lines.join('\n')}` }));
    return;
  }

  if (url.pathname === '/api/config' && req.method === 'GET') {
    res.end(JSON.stringify({ config: loadConfig(), defaults: getDefaults() }));
    return;
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body) { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid JSON' })); return; }
    // Validate numeric fields
    const numericFields = ['port', 'analysisTimeout', 'maxTurns', 'minDeltaChars', 'minSummaryChars', 'maxPromptChars', 'maxSummaryChars', 'recentLinksLimit', 'recentSessionsLimit', 'recentCompletedLimit', 'autoRefreshInterval'];
    for (const field of numericFields) {
      if (body[field] !== undefined) {
        body[field] = Number(body[field]);
        if (isNaN(body[field]) || body[field] < 0) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: `invalid value for ${field}` }));
          return;
        }
      }
    }
    if (body.port !== undefined && (body.port < 1024 || body.port > 65535)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'port must be between 1024 and 65535' }));
      return;
    }
    const updated = saveConfig(body);
    res.end(JSON.stringify({ config: updated, message: 'Config saved. Restart worker for port/host changes.' }));
    return;
  }

  if (url.pathname === '/shutdown' && req.method === 'POST') {
    res.end(JSON.stringify({ status: 'shutting_down' }));
    shutdown();
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

// ── Lifecycle ──

function writePid() {
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: PORT, startedAt: new Date().toISOString() }));
}

function shutdown() {
  log('Shutting down');
  try { unlinkSync(PID_FILE); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Start ──

async function main() {
  mkdirSync(DIR, { recursive: true });
  await loadSDK();
  server.listen(PORT, config.host, () => {
    writePid();
    log(`Worker started on ${config.host}:${PORT}, pid ${process.pid}`);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`Port ${PORT} in use — another worker running`);
      process.exit(0);
    }
    throw e;
  });
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
