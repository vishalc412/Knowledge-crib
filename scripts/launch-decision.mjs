/** Produce a deliberately small, auditable developer-launch decision from release evidence. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CertificationEvidenceError,
  bindingProblems,
  certifyClientCell,
  loadClientCertificationReceipts,
} from './client-certification-evidence.mjs';
import {
  evaluateGate,
  loadLaunchPolicy,
  policyClientCells,
  policyFuzzRequirements,
  policyGateIds,
  policyGlobalReceiptTypes,
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
 * Client certification is CANDIDATE-scoped: the 21 vendor-runtime cells describe the build, not any
 * one OS/Node cell. So it is judged from raw receipts the caller supplies
 * (`options.certificationReceipts`) and NEVER from the summary a manifest copied in — a per-platform
 * manifest that claims a runtime pass the raw receipts do not support is a tampering signal, not
 * coverage. `options.certificationReceipts === null` means "judged at another scope" (the aggregate
 * evaluates it once); `undefined` means "required but never supplied", which is a blocker.
 *
 * @param options.policy       parsed launch policy (defaults to the committed one)
 * @param options.policySha256 the hash the evidence must have been collected under
 * @param options.candidate    {commit, packageSha256} the build being decided
 * @param options.certificationReceipts raw 21-cell receipts, or null to defer to the aggregate
 * @param options.globalReceipts        raw candidate-wide receipts (fuzz-deep), or null to defer
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
  //
  // From RAW receipts, never from `evidence.certification.receipts`. That summary is a manifest
  // restating its own conclusions — the A01 defect — so it is compared against the raw coverage
  // below rather than trusted, and a summary claim the receipts do not support names the cell.
  const rawCertification = options.certificationReceipts;
  if (rawCertification === null) {
    // Candidate-scoped, and this call is a per-OS/Node-cell evaluation: the aggregate owns it so
    // one uncertified client is reported once rather than repeated into all six cell manifests.
  } else if (Array.isArray(rawCertification)) {
    blockers.push(
      ...uncertifiedClientCells(rawCertification, {
        policy,
        policySha256,
        candidate: {
          commit: candidate.commit,
          packageSha256: candidate.packageSha256,
        },
      }),
    );
    const covered = new Set(
      rawCertification.filter((receipt) => certifyClientCell(receipt).ok).map(certificationCellOf),
    );
    for (const claim of evidence.certification?.receipts ?? []) {
      const cell = `${claim?.client?.id}/${claim?.platform?.os}`;
      if (claim?.runtimeStatus === 'pass' && !covered.has(cell)) {
        add(`certification-summary-unsupported:${cell}`);
      }
    }
  } else if (certifying) {
    add('certification-receipts-not-loaded');
  }

  // ── candidate-wide receipts the policy requires (the deep sweep) ────────────
  const rawGlobal = options.globalReceipts;
  if (rawGlobal === null) {
    // Deferred to the aggregate, same as certification.
  } else if (Array.isArray(rawGlobal)) {
    blockers.push(
      ...judgeGlobalReceipts(rawGlobal, {
        policy,
        policySha256,
        candidate: {
          commit: candidate.commit,
          packageSha256: candidate.packageSha256,
        },
        evidenceRoot: options.globalReceiptsRoot,
      }),
    );
  } else if (certifying) {
    add('global-receipts-not-loaded');
  }

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
 * runtime for — the A02 repair.
 *
 * Coverage comes from `certifyClientCell`, so a receipt only covers a cell when the CURRENT
 * certifying schema produced it, for this exact commit, this exact package, under this policy, at a
 * client version at or above that CELL's floor, carrying all eight legs including a vendor-client
 * handshake, on a native (non-WSL) platform with its transcript still on disk. Anything else leaves
 * the cell open by name.
 *
 * Two kinds of name are produced, because they answer different questions.
 *
 * A BINDING failure is reported whatever else the set contains (`client-receipt-foreign-commit:…`):
 * the receipt is about ANOTHER build, and a reader has to be told that the set they were handed is
 * not the candidate they asked about — even when every policy cell happens to be covered by the
 * receipts that remain.
 *
 * Any other failure is a statement about COVERAGE, and coverage is settled per CELL. A cell another
 * receipt certifies is certified: an extra run for that same cell — a WSL sanity check, an
 * interrupted attempt, a test-client protocol probe — is not part of the promise and must not sink a
 * release that satisfies it. Reporting it anyway would make the decision disagree with the public
 * matrix, which reads this same fact the same way, and would let a diagnostic run permanently block
 * a launch. So the finding is emitted only while its cell is actually open, and then as
 * `client-cell-not-certifying:<cell>:<why>` — never as an absence a reader has to interpret.
 */
