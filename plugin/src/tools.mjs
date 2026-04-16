// In-process MCP tools the analysis AI can call to query the task DB.
// Runs inside the Agent SDK subprocess — tool calls don't trigger Claude Code hooks
// (they're intercepted by the SDK MCP transport, never executed by the outer Claude).
import {
  getAllTasks, getTaskById, getSubtasks, queryTasks, getLinksByTaskId
} from './store.mjs';
import { buildIndex } from './search.mjs';
import * as chroma from './chroma.mjs';

// ── Render helpers ──

function renderTaskLine(t) {
  const tags = (t.tags || []).join(',');
  const ctx = t.context ? ` — ${t.context.slice(0, 120)}` : '';
  const parent = t.parentId ? ` (subtask of #${t.parentId})` : '';
  return `[#${t.id}] "${t.title}" (${t.status}/${t.origin}) [${tags}]${parent}${ctx}`;
}

function renderTaskList(tasks) {
  if (!tasks.length) return '(no matching tasks)';
  return tasks.map(renderTaskLine).join('\n');
}

// ── Hybrid search: chroma embeddings first, BM25 fallback ──

export async function hybridSearch(query, limit, { includeDone = false } = {}) {
  const all = getAllTasks();
  const pool = includeDone ? all : all.filter(t => t.status !== 'done');
  const poolIds = new Set(pool.map(t => t.id));

  // Try chroma first
  const chromaIds = await chroma.queryTasks(query, limit * 2).catch(() => null);
  if (chromaIds && chromaIds.length) {
    const byId = new Map(all.map(t => [t.id, t]));
    const hits = chromaIds
      .filter(id => poolIds.has(id))
      .map(id => byId.get(id))
      .filter(Boolean)
      .slice(0, limit);
    if (hits.length) return { source: 'embedding', hits };
  }
  // Fallback: BM25
  const index = buildIndex(pool);
  const hits = index(query, limit);
  return { source: 'bm25', hits };
}

// ── Tools ──

export function buildTools(sdk) {
  const { tool } = sdk;
  const z = sdk.z;
  if (!z) throw new Error('zod not available from SDK');

  return [
    tool(
      'list_tasks',
      'List tasks with optional filters. Returns compact one-line summaries. Use for browsing; use get_task for full details.',
      {
        status: z.string().optional().describe('open, in_progress, done, or blocked'),
        tag: z.string().optional().describe('tag substring match'),
        project: z.string().optional().describe('project/cwd substring from session_links'),
        category: z.string().optional().describe('bugfix, feature, refactor, research, devops, review, documentation, support'),
        origin: z.string().optional().describe('user_initiated, user_confirmed, user_implicit, agent_pending, agent_ignored'),
        parentId: z.number().optional().describe('only direct children of this task id'),
        rootOnly: z.boolean().optional().describe('only top-level tasks (no parent)'),
        limit: z.number().optional().describe('max results, default 30'),
      },
      async (args) => {
        let tasks = queryTasks({ tag: args.tag, status: args.status, project: args.project });
        if (args.category) tasks = tasks.filter(t => t.category === args.category);
        if (args.origin) tasks = tasks.filter(t => t.origin === args.origin);
        if (args.parentId != null) tasks = tasks.filter(t => t.parentId === args.parentId);
        if (args.rootOnly) tasks = tasks.filter(t => !t.parentId);
        const limit = args.limit || 30;
        tasks = tasks.slice(0, limit);
        return { content: [{ type: 'text', text: renderTaskList(tasks) }] };
      }
    ),

    tool(
      'search_tasks',
      'Semantic search over titles/tags/categories/context/notes. Prefers embedding-based (chroma), falls back to BM25. For best results, summarize the conversation topic into 2-3 concise phrases rather than passing raw user message.',
      {
        query: z.string().describe('topic summary — use keywords and noun phrases, not full sentences'),
        limit: z.number().optional().describe('max results, default 10'),
        includeDone: z.boolean().optional().describe('include completed tasks (default false)'),
      },
      async (args) => {
        const { source, hits } = await hybridSearch(args.query, args.limit || 10, { includeDone: !!args.includeDone });
        const header = `(search via ${source})\n`;
        return { content: [{ type: 'text', text: header + renderTaskList(hits) }] };
      }
    ),

    tool(
      'get_task',
      'Get full details of a single task — context, notes, origin_reason history, direct subtasks, recent session links.',
      {
        id: z.number().describe('task id'),
      },
      async (args) => {
        const t = getTaskById(args.id);
        if (!t) return { content: [{ type: 'text', text: `Task #${args.id} not found` }] };
        const subs = getSubtasks(t.id);
        const links = getLinksByTaskId(t.id).slice(-5);
        const lines = [
          `# Task #${t.id} — ${t.title}`,
          `Status: ${t.status} | Priority: ${t.priority} | Category: ${t.category || '-'}`,
          `Origin: ${t.origin}`,
          t.originReason ? `Origin reason history:\n${t.originReason}` : '',
          `Tags: ${(t.tags || []).join(', ')}`,
          t.parentId ? `Parent: #${t.parentId}` : 'Top-level task',
          '',
          `## Context`,
          t.context || '(none)',
          '',
          `## Notes`,
          t.notes || '(none)',
          '',
          subs.length ? `## Direct subtasks (${subs.length})\n${subs.map(renderTaskLine).join('\n')}` : '',
          links.length ? `## Recent sessions\n${links.map(l => `- [${l.role}] ${(l.createdAt || '').slice(0, 16)} @ ${l.project}: ${l.summary || ''}`).join('\n')}` : '',
        ].filter(Boolean);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
    ),

    tool(
      'get_task_tree',
      'Show a task and all its descendants recursively. Use to understand the full scope of a parent task.',
      {
        id: z.number().describe('root task id'),
      },
      async (args) => {
        const root = getTaskById(args.id);
        if (!root) return { content: [{ type: 'text', text: `Task #${args.id} not found` }] };
        const lines = [];
        function walk(t, depth) {
          const indent = '  '.repeat(depth);
          const ctx = t.context ? ` — ${t.context.slice(0, 80)}` : '';
          lines.push(`${indent}[#${t.id}] (${t.status}) ${t.title}${ctx}`);
          for (const c of getSubtasks(t.id)) walk(c, depth + 1);
        }
        walk(root, 0);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
    ),
  ];
}
