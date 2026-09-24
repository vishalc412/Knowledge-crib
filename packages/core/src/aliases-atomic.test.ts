/**
 * WP1 defect D1-h — `writeAliases` used to replace the dictionary IN PLACE.
 *
 * Its own doc comment claimed "Overwrites any existing file atomically (single write)". A single
 * write is not an atomic one: `writeFileSync(path, …)` opens the target with `O_TRUNC`, so the
 * dictionary is truncated to zero bytes before the replacement lands. The failure mode is not
 * theoretical — `loadAliases` PARSES the file it finds, so a crash in that window leaves an operator
 * with an empty or half-written alias dictionary and no previous copy to fall back to.
 *
 * WHY THIS TEST INSTRUMENTS `node:fs`. The distinction being asserted is "was the target ever a
 * zero-byte file", which is invisible once the call has returned successfully. The only place it is
 * observable is the sequence of syscalls, so this file wraps the fs primitives and records them. The
 * wrapper delegates every call unchanged; it only records.
 *
 * DISCRIMINATION. The primary assertion — that the target is never opened for writing and IS reached
 * by a rename — fails against the pre-fix implementation (which opened the target with `'w'` and
 * never renamed). That was verified by reverting the body to `writeFileSync(path, …)` and watching
 * this test go red.
 *
 * WHY MOCKING `node:fs` IS SAFE HERE. This file imports `./aliases.js` and nothing else, and the
 * graph it pulls in is `./aliases.js` → `./atomic-write.js` (three Node builtins) → `./graph-layout.js`.
 * No store, index, or embedder module is loaded through the wrapper.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trace = vi.hoisted(() => ({
  opens: [] as Array<{ path: string; flags: string }>,
  /** Paths passed to `writeFileSync` BY NAME — i.e. the truncating, non-atomic call shape. */
  writesByPath: [] as string[],
  renames: [] as Array<{ from: string; to: string }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>): number => {
      if (typeof args[0] === 'string') {
        trace.opens.push({ path: args[0], flags: typeof args[1] === 'string' ? args[1] : '' });
      }
      return actual.openSync(...args);
    },
    // Recording the PATH-based form is what makes the pre-fix defect observable: `writeFileSync`
    // opens the target with `O_TRUNC` inside the binding, so the explicit `openSync` wrapper above
    // cannot see that open. An fd-based call is the temp file, and is expected; a path-based call
    // naming the target is the in-place truncation.
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>): void => {
      if (typeof args[0] === 'string') trace.writesByPath.push(args[0]);
      actual.writeFileSync(...args);
    },
    renameSync: (from: string, to: string): void => {
      trace.renames.push({ from, to });
      actual.renameSync(from, to);
    },
  };
});

// Imported AFTER the mock declaration (vitest hoists the factory above every import).
const { loadAliases, writeAliases } = await import('./aliases.js');

/** The canonical dictionary filename is private to the module; asserted here as the real path. */
const ALIAS_FILE = 'aliases.json';

let cribDir = '';

beforeEach(() => {
  cribDir = join(mkdtempSync(join(tmpdir(), 'crib-aliases-atomic-')), '.crib');
  trace.opens.length = 0;
  trace.writesByPath.length = 0;
  trace.renames.length = 0;
});

afterEach(() => {
  rmSync(cribDir, { recursive: true, force: true });
});

/** The path the writer is expected to replace. */
function aliasPath(): string {
  return join(cribDir, 'graph', 'semantic', ALIAS_FILE);
}

describe('writeAliases replaces the dictionary by rename, never by truncation', () => {
  it('never writes the target by name, and reaches it through a rename from a staged temp', () => {
    const target = aliasPath();
    const tmp = `${target}.tmp`;
    writeAliases(cribDir, [{ alias: 'DTI', expand: 'debt to income' }]);

    // The defect, stated directly: the previous dictionary must never be replaced by a call that
    // opens the target with O_TRUNC. Pre-fix this read `['…/aliases.json']`.
    expect(trace.writesByPath).not.toContain(target);
    // The replacement is staged first — the temp file is really opened for writing.
    expect(trace.opens.some((o) => o.path === tmp && /w/.test(o.flags))).toBe(true);
    // …and it arrives at the target's name only by rename.
    const replaced = trace.renames.find((r) => r.to === target);
    expect(replaced).toBeDefined();
    expect(replaced?.from).toBe(tmp);
  });

  it('creates the parent directory itself, so a first write into a bare .crib still lands', () => {
    expect(existsSync(join(cribDir, 'graph', 'semantic'))).toBe(false);

    writeAliases(cribDir, [{ alias: 'NLP', expand: 'natural language processing' }]);

    expect(loadAliases(cribDir).get('NLP')).toBe('natural language processing');
  });

  it('round-trips: a second write replaces the first and leaves no temp file behind', () => {
    writeAliases(cribDir, [{ alias: 'A', expand: 'first' }]);
    writeAliases(cribDir, [{ alias: 'B', expand: 'second' }]);

    const loaded = loadAliases(cribDir);
    expect(loaded.get('B')).toBe('second');
    expect(loaded.has('A')).toBe(false); // replacement, not merge
    expect(existsSync(`${aliasPath()}.tmp`)).toBe(false);
    expect(readFileSync(aliasPath(), 'utf8')).toContain('"version": 1');
  });
});
