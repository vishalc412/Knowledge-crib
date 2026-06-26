/**
 * Low-level Java lexer + structural parser — unit coverage in isolation. These tests exercise the
 * tokenizer and the declaration parser DIRECTLY (not through the JavaExtractor pipeline), mirroring
 * the altitude of {@link spring.test.ts} (inline source, fast, deterministic) but targeting the
 * primitive layers the extractor builds on. Coverage: token shapes for every lexer scanner, the
 * comment collector, declaration tree (class/interface/enum/record + method/ctor/field), nested
 * generics, throws, record compact ctor, imports/package, call-site collection, the body
 * statement tree, and graceful degradation (malformed/truncated input never throws or hangs).
 */
import { describe, expect, it } from 'vitest';
import { collectComments, isKeyword, isModifier, tokenize } from './lexer.js';
import type { Token } from './lexer.js';
import { collectCallSites, collectImports, parseBodyStmts, parseJava } from './parser.js';
import type { JavaDef, JavaModule, JavaStmt } from './parser.js';

// --- tokenizer helpers --------------------------------------------------------

/** Tokenize and drop the trailing EOF for shape assertions. */
const toks = (src: string): Token[] => tokenize(src).filter((t) => t.type !== 'EOF');

/** Compact shape: each token as `TYPE:value` (numbers/strings/chars keep their literal value). */
const shapes = (src: string): string[] =>
  tokenize(src)
    .filter((t) => t.type !== 'EOF')
    .map((t) => `${t.type}:${t.value}`);

/** The EOF sentinel (always last, empty value). */
const eof = (src: string): Token => {
  const all = tokenize(src);
  return all[all.length - 1]!;
};

// --- parser helpers -----------------------------------------------------------

const parse = (src: string): JavaModule => parseJava(src);

/** Find a top-level or nested def by name (first match). */
const find = (defs: JavaDef[], name: string): JavaDef | undefined => {
  for (const d of defs) {
    if (d.name === name) return d;
    const nested = find(d.body, name);
    if (nested) return nested;
  }
  return undefined;
};

/** All def names in declaration order, flattened one level into the top-level list. */
const topNames = (m: JavaModule): string[] => m.defs.map((d) => d.name);

// =============================================================================
// Tokenizer
// =============================================================================

