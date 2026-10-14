'use strict';
/**
 * Searchable index over the bundled beginner-guide transcript.
 *
 * The transcript is the Lucky Ghost "Warframe - Complete Beginner Guide" video
 * (2h49m, 67 chapters) stored as markdown, with "## [mm:ss] CHAPTER" headings.
 * Keeping it here means the agent can quote how a trusted beginner guide explains
 * something, and point the player at the exact moment in the video.
 */

const fs = require('fs');
const path = require('path');

const TRANSCRIPT =
  process.env.WARFRAME_GUIDE_TRANSCRIPT ||
  path.resolve(__dirname, '..', '..', 'data', 'transcript.md');

let cached = null;
let cachedMtime = 0;

function load() {
  try {
    const st = fs.statSync(TRANSCRIPT);
    if (!cached || st.mtimeMs !== cachedMtime) {
      cached = fs.readFileSync(TRANSCRIPT, 'utf8');
      cachedMtime = st.mtimeMs;
    }
    return cached;
  } catch (e) {
    return null;
  }
}

function available() {
  return load() !== null;
}

/** Chapter list, parsed from the "## [mm:ss] Title" headings. */
function chapters() {
  const text = load();
  if (!text) return [];
  const out = [];
  const re = /^## \[(\d{2}:\d{2}(?::\d{2})?)\]\s*(.+)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ ts: m[1], title: m[2].trim() });
  return out;
}

function timestampBefore(text, pos) {
  const idx = text.lastIndexOf('## [', pos);
  if (idx === -1) return '00:00';
  const nl = text.indexOf('\n', idx);
  const line = text.slice(idx, nl === -1 ? idx + 20 : nl);
  const m = line.match(/\[(\d{2}:\d{2}(?::\d{2})?)\]/);
  return m ? m[1] : '00:00';
}

/**
 * Keyword search over the transcript.
 * Nearby hits are clustered so one mention does not produce five near-identical passages.
 */
function search(query, maxResults = 5, contextChars = 900) {
  const text = load();
  if (!text) return null;

  let terms = String(query || '')
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  if (!terms.length) terms = [String(query || '').toLowerCase().trim()].filter(Boolean);
  if (!terms.length) return { total: 0, passages: [] };

  const lowered = text.toLowerCase();
  const hits = [];
  for (const term of terms) {
    let i = lowered.indexOf(term);
    while (i !== -1) {
      hits.push(i);
      if (hits.length >= 4000) break;
      i = lowered.indexOf(term, i + 1);
    }
    if (hits.length >= 4000) break;
  }
  if (!hits.length) return { total: 0, passages: [] };

  hits.sort((a, b) => a - b);

  const clusters = [];
  for (const i of hits) {
    const last = clusters[clusters.length - 1];
    if (last && i - last[last.length - 1] < contextChars) last.push(i);
    else clusters.push([i]);
  }
  clusters.sort((a, b) => b.length - a.length);

  const passages = clusters.slice(0, Math.max(1, Math.min(maxResults, 10))).map((c) => {
    const centre = c[0];
    const start = Math.max(0, centre - Math.floor(contextChars / 3));
    const end = Math.min(text.length, centre + contextChars);
    return {
      ts: timestampBefore(text, centre),
      score: c.length,
      text: text.slice(start, end).trim(),
    };
  });

  return { total: clusters.length, passages };
}

module.exports = { available, chapters, search, TRANSCRIPT };
