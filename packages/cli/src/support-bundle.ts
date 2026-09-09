/**
 * The diagnostics snapshot and the redacted support bundle.
 *
 * Two separate jobs, deliberately in one bounded module rather than grown into `cli.ts`:
 *
 *  1. {@link collectDiagnostics} answers "what state is this installation actually in" — refresh and
 *     adoption, retries and dead letters, model readiness, the last classified error, adapter
 *     command health. It keeps UNAVAILABLE distinct from ABSENT everywhere: "the worker is not
 *     running" and "we could not read whether the worker is running" lead to different repairs, and
 *     collapsing them is how a diagnostic starts lying.
 *
 *  2. {@link buildSupportBundle} turns that snapshot into something a user can safely SEND. The rule
 *     is an allowlist, not a denylist: a field reaches the bundle because it was named here, so a
 *     new field added upstream is excluded by default instead of leaking by default. Memory claims,
 *     prompts, credentials, environment dumps and personal absolute paths are never members, and
 *     the paths that do appear are relativized (`~/…`, `<repo>/…`) so a bundle does not disclose a
 *     user's name or directory layout.
 *
 * Redaction is verified by planting sentinel secrets in every source and asserting no bundle member
 * contains them — a test that fails loudly when a new field starts carrying user content.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** A value that is deliberately not present, distinguished from one we could not read. */
export type Availability = 'present' | 'absent' | 'unavailable';

export interface DiagnosticValue<T> {
  availability: Availability;
  value?: T;
  /** Why the value is unavailable — the classified reason, never a raw stack. */
  reason?: string;
}

export interface RefreshDiagnostics {
  mode: DiagnosticValue<string>;
  workerRunning: DiagnosticValue<boolean>;
  pending: DiagnosticValue<number>;
  deadLettered: DiagnosticValue<number>;
  behindHead: DiagnosticValue<boolean>;
  /** Reader/published generation identity — the adoption state, not merely "a refresh happened". */
  readerGeneration: DiagnosticValue<string>;
  publishedGeneration: DiagnosticValue<string>;
  stale: DiagnosticValue<boolean>;
  staleReasons: DiagnosticValue<string[]>;
}

export interface ModelDiagnostics {
  state: DiagnosticValue<string>;
  modelId: DiagnosticValue<string>;
  modelVersion: DiagnosticValue<string>;
}

export interface AdapterDiagnostic {
  ide: string;
  scope: string;
  /** Relativized — a config path is a filesystem fact about the USER, not about the product. */
  configPath: string;
  problem?: string;
  kind?: string;
}

export interface Diagnostics {
  refresh: RefreshDiagnostics;
  model: ModelDiagnostics;
  adapters: DiagnosticValue<AdapterDiagnostic[]>;
  /** The last refresh error, already classified by the coordinator (code + message, no stack). */
  lastError: DiagnosticValue<{ code: string; message: string; occurredAt: string }>;
}

/** Sources the collector reads. Injected so the module stays testable without a live installation. */
export interface DiagnosticsSources {
  freshnessStatus?: () => {
    mode: string;
    workerRunning: boolean;
    pending: number;
    dead: number;
    behindHead: boolean;
  };
  readerFreshness?: () => {
    readerGeneration: string | null;
    publishedGeneration: string | null;
    stale: boolean;
    staleReasons: string[];
    lastRefreshError: { code: string; message: string; occurredAt: string } | null;
  };
  embedder?: () => { state: string; modelId?: string; modelVersion?: string };
  adapters?: () => Array<{
    ide: string;
    scope: string;
    configPath: string;
    message?: string;
    kind?: string;
  }>;
}

const present = <T>(value: T): DiagnosticValue<T> => ({ availability: 'present', value });
const absent = (reason: string): DiagnosticValue<never> => ({ availability: 'absent', reason });
const unavailable = (reason: string): DiagnosticValue<never> => ({
  availability: 'unavailable',
  reason,
});

/** Run one source, turning a throw into `unavailable` rather than losing the whole snapshot. */
function attempt<T>(
  source: (() => T) | undefined,
  map: (value: T) => DiagnosticValue<unknown>,
): DiagnosticValue<unknown> {
  if (!source) return absent('not configured in this environment');
  try {
    return map(source());
  } catch (error) {
    return unavailable(classify(error));
  }
}

/** A short, non-identifying classification of a failure — never a stack, never a path. */
export function classify(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code;
  if (code === 'ENOENT') return 'not found (ENOENT)';
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'ETIMEDOUT') return 'timed out';
  return redactSecrets(redactPaths(message)).slice(0, 200);
}