describe('Java lexer — tokenizer', () => {
  it('emits a trailing EOF token with empty value', () => {
    const e = eof('int x;');
    expect(e.type).toBe('EOF');
    expect(e.value).toBe('');
  });

  it('tokenizes identifiers (incl. $ and underscores)', () => {
    const ids = toks('fooBar _baz $value a1');
    expect(ids.every((t) => t.type === 'NAME')).toBe(true);
    expect(ids.map((t) => t.value)).toEqual(['fooBar', '_baz', '$value', 'a1']);
  });

  it('classifies keywords as NAME tokens (parser inspects .value)', () => {
    const ts = toks('class interface extends implements return new throws');
    expect(ts.every((t) => t.type === 'NAME')).toBe(true);
    expect(ts.map((t) => t.value)).toEqual([
      'class',
      'interface',
      'extends',
      'implements',
      'return',
      'new',
      'throws',
    ]);
    for (const kw of ['class', 'interface', 'extends', 'return', 'new']) {
      expect(isKeyword(kw)).toBe(true);
    }
    expect(isKeyword('notAKeyword')).toBe(false);
  });

  it('exposes isModifier for modifier/soft keywords only', () => {
    expect(isModifier('public')).toBe(true);
    expect(isModifier('static')).toBe(true);
    expect(isModifier('final')).toBe(true);
    // contextual keywords that may appear as names are NOT modifiers
    expect(isModifier('record')).toBe(false);
    expect(isModifier('var')).toBe(false);
    expect(isModifier('class')).toBe(false);
  });

  it('tokenizes decimal / hex / binary / suffixed numbers', () => {
    const ts = toks('42 0xFF 0b1010 1_000L 3.14f 100D 0 999');
    expect(ts.every((t) => t.type === 'NUMBER')).toBe(true);
    expect(ts.map((t) => t.value)).toEqual([
      '42',
      '0xFF',
      '0b1010',
      '1_000L',
      '3.14f',
      '100D',
      '0',
      '999',
    ]);
  });

  it('tokenizes exponents (e+ / e-)', () => {
    const ts = toks('1e10 1.5e-3 2E+4');
    expect(ts.map((t) => `${t.type}:${t.value}`)).toEqual([
      'NUMBER:1e10',
      'NUMBER:1.5e-3',
      'NUMBER:2E+4',
    ]);
  });

  it('tokenizes string literals with escapes', () => {
    const ts = toks('"hello" "a\\"b" "tab\\t"');
    expect(ts.every((t) => t.type === 'STRING')).toBe(true);
    expect(ts.map((t) => t.value)).toEqual(['"hello"', '"a\\"b"', '"tab\\t"']);
  });

  it('tokenizes Java 15+ text blocks ("""...""")', () => {
    const src = '"""\nline one\nline two\n"""';
    const ts = toks(src);
    expect(ts).toHaveLength(1);
    expect(ts[0]!.type).toBe('STRING');
    // value retains the triple-quote delimiters and the inner newlines
    expect(ts[0]!.value.startsWith('"""')).toBe(true);
    expect(ts[0]!.value.endsWith('"""')).toBe(true);
    expect(ts[0]!.value).toContain('line one');
    expect(ts[0]!.value).toContain('line two');
  });

  it('tokenizes char literals (regular + escaped)', () => {
    const ts = toks("'a' '\\n' '\\'' '\\\\'");
    expect(ts.every((t) => t.type === 'CHAR')).toBe(true);
    expect(ts.map((t) => t.value)).toEqual(["'a'", "'\\n'", "'\\''", "'\\\\'"]);
  });

  it('tokenizes annotations as OP @ + NAME (marker and single-arg)', () => {
    // @Foo  →  OP:@  NAME:Foo
    expect(shapes('@Foo')).toEqual(['OP:@', 'NAME:Foo']);
    // @Foo("/x") keeps the parenthesized args as separate tokens
    const s = shapes('@GetMapping("/api/loans")');
    expect(s[0]).toBe('OP:@');
    expect(s[1]).toBe('NAME:GetMapping');
    expect(s[2]).toBe('OP:(');
    expect(s[3]).toBe('STRING:"/api/loans"');
    expect(s[4]).toBe('OP:)');
  });

  it('skips line comments entirely (no tokens emitted)', () => {
    const s = shapes('int x; // a line comment\nint y;');
    expect(s).toEqual(['NAME:int', 'NAME:x', 'OP:;', 'NAME:int', 'NAME:y', 'OP:;']);
  });

  it('skips block comments and javadoc (no tokens emitted)', () => {
    const src = 'int x; /* block */ int y; /** javadoc */ int z;';
    expect(shapes(src)).toEqual([
      'NAME:int',
      'NAME:x',
      'OP:;',
      'NAME:int',
      'NAME:y',
      'OP:;',
      'NAME:int',
      'NAME:z',
      'OP:;',
    ]);
  });

  it('tokenizes multi-char operators longest-first (>>, >>>, ->, ::, ...)', () => {
    const cases: Array<[string, string[]]> = [
      ['a >> b', ['NAME:a', 'OP:>>', 'NAME:b']],
      ['a >>> b', ['NAME:a', 'OP:>>>', 'NAME:b']],
      ['a -> b', ['NAME:a', 'OP:->', 'NAME:b']],
      ['a::b', ['NAME:a', 'OP:::', 'NAME:b']],
      [
        'void f(int... xs)',
        ['NAME:void', 'NAME:f', 'OP:(', 'NAME:int', 'OP:...', 'NAME:xs', 'OP:)'],
      ],
      ['x << y', ['NAME:x', 'OP:<<', 'NAME:y']],
      ['x == y != z', ['NAME:x', 'OP:==', 'NAME:y', 'OP:!=', 'NAME:z']],
      ['x >= y <= z', ['NAME:x', 'OP:>=', 'NAME:y', 'OP:<=', 'NAME:z']],
      ['x && y || z', ['NAME:x', 'OP:&&', 'NAME:y', 'OP:||', 'NAME:z']],
      ['i++ j--', ['NAME:i', 'OP:++', 'NAME:j', 'OP:--']],
    ];
    for (const [src, want] of cases) expect(shapes(src)).toEqual(want);
  });

  it('splits generic closers via the Java >>/>>> lexer rule', () => {
    // List<List<X>>  →  the >> closes two open <s, emitted as ONE OP:>> token (header skipper balances it)
    expect(shapes('List<List<X>>')).toEqual([
      'NAME:List',
      'OP:<',
      'NAME:List',
      'OP:<',
      'NAME:X',
      'OP:>>',
    ]);
    // Map<K,V>>> is contrived but validates the 3-closer
    expect(shapes('A<B<C<D>>>')).toEqual([
      'NAME:A',
      'OP:<',
      'NAME:B',
      'OP:<',
      'NAME:C',
      'OP:<',
      'NAME:D',
      'OP:>>>',
    ]);
  });

  it('records 1-based line + col for each token (tracks newlines)', () => {
    const ts = toks('a\n  b\n    c');
    expect(ts.map((t) => `${t.value}@${t.line}:${t.col}`)).toEqual(['a@1:1', 'b@2:3', 'c@3:5']);
  });

  it('degrades gracefully on an unterminated string (no throw, tolerates)', () => {
    expect(() => tokenize('"oops')).not.toThrow();
    const ts = toks('"oops\nafter');
    // the unterminated string stops at the newline; "after" is a normal NAME
    expect(ts[0]!.type).toBe('STRING');
    expect(ts.find((t) => t.type === 'NAME' && t.value === 'after')).toBeDefined();
  });

  it('degrades gracefully on an unterminated char literal (no throw)', () => {
    expect(() => tokenize("'x")).not.toThrow();
    const ts = toks("'x\nok");
    expect(ts[0]!.type).toBe('CHAR');
    expect(ts.find((t) => t.type === 'NAME' && t.value === 'ok')).toBeDefined();
  });

  it('degrades gracefully on an unterminated block comment (no throw)', () => {
    expect(() => tokenize('int x; /* never closed')).not.toThrow();
    expect(shapes('int x; /* never closed')).toEqual(['NAME:int', 'NAME:x', 'OP:;']);
  });

  it('does NOT support string interpolation (Java has none) — ${...} is verbatim string text', () => {
    // Java strings are not interpolated; `\\` escape is consumed but `${x}` stays literal.
    const ts = toks('"${notInterpolated}"');
    expect(ts).toHaveLength(1);
    expect(ts[0]!.type).toBe('STRING');
    expect(ts[0]!.value).toBe('"${notInterpolated}"');
  });
});

