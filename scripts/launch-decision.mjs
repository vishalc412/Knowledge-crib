/** Produce a deliberately small, auditable developer-launch decision from release evidence. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateGate,
  loadLaunchPolicy,
  policyClientCells,
  policyGateIds,
  policyOsNodeCells,
} from './launch-policy.mjs';
import { ReleaseEvidenceError, validateReleaseEvidence } from './release-evidence.mjs';

/**
 * Recompute launch eligibility from the frozen policy and the manifest's VALIDATED measurements.
 *
 * The audit's A01 finding was that this function read the manifest's own conclusions —
 * `acceptance.pass`, `requiredFailures`, a precomputed missing-cell list, and a
 * `certification.required` switch the evidence itself set. Ordinary non-certifying verification
 * therefore printed GO, and so did a manifest with an empty gate array, a dirty tree, or no model
 * proof. Nothing in an artifact may now select or satisfy its own requirements: the policy says
 * what is required, the manifest supplies measurements, and this function does the judging.
 *
 * Every unknown is a blocker. Absent, skipped, not-run, invalid, mismatched and stale evidence all
 * produce NO-GO with a named reason — silence is never consent.
 *
 * @param options.policy       parsed launch policy (defaults to the committed one)
 * @param options.policySha256 the hash the evidence must have been collected under
 * @param options.candidate    {commit, packageSha256} the build being decided
 */
