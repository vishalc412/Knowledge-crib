/**
 * Stable locators + reattachment matching (PRD §2 "Freshness and refactor survival").
 *
 * Symbol IDs currently contain file + line information (`sym:<path>#<qualifiedName>@L<line>`), so ID
 * equality alone breaks when a symbol moves or its body shifts line. The evaluator instead builds a
 * {@link StableLocator} from the live soul node at save time and, at revalidation, when the exact id
 * no longer resolves, searches the live soul for nodes matching the locator. Reattachment succeeds
 * only when EXACTLY ONE candidate matches (PRD: "Require exactly one candidate"); multiple matches
 * mark the record `needs-review` and ambiguous matches are excluded from normal recall.
 *
 * The locator signals (PRD line 173): "artifact kind, qualified name, signature, path hints, heading
 * anchor, and content fingerprint." A node's `hash` is the content fingerprint (changes iff content
 * changes); `qualifiedName`/`signature` disambiguate overloads; `file` yields path hints; `anchor`
 * is the doc-section heading anchor; `kind` (+ `artifactType` for agent-artifacts) is the artifact
 * kind. All PURE over the soul node — no disk, no network.
 */
import type { Node } from '@knowledge-crib/soul-schema';

/**
 * The stable reattachment signals derived from a soul node (or, when the node is gone, parsed from a
 * stale evidence's `soulId`/`anchor`/`targetHash`). Enough to find a moved symbol uniquely without
 * relying on the line-bearing id.
 */
export interface StableLocator {
  /** the node `kind` (e.g. 'symbol', 'doc-section', 'agent-artifact'). */
  artifactKind: string;
  /** for `agent-artifact` nodes, the artifact class (instruction/skill/agent/…); absent otherwise. */
  artifactType?: string;
  /** the symbol's qualified name (e.g. 'A.b' / 'MemoryStore.upsertEntries'). */
  qualifiedName?: string;
  /** the simple name (node.name) — a fallback when qualifiedName is absent. */
  name?: string;
  /** the symbol signature text — disambiguates overloads. */
  signature?: string;
  /** path hints — the file(s) the target lived in (basename + full repo-relative path). */
  pathHints: string[];
  /** the doc-section heading anchor (`doc:<path>#<anchor>`). */
  headingAnchor?: string;
  /** content fingerprint — the node `hash` (the evidence `targetHash` / `policyHash`). */
  contentFingerprint?: string;
}

/** Parse a soul id into its components. Returns `undefined` for a non-soul / malformed id. */
export interface ParsedSoulId {
  prefix: string;
  path?: string;
  /** the `#<…>` fragment — qualifiedName for sym/comp/field, anchor for doc, name for art/cursor. */
  name?: string;
  anchor?: string;
  /** the `@L<line>` start line, when present. */
  line?: number;
}

/**
 * Parse a soul id grammar (`sym:<path>#<qname>@L<line>`, `doc:<path>#<anchor>`, `art:<path>#<name>`,
 * `comp:<path>#<qname>@L<line>`, `field:<path>#<qname>@L<line>`, …) into its parts. Tolerant: returns
 * `undefined` only when the id is not a `prefix:…` string. Used to rebuild a locator from a STALE id
 * (the node is gone) so reattachment can still search by name + path.
 */
export function parseSoulId(id: string | undefined): ParsedSoulId | undefined {
  if (!id || typeof id !== 'string') return undefined;
  const colon = id.indexOf(':');
  if (colon <= 0) return undefined;
  const prefix = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  const parsed: ParsedSoulId = { prefix };
  // split off a trailing @L<line> (start line) if present
  const atIdx = rest.lastIndexOf('@L');
  let body = rest;
  if (atIdx > 0) {
    const linePart = rest.slice(atIdx + 2);
    const n = Number.parseInt(linePart, 10);
    if (Number.isFinite(n) && n > 0) {
      parsed.line = n;
      body = rest.slice(0, atIdx);
    }
  }
  // split the #<fragment> (qualifiedName / anchor / name)
  const hashIdx = body.indexOf('#');
  if (hashIdx >= 0) {
    parsed.path = body.slice(0, hashIdx);
    const frag = body.slice(hashIdx + 1);
    if (prefix === 'doc') parsed.anchor = frag;
    else parsed.name = frag;
  } else {
    // no #fragment: the whole body is the path (file:, expl:, stmt:, …) or a non-path payload
    if (body.length > 0 && body.includes('/')) parsed.path = body;
  }
  return parsed;
}

/** Derive path hints (basename + full path) from a repo-relative file path. */
function pathHintsFor(file: string | undefined): string[] {
  if (!file) return [];
  const hints = [file];
  const base = file.split('/').pop();
  if (base && base !== file) hints.push(base);
  return hints;
}

