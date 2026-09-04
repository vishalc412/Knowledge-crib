import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentProfileAliasError, AgentProfileDirectory } from './identity-directory.js';

const roots: string[] = [];

function directory(): AgentProfileDirectory {
  const rootDir = mkdtempSync(join(tmpdir(), 'knowledge-crib-identities-'));
  roots.push(rootDir);
  return new AgentProfileDirectory({ rootDir });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('AgentProfileDirectory', () => {
  it('resolves a configured vendor alias into one durable profile for its owning principal', () => {
    const profiles = directory();
    const profile = profiles.register({
      principalId: 'principal:alice',
      profileKey: 'architect',
      aliases: [
        { clientId: 'codex', agentId: 'thread-123' },
        { clientId: 'cursor', agentId: 'agent_456' },
      ],
    });

    expect(profile.id).toBe('agent-profile:principal:alice:architect');
    expect(
      profiles.resolve(
        { principalId: 'principal:alice', workspaceId: 'workspace:product' },
        { clientId: 'cursor', agentId: 'agent_456' },
      ),
    ).toEqual({
      principalId: 'principal:alice',
      workspaceId: 'workspace:product',
      agentProfileId: profile.id,
    });
    // A re-opened directory returns the same durable identity association.
    expect(
      new AgentProfileDirectory({ rootDir: roots.at(-1)! }).resolve(
        { principalId: 'principal:alice' },
        { clientId: 'codex', agentId: 'thread-123' },
      ),
    ).toMatchObject({ agentProfileId: profile.id });
  });

  it('never resolves a profile alias across a principal boundary', () => {
    const profiles = directory();
    profiles.register({
      principalId: 'principal:alice',
      profileKey: 'architect',
      aliases: [{ clientId: 'codex', agentId: 'thread-123' }],
    });

    expect(
      profiles.resolve(
        { principalId: 'principal:bob' },
        { clientId: 'codex', agentId: 'thread-123' },
      ),
    ).toEqual({ principalId: 'principal:bob' });
  });

  it('refuses an alias that is already bound to a different profile', () => {
    const profiles = directory();
    profiles.register({
      principalId: 'principal:alice',
      profileKey: 'architect',
      aliases: [{ clientId: 'codex', agentId: 'thread-123' }],
    });

    expect(() =>
      profiles.register({
        principalId: 'principal:alice',
        profileKey: 'reviewer',
        aliases: [{ clientId: 'codex', agentId: 'thread-123' }],
      }),
    ).toThrow(AgentProfileAliasError);
  });
});
