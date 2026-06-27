import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { Verbs } from './verbs.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-srv-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('MCP server wiring', () => {
  it('builds a server with all verbs registered without throwing', () => {
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    soul.commit('2026-01-01T00:00:00.000Z');
    const index = new SqliteIndexStore();
    index.buildFromSoul(soul, dir);
    const server = buildServer(new Verbs({ soul, index, repoRoot: dir }), '1.2.3');
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
    index.close();
  });
});
