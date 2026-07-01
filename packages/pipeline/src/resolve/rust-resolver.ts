/**
 * Phase 3 — Rust cross-file resolver. Re-parses each `.rs` file with the hand-rolled {@link parseRust}
 * and turns cross-file references into EXTRACTED edges, looking every target up in the global
 * {@link SymbolTable}:
 *
 *   imports     file → imported top-level item (`use crate::foo::Bar;` resolves Bar to foo.rs)
 *   implements  type → trait (`impl Trait for Type` — the Rust analog of Java `implements`)
 *   inherits     trait → supertrait (`trait T: Super` → Super; Rust has NO class inheritance, so
 *                `inherits` is ONLY ever emitted for trait supertraits)
 *   calls       caller symbol → an imported top-level item used as a constructor / free-fn call
 *                (`Token(input)` to an imported `Token`; bare `func()` to an imported `func`)
 *
 * Deterministic only: a reference that does not resolve to an indexed symbol is DROPPED, never
 * guessed. Glob imports (`use a::b::*;`) bind no discrete item here → counted as dropped (there is
 * no enumeration of a module's members without a global scan). Receiver method calls
 * (`obj.method()`) and `Type::method()` cross-file method calls are NOT resolved (method resolution
 * across files needs inference) — they are dropped rather than pointed at the wrong node. Macro
 * calls (`m!()`) are dropped unless resolvable (left to the extractor's same-file macro handling).
 * ZERO type edges (no Rust type pass). Intra-file `obj.method()` / bare `func()` / `Type::method()`
 * to same-file symbols are the extractor's job (Phase 2).
 *
 * Module-path model: a file `foo.rs` at the crate root is module `crate::foo` (basename without
 * `.rs`); a top-level item `Bar` in it has FQN `crate::foo::Bar`. `use crate::foo::Bar;` resolves via
 * this FQN map. Nested module files (`foo/bar.rs` → `crate::foo::bar`) are NOT mapped here — an
 * honest, documented limitation (the fixture uses flat crate-root modules).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRust } from '@knowledge-crib/parsers';
import type { RustDef, RustImplInfo, RustModule } from '@knowledge-crib/parsers';
import type { FileMeta } from '@knowledge-crib/parsers';
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Rel } from '@knowledge-crib/soul-schema';
import type { ResolveContext, Resolver } from './resolver-registry.js';
import type { SymbolTable } from './symbol-table.js';
import type { ResolveStats } from './ts-resolver.js';

const RUST_EXTS = ['.rs'];

/** An item brought in by `use crate::foo::Bar;`: local alias → (target file, original item name). */
interface NameBinding {
  file: string;
  /** original item name in the target file (the symbol to look up). */
  name: string;
}

interface ParsedFile {
  path: string;
  mod: RustModule;
}