// =============================================================================
// Comment collector (collectComments)
// =============================================================================

describe('Java lexer — collectComments', () => {
  it('merges a contiguous // run into one block with a 1-based line span', () => {
    const src = ['// first line', '// second line', '', '// after a gap (separate block)'].join(
      '\n',
    );
    const blocks = collectComments(src);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ start: 1, end: 2, javadoc: false });
    expect(blocks[0]!.text).toBe('first line\nsecond line');
    expect(blocks[1]).toMatchObject({ start: 4, end: 4, javadoc: false });
    expect(blocks[1]!.text).toBe('after a gap (separate block)');
  });

  it('captures a single-line block comment', () => {
    const blocks = collectComments('/* hello */');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ start: 1, end: 1, text: 'hello', javadoc: false });
  });

  it('captures a multi-line javadoc block, stripping the per-line star', () => {
    const src = ['/**', ' * Summary.', ' * @param x the x', ' */'].join('\n');
    const blocks = collectComments(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.javadoc).toBe(true);
    expect(blocks[0]!.start).toBe(1);
    expect(blocks[0]!.end).toBe(4);
    expect(blocks[0]!.text).toContain('Summary.');
    expect(blocks[0]!.text).toContain('@param x the x');
  });

  it('never throws on empty / comment-less source', () => {
    expect(() => collectComments('')).not.toThrow();
    expect(collectComments('int x;')).toEqual([]);
  });
});

