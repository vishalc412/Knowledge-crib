import type { SoulStore } from '@knowledge-crib/core';
/**
 * Java method-call resolution across the whole project (Phase 3).
 *
 * Resolves every call-site shape the extractor cannot settle from one file without types:
 *
 *   Type.m(...)            static call through a class name (imports / same package / FQN / nested)
 *   Type::m, var::m        method references
 *   var.m(...)             receiver typed from a local, parameter, or field (lexically outward,
 *                          inherited fields included)
 *   a.getX().m(...)        receiver typed from the resolved call's declared return type
 *   this.m / super.m / m   the enclosing class, its outer classes, and inherited methods
 *   import static C.m      static imports
 *
 * Overloads are selected the way javac narrows them, as far as declared types allow: arity (varargs
 * aware), then access (private → same file, package-private → same package), then argument
 * compatibility using literal / local / field / return types, then most-specific. A single survivor
 * is an EXTRACTED edge (confidence 1). Anything crib cannot prove is either dropped or — when the
 * receiver's type is genuinely unknown (untyped lambda parameter, untypeable expression) or an
 * overload tie survives — emitted as an INFERRED edge with confidence < 1, so `extractedOnly`
 * consumers never see a guess.
 */
import type {
  JavaArg,
  JavaCallSite,
  JavaDef,
  JavaLocal,
  JavaModule,
} from '@knowledge-crib/parsers';
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge } from '@knowledge-crib/soul-schema';
import type { SymbolTable } from './symbol-table.js';

export interface ParsedJavaFile {
  path: string;
  mod: JavaModule;
}

interface TypeInfo {
  file: string;
  pkg: string;
  /** dotted name within the file (`Outer.Inner`). */
  qualified: string;
  def: JavaDef;
  id: string | undefined;
  outer: TypeInfo | undefined;
  fields: Map<string, JavaDef>;
  methods: MethodInfo[];
  nested: Map<string, TypeInfo>;
}

interface MethodInfo {
  def: JavaDef;
  id: string;
  owner: TypeInfo;
}

/** A resolved static type: a project type, or a named type crib does not index, or unknown. */
type TypeRef =
  | { kind: 'project'; info: TypeInfo }
  | { kind: 'external'; name: string }
  | { kind: 'unknown' };

const UNKNOWN: TypeRef = { kind: 'unknown' };
/** A value whose type exists but crib cannot see (a JDK / library method's result). No fallback. */
const OPAQUE: TypeRef = { kind: 'external', name: '' };

/** Where a call's receiver came from — decides static-ness and whether a fallback is allowed. */
interface Receiver {
  type: TypeRef;
  /** receiver is a type name (`Type.m`), not a value. */
  isTypeName: boolean;
}

interface CallResolution {
  targets: MethodInfo[];
  exact: boolean;
  /** the call is a constructor of this project type. */
  ctorType?: TypeInfo;
  /** the value this call expression evaluates to (return type / constructed type). */
  result: TypeRef;
}

const PRIMITIVES = new Set(['boolean', 'byte', 'short', 'int', 'long', 'char', 'float', 'double']);
const BOX: Record<string, string> = {
  Boolean: 'boolean',
  Byte: 'byte',
  Short: 'short',
  Integer: 'int',
  Long: 'long',
  Character: 'char',
  Float: 'float',
  Double: 'double',
};
const NUMERIC_RANK: Record<string, number> = {
  byte: 1,
  short: 2,
  char: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
};
const UNIVERSAL_SUPERTYPES = new Set(['Object', 'Serializable', 'Comparable', 'Cloneable']);
/** JDK types whose supertypes are small and well-known — lets `String` vs `List` be rejected. */
const JDK_SUPERTYPES: Record<string, string[]> = {
  String: ['CharSequence', 'Comparable', 'Serializable', 'Object'],
  ArrayList: ['List', 'Collection', 'Iterable', 'Object'],
  LinkedList: ['List', 'Deque', 'Queue', 'Collection', 'Iterable', 'Object'],
  List: ['Collection', 'Iterable', 'Object'],
  Set: ['Collection', 'Iterable', 'Object'],
  HashSet: ['Set', 'Collection', 'Iterable', 'Object'],
  Collection: ['Iterable', 'Object'],
  Map: ['Object'],
  HashMap: ['Map', 'Object'],
  Optional: ['Object'],
};
/** Method names too common across the JDK to attribute to a project method by name alone. */
const FALLBACK_BLOCKLIST = new Set([
  'get',
  'set',
  'put',
  'add',
  'remove',
  'size',
  'isEmpty',
  'contains',
  'equals',
  'hashCode',
  'toString',
  'stream',
  'map',
  'filter',
  'forEach',
  'collect',
  'of',
  'valueOf',
  'apply',
  'accept',
  'test',
  'run',
  'call',
  'close',
  'build',
  'builder',
  'iterator',
  'next',
  'hasNext',
  'orElse',
  'getName',
  'getId',
  'getValue',
  'length',
  'name',
  'compareTo',
  'clone',
  'init',
  'start',
  'stop',
]);
const INFERRED_FALLBACK_CONFIDENCE = 0.6;
const INFERRED_TIE_CONFIDENCE = 0.5;

