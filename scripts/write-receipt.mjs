import { execFileSync } from 'node:child_process';
/**
 * Write ONE typed acceptance receipt.
 *
 * A release manifest used to infer install/browser/recovery coverage from a unit-test total, which
 * is how a workflow could pass while never running any of them. Each of those checks now writes its
 * own receipt, from the step that actually ran it, AFTER it succeeded — so the receipt's existence
 * means the command completed, not that it was scheduled. The launch decision requires one receipt
 * per policy receipt type and refuses the missing ones by name.
 *
 * Two vocabularies, one writer. An ACCEPTANCE type (`install`, `browser`, …) is collected once per
 * OS/Node cell; a GLOBAL type (`fuzz-deep`) is collected once per candidate. Both are policy-
 * declared and both are refused if the policy does not know the name — a receipt for a type nobody
 * requires is not evidence, it is a typo that looks like progress.
 *
 * Usage:
 *   node scripts/write-receipt.mjs <type> --out receipts/install.json \
 *     --package <candidate-tarball> --command "pnpm installer:smoke" --exit-code 0 \
 *     [--command "..." --exit-code N ...] [--artifact <path>...] [--artifact-root <dir>] \
 *     [--run-id <id>] [--p95-ms <n>] [--workload <name>]
 *
 * `--package` is required, and `--status` is no longer a claim: pass/fail is derived from the
 * archived --command/--exit-code pairs (a caller's --status must agree with them or the writer
 * refuses).
 *
 * Artifact paths are stored VERBATIM. The launch decision resolves them against the
 * `--receipts-root` it was given, so a receipt that stores a machine-absolute path only certifies
 * from the machine and directory it was written on — evidence that cannot survive being copied to
 * the launch judge is not evidence. By default an --artifact path is resolved against the writer's
 * cwd; `--artifact-root` says the path is relative to that directory instead (the acceptance
 * collector passes its --out dir, so the whole evidence tree is relocatable).
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLaunchPolicy } from './launch-policy.mjs';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

function flags(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name) out.push(argv[++i]);
  return out.filter(Boolean);
}

/**
 * Build a receipt envelope. Exported so a check that ALREADY knows what it measured (the fuzz
 * harness, which owns its own transcript and its own per-extractor results) can write its receipt
 * in-process rather than re-describing itself to a second script on a command line — a description
 * that could disagree with what actually ran.
 *
 * `details` carries check-specific facts (a deep sweep's seed, iterations, extractor list and
 * failures). It is nested rather than spread so a detail can never overwrite an envelope field like
 * `status` or `candidateCommit`: the envelope is the part the decision reads structurally, and a
 * producer must not be able to rewrite it by choosing a field name.
 */
