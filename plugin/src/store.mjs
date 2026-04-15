import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getDataDir, loadConfig } from './config.mjs';

const DIR = getDataDir();
const DB_PATH = join(DIR, 'tasks.db');
const TASKS_MD = join(DIR, 'TASKS.md');
const OLD_JSON = join(DIR, 'data.json');

export { DIR, TASKS_MD };

let _db = null;

function getDb() {
  if (_db) return _db;
  mkdirSync(DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode=WAL');
  _db.exec('PRAGMA foreign_keys=ON');
  initSchema(_db);
  migrateSchema(_db);
  migrateFromJson(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      notes TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      parent_id INTEGER,
      origin TEXT NOT NULL DEFAULT 'user_initiated',
      origin_reason TEXT DEFAULT '',
      category TEXT DEFAULT '',
      context TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS session_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      project TEXT DEFAULT '',
      role TEXT NOT NULL,
      summary TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS analysis_state (
      session_id TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      analyzed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_links_task ON session_links(task_id);
    CREATE INDEX IF NOT EXISTS idx_links_session ON session_links(session_id);
  `);
}

function migrateSchema(db) {
  const cols = db.prepare("PRAGMA table_info(tasks)").all();
  const has = name => cols.some(c => c.name === name);
  // v1.3.0: origin
  if (!has('origin')) db.exec("ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'user_initiated'");
  // v1.3.0→1.4.0: migrate old origin values
  if (has('origin')) {
    db.exec("UPDATE tasks SET origin = 'user_initiated' WHERE origin = 'user'");
    db.exec("UPDATE tasks SET origin = 'agent_pending' WHERE origin = 'agent'");
  }
  // v1.4.0: new structured fields
  if (!has('origin_reason')) db.exec("ALTER TABLE tasks ADD COLUMN origin_reason TEXT DEFAULT ''");
  if (!has('category')) db.exec("ALTER TABLE tasks ADD COLUMN category TEXT DEFAULT ''");
  if (!has('context')) db.exec("ALTER TABLE tasks ADD COLUMN context TEXT DEFAULT ''");
}

function migrateFromJson(db) {
  if (!existsSync(OLD_JSON)) return;
  // Check if already migrated
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('migrated_json');
  if (row) return;

  let data;
  try { data = JSON.parse(readFileSync(OLD_JSON, 'utf-8')); } catch { return; }

  const insertTask = db.prepare(`
    INSERT OR IGNORE INTO tasks (id, title, status, priority, notes, tags, parent_id, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLink = db.prepare(`
    INSERT INTO session_links (task_id, session_id, project, role, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertState = db.prepare(`
    INSERT OR REPLACE INTO analysis_state (session_id, byte_offset, analyzed_at) VALUES (?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    for (const t of data.tasks || []) {
      insertTask.run(
        t.id, t.title, t.status, t.priority, t.notes || '',
        JSON.stringify(t.tags || []), t.parentId || null,
        t.createdAt, t.updatedAt, t.completedAt || null
      );
    }
    for (const l of data.sessionLinks || []) {
      insertLink.run(l.taskId, l.sessionId, l.project || '', l.role, l.summary || '', l.createdAt);
    }
    for (const [sid, s] of Object.entries(data.analysisState || {})) {
      insertState.run(sid, s.offset || 0, s.analyzedAt || null);
    }
    // Set next id
    const maxId = data.nextId ? data.nextId - 1 : 0;
    if (maxId > 0) {
      db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('next_id', '${maxId}')`);
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('migrated_json', new Date().toISOString());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ── Task CRUD ──

export function getAllTasks() {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks ORDER BY id').all().map(rowToTask);
}

export function getTasksByStatus(status) {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE status = ?').all(status).map(rowToTask);
}

export function getTaskById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return row ? rowToTask(row) : null;
}

export function getSubtasks(parentId) {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE parent_id = ?').all(parentId).map(rowToTask);
}

export function createTask({ title, status, priority, notes, tags, parentId, origin, originReason, category, context }) {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO tasks (title, status, priority, notes, tags, parent_id, origin, origin_reason, category, context, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, status || 'open', priority || 'normal', notes || '', JSON.stringify(tags || []),
    parentId || null, origin || 'user_initiated', originReason || '', category || '', context || '', now, now);
  return Number(result.lastInsertRowid);
}

export function updateTask(id, updates) {
  const db = getDb();
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(updates)) {
    const col = k === 'parentId' ? 'parent_id' : k === 'completedAt' ? 'completed_at' : k === 'updatedAt' ? 'updated_at' : k;
    if (col === 'tags') { sets.push('tags = ?'); vals.push(JSON.stringify(v)); }
    else { sets.push(`${col} = ?`); vals.push(v); }
  }
  if (!sets.some(s => s.startsWith('updated_at'))) {
    sets.push('updated_at = ?');
    vals.push(new Date().toISOString());
  }
  vals.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function taskExistsByTitle(title) {
  const db = getDb();
  return !!db.prepare('SELECT 1 FROM tasks WHERE LOWER(title) = LOWER(?)').get(title);
}

// ── Session Links ──

export function addSessionLink({ taskId, sessionId, project, role, summary }) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT 1 FROM session_links WHERE task_id = ? AND session_id = ? AND role = ?'
  ).get(taskId, sessionId, role);
  if (existing) return;
  db.prepare(`
    INSERT INTO session_links (task_id, session_id, project, role, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(taskId, sessionId, project || '', role, summary || '', new Date().toISOString());
}

export function getRecentLinks(limit) {
  const db = getDb();
  return db.prepare('SELECT * FROM session_links ORDER BY created_at DESC LIMIT ?').all(limit || 50).map(rowToLink);
}

export function getLinksByTaskId(taskId) {
  const db = getDb();
  return db.prepare('SELECT * FROM session_links WHERE task_id = ? ORDER BY created_at').all(taskId).map(rowToLink);
}

// ── Analysis State ──

export function getAnalysisState(sessionId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM analysis_state WHERE session_id = ?').get(sessionId);
  return row ? { offset: row.byte_offset, analyzedAt: row.analyzed_at } : { offset: 0 };
}

export function setAnalysisState(sessionId, offset) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO analysis_state (session_id, byte_offset, analyzed_at)
    VALUES (?, ?, ?)
  `).run(sessionId, offset, new Date().toISOString());
}

// ── Query helpers ──

export function queryTasks({ tag, status, project } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (tag) { sql += ' AND LOWER(tags) LIKE ?'; params.push(`%${tag.toLowerCase()}%`); }

  let tasks = db.prepare(sql).all(...params).map(rowToTask);

  if (project) {
    const linkedIds = new Set(
      db.prepare('SELECT DISTINCT task_id FROM session_links WHERE LOWER(project) LIKE ?')
        .all(`%${project.toLowerCase()}%`)
        .map(r => r.task_id)
    );
    tasks = tasks.filter(t => linkedIds.has(t.id) || (t.tags || []).some(g => g.toLowerCase().includes(project.toLowerCase())));
  }

  return tasks;
}

// ── Row mappers ──

function rowToTask(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    notes: row.notes,
    tags: JSON.parse(row.tags || '[]'),
    parentId: row.parent_id,
    origin: row.origin || 'user_initiated',
    originReason: row.origin_reason || '',
    category: row.category || '',
    context: row.context || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToLink(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    project: row.project,
    role: row.role,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

// ── Markdown export ──

export function renderMarkdown() {
  const config = loadConfig();
  const allTasks = getAllTasks();
  const lines = ['# Task Tracker', '', `> Updated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`, ''];

  const groups = [
    ['in_progress', 'In Progress'],
    ['open', 'Open'],
    ['blocked', 'Blocked'],
    ['done', 'Recently Completed'],
  ];

  for (const [status, label] of groups) {
    let tasks = allTasks.filter(t => t.status === status);
    if (status === 'done') tasks = tasks.slice(-config.recentCompletedLimit);
    if (!tasks.length) continue;

    const roots = tasks.filter(t => !t.parentId);
    const subtaskMap = {};
    for (const t of tasks) {
      if (t.parentId) {
        if (!subtaskMap[t.parentId]) subtaskMap[t.parentId] = [];
        subtaskMap[t.parentId].push(t);
      }
    }

    lines.push(`## ${label}`, '');
    lines.push('| ID | Task | Tags | Updated | Notes |');
    lines.push('|----|------|------|---------|-------|');
    for (const t of roots) {
      const tags = t.tags.length ? t.tags.join(', ') : '';
      const date = (t.updatedAt || t.createdAt || '').slice(0, 10);
      const note = (t.notes || '').split('\n').pop().slice(0, 80);
      const subCount = (subtaskMap[t.id] || []).length;
      const subLabel = subCount ? ` (${subCount} subtasks)` : '';
      lines.push(`| #${t.id} | ${t.title}${subLabel} | ${tags} | ${date} | ${note} |`);
      for (const s of subtaskMap[t.id] || []) {
        const sDate = (s.updatedAt || s.createdAt || '').slice(0, 10);
        const sNote = (s.notes || '').split('\n').pop().slice(0, 60);
        lines.push(`| | \u2514 #${s.id} ${s.title} | | ${sDate} | ${sNote} |`);
      }
    }
    const orphans = tasks.filter(t => t.parentId && !roots.some(r => r.id === t.parentId));
    for (const t of orphans) {
      const tags = t.tags.length ? t.tags.join(', ') : '';
      const date = (t.updatedAt || t.createdAt || '').slice(0, 10);
      const note = (t.notes || '').split('\n').pop().slice(0, 80);
      lines.push(`| #${t.id} | \u2514 ${t.title} (of #${t.parentId}) | ${tags} | ${date} | ${note} |`);
    }
    lines.push('');
  }

  const db = getDb();
  const recentLinks = db.prepare(`
    SELECT sl.*, t.title as task_title FROM session_links sl
    LEFT JOIN tasks t ON t.id = sl.task_id
    ORDER BY sl.created_at DESC LIMIT ?
  `).all(config.recentSessionsLimit * 3);

  const seenSessions = new Set();
  const unique = [];
  for (const l of recentLinks) {
    if (!seenSessions.has(l.session_id) && unique.length < config.recentSessionsLimit) {
      seenSessions.add(l.session_id);
      unique.push(l);
    }
  }
  if (unique.length) {
    lines.push('## Recent Session Activity', '');
    for (const l of unique.reverse()) {
      const date = (l.created_at || '').slice(0, 16).replace('T', ' ');
      lines.push(`- **${date}** [${l.role}] #${l.task_id} ${l.task_title || '?'} \u2014 ${l.summary || ''}`);
    }
    lines.push('');
  }

  const total = allTasks.length;
  const active = allTasks.filter(t => t.status !== 'done').length;
  lines.push('---', `*${total} total tasks, ${active} active*`);
  writeFileSync(TASKS_MD, lines.join('\n'));
}

// ── Legacy compat (for loadData calls in hook.mjs) ──

export function loadData() {
  const tasks = getAllTasks();
  return { tasks };
}