export interface JavaCallStats {
  calls: number;
  inferred: number;
  dropped: number;
}

/** Resolve method calls for all parsed Java files. Pure: returns edges; the caller persists them. */
export function resolveJavaCalls(
  parsed: readonly ParsedJavaFile[],
  table: SymbolTable,
  soul: SoulStore | undefined,
  index: ProjectIndex = new ProjectIndex(parsed, table),
): { edges: Edge[]; stats: JavaCallStats } {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const stats: JavaCallStats = { calls: 0, inferred: 0, dropped: 0 };

  const push = (
    src: string,
    dst: string,
    exact: boolean,
    confidence: number,
    snippet: string,
  ): void => {
    const id = edgeId(src, dst, 'calls');
    const existing = seen.has(id) ? edges.find((e) => e.id === id) : undefined;
    if (existing) {
      // an EXTRACTED sighting of the same (caller, callee) upgrades an earlier INFERRED one.
      if (exact && existing.provenance !== 'EXTRACTED') {
        existing.provenance = 'EXTRACTED';
        existing.method = 'static';
        existing.confidence = 1;
        existing.evidence = { by: 'java-resolver', snippet };
        stats.inferred--;
        stats.calls++;
      }
      return;
    }
    // the extractor already emitted this edge with guard/CFG annotations — keep that one.
    const prior = soul?.getEdge(id);
    if (prior?.provenance === 'EXTRACTED' && prior.evidence?.by === 'java-extractor') return;
    seen.add(id);
    edges.push({
      id,
      src,
      dst,
      rel: 'calls',
      method: exact ? 'static' : 'inferred',
      provenance: exact ? 'EXTRACTED' : 'INFERRED',
      confidence: exact ? 1 : confidence,
      evidence: { by: 'java-resolver', snippet },
    });
    if (exact) stats.calls++;
    else stats.inferred++;
  };

  for (const file of parsed) {
    const scope = new FileScope(file, index);
    for (let i = 0; i < file.mod.calls.length; i++) {
      const c = file.mod.calls[i]!;
      const res = scope.resolveCall(i);
      const caller = table.enclosingSymbolId(file.path, c.line);
      if (!caller) continue;
      const snippet = callText(c);
      if (res.ctorType) {
        if (res.ctorType.id && res.ctorType.id !== caller && res.ctorType.file !== file.path) {
          push(caller, res.ctorType.id, true, 1, snippet);
        }
        continue;
      }
      if (res.targets.length === 0) {
        stats.dropped++;
        continue;
      }
      const confidence =
        res.targets.length > 1 ? INFERRED_TIE_CONFIDENCE : INFERRED_FALLBACK_CONFIDENCE;
      for (const t of res.targets) {
        if (t.id === caller) continue;
        push(caller, t.id, res.exact, confidence, snippet);
      }
    }
  }
  return { edges, stats };
}

function callText(c: JavaCallSite): string {
  const chain = [c.head, ...c.tail].join('.');
  if (c.ref) return `${[c.head, ...c.tail.slice(0, -1)].join('.')}::${c.name}`;
  return `${c.ctor ? 'new ' : ''}${chain}(${(c.args ?? []).map((a) => a.text).join(', ')})`.slice(
    0,
    160,
  );
}

// ---------------------------------------------------------------------------------------------
// Project index: every type, its members, and name → type lookup the way javac scopes names.
// ---------------------------------------------------------------------------------------------

export class ProjectIndex {
  readonly typesByFile = new Map<string, TypeInfo[]>();
  readonly typesBySimpleName = new Map<string, TypeInfo[]>();
  readonly typeByFqn = new Map<string, TypeInfo>();
  readonly modules = new Map<string, JavaModule>();
  /** simple method name → every project method so named (for the unknown-receiver fallback). */
  readonly methodsByName = new Map<string, MethodInfo[]>();
  private readonly memberCache = new Map<string, MethodInfo[]>();
  private readonly ancestryCache = new Map<TypeInfo, { names: Set<string>; complete: boolean }>();

