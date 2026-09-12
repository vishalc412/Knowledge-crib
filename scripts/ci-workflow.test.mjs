import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Windows runners default to core.autocrlf=true, so checked-out YAML carries \r\n line endings
// and the structural regexes below (which match `on:\n  push:`) would fail. A workflow-shape test
// must not depend on the host's line-ending policy, so normalize CRLF → LF at read time.
const readLF = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const workflow = readLF('.github/workflows/beta-installers.yml');
const releaseWorkflow = readLF('.github/workflows/ci.yml');
const tagWorkflow = readLF('.github/workflows/release.yml');
const soulRefreshWorkflow = readLF('.github/workflows/crib-soul-refresh.yml');
const nightlyWorkflow = readLF('.github/workflows/fuzz-nightly.yml');
const occurrences = (text, pattern) => [...text.matchAll(pattern)].length;
const dependabot = readLF('.github/dependabot.yml');

assert.match(workflow, /macos-latest/, 'beta installer CI must run on macOS');
assert.match(workflow, /windows-latest/, 'beta installer CI must run on Windows');
assert.match(
  workflow,
  /corepack pnpm@9\.15\.0 installer:build/,
  'CI must build beta installer artifacts',
);
assert.match(
  workflow,
  /corepack pnpm@9\.15\.0 installer:smoke/,
  'CI must smoke-install beta artifacts',
);
assert.match(workflow, /install-macos\.sh/, 'CI must execute the generated macOS installer');
assert.match(workflow, /install-windows\.ps1/, 'CI must execute the generated Windows installer');
assert.match(workflow, /actions\/upload-artifact@/, 'CI must upload installer bundles');
assert.match(workflow, /contents:\s*read/, 'installer CI must use read-only repository access');
assert.match(workflow, /cancel-in-progress:\s*true/, 'installer CI must cancel superseded runs');
assert.equal(
  occurrences(workflow, /^permissions:/gm),
  1,
  'installer CI must define permissions once',
);
assert.equal(
  occurrences(workflow, /^concurrency:/gm),
  1,
  'installer CI must define concurrency once',
);
assert.equal(
  occurrences(workflow, /^\s+timeout-minutes:/gm),
  1,
  'installer CI must define its job timeout once',
);

