/**
 * W7 — external enrichment provider execution (PRD line 383).
 *
 * `crib enrich run --provider <name>` drives the SAME deterministic work queue (`enrich_next`) as the
 * MCP host-agent path, but hands each work item to an external program configured in user-owned
 * `~/.crib/providers.json` instead of the IDE's selected agent model. The MCP path stays the
 * provider-free default (PRD line 390); this is the headless/CI automation path.
 *
 * Hardened per the PRD + the global security rules:
 *   • Provider definitions come ONLY from `~/.crib/providers.json` (user-owned, never the repo) — a
 *     committed file could smuggle an arbitrary `command`, so the repo is never a source.
 *   • Programs are executed with `shell:false` — no shell interpolation of the work-item payload, so
 *     a model-authored `purpose`/`quote` string can never become a shell command.
 *   • Strict JSON over stdin/stdout: the whole stdout buffer must parse as one JSON object. No
 *     trailing-text leniency, no `eval`, no `Function`. A malformed response is a per-item failure,
 *     not a crash.
 *   • Concurrency defaults to 1, hard-clamped to 4 (PRD line 387).
 *   • A per-item timeout kills the child so a hung provider cannot stall the run.
 *   • Provider failure is NON-fatal to the queue: a failed item is simply not saved, so its target
 *     stays pending and is re-offered next run (PRD exit gate line 392: "provider failure leaves
 *     work pending and resumable"). Grounding/secret validation still runs in `enrich.save()` — a
 *     provider that returns garbage is rejected there, identical to the MCP path.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EnrichSaveItem, EnrichWorkItem } from '@knowledge-crib/mcp';

/** A single provider definition in `~/.crib/providers.json`. */
export interface ProviderDef {
  /** The program + its fixed leading args, run with `shell:false`. e.g. `["node","/abs/agent.js"]`.
   *  Must be non-empty; the first element is the executable. */
  command: string[];
  /** Extra args appended to every invocation (after `command`). */
  args?: string[];
  /** Extra env vars merged over `process.env` for the child. */
  env?: Record<string, string>;
  /** Parallel items per batch. Default 1, hard-clamped to 4 (PRD line 387). */
  concurrency?: number;
  /** Per-item timeout in ms; the child is killed if it exceeds this. Default 120_000. */
  timeoutMs?: number;
}

/** The shape of `~/.crib/providers.json`. */
export interface ProvidersFile {
  providers: Record<string, ProviderDef>;
}

/** Per-item provider outcome — either a parsed save item or a recorded failure. Generic over the
 *  validated response so an alternative contract (the G2.3 distill decision) can ride the SAME
 *  spawn/timeout/concurrency plumbing without forking it. */
export type ProviderItemOutcome<T = EnrichSaveItem> =
  | { ok: true; targetId: string; item: T }
  | { ok: false; targetId: string; reason: string };

export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
export const MAX_PROVIDER_CONCURRENCY = 4;

/** Resolve the providers file path. `override` is used for tests so they never touch the real
 *  `~/.crib/providers.json`. */
export function providersPath(override?: string): string {
  return override ?? join(homedir(), '.crib', 'providers.json');
}

/**
 * Load + structurally validate `~/.crib/providers.json`. Throws a readable error on a malformed file
 * (bad JSON, missing `providers` map, or a provider without a non-empty string[] `command`). Returns
 * `{ providers: {} }` when the file is absent — calling `resolveProvider` then errors with guidance.
 */
