#!/usr/bin/env node
'use strict';
/**
 * warframe-wiki - MCP server for the official WARFRAME Wiki (wiki.warframe.com).
 *
 * Zero dependencies. Node 18+. Speaks MCP over stdio (newline-delimited JSON-RPC).
 *
 * Unlike the Stellaris wiki, wiki.warframe.com is NOT behind a bot challenge, so this
 * server queries the MediaWiki Action API directly on every call (with an in-memory
 * cache). Nothing to download, nothing to keep in sync - it is always current.
 *
 * Built for the Warframe Guide agent, whose job is to answer "what does this mean?"
 * from a screenshot, a tooltip, or a half-remembered name - at any level, from
 * "I installed this yesterday" to "I min-max Archon Shard breakpoints".
 */

const fs = require('fs');
const path = require('path');

const wiki = require('./lib/wiki');
const guide = require('./lib/guide');

const DATA = path.join(__dirname, 'data');
function readData(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
  } catch (e) {
    return fallback;
  }
}
const GLOSSARY = readData('glossary.json', { entries: {} }).entries || {};
const UI_TERMS = readData('ui_terms.json', { terms: {} }).terms || {};
const PATHS = readData('learning_paths.json', { paths: {} }).paths || {};

const SERVER_INFO = { name: 'warframe-wiki', version: '1.0.0' };

// ---------------------------------------------------------------- utilities

