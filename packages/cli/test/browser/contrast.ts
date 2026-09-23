import type { Page } from '@playwright/test';

export interface ContrastFailure {
  text: string;
  ratio: number;
  required: number;
  color: string;
  background: string;
}

/**
 * Sample every visible text run inside `rootSelector` and report the ones below WCAG 2.2 AA.
 *
 * The effective background is found by compositing each ancestor's background colour (and element
 * opacity) from the element outward until an opaque layer is reached, so translucent surfaces are
 * judged on what actually sits behind them. Elements drawn over the canvas are composited onto the
 * shell's page surface, which is the colour the canvas paints as its own background.
 */
export async function sampleTextContrast(
  page: Page,
  rootSelector: string,
): Promise<ContrastFailure[]> {
  return page.evaluate((selector) => {
    type Rgba = [number, number, number, number];
    const parse = (value: string): Rgba => {
      const parts = [...value.matchAll(/[\d.]+/g)].map((match) => Number(match[0]));
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => {
      const alpha = top[3] + bottom[3] * (1 - top[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      const channel = (index: number) =>
        (top[index] * top[3] + bottom[index] * bottom[3] * (1 - top[3])) / alpha;
      return [channel(0), channel(1), channel(2), alpha];
    };
    const luminance = (rgb: Rgba) =>
      [rgb[0], rgb[1], rgb[2]]
        .map((part) => part / 255)
        .map((part) => (part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4))
        .reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index], 0);
    const shell = document.querySelector('[data-kc-shell]') as HTMLElement;
    const pageSurface = parse(getComputedStyle(shell).backgroundColor);
    const backgroundOf = (element: Element): Rgba => {
      const layers: Rgba[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const layer = parse(getComputedStyle(node).backgroundColor);
        if (layer[3] > 0) layers.push(layer);
        if (layer[3] >= 1) break;
        if (node === shell) break;
      }
      let result: Rgba = [pageSurface[0], pageSurface[1], pageSurface[2], 1];
      for (let index = layers.length - 1; index >= 0; index -= 1)
        result = over(layers[index], result);
      return result;
    };
    const opacityOf = (element: Element) => {
      let value = 1;
      for (let node: Element | null = element; node; node = node.parentElement) {
        value *= Number(getComputedStyle(node).opacity || 1);
      }
      return value;
    };
    const root = document.querySelector(selector);
    if (!root) return [];
    const failures: ContrastFailure[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const value = (text.textContent ?? '').trim();
      const element = text.parentElement;
      if (!value || !element || seen.has(element)) continue;
      seen.add(element);
      if (element.closest('[inert],[aria-hidden="true"]')) continue;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (style.visibility === 'hidden' || box.width < 2 || box.height < 2) continue;
      if (element.closest('svg')) continue;
      const background = backgroundOf(element);
      const foregroundRaw = parse(style.color);
      const alpha = foregroundRaw[3] * opacityOf(element);
      const foreground = over(
        [foregroundRaw[0], foregroundRaw[1], foregroundRaw[2], alpha],
        background,
      );
      const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      const ratio = (light + 0.05) / (dark + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      const required = large ? 3 : 4.5;
      if (ratio + 0.005 < required) {
        failures.push({
          text: value.slice(0, 60),
          ratio: Math.round(ratio * 100) / 100,
          required,
          color: style.color,
          background: `rgb(${background.slice(0, 3).map(Math.round).join(', ')})`,
        });
      }
    }
    return failures;
  }, rootSelector);
}

/** Visible interactive controls inside `rootSelector` whose box is smaller than `min` CSS pixels. */
export async function undersizedTargets(
  page: Page,
  rootSelector: string,
  min: number,
): Promise<string[]> {
  return page.evaluate(
    ({ selector, size }) => {
      const root = document.querySelector(selector);
      if (!root) return [];
      const small: string[] = [];
      for (const element of root.querySelectorAll('button, input, select, [role="button"]')) {
        if (element.closest('[inert]')) continue;
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        if (getComputedStyle(element).visibility === 'hidden') continue;
        if (box.width + 0.5 < size || box.height + 0.5 < size) {
          const label =
            element.getAttribute('aria-label') ||
            element.getAttribute('title') ||
            (element.textContent ?? '').trim().slice(0, 40) ||
            element.tagName;
          small.push(`${label} (${Math.round(box.width)}×${Math.round(box.height)})`);
        }
      }
      return small;
    },
    { selector: rootSelector, size: min },
  );
}