export function uncertifiedClientCells(receipts, { policy, policySha256, candidate }) {
  const options = { policy, policySha256, candidate };
  const covered = new Set();
  const uncertified = [];
  for (const receipt of receipts ?? []) {
    const verdict = certifyClientCell(receipt, options);
    if (verdict.ok) covered.add(verdict.cell);
    else uncertified.push({ receipt, verdict });
  }
  const problems = [];
  for (const { receipt, verdict } of uncertified) {
    // One producer for "is this receipt about another build", so the unconditional cases here and
    // the ones `certifyClientCell` refuses can never drift apart.
    if (bindingProblems(receipt, options).length > 0) {
      problems.push(`${verdict.problem}:${verdict.cell}:${verdict.detail ?? 'unknown'}`);
      continue;
    }
    if (covered.has(verdict.cell)) continue;
    problems.push(`client-cell-not-certifying:${verdict.cell}:${verdict.detail ?? 'unknown'}`);
  }
  const missing = policyClientCells(policy)
    .filter((cell) => !covered.has(cell))
    .map((cell) => `client-cell-uncertified:${cell}`);
  return [...new Set([...problems, ...missing])];
}

/** The `client/os` cell a raw receipt speaks for. */
function certificationCellOf(receipt) {
  return `${receipt?.client?.id}/${receipt?.platform?.os}`;
}

/**
 * Candidate-wide receipts the policy requires but that are not produced once per OS/Node cell —
 * today the deep fuzz sweep. `fuzz-deep` is the receipt that says a million seeded inputs per
 * extractor ran against THIS package, so it binds to the candidate exactly as a client receipt does,
 * and its own numbers (workload, seed, iterations, fleet size, failures) are re-judged against the
 * policy rather than read as a verdict.
 */
export function judgeGlobalReceipts(receipts, { policy, policySha256, candidate, evidenceRoot }) {
  const blockers = [];
  const required = policyGlobalReceiptTypes(policy);
  const byType = new Map();
  for (const receipt of receipts ?? []) {
    if (typeof receipt?.type === 'string') byType.set(receipt.type, receipt);
  }
  for (const type of required) {
    const receipt = byType.get(type);
    if (!receipt) {
      blockers.push(`global-receipt-missing:${type}`);
      continue;
    }
    if (receipt.status !== 'pass') {
      blockers.push(`global-receipt-not-passing:${type}:${receipt.status ?? 'unknown'}`);
      continue;
    }
    if (
      candidate.commit &&
      receipt.candidateCommit !== undefined &&
      receipt.candidateCommit !== candidate.commit
    ) {
      blockers.push(`global-receipt-foreign-commit:${type}`);
      continue;
    }
    if (!receipt.candidateCommit) blockers.push(`global-receipt-foreign-commit:${type}`);
    if (
      candidate.packageSha256 &&
      receipt.candidatePackageSha256 !== undefined &&
      receipt.candidatePackageSha256 !== candidate.packageSha256
    ) {
      blockers.push(`global-receipt-foreign-package:${type}`);
      continue;
    }
    if (!receipt.candidatePackageSha256) blockers.push(`global-receipt-foreign-package:${type}`);
    if (policySha256 && receipt.policySha256 !== policySha256) {
      blockers.push(`global-receipt-foreign-policy:${type}`);
      continue;
    }
    const artifacts = Array.isArray(receipt.artifacts) ? receipt.artifacts : [];
    if (artifacts.length === 0) {
      blockers.push(`global-receipt-artifact-missing:${type}`);
    } else if (typeof evidenceRoot === 'string' && evidenceRoot.trim()) {
      for (const artifact of artifacts) {
        if (!artifactDigestMatches(resolve(evidenceRoot), artifact)) {
          blockers.push(`global-receipt-artifact-digest:${type}:${artifact?.path ?? 'unknown'}`);
        }
      }
    } else {
      // A receipt whose evidence cannot be located is a claim, not a proof. The receipts directory
      // is what makes the transcript checkable, so its absence is named rather than skipped.
      blockers.push(`global-receipt-artifact-unverifiable:${type}`);
    }
    if (type === 'fuzz-deep') blockers.push(...judgeFuzzWorkload(receipt, policy));
  }
  return blockers;
}