// =============================================================================
// Structural parser — declarations
// =============================================================================

describe('Java parser — type declarations', () => {
  it('parses a class with modifiers + annotations + extends + implements', () => {
    const m = parse(
      'package com.example; @RestController public class AuthController extends BaseController implements AuthApi {}',
    );
    expect(m.pkg).toBe('com.example');
    const c = find(m.defs, 'AuthController');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('class');
    expect(c!.modifiers).toContain('public');
    expect(c!.annotations).toEqual(['RestController']);
    expect(c!.bases).toEqual(['BaseController']);
    expect(c!.implements).toEqual(['AuthApi']);
  });

  it('parses an interface with a method header (no body = ;)', () => {
    const m = parse('public interface Greeter { String greet(String user); }');
    const iface = find(m.defs, 'Greeter');
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe('interface');
    expect(iface!.body.map((d) => d.name)).toEqual(['greet']);
    const greet = iface!.body[0]!;
    expect(greet.kind).toBe('method');
    expect(greet.params).toEqual(['user']);
    expect(greet.paramTypes).toEqual(['String']);
    expect(greet.returnType).toBe('String');
  });

  it('parses an enum with constants + a method', () => {
    const m = parse('enum Role { ADMIN, USER; String label() { return name(); } }');
    const e = find(m.defs, 'Role');
    expect(e!.kind).toBe('enum');
    // enum constants are skipped; only the method surfaces as a def
    const names = e!.body.map((d) => d.name);
    expect(names).toContain('label');
    expect(names).not.toContain('ADMIN');
    expect(names).not.toContain('USER');
  });

  it('parses a record with a compact canonical constructor (params + paramTypes)', () => {
    const m = parse('public record Token(String value, long expires) {}');
    const r = find(m.defs, 'Token');
    expect(r!.kind).toBe('record');
    expect(r!.params).toEqual(['value', 'expires']);
    expect(r!.paramTypes).toEqual(['String', 'long']);
  });

  it('parses nested types (class inside class) and preserves nesting in body', () => {
    const m = parse('class Outer { class Inner {} static class StaticNested {} }');
    const outer = find(m.defs, 'Outer');
    expect(outer!.body.map((d) => `${d.kind}:${d.name}`).sort()).toEqual([
      'class:Inner',
      'class:StaticNested',
    ]);
    // the nested classes do NOT also appear at top level
    expect(topNames(m)).toEqual(['Outer']);
  });
});

