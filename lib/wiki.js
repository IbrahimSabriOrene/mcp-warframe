'use strict';
/**
 * Minimal MediaWiki client for the WARFRAME Wiki.
 *
 * Zero dependencies: uses Node's built-in https module.
 * Everything here is read-only.
 *
 * Two wiki-specific quirks are handled, both of which will silently break a naive client:
 *
 *   1. HUB PAGES ARE EMPTY SHELLS. "Excalibur" is a couple hundred bytes of wikitext;
 *      the real body lives in "Excalibur/Main", "Excalibur/Abilities", ... pulled in by
 *      transclusion. prop=extracts still renders them, but short pages need expanding.
 *
 *   2. TRANSCLUDED SECTIONS HAVE FAKE INDICES. Sections inherited from a subpage get ids
 *      like "T-3", which action=parse rejects with `nosuchsection`. The fix is to follow
 *      each section's `fromtitle` back to the page it actually lives on and read the
 *      numeric index there. resolveSection() does that, so callers can just pass a
 *      heading name.
 */

const https = require('https');
const { URL } = require('url');

const API_BASE = process.env.WARFRAME_WIKI_API || 'https://wiki.warframe.com/api.php';
const SITE_BASE = API_BASE.replace(/\/api\.php.*$/, '');
const USER_AGENT =
  process.env.WARFRAME_WIKI_UA || 'WarframeWikiMCP/1.0 (read-only research bot)';
const CACHE_TTL_MS = Number(process.env.WARFRAME_WIKI_TTL || 300) * 1000;
const MIN_INTERVAL_MS = 120; // be polite

// ---------------------------------------------------------------------------
// HTTP + cache
// ---------------------------------------------------------------------------

const cache = new Map();
let lastRequest = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpsGetJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = https.get(
        url,
        { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirects >= 5) return reject(new Error('too many redirects'));
            let next;
            try {
              next = new URL(res.headers.location, url).toString();
            } catch (e) {
              return reject(new Error('bad redirect'));
            }
            return resolve(httpsGetJson(next, redirects + 1));
          }
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(buf));
            } catch (e) {
              reject(new Error('wiki returned non-JSON: ' + buf.slice(0, 160)));
            }
          });
        }
      );
    } catch (e) {
      return reject(e);
    }
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('wiki request timed out')));
  });
}

async function api(params) {
  const q = new URLSearchParams(
    Object.assign({ format: 'json', formatversion: '2', redirects: '1' }, params)
  );
  const key = q.toString();
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.data;

  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequest);
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();

  const data = await httpsGetJson(API_BASE + '?' + key);
  if (data && data.error) {
    throw new Error(data.error.info || data.error.code || 'wiki error');
  }
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, data });
  return data;
}

function pageUrl(title) {
  return SITE_BASE + '/w/' + encodeURIComponent(String(title).replace(/ /g, '_'));
}

// ---------------------------------------------------------------------------
// HTML -> text (tables preserved: crafting costs and drop tables are tables)
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set([
  'br', 'img', 'hr', 'input', 'meta', 'link', 'source',
  'area', 'base', 'col', 'embed', 'param', 'track', 'wbr',
]);
const BLOCK_TAGS = new Set([
  'p', 'div', 'tr', 'table', 'ul', 'ol', 'dl', 'dd', 'dt', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'figure', 'blockquote', 'thead', 'tbody',
]);
const SKIP_CLASS_TOKENS = new Set([
  'mw-editsection', 'reference', 'toc', 'mw-jump-link', 'mw-cite-backlink',
  'sortkey', 'noprint', 'mw-empty-elt', 'mw-references-wrap', 'mf-edit',
  'edit-blueprint', 'mw-editsection-bracket', 'printfooter',
  'button', // in-table UI affordances, e.g. "Edit blueprint requirements"
]);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', times: '\u00d7',
  deg: '\u00b0', plusmn: '\u00b1',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    const named = ENTITIES[code.toLowerCase()];
    return named === undefined ? m : named;
  });
}

