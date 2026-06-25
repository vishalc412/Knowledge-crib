/**
 * Phase 3 — Go cross-file resolver. Re-parses each `.go` file with the hand-rolled {@link parseGo}
 * and turns cross-file references into EXTRACTED edges, looking every target up in the global
 * {@link SymbolTable}:
 *
 *   imports     file → a top-level symbol in the imported package (Go imports bring a whole
 *              package, not a single type — the edge points at the first top-level symbol found in
 *              the package's files; an honest, deterministic heuristic)
 *   calls       caller symbol → an imported top-level func invoked as `pkg.Func()` (dotted calls
 *              where the head is an imported binding) — the Go resolver DOES resolve dotted
 *              package-qualified calls (unlike Java's, which skips `C.m()`). Bare same-file calls
 *              are the extractor's job (Phase 2); `obj.method()` receiver calls are inference's.
 *   inherits    struct/interface → embedded type (struct embedding or interface embedding; both are
 *              Go's inheritance substitute, resolved same-package / imported-package / same-file)
 *
 * Deterministic only: a reference that does not resolve to an indexed symbol is DROPPED, never
 * guessed. Go's IMPLICIT interface satisfaction is NOT statically detectable without full type
 * info → ZERO `implements` edges are emitted (honest limitation; only explicit embedding →
 * `inherits`). Dot imports (`import . "pkg"`) and blank imports (`import _ "pkg"`) bind no
 * discrete name → counted as dropped. Package→file resolution is by the import path's LAST
 * SEGMENT matching a file's `package` clause (a heuristic — Go packages map to directories, not
 * files; the full module-path → directory mapping requires go.mod which this offline tool does not
 * assume). ZERO type edges (no Go type pass).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGo } from '@knowledge-crib/parsers';
import type { GoDef, GoModule } from '@knowledge-crib/parsers';
import type { FileMeta } from '@knowledge-crib/parsers';
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Rel } from '@knowledge-crib/soul-schema';
import type { ResolveContext, Resolver } from './resolver-registry.js';
import type { SymbolTable } from './symbol-table.js';
import type { ResolveStats } from './ts-resolver.js';

const GO_EXTS = ['.go'];

/** A package brought in by an import: local binding → (package name, the package's file list). */
interface NameBinding {
  pkgName: string;
  files: string[];
}

interface ParsedFile {
  path: string;
  mod: GoModule;
}

