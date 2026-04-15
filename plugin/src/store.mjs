import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getDataDir, loadConfig } from './config.mjs';

const DIR = getDataDir();
const DATA_FILE = join(DIR, 'data.json');
const TASKS_MD = join(DIR, 'TASKS.md');

export { DIR, TASKS_MD };

export function loadData() {
  mkdirSync(DIR, { recursive: true });
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return { tasks: [], sessionLinks: [], analysisState: {}, nextId: 1 };
  }
}

export function saveData(data) {
  const tmp = DATA_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, DATA_FILE);
}

export function renderMarkdown(data) {
  const config = loadConfig();
  const lines = ['# Task Tracker', '', `> Updated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`, ''];

  const groups = [
    ['in_progress', 'In Progress'],
    ['open', 'Open'],
    ['blocked', 'Blocked'],
    ['done', 'Recently Completed'],
  ];

  for (const [status, label] of groups) {
    let tasks = data.tasks.filter(t => t.status === status);
    if (status === 'done') tasks = tasks.slice(-config.recentCompletedLimit);
    if (!tasks.length) continue;

    lines.push(`## ${label}`, '');
    lines.push('| ID | Task | Tags | Updated | Notes |');
    lines.push('|----|------|------|---------|-------|');
    for (const t of tasks) {
      const tags = t.tags.length ? t.tags.join(', ') : '';
      const date = (t.updatedAt || t.createdAt || '').slice(0, 10);
      const note = (t.notes || '').split('\n').pop().slice(0, 80);
      lines.push(`| #${t.id} | ${t.title} | ${tags} | ${date} | ${note} |`);
    }
    lines.push('');
  }

  const recentLinks = data.sessionLinks.slice(-(config.recentSessionsLimit * 3));
  const seenSessions = new Set();
  const uniqueRecent = [];
  for (let i = recentLinks.length - 1; i >= 0 && uniqueRecent.length < config.recentSessionsLimit; i--) {
    const l = recentLinks[i];
    if (!seenSessions.has(l.sessionId)) {
      seenSessions.add(l.sessionId);
      uniqueRecent.unshift(l);
    }
  }
  if (uniqueRecent.length) {
    lines.push('## Recent Session Activity', '');
    for (const l of uniqueRecent) {
      const task = data.tasks.find(t => t.id === l.taskId);
      const date = (l.createdAt || '').slice(0, 16).replace('T', ' ');
      lines.push(`- **${date}** [${l.role}] #${l.taskId} ${task?.title || '?'} — ${l.summary || ''}`);
    }
    lines.push('');
  }

  lines.push('---', `*${data.tasks.length} total tasks, ${data.tasks.filter(t => t.status !== 'done').length} active*`);
  writeFileSync(TASKS_MD, lines.join('\n'));
}