  constructor(
    parsed: readonly ParsedJavaFile[],
    private readonly table: SymbolTable,
  ) {
    for (const { path, mod } of parsed) {
      this.modules.set(path, mod);
      const types: TypeInfo[] = [];
      const visit = (defs: JavaDef[], outer: TypeInfo | undefined): void => {
        for (const d of defs) {
          if (
            d.kind !== 'class' &&
            d.kind !== 'interface' &&
            d.kind !== 'enum' &&
            d.kind !== 'record'
          )
            continue;
          const qualified = outer ? `${outer.qualified}.${d.name}` : d.name;
          const info: TypeInfo = {
            file: path,
            pkg: mod.pkg,
            qualified,
            def: d,
            id: table.enclosingSymbolId(path, d.startLine),
            outer,
            fields: new Map(),
            methods: [],
            nested: new Map(),
          };
          types.push(info);
          outer?.nested.set(d.name, info);
          const same = this.typesBySimpleName.get(d.name) ?? [];
          same.push(info);
          this.typesBySimpleName.set(d.name, same);
          this.typeByFqn.set(mod.pkg ? `${mod.pkg}.${qualified}` : qualified, info);
          for (const m of d.body) {
            if (m.kind === 'field') info.fields.set(m.name, m);
            else if (m.kind === 'method') {
              const id = table.enclosingSymbolId(path, m.startLine);
              if (!id) continue;
              const mi: MethodInfo = { def: m, id, owner: info };
              info.methods.push(mi);
              const list = this.methodsByName.get(m.name) ?? [];
              list.push(mi);
              this.methodsByName.set(m.name, list);
            }
          }
          visit(d.body, info);
        }
      };
      visit(mod.defs, undefined);
      this.typesByFile.set(path, types);
    }
  }

  /**
   * Resolve a type name as written in `file` inside `enclosing`: nested/outer member types, same-file
   * top-level types, single-type imports, same package, on-demand imports, then FQN. A name that is
   * written but not indexed (JDK / library type) is `external` — its type is known, just not ours.
   */
  resolveTypeName(name: string, file: string, enclosing: TypeInfo | undefined): TypeRef {
    if (!name || name === 'var') return UNKNOWN;
    if (PRIMITIVES.has(name) || name === 'void') return { kind: 'external', name };
    if (name.includes('.')) {
      const direct = this.typeByFqn.get(name);
      if (direct) return { kind: 'project', info: direct };
      const [head, ...rest] = name.split('.');
      let cur = this.resolveTypeName(head!, file, enclosing);
      for (const seg of rest) {
        if (cur.kind !== 'project') return { kind: 'external', name: rest[rest.length - 1]! };
        const nested = this.memberType(cur.info, seg);
        cur = nested ? { kind: 'project', info: nested } : { kind: 'external', name: seg };
      }
      return cur;
    }
    for (let t = enclosing; t; t = t.outer) {
      if (t.def.name === name) return { kind: 'project', info: t };
      const nested = this.memberType(t, name);
      if (nested) return { kind: 'project', info: nested };
    }
    const mod = this.modules.get(file);
    const local = this.typesByFile.get(file)?.find((t) => !t.outer && t.def.name === name);
    if (local) return { kind: 'project', info: local };
    if (mod) {
      for (const imp of mod.imports) {
        if (imp.static || imp.star || imp.name !== name) continue;
        const hit = this.typeByFqn.get(imp.module ? `${imp.module}.${imp.name}` : imp.name);
        return hit ? { kind: 'project', info: hit } : { kind: 'external', name };
      }
      const samePkg = this.typeByFqn.get(mod.pkg ? `${mod.pkg}.${name}` : name);
      if (samePkg) return { kind: 'project', info: samePkg };
      for (const imp of mod.imports) {
        if (imp.static || !imp.star) continue;
        const hit = this.typeByFqn.get(`${imp.module}.${name}`);
        if (hit) return { kind: 'project', info: hit };
      }
    }
    return /^[A-Z]/.test(name) ? { kind: 'external', name } : UNKNOWN;
  }

  /** A member type declared in `t` or inherited from its supertypes. */
  private memberType(t: TypeInfo, name: string, seen = new Set<TypeInfo>()): TypeInfo | undefined {
    if (seen.has(t)) return undefined;
    seen.add(t);
    const own = t.nested.get(name);
    if (own) return own;
    for (const s of this.supertypes(t)) {
      if (s.kind !== 'project') continue;
      const hit = this.memberType(s.info, name, seen);
      if (hit) return hit;
    }
    return undefined;
  }

  /** The declared return type of `m`, resolved where `m` is declared. */
  returnTypeOf(m: MethodInfo): TypeRef {
    return this.resolveTypeName(m.def.returnType ?? '', m.owner.file, m.owner);
  }

  supertypes(t: TypeInfo): TypeRef[] {
    return [...t.def.bases, ...t.def.implements].map((n) =>
      this.resolveTypeName(n, t.file, t.outer),
    );
  }

