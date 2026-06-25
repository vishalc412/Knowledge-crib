/**
 * Phase 3 — Python cross-file resolver (M8). Re-parses each `.py` file with the hand-rolled
 * {@link parsePython} and turns cross-file references into EXTRACTED edges, looking every target up
 * in the global {@link SymbolTable}:
 *
 *   imports     file → top-level symbol brought in by `from M import N`
 *   calls       caller symbol → an imported top-level function/class (`N()` / `M.f()`)
 *   inherits    class → base class (`class C(Base)`), Base imported or local top-level
 *
 * Deterministic only: a reference that does not resolve to an indexed symbol is DROPPED, never
 * guessed. `import M` (module binding) records the module file so `M.f()` calls resolve, but emits
 * no `imports` edge — there is no module node to point at (capability-honest). Intra-file
 * `self.method()` / bare-local calls are already handled by the extractor (Phase 2); this resolver
 * only resolves calls whose callee is an IMPORTED name. ZERO type edges — Python has no type pass.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parsePython } from '@knowledge-crib/parsers';
import type { PyDef } from '@knowledge-crib/parsers';
import type { FileMeta } from '@knowledge-crib/parsers';
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Rel } from '@knowledge-crib/soul-schema';
import type { ResolveContext, Resolver } from './resolver-registry.js';
import type { SymbolTable } from './symbol-table.js';
import type { ResolveStats } from './ts-resolver.js';

const PY_EXTS = ['.py', '.pyi'];

/** A name brought in by `from M import N`: local alias → (target file, original name). */
interface NameBinding {
  file: string;
  name: string;
}

/**
 * A module brought in by `import M` / `import a.b as x` / `from . import x`: local alias → the
 * module it binds to.
 *
 * `navParts` is the module path the LOCAL NAME represents — the top package for a plain
 * `import a.b` (where `a` binds to package `a`, and `a.b` is reached by navigating), or the full
 * module for an alias `import a.b as x` (where `x` IS module `a.b`). `deepFile` is the indexed file
 * for `fullModule` (the deepest module actually imported); `relative` is the import's leading-dot
 * count (0 for `import`, ≥1 for `from . import`). Call resolution walks the dotted access chain from
 * `navParts`; when the chain lands exactly on `fullModule` it uses `deepFile`, otherwise it
 * re-resolves the deeper path (relative-aware). A chain that does not land on an indexed module +
 * symbol (e.g. `a.f()` after `import a.b`) is DROPPED rather than guessed at the wrong file.
 */
interface ModuleBinding {
  deepFile: string | undefined;
  fullModule: string;
  navParts: string[];
  relative: number;
}