function parseTag(token) {
  const isClose = token[1] === '/';
  const selfClose = token.endsWith('/>');
  let body = token.slice(isClose ? 2 : 1, selfClose ? -2 : -1);
  const name = (body.match(/^([a-zA-Z0-9]+)/) || [, ''])[1].toLowerCase();
  const attrs = {};
  const attrRe = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let a;
  const rest = body.slice(name.length);
  while ((a = attrRe.exec(rest)) !== null) {
    attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : '');
  }
  return { name, isClose, selfClose, attrs };
}

/**
 * Convert wiki HTML to readable plain text.
 * Table rows become "cell | cell | cell" on one line — on this wiki that is where
 * crafting requirements, drop tables and stat blocks actually live.
 */
function htmlToText(fragment) {
  if (!fragment) return '';

  let out = '';
  let skipDepth = 0;
  let cell = null; // buffering a <td>/<th>
  let row = []; // cells collected for the current <tr>

  const emit = (text) => {
    if (!text) return;
    if (cell !== null) cell.push(text);
    else out += text;
  };

  const re = /<[^>]+>|[^<]+/g;
  let m;
  while ((m = re.exec(fragment)) !== null) {
    const token = m[0];

    if (token[0] !== '<') {
      if (skipDepth === 0) emit(decodeEntities(token));
      continue;
    }

    const { name, isClose, selfClose, attrs } = parseTag(token);
    if (!name) continue;

    if (skipDepth > 0) {
      if (isClose) skipDepth -= 1;
      else if (!selfClose && !VOID_TAGS.has(name)) skipDepth += 1;
      continue;
    }

    const classes = (attrs.class || '').split(/\s+/).filter(Boolean);
    const shouldSkip =
      name === 'script' ||
      name === 'style' ||
      attrs.id === 'toc' ||
      classes.some((c) => SKIP_CLASS_TOKENS.has(c));

    if (shouldSkip) {
      if (isClose) continue;
      if (!selfClose && !VOID_TAGS.has(name)) skipDepth = 1;
      continue;
    }

    if (isClose) {
      if ((name === 'td' || name === 'th') && cell !== null) {
        const text = cell.join('').replace(/\s+/g, ' ').trim();
        if (text) row.push(text);
        cell = null;
        continue;
      }
      if (name === 'tr') {
        if (row.length) out += '\n' + row.join(' | ') + '\n';
        row = [];
        continue;
      }
      if (/^h[1-6]$/.test(name)) { emit('\n'); continue; }
      if (BLOCK_TAGS.has(name)) { emit('\n'); continue; }
      continue;
    }

    if (selfClose || VOID_TAGS.has(name)) {
      if (name === 'br') emit('\n');
      continue;
    }

    if (/^h[1-6]$/.test(name)) {
      emit('\n\n' + '#'.repeat(Number(name[1])) + ' ');
      continue;
    }
    if (name === 'li') { emit('\n- '); continue; }
    if (name === 'tr') { row = []; continue; }
    if (name === 'td' || name === 'th') { cell = []; continue; }
    if (BLOCK_TAGS.has(name)) { emit('\n'); continue; }
  }

  out = decodeEntities(out)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n *\| *\n/g, '\n') // drop divider rows made of empty cells
    .replace(/\n{3,}/g, '\n\n');

  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// API wrappers
// ---------------------------------------------------------------------------

function firstPage(data) {
  const pages = (data && data.query && data.query.pages) || [];
  const list = Array.isArray(pages) ? pages : Object.values(pages);
  return list.find((p) => p && !p.missing) || null;
}

async function search(query, limit = 10) {
  const data = await api({
    action: 'query', list: 'search', srsearch: query,
    srlimit: String(limit), srnamespace: '0',
  });
  const results = (data.query && data.query.search) || [];
  const total = (data.query && data.query.searchinfo && data.query.searchinfo.totalhits) || results.length;
  return { total, results };
}

async function getExtract(title, introOnly = false) {
  const params = {
    action: 'query', prop: 'extracts', explaintext: '1', titles: title,
  };
  if (introOnly) params.exintro = '1';
  const data = await api(params);
  const page = firstPage(data);
  if (!page) return { found: false, title, text: '' };
  return { found: true, title: page.title || title, text: (page.extract || '').trim() };
}