  /** Methods named `name` visible on `t`: declared first, then inherited ones not overridden. */
  methodsOf(t: TypeInfo, name: string): MethodInfo[] {
    const key = `${t.file}#${t.qualified}#${name}`;
    const cached = this.memberCache.get(key);
    if (cached) return cached;
    const out: MethodInfo[] = [];
    const signatures = new Set<string>();
    const seen = new Set<TypeInfo>();
    const walk = (cur: TypeInfo): void => {
      if (seen.has(cur)) return;
      seen.add(cur);
      for (const m of cur.methods) {
        if (m.def.name !== name) continue;
        const sig = `${m.def.params.length}:${(m.def.paramTypes ?? []).join(',')}`;
        if (signatures.has(sig)) continue;
        signatures.add(sig);
        out.push(m);
      }
      for (const s of this.supertypes(cur)) if (s.kind === 'project') walk(s.info);
    };
    walk(t);
    this.memberCache.set(key, out);
    return out;
  }

  /** A field named `name` on `t` (declared or inherited), with the type it is declared in. */
  fieldOf(
    t: TypeInfo,
    name: string,
    seen = new Set<TypeInfo>(),
  ): { def: JavaDef; owner: TypeInfo } | undefined {
    if (seen.has(t)) return undefined;
    seen.add(t);
    const own = t.fields.get(name);
    if (own) return { def: own, owner: t };
    for (const s of this.supertypes(t)) {
      if (s.kind !== 'project') continue;
      const hit = this.fieldOf(s.info, name, seen);
      if (hit) return hit;
    }
    return undefined;
  }

  /** All supertype simple names of `t` (itself included); `complete` false if any is not indexed. */
  ancestry(t: TypeInfo): { names: Set<string>; complete: boolean } {
    const cached = this.ancestryCache.get(t);
    if (cached) return cached;
    const names = new Set<string>([t.def.name]);
    let complete = true;
    const seen = new Set<TypeInfo>();
    const walk = (cur: TypeInfo): void => {
      if (seen.has(cur)) return;
      seen.add(cur);
      names.add(cur.def.name);
      for (const s of this.supertypes(cur)) {
        if (s.kind === 'project') walk(s.info);
        else if (s.kind === 'external') {
          names.add(s.name);
          for (const sup of JDK_SUPERTYPES[s.name] ?? []) names.add(sup);
          if (!JDK_SUPERTYPES[s.name]) complete = false;
        } else complete = false;
      }
    };
    walk(t);
    const result = { names, complete };
    this.ancestryCache.set(t, result);
    return result;
  }
}

// ---------------------------------------------------------------------------------------------
// Per-file scope: names → types at a line, receivers, overload selection.
// ---------------------------------------------------------------------------------------------

class FileScope {
  private readonly calls: JavaCallSite[];
  private readonly memo = new Map<number, CallResolution>();
  private readonly inProgress = new Set<number>();
  private readonly types: TypeInfo[];
  private readonly methods: Array<{ def: JavaDef; owner: TypeInfo }> = [];

  constructor(
    private readonly file: ParsedJavaFile,
    private readonly index: ProjectIndex,
  ) {
    this.calls = file.mod.calls;
    this.types = index.typesByFile.get(file.path) ?? [];
    for (const t of this.types) {
      for (const m of t.def.body) {
        if (m.kind === 'method' || m.kind === 'constructor')
          this.methods.push({ def: m, owner: t });
      }
    }
  }

  private enclosingType(line: number): TypeInfo | undefined {
    let best: TypeInfo | undefined;
    for (const t of this.types) {
      if (line < t.def.startLine || line > t.def.endLine) continue;
      if (!best || t.def.startLine >= best.def.startLine) best = t;
    }
    return best;
  }

  private enclosingMethod(line: number): { def: JavaDef; owner: TypeInfo } | undefined {
    let best: { def: JavaDef; owner: TypeInfo } | undefined;
    for (const m of this.methods) {
      if (line < m.def.startLine || line > m.def.endLine) continue;
      if (!best || m.def.startLine >= best.def.startLine) best = m;
    }
    return best;
  }

  /** The static type of a simple name at `line`: local → parameter → field (outward) → type name. */
  private nameType(name: string, line: number): Receiver {
    const method = this.enclosingMethod(line);
    const enclosing = this.enclosingType(line);
    if (method) {
      const local = this.latestLocal(name, line, method.def);
      if (local) return { type: this.localType(local, method.owner), isTypeName: false };
      const p = method.def.params.lastIndexOf(name);
      if (p >= 0) {
        return {
          type: this.index.resolveTypeName(
            method.def.paramTypes?.[p] ?? '',
            this.file.path,
            method.owner,
          ),
          isTypeName: false,
        };
      }
    }
    for (let t = enclosing; t; t = t.outer) {
      const field = this.index.fieldOf(t, name);
      if (field) {
        return {
          type: this.index.resolveTypeName(
            field.def.fieldType ?? '',
            field.owner.file,
            field.owner.outer ?? field.owner,
          ),
          isTypeName: false,
        };
      }
    }
    // not a variable: a type name, a package prefix (`org.acme.X.m()`), or a member inherited from a
    // supertype crib does not index — none of which is an unknown VALUE, so none may fall back.
    return { type: this.index.resolveTypeName(name, this.file.path, enclosing), isTypeName: true };
  }

