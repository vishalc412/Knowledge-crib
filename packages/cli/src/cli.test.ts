import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { SoulStore, newManifest, openIndex } from '@knowledge-crib/core';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syntheticMuleProject } from '../../../scripts/fixtures/synthetic-mule-project.mjs';

/**
 * End-to-end CLI dispatch tests for the P2 surface: `context --package <pkg>` (WS-4 bulk dossierByScope)
 * and `reconstruct <pkg>` (WS-6). Drives the BUILT `dist/cli.js` as a subprocess against a temp repo the
 * pipeline has indexed, so these exercise the real arg parsing + scope routing + the maxSymbols guard
 * (Blocker 2 regression) — not just the verbs (which are covered in @knowledge-crib/core / @knowledge-crib/mcp).
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');

let repo: string;
let pkgQname: string;

// A PL/SQL package SPEC with the two migration-critical CONSTANT thresholds (30/80) + three member
// procedures (so maxSymbols cap/truncation is testable). Mirrors the parser's captured shape
// (CONSTANT keyword precedes the type).
const SPEC = `CREATE OR REPLACE PACKAGE loan_pkg IS
  C_THRESHOLD_AUTO_REJECT   CONSTANT NUMBER := 30;
  C_THRESHOLD_AUTO_APPROVE  CONSTANT NUMBER := 80;
  PROCEDURE process_one(p_id NUMBER);
  PROCEDURE process_two(p_id NUMBER);
  PROCEDURE process_three(p_id NUMBER);
END loan_pkg;
/
`;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'crib-cli-e2e-'));
  mkdirSync(join(repo, 'db'), { recursive: true });
  writeFileSync(join(repo, 'db', 'loan_pkg_spec.sql'), SPEC);
  pkgQname = 'loan_pkg';
  // index the temp repo so .crib exists at the repo root (the CLI resolves .crib from cwd)
  const soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ root: '.' }) });
  soul.load();
  await indexRepo(soul, repo);
  mkdirSync(join(repo, '.crib', 'index'), { recursive: true });
  const index = openIndex(soul.getManifest().stores.index.backend, {
    path: join(repo, '.crib', 'index', 'crib.sqlite'),
  });
  index.buildFromSoul(soul, repo);
  index.close();
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** Run the CLI from the temp repo root, returning parsed JSON (or raw stdout for markdown). */
function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/** Run the CLI capturing a non-zero exit (e.g. BAD_ARGS) instead of throwing. */
function runCliResult(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: 0, stdout: out.trim(), stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? '').trim(),
    };
  }
}

describe('crib context --package (WS-4 bulk dossierByScope) — CLI dispatch', () => {
  it('returns all package members in one call (scope=package, per-symbol dossiers)', () => {
    const out = runCli(['context', '--package', pkgQname]);
    const r = JSON.parse(out) as {
      scope: string;
      label: string;
      symbolCount: number;
      symbols: Array<{ node: { qualifiedName?: string } }>;
      truncated: boolean;
      skipped: string[];
    };
    expect(r.scope).toBe('package');
    expect(r.label).toBe(pkgQname);
    // the package itself is NOT a member (members are the 3 procedures); spec-only → all unimplemented
    expect(r.symbolCount).toBe(3);
    expect(r.symbols).toHaveLength(3);
    expect(r.truncated).toBe(false);
    expect(r.skipped).toEqual([]);
    const qnames = r.symbols.map((s) => s.node.qualifiedName).sort();
    expect(qnames).toEqual(
      ['loan_pkg.process_one', 'loan_pkg.process_three', 'loan_pkg.process_two'].sort(),
    );
  });

  it('resolves by qualified name and supports --format markdown + --max-symbols cap', () => {
    // markdown format dispatches through dossiersByScopeToMarkdown
    const md = runCli(['context', '--package', pkgQname, '--format', 'markdown']);
    expect(md).toContain('# Dossier-by-scope: loan_pkg');
    expect(md).toContain('- symbols: 3');
    // the cap: --max-symbols 1 → truncated, symbolCount still 3
    const capped = JSON.parse(runCli(['context', '--package', pkgQname, '--max-symbols', '1'])) as {
      symbolCount: number;
      symbols: unknown[];
      truncated: boolean;
    };
    expect(capped.symbols).toHaveLength(1);
    expect(capped.symbolCount).toBe(3);
    expect(capped.truncated).toBe(true);
  });
});