// ─── the nightly deep sweep ─────────────────────────────────────────────────────────────────────
//
// The defect this section pins: the nightly ran the deep sweep against whatever `dist/` happened to
// exist, so the fuzz result was also the first test of the build — a compile error arrived as a
// fuzz finding, and a hang caused by a stale artefact read as a parser bug. And a nightly that
// fuzzed a package it never built could produce no receipt at all: nothing in the workflow named the
// candidate bytes, so there was nothing to bind a receipt to.
//
// ORDER is the requirement, not mere presence: install → build → deep fuzz → upload.
{
  const order = (needle) => nightlyWorkflow.indexOf(needle);
  const steps = {
    install: order('name: Install dependencies'),
    build: order('name: Build workspace'),
    candidate: order('name: Build the candidate package'),
    fuzz: order('name: Execute deep fuzz'),
    upload: order('name: Upload the deep-fuzz receipt'),
  };
  for (const [label, index] of Object.entries(steps)) {
    assert.ok(index > 0, `the nightly must contain the "${label}" step`);
  }
  assert.ok(
    steps.install < steps.build,
    'the nightly must build the workspace AFTER installing dependencies',
  );
  assert.ok(
    steps.build < steps.fuzz,
    'the deep sweep must run against the BUILT workspace: fuzzing before the build makes the fuzz ' +
      'result double as a compile test, and a hang from a stale artefact read as a parser bug',
  );
  assert.ok(
    steps.candidate < steps.fuzz,
    'the candidate package must be packed before the sweep it is the subject of',
  );
  assert.ok(steps.fuzz < steps.upload, 'the receipt is uploaded after the sweep that produced it');
}
assert.match(
  nightlyWorkflow,
  /corepack pnpm@9\.15\.0 build\b/,
  'the nightly must run a full workspace build, not a per-package one',
);
// The sweep refuses a shallow run (exit 2) when asked for a receipt, so the nightly's declared
// iterations must not fall below the policy's floor. Read from the policy rather than compared with
// a literal: if the floor rises, this fails here instead of failing at 03:00 in a nightly.
{
  const policy = JSON.parse(readLF('scripts/launch-policy.json'));
  const declared = /--iterations (\d+)/.exec(nightlyWorkflow);
  assert.ok(declared, 'the nightly must state the deep sweep iteration count explicitly');
  assert.ok(
    Number(declared[1]) >= policy.fuzz.requiredIterations,
    `the nightly runs ${declared?.[1]} iterations but the launch policy requires ` +
      `${policy.fuzz.requiredIterations}; a receipt for the smaller sweep would be refused`,
  );
}
assert.match(
  nightlyWorkflow,
  /--receipt fuzz-evidence\/fuzz-deep\.json/,
  'the nightly must write the candidate-bound deep-fuzz receipt',
);
assert.match(
  nightlyWorkflow,
  /--package "\$CANDIDATE_PACKAGE"/,
  'the receipt must bind to the candidate package bytes, not only to the commit',
);
assert.match(
  nightlyWorkflow,
  /echo "CANDIDATE_PACKAGE=\$CANDIDATE" >> "\$GITHUB_ENV"/,
  'the candidate package path must be resolved once and reused, so the receipt names the bytes ' +
    'that were on disk when the sweep ran',
);
// The receipt is uploaded even when the sweep fails: a failed sweep's receipt is how the run says
// WHICH extractor broke, and it is written on the failing path.
assert.match(
  nightlyWorkflow,
  /name:\s*Upload the deep-fuzz receipt\s*\n\s+if:\s*always\(\)/,
  'the deep-fuzz receipt must upload on the failing path too',
);
assert.match(
  nightlyWorkflow,
  /if-no-files-found:\s*warn/,
  'a run killed by the timeout may leave no receipt, and that must stay a different fact from a ' +
    'receipt that says fail — so the upload is best-effort',
);
assert.match(
  nightlyWorkflow,
  /fuzz-evidence\/fuzz-deep\.json\.log/,
  'the archived transcript must be uploaded beside the receipt it is hashed into',
);
assert.match(
  nightlyWorkflow,
  /workflow_dispatch:/,
  'the nightly must allow manual workflow_dispatch',
);
assert.match(
  nightlyWorkflow,
  /cron:\s*'13 9 \* \* \*'/,
  'the nightly must stay off the :00/:30 marks',
);
assert.match(
  nightlyWorkflow,
  /node-version:\s*'22'/,
  'the nightly must run on the standardized Node 22',
);
assert.match(
  nightlyWorkflow,
  /contents:\s*read/,
  'the nightly must use read-only repository access',
);
assert.equal(
  occurrences(nightlyWorkflow, /^permissions:/gm),
  1,
  'the nightly must define permissions once',
);
assert.equal(
  occurrences(nightlyWorkflow, /^concurrency:/gm),
  1,
  'the nightly must define concurrency once',
);
assert.equal(
  occurrences(nightlyWorkflow, /^\s+timeout-minutes:/gm),
  1,
  'the nightly must define its job timeout once',
);

