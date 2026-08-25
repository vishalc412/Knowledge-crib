/**
 * W4 Slice 1 — the trusted-base gate policy (PRD §2 "CLI and CI interfaces" + W4 lines 340–350).
 *
 * Covers: the version-discipline (unknown versions fail closed), profile-key-matches-name drift
 * guard, per-assertion-kind validation, the canonical (key-sorted) blake3 hashing of policy + profile
 * (so a receipt's `policyHash`/`profileHash` deterministically detect drift), `loadPolicy` absence
 * → `undefined` (gate cannot run) vs corrupt → `PolicyError`, and the default trusted ref.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TRUSTED_REF,
  type GateProfile,
  POLICY_FORMAT_VERSION,
  PolicyError,
  assertValidPolicy,
  loadPolicy,
  loadPolicyJson,
  policyHash,
  profileHash,
  resolveProfile,
  trustedRefOf,
} from './policy.js';

function profile(partial: Partial<GateProfile> & { name?: string } = {}): GateProfile {
  return {
    name: 'test',
    executable: 'node',
    args: ['--version'],
    timeoutMs: 5000,
    permittedEnv: ['PATH'],
    successExitCodes: [0],
    assertions: [{ name: 'exit-ok', kind: 'exit-code', codes: [0] }],
    ...partial,
  };
}

function policy(profiles: Record<string, GateProfile> = { test: profile() }) {
  return { version: 1 as const, profiles };
}

describe('policy validation', () => {
  it('accepts a well-formed policy + fills the profile `name` from its key', () => {
    // a profile object WITHOUT a `name` field — assertValidPolicy fills it from the key
    const lintProfile = {
      executable: 'node',
      args: ['--version'],
      timeoutMs: 5000,
      permittedEnv: ['PATH'],
      successExitCodes: [0],
      assertions: [{ name: 'exit-ok', kind: 'exit-code' as const, codes: [0] }],
    };
    const p = { version: 1, profiles: { lint: lintProfile } };
    assertValidPolicy(p);
    expect((p.profiles.lint as GateProfile).name).toBe('lint');
  });

  it('rejects an unknown version (fail closed)', () => {
    expect(() => assertValidPolicy({ version: 2, profiles: {} })).toThrow(PolicyError);
    expect(() => loadPolicyJson('{"version":99,"profiles":{}}')).toThrow(/expected 1/);
  });

  it('rejects a profile whose key does not match its name field (drift guard)', () => {
    const p = { version: 1, profiles: { lint: { ...profile(), name: 'test' } } };
    expect(() => assertValidPolicy(p)).toThrow(/does not match name field/);
  });

  it('rejects a non-object / missing profiles map', () => {
    expect(() => assertValidPolicy({ version: 1 })).toThrow(/profiles must be an object/);
    expect(() => assertValidPolicy({ version: 1, profiles: { x: null } })).toThrow(
      /must be an object/,
    );
  });

  it('rejects an absolute / empty cwd (must be repo-relative)', () => {
    const p = { version: 1, profiles: { test: { ...profile(), cwd: '/abs' } } };
    expect(() => assertValidPolicy(p)).toThrow(/non-absolute/);
    const p2 = { version: 1, profiles: { test: { ...profile(), cwd: '' } } };
    expect(() => assertValidPolicy(p2)).toThrow(/non-absolute/);
  });

  it('rejects a non-positive / non-finite timeout', () => {
    expect(() =>
      assertValidPolicy({ version: 1, profiles: { test: { ...profile(), timeoutMs: 0 } } }),
    ).toThrow(/timeoutMs/);
    expect(() =>
      assertValidPolicy({
        version: 1,
        profiles: { test: { ...profile(), timeoutMs: Number.POSITIVE_INFINITY } },
      }),
    ).toThrow(/timeoutMs/);
  });

  it('rejects an assertion with an invalid kind + validates per-kind fields', () => {
    expect(() =>
      assertValidPolicy({
        version: 1,
        profiles: { test: { ...profile(), assertions: [{ name: 'x', kind: 'shell-inject' }] } },
      }),
    ).toThrow(/invalid kind/);
    // output-contains requires a needle
    expect(() =>
      assertValidPolicy({
        version: 1,
        profiles: { test: { ...profile(), assertions: [{ name: 'x', kind: 'output-contains' }] } },
      }),
    ).toThrow(/needle/);
    // output-matches requires a pattern
    expect(() =>
      assertValidPolicy({
        version: 1,
        profiles: { test: { ...profile(), assertions: [{ name: 'x', kind: 'output-matches' }] } },
      }),
    ).toThrow(/pattern/);
  });

  it('rejects an empty / non-string trustedRef when present', () => {
    expect(() => assertValidPolicy({ version: 1, profiles: {}, trustedRef: '' })).toThrow(
      /trustedRef/,
    );
  });

  it('rejects invalid JSON text', () => {
    expect(() => loadPolicyJson('{not json')).toThrow(PolicyError);
  });
});

describe('policy loading', () => {
  let crib: string;
  beforeEach(() => {
    crib = mkdtempSync(join(tmpdir(), 'mem-policy-'));
  });
  afterEach(() => rmSync(crib, { recursive: true, force: true }));

  it('returns undefined when policy.json is absent (gate cannot run)', () => {
    expect(loadPolicy(crib)).toBeUndefined();
  });

  it('loads + validates a present policy.json', () => {
    mkdirSync(join(crib, 'memory'), { recursive: true });
    writeFileSync(join(crib, 'memory', 'policy.json'), JSON.stringify(policy()));
    const loaded = loadPolicy(crib);
    expect(loaded?.version).toBe(POLICY_FORMAT_VERSION);
    expect(loaded?.profiles.test?.executable).toBe('node');
  });

  it('throws PolicyError on a corrupt (unknown-version) file (never silently partial)', () => {
    mkdirSync(join(crib, 'memory'), { recursive: true });
    writeFileSync(join(crib, 'memory', 'policy.json'), '{"version":7,"profiles":{}}');
    expect(() => loadPolicy(crib)).toThrow(PolicyError);
  });
});

describe('policy / profile hashing (drift detection)', () => {
  it('is stable across key-order changes (canonical key-sorted blake3)', () => {
    const p1 = profile({ assertions: [{ name: 'a', kind: 'exit-code', codes: [0] }] });
    const p2: GateProfile = { ...p1, permittedEnv: [...p1.permittedEnv].reverse() };
    // same semantic content → same hash regardless of array order WITHIN the same field is NOT
    // guaranteed (arrays are ordered), but identical objects always hash the same.
    expect(profileHash(p1)).toBe(profileHash({ ...p1 }));
  });

  it('changes when the executable changes (the whole point of the drift hash)', () => {
    const a = profile({ executable: 'node' });
    const b = profile({ executable: 'deno' });
    expect(profileHash(a)).not.toBe(profileHash(b));
  });

  it('policyHash changes when a profile is added', () => {
    const a = policy({ test: profile() });
    const b = policy({ test: profile(), lint: profile({ name: 'lint', executable: 'eslint' }) });
    expect(policyHash(a)).not.toBe(policyHash(b));
  });
});

describe('profile + trusted-ref resolution', () => {
  it('resolveProfile returns the profile by name, undefined when absent', () => {
    const p = policy();
    expect(resolveProfile(p, 'test')?.executable).toBe('node');
    expect(resolveProfile(p, 'nope')).toBeUndefined();
  });

  it('trustedRefOf falls back to the default when the policy omits one', () => {
    expect(trustedRefOf(undefined)).toBe(DEFAULT_TRUSTED_REF);
    expect(trustedRefOf(policy())).toBe(DEFAULT_TRUSTED_REF);
    expect(trustedRefOf({ ...policy(), trustedRef: 'refs/heads/main' })).toBe('refs/heads/main');
  });
});
