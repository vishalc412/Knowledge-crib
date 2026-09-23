import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

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
      // biome-ignore lint/suspicious/noExplicitAny: axe is injected at runtime without types.
      const axe = (window as any).axe;
      const result = await axe.run(
        { include: [selector], exclude: [['[inert]']] },
        { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] },
      );
      // biome-ignore lint/suspicious/noExplicitAny: axe result shape.
      return result.violations.map((v: any) => ({
        rule: v.id,
        impact: v.impact ?? 'unknown',
        criteria: v.tags.filter((t: string) => /^wcag\d{3,4}$/.test(t)),
        help: v.help,
        // biome-ignore lint/suspicious/noExplicitAny: axe node shape.
        targets: v.nodes.slice(0, 5).map((n: any) => String(n.target.join(' '))),
      }));
    },
    { include, tags: WCAG_AA_TAGS },
  );
}
