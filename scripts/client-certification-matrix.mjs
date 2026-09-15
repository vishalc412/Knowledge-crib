/** Generate the public client-support table from validated certification receipts. */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CERTIFICATION_EVIDENCE_FORMAT_VERSION,
  CERTIFIED_CLIENTS,
  certificationStatus,
  certificationSummary,
  certifyClientCell,
  loadClientCertificationReceipts,
  receiptLegs,
} from './client-certification-evidence.mjs';
import { POLICY_PLATFORMS, loadLaunchPolicy } from './launch-policy.mjs';

// The generated table is tied to the exact frozen contract it certifies under. Loading the policy
// here (not accepting it as an argument) is what ties it: a receipt collected under any other hash
// is demoted below, and the stamp printed in the header is the hash this module judged against.
const { policy: POLICY, sha256: POLICY_SHA256 } = loadLaunchPolicy();

const START = '<!-- client-certification:generated:start -->';
const END = '<!-- client-certification:generated:end -->';
const LABELS = {
  claude: 'Claude Code',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  codex: 'Codex',
  windsurf: 'Windsurf',
  gemini: 'Gemini',
  vscode: 'VS Code',
};
const PLATFORM_NAMES = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
const DISPLAY_STATES = {
  'not-certified': 'not certified',
  'configuration-verified': 'configuration verified',
  'protocol-verified': 'protocol verified',
  'runtime-evidence-only': 'runtime evidence only (not a native runtime)',
  'legacy-evidence-only': 'runtime evidence only (legacy receipt schema)',
  'foreign-policy-evidence': 'runtime evidence only (collected under a different policy)',
  'runtime-verified': 'runtime verified',
};

/** Strength order for the display states, weakest first. */
const STATE_ORDER = [
  'not-certified',
  'configuration-verified',
  'protocol-verified',
  'runtime-evidence-only',
  'legacy-evidence-only',
  'foreign-policy-evidence',
  'runtime-verified',
];

/**
 * The state ONE receipt may display.
 *
 * The leg view says how strong the evidence is; the CELL judgement decides whether it may be shown as
 * a runtime pass at all. Those are not the same question, and collapsing them is how a public table
 * ends up contradicting the launch decision: a WSL run satisfies every leg and can still never be a
 * native Linux or Windows runtime, so its legs must not promote the row that the decision refuses.
 */
function matrixState(receipt) {
  const status = certificationStatus(receipt);
  if (status !== 'runtime-verified') return status;
  // A v1/v2 receipt is readable history from a schema that can no longer certify a cell — but it
  // WAS a native run, and the "not a native runtime" label would claim the run happened somewhere
  // it did not. The legacy schema is named instead, the same fact the launch decision reports.
  if (receipt?.formatVersion !== CERTIFICATION_EVIDENCE_FORMAT_VERSION)
    return 'legacy-evidence-only';
  // A receipt collected under a different policy hash certifies nothing here, however strongly its
  // legs passed: the boundary it was collected against is not the one named in the header above.
  // The same judgement the launch decision makes, stated where the public can read it.
  if (receipt.policySha256 && receipt.policySha256 !== POLICY_SHA256)
    return 'foreign-policy-evidence';
  if (certifyClientCell(receipt).ok) return 'runtime-verified';
  return 'runtime-evidence-only';
}

function rank(receipt) {
  return STATE_ORDER.indexOf(matrixState(receipt));
}

function platformName(receipt) {
  // A WSL run reports process.platform 'linux'; it is labelled WSL and never presented as native.
  return receipt.platform.wsl ? 'WSL' : PLATFORM_NAMES[receipt.platform.os];
}

/**
 * The file a cell's receipt was published as, named — never linked.
 *
 * Receipts are release artifacts published OUTSIDE the candidate source tree, so a repo-relative
 * link would point at a path the repository does not carry; the table names the file instead. The
 * filename is not guessed from the cell: `scripts/client-certify.mjs` writes exactly
 * `client-<client>-<platform>-<arch>.json`, from the same values the receipt records, so for any
 * receipt the shipped certifier produced this resolves to the real file. A receipt placed under
 * any other name resolves to nothing, and the check renders an em-dash rather than naming a file
 * it has not looked for — a public table may not point at evidence it has not seen.
 */
function receiptName(client, os, arch, directory) {
  if (!directory) return '—';
  const name = `client-${client}-${os}-${arch}.json`;
  return existsSync(join(directory, name)) ? `\`${name}\`` : '—';
}

