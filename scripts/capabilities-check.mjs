/**
 * capabilities-check — the Gate 1.4 single-capability-manifest gate.
 *
 * Closes the "7-wrong-verb-counts" hole: the tool/operation counts used to live only in prose
 * (docs/knowledge-crib-mcp-api.md) and in hand-maintained name arrays, so each surface change left
 * a doc lying with nobody failing a build. Now packages/mcp/src/capabilities.ts is the ONE list —
 * server registration derives its op enums from it and validates the registered names against it
 * (buildServer throws on mismatch), and this gate regenerates the counts FROM the manifest and
 * compares them with what the docs claim.
 *
 * Asserts:
 *   (1) the manifest is internally consistent (no duplicate tools/ops, defaults name real ops);
 *   (2) the registered surface (what a client's tools/list would show) === the manifest's tools —
 *       buildServer's own assertion already throws on drift, this re-asserts it through the built
 *       dist the way a release actually ships;
 *   (3) every "N tools / M operations" figure stated in docs/knowledge-crib-mcp-api.md equals the
 *       manifest-derived TOOL_COUNT / OPERATION_COUNT — and at least one figure is stated, so
 *       deleting the count from the doc is a failure, not a loophole.
 *   (4) the client capture-lane matrix (G2.1, packages/cli/src/adapters.ts) is internally
 *       consistent (a row per client, closed enums), and every tool/op name it cites — plus the
 *       names the neutral protocol text cites — exists in the manifest: a renamed op must break
 *       the build here, not silently break every installed client's recall instruction.
 *
 * A wrong count is therefore a release-verify failure, not a doc-sweep: adding an op to the
 * manifest changes the derived count, and this gate stays red until the doc is updated to match.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

// release:verify builds every package before any gate runs, so the built mcp dist resolves.
const { buildServer, manifestInvariants, OPERATION_COUNT, TOOL_COUNT, TOOL_NAMES, opsOf } =
  await import(pathToFileURL(join(REPO, 'packages', 'mcp', 'dist', 'index.js')).href);

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  capabilities:check FAIL — ${msg}\n`);
  failed++;
};
const ok = (msg) => process.stdout.write(`  capabilities:check — ${msg}\n`);

// (1) manifest invariants.
const problems = manifestInvariants();
if (problems.length > 0) {
  for (const problem of problems) fail(problem);
} else {
  ok(`manifest internally consistent (${TOOL_COUNT} tools / ${OPERATION_COUNT} operations)`);
}

// (2) registered surface === manifest. Handlers are lazy adapters, so an empty verbs object is
//     enough to build the server — nothing is invoked at registration time.
const registered = Object.keys(buildServer({})._registeredTools ?? {}).sort();
const expected = [...TOOL_NAMES].sort();
if (registered.length !== expected.length || registered.some((n, i) => n !== expected[i])) {
  fail(`registered surface [${registered.join(', ')}] != manifest [${expected.join(', ')}]`);
} else {
  ok(`tools/list matches the manifest (${registered.length} tools)`);
}

// (3) the count-bearing doc must state the manifest-derived counts, everywhere it states any.
const DOC_PATH = join(REPO, 'docs', 'knowledge-crib-mcp-api.md');
const doc = readFileSync(DOC_PATH, 'utf8');
const COUNT_RE = /(\d+) tools \/ (\d+) operations/g;
const stated = [...doc.matchAll(COUNT_RE)];
if (stated.length === 0) {
  fail(
    `docs/knowledge-crib-mcp-api.md states no "N tools / M operations" figure — the surface counts must be stated there and pinned to the manifest`,
  );
}
for (const match of stated) {
  const [, tools, operations] = match;
  if (Number(tools) !== TOOL_COUNT || Number(operations) !== OPERATION_COUNT) {
    fail(
      `docs/knowledge-crib-mcp-api.md states "${tools} tools / ${operations} operations" but the capability manifest derives ${TOOL_COUNT} tools / ${OPERATION_COUNT} operations — update the doc (or the manifest, if the surface really changed)`,
    );
  }
}
if (failed === 0 && stated.length > 0) {
  ok(`doc states the manifest-derived count in all ${stated.length} place(s)`);
}

// (4) the client capture-lane matrix (G2.1). Read through the built cli dist the same way (2)
//     reads the mcp dist — the shipped bytes are what must agree, not the sources. The protocol
//     text is the contract every installed client follows, so a tool/op it cites must exist in the
//     manifest, and the matrix's lane rows must survive the same closed-enum checks tests assert.
const {
  CAPTURE_TOOL_REF,
  PROTOCOL_CITED_TOOLS,
  captureLaneManifestViolations,
  captureLaneSummary,
  lifecycleInvariants,
  neutralProtocolBody,
} = await import(pathToFileURL(join(REPO, 'packages', 'cli', 'dist', 'adapters.js')).href);

const laneProblems = lifecycleInvariants();
if (laneProblems.length > 0) {
  for (const problem of laneProblems) fail(problem);
} else {
  ok(`capture-lane matrix covers every client row (${captureLaneSummary('claude')})`);
}

const manifestProblems = captureLaneManifestViolations({
  tools: TOOL_NAMES,
  opsOf: (tool) => opsOf(tool).map((o) => o.op),
});
if (manifestProblems.length > 0) {
  for (const problem of manifestProblems) fail(problem);
} else {
  ok(
    `capture-lane + protocol tool refs resolve (memory.${CAPTURE_TOOL_REF.op}, ${PROTOCOL_CITED_TOOLS.join(', ')})`,
  );
}

// The protocol body must actually NAME every tool it claims to rely on — if the text is edited to
// drop a name, the matrix no longer describes what clients are told to do, and the gate goes red.
const body = neutralProtocolBody();
for (const tool of PROTOCOL_CITED_TOOLS) {
  if (!body.includes(tool)) {
    fail(
      `neutralProtocolBody no longer names '${tool}' — the protocol text and the capture-lane matrix must agree`,
    );
  }
}

if (failed > 0) process.exit(1);
