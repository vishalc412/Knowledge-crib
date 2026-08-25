/**
 * W4 Slice 1 — the fixed-argument gate runner (PRD §2 "Execution rules" + W4 lines 340–350).
 *
 * A fake {@link GateExecPort} exercises the runner WITHOUT spawning a real process. Covers: shell
 * false (the argv is the profile's, frozen — candidate content never adds args), permittedEnv
 * least-privilege filtering, the sanitized receipt (no raw stdout/stderr — only outputDigest +
 * assertion results), assertion evaluation (exit-code / output-contains / output-matches), timeout
 * → exit 124, the content-addressed receipt id (idempotent across re-runs of identical input), and
 * the fail-closed outcomes (unresolvable executable / spawn failure).
 */
import { describe, expect, it } from 'vitest';
import {
  GATE_TIMEOUT_EXIT,
  type GateExecPort,
  type GateExecResult,
  type GateRunInput,
  NodeGateExecPort,
  evalAssertion,
  runGate,
} from './gate-runner.js';
import { receiptId } from './ids.js';
import { type GateProfile, type MemoryPolicy, policyHash, profileHash } from './policy.js';

const NOW = '2026-01-01T00:00:00.000Z';
const HEAD = '0'.repeat(40);
const DIGEST = 'blake3:worktree';

function profile(partial: Partial<GateProfile> = {}): GateProfile {
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

function policy(profiles: Record<string, GateProfile> = { test: profile() }): MemoryPolicy {
  return { version: 1, profiles };
}

/** A fake exec port: records the resolved executable + the spawn args/env, returns canned output. */
class FakeExec implements GateExecPort {
  readonly spawned: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  constructor(
    private readonly result: GateExecResult,
    private readonly resolved = '/usr/bin/node',
  ) {}
  resolveExecutable(): string {
    return this.resolved;
  }
  execFile(
    file: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv },
  ): Promise<GateExecResult> {
    this.spawned.push({ file, args, env: { ...opts.env } });
    return Promise.resolve(this.result);
  }
}

function runInput(
  opts: Partial<GateRunInput> & { profile: GateProfile; policy: MemoryPolicy },
): GateRunInput {
  return {
    head: HEAD,
    worktreeDigest: DIGEST,
    runner: 'ci',
    repoRoot: '/repo',
    env: { PATH: '/usr/bin', SECRET_TOKEN: 'shhh' },
    now: () => NOW,
    ...opts,
  };
}

describe('evalAssertion (pure)', () => {
  it('exit-code matches iff the code is in `codes`', () => {
    const a = { name: 'x', kind: 'exit-code' as const, codes: [0, 2] };
    expect(evalAssertion(a, 0, '')).toBe(true);
    expect(evalAssertion(a, 2, '')).toBe(true);
    expect(evalAssertion(a, 1, '')).toBe(false);
    expect(evalAssertion({ name: 'x', kind: 'exit-code', codes: [] }, 0, '')).toBe(false);
  });
  it('output-contains matches iff the needle is a non-empty substring', () => {
    const a = { name: 'x', kind: 'output-contains' as const, needle: 'PASS' };
    expect(evalAssertion(a, 0, 'all PASS\n')).toBe(true);
    expect(evalAssertion(a, 0, 'fail\n')).toBe(false);
    expect(evalAssertion({ name: 'x', kind: 'output-contains', needle: '' }, 0, 'x')).toBe(false);
  });
  it('output-matches tests a regex (fail closed on a bad pattern)', () => {
    const a = { name: 'x', kind: 'output-matches' as const, pattern: '\\d+ tests', flags: '' };
    expect(evalAssertion(a, 0, '42 tests ran')).toBe(true);
    expect(evalAssertion(a, 0, 'no tests')).toBe(false);
    expect(evalAssertion({ name: 'x', kind: 'output-matches', pattern: '(' }, 0, 'x')).toBe(false);
  });
});

