/**
 * The support bundle's contract: diagnosable, and safe to send.
 *
 * The redaction half is tested the only way redaction can honestly be tested — by planting a
 * SENTINEL secret in every source the collector reads and asserting that no member of the produced
 * bundle contains it. A denylist test that checks three known field names passes forever while a
 * fourth field quietly starts carrying user content; a sentinel sweep over the serialized bundle
 * fails the moment anything new leaks.
 */
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  type DiagnosticsSources,
  buildSupportBundle,
  classify,
  collectDiagnostics,
  redactPaths,
  redactSecrets,
} from './support-bundle.js';

const REPO = '/Users/someone/projects/private-repo';

/** One sentinel per source; each must be absent from the serialized bundle. */
const SENTINELS = {
  memory: 'SENTINEL-MEMORY-CLAIM-9f2a',
  prompt: 'SENTINEL-PROMPT-TEXT-4c71',
  token: 'ghp_SENTINELTOKEN0123456789abcdef',
  password: 'SENTINEL-PASSWORD-8e3b',
  env: 'SENTINEL-ENV-VALUE-1d55',
  home: homedir(),
};

/** Sources that are hostile on purpose: every one of them carries a secret in its output. */
function leakySources(): DiagnosticsSources {
  return {
    freshnessStatus: () => ({
      mode: `watch ${SENTINELS.env}`,
      workerRunning: true,
      pending: 2,
      dead: 1,
      behindHead: false,
    }),
    readerFreshness: () => ({
      readerGeneration: 'reader:abc123',
      publishedGeneration: 'reader:abc123',
      stale: false,
      staleReasons: [],
      lastRefreshError: {
        code: 'Error',
        message: `failed while embedding "${SENTINELS.prompt}" with api_key=${SENTINELS.token} for ${SENTINELS.memory}`,
        occurredAt: '2026-09-09T00:00:00.000Z',
      },
    }),
    embedder: () => ({ state: 'installed', modelId: 'e5-large', modelVersion: '1' }),
    adapters: () => [
      {
        ide: 'cursor',
        scope: 'project',
        configPath: `${REPO}/.cursor/mcp.json`,
        message: `${REPO}/.cursor/mcp.json: password=${SENTINELS.password} in ${homedir()}/secrets`,
        kind: 'config-unparseable',
      },
    ],
  };
}

