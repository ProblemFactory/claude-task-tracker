import { readFileSync, existsSync, openSync, readSync, closeSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { loadConfig } from './config.mjs';

// ── Transcript ──

export function readTranscriptDelta(transcriptPath, lastOffset) {
  let stat;
  try { stat = statSync(transcriptPath); } catch { return { messages: [], newOffset: lastOffset }; }
  if (stat.size <= lastOffset) return { messages: [], newOffset: lastOffset };

  const fd = openSync(transcriptPath, 'r');
  const buf = Buffer.alloc(stat.size - lastOffset);
  readSync(fd, buf, 0, buf.length, lastOffset);
  closeSync(fd);

  const messages = [];
  for (const line of buf.toString('utf-8').split('\n')) {
    if (!line) continue;
    try { messages.push(JSON.parse(line)); } catch {}
  }
  return { messages, newOffset: stat.size };
}

export function summarizeMessages(messages, maxChars, { skipToolResults = false, source = 'claude' } = {}) {
  const config = loadConfig();
  maxChars = maxChars || config.maxSummaryChars;
  if (source === 'codex') return summarizeCodexMessages(messages, maxChars, skipToolResults);
  const parts = [];
  let total = 0;
  for (const msg of messages) {
    if (total >= maxChars) break;
    const text = extractContent(msg, skipToolResults);
    if (!text) continue;
    const role = msg.type === 'human' ? 'User' : msg.type === 'assistant' ? 'Claude' : msg.type;
    const line = `[${role}]: ${text}`;
    parts.push(line);
    total += line.length;
  }
  return parts.join('\n\n');
}

function summarizeCodexMessages(messages, maxChars, skipToolResults) {
  const parts = [];
  let total = 0;
  for (const msg of messages) {
    if (total >= maxChars) break;
    const p = msg.payload || msg;
    const type = msg.type || p.type;
    let role = '', text = '';

    if (type === 'event_msg' && p.type === 'user_message') {
      role = 'User';
      text = p.message || '';
    } else if (type === 'event_msg' && p.type === 'agent_message') {
      role = 'Codex';
      text = p.message || '';
    } else if (type === 'response_item' && p.type === 'message') {
      role = p.role === 'assistant' ? 'Codex' : p.role || 'System';
      text = (p.content || []).filter(b => b.type === 'output_text' || b.type === 'text_block').map(b => b.text).join('\n');
    } else if (type === 'response_item' && p.type === 'function_call') {
      role = 'Codex';
      text = `[Tool: ${p.name}(${(p.arguments || '').slice(0, 120)})]`;
    } else if (type === 'response_item' && p.type === 'function_call_output') {
      if (skipToolResults) continue;
      role = 'Result';
      text = `[Result: ${(p.output || '').slice(0, 200)}]`;
    } else {
      continue;
    }

    if (!text) continue;
    const line = `[${role}]: ${text}`;
    parts.push(line);
    total += line.length;
  }
  return parts.join('\n\n');
}

function extractContent(msg, skipToolResults = false) {
  const c = msg.message?.content;
  if (!c) return '';
  if (typeof c === 'string') return c.slice(0, 1000);
  if (!Array.isArray(c)) return '';
  return c
    .map(b => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `[Tool: ${b.name}(${briefInput(b.input)})]`;
      if (b.type === 'tool_result') {
        if (skipToolResults) return null;
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
        return `[Result: ${t.slice(0, 200)}]`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function briefInput(input) {
  if (!input) return '';
  for (const k of ['command', 'file_path', 'pattern', 'query', 'prompt', 'skill']) {
    if (input[k]) return String(input[k]).slice(0, 120);
  }
  return JSON.stringify(input).slice(0, 120);
}
