/**
 * Ambient declarations for repo-root `.mjs` fixtures imported by tests (the deterministic PDF
 * builder at `scripts/fixtures/minimal-pdf.mjs`, used by the G5.3 adapter tests). TypeScript has no
 * type information for these hand-written ESM scripts and they live outside `rootDir`, so a wildcard
 * `*.mjs` declaration lets the test import type-check while Vitest loads the real module at runtime.
 *
 * Mirrors `packages/cli/src/mjs-modules.d.ts` — each package needs its own copy because `rootDir`
 * is `src` and `include` is `src/**\/*.ts`, so a declaration in a sibling package is not visible here.
 * Test-only — not part of the published pipeline surface.
 */
declare module '*.mjs' {
  const value: Record<string, unknown>;
  export default value;
  /** Build a byte-deterministic PDF whose pages each render the given text lines. */
  export const buildMinimalPdf: (pages: string[][]) => Buffer;
}