export function evaluateLaunchDecision(evidence, options = {}) {
  const blockers = [];
  const add = (reason) => void blockers.push(reason);

  const loaded = options.policy
    ? { policy: options.policy, sha256: options.policySha256 }
    : loadLaunchPolicy(options.policyPath);
  const policy = loaded.policy;
  const policySha256 = options.policySha256 ?? loaded.sha256;

  if (!evidence || typeof evidence !== 'object') {
    return { decision: 'NO-GO', blockers: ['evidence-missing'], certifying: false };
  }

  // Schema 1 predates candidate identity, typed receipts and recorded measurements. It stays
  // readable for diagnostics — an honest historical failure should not become unreadable — but it
  // cannot certify, because the facts a decision must check are not expressible in it.
  const certifying = evidence.formatVersion >= 2;
  if (!certifying) add(`evidence-schema-non-certifying:${evidence.formatVersion ?? 'unknown'}`);

  // ── candidate identity ──────────────────────────────────────────────────────
  const candidate = evidence.candidate ?? {};
  if (candidate.dirty !== false) add('candidate-dirty-or-unknown');
  if (typeof candidate.commit !== 'string' || !candidate.commit) add('candidate-commit-missing');
  if (typeof candidate.packageSha256 !== 'string' || !candidate.packageSha256)
    add('candidate-package-missing');
  if (options.candidate?.commit && candidate.commit !== options.candidate.commit)
    add(`candidate-commit-mismatch:${candidate.commit ?? 'none'}`);
  if (
    options.candidate?.packageSha256 &&
    candidate.packageSha256 !== options.candidate.packageSha256
  )
    add(`candidate-package-mismatch:${candidate.packageSha256 ?? 'none'}`);
  if (policySha256 && candidate.policySha256 !== policySha256)
    add(`policy-mismatch:${candidate.policySha256 ?? 'none'}`);

  // ── the run itself completed ────────────────────────────────────────────────
  if (certifying && evidence.run?.exitCode !== 0)
    add(`run-exit-code:${evidence.run?.exitCode ?? 'unknown'}`);

  // ── semantic model + scorer ─────────────────────────────────────────────────
  const model = evidence.retrieval?.model ?? {};
  if (!model.id || !model.version || !model.manifestSha256) add('semantic-model-proof-missing');
  const supported = policy.semanticModel.supportedScorers;
  if (supported.length > 0 && !supported.includes(evidence.retrieval?.scorer))
    add(`scorer-unsupported:${evidence.retrieval?.scorer ?? 'unknown'}`);

  // ── gates: the EXACT frozen set, re-judged against the policy's own numbers ──
  const gates = Array.isArray(evidence.gates) ? evidence.gates : [];
  const byId = new Map();
  for (const gate of gates) {
    if (byId.has(gate.id)) add(`gate-duplicate:${gate.id}`);
    byId.set(gate.id, gate);
  }
  for (const id of byId.keys()) {
    if (!policyGateIds(policy).includes(id)) add(`gate-unknown:${id}`);
  }
  for (const policyGate of policy.gates) {
    const gate = byId.get(policyGate.id);
    if (!gate) {
      add(`gate-missing:${policyGate.id}`);
      continue;
    }
    // A manifest may not restate the requirement more leniently than the policy froze it.
    if (gate.threshold !== undefined && gate.threshold !== policyGate.threshold)
      add(`gate-threshold-altered:${policyGate.id}`);
    if (gate.comparison !== undefined && gate.comparison !== policyGate.direction)
      add(`gate-direction-altered:${policyGate.id}`);
    const verdict = evaluateGate(policyGate, gate.measured, policy.gateEpsilon);
    if (!verdict.pass) add(`gate-failed:${policyGate.id}:${verdict.reason}`);
    // A pass flag that disagrees with the recomputation is a tampering signal, reported as such
    // even when the recomputation itself passes.
    if (typeof gate.pass === 'boolean' && gate.pass !== verdict.pass)
      add(`gate-contradiction:${policyGate.id}`);
  }

  // ── typed receipts: a missing type is an actionable blocker, never an inference ──
  const receipts = evidence.receipts ?? {};
  for (const type of policy.receiptTypes) {
    const receipt = receipts[type];
    if (!receipt) {
      add(`receipt-missing:${type}`);
      continue;
    }
    if (receipt.status !== 'pass')
      add(`receipt-not-passing:${type}:${receipt.status ?? 'unknown'}`);
    else if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0)
      add(`receipt-artifact-missing:${type}`);
    if (receipt.candidateCommit !== undefined && receipt.candidateCommit !== candidate.commit)
      add(`receipt-candidate-mismatch:${type}`);
  }

  // ── freshness receipt must meet the PREREGISTERED target ────────────────────
  const freshness = receipts.freshness;
  if (freshness?.status === 'pass') {
    const p95 = freshness.p95Ms;
    if (typeof p95 !== 'number' || !Number.isFinite(p95)) add('freshness-p95-not-finite');
    else if (p95 > policy.freshness.p95TargetMs) add(`freshness-p95-exceeded:${p95}`);
    if (freshness.workload !== policy.freshness.workload)
      add(`freshness-workload-mismatch:${freshness.workload ?? 'unknown'}`);
  }

  // ── every advertised client/platform cell, bound to THIS candidate ──────────
  blockers.push(
    ...uncertifiedClientCells(evidence.certification?.receipts ?? [], {
      policy,
      policySha256,
      candidate: {
        commit: candidate.commit,
        packageSha256: candidate.packageSha256,
      },
    }),
  );

  // ── the manifest's own conclusion is compared, never trusted ────────────────
  const recomputedPass = blockers.length === 0;
  if (evidence.acceptance?.pass === true && !recomputedPass) add('acceptance-contradiction');

  return {
    decision: blockers.length === 0 ? 'GO' : 'NO-GO',
    blockers: [...new Set(blockers)],
    certifying,
  };
}

/**
 * The client/platform cells the policy advertises that this candidate cannot show a genuine vendor
 * runtime for — the A02 repair. A receipt only covers a cell when it is for this exact commit AND
 * this exact package AND was collected under this policy AND names a supported client version AND
 * carries a vendor-client runtime pass. Anything else leaves the cell open by name.
 */
