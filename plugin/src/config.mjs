import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), '.claude', 'task-tracker');
const CONFIG_FILE = join(DATA_DIR, 'config.json');

const DEFAULTS = {
  // Worker
  port: 37778,
  host: '0.0.0.0',

  // AI
  model: 'sonnet',
  analysisTimeout: 25000,
  maxTurns: 1,

  // Analysis thresholds
  minDeltaChars: 2000,
  minSummaryChars: 100,
  maxPromptChars: 12000,
  maxSummaryChars: 15000,

  // Data
  recentLinksLimit: 50,
  recentSessionsLimit: 10,
  recentCompletedLimit: 20,

  // Language
  language: 'auto',

  // Dashboard
  autoRefreshInterval: 15000,
};

let _config = null;

export function loadConfig() {
  if (_config) return _config;
  mkdirSync(DATA_DIR, { recursive: true });
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {}

  // Env vars override file config (prefix: TASK_TRACKER_)
  const envOverrides = {};
  for (const [key, defaultVal] of Object.entries(DEFAULTS)) {
    const envKey = `TASK_TRACKER_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
    if (process.env[envKey] !== undefined) {
      envOverrides[key] = typeof defaultVal === 'number'
        ? Number(process.env[envKey])
        : process.env[envKey];
    }
  }

  _config = { ...DEFAULTS, ...fileConfig, ...envOverrides };
  return _config;
}

export function saveConfig(updates) {
  mkdirSync(DATA_DIR, { recursive: true });
  let existing = {};
  try { existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')); } catch {}
  const merged = { ...existing, ...updates };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  _config = { ...DEFAULTS, ...merged };
  return _config;
}

export function getDefaults() {
  return { ...DEFAULTS };
}

export function getDataDir() {
  return DATA_DIR;
}

export { DATA_DIR, CONFIG_FILE };