describe('read commands use an existing derived index instead of rebuilding it', () => {
  it('reports a clear reindex instruction when the derived sqlite index is missing', async () => {
    const missingRepo = mkdtempSync(join(tmpdir(), 'crib-cli-missing-index-'));
    try {
      mkdirSync(join(missingRepo, 'db'), { recursive: true });
      writeFileSync(join(missingRepo, 'db', 'loan_pkg_spec.sql'), SPEC);
      const missingSoul = new SoulStore(join(missingRepo, '.crib'), {
        manifest: newManifest({ root: '.' }),
      });
      missingSoul.load();
      await indexRepo(missingSoul, missingRepo);

      const result = (() => {
        try {
          execFileSync(process.execPath, [CLI, 'status', '.'], {
            cwd: missingRepo,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return { status: 0, stderr: '' };
        } catch (e) {
          const err = e as { status?: number; stderr?: string };
          return { status: err.status ?? 1, stderr: (err.stderr ?? '').trim() };
        }
      })();

      expect(result.status).toBe(3);
      expect(result.stderr).toContain('derived index missing or stale');
      expect(result.stderr).toContain('run `crib index .`');
    } finally {
      rmSync(missingRepo, { recursive: true, force: true });
    }
  });
});

describe('crib index --crib-dir', () => {
  it('indexes into an external crib directory and registers that directory', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'crib-cli-external-source-'));
    const cribDir = mkdtempSync(join(tmpdir(), 'crib-cli-external-store-'));
    const registryDir = mkdtempSync(join(tmpdir(), 'crib-cli-external-registry-'));
    try {
      writeFileSync(join(sourceRoot, 'hello.ts'), 'export const hello = "world";\n');
      const result = (() => {
        try {
          const stdout = execFileSync(
            process.execPath,
            [CLI, 'index', sourceRoot, '--crib-dir', cribDir],
            {
              cwd: sourceRoot,
              encoding: 'utf8',
              env: { ...process.env, KCRIB_REGISTRY_DIR: registryDir },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          return { status: 0, stdout, stderr: '' };
        } catch (e) {
          const err = e as { status?: number; stdout?: string; stderr?: string };
          return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
        }
      })();

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(sourceRoot, '.crib'))).toBe(false);
      expect(existsSync(join(cribDir, 'crib.json'))).toBe(true);
      const registry = JSON.parse(readFileSync(join(registryDir, 'registry.json'), 'utf8')) as {
        projects: Record<string, { cribDir: string }>;
      };
      expect(registry.projects[sourceRoot]?.cribDir).toBe(realpathSync(cribDir));
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(cribDir, { recursive: true, force: true });
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  it('rejects relative paths and paths inside the source .git directory', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'crib-cli-external-invalid-'));
    try {
      writeFileSync(join(sourceRoot, 'hello.ts'), 'export const hello = "world";\n');
      mkdirSync(join(sourceRoot, '.git'));
      for (const cribDir of ['relative-crib', join(sourceRoot, '.git', 'crib')]) {
        const result = (() => {
          try {
            execFileSync(process.execPath, [CLI, 'index', sourceRoot, '--crib-dir', cribDir], {
              cwd: sourceRoot,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            return { status: 0, stderr: '' };
          } catch (e) {
            const err = e as { status?: number; stderr?: string };
            return { status: err.status ?? 1, stderr: err.stderr ?? '' };
          }
        })();
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('--crib-dir');
      }
      expect(existsSync(join(sourceRoot, '.crib'))).toBe(false);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it('uses the registered external crib directory when update omits --crib-dir', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'crib-cli-external-update-source-'));
    const cribDir = mkdtempSync(join(tmpdir(), 'crib-cli-external-update-store-'));
    const registryDir = mkdtempSync(join(tmpdir(), 'crib-cli-external-update-registry-'));
    const env = { ...process.env, KCRIB_REGISTRY_DIR: registryDir };
    try {
      writeFileSync(join(sourceRoot, 'hello.ts'), 'export const hello = "world";\n');
      execFileSync(process.execPath, [CLI, 'index', sourceRoot, '--crib-dir', cribDir], {
        cwd: sourceRoot,
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const result = (() => {
        try {
          execFileSync(process.execPath, [CLI, 'update', sourceRoot], {
            cwd: sourceRoot,
            encoding: 'utf8',
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return { status: 0, stderr: '' };
        } catch (e) {
          const err = e as { status?: number; stderr?: string };
          return { status: err.status ?? 1, stderr: err.stderr ?? '' };
        }
      })();
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(sourceRoot, '.crib'))).toBe(false);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(cribDir, { recursive: true, force: true });
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked external path that resolves inside source .git', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'crib-cli-external-symlink-source-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'crib-cli-external-symlink-outside-'));
    try {
      writeFileSync(join(sourceRoot, 'hello.ts'), 'export const hello = "world";\n');
      mkdirSync(join(sourceRoot, '.git'));
      const link = join(outsideRoot, 'git-link');
      symlinkSync(join(sourceRoot, '.git'), link, 'dir');
      const result = (() => {
        try {
          execFileSync(
            process.execPath,
            [CLI, 'index', sourceRoot, '--crib-dir', join(link, 'crib')],
            {
              cwd: sourceRoot,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          return { status: 0, stderr: '' };
        } catch (e) {
          const err = e as { status?: number; stderr?: string };
          return { status: err.status ?? 1, stderr: err.stderr ?? '' };
        }
      })();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--crib-dir');
      expect(existsSync(join(sourceRoot, '.git', 'crib'))).toBe(false);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Build a minimal STORED (uncompressed, method 0) ZIP in memory so the archive CLI path can be
 * exercised end-to-end without a zip library (yazl is a pipeline devDep, not resolvable from the cli
 * package). Real archives use deflate; yauzl in the pipeline handles both — the stored layout is the
 * simplest valid container and proves the extract → index → register → resolve round-trip.
 */
function buildStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const dos = (d: Date): number =>
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >>> 1);
  const dosDate = (d: Date): number =>
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const now = new Date();
  const time = dos(now);
  const date = dosDate(now);
  const locals: Buffer[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  const central: Buffer[] = [];
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    offsets.push(cursor);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // local file header sig
      Buffer.from([20, 0]), // version needed = 2.0
      Buffer.from([0, 0]), // flags
      Buffer.from([0, 0]), // method = stored
      Buffer.from([time & 0xff, (time >>> 8) & 0xff]), // mod time
      Buffer.from([date & 0xff, (date >>> 8) & 0xff]), // mod date
      Buffer.from(uint32(crc)),
      Buffer.from(uint32(data.length)),
      Buffer.from(uint32(data.length)),
      Buffer.from(uint16(nameBuf.length)),
      Buffer.from([0, 0]), // extra len
      nameBuf,
      data,
    ]);
    locals.push(local);
    cursor += local.length;
    const centralRec = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), // central dir header sig
      Buffer.from([20, 0]), // version made by
      Buffer.from([20, 0]), // version needed
      Buffer.from([0, 0]), // flags
      Buffer.from([0, 0]), // method
      Buffer.from([time & 0xff, (time >>> 8) & 0xff]),
      Buffer.from([date & 0xff, (date >>> 8) & 0xff]),
      Buffer.from(uint32(crc)),
      Buffer.from(uint32(data.length)),
      Buffer.from(uint32(data.length)),
      Buffer.from(uint16(nameBuf.length)),
      Buffer.from([0, 0]), // extra len
      Buffer.from([0, 0]), // comment len
      Buffer.from([0, 0]), // disk start
      Buffer.from([0, 0]), // internal attrs
      Buffer.from(uint32(0)), // external attrs
      Buffer.from(uint32(offsets[offsets.length - 1]!)), // local header offset
      nameBuf,
    ]);
    central.push(centralRec);
  }
  const centralBlob = Buffer.concat(central);
  const cdOffset = cursor;
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), // EOCD sig
    Buffer.from([0, 0]), // disk number
    Buffer.from([0, 0]), // disk with central dir
    Buffer.from(uint16(entries.length)), // entries on this disk
    Buffer.from(uint16(entries.length)), // total entries
    Buffer.from(uint32(centralBlob.length)),
    Buffer.from(uint32(cdOffset)),
    Buffer.from([0, 0]), // comment len
  ]);
  return Buffer.concat([...locals, centralBlob, eocd]);
}

function uint16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}
function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

