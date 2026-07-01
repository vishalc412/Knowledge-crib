/**
 * React framework-semantics (schema 1.3) — dedicated coverage of
 * {@link extractReactSemantics} driven through the {@link TypeScriptExtractor} end-to-end (Pass 4).
 * Mirrors {@link nest.test.ts}: the artifacts that put a React component tree "above reading it" —
 * component/hook tagging, the renders composition graph, hook usage, and props/state types — each
 * exercised for the happy path, the edge shapes, and the no-op gates. Inline source keeps these
 * fast + deterministic. PATH is `.tsx` so JSX parses.
 */
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { TypeScriptExtractor } from './TypeScriptExtractor.js';

const PATH = 'react.tsx';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used — TypeScript uses the TS compiler API');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(src: string): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'typescript', bytes: src.length, mtime: 0 };
  return new TypeScriptExtractor().extract(meta, ctxFor(src));
}

/** label a node id by qualified name (symbol), else kind — for readable edge assertions. */
function label(r: ExtractResult): (id: string) => string {
  return (id: string): string => {
    const n = r.nodes.find((x) => x.id === id);
    return n?.qualifiedName ?? n?.name ?? n?.kind ?? id;
  };
}

/** `framework:stereotype` for a symbol by qualified name (none if absent). */
const tagOf = (r: ExtractResult, q: string): string => {
  const n = r.nodes.find((x) => x.qualifiedName === q);
  return `${n?.framework ?? 'none'}:${n?.stereotype ?? 'none'}`;
};

/** all `renders` edges: parent → child, sorted. */
const renders = (r: ExtractResult): string[] => {
  const lbl = label(r);
  return r.edges
    .filter((e) => e.rel === 'renders')
    .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
    .sort();
};

/** `meta.renders` (cross-file / unresolved child names) for a symbol by qualified name. */
const metaRenders = (r: ExtractResult, q: string): string[] => {
  const n = r.nodes.find((x) => x.qualifiedName === q);
  return (n?.meta?.renders as string[] | undefined) ?? [];
};

/** `meta.hooks` for a symbol by qualified name. */
const metaHooks = (r: ExtractResult, q: string): string[] => {
  const n = r.nodes.find((x) => x.qualifiedName === q);
  return (n?.meta?.hooks as string[] | undefined) ?? [];
};

/** `meta.propsType` for a symbol by qualified name. */
const metaPropsType = (r: ExtractResult, q: string): string | undefined =>
  r.nodes.find((x) => x.qualifiedName === q)?.meta?.propsType as string | undefined;

/** `meta.stateType` for a symbol by qualified name. */
const metaStateType = (r: ExtractResult, q: string): string | undefined =>
  r.nodes.find((x) => x.qualifiedName === q)?.meta?.stateType as string | undefined;

describe('React components', () => {
  it('tags a function component returning JSX with framework + stereotype', async () => {
    const src = ['function Card() {', '  return <div>hello</div>;', '}'].join('\n');
    const r = await run(src);
    expect(tagOf(r, 'Card')).toBe('react:component');
  });

  it('tags an arrow-const component returning JSX', async () => {
    const src = ['const Badge = () => <span>x</span>;'].join('\n');
    const r = await run(src);
    expect(tagOf(r, 'Badge')).toBe('react:component');
  });

  it('tags a class component extending Component and records props/state type args', async () => {
    const src = [
      'class Counter extends Component<CounterProps, CounterState> {',
      '  render() { return <div/>; }',
      '}',
    ].join('\n');
    const r = await run(src);
    expect(tagOf(r, 'Counter')).toBe('react:component');
    expect(metaPropsType(r, 'Counter')).toBe('CounterProps');
    expect(metaStateType(r, 'Counter')).toBe('CounterState');
  });

  it('tags a class component extending React.PureComponent', async () => {
    const src = [
      'class Row extends React.PureComponent {',
      '  render() { return <div/>; }',
      '}',
    ].join('\n');
    const r = await run(src);
    expect(tagOf(r, 'Row')).toBe('react:component');
  });

  it('records the props type from a function component param', async () => {
    const src = ['function List(props: ListProps) {', '  return <ul/>;', '}'].join('\n');
    const r = await run(src);
    expect(metaPropsType(r, 'List')).toBe('ListProps');
  });

  it('is a no-op for a PascalCase function returning no JSX (not a component)', async () => {
    const src = ['function Adder(a: number, b: number) {', '  return a + b;', '}'].join('\n');
    const r = await run(src);
    expect(tagOf(r, 'Adder')).toBe('none:none');
  });

  it('is a no-op for a non-React class (no Component heritage)', async () => {
    const src = ['class Plain {', '  render() { return 1; }', '}'].join('\n');
    const r = await run(src);
    expect(tagOf(r, 'Plain')).toBe('none:none');
  });
});

describe('React renders graph', () => {
  it('emits renders edges for JSX child components (intra-file resolved)', async () => {
    const src = [
      'function Child() { return <div/>; }',
      'function Parent() { return <Child/>; }',
    ].join('\n');
    const r = await run(src);
    expect(renders(r)).toEqual(['Parent -> Child']);
  });

  it('records cross-file child names on meta.renders (unresolved, honest)', async () => {
    // External is not defined in this file → no symbol → recorded on meta.renders only.
    const src = ['function Page() { return <External/>; }'].join('\n');
    const r = await run(src);
    expect(renders(r)).toEqual([]);
    expect(metaRenders(r, 'Page')).toEqual(['External']);
  });

  it('skips DOM tags (lowercase) — only PascalCase tags are component renders', async () => {
    const src = ['function Box() { return <div><span/></div>; }'].join('\n');
    const r = await run(src);
    expect(renders(r)).toEqual([]);
    expect(metaRenders(r, 'Box')).toEqual([]);
  });

  it('emits renders edges for React.createElement(Foo) / createElement(Foo) calls', async () => {
    const src = [
      'function Item() { return React.createElement("div"); }',
      'function Grid() {',
      '  return createElement(Item);',
      '}',
    ].join('\n');
    const r = await run(src);
    expect(renders(r)).toEqual(['Grid -> Item']);
  });

  it('collects renders from callback bodies (e.g. .map)', async () => {
    const src = [
      'function Row() { return <div/>; }',
      'function List() {',
      '  return <ul>{items.map((i) => <Row key={i.id}/>)}</ul>;',
      '}',
    ].join('\n');
    const r = await run(src);
    expect(renders(r)).toEqual(['List -> Row']);
  });
});

describe('React hooks', () => {
  it('tags a custom hook that calls a hook with stereotype hook', async () => {
    const src = [
      'function useAuth() {',
      '  const [x, setX] = useState(null);',
      '  return x;',
      '}',
    ].join('\n');
    const r = await run(src);
    expect(tagOf(r, 'useAuth')).toBe('react:hook');
    expect(metaHooks(r, 'useAuth')).toEqual(['useState']);
  });

  it('does NOT tag a useX function that calls no hook (mis-named, not a hook)', async () => {
    const src = ['function useHelper() {', '  return compute();', '}'].join('\n');
    const r = await run(src);
    expect(tagOf(r, 'useHelper')).toBe('none:none');
  });

  it('records meta.hooks on a component (the state/side-effect contract)', async () => {
    const src = [
      'function Profile() {',
      '  const [n, setN] = useState(0);',
      '  useEffect(() => {}, []);',
      '  return <div/>;',
      '}',
    ].join('\n');
    const r = await run(src);
    expect(tagOf(r, 'Profile')).toBe('react:component');
    expect(metaHooks(r, 'Profile').sort()).toEqual(['useEffect', 'useState']);
  });
});