  private latestLocal(name: string, line: number, method: JavaDef): JavaLocal | undefined {
    let hit: JavaLocal | undefined;
    for (const l of this.file.mod.locals ?? []) {
      if (l.name !== name || l.line > line || l.line < method.startLine || l.line > method.endLine)
        continue;
      if (!hit || l.line >= hit.line) hit = l;
    }
    return hit;
  }

  private localType(local: JavaLocal, owner: TypeInfo): TypeRef {
    if (local.type === '') return UNKNOWN;
    if (local.type === 'var') return local.init ? this.argType(local.init, local.line) : UNKNOWN;
    return this.index.resolveTypeName(local.type, this.file.path, owner);
  }

  private argType(arg: JavaArg, line: number): TypeRef {
    if (arg.literal)
      return arg.literal === 'null' ? UNKNOWN : { kind: 'external', name: arg.literal };
    if (arg.ident !== undefined) {
      if (arg.thisField) {
        const t = this.enclosingType(line);
        const f = t ? this.index.fieldOf(t, arg.ident) : undefined;
        return f
          ? this.index.resolveTypeName(f.def.fieldType ?? '', f.owner.file, f.owner)
          : UNKNOWN;
      }
      const r = this.nameType(arg.ident, line);
      return r.isTypeName ? OPAQUE : r.type;
    }
    if (arg.newType)
      return this.index.resolveTypeName(arg.newType, this.file.path, this.enclosingType(line));
    if (arg.castType)
      return this.index.resolveTypeName(arg.castType, this.file.path, this.enclosingType(line));
    if (arg.call !== undefined) return this.resolveCall(arg.call).result;
    return UNKNOWN;
  }

  resolveCall(i: number): CallResolution {
    const memo = this.memo.get(i);
    if (memo) return memo;
    const none: CallResolution = { targets: [], exact: false, result: UNKNOWN };
    if (this.inProgress.has(i)) return none;
    this.inProgress.add(i);
    try {
      const r = this.computeCall(this.calls[i]!);
      this.memo.set(i, r);
      return r;
    } finally {
      this.inProgress.delete(i);
    }
  }

  private computeCall(c: JavaCallSite): CallResolution {
    const enclosing = this.enclosingType(c.line);
    const none: CallResolution = { targets: [], exact: false, result: UNKNOWN };

    if (c.ctor) {
      const t = this.index.resolveTypeName(
        [c.head, ...c.tail].join('.'),
        this.file.path,
        enclosing,
      );
      return t.kind === 'project'
        ? { targets: [], exact: true, ctorType: t.info, result: t }
        : { ...none, result: t.kind === 'unknown' ? OPAQUE : t };
    }
    if (c.head === 'this' && c.tail.length === 0) return none; // this(...) constructor chaining
    if (c.head === 'super' && c.tail.length === 0) return none;

    // --- the receiver type and the method's simple name ---
    const segments = [c.head, ...c.tail];
    const name = segments[segments.length - 1]!;
    let receiver: Receiver | undefined;
    let fields: string[];
    if (c.receiverCall !== undefined) {
      receiver = { type: this.resolveCall(c.receiverCall).result, isTypeName: false };
      fields = segments.slice(0, -1);
    } else if (c.receiverExpr) {
      receiver = { type: UNKNOWN, isTypeName: false };
      fields = segments.slice(0, -1);
    } else if (segments.length === 1) {
      return this.finish(c, this.lexicalMethods(name, enclosing), undefined);
    } else if (c.head === 'this' || c.head === 'super') {
      if (!enclosing) return none;
      const self: TypeRef = { kind: 'project', info: enclosing };
      const base = c.head === 'super' ? (this.index.supertypes(enclosing)[0] ?? UNKNOWN) : self;
      receiver = { type: base, isTypeName: false };
      fields = segments.slice(1, -1);
    } else {
      receiver = this.nameType(c.head, c.line);
      fields = segments.slice(1, -1);
      if (receiver.isTypeName && receiver.type.kind !== 'project') {
        // maybe a fully-qualified prefix: org.acme.model.Event.isX()
        for (let k = segments.length - 1; k >= 2; k--) {
          const fqn = this.index.typeByFqn.get(segments.slice(0, k).join('.'));
          if (fqn) {
            receiver = { type: { kind: 'project', info: fqn }, isTypeName: true };
            fields = segments.slice(k, -1);
            break;
          }
        }
      }
    }

    // --- walk intermediate segments: nested types (static context) or fields ---
    for (const seg of fields) {
      const cur: TypeRef = receiver.type;
      if (cur.kind !== 'project') {
        // an unseen type's member stays unseen; an unknown VALUE's member stays unknown; a name that
        // was never bound (package prefix) stays a non-value so it cannot fall back.
        receiver = {
          type: cur.kind === 'external' ? OPAQUE : UNKNOWN,
          isTypeName: cur.kind === 'external' ? false : receiver.isTypeName,
        };
        continue;
      }
      if (receiver.isTypeName) {
        const nested = this.index.resolveTypeName(
          `${cur.info.qualified}.${seg}`,
          cur.info.file,
          cur.info.outer,
        );
        if (nested.kind === 'project') {
          receiver = { type: nested, isTypeName: true };
          continue;
        }
      }
      const f = this.index.fieldOf(cur.info, seg);
      receiver = {
        type: f
          ? this.index.resolveTypeName(f.def.fieldType ?? '', f.owner.file, f.owner)
          : UNKNOWN,
        isTypeName: false,
      };
    }

    const rt = receiver.type;
    if (rt.kind === 'project') return this.finish(c, this.index.methodsOf(rt.info, name), receiver);
    if (rt.kind === 'unknown' && !receiver.isTypeName) return this.fallback(c, name);
    return { ...none, result: OPAQUE }; // JDK / library receiver, or an unresolvable name
  }

