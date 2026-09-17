import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { afterEach, describe, expect, it } from 'vitest';
import { indexRepo } from '../pipeline.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'tsx-renders',
);
const NOW = '2026-01-01T00:00:00.000Z';
let cribDir: string;
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

describe('TS resolver — cross-file JSX renders', () => {
  it('links <Child/> of an imported component to its definition, respecting local shadowing', async () => {
    cribDir = mkdtempSync(join(tmpdir(), 'crib-tsx-renders-'));
    const soul = new SoulStore(cribDir, { manifest: newManifest({ now: NOW }) });
    soul.load();
    await indexRepo(soul, FIXTURE, { now: NOW, cluster: false, semantic: false });
    const name = (id: string) => soul.getNode(id)?.qualifiedName ?? id;
    const renders = [...soul.iterateEdges('renders')].map(
      (e) => `${name(e.src)} -> ${name(e.dst)}`,
    );
    expect(renders).toContain('CoreGroup -> GradeBandGroup');
    expect(renders).not.toContain('Shadowed -> GradeBandGroup');
  });
});
