/**
 * Phase 3 — Java cross-file resolver. Re-parses each `.java` file with the hand-rolled
 * {@link parseJava} and turns cross-file references into EXTRACTED edges, looking every target up in
 * the global {@link SymbolTable}:
 *
 *   imports     file → imported top-level TYPE (`import a.b.C;` resolves C to a/b/C.java-ish file)
 *   inherits    class/record → `extends` base (imported binding, same-package, or same-file top-level)
 *   implements  class/enum/record → `implements` interface
 *   calls       caller → callee method / constructed type, resolved with receiver + argument types
 *               (see java-calls.ts); unprovable targets are INFERRED with confidence < 1
 *   injects     consumer class → injected dependency type (1.3 DI: a Spring bean's `meta.injects` —
 *               the constructor-param / @Autowired-field types that did NOT resolve intra-file —
 *               resolved here via imports / same-package, the cross-file DI graph)
 *   produces    @Bean method → produced return type (1.3 producer graph: a `@Bean` method's
 *               `meta.produces` — the return type that did NOT resolve intra-file — resolved here
 *               via imports / same-package, the cross-file bean-production graph)
 *
 * Deterministic only: a reference that does not resolve to an indexed symbol is DROPPED, never
 * guessed. Star imports (`import a.b.*;`) and static imports (`import static a.b.C.m;`) bind no
 * discrete type for the `imports` edge → counted as dropped. Call resolution consults star and static
 * imports separately (java-calls.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SoulStore } from '@knowledge-crib/core';
import { parseJava } from '@knowledge-crib/parsers';
import type { JavaDef, JavaModule } from '@knowledge-crib/parsers';
import type { FileMeta } from '@knowledge-crib/parsers';
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Rel } from '@knowledge-crib/soul-schema';
import { ProjectIndex, resolveJavaCalls, resolveTemplateCalls } from './java-calls.js';
import type { TemplateFile } from './java-calls.js';
import type { ResolveContext, Resolver } from './resolver-registry.js';
import type { SymbolTable } from './symbol-table.js';
import type { ResolveStats } from './ts-resolver.js';

const JAVA_EXTS = ['.java'];
/** Velocity view templates — resolved against the Java project's types (INFERRED only). */
const TEMPLATE_EXTS = ['.vm', '.vtl'];

/** Type symbol kinds — used to recognize an intra-file-satisfied injection (skip; extractor edge). */
const TYPE_KINDS = new Set(['class', 'interface', 'enum', 'record']);

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
  soul?: SoulStore,
): { edges: Edge[]; stats: ResolveStats } {
  const edges: Edge[] = [];
  const stats: ResolveStats = {
    imports: 0,
    calls: 0,
    inherits: 0,
    implements: 0,
    injects: 0,
    produces: 0,
    dropped: 0,
  };
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

    // --- inherits + implements + injects: walk the whole declaration tree ---
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
          // 1.3: cross-file DI — a Spring bean's `meta.injects` (dependency types the Spring pass
          // could NOT resolve intra-file) resolved here via imports / same-package / same-file. An
          // intra-file-satisfied injection is skipped: the Spring pass already emitted that edge.
          const classNode = table.nodeInFile(path, classId);
          const injects = (classNode?.meta?.injects as string[] | undefined) ?? [];
          for (const depType of injects) {
            if (!depType) continue;
            if (table.symbolByKind(path, depType, TYPE_KINDS)) continue; // intra-file — already edged
            const target = resolveTypeName(depType, path, pkgPrefix, nameBindings, fqnFile, table);
            if (target) {
              push(classId, target, 'injects', depType);
              stats.injects = (stats.injects ?? 0) + 1;
            } else {
              stats.dropped++;
            }
          }
          // 1.3: cross-file bean-production — a @Bean method's `meta.produces` (return types the
          // Spring pass could NOT resolve intra-file) resolved here. Intra-file-satisfied produces
          // is skipped (the Spring pass already emitted that edge).
          for (const m of d.body) {
            if (m.kind !== 'method') continue;
            const methodId = table.enclosingSymbolId(path, m.startLine);
            if (!methodId) continue;
            const methodNode = table.nodeInFile(path, methodId);
            const produces = (methodNode?.meta?.produces as string[] | undefined) ?? [];
            for (const producedType of produces) {
              if (!producedType) continue;
              if (table.symbolByKind(path, producedType, TYPE_KINDS)) continue; // intra-file
              const target = resolveTypeName(
                producedType,
                path,
                pkgPrefix,
                nameBindings,
                fqnFile,
                table,
              );
              if (target) {
                push(methodId, target, 'produces', producedType);
                stats.produces = (stats.produces ?? 0) + 1;
              } else {
                stats.dropped++;
              }
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
  }

  // --- calls: static / method-reference / typed-receiver / chained / inherited / constructor ---
  const index = new ProjectIndex(parsed, table);
  const calls = resolveJavaCalls(parsed, table, soul, index);
  for (const e of calls.edges) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    edges.push(e);
  }
  stats.calls += calls.stats.calls;
  stats.inferredCalls = (stats.inferredCalls ?? 0) + calls.stats.inferred;

  // --- view templates: `$event.isFllGradeBandK2Only()` → Event.isFllGradeBandK2Only (INFERRED) ---
  const templates: TemplateFile[] = [];
  for (const file of files) {
    if (!TEMPLATE_EXTS.some((e) => file.path.endsWith(e))) continue;
    const text = safeRead(join(root, file.path));
    if (text !== undefined) templates.push({ path: file.path, text });
  }
  if (templates.length > 0 && parsed.length > 0) {
    const tpl = resolveTemplateCalls(templates, index, table);
    for (const e of tpl.edges) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      edges.push(e);
    }
    stats.inferredCalls = (stats.inferredCalls ?? 0) + tpl.inferred;
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
    return [...JAVA_EXTS, ...TEMPLATE_EXTS].some((e) => file.path.endsWith(e));
  }
  resolve(ctx: ResolveContext): { edges: Edge[]; stats: ResolveStats } {
    return resolveJava(ctx.table, ctx.root, ctx.files, ctx.soul);
  }
}
