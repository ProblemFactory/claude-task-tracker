// Minimal MCP stdio client + chroma-mcp lifecycle manager.
// Runs `uvx chroma-mcp` as a subprocess and communicates via newline-delimited JSON-RPC.
// No npm dependencies — implements just enough of MCP to index and query task embeddings.
//
// Requires `uvx` on PATH. Falls back gracefully if unavailable.

import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getDataDir } from './config.mjs';

const CHROMA_DIR = join(getDataDir(), 'chroma');
const COLLECTION = 'tasks';

let _state = {
  enabled: null,      // null = unknown, true/false once decided
  proc: null,
  buffer: '',
  nextId: 1,
  pending: new Map(), // id → { resolve, reject, timeout }
  initialized: false,
  initPromise: null,
  collectionReady: false,
  logger: () => {},
};

export function setChromaLogger(fn) { _state.logger = fn || (() => {}); }

function log(msg) { try { _state.logger(`[chroma] ${msg}`); } catch {} }

async function hasUvx() {
  return new Promise((resolve) => {
    const p = spawn('uvx', ['--version'], { stdio: 'ignore' });
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
    setTimeout(() => { try { p.kill(); } catch {} ; resolve(false); }, 3000);
  });
}

function sendRaw(obj) {
  if (!_state.proc || _state.proc.killed) throw new Error('chroma-mcp not running');
  _state.proc.stdin.write(JSON.stringify(obj) + '\n');
}

