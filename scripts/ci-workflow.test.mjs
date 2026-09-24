import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Windows runners default to core.autocrlf=true, so checked-out YAML carries \r\n line endings
// and the structural regexes below (which match `on:\n  push:`) would fail. A workflow-shape test
// must not depend on the host's line-ending policy, so normalize CRLF → LF at read time.
const readLF = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const workflow = readLF('.github/workflows/beta-installers.yml');
const releaseWorkflow = readLF('.github/workflows/ci.yml');
const tagWorkflow = readLF('.github/workflows/release.yml');
const verifyWorkflow = readLF('.github/workflows/release-verify.yml');
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
  ['release verification', verifyWorkflow],
  ['fuzz nightly', nightlyWorkflow],
]) {
  const actionRefs = [...source.matchAll(/uses:\s+actions\/[\w-]+@([^\s]+)/g)];
  assert.ok(actionRefs.length > 0, `${name} must use GitHub Actions`);
  for (const [, ref] of actionRefs) {
    assert.match(ref, /^[0-9a-f]{40}$/, `${name} action references must use immutable SHAs`);
  }
}

assert.match(tagWorkflow, /tags:\s*\n\s*- ['"]v\*['"]/, 'release workflow must run for v* tags');
// Task 4 — the verification chain is a REUSABLE workflow the tag workflow invokes, so the exact
// chain a tag runs is callable BEFORE publication (workflow_dispatch) instead of being
// discoverable only by cutting a tag.
assert.match(
  tagWorkflow,
  /uses:\s*\.\/\.github\/workflows\/release-verify\.yml/,
  'the tag workflow must invoke the verification chain as a reusable workflow',
);
assert.match(
  verifyWorkflow,
  /workflow_call:\s*\n\s+outputs:\s*\n\s+package_sha256:/,
  'the reusable verification workflow must export the attested digest to its caller',
);
assert.match(
  verifyWorkflow,
  /workflow_dispatch:/,
  'the verification chain must be callable directly, before publication',
);
// Which platforms a TAG verifies on is the launch policy's decision, asserted from the policy
// itself further down rather than from a list that drifts from it.
assert.match(
  verifyWorkflow,
  /corepack pnpm@9\.15\.0 release:verify/,
  'release verification must run the complete release gate',
);
assert.match(
  verifyWorkflow,
  /KCRIB_EMBED_HOME/,
  'release verification must isolate the semantic model cache from the runner home',
);
assert.match(
  verifyWorkflow,
  /embed setup --model large --yes/,
  'release verification must install the supported semantic tier before collecting release evidence',
);
assert.match(
  verifyWorkflow,
  /actions\/upload-artifact@/,
  'release verification must upload the verified bundle',
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
  verifyWorkflow,
  /name:\s*Collect release evidence/,
  'every verification cell must collect release evidence after the collector ran',
);
assert.match(
  verifyWorkflow,
  /name:\s*Upload failure diagnostics\s*\n\s+if:\s*failure\(\)/,
  'failure diagnostics must upload separately from the evidence the decision consumes',
);
assert.doesNotMatch(
  verifyWorkflow,
  /name:\s*Upload release evidence\s*\n\s+if:\s*always\(\)/,
  'a half-finished run must not contribute a manifest to the launch decision',
);

// Task 4 — the COMPLETE acceptance collector runs in every verification cell, in certifying mode:
// it verifies the downloaded bundle against its own manifest checksums, installs it into an
// isolated prefix, and runs all seven checks — each one exercising the INSTALLED candidate and
// writing its own typed receipt, so a missing receipt type is an actionable blocker downstream.
// The workflow's job is to hand it the right directory and the right bytes.
assert.match(
  verifyWorkflow,
  /node scripts\/collect-acceptance-receipts\.mjs\s*\n\s+--out "\$\{\{ runner\.temp \}\}\/evidence\/cells\/\$\{\{ matrix\.os \}\}\/\$\{\{ matrix\.node \}\}"\s*\n\s+--package "\$CANDIDATE_PACKAGE"\s*\n\s+--candidate-commit "\$\(git rev-parse HEAD\)"/,
  'every verification cell must run the complete acceptance collector against the supplied candidate',
);
assert.match(
  verifyWorkflow,
  /--out "\$\{\{ runner\.temp \}\}\/evidence\/cells\/\$\{\{ matrix\.os \}\}\/\$\{\{ matrix\.node \}\}\/manifest\.json"/,
  'the cell manifest must land inside the cell directory the collector filled — one evidence root per cell',
);
assert.match(
  verifyWorkflow,
  /--receipts "\$\{\{ runner\.temp \}\}\/evidence\/cells\/\$\{\{ matrix\.os \}\}\/\$\{\{ matrix\.node \}\}\/receipts"/,
  'release evidence must consume the typed receipts the collector wrote into the cell directory',
);
// Browser binaries on EVERY platform: browser acceptance is one of the checks the collector runs,
// so a cell without Chromium fails the browser check and the cell goes red. The install step used
// to run only on the macOS leg — it must not be conditional.
assert.match(
  verifyWorkflow,
  /name:\s*Install browser binaries\s*\n\s+shell:\s*bash/,
  'browser binaries must be installed on every platform, under bash',
);
assert.doesNotMatch(
  verifyWorkflow,
  /name:\s*Install browser binaries\s*\n\s+if:/,
  'browser acceptance is a TAG requirement on all three operating systems — the install step must not be conditional',
);
assert.match(
  verifyWorkflow,
  /playwright install --with-deps chromium/,
  'the Linux cells must install chromium with its system dependencies',
);
// The steps that expand environment variables pin `shell: bash`. The platform-default shell breaks
// the receipt contract on the windows cells: pwsh expands "$CANDIDATE_PACKAGE" as a PowerShell
// variable (empty), so the collector would be handed a missing package and the manifest written
// from it would refuse — a receipt can never describe a check that never ran.
for (const step of [
  'Run the complete acceptance collector',
  'Collect release evidence',
  'Install browser binaries',
  'Certify \\$\\{\\{ matrix\\.client \\}\\}',
  'Execute deep fuzz \\(10\\^6 iters/extractor\\)',
]) {
  assert.match(
    verifyWorkflow,
    new RegExp(`name:\\s*${step}[\\s\\S]{0,600}?shell:\\s*bash`),
    `${step} must pin shell: bash — the receipt contract dies on the windows default shell`,
  );
}

// The verify matrix must be the policy's cell set — EXACTLY, in both directions. A matrix smaller
// than the policy fails aggregation on a missing cell; a matrix larger than it uploads manifests
// for cells the launch does not claim, which are then judged against requirements their legs never
// produce. So this reads the committed policy rather than hardcoding a list.
{
  const policy = JSON.parse(readLF('scripts/launch-policy.json'));
  const declared = new Set(policy.osNodeCells.map((cell) => cell.split('/')[0]));
  const nodes = [...new Set(policy.osNodeCells.map((cell) => cell.split('/')[1]))].sort();
  assert.match(
    verifyWorkflow,
    new RegExp(`node:\\s*\\[${nodes.map((n) => `'${n}'`).join(',\\s*')}\\]`),
    `the release verify matrix must cover exactly Node ${nodes.join(' and ')}`,
  );
  for (const os of declared) {
    assert.ok(verifyWorkflow.includes(`- ${os}`), `the release verify matrix must cover ${os}`);
  }
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
    if (declared.has(os)) continue;
    assert.ok(
      !new RegExp(`^\\s+- ${os}$`, 'm').test(verifyWorkflow),
      `${os} is not in the launch policy, so the release matrix must not emit evidence for it`,
    );
  }
  // The certification platforms the tag demands must match the policy's too.
  assert.ok(
    verifyWorkflow.includes(`--certification-platforms ${policy.clientPlatforms.join(',')}`),
    'the verification chain must require certification for exactly the policy platforms',
  );
}

// The aggregate must see EVERY evidence source, and `needs` is the only thing that makes it wait.
//
// The defect this pins: the decision must never be computed over a partially-written evidence
// directory — e.g. while the twenty-one certification jobs and the deep sweep are still running.
// The caller therefore needs the WHOLE reusable verification chain: a caller job that `uses` a
// reusable workflow completes only when every job inside it has, so `needs: [verification]`
// subsumes the candidate, the verify matrix, the certification jobs and the sweep. Absent evidence
// is a NO-GO, which means a race does not publish a bad release; it publishes a NO-GO on a release
// that was actually clean, and a decision that is wrong in the safe direction is still wrong.
assert.match(
  tagWorkflow,
  /launch-decision:\s*\n\s+name:\s*Aggregate launch decision\s*\n\s+needs:\s*\[verification\]/,
  'the launch-decision job must wait for the whole verification chain — anything less computes ' +
    'the decision over a partially-written directory',
);
assert.match(
  tagWorkflow,
  /launch-decision:\s*\n\s+name:\s*Aggregate launch decision\s*\n\s+needs:\s*\[verification\]\s*\n\s+if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}/,
  'launch-decision must run even when a required verification job fails (if: !cancelled()), and the ' +
    'guard belongs to the decision job itself — a bare if: anywhere in the file could sit on a job ' +
    'that never runs on the failure path',
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
  /--candidate-commit "\$\(git rev-parse HEAD\)"/,
  'the aggregate must be bound to the commit the checkout holds, not to $GITHUB_SHA (an annotated ' +
    'tag puts the TAG OBJECT sha there) and not to whatever the manifests claim',
);
assert.match(
  tagWorkflow,
  /--json-out decision\.json/,
  'the aggregate must write its pure JSON to decision.json — stdout carries the per-cell table and ' +
    'blocker lines in front of the JSON, and a blocker line can itself contain a brace',
);
assert.match(
  tagWorkflow,
  /decision=NO-GO/,
  'an unattested candidate must still produce a NO-GO verdict by name — a run that ends in a red ' +
    'matrix with no decision is the silent NO-GO this job exists to prevent',
);

