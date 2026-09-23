// Repeatable, read-only UI benchmark against an indexed repository near the audited scale.
// Run from any directory: node packages/cli/test/browser/large-graph-benchmark.mjs
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const cli = join(root, 'packages/cli/dist/cli.js');
const privateHome = mkdtempSync(join(tmpdir(), 'crib-ui-bench-'));
const samples = [];
let browser;
let server;

const median = (values) => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
};

try {
  const started = performance.now();
  server = spawn(process.execPath, [cli, 'viz', '--no-open', '--port', '0'], {
    cwd: root,
    env: {
      ...process.env,
      KCRIB_MEMORY_DIR: privateHome,
      KCRIB_REGISTRY_DIR: privateHome,
      KCRIB_PRINCIPAL_ID: 'principal:ui-benchmark',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolveUrl, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error(`viz startup timed out: ${output}`)),
      180_000,
    );
    const onOutput = (chunk) => {
      output += chunk.toString();
      const port = output.match(/viz → http:\/\/127\.0\.0\.1:(\d+)\//)?.[1];
      if (port) {
        clearTimeout(timeout);
        resolveUrl(`http://127.0.0.1:${port}/`);
      }
    };
    server.stdout.on('data', onOutput);
    server.stderr.on('data', onOutput);
    server.on('exit', (code) => reject(new Error(`viz exited ${code}: ${output}`)));
  });
  const serverStartupMs = performance.now() - started;
  browser = await chromium.launch({ headless: true });
  for (let pass = 0; pass < 3; pass++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageStart = performance.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => {
        const count = document.querySelector('.kc-rail-stat strong')?.textContent?.trim() || '';
        return /[1-9]/.test(count);
      },
      undefined,
      { timeout: 180_000 },
    );
    const startupMs = performance.now() - pageStart;
    const nodeCount = await page.locator('.kc-rail-stat strong').first().innerText();
    const edgeCount = await page.locator('.kc-rail-stat strong').nth(1).innerText();
    // Measured inside the page from the input event to the DOM commit of the result count, with a
    // MutationObserver: frame-polling from the test process quantizes to ~16.7 ms, which is the
    // same size as the differences being compared. Accepts every release's status wording.
    const searchMs = await page.evaluate(
      () =>
        new Promise((resolveSearch, rejectSearch) => {
          const input = document.querySelector('input[placeholder="Search code, docs, tables…"]');
          const box = document.querySelector('.kc-search');
          if (!input || !box) {
            rejectSearch(new Error('search box not found'));
            return;
          }
          const done = () => /\d+ (code graph )?match(es)?\b/.test(box.textContent || '');
          const started = performance.now();
          const observer = new MutationObserver(() => {
            if (done()) {
              observer.disconnect();
              resolveSearch(performance.now() - started);
            }
          });
          observer.observe(box, { subtree: true, childList: true, characterData: true });
          const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setValue.call(input, 'test');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }),
    );
    const list = page.getByRole('button', { name: 'List', exact: true });
    let presentationSwitchMs = null;
    if (await list.count()) {
      const switchStart = performance.now();
      await list.click();
      await page.locator('[data-kc-result-list]').waitFor({ timeout: 180_000 });
      presentationSwitchMs = performance.now() - switchStart;
    }
    const renderedResultRows = await page.locator('[data-kc-result-row]').count();
    samples.push({
      pass: pass + 1,
      startupMs,
      searchMs,
      presentationSwitchMs,
      renderedResultRows,
      nodeCount,
      edgeCount,
    });
    await page.close();
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        searchTerm: 'test',
        serverStartupMs,
        samples,
        medianStartupMs: median(samples.map((sample) => sample.startupMs)),
        medianSearchMs: median(samples.map((sample) => sample.searchMs)),
        medianPresentationSwitchMs: median(
          samples.map((sample) => sample.presentationSwitchMs).filter((value) => value !== null),
        ),
        peakRenderedResultRows: Math.max(...samples.map((sample) => sample.renderedResultRows)),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (browser) await browser.close();
  if (server) server.kill('SIGTERM');
  rmSync(privateHome, { recursive: true, force: true });
}