assert.match(releaseWorkflow, /ubuntu-latest/, 'release CI must run on Linux');
assert.match(
  releaseWorkflow,
  /corepack pnpm@9\.15\.0 release:verify/,
  'release CI must run the complete release gate',
);
assert.match(
  releaseWorkflow,
  /KCRIB_EMBED_HOME/,
  'release CI must isolate the semantic model cache from the runner home',
);
assert.match(
  releaseWorkflow,
  /embed setup --model large --yes/,
  'release CI must install the supported semantic tier before collecting release evidence',
);
assert.match(
  releaseWorkflow,
  /contents:\s*read/,
  'release CI must use read-only repository access',
);
assert.match(
  releaseWorkflow,
  /cancel-in-progress:\s*true/,
  'release CI must cancel superseded runs',
);
// WP6 slice D — the browser acceptance suite runs ONLY on the ubuntu release gate (it
// downloads real chromium), never on the Windows/matrix legs. Both pins must hold: the
// binaries are installed and the suite actually runs.
assert.match(
  releaseWorkflow,
  /playwright install --with-deps chromium/,
  'release CI must install chromium for the browser acceptance suite',
);
assert.match(
  releaseWorkflow,
  /verify:browser/,
  'release CI must run the browser acceptance suite against the real isolated backend',
);
// WP9.4 — logs-on-failed-jobs: BOTH CI jobs (release gate + verify matrix) must upload their
// failure diagnostics even when a step fails. `if: always()` on the upload step is what keeps
// release-evidence.json and run logs alive past a red gate; without it the artifact step is
// skipped on exactly the runs where the evidence matters.
assert.ok(
  occurrences(releaseWorkflow, /name:\s*Upload failure diagnostics\s*\n\s+if:\s*always\(\)/g) >= 2,
  'both CI jobs must carry an if: always() failure-diagnostics upload step',
);
assert.ok(
  occurrences(releaseWorkflow, /uses:\s+actions\/upload-artifact@/g) >= 2,
  'both CI jobs must upload failure diagnostics',
);
assert.match(
  releaseWorkflow,
  /if-no-files-found:\s*warn/,
  'CI diagnostics upload must be best-effort (warn, not error, when no files match)',
);

for (const [name, source] of [
  ['release CI', releaseWorkflow],
  ['installer CI', workflow],
  ['tag release', tagWorkflow],
  ['fuzz nightly', nightlyWorkflow],
]) {
  const actionRefs = [...source.matchAll(/uses:\s+actions\/[\w-]+@([^\s]+)/g)];
  assert.ok(actionRefs.length > 0, `${name} must use GitHub Actions`);
  for (const [, ref] of actionRefs) {
    assert.match(ref, /^[0-9a-f]{40}$/, `${name} action references must use immutable SHAs`);
  }
}

