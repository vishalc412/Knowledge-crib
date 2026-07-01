/**
 * Phase 3 — C# cross-file resolver. Re-parses each `.cs` file with the hand-rolled
 * {@link parseCsharp} and turns cross-file references into EXTRACTED edges, looking every target up
 * in the global {@link SymbolTable}:
 *
 *   imports     file → imported top-level TYPE (`using A.B.C;` resolves C to the file declaring it)
 *   inherits    class/struct/record/enum → a `:` target that resolves to a class/struct/record
 *   implements  class/struct/record/enum → a `:` target that resolves to an interface
 *   calls       caller symbol → an imported type used as a constructor (`new C()` / bare `C()`)
 *
 * Deterministic only: a reference that does not resolve to an indexed symbol is DROPPED, never
 * guessed. `using static` and `using A = B;` aliases bind no discrete type here → counted as
 * dropped (parity with the Java resolver's static/alias handling). Receiver-typed method calls
 * (`obj.M()` / `Type.M()`) are NOT resolved cross-file — methods are not top-level symbols — so
 * they are left to inference / dropped rather than pointed at the wrong node. ZERO type edges (no
 * C# type pass). Intra-file `this.M()` / bare `M()` / `new SameFileCls()` are the extractor's job
 * (Phase 2).
 *
 * The `:` clause carries BOTH the base class AND the interface list (`class C : Base, I1, I2`). The
 * resolver splits each target by the resolved node's `type`: a class/struct/record/record target →
 * `inherits`; an interface target → `implements`. If a target resolves to neither (unknown kind),
 * it is dropped. This is the authoritative split — the extractor's same-file `meta.bases`/
 * `meta.implements` split is only a hint and may mis-classify cross-file targets.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsharp } from '@knowledge-crib/parsers';
import type { CsharpDef, CsharpModule } from '@knowledge-crib/parsers';
import type { FileMeta } from '@knowledge-crib/parsers';
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import type { ResolveContext, Resolver } from './resolver-registry.js';
import type { SymbolTable } from './symbol-table.js';
import type { ResolveStats } from './ts-resolver.js';

const CSHARP_EXTS = ['.cs'];

/** A type brought in by `using A.B.C;`: local alias → (target file, type name). */
interface NameBinding {
  file: string;
  name: string;
}

interface ParsedFile {
  path: string;
  mod: CsharpModule;
}

