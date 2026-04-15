#!/usr/bin/env node
import http from 'http';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, appendFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadData, saveData, renderMarkdown, DIR } from './store.mjs';
import { readTranscriptDelta, summarizeMessages } from './ai.mjs';
import { loadConfig, saveConfig, getDefaults } from './config.mjs';

const config = loadConfig();
const PORT = config.port;
const PID_FILE = join(DIR, 'worker.pid');
const LOG = join(DIR, 'debug.log');

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
  const data = loadData();
  const state = data.analysisState[sessionId] || { offset: 0 };
  const { messages, newOffset } = readTranscriptDelta(transcriptPath, state.offset);

  if (!messages.length) return;
  const summary = summarizeMessages(messages);
  if (!isFinal && summary.length < cfg.minDeltaChars) return;
  if (summary.length < cfg.minSummaryChars) return;

  const openTasks = data.tasks.filter(t => t.status !== 'done');
  const taskList = openTasks.length
    ? openTasks.map(t => `[#${t.id}] "${t.title}" (${t.status}) [${t.tags.join(',')}]`).join('\n')
    : '(no tasks yet)';

  const prompt = `You are a task tracker analyzing development conversations.

GLOBAL task list — tasks are NOT tied to folders. Same feature may span sessions.
Match work to existing tasks by SEMANTIC similarity. "task" = meaningful work unit.
Don't create tasks for greetings, clarifications, routine git ops.
Only update status with CLEAR evidence.
Titles: 5-12 words. Tags: project/area.
Analytical tasks (review, research) with conclusions → mark done.

Status: open | in_progress | done | blocked
Priority: low | normal | high

## Current Open Tasks
${taskList}

## Session ${sessionId.slice(0, 8)} at ${cwd}

## Conversation
${summary.slice(0, cfg.maxPromptChars)}

Respond with ONLY JSON:
{"updates":[{"task_id":N,"status":"...","notes":"brief"}],"new_tasks":[{"title":"...","status":"in_progress","priority":"normal","tags":["project"],"notes":"brief"}],"session_summary":"one line"}`;

  if (!queryFn) { log('No SDK available, skipping analysis'); return; }

  const result = await analyzeWithSDK(prompt);
  if (result) {
    applyResult(data, result, sessionId, cwd);
    data.analysisState[sessionId] = { offset: newOffset, analyzedAt: new Date().toISOString() };
    saveData(data);
    renderMarkdown(data);
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
    // Clean up JSONL files from both the sessions dir and the encoded project dir
    const encodedName = sessionsDir.replace(/\//g, '-').replace(/^-/, '');
    const projDir = join(homedir(), '.claude', 'projects', encodedName);
    for (const dir of [sessionsDir, projDir]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.jsonl') || f.endsWith('.json')) {
          try { unlinkSync(join(dir, f)); } catch {}
        }
      }
    }
  } catch (e) {
    log(`Cleanup error: ${e.message}`);
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

function applyResult(data, result, sessionId, cwd) {
  for (const u of result.updates || []) {
    const task = data.tasks.find(t => t.id === u.task_id);
    if (!task) continue;
    if (u.status) task.status = u.status;
    if (u.notes) task.notes = (task.notes ? task.notes + '\n' : '') + `[${new Date().toISOString().slice(0, 10)}] ${u.notes}`;
    task.updatedAt = new Date().toISOString();
    if (u.status === 'done') task.completedAt = new Date().toISOString();
    addLink(data, task.id, sessionId, cwd, u.status === 'done' ? 'completed' : 'progressed', u.notes);
  }
  for (const n of result.new_tasks || []) {
    if (!n.title) continue;
    if (data.tasks.some(t => t.title.toLowerCase() === n.title.toLowerCase())) continue;
    const id = data.nextId++;
    data.tasks.push({
      id, title: n.title, status: n.status || 'open', priority: n.priority || 'normal',
      notes: n.notes ? `[${new Date().toISOString().slice(0, 10)}] ${n.notes}` : '',
      tags: n.tags || [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
    });
    addLink(data, id, sessionId, cwd, 'created', n.notes);
  }
}

function addLink(data, taskId, sessionId, cwd, role, summary) {
  if (data.sessionLinks.some(l => l.taskId === taskId && l.sessionId === sessionId && l.role === role)) return;
  data.sessionLinks.push({ taskId, sessionId, project: cwd, role, summary: summary || '', createdAt: new Date().toISOString() });
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
    res.end(JSON.stringify({ status: 'ok', pid: process.pid, uptime: process.uptime(), sdkLoaded: !!queryFn }));
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
    const data = loadData();
    const cfg = loadConfig();
    const tag = url.searchParams.get('tag');
    const status = url.searchParams.get('status');
    const project = url.searchParams.get('project');
    let tasks = data.tasks;
    if (tag) tasks = tasks.filter(t => (t.tags||[]).some(g => g.toLowerCase().includes(tag.toLowerCase())));
    if (status) tasks = tasks.filter(t => t.status === status);
    if (project) {
      const linked = new Set(data.sessionLinks.filter(l => l.project && l.project.toLowerCase().includes(project.toLowerCase())).map(l => l.taskId));
      tasks = tasks.filter(t => linked.has(t.id) || (t.tags||[]).some(g => g.toLowerCase().includes(project.toLowerCase())));
    }
    res.end(JSON.stringify({ tasks, sessionLinks: data.sessionLinks.slice(-cfg.recentLinksLimit) }));
    return;
  }

  if (url.pathname === '/api/context' && req.method === 'GET') {
    const data = loadData();
    const active = data.tasks.filter(t => t.status !== 'done');
    if (!active.length) { res.end(JSON.stringify({ context: null })); return; }
    const lines = active.map(t => `- #${t.id} ${t.title} (${t.status}) [${t.tags.join(', ')}]`);
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