assert.match(tagWorkflow, /tags:\s*\n\s*- ['"]v\*['"]/, 'release workflow must run for v* tags');
// Which platforms a TAG verifies on is the launch policy's decision, asserted from the policy
// itself further down rather than from a list that drifts from it.
assert.match(
  tagWorkflow,
  /corepack pnpm@9\.15\.0 release:verify/,
  'tag release must run the complete release gate',
);
assert.match(
  tagWorkflow,
  /KCRIB_EMBED_HOME/,
  'tag release must isolate the semantic model cache from the runner home',
);
assert.match(
  tagWorkflow,
  /embed setup --model large --yes/,
  'tag release must install the supported semantic tier before collecting release evidence',
);
assert.match(
  tagWorkflow,
  /actions\/upload-artifact@/,
  'tag release must upload the verified bundle',
);
assert.match(
  tagWorkflow,
  /release-evidence\.json/,
  'tag release must archive the semantic release receipt',
);
assert.match(
  tagWorkflow,
  /actions\/download-artifact@/,
  'tag release must download the verified bundle',
);
assert.match(
  tagWorkflow,
  /v\$VERSION/,
  'tag release must compare the tag with the package version',
);
assert.match(tagWorkflow, /gh release create/, 'tag release must create the GitHub release');
assert.match(
  tagWorkflow,
  /contents:\s*write/,
  'release job must have permission to create a release',
);
// A03 — publication depends on APPROVAL, not merely on the build having run.
//
// The defect this section pins: `release.needs: verify` let a tag publish while the aggregate
// decision failed or never ran, and the aggregator was invoked with no expected cell set, so a
// single green fixture produced aggregate GO. Every assertion below is one link in the chain
// "every policy cell ran -> one aggregate decision -> the approved bytes are the published bytes".

// The final receipt is written only after the mandatory commands, so a manifest cannot describe a
// workflow that stopped halfway; a FAILED cell's diagnostics go to a separate artifact the
// aggregation never reads.
assert.match(
  tagWorkflow,
  /name:\s*Collect release evidence/,
  'the tag workflow must collect release evidence after the mandatory commands',
);
assert.match(
  tagWorkflow,
  /name:\s*Upload failure diagnostics\s*\n\s+if:\s*failure\(\)/,
  'failure diagnostics must upload separately from the evidence the decision consumes',
);
assert.doesNotMatch(
  tagWorkflow,
  /name:\s*Upload release evidence\s*\n\s+if:\s*always\(\)/,
  'a half-finished run must not contribute a manifest to the launch decision',
);

// Browser acceptance and the install cycle are TAG requirements, not only PR CI, and each writes
// its own typed receipt — a missing receipt type is an actionable blocker downstream.
assert.match(
  tagWorkflow,
  /pnpm@9\.15\.0 verify:browser/,
  'tag verification must run the browser suite',
);
assert.match(
  tagWorkflow,
  /write-receipt\.mjs browser/,
  'the browser leg must write its own receipt',
);
assert.match(
  tagWorkflow,
  /write-receipt\.mjs install/,
  'the install cycle must write its own receipt',
);
assert.match(
  tagWorkflow,
  /--receipts receipts/,
  'release evidence must consume the typed receipts the steps wrote',
);

// The verify matrix must be the policy's cell set — EXACTLY, in both directions. A matrix smaller
// than the policy fails aggregation on a missing cell; a matrix larger than it uploads manifests
// for cells the launch does not claim, which are then judged against requirements their legs never
// produce. So this reads the committed policy rather than hardcoding a list.
{
  const policy = JSON.parse(readLF('scripts/launch-policy.json'));
  const declared = new Set(policy.osNodeCells.map((cell) => cell.split('/')[0]));
  const nodes = [...new Set(policy.osNodeCells.map((cell) => cell.split('/')[1]))].sort();
  assert.match(
    tagWorkflow,
    new RegExp(`node:\\s*\\[${nodes.map((n) => `'${n}'`).join(',\\s*')}\\]`),
    `the release verify matrix must cover exactly Node ${nodes.join(' and ')}`,
  );
  for (const os of declared) {
    assert.ok(tagWorkflow.includes(`- ${os}`), `the release verify matrix must cover ${os}`);
  }
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
    if (declared.has(os)) continue;
    assert.ok(
      !new RegExp(`^\\s+- ${os}$`, 'm').test(tagWorkflow),
      `${os} is not in the launch policy, so the release matrix must not emit evidence for it`,
    );
  }
  // The certification platforms the tag demands must match the policy's too.
  assert.ok(
    tagWorkflow.includes(`--certification-platforms ${policy.clientPlatforms.join(',')}`),
    'the tag must require certification for exactly the policy platforms',
  );
}

// The aggregate must see EVERY evidence source, and `needs` is the only thing that makes it wait.
//
// The defect this pins: with `needs: verify` alone, the aggregate could start as soon as the hosted
// matrix finished — while the twenty-one certification jobs and the deep sweep were still running —
// so the decision was computed from a directory the receipts had not been written into yet. Absent
// evidence is a NO-GO, which means the race does not publish a bad release; it publishes a NO-GO on a
// release that was actually clean, and a decision that is wrong in the safe direction is still wrong.
// It must list all four: the candidate it is bound to, the cell matrix, the certification jobs and
// the sweep.
assert.match(
  tagWorkflow,
  /launch-decision:\s*\n\s+name:\s*Aggregate launch decision\s*\n\s+needs:\s*\[candidate,\s*verify,\s*certify,\s*fuzz\]/,
  'the launch-decision job must wait for the candidate, the verify matrix, the certification jobs ' +
    'and the deep sweep — anything less computes the decision over a partially-written directory',
);
assert.match(
  tagWorkflow,
  /if:\s+\$\{\{\s*!cancelled\(\)\s*\}\}/,
  'launch-decision must run even when a verify cell fails (if: !cancelled())',
);
assert.match(
  tagWorkflow,
  /merge-multiple:\s*true/,
  'the per-cell evidence must merge so the aggregation reads the policy cell ids',
);
assert.match(
  tagWorkflow,
  /scripts\/launch-decision\.mjs --cells /,
  'launch-decision must aggregate the per-cell evidence via scripts/launch-decision.mjs --cells',
);
assert.match(
  tagWorkflow,
  /--candidate-commit "\$GITHUB_SHA"/,
  'the aggregate must be bound to the tagged commit, not to whatever the manifests claim',
);

// ORDER matters as much as presence: the receipt is the LAST thing a cell writes, so a mandatory
// command that fails after evidence generation cannot exist — there is nothing after it.
{
  const order = (needle) => tagWorkflow.indexOf(needle);
  const collect = order('name: Collect release evidence');
  for (const step of [
    'name: Run release gate',
    'name: Run browser acceptance suite',
    'name: Run install cycle',
    'name: Write browser receipt',
    'name: Write install receipt',
  ]) {
    assert.ok(order(step) > 0, `the tag workflow must contain "${step}"`);
    assert.ok(
      order(step) < collect,
      `"${step}" must run BEFORE the final receipt is written, or the receipt could describe work that had not happened`,
    );
  }
  assert.ok(
    order('name: Upload verified bundle') > collect,
    'the bundle is uploaded only after the evidence for it exists',
  );
}

// THE gate: publication needs verification AND approval, and ships only the approved bytes.
assert.match(
  tagWorkflow,
  /needs:\s*\[verify,\s*launch-decision\]/,
  'the release job must depend on BOTH the verify matrix and the aggregate launch decision',
);
assert.match(
  tagWorkflow,
  /if:\s*\$\{\{\s*needs\.launch-decision\.outputs\.decision == 'GO'\s*\}\}/,
  'the release job must run only on an explicit GO',
);
assert.match(
  tagWorkflow,
  /name:\s*Verify downloaded bytes against the approved digest/,
  'the release job must re-hash the downloaded package and compare it with the approved digest',
);
assert.match(
  tagWorkflow,
  /package_sha256:\s*\$\{\{\s*steps\.decide\.outputs\.package_sha256\s*\}\}/,
  'the launch-decision job must publish the approved package digest as an output',
);

// ─── WP5: build once, certify natively, sweep once ──────────────────────────────────────────────
//
// The defects this section pins, in order of how badly each one would have corrupted a decision:
//
//   (a) SIX CANDIDATES. `pnpm pack` is not byte-reproducible (dependency-key ordering), and the
//       aggregate enforces ONE `packageSha256` across every manifest. Six independent builds would
//       therefore produce six digests and a NO-GO on a completely clean tree — evidence of a
//       non-existent defect. The candidate must be built and attested in exactly one job, and every
//       other job must DOWNLOAD it.
//   (b) A SUMMARISED RECEIPT. A manifest carries its own certification summary. The decision must
//       read the raw receipts, so the workflow has to hand them over as files.
//   (c) A DEGRADED CERTIFICATION. A cell with no runner or a signed-out client must leave the cell
//       uncertified and say so by name — never soften into a warning.
{
  const order = (needle) => tagWorkflow.indexOf(needle);

  // (a) exactly one attestation, and the two jobs that pack must not both exist. Counting the
  // digest-producing step is how "build once" is asserted: a second one is a second candidate.
  assert.equal(
    occurrences(tagWorkflow, /name:\s*Attest the candidate package/g),
    1,
    'the package digest must be attested in exactly one job — a second attestation is a second ' +
      'candidate, and pnpm pack is not byte-reproducible, so the aggregate would refuse them',
  );
  assert.match(
    tagWorkflow,
    /package_sha256:\s*\$\{\{\s*steps\.attest\.outputs\.package_sha256\s*\}\}/,
    'the candidate job must publish the attested digest as a job output',
  );
  assert.match(
    tagWorkflow,
    /CANDIDATE_SHA256:\s*\$\{\{\s*needs\.candidate\.outputs\.package_sha256\s*\}\}/,
    'the aggregate must be bound to the ATTESTED digest, never to a digest it computed itself',
  );
  // Every later job downloads those bytes. The pattern is per-job rather than global: the point is
  // that no evidence-producing job is left building its own tarball.
  assert.ok(
    occurrences(tagWorkflow, /name:\s*Download the candidate package/g) >= 3,
    'each evidence-producing job must download the attested candidate rather than pack its own',
  );

  // (b) the RAW receipts reach the aggregate as files, from three separate artifact sets: the
  // per-cell manifests, the twenty-one client receipts, and the global deep-fuzz receipt.
  assert.match(
    tagWorkflow,
    /--certification-receipts launch-evidence\/client-certification-receipts/,
    'the aggregate must receive the raw certification receipts directory',
  );
  assert.match(
    tagWorkflow,
    /--global-receipts launch-evidence\/global-receipts/,
    'the aggregate must receive the raw global (deep-fuzz) receipts directory',
  );
  assert.match(
    tagWorkflow,
    /--candidate-package "\$CANDIDATE_SHA256"/,
    'the aggregate must judge the attested package digest, not a digest it derived',
  );
  assert.ok(
    occurrences(tagWorkflow, /merge-multiple:\s*true/g) >= 3,
    'the manifests, the client receipts and the global receipts must each merge by policy cell id',
  );

  // (c) the certification matrix is the policy's client set × platform set, read from the policy so
  // it widens and narrows with the launch promise instead of drifting from it.
  const policy = JSON.parse(readLF('scripts/launch-policy.json'));
  assert.match(
    tagWorkflow,
    new RegExp(`client:\\s*\\[${policy.clients.join(',\\s*')}\\]`),
    `the certification matrix must cover exactly the policy clients: ${policy.clients.join(', ')}`,
  );
  assert.match(
    tagWorkflow,
    new RegExp(`platform:\\s*\\[${policy.clientPlatforms.join(',\\s*')}\\]`),
    `the certification matrix must cover exactly the policy platforms: ${policy.clientPlatforms.join(', ')}`,
  );
  // A NATIVE host per platform — `self-hosted, certification, <os>` — and never a hosted runner,
  // because WSL satisfies neither linux nor win32 and a hosted runner satisfies neither.
  assert.match(
    tagWorkflow,
    /runs-on:\s*\[self-hosted,\s*certification,\s*'\$\{\{\s*matrix\.platform\s*\}\}'\]/,
    'each certification cell must run on its own native self-hosted runner',
  );
  assert.match(
    tagWorkflow,
    /node scripts\/client-certify\.mjs/,
    'the certification cells must drive the real vendor client through the certification harness',
  );
  assert.match(
    tagWorkflow,
    /--candidate-commit "\$GITHUB_SHA"/,
    'each certification receipt must bind to the tagged commit',
  );

  // The deep sweep runs ONCE, against the attested candidate, at the policy's iteration floor.
  {
    const declared = /--iterations (\d+)/.exec(tagWorkflow);
    assert.ok(declared, 'the tag workflow must state the deep sweep iteration count explicitly');
    assert.ok(
      Number(declared[1]) >= policy.fuzz.requiredIterations,
      `the tag sweep runs ${declared[1]} iterations but the policy requires ` +
        `${policy.fuzz.requiredIterations}; a receipt for the smaller sweep would be refused`,
    );
    assert.match(
      tagWorkflow,
      /--receipt global-receipts\/fuzz-deep\.json/,
      'the tag sweep must write the candidate-bound deep-fuzz receipt',
    );
    assert.match(
      tagWorkflow,
      /--package "\$CANDIDATE_PACKAGE"/,
      'the deep sweep must run against the attested candidate bytes',
    );
    assert.ok(
      order('name: Deep fuzz the candidate') > order('name: Download the candidate package'),
      'the sweep must run after the candidate is downloaded, not against a stale dist/',
    );
  }

  // NOTHING SECRET: credentials live in the platform keychain or the vendor profile, so the
  // workflow may not reference repository secrets at all. `secrets.` anywhere in this file is a
  // design regression — a runner that needs a secret to certify has not been provisioned for
  // certification. The one token used is the automatic, per-run `github.token`, scoped to `contents:
  // write` on the single publishing job.
  assert.doesNotMatch(
    tagWorkflow,
    /\$\{\{\s*secrets\./,
    'credentials are an operational prerequisite held in the platform keychain — the certification ' +
      'workflow must not read repository secrets',
  );
}

// WP9.5 / WP9.3 — a tag is a launch decision: the release gate must demand client runtime
// certification receipts for every advertised platform cell.
assert.match(
  tagWorkflow,
  /--require-runtime-certification/,
  'tag release must require client runtime certification before shipping',
);
// (Which platforms must be certified is asserted from the policy above — it narrows and widens
// with the promise, and hardcoding it here is how the two drift apart.)

assert.match(dependabot, /package-ecosystem:\s*"npm"/, 'Dependabot must monitor npm dependencies');
assert.match(
  dependabot,
  /package-ecosystem:\s*"github-actions"/,
  'Dependabot must monitor GitHub Actions',
);

// M4.3 — crib-soul-refresh workflow shape. The "never stale" differentiator: on every merge, run
// `crib update` and commit the refreshed committed soul back. The behavioral idempotence (the
// property the auto-commit loop relies on) is pinned in scripts/soul-refresh-check.mjs; these
// assertions pin the workflow FILE shape — trigger, the crib update call, loop control, commit scope.
assert.match(
  soulRefreshWorkflow,
  /name:\s*Crib Soul Refresh/,
  'soul-refresh workflow must be named',
);
assert.match(
  soulRefreshWorkflow,
  /on:\n\s+push:\n\s+branches:\n\s+-\s+main\n\s+-\s+master/,
  'soul-refresh must trigger on push to main + master (merge)',
);
assert.match(
  soulRefreshWorkflow,
  /workflow_dispatch:/,
  'soul-refresh must allow manual workflow_dispatch',
);
assert.match(
  soulRefreshWorkflow,
  /contents:\s*write/,
  'soul-refresh needs contents:write to push the refreshed soul back',
);
assert.match(
  soulRefreshWorkflow,
  /node packages\/cli\/dist\/cli\.js update \./,
  'soul-refresh must run the built crib CLI `update` (the incremental re-extract)',
);
assert.match(
  soulRefreshWorkflow,
  /\[skip ci\]/,
  'soul-refresh auto-commit must carry [skip ci] so the push does not re-trigger the workflow',
);
assert.match(
  soulRefreshWorkflow,
  /github\.actor\s*!=\s*'github-actions\[bot\]'/,
  'soul-refresh must skip runs launched by the bot itself (loop-control belt-and-suspenders)',
);
assert.match(
  soulRefreshWorkflow,
  /github-actions\[bot\]@users\.noreply\.github\.com/,
  'soul-refresh commit must be authored by github-actions[bot]',
);
// commit scope: the canonical graph plus dossiers/schema/bootstrap manifest —
// NEVER the gitignored derived .crib/index or .crib/embeddings.
assert.match(
  soulRefreshWorkflow,
  /git add \.crib\/graph \.crib\/dossiers \.crib\/schema \.crib\/crib\.json/,
  'soul-refresh must stage only the committed soul artifacts, never the derived index/embeddings',
);
assert.match(
  soulRefreshWorkflow,
  /git diff --staged --quiet/,
  'soul-refresh must skip the commit when the diff is empty (idempotent no-op)',
);
assert.match(
  soulRefreshWorkflow,
  /fetch-depth:\s*0/,
  'soul-refresh needs full git history for the vcsHead anchor diff',
);
assert.equal(
  occurrences(soulRefreshWorkflow, /contents:\s*write/g),
  1,
  'soul-refresh must define permissions once',
);
assert.equal(
  occurrences(soulRefreshWorkflow, /concurrency:/g),
  1,
  'soul-refresh must define concurrency once',
);

console.log('ci-workflow tests ok');