export function loadProviders(pathOverride?: string): {
  providers: Record<string, ProviderDef>;
  path: string;
} {
  const path = providersPath(pathOverride);
  if (!existsSync(path)) return { providers: {}, path };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`could not read providers file ${path}: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  const file = json as Partial<ProvidersFile>;
  const providers = file?.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new Error(
      `${path} must be { "providers": { "<name>": { "command": ["prog","arg"], ... } } }`,
    );
  }
  for (const [name, def] of Object.entries(providers)) {
    if (
      !def ||
      !Array.isArray(def.command) ||
      def.command.length === 0 ||
      def.command.some((s) => typeof s !== 'string')
    ) {
      throw new Error(
        `provider "${name}" in ${path} must have a non-empty string[] "command" (run with shell:false)`,
      );
    }
  }
  return { providers, path };
}

/** Look up a named provider, throwing a guidance error when absent or the file is missing. */
export function resolveProvider(
  name: string,
  pathOverride?: string,
): {
  def: ProviderDef;
  path: string;
} {
  const { providers, path } = loadProviders(pathOverride);
  const def = providers[name];
  if (!def) {
    const available = Object.keys(providers).sort();
    const hint =
      available.length > 0
        ? ` (available: ${available.join(', ')})`
        : ' — define one as { "providers": { "name": { "command": ["prog"] } } }';
    throw new Error(`no provider named "${name}" in ${path}${hint}`);
  }
  return { def, path };
}

/** Effective concurrency: default 1, clamped to [1, MAX_PROVIDER_CONCURRENCY]. */
export function providerConcurrency(def: ProviderDef): number {
  const c = def.concurrency ?? 1;
  if (!Number.isInteger(c) || c < 1) return 1;
  return Math.min(c, MAX_PROVIDER_CONCURRENCY);
}

/** Validate the minimal EnrichSaveItem shape a provider must return. Full grounding/secret/endpoint
 *  validation runs in `EnrichmentStore.save()` — this only enforces the contract a provider can be
 *  expected to honor: a JSON object echoing the targetId with an `analysis` object, a `graph` of
 *  nodes/edges arrays, and an `evidence` array. Throws on mismatch. */
export function validateSaveItemShape(parsed: unknown, expectedTargetId: string): EnrichSaveItem {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderItemError(expectedTargetId, 'provider stdout is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const targetId = typeof obj.targetId === 'string' ? obj.targetId : '';
  if (!targetId) {
    throw new ProviderItemError(expectedTargetId, 'provider response missing string "targetId"');
  }
  if (targetId !== expectedTargetId) {
    throw new ProviderItemError(
      expectedTargetId,
      `provider response targetId "${targetId}" does not match the work item "${expectedTargetId}"`,
    );
  }
  if (!obj.analysis || typeof obj.analysis !== 'object' || Array.isArray(obj.analysis)) {
    throw new ProviderItemError(expectedTargetId, 'provider response "analysis" must be an object');
  }
  const graph = obj.graph;
  if (
    !graph ||
    typeof graph !== 'object' ||
    Array.isArray(graph) ||
    !Array.isArray((graph as Record<string, unknown>).nodes) ||
    !Array.isArray((graph as Record<string, unknown>).edges)
  ) {
    throw new ProviderItemError(
      expectedTargetId,
      'provider response "graph" must be { nodes: [], edges: [] }',
    );
  }
  if (!Array.isArray(obj.evidence)) {
    throw new ProviderItemError(expectedTargetId, 'provider response "evidence" must be an array');
  }
  return {
    targetId,
    ...(typeof obj.model === 'string' ? { model: obj.model } : {}),
    analysis: obj.analysis as EnrichSaveItem['analysis'],
    graph: obj.graph as EnrichSaveItem['graph'],
    evidence: obj.evidence as EnrichSaveItem['evidence'],
  };
}

/** A thrown per-item failure — caught and recorded as a non-ok outcome so the queue keeps going. */
export class ProviderItemError extends Error {
  constructor(
    readonly targetId: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'ProviderItemError';
  }
}

/** Options for {@link runProviderOnce}. `validate` swaps the response contract: the default keeps
 *  the strict {@link EnrichSaveItem} shape; the G2.3 distill loop passes a verifier for its
 *  decision envelope instead. Spawn/timeout/JSON rules are untouched either way. */
export interface RunProviderOnceOpts<T = EnrichSaveItem> {
  timeoutMs?: number;
  /** Validate + shape the parsed stdout for this work item. Throws on any contract violation. */
  validate?: (parsed: unknown, expectedTargetId: string) => T;
}

/**
 * Run ONE work item through the provider: spawn with `shell:false`, write the work-item JSON to
 * stdin, collect stdout, and strict-JSON-parse it. Resolves to a validated response (by default a
 * {@link EnrichSaveItem}; a custom `validate` may return any shape it vouches for); rejects with a
 * {@link ProviderItemError} on any failure (non-zero exit, timeout, bad JSON, shape mismatch).
 * Never throws a non-ProviderItemError — callers treat any throw as a per-item failure.
 */
export function runProviderOnce<T = EnrichSaveItem>(
  def: ProviderDef,
  workItem: EnrichWorkItem,
  opts: RunProviderOnceOpts<T> = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? def.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  // The default validator keeps the historical EnrichSaveItem contract; the generic anchor makes a
  // custom validator type-safe without touching the spawn path below.
  const validate = (opts.validate ?? validateSaveItemShape) as (
    parsed: unknown,
    expectedTargetId: string,
  ) => T;
  const cmd = def.command;
  if (cmd.length === 0 || cmd.some((s) => typeof s !== 'string')) {
    return Promise.reject(new ProviderItemError(workItem.targetId, 'provider command is empty'));
  }
  const program = cmd[0] as string;
  const args = [...cmd.slice(1), ...(def.args ?? [])];
  const env = def.env ? { ...process.env, ...def.env } : process.env;
  const stdin = JSON.stringify(workItem);
  return new Promise<T>((resolve, reject) => {
    const child = spawn(program, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (err: ProviderItemError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore — child may already be gone */
      }
      fail(new ProviderItemError(workItem.targetId, `provider timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      // spawn error (ENOENT etc.) — provider not installed / wrong path.
      fail(
        new ProviderItemError(
          workItem.targetId,
          `failed to spawn provider "${program}": ${err.message}`,
        ),
      );
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().slice(-2000);
        reject(
          new ProviderItemError(
            workItem.targetId,
            `provider exited with code ${code}${tail ? `\nstderr: ${tail}` : ''}`,
          ),
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        const tail = stderr.trim().slice(-2000);
        reject(
          new ProviderItemError(
            workItem.targetId,
            `provider stdout is not strict JSON: ${(e as Error).message}${tail ? `\nstderr: ${tail}` : ''}`,
          ),
        );
        return;
      }
      try {
        resolve(validate(parsed, workItem.targetId));
      } catch (e) {
        reject(e instanceof Error ? e : new ProviderItemError(workItem.targetId, String(e)));
      }
    });

    // Write the work item to stdin; end the stream so the provider can read-to-EOF.
    try {
      child.stdin?.write(stdin);
      child.stdin?.end();
    } catch {
      /* ignore — a missing stdin pipe is surfaced as a non-zero exit / timeout */
    }
  });
}

