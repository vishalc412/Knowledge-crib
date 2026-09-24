import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  type ImplementationRecord,
  implementationArchivePath,
  implementationRecordId,
  scanSecrets,
} from '@knowledge-crib/memory';

export interface ImplementedPlanInput {
  repoRoot: string;
  intakeId: string;
  principalId: string;
  projectId: string;
  planPath: string;
  base: string;
  category: ImplementationRecord['category'];
  summary: string;
  audience: ImplementationRecord['audience'];
  receiptIds: string[];
  receipts?: Array<{
    id: string;
    runner: string;
    head: string;
    exitCode: number;
    policyHash: string;
    profileHash: string;
    outputDigest: string;
  }>;
  actor: string;
  /** Read-only retry path after a matching completed implementation is already known. */
  allowDirty?: boolean;
}

export interface PreparedImplementedPlan {
  record: ImplementationRecord;
  markdown: string;
}

const SHA256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitBlob(root: string, objectId: string): Buffer {
  return execFileSync('git', ['cat-file', 'blob', objectId], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitCheck(root: string, args: string[]): boolean {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

export function gitDirtyPaths(repoRoot: string): string[] {
  const fields = git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    .split('\0')
    .filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    if (/[RC]/.test(status) && index + 1 < fields.length) paths.push(fields[++index]!);
  }
  return paths;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Build an immutable report from committed Git state. The caller owns persistence and the final
 * intake checkpoint; this function performs every read and secret preflight before any write.
 */
export function prepareImplementedPlan(input: ImplementedPlanInput): PreparedImplementedPlan {
  const root = realpathSync(input.repoRoot);
  const absolutePlan = realpathSync(resolve(root, input.planPath));
  if (!inside(root, absolutePlan) || !absolutePlan.endsWith('.md')) {
    throw new Error('plan must be a Markdown file inside the repository');
  }
  const planPath = relative(root, absolutePlan).split(sep).join('/');
  const plan = readFileSync(absolutePlan, 'utf8');
  const summary = input.summary.replace(/\s+/g, ' ').trim();
  if (!summary) throw new Error('implementation summary is empty');
  if (!plan.trim()) throw new Error('plan is empty');
  if (!input.allowDirty && git(root, ['status', '--porcelain', '--untracked-files=all']).trim()) {
    throw new Error('implemented plan requires a clean committed worktree');
  }
  const baseCommit = git(root, ['rev-parse', '--verify', `${input.base}^{commit}`]).trim();
  const headCommit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  if (baseCommit === headCommit) throw new Error('base and HEAD have an empty change range');
  if (!gitCheck(root, ['merge-base', '--is-ancestor', baseCommit, headCommit])) {
    throw new Error('base must be an ancestor of HEAD');
  }
  const changedPaths = git(root, ['diff', '--name-only', '-z', baseCommit, headCommit])
    .split('\0')
    .filter(Boolean);
  if (changedPaths.length === 0) throw new Error('base and HEAD have an empty change range');
  const commits = git(root, ['rev-list', '--reverse', `${baseCommit}..${headCommit}`])
    .trim()
    .split('\n')
    .filter(Boolean);
  const patch = git(root, [
    'diff',
    '--binary',
    '--full-index',
    '--no-ext-diff',
    '--no-textconv',
    baseCommit,
    headCommit,
  ]);
  if (!patch.trim()) throw new Error('Git produced an empty patch');
  // A binary patch encodes blob bytes, so scanning only the readable Markdown would miss a token
  // embedded in a binary file. Scan both revisions of every changed blob before persisting.
  const scannedBlobs = new Set<string>();
  for (const path of changedPaths) {
    for (const revision of [baseCommit, headCommit]) {
      let objectId: string;
      try {
        objectId = git(root, ['rev-parse', '--verify', `${revision}:${path}`]).trim();
      } catch {
        continue; // added/deleted path in this revision
      }
      if (scannedBlobs.has(objectId)) continue;
      scannedBlobs.add(objectId);
      if (git(root, ['cat-file', '-t', objectId]).trim() !== 'blob') continue;
      const hits = scanSecrets(gitBlob(root, objectId).toString('utf8'));
      if (hits.length > 0) {
        throw new Error(
          `archive contains secret patterns in ${path}: ${hits.map((hit) => hit.name).join(', ')}`,
        );
      }
    }
  }
  const planSha256 = SHA256(plan);
  const patchSha256 = SHA256(patch);
  const id = implementationRecordId({
    namespace: { principalId: input.principalId, projectId: input.projectId },
    intakeId: input.intakeId,
    planSha256,
    baseCommit,
    headCommit,
    category: input.category,
    audience: input.audience,
  });
  const archivePath = implementationArchivePath({ id, audience: input.audience });
  const pathLines = changedPaths
    .map(
      (path) =>
        `- \`${path.replaceAll('`', '\\`')}\`${input.audience === 'team' ? ` ([source](../../${encodeURI(path)}))` : ''}`,
    )
    .join('\n');
  const fenceFor = (value: string): string =>
    '~'.repeat(Math.max(6, ...[...value.matchAll(/~+/g)].map((match) => match[0].length + 1)));
  const planFence = fenceFor(plan);
  const patchFence = fenceFor(patch);
  const markdown = [
    `# Implemented plan: ${summary}`,
    '',
    'This archive reports a committed change range. Confirm the linked intake has a completed',
    'checkpoint before treating the implementation as finished or release-ready.',
    '',
    `- Implementation: \`${id}\``,
    `- Intake: \`${input.intakeId}\``,
    `- Category: \`${input.category}\``,
    `- Audience: \`${input.audience}\``,
    `- Plan: \`${planPath}\` (SHA-256 \`${planSha256}\`)`,
    `- Base: \`${baseCommit}\``,
    `- Head: \`${headCommit}\``,
    `- Patch SHA-256: \`${patchSha256}\``,
    '',
    '## Commits',
    '',
    ...commits.map((commit) => `- \`${commit}\``),
    '',
    '## Changed paths',
    '',
    pathLines,
    '',
    '## Verification receipts',
    '',
    ...(input.receiptIds.length
      ? input.receiptIds.map((id) => {
          const receipt = input.receipts?.find((item) => item.id === id);
          if (!receipt) throw new Error(`receipt provenance is missing: ${id}`);
          return `- \`${id}\` — runner \`${receipt.runner}\`, HEAD \`${receipt.head}\`, exit \`${receipt.exitCode}\`, policy \`${receipt.policyHash}\`, profile \`${receipt.profileHash}\`, output \`${receipt.outputDigest}\``;
        })
      : ['- None supplied']),
    '',
    '## Original plan',
    '',
    `${planFence}markdown`,
    plan.replace(/\n$/, ''),
    planFence,
    '',
    '## Raw patch',
    '',
    `${patchFence}diff`,
    patch.replace(/\n$/, ''),
    patchFence,
    '',
  ].join('\n');
  const secretHits = scanSecrets(markdown);
  if (secretHits.length > 0) {
    throw new Error(
      `archive contains secret patterns: ${secretHits.map((hit) => hit.name).join(', ')}`,
    );
  }
  return {
    markdown,
    record: {
      id,
      schemaVersion: '1',
      namespace: { principalId: input.principalId, projectId: input.projectId },
      intakeId: input.intakeId,
      audience: input.audience,
      category: input.category,
      summary,
      planPath,
      planSha256,
      baseCommit,
      headCommit,
      commits,
      changedPaths,
      patchSha256,
      archivePath,
      archiveSha256: SHA256(markdown),
      receiptIds: [...input.receiptIds],
      actor: input.actor,
      recordedAt: new Date().toISOString(),
    },
  };
}