/** Resolve cross-file edges for all C# files. Pure: returns edges; the caller persists them. */
export function resolveCsharp(
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
      evidence: { by: 'csharp-resolver', snippet },
    });
  };

  // parse every supported file once (re-used for the FQN map + per-file resolution).
  const parsed: ParsedFile[] = [];
  for (const file of files) {
    if (!CSHARP_EXTS.some((e) => file.path.endsWith(e))) continue;
    const text = safeRead(join(root, file.path));
    if (text === undefined) continue;
    parsed.push({ path: file.path, mod: parseCsharp(text) });
  }

  // FQN → file: `${namespace}.${TopLevelType}` → file path.
  const fqnFile = new Map<string, string>();
  for (const p of parsed) {
    const ns = p.mod.pkg ? `${p.mod.pkg}.` : '';
    for (const d of topLevelTypeNames(p.mod)) fqnFile.set(`${ns}${d}`, p.path);
  }

  for (const p of parsed) {
    const { path, mod } = p;
    const nsPrefix = mod.pkg ? `${mod.pkg}.` : '';

    // --- name bindings from `using A.B.C;` (non-static, non-alias) ---
    const nameBindings = new Map<string, NameBinding>();
    for (const imp of mod.imports) {
      if (imp.static || imp.alias) {
        stats.dropped++;
        continue;
      }
      // `using A.B.C;` → fully-qualified type A.B.C → its file.
      const fqn = imp.module ? `${imp.module}.${imp.name}` : imp.name;
      const targetFile =
        fqnFile.get(fqn) ??
        (imp.module ? findFileBySuffix(imp.module, imp.name, parsed) : undefined);
      if (!targetFile) {
        stats.dropped++;
        continue;
      }
      nameBindings.set(imp.name, { file: targetFile, name: imp.name });
    }

    // --- imports edges: file → imported top-level type ---
    for (const [, binding] of nameBindings) {
      const target = table.symbolByKind(binding.file, binding.name, TYPE_KINDS);
      if (target) {
        push(table.fileId(path), target.id, 'imports', `using ${binding.name}`);
        stats.imports++;
      } else {
        stats.dropped++;
      }
    }

    // --- inherits + implements: walk the whole declaration tree, splitting `:` targets by kind ---
    const visitDef = (d: CsharpDef): void => {
      if (d.kind === 'class' || d.kind === 'struct' || d.kind === 'record' || d.kind === 'enum') {
        const symId = table.enclosingSymbolId(path, d.startLine);
        if (symId) {
          for (const base of d.bases) {
            const target = resolveTypeName(base, path, nsPrefix, nameBindings, fqnFile, table);
            if (!target) {
              stats.dropped++;
              continue;
            }
            // a base in the def's `bases` list — emit inherits if it resolves to a class/struct/record,
            // else (interface, or unknown) treat as implements per the honest default.
            if (target.type === 'class' || target.type === 'struct' || target.type === 'record') {
              push(symId, target.id, 'inherits', `: ${base}`);
              stats.inherits++;
            } else if (target.type === 'interface') {
              push(symId, target.id, 'implements', `: ${base}`);
              stats.implements++;
            } else {
              stats.dropped++;
            }
          }
          for (const iface of d.implements) {
            const target = resolveTypeName(iface, path, nsPrefix, nameBindings, fqnFile, table);
            if (!target) {
              stats.dropped++;
              continue;
            }
            push(symId, target.id, 'implements', `: ${iface}`);
            stats.implements++;
          }
        }
      }
      if (d.kind === 'interface') {
        const ifaceId = table.enclosingSymbolId(path, d.startLine);
        if (ifaceId) {
          // interfaces can inherit from base interfaces (in the `bases` list).
          for (const base of d.bases) {
            const target = resolveTypeName(base, path, nsPrefix, nameBindings, fqnFile, table);
            if (target) {
              push(ifaceId, target.id, 'inherits', `: ${base}`);
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

    // --- cross-file calls: constructor call to an imported type (`new C()` / bare `C()`) ---
    for (const c of mod.calls) {
      if (c.head === 'this' || c.head === 'base') continue; // intra / parent — not here
      if (c.tail.length > 0) continue; // `C.M()` / `obj.M()` — method resolution is inference's job
      const b = nameBindings.get(c.head);
      if (!b) continue; // local / builtin / unknown — not this resolver's concern
      const targetId = table.symbolByKind(b.file, b.name, TYPE_KINDS)?.id;
      if (!targetId) continue;
      const caller = table.enclosingSymbolId(path, c.line);
      if (!caller || caller === targetId) continue; // self-recursion
      push(caller, targetId, 'calls', c.head);
      stats.calls++;
    }
  }

  return { edges, stats };
}

/** The top-level TYPE names of a module (skipping namespace wrappers — those aren't FQN-qualified). */
function topLevelTypeNames(mod: CsharpModule): string[] {
  const out: string[] = [];
  for (const d of mod.defs) {
    if (d.kind === 'namespace') {
      // a file-scoped namespace wraps the file's top-level types in its body; the FQN already includes
      // the namespace, so recurse into the body but DON'T re-prefix (the FQN map uses mod.pkg).
      for (const child of d.body) {
        if (TYPE_KINDS.has(child.kind)) out.push(child.name);
      }
    } else if (TYPE_KINDS.has(d.kind)) {
      out.push(d.name);
    }
  }
  return out;
}

const TYPE_KINDS = new Set<CsharpDef['kind']>(['class', 'interface', 'struct', 'record', 'enum']);

/**
 * Resolve a base / implements name to its top-level symbol NODE, in priority order:
 *   1. dotted name → FQN map (then that file's top-level symbol)
 *   2. imported name binding → that file's top-level symbol
 *   3. same-namespace FQN → that file's top-level symbol
 *   4. same-file top-level symbol
 * Returns the Node so the caller can inspect `.type` (class/struct/record vs interface) to split
 * `inherits` vs `implements`.
 */
function resolveTypeName(
  name: string,
  file: string,
  nsPrefix: string,
  imports: Map<string, NameBinding>,
  fqnFile: Map<string, string>,
  table: SymbolTable,
): Node | undefined {
  if (name.includes('.')) {
    const f = fqnFile.get(name);
    if (f) {
      const sym = table.symbolByKind(f, lastSegment(name), TYPE_KINDS);
      if (sym) return sym;
    }
  }
  const b = imports.get(name);
  if (b) {
    const sym = table.symbolByKind(b.file, b.name, TYPE_KINDS);
    if (sym) return sym;
  }
  const sameNs = fqnFile.get(`${nsPrefix}${name}`);
  if (sameNs) {
    const sym = table.symbolByKind(sameNs, name, TYPE_KINDS);
    if (sym) return sym;
  }
  return table.symbolByKind(file, name, TYPE_KINDS);
}

/** Find a file whose path ends with the namespace-dir/type-name suffix (`a/b/C` → `.../a/b/C.cs`). */
function findFileBySuffix(
  module: string,
  name: string,
  parsed: readonly ParsedFile[],
): string | undefined {
  const suffix = `${module.replace(/\./g, '/')}/${name}.cs`;
  return parsed.find((p) => p.path === suffix || p.path.endsWith(`/${suffix}`))?.path;
}

function lastSegment(dotted: string): string {
  const i = dotted.lastIndexOf('.');
  return i === -1 ? dotted : dotted.slice(i + 1);
}

function safeRead(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/** CsharpResolver — the {@link Resolver} adapter around {@link resolveCsharp}. */
export class CsharpResolver implements Resolver {
  name = 'csharp-resolver';
  supports(file: FileMeta): boolean {
    return CSHARP_EXTS.some((e) => file.path.endsWith(e));
  }
  resolve(ctx: ResolveContext): { edges: Edge[]; stats: ResolveStats } {
    return resolveCsharp(ctx.table, ctx.root, ctx.files);
  }
}
