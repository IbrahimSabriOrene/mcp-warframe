'use strict';
/**
 * Stdio smoke test for the warframe-wiki MCP server.
 * Usage: node test/smoke.js
 *
 * Spawns the server, speaks JSON-RPC over newline-delimited stdio, and calls every
 * tool. A case fails if the server errors, returns nothing, or returns a stack trace.
 */
const { spawn } = require('child_process');
const path = require('path');

const server = path.join(__dirname, '..', 'server.js');
const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buffer += d;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('timeout: ' + method));
      }
    }, 60000);
  });
}

/** Notifications carry no id and get no reply. */
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const CASES = [
  ['warframe_readme', {}],
  ['warframe_search', { query: 'archon shard', limit: 3 }],
  ['warframe_resolve', { name: 'galvinized mods', limit: 3 }],
  ['warframe_resolve', { name: 'excalibur umbra', limit: 3 }],
  ['warframe_explain', { term: 'Viral', level: 'beginner' }],
  ['warframe_explain', { term: 'Netracells', level: 'beginner' }],
  ['warframe_explain', { term: 'Orokin Cell', level: 'advanced', maxChars: 1500 }],
  ['warframe_outline', { title: 'Excalibur' }],
  ['warframe_get_page', { title: 'Excalibur', maxChars: 2000 }],
  // hub page + transcluded section: the index is "T-1", not numeric
  ['warframe_get_page', { title: 'Saryn', section: 'Crafting', maxChars: 1200 }],
  ['warframe_get_page', { title: 'Saryn', section: '2', maxChars: 600 }],
  ['warframe_get_page', { title: 'Saryn', section: 'Nonexistent Section' }],
  ['warframe_get_page', { title: 'Damage/Viral Damage', section: 'Viral Sources', maxChars: 900 }],
  ['warframe_related', { title: 'Argon Crystal', limit: 6 }],
  ['warframe_glossary', { term: 'potato' }],
  ['warframe_glossary', { term: 'ESO' }],
  ['warframe_glossary', {}],
  ['warframe_ui_hint', { text: 'Mod Capacity' }],
  ['warframe_ui_hint', { text: 'MASTERY RANK 4' }],
  ['warframe_ui_hint', { text: 'zzzz not a real label' }],
  ['warframe_learning_path', {}],
  ['warframe_learning_path', { path: 'absolute-beginner' }],
  ['warframe_learning_path', { path: 'endgame-loop' }],
  ['warframe_guide', { chapters: true }],
  ['warframe_guide', { query: 'endo farm', maxResults: 2 }],
  ['warframe_screenshot', { text: 'Mod Capacity 12 / 30' }],
  ['warframe_screenshot', { text: 'what is a radshare' }],
  ['warframe_screenshot', { text: 'Archon Shard' }],
];

(async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0' },
  });
  console.log('initialized:', init.result && init.result.serverInfo);

  notify('notifications/initialized', {});

  const tools = await rpc('tools/list', {});
  const names = tools.result.tools.map((t) => t.name).sort();
  console.log(`\ntools exposed (${names.length}):`);
  for (const n of names) console.log('  - ' + n);
  console.log('');

  let failures = 0;
  for (const [name, args] of CASES) {
    let res;
    try {
      res = await rpc('tools/call', { name, arguments: args });
    } catch (e) {
      console.log(`[FAIL] ${name} ${JSON.stringify(args)} -> ${e.message}`);
      failures++;
      continue;
    }

    const result = res.result || {};
    const text = ((result.content || [])[0] || {}).text || '';
    const bad = result.isError || !text.trim() || /^\s*at .+\(.*:\d+:\d+\)/m.test(text);

    if (bad) failures++;
    console.log(`[${bad ? 'FAIL' : 'ok'}] ${name} ${JSON.stringify(args)}`);
    console.log('        ' + text.slice(0, 200).replace(/\n/g, ' \u21b3 '));
    console.log('');
  }

  console.log('='.repeat(60));
  if (failures) {
    console.log(`${failures} FAILED`);
    child.kill();
    process.exit(1);
  }
  console.log('ALL PASSED');
  child.kill();
  process.exit(0);
})();
