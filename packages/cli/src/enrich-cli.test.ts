/**
 * W7 — CLI end-to-end: `crib enrich run --provider` and `crib enrich --auto` (PRD line 383–392).
 *
 * Drives the BUILT `dist/cli.js` as a subprocess against a temp repo the pipeline has indexed, so
 * this exercises the real arg parsing → provider resolution → bounded `runProviderEnrichLoop` →
 * `enrich.next()` / `enrich.save()` round trip — not just the unit-level engine (enrich-provider.test.ts).
 *
 * The fixture provider is a temp ESM script run with `shell:false` (via `process.execPath`) that reads
 * the work item, lifts the longest line of `seed.sourceBody.text` (the rehydrated anchor span) as the
 * verbatim `quote`, and echoes a valid `EnrichSaveItem`. Because `sourceBody.text` IS the rehydrated
 * span, any line of it is a (whitespace-normalized) substring of the span — so grounding passes and the
 * artifact is stamped `verified`, advancing coverage. A second fixture always exits 1, proving provider
 * failure leaves work pending and resumable (the third PRD exit-gate clause), end-to-end through the CLI.
 *
 * Providers come ONLY from a temp `--providers-file` so the test never touches real `~/.crib/providers.json`.
 *
 * NOTE: these tests require the BUILT `@knowledge-crib/mcp` dist (the CLI imports the compiled package,
 * not the source). `pnpm verify` / `pretest` rebuilds all dists before tests; if you run this file alone
 * after editing enrichment.ts, rebuild first: `pnpm -r run build`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest, openIndex } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = join(__dirname, '..', 'dist', 'cli.js');

let repo: string;
let providersFile: string;

// Same fixture as enrichment-quality.test.ts: a real `src/auth.ts` on disk so rehydrateBody reads
// actual span text. login (lines 10-11) → `return issue(user, pass)`; logout (13-14) → `return clear()`.
const fileId = idFor({ kind: 'file', path: 'src/auth.ts' });
const loginId = idFor({
  kind: 'symbol',
  path: 'src/auth.ts',
  qualifiedName: 'AuthService.login',
  startLine: 10,
});
const logoutId = idFor({
  kind: 'symbol',
  path: 'src/auth.ts',
  qualifiedName: 'AuthService.logout',
  startLine: 13,
});

/**
 * A provider script that echoes a GROUNDED save item. `seed.sourceBody` is a `RehydratedBody` object
 * `{ text, truncated, ... }`; the longest trimmed line of `text` is a verbatim substring of the
 * (normalized) anchor span, so the grounding validator (which rehydrates the same span) accepts it and
 * `save()` stamps the artifact `verified`. No `process.exit(0)` — Node keeps the loop alive until the
 * stdout pipe drains, so the parent never sees a truncated response.
 */
const GROUNDED_FIXTURE = `let buf = '';
process.stdin.on('data', (c) => { buf += c.toString(); });
process.stdin.on('end', () => {
  let item;
  try { item = JSON.parse(buf); } catch { process.exit(3); }
  const tid = item.targetId;
  const source = item && item.seed && item.seed.sourceBody ? item.seed.sourceBody : {};
  const body = typeof source === 'string' ? source : (source.text || '');
  // The longest trimmed non-empty line is a verbatim substring of the (normalized) anchor span.
  const quote = body.split('\\n').map((l) => l.trim()).filter((l) => l.length > 0)
    .sort((a, b) => b.length - a.length)[0] || '';
  process.stdout.write(JSON.stringify({
    targetId: tid, model: 'fixture-provider',
    analysis: { purpose: 'fixture analysis', confidence: 0.9 },
    graph: { nodes: [], edges: [] },
    evidence: [{ soulId: tid, quote }],
  }));
});
`;

/** A provider script that always fails — exits 1 so every item records a !ok outcome. */
const FAILING_FIXTURE = `process.stderr.write('boom'); process.exit(1);
`;

/**
 * A PARTIAL provider — grounds every target EXCEPT `logout`. The fixture branches on the rehydrated
 * span text (the only target-specific signal available to a `shell:false` provider that cannot see the
 * symbol name): a span containing `clear()` is the logout body, which it fails with exit 1; every other
 * span is grounded with the longest trimmed line as the verbatim quote. This exercises the per-item
 * failure path the PRD exit gate calls "resumable" — one item in the batch fails (not saved → stays
 * pending) while the other is saved `verified`, and the run continues past the failure rather than
 * aborting. (The cross-run same-pending retry is deliberately NOT asserted: the `lastIssued`
 * zero-progress marker is a safety valve that, by design, stops a re-issue of the same batchId, so a
 * deliberate re-run on an unchanged pending set hits zero-progress — that is the within-run stuck-loop
 * guard working as intended, not a resumability regression.)
 */