/** Build a locator from a LIVE soul node (the save-time snapshot — the node is present). */
export function buildLocator(node: Node): StableLocator {
  return {
    artifactKind: node.kind,
    ...(node.artifactType ? { artifactType: node.artifactType } : {}),
    ...(node.qualifiedName ? { qualifiedName: node.qualifiedName } : {}),
    ...(node.name ? { name: node.name } : {}),
    ...(node.signature ? { signature: node.signature } : {}),
    pathHints: pathHintsFor(node.file),
    ...(node.anchor ? { headingAnchor: node.anchor } : {}),
    contentFingerprint: node.hash,
  };
}

/**
 * Build a locator from a STALE evidence item (the node is GONE — the id no longer resolves). Derives
 * artifact-kind + qualified-name/anchor + path hints + content fingerprint from the evidence's
 * `soulId`/`artifactId`/`anchor`/`targetHash`. Returns `undefined` when the evidence carries no
 * stable anchor at all (e.g. a human-attestation — those have no code target and never reattach).
 */
export function buildLocatorFromEvidence(ev: {
  soulId?: string;
  artifactId?: string;
  anchor?: string;
  targetHash?: string;
  quote?: string;
}): StableLocator | undefined {
  const anchorId = ev.artifactId ?? ev.soulId;
  const parsed = parseSoulId(anchorId);
  if (!parsed) return undefined;
  const locator: StableLocator = {
    artifactKind: kindForPrefix(parsed.prefix),
    pathHints: parsed.path ? pathHintsFor(parsed.path) : [],
    ...(parsed.path ? { contentFingerprint: ev.targetHash } : {}),
  };
  if (parsed.anchor || ev.anchor) locator.headingAnchor = parsed.anchor ?? ev.anchor;
  if (parsed.name) {
    if (parsed.prefix === 'art') locator.name = parsed.name;
    else locator.qualifiedName = parsed.name;
  }
  return locator;
}

/** Map a soul-id prefix to the node kind it denotes (mirrors `soul-schema/id.ts` `ID_PREFIX`). */
function kindForPrefix(prefix: string): string {
  switch (prefix) {
    case 'sym':
    case 'field':
    case 'comp':
      return 'symbol';
    case 'doc':
      return 'doc-section';
    case 'art':
      return 'agent-artifact';
    case 'expl':
      return 'explanation';
    case 'file':
      return 'file';
    case 'c':
      return 'cluster';
    default:
      return prefix; // best-effort for deep-extraction kinds (stmt/cond/raise/…)
  }
}

/** The minimum score for a node to count as a reattachment candidate (strict — avoid false matches). */
export const LOCATOR_MATCH_THRESHOLD = 50;

/**
 * Score how well a live node matches a locator. Kind match is mandatory; beyond that, name + path +
 * signature + anchor + hash accumulate. A perfect same-name + same-path + same-signature match scores
 * 100; a kind-only match scores 30 (below the threshold, so it is NOT a candidate).
 */
export function locatorScore(node: Node, locator: StableLocator): number {
  // Kind match is mandatory. For agent-artifacts, also honor the artifactType when the locator has it.
  if (node.kind !== locator.artifactKind) return 0;
  if (locator.artifactType && node.artifactType !== locator.artifactType) return 0;
  let score = 30; // kind matched
  if (locator.qualifiedName && node.qualifiedName === locator.qualifiedName) score += 30;
  else if (locator.name && node.name === locator.name) score += 25;
  if (locator.signature && node.signature === locator.signature) score += 15;
  if (locator.pathHints.length > 0 && node.file && locator.pathHints.includes(node.file))
    score += 15;
  else if (locator.pathHints.length > 0 && node.file) {
    // partial path credit: basename match
    const base = node.file.split('/').pop();
    if (base && locator.pathHints.includes(base)) score += 8;
  }
  if (locator.headingAnchor && node.anchor === locator.headingAnchor) score += 10;
  if (locator.contentFingerprint && node.hash === locator.contentFingerprint) score += 10;
  return score;
}

/**
 * Return the live nodes that match `locator`, best-first, filtered to the candidate threshold. PURE
 * over the input node list — the {@link SoulStoreSoulPort} adapter feeds it `Array.from(soul.iterate())`.
 * At most `limit` candidates are returned (the evaluator needs to know 0 / 1 / many, not the full set).
 */
export function bestLocatorMatches(
  nodes: readonly Node[],
  locator: StableLocator,
  limit = 8,
): Node[] {
  const scored: { node: Node; score: number }[] = [];
  for (const node of nodes) {
    const score = locatorScore(node, locator);
    if (score >= LOCATOR_MATCH_THRESHOLD) scored.push({ node, score });
  }
  scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  return scored.slice(0, limit).map((s) => s.node);
}
