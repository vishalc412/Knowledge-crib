/** Produce a deliberately small, auditable developer-launch decision from release evidence. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReleaseEvidenceError, validateReleaseEvidence } from './release-evidence.mjs';

export function evaluateLaunchDecision(evidence) {
  const blockers = [
    ...(evidence?.acceptance?.requiredFailures ?? []),
    ...((evidence?.certification?.required === true &&
      evidence.certification.missingRuntimeCells) ||
      []),
  ];
  return {
    decision: blockers.length === 0 && evidence?.acceptance?.pass === true ? 'GO' : 'NO-GO',
    blockers: [...new Set(blockers)],
  };
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
export function aggregateLaunchDecisions(cells) {
  const rows = [];
  const blockers = [];
  for (const entry of cells ?? []) {
    const row = { cell: entry?.cell, decision: 'NO-GO', blockers: [] };
    if (!entry?.manifest) {
      row.blockers.push(`missing-evidence:${row.cell}`);
    } else {
      try {
        validateReleaseEvidence(entry.manifest);
      } catch {
        row.blockers.push(`invalid-evidence:${row.cell}`);
      }
      if (row.blockers.length === 0) {
        const decision = evaluateLaunchDecision(entry.manifest);
        row.decision = decision.decision;
        row.blockers = decision.blockers.map((blocker) => `${row.cell}:${blocker}`);
      }
    }
    rows.push(row);
    blockers.push(...row.blockers);
  }
  if (rows.length === 0) {
    return { decision: 'NO-GO', blockers: ['no-evidence'], cells: rows };
  }
  return {
    decision: rows.every((row) => row.decision === 'GO') ? 'GO' : 'NO-GO',
    blockers: [...new Set(blockers)],
    cells: rows,
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
  const foundCells = new Set(found.map((entry) => entry.cell));
  for (const cell of expectedCells(argv)) {
    if (!foundCells.has(cell)) cells.push({ cell, manifest: null });
  }
  const aggregate = aggregateLaunchDecisions(cells);
  for (const row of aggregate.cells) {
    process.stdout.write(`${row.cell}  ${row.decision}\n`);
    for (const blocker of row.blockers) process.stdout.write(`  - ${blocker}\n`);
  }
  process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
  if (aggregate.decision !== 'GO') process.exitCode = 1;
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
    const decision = evaluateLaunchDecision(evidence);
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    if (decision.decision !== 'GO') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
