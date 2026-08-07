/**
 * Atomic JSON write (PRD W2 Slice 2: "atomic temp→rename writes").
 *
 * `core`'s `SoulStore.atomicWrite` is a private method (not exported) and `cli/registry.ts`'s
 * `writeRegistry` is application-scoped, so the memory package vendors the same temp→rename pattern
 * here. A crash mid-write leaves the OLD file intact plus an orphan `<path>.tmp`; the store's read
 * path never reads `.tmp`, so a reader always sees either the previous or the next valid snapshot —
 * never a half-written file. `renameSync` is atomic on the target filesystems knowledge-crib runs
 * on (POSIX local dirs; the committed team store is local-disk too). The store's per-role lock
 * guarantees a single writer per path, so the shared `<path>.tmp` name never collides.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write `content` to `path` atomically: mkdir -p the parent, write `<path>.tmp`, rename over `path`. */
export function writeJsonAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}