async function getSections(title) {
  const data = await api({ action: 'parse', page: title, prop: 'sections' });
  return (data.parse && data.parse.sections) || [];
}

async function getSectionText(page, index) {
  const data = await api({ action: 'parse', page, section: String(index), prop: 'text' });
  return htmlToText((data.parse && data.parse.text) || '');
}

async function listSubpages(title, limit = 50) {
  const data = await api({
    action: 'query', list: 'allpages', apprefix: title + '/',
    aplimit: String(limit), apnamespace: '0',
  });
  return ((data.query && data.query.allpages) || []).map((p) => p.title);
}

async function getCategories(title) {
  const data = await api({
    action: 'query', prop: 'categories', titles: title, cllimit: '100',
  });
  const page = firstPage(data);
  if (!page) return null;
  return (page.categories || []).map((c) => String(c.title || '').replace(/^Category:/, ''));
}

async function getCategoryMembers(category, limit = 50, includeSubpages = false) {
  const cmtitle = /^Category:/i.test(category) ? category : 'Category:' + category;
  const data = await api({
    action: 'query', list: 'categorymembers', cmtitle,
    cmlimit: '500', cmnamespace: '0',
  });
  let members = (data.query && data.query.categorymembers) || [];
  if (!includeSubpages) members = members.filter((m) => !String(m.title || '').includes('/'));
  return members.slice(0, limit).map((m) => m.title);
}

async function listPrefix(prefix, limit = 30) {
  const data = await api({
    action: 'query', list: 'allpages', apprefix: prefix,
    aplimit: String(limit), apnamespace: '0',
  });
  return ((data.query && data.query.allpages) || []).map((p) => p.title);
}

async function getBacklinks(title, limit = 30) {
  const data = await api({
    action: 'query', list: 'backlinks', bltitle: title,
    bllimit: String(limit), blnamespace: '0',
  });
  return ((data.query && data.query.backlinks) || []).map((b) => b.title);
}

async function getLinks(title, limit = 50) {
  const data = await api({
    action: 'query', prop: 'links', titles: title, pllimit: String(limit), plnamespace: '0',
  });
  const page = firstPage(data);
  if (!page) return [];
  return (page.links || []).map((l) => l.title);
}

// ---------------------------------------------------------------------------
// Section resolution (handles the transcluded "T-N" indices)
// ---------------------------------------------------------------------------

function normalise(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findHeading(sections, heading) {
  const target = normalise(heading);
  if (!target) return null;
  return (
    sections.find((s) => normalise(s.line) === target) ||
    sections.find((s) => normalise(s.line).includes(target)) ||
    null
  );
}

/**
 * Map a requested section onto {page, index, heading} that action=parse will accept.
 * `section` may be a heading name, a numeric index, or "0"/"lead".
 */
async function resolveSection(title, section) {
  const sections = await getSections(title);
  if (!sections.length) throw new Error(`"${title}" has no readable sections.`);

  const wanted = String(section).trim();
  if (['0', 'lead', 'intro'].includes(wanted.toLowerCase())) {
    return { page: title, index: '0', heading: '' };
  }

  let entry = null;
  if (/^\d+$/.test(wanted)) {
    entry = sections.find((s) => String(s.index) === wanted)
      || sections.find((s) => String(s.number) === wanted);
  }
  if (!entry) entry = findHeading(sections, wanted);
  if (!entry) {
    const names = sections.slice(0, 25).map((s) => s.line).join(', ');
    throw new Error(`No section "${section}" in "${title}". Available: ${names}`);
  }

  const index = String(entry.index || '');
  const heading = entry.line || '';
  const source = entry.fromtitle || title;

  if (index.startsWith('T-') && source && source !== title) {
    const subSections = await getSections(source).catch(() => []);
    const sub = subSections.length ? findHeading(subSections, heading) : null;
    if (sub) return { page: source, index: String(sub.index || '0'), heading };
  }
  return { page: title, index: index || '0', heading };
}

module.exports = {
  api, pageUrl, htmlToText, normalise, findHeading, resolveSection,
  search, getExtract, getSections, getSectionText, listSubpages,
  getCategories, getCategoryMembers, listPrefix, getBacklinks, getLinks,
  SITE_BASE,
};
