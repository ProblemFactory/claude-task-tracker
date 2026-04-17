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
import * as chroma from './chroma.mjs';
import { buildTools } from './tools.mjs';
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
let toolFn = null;
let createSdkMcpServerFn = null;
let zodLib = null;
let mcpServerInstance = null;

async function loadSDK() {
  const candidates = [
    '@anthropic-ai/claude-agent-sdk',
  ];
  let sdkBasePath = null;
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
      if (queryFn) {
        toolFn = mod.tool || mod.default?.tool;
        createSdkMcpServerFn = mod.createSdkMcpServer || mod.default?.createSdkMcpServer;
        sdkBasePath = loc;
        log(`Agent SDK loaded from ${loc}`);
        break;
      }
    } catch {}
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const mod = require(loc);
      queryFn = mod.query;
      if (queryFn) {
        toolFn = mod.tool;
        createSdkMcpServerFn = mod.createSdkMcpServer;
        sdkBasePath = loc;
        log(`Agent SDK loaded (CJS) from ${loc}`);
        break;
      }
    } catch {}
  }
  if (!queryFn) { log('Agent SDK not found in any location'); return false; }

  // Load zod sibling to SDK (task-master-ai/node_modules/zod etc.)
  if (sdkBasePath && sdkBasePath.startsWith('/')) {
    try {
      const { join: pjoin } = await import('path');
      const { existsSync: ex } = await import('fs');
      // Try zod located as a sibling in the same node_modules tree
      let cur = sdkBasePath;
      while (cur && cur !== '/') {
        const zodPath = pjoin(cur, '..', '..', 'zod');
        if (ex(zodPath)) {
          const { createRequire } = await import('module');
          const require = createRequire(import.meta.url);
          try { zodLib = require(zodPath).z || require(zodPath); break; } catch {}
        }
        const parent = pjoin(cur, '..');
        if (parent === cur) break;
        cur = parent;
      }
    } catch {}
  }
  if (!zodLib) log('zod not found — MCP tools will be disabled');
  return true;
}

