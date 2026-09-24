import { createHash } from 'node:crypto';
import type { ImplementationRecord } from './types.js';

/** Stable identity for one principal's declared implementation of one plan over one Git range. */
export function implementationRecordId(
  input: Pick<
    ImplementationRecord,
    'namespace' | 'intakeId' | 'planSha256' | 'baseCommit' | 'headCommit' | 'category' | 'audience'
  >,
): string {
  if (!input.namespace.projectId) throw new Error('implementation projectId is required');
  const seed = [
    input.namespace.principalId,
    input.namespace.projectId,
    input.intakeId,
    input.planSha256,
    input.baseCommit,
    input.headCommit,
    input.category,
    input.audience,
  ];
  return `impl:${createHash('sha256').update(JSON.stringify(seed)).digest('hex')}`;
}

export function implementationArchivePath(
  record: Pick<ImplementationRecord, 'id' | 'audience'>,
): string {
  return record.audience === 'team'
    ? `docs/implemented-plans/${record.id.slice(5)}.md`
    : `implementations/${record.id.slice(5)}.md`;
}