/**
 * Re-judge the sweep's own reported numbers against the frozen policy. A deep receipt is refused by
 * the harness when it is too shallow, but the harness is not the authority on what a launch needs —
 * the policy is, and it is the thing this function reads. The iteration count is compared with the
 * policy's own figure so the number lives in exactly one place.
 */
function judgeFuzzWorkload(receipt, policy) {
  const blockers = [];
  const requirements = policyFuzzRequirements(policy);
  const details = receipt.details ?? {};
  if (details.workload !== requirements.workload) {
    blockers.push(`fuzz-receipt-workload-mismatch:${details.workload ?? 'unknown'}`);
  }
  if (details.seed !== requirements.seed) {
    blockers.push(`fuzz-receipt-seed-mismatch:${details.seed ?? 'unknown'}`);
  }
  if (
    typeof details.iterations !== 'number' ||
    !Number.isFinite(details.iterations) ||
    details.iterations < requirements.requiredIterations
  ) {
    blockers.push(`fuzz-receipt-iterations-below-floor:${details.iterations ?? 'unknown'}`);
  }
  if (
    typeof details.extractorCount !== 'number' ||
    details.extractorCount < requirements.minimumExtractors
  ) {
    blockers.push(`fuzz-receipt-extractors-below-floor:${details.extractorCount ?? 'unknown'}`);
  }
  const failures = Array.isArray(details.failures) ? details.failures : [];
  if (failures.length > 0) blockers.push(`fuzz-receipt-failures:${failures.length}`);
  return blockers;
}

/**
 * Verify one archived artifact's digest.
 *
 * A path recorded by the producing run is normally relative to the receipts directory it sits in;
 * an absolute path is honoured as recorded, because the receipt is the producer's statement of where
 * its own evidence is. Either way the file must exist AND hash to what the receipt claimed — that
 * is the property that makes "altering a transcript after receipt generation invalidates the cell"
 * true rather than aspirational.
 */
function artifactDigestMatches(root, artifact) {
  if (typeof artifact?.path !== 'string' || typeof artifact?.sha256 !== 'string') return false;
  const path = resolve(root, artifact.path);
  if (!existsSync(path)) return false;
  const digest = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  return artifact.sha256 === digest;
}