/**
 * The candidate package digest, short enough for a table row and exact in the receipt it names.
 *
 * The commit alone does not identify the candidate bytes — the package is not byte-reproducible —
 * so the row carries the digest the receipt binds. It is a CHECKSUM: without a provenance
 * attestation it says "these bytes", never "these bytes built by whom, from what".
 */
function packageDigest(receipt) {
  const sha = receipt.product?.packageSha256;
  if (typeof sha !== 'string' || !sha.startsWith('sha256:')) return '—';
  return `\`sha256:${sha.slice('sha256:'.length).slice(0, 12)}…\``;
}

/**
 * The advertised cells — every client on every native platform — one row each, from the same
 * validated receipts as the summary above.
 *
 * The summary cannot state the promise. A client row reads "runtime verified" once ONE platform has
 * certified it, so a reader counting rows would take seven of twenty-one cells for done — the exact
 * overstatement the launch decision refuses. Policy version 3 removed the preview tier and made all
 * twenty-one cells hard requirements, so the grid is the only place the boundary is legible.
 *
 * A cell with no receipt reads `not certified` with every remaining field an em-dash. That is the
 * point: there is nothing to show, and a plausible version, commit or date beside an uncertified
 * cell would be a fabricated record of a run that never happened.
 */
function renderCellGrid(receipts, directory) {
  const byCell = new Map();
  for (const receipt of receipts) {
    const key = `${receipt.client.id}/${receipt.platform.os}`;
    const held = byCell.get(key);
    // Rank, not arrival: a WSL run lands on the same `linux` key as a native run, and letting file
    // order decide would let the weaker evidence displace the stronger.
    if (!held || rank(receipt) > rank(held)) byCell.set(key, receipt);
  }
  const rows = [];
  for (const client of CERTIFIED_CLIENTS) {
    for (const os of POLICY_PLATFORMS) {
      const receipt = byCell.get(`${client}/${os}`);
      if (!receipt) {
        rows.push(
          `| ${LABELS[client]} | ${PLATFORM_NAMES[os]} | ${DISPLAY_STATES['not-certified']} | — | — | — | — | — | — |`,
        );
        continue;
      }
      // Same relabel as the summary row: a test-client probe is not the client under test.
      let stateLabel = DISPLAY_STATES[matrixState(receipt)];
      if (
        matrixState(receipt) === 'protocol-verified' &&
        receiptLegs(receipt).handshake.source === 'test-client'
      ) {
        stateLabel = 'protocol evidence only (test client)';
      }
      // The cell stays the REQUIREMENT (`Linux`), never the run's platform: a WSL run reports
      // `linux` and must be shown as failing the Linux cell, not as occupying it. The label says
      // so, and the host column names WSL outright.
      const host = `${receipt.platform.wsl ? 'WSL ' : ''}${receipt.platform.arch} / ${receipt.platform.node}`;
      rows.push(
        `| ${LABELS[client]} | ${PLATFORM_NAMES[os]} | ${stateLabel} | ${receipt.client.version} | ${host} | \`${receipt.product.commit.slice(0, 12)}\` | ${packageDigest(receipt)} | ${receipt.generatedAt.slice(0, 10)} | ${receiptName(client, os, receipt.platform.arch, directory)} |`,
      );
    }
  }
  return [
    '### Cells — every client on every native platform',
    '',
    'One row per advertised cell. A cell is certified only by a vendor-client receipt for that exact client on that native platform; the summary above is per client and can read stronger than any single cell.',
    '',
    '| Client | Platform | Runtime status | Client version | Host | Candidate commit | Package digest | Certified | Receipt |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ];
}

export function renderClientCertificationMatrix(receipts, opts = {}) {
  const states = certificationSummary(receipts);
  const rows = CERTIFIED_CLIENTS.map((client) => {
    const strongest = receipts
      .filter((receipt) => receipt.client.id === client)
      .sort((a, b) => rank(b) - rank(a) || a.platform.os.localeCompare(b.platform.os))[0];
    // The summary is computed per CLIENT across every platform, so it can read stronger than the
    // single strongest receipt shown beside it — a client with a native macOS runtime pass and a WSL
    // Linux run is runtime-verified overall, but the row must disclose which evidence it is showing.
    let stateLabel = strongest
      ? DISPLAY_STATES[matrixState(strongest)]
      : DISPLAY_STATES[states[client]];
    // A test-client protocol probe speaks the protocol shape but is not the client under test, so the
    // row says so instead of reading as a client result. Only a schema-1 receipt can be here: the
    // certifying schema requires a vendor-client source on the handshake and tool-use legs, so it
    // cannot express this claim at all.
    if (
      strongest &&
      matrixState(strongest) === 'protocol-verified' &&
      receiptLegs(strongest).handshake.source === 'test-client'
    ) {
      stateLabel = 'protocol evidence only (test client)';
    }
    const cell = strongest
      ? `${platformName(strongest)} ${strongest.platform.arch} (${strongest.client.version})`
      : '—';
    return `| ${LABELS[client]} | ${stateLabel} | ${cell} |`;
  });
  return [
    START,
    '## Client certification evidence',
    '',
    `Generated under launch policy version ${POLICY.policyVersion} (\`${POLICY_SHA256}\`). Every state below is judged against that exact frozen contract; a receipt naming any other hash is evidence about the run and never a certified cell.`,
    '',
    'Generated from validated receipts. A client is runtime verified only when a vendor-client receipt proves record → interruption/restart → authorized resume on the listed platform. Four labels say a row is evidence and not a runtime pass: "protocol evidence only (test client)" when the handshake came from a test client rather than the client under test, "runtime evidence only (not a native runtime)" when the run happened somewhere other than the native platform — a WSL run satisfies every leg and still cannot certify native Linux or Windows — "runtime evidence only (legacy receipt schema)" when the receipt predates the certifying schema and is kept as readable history, and "runtime evidence only (collected under a different policy)" when the receipt was collected under a policy hash other than the one named above. No label can promote a row.',
    '',
    '| Client | Highest verified evidence | Strongest certified cell |',
    '|---|---|---|',
    ...rows,
    '',
    ...renderCellGrid(receipts, opts.receiptDirectory),
    END,
  ].join('\n');
}

export function replaceGeneratedClientMatrix(document, rendered) {
  const start = document.indexOf(START);
  const end = document.indexOf(END);
  if (start < 0 || end < start) {
    throw new Error('docs/capability-matrix.md is missing client-certification generated markers');
  }
  return `${document.slice(0, start)}${rendered}${document.slice(end + END.length)}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const stdoutMode = argv.includes('--stdout');
  if (stdoutMode && argv.includes('--check'))
    throw new Error(
      '--stdout prints the rendered matrix to stdout; --check compares the docs file against it — pick one',
    );
  const docsIndex = argv.indexOf('--docs');
  const receiptIndex = argv.indexOf('--receipts');
  const docs = resolve(docsIndex >= 0 ? argv[docsIndex + 1] : 'docs/capability-matrix.md');
  // Receipts are release artifacts published outside the candidate source tree, so there is no
  // in-tree default to fall back to: without --receipts the generator claims NOTHING — every cell
  // renders not certified — rather than reading a directory out of the tree it documents.
  let receipts = [];
  let receiptDirectory;
  if (receiptIndex >= 0) {
    const target = argv[receiptIndex + 1];
    if (!target) throw new Error('--receipts requires a directory of published receipts');
    receiptDirectory = resolve(target);
    // Refused loudly, here: loadClientCertificationReceipts answers a missing directory with an
    // empty list, and a typo in the path would otherwise publish a matrix that silently claims
    // nothing is certified rather than failing the operator's command.
    if (!existsSync(receiptDirectory))
      throw new Error(`--receipts directory does not exist: ${receiptDirectory}`);
    receipts = loadClientCertificationReceipts(receiptDirectory);
  }
  const rendered = renderClientCertificationMatrix(receipts, { receiptDirectory });
  if (stdoutMode) {
    // The receipt-backed matrix is PUBLISHED as a release artifact outside the candidate source
    // tree (redirected to the evidence root), never committed into the docs: the committed block
    // stays the zero-receipt contract view, so the release-verify gate — which regenerates it bare —
    // remains valid in every era. The generated-block markers exist for splicing into the docs
    // page and are stripped here so the published artifact is standalone markdown.
    const withoutMarkers = rendered
      .split('\n')
      .filter((line) => line !== START && line !== END)
      .join('\n');
    process.stdout.write(`${withoutMarkers}\n`);
    return;
  }
  const updated = replaceGeneratedClientMatrix(readFileSync(docs, 'utf8'), rendered);
  if (argv.includes('--check')) {
    if (updated !== readFileSync(docs, 'utf8')) {
      throw new Error(
        'generated client certification matrix is stale; run client-certification-matrix.mjs',
      );
    }
    return;
  }
  const tmp = `${docs}.${process.pid}.tmp`;
  writeFileSync(tmp, updated);
  renameSync(tmp, docs);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