/** Resolve cross-file edges for all Python files. Pure: returns edges; the caller persists them. */
export function resolvePython(
  table: SymbolTable,
  root: string,
  files: FileMeta[],
): {
  edges: Edge[];
  stats: ResolveStats;
} {
  const edges: Edge[] = [];
  const stats: ResolveStats = { imports: 0, calls: 0, inherits: 0, implements: 0, dropped: 0 };
  const seen = new Set<string>();

  const push = (src: string, dst: string, rel: Rel, snippet: string): void => {
    const id = edgeId(src, dst, rel);
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({
      id,
      src,
      dst,
      rel,
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'python-resolver', snippet },
    });
  };

  for (const file of files) {
    if (!PY_EXTS.some((e) => file.path.endsWith(e))) continue;
    const text = safeRead(join(root, file.path));
    if (text === undefined) continue;
    const mod = parsePython(text);

    // --- build import bindings: name bindings (from-import) + module bindings (import M) ---
    const nameBindings = new Map<string, NameBinding>(); // local → (file, original)
    const moduleBindings = new Map<string, ModuleBinding>(); // local → module binding
    for (const imp of mod.imports) {
      if (imp.isImportStmt) {
        // `import M` / `import a.b` / `import a.b as x` — module binding (NO imports edge: no module
        // node to point at). `import` never takes leading dots, so relative is always 0 here.
        const fullParts = imp.module.split('.').filter(Boolean);
        const deepFile = resolveModule(file.path, imp.module, imp.relative, table);
        for (const n of imp.names) {
          // plain `import a.b` binds `a` to the TOP package a; alias `import a.b as x` binds `x` to
          // the full module a.b. navParts is what the local name represents for chain navigation.
          const isAlias = n.local !== fullParts[0];
          const navParts = isAlias ? fullParts : [fullParts[0]!];
          moduleBindings.set(n.local, {
            deepFile,
            fullModule: imp.module,
            navParts,
            relative: imp.relative,
          });
        }
        if (imp.star) stats.dropped++;
        continue;
      }
      if (imp.star) {
        // `from M import *` — no discrete binding; count the module as dropped if unresolvable.
        const target = resolveModule(file.path, imp.module, imp.relative, table);
        if (!target) stats.dropped++;
        continue;
      }
      if (imp.module === '') {
        // `from . import x` — x is either a SIBLING SUBMODULE (x.py / x/__init__.py) or a name
        // re-exported by the package's own __init__. Prefer the submodule (a module binding, enables
        // `x.f()`); fall back to a name binding in __init__ (enables bare `x()`).
        for (const n of imp.names) {
          const sub = resolveModule(file.path, n.original, imp.relative, table);
          if (sub) {
            moduleBindings.set(n.local, {
              deepFile: sub,
              fullModule: n.original,
              navParts: [n.original],
              relative: imp.relative,
            });
            continue;
          }
          const init = resolveModule(file.path, '', imp.relative, table);
          if (init && !hasLocalTopLevel(table, file.path, n.local)) {
            nameBindings.set(n.local, { file: init, name: n.original });
          } else {
            stats.dropped++;
          }
        }
        continue;
      }
      // `from M import N` — name binding, unless a local top-level def shadows the imported name
      // (Python: a same-name module-level def wins; we avoid emitting a contradictory cross-file edge).
      const targetFile = resolveModule(file.path, imp.module, imp.relative, table);
      if (!targetFile) {
        stats.dropped += imp.names.length;
        continue;
      }
      for (const n of imp.names) {
        if (hasLocalTopLevel(table, file.path, n.local)) {
          stats.dropped++;
          continue;
        }
        nameBindings.set(n.local, { file: targetFile, name: n.original });
      }
    }

    // --- imports edges: file → imported top-level symbol (from-imports only) ---
    for (const [, binding] of nameBindings) {
      const target = table.topLevelSymbol(binding.file, binding.name);
      if (target) {
        push(table.fileId(file.path), target.id, 'imports', `from import ${binding.name}`);
        stats.imports++;
      } else {
        stats.dropped++;
      }
    }

    // --- cross-file calls: imported bare name `N()` or module-qualified `M.f()` ---
    for (const c of mod.calls) {
      if (c.head === 'self' || c.head === 'cls') continue; // intra-file, extractor's job
      let targetId: string | undefined;
      if (c.tail.length === 0) {
        const b = nameBindings.get(c.head);
        if (b) targetId = table.topLevelSymbol(b.file, b.name)?.id;
      } else {
        // `M.f()` / `a.b.f()` / `x.f()` — resolve via the module binding's navigation chain.
        const mb = moduleBindings.get(c.head);
        if (mb) {
          // accessed module = the local name's module (navParts) + any intermediate submodules in
          // the chain (tail minus the final attribute). When the chain lands exactly on the imported
          // fullModule, use its resolved file; otherwise re-resolve the deeper path (relative-aware).
          const accessed = [...mb.navParts, ...c.tail.slice(0, -1)];
          const modFile =
            accessed.join('.') === mb.fullModule
              ? mb.deepFile
              : resolveModule(file.path, accessed.join('.'), mb.relative, table);
          if (modFile) targetId = table.topLevelSymbol(modFile, c.name)?.id;
        }
      }
      if (!targetId) {
        // not an imported callee (local/builtin/unknown/mismatched chain) → not this resolver's concern.
        continue;
      }
      const caller = table.enclosingSymbolId(file.path, c.line);
      if (!caller) continue;
      if (caller === targetId) continue; // self-recursion
      push(caller, targetId, 'calls', c.tail.length ? `${c.head}.${c.tail.join('.')}` : c.head);
      stats.calls++;
    }

    // --- inherits: class → base (imported binding or local top-level) ---
    const visitDef = (d: PyDef): void => {
      if (d.kind === 'class' && d.bases.length) {
        const classId = table.enclosingSymbolId(file.path, d.startLine);
        if (classId) {
          for (const base of d.bases) {
            const target = resolveTypeName(base, file.path, nameBindings, table);
            if (target) {
              push(classId, target, 'inherits', `extends ${base}`);
              stats.inherits++;
            } else {
              stats.dropped++;
            }
          }
        }
      }
      for (const child of d.body) visitDef(child);
    };
    for (const d of mod.defs) visitDef(d);
  }

  return { edges, stats };
}

