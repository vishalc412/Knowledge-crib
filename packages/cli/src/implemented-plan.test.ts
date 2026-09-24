import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareImplementedPlan } from './implemented-plan.js';

const roots: string[] = [];
// Build the fake credential at runtime so this test's own committed patch is archive-safe.
const fakeKey = (): string => ['sk', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('-');
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
function repo(): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), 'implemented-plan-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'plan.md'), '# Plan\n\nAdd one feature.\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'plan');
  const base = git(root, 'rev-parse', 'HEAD');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'feature.ts'), 'export const feature = true;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'feature');
  return { root, base, head: git(root, 'rev-parse', 'HEAD') };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('implemented plan archive', () => {
  it('captures the verbatim plan and complete committed patch deterministically', () => {
    const { root, base, head } = repo();
    const input = {
      repoRoot: root,
      intakeId: `intake:${'b'.repeat(64)}`,
      principalId: 'principal-1',
      projectId: 'repo-1',
      planPath: 'docs/plan.md',
      base,
      category: 'enhancement' as const,
      summary: 'Feature done',
      audience: 'private' as const,
      receiptIds: [],
      actor: 'human:principal-1',
    };
    const first = prepareImplementedPlan(input);
    const second = prepareImplementedPlan(input);
    expect(first.record.id).toBe(second.record.id);
    expect(first.markdown).toBe(second.markdown);
    expect(first.record.headCommit).toBe(head);
    expect(first.markdown).toContain(readFileSync(join(root, 'docs', 'plan.md'), 'utf8'));
    expect(first.markdown).toContain('diff --git a/src/feature.ts b/src/feature.ts');
  });

  it('rejects dirty trees and unrelated base commits before archive creation', () => {
    const { root, base } = repo();
    const input = {
      repoRoot: root,
      intakeId: `intake:${'b'.repeat(64)}`,
      principalId: 'principal-1',
      projectId: 'repo-1',
      planPath: 'docs/plan.md',
      base,
      category: 'addon' as const,
      summary: 'Feature done',
      audience: 'private' as const,
      receiptIds: [],
      actor: 'human:principal-1',
    };
    writeFileSync(join(root, 'dirty.txt'), 'dirty');
    expect(() => prepareImplementedPlan(input)).toThrow(/clean/i);
  });

  it('rejects empty ranges, missing plans, and secrets in the committed patch', () => {
    const { root, base, head } = repo();
    const input = {
      repoRoot: root,
      intakeId: `intake:${'b'.repeat(64)}`,
      principalId: 'principal-1',
      projectId: 'repo-1',
      planPath: 'docs/plan.md',
      base,
      category: 'fix' as const,
      summary: 'Fix complete',
      audience: 'private' as const,
      receiptIds: [],
      actor: 'human:principal-1',
    };
    expect(() => prepareImplementedPlan({ ...input, base: head })).toThrow(/empty change range/i);
    expect(() => prepareImplementedPlan({ ...input, planPath: 'docs/missing.md' })).toThrow();
    writeFileSync(join(root, 'src', 'credential.txt'), `${fakeKey()}\n`);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'include credential');
    expect(() => prepareImplementedPlan(input)).toThrow(/secret patterns/i);
  });

  it('rejects a base commit outside the current history', () => {
    const { root, base } = repo();
    const branch = git(root, 'branch', '--show-current');
    git(root, 'switch', '--orphan', 'unrelated');
    writeFileSync(join(root, 'unrelated.txt'), 'other\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'unrelated');
    const unrelated = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', branch);
    expect(() =>
      prepareImplementedPlan({
        repoRoot: root,
        intakeId: `intake:${'b'.repeat(64)}`,
        principalId: 'principal-1',
        projectId: 'repo-1',
        planPath: 'docs/plan.md',
        base: unrelated,
        category: 'refactor',
        summary: 'Refactor complete',
        audience: 'private',
        receiptIds: [],
        actor: 'human:principal-1',
      }),
    ).toThrow(/ancestor/i);
    expect(base).not.toBe(unrelated);
  });

  it('scans changed binary blobs before archiving their encoded patch', () => {
    const { root, base } = repo();
    writeFileSync(
      join(root, 'src', 'binary.bin'),
      Buffer.from(['header\0', fakeKey(), '\0footer'].join('')),
    );
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'binary change');
    expect(() =>
      prepareImplementedPlan({
        repoRoot: root,
        intakeId: `intake:${'b'.repeat(64)}`,
        principalId: 'principal-1',
        projectId: 'repo-1',
        planPath: 'docs/plan.md',
        base,
        category: 'addon',
        summary: 'Binary change complete',
        audience: 'private',
        receiptIds: [],
        actor: 'human:principal-1',
      }),
    ).toThrow(/secret patterns/i);
  });
});
