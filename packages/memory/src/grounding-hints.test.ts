/**
 * Quote hints. Found on a real bug fix: an agent cited a line it had read BEFORE editing the file,
 * crib refused the memory as "quote not found", and the refusal gave no clue what the code now says.
 * Separately, `capture` quoted the first 240 characters of the anchored method — its signature —
 * which is exactly what the fix changed, so the evidence drifted on the next revalidation.
 */
import type { Node } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import { closestLiveText, liftRelevantQuote } from './index.js';
import type { RehydratePort } from './index.js';

const PATH = 'src/EventTeamAuthorizationValidator.java';
const FILE_NODE = { id: `file:${PATH}`, kind: 'file', file: PATH, hash: 'h' } as Node;
const LINES = [
  'public class EventTeamAuthorizationValidator {',
  '    static void validateEventRequestType(TardisEventType type, boolean canRequestClassroom,',
  '            boolean canRequestWorldFestival, List<String> gradeBands, String country) {',
  '        validateEventRequestType(type, canRequestClassroom, canRequestWorldFestival);',
  '        Event probe = new Event();',
  '        if (Event.gradeBandsMixK2WithOthers(gradeBands)) {',
  '            throw new IllegalArgumentException("K-2 cannot share an event");',
  '        }',
  '    }',
  '}',
];

const port: RehydratePort = {
  rehydrate: (n: Node, opts?: { startLine?: number }) => {
    const from = Math.max(opts?.startLine ?? n.span?.start ?? 1, 1);
    const to = n.span?.end ?? LINES.length;
    return {
      text: LINES.slice(from - 1, to).join('\n'),
      truncated: false,
      totalLines: LINES.length,
      startLine: from,
    };
  },
};

describe('closestLiveText — what the code says now, for a refused quote', () => {
  it('returns the most similar current line, preferring the cited neighbourhood', () => {
    // the pre-edit line the agent remembered
    const hint = closestLiveText(
      port,
      FILE_NODE,
      'if (probe.isFllGradeBandK2Only(gradeBands)) {',
      5,
    );
    expect(hint).toEqual({
      line: 6,
      text: 'if (Event.gradeBandsMixK2WithOthers(gradeBands)) {',
    });
  });

  it('matches a multi-line quote against a window of the same height', () => {
    const hint = closestLiveText(
      port,
      FILE_NODE,
      'static void validateEventRequestType(TardisEventType type, boolean canRequestClassroom,\n boolean canRequestWorldFestival, List<String> gradeBands) {',
      2,
    );
    expect(hint?.line).toBe(2);
    expect(hint?.text).toContain('String country');
  });

  it('offers nothing when no line is meaningfully similar', () => {
    expect(
      closestLiveText(port, FILE_NODE, 'SELECT * FROM teams WHERE region = ?', 3),
    ).toBeUndefined();
  });
});

describe('liftRelevantQuote — a stable, relevant capture quote', () => {
  const body = LINES.slice(1, 9).join('\n');

  it('quotes the line naming what the observation is about, not the signature', () => {
    expect(
      liftRelevantQuote(
        body,
        'K-2 must not share an event; enforced via gradeBandsMixK2WithOthers',
        240,
      ),
    ).toBe('if (Event.gradeBandsMixK2WithOthers(gradeBands)) {');
  });

  it('falls back to the head of the span when nothing in the observation appears in it', () => {
    expect(liftRelevantQuote(body, 'unrelated prose', 40)).toBe(body.trim().slice(0, 40));
  });
});