describe('Java parser — members (methods, constructors, fields)', () => {
  it('distinguishes a method from a constructor (>=2 depth-0 names => method)', () => {
    const m = parse('class C { C() {} void m() {} }');
    const ctor = find(m.defs, 'C')!.body.find((d) => d.name === 'C')!;
    const meth = find(m.defs, 'C')!.body.find((d) => d.name === 'm')!;
    expect(ctor.kind).toBe('constructor');
    expect(meth.kind).toBe('method');
    expect(meth.returnType).toBe('void');
    expect(ctor.returnType).toBeUndefined();
  });

  it('captures method params, paramTypes, param annotations, and return type', () => {
    const m = parse(
      'class C { @PostMapping("/x") Loan apply(@PathVariable("id") String id, @RequestBody Loan loan) { return null; } }',
    );
    const meth = find(m.defs, 'C')!.body.find((d) => d.name === 'apply')!;
    expect(meth.kind).toBe('method');
    expect(meth.annotations).toEqual(['PostMapping']);
    expect(meth.annos?.[0]).toMatchObject({ name: 'PostMapping', args: '"/x"' });
    expect(meth.params).toEqual(['id', 'loan']);
    expect(meth.paramTypes).toEqual(['String', 'Loan']);
    expect(meth.paramAnnos).toEqual([['PathVariable'], ['RequestBody']]);
    expect(meth.returnType).toBe('Loan');
  });

  it('captures nested generics: return element type of List<Payment>', () => {
    const m = parse('class C { List<Payment> all() { return null; } }');
    const meth = find(m.defs, 'C')!.body.find((d) => d.name === 'all')!;
    expect(meth.returnType).toBe('List');
    expect(meth.returnElementType).toBe('Payment');
  });

  it('captures a throws clause (skips to body without throwing)', () => {
    const m = parse('class C { void risky() throws IOException, SQLException { doThing(); } }');
    const meth = find(m.defs, 'C')!.body.find((d) => d.name === 'risky')!;
    expect(meth.kind).toBe('method');
    expect(meth.params).toEqual([]);
    expect(meth.returnType).toBe('void');
    // body is parsed (the call site is captured), proving the throws clause was skipped cleanly
    expect(m.calls.find((c) => c.name === 'doThing')).toBeDefined();
  });

  it('captures a field def with fieldType + fieldElementType (collection)', () => {
    const m = parse('class C { @Autowired private List<User> users; }');
    const field = find(m.defs, 'C')!.body.find((d) => d.kind === 'field');
    expect(field).toBeDefined();
    expect(field!.name).toBe('users');
    expect(field!.fieldType).toBe('List');
    expect(field!.fieldElementType).toBe('User');
    expect(field!.annotations).toEqual(['Autowired']);
  });

  it('captures a plain scalar field with its type head (dotted type → last segment)', () => {
    const m = parse('class C { private com.example.UserRepo repo; }');
    const field = find(m.defs, 'C')!.body.find((d) => d.kind === 'field');
    expect(field!.name).toBe('repo');
    expect(field!.fieldType).toBe('UserRepo');
  });

  it('skips an initializer block without emitting a def', () => {
    const m = parse('class C { static { int x = 1; } }');
    expect(find(m.defs, 'C')!.body).toEqual([]);
  });
});

// =============================================================================
// Imports + package + call sites
// =============================================================================

describe('Java parser — imports + package', () => {
  it('collects the package and a plain import', () => {
    const m = parse('package com.acme.app;\nimport com.acme.lib.Util;\nclass C {}');
    expect(m.pkg).toBe('com.acme.app');
    expect(m.imports).toEqual([
      { module: 'com.acme.lib', name: 'Util', star: false, static: false, line: 2 },
    ]);
  });

  it('collects a wildcard import', () => {
    const m = parse('import com.acme.lib.*;\nclass C {}');
    expect(m.imports[0]).toMatchObject({
      module: 'com.acme.lib',
      name: '',
      star: true,
      static: false,
    });
  });

  it('collects a static import (bound name = last segment)', () => {
    const m = parse('import static com.acme.lib.Math.PI;\nclass C {}');
    expect(m.imports[0]).toMatchObject({
      module: 'com.acme.lib.Math',
      name: 'PI',
      star: false,
      static: true,
    });
  });
});

describe('Java parser — call sites', () => {
  it('collects a bare call and a dotted call', () => {
    const m = parse('class C { void m() { doThing(); Collections.sort(xs); } }');
    const names = m.calls.map((c) => `${c.head}.${c.name}#${c.tail.join('.')}`).sort();
    expect(names).toContain('doThing.doThing#');
    expect(names).toContain('Collections.sort#sort');
  });

  it('does NOT record a method definition paren as a call', () => {
    // m() {} — the definition `(` is excluded; only the body call `doThing()` surfaces
    const m = parse('class C { void m() { doThing(); } }');
    expect(m.calls.map((c) => c.name).sort()).toEqual(['doThing']);
  });

  it('does NOT record an annotation arg paren as a call', () => {
    // @PostMapping("/x") — the annotation `(` is excluded; the route path string is not a call
    const m = parse('class C { @PostMapping("/x") void m() {} }');
    expect(m.calls).toEqual([]);
  });

  it('records a constructor call (new Foo())', () => {
    const m = parse('class C { void m() { new Foo(); } }');
    // `new` is a NAME not followed by `(`; the following `Foo(` is the constructor call
    const f = m.calls.find((c) => c.name === 'Foo');
    expect(f).toBeDefined();
    expect(f!.head).toBe('Foo');
  });
});