/** Resolve cross-file edges for all Rust files. Pure: returns edges; the caller persists them. */
export function resolveRust(
  table: SymbolTable,
  root: string,
  files: FileMeta[],
): { edges: Edge[]; stats: ResolveStats } {
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
      evidence: { by: 'rust-resolver', snippet },
    });
  };

  // parse every supported file once (re-used for the FQN map + per-file resolution).
  const parsed: ParsedFile[] = [];
  for (const file of files) {
    if (!RUST_EXTS.some((e) => file.path.endsWith(e))) continue;
    const text = safeRead(join(root, file.path));
    if (text === undefined) continue;
    parsed.push({ path: file.path, mod: parseRust(text) });
  }

  // FQN → file: `crate::<basename>::<TopLevelItem>` → file path (flat crate-root modules only).
  const fqnFile = new Map<string, string>();
  for (const p of parsed) {
    const basename = baseModule(p.path);
    for (const d of p.mod.defs) {
      if (d.kind === 'impl') continue; // impl names are not path-addressable
      fqnFile.set(`crate::${basename}::${d.name}`, p.path);
    }
  }

  for (const p of parsed) {
    const { path, mod } = p;
    const basename = baseModule(path);

    // --- name bindings from `use crate::foo::Bar;` (non-star) ---
    const nameBindings = new Map<string, NameBinding>();
    for (const imp of mod.imports) {
      if (imp.star) {
        stats.dropped++;
        continue;
      }
      const fqn = imp.module ? `${imp.module}::${imp.original}` : imp.original;
      const targetFile = fqnFile.get(fqn) ?? findFileByModule(imp.module, imp.original, parsed);
      if (!targetFile) {
        stats.dropped++;
        continue;
      }
      nameBindings.set(imp.name, { file: targetFile, name: imp.original });
    }

    // --- imports edges: file → imported top-level item ---
    for (const [, binding] of nameBindings) {
      const target = table.topLevelSymbol(binding.file, binding.name);
      if (target) {
        push(table.fileId(path), target.id, 'imports', `use ${binding.name}`);
        stats.imports++;
      } else {
        stats.dropped++;
      }
    }

    // --- implements (impl Trait for Type) + inherits (trait supertraits): walk the decl tree ---
    const visitDef = (d: RustDef): void => {
      if (d.kind === 'impl' && d.impl) {
        const impl = d.impl as RustImplInfo;
        const typeSym = resolveTypeName(impl.type, path, basename, nameBindings, fqnFile, table);
        const traitSym = impl.trait
          ? resolveTypeName(impl.trait, path, basename, nameBindings, fqnFile, table)
          : undefined;
        if (typeSym && traitSym) {
          push(typeSym, traitSym, 'implements', `impl ${impl.trait} for ${impl.type}`);
          stats.implements++;
        } else {
          stats.dropped++;
        }
      }
      if (d.kind === 'trait') {
        const traitId = table.enclosingSymbolId(path, d.startLine);
        if (traitId) {
          for (const base of d.bases) {
            const target = resolveTypeName(base, path, basename, nameBindings, fqnFile, table);
            if (target) {
              push(traitId, target, 'inherits', `trait ${d.name}: ${base}`);
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

    // --- cross-file calls: bare / path call to an imported top-level item ---
    for (const c of mod.calls) {
      if (c.macro) continue; // macro calls — not resolved here
      if (c.seps.includes('.')) continue; // `obj.method()` receiver call — inference's job
      // `Type::method()` cross-file method calls are dropped (method resolution across files)
      if (c.segments.length > 0) continue;
      const b = nameBindings.get(c.head);
      if (!b) continue; // local / builtin / unknown — not this resolver's concern
      const targetId = table.topLevelSymbol(b.file, b.name)?.id;
      if (!targetId) continue;
      const caller = table.enclosingSymbolId(path, c.line);
      if (!caller || caller === targetId) continue; // self-recursion
      push(caller, targetId, 'calls', c.head);
      stats.calls++;
    }
  }

  return { edges, stats };
}

/**
 * Resolve a type / supertrait name to a symbol id, in priority order:
 *   1. dotted/path name → FQN map (then that file's top-level symbol)
 *   2. imported name binding → that file's top-level symbol
 *   3. same-crate FQN (`crate::<basename>::<name>`) → that file's top-level symbol
 *   4. same-file top-level symbol
 */
function resolveTypeName(
  name: string,
  file: string,
  basename: string,
  imports: Map<string, NameBinding>,
  fqnFile: Map<string, string>,
  table: SymbolTable,
): string | undefined {
  if (name.includes('::')) {
    const f = fqnFile.get(name);
    if (f) {
      const sym = table.topLevelSymbol(f, lastSegment(name));
      if (sym) return sym.id;
    }
  }
  const b = imports.get(name);
  if (b) {
    const sym = table.topLevelSymbol(b.file, b.name);
    if (sym) return sym.id;
  }
  const sameCrate = fqnFile.get(`crate::${basename}::${name}`);
  if (sameCrate) {
    const sym = table.topLevelSymbol(sameCrate, name);
    if (sym) return sym.id;
  }
  const local = table.topLevelSymbol(file, name);
  return local?.id;
}

/** `crate::foo::bar::Baz` → "Baz" (last `::`-segment). */
function lastSegment(path: string): string {
  const i = path.lastIndexOf('::');
  return i === -1 ? path : path.slice(i + 2);
}

/** File `path` → crate-root module name: `foo.rs` / `src/foo.rs` → "foo". */
function baseModule(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.rs$/, '');
}

/** Find a file whose `crate::<basename>::<name>` matches an import module path. */
function findFileByModule(
  module: string,
  name: string,
  parsed: readonly ParsedFile[],
): string | undefined {
  if (!module) return undefined;
  // `crate::foo::Bar` → look for a file whose basename is the segment before `Bar`
  const segs = module.split('::');
  if (segs[0] === 'crate' && segs.length >= 2) {
    const modName = segs[segs.length - 1]!;
    const target = `crate::${modName}::${name}`;
    for (const p of parsed) {
      if (baseModule(p.path) === modName && fqnHas(p, target)) return p.path;
    }
  }
  return undefined;
}

function fqnHas(p: ParsedFile, fqn: string): boolean {
  const basename = baseModule(p.path);
  return p.mod.defs.some((d) => d.kind !== 'impl' && `crate::${basename}::${d.name}` === fqn);
}

function safeRead(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/** RustResolver — the {@link Resolver} adapter around {@link resolveRust}. */
export class RustResolver implements Resolver {
  name = 'rust-resolver';
  supports(file: FileMeta): boolean {
    return RUST_EXTS.some((e) => file.path.endsWith(e));
  }
  resolve(ctx: ResolveContext): { edges: Edge[]; stats: ResolveStats } {
    return resolveRust(ctx.table, ctx.root, ctx.files);
  }
}