  /** Bare `m(...)`: innermost lexically enclosing class that has (or inherits) `m`, then static imports. */
  private lexicalMethods(name: string, enclosing: TypeInfo | undefined): MethodInfo[] {
    for (let t = enclosing; t; t = t.outer) {
      const found = this.index.methodsOf(t, name);
      if (found.length > 0) return found;
    }
    const out: MethodInfo[] = [];
    for (const imp of this.file.mod.imports) {
      if (!imp.static) continue;
      if (!imp.star && imp.name !== name) continue;
      const typeFqn = imp.star ? imp.module : imp.module;
      const t = this.index.typeByFqn.get(typeFqn);
      if (t)
        out.push(
          ...this.index.methodsOf(t, name).filter((m) => m.def.modifiers.includes('static')),
        );
    }
    return out;
  }

  private fallback(c: JavaCallSite, name: string): CallResolution {
    const none: CallResolution = { targets: [], exact: false, result: UNKNOWN };
    if (FALLBACK_BLOCKLIST.has(name)) return none;
    const all = this.index.methodsByName.get(name) ?? [];
    const applicable = c.args ? all.filter((m) => acceptsArity(m.def, c.args!.length)) : all;
    if (applicable.length !== 1) return none;
    return { targets: applicable, exact: false, result: this.returnType(applicable) };
  }

  private finish(
    c: JavaCallSite,
    candidates: MethodInfo[],
    receiver: Receiver | undefined,
  ): CallResolution {
    const none: CallResolution = { targets: [], exact: false, result: OPAQUE };
    if (candidates.length === 0) return none;
    let pool = candidates.filter((m) => this.accessible(m, c.line));
    if (c.args) pool = pool.filter((m) => acceptsArity(m.def, c.args!.length));
    if (pool.length > 1 && c.args && c.args.length > 0) {
      const argTypes = c.args.map((a) => this.argType(a, c.line));
      const compatible = pool.filter((m) => argTypes.every((at, k) => this.compatible(at, m, k)));
      if (compatible.length > 0) pool = compatible;
      if (pool.length > 1) pool = this.mostSpecific(pool, argTypes);
    }
    if (pool.length > 1 && receiver?.isTypeName && !c.ref) {
      const statics = pool.filter((m) => m.def.modifiers.includes('static'));
      if (statics.length > 0) pool = statics;
    }
    if (pool.length === 0) return none;
    return { targets: pool, exact: pool.length === 1, result: this.returnType(pool) };
  }

  private returnType(pool: MethodInfo[]): TypeRef {
    const types = pool.map((m) =>
      this.index.resolveTypeName(m.def.returnType ?? '', m.owner.file, m.owner),
    );
    const first = types[0];
    if (!first) return UNKNOWN;
    const same = types.every(
      (t) =>
        t.kind === first.kind &&
        (t.kind !== 'project' || (first.kind === 'project' && t.info === first.info)) &&
        (t.kind !== 'external' || (first.kind === 'external' && t.name === first.name)),
    );
    return same ? first : UNKNOWN;
  }