// =============================================================================
// Body statement tree (Track 3)
// =============================================================================

describe('Java parser — body statement tree', () => {
  /** Parse one method's body statements directly via parseBodyStmts. */
  const bodyOf = (src: string): JavaStmt[] => {
    const m = parse(src);
    const c = find(m.defs, 'C');
    const meth = c!.body.find((d) => d.kind === 'method' || d.kind === 'constructor');
    return meth?.stmts ?? [];
  };

  it('captures an if / else-if / else chain as branches', () => {
    const stmts = bodyOf(
      'class C { void m(int x) { if (x > 0) { a(); } else if (x < 0) { b(); } else { c(); } } }',
    );
    expect(stmts).toHaveLength(1);
    const iff = stmts[0]!;
    expect(iff.kind).toBe('if');
    expect(iff.branches?.map((b) => b.role)).toEqual(['then', 'elseif', 'else']);
    expect(iff.branches?.[0]?.predicate).toContain('x > 0');
    expect(iff.branches?.[1]?.predicate).toContain('x < 0');
  });

  it('captures a for-loop with a predicate + body', () => {
    const stmts = bodyOf('class C { void m() { for (int i = 0; i < 10; i++) { doThing(i); } } }');
    const loop = stmts.find((s) => s.kind === 'for');
    expect(loop).toBeDefined();
    expect(loop!.predicate).toContain('i < 10');
    expect(loop!.body?.length).toBeGreaterThan(0);
  });

  it('captures a try / catch / finally', () => {
    const stmts = bodyOf(
      'class C { void m() { try { a(); } catch (Exception e) { b(); } finally { c(); } } }',
    );
    const tr = stmts.find((s) => s.kind === 'try');
    expect(tr).toBeDefined();
    expect(tr!.tryBody?.length).toBeGreaterThan(0);
    expect(tr!.catches?.[0]?.predicate).toContain('Exception e');
    expect(tr!.finallyBody?.length).toBeGreaterThan(0);
  });

  it('captures a return statement with embedded call chain', () => {
    const stmts = bodyOf('class C { int m() { return svc.compute(x); } }');
    const ret = stmts.find((s) => s.kind === 'return');
    expect(ret).toBeDefined();
    expect(ret!.text).toContain('svc.compute(x)');
    expect(ret!.callChain).toEqual(['svc', 'compute']);
  });

  it('captures a plain assignment (lhs = rhs) as an assign statement', () => {
    const stmts = bodyOf('class C { void m() { count = count + 1; } }');
    const a = stmts.find((s) => s.kind === 'assign');
    expect(a).toBeDefined();
    expect(a!.assignTarget).toBe('count');
  });

  it('keeps a call-bearing assignment as a call (the call is the interesting part)', () => {
    const stmts = bodyOf('class C { void m() { result = svc.process(x); } }');
    const call = stmts.find((s) => s.kind === 'call');
    expect(call).toBeDefined();
    expect(call!.callChain).toEqual(['svc', 'process']);
  });

  it('parses a switch with case arms', () => {
    const stmts = bodyOf(
      'class C { void m(int x) { switch (x) { case 1: a(); break; case 2: b(); break; default: c(); } } }',
    );
    const sw = stmts.find((s) => s.kind === 'switch');
    expect(sw).toBeDefined();
    const caseRoles = sw!.cases?.map((c) => (c.predicate !== undefined ? 'case' : 'default'));
    expect(caseRoles).toEqual(['case', 'case', 'default']);
  });
});