/** Load the raw certification receipts a decision must judge; a throw is reported, never fatal. */
export function loadCertificationReceiptsOrReport(directory) {
  try {
    return { receipts: loadClientCertificationReceipts(directory) };
  } catch (error) {
    if (error instanceof CertificationEvidenceError) {
      return { receipts: [], blocker: `certification-receipts-unreadable:${error.message}` };
    }
    throw error;
  }
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
          // Candidate-scoped, and judged once below. Passing it into each cell would repeat the
          // same 21 findings into all six manifests, which reads as six problems instead of one.
          certificationReceipts: null,
          globalReceipts: null,
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

  // A cell set that is empty by construction says nothing about certification; naming "no-evidence"
  // is the actionable finding, and expanding it into 21 cell names would bury it.
  if (rows.length === 0) {
    return {
      decision: 'NO-GO',
      blockers: ['no-evidence'],
      cells: rows,
      candidate: candidate ?? null,
    };
  }

  // ── the candidate-wide facts, judged ONCE ───────────────────────────────────
  //
  // These are not per-OS/Node-cell questions, so they are asked here rather than in each cell: is
  // this BUILD certified for all 21 advertised vendor-runtime cells, and did the policy's deep sweep
  // actually run against this package? Both read RAW receipts. A summary inside a manifest is not
  // consulted — a manifest cannot certify itself.
  const resolvedCandidate = candidate ?? null;
  if (options.certificationReceipts === undefined) {
    // Absent is not "not required": the policy advertises 21 cells, so a decision that never looked
    // at them says so by name rather than passing silently.
    for (const cell of policyClientCells(policy)) blockers.push(`client-cell-uncertified:${cell}`);
    blockers.push('certification-receipts-not-loaded');
  } else {
    blockers.push(
      ...uncertifiedClientCells(options.certificationReceipts, {
        policy,
        policySha256,
        candidate: resolvedCandidate ?? {},
      }),
    );
  }
  if (options.globalReceipts === undefined) {
    for (const type of policyGlobalReceiptTypes(policy)) {
      blockers.push(`global-receipt-missing:${type}`);
    }
    blockers.push('global-receipts-not-loaded');
  } else {
    blockers.push(
      ...judgeGlobalReceipts(options.globalReceipts, {
        policy,
        policySha256,
        candidate: resolvedCandidate ?? {},
        evidenceRoot: options.globalReceiptsRoot,
      }),
    );
  }

  return {
    decision: rows.every((row) => row.decision === 'GO') && blockers.length === 0 ? 'GO' : 'NO-GO',
    blockers: [...new Set(blockers)],
    cells: rows,
    // The digest a publication step is allowed to ship — and only on a GO.
    candidate: resolvedCandidate,
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

/**
 * `--certification-receipts <dir>` — the 21 raw vendor-runtime receipts, loaded and validated here
 * rather than summarized by a manifest.
 *
 * A load failure is REPORTED, not thrown: an unreadable or malformed receipt directory is a named
 * blocker alongside the cell names it leaves open, so a reader sees both the cause and its
 * consequence. Throwing would print one line and hide which cells the failure actually costs.
 */
function certificationReceiptsFromArgv(argv) {
  const index = argv.indexOf('--certification-receipts');
  if (index < 0) return undefined;
  const directory = resolve(argv[index + 1] ?? '.');
  const loaded = loadCertificationReceiptsOrReport(directory);
  return { receipts: loaded.receipts, blocker: loaded.blocker };
}

/** `--global-receipts <dir>` — candidate-wide receipts (the deep sweep), loaded as raw JSON. */
function globalReceiptsFromArgv(argv) {
  const index = argv.indexOf('--global-receipts');
  if (index < 0) return undefined;
  const directory = resolve(argv[index + 1] ?? '.');
  if (!existsSync(directory)) {
    return { receipts: [], blocker: `global-receipts-unreadable:${directory} does not exist` };
  }
  const receipts = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      receipts.push(JSON.parse(readFileSync(join(directory, name), 'utf8')));
    } catch (error) {
      return { receipts: [], blocker: `global-receipts-unreadable:${name}:${error.message}` };
    }
  }
  return { receipts, root: directory };
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
  const certification = certificationReceiptsFromArgv(argv);
  const global = globalReceiptsFromArgv(argv);
  const aggregate = aggregateLaunchDecisions(cells, {
    ...(declared.length > 0
      ? {
          expectedCells: [
            ...new Set([...policyOsNodeCells(loadLaunchPolicy().policy), ...declared]),
          ],
        }
      : {}),
    ...(candidateFromArgv(argv) ? { candidate: candidateFromArgv(argv) } : {}),
    ...(certification ? { certificationReceipts: certification.receipts } : {}),
    ...(global ? { globalReceipts: global.receipts, globalReceiptsRoot: global.root } : {}),
  });
  for (const row of aggregate.cells) {
    process.stdout.write(`${row.cell}  ${row.decision}\n`);
    for (const blocker of row.blockers) process.stdout.write(`  - ${blocker}\n`);
  }
  for (const blocker of [certification?.blocker, global?.blocker].filter(Boolean)) {
    process.stdout.write(`  - ${blocker}\n`);
    aggregate.blockers.push(blocker);
    aggregate.decision = 'NO-GO';
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
    const certification = certificationReceiptsFromArgv(argv);
    const global = globalReceiptsFromArgv(argv);
    const decision = evaluateLaunchDecision(evidence, {
      ...(candidateFromArgv(argv) ? { candidate: candidateFromArgv(argv) } : {}),
      ...(certification ? { certificationReceipts: certification.receipts } : {}),
      ...(global ? { globalReceipts: global.receipts, globalReceiptsRoot: global.root } : {}),
    });
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    if (decision.decision !== 'GO') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
