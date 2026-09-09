/**
 * Does automatic freshness actually work, end to end, at the default configuration?
 *
 * The audit's finding was that the existing convergence tests call the coordinator directly, and
 * that the one p95 test overrode the fallback interval to 250ms (production is 2000ms) while
 * measuring dirty-path CAPTURE rather than successful adoption. Neither answers the question a user
 * asks: after I save this file, how long until the server ANSWERS with it.
 *
 * So this harness measures the only thing that counts. It launches the built server exactly as a
 * user runs it — `crib serve --http --watch`, production debounce and fallback, nothing overridden —
 * drives real filesystem and Git transitions, and then polls the server's OWN verbs until the
 * change is queryable: the graph query returns the new symbol, FTS finds it, context resolves it,
 * and health reports reader and published generations converged. The clock runs from the source
 * mutation to that moment, not to a bookkeeping event.
 *
 * Everything about the workload is preregistered in scripts/launch-policy.json (transitions, sample
 * count, warmup, the p95 target, failure treatment) and frozen by its hash BEFORE measuring, so the
 * target cannot be retuned after seeing the numbers. A missed transition or a timeout is a failed
 * sample, never a discarded one.
 *
 * Usage: node scripts/freshness-adoption-check.mjs [--out receipts/freshness.json] [--samples N]
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLaunchPolicy } from './launch-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CLI = join(REPO_ROOT, 'packages/cli/dist/cli.js');

function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * The workload fixture: a repository of `fileCount` TypeScript modules with a call chain between
 * them, committed and indexed. Representative of a mid-size service rather than a toy: the overlay
 * has to re-resolve real edges on every transition, which is where the time goes.
 */
function buildFixture(fileCount) {
  const root = mkdtempSync(join(tmpdir(), 'crib-freshness-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const next = (i + 1) % fileCount;
    writeFileSync(
      join(root, 'src', `mod${i}.ts`),
      `import { fn${next} } from './mod${next}.js';\n` +
        `/** Module ${i} of the freshness workload. */\n` +
        `export function fn${i}(depth: number): number {\n` +
        `  return depth <= 0 ? ${i} : fn${next}(depth - 1);\n` +
        `}\n`,
    );
  }
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'freshness-workload', private: true, type: 'module' }, null, 2)}\n`,
  );
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'freshness@example.invalid']);
  git(root, ['config', 'user.name', 'freshness harness']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'workload base']);
  execFileSync(process.execPath, [CLI, 'index', root], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return root;
}

/** Start the REAL server the way a user does: watch mode, production defaults, nothing overridden. */
async function startServer(root) {
  const child = spawn(process.execPath, [CLI, 'serve', root, '--http', '--watch'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(
      () => reject(new Error('server did not report a port within 60s')),
      60_000,
    );
    let buffered = '';
    child.stderr.on('data', (chunk) => {
      buffered += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}): ${buffered.slice(-500)}`));
    });
  });
  return { child, port };
}

