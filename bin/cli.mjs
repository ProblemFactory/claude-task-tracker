#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'fs';
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

Usage:
  claude-task-tracker install     Install hooks into Claude Code settings
  claude-task-tracker uninstall   Remove hooks from Claude Code settings
  claude-task-tracker status      Show worker and hook status
  claude-task-tracker start       Start the worker manually
  claude-task-tracker stop        Stop the worker
  claude-task-tracker dashboard   Open the dashboard URL
  claude-task-tracker help        Show this help
`);
}

function getSettingsPath() {
  return join(homedir(), '.claude', 'settings.json');
}

function loadSettings() {
  const path = getSettingsPath();
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return {}; }
}

function saveSettings(settings) {
  writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
}

function hookCommand() {
  return `node ${join(SRC_DIR, 'hook.mjs')}`;
}

function install() {
  const settings = loadSettings();
  if (!settings.hooks) settings.hooks = {};

  const events = {
    SessionStart: { timeout: 5 },
    UserPromptSubmit: { timeout: 30 },
    Stop: { timeout: 30 },
  };

  const cmd = hookCommand();
  let modified = false;

  for (const [event, opts] of Object.entries(events)) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Check if already installed
    const existing = settings.hooks[event].find(entry => {
      const hooks = entry.hooks || [];
      return hooks.some(h => h.command && h.command.includes('task-tracker'));
    });

    if (existing) {
      console.log(`  ${event}: already installed`);
      continue;
    }

    settings.hooks[event].push({
      hooks: [{ type: 'command', command: cmd, timeout: opts.timeout }],
    });
    modified = true;
    console.log(`  ${event}: installed (timeout: ${opts.timeout}s)`);
  }

  if (modified) {
    saveSettings(settings);
    console.log('\nHooks installed. Restart Claude Code for changes to take effect.');
  } else {
    console.log('\nAll hooks already installed.');
  }
}

function uninstall() {
  const settings = loadSettings();
  if (!settings.hooks) { console.log('No hooks found.'); return; }

  let modified = false;
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    if (!settings.hooks[event]) continue;
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(entry => {
      const hooks = entry.hooks || [];
      return !hooks.some(h => h.command && h.command.includes('task-tracker'));
    });
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
    if (settings.hooks[event]?.length !== before) {
      modified = true;
      console.log(`  ${event}: removed`);
    }
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  if (modified) {
    saveSettings(settings);
    console.log('\nHooks removed. Restart Claude Code for changes to take effect.');
  } else {
    console.log('No task-tracker hooks found.');
  }
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

  // Check PID file
  let pidInfo = null;
  try {
    pidInfo = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
    process.kill(pidInfo.pid, 0);
  } catch { pidInfo = null; }

  // Check worker health
  const health = await workerGet('/health');

  console.log('Task Tracker Status');
  console.log('─'.repeat(40));

  if (health?.status === 'ok') {
    console.log(`  Worker:    running (pid ${health.pid}, port ${port})`);
    console.log(`  Uptime:    ${Math.floor(health.uptime)}s`);
    console.log(`  SDK:       ${health.sdkLoaded ? 'loaded' : 'NOT loaded'}`);
  } else if (pidInfo) {
    console.log(`  Worker:    stale PID file (pid ${pidInfo.pid})`);
  } else {
    console.log('  Worker:    not running');
  }

  console.log(`  Dashboard: http://127.0.0.1:${port}/`);
  console.log(`  Data dir:  ${DATA_DIR}`);

  // Check hooks
  const settings = loadSettings();
  const hooks = settings.hooks || {};
  const events = ['SessionStart', 'UserPromptSubmit', 'Stop'];
  let hooksInstalled = 0;
  for (const event of events) {
    const installed = (hooks[event] || []).some(entry =>
      (entry.hooks || []).some(h => h.command && h.command.includes('task-tracker'))
    );
    if (installed) hooksInstalled++;
  }
  console.log(`  Hooks:     ${hooksInstalled}/3 installed`);

  // Task stats
  try {
    const r = await workerGet('/api/tasks');
    if (r?.tasks) {
      const done = r.tasks.filter(t => t.status === 'done').length;
      console.log(`  Tasks:     ${r.tasks.length} total, ${r.tasks.length - done} active, ${done} done`);
    }
  } catch {}
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

// Dispatch
switch (command) {
  case 'install': install(); break;
  case 'uninstall': uninstall(); break;
  case 'status': status(); break;
  case 'start': start(); break;
  case 'stop': stop(); break;
  case 'dashboard': dashboard(); break;
  case 'help': case '--help': case '-h': case undefined: usage(); break;
  default: console.error(`Unknown command: ${command}`); usage(); process.exit(1);
}