/** Resolve cross-file edges for all Go files. Pure: returns edges; the caller persists them. */
export function resolveGo(
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
      evidence: { by: 'go-resolver', snippet },
    });
  };

  // parse every supported file once (re-used for the package map + per-file resolution).
  const parsed: ParsedFile[] = [];
  for (const file of files) {
    if (!GO_EXTS.some((e) => file.path.endsWith(e))) continue;
    const text = safeRead(join(root, file.path));
    if (text === undefined) continue;
    parsed.push({ path: file.path, mod: parseGo(text) });
  }

  // package name → file paths (Go packages map to directories; we key by the `package` clause name,
  // which by convention equals the import path's last segment).
  const pkgFiles = new Map<string, string[]>();
  for (const p of parsed) {
    if (!p.mod.pkg) continue;
    const list = pkgFiles.get(p.mod.pkg) ?? [];
    list.push(p.path);
    pkgFiles.set(p.mod.pkg, list);
  }

  // (pkgName, symbolName) → symbol id, scanning every file in the package.
  const findTopInPkg = (pkgName: string, name: string): string | undefined => {
    const files = pkgFiles.get(pkgName);
    if (!files) return undefined;
    for (const f of files) {
      const sym = table.topLevelSymbol(f, name);
      if (sym) return sym.id;
    }
    return undefined;
  };

  // first top-level symbol in a package (imports-edge target). Iterates files in sorted order and,
  // within each, the parsed top-level defs in declaration order — deterministic.
  const firstTopInPkg = (pkgName: string): string | undefined => {
    const files = pkgFiles.get(pkgName);
    if (!files) return undefined;
    for (const f of [...files].sort()) {
      const pf = parsed.find((p) => p.path === f);
      if (!pf) continue;
      for (const d of pf.mod.defs) {
        // receiver methods (kind 'method', non-interface) are top-level decls but NOT top-level
        // symbols by simple name (their parentQualifier is the receiver type) — skip so the
        // imports edge points at a genuine top-level func/type. Interface methods are nested in
        // body[] and never appear in pf.mod.defs.
        if (d.kind === 'method') continue;
        const sym = table.topLevelSymbol(f, d.name);
        if (sym) return sym.id;
      }
    }
    return undefined;
  };

  for (const p of parsed) {
    const { path, mod } = p;
    const pkg = mod.pkg;
    const pkgFileList = pkg ? (pkgFiles.get(pkg) ?? []) : [];

    // --- name bindings from `import [alias] "path"` (non-dot, non-blank) + imports edges ---
    const nameBindings = new Map<string, NameBinding>();
    for (const imp of mod.imports) {
      if (imp.alias === '.' || imp.alias === '_') {
        stats.dropped++;
        continue;
      }
      const pkgName = imp.module.split('/').pop() ?? imp.module;
      const files = pkgFiles.get(pkgName);
      if (!files || files.length === 0) {
        stats.dropped++;
        continue;
      }
      nameBindings.set(imp.alias, { pkgName, files });
      // imports edge: file → a top-level symbol in the package
      const target = firstTopInPkg(pkgName);
      if (target) {
        push(table.fileId(path), target, 'imports', `import ${imp.module}`);
        stats.imports++;
      } else {
        stats.dropped++;
      }
    }

    // --- inherits (embedding): struct/interface → embedded type ---
    const visitDef = (d: GoDef): void => {
      if (d.kind === 'struct' || d.kind === 'interface') {
        const id = table.enclosingSymbolId(path, d.startLine);
        if (id) {
          for (const base of d.bases) {
            const target = resolveTypeName(base, path, pkgFileList, nameBindings, table);
            if (target) {
              push(id, target, 'inherits', `embed ${base}`);
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

    // --- cross-file calls: `pkg.Func()` where pkg is an imported binding ---
    for (const c of mod.calls) {
      const b = nameBindings.get(c.head);
      if (!b) continue; // not an imported binding — extractor / inference territory
      const name = c.tail.length > 0 ? c.name : c.head;
      const targetId = findTopInPkg(b.pkgName, name);
      if (!targetId) {
        stats.dropped++;
        continue;
      }
      const caller = table.enclosingSymbolId(path, c.line);
      if (!caller) {
        stats.dropped++;
        continue;
      }
      if (caller === targetId) continue; // self-recursion
      push(caller, targetId, 'calls', `${c.head}.${c.name}`);
      stats.calls++;
    }
  }

  return { edges, stats };
}

/**
 * Resolve an embedded type name to a symbol id, in priority order:
 *   1. dotted `pkg.Type` → the binding's package files, then `Type`
 *   2. dotted `pkg.Type` where pkg is a package name (not a binding) → that package's `Type`
 *   3. bare → same-package top-level symbol
 *   4. bare → same-file top-level symbol
 */
function resolveTypeName(
  name: string,
  file: string,
  pkgFileList: string[],
  imports: Map<string, NameBinding>,
  table: SymbolTable,
): string | undefined {
  const dot = name.indexOf('.');
  if (dot > 0) {
    const head = name.slice(0, dot);
    const tail = name.slice(dot + 1);
    const b = imports.get(head);
    if (b) {
      for (const f of b.files) {
        const sym = table.topLevelSymbol(f, tail);
        if (sym) return sym.id;
      }
    }
    // head might be a package name (qualified without an import)
    for (const f of pkgFileList) {
      const sym = table.topLevelSymbol(f, tail);
      if (sym) return sym.id;
    }
  }
  // bare → same package
  for (const f of pkgFileList) {
    const sym = table.topLevelSymbol(f, name);
    if (sym) return sym.id;
  }
  // bare → same file
  return table.topLevelSymbol(file, name)?.id;
}

function safeRead(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/** GoResolver — the {@link Resolver} adapter around {@link resolveGo}. */
export class GoResolver implements Resolver {
  name = 'go-resolver';
  supports(file: FileMeta): boolean {
    return GO_EXTS.some((e) => file.path.endsWith(e));
  }
  resolve(ctx: ResolveContext): { edges: Edge[]; stats: ResolveStats } {
    return resolveGo(ctx.table, ctx.root, ctx.files);
  }
}
