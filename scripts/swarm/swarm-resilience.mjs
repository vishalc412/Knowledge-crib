/** Hostile and broken clients must not take the daemon down or corrupt a neighbour's answer. */
const PORT = Number(process.argv[2]);
const URL = `http://127.0.0.1:${PORT}/`;
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const raw = async (body, headers = H, method = 'POST') => {
  try { const r = await fetch(URL, { method, headers, body }); return { s: r.status, t: (await r.text()).slice(0, 120) }; }
  catch (e) { return { s: 0, t: String(e).slice(0, 80) }; }
};
const checks = [];
const check = (name, pass, detail) => { checks.push({ name, pass, detail }); };

// 1. Malformed JSON
let r = await raw('{not json');
check('malformed JSON rejected, not crashed', r.s === 400 || r.s === 406, `status ${r.s}`);

// 2. Valid JSON, not JSON-RPC
r = await raw(JSON.stringify({ hello: 'world' }));
check('non-JSON-RPC body handled', r.s >= 200 && r.s < 500, `status ${r.s}`);

// 3. Unknown tool
await raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }));
r = await raw(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }));
check('unknown tool returns an error, not a crash', r.s === 200 && r.t.includes('error'), `status ${r.s}`);

// 4. Missing required argument
r = await raw(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'brief', arguments: {} } }));
check('missing argument returns an error', r.s === 200 && r.t.includes('error'), `status ${r.s}`);

// 5. Enormous query string (resource exhaustion attempt)
r = await raw(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'brief', arguments: { q: 'x'.repeat(200000) } } }));
check('200KB query survived', r.s === 200, `status ${r.s}`);

// 6. GET is refused
r = await raw(undefined, H, 'GET');
check('GET refused', r.s === 405 || r.s === 400 || r.s === 406, `status ${r.s}`);

// 7. Clients that hang up mid-flight must not affect a neighbour
const aborts = Array.from({ length: 50 }, () => {
  const ac = new AbortController();
  const p = fetch(URL, { method: 'POST', headers: H, signal: ac.signal,
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'brief', arguments: { q: 'soul store' } } }) }).catch(() => {});
  setTimeout(() => ac.abort(), 5);
  return p;
});
await Promise.all(aborts);
r = await raw(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'brief', arguments: { q: 'how do I debug a parser that hangs' } } }));
check('survives 50 aborted requests, still correct', r.s === 200 && !r.t.includes('"error"'), `status ${r.s}`);

// 8. Still healthy at the end
const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json().catch(() => ({}));
check('daemon still healthy after abuse', h.ok === true, JSON.stringify(h));

let failed = 0;
for (const c of checks) { if (!c.pass) failed++; console.log(`  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.name}${c.pass ? '' : `  (${c.detail})`}`); }
console.log(failed ? `\n${failed} resilience check(s) failed` : '\nall resilience checks passed');
process.exit(failed ? 1 : 0);