describe('runGate — the sanitized receipt', () => {
  it('produces a receipt with NO raw stdout/stderr, only outputDigest + assertion results', async () => {
    const exec = new FakeExec({ stdout: 'v22\n', stderr: '', exitCode: 0 });
    const prof = profile({
      assertions: [
        { name: 'exit-ok', kind: 'exit-code', codes: [0] },
        { name: 'has-v', kind: 'output-contains', needle: 'v22' },
      ],
    });
    const outcome = await runGate(
      runInput({ profile: prof, policy: policy({ test: prof }), exec }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const r = outcome.receipt;
    expect(r.exitCode).toBe(0);
    expect(r.outputDigest).toMatch(/^blake3:[0-9a-f]+$/);
    expect(r.assertions).toEqual([
      { name: 'exit-ok', passed: true },
      { name: 'has-v', passed: true },
    ]);
    // the raw output never leaves runGate — the receipt schema has no stdout/stderr field
    expect(JSON.stringify(r)).not.toContain('v22');
  });

  it('the argv is the profile frozen — candidate content never adds args (PRD line 272)', async () => {
    const exec = new FakeExec({ stdout: '', stderr: '', exitCode: 0 });
    const prof = profile({ args: ['--version'] });
    await runGate(runInput({ profile: prof, policy: policy({ test: prof }), exec }));
    expect(exec.spawned[0]?.args).toEqual(['--version']);
  });

  it('passes through ONLY permittedEnv names (drops SECRET_TOKEN even though present)', async () => {
    const exec = new FakeExec({ stdout: '', stderr: '', exitCode: 0 });
    const prof = profile({ permittedEnv: ['PATH'] });
    await runGate(runInput({ profile: prof, policy: policy({ test: prof }), exec }));
    const env = exec.spawned[0]?.env ?? {};
    expect(env.PATH).toBe('/usr/bin');
    expect(env.SECRET_TOKEN).toBeUndefined();
  });

  it('records the resolved executable path + policyHash + profileHash + head + worktreeDigest', async () => {
    const exec = new FakeExec({ stdout: '', stderr: '', exitCode: 0 }, '/opt/node');
    const prof = profile();
    const pol = policy({ test: prof });
    const outcome = await runGate(runInput({ profile: prof, policy: pol, exec }));
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.receipt.executable).toBe('/opt/node');
    expect(outcome.receipt.policyHash).toBe(policyHash(pol));
    expect(outcome.receipt.profileHash).toBe(profileHash(prof));
    expect(outcome.receipt.head).toBe(HEAD);
    expect(outcome.receipt.worktreeDigest).toBe(DIGEST);
    expect(outcome.receipt.runner).toBe('ci');
  });

  it('timeout → exit 124 + records the timeout', async () => {
    const exec = new FakeExec({ stdout: '', stderr: '', exitCode: 0, timedOut: true });
    const prof = profile({ assertions: [{ name: 'exit-ok', kind: 'exit-code', codes: [0] }] });
    const outcome = await runGate(
      runInput({ profile: prof, policy: policy({ test: prof }), exec }),
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.receipt.exitCode).toBe(GATE_TIMEOUT_EXIT);
    expect(outcome.receipt.assertions[0]?.passed).toBe(false); // 124 ∉ [0]
  });

  it('is content-addressed: identical input reproduces an identical receipt id (idempotent)', async () => {
    const exec = new FakeExec({ stdout: 'v22\n', stderr: '', exitCode: 0 });
    const prof = profile();
    const pol = policy({ test: prof });
    const a = await runGate(runInput({ profile: prof, policy: pol, exec }));
    const b = await runGate(runInput({ profile: prof, policy: pol, exec }));
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.receipt.id).toBe(b.receipt.id);
    // and the id matches the ids.ts receiptId() over the same semantic content
    const expected = receiptId({
      policyHash: policyHash(pol),
      profileHash: profileHash(prof),
      executable: '/usr/bin/node',
      args: prof.args,
      head: HEAD,
      worktreeDigest: DIGEST,
      exitCode: 0,
      outputDigest: a.receipt.outputDigest,
      assertions: a.receipt.assertions,
      runner: 'ci',
    });
    expect(a.receipt.id).toBe(expected);
  });

  it('fail-closed: unresolvable executable → ok:false, no receipt', async () => {
    const exec: GateExecPort = {
      resolveExecutable: () => {
        throw new Error('not on PATH');
      },
      execFile: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    };
    const prof = profile();
    const outcome = await runGate(
      runInput({ profile: prof, policy: policy({ test: prof }), exec }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('could not resolve');
  });

  it('fail-closed: spawn failure → ok:false, no receipt', async () => {
    const exec: GateExecPort = {
      resolveExecutable: () => '/opt/node',
      execFile: () => Promise.reject(new Error('ENOENT')),
    };
    const prof = profile();
    const outcome = await runGate(
      runInput({ profile: prof, policy: policy({ test: prof }), exec }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('gate execution failed');
  });
});

describe('NodeGateExecPort.resolveExecutable', () => {
  it('passes an absolute path through', () => {
    const port = new NodeGateExecPort();
    expect(port.resolveExecutable('/usr/bin/node', {})).toBe('/usr/bin/node');
  });
  it('throws when not found on PATH', () => {
    const port = new NodeGateExecPort();
    expect(() => port.resolveExecutable('no-such-binary-xyz', { PATH: '/tmp' })).toThrow(
      /not found on PATH/,
    );
  });
});
