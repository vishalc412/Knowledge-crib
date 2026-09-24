import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import type { AxeResults, NodeResult, Result } from 'axe-core';

const require = createRequire(import.meta.url);
/** The vendored axe-core engine, injected from disk — the audit never fetches anything. */
const AXE_PATH = require.resolve('axe-core/axe.min.js');

/** WCAG 2.0–2.2 Level A and AA rule tags: the conformance target of the release gate. */
export const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

export interface AxeFinding {
  rule: string;
  impact: string;
  criteria: string[];
  help: string;
  targets: string[];
}

/**
 * Run axe-core's WCAG A/AA rules against the live page (or one region of it). Inert layers are
 * excluded because they are, by definition, not operable while a modal owns the keyboard.
 */
export async function runAxe(page: Page, include = 'body'): Promise<AxeFinding[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(
    async ({ include: selector, tags }) => {
      // Injected by addScriptTag above; the package's own declarations describe the global.
      const engine = (window as unknown as { axe: typeof import('axe-core') }).axe;
      const result: AxeResults = await engine.run(
        { include: [selector], exclude: [['[inert]']] },
        { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] },
      );
      return result.violations.map((v: Result) => ({
        rule: v.id,
        impact: v.impact ?? 'unknown',
        criteria: v.tags.filter((t: string) => /^wcag\d{3,4}$/.test(t)),
        help: v.help,
        targets: v.nodes.slice(0, 5).map((n: NodeResult) => String(n.target.join(' '))),
      }));
    },
    { include, tags: WCAG_AA_TAGS },
  );
}
