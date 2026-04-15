#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import http from 'http';

const DATA_DIR = join(homedir(), '.claude', 'task-tracker');
const PID_FILE = join(DATA_DIR, 'worker.pid');
const SRC_DIR = new URL('../src', import.meta.url).pathname;

const command = process.argv[2];

function usage() {
  console.log(`
claude-task-tracker — Passive task tracking for Claude Code

Install via Claude Code plugin system:
  claude plugins marketplace add github:ProblemFactory/claude-task-tracker
  claude plugins install claude-task-tracker@ProblemFactory

Management:
  status      Show worker and hook status
  start       Start the worker manually
  stop        Stop the worker
  dashboard   Open the dashboard URL
  help        Show this help
`);
}

function workerGet(path) {
  return new Promise((resolve) => {
    const port = getPort();
    const req = http.get(`http://127.0.0.1:${port}${path}`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function workerPost(path) {
  return new Promise((resolve) => {
    const port = getPort();
    const req = http.request(`http://127.0.0.1:${port}${path}`, { method: 'POST', timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function getPort() {
  try {
    const configPath = join(DATA_DIR, 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.port) return config.port;
    }
  } catch {}
  return 37778;
}

async function status() {
  const port = getPort();
  const health = await workerGet('/health');

  console.log('Task Tracker Status');
  console.log('\u2500'.repeat(40));

  if (health?.status === 'ok') {
    console.log(`  Worker:    running (pid ${health.pid}, port ${port})`);
    console.log(`  Uptime:    ${Math.floor(health.uptime)}s`);
    console.log(`  SDK:       ${health.sdkLoaded ? 'loaded' : 'NOT loaded'}`);
  } else {
    console.log('  Worker:    not running');
  }

  console.log(`  Dashboard: http://127.0.0.1:${port}/`);
  console.log(`  Data dir:  ${DATA_DIR}`);

  // Check plugin
  try {
    const result = execSync('claude plugins list 2>/dev/null', { encoding: 'utf-8' });
    console.log(`  Plugin:    ${result.includes('claude-task-tracker') ? 'installed' : 'not found'}`);
  } catch {
    console.log('  Plugin:    unknown (claude CLI not found)');
  }

  // Task stats
  const r = await workerGet('/api/tasks');
  if (r?.tasks) {
    const done = r.tasks.filter(t => t.status === 'done').length;
    console.log(`  Tasks:     ${r.tasks.length} total, ${r.tasks.length - done} active, ${done} done`);
  }
}

async function start() {
  const { spawn } = await import('child_process');
  const worker = spawn('node', [join(SRC_DIR, 'worker.mjs')], {
    detached: true,
    stdio: 'ignore',
  });
  worker.unref();
  console.log(`Worker started (pid ${worker.pid})`);
}

async function stop() {
  const result = await workerPost('/shutdown');
  if (result?.status === 'shutting_down') {
    console.log('Worker shutting down.');
  } else {
    // Try kill from PID file
    try {
      const info = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
      process.kill(info.pid, 'SIGTERM');
      console.log(`Sent SIGTERM to pid ${info.pid}`);
    } catch {
      console.log('Worker is not running.');
    }
  }
}

function dashboard() {
  const port = getPort();
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Dashboard: ${url}`);
  try { execSync(`xdg-open "${url}" 2>/dev/null || open "${url}" 2>/dev/null`, { stdio: 'ignore' }); } catch {}
}

switch (command) {
  case 'status': status(); break;
  case 'start': start(); break;
  case 'stop': stop(); break;
  case 'dashboard': dashboard(); break;
  case 'help': case '--help': case '-h': case undefined: usage(); break;
  default: console.error(`Unknown command: ${command}`); usage(); process.exit(1);
}