export function buildReceipt({ type, argv, now = new Date().toISOString(), details }) {
  const { policy, sha256: policySha256 } = loadLaunchPolicy();
  const known = [...policy.receiptTypes, ...policy.globalReceiptTypes];
  if (!known.includes(type)) {
    throw new Error(`unknown receipt type ${type}; the launch policy declares ${known.join(', ')}`);
  }
  // Artifact paths are stored VERBATIM — the decision resolves them against --receipts-root — but
  // existence and digest are checked against real bytes before the receipt is written. By default
  // that means the writer's cwd; --artifact-root names the directory a (relative) path is against,
  // which is how the collector writes `logs/<type>.log` entries that still verify on any machine.
  const artifactRoot =
    flag(argv, '--artifact-root') === undefined
      ? undefined
      : resolve(flag(argv, '--artifact-root'));
  const artifactPath = (path) => (artifactRoot === undefined ? path : resolve(artifactRoot, path));
  const artifacts = flags(argv, '--artifact').map((path) => {
    const absolute = artifactPath(path);
    if (!existsSync(absolute)) throw new Error(`receipt artifact does not exist: ${path}`);
    return { path, sha256: sha256(readFileSync(absolute)) };
  });
  // The candidate ARTIFACT, not the candidate source. A receipt that binds only to a commit cannot
  // notice that the tarball it certifies was rebuilt — and a rebuilt tarball is a different product
  // even when the commit is identical (`pnpm pack` is not byte-reproducible here). In v2 the
  // binding is REQUIRED: a receipt with no package digest certifies nothing.
  const packagePath = flag(argv, '--package');
  if (packagePath === undefined) {
    throw new Error(
      '--package is required: an acceptance receipt that binds no candidate package cannot certify the launch',
    );
  }
  if (!existsSync(packagePath)) {
    throw new Error(`receipt package does not exist: ${packagePath}`);
  }
  // v2 archives every constituent command WITH its actual exit code. Status is then DERIVED from
  // those facts (all zero ⇒ pass) instead of being asserted by whoever invokes this writer — the
  // nonzero-exit-as-pass laundering route is closed at the source. Multi-command checks (the
  // security battery + its checker) archive one entry per command; a single joined display string
  // would let a failed constituent hide behind a sibling's success.
  const commands = flags(argv, '--command');
  const exitCodes = flags(argv, '--exit-code');
  if (commands.length === 0) {
    throw new Error(`a ${type} receipt must archive at least one --command with its --exit-code`);
  }
  if (commands.length !== exitCodes.length) {
    throw new Error(
      `--command and --exit-code must appear the same number of times (got ${commands.length} commands and ${exitCodes.length} exit codes); every command's completion must be recorded, not just some`,
    );
  }
  const commandResults = commands.map((command, i) => {
    const exitCode = Number(exitCodes[i]);
    if (!Number.isInteger(exitCode)) {
      throw new Error(
        `--exit-code must be an integer exit status, got ${JSON.stringify(exitCodes[i])}`,
      );
    }
    return { command, exitCode };
  });
  const status = commandResults.every((result) => result.exitCode === 0) ? 'pass' : 'fail';
  // A caller may still pass --status, but it must AGREE with the facts. Allowing a contradiction
  // here would move the laundering one flag earlier, not remove it.
  const declaredStatus = flag(argv, '--status');
  if (declaredStatus !== undefined && declaredStatus !== status) {
    throw new Error(
      `--status ${declaredStatus} contradicts the recorded command results, which derive ${status}; a receipt may not disagree with what actually ran`,
    );
  }
  if (status === 'pass' && artifacts.length === 0) {
    throw new Error(
      `a passing ${type} receipt must reference at least one --artifact; a claim with nothing behind it is not evidence`,
    );
  }
  let commit;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    commit = undefined;
  }
  const p95 = flag(argv, '--p95-ms');
  const runId = flag(argv, '--run-id') ?? randomUUID();
  return {
    format: 'knowledge-crib-acceptance-receipt',
    formatVersion: 2,
    type,
    status,
    recordedAt: now,
    runId,
    candidateCommit: commit,
    candidatePackageSha256: sha256(readFileSync(packagePath)),
    policySha256,
    command: commands.length === 1 ? commands[0] : commands.join(' && '),
    commandResults,
    platform: { os: process.platform, arch: process.arch, node: process.version },
    runner:
      process.env.GITHUB_ACTIONS === 'true'
        ? { provider: 'github-actions', runId: process.env.GITHUB_RUN_ID }
        : { provider: 'local', host: hostname() },
    artifacts,
    ...(p95 !== undefined ? { p95Ms: Number(p95) } : {}),
    ...(flag(argv, '--workload') ? { workload: flag(argv, '--workload') } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const type = argv[0];
  if (!type || type.startsWith('--')) {
    process.stderr.write(
      'usage: write-receipt.mjs <type> --out <path> --package <tarball> --command "..." --exit-code <n> [--artifact <path>...]\n',
    );
    process.exitCode = 1;
    return;
  }
  const out = resolve(flag(argv, '--out', `receipts/${type}.json`));
  const receipt = buildReceipt({ type, argv });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${type} receipt (${receipt.status}) -> ${out}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