const PARTIAL_FIXTURE = `let buf = '';
process.stdin.on('data', (c) => { buf += c.toString(); });
process.stdin.on('end', () => {
  let item;
  try { item = JSON.parse(buf); } catch { process.exit(3); }
  const tid = item.targetId;
  const source = item && item.seed && item.seed.sourceBody ? item.seed.sourceBody : {};
  const body = typeof source === 'string' ? source : (source.text || '');
  // logout's rehydrated span is \`return clear()\` — fail it; ground everything else.
  if (body.includes('clear()')) { process.stderr.write('partial: failing logout'); process.exit(1); }
  const quote = body.split('\\n').map((l) => l.trim()).filter((l) => l.length > 0)
    .sort((a, b) => b.length - a.length)[0] || '';
  process.stdout.write(JSON.stringify({
    targetId: tid, model: 'fixture-provider',
    analysis: { purpose: 'fixture analysis', confidence: 0.9 },
    graph: { nodes: [], edges: [] },
    evidence: [{ soulId: tid, quote }],
  }));
});
`;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-w7-e2e-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'auth.ts'),
    `${'\n'.repeat(8)}class AuthService {
  login(user, pass) {
    return issue(user, pass);
  }
  logout() {
    return clear();
  }
}
`,
  );

  // Commit a soul with the file + two method symbols so the CLI subprocess can reopen it from disk.
  const soul = new SoulStore(join(repo, '.crib'), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  soul.load();
  soul.putNodes([
    {
      id: fileId,
      kind: 'file',
      file: 'src/auth.ts',
      hash: contentHash('src/auth.ts'),
      lang: 'typescript',
    },
    {
      id: loginId,
      kind: 'symbol',
      type: 'method',
      name: 'login',
      qualifiedName: 'AuthService.login',
      file: 'src/auth.ts',
      span: { start: 10, end: 11 },
      lang: 'typescript',
      hash: contentHash('AuthService.login'),
    },
    {
      id: logoutId,
      kind: 'symbol',
      type: 'method',
      name: 'logout',
      qualifiedName: 'AuthService.logout',
      file: 'src/auth.ts',
      span: { start: 13, end: 14 },
      lang: 'typescript',
      hash: contentHash('AuthService.logout'),
    },
  ]);
  soul.commit('2026-01-01T00:00:00.000Z');

  // Build the sqlite index so `isIndexedRoot` passes for the CLI subprocess.
  mkdirSync(join(repo, '.crib', 'index'), { recursive: true });
  const index = openIndex(soul.getManifest().stores.index.backend, {
    path: join(repo, '.crib', 'index', 'crib.sqlite'),
  });
  index.buildFromSoul(soul, repo);
  index.close();

  // Three fixture providers + a providers.json (temp, never the real ~/.crib/providers.json).
  const groundedPath = join(repo, 'fixture.mjs');
  const failPath = join(repo, 'fail.mjs');
  const partialPath = join(repo, 'partial.mjs');
  writeFileSync(groundedPath, GROUNDED_FIXTURE);
  writeFileSync(failPath, FAILING_FIXTURE);
  writeFileSync(partialPath, PARTIAL_FIXTURE);
  providersFile = join(repo, 'providers.json');
  writeFileSync(
    providersFile,
    JSON.stringify({
      providers: {
        fixture: { command: [process.execPath, groundedPath] },
        fail: { command: [process.execPath, failPath] },
        partial: { command: [process.execPath, partialPath] },
      },
    }),
  );
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** Run the CLI from the temp repo root, returning trimmed stdout (for non-JSON / JSON+hint output). */
function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/** Run the CLI capturing the exit status (zero or non-zero) instead of throwing. */
function runCliResult(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: 0, stdout: out.trim(), stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? '').trim(),
    };
  }
}

