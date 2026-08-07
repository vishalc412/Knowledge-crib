/**
 * W2 Slice 3 — pure stable-locator parsing + scoring (no soul needed). The reattachment search over
 * a live soul is exercised in `evaluator.test.ts` via a fake port; here we pin the grammar parser,
 * the locator builder, and the candidate-threshold scoring.
 */
import type { Node } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import {
  LOCATOR_MATCH_THRESHOLD,
  bestLocatorMatches,
  buildLocator,
  buildLocatorFromEvidence,
  locatorScore,
  parseSoulId,
} from './locator.js';

function node(partial: Partial<Node> & { id: string; kind: string }): Node {
  return {
    hash: 'blake3:abc',
    ...partial,
  } as Node;
}

describe('parseSoulId', () => {
  it('parses sym:<path>#<qname>@L<line>', () => {
    const p = parseSoulId('sym:src/a.ts#A.b@L42');
    expect(p).toEqual({ prefix: 'sym', path: 'src/a.ts', name: 'A.b', line: 42 });
  });

  it('parses doc:<path>#<anchor> (anchor, not name)', () => {
    const p = parseSoulId('doc:docs/runbook.md#restart');
    expect(p).toEqual({ prefix: 'doc', path: 'docs/runbook.md', anchor: 'restart' });
  });

  it('parses art:<path>#<name> (agent-artifact)', () => {
    const p = parseSoulId('art:.claude/skills/deploy/SKILL.md#deploy');
    expect(p).toEqual({ prefix: 'art', path: '.claude/skills/deploy/SKILL.md', name: 'deploy' });
  });

  it('parses comp/field like sym (qualifiedName)', () => {
    expect(parseSoulId('comp:src/x.tsx#Button@L10')).toEqual({
      prefix: 'comp',
      path: 'src/x.tsx',
      name: 'Button',
      line: 10,
    });
  });

  it('returns undefined for non-soul / malformed ids', () => {
    expect(parseSoulId(undefined)).toBeUndefined();
    expect(parseSoulId('')).toBeUndefined();
    expect(parseSoulId('nope')).toBeUndefined();
  });
});

describe('buildLocator', () => {
  it('captures kind + qualifiedName + signature + path hints + anchor + hash', () => {
    const loc = buildLocator(
      node({
        id: 'sym:src/a.ts#A.b@L1',
        kind: 'symbol',
        qualifiedName: 'A.b',
        signature: '(x: number): string',
        file: 'src/a.ts',
        anchor: undefined,
      }),
    );
    expect(loc.artifactKind).toBe('symbol');
    expect(loc.qualifiedName).toBe('A.b');
    expect(loc.signature).toBe('(x: number): string');
    expect(loc.pathHints).toContain('src/a.ts');
    expect(loc.contentFingerprint).toBe('blake3:abc');
  });

  it('captures artifactType for agent-artifacts + heading anchor for doc-sections', () => {
    const art = buildLocator(
      node({
        id: 'art:.claude/skills/deploy/SKILL.md#deploy',
        kind: 'agent-artifact',
        artifactType: 'skill',
        name: 'deploy',
        file: '.claude/skills/deploy/SKILL.md',
      }),
    );
    expect(art.artifactKind).toBe('agent-artifact');
    expect(art.artifactType).toBe('skill');
    expect(art.name).toBe('deploy');

    const doc = buildLocator(
      node({
        id: 'doc:docs/r.md#restart',
        kind: 'doc-section',
        anchor: 'restart',
        file: 'docs/r.md',
      }),
    );
    expect(doc.artifactKind).toBe('doc-section');
    expect(doc.headingAnchor).toBe('restart');
  });
});

describe('buildLocatorFromEvidence (stale anchor)', () => {
  it('derives kind + qualifiedName + path + fingerprint from a sym soulId + targetHash', () => {
    const loc = buildLocatorFromEvidence({
      soulId: 'sym:src/a.ts#A.b@L7',
      targetHash: 'blake3:dead',
    });
    expect(loc?.artifactKind).toBe('symbol');
    expect(loc?.qualifiedName).toBe('A.b');
    expect(loc?.pathHints).toContain('src/a.ts');
    expect(loc?.contentFingerprint).toBe('blake3:dead');
  });

  it('derives anchor from a doc soulId', () => {
    const loc = buildLocatorFromEvidence({ soulId: 'doc:docs/r.md#restart', anchor: 'restart' });
    expect(loc?.artifactKind).toBe('doc-section');
    expect(loc?.headingAnchor).toBe('restart');
  });

  it('returns undefined when the evidence has no anchor id (e.g. human-attestation)', () => {
    expect(buildLocatorFromEvidence({})).toBeUndefined();
  });
});

describe('locatorScore + bestLocatorMatches', () => {
  const locator: ReturnType<typeof buildLocatorFromEvidence> = {
    artifactKind: 'symbol',
    qualifiedName: 'A.b',
    pathHints: ['src/a.ts'],
    contentFingerprint: 'blake3:dead',
  };

  it('scores 0 when the kind does not match', () => {
    expect(locatorScore(node({ id: 'doc:src/a.ts#x', kind: 'doc-section' }), locator)).toBe(0);
  });

  it('a same-name + same-path + same-hash match scores at or near 100', () => {
    const n = node({
      id: 'sym:src/a.ts#A.b@L99',
      kind: 'symbol',
      qualifiedName: 'A.b',
      file: 'src/a.ts',
      hash: 'blake3:dead',
    });
    expect(locatorScore(n, locator)).toBeGreaterThanOrEqual(85);
  });

  it('a kind-only match is below the candidate threshold', () => {
    const n = node({
      id: 'sym:src/other.ts#Z.y@L1',
      kind: 'symbol',
      qualifiedName: 'Z.y',
      file: 'src/other.ts',
    });
    expect(locatorScore(n, locator)).toBeLessThan(LOCATOR_MATCH_THRESHOLD);
  });

  it('bestLocatorMatches returns the unique strong match, best-first', () => {
    const match = node({
      id: 'sym:src/a.ts#A.b@L99',
      kind: 'symbol',
      qualifiedName: 'A.b',
      file: 'src/a.ts',
      hash: 'blake3:dead',
    });
    const noise = node({
      id: 'sym:src/other.ts#Z.y@L1',
      kind: 'symbol',
      qualifiedName: 'Z.y',
      file: 'src/other.ts',
    });
    const got = bestLocatorMatches([match, noise], locator);
    expect(got).toHaveLength(1);
    expect(got[0]?.id).toBe(match.id);
  });
});