export function uncertifiedClientCells(receipts, { policy, policySha256, candidate }) {
  const covered = new Set();
  const problems = [];
  for (const receipt of receipts ?? []) {
    const cell = `${receipt?.client?.id}/${receipt?.platform?.os}`;
    if (receipt?.runtimeStatus !== 'pass') continue; // configuration/protocol evidence is not runtime
    if (receipt?.platform?.wsl === true) continue; // WSL never satisfies a native cell
    if (candidate.commit && receipt?.product?.commit !== candidate.commit) {
      problems.push(`client-receipt-foreign-commit:${cell}`);
      continue;
    }
    if (candidate.packageSha256 && receipt?.product?.packageSha256 !== candidate.packageSha256) {
      problems.push(`client-receipt-foreign-package:${cell}`);
      continue;
    }
    if (policySha256 && receipt?.policySha256 !== policySha256) {
      problems.push(`client-receipt-foreign-policy:${cell}`);
      continue;
    }
    const requirement = policy.clientVersionRequirements?.[receipt?.client?.id];
    if (requirement && !satisfiesMinimumVersion(receipt?.client?.version, requirement)) {
      problems.push(`client-version-unsupported:${cell}:${receipt?.client?.version ?? 'none'}`);
      continue;
    }
    covered.add(cell);
  }
  const missing = policyClientCells(policy)
    .filter((cell) => !covered.has(cell))
    .map((cell) => `client-cell-uncertified:${cell}`);
  return [...new Set([...problems, ...missing])];
}

/** Dotted numeric comparison: `version >= minimum`. Anything unparseable fails closed. */
function satisfiesMinimumVersion(version, minimum) {
  const parse = (value) =>
    typeof value === 'string' ? value.trim().replace(/^v/, '').split('.').map(Number) : null;
  const actual = parse(version);
  const floor = parse(minimum);
  if (!actual || !floor || actual.some(Number.isNaN) || floor.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(actual.length, floor.length); i++) {
    const a = actual[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * WP9.1 — load one evidence file through structural validation BEFORE the decision reads
 * acceptance.pass / requiredFailures verbatim. A tampered or omission-ridden manifest throws
 * (ReleaseEvidenceError naming the offending field) instead of yielding a fabricated GO.
 */
export function loadReleaseEvidence(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ReleaseEvidenceError(`unreadable release evidence ${path}: ${error.message}`);
  }
  return validateReleaseEvidence(parsed);
}

/**
 * WP9.4 (aggregation half) — GO only when EVERY cell is GO. A cell whose manifest is missing
 * (null) or fails structural validation blocks the aggregate under a cell-tagged blocker; one
 * green cell never carries a red one. An empty cell set is NO-GO, not a vacuous GO.
 */
export function aggregateLaunchDecisions(cells, options = {}) {
  const loaded = options.policy
    ? { policy: options.policy, sha256: options.policySha256 }
    : loadLaunchPolicy(options.policyPath);
  const policy = loaded.policy;
  const policySha256 = options.policySha256 ?? loaded.sha256;
  const rows = [];
  const blockers = [];
  const seen = new Set();

  // Every cell is judged against ONE candidate. Which one is either supplied by the caller (a tag
  // build knows what it is publishing) or taken from the first manifest — after which any cell
  // disagreeing about the commit, the package or the policy is a mixed-candidate aggregate, not a
  // green one (A03: a one-cell green fixture used to produce aggregate GO).
  let candidate = options.candidate;

  for (const entry of cells ?? []) {
    const row = { cell: entry?.cell, decision: 'NO-GO', blockers: [] };
    if (seen.has(row.cell)) row.blockers.push(`duplicate-cell:${row.cell}`);
    seen.add(row.cell);

    if (!entry?.manifest) {
      row.blockers.push(`missing-evidence:${row.cell}`);
    } else {
      try {
        validateReleaseEvidence(entry.manifest);
      } catch (error) {
        row.blockers.push(`invalid-evidence:${row.cell}:${error.message}`);
      }
      if (row.blockers.length === 0) {
        // The caller pins what it KNOWS (a tag build knows its commit); the rest is discovered from
        // the first valid manifest and then enforced on every other cell. Leaving a field undefined
        // would publish an empty digest downstream, so the resolved candidate is always complete
        // before any cell is judged against it.
        candidate = {
          commit: candidate?.commit ?? entry.manifest.candidate?.commit,
          packageSha256: candidate?.packageSha256 ?? entry.manifest.candidate?.packageSha256,
        };
        const decision = evaluateLaunchDecision(entry.manifest, {
          policy,
          policySha256,
          candidate,
        });
        row.decision = decision.decision;
        row.blockers = decision.blockers.map((blocker) => `${row.cell}:${blocker}`);
      }
    }
    rows.push(row);
    blockers.push(...row.blockers);
  }

  // The expected set is the POLICY's, not "whatever files happened to be downloaded". A workflow
  // that silently uploads five of six OS/Node manifests must not aggregate to GO.
  const expected = options.expectedCells ?? policyOsNodeCells(policy);
  for (const cell of expected) {
    if (!seen.has(cell)) {
      const row = { cell, decision: 'NO-GO', blockers: [`missing-evidence:${cell}`] };
      rows.push(row);
      blockers.push(...row.blockers);
    }
  }

  if (rows.length === 0) {
    return { decision: 'NO-GO', blockers: ['no-evidence'], cells: rows, candidate: null };
  }
  return {
    decision: rows.every((row) => row.decision === 'GO') && blockers.length === 0 ? 'GO' : 'NO-GO',
    blockers: [...new Set(blockers)],
    cells: rows,
    // The digest a publication step is allowed to ship — and only on a GO.
    candidate: candidate ?? null,
    policySha256,
  };
}

/** Collect one entry per *.json under the cells directory; the cell id is the path minus .json. */
function collectCellFiles(directory) {
  const files = [];
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.json'))
        files.push({ path: join(dir, entry.name), cell: `${prefix}${entry.name.slice(0, -5)}` });
    }
  };
  walk(directory, '');
  return files;
}

