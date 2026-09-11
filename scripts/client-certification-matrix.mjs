/** Generate the public client-support table from validated certification receipts. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CERTIFIED_CLIENTS,
  certificationStatus,
  certificationSummary,
  certifyClientCell,
  loadClientCertificationReceipts,
  receiptLegs,
} from './client-certification-evidence.mjs';

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
  'runtime-verified': 'runtime verified',
};

/** Strength order for the display states, weakest first. */
const STATE_ORDER = [
  'not-certified',
  'configuration-verified',
  'protocol-verified',
  'runtime-evidence-only',
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
  return certifyClientCell(receipt).ok ? 'runtime-verified' : 'runtime-evidence-only';
}

function rank(receipt) {
  return STATE_ORDER.indexOf(matrixState(receipt));
}

function platformName(receipt) {
  // A WSL run reports process.platform 'linux'; it is labelled WSL and never presented as native.
  return receipt.platform.wsl ? 'WSL' : PLATFORM_NAMES[receipt.platform.os];
}

export function renderClientCertificationMatrix(receipts) {
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
    'Generated from validated receipts. A client is runtime verified only when a vendor-client receipt proves record → interruption/restart → authorized resume on the listed platform. Two labels say a row is evidence and not a runtime pass: "protocol evidence only (test client)" when the handshake came from a test client rather than the client under test, and "runtime evidence only (not a native runtime)" when the run happened somewhere other than the native platform — a WSL run satisfies every leg and still cannot certify native Linux or Windows. Neither label can promote a row.',
    '',
    '| Client | Highest verified evidence | Strongest certified cell |',
    '|---|---|---|',
    ...rows,
    '',
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
  const docsIndex = argv.indexOf('--docs');
  const receiptIndex = argv.indexOf('--receipts');
  const docs = resolve(docsIndex >= 0 ? argv[docsIndex + 1] : 'docs/capability-matrix.md');
  const receiptDirectory = resolve(
    receiptIndex >= 0 ? argv[receiptIndex + 1] : 'docs/launch/client-certification-receipts',
  );
  const updated = replaceGeneratedClientMatrix(
    readFileSync(docs, 'utf8'),
    renderClientCertificationMatrix(loadClientCertificationReceipts(receiptDirectory)),
  );
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