function out(s) {
  return { content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] };
}
function err(s) {
  return { content: [{ type: 'text', text: 'ERROR: ' + s }], isError: true };
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Similarity ratio, 0..1 - used for fuzzy name resolution. */
function similarity(a, b) {
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  // normalised Levenshtein similarity
  const rows = [Array.from({ length: B.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= A.length; i++) {
    const row = [i];
    for (let j = 1; j <= B.length; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      row[j] = Math.min(rows[i - 1][j] + 1, row[j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
    rows.push(row);
  }
  const dist = rows[A.length][B.length];
  return 1 - dist / Math.max(A.length, B.length);
}

function truncate(text, maxChars) {
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return { text, cut: false };
  const cut = text.slice(0, maxChars);
  for (const sep of ['\n\n', '. ', '\n']) {
    const i = cut.lastIndexOf(sep);
    if (i > maxChars * 0.6) {
      return { text: cut.slice(0, i + sep.length).trim() + '\n\n... [truncated]', cut: true };
    }
  }
  return { text: cut.trim() + ' ... [truncated]', cut: true };
}

function stripMarkup(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim();
}

/** Where does this page sit in the learning paths? Used to give a "next step". */
function pathContext(pageTitle) {
  const target = norm(pageTitle);
  if (!target) return null;
  for (const [key, p] of Object.entries(PATHS)) {
    const steps = p.steps || [];
    const idx = steps.findIndex((s) => norm(s.page) === target);
    if (idx === -1) continue;
    const next = steps[idx + 1];
    return {
      path: key,
      title: p.title,
      step: idx + 1,
      of: steps.length,
      why: steps[idx].why,
      next: next ? { page: next.page, why: next.why } : null,
    };
  }
  return null;
}

// ---------------------------------------------------------------- name resolution

/**
 * Fuzzy-resolve a possibly-wrong name into real wiki titles.
 * Sources: direct title lookup (handles redirects), prefix scan, full-text search,
 * then a similarity sweep over everything we saw.
 */
async function resolveName(name, limit = 5) {
  const wanted = norm(name);
  if (!wanted) return [];
  const candidates = new Map();

  const add = (title, source, score) => {
    if (!title) return;
    const cur = candidates.get(title);
    if (!cur || score > cur.score) candidates.set(title, { title, source, score });
  };

  const direct = await wiki.api({ action: 'query', titles: name, redirects: '1' });
  for (const page of Object.values(direct.query.pages || {})) {
    if (page.missing) continue;
    if (norm(page.title) === wanted) add(page.title, 'exact title', 1.0);
    else add(page.title, 'redirect', 0.95);
  }

  const prefixData = await wiki.api({
    action: 'query', list: 'allpages', apprefix: String(name).trim(),
    aplimit: '15', apnamespace: '0',
  });
  const prefixHits = (prefixData.query && prefixData.query.allpages) || [];
  for (const p of prefixHits) {
    const nt = norm(p.title);
    if (nt === wanted) add(p.title, 'exact', 1.0);
    else if (nt.startsWith(wanted)) add(p.title, 'prefix', 0.85);
    else add(p.title, 'prefix', 0.5);
  }

  const searchData = await wiki.search(name, 10);
  searchData.results.forEach((r, rank) => {
    const sim = similarity(wanted, r.title);
    add(r.title, 'search', 0.45 + 0.4 * sim - 0.01 * rank);
  });

  for (const p of prefixHits) {
    const sim = similarity(wanted, p.title);
    if (sim > 0.72) add(p.title, 'similar', 0.4 + 0.5 * sim);
  }

  // Redirects are real pages, so a misspelled redirect (e.g. "Galvinized mods") will
  // show up in the prefix scan and beat the page it points at. Prefer the target.
  const titles = [...candidates.keys()];
  const isRedirect = new Set();
  const pointsTo = new Map();
  for (let i = 0; i < titles.length; i += 20) {
    const chunk = titles.slice(i, i + 20);
    const d = await wiki.api({ action: 'query', titles: chunk.join('|'), redirects: '1' });
    for (const r of (d.query && d.query.redirects) || []) {
      isRedirect.add(r.from);
      pointsTo.set(r.from, r.to);
    }
  }

  for (const [title, c] of [...candidates.entries()]) {
    if (!isRedirect.has(title)) continue;
    const target = pointsTo.get(title);
    candidates.delete(title);
    if (!target) continue;
    if (candidates.has(target)) {
      // target is already a candidate - just make sure it is at least as good
      const t = candidates.get(target);
      if (c.score > t.score) candidates.set(target, { title: target, source: 'redirect target', score: c.score });
    } else {
      candidates.set(target, { title: target, source: 'redirect target', score: Math.min(c.score, 0.92) });
    }
  }

  return [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

const confidence = (score) => (score >= 0.9 ? 'high' : score >= 0.6 ? 'medium' : 'low');

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'warframe_readme',
    description:
      'READ THIS FIRST. Returns the teaching contract for this agent: how to answer Warframe ' +
      'questions for a new player vs an advanced player, how to handle screenshot questions, ' +
      'and the rule about never inventing numbers. Call this at the start of a session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'warframe_explain',
    description:
      'Explain a Warframe term, item, mod, resource or system. Resolves sloppy names, gives a ' +
      'summary, tells you where it sits in progression, and lists sections for deeper reading. ' +
      'This is the fastest path from "what does this mean?" to a grounded answer.',
    inputSchema: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'What to explain, e.g. "Viral damage", "Netracells", "Orokin Cell".' },
        level: {
          type: 'string',
          enum: ['beginner', 'advanced', 'auto'],
          description: 'Depth to pitch at. Beginner = short, one thing to do next. Advanced = full numbers. Default auto.',
        },
        maxChars: { type: 'number', description: 'Cap on article text returned (0 = no limit).' },
      },
      required: ['term'],
      additionalProperties: false,
    },
  },
  {
    name: 'warframe_search',
    description: 'Full-text search the WARFRAME Wiki. Returns ranked article titles with snippets and URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        limit: { type: 'number', description: 'Max results (1-30).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'warframe_get_page',
    description:
      'Read a wiki article, or just one section of it. Pass a heading name ("Acquisition", ' +
      '"Crafting", "Drop Locations"), a numeric index, or "0" for the intro. Works on hub pages ' +
      'whose sections are transcluded from subpages. Tables (crafting costs, drop tables) preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Exact article title (use warframe_resolve first if unsure).' },
        section: { type: 'string', description: 'Optional heading name, numeric index, or "0" for the intro.' },
        maxChars: { type: 'number', description: 'Cap on returned characters (0 = no limit).' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'warframe_outline',
    description: 'List the section headings of an article, so you can then read only the relevant part.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Exact article title.' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'warframe_related',
    description:
      'Find what is related to a page: subpages, categories, outgoing links and pages that link back. ' +
      'Good for "what else is in this family" and "where does this drop".',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Exact article title.' },
        limit: { type: 'number', description: 'Max items per group (default 15).' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'warframe_resolve',
    description:
      'Fuzzy-resolve a possibly misspelled, OCR\'d or shorthand name into real wiki titles with ' +
      'confidence scores. Use FIRST when the name came off a screenshot or from a player typing fast.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The raw, possibly wrong, name.' },
        limit: { type: 'number', description: 'How many candidates (1-10).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'warframe_glossary',
    description:
      'Look up Warframe slang and abbreviations (MR, endo, forma, potato, ESO, radshare, shield gating, ' +
      'COBWEB...). Always run this when you or the player use shorthand. Omit term to list all known terms.',
    inputSchema: {
      type: 'object',
      properties: { term: { type: 'string', description: 'Slang term or abbreviation. Omit to list all.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'warframe_ui_hint',
    description:
      'Map text from a screenshot (a UI label, menu name, tooltip header or HUD stat) to the wiki page ' +
      'that explains it. A new player usually cannot look something up because they do not know its name - ' +
      'this is the translation layer. Falls back to wiki search.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text as read from the screenshot.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'warframe_learning_path',
    description:
      'Return an ordered progression path: what to learn, in what order, and why. Use it to place the ' +
      'player on the map and to pick a sensible next step. Omit path to list available paths.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path id, e.g. "absolute-beginner", "getting-stronger", "endgame-loop". Omit to list all.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'warframe_guide',
    description:
      'Search the bundled Lucky Ghost "Complete Beginner Guide" video transcript (2h49m, 67 chapters). ' +
      'Returns matching passages with timestamps into the video. Great for "how would a guide explain this?".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or phrase.' },
        maxResults: { type: 'number', description: 'Passages to return (1-10, default 3).' },
        chapters: { type: 'boolean', description: 'Return the chapter list instead of searching.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'warframe_screenshot',
    description:
      'Helper for the screenshot workflow. Takes whatever text the player or OCR gave you, figures out ' +
      'what it is (UI label, item, mod, slang), and returns a bundle: resolved wiki page, glossary hits, ' +
      'beginner-safe summary, and where to read more. Call this when someone pastes/a screenshot with ' +
      '"what does this mean?".',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text visible in the screenshot (any messiness is fine).' },
        level: { type: 'string', enum: ['beginner', 'advanced', 'auto'], description: 'Depth to pitch at.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------- handlers

async function handleExplain(term, level = 'auto', maxChars) {
  const wanted = norm(term);
  const limit = level === 'advanced' ? maxChars || 12000 : maxChars || 2600;

  // 1. resolve to a real page
  let title = term;
  let resolvedNote = '';
  const direct = await wiki.api({ action: 'query', titles: term, redirects: '1' });
  const page = Object.values(direct.query.pages || {}).find((p) => !p.missing);
  if (page) {
    title = page.title;
  } else {
    const hits = await wiki.search(term, 5);
    if (hits.results.length) {
      const best = hits.results
        .map((h) => ({ h, s: similarity(wanted, h.title) }))
        .sort((a, b) => b.s - a.s)[0].h;
      title = best.title;
      if (norm(title) !== wanted) resolvedNote = `(resolved "${term}" -> "${title}")`;
    }
  }

  const extract = await wiki.getExtract(title, level !== 'advanced');
  if (!extract.found || !extract.text) {
    return out(
      `No WARFRAME Wiki article found for "${term}".\n\n` +
        `Try warframe_search("${term}") to see what exists, or warframe_glossary if it might be slang.`
    );
  }

  const { text, cut } = truncate(extract.text, limit);
  const lines = [
    `# ${extract.title}`,
    wiki.pageUrl(extract.title),
    resolvedNote,
    '',
    text,
  ].filter((l, i) => !(i === 2 && !resolvedNote));

  if (cut) {
    lines.push('', '(truncated - use warframe_get_page with a section name for more depth)');
  }

  // slang, if this term is one
  const gKey = Object.keys(GLOSSARY).find((k) => norm(k) === wanted);
  if (gKey) lines.push('', `Slang note - "${gKey}": ${GLOSSARY[gKey]}`);

  // where in progression
  const ctx = pathContext(extract.title);
  if (ctx) {
    lines.push('', `Progression: step ${ctx.step} of ${ctx.of} in "${ctx.title}". ${ctx.why}`);
    if (ctx.next) lines.push(`Next: ${ctx.next.page} - ${ctx.next.why}`);
  }

  // sections for follow-up
  const sections = await wiki.getSections(extract.title).catch(() => []);
  if (sections.length) {
    lines.push('', 'Sections:');
    for (const s of sections) {
      lines.push(`  - ${s.line}${s.fromtitle && s.fromtitle !== extract.title ? `  (from ${s.fromtitle})` : ''}`);
    }
    lines.push('', 'Read one with warframe_get_page(title, section="<heading>").');
  }

  return out(lines.join('\n'));
}

async function handleScreenshot(text, level = 'auto') {
  const raw = String(text || '').trim();
  if (!raw) return err('No text provided.');

  const lines = [`Screenshot text: "${raw}"`, ''];

  // 1. exact-ish UI term?
  const key = raw.toLowerCase().trim();
  let page = UI_TERMS[key];
  let how = 'exact UI label';

  // 2. UI term contained in the text?
  if (!page) {
    const lower = raw.toLowerCase();
    const keys = Object.keys(UI_TERMS).sort((a, b) => b.length - a.length);
    const hit = keys.find((k) => k.length > 2 && lower.includes(k));
    if (hit) {
      page = UI_TERMS[hit];
      how = `matched UI label "${hit}"`;
    }
  }

  // 3. glossary slang?
  let slang = null;
  const gKey = Object.keys(GLOSSARY).find((k) => norm(k) === norm(raw));
  if (!gKey) {
    const lower = raw.toLowerCase();
    const keys = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);
    const hit = keys.find((k) => k.length > 1 && new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower));
    if (hit) slang = { term: hit, meaning: GLOSSARY[hit] };
  } else {
    slang = { term: gKey, meaning: GLOSSARY[gKey] };
  }

  if (slang) {
    lines.push(`Slang: "${slang.term}" means: ${slang.meaning}`, '');
  }

  // 4. fall back to fuzzy wiki resolution
  if (!page) {
    const candidates = await resolveName(raw, 3);
    if (candidates.length) {
      page = candidates[0].title;
      how = `wiki match (${confidence(candidates[0].score)} confidence)`;
      lines.push('Candidate wiki pages:');
      for (const c of candidates) lines.push(`  - ${c.title}  [${confidence(c.score)}]`);
      lines.push('');
    }
  } else {
    lines.push(`Identified as: ${page} (${how})`, '');
  }

  if (!page) {
    return out(
      lines.join('\n') +
        `\nCould not identify "${raw}" from UI labels, slang or wiki search.\n` +
        `Next: warframe_search("${raw}"), or ask the player to type the exact wording.`
    );
  }

  // 5. beginner-safe summary
  const isBeginner = level !== 'advanced';
  const extract = await wiki.getExtract(page, isBeginner);
  if (extract.found && extract.text) {
    const { text: body, cut } = truncate(extract.text, isBeginner ? 1800 : 9000);
    lines.push(`# ${extract.title}`, wiki.pageUrl(extract.title), '', body);
    if (cut) lines.push('', '(truncated)');
  } else {
    lines.push(`Wiki page: ${page} - ${wiki.pageUrl(page)}`, '(no plain-text body; it is a hub page)');
  }

  const ctx = pathContext(page);
  if (ctx) {
    lines.push('', `Progression: step ${ctx.step} of ${ctx.of} in "${ctx.title}". ${ctx.why}`);
    if (ctx.next) lines.push(`Next: ${ctx.next.page} - ${ctx.next.why}`);
  }

  const sections = await wiki.getSections(page).catch(() => []);
  if (sections.length) {
    lines.push('', 'Sections:');
    for (const s of sections.slice(0, 20)) lines.push(`  - ${s.line}`);
  }

  return out(lines.join('\n'));
}

const HANDLERS = {
  warframe_readme: async () => out(README_TEXT),

  warframe_explain: async (a) => handleExplain(a.term, a.level, a.maxChars),

  warframe_search: async (a) => {
    const limit = Math.max(1, Math.min(Number(a.limit) || 10, 30));
    const r = await wiki.search(a.query, limit);
    if (!r.results.length) return out(`No WARFRAME Wiki results for "${a.query}".`);
    const lines = [`${r.total} hits for "${a.query}" - showing ${r.results.length}:`, ''];
    r.results.forEach((h, i) => {
      lines.push(`${i + 1}. ${h.title}`);
      lines.push(`   ${wiki.pageUrl(h.title)}`);
      const snip = stripMarkup(h.snippet);
      if (snip) lines.push(`   ${snip}`);
      lines.push('');
    });
    return out(lines.join('\n').trim());
  },

  warframe_get_page: async (a) => {
    if (a.section !== undefined && a.section !== null && String(a.section) !== '') {
      let target;
      try {
        target = await wiki.resolveSection(a.title, a.section);
      } catch (e) {
        return out(String(e.message || e));
      }
      const text = await wiki.getSectionText(target.page, target.index);
      const { text: body, cut } = truncate(text, Number(a.maxChars) || 8000);
      const lines = [
        `# ${a.title} - ${target.heading || 'lead'}`,
        wiki.pageUrl(target.page) + (target.page !== a.title ? `  (section lives on ${target.page})` : ''),
        '',
        body || '(this section has no text - it may be a table or transcluded content)',
      ];
      if (cut) lines.push('', '(truncated)');
      return out(lines.join('\n'));
    }

    const result = await wiki.getExtract(a.title);
    if (!result.found) return out(`Article "${a.title}" not found on the WARFRAME Wiki.`);

    const parts = [result.text];
    const used = [];
    if (result.text.length < 600) {
      const subs = await wiki.listSubpages(a.title, 30).catch(() => []);
      const priority = ['Main', 'Abilities', 'Equip', 'Acquisition', 'Stats', 'Notes', 'Tips'];
      const ordered = subs.sort((x, y) => {
        const ix = priority.findIndex((p) => x.toLowerCase().includes(p.toLowerCase()));
        const iy = priority.findIndex((p) => y.toLowerCase().includes(p.toLowerCase()));
        return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy) || x.localeCompare(y);
      });
      for (const sub of ordered.slice(0, 8)) {
        if (parts.join('\n\n').length > (Number(a.maxChars) || 20000)) break;
        const r = await wiki.getExtract(sub);
        if (r.found && r.text) {
          parts.push(`=== ${sub.split('/').slice(1).join('/')} ===\n${r.text}`);
          used.push(sub);
        }
      }
    }

    const { text: body, cut } = truncate(parts.join('\n\n'), Number(a.maxChars) || 8000);
    const lines = [`# ${result.title}`, wiki.pageUrl(result.title)];
    if (used.length) lines.push(`(auto-expanded with subpages: ${used.join(', ')})`);
    lines.push('', body);
    if (cut) lines.push('', '(truncated - narrow it with warframe_outline + warframe_get_page(section=...))');
    return out(lines.join('\n'));
  },

  warframe_outline: async (a) => {
    const sections = await wiki.getSections(a.title).catch((e) => {
      throw e;
    });
    if (!sections.length) return out(`Article "${a.title}" has no sections (short page or hub page).`);
    const lines = [
      `Sections in ${a.title}  (${wiki.pageUrl(a.title)}):`,
      '',
      `Read one with warframe_get_page(title="${a.title}", section="<heading name>")`,
      '',
    ];
    for (const s of sections) {
      const indent = '  '.repeat(Math.max(0, Number(s.level || 2) - 2));
      const from = s.fromtitle && s.fromtitle !== a.title ? `  <- ${s.fromtitle}` : '';
      lines.push(`- ${indent}${s.line}${from}`);
    }
    return out(lines.join('\n'));
  },

  warframe_related: async (a) => {
    const limit = Math.max(1, Math.min(Number(a.limit) || 15, 50));
    const [subs, cats, links, back] = await Promise.all([
      wiki.listSubpages(a.title, limit).catch(() => []),
      wiki.getCategories(a.title).catch(() => []),
      wiki.getLinks(a.title, limit).catch(() => []),
      wiki.getBacklinks(a.title, limit).catch(() => []),
    ]);
    const lines = [`Related to ${a.title}  (${wiki.pageUrl(a.title)}):`, ''];
    const group = (label, arr) => {
      if (!arr || !arr.length) return;
      lines.push(`${label} (${arr.length}):`);
      for (const t of arr) lines.push(`  - ${t}`);
      lines.push('');
    };
    group('Subpages', subs);
    group('Categories', cats);
    group('Links out', links);
    group('Pages linking here', back);
    return out(lines.join('\n').trim());
  },

  warframe_resolve: async (a) => {
    const limit = Math.max(1, Math.min(Number(a.limit) || 5, 10));
    const ranked = await resolveName(a.name, limit);
    if (!ranked.length) return out(`Could not resolve "${a.name}" to any WARFRAME Wiki page.`);
    const lines = [`Resolved "${a.name}":`, ''];
    ranked.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.title}   [confidence: ${confidence(c.score)}]`);
      lines.push(`   ${wiki.pageUrl(c.title)}`);
      lines.push(`   matched via: ${c.source}`);
      lines.push('');
    });
    const best = ranked[0];
    lines.push(
      `Best match: "${best.title}" (${confidence(best.score)} confidence). ` +
        'Feed that exact title to warframe_get_page or warframe_explain.'
    );
    return out(lines.join('\n').trim());
  },

  warframe_glossary: async (a) => {
    if (!a.term) {
      const keys = Object.keys(GLOSSARY).sort();
      return out(`${keys.length} terms known:\n\n${keys.join(', ')}`);
    }
    const wanted = norm(a.term);
    const exact = Object.keys(GLOSSARY).filter((k) => norm(k) === wanted);
    if (exact.length) {
      return out(exact.map((k) => `${k}: ${GLOSSARY[k]}`).join('\n\n'));
    }
    const partial = Object.keys(GLOSSARY).filter(
      (k) => k.toLowerCase().includes(a.term.toLowerCase()) || norm(k).includes(wanted)
    );
    if (partial.length) {
      return out(
        `No exact entry for "${a.term}". Closest:\n\n` +
          partial.slice(0, 10).map((k) => `${k}: ${GLOSSARY[k]}`).join('\n\n')
      );
    }
    return out(
      `"${a.term}" is not in the glossary.\n\n` +
        `Try warframe_search("${a.term}") or warframe_explain("${a.term}").`
    );
  },

  warframe_ui_hint: async (a) => {
    const raw = String(a.text || '').trim();
    if (!raw) return err('No text provided.');
    const lower = raw.toLowerCase();
    let page = UI_TERMS[lower];
    let how = 'exact UI label';
    if (!page) {
      const keys = Object.keys(UI_TERMS).sort((x, y) => y.length - x.length);
      const hit = keys.find((k) => k.length > 2 && lower.includes(k));
      if (hit) {
        page = UI_TERMS[hit];
        how = `contains UI label "${hit}"`;
      }
    }
    if (page) {
      return out(`"${raw}" -> ${page}  (${how})\n\n${wiki.pageUrl(page)}\n\nRead it: warframe_get_page("${page}")`);
    }
    const r = await wiki.search(raw, 5);
    if (!r.results.length) return out(`No UI-term or wiki match for "${raw}".`);
    const lines = [`No UI-term match for "${raw}". Closest wiki pages:`];
    for (const h of r.results) lines.push(`  - ${h.title}  (${wiki.pageUrl(h.title)})`);
    return out(lines.join('\n'));
  },

  warframe_learning_path: async (a) => {
    if (!a.path) {
      const lines = ['Learning paths available:', ''];
      for (const [key, p] of Object.entries(PATHS)) {
        lines.push(`- ${key}: ${p.title}`);
        lines.push(`    audience: ${p.audience}`);
      }
      lines.push('', 'Call warframe_learning_path(path="<id>") for the ordered steps.');
      return out(lines.join('\n'));
    }
    const p = PATHS[a.path];
    if (!p) {
      return out(`Unknown path "${a.path}".\n\nAvailable: ${Object.keys(PATHS).join(', ')}`);
    }
    const lines = [`# ${p.title}`, `Audience: ${p.audience}`];
    if (p.goal) lines.push(`Goal: ${p.goal}`);
    lines.push('');
    p.steps.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.page}${s.ts ? `  [guide ${s.ts}]` : ''}`);
      lines.push(`   why: ${s.why}`);
    });
    return out(lines.join('\n'));
  },

  warframe_guide: async (a) => {
    if (!guide.available()) {
      return out(`Beginner-guide transcript not available at ${guide.TRANSCRIPT}`);
    }
    if (a.chapters) {
      const ch = guide.chapters();
      const lines = [`Beginner guide chapters (${ch.length}):`, ''];
      for (const c of ch) lines.push(`- ${c.ts}  ${c.title}`);
      return out(lines.join('\n'));
    }
    if (!a.query) return err('Provide a query, or pass chapters=true.');
    const r = guide.search(a.query, Number(a.maxResults) || 3, 900);
    if (!r || !r.passages.length) {
      return out(`No match for "${a.query}" in the beginner guide transcript.`);
    }
    const lines = [`Beginner guide - ${r.total} passages match "${a.query}":`, ''];
    for (const p of r.passages) {
      lines.push(`--- [${p.ts}] ---`);
      lines.push(p.text);
      lines.push('');
    }
    return out(lines.join('\n').trim());
  },

  warframe_screenshot: async (a) => handleScreenshot(a.text, a.level),
};

// ---------------------------------------------------------------- teaching contract

const README_TEXT = `# Warframe Guide agent - teaching contract

The person asking is very often a BRAND-NEW player. Warframe is famously opaque: there are
dozens of currencies, six damage-combining elements, and systems nested inside systems. They
frequently ask by SENDING A SCREENSHOT and asking "what does this mean?". Assume goodwill and
assume confusion.

1. ANSWER, THEN TEACH. "That's your Mod Capacity - it's why your mods stop fitting. Put an
   Orokin Reactor on the frame to double it." Never just dump a wiki excerpt.
2. LEVEL-MATCH. Beginner: one sentence, one thing to do next, zero jargon (or define it).
   Advanced: exact numbers, breakpoints, interactions, scaling. If you cannot tell which,
   DEFAULT TO BEGINNER and offer to go deeper.
3. NEVER INVENT A NUMBER. Warframe is patched constantly and numbers matter. If the tool did
   not return it, either call warframe_get_page for the section that has it, or say you are
   not certain. A confident wrong stat is worse than "let me check".
4. NAME THE THING THEY ARE LOOKING AT. New players cannot look something up because they do
   not know what it is called. Use warframe_screenshot or warframe_ui_hint to translate
   screenshot text -> wiki page.
5. EXPLAIN SLANG. Warframe's community shorthand is brutal (MR, endo, forma, potato, ESO,
   radshare, shield gating, COBWEB). Run warframe_glossary and define it, every time.
6. GIVE THE NEXT ACTION. End with what to click, craft, or equip. Teaching beats trivia.
7. USE THE WIKI, DON'T RECITE IT. Always ground answers in a tool call and cite the page URL
   so the player can read further.

## Typical flows

Screenshot + "what is this?"
  warframe_screenshot(text)        -> identifies, summarises, places it in progression
  warframe_glossary(term)          -> if it turned out to be slang
  warframe_get_page(section=...)   -> exact numbers when they ask

Plain question: "what are archon shards?"
  warframe_explain("archon shards", level="beginner")
  warframe_guide("archon shard")   -> how the bundled guide explains it, with timestamp

"I'm new, where do I start?"
  warframe_learning_path("absolute-beginner")

Someone pasted a garbled name:
  warframe_resolve("galvinized mods")  -> "Galvanized Mods" (high confidence)

## Levels

- beginner  : short summary (warframe_explain caps it), plain words, one next step
- advanced  : full article text, numbers, interactions
- auto      : infer from how the question is phrased; when in doubt, beginner

## How not to answer

- Do not say "just mod it" without saying which mod and why.
- Do not suggest Platinum purchases for anything obtainable by playing.
- Do not assume a slow player is a leech. They may be on their first week.
- Do not repeat the wiki verbatim - translate it.`;

// ---------------------------------------------------------------- JSON-RPC plumbing

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params && params.protocolVersion ? params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });

      case 'notifications/initialized':
      case 'initialized':
        return; // notification, no reply

      case 'tools/list':
        return reply({ tools: TOOLS });

      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const fn = HANDLERS[name];
        if (!fn) return fail(-32601, `Unknown tool: ${name}`);
        try {
          return reply(await fn(args));
        } catch (e) {
          return reply(err(`${name} failed: ${e && e.message ? e.message : e}`));
        }
      }

      case 'resources/list':
        return reply({ resources: [] });
      case 'prompts/list':
        return reply({ prompts: [] });

      case 'ping':
        return reply({});

      default:
        if (String(method || '').startsWith('notifications/')) return;
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return fail(-32603, `Internal error: ${e && e.message ? e.message : e}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      process.stderr.write('parse error: ' + e.message + '\n');
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

process.on('uncaughtException', (e) =>
  process.stderr.write('uncaught: ' + (e && e.stack ? e.stack : e) + '\n')
);
