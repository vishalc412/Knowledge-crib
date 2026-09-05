/**
 * security-doc-check — the M3.7 threat-model + access-model gate.
 *
 * Pins the plan's M3.7 gate intent: "SECURITY.md section exists" — i.e. the threat model and access
 * model are documented, grounded in real file:line references, and cover the three load-bearing
 * properties the product is sold on:
 *
 *   (1) the soul inherits the repo ACL (no separate crib authn/authz layer — access == git ACL),
 *   (2) the MCP transport inventory is honest — stdio is the default (no listener), and the opt-in
 *       `serve --http` shared daemon is documented with its Host/Origin allowlist, its body cap,
 *       and the explicit statement that locality is not per-user authorization,
 *   (3) the deterministic core (index / parse / link / cluster / query / persist / federation) makes
 *       no network calls — the only network surfaces are the loopback `crib viz` HTTP server
 *       (Host-allowlisted, M0.3) and the opt-in LLM enrichment (and even there the crib process
 *       itself makes no model call — the host IDE agent does).
 *
 * This is a DOC gate, not a pipeline gate: it reads SECURITY.md and asserts the M3.7 section is
 * present with its subsections and its grounded source references. A doc gate is the right shape
 * here because the M3.7 deliverable IS the doc — and the gate pins it against silent deletion or
 * drift the same way the other *-check gates pin behavior. The file:line references inside the doc
 * are themselves the grounding contract; if the referenced code moves, this gate does NOT re-verify
 * the line numbers (that would couple a doc to exact line churn), but the eval-check.test.mjs
 * assertion below guarantees the gate runs in release:verify, and the section's prose names the
 * files so a reviewer can spot-check.
 *
 * Asserts:
 *   (1) the M3.7 section header exists,
 *   (2) the three load-bearing subsections exist (network surface inventory, access model, STRIDE),
 *   (3) the doc states each of the load-bearing properties (soul inherits repo ACL; stdio-default
 *       server plus a bounded opt-in HTTP daemon; deterministic core offline),
 *   (4) the doc names the two real network surfaces (viz loopback HTTP + opt-in LLM enrichment) and
 *       explicitly says the crib process makes no model call,
 *   (5) the doc names the M0.3 Host-header allowlist, the M0.6 lock, the M1.3 grounding, the M1.4
 *       secret scan / redact, and the M0.5 hard caps + M3.5 fuzz as the controls — i.e. the
 *       cross-references to prior milestone controls are present so the threat model is not a
 *       free-standing island.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const SECURITY = readFileSync(join(REPO, 'SECURITY.md'), 'utf8');

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  security:check FAIL — ${msg}\n`);
  failed++;
};
const assertContains = (needle, label) => {
  if (!SECURITY.includes(needle)) {
    fail(`${label} — SECURITY.md missing "${needle}"`);
  } else {
    process.stdout.write(`  security:check — ${label}\n`);
  }
};

try {
  // (1) section header
  assertContains('## Threat Model & Access Model (M3.7)', 'M3.7 section header present');

  // (2) subsections
  assertContains('### Network surface inventory', 'network surface inventory subsection');
  assertContains('### Access model', 'access model subsection');
  assertContains('### STRIDE summary', 'STRIDE summary subsection');
  assertContains('### Operator checklist', 'operator checklist subsection');

  // (3) the three load-bearing properties
  assertContains('soul inherits the repo ACL', 'property: soul inherits repo ACL');
  // The MCP transport inventory, pinned honestly. Asserting "stdio only" kept this gate green
  // while `serveHttp` shipped an unguarded listener (audit F14): a gate that pins a claim the code
  // contradicts is worse than no gate. Both transports must be inventoried, and the opt-in HTTP one
  // must state its boundary AND its limit (locality is not per-user authorization).
  assertContains('stdio by default, no listener', 'property: stdio default MCP transport');
  assertContains(
    'Host/Origin-allowlisted and\n   byte-capped',
    'property: opt-in HTTP daemon is boundary-enforced',
  );
  assertContains('Locality is not authorization', 'property: HTTP boundary is not authorization');
  assertContains('deterministic core is offline', 'property: deterministic core offline');

  // (4) the two real network surfaces + the "crib makes no model call" fact
  assertContains('loopback only, Host-allowlisted', 'surface: viz loopback HTTP (M0.3)');
  assertContains(
    'LLM enrichment makes no outbound model call',
    'surface: LLM enrichment opt-in, no crib model call',
  );

  // (5) cross-references to prior-milestone controls
  assertContains('Host-header allowlist', 'control ref: M0.3 Host allowlist');
  assertContains('.crib/.lock', 'control ref: M0.6 single-writer lock');
  assertContains('grounding rejects unverifiable', 'control ref: M1.3 grounding');
  assertContains('secret scan', 'control ref: M1.4 secret scan');
  assertContains('crib export --format llm --redact', 'control ref: M1.4 redact export');
  assertContains('MAX_LIMIT=200', 'control ref: M0.5 hard caps');
  assertContains('fast-check fuzz', 'control ref: M3.5 fuzz');

  // grounding: the doc must name the real source files it rests on
  assertContains('packages/mcp/src/server.ts', 'grounding: server.ts cited');
  assertContains('packages/mcp/src/http-boundary.test.ts', 'grounding: HTTP boundary test cited');
  assertContains('packages/cli/src/viz-server.ts', 'grounding: viz-server.ts cited');
  assertContains('packages/core/src/federation.ts', 'grounding: federation.ts cited');
  assertContains('packages/mcp/src/enrichment.ts', 'grounding: enrichment.ts cited');
  assertContains('packages/core/src/soul-store.ts', 'grounding: soul-store.ts cited');
} catch (err) {
  process.stderr.write(`  security:check threw: ${err?.stack ?? err}\n`);
  failed++;
}

if (failed > 0) {
  process.stderr.write(`\nsecurity:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nsecurity:check — all assertions passed\n');