function buildMcpServer() {
  if (mcpServerInstance) return mcpServerInstance;
  if (!toolFn || !createSdkMcpServerFn || !zodLib) return null;
  try {
    const tools = buildTools({ tool: toolFn, z: zodLib });
    mcpServerInstance = createSdkMcpServerFn({
      name: 'task-tracker-query',
      version: '1.0.0',
      tools,
    });
    log(`MCP server built with ${tools.length} tools`);
    return mcpServerInstance;
  } catch (e) {
    log(`MCP server build failed: ${e.message}`);
    return null;
  }
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
  const isFirstAnalysis = state.offset === 0;
  const { messages, newOffset } = readTranscriptDelta(transcriptPath, state.offset);

  if (!messages.length) return;
  const summary = summarizeMessages(messages);
  // First analysis of a session: read the full transcript, don't skip regardless of size
  if (!isFirstAnalysis && !isFinal && summary.length < cfg.minDeltaChars) return;
  if (summary.length < cfg.minSummaryChars) return;

  const allTasks = getAllTasks();
  const openTasks = allTasks.filter(t => t.status !== 'done');
  const taskById = new Map(allTasks.map(t => [t.id, t]));

  // ── Pre-retrieval: build the candidate task set shown to AI ──
  // Strategy: (1) all tasks linked to this cwd, (2) top-K semantically related via chroma
  // (3) all top-level parents of anything selected (for context on hierarchy)
  const selected = new Set();

  // 1. Project-local tasks (any task with a session_link to this cwd, recursively up)
  const cwdLower = (cwd || '').toLowerCase();
  for (const t of openTasks) {
    if ((t.tags || []).some(tag => cwdLower.includes(tag.toLowerCase()))) selected.add(t.id);
  }

  // 2. Chroma semantic search — HyDE via Haiku extracts task-like phrases first
  const queryText = await extractSearchQuery(summary);
  const chromaHits = await chroma.queryTasks(queryText, 15).catch(() => null);
  if (chromaHits) for (const id of chromaHits) if (taskById.has(id)) selected.add(id);

  // 3. Always include active (in_progress) top-level tasks so AI sees what's live
  for (const t of openTasks) {
    if (!t.parentId && t.status === 'in_progress') selected.add(t.id);
  }

  // 4. Walk up: for every selected task include its parent chain (context on hierarchy)
  const withAncestors = new Set(selected);
  for (const id of selected) {
    let cur = taskById.get(id);
    while (cur?.parentId && !withAncestors.has(cur.parentId)) {
      withAncestors.add(cur.parentId);
      cur = taskById.get(cur.parentId);
    }
  }
  // 5. Also pull in direct children of any selected task so updates can reference them
  for (const t of allTasks) {
    if (t.parentId && withAncestors.has(t.parentId)) withAncestors.add(t.id);
  }

  const candidates = [...withAncestors].map(id => taskById.get(id)).filter(Boolean);
  const candidateIds = new Set(candidates.map(t => t.id));

  // Render hierarchically: roots first, then subtasks indented
  const roots = candidates.filter(t => !t.parentId || !candidateIds.has(t.parentId));
  const lines = [];
  function renderLine(t, depth) {
    const indent = '  '.repeat(depth);
    const parent = t.parentId ? ` (subtask of #${t.parentId})` : '';
    const ctx = t.context ? ` — ${t.context.slice(0, 150)}` : '';
    const subs = getSubtasks(t.id).filter(s => s.status !== 'done');
    const subInfo = subs.length ? ` [${subs.length} active subtasks]` : '';
    lines.push(`${indent}[#${t.id}] "${t.title}" (${t.status}/${t.origin}) [${(t.tags || []).join(',')}]${parent}${subInfo}${ctx}`);
    for (const c of candidates.filter(ch => ch.parentId === t.id)) renderLine(c, depth + 1);
  }
  for (const r of roots) renderLine(r, 0);

  const taskList = lines.length
    ? lines.join('\n')
    : '(no tasks yet)';
  const retrievalStats = `[retrieval] ${candidates.length} candidates shown out of ${openTasks.length} open tasks (chroma=${chromaHits ? chromaHits.length : 'unavailable'})`;

  const prompt = `You are a task tracker analyzing development conversations. Record what WAS DONE / DECIDED / STARTED / BLOCKED in this conversation. You are NOT a planner or researcher — your sole output is updates to the task DB.

Current date and time: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC

## When to skip
Return \`{"updates":[],"new_tasks":[],"session_summary":""}\` — no prose — if the conversation is:
- Greeting / clarification / thinking aloud with no decisions made
- A routine operation already covered by an existing task update
- Too short or ambiguous to create a meaningful task

## Task creation rules
GLOBAL task list — tasks are NOT tied to folders. Same feature may span sessions.
Match work to existing tasks by SEMANTIC similarity. "task" = meaningful work unit.
Don't create tasks for greetings, clarifications, routine git ops.
Only update status with CLEAR evidence.

## IMPORTANT: The candidate list below is FILTERED, not exhaustive
You see a pre-retrieved subset (project-relevant + semantically similar + active top-level tasks + their parent/child context). The full DB has many more tasks you cannot see here. Implications:
- If work seems NEW based on this list, it might still match an unseen task. Prefer updating over creating when in doubt.
- Never assume a task doesn't exist just because it's not in this list.

## Tools (use them when the candidate list is insufficient)
You have MCP tools from \`task-tracker\`:
- \`mcp__task-tracker__search_tasks\`: semantic search with a free-text query. Use this if the conversation mentions a topic/project/customer that isn't in the candidate list — you might find a better match.
- \`mcp__task-tracker__get_task\`: fetch full details (context, notes, origin history, recent sessions) for one task id. Use this when you need to verify a match is correct before updating, or when understanding a parent's scope before creating a subtask.
- \`mcp__task-tracker__get_task_tree\`: see all descendants of a parent. Use this when considering reparenting — check the parent's current children first.
- \`mcp__task-tracker__list_tasks\`: filter by status/tag/project/category/origin/parentId.

When to use tools:
- Big new feature mentioned, nothing similar in candidates → search first
- About to create a top-level task → search to double-check no better parent exists
- About to reparent something → get_task on the candidate parent to confirm it fits
Don't over-use tools. If the candidate list clearly contains the right match, just update.

## Stale task review + organization review
Each analysis, also review the existing tasks:
- Mark tasks DONE if the conversation shows the work is complete (previous session evidence OK).
- Look for REPARENTING opportunities: if two or more top-level tasks are actually parts of the same larger effort, create or identify a parent and move them under it via the reparenting mechanism.
- Check if a parent task was incorrectly marked done: if it represents ongoing work but was auto-completed, reopen it.

## Before creating a new top-level task — check for natural parents
Creating too many top-level tasks makes the dashboard cluttered. Before setting parent_id: null on a new task, scan the existing list for:
- **Same project/product parent**: e.g. "Build Claude Code WebUI" owns all UI bug fixes / features for that webui
- **Same customer/client parent**: e.g. "Ello customer support" owns all technical questions from that customer
- **Same topic/domain parent**: e.g. "Personal health research" owns all blood-test/wearable-device research
- **Same plugin/dependency parent**: e.g. "claude-mem maintenance" owns all upgrade/patch/config tasks for that plugin
If a natural parent exists (even vaguely), put the new task under it. Only use parent_id: null for tasks that are genuinely standalone.

## Parent task naming
When creating a parent container, pick a title that reflects its ONGOING scope, not a single milestone. Good: "Build X system", "Support Y customer", "Research Z topic". Bad: "Implement feature A" (too narrow — future work for X won't fit naturally).

## Don't misclassify subtasks
A subtask should share the SEMANTIC purpose of its parent. "Set up B2B workspace" should NOT have "Configure WireGuard VPN" as a child — VPN is infrastructure, not B2B setup. If the work genuinely belongs to a different domain, make it a separate top-level task (and find/create the right parent for it).

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
- Nest as deep as needed (no hard limit, but prefer flat when it makes sense).
- Auto-complete parent rule: ONLY mark a parent done when ALL subtasks are done AND the parent represents a BOUNDED deliverable (e.g. "Fix dropdown bug", "Release v2.1.0"). Do NOT auto-complete parents that represent ONGOING projects or long-term containers (e.g. "Build X system", "Support Y customer"). When in doubt, leave parent in_progress.
- When reviewing existing tasks: if a seemingly-done root task represents ongoing work (indicated by tags like "platform", broad scope, or category not being a specific deliverable), reopen it back to in_progress.
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

For UPDATES to existing tasks: only include origin/origin_reason if the origin actually CHANGES (e.g. agent_pending → user_confirmed because user just engaged). If origin stays the same, OMIT both fields. The origin_reason is append-only — each transition adds a new dated line preserving the full history of why the task's classification evolved. Do NOT try to rewrite or "improve" the existing reason.

## Correcting outdated task metadata
If the conversation reveals that a task's title, tags, category, or priority is now WRONG or OUTDATED (e.g. customer name was wrong, scope changed, project misidentified), include corrected fields in the update. Don't leave stale metadata. Examples:
- Task title says "Sierra customer support" but conversation reveals it's actually Ello → update title and tags
- Task tagged "frontend" but turned out to be a backend issue → update tags
- Priority was "normal" but user said it's urgent → update priority

Status: open | in_progress | done | blocked
Priority: low | normal | high

## Candidate tasks (filtered subset, NOT the full DB)
${taskList}

## Session ${sessionId.slice(0, 8)} at ${cwd}${isFirstAnalysis ? '\nNOTE: This is the FIRST analysis of this session — you are seeing the FULL conversation history, not just a delta. Establish all relevant tasks from scratch for this session.' : ''}

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
    log(`${retrievalStats}`);
    log(`Analyzed: ${result.updates?.length || 0} updates, ${result.new_tasks?.length || 0} new. "${result.session_summary || ''}"`);
  }
}

// HyDE: Use Haiku to extract task-relevant topic phrases from the raw conversation.
// This improves chroma's embedding retrieval because the query text is now in the
// same "task description" style as the indexed task.context / task.title fields.
async function extractSearchQuery(conversationSummary) {
  if (!queryFn) return conversationSummary.slice(0, 2500);
  try {
    const prompt = `Extract 3-5 short phrases describing the TASKS / WORK / TOPICS in this conversation. These phrases will be used as a semantic search query against an existing task database.

Rules:
- Each phrase: 3-8 words, noun-phrase style, specific technical/domain keywords
- Include: feature names, bug descriptions, file/module names, customer/project names, technologies
- Exclude: greetings, chit-chat, generic verbs ("discussed", "asked"), meta-commentary
- Output ONE phrase per line, no bullets, no prose, no explanation

Conversation:
${conversationSummary.slice(0, 6000)}

Phrases:`;

    const sessionsDir = join(DIR, 'observer-sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const iter = queryFn({
      prompt,
      options: {
        model: 'haiku',
        maxTurns: 1,
        cwd: sessionsDir,
        disallowedTools: ['Bash','Read','Write','Edit','Grep','Glob','WebFetch','WebSearch','TodoWrite','NotebookEdit','Agent'],
      },
    });
    let text = '';
    const timeout = new Promise(r => setTimeout(() => r(null), 12000));
    const collect = (async () => {
      for await (const msg of iter) {
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') text += block.text;
          }
        }
      }
      return 'done';
    })();
    const outcome = await Promise.race([collect, timeout]);
    if (outcome !== 'done') {
      log('HyDE timeout, falling back to raw summary');
      return conversationSummary.slice(0, 2500);
    }
    const phrases = text
      .replace(/```+[a-z]*|```+/g, '')
      .trim()
      .split('\n')
      .map(l => l.trim().replace(/^[-*•]\s*/, ''))
      .filter(l => l && l.length < 150)
      .slice(0, 8);
    if (!phrases.length) return conversationSummary.slice(0, 2500);
    log(`HyDE phrases: ${phrases.join(' | ')}`);
    return phrases.join('\n');
  } catch (e) {
    log(`HyDE error: ${e.message}`);
    return conversationSummary.slice(0, 2500);
  }
}

async function analyzeWithSDK(prompt) {
  const cfg = loadConfig();
  return new Promise(async (resolve) => {
    const timeout = setTimeout(() => { log('SDK timeout'); resolve(null); }, cfg.analysisTimeout);
    try {
      const sessionsDir = join(DIR, 'observer-sessions');
      mkdirSync(sessionsDir, { recursive: true });
      const mcpServer = buildMcpServer();
      const opts = {
        model: cfg.model,
        maxTurns: mcpServer ? Math.max(cfg.maxTurns, 5) : cfg.maxTurns,
        cwd: sessionsDir,
        disallowedTools: ['Bash','Read','Write','Edit','Grep','Glob','WebFetch','WebSearch','TodoWrite','NotebookEdit','Agent'],
      };
      if (mcpServer) {
        opts.mcpServers = { 'task-tracker': mcpServer };
      }
      const iter = queryFn({ prompt, options: opts });
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
    // Origin transitions: append a new reason line when origin actually changes
    // origin_reason is append-only history of all classification decisions
    if (u.origin && VALID_ORIGINS.includes(u.origin) && task.origin !== 'user_initiated' && u.origin !== task.origin) {
      updates.origin = u.origin;
      if (u.origin_reason) {
        const entry = `[${today}] ${task.origin} \u2192 ${u.origin}: ${u.origin_reason}`;
        updates.origin_reason = (task.origin_reason ? task.origin_reason + '\n' : '') + entry;
      }
    }
    updateTask(task.id, updates);
    addSessionLink({ taskId: task.id, sessionId, project: cwd, role: u.status === 'done' ? 'completed' : 'progressed', summary: u.notes });
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

  // Static assets (icons preview, svg files)
  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const srcDir = new URL('.', import.meta.url).pathname;
    const safePath = url.pathname.replace(/\.\./g, '');
    const full = join(srcDir, safePath);
    try {
      const ext = safePath.split('.').pop();
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'html' ? 'text/html' : 'text/plain';
      res.setHeader('Content-Type', mime);
      res.end(readFileSync(full));
    } catch { res.statusCode = 404; res.end('not found'); }
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

async function initChroma() {
  chroma.setChromaLogger(log);
  const ok = await chroma.isAvailable();
  if (!ok) {
    log('chroma unavailable — semantic retrieval disabled (BM25 fallback only)');
    return;
  }
  // Backfill: ensure existing tasks are indexed. Cheap if already there (upsert).
  // Only backfill if meta flag says we haven't, to avoid re-indexing every start.
  try {
    const all = getAllTasks();
    log(`chroma backfill: indexing ${all.length} tasks (async)`);
    (async () => {
      for (const t of all) {
        await chroma.upsertTask(t);
      }
      log('chroma backfill complete');
    })();
  } catch (e) {
    log(`backfill error: ${e.message}`);
  }
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  await loadSDK();
  initChroma().catch(e => log(`chroma init error: ${e.message}`));
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
