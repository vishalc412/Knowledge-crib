/**
 * Phase 3 — TypeScript cross-file resolver. Re-parses each TS file syntactically and turns
 * cross-file references into EXTRACTED edges, looking every target up in the global SymbolTable:
 *
 *   imports      file → top-level symbol it imports (resolved relative module specifier)
 *   calls        caller symbol → imported top-level function/class or provably typed member
 *   inherits     class → base class (extends)
 *   implements   class → interface (implements)
 *
 * Deterministic only: a reference that does not resolve to an indexed symbol is DROPPED, never
 * guessed. Receiver calls resolve only when syntax proves an imported receiver type (an annotation,
 * `new` initializer, imported static receiver, or typed `this` property). Dynamic receivers remain
 * unresolved; intra-file receiver calls are handled by the extractor in Phase 2.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { FileMeta } from '@knowledge-crib/parsers';
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
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
      if (ts.isCallExpression(node)) {
        let target: Node | undefined;
        let attempted = false;
        if (ts.isIdentifier(node.expression)) {
          const binding = imports.get(node.expression.text);
          if (binding && !isLocallyBound(node, node.expression.text)) {
            attempted = true;
            target = table.topLevelSymbol(binding.file, binding.name);
          }
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          const resolved = resolveImportedPropertyCall(node, file.path, imports, table);
          target = resolved.target;
          attempted = resolved.attempted;
        }
        if (attempted) {
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

/** True when a parameter/local declaration shadows a file import at the call site. */
function isLocallyBound(node: ts.Node, name: string): boolean {
  const callPos = node.getStart();
  for (let cur = node.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
    if (
      ts.isFunctionLike(cur) &&
      cur.parameters.some((parameter) =>
        ts.isIdentifier(parameter.name)
          ? parameter.name.text === name
          : bindingDeclares(parameter.name, name),
      )
    ) {
      return true;
    }
    if (ts.isBlock(cur)) {
      for (const statement of cur.statements) {
        if (statement.getStart() >= callPos) continue;
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return true;
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (bindingDeclares(declaration.name, name)) return true;
          }
        }
      }
    }
  }
  return false;
}

function bindingDeclares(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindingDeclares(element.name, name),
  );
}

/** Resolve `receiver.member()` only when the receiver maps to an imported class/interface. */
function resolveImportedPropertyCall(
  call: ts.CallExpression,
  file: string,
  imports: Map<string, ImportBinding>,
  table: SymbolTable,
): { target?: Node; attempted: boolean } {
  if (!ts.isPropertyAccessExpression(call.expression)) return { attempted: false };
  const receiver = call.expression.expression;
  let typeName: string | undefined;

  if (ts.isIdentifier(receiver)) {
    typeName = localBindingType(call, receiver.text);
    if (!typeName && imports.has(receiver.text)) typeName = receiver.text;
  } else if (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    typeName = classPropertyType(call, receiver.name.text);
  }

  if (!typeName) return { attempted: false };
  const binding = imports.get(typeName);
  if (!binding) return { attempted: false }; // same-file type: extractor owns it
  return {
    attempted: true,
    target: table.memberSymbol(binding.file, binding.name, call.expression.name.text),
  };
}

function localBindingType(node: ts.Node, name: string): string | undefined {
  const callPos = node.getStart();
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) {
      const param = cur.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (param) return declaredTypeName(param.type, param.initializer);
    }
    if (ts.isBlock(cur) || ts.isSourceFile(cur)) {
      for (const statement of cur.statements) {
        if (statement.getStart() >= callPos || !ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            return declaredTypeName(declaration.type, declaration.initializer);
          }
        }
      }
    }
  }
  return undefined;
}

function classPropertyType(node: ts.Node, name: string): string | undefined {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!ts.isClassDeclaration(cur) && !ts.isClassExpression(cur)) continue;
    for (const member of cur.members) {
      if (ts.isPropertyDeclaration(member) && member.name?.getText() === name) {
        return declaredTypeName(member.type, member.initializer);
      }
      if (ts.isConstructorDeclaration(member)) {
        const param = member.parameters.find(
          (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
        );
        if (param) return declaredTypeName(param.type, param.initializer);
      }
    }
    return undefined;
  }
  return undefined;
}

function declaredTypeName(
  type: ts.TypeNode | undefined,
  initializer: ts.Expression | undefined,
): string | undefined {
  if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    return type.typeName.text;
  }
  if (initializer && ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)) {
    return initializer.expression.text;
  }
  if (
    initializer &&
    (ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer)) &&
    ts.isTypeReferenceNode(initializer.type) &&
    ts.isIdentifier(initializer.type.typeName)
  ) {
    return initializer.type.typeName.text;
  }
  return undefined;
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
