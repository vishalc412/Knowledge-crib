/**
 * Phase 3 — Java cross-file resolver. Re-parses each `.java` file with the hand-rolled
 * {@link parseJava} and turns cross-file references into EXTRACTED edges, looking every target up in
 * the global {@link SymbolTable}:
 *
 *   imports     file → imported top-level TYPE (`import a.b.C;` resolves C to a/b/C.java-ish file)
 *   inherits    class/record → `extends` base (imported binding, same-package, or same-file top-level)
 *   implements  class/enum/record → `implements` interface
 *   calls       caller symbol → an imported type used as a constructor (`new C()` / bare `C()`)
 *
 * Deterministic only: a reference that does not resolve to an indexed symbol is DROPPED, never
 * guessed. Star imports (`import a.b.*;`) and static imports (`import static a.b.C.m;`) bind no
 * discrete type here → counted as dropped (parity with the Python resolver's star handling; there
 * is no enumeration of a package's members without a global scan). Static method calls (`C.m()`)
 * are NOT resolved to a method across files — Java methods are not top-level symbols — so they are
 * left to inference / dropped rather than pointed at the wrong node. ZERO type edges (no Java type
 * pass). Intra-file `this.m()` / bare `m()` / `new SameFileCls()` are the extractor's job (Phase 2).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJava } from '@knowledge-crib/parsers';
import type { JavaDef, JavaModule } from '@knowledge-crib/parsers';
import type { FileMeta } from '@knowledge-crib/parsers';
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Rel } from '@knowledge-crib/soul-schema';
import type { ResolveContext, Resolver } from './resolver-registry.js';
import type { SymbolTable } from './symbol-table.js';
import type { ResolveStats } from './ts-resolver.js';

const JAVA_EXTS = ['.java'];

/** A type brought in by `import a.b.C;`: local alias → (target file, type name). */
interface NameBinding {
  file: string;
  name: string;
}

interface ParsedFile {
  path: string;
  mod: JavaModule;
}

/** Resolve cross-file edges for all Java files. Pure: returns edges; the caller persists them. */
export function resolveJava(
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
      evidence: { by: 'java-resolver', snippet },
    });
  };

  // parse every supported file once (re-used for the FQN map + per-file resolution).
  const parsed: ParsedFile[] = [];
  for (const file of files) {
    if (!JAVA_EXTS.some((e) => file.path.endsWith(e))) continue;
    const text = safeRead(join(root, file.path));
    if (text === undefined) continue;
    parsed.push({ path: file.path, mod: parseJava(text) });
  }

  // FQN → file: `${pkg}.${TopLevelType}` → file path (robust to source-root prefixes like src/main/java).
  const fqnFile = new Map<string, string>();
  for (const p of parsed) {
    const pkg = p.mod.pkg ? `${p.mod.pkg}.` : '';
    for (const d of p.mod.defs) fqnFile.set(`${pkg}${d.name}`, p.path);
  }

  for (const p of parsed) {
    const { path, mod } = p;
    const pkgPrefix = mod.pkg ? `${mod.pkg}.` : '';

    // --- name bindings from `import a.b.C;` (non-star, non-static) ---
    const nameBindings = new Map<string, NameBinding>();
    for (const imp of mod.imports) {
      if (imp.star || imp.static) {
        stats.dropped++;
        continue;
      }
      // `import a.b.C;` → fully-qualified type a.b.C → its file.
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
      const target = table.topLevelSymbol(binding.file, binding.name);
      if (target) {
        push(table.fileId(path), target.id, 'imports', `import ${binding.name}`);
        stats.imports++;
      } else {
        stats.dropped++;
      }
    }

    // --- inherits + implements: walk the whole declaration tree ---
    const visitDef = (d: JavaDef): void => {
      if (d.kind === 'class' || d.kind === 'record' || d.kind === 'enum') {
        const classId = table.enclosingSymbolId(path, d.startLine);
        if (classId) {
          for (const base of d.bases) {
            const target = resolveTypeName(base, path, pkgPrefix, nameBindings, fqnFile, table);
            if (target) {
              push(classId, target, 'inherits', `extends ${base}`);
              stats.inherits++;
            } else {
              stats.dropped++;
            }
          }
          for (const iface of d.implements) {
            const target = resolveTypeName(iface, path, pkgPrefix, nameBindings, fqnFile, table);
            if (target) {
              push(classId, target, 'implements', `implements ${iface}`);
              stats.implements++;
            } else {
              stats.dropped++;
            }
          }
        }
      }
      if (d.kind === 'interface') {
        const ifaceId = table.enclosingSymbolId(path, d.startLine);
        if (ifaceId) {
          for (const base of d.bases) {
            const target = resolveTypeName(base, path, pkgPrefix, nameBindings, fqnFile, table);
            if (target) {
              push(ifaceId, target, 'inherits', `extends ${base}`);
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
      if (c.head === 'this' || c.head === 'super') continue; // intra / parent — not here
      if (c.tail.length > 0) continue; // `C.m()` static / `obj.m()` — method resolution is inference's job
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
 * Resolve a base / implements name to a symbol id, in priority order:
 *   1. dotted name → FQN map (then that file's top-level symbol)
 *   2. imported name binding → that file's top-level symbol
 *   3. same-package FQN → that file's top-level symbol
 *   4. same-file top-level symbol
 */
function resolveTypeName(
  name: string,
  file: string,
  pkgPrefix: string,
  imports: Map<string, NameBinding>,
  fqnFile: Map<string, string>,
  table: SymbolTable,
): string | undefined {
  if (name.includes('.')) {
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
  const samePkg = fqnFile.get(`${pkgPrefix}${name}`);
  if (samePkg) {
    const sym = table.topLevelSymbol(samePkg, name);
    if (sym) return sym.id;
  }
  const local = table.topLevelSymbol(file, name);
  return local?.id;
}

/** Find a file whose path ends with the package-dir/type-name suffix (`a/b/C` → `.../a/b/C.java`). */
function findFileBySuffix(
  module: string,
  name: string,
  parsed: readonly ParsedFile[],
): string | undefined {
  const suffix = `${module.replace(/\./g, '/')}/${name}.java`;
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

/** JavaResolver — the {@link Resolver} adapter around {@link resolveJava}. */
export class JavaResolver implements Resolver {
  name = 'java-resolver';
  supports(file: FileMeta): boolean {
    return JAVA_EXTS.some((e) => file.path.endsWith(e));
  }
  resolve(ctx: ResolveContext): { edges: Edge[]; stats: ResolveStats } {
    return resolveJava(ctx.table, ctx.root, ctx.files);
  }
}
