/**
 * Phase 3 — TypeScript cross-file resolver. Re-parses each TS file syntactically and turns
 * cross-file references into EXTRACTED edges, looking every target up in the global SymbolTable:
 *
 *   imports      file → top-level symbol it imports (resolved relative module specifier)
 *   calls        caller symbol → imported top-level function/class it invokes
 *   inherits     class → base class (extends)
 *   implements   class → interface (implements)
 *
 * Deterministic only: a reference that does not resolve to an indexed symbol is DROPPED, never
 * guessed. Receiver-typed cross-file method calls (`obj.method()`) need type inference and are out
 * of scope here — intra-file `this.method()` calls are already handled by the extractor (Phase 2).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { FileMeta } from '@knowledge-crib/parsers';
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Rel } from '@knowledge-crib/soul-schema';
import ts from 'typescript';
import type { ResolveContext, Resolver } from './resolver-registry.js';
import type { SymbolTable } from './symbol-table.js';

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'];

/** A name brought into a file by an import: the local alias → (target file, original export name). */
interface ImportBinding {
  file: string;
  name: string;
}

export interface ResolveStats {
  imports: number;
  calls: number;
  inherits: number;
  implements: number;
  /** references seen that did not resolve to an indexed symbol (dropped). */
  dropped: number;
  /** SQL resolver (M10) contributes reads/writes here; other resolvers may add more. */
  reads?: number;
  writes?: number;
  // NOTE: optional named fields above are `number`, matching the index signature. Other resolvers
  // add arbitrary counters (e.g. executes/guardedBy) through the index without a named field.
  [k: string]: number | undefined;
}

export interface ResolveResult {
  edges: Edge[];
  stats: ResolveStats;
}

/** Resolve cross-file edges for all TS files. Pure: returns edges; the caller persists them. */
export function resolveTypeScript(
  table: SymbolTable,
  root: string,
  files: FileMeta[],
): ResolveResult {
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
      evidence: { by: 'ts-resolver', snippet },
    });
  };

  for (const file of files) {
    if (!TS_EXTS.some((e) => file.path.endsWith(e))) continue;
    const text = safeRead(join(root, file.path));
    if (text === undefined) continue;
    const sf = ts.createSourceFile(file.path, text, ts.ScriptTarget.Latest, true);
    const imports = collectImports(sf, file.path, table);
    const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

    // imports edges: file → imported symbol
    for (const [, binding] of imports) {
      const target = table.topLevelSymbol(binding.file, binding.name);
      if (target) {
        push(table.fileId(file.path), target.id, 'imports', `import ${binding.name}`);
        stats.imports++;
      } else {
        stats.dropped++;
      }
    }

    walk(sf, (node) => {
      // cross-file calls
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const binding = imports.get(node.expression.text);
        if (binding) {
          const target = table.topLevelSymbol(binding.file, binding.name);
          const caller = table.enclosingSymbolId(file.path, lineOf(node.getStart()));
          if (target && caller && caller !== target.id) {
            push(caller, target.id, 'calls', node.expression.getText());
            stats.calls++;
          } else if (!target) {
            stats.dropped++;
          }
        }
      }
      // inheritance / implements
      if (ts.isClassDeclaration(node) && node.name && node.heritageClauses) {
        const classSym = table.topLevelSymbol(file.path, node.name.text);
        for (const clause of node.heritageClauses) {
          const rel: Rel =
            clause.token === ts.SyntaxKind.ExtendsKeyword ? 'inherits' : 'implements';
          for (const t of clause.types) {
            const baseName = ts.isIdentifier(t.expression) ? t.expression.text : undefined;
            if (!classSym || !baseName) continue;
            const target = resolveTypeName(baseName, file.path, imports, table);
            if (target) {
              push(classSym.id, target, rel, `${rel} ${baseName}`);
              if (rel === 'inherits') stats.inherits++;
              else stats.implements++;
            } else {
              stats.dropped++;
            }
          }
        }
      }
    });
  }

  return { edges, stats };
}

/** Resolve a type name to a symbol id: imported binding first, then a top-level local. */
function resolveTypeName(
  name: string,
  file: string,
  imports: Map<string, ImportBinding>,
  table: SymbolTable,
): string | undefined {
  const binding = imports.get(name);
  if (binding) return table.topLevelSymbol(binding.file, binding.name)?.id;
  return table.topLevelSymbol(file, name)?.id;
}

/** Collect named/default import bindings whose module resolves to an indexed repo file. */
function collectImports(
  sf: ts.SourceFile,
  fromPath: string,
  table: SymbolTable,
): Map<string, ImportBinding> {
  const map = new Map<string, ImportBinding>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const targetFile = resolveModule(fromPath, stmt.moduleSpecifier.text, table);
    if (!targetFile) continue; // external or unresolved → not indexed
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        const original = el.propertyName?.text ?? el.name.text;
        map.set(el.name.text, { file: targetFile, name: original });
      }
    }
    if (stmt.importClause?.name) {
      // default import → the file's default export; approximate by the alias name
      map.set(stmt.importClause.name.text, { file: targetFile, name: stmt.importClause.name.text });
    }
  }
  return map;
}

/** JS extensions a TS ESM import may use to refer to a `.ts` source (`./x.js` → `./x.ts`). */
const JS_EXTS = ['.js', '.jsx', '.mjs', '.cjs'];

/** Resolve a relative module specifier to an indexed repo-relative file path, or undefined. */
function resolveModule(fromPath: string, spec: string, table: SymbolTable): string | undefined {
  if (!spec.startsWith('.')) return undefined; // bare/external import
  const baseDir = dirname(fromPath);
  // TS allows `import './x.js'` to resolve to `./x.ts`; strip a trailing JS ext first.
  const jsExt = JS_EXTS.find((e) => spec.endsWith(e));
  const bare = jsExt ? spec.slice(0, -jsExt.length) : spec;
  const joined = normalize(join(baseDir, bare));
  const candidates: string[] = [];
  if (TS_EXTS.some((e) => joined.endsWith(e))) {
    candidates.push(joined);
  } else {
    for (const e of TS_EXTS) candidates.push(joined + e);
    for (const e of TS_EXTS) candidates.push(normalize(join(joined, `index${e}`)));
  }
  return candidates.find((c) => table.hasFile(c));
}

function normalize(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function walk(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (c) => walk(c, fn));
}

function safeRead(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * TypeScriptResolver — the {@link Resolver} adapter around {@link resolveTypeScript}. No behavioral
 * change; this is the P0a dispatch shape so the pipeline registers resolvers append-only.
 */
export class TypeScriptResolver implements Resolver {
  name = 'ts-resolver';
  supports(file: FileMeta): boolean {
    return TS_EXTS.some((e) => file.path.endsWith(e));
  }
  resolve(ctx: ResolveContext): { edges: Edge[]; stats: ResolveStats } {
    return resolveTypeScript(ctx.table, ctx.root, ctx.files);
  }
}