describe('support bundle — redaction', () => {
  it('contains no planted sentinel from any source', () => {
    const bundle = buildSupportBundle({
      repoRoot: REPO,
      version: '0.1.0',
      now: '2026-09-09T00:00:00.000Z',
      sources: leakySources(),
    });
    const serialized = JSON.stringify(bundle);
    for (const [name, sentinel] of Object.entries(SENTINELS)) {
      if (name === 'home' && !sentinel) continue;
      expect(serialized, `the ${name} sentinel leaked into the bundle`).not.toContain(sentinel);
    }
  });

  it('keeps the diagnosis while removing the disclosure', () => {
    const bundle = buildSupportBundle({
      repoRoot: REPO,
      version: '0.1.0',
      sources: leakySources(),
    });
    const adapter = bundle.diagnostics.adapters.value?.[0];
    // Still actionable: which client, which scope, which kind of problem, which file.
    expect(adapter?.ide).toBe('cursor');
    expect(adapter?.kind).toBe('config-unparseable');
    expect(adapter?.configPath).toBe('<repo>/.cursor/mcp.json');
    // But the user's directory layout and their password are gone.
    expect(adapter?.problem).not.toContain(REPO);
    expect(adapter?.problem).toContain('<redacted>');
  });

  it('withholds raw error text but keeps the error identifiable', () => {
    const bundle = buildSupportBundle({
      repoRoot: REPO,
      version: '0.1.0',
      sources: leakySources(),
    });
    const error = bundle.diagnostics.lastError.value;
    // Still diagnosable: which class of failure, when, and a digest that matches across reports.
    expect(error?.code).toBe('Error');
    expect(error?.occurredAt).toBe('2026-09-09T00:00:00.000Z');
    expect(error?.message).toMatch(/^<withheld: \d+ chars, sha256:[0-9a-f]{16}>$/);
    // The same failure produces the same digest, so support can correlate without the text.
    const again = buildSupportBundle({ repoRoot: REPO, version: '0.1.0', sources: leakySources() });
    expect(again.diagnostics.lastError.value?.message).toBe(error?.message);
    // The LOCAL diagnostics keep the message — the user can still read it on their own machine.
    const local = collectDiagnostics(REPO, leakySources());
    expect(local.lastError.value?.message).toContain(SENTINELS.prompt);
  });

  it('states what it excluded, so an omission reads as a decision', () => {
    const bundle = buildSupportBundle({ repoRoot: REPO, version: '0.1.0' });
    expect(bundle.excluded).toEqual(
      expect.arrayContaining([
        'memory records and claims',
        'credentials, tokens and keys',
        'environment variables',
      ]),
    );
  });

  it('redacts secret shapes wherever they appear', () => {
    expect(redactSecrets('API_KEY=abc123')).toBe('API_KEY=<redacted>');
    expect(redactSecrets('authorization: "Bearer xyz"')).toContain('<redacted>');
    expect(redactSecrets('Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toBe('Bearer <redacted>');
    expect(redactSecrets('token: ghp_0123456789abcdefghij')).toContain('<redacted>');
    expect(
      redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'),
    ).toBe('<redacted>');
    // A sentence that merely MENTIONS a token is left readable — over-redaction hides the defect.
    expect(redactSecrets('the token was rejected')).toBe('the token was rejected');
  });

  it("removes ANY user's home segment, including one with spaces and non-ASCII characters", () => {
    // Found by running the real command: `/Users/jöhn doe/npm-global/bin/crib` kept the person's
    // name, because the generic path rule stops at whitespace. A home root is one segment, however
    // it is spelled.
    expect(redactPaths('/Users/jöhn doe/npm-global/bin/crib', REPO, '/Users/someone')).toBe(
      '<home>/npm-global/bin/crib',
    );
    expect(redactPaths('/home/ci runner/.crib/memory', REPO, '/Users/someone')).toBe(
      '<home>/.crib/memory',
    );
    expect(redactPaths('C:\\Users\\jöhn doe\\AppData\\crib', REPO, '/Users/someone')).toBe(
      '<home>\\AppData\\crib',
    );
  });

  it('relativizes repo and home paths, and truncates any other absolute path', () => {
    expect(redactPaths(`${REPO}/src/a.ts`, REPO)).toBe('<repo>/src/a.ts');
    expect(redactPaths('/Users/someone/.crib/memory', REPO, '/Users/someone')).toBe(
      '~/.crib/memory',
    );
    // A different user's home is redacted structurally rather than left in place.
    expect(redactPaths('/Users/other/.crib/memory', REPO, '/Users/someone')).toBe(
      '<home>/.crib/memory',
    );
    expect(redactPaths('/var/lib/deep/nested/thing.json', REPO, '/Users/someone')).toBe(
      '<path>/nested/thing.json',
    );
  });
});

describe('support bundle — diagnostics', () => {
  it('keeps ABSENT and UNAVAILABLE distinct', () => {
    const diagnostics = collectDiagnostics(REPO, {
      // present, but with nothing published yet: absent, not unavailable
      readerFreshness: () => ({
        readerGeneration: null,
        publishedGeneration: null,
        stale: false,
        staleReasons: [],
        lastRefreshError: null,
      }),
      // throws: unavailable, not absent — "we could not read it" is a different repair
      freshnessStatus: () => {
        throw Object.assign(new Error('nope'), { code: 'EACCES' });
      },
      // not wired at all
    });

    expect(diagnostics.refresh.readerGeneration.availability).toBe('absent');
    expect(diagnostics.refresh.readerGeneration.reason).toBe('no bundle is being served');
    expect(diagnostics.refresh.workerRunning.availability).toBe('unavailable');
    expect(diagnostics.refresh.workerRunning.reason).toBe('permission denied');
    expect(diagnostics.model.state.availability).toBe('absent');
    expect(diagnostics.model.state.reason).toBe('not configured in this environment');
    expect(diagnostics.lastError.availability).toBe('absent');
  });

  it('reports adoption identity, retries and dead letters', () => {
    const diagnostics = collectDiagnostics(REPO, {
      freshnessStatus: () => ({
        mode: 'watch',
        workerRunning: true,
        pending: 3,
        dead: 2,
        behindHead: true,
      }),
      readerFreshness: () => ({
        readerGeneration: 'reader:aaa',
        publishedGeneration: 'reader:bbb',
        stale: true,
        staleReasons: ['published-generation-not-adopted'],
        lastRefreshError: null,
      }),
    });

    expect(diagnostics.refresh.pending.value).toBe(3);
    expect(diagnostics.refresh.deadLettered.value).toBe(2);
    expect(diagnostics.refresh.behindHead.value).toBe(true);
    // The adoption state is visible as an IDENTITY disagreement, not just a boolean.
    expect(diagnostics.refresh.readerGeneration.value).not.toBe(
      diagnostics.refresh.publishedGeneration.value,
    );
    expect(diagnostics.refresh.staleReasons.value).toContain('published-generation-not-adopted');
  });

  it('classifies errors without leaking a stack or a path', () => {
    expect(classify(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('not found (ENOENT)');
    expect(classify(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('timed out');
    const classified = classify(
      new Error(`open /Users/someone/deep/dir/file: token=ghp_${'a'.repeat(20)}`),
    );
    expect(classified).not.toContain('/Users/someone');
    expect(classified).toContain('<redacted>');
  });

  it('survives a source that throws without losing the rest of the snapshot', () => {
    const diagnostics = collectDiagnostics(REPO, {
      adapters: () => {
        throw new Error('adapter scan exploded');
      },
      embedder: () => ({ state: 'installed', modelId: 'e5', modelVersion: '1' }),
    });
    expect(diagnostics.adapters.availability).toBe('unavailable');
    expect(diagnostics.model.state.value).toBe('installed');
  });
});
