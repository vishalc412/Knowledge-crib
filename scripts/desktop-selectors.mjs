#!/usr/bin/env node
/**
 * Versioned UI selector sets for the native editor certification scenarios.
 *
 * The plan's rule: a scenario drives an editor through its accessibility tree using selectors
 * maintained "for the exact tested editor and extension versions" — an unknown editor version
 * produces a NAMED blocker, and a missing control produces a NAMED blocker. Fixed screen
 * coordinates are forbidden as the primary control mechanism, so a selector that pins a point
 * instead of a role/identifier/name is rejected outright.
 *
 * That rule has a consequence this module enforces rather than hides: a selector set only
 * certifies the editor versions a GUI host has actually RECORDED in `testedVersions`. The sets
 * shipped in desktop-selectors.json carry an EMPTY `testedVersions` list on purpose — no GUI host
 * has validated any selector set yet, so every resolution today is a named blocker naming the
 * scenario and platform. A GUI host that runs a scenario appends the exact editor and extension
 * versions it validated; only then does resolution pass. The suite pins this refusal, so a host
 * cannot silently inherit selectors nobody tested.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SELECTORS_FORMAT = 'knowledge-crib-desktop-selectors';
export const SELECTORS_FORMAT_VERSION = 1;
export const DEFAULT_SELECTOR_STORE = resolve(HERE, 'desktop-selectors.json');

/**
 * The controls every scenario must be able to reach, by scenario. A set missing one of these is a
 * named blocker — "the scenario cannot reach the MCP enablement control" — never a silent gap that
 * turns into a mid-scenario timeout.
 */
export const SCENARIO_CONTROL_IDS = {
  copilot: [
    'commandPalette',
    'chatInput',
    'chatSubmit',
    'agentModeIndicator',
    'cribServerToggle',
    'sessionNotice',
  ],
  vscode: [
    'commandPalette',
    'chatInput',
    'chatSubmit',
    'mcpServerList',
    'cribServerToggle',
    'sessionNotice',
  ],
  windsurf: [
    'commandPalette',
    'chatInput',
    'chatSubmit',
    'mcpServerList',
    'cribServerToggle',
    'sessionNotice',
  ],
};

/** Selector keys that name a screen position — the control mechanism the plan forbids. */
const COORDINATE_KEYS = new Set(['x', 'y', 'point', 'position', 'coordinates']);

/**
 * Structural problems with one selector set (an empty array is valid). Pure, so the suite can judge
 * synthetic sets with the same rules the scenario engine judges shipped ones with. Every problem
 * is a named blocker in the making: it names the control or the law it breaks.
 */
export function selectorSetProblems(set, scenario) {
  const problems = [];
  if (!set || typeof set !== 'object') return ['the selector set must be an object'];
  if (set.scenario !== scenario) {
    problems.push(`the selector set names scenario ${set.scenario}, not ${scenario}`);
  }
  if (typeof set.editor !== 'string' || set.editor.length === 0) {
    problems.push('the selector set must name the editor it targets');
  }
  if (!Array.isArray(set.testedVersions)) {
    problems.push(
      'testedVersions must be an array of the exact tested editor and extension versions',
    );
  } else {
    for (const version of set.testedVersions) {
      if (typeof version !== 'string' || version.length === 0) {
        problems.push('every tested version must be a non-empty string');
        break;
      }
    }
  }
  const controls = set.controls;
  if (!controls || typeof controls !== 'object' || Array.isArray(controls)) {
    problems.push('the selector set must carry a controls object');
    return problems;
  }
  for (const control of SCENARIO_CONTROL_IDS[scenario] ?? []) {
    if (!controls[control]) {
      problems.push(`missing control: the ${scenario} scenario cannot reach ${control}`);
    }
  }
  for (const [control, selector] of Object.entries(controls)) {
    if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
      problems.push(`selector for ${control} must be an object of role/identifier/name attributes`);
      continue;
    }
    for (const key of Object.keys(selector)) {
      if (COORDINATE_KEYS.has(key.toLowerCase())) {
        problems.push(
          `fixed-coordinate selector for ${control} is not allowed — accessibility roles, identifiers and names only`,
        );
      }
    }
    if (!('role' in selector)) {
      problems.push(`selector for ${control} names no accessibility role`);
    }
  }
  return problems;
}

/**
 * Load the selector store. The document format is checked before the sets are returned, so a
 * hand-edited store fails at load with the format problem, not at the first resolution.
 */
export function loadSelectorSets(path = DEFAULT_SELECTOR_STORE) {
  if (!existsSync(path)) {
    throw new Error(`the selector store is missing: ${path}`);
  }
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`the selector store at ${path} is not parseable: ${error.message}`);
  }
  if (document?.format !== SELECTORS_FORMAT) {
    throw new Error(`unknown selector store format: ${document?.format}`);
  }
  if (document.formatVersion !== SELECTORS_FORMAT_VERSION) {
    throw new Error(`unsupported selector store version: ${document.formatVersion}`);
  }
  if (!Array.isArray(document.sets)) {
    throw new Error('the selector store must carry a sets array');
  }
  return document.sets;
}

/**
 * Resolve the selector set for one scenario on one platform at one editor version. BLOCKED (with a
 * named reason) unless the store carries a set that a GUI host has recorded as TESTED for exactly
 * this editor version — an unknown version must never inherit a neighbouring version's selectors,
 * because that is precisely how a layout change turns into a certified lie.
 */
export function resolveSelectors(sets, { scenario, platform, editorVersion, editor }) {
  const set = sets.find((s) => s?.scenario === scenario && s?.platform === platform);
  if (!set) {
    return {
      status: 'blocked',
      reason: `no selector set for the ${scenario} scenario on ${platform} — record one for the exact editor version before the scenario can run`,
    };
  }
  const problems = selectorSetProblems(set, scenario);
  if (problems.length > 0) {
    return {
      status: 'blocked',
      reason: `selector set for ${scenario}/${platform} is invalid: ${problems[0]}`,
    };
  }
  if (set.testedVersions.length === 0) {
    return {
      status: 'blocked',
      reason: `the selector set for the ${scenario} scenario on ${platform} has no tested editor versions — a GUI host must validate the scenario against the exact editor and extension versions and record them first`,
    };
  }
  if (!set.testedVersions.includes(editorVersion)) {
    return {
      status: 'blocked',
      reason:
        `editor version ${editorVersion} has no tested selector set for the ${scenario} scenario on ${platform} ` +
        `(tested: ${set.testedVersions.join(', ')})`,
    };
  }
  if (editor && set.editor !== editor) {
    return {
      status: 'blocked',
      reason: `the tested selector set targets ${set.editor}, not ${editor}`,
    };
  }
  return { status: 'pass', set };
}