// =============================================================================
// Graceful degradation
// =============================================================================

describe('Java parser — graceful degradation (never throws / never hangs)', () => {
  it('returns an empty module on a truncated class header', () => {
    expect(() => parse('class')).not.toThrow();
    const m = parse('class');
    // malformed type (no name) yields no defs; no throw
    expect(m.defs).toEqual([]);
  });

  it('returns best-effort defs on a truncated body (unterminated {)', () => {
    const src = 'class C { void m() { doThing('; // unclosed paren + unclosed brace
    expect(() => parse(src)).not.toThrow();
    const m = parse(src);
    // the class and method are still recognized; the malformed body is consumed best-effort
    expect(find(m.defs, 'C')).toBeDefined();
  });

  it('skips to block end on a stray } without throwing (top-level stray } ends the parse)', () => {
    // A stray `}` at top level terminates the declaration scan (graceful) — the contract is no-throw;
    // a class AFTER the stray `}` is not recovered. Verify the degradation itself, not recovery.
    expect(() => parse('} } } class C {}')).not.toThrow();
    const m = parse('} } } class C {}');
    expect(m.defs).toEqual([]);
    // a class BEFORE any stray brace is still parsed (the stray trailing } just ends the scan)
    const ok = parse('class C {} } } }');
    expect(find(ok.defs, 'C')).toBeDefined();
  });

  it('does not hang on a malformed enum constant body', () => {
    const src = 'enum E { A( { }, B; }'; // malformed constant arg
    expect(() => parse(src)).not.toThrow();
    const m = parse(src);
    expect(find(m.defs, 'E')).toBeDefined();
  });

  it('parseBodyStmts returns [] on an unterminated body (never throws)', () => {
    const tokens = tokenize('class C { void m() { doThing();');
    // locate the body opening brace index (the one after m() )
    let openIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.type === 'OP' && tokens[i]!.value === '{') openIdx = i;
    }
    expect(openIdx).toBeGreaterThan(-1);
    const lineStarts = [0];
    const src = 'class C { void m() { doThing();';
    for (const ch of src) if (ch === '\n') lineStarts.push(0); // single-line; offsets not needed for bail
    expect(() => parseBodyStmts(tokens, src, lineStarts, openIdx)).not.toThrow();
    expect(parseBodyStmts(tokens, src, lineStarts, openIdx)).toEqual([]);
  });

  it('parseJava returns an empty module on garbage input (outer try-catch)', () => {
    // pathological: a class keyword followed by reserved-word garbage
    expect(() => parse('class void extends')).not.toThrow();
    const m = parse('class void extends');
    expect(m.defs).toEqual([]);
  });
});

// =============================================================================
// collectCallSites / collectImports in isolation (exported helpers)
// =============================================================================

describe('Java parser — exported helpers in isolation', () => {
  it('collectCallSites finds a dotted chain and splits head/tail/name', () => {
    const tokens = tokenize('a.b.c(x)');
    const calls = collectCallSites(tokens, new Set());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ head: 'a', name: 'c', tail: ['b', 'c'], line: 1 });
  });

  it('collectCallSites skips an excluded paren index', () => {
    const tokens = tokenize('foo(bar)');
    // the `(` is at index 1 (NAME:foo=0, OP:(=1) — exclude it (simulating a def/annotation paren)
    const calls = collectCallSites(tokens, new Set([1]));
    expect(calls).toEqual([]);
  });

  it('collectImports parses package + imports from a raw token stream', () => {
    const tokens = tokenize('package p.q;\nimport a.b.C;\nimport static x.y.Z;');
    const { pkg, imports } = collectImports(tokens);
    expect(pkg).toBe('p.q');
    expect(imports.map((i) => `${i.static ? 'static ' : ''}${i.module}#${i.name}`)).toEqual([
      'a.b#C',
      'static x.y#Z',
    ]);
  });
});
