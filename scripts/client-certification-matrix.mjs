/** Generate the public client-support table from validated certification receipts. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CERTIFIED_CLIENTS,
  certificationSummary,
  loadClientCertificationReceipts,
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
  'runtime-verified': 'runtime verified',
};

function rank(receipt) {
  if (receipt.evidence.runtime.status === 'pass') return 3;
  if (receipt.evidence.protocol.status === 'pass') return 2;
  return 1;
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
    let stateLabel = DISPLAY_STATES[states[client]];
    if (
      strongest &&
      rank(strongest) === 2 &&
      strongest.evidence.protocol.source === 'test-client'
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
    'Generated from validated receipts. A client is runtime verified only when a vendor-client receipt proves record → interruption/restart → authorized resume on the listed platform. Protocol evidence captured by a test client is labelled "protocol evidence only (test client)" and can never promote a row.',
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
