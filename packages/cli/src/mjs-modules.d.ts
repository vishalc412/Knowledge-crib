/**
 * Ambient declarations for repo-root `.mjs` scripts imported by tests (e.g. the synthetic Mule
 * project generator at `scripts/fixtures/synthetic-mule-project.mjs`). TypeScript has no type
 * information for these hand-written ESM scripts and they live outside `rootDir`, so a wildcard
 * `*.mjs` declaration lets the test import resolve to `any` at compile time while Vitest loads the
 * real module at runtime. Test-only — not part of the published CLI surface.
 */
declare module '*.mjs' {
  const value: Record<string, unknown>;
  export default value;
  export const syntheticMuleProject: (root: string) => void;
  export const SECRET_CANARY: string;
}
