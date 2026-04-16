// Lightweight BM25-style ranker over tasks — zero dependencies.
// Used by the AI's task-search tool to find relevant tasks without
// having to embed the full task list in the prompt.

const STOP = new Set(['the','a','an','is','are','was','were','be','to','of','in','on','at','for','and','or','but','with','by','from','as','it','this','that','these','those','not']);

function tokenize(s) {
  if (!s) return [];
  return String(s).toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-_#./]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP.has(t));
}

function tf(tokens) {
  const m = {};
  for (const t of tokens) m[t] = (m[t] || 0) + 1;
  return m;
}

// Build an index over tasks and return a search function.
// Each task is represented by its title (weight 3), tags (weight 2), category (weight 2), context (weight 1), notes (weight 1).
export function buildIndex(tasks) {
  const docs = tasks.map(t => {
    const parts = [
      (t.title || '').repeat(3),
      (Array.isArray(t.tags) ? t.tags : []).join(' ').repeat(2),
      (t.category || '').repeat(2),
      t.context || '',
      t.notes || '',
    ].join(' ');
    return { id: t.id, tokens: tokenize(parts), task: t };
  });

  const N = docs.length || 1;
  const df = {};
  for (const d of docs) {
    const seen = new Set(d.tokens);
    for (const t of seen) df[t] = (df[t] || 0) + 1;
  }
  const avgdl = docs.reduce((s, d) => s + d.tokens.length, 0) / N || 1;
  const k1 = 1.5, b = 0.75;

  for (const d of docs) {
    d.tf = tf(d.tokens);
    d.len = d.tokens.length;
  }

  return function search(query, limit = 10) {
    const qTokens = tokenize(query);
    if (!qTokens.length) return [];
    const scores = [];
    for (const d of docs) {
      let score = 0;
      for (const qt of qTokens) {
        if (!(qt in d.tf)) continue;
        const idf = Math.log(1 + (N - (df[qt] || 0) + 0.5) / ((df[qt] || 0) + 0.5));
        const termFreq = d.tf[qt];
        const norm = termFreq * (k1 + 1) / (termFreq + k1 * (1 - b + b * d.len / avgdl));
        score += idf * norm;
      }
      if (score > 0) scores.push({ task: d.task, score });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit).map(s => s.task);
  };
}
