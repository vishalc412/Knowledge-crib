import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { TypeScriptExtractor } from './TypeScriptExtractor.js';
import { maskToEmbeddedScripts } from './embedded-scripts.js';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function extract(path: string, text: string): Promise<ExtractResult> {
  const meta: FileMeta = { path, lang: undefined, bytes: text.length, mtime: 0 } as FileMeta;
  const x = new TypeScriptExtractor();
  expect(x.supports(meta)).toBe(true);
  return x.extract(meta, ctxFor(text));
}

const symbol = (r: ExtractResult, name: string) =>
  r.nodes.find((n) => n.kind === 'symbol' && n.name === name);

describe('code embedded in markup is indexed at its real lines', () => {
  it('html: inline scripts, including custom script types, but not src or JSON blocks', async () => {
    const html = [
      '<!doctype html>', // 1
      '<script src="./vendor.js"></script>', // 2
      '<script type="application/json">{"setPresentation": 1}</script>', // 3
      '<p>function notCode() {}</p>', // 4
      '<script type="text/x-dc">', // 5
      'class Viewer {', // 6
      '  setPresentation(next) { return next; }', // 7
      '}', // 8
      '</script>', // 9
    ].join('\n');
    const r = await extract('packages/ui/web/index.html', html);
    const method = symbol(r, 'setPresentation');
    expect(method?.span?.start).toBe(7);
    expect(method?.lang).toBe('javascript');
    expect(symbol(r, 'notCode')).toBeUndefined();
  });

  it('vue: <script setup lang="ts"> is parsed as TypeScript', async () => {
    const vue = [
      '<template><button @click="save">Save</button></template>',
      '<script setup lang="ts">',
      'export function save(id: string): void {}',
      '</script>',
    ].join('\n');
    const r = await extract('src/components/Save.vue', vue);
    expect(symbol(r, 'save')?.span?.start).toBe(3);
    expect(symbol(r, 'save')?.lang).toBe('typescript');
  });

  it('svelte and astro frontmatter', async () => {
    const svelte =
      '<script>\n  export let count = 0;\n  function increment() { count += 1; }\n</script>\n<button on:click={increment}>{count}</button>';
    expect(symbol(await extract('src/Counter.svelte', svelte), 'increment')?.span?.start).toBe(3);
    const astro = '---\nfunction title(s: string) { return s; }\n---\n<h1>{title("x")}</h1>';
    expect(symbol(await extract('src/pages/index.astro', astro), 'title')?.span?.start).toBe(2);
  });

  it('a markup file with no inline code yields nothing', async () => {
    const r = await extract('docs/page.html', '<html><body><p>hello</p></body></html>');
    expect(r.nodes).toEqual([]);
  });

  it('masking preserves length and line breaks exactly', () => {
    const src = 'a\r\n<script>let x = 1;\n</script>\nb';
    const masked = maskToEmbeddedScripts('x.html', src);
    expect(masked.text.length).toBe(src.length);
    expect(masked.text.split('\n').length).toBe(src.split('\n').length);
    expect(masked.text).toContain('let x = 1;');
    expect(masked.text).not.toContain('<script>');
  });
});
