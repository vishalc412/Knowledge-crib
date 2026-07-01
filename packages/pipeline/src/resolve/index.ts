import { CALLABLE_SYMBOL_TYPES } from '@knowledge-crib/core';
import type { SoulStore } from '@knowledge-crib/core';
/**
 * Phase 3 — resolve. Builds the global symbol table from the soul, dispatches the per-language
 * resolvers (P0a registry), and writes the cross-file EXTRACTED edges back to the soul. Then the
 * M11 CFG pass (Phase 3d) annotates the `executes`/`calls` edges with their guard chain.
 *
 * Defaults: TypeScript + PL/SQL + Python (M10/M8 resolvers; M11 CFG pass). Other languages register
 * append-only through the registries passed via `IndexOpts`. A reference that does not resolve to
 * an indexed node is dropped, never guessed.
 */
import type { FileMeta } from '@knowledge-crib/parsers';
import { CsharpResolver } from './csharp-resolver.js';
import type { CfgPass } from './dispatch.js';
import { CfgPassRegistry } from './dispatch.js';
import { GoResolver } from './go-resolver.js';
import { JavaResolver } from './java-resolver.js';
import { PlSqlCfgPass } from './plsql-cfg.js';
import { PythonResolver } from './python-resolver.js';
import { ResolverRegistry } from './resolver-registry.js';
import type { Resolver } from './resolver-registry.js';
import { RustResolver } from './rust-resolver.js';
import { SqlResolver } from './sql-resolver.js';
import { SymbolTable } from './symbol-table.js';
import { TypeScriptResolver } from './ts-resolver.js';
import type { ResolveStats } from './ts-resolver.js';

export { SymbolTable } from './symbol-table.js';
export { resolveTypeScript, TypeScriptResolver } from './ts-resolver.js';
export type { ResolveStats, ResolveResult } from './ts-resolver.js';
export { SqlResolver } from './sql-resolver.js';
export { PythonResolver, resolvePython } from './python-resolver.js';
export { JavaResolver, resolveJava } from './java-resolver.js';
export { CsharpResolver, resolveCsharp } from './csharp-resolver.js';
export { GoResolver, resolveGo } from './go-resolver.js';
export { RustResolver, resolveRust } from './rust-resolver.js';
export { SchemaCatalog } from './schema-catalog.js';
export { ResolverRegistry } from './resolver-registry.js';
export type {
  Resolver,
  ResolveContext,
  ResolveResult as ResolverResult,
} from './resolver-registry.js';
export { CfgPassRegistry } from './dispatch.js';
export type { CfgPass, CfgContext, CfgStats } from './dispatch.js';
export { PlSqlCfgPass } from './plsql-cfg.js';
export { segmentBlock } from '../cfg/basic-block.js';
export type { BasicBlock } from '../cfg/basic-block.js';
export { pathCondition } from '../cfg/guard-chain.js';
export type { GuardFrame, PathCondition } from '../cfg/guard-chain.js';

/** Default resolvers when the caller doesn't override: TypeScript + PL/SQL + Python + Java + C# + Go + Rust. */
export function defaultResolvers(): Resolver[] {
  return [
    new TypeScriptResolver(),
    new SqlResolver(),
    new PythonResolver(),
    new JavaResolver(),
    new CsharpResolver(),
    new GoResolver(),
    new RustResolver(),
  ];
}

/** Default CFG passes when the caller doesn't override: PL/SQL (M11). */
export function defaultCfgPasses(): CfgPass[] {
  return [new PlSqlCfgPass()];
}

/** Phase 3: resolve cross-file edges and persist them. Returns aggregate stats (merged per resolver). */
export function runResolve(
  soul: SoulStore,
  root: string,
  files: FileMeta[],
  resolvers?: Resolver[],
): ResolveStats {
  const registry = new ResolverRegistry();
  for (const r of resolvers ?? defaultResolvers()) registry.register(r);

  const table = new SymbolTable(soul);
  const agg: ResolveStats = { imports: 0, calls: 0, inherits: 0, implements: 0, dropped: 0 };

  const allEdges = [];
  for (const resolver of registry.all()) {
    const supported = files.filter((f) => resolver.supports(f));
    if (supported.length === 0) continue;
    const { edges, stats } = resolver.resolve({ soul, table, root, files: supported });
    for (const e of edges) allEdges.push(e);
    for (const [k, v] of Object.entries(stats)) agg[k] = (agg[k] ?? 0) + (v ?? 0);
  }
  if (allEdges.length > 0) soul.putEdges(allEdges);
  // Self-recursion stamp (language-agnostic): a callable that calls itself. Self-call EDGES are never
  // emitted (cycle avoidance — every extractor + resolver skips them), so recursion is surfaced as a
  // `meta.recursive = true` flag on the proc instead. Every extractor records call sites on
  // `meta.calls` as `{ callee, line }` and RETAINS the self-call site (only the self edge is dropped),
  // so one pass over `meta.calls` catches both intra-file (`this.m()` / bare `m()` / `self.m`) and
  // cross-file self-recursion for TS / Java / C# / Go / Rust / Python / PL/SQL. The PL/SQL extractor +
  // SqlResolver already stamp this directly; this is the uniform backstop for the other languages and
  // is idempotent for PL/SQL (boolean flag). Mirrors the qualified→simple, same-file-preferred
  // resolution the per-language resolvers use, so a call resolves to "self" exactly when a resolver
  // would have skipped it as self.
  agg.recursive = stampRecursion(soul);
  return agg;
}