let requestId = 0;
async function call(port, name, args) {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // The MCP HTTP transport refuses a client that does not declare both.
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++requestId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await response.json();
  const text = body?.result?.content?.[0]?.text;
  if (text === undefined) return body?.result ?? body;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Does a hit list contain THIS symbol — matched on the id, not on a substring of a name. */
function hitsSymbol(result, probe) {
  // `query` answers with `hits`; `brief` answers with `codeHits` — both are checked so a shape
  // change surfaces as a missing hit rather than a silently-always-false reader.
  const hits = [...(result?.hits ?? []), ...(result?.codeHits ?? []), ...(result?.llmHits ?? [])];
  return hits.some((hit) => typeof hit?.id === 'string' && hit.id.includes(`#${probe}@`));
}

/**
 * One transition's adoption latency: mutate, then poll the server's OWN verbs until every reader
 * agrees — graph query, FTS/brief search, symbol resolution through context, and health reporting
 * converged generations with no staleness. `present` says whether the probe symbol should appear or
 * disappear, so a delete is measured on the same clock as a save.
 *
 * A partial agreement never stops the clock: a graph hit whose context still misses is a
 * half-adopted bundle, which is precisely the state this harness exists to catch.
 */
async function measure(port, { mutate, probe, present, timeoutMs }) {
  const started = performance.now();
  await mutate();
  // How much of the elapsed time was the MUTATION itself (an external `crib index` run, a git
  // rebase) rather than crib's adoption of it. Reported alongside — never subtracted from — the
  // frozen clock, so the preregistered number stays the number and the diagnosis is still visible.
  const mutationMs = performance.now() - started;
  const deadline = started + timeoutMs;
  for (;;) {
    const [query, brief, context, health] = await Promise.all([
      call(port, 'query', { q: probe }),
      call(port, 'brief', { q: probe }),
      call(port, 'context', { id: probe }),
      call(port, 'status', { op: 'health' }),
    ]);
    const freshness = health?.readerFreshness ?? {};
    const converged =
      freshness.publishedGeneration == null ||
      freshness.publishedGeneration === freshness.readerGeneration;
    const readers = {
      query: hitsSymbol(query, probe),
      brief: hitsSymbol(brief, probe),
      context: context?.node?.name === probe,
    };
    if (
      Object.values(readers).every((agrees) => agrees === present) &&
      converged &&
      freshness.stale !== true
    ) {
      return { ms: performance.now() - started, mutationMs, timedOut: false };
    }
    if (performance.now() > deadline) {
      return {
        ms: performance.now() - started,
        mutationMs,
        timedOut: true,
        readers,
        converged,
        stale: freshness.stale === true,
        staleReasons: freshness.staleReasons ?? [],
      };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

async function main() {
  const argv = process.argv.slice(2);
  const { policy, sha256: policySha256 } = loadLaunchPolicy();
  const spec = policy.freshness;
  const samples = Number(flag(argv, '--samples', String(spec.samplesPerTransition)));
  const warmup = Number(flag(argv, '--warmup', String(spec.warmupSamples)));
  const fileCount = Number(flag(argv, '--files', String(spec.files ?? 120)));
  const timeoutMs = Number(flag(argv, '--timeout-ms', '30000'));
  const out = resolve(flag(argv, '--out', 'receipts/freshness.json'));

  const root = buildFixture(fileCount);
  const { child, port } = await startServer(root);
  const perTransition = {};
  const failures = [];
  let counter = 0;

  const transitions = {
    save: async () => {
      const name = `saved${counter}`;
      return {
        probe: name,
        present: true,
        mutate: async () => {
          writeFileSync(
            join(root, 'src', `saved.ts`),
            `export function ${name}(): number { return ${counter}; }\n`,
          );
        },
      };
    },
    rename: async () => {
      const name = `renamed${counter}`;
      writeFileSync(
        join(root, 'src', 'before-rename.ts'),
        `export function ${name}(): number { return 0; }\n`,
      );
      await settle(port, name, true, timeoutMs);
      return {
        probe: name,
        present: true,
        mutate: async () => {
          execFileSync('mv', [
            join(root, 'src', 'before-rename.ts'),
            join(root, 'src', `after-rename${counter}.ts`),
          ]);
        },
      };
    },
    delete: async () => {
      const name = `doomed${counter}`;
      const file = join(root, 'src', `doomed${counter}.ts`);
      writeFileSync(file, `export function ${name}(): number { return 0; }\n`);
      await settle(port, name, true, timeoutMs);
      return { probe: name, present: false, mutate: async () => rmSync(file, { force: true }) };
    },
    'clean-checkout': async () => {
      const name = `branched${counter}`;
      git(root, ['checkout', '-q', '-b', `feature-${counter}`]);
      writeFileSync(
        join(root, 'src', `branched${counter}.ts`),
        `export function ${name}(): number { return 0; }\n`,
      );
      git(root, ['add', '-A']);
      git(root, ['commit', '-qm', `branch ${counter}`]);
      git(root, ['checkout', '-q', '-']);
      return {
        probe: name,
        present: true,
        mutate: async () => git(root, ['checkout', '-q', `feature-${counter}`]),
      };
    },
    merge: async () => {
      const name = `merged${counter}`;
      const base = git(root, ['branch', '--show-current']);
      git(root, ['checkout', '-q', '-b', `merge-src-${counter}`]);
      writeFileSync(
        join(root, 'src', `merged${counter}.ts`),
        `export function ${name}(): number { return 0; }\n`,
      );
      git(root, ['add', '-A']);
      git(root, ['commit', '-qm', `merge source ${counter}`]);
      git(root, ['checkout', '-q', base]);
      return {
        probe: name,
        present: true,
        mutate: async () => git(root, ['merge', '-q', '--no-edit', `merge-src-${counter}`]),
      };
    },
    rebase: async () => {
      const name = `rebased${counter}`;
      const base = git(root, ['branch', '--show-current']);
      git(root, ['checkout', '-q', '-b', `rebase-src-${counter}`]);
      writeFileSync(
        join(root, 'src', `rebased${counter}.ts`),
        `export function ${name}(): number { return 0; }\n`,
      );
      git(root, ['add', '-A']);
      git(root, ['commit', '-qm', `rebase source ${counter}`]);
      git(root, ['checkout', '-q', base]);
      writeFileSync(
        join(root, 'src', `base-move${counter}.ts`),
        `export const baseMove${counter} = ${counter};\n`,
      );
      git(root, ['add', '-A']);
      git(root, ['commit', '-qm', `base move ${counter}`]);
      return {
        probe: name,
        present: true,
        mutate: async () => {
          git(root, ['checkout', '-q', `rebase-src-${counter}`]);
          git(root, ['rebase', '-q', base]);
          git(root, ['checkout', '-q', base]);
          git(root, ['merge', '-q', '--no-edit', `rebase-src-${counter}`]);
        },
      };
    },
    'external-update': async () => {
      const name = `external${counter}`;
      return {
        probe: name,
        present: true,
        mutate: async () => {
          writeFileSync(
            join(root, 'src', `external${counter}.ts`),
            `export function ${name}(): number { return 0; }\n`,
          );
          git(root, ['add', '-A']);
          git(root, ['commit', '-qm', `external ${counter}`]);
          // Another process re-indexes the canonical graph underneath the running server.
          execFileSync(process.execPath, [CLI, 'index', root], {
            stdio: ['ignore', 'ignore', 'pipe'],
          });
        },
      };
    },
  };

  /** Wait for a symbol to reach (or leave) the served graph — setup, not measurement. */
  async function settle(p, probe, present, timeout) {
    await measure(p, { mutate: async () => {}, probe, present, timeoutMs: timeout });
  }

  try {
    for (const transition of spec.transitions) {
      if (transition === 'restart') continue; // handled separately below (it restarts the server)
      const factory = transitions[transition];
      if (!factory) {
        failures.push({ transition, reason: 'no-driver' });
        continue;
      }
      const durations = [];
      for (let i = 0; i < warmup + samples; i++) {
        counter++;
        const plan = await factory();
        const result = await measure(port, { ...plan, timeoutMs });
        if (result.timedOut) {
          failures.push({
            transition,
            sample: i,
            reason: 'timeout',
            ms: Number(result.ms.toFixed(1)),
            readers: result.readers,
            converged: result.converged,
            staleReasons: result.staleReasons,
          });
        }
        // A timeout is a FAILED sample, not a discarded one: its (capped) latency stays in the set.
        if (i >= warmup) durations.push({ ms: result.ms, mutationMs: result.mutationMs ?? 0 });
      }
      perTransition[transition] = durations;
    }

    // Restart: the server process goes away and comes back; the clock runs from the mutation made
    // while it was down to the moment the restarted server answers with it.
    if (spec.transitions.includes('restart')) {
      const durations = [];
      let restartPort = port;
      let restartChild = child;
      for (let i = 0; i < warmup + samples; i++) {
        counter++;
        const name = `restarted${counter}`;
        restartChild.kill('SIGTERM');
        await new Promise((r) => restartChild.once('exit', r));
        const started = performance.now();
        writeFileSync(
          join(root, 'src', `restarted${counter}.ts`),
          `export function ${name}(): number { return 0; }\n`,
        );
        const next = await startServer(root);
        restartChild = next.child;
        restartPort = next.port;
        const result = await measure(restartPort, {
          mutate: async () => {},
          probe: name,
          present: true,
          timeoutMs,
        });
        const total = performance.now() - started;
        if (result.timedOut)
          failures.push({ transition: 'restart', sample: i, reason: 'timeout', ms: total });
        if (i >= warmup) durations.push({ ms: total, mutationMs: total - result.ms });
      }
      perTransition.restart = durations;
      restartChild.kill('SIGTERM');
    } else {
      child.kill('SIGTERM');
    }

    const rows = Object.values(perTransition).flat();
    const all = rows.map((r) => r.ms);
    // The same samples with the mutation's own runtime removed: what the SERVER contributed.
    const adoptionOnly = rows.map((r) => Math.max(r.ms - r.mutationMs, 0));
    const p95 = percentile(all, 95);
    const receipt = {
      format: 'knowledge-crib-acceptance-receipt',
      formatVersion: 1,
      type: 'freshness',
      status: failures.length === 0 && p95 <= spec.p95TargetMs ? 'pass' : 'fail',
      recordedAt: new Date().toISOString(),
      candidateCommit: git(REPO_ROOT, ['rev-parse', 'HEAD']),
      policySha256,
      workload: spec.workload,
      command: `node scripts/freshness-adoption-check.mjs ${argv.join(' ')}`.trim(),
      configuration: {
        watch: 'production defaults (no debounce or fallback override)',
        files: fileCount,
        samplesPerTransition: samples,
        warmupSamples: warmup,
        timeoutMs,
      },
      platform: { os: process.platform, arch: process.arch, node: process.version },
      machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, ramBytes: totalmem() },
      p95Ms: Number(p95.toFixed(1)),
      p50Ms: Number(percentile(all, 50).toFixed(1)),
      maxMs: Number(percentile(all, 100).toFixed(1)),
      // DIAGNOSTIC ONLY — the verdict above uses the frozen clock. This says how much of the
      // measured time the server was responsible for, which is what an optimization would move.
      adoptionOnlyP95Ms: Number(percentile(adoptionOnly, 95).toFixed(1)),
      mutationP95Ms: Number(
        percentile(
          rows.map((r) => r.mutationMs),
          95,
        ).toFixed(1),
      ),
      targetMs: spec.p95TargetMs,
      samples: all.length,
      failures,
      perTransition: Object.fromEntries(
        Object.entries(perTransition).map(([name, values]) => [
          name,
          {
            samples: values.length,
            p95Ms: Number(
              percentile(
                values.map((v) => v.ms),
                95,
              ).toFixed(1),
            ),
            adoptionOnlyP95Ms: Number(
              percentile(
                values.map((v) => Math.max(v.ms - v.mutationMs, 0)),
                95,
              ).toFixed(1),
            ),
            mutationP95Ms: Number(
              percentile(
                values.map((v) => v.mutationMs),
                95,
              ).toFixed(1),
            ),
            rawMs: values.map((v) => Number(v.ms.toFixed(1))),
          },
        ]),
      ),
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(
      `freshness ${receipt.status.toUpperCase()} — p95 ${receipt.p95Ms}ms against a ${spec.p95TargetMs}ms target ` +
        `over ${receipt.samples} samples, ${failures.length} failed transitions -> ${out}\n`,
    );
    for (const [name, data] of Object.entries(receipt.perTransition)) {
      process.stdout.write(
        `  ${name.padEnd(16)} p95 ${String(data.p95Ms).padStart(8)}ms  ` +
          `(adoption ${String(data.adoptionOnlyP95Ms).padStart(7)}ms + mutation ${String(data.mutationP95Ms).padStart(7)}ms, ${data.samples} samples)\n`,
      );
    }
    if (receipt.status !== 'pass') process.exitCode = 1;
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