  private accessible(m: MethodInfo, line: number): boolean {
    const mods = m.def.modifiers;
    if (m.owner.def.kind === 'interface') return true;
    if (mods.includes('public')) return true;
    if (mods.includes('private')) return m.owner.file === this.file.path;
    const samePkg = m.owner.pkg === this.file.mod.pkg;
    if (mods.includes('protected')) {
      if (samePkg) return true;
      const t = this.enclosingType(line);
      return t ? this.index.ancestry(t).names.has(m.owner.def.name) : true;
    }
    return samePkg;
  }

  /** Can an argument of static type `arg` be passed to parameter `k` of `m`? Unknown ⇒ yes. */
  private compatible(arg: TypeRef, m: MethodInfo, k: number): boolean {
    const d = m.def;
    const last = d.params.length - 1;
    const rawParam = d.paramTypes?.[Math.min(k, last)] ?? '';
    if (arg.kind === 'unknown' || (arg.kind === 'external' && !arg.name) || !rawParam) return true;
    if (isTypeVariable(rawParam, m)) return true;
    const param = this.index.resolveTypeName(rawParam, m.owner.file, m.owner);
    const argName = arg.kind === 'project' ? arg.info.def.name : arg.name;
    const paramName =
      param.kind === 'project' ? param.info.def.name : param.kind === 'external' ? param.name : '';
    if (!paramName) return true;
    const argPrim = PRIMITIVES.has(argName) ? argName : undefined;
    const paramPrim = PRIMITIVES.has(paramName) ? paramName : BOX[paramName];
    if (argPrim) {
      if (UNIVERSAL_SUPERTYPES.has(paramName) || paramName === 'Number')
        return argPrim !== 'boolean' || paramName !== 'Number';
      if (!paramPrim) return false;
      if (argPrim === paramPrim) return true;
      if (argPrim === 'boolean' || paramPrim === 'boolean') return false;
      return (NUMERIC_RANK[argPrim] ?? 0) <= (NUMERIC_RANK[paramPrim] ?? 0);
    }
    if (PRIMITIVES.has(paramName)) return BOX[argName] === paramName;
    if (argName === paramName || UNIVERSAL_SUPERTYPES.has(paramName)) return true;
    if (arg.kind === 'project') {
      const anc = this.index.ancestry(arg.info);
      if (anc.names.has(paramName)) return true;
      return !anc.complete && param.kind === 'external';
    }
    // external argument
    if (param.kind === 'project') return false;
    const known = JDK_SUPERTYPES[argName];
    if (known) return known.includes(paramName);
    return true;
  }

  /** Keep the candidates whose declared parameter names match the argument types most exactly. */
  private mostSpecific(pool: MethodInfo[], argTypes: TypeRef[]): MethodInfo[] {
    const score = (m: MethodInfo): number =>
      argTypes.reduce((acc, at, k) => {
        const p = m.def.paramTypes?.[k];
        if (!p || at.kind === 'unknown') return acc;
        const name = at.kind === 'project' ? at.info.def.name : at.name;
        return acc + (p === name || BOX[p] === name || BOX[name] === p ? 1 : 0);
      }, 0);
    const best = Math.max(...pool.map(score));
    return pool.filter((m) => score(m) === best);
  }
}

function acceptsArity(d: JavaDef, n: number): boolean {
  return d.varargs ? n >= d.params.length - 1 : n === d.params.length;
}

/** `T`, `E`, `K extends …` — a single upper-case letter (optionally with a digit) is a type variable. */
function isTypeVariable(name: string, _m: MethodInfo): boolean {
  return /^[A-Z][0-9]?$/.test(name);
}

// ---------------------------------------------------------------------------------------------
// Velocity templates: `$var.a.b()` / `${var.prop}` / `$!var.m()` references into Java methods.
// ---------------------------------------------------------------------------------------------

export interface TemplateFile {
  path: string;
  text: string;
}

const TEMPLATE_NAME_CONFIDENCE = 0.7;

interface TemplateSegment {
  name: string;
  /** argument count for `name(...)`; undefined for a property access. */
  args: number | undefined;
}

/**
 * Resolve Velocity references to Java methods. A template's model objects are bound at runtime
 * (`context.put("event", event)`), so the variable's type is taken from its name (`$event` → a
 * project type `Event`), properties map to JavaBeans getters (`$e.type` → `getType()`/`isType()`),
 * and chains follow declared return types. Every edge is INFERRED — the binding is a convention,
 * not a declaration. When the variable's type cannot be found, the final method falls back to a
 * project-unique name (lower confidence), exactly like an untyped Java receiver.
 */
export function resolveTemplateCalls(
  templates: readonly TemplateFile[],
  index: ProjectIndex,
  table: SymbolTable,
): { edges: Edge[]; inferred: number } {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const tpl of templates) {
    const src = table.fileId(tpl.path);
    for (const ref of scanVelocityRefs(tpl.text)) {
      for (const hit of resolveTemplateRef(ref.variable, ref.segments, index)) {
        const id = edgeId(src, hit.method.id, 'calls');
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({
          id,
          src,
          dst: hit.method.id,
          rel: 'calls',
          method: 'inferred',
          provenance: 'INFERRED',
          confidence: hit.confidence,
          evidence: { by: 'velocity-resolver', snippet: `L${ref.line}: ${ref.text}` },
        });
      }
    }
  }
  return { edges, inferred: edges.length };
}