/** Expected cell ids come from repeatable --expect name[,name...] flags. */
function expectedCells(argv) {
  const expected = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--expect') continue;
    for (const name of (argv[++i] ?? '').split(',')) {
      if (name.trim()) expected.push(name.trim());
    }
  }
  return expected;
}

function mainCells(argv, cellsIndex) {
  const directory = resolve(argv[cellsIndex + 1] ?? '.');
  const found = collectCellFiles(directory);
  const cells = found.map((entry) => {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(entry.path, 'utf8'));
    } catch {
      // Unreadable JSON fails structural validation below -> invalid-evidence:<cell>.
      manifest = {};
    }
    return { cell: entry.cell, manifest };
  });
  // --expect NARROWS nothing: the policy's cell set is always required. Explicit flags may only
  // ADD cells a caller knows about beyond the policy.
  const declared = expectedCells(argv);
  const aggregate = aggregateLaunchDecisions(cells, {
    ...(declared.length > 0
      ? {
          expectedCells: [
            ...new Set([...policyOsNodeCells(loadLaunchPolicy().policy), ...declared]),
          ],
        }
      : {}),
    ...(candidateFromArgv(argv) ? { candidate: candidateFromArgv(argv) } : {}),
  });
  for (const row of aggregate.cells) {
    process.stdout.write(`${row.cell}  ${row.decision}\n`);
    for (const blocker of row.blockers) process.stdout.write(`  - ${blocker}\n`);
  }
  process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
  if (aggregate.decision !== 'GO') process.exitCode = 1;
}

/** `--candidate-commit <sha> --candidate-package sha256:<hex>` — what a tag build is publishing. */
function candidateFromArgv(argv) {
  const commitIdx = argv.indexOf('--candidate-commit');
  const packageIdx = argv.indexOf('--candidate-package');
  if (commitIdx < 0 && packageIdx < 0) return undefined;
  return {
    ...(commitIdx >= 0 ? { commit: argv[commitIdx + 1] } : {}),
    ...(packageIdx >= 0 ? { packageSha256: argv[packageIdx + 1] } : {}),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const cellsIndex = argv.indexOf('--cells');
  if (cellsIndex >= 0) {
    mainCells(argv, cellsIndex);
    return;
  }
  const index = argv.indexOf('--evidence');
  const path = resolve(
    index >= 0 ? (argv[index + 1] ?? 'release-evidence.json') : 'release-evidence.json',
  );
  try {
    const evidence = loadReleaseEvidence(path);
    const decision = evaluateLaunchDecision(evidence, {
      ...(candidateFromArgv(argv) ? { candidate: candidateFromArgv(argv) } : {}),
    });
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    if (decision.decision !== 'GO') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