function request(method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = _state.nextId++;
    const timer = setTimeout(() => {
      _state.pending.delete(id);
      reject(new Error(`chroma-mcp ${method} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    _state.pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      sendRaw({ jsonrpc: '2.0', id, method, params });
    } catch (e) {
      clearTimeout(timer);
      _state.pending.delete(id);
      reject(e);
    }
  });
}

function notify(method, params) {
  sendRaw({ jsonrpc: '2.0', method, params });
}

function handleLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && _state.pending.has(msg.id)) {
    const p = _state.pending.get(msg.id);
    _state.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }
  // Notifications from server are ignored (we don't use them)
}

function startProcess() {
  mkdirSync(CHROMA_DIR, { recursive: true });
  const args = ['chroma-mcp', '--client-type', 'persistent', '--data-dir', CHROMA_DIR];
  log(`spawning: uvx ${args.join(' ')}`);
  const proc = spawn('uvx', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  proc.stdout.setEncoding('utf-8');
  proc.stdout.on('data', (chunk) => {
    _state.buffer += chunk;
    let idx;
    while ((idx = _state.buffer.indexOf('\n')) >= 0) {
      const line = _state.buffer.slice(0, idx);
      _state.buffer = _state.buffer.slice(idx + 1);
      handleLine(line);
    }
  });
  proc.stderr.setEncoding('utf-8');
  proc.stderr.on('data', (chunk) => {
    // chroma-mcp logs setup info to stderr; only surface if it looks like an error
    for (const line of chunk.split('\n')) {
      if (line.includes('ERROR') || line.includes('Traceback') || line.includes('Error')) log(`stderr: ${line}`);
    }
  });
  proc.on('exit', (code) => {
    log(`chroma-mcp exited with code ${code}`);
    _state.proc = null;
    _state.initialized = false;
    _state.collectionReady = false;
    for (const [, p] of _state.pending) p.reject(new Error('chroma-mcp died'));
    _state.pending.clear();
  });
  proc.on('error', (e) => log(`spawn error: ${e.message}`));
  _state.proc = proc;
}

async function initialize() {
  if (_state.initPromise) return _state.initPromise;
  _state.initPromise = (async () => {
    if (!(await hasUvx())) {
      _state.enabled = false;
      log('uvx not available, chroma disabled (BM25 fallback will be used)');
      return false;
    }
    try {
      startProcess();
      // Wait a bit for process to be ready to read stdin
      await new Promise((r) => setTimeout(r, 200));
      await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'claude-task-tracker', version: '1.7.2' },
      }, 15000);
      notify('notifications/initialized', {});
      _state.initialized = true;
      // Ensure collection exists
      try {
        await request('tools/call', {
          name: 'chroma_create_collection',
          arguments: { collection_name: COLLECTION },
        }, 30000);
      } catch (e) {
        // Already exists is fine
        if (!/exists|already/i.test(e.message)) log(`create_collection: ${e.message}`);
      }
      _state.collectionReady = true;
      _state.enabled = true;
      log('ready');
      return true;
    } catch (e) {
      log(`init failed: ${e.message}`);
      _state.enabled = false;
      try { _state.proc?.kill(); } catch {}
      return false;
    }
  })();
  return _state.initPromise;
}

export async function isAvailable() {
  if (_state.enabled === null) await initialize();
  return _state.enabled === true;
}

function taskToDocument(t) {
  const tags = (t.tags || []).join(' ');
  // Concatenate important fields for better embedding semantics
  const parts = [
    t.title,
    t.category ? `category: ${t.category}` : '',
    tags ? `tags: ${tags}` : '',
    t.context || '',
  ].filter(Boolean);
  return parts.join('\n\n');
}

function taskMetadata(t) {
  // Chroma metadata must be primitive values
  return {
    task_id: t.id,
    status: t.status || '',
    priority: t.priority || '',
    category: t.category || '',
    parent_id: t.parentId == null ? -1 : t.parentId,
    tags: (t.tags || []).join(','),
  };
}

export async function upsertTask(t) {
  if (!(await isAvailable())) return;
  try {
    const id = `task_${t.id}`;
    const doc = taskToDocument(t);
    if (!doc.trim()) return;
    // Try delete then add to avoid duplicate-id errors
    try {
      await request('tools/call', {
        name: 'chroma_delete_documents',
        arguments: { collection_name: COLLECTION, ids: [id] },
      }, 15000);
    } catch {}
    await request('tools/call', {
      name: 'chroma_add_documents',
      arguments: {
        collection_name: COLLECTION,
        ids: [id],
        documents: [doc],
        metadatas: [taskMetadata(t)],
      },
    }, 30000);
  } catch (e) {
    log(`upsertTask(#${t.id}) failed: ${e.message}`);
  }
}

export async function deleteTask(taskId) {
  if (!(await isAvailable())) return;
  try {
    await request('tools/call', {
      name: 'chroma_delete_documents',
      arguments: { collection_name: COLLECTION, ids: [`task_${taskId}`] },
    }, 10000);
  } catch (e) {
    log(`deleteTask(#${taskId}) failed: ${e.message}`);
  }
}

// Returns array of task_id (number) in ranked order.
export async function queryTasks(queryText, limit = 10, whereFilter = null) {
  if (!(await isAvailable())) return null;
  try {
    const params = {
      collection_name: COLLECTION,
      query_texts: [queryText],
      n_results: limit,
      include: ['metadatas', 'distances'],
    };
    if (whereFilter) params.where = whereFilter;
    const result = await request('tools/call', {
      name: 'chroma_query_documents',
      arguments: params,
    }, 30000);
    // MCP tool-call result format: { content: [{ type: 'text', text: '...' }] }
    const text = result?.content?.[0]?.text;
    if (!text) return [];
    const parsed = typeof text === 'string' ? JSON.parse(text) : text;
    const metas = parsed?.metadatas?.[0] || [];
    return metas.map(m => Number(m.task_id)).filter(n => !isNaN(n));
  } catch (e) {
    log(`query failed: ${e.message}`);
    return null;
  }
}

export async function backfill(tasks) {
  if (!(await isAvailable())) return 0;
  let n = 0;
  for (const t of tasks) {
    await upsertTask(t);
    n++;
  }
  log(`backfilled ${n} tasks`);
  return n;
}

export function shutdown() {
  if (_state.proc && !_state.proc.killed) {
    try { _state.proc.kill(); } catch {}
  }
  _state.proc = null;
  _state.initialized = false;
  _state.collectionReady = false;
  _state.enabled = null;
  _state.initPromise = null;
  for (const [, p] of _state.pending) p.reject(new Error('chroma shutdown'));
  _state.pending.clear();
}