interface CallSite {
  callee: string;
  line: number;
}

/**
 * Stamp `meta.recursive = true` on every callable whose `meta.calls` includes a call that resolves to
 * itself. Pure over the soul (reads + mutates node `meta` only). See {@link runResolve} for the
 * rationale + the no-self-edge convention this compensates for.
 */
export function stampRecursion(soul: SoulStore): number {
  const byQualified = new Map<string, string>(); // lowercased qualifiedName → symbol id
  const bySimple = new Map<string, { id: string; file: string }[]>(); // lowercased simple name → candidates
  for (const s of soul.iterate('symbol')) {
    if (!s.type || !CALLABLE_SYMBOL_TYPES.has(s.type)) continue;
    const q = (s.qualifiedName ?? '').toLowerCase();
    const simple = (s.name ?? '').toLowerCase();
    if (q) byQualified.set(q, s.id);
    if (simple && s.file) {
      const list = bySimple.get(simple) ?? [];
      list.push({ id: s.id, file: s.file });
      bySimple.set(simple, list);
    }
  }

  let stamped = 0;
  for (const s of soul.iterate('symbol')) {
    if (!s.type || !CALLABLE_SYMBOL_TYPES.has(s.type)) continue;
    const calls = s.meta?.calls;
    if (!Array.isArray(calls) || calls.length === 0) continue;
    const callerFile = s.file ?? '';
    for (const site of calls) {
      if (typeof site.callee !== 'string') continue;
      if (resolveSelfCallee(site.callee, callerFile, byQualified, bySimple) === s.id) {
        if (!s.meta) s.meta = {};
        if (!s.meta.recursive) {
          s.meta.recursive = true;
          stamped++;
        }
        break; // one self-call is enough; don't re-stamp
      }
    }
  }
  return stamped;
}

/** Resolve a callee "pkg.proc" / "Cls.m" / "self::m" / bare "m" to a symbol id (qualified → simple,
 *  same-file preferred), mirroring the per-language resolvers. Returns the callee's id or undefined. */
function resolveSelfCallee(
  callee: string,
  callerFile: string,
  byQualified: Map<string, string>,
  bySimple: Map<string, { id: string; file: string }[]>,
): string | undefined {
  const c = callee.toLowerCase();
  const q = byQualified.get(c);
  if (q) return q;
  // last `.`/`::`/`/`-separated segment is the simple name (handles `Cls.m`, `self::m`, `module::foo`).
  const simple = c.split(/[.:]/).filter(Boolean).pop() ?? c;
  const list = bySimple.get(simple);
  if (!list || list.length === 0) return undefined;
  const same = list.find((e) => e.file === callerFile);
  return (same ?? list[0])?.id;
}

/**
 * Phase 3d (M11): annotate the guard chain onto existing `executes`/`calls` edges. Runs AFTER
 * {@link runResolve} so the cross-file `calls` edges it annotates already exist. Returns aggregate
 * stats (merged per pass).
 */
export function runCfg(
  soul: SoulStore,
  root: string,
  files: FileMeta[],
  passes?: CfgPass[],
): { annotated: number; skipped: number } {
  const registry = new CfgPassRegistry();
  for (const p of passes ?? defaultCfgPasses()) registry.register(p);
  let annotated = 0;
  let skipped = 0;
  for (const pass of registry.all()) {
    const supported = files.filter((f) => pass.supports(f));
    if (supported.length === 0) continue;
    const stats = pass.run({ soul, root, files: supported });
    annotated += stats.annotated ?? 0;
    skipped += stats.skipped ?? 0;
  }
  return { annotated, skipped };
}
