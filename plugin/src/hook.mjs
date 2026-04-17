#!/usr/bin/env node
import http from 'http';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { loadData } from './store.mjs';
import { loadConfig } from './config.mjs';

const DIR = join(homedir(), '.claude', 'task-tracker');
const PID_FILE = join(DIR, 'worker.pid');
const LOG = join(DIR, 'debug.log');

// Read current plugin version (hook always runs from latest code)
let CURRENT_VERSION = 'unknown';
try {
  const pluginJson = JSON.parse(readFileSync(join(new URL('..', import.meta.url).pathname, '.claude-plugin', 'plugin.json'), 'utf-8'));
  CURRENT_VERSION = pluginJson.version;
} catch {}

// Cached observer cwd from worker health — used to filter out our own SDK sessions
let _observerCwd = null;

function log(msg) {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(LOG, `[${new Date().toISOString()}] [hook] ${msg}\n`);
  } catch {}
}

// ── HTTP helpers ──

function getPort() {
  return loadConfig().port;
}

function workerGet(path) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${getPort()}${path}`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function workerPost(path, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const req = http.request(`http://127.0.0.1:${getPort()}${path}`, {
      method: 'POST', timeout: 3000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Worker lifecycle ──

function isWorkerAlive() {
  try {
    if (!existsSync(PID_FILE)) return false;
    const info = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
    process.kill(info.pid, 0);
    return true;
  } catch { return false; }
}

function startWorker() {
  const workerPath = join(new URL('.', import.meta.url).pathname, 'worker.mjs');
  const worker = spawn('node', [workerPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  worker.unref();
  log(`Spawned worker pid=${worker.pid}`);
}

async function ensureWorker() {
  if (isWorkerAlive()) {
    const health = await workerGet('/health');
    if (health?.status === 'ok') {
      if (health.observerCwd) _observerCwd = health.observerCwd;
      // Check version — restart if worker is running stale code
      if (health.version && CURRENT_VERSION !== 'unknown' && health.version !== CURRENT_VERSION) {
        log(`Worker version ${health.version} != plugin ${CURRENT_VERSION}, restarting`);
        await workerPost('/shutdown', {});
        await new Promise(r => setTimeout(r, 1000));
      } else {
        return true;
      }
    }
  }
  startWorker();
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 500));
    const health = await workerGet('/health');
    if (health?.status === 'ok') {
      if (health.observerCwd) _observerCwd = health.observerCwd;
      return true;
    }
  }
  log('Worker failed to start');
  return false;
}

// ── Stdin reader ──

let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => {
  buf += chunk;
  try {
    const input = JSON.parse(buf);
    main(input)
      .then(result => {
        if (result) process.stdout.write(JSON.stringify(result));
        process.exit(0);
      })
      .catch(e => {
        log(`Fatal: ${e.message}`);
        process.exit(0);
      });
  } catch { /* incomplete JSON */ }
});
setTimeout(() => process.exit(0), 8000);

// ── Dispatch ──

async function main(input) {
  const event = input.hook_event_name;

  // Guard: skip ALL observer/synthetic sessions (ours, claude-mem's, any plugin's)
  // 1. Exact match against our own observer cwd from worker /health
  // 2. Broad match: any cwd ending in "observer-sessions" (convention shared by claude-mem etc.)
  const observerCwd = _observerCwd || join(homedir(), '.claude', 'task-tracker', 'observer-sessions');
  if (input.cwd && (input.cwd.startsWith(observerCwd) || input.cwd.endsWith('observer-sessions'))) {
    return null;
  }

  log(`${event} session=${input.session_id?.slice(0, 8)} cwd=${input.cwd}`);

  if (event === 'SessionStart') {
    await ensureWorker();
    const ctx = await workerGet('/api/context');
    if (ctx?.context) return { additionalContext: ctx.context };
    const data = loadData();
    const active = data.tasks.filter(t => t.status !== 'done');
    if (active.length) {
      const roots = active.filter(t => !t.parentId);
      const lines = [];
      for (const t of roots) {
        lines.push(`- #${t.id} ${t.title} (${t.status}) [${t.tags.join(', ')}]`);
        const subs = active.filter(s => s.parentId === t.id);
        for (const s of subs) lines.push(`  - #${s.id} ${s.title} (${s.status})`);
      }
      return { additionalContext: `# Active Tasks (task-tracker)\n${lines.join('\n')}` };
    }
    return null;
  }

  if (event === 'UserPromptSubmit') {
    const tp = input.transcript_path;
    if (!tp || !existsSync(tp)) return null;
    if (!(await ensureWorker())) return null;
    await workerPost('/api/analyze', {
      session_id: input.session_id,
      cwd: input.cwd,
      transcript_path: tp,
      is_final: false,
    });
    return null;
  }

  if (event === 'Stop') {
    const tp = input.transcript_path;
    if (!tp || !existsSync(tp)) return null;
    if (!(await ensureWorker())) return null;
    await workerPost('/api/analyze', {
      session_id: input.session_id,
      cwd: input.cwd,
      transcript_path: tp,
      is_final: true,
    });
    return null;
  }

  return null;
}
