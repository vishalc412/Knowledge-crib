import { describe, expect, it } from 'vitest';
import { serverInstructions } from './server.js';
import type { Verbs } from './verbs.js';

const verbsWith = (memoryHandoff: () => unknown): Verbs => ({ memoryHandoff }) as unknown as Verbs;

describe('serverInstructions — the handshake every MCP client injects', () => {
  it('carries the protocol and the previous session left in memory', () => {
    const text = serverInstructions(
      verbsWith(() => ({
        continuation: {
          question: 'No intake is open, but the previous session left context (see carryOver).',
          carryOver: ['Note (not yet verified): split graph.json per module'],
          options: [{ label: 'Start fresh — begin new work' }],
        },
      })),
    );
    expect(text).toContain('op:"handoff"');
    expect(text).toContain('split graph.json per module');
    expect(text).not.toContain('Start fresh — begin new work');
  });

  it('falls back to the protocol alone when memory cannot be read', () => {
    const text = serverInstructions(
      verbsWith(() => {
        throw new Error('store locked');
      }),
    );
    expect(text).toContain('op:"handoff"');
    expect(text).not.toContain('State of this repository');
  });

  it('stays within the size clients will prepend to a prompt', () => {
    const text = serverInstructions(
      verbsWith(() => ({ continuation: { carryOver: Array(200).fill('x'.repeat(100)) } })),
    );
    expect(text.length).toBeLessThanOrEqual(2_400);
  });
});
