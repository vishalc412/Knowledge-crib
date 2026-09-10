/**
 * The forked child of the freshness supervisor (WP5.1). The descriptor arrives pre-loaded in
 * `KCRIB_FRESHNESS_TASK` (no IPC round-trip that could race the supervisor's death); the
 * revalidation port is loaded lazily so the supervisor's own module graph never pays for it.
 *
 * The revalidation module: `KCRIB_FRESHNESS_REVALIDATE_MODULE` (a file: URL) when set — the
 * subprocess tests point it at a fixture — and this entry's compiled sibling `cli.js`
 * (`freshnessRevalidate`) otherwise, which is the production port.
 */
import { runFreshnessChildBody } from './freshness-child.js';
import { isPidAlive } from './freshness.js';

runFreshnessChildBody({
  env: process.env,
  isPidAlive,
  loadRevalidate: async () => {
    const url = process.env.KCRIB_FRESHNESS_REVALIDATE_MODULE;
    const mod = url ? await import(url) : await import('./cli.js');
    const fn = (mod as { freshnessRevalidate?: unknown }).freshnessRevalidate;
    if (typeof fn !== 'function') {
      throw new Error('freshness child: revalidation module does not export freshnessRevalidate');
    }
    return fn as (task: import('./freshness.js').FreshnessTask) => Promise<{ generation: string }>;
  },
}).catch((err: unknown) => {
  process.stderr.write(`freshness child failed: ${String(err)}\n`);
  process.exit(1);
});