// ORDER matters as much as presence: the receipt is the LAST thing a cell writes, so a mandatory
// command that fails after evidence generation cannot exist — there is nothing after it.
{
  const order = (needle) => verifyWorkflow.indexOf(needle);
  const collect = order('name: Collect release evidence');
  for (const step of [
    'name: Run release gate',
    'name: Install browser binaries',
    'name: Run the complete acceptance collector',
  ]) {
    assert.ok(order(step) > 0, `the verification workflow must contain "${step}"`);
    assert.ok(
      order(step) < collect,
      `"${step}" must run BEFORE the final receipt is written, or the receipt could describe work that had not happened`,
    );
  }
  assert.ok(
    order('name: Upload release evidence') > collect,
    'the cell evidence is uploaded only after the manifest for it exists',
  );
  assert.ok(
    order('name: Upload verified bundle') > collect,
    'the bundle is uploaded only after the evidence for it exists',
  );
}

// THE gate: publication needs verification AND approval, and ships only the approved bytes.
assert.match(
  tagWorkflow,
  /needs:\s*\[verification,\s*launch-decision\]/,
  'the release job must depend on BOTH the verification chain and the aggregate launch decision',
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
  const order = (needle) => verifyWorkflow.indexOf(needle);

  // (a) exactly one attestation, and the two jobs that pack must not both exist. Counting the
  // digest-producing step is how "build once" is asserted: a second one is a second candidate.
  assert.equal(
    occurrences(verifyWorkflow, /name:\s*Attest the candidate package/g),
    1,
    'the package digest must be attested in exactly one job — a second attestation is a second ' +
      'candidate, and pnpm pack is not byte-reproducible, so the aggregate would refuse them',
  );
  assert.match(
    verifyWorkflow,
    /package_sha256:\s*\$\{\{\s*steps\.attest\.outputs\.package_sha256\s*\}\}/,
    'the candidate job must publish the attested digest as a job output',
  );
  assert.match(
    tagWorkflow,
    /CANDIDATE_SHA256:\s*\$\{\{\s*needs\.verification\.outputs\.package_sha256\s*\}\}/,
    'the aggregate must be bound to the ATTESTED digest the verification chain exported, never to ' +
      'a digest it computed itself',
  );
  // Every later job downloads those bytes. The pattern is per-job rather than global: the point is
  // that no evidence-producing job is left building its own tarball.
  assert.ok(
    occurrences(verifyWorkflow, /name:\s*Download the candidate package/g) >= 3,
    'each evidence-producing job must download the attested candidate rather than pack its own',
  );

  // (b) the RAW receipts reach the aggregate as files, from three separate artifact sets: the
  // per-cell manifests, the twenty-one client receipts, and the global deep-fuzz receipt.
  assert.match(
    tagWorkflow,
    /--certification-receipts evidence\/clients/,
    'the aggregate must receive the raw certification receipts directory',
  );
  assert.match(
    tagWorkflow,
    /--global-receipts evidence\/global/,
    'the aggregate must receive the raw global (deep-fuzz) receipts directory',
  );
  assert.match(
    tagWorkflow,
    /--candidate-package "\$CANDIDATE_SHA256"/,
    'the aggregate must judge the attested package digest, not a digest it derived',
  );
  assert.ok(
    occurrences(tagWorkflow, /merge-multiple:\s*true/g) +
      occurrences(verifyWorkflow, /merge-multiple:\s*true/g) >=
      3,
    'the cell manifests, the client receipts and the global receipts must each merge into their own root',
  );

  // (c) the certification matrix is the policy's client set × platform set, read from the policy so
  // it widens and narrows with the launch promise instead of drifting from it.
  const policy = JSON.parse(readLF('scripts/launch-policy.json'));
  assert.match(
    verifyWorkflow,
    new RegExp(`client:\\s*\\[${policy.clients.join(',\\s*')}\\]`),
    `the certification matrix must cover exactly the policy clients: ${policy.clients.join(', ')}`,
  );
  assert.match(
    verifyWorkflow,
    new RegExp(`platform:\\s*\\[${policy.clientPlatforms.join(',\\s*')}\\]`),
    `the certification matrix must cover exactly the policy platforms: ${policy.clientPlatforms.join(', ')}`,
  );
  // A NATIVE host per platform — `self-hosted, certification, <os>` — and never a hosted runner,
  // because WSL satisfies neither linux nor win32 and a hosted runner satisfies neither.
  assert.match(
    verifyWorkflow,
    /runs-on:\s*\[self-hosted,\s*certification,\s*'\$\{\{\s*matrix\.platform\s*\}\}'\]/,
    'each certification cell must run on its own native self-hosted runner',
  );
  assert.match(
    verifyWorkflow,
    /node scripts\/client-certify\.mjs/,
    'the certification cells must drive the real vendor client through the certification harness',
  );
  assert.match(
    verifyWorkflow,
    /--candidate-commit "\$\(git rev-parse HEAD\)"/,
    'each certification receipt must bind to the peeled commit the checkout holds — $GITHUB_SHA on an ' +
      'annotated tag is the TAG OBJECT sha, which no receipt or manifest ever binds to',
  );

  // The deep sweep runs ONCE, against the attested candidate, at the policy's iteration floor.
  {
    const declared = /--iterations (\d+)/.exec(verifyWorkflow);
    assert.ok(
      declared,
      'the verification workflow must state the deep sweep iteration count explicitly',
    );
    assert.ok(
      Number(declared[1]) >= policy.fuzz.requiredIterations,
      `the verification sweep runs ${declared[1]} iterations but the policy requires ` +
        `${policy.fuzz.requiredIterations}; a receipt for the smaller sweep would be refused`,
    );
    assert.match(
      verifyWorkflow,
      /--receipt "\$\{\{ runner\.temp \}\}\/evidence\/global\/fuzz-deep\.json"/,
      'the verification sweep must write the candidate-bound deep-fuzz receipt outside the checkout',
    );
    assert.match(
      verifyWorkflow,
      /--package "\$CANDIDATE_PACKAGE"/,
      'the deep sweep must run against the attested candidate bytes',
    );
    assert.ok(
      order('name: Deep fuzz the candidate') > order('name: Download the candidate package'),
      'the sweep must run after the candidate is downloaded, not against a stale dist/',
    );
  }

  // NOTHING SECRET: credentials live in the platform keychain or the vendor profile, so neither
  // workflow may reference repository secrets at all. `secrets.` anywhere in either file is a
  // design regression — a runner that needs a secret to certify has not been provisioned for
  // certification. The one token used is the automatic, per-run `github.token`, scoped to
  // `contents: write` on the single publishing job.
  for (const [name, source] of [
    ['the tag workflow', tagWorkflow],
    ['the verification workflow', verifyWorkflow],
  ]) {
    assert.doesNotMatch(
      source,
      /\$\{\{\s*secrets\./,
      `credentials are an operational prerequisite held in the platform keychain — ${name} must not read repository secrets`,
    );
  }
}

// ─── Task 10: preflight the certification host, serialize the desktop per platform ──────────────
//
// The defect this section pins: a certification cell scheduled onto an unprovisioned host used to
// burn its full budget discovering that — a five-minute run ending in "not signed in", or a launch
// left queued forever. The host preflight (scripts/host-preflight.mjs) must run BEFORE any
// expensive work and publish its report unconditionally, so missing infrastructure is a named
// preflight failure with uploaded blockers, not a timeout.
{
  // The certify job block, sliced so the order assertions below judge THIS job's steps — the
  // candidate and verify jobs carry identically named steps (Checkout, Setup Node).
  const certifyStart = verifyWorkflow.indexOf('  certify:');
  assert.ok(certifyStart >= 0, 'the verification workflow must have a certify job');
  const certifyJob = verifyWorkflow.slice(certifyStart, verifyWorkflow.indexOf('  verify:'));
  const certifyOrder = (needle) => certifyJob.indexOf(needle);

  // Existence first: every order comparison below is an indexOf difference, and a DELETED step
  // turns its indexOf into -1, making some pins pass vacuously — delete the preflight step and
  // "preflight runs before install" reads "-1 < 40", true; delete Checkout and "preflight runs
  // after checkout" reads "40 > -1", also true. A deleted step must fail HERE, named, never feed
  // an order pin vacuous arithmetic.
  for (const step of [
    'name: Preflight the certification host',
    'name: Checkout',
    'uses: actions/setup-node@',
    'name: Install dependencies',
  ]) {
    assert.ok(
      certifyOrder(step) >= 0,
      `the certify job must still have a step matching "${step}" — an order pin against a deleted step is vacuous`,
    );
  }

  // The preflight runs after Checkout and Setup Node — it is a Node script, so a host without node
  // on PATH must fail on a missing interpreter AFTER the runner image named it, never as an
  // anonymous "command not found" in place of the blockers — and BEFORE any expensive work
  // (dependency install, candidate download, the 120-minute certification).
  assert.ok(
    certifyOrder('name: Preflight the certification host') > certifyOrder('name: Checkout'),
    'the host preflight must run after the checkout — it executes scripts/host-preflight.mjs',
  );
  assert.ok(
    certifyOrder('name: Preflight the certification host') >
      certifyOrder('uses: actions/setup-node@'),
    'the host preflight must run after Node is set up — on a host without node on PATH it would die ' +
      'on a missing interpreter instead of naming its blockers',
  );
  assert.ok(
    certifyOrder('name: Preflight the certification host') <
      certifyOrder('name: Install dependencies'),
    'the preflight must run before the expensive work — a host missing infrastructure fails in ' +
      'seconds with named blockers, never as a five-minute run ending in "not signed in"',
  );
  assert.match(
    certifyJob,
    /node scripts\/host-preflight\.mjs/,
    'the preflight step must invoke the host preflight module',
  );
  assert.match(
    certifyJob,
    /--platform \$\{\{ matrix\.platform \}\}/,
    'the preflight must be told which platform cell it is validating',
  );
  assert.match(
    certifyJob,
    /--json "\$\{\{ runner\.temp \}\}\/certify-preflight\/r\$\{\{ github\.run_id \}\}a\$\{\{ github\.run_attempt \}\}\/preflight\.json"/,
    'the preflight report must go to a run-scoped directory outside the checkout — a self-hosted ' +
      "runner's disk persists between runs, and a previous run's report must never sit in this " +
      "pass's output",
  );

  // The report uploads UNCONDITIONALLY: a blocked preflight's named blockers are the diagnostic,
  // and "the run was killed before the preflight wrote anything" must stay a distinct fact
  // (if-no-files-found: warn) rather than a masked one. Pinned against the upload STEP's own block,
  // not the whole job — any other upload in the job would otherwise satisfy a whole-job pin, and
  // the per-cell name and the preflight path must belong to THIS step.
  const uploadStep = certifyJob
    .split('\n      - name:')
    .find((block) => /Upload the host preflight report/.test(block));
  assert.ok(uploadStep, 'the certify job must have a preflight report upload step');
  assert.match(
    uploadStep,
    /Upload the host preflight report\s*\n\s*if:\s*always\(\)\s*\n\s*uses:\s*actions\/upload-artifact@/,
    'the preflight report must upload even when the preflight blocked — the blockers are the diagnostic',
  );
  assert.match(
    uploadStep,
    /name:\s*certify-preflight-\$\{\{ matrix\.client \}\}-\$\{\{ matrix\.platform \}\}/,
    'the preflight report artifact must be per-cell — the seven clients of one platform queue on ' +
      'the same host, and each must publish its own report',
  );
  assert.match(
    uploadStep,
    /if-no-files-found:\s*warn/,
    '"the preflight never wrote a report" must be its own signal, not a silent success',
  );
  assert.match(
    uploadStep,
    /path:\s*\$\{\{ runner\.temp \}\}\/certify-preflight\/r\$\{\{ github\.run_id \}\}a\$\{\{ github\.run_attempt \}\}\//,
    'the upload must carry the preflight report DIRECTORY this run wrote — a wrong path uploads ' +
      'nothing while if-no-files-found: warn reports the absence, which is the failure this pin names',
  );

  // GUI execution is serialized per platform WITHOUT a job-level concurrency group. A concurrency
  // group admits one running and one pending job and CANCELS any further queued matrix cell to
  // admit a newer arrival, so `concurrency: certification-${{ matrix.platform }}` would turn the
  // seven-client queue into missing receipts — exactly the missing-evidence failure this workflow
  // must not manufacture. Serialization comes from the ONE registered runner per platform (a
  // self-hosted runner executes one job at a time; Actions queues every further cell indefinitely)
  // plus the scenario harness's per-platform desktop lock. This negative pin keeps a future change
  // from "fixing" serialization with a stanza that silently cancels cells. The pattern allows
  // leading whitespace because a JOB-level stanza is INDENTED under the job key — anchoring at
  // column 0 would miss exactly the regression this pin exists to catch — while the header comment
  // explaining the design starts with `#` and never matches.
  assert.doesNotMatch(
    verifyWorkflow,
    /^[ \t]*concurrency:/m,
    'per-platform serialization must NOT use a concurrency group — it cancels the queued matrix ' +
      'cells (one running + one pending, newest arrival wins), manufacturing missing receipts',
  );
}

// WP9.5 / WP9.3 — a tag is a launch decision: the release gate must demand client runtime
// certification receipts for every advertised platform cell.
assert.match(
  verifyWorkflow,
  /--require-runtime-certification/,
  'release verification must require client runtime certification before shipping',
);
// (Which platforms must be certified is asserted from the policy above — it narrows and widens
// with the promise, and hardcoding it here is how the two drift apart.)

// ─── Task 4: explicit artifact roots, complete evidence, re-run-safe uploads ─────────────────────
//
// The defects this section pins:
//
//   (d) THREE SEPARATE EVIDENCE ROOTS. The old workflow downloaded the client and global receipts
//       INTO the cells tree, where the cells discovery walked arbitrary JSON — valid receipts
//       could be read as bogus OS/Node cells. The caller now reconstructs cells/, clients/ and
//       global/ as siblings, and the decision reads cells ONLY from the six policy-declared
//       manifest locations.
//   (e) EVIDENCE OUTSIDE THE CHECKOUT. The collector refuses a dirty working tree and the launch
//       decision refuses any manifest whose candidate is dirty, so a receipt written inside the
//       checkout would fail the very checks it is evidence for.
//   (f) REUSED OUTPUT DIRECTORIES. A certification runner is self-hosted: its disk persists between
//       runs, so its receipts directory must be scoped by run id and attempt.
//   (g) FLATTENED BUNDLES. upload-artifact treats a single-directory path as "upload the CONTENTS"
//       (least-common-ancestor rule); a trailing slash on the bundle path strips the
//       `knowledge-crib-<version>/` wrapper, and the collector takes the tarball's PARENT as the
//       bundle directory — a flattened download has no manifest beside the tarball to verify against.
//   (h) IMMUTABLE ARTIFACTS. Artifacts persist across re-run attempts of a run, so a re-executed
//       job re-uploading the same name would 409 against its own previous attempt. Every upload
//       carries `overwrite: true`: a re-executed job replaces ONLY its own output, and jobs that
//       did not re-run keep their original artifacts.
assert.match(
  tagWorkflow,
  /pattern:\s*release-evidence-\*\s*\n\s+path:\s*evidence\s*\n\s+merge-multiple:\s*true/,
  'the per-cell evidence must merge into ONE cells root',
);
assert.match(
  tagWorkflow,
  /pattern:\s*client-certification-\*\s*\n\s+path:\s*evidence\/clients/,
  'the vendor receipts must land in their OWN root, outside the cells tree',
);
assert.match(
  tagWorkflow,
  /name:\s*global-receipts\s*\n\s+path:\s*evidence\/global/,
  'the global receipts must land in their OWN root, outside the cells tree',
);
assert.match(
  verifyWorkflow,
  /name:\s*global-receipts\s*\n\s+path:\s*\$\{\{ runner\.temp \}\}\/evidence\/global/,
  'the global receipts must upload from their own root outside the checkout — a receipt or ' +
    'transcript written inside the tree fails the dirty-tree checks it is evidence for',
);
assert.match(
  tagWorkflow,
  /--cells evidence\/cells/,
  'the aggregate must read cells from the dedicated cells root',
);
assert.match(
  verifyWorkflow,
  /pattern:\s*client-certification-\*\s*\n\s+path:\s*\$\{\{ runner\.temp \}\}\/evidence\/cells\/\$\{\{ matrix\.os \}\}\/\$\{\{ matrix\.node \}\}\/receipts\s*\n\s+merge-multiple:\s*true/,
  'each cell must see the raw vendor receipts in its own receipts directory, outside the checkout',
);
assert.match(
  verifyWorkflow,
  /--out "\$\{\{ runner\.temp \}\}\/certify-receipts\/r\$\{\{ github\.run_id \}\}a\$\{\{ github\.run_attempt \}\}"/,
  "certification receipts must go to a run-scoped output directory — a self-hosted runner's disk " +
    "persists between runs, and a previous run's receipt must never sit in this pass's --out",
);
assert.match(
  verifyWorkflow,
  /path:\s*\$\{\{ runner\.temp \}\}\/certify-receipts\/r\$\{\{ github\.run_id \}\}a\$\{\{ github\.run_attempt \}\}\/\s*\n\s+if-no-files-found:\s*warn/,
  'the certification upload must read exactly the run-scoped directory the certify step wrote — a ' +
    'run killed before it wrote anything must stay a different fact from a receipt that says blocked',
);
{
  const outs = [...verifyWorkflow.matchAll(/--out "([^"]+)"/g)];
  assert.ok(outs.length >= 2, 'the verification workflow must state its evidence output paths');
  for (const [, out] of outs) {
    assert.ok(
      out.startsWith('${{ runner.temp }}/'),
      `evidence output ${out} must live outside the checkout — the collector refuses a dirty tree and the decision refuses a dirty candidate`,
    );
  }
}
assert.ok(
  occurrences(verifyWorkflow, /path:\s*dist\/installers\/knowledge-crib-\*\s*\n/g) >= 2,
  'the candidate and verified-bundle uploads must keep the complete bundle directory layout',
);
assert.doesNotMatch(
  verifyWorkflow,
  /dist\/installers\/knowledge-crib-\*\/\s*\n/,
  'a trailing slash on the bundle upload path flattens the artifact — the layout must be preserved',
);
assert.match(
  verifyWorkflow,
  /name:\s*release-evidence-\$\{\{ matrix\.os \}\}-node\$\{\{ matrix\.node \}\}[\s\S]{0,200}?path:\s*\$\{\{ runner\.temp \}\}\/evidence\/\s*\n/,
  'the cell artifact must be rooted one level up, so a merge download reconstructs cells/<os>/<node>/…',
);
assert.match(
  verifyWorkflow,
  /name:\s*release-diagnostics-\$\{\{ matrix\.os \}\}-node\$\{\{ matrix\.node \}\}/,
  'failure diagnostics must upload under a name no evidence download pattern matches',
);
for (const [name, source] of [
  ['tag release', tagWorkflow],
  ['release verification', verifyWorkflow],
]) {
  const uploads = occurrences(source, /uses:\s+actions\/upload-artifact@/g);
  // The trailing newline keeps this a YAML key, not the phrase inside a comment that explains
  // the rule — the comments say "overwrite: true" too, and must not count as pins.
  const overwrites = occurrences(source, /\boverwrite:\s*true\s*\n/g);
  assert.ok(uploads > 0, `${name} must upload artifacts`);
  assert.equal(
    overwrites,
    uploads,
    `every ${name} upload must carry overwrite: true — a re-executed job replaces only its own artifact`,
  );
}

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
  /on:\n\s+push:\n\s+branches:\n\s+-\s+main\n\s+-\s+master\n(?:\s+#.*\n)*\s+-\s+Master\n/,
  'soul-refresh must trigger on push to main + master + Master (the real default branch; filters are case-sensitive)',
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

// Branch filters are case-sensitive and the default branch is `Master`. Every push-triggered
// workflow that names the lowercase spellings must also name the real one, or it never fires on a
// merge — the defect that kept CI and soul-refresh from ever running on the default branch.
for (const [name, text] of [
  ['ci.yml', releaseWorkflow],
  ['beta-installers.yml', workflow],
  ['crib-soul-refresh.yml', soulRefreshWorkflow],
]) {
  const push = text.match(/\n {2}push:\n {4}branches:\n((?: {6}.*\n)+)/);
  assert.ok(push, `${name} must declare push branches`);
  assert.match(
    push[1],
    /^ {6}- Master$/m,
    `${name} push trigger must name the default branch Master`,
  );
}

// The cross-platform matrix runs after the release gate but must not be SKIPPED by its failure.
const matrixJob = releaseWorkflow.match(/\n {2}verify-matrix:\n((?: {4}.*\n|\s*\n)+?) {4}steps:/);
assert.ok(matrixJob, 'ci.yml must define verify-matrix');
assert.match(matrixJob[1], /needs:\s*release-gate/, 'verify-matrix stays ordered after the gate');
assert.match(
  matrixJob[1],
  /if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}/,
  'verify-matrix must run even when the release gate fails',
);
process.stdout.write('ci-workflow branch-filter and matrix assertions ok\n');
