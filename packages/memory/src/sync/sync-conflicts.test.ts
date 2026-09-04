/**
 * D8 conflict-projection tests: the retirement-set rules mirrored from the merge driver, the
 * composable-flag rule (quarantine never conflicts), and determinism.
 */
import { describe, expect, it } from 'vitest';
import { type DecisionConflictGroup, decisionConflicts } from './sync-conflicts.js';
import { decision } from './sync-test-fixtures.js';

describe('decisionConflicts (D8)', () => {
  it('flags a retract+supersede on one subject (rule-3 posture, never auto-resolved)', () => {
    const conflicts = decisionConflicts([
      decision('retract', 'mem:a'),
      decision('supersede', 'mem:a', 'mem:b'),
      decision('activate', 'mem:a'), // non-retiring kinds never group
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      subject: 'mem:a',
      kind: 'retract-supersede',
      decisionIds: expect.arrayContaining([
        decision('retract', 'mem:a').id,
        decision('supersede', 'mem:a', 'mem:b').id,
      ]),
    });
    expect(conflicts[0]?.decisionIds).toHaveLength(2);
  });

  it('flags two supersedes naming DIFFERENT successors (divergent-successors)', () => {
    const conflicts = decisionConflicts([
      decision('supersede', 'mem:a', 'mem:b1'),
      decision('supersede', 'mem:a', 'mem:b2'),
    ]);
    expect(conflicts).toEqual([
      { subject: 'mem:a', kind: 'divergent-successors', decisionIds: expect.any(Array) },
    ]);
  });

  it('lets two supersedes naming the SAME successor converge (no conflict)', () => {
    expect(
      decisionConflicts([
        decision('supersede', 'mem:a', 'mem:b'),
        decision('supersede', 'mem:a', 'mem:b'),
      ]),
    ).toEqual([]);
  });

  it('quarantine is composable and never conflicts — even alongside a supersede', () => {
    expect(
      decisionConflicts([
        decision('quarantine', 'mem:a'),
        decision('quarantine', 'mem:a'),
        decision('supersede', 'mem:a', 'mem:b'),
        decision('supersede', 'mem:a', 'mem:b'),
      ]),
    ).toEqual([]);
  });

  it('never groups decisions on different subjects', () => {
    expect(
      decisionConflicts([
        decision('retract', 'mem:a'),
        decision('supersede', 'mem:other', 'mem:z'),
      ]),
    ).toEqual([]);
  });

  it('an absent successor counts as a distinct value', () => {
    const conflicts = decisionConflicts([
      decision('supersede', 'mem:a'), // no successor
      decision('supersede', 'mem:a', 'mem:b'),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('divergent-successors');
  });

  it('is deterministic: groups sort by subject, ids sort within a group', () => {
    const conflicts = decisionConflicts([
      decision('supersede', 'mem:c', 'mem:z1'),
      decision('retract', 'mem:b'),
      decision('supersede', 'mem:b', 'mem:x'),
      decision('supersede', 'mem:c', 'mem:z2'),
      decision('retract', 'mem:a'), // a lone retract is not a conflict — no group
    ]);
    expect(conflicts.map((g: DecisionConflictGroup) => g.subject)).toEqual(['mem:b', 'mem:c']);
    expect(conflicts[0]?.kind).toBe('retract-supersede');
    expect(conflicts[1]?.kind).toBe('divergent-successors');
    expect(conflicts[1]?.decisionIds).toEqual([...conflicts[1]!.decisionIds].sort());
  });
});