/** Resolve a base name to a symbol id: imported name binding first, then a top-level local. */
function resolveTypeName(
  name: string,
  file: string,
  imports: Map<string, NameBinding>,
  table: SymbolTable,
): string | undefined {
  const b = imports.get(name);
  if (b) return table.topLevelSymbol(b.file, b.name)?.id;
  return table.topLevelSymbol(file, name)?.id;
}

/**
 * The directory bases to search for a module resolved from `fromPath`:
 *   - relative≥1: the importing file's package, walking up one dir per leading dot (`.` = file's
 *     own dir, `..` = parent, …).
 *   - relative=0 (absolute): repo root first, then the importing file's own dir (Python puts the
 *     script's dir on sys.path[0]).
 */
function packageBase(fromPath: string, relative: number): string[] {
  const fileDir = dirname(fromPath);
  if (relative > 0) {
    let b = fileDir;
    for (let k = 1; k < relative; k++) b = dirname(b);
    return [b];
  }
  return ['', fileDir];
}

/**
 * Resolve a Python module specifier to an indexed repo-relative file path, or undefined.
 *
 * `pkg.sub` → `pkg/sub.py` or `pkg/sub/__init__.py`; an empty spec (`from . import …` resolved as
 * a module) → the package's own `__init__.py`. Never guesses — only returns a path the
 * SymbolTable actually has.
 */
function resolveModule(
  fromPath: string,
  spec: string,
  relative: number,
  table: SymbolTable,
): string | undefined {
  const parts = spec ? spec.split('.').filter(Boolean) : [];
  for (const base of packageBase(fromPath, relative)) {
    const candidates: string[] = [];
    if (parts.length === 0) {
      candidates.push(normalize(join(base, '__init__.py')));
    } else {
      const stem = normalize(join(base, ...parts));
      candidates.push(`${stem}.py`);
      candidates.push(normalize(join(stem, '__init__.py')));
    }
    const hit = candidates.find((c) => table.hasFile(c));
    if (hit) return hit;
  }
  return undefined;
}

/** True iff `file` has a top-level symbol named `name` (a local def that shadows an import). */
function hasLocalTopLevel(table: SymbolTable, file: string, name: string): boolean {
  return table.topLevelSymbol(file, name) !== undefined;
}

function normalize(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function safeRead(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * PythonResolver — the {@link Resolver} adapter around {@link resolvePython}. Registered append-only
 * alongside the TypeScript + PL/SQL resolvers (M8); a `.py` file goes to at most this resolver.
 */
export class PythonResolver implements Resolver {
  name = 'python-resolver';
  supports(file: FileMeta): boolean {
    return PY_EXTS.some((e) => file.path.endsWith(e));
  }
  resolve(ctx: ResolveContext): { edges: Edge[]; stats: ResolveStats } {
    return resolvePython(ctx.table, ctx.root, ctx.files);
  }
}