export function collectDiagnostics(
  repoRoot: string,
  sources: DiagnosticsSources = {},
): Diagnostics {
  const freshness = attempt(sources.freshnessStatus, present) as DiagnosticValue<{
    mode: string;
    workerRunning: boolean;
    pending: number;
    dead: number;
    behindHead: boolean;
  }>;
  const reader = attempt(sources.readerFreshness, present) as DiagnosticValue<{
    readerGeneration: string | null;
    publishedGeneration: string | null;
    stale: boolean;
    staleReasons: string[];
    lastRefreshError: { code: string; message: string; occurredAt: string } | null;
  }>;
  const embedder = attempt(sources.embedder, present) as DiagnosticValue<{
    state: string;
    modelId?: string;
    modelVersion?: string;
  }>;

  /** Lift one field out of a source that may itself be absent/unavailable. */
  const field = <S, T>(
    source: DiagnosticValue<S>,
    pick: (value: S) => T | null | undefined,
    missing: string,
  ): DiagnosticValue<T> => {
    // A source that is absent or unavailable propagates its own availability + reason to every
    // field derived from it: one unreadable source must not read as nine absent values.
    if (source.availability !== 'present')
      return {
        availability: source.availability,
        ...(source.reason ? { reason: source.reason } : {}),
      };
    const value = pick(source.value as S);
    return value === null || value === undefined ? absent(missing) : present(value);
  };

  return {
    refresh: {
      mode: field(freshness, (f) => f.mode, 'no freshness mode recorded'),
      workerRunning: field(freshness, (f) => f.workerRunning, 'worker state unknown'),
      pending: field(freshness, (f) => f.pending, 'queue depth unknown'),
      deadLettered: field(freshness, (f) => f.dead, 'dead-letter count unknown'),
      behindHead: field(freshness, (f) => f.behindHead, 'head comparison unknown'),
      readerGeneration: field(reader, (r) => r.readerGeneration, 'no bundle is being served'),
      publishedGeneration: field(reader, (r) => r.publishedGeneration, 'nothing published yet'),
      stale: field(reader, (r) => r.stale, 'staleness unknown'),
      staleReasons: field(reader, (r) => r.staleReasons, 'no reasons recorded'),
    },
    model: {
      state: field(embedder, (e) => e.state, 'no semantic model installed'),
      modelId: field(embedder, (e) => e.modelId, 'no model id recorded'),
      modelVersion: field(embedder, (e) => e.modelVersion, 'no model revision recorded'),
    },
    adapters: attempt(sources.adapters, (list) =>
      present(
        list.map((entry) => ({
          ide: entry.ide,
          scope: entry.scope,
          configPath: redactPaths(entry.configPath, repoRoot),
          ...(entry.message ? { problem: redactPaths(entry.message, repoRoot) } : {}),
          ...(entry.kind ? { kind: entry.kind } : {}),
        })),
      ),
    ) as DiagnosticValue<AdapterDiagnostic[]>,
    lastError: field(reader, (r) => r.lastRefreshError, 'no refresh has failed'),
  };
}

/**
 * Replace personal absolute paths with stable placeholders. A support bundle should say WHICH
 * config is broken, not where the user keeps their files or what their account is called.
 */