/**
 * Run a batch of work items through `def` with bounded concurrency (default 1, max 4). Each item's
 * outcome is recorded independently — a failure never aborts the batch (PRD exit gate line 392).
 * Returns the outcomes in the SAME order as `items` so callers can correlate them.
 */
export async function runProviderBatch<T = EnrichSaveItem>(
  def: ProviderDef,
  items: EnrichWorkItem[],
  opts: {
    timeoutMs?: number;
    concurrencyOverride?: number;
    /** Passed through to every {@link runProviderOnce} call (the response contract). */
    validate?: (parsed: unknown, expectedTargetId: string) => T;
  } = {},
): Promise<ProviderItemOutcome<T>[]> {
  const concurrency = opts.concurrencyOverride ?? providerConcurrency(def);
  const timeoutMs = opts.timeoutMs;
  const results: ProviderItemOutcome<T>[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i] as EnrichWorkItem;
      try {
        const saveItem = await runProviderOnce<T>(
          def,
          item,
          opts.validate !== undefined || timeoutMs !== undefined
            ? {
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(opts.validate !== undefined ? { validate: opts.validate } : {}),
              }
            : {},
        );
        results[i] = { ok: true, targetId: item.targetId, item: saveItem };
      } catch (e) {
        const reason =
          e instanceof ProviderItemError ? e.message : `provider error: ${(e as Error).message}`;
        results[i] = { ok: false, targetId: item.targetId, reason };
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