describe('crib index <archive> — archive identity round-trip', () => {
  let importsDir: string;
  let registryDir: string;
  let env: NodeJS.ProcessEnv;
  const runArchive = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env,
    });
    const strip = (s: string): string =>
      s
        .split('\n')
        .filter((l) => !/ExperimentalWarning|trace-warnings|DEP00/.test(l))
        .join('\n')
        .trim();
    return { status: r.status ?? 1, stdout: strip(r.stdout ?? ''), stderr: strip(r.stderr ?? '') };
  };

  beforeEach(() => {
    importsDir = mkdtempSync(join(tmpdir(), 'crib-cli-imports-'));
    registryDir = mkdtempSync(join(tmpdir(), 'crib-cli-archive-reg-'));
    env = { ...process.env, KCRIB_IMPORTS_DIR: importsDir, KCRIB_REGISTRY_DIR: registryDir };
  });
  afterEach(() => {
    rmSync(importsDir, { recursive: true, force: true });
    rmSync(registryDir, { recursive: true, force: true });
  });

  it('indexes a ZIP, registers archive identity, and resolves read commands from the registry (no re-extract)', () => {
    const archiveDir = mkdtempSync(join(tmpdir(), 'crib-cli-archive-src-'));
    try {
      const zip = join(archiveDir, 'app.zip');
      writeFileSync(
        zip,
        buildStoredZip([
          {
            name: 'hello.ts',
            data: Buffer.from('export function greet(): string {\n  return "hi";\n}\n'),
          },
        ]),
      );

      const indexed = runArchive(['index', zip]);
      expect(indexed.status, indexed.stderr).toBe(0);
      expect(indexed.stdout).toMatch(/indexed \d+ files/);
      // No `.crib` is created next to the archive — the soul lives in the imports cache.
      expect(existsSync(join(archiveDir, '.crib'))).toBe(false);

      // The registry records the archive identity under the archive path (projectKey).
      const registry = JSON.parse(readFileSync(join(registryDir, 'registry.json'), 'utf8')) as {
        projects: Record<
          string,
          { cribDir: string; sourceRoot: string; sourceArchive: string; sourceFingerprint: string }
        >;
      };
      const entry = registry.projects[zip]!;
      expect(entry).toBeDefined();
      expect(entry.sourceArchive).toBe(zip);
      expect(entry.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
      // sourceRoot + cribDir live inside the imports cache, not next to the archive.
      expect(entry.sourceRoot.startsWith(importsDir)).toBe(true);
      expect(entry.cribDir.startsWith(importsDir)).toBe(true);
      expect(existsSync(join(entry.cribDir, 'crib.json'))).toBe(true);

      // A read command using the ARCHIVE PATH resolves via the registry without re-extracting:
      // status reports indexed:true against the cached soul (no `.crib` next to the zip to find).
      const status = runArchive(['status', zip]);
      expect(status.status, status.stderr).toBe(0);
      const parsed = JSON.parse(status.stdout) as { indexed: boolean };
      expect(parsed.indexed).toBe(true);
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });

  it('update on an unchanged archive is a no-op (fingerprint cache hit), and re-index keeps identity', () => {
    const archiveDir = mkdtempSync(join(tmpdir(), 'crib-cli-archive-upd-'));
    try {
      const zip = join(archiveDir, 'app.zip');
      writeFileSync(
        zip,
        buildStoredZip([{ name: 'a.ts', data: Buffer.from('export const a = 1;\n') }]),
      );
      const first = runArchive(['index', zip]);
      expect(first.status, first.stderr).toBe(0);
      const registry = () =>
        (
          JSON.parse(readFileSync(join(registryDir, 'registry.json'), 'utf8')) as {
            projects: Record<string, { sourceFingerprint: string }>;
          }
        ).projects[zip]?.sourceFingerprint;
      const fp1 = registry();
      expect(fp1).toMatch(/^[0-9a-f]{64}$/);

      // Unchanged archive → no-op, identity preserved.
      const upd = runArchive(['update', zip]);
      expect(upd.status, upd.stderr).toBe(0);
      expect(upd.stdout).toContain('up to date (archive unchanged)');
      expect(registry()).toBe(fp1);
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });

  it('rejects --watch on an archive input (no work tree to observe)', () => {
    const archiveDir = mkdtempSync(join(tmpdir(), 'crib-cli-archive-watch-'));
    try {
      const zip = join(archiveDir, 'app.zip');
      writeFileSync(
        zip,
        buildStoredZip([{ name: 'a.ts', data: Buffer.from('export const a = 1;\n') }]),
      );
      runArchive(['index', zip]);
      const r = runArchive(['serve', zip, '--watch']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('watch is not supported for archive inputs');
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });
});

describe('crib reconstruct (WS-6) — CLI dispatch + maxSymbols guard (Blocker 2 regression)', () => {
  it('markdown emits the 30/80 thresholds + expectedBodyFile + members', () => {
    const out = runCli(['reconstruct', pkgQname, '--format', 'markdown']);
    // the markdown is wrapped in a JSON { id, markdown } envelope (verbs.reconstruct format:path)
    const parsed = JSON.parse(out) as { markdown: string };
    const md = parsed.markdown;
    expect(md).toContain('# Reconstruct: loan_pkg');
    expect(md).toContain('C_THRESHOLD_AUTO_REJECT');
    expect(md).toContain('`30`');
    expect(md).toContain('C_THRESHOLD_AUTO_APPROVE');
    expect(md).toContain('`80`');
    // spec file is db/loan_pkg_spec.sql → expected body db/loan_pkg_body.sql
    expect(md).toContain('expectedBodyFile: `db/loan_pkg_body.sql`');
    expect(md).toContain('- members: 3');
  });

  it('a valid --max-symbols cap truncates (1 of 3), JSON shape', () => {
    const out = runCli(['reconstruct', pkgQname, '--max-symbols', '1']);
    const r = JSON.parse(out) as { memberCount: number; members: unknown[]; truncated: boolean };
    expect(r.members).toHaveLength(1);
    expect(r.memberCount).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it('Blocker 2 regression: --max-symbols -5 is REJECTED (no silent slice(0,-5) corruption)', () => {
    // Before the fix, `--max-symbols -5` forwarded -5 → slice(0,-5) silently dropped all members
    // (or returned a corrupted tail). The guard now rejects non-positive values, so the FULL set is
    // returned: members.length === memberCount === 3, truncated false.
    const out = runCli(['reconstruct', pkgQname, '--max-symbols', '-5']);
    const r = JSON.parse(out) as { memberCount: number; members: unknown[]; truncated: boolean };
    expect(r.members).toHaveLength(3);
    expect(r.memberCount).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it('Blocker 2 regression: --max-symbols 0 is also rejected (no empty slice)', () => {
    const out = runCli(['reconstruct', pkgQname, '--max-symbols', '0']);
    const r = JSON.parse(out) as { memberCount: number; members: unknown[]; truncated: boolean };
    expect(r.members).toHaveLength(3);
    expect(r.memberCount).toBe(3);
    expect(r.truncated).toBe(false);
  });
});

describe('crib ask — natural-language CLI dispatch', () => {
  it('markdown answer explains a symbol by qualified name', () => {
    const md = runCli(['ask', 'loan_pkg.process_one', '--format', 'markdown']);
    expect(md).toContain('# loan_pkg.process_one');
    expect(md).toContain('interpretation:');
    expect(md).toContain('loan_pkg');
  });

  it('discovery answer searches the index and returns graph hits', () => {
    const out = runCli(['ask', 'C_THRESHOLD', '--limit', '5']);
    const r = JSON.parse(out) as {
      interpretation: string;
      hits: Array<{ id: string; snippet?: string }>;
    };
    expect(r.interpretation).toBe('discovery');
    expect(r.hits.length).toBeGreaterThan(0);
    const text = r.hits.map((h) => `${h.id} ${h.snippet ?? ''}`).join('\n');
    expect(text).toMatch(/loan_pkg|C_THRESHOLD/i);
  });

  it('overview question falls back to cluster summary when no LLM bible exists', () => {
    const out = runCli(['ask', 'what is the architecture']);
    const r = JSON.parse(out) as {
      interpretation: string;
      fallback?: { clusters: unknown[] };
    };
    expect(r.interpretation).toBe('overview');
    expect(r.fallback?.clusters).toBeDefined();
  });
});

describe('crib enrich --scope / --scope-cluster / --save flag guards (scope-picker hardening)', () => {
  it('--scope with no value is REJECTED as BAD_ARGS (no silent full-repo default)', () => {
    // The silent default to full-repo on a malformed --scope is the exact failure mode the scope
    // picker exists to prevent; it MUST surface as BAD_ARGS, not a quiet unscoped run.
    const r = runCliResult(['enrich', '--scope']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--scope requires a path prefix');
  });

  it('--scope --next (flag-like value) is REJECTED as BAD_ARGS', () => {
    const r = runCliResult(['enrich', '--scope', '--next']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--scope requires a path prefix');
  });

  it('--scope-cluster with no value is REJECTED as BAD_ARGS', () => {
    const r = runCliResult(['enrich', '--scope', 'db', '--scope-cluster']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--scope-cluster requires a cluster id');
  });

  it('--save with no value is REJECTED as BAD_ARGS (no ENOENT crash on a missing file path)', () => {
    const r = runCliResult(['enrich', '--save']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: crib enrich --save');
  });

  it('--save --scope foo (flag-like value) is REJECTED as BAD_ARGS, not treated as a file', () => {
    const r = runCliResult(['enrich', '--save', '--scope', 'foo']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: crib enrich --save');
  });

  it('a valid --scope runs scoped (exit 0): scopeEcho present, system reported separately, scoped pending hint not inflated by system', () => {
    const r = runCliResult(['enrich', '--scope', 'db']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"scopeEcho"');
    expect(r.stdout).toContain('"pathPrefix": "db"');
    expect(r.stdout).toContain('"wholeRepoPending"');
    // The scoped pending sum excludes the whole-repo system target, which is reported on its own line.
    expect(r.stdout).toMatch(/\d+ target\(s\) pending/);
    expect(r.stdout).toContain('whole-repo system target(s) still pending');
  });
});

describe('crib enrich --auto — bare (no --provider) prints guidance, no stub loop (W7)', () => {
  // W7 removed the autonomous confidence-0.1 stub loop: only grounded `verified` artifacts satisfy
  // coverage now, so a stub would not advance the queue (it would spin to zero-progress). Bare
  // `--auto` (no --provider) reports real pending + points at the provider loop / MCP skill and exits
  // OK. The bounded loop's stop conditions (layer boundary, max-batches, max-tokens, zero-progress)
  // now live behind `crib enrich run --provider <name>` (covered in enrich-cli.test.ts). Each test
  // drives the BUILT dist/cli.js against the shared freshly-indexed temp repo (non-empty queue).

  it('bare --auto prints pending + guidance and exits OK (no stub-authoring loop)', () => {
    const r = runCliResult(['enrich', '--auto']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no longer writes stubs');
    expect(r.stdout).toContain('provider loop: crib enrich run --provider <name>');
    expect(r.stdout).toMatch(/pending targets: \d+/);
    expect(r.stdout).not.toContain('auto batch 1');
  });

  it('--auto ignores loop-budget flags (no loop runs; still guidance + exit 0)', () => {
    // --max-batches / --max-tokens / --budget-tokens only govern the provider loop; with no
    // --provider they are inert — bare --auto still prints guidance and exits OK.
    const r = runCliResult([
      'enrich',
      '--auto',
      '--max-batches',
      '1',
      '--max-tokens',
      '1',
      '--budget-tokens',
      '1',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no longer writes stubs');
    expect(r.stdout).not.toContain('auto batch 1');
    expect(r.stdout).not.toContain('max-batches reached');
    expect(r.stdout).not.toContain('token ceiling');
  });

  it('bare --auto writes no stub artifacts (the W7 stub-freshness fix, end-to-end through the CLI)', () => {
    const r = runCliResult(['enrich', '--auto']);
    expect(r.status).toBe(0);
    // No confidence-0.1 stubs were authored: the audit finds zero LLM artifacts on disk.
    const audit = runCli(['audit-llm']);
    expect(audit).toContain('no LLM artifacts on disk');
  });

  it('bare --auto does not spin on a primed zero-progress batch (guidance, exit 0)', () => {
    // Prime: `--next` issues a batch and persists lastIssued WITHOUT saving. The old stub loop would
    // then re-issue the same batchId → zero-progress churn. Bare --auto never calls next() (it only
    // reads status), so it prints guidance and exits OK regardless of the primed marker — the
    // zero-progress guard now governs only the provider loop (run --provider).
    runCliResult(['enrich', '--next']);
    const r = runCliResult(['enrich', '--auto']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no longer writes stubs');
    expect(r.stderr).not.toContain('zero-progress');
  });
});

describe('crib index --package (workspace-aware indexing) — CLI dispatch', () => {
  let wsRepo: string;
  const wsPkg = (name: string, rel: string): void => {
    const dir = join(wsRepo, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), `export const ${name.replace(/-/g, '_')} = 1;\n`);
  };
  const runWs = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: wsRepo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const stripNoise = (s: string): string =>
      s
        .split('\n')
        .filter((l) => !/ExperimentalWarning|trace-warnings/.test(l))
        .join('\n')
        .trim();
    return {
      status: r.status ?? 1,
      stdout: stripNoise(r.stdout ?? ''),
      stderr: stripNoise(r.stderr ?? ''),
    };
  };

  beforeEach(() => {
    wsRepo = mkdtempSync(join(tmpdir(), 'crib-cli-ws-'));
    writeFileSync(join(wsRepo, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    writeFileSync(join(wsRepo, 'README.md'), '# root\n');
    wsPkg('ftc-cloud', 'packages/FTCCloud');
    wsPkg('ftc-local', 'packages/FTCLocal');
  });
  afterEach(() => rmSync(wsRepo, { recursive: true, force: true }));

  const fileCount = (stdout: string): number => {
    const m = stdout.match(/indexed (\d+) files/);
    return m ? Number(m[1]!) : -1;
  };

  it('indexes the full repo when no --package is given, but lists detected packages on stderr', () => {
    const r = runWs(['index', '.']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('monorepo detected (pnpm)');
    expect(r.stderr).toContain('ftc-cloud');
    expect(r.stderr).toContain('--package');
    expect(r.stdout).toMatch(/indexed \d+ files/);
    expect(r.stdout).not.toContain('[scoped:');
    // full walk sees both packages + root files
    expect(fileCount(r.stdout)).toBeGreaterThanOrEqual(6);
  });

  it('scopes discovery to one package with --package <name> (sibling pruned)', () => {
    const scoped = runWs(['index', '.', '--package', 'ftc-cloud']);
    expect(scoped.status).toBe(0);
    expect(scoped.stdout).toContain('[scoped: packages/FTCCloud]');
    const scopedCount = fileCount(scoped.stdout);
    // scoped walk: FTCCloud package.json + index.ts + root README + workspace.yaml (4), NOT FTCLocal
    expect(scopedCount).toBeLessThanOrEqual(4);
    // the FTCLocal source file never enters the soul
    expect(scoped.stdout).not.toContain('FTCLocal');

    const full = runWs(['index', '.', '--package', 'all']);
    expect(full.status).toBe(0);
    expect(full.stdout).not.toContain('[scoped:');
    expect(fileCount(full.stdout)).toBeGreaterThan(scopedCount);
  });

  it('scopes by repo-relative path too', () => {
    const r = runWs(['index', '.', '--package', 'packages/FTCLocal']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[scoped: packages/FTCLocal]');
  });

  it('rejects an unknown package name as BAD_ARGS with the valid names listed', () => {
    const r = runWs(['index', '.', '--package', 'ghost']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown package: ghost');
    expect(r.stderr).toContain('ftc-cloud');
    expect(r.stderr).toContain('ftc-local');
  });

  it('records the workspace + indexedPackages in the soul manifest meta', () => {
    const r = runWs(['index', '.', '--package', 'ftc-cloud']);
    expect(r.status).toBe(0);
    const manifest = JSON.parse(
      execFileSync('cat', [join(wsRepo, '.crib', 'graph', 'manifest.json')], {
        encoding: 'utf8',
      }),
    ) as { meta?: { workspace?: { tool: string }; indexedPackages?: string[] } };
    expect(manifest.meta?.workspace?.tool).toBe('pnpm');
    expect(manifest.meta?.indexedPackages).toEqual(['packages/FTCCloud']);
  });
});

describe('crib index — token-savings hero output (P1 instant value)', () => {
  let heroRepo: string;
  const runHero = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: heroRepo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const stripNoise = (s: string): string =>
      s
        .split('\n')
        .filter((l) => !/ExperimentalWarning|trace-warnings/.test(l))
        .join('\n')
        .trim();
    return {
      status: r.status ?? 1,
      stdout: stripNoise(r.stdout ?? ''),
      stderr: stripNoise(r.stderr ?? ''),
    };
  };

  afterEach(() => rmSync(heroRepo, { recursive: true, force: true }));

  it('prints a real measured token-savings ratio when a central, well-called symbol exists', () => {
    heroRepo = mkdtempSync(join(tmpdir(), 'crib-cli-hero-'));
    writeFileSync(join(heroRepo, 'package.json'), JSON.stringify({ name: 'hero', type: 'module' }));
    mkdirSync(join(heroRepo, 'src'), { recursive: true });
    // a deliberately central function (high in-degree) called from several other files padded with
    // unrelated content, so the raw-file-read cost meaningfully exceeds the one-line query response.
    const filler = Array.from({ length: 40 }, (_, i) => `export const filler${i} = ${i};`).join(
      '\n',
    );
    writeFileSync(
      join(heroRepo, 'src', 'core.ts'),
      `${filler}\nexport function widgetCore(id: string): string {\n  return id.toUpperCase();\n}\n`,
    );
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(heroRepo, 'src', `caller${i}.ts`),
        `${filler}\nimport { widgetCore } from './core.js';\nexport function use${i}(): string {\n  return widgetCore('x${i}');\n}\n`,
      );
    }
    const r = runHero(['index', '.']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /≈\d+(\.\d+)?x fewer tokens per discovery query than reading files directly/,
    );
    expect(r.stdout).toContain('via crib query');
  });

  it('omits the hero line on a tiny repo where the win is not real (no overclaiming)', () => {
    heroRepo = mkdtempSync(join(tmpdir(), 'crib-cli-hero-tiny-'));
    writeFileSync(join(heroRepo, 'package.json'), JSON.stringify({ name: 'tiny', type: 'module' }));
    mkdirSync(join(heroRepo, 'src'), { recursive: true });
    writeFileSync(
      join(heroRepo, 'src', 'a.ts'),
      'export function one(): number {\n  return 1;\n}\n',
    );
    const r = runHero(['index', '.']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/fewer tokens per discovery query/);
  });
});

describe('crib skill install --dest — cross-client skill installation', () => {
  it('does not mistake the destination value for a skill name', () => {
    const dest = join(repo, 'codex-skills');
    const first = runCliResult(['skill', 'install', '--dest', dest]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`crib-enrich: installed → ${join(dest, 'crib-enrich')}`);
    expect(readFileSync(join(dest, 'crib-enrich', 'SKILL.md'), 'utf8')).toContain('# crib-enrich');

    const second = runCliResult(['skill', 'install', '--dest', dest]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('crib-enrich: already up to date');
  });

  it('rejects a missing --dest value', () => {
    const result = runCliResult(['skill', 'install', '--dest']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: crib skill install [name] [--dest <dir>]');
  });

  it('rejects --client all (skill install targets one client, not a sentinel)', () => {
    const r = runCliResult(['skill', 'install', '--client', 'all']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown --client: all/);
  });

  it('rejects an unknown --client with a clean usage error (no stack trace)', () => {
    const r = runCliResult(['skill', 'install', '--client', 'foo']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown --client: foo/);
    expect(r.stderr).not.toMatch(/no adapter for client/); // no ungraceful throw
    expect(r.stderr).not.toMatch(/at .*:\d+/); // no stack trace
  });
});

describe('crib update --package (P4 multi-package federation) — CLI dispatch', () => {
  let fedRepo: string;
  const runFed = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: fedRepo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const stripNoise = (s: string): string =>
      s
        .split('\n')
        .filter((l) => !/ExperimentalWarning|trace-warnings/.test(l))
        .join('\n')
        .trim();
    return {
      status: r.status ?? 1,
      stdout: stripNoise(r.stdout ?? ''),
      stderr: stripNoise(r.stderr ?? ''),
    };
  };
  const git = (args: string[]): string =>
    execFileSync('git', ['-C', fedRepo, ...args], { encoding: 'utf8' }).trim();

  beforeEach(() => {
    fedRepo = mkdtempSync(join(tmpdir(), 'crib-cli-fed-'));
    writeFileSync(join(fedRepo, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    for (const [name, rel] of [
      ['pkg-a', 'packages/pkg-a'],
      ['pkg-b', 'packages/pkg-b'],
    ] as const) {
      mkdirSync(join(fedRepo, rel, 'src'), { recursive: true });
      writeFileSync(join(fedRepo, rel, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
      writeFileSync(
        join(fedRepo, rel, 'src', 'index.ts'),
        `export const ${name.replace('-', '_')} = 1;\n`,
      );
    }
    git(['init', '-q']);
    git(['add', '-A']);
    git(['-c', 'user.email=t@t.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'initial']);
  });
  afterEach(() => rmSync(fedRepo, { recursive: true, force: true }));

  it('scopes an incremental update to one package, leaving the other package pending and the anchor un-advanced', () => {
    const indexed = runFed(['index', '.']);
    expect(indexed.status).toBe(0);
    const h1 = git(['rev-parse', 'HEAD']);

    writeFileSync(
      join(fedRepo, 'packages', 'pkg-a', 'src', 'index.ts'),
      'export const pkg_a = 2;\n',
    );
    writeFileSync(
      join(fedRepo, 'packages', 'pkg-b', 'src', 'index.ts'),
      'export const pkg_b = 2;\n',
    );
    git(['add', 'packages/pkg-a/src/index.ts', 'packages/pkg-b/src/index.ts']);
    git(['-c', 'user.email=t@t.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'edit both']);

    const scoped = runFed(['update', '.', '--package', 'pkg-a']);
    expect(scoped.status).toBe(0);
    expect(scoped.stdout).toContain('outside scope');
    expect(scoped.stdout).toContain('anchor not advanced');

    const manifest = JSON.parse(
      readFileSync(join(fedRepo, '.crib', 'graph', 'manifest.json'), 'utf8'),
    ) as {
      repo: { vcsHead: string };
    };
    expect(manifest.repo.vcsHead).toBe(h1);
  });
});

describe('crib index — cross-process writer lock (M0.6)', () => {
  let lockRepo: string;
  const runLock = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: lockRepo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const stripNoise = (str: string): string =>
      str
        .split('\n')
        .filter((l) => !/ExperimentalWarning|trace-warnings/.test(l))
        .join('\n')
        .trim();
    return {
      status: r.status ?? 1,
      stdout: stripNoise(r.stdout ?? ''),
      stderr: stripNoise(r.stderr ?? ''),
    };
  };
  beforeEach(() => {
    lockRepo = mkdtempSync(join(tmpdir(), 'crib-cli-lock-'));
    writeFileSync(join(lockRepo, 'README.md'), '# locked\n');
    mkdirSync(join(lockRepo, 'src'), { recursive: true });
    writeFileSync(join(lockRepo, 'src', 'a.ts'), 'export const a = 1;\n');
  });
  afterEach(() => rmSync(lockRepo, { recursive: true, force: true }));

  it('leaves no .lock behind after a clean index', () => {
    const r = runLock(['index', '.']);
    expect(r.status).toBe(0);
    expect(existsSync(join(lockRepo, '.crib', '.lock'))).toBe(false);
  });

  it('refuses to index when a live-pid lock already holds (exit 4 LOCKED)', () => {
    mkdirSync(join(lockRepo, '.crib'), { recursive: true });
    // the test process is alive and is NOT the child crib will spawn → foreign live holder
    writeFileSync(join(lockRepo, '.crib', '.lock'), `${process.pid}\n`);
    const r = runLock(['index', '.']);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('crib is busy');
  });

  it('self-heals a stale (dead-pid) lock and indexes successfully', () => {
    mkdirSync(join(lockRepo, '.crib'), { recursive: true });
    // a pid nothing owns → dead → stale → stolen on acquire
    writeFileSync(join(lockRepo, '.crib', '.lock'), '4194304\n');
    const r = runLock(['index', '.']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/indexed \d+ files/);
    expect(existsSync(join(lockRepo, '.crib', '.lock'))).toBe(false);
  });
});

describe('crib federated-impact (M3.2) — CLI dispatch + id-parse regression', () => {
  it('parses the id as the positional AFTER flag values, not the --dir value', () => {
    // Regression: `args.find(!startsWith('-'))` resolved id to 'down' (the --dir VALUE) when --dir
    // preceded the id. positionalsOf strips VALUE_FLAGS values so the id is the real positional.
    // With the bug, the verb got id='down' → NOT_FOUND; with the fix, id='loan_pkg.process_one'
    // resolves and the result has a `root` (no error). The PL/SQL fixture has no http-call, so the
    // down traversal is empty — this still proves dispatch + id resolution + the verb shape.
    const out = runCli(['federated-impact', '--dir', 'down', 'loan_pkg.process_one']);
    const r = JSON.parse(out) as {
      root?: string;
      dir?: string;
      federatedRoots?: string[];
      affected?: unknown[];
      crossRepoHops?: number;
      error?: { code: string };
    };
    expect(r.error).toBeUndefined();
    expect(r.dir).toBe('down');
    expect(typeof r.root).toBe('string');
    expect(Array.isArray(r.affected)).toBe(true);
    expect(r.crossRepoHops).toBe(0);
  });

  it('accepts the `federated` alias', () => {
    const out = runCli(['federated', '--dir', 'down', 'loan_pkg.process_one']);
    const r = JSON.parse(out) as { dir?: string; error?: { code: string } };
    expect(r.error).toBeUndefined();
    expect(r.dir).toBe('down');
  });

  it('exits BAD_ARGS when --dir is missing', () => {
    const r = runCliResult(['federated-impact', 'loan_pkg.process_one']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage:/);
  });

  it('exits BAD_ARGS when --dir is not up|down', () => {
    const r = runCliResult(['federated-impact', '--dir', 'sideways', 'loan_pkg.process_one']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage:/);
  });

  it('exits BAD_ARGS when the id is missing', () => {
    const r = runCliResult(['federated-impact', '--dir', 'down']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage:/);
  });
});

// ─── W8 — cross-agent onboarding adapters + doctor memory-loop (PRD line 394/408) ───────────────
//
// These exercise the BUILT dist end-to-end: `crib adapters install --client all` writes every
// client instruction file preserving sibling content, `crib adapters remove` leaves the others +
// memory intact, `crib doctor` reports the 7th agent-memory-loop check (non-fatal when not
// initialized). They depend on the cli package's pretest/verify having rebuilt dist first.

describe('crib adapters (W8) — CLI dispatch', () => {
  it('install --client all writes all six instruction files + reports vscode as no-target', () => {
    const out = runCli(['adapters', 'install', '--client', 'all']);
    // six clients get a file written; vscode gets a note with an empty path.
    expect(out).toContain('claude: installed');
    expect(out).toContain('cursor: installed');
    expect(out).toContain('copilot: installed');
    expect(out).toContain('codex: installed');
    expect(out).toContain('windsurf: installed');
    expect(out).toContain('gemini: installed');
    expect(out).toMatch(/vscode:.*no project-scope instruction file|MCP wiring/);
    // the files exist and carry the managed block.
    expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(repo, 'GEMINI.md'))).toBe(true);
    expect(existsSync(join(repo, '.cursor', 'rules', 'crib.mdc'))).toBe(true);
    expect(existsSync(join(repo, '.github', 'copilot-instructions.md'))).toBe(true);
    expect(existsSync(join(repo, '.windsurfrules'))).toBe(true);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toContain('<!-- crib:start -->');
  });

  it('install preserves pre-existing sibling content in AGENTS.md', () => {
    writeFileSync(join(repo, 'AGENTS.md'), '# Existing\n\nuser prose\n');
    runCli(['adapters', 'install', '--client', 'codex']);
    const out = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    expect(out).toContain('# Existing');
    expect(out).toContain('user prose');
    expect(out).toContain('<!-- crib:start -->');
  });

  it('is idempotent — a second install reports "up to date"', () => {
    runCli(['adapters', 'install', '--client', 'claude']);
    const second = runCli(['adapters', 'install', '--client', 'claude']);
    expect(second).toContain('claude: up to date');
  });

  it('list reports present after install', () => {
    runCli(['adapters', 'install', '--client', 'all']);
    const out = runCli(['adapters', 'list', '--client', 'all']);
    expect(out).toContain('claude: present');
    expect(out).toContain('codex: present');
  });

  it('remove --client claude leaves the other instruction files + memory intact', () => {
    runCli(['adapters', 'install', '--client', 'all']);
    const out = runCli(['adapters', 'remove', '--client', 'claude']);
    expect(out).toContain('claude: removed');
    expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(false);
    // siblings untouched.
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(repo, 'GEMINI.md'))).toBe(true);
  });

  it('rejects an unknown --client with BAD_ARGS', () => {
    const r = runCliResult(['adapters', 'install', '--client', 'nope']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown --client/);
  });
});

describe('crib doctor (W8) — agent-memory loop check', () => {
  // doctor exits non-zero when OTHER checks fail (git hooks / IDE wiring absent in the temp repo),
  // so use runCliResult (captures non-zero) and assert on stdout — the memory-loop CHECK state is
  // what we're verifying, not doctor's overall exit code.
  it('reports the memory-loop check as non-fatal (✓) when memory is not initialized', () => {
    const r = runCliResult(['doctor']);
    expect(r.stdout).toContain('agent-memory loop');
    expect(r.stdout).toMatch(/✓ agent-memory loop — not initialized/);
    // overall doctor ran every applicable check (memory is opt-in → its ✓ does not cause failure
    // by itself). Count is deliberately NOT pinned: it varies with the environment — G3.2/G3.4
    // added the embedder-tier + freshness checks, and the freshness hook check adds an 11th
    // check only on repos where the post-commit hook is actually installed. Pinning the total
    // would break on every future check addition.
    expect(r.stdout).toMatch(/crib doctor: \d+\/\d+ checks passed/);
  });

  it('flags the memory loop as failing when policy.json exists but no adapter is installed', () => {
    // Simulate `crib memory init` having run (policy + team dir) WITHOUT any adapter installed.
    const memDir = join(repo, '.crib', 'memory');
    mkdirSync(join(memDir, 'team'), { recursive: true });
    writeFileSync(join(memDir, 'policy.json'), '{"version":1,"profiles":{}}\n');
    const r = runCliResult(['doctor']);
    expect(r.stdout).toContain('agent-memory loop');
    expect(r.stdout).toMatch(/✗ agent-memory loop/);
    expect(r.stdout).toMatch(/crib adapters install/);
  });

  it('passes the memory loop when policy + team dir + an adapter are all present', () => {
    const memDir = join(repo, '.crib', 'memory');
    mkdirSync(join(memDir, 'team'), { recursive: true });
    writeFileSync(join(memDir, 'policy.json'), '{"version":1,"profiles":{}}\n');
    runCli(['adapters', 'install', '--client', 'claude']);
    const r = runCliResult(['doctor']);
    expect(r.stdout).toMatch(/✓ agent-memory loop — policy ✓, team store ✓/);
  });
});

describe('crib doctor — stale build artifacts (WARN-class, report-only)', () => {
  // doctor exits non-zero when OTHER checks fail (git hooks / IDE wiring absent in the temp repo),
  // so assert on stdout like the memory-loop block above. The 8th check must never itself fail:
  // stale `.crib-build-*` builds are auto-reclaimed by the build-time sweep (runtime.ts); doctor
  // only surfaces the backlog.
  /** Write a `.crib-build-*` temp db (+ sidecars) into the temp repo's index dir. */
  function plantBuild(name: string, ageMs: number): string {
    const indexDir = join(repo, '.crib', 'index');
    mkdirSync(indexDir, { recursive: true });
    const full = join(indexDir, name);
    writeFileSync(full, Buffer.alloc(2048));
    writeFileSync(`${full}-wal`, Buffer.alloc(1024));
    writeFileSync(`${full}-shm`, Buffer.alloc(64));
    const mtime = new Date(Date.now() - ageMs);
    for (const p of [full, `${full}-wal`, `${full}-shm`]) utimesSync(p, mtime, mtime);
    return full;
  }

  it('reports a stale build (name, count, size incl. sidecars) as a non-failing ✓ check', () => {
    plantBuild('.crib-build-999-stale.sqlite', 2 * 60 * 60 * 1000);
    const r = runCliResult(['doctor']);
    expect(r.stdout).toMatch(
      /✓ stale build artifacts — 1 stale \.crib-build-\* build \(3\.1 KiB incl\. -wal\/-shm\)/,
    );
  });

  it('never deletes the stale artifacts it reports — deletion is the runtime sweep', () => {
    const full = plantBuild('.crib-build-999-stale.sqlite', 2 * 60 * 60 * 1000);
    runCliResult(['doctor']);
    expect(existsSync(full)).toBe(true);
    expect(existsSync(`${full}-wal`)).toBe(true);
    expect(existsSync(`${full}-shm`)).toBe(true);
  });

  it('treats a fresh .crib-build-* file as an in-progress build, not a stale one', () => {
    plantBuild('.crib-build-123-live.sqlite', 5 * 1000);
    const r = runCliResult(['doctor']);
    expect(r.stdout).toMatch(/✓ stale build artifacts — none/);
  });

  it('reports "none" when the index dir holds no build artifacts', () => {
    const r = runCliResult(['doctor']);
    expect(r.stdout).toMatch(/✓ stale build artifacts — none/);
    // total NOT pinned — the check count varies with environment (see the doctor W8 describe
    // block above); the invariant under test here is that the stale-artifacts check is included.
    expect(r.stdout).toMatch(/crib doctor: \d+\/\d+ checks passed/);
  });
});

describe('crib index — MuleSoft summary (Task 7)', () => {
  let muleRoot: string;
  beforeEach(() => {
    muleRoot = mkdtempSync(join(tmpdir(), 'crib-cli-mule-'));
    syntheticMuleProject(muleRoot);
  });
  afterEach(() => rmSync(muleRoot, { recursive: true, force: true }));

  const runMule = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: muleRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const stripNoise = (s: string): string =>
      s
        .split('\n')
        .filter((l) => !/ExperimentalWarning|trace-warnings/.test(l))
        .join('\n')
        .trim();
    return {
      status: r.status ?? 1,
      stdout: stripNoise(r.stdout ?? ''),
      stderr: stripNoise(r.stderr ?? ''),
    };
  };

  it('the human line appends a Mule summary with project, dialect, flows, subflows, munit, unresolved', () => {
    const r = runMule(['index', '.']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/indexed \d+ files → \d+ nodes, \d+ edges/);
    expect(r.stdout).toContain('· mule:');
    // 1 project, Mule 4 (the synthetic corpus is a single mule4 app at the repo root).
    expect(r.stdout).toContain('1 project');
    expect(r.stdout).toContain('mule4:');
    expect(r.stdout).toContain('18 flows');
    expect(r.stdout).toContain('7 subflows');
    expect(r.stdout).toContain('6 munit tests');
    // 3 unresolved flow-ref targets → "3 unresolved".
    expect(r.stdout).toContain('3 unresolved');
  });

  it('--json emits the full report with a mulesoft key and unchanged top-level fields', () => {
    const r = runMule(['index', '.', '--json']);
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    // Existing top-level fields are preserved (the JSON contract: no top-level change).
    for (const k of [
      'files',
      'parse',
      'resolve',
      'cfg',
      'link',
      'cluster',
      'ownership',
      'artifacts',
    ])
      expect(obj[k]).toBeDefined();
    expect(obj.mulesoft).toBeDefined();
    const m = obj.mulesoft;
    expect(m.projects).toBe(1);
    expect(m.dialectFiles).toEqual({ mule3: 0, mule4: expect.any(Number) });
    expect(m.dialectFiles.mule4).toBeGreaterThan(0);
    expect(m.flows).toBe(18);
    expect(m.subflows).toBe(7);
    expect(m.flowRefs).toBe(39);
    expect(m.transforms).toBe(27);
    expect(m.munitTests).toBe(6);
    expect(m.externalTargets).toBe(3);
    // routes = 2 http:listeners + 8 RAML API operations = 10.
    expect(m.routes).toBe(10);
    expect(m.references).toEqual({ resolved: 36, unresolved: 3 });
    // The synthetic corpus has no ambiguous-dialect / packaged-duplicate diagnostics.
    expect(m.diagnostics).toEqual({ warnings: 0, errors: 0 });
  });

  it('a non-Mule repo emits no mule segment and mulesoft is null under --json', () => {
    const plain = mkdtempSync(join(tmpdir(), 'crib-cli-nomule-'));
    try {
      writeFileSync(join(plain, 'index.ts'), 'export const x = 1;\n');
      const r = spawnSync(process.execPath, [CLI, 'index', '.', '--json'], {
        cwd: plain,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      expect(r.status ?? 1).toBe(0);
      const out = (r.stdout ?? '')
        .split('\n')
        .filter((l) => !/ExperimentalWarning|trace-warnings/.test(l))
        .join('\n')
        .trim();
      const obj = JSON.parse(out);
      expect(obj.mulesoft).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