function resolveTemplateRef(
  variable: string,
  segments: TemplateSegment[],
  index: ProjectIndex,
): Array<{ method: MethodInfo; confidence: number }> {
  if (segments.length === 0) return [];
  const cap = (n: string): string => n.charAt(0).toUpperCase() + n.slice(1);
  const lookup = (t: TypeInfo, seg: TemplateSegment): MethodInfo[] => {
    if (seg.args !== undefined) {
      return index.methodsOf(t, seg.name).filter((m) => acceptsArity(m.def, seg.args!));
    }
    return [
      ...index.methodsOf(t, `get${cap(seg.name)}`),
      ...index.methodsOf(t, `is${cap(seg.name)}`),
    ].filter((m) => m.def.params.length === 0);
  };

  let types: TypeInfo[] = index.typesBySimpleName.get(cap(variable)) ?? [];
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k]!;
    if (types.length === 0) break;
    const last = k === segments.length - 1;
    const methods = types.flatMap((t) => lookup(t, seg));
    if (last) {
      return methods.map((m) => ({
        method: m,
        confidence: TEMPLATE_NAME_CONFIDENCE / Math.max(1, methods.length),
      }));
    }
    const next: TypeInfo[] = [];
    for (const m of methods) {
      const rt = index.returnTypeOf(m);
      if (rt.kind === 'project') next.push(rt.info);
      else if (rt.kind === 'external' && rt.name) return []; // typed by a library — not ours
    }
    if (methods.length === 0 && seg.args === undefined) {
      for (const t of types) {
        const f = index.fieldOf(t, seg.name);
        const ft = f
          ? index.resolveTypeName(f.def.fieldType ?? '', f.owner.file, f.owner)
          : UNKNOWN;
        if (ft.kind === 'project') next.push(ft.info);
      }
    }
    types = [...new Set(next)];
  }

  // unknown variable / chain type: a project-unique method name for the final segment.
  const final = segments[segments.length - 1]!;
  const names =
    final.args !== undefined ? [final.name] : [`get${cap(final.name)}`, `is${cap(final.name)}`];
  if (names.some((n) => FALLBACK_BLOCKLIST.has(n))) return [];
  const candidates = names
    .flatMap((n) => index.methodsByName.get(n) ?? [])
    .filter((m) =>
      final.args !== undefined ? acceptsArity(m.def, final.args) : m.def.params.length === 0,
    );
  return candidates.length === 1
    ? [{ method: candidates[0]!, confidence: INFERRED_FALLBACK_CONFIDENCE }]
    : [];
}

interface VelocityRef {
  variable: string;
  segments: TemplateSegment[];
  line: number;
  text: string;
}

/** Scan a Velocity template for `$var(.seg)*` references, ignoring `##` and `#* … *#` comments. */
export function scanVelocityRefs(text: string): VelocityRef[] {
  // blank out comments but keep newlines so line numbers stay true
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  const src = text.replace(/#\*[\s\S]*?\*#/g, blank).replace(/##[^\n]*/g, blank);
  const out: VelocityRef[] = [];
  const refRe = /\$!?\{?([A-Za-z][\w-]*)/g;
  for (let m = refRe.exec(src); m !== null; m = refRe.exec(src)) {
    const variable = m[1]!;
    let pos = refRe.lastIndex;
    const segments: TemplateSegment[] = [];
    while (src[pos] === '.' && /[A-Za-z_]/.test(src[pos + 1] ?? '')) {
      const nameMatch = /^[A-Za-z_]\w*/.exec(src.slice(pos + 1))!;
      const name = nameMatch[0];
      pos += 1 + name.length;
      let args: number | undefined;
      if (src[pos] === '(') {
        const close = matchVelocityParen(src, pos);
        if (close < 0) break;
        args = countTopLevelArgs(src.slice(pos + 1, close));
        pos = close + 1;
      }
      segments.push({ name, args });
    }
    refRe.lastIndex = Math.max(pos, refRe.lastIndex);
    if (segments.length === 0) continue;
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ variable, segments, line, text: src.slice(m.index, pos).slice(0, 120) });
  }
  return out;
}

function matchVelocityParen(src: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let k = open; k < src.length; k++) {
    const ch = src[k]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

function countTopLevelArgs(inner: string): number {
  if (inner.trim() === '') return 0;
  let depth = 0;
  let quote: string | undefined;
  let count = 1;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}