describe('W7 crib enrich --auto (no --provider) — no longer writes stubs', () => {
  it('prints guidance and exits OK without authoring any artifacts', () => {
    const r = runCliResult(['enrich', '--auto']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no longer writes stubs');
    expect(r.stdout).toContain('provider loop: crib enrich run --provider <name>');

    // No stubs were written: the audit finds zero LLM artifacts on disk (the W7 stub-freshness fix —
    // a fresh-but-unverified legacy artifact can no longer masquerade as coverage).
    const audit = runCli(['audit-llm']);
    expect(audit).toContain('no LLM artifacts on disk');
  });
});

describe('W7 crib enrich run --provider <name> — grounded provider advances coverage', () => {
  it('saves verified artifacts through the bounded loop and the audit confirms grounding', () => {
    const r = runCliResult([
      'enrich',
      'run',
      '--provider',
      'fixture',
      '--providers-file',
      providersFile,
    ]);
    expect(r.status).toBe(0);
    // The loop summary line reports accepted items (both symbols grounded) and zero provider failures.
    expect(r.stdout).toContain('accepted=');
    expect(r.stdout).not.toContain('provider-failed=2');

    // The audit confirms the artifacts are grounded (verified), not legacy stubs. The summary line
    // always names every bucket ("N grounded, M ungrounded, …"), so assert the counts, not absence of
    // the word "ungrounded" — "0 ungrounded" is the green signal.
    const audit = runCliResult(['audit-llm']);
    expect(audit.status).toBe(0); // ungrounded=0 → OK, not EXIT.ERROR
    expect(audit.stdout).toContain('audited 2 artifact(s)');
    expect(audit.stdout).toContain('2 grounded');
    expect(audit.stdout).toContain('0 ungrounded');
  });

  it('reaches the symbol-layer boundary and stops for review (no runaway into file/cluster)', () => {
    const r = runCliResult([
      'enrich',
      'run',
      '--provider',
      'fixture',
      '--providers-file',
      providersFile,
    ]);
    expect(r.status).toBe(0);
    // After the symbol layer is verified, the next batch is the file layer → layer-boundary stop.
    expect(r.stdout).toContain('layer boundary');
  });
});

describe('W7 crib enrich run --provider <name> — provider failure leaves work pending and resumable', () => {
  it('a always-failing provider writes nothing and stops at zero-progress (non-zero exit)', () => {
    const r = runCliResult([
      'enrich',
      'run',
      '--provider',
      'fail',
      '--providers-file',
      providersFile,
    ]);
    // Every item fails at the provider → nothing saved → next() re-issues the same batchId → zero-progress stop.
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('provider failed');
    expect(r.stderr).toContain('zero-progress');

    // Nothing was written: the audit still finds zero artifacts — the targets stayed pending.
    const audit = runCli(['audit-llm']);
    expect(audit).toContain('no LLM artifacts on disk');
  });

  it('a per-item provider failure is re-offered and leaves the failed target pending (resumable)', () => {
    // The partial provider grounds `login` but fails `logout` (exits 1 on the `clear()` span). The run
    // must NOT abort on the per-item failure: batch 1 saves login `verified` with `provider-failed=1`,
    // then re-offers logout, fails it again, and stops at zero-progress (the within-run stuck-loop
    // guard). The audit then shows login grounded and NO artifact for logout — it stayed pending,
    // neither written nor corrupted. That is the PRD exit-gate clause: provider failure leaves work
    // pending (logout) and resumable (the run continued past the failure and saved the good item).
    const r = runCliResult([
      'enrich',
      'run',
      '--provider',
      'partial',
      '--providers-file',
      providersFile,
    ]);
    // Zero-progress stop after re-offering the failed logout — a non-zero exit, NOT an abort on the
    // first failure.
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('provider failed');
    expect(r.stderr).toContain('zero-progress');

    // Batch 1 advanced login despite logout's failure in the same batch — the per-item failure did not
    // abort the batch/run (the resumable property).
    expect(r.stdout).toContain('accepted=1');
    expect(r.stdout).toContain('provider-failed=1');

    // login was saved `verified`; logout was NOT written (it failed and stayed pending). So the audit
    // finds exactly one grounded artifact and zero ungrounded — logout is simply absent, not a stub.
    const audit = runCliResult(['audit-llm']);
    expect(audit.status).toBe(0);
    expect(audit.stdout).toContain('audited 1 artifact(s)');
    expect(audit.stdout).toContain('1 grounded');
    expect(audit.stdout).toContain('0 ungrounded');
  });
});