export function redactPaths(text: string, repoRoot?: string, home = homedir()): string {
  let out = text;
  if (repoRoot) {
    const abs = resolve(repoRoot);
    out = out.split(abs).join('<repo>');
  }
  if (home) out = out.split(home).join('~');
  // ANY user's home, not just this process's. Running the real command surfaced the gap: a home
  // like `/Users/jöhn doe/…` survived the generic path rule below, because that rule stops at
  // whitespace and a directory name may contain spaces — leaking exactly the segment (the person's
  // name) that redaction exists to remove. A home root is therefore matched structurally, taking
  // one whole path segment however it is spelled.
  out = out
    .replace(/(?:\/Users|\/home|\/var\/root)\/[^/\\\n]+/g, '<home>')
    .replace(/[A-Za-z]:\\Users\\[^\\\n]+/g, '<home>');
  // Any remaining absolute path outside those roots keeps only its last two segments, which is
  // enough to identify a file without disclosing the tree above it.
  // The lookbehind keeps this rule off the TAIL of a path already replaced above: once a path
  // starts with <home>, <repo> or ~, what follows is no longer personally identifying and is worth
  // keeping readable ("which binary", "which config").
  out = out.replace(/(?<![>~])(?:\/[^\s/:"']+){3,}/g, (match) => {
    const parts = match.split('/').filter(Boolean);
    return `<path>/${parts.slice(-2).join('/')}`;
  });
  return out;
}

/** Token-shaped values are removed wholesale — a support bundle never carries a credential. */
export function redactSecrets(text: string): string {
  return (
    text
      // key=value / key: value for anything named like a secret
      .replace(
        /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|credential)[A-Za-z0-9_.-]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
        '$1=<redacted>',
      )
      // bearer tokens and common provider key shapes
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <redacted>')
      .replace(/\b(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g, '<redacted>')
      // private key blocks
      .replace(
        /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
        '<redacted>',
      )
  );
}

export interface SupportBundle {
  format: 'knowledge-crib-support-bundle';
  formatVersion: 1;
  generatedAt: string;
  product: { version: string; node: string; platform: string; arch: string };
  diagnostics: Diagnostics;
  /** What was deliberately left out, so a reader knows the omission was a decision. */
  excluded: string[];
}

export interface SupportBundleOptions {
  repoRoot: string;
  version: string;
  now?: string;
  sources?: DiagnosticsSources;
}

/**
 * The bundle a user can attach to a bug report.
 *
 * ALLOWLIST: only the fields named below are emitted. Memory claims, prompts, queries, file
 * contents, environment variables and credentials have no path into this structure — not because
 * they are stripped afterwards, but because nothing copies them in.
 */
export function buildSupportBundle(options: SupportBundleOptions): SupportBundle {
  const diagnostics = collectDiagnostics(options.repoRoot, options.sources ?? {});
  return {
    format: 'knowledge-crib-support-bundle',
    formatVersion: 1,
    generatedAt: options.now ?? new Date().toISOString(),
    product: {
      version: options.version,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    diagnostics: sanitize(withoutRawErrorText(diagnostics), options.repoRoot) as Diagnostics,
    excluded: [
      'memory records and claims',
      'prompts, queries and model input or output',
      'source file contents',
      'environment variables',
      'credentials, tokens and keys',
      'absolute user paths (replaced with ~ and <repo>)',
      'raw error text (replaced with a code, a timestamp and a digest)',
    ],
  };
}

/**
 * Drop the one field that can carry ARBITRARY third-party text.
 *
 * A refresh error's message is whatever threw: a parser echoing a source line, an embedder echoing
 * a prompt, a store echoing a memory claim. Redaction can remove shapes it recognizes (paths,
 * tokens) but it cannot recognize "this sentence is the user's private data" — the sentinel sweep
 * in the tests proved exactly that. So the message does not leave the machine at all. What travels
 * is the classified code, when it happened, and a digest, which is enough to recognize the same
 * failure across reports and to ask the user to read the local message that `crib doctor` prints.
 */
const KNOWN_FRESHNESS_MODES = ['manual', 'hook', 'watch', 'service'];
const KNOWN_MODEL_STATES = ['installed', 'missing', 'invalid'];

/** Constrain an enum-shaped field to values the product itself defines. A field that is supposed
 *  to hold one of four words must not become a channel for whatever string a source produced. */
function knownValue(field: DiagnosticValue<string>, allowed: string[]): DiagnosticValue<string> {
  if (field.availability !== 'present' || typeof field.value !== 'string') return field;
  return allowed.includes(field.value)
    ? field
    : { availability: 'present', value: '<unrecognized>', reason: 'value outside the known set' };
}

function withoutRawErrorText(diagnostics: Diagnostics): Diagnostics {
  const narrowed: Diagnostics = {
    ...diagnostics,
    refresh: {
      ...diagnostics.refresh,
      mode: knownValue(diagnostics.refresh.mode, KNOWN_FRESHNESS_MODES),
    },
    model: {
      ...diagnostics.model,
      state: knownValue(diagnostics.model.state, KNOWN_MODEL_STATES),
    },
  };
  diagnostics = narrowed;
  const lastError = diagnostics.lastError;
  if (lastError.availability !== 'present' || !lastError.value) return diagnostics;
  const { code, occurredAt, message } = lastError.value;
  return {
    ...diagnostics,
    lastError: {
      availability: 'present',
      value: {
        code,
        occurredAt,
        // Deliberately not the message: see above.
        message: `<withheld: ${message.length} chars, sha256:${sha256Hex(message).slice(0, 16)}>`,
      },
    },
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Final pass over every string in the structure: paths relativized, secret shapes removed. */
function sanitize(value: unknown, repoRoot: string): unknown {
  if (typeof value === 'string') return redactSecrets(redactPaths(value, repoRoot));
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, repoRoot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sanitize(entry, repoRoot),
      ]),
    );
  }
  return value;
}

/** Read the installed version without importing the package graph (used by the CLI command). */
export function readProductVersion(packageJsonPath: string): string {
  try {
    if (!existsSync(packageJsonPath)) return 'unknown';
    return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** True when `candidate` is inside `root` — used by callers that resolve bundle output paths. */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}
