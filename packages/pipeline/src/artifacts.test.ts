/**
 * W1 — the deterministic AI-artifact graph (PRD §"Deterministic AI-artifact graph", lines 189-197).
 *
 * Proves the three load-bearing claims of Slice B:
 *   1. The committed scanner finds a TRACKED artifact that lives under a `.gitignore`d tool dir
 *      (`.claude/`) — the normal `discoverFiles` walk misses it (gitignore-aware), but `git ls-files`
 *      lists it (tracked files survive a `.gitignore`), so the artifact phase is the ONLY path that
 *      surfaces it. This is the PRD line-194 case.
 *   2. `governs` / `requires` / `invokes` edges resolve against the indexed symbol + sibling-artifact
 *      + MCP graph (frontmatter `appliesTo`→symbol, `requires`→artifact, `invokes`→`mcp:<name>`).
 *   3. MCP-server config parsing is secret-safe: `env` is never read, arg VALUES are not stored (only
 *      the count), and a command string matching a secret pattern is redacted to `<redacted>`.
 * Plus the W1 exit-gate byte-stability check: two independent reindexes produce byte-identical souls.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchGlob } from './artifacts.js';
import { indexRepo } from './pipeline.js';
import { discoverFiles } from './structure.js';
import { trackedFiles } from './vcs.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-artifacts-'));
  mkdirSync(join(repo, '.claude', 'skills', 'auth-skill'), { recursive: true });
  mkdirSync(join(repo, 'docs', 'agents'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });

  // A tracked skill UNDER a .gitignore'd tool dir — force-added. The normal walk misses it; the
  // committed scanner (git ls-files) is the only path that surfaces it (PRD line 194).
  writeFileSync(
    join(repo, '.claude', 'skills', 'auth-skill', 'SKILL.md'),
    [
      '---',
      'name: auth-skill',
      'artifactType: skill',
      'appliesTo:',
      '  - AuthService.login',
      '---',
      '',
      '# auth-skill',
      '',
      'Govern the `AuthService.login` entrypoint. See [sessions](docs/auth.md#sessions).',
      '',
    ].join('\n'),
  );

  // A tracked agent artifact that `requires` the skill (by artifact name) and `invokes` an MCP server.
  writeFileSync(
    join(repo, 'docs', 'agents', 'reviewer.md'),
    [
      '---',
      'name: reviewer',
      'artifactType: agent',
      'requires:',
      '  - auth-skill',
      'invokes:',
      '  - mcp:reviewer-llm',
      '---',
      '',
      '# reviewer',
      '',
      'Reviews auth changes against `AuthService.login`.',
      '',
    ].join('\n'),
  );

  // A root instruction artifact with a body link to the symbol's source file.
  writeFileSync(
    join(repo, 'AGENTS.md'),
    '# Agent conventions\n\nAuth lives in [auth](src/auth.ts).\n',
  );

  // The symbol the skill `governs`. Must exist in the indexed graph for the edge to resolve.
  writeFileSync(
    join(repo, 'src', 'auth.ts'),
    'export class AuthService {\n  login(): void {}\n}\n',
  );

  // MCP config: one benign server (command + args + a SECRET env value) + one whose command itself
  // matches the secret pattern. Neither env value nor arg values may reach a node.
  writeFileSync(
    join(repo, '.mcp.json'),
    `${JSON.stringify(
      {
        mcpServers: {
          'reviewer-llm': {
            command: 'npx',
            args: ['-y', '@scope/reviewer'],
            env: { API_KEY: 'super-secret-value-123' },
          },
          'secret-token-runner': {
            command: 'secret-key-runner',
            args: [],
            env: { TOKEN: 'another-secret' },
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  // .gitignore the tool dir, then force-add the one tracked artifact under it.
  writeFileSync(join(repo, '.gitignore'), '.claude/\n');
  git(repo, ['init', '-q']);
  git(repo, ['add', '-A']);
  git(repo, ['add', '-f', '.claude/skills/auth-skill/SKILL.md']);
  git(repo, ['-c', 'user.email=t@t.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'initial']);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function soulFor(suffix = '.crib'): SoulStore {
  const s = new SoulStore(join(repo, suffix), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z', repoId: 'test-artifact-repo' }),
  });
  s.load();
  return s;
}

async function index(soul: SoulStore): Promise<void> {
  await indexRepo(soul, repo, {
    now: '2026-01-01T00:00:00.000Z',
    ownership: false,
    dossiers: false,
    cluster: false,
    semantic: false,
  });
}

function artifacts(soul: SoulStore): Node[] {
  return [...soul.iterate('agent-artifact')];
}

function edges(soul: SoulStore, rel: string): Edge[] {
  return [...soul.iterateEdges()].filter((e) => e.rel === rel);
}

describe('runArtifactGraph — W1 AI-artifact graph', () => {
  it('finds a tracked skill under a .gitignored tool dir that the normal walk misses (PRD line 194)', async () => {
    const skillRel = '.claude/skills/auth-skill/SKILL.md';
    // The normal gitignore-aware walk skips it (.claude/ is gitignored):
    expect(discoverFiles(repo).map((f) => f.path)).not.toContain(skillRel);
    // ...but `git ls-files` lists it (tracked survives .gitignore):
    expect(trackedFiles(repo)).toContain(skillRel);

    const soul = soulFor();
    await index(soul);
    const nodes = artifacts(soul);
    const skill = nodes.find((n) => n.file === skillRel);
    expect(skill).toBeDefined();
    expect(skill?.artifactType).toBe('skill');
    expect(skill?.name).toBe('auth-skill');
    expect(skill?.id).toBe(`art:${skillRel}#auth-skill`);
  });

  it('emits one agent-artifact node per tracked artifact with the correct artifactType', async () => {
    const soul = soulFor();
    await index(soul);
    const byFile = new Map(artifacts(soul).map((n) => [n.file ?? '', n]));
    expect(byFile.get('docs/agents/reviewer.md')?.artifactType).toBe('agent');
    expect(byFile.get('AGENTS.md')?.artifactType).toBe('instruction');
  });

  it('resolves governs (artifact→symbol), requires (artifact→artifact), invokes (artifact→mcp) edges', async () => {
    const soul = soulFor();
    await index(soul);
    const nodes = artifacts(soul);
    const byName = new Map(nodes.map((n) => [n.name ?? '', n]));
    const skill = byName.get('auth-skill')!;
    const reviewer = byName.get('reviewer')!;
    const mcp = byName.get('mcp:reviewer-llm')!;

    // governs: skill → AuthService.login (frontmatter appliesTo → qualified symbol)
    const g = edges(soul, 'governs').find((e) => e.src === skill.id);
    expect(g).toBeDefined();
    const target = soul.getNode(g!.dst);
    expect(target?.qualifiedName).toBe('AuthService.login');

    // requires: reviewer → auth-skill (frontmatter requires → sibling artifact by name)
    const r = edges(soul, 'requires').find((e) => e.src === reviewer.id);
    expect(r?.dst).toBe(skill.id);

    // invokes: reviewer → mcp:reviewer-llm (frontmatter invokes → mcp: prefix)
    const inv = edges(soul, 'invokes').find((e) => e.src === reviewer.id);
    expect(inv?.dst).toBe(mcp.id);
  });

  it('stamps every artifact edge with evidence.targetHash (the grounding moat)', async () => {
    const soul = soulFor();
    await index(soul);
    const rels = new Set(['governs', 'requires', 'invokes']);
    const artifactEdges = [...soul.iterateEdges()].filter((e) => rels.has(e.rel));
    expect(artifactEdges.length).toBeGreaterThan(0);
    for (const e of artifactEdges) {
      expect(e.evidence?.targetHash).toMatch(/^blake3:/);
    }
  });

  it('redacts MCP secrets: never reads env, stores only arg count, redacts secret commands', async () => {
    const soul = soulFor();
    await index(soul);
    const nodes = artifacts(soul);
    const benign = nodes.find((n) => n.name === 'mcp:reviewer-llm')!;
    const secret = nodes.find((n) => n.name === 'mcp:secret-token-runner')!;

    expect(benign).toBeDefined();
    expect(benign.artifactType).toBe('mcp-server');
    expect(benign.meta?.command).toBe('npx');
    expect(benign.meta?.argsCount).toBe(2);
    expect(benign.meta?.envRedacted).toBe(true);
    // the env value must NOT have leaked into the node
    expect(JSON.stringify(benign)).not.toContain('super-secret-value-123');

    expect(secret).toBeDefined();
    expect(secret.meta?.command).toBe('<redacted>'); // command matched the secret pattern
    expect(JSON.stringify(secret)).not.toContain('another-secret');
  });

  it('emits an unresolved-ref diagnostic for a body link to a non-existent file (no silent drop)', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, repo, {
      now: '2026-01-01T00:00:00.000Z',
      ownership: false,
      dossiers: false,
      cluster: false,
      semantic: false,
    });
    // The skill body links to docs/auth.md#sessions, which does not exist in the fixture → unresolved.
    const missing = report.artifacts.diagnostics.find((d) => d.ref.includes('docs/auth.md'));
    expect(missing).toBeDefined();
    expect(missing?.kind).toBe('unresolved');
    expect(missing?.rel).toBe('governs');
  });

  it('matchGlob: ** across separators, * one segment, ? one char, literal dots', () => {
    expect(matchGlob('.claude/skills/**/SKILL.md', '.claude/skills/auth-skill/SKILL.md')).toBe(
      true,
    );
    expect(matchGlob('.claude/skills/**/SKILL.md', '.claude/skills/a/b/c/SKILL.md')).toBe(true);
    expect(matchGlob('.claude/skills/**/SKILL.md', '.claude/skills/SKILL.md')).toBe(true); // **/ = zero segs
    expect(matchGlob('.claude/skills/**/SKILL.md', '.claude/skills/auth-skill/OTHER.md')).toBe(
      false,
    );
    expect(matchGlob('**/AGENTS.md', 'AGENTS.md')).toBe(true);
    expect(matchGlob('**/AGENTS.md', 'docs/AGENTS.md')).toBe(true);
    expect(matchGlob('**/.mcp.json', '.mcp.json')).toBe(true);
    expect(matchGlob('.cursor/rules/**/*.mdc', '.cursor/rules/foo.mdc')).toBe(true);
    expect(matchGlob('.cursor/rules/**/*.mdc', '.cursor/rules/x/y.mdc')).toBe(true);
    // `*` does not cross a separator:
    expect(matchGlob('docs/*/SKILL.md', 'docs/a/SKILL.md')).toBe(true);
    expect(matchGlob('docs/*/SKILL.md', 'docs/a/b/SKILL.md')).toBe(false);
  });

  it('is byte-identical across two independent reindexes (W1 exit gate)', async () => {
    // Use `.crib` (in DEFAULT_IGNORES, so discoverFiles never walks the soul dir as source) and rm
    // between runs so the two indexes are truly independent — two side-by-side crib dirs would let
    // the second run's discoverFiles descend into the first's shards.
    const a = soulFor();
    await index(a);
    const snapA = snapshotSoul(join(repo, '.crib'));

    rmSync(join(repo, '.crib'), { recursive: true, force: true });

    const b = soulFor();
    await index(b);
    const snapB = snapshotSoul(join(repo, '.crib'));

    expect(snapA.size).toBe(snapB.size);
    for (const [path, content] of snapA) {
      expect(snapB.get(path), `shard ${path}`).toBe(content);
    }
  });
});

/** Snapshot every extracted node/edge shard + the manifest as a {relpath: content} map. */
function snapshotSoul(cribDir: string): Map<string, string> {
  const snap = new Map<string, string>();
  for (const sub of ['nodes', 'edges']) {
    const base = join(cribDir, 'graph', 'extracted', sub);
    for (const p of walkJsonl(base)) snap.set(`${sub}/${rel(base, p)}`, readFileSync(p, 'utf8'));
  }
  snap.set('graph/manifest.json', readFileSync(join(cribDir, 'graph', 'manifest.json'), 'utf8'));
  return snap;
}
function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  let entries: { isDirectory(): boolean; name: string }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as {
      isDirectory(): boolean;
      name: string;
    }[];
  } catch {
    return out; // dir absent (no edges, etc.) — nothing to snapshot
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonl(full));
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}
function rel(base: string, full: string): string {
  return full.slice(base.length + 1).replace(/\\/g, '/');
}
