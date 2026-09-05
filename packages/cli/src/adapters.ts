/**
 * W8 — cross-agent onboarding adapters (PRD line 394, exit gate line 408).
 *
 * The neutral protocol: root `AGENTS.md` (and each client's native instruction file) carries a
 * managed block telling every agent — Claude, Cursor, Copilot/VS Code, Codex, Windsurf, Gemini, or
 * any MCP-capable tool — to recall via `brief`, record only reusable learnings, provide admissible
 * evidence, and never claim self-evaluation. The block is spliced between HTML-comment markers so a
 * user's hand-written content outside the block survives byte-for-byte. Removing an adapter removes
 * only its block — memory lives in `.crib/memory/` + `~/.crib/memory/`, never in these files (PRD exit
 * gate: "removing an adapter does not remove memory").
 *
 * This module is the per-client registry: which instruction file each client reads, where each
 * client installs skills, and (G2.1) which capture lanes each client can carry — portable capture
 * (the memory MCP tool, every client), real lifecycle hooks (only where a verified hook surface +
 * an in-repo writer exist: Claude Code today), and SDK middleware. The lane row is a REQUIRED
 * `lifecycle` field on every adapter, so the compiler forces a row per client. MCP config wiring
 * lives in `mcp-install.ts` (reusing its writers); adding a client = add a `ClientAdapter` entry
 * here + an `McpIde` target there, not a third hardcoded switch.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** A supported agent client for the instruction-adapter registry. A superset of {@link McpIde}:
 *  includes `'copilot'` (GitHub Copilot), which has its own instruction file
 *  (`.github/copilot-instructions.md`) but reuses VS Code's MCP config — so it is a client here but NOT
 *  an MCP installer target. */
export type ClientId = 'claude' | 'cursor' | 'copilot' | 'vscode' | 'codex' | 'windsurf' | 'gemini';

export type AdapterScope = 'project' | 'global';

export interface InstructionTarget {
  /** Absolute file path the managed block is spliced into. */
  path: string;
  /** `'md'` (HTML-comment markers) or `'mdc'` (Cursor rule = YAML frontmatter + markers). */
  format: 'md' | 'mdc';
}

/** Evidence class for a capture-lane cell — the repo's never-self-assert rule applied to client
 *  capabilities: a claim is never stronger than its evidence. `in-repo-writer` = this repo wires the
 *  lane end to end (an mcp-install/adapters writer exists); `verified-upstream-doc` = the mechanism
 *  is documented by the client's upstream docs but this repo does not exercise it end to end;
 *  `unverified` = believed but unproven — never rendered as a guarantee. */
export type CaptureEvidence = 'in-repo-writer' | 'verified-upstream-doc' | 'unverified';

/** Lifecycle events a lane-2 hook can observe. A closed enum: the matrix may only describe events
 *  this set names, so a new observable event is a deliberate extension, not free-form prose. */
export type LifecycleEvent = 'session-start' | 'turn-end' | 'tool-use';
export const LIFECYCLE_EVENTS: readonly LifecycleEvent[] = [
  'session-start',
  'turn-end',
  'tool-use',
];

/** Lane 2 — real lifecycle hooks: the client fires a configured command on the declared events and
 *  the command invokes the crib CLI capture path. `settingsPath` is the config file the hook writer
 *  (bottom of this file) manages; present only when a writer exists for this client. */
export interface LifecycleHooksCell {
  readonly events: readonly LifecycleEvent[];
  readonly evidence: CaptureEvidence;
  settingsPath?(repoRoot: string): string;
}

/** The per-client capture-lane capability row (G2.1). REQUIRED on every {@link ClientAdapter} so the
 *  compiler forces a row for every client — a new client cannot silently default to "none", and the
 *  matrix is keyed by ClientId (copilot and vscode share `.vscode/mcp.json` but are separate rows). */
export interface CaptureLanes {
  /** Lane 1 — portable capture through the memory MCP tool. Every registry client runs the MCP
   *  server (mcp-install.ts wires all of them), so the cell is always present; it is data so the
   *  lane is described explicitly, not left implicit. */
  readonly portableCapture: {
    readonly tool: string;
    readonly op: string;
    readonly evidence: CaptureEvidence;
  };
  /** Lane 2 — lifecycle hooks, or `null` when the client exposes no hook surface this repo can wire
   *  or upstream-verify. Such a client is on instruction-based recall only — reported as data, never
   *  as a doctor failure (the doctor check-7 precedent: an unfilled optional state is ✓ + hint). */
  readonly lifecycleHooks: LifecycleHooksCell | null;
  /** Lane 3 — SDK middleware (an application embeds the client's agent SDK and injects guaranteed
   *  capture + recall around each turn), or `null` when no SDK surface is verified for this client. */
  readonly sdkMiddleware: { readonly evidence: CaptureEvidence } | null;
}

export interface ClientAdapter {
  id: ClientId;
  /** Human-readable label for `crib adapters list`. */
  label: string;
  /** Instruction file targets for a scope (the neutral protocol), or `null` when this client reads
   *  no dedicated instruction file (VS Code's agent IS Copilot → `.github/copilot-instructions.md`). */
  instructionTargets(scope: AdapterScope, repoRoot: string): InstructionTarget[] | null;
  /** Skill install destination root, or `null` when this client has no skill mechanism. */
  skillDest(home: string): string | null;
  /** The capture-lane capability matrix row (see {@link CaptureLanes}). */
  lifecycle: CaptureLanes;
}

/** HTML-comment markers delimiting the managed block. Chosen so the block is invisible to a markdown
 *  renderer (renders as an HTML comment) yet trivially locatable for idempotent replace/remove. */
export const ADAPTER_BEGIN = '<!-- crib:start -->';
export const ADAPTER_END = '<!-- crib:end -->';

/** Cursor `.mdc` rule frontmatter (written above the managed block on a fresh file). `alwaysApply`
 *  makes Cursor inject the rule into every session, matching the AGENTS.md-always-loaded contract. */
export const CURSOR_FRONTMATTER = [
  '---',
  'description: Knowledge-crib agent protocol — recall via brief, record reusable learnings with evidence, never self-evaluate; analyse impact before editing and graph changes before committing.',
  'globs: "**/*"',
  'alwaysApply: true',
  '---',
  '',
].join('\n');

/**
 * The neutral protocol body — the SAME content for every client's instruction file and the root
 * `AGENTS.md`. Vendor-neutral: names crib's own MCP tools (not a client-specific command), states the
 * record-only-reusable-learnings rule, the admissible-evidence/no-self-evaluation rule, and the
 * non-destructive rule (memory is not in this file). Exported so tests assert it without re-deriving.
 *
 * It covers BOTH halves of the server: the memory protocol (§1-4) and the code-intelligence protocol
 * (§5-7). The code-intelligence half exists so a repository indexed by crib does not have to borrow a
 * third-party tool's instruction block to get "analyse impact before you edit" discipline — crib
 * serves `impact`, `detect_changes`, `query`, `context`, `rename` and `explain` itself, so the rules
 * name crib's own verbs and, more importantly, crib's own HONESTY signals. Those signals differ from
 * other tools' and must not be paraphrased from them: crib's `risk` is distance-derived (never a
 * safety verdict and never `UNKNOWN`), an empty `affected` list is unresolved-not-unused, `truncated`
 * means the walk was paged, and a `note` on `detect_changes` means the report degraded.
 */
export function neutralProtocolBody(): string {
  return [
    '## Knowledge-crib agent memory protocol (vendor-neutral)',
    '',
    'This repository uses knowledge-crib as a shared, vendor-neutral memory substrate. Every agent session — Claude, Cursor, Copilot/VS Code, Codex, Windsurf, Gemini, or any MCP-capable tool — follows this protocol. It does not change your tool; it tells you how to use memory safely.',
    '',
    '### 1. Restore durable work before acting',
    '- Run handoff before relying on prior project context: call the `memory` MCP tool with `op: "handoff"` (or run `crib session bootstrap --json`). Read its `continuation` block: it states the question, the selectable options (each `resume:<intakeId>`, plus `fresh`), and any `cautions` on an option. Take `recommended` when it is present; when it is absent, ASK the user to choose rather than picking one — an absent recommendation means several intakes are resumable, or the only one needs a deliberate look (repository drift, blockers, conflicts).',
    '- Act on the choice explicitly: `crib session resume <intakeId> --next "<next step>"` records the resume so a later session can tell resumed work from abandoned work, and `crib session fresh` starts new work while leaving every unfinished intake open and resumable. Starting fresh never closes anything; retire an intake with `crib intake complete` or `crib intake cancel`.',
    '- Create or match a durable intake for meaningful user work before planning or editing. Preserve the sanitized original request, interpreted outcome, scope, constraints, and acceptance criteria; never store full transcripts or chain-of-thought.',
    '- Checkpoint unfinished intake work at meaningful boundaries: after selecting a plan, after material progress, when blocked, and before ending a session. Record completed step IDs, artifacts/receipts, and one concrete next safe action.',
    '- Validate repository drift from the saved checkpoint before resuming. If HEAD, branch, or the dirty-path digest changed, re-check the plan and next action against the current tree rather than blindly continuing.',
    '- Never share or sync an intake implicitly. Device sync requires configured encrypted sync plus an explicit devices audience; team visibility requires an explicit team share into Git-backed memory.',
    '',
    '### 2. Recall before you act',
    '- Before relying on a reusable claim, call the `brief` MCP tool (or the `memory_recall` MCP tool, or `crib memory recall "<query>"`) to surface team + local memory for this repository. Memory is the source of truth across sessions — do not assume last session’s state still holds.',
    '- `brief` returns typed groups: team before local, valid before degraded, current before needs-review. Never mix memory results with BM25 code-search results into one opaque list.',
    '',
    '### 3. Record only reusable learnings',
    '- Persist a memory (via `memory_observe`, or `crib memory propose/attest`) ONLY when it is reusable beyond the current task: a non-obvious fact, a verified procedure, a decision with rationale, a pitfall and its fix, or a convention.',
    '- NEVER persist ephemeral state, full transcripts, chain-of-thought, raw command output, or secrets. Default `brief` stays within 2,000 tokens; default recall within 1,200.',
    '',
    '### 4. Provide evidence — never self-evaluate',
    '- Every memory must carry admissible evidence grounded in the repository: source-quote, execution-assertion, committed-policy, human-attestation, or receipt-pair. An agent NEVER self-asserts a pass: a passing local gate produces a receipt; team trust requires both CI success AND presence on a configured trusted Git ref.',
    '- Never claim a memory is verified, trusted, or current on your own authority. State what you observed; the freshness engine derives those verdicts from the evidence.',
    '',
    '### 5. Non-destructive',
    '- Memory lives in `.crib/memory/` (team) and `~/.crib/memory/` (local/global) — NOT in this file. Removing this adapter (or this client) removes only this managed block; it does not delete memory. On disagreement do not delete team memory; supersede or quarantine it with admissible counter-evidence instead.',
    '',
    '## Knowledge-crib code intelligence protocol',
    '',
    'The same MCP server that serves memory also serves this repository’s code graph. Use the graph, not a text search, to answer structural questions — and read its honesty signals rather than assuming a clean result.',
    '',
    '### 6. Analyse blast radius before you edit',
    '- Before changing a function, class, or method, call `impact({ id: "<symbol>", dir: "up" })` (`op` defaults to `blast`; `dir: "up"` = dependents, `dir: "down"` = dependencies). Report the affected symbols before editing.',
    '- `risk` on each affected node is DISTANCE-derived, not a judgement: `high` at distance 1, `medium` at 2, `low` beyond. It ranks proximity — it never certifies that an edit is safe.',
    '- An empty `affected` list is NOT evidence the symbol is unused. It can equally mean the edges are not resolvable by the index (dynamic dispatch, plain-object property access, cross-language calls, reflection). Confirm with a text search before treating a symbol as dead.',
    '- `truncated: true` means the walk was cut at a limit — the result is a page, not the blast radius. Raise `limit`/`depth` or page with `cursor` before drawing a conclusion.',
    '',
    '### 7. Analyse graph changes before you commit',
    '- Run `detect_changes({})` (optionally `{ since: "<ref>" }`) and review `changedSymbols`, `removedEdges`, `changedPaths` (committed since the anchor) and `uncommittedPaths` (still in the working tree). Both path sets feed `changedSymbols`, so the check works BEFORE you commit.',
    '- A `note` QUALIFIES the report — it is degraded or narrowed in scope, never a clean bill of health. `vcs adapter not configured`, `not a git work tree` and `no incremental anchor` all return empty arrays; `no commits since the anchor …` means the commit range was empty by construction. Never read an empty result carrying a `note` as "nothing changed".',
    '',
    '### 8. Review a change with `review`, not by reading the files',
    '- Asked to review, diff, or assess a change, call `review({})` FIRST. It returns what changed, each changed DECLARATION with its signature, who calls it, and prior trusted decisions about it — in one bounded call.',
    '- This is not a style preference, it is a budget. On a real commit in this repository, reading every touched file costs ~212,000 tokens while `review` costs ~2,000 (docs/bench/review-cost.md). A review that reads files does not fit, so it degrades into skimming a few lines and guessing — which is the failure this verb exists to remove.',
    '- Pair it with the diff: the diff says WHAT changed, `review` says who it affects and what was already decided. Read specific files only for what neither answers.',
    '- An empty `callers` list is labelled and is NOT evidence a symbol is unused; a `note` means the change set itself is degraded, so every count is a floor.',
    '',
    '### 9. Prefer graph verbs over grep',
    '- Explore unfamiliar code with `query({ q: "<concept>" })`; get callers, callees, and docs for one symbol with `context({ id: "<symbol>" })`; find owning files/modules with `impact({ op: "owners", id })`; find how two symbols connect with `impact({ op: "path", from, to })`.',
    '- Rename through `rename({ from, to })` — it plans across the call graph and is dry-run by default; apply only with the returned `planId`. Never rename with find-and-replace.',
    '- `explain({ id })` reports taint/dataflow findings for one callable. `status({ op: "gaps" })` reports what the graph does NOT cover — read it before claiming coverage.',
    '- If the index is stale, refresh it with `crib index` (or `crib update`). A stale graph answers confidently and wrongly.',
  ].join('\n');
}

/** The full managed block (markers + body) spliced into each instruction file. */
export function neutralProtocolBlock(): string {
  return `${ADAPTER_BEGIN}\n${neutralProtocolBody()}\n${ADAPTER_END}`;
}

// ─── client registry ──────────────────────────────────────────────────────────

/** The lane row shared by every client with no lifecycle-hook surface (everyone but Claude, today).
 *  One shared const so the honest "instruction-based recall only" wording lives in exactly one place;
 *  the rows are still per-ClientId entries below (copilot and vscode are separate clients that happen
 *  to have identical lane capability). */
const INSTRUCTION_RECALL_ONLY: CaptureLanes = {
  portableCapture: { tool: 'memory', op: 'capture', evidence: 'in-repo-writer' },
  lifecycleHooks: null,
  sdkMiddleware: null,
};

/** All supported clients, in the order `crib adapters install --client all` writes them. */
export const CLIENT_ADAPTERS: ClientAdapter[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    instructionTargets: (scope, repoRoot) =>
      scope === 'project' ? [{ path: join(repoRoot, 'CLAUDE.md'), format: 'md' }] : null,
    skillDest: (home) => join(home, '.claude', 'skills'),
    lifecycle: {
      portableCapture: { tool: 'memory', op: 'capture', evidence: 'in-repo-writer' },
      lifecycleHooks: {
        events: ['session-start', 'turn-end', 'tool-use'],
        // settings.json hooks exist upstream (SessionStart / Stop / PostToolUse run a configured
        // command) — but the fired-event guarantee is upstream documentation, not in-repo
        // execution: this repo only writes the entry (capture-hook writer below), and the durable
        // capture CLI it invokes is the G2.2 capture lane. Evidence stays at the upstream-doc tier
        // until that path exists in-repo — a stronger label would self-assert a guarantee nobody
        // has run.
        evidence: 'verified-upstream-doc',
        settingsPath: (repoRoot) => join(repoRoot, '.claude', 'settings.json'),
      },
      // The Claude Agent SDK can wrap each turn in an embedded application, but no in-repo code or
      // verified upstream doc pins that contract for memory capture + recall injection — reported
      // honestly as unverified rather than promised.
      sdkMiddleware: { evidence: 'unverified' },
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    instructionTargets: (scope, repoRoot) =>
      scope === 'project'
        ? [{ path: join(repoRoot, '.cursor', 'rules', 'crib.mdc'), format: 'mdc' }]
        : null,
    // Cursor loads only `.mdc` rule files (not Claude-style `SKILL.md` directories), and as of mid-2026
    // has no user-home rules location at all — user rules are plain text managed via Cursor Settings.
    // So a bundled Claude skill copied to `~/.cursor/rules/<name>/SKILL.md` is silently ignored. Return
    // null: `crib skill install --client cursor` reports a non-fatal note + installs nothing rather than
    // writing a directory Cursor will never load.
    skillDest: () => null,
    lifecycle: INSTRUCTION_RECALL_ONLY,
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    instructionTargets: (scope, repoRoot) =>
      scope === 'project'
        ? [{ path: join(repoRoot, '.github', 'copilot-instructions.md'), format: 'md' }]
        : null,
    skillDest: () => null,
    lifecycle: INSTRUCTION_RECALL_ONLY,
  },
  {
    id: 'vscode',
    label: 'VS Code',
    // VS Code's agent IS Copilot, which reads `.github/copilot-instructions.md`; VS Code has no
    // separate agent-instruction file, so no instruction target here. MCP wiring is offered via
    // `crib mcp install --ide vscode`.
    instructionTargets: () => null,
    skillDest: () => null,
    lifecycle: INSTRUCTION_RECALL_ONLY,
  },
  {
    id: 'codex',
    label: 'Codex',
    // Codex reads `AGENTS.md` natively (same file as the root neutral protocol).
    instructionTargets: (scope, repoRoot) =>
      scope === 'project' ? [{ path: join(repoRoot, 'AGENTS.md'), format: 'md' }] : null,
    skillDest: () => null,
    lifecycle: INSTRUCTION_RECALL_ONLY,
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    instructionTargets: (scope, repoRoot) =>
      scope === 'project' ? [{ path: join(repoRoot, '.windsurfrules'), format: 'md' }] : null,
    skillDest: () => null,
    lifecycle: INSTRUCTION_RECALL_ONLY,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    instructionTargets: (scope, repoRoot) =>
      scope === 'project' ? [{ path: join(repoRoot, 'GEMINI.md'), format: 'md' }] : null,
    skillDest: () => null,
    lifecycle: INSTRUCTION_RECALL_ONLY,
  },
];

/** All client ids. */
export const ALL_CLIENTS: ClientId[] = CLIENT_ADAPTERS.map((a) => a.id);

/** Look up a client adapter by id. */
export function clientAdapter(id: ClientId): ClientAdapter {
  const a = CLIENT_ADAPTERS.find((x) => x.id === id);
  if (!a) throw new Error(`no adapter for client '${id}'`);
  return a;
}

/** Resolve the skill install destination for a client (or `null` if it has no skill mechanism). Falls
 *  back to `os.homedir()` (getpwuid on POSIX) when no `home` is passed — never `process.env.HOME ?? ''`,
 *  which yields a relative path (`.claude/skills`) when HOME is unset (sandboxed CI / `env -i`). */
export function skillDestFor(client: ClientId, home?: string): string | null {
  return clientAdapter(client).skillDest(home ?? homedir());
}

// ─── capture-lane matrix: constants, invariants, manifest gate (G2.1) ─────────

/** The MCP tool + op the capture lanes rely on. The manifest gate (below, run by
 *  scripts/capabilities-check.mjs) pins both names, so a rename breaks the build instead of silently
 *  breaking every installed client's capture path. */
export const CAPTURE_TOOL_REF = { tool: 'memory', op: 'capture' } as const;

/** The MCP tools the neutral protocol body cites directly — the standalone compatibility adapters
 *  (capabilities.ts keeps them standalone precisely because this protocol text names them). */
export const PROTOCOL_CITED_TOOLS: readonly string[] = ['brief', 'memory_recall', 'memory_observe'];

/** The stable CLI subcommand a lane-2 hook entry invokes. The durable capture path behind it
 *  (transient acceptance → policy-gated distillation) is the G2.2 capture lane; the wire format is
 *  fixed here so hook entries survive that lane landing. This marker string is also how the hook
 *  writer identifies crib-owned entries inside a user-owned settings.json — the JSON analogue of the
 *  managed-block begin marker (JSON carries no comments). */
export const CAPTURE_HOOK_COMMAND_MARKER = 'crib memory capture-hook';

/** The hook command for one lifecycle event, as embedded in the client's settings file. */
export function captureHookCommand(event: LifecycleEvent): string {
  const capture = `${CAPTURE_HOOK_COMMAND_MARKER} --event ${event}`;
  // Claude injects SessionStart stdout into the new session. Keep the managed marker first so the
  // non-clobbering writer can still identify/replace this entry; `|| true` preserves the hook's
  // fail-open contract if bootstrap cannot resolve memory yet.
  return event === 'session-start' ? `${capture}; crib session bootstrap --json || true` : capture;
}

/** One-line lane summary for `crib adapters list` / `crib doctor`, regenerated from the matrix —
 *  never hand-written prose (the same regenerate-from-one-list law the tool/op counts follow). */
export function captureLaneSummary(client: ClientId): string {
  const { label, lifecycle } = clientAdapter(client);
  const pc = `portable capture via ${lifecycle.portableCapture.tool}({op:'${lifecycle.portableCapture.op}'}) [${lifecycle.portableCapture.evidence}]`;
  const hooks = lifecycle.lifecycleHooks;
  if (hooks) {
    return `${label}: ${pc}; lifecycle hooks (${hooks.events.join(', ')}) [${hooks.evidence}]`;
  }
  const sdk = lifecycle.sdkMiddleware
    ? `; sdk-middleware [${lifecycle.sdkMiddleware.evidence}]`
    : '';
  return `${label}: ${pc}; instruction-based recall only (no lifecycle-hook surface)${sdk}`;
}

/** Minimal view of the MCP capability manifest the lane gate validates against (injected, so this
 *  module stays dependency-free and the gate can run against the built dist). */
export interface ToolManifestView {
  readonly tools: readonly string[];
  opsOf(tool: string): readonly string[];
}

/** Cross-entry consistency checks for the capture-lane matrix (mirrors capabilities.ts
 *  manifestInvariants). tsc already forces a `lifecycle` row on every adapter; this re-asserts it
 *  through the built dist the way a release actually ships, and checks the enum closed-ness tsc
 *  cannot see at the data level. Empty return = healthy. */
export function lifecycleInvariants(
  rows: readonly { id: ClientId; lifecycle?: CaptureLanes }[] = CLIENT_ADAPTERS,
): readonly string[] {
  const evidenceOk = (e: unknown): boolean =>
    e === 'in-repo-writer' || e === 'verified-upstream-doc' || e === 'unverified';
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) problems.push(`duplicate capture-lane row for '${row.id}'`);
    seen.add(row.id);
    const lc = row.lifecycle;
    if (!lc) {
      problems.push(`client '${row.id}' has no capture-lane row`);
      continue;
    }
    if (!lc.portableCapture?.tool || !lc.portableCapture.op) {
      problems.push(`client '${row.id}' portableCapture must name a tool + op`);
    } else if (!evidenceOk(lc.portableCapture.evidence)) {
      problems.push(
        `client '${row.id}' portableCapture evidence '${String(lc.portableCapture.evidence)}' is not a known evidence class`,
      );
    }
    if (lc.lifecycleHooks) {
      const hooks = lc.lifecycleHooks;
      if (hooks.events.length === 0)
        problems.push(`client '${row.id}' declares lifecycle hooks but no events`);
      for (const event of hooks.events) {
        if (!(LIFECYCLE_EVENTS as readonly string[]).includes(event))
          problems.push(
            `client '${row.id}' hook event '${String(event)}' is not one of ${LIFECYCLE_EVENTS.join(', ')}`,
          );
      }
      if (!evidenceOk(hooks.evidence))
        problems.push(
          `client '${row.id}' lifecycleHooks evidence '${String(hooks.evidence)}' is not a known evidence class`,
        );
    }
    if (lc.sdkMiddleware && !evidenceOk(lc.sdkMiddleware.evidence))
      problems.push(
        `client '${row.id}' sdkMiddleware evidence '${String(lc.sdkMiddleware.evidence)}' is not a known evidence class`,
      );
  }
  return problems;
}

/** The gate half of G2.1: every tool/op name the matrix and the neutral protocol text cite must
 *  exist in the MCP capability manifest. A renamed op therefore breaks the build (the
 *  capabilities:check release gate runs this against the built dists) instead of silently breaking
 *  every installed client's recall instruction. */
export function captureLaneManifestViolations(manifest: ToolManifestView): readonly string[] {
  const problems: string[] = [];
  const checkRef = (tool: string, op: string | undefined, citedBy: string): void => {
    if (!manifest.tools.includes(tool)) {
      problems.push(
        `${citedBy} cites tool '${tool}', which the capability manifest does not define`,
      );
      return;
    }
    if (op !== undefined && !manifest.opsOf(tool).includes(op))
      problems.push(
        `${citedBy} cites op '${op}' on tool '${tool}', which the manifest does not define`,
      );
  };
  for (const row of CLIENT_ADAPTERS) {
    const pc = row.lifecycle?.portableCapture;
    if (pc) checkRef(pc.tool, pc.op, `client '${row.id}' portableCapture`);
  }
  checkRef(CAPTURE_TOOL_REF.tool, CAPTURE_TOOL_REF.op, 'CAPTURE_TOOL_REF');
  for (const tool of PROTOCOL_CITED_TOOLS) {
    if (!manifest.tools.includes(tool))
      problems.push(
        `neutralProtocolBody cites tool '${tool}', which the capability manifest does not define`,
      );
  }
  return problems;
}

// ─── managed-block splice (markdown) ──────────────────────────────────────────

/** Read a file as text, or `''` if absent. */
function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Splice the managed block into `content`, replacing any existing complete block in place (never
 *  duplicating). Content outside a COMPLETE marker pair is preserved (a separating newline is inserted
 *  only when sibling text directly abuts a marker, so the block stays a standalone region). When a begin
 *  marker is present with no matching end marker (a truncated/corrupted file), the function REFUSES to
 *  splice and returns `content` unchanged — it cannot know where the block ended, so it must not guess
 *  (guessing would discard the unterminated tail). The caller observes `written:false` and can repair. */
export function spliceAdapterBlock(content: string, block: string): string {
  const beginIdx = content.indexOf(ADAPTER_BEGIN);
  if (beginIdx === -1) {
    const tail = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    return `${content}${tail}${block}\n`;
  }
  const endIdx = content.indexOf(ADAPTER_END, beginIdx);
  if (endIdx === -1) return content; // orphan begin marker — refuse to splice (non-destructive)
  const before = content.slice(0, beginIdx);
  const after = content.slice(endIdx + ADAPTER_END.length);
  const ensuredNl = (s: string) => (s.length > 0 && !s.endsWith('\n') ? `${s}\n` : s);
  return `${ensuredNl(before)}${block}\n${after.replace(/^\n/, '')}`;
}

/** Remove the managed block from `content`, preserving everything outside a COMPLETE marker pair. When
 *  a begin marker is present with no matching end marker, returns `content` unchanged (refuses to remove
 *  — cannot find the block boundary without discarding the unterminated tail). */
export function removeAdapterBlock(content: string): string {
  const beginIdx = content.indexOf(ADAPTER_BEGIN);
  if (beginIdx === -1) return content;
  const endIdx = content.indexOf(ADAPTER_END, beginIdx);
  if (endIdx === -1) return content; // orphan begin marker — refuse to remove (non-destructive)
  const before = content.slice(0, beginIdx);
  const after = content.slice(endIdx + ADAPTER_END.length);
  return `${before}${after.replace(/^\n/, '')}`;
}

/** True if `content` is empty or ONLY YAML frontmatter (no user body). CRLF-tolerant (`\r?\n`) so a
 *  Windows-edited frontmatter-only Cursor rule is still recognized. Only meaningful for `.mdc` targets
 *  (crib owns the frontmatter it writes there); see `removeInstructions` for the format gate. */
function isOnlyFrontmatter(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed === '') return true;
  return /^---\r?\n[\s\S]*\r?\n---\s*$/.test(trimmed);
}

// ─── install / list / remove ──────────────────────────────────────────────────

export interface InstructionInstallResult {
  client: ClientId;
  scope: AdapterScope;
  /** Absolute instruction file path written (or `''` when the client has no instruction target). */
  path: string;
  /** Whether the block was written vs already up to date. */
  written: boolean;
  /** Non-fatal note (unsupported scope/client). */
  note?: string;
}

/** Install/refresh the neutral-protocol managed block for one client (or all). Non-destructive:
 *  sibling content outside the markers is preserved. */
export function installInstructions(
  repoRoot: string,
  opts: { client?: ClientId | 'all'; scope?: AdapterScope } = {},
): InstructionInstallResult[] {
  const scope: AdapterScope = opts.scope ?? 'project';
  const ids: ClientId[] = opts.client && opts.client !== 'all' ? [opts.client] : ALL_CLIENTS;
  const out: InstructionInstallResult[] = [];
  for (const id of ids) {
    const adapter = clientAdapter(id);
    const targets = adapter.instructionTargets(scope, repoRoot);
    if (!targets || targets.length === 0) {
      out.push({
        client: id,
        scope,
        path: '',
        written: false,
        note: `${adapter.label} has no ${scope}-scope instruction file; MCP wiring via \`crib mcp install --ide ${id}\`.`,
      });
      continue;
    }
    for (const target of targets) {
      const existing = readOrEmpty(target.path);
      let next: string;
      if (target.format === 'mdc') {
        // Ensure the Cursor frontmatter is present (write it on a fresh file; preserve an existing
        // user-edited frontmatter above the managed block). CRLF-tolerant so a Windows-edited frontmatter
        // is recognized, not stacked beneath a duplicate crib default.
        const hasFrontmatter = /^---\r?\n[\s\S]*?\r?\n---/.test(existing);
        const withFrontmatter = hasFrontmatter ? existing : `${CURSOR_FRONTMATTER}${existing}`;
        next = spliceAdapterBlock(withFrontmatter, neutralProtocolBlock());
      } else {
        next = spliceAdapterBlock(existing, neutralProtocolBlock());
      }
      const written = next !== existing;
      if (written) {
        mkdirSync(dirname(target.path), { recursive: true });
        writeFileSync(target.path, next, 'utf8');
      }
      out.push({ client: id, scope, path: target.path, written });
    }
  }
  return out;
}

export interface InstructionListEntry {
  client: ClientId;
  scope: AdapterScope;
  path: string;
  present: boolean;
}

/** Report the current managed-block status for each client's instruction file, without writing. */
export function listInstructions(
  repoRoot: string,
  opts: { client?: ClientId | 'all'; scope?: AdapterScope } = {},
): InstructionListEntry[] {
  const scope: AdapterScope = opts.scope ?? 'project';
  const ids: ClientId[] = opts.client && opts.client !== 'all' ? [opts.client] : ALL_CLIENTS;
  const out: InstructionListEntry[] = [];
  for (const id of ids) {
    const adapter = clientAdapter(id);
    const targets = adapter.instructionTargets(scope, repoRoot);
    if (!targets || targets.length === 0) continue;
    for (const target of targets) {
      const present = existsSync(target.path) && readOrEmpty(target.path).includes(ADAPTER_BEGIN);
      out.push({ client: id, scope, path: target.path, present });
    }
  }
  return out;
}

/** Remove the managed block for one client (or all). A crib-owned rule file left empty or
 *  frontmatter-only after removal is deleted; a file with remaining user content is left intact. */
export function removeInstructions(
  repoRoot: string,
  opts: { client?: ClientId | 'all'; scope?: AdapterScope } = {},
): InstructionInstallResult[] {
  const scope: AdapterScope = opts.scope ?? 'project';
  const ids: ClientId[] = opts.client && opts.client !== 'all' ? [opts.client] : ALL_CLIENTS;
  const out: InstructionInstallResult[] = [];
  for (const id of ids) {
    const adapter = clientAdapter(id);
    const targets = adapter.instructionTargets(scope, repoRoot);
    if (!targets || targets.length === 0) {
      out.push({
        client: id,
        scope,
        path: '',
        written: false,
        note: `${adapter.label} has no ${scope}-scope instruction file.`,
      });
      continue;
    }
    for (const target of targets) {
      if (!existsSync(target.path)) {
        out.push({ client: id, scope, path: target.path, written: false });
        continue;
      }
      const existing = readOrEmpty(target.path);
      const next = removeAdapterBlock(existing);
      const written = next !== existing;
      if (written) {
        // Only a CRIB-OWNED file is safe to delete. For `.mdc` (Cursor) crib authors the frontmatter
        // itself, so a frontmatter-only residual (or empty file) is crib-owned → delete. For `.md`
        // targets (CLAUDE.md, AGENTS.md, GEMINI.md, .windsurfrules, copilot-instructions.md) crib NEVER
        // writes frontmatter — any frontmatter present is user-authored sibling content. Deleting a
        // frontmatter-only `.md` residual would destroy user metadata, so a `.md` file is deleted ONLY
        // when it is empty after block removal.
        const cribOwned = target.format === 'mdc' ? isOnlyFrontmatter(next) : next.trim() === '';
        if (cribOwned) {
          rmSync(target.path, { force: true });
        } else {
          writeFileSync(target.path, next, 'utf8');
        }
      }
      out.push({ client: id, scope, path: target.path, written });
    }
  }
  return out;
}

// ─── lane-2 capture-hook writer (G2.1, Claude Code settings.json) ─────────────

/**
 * Writes the lane-2 hook entry into `.claude/settings.json` (project scope) so Claude Code invokes
 * the crib CLI capture path on session/turn events. Modeled on mcp-install.ts's per-format JSON
 * writers: idempotent, non-clobbering (parse → set crib-owned entries → reserialize, preserving all
 * sibling content), with the adapters.ts managed-block refusal rules carried over. Since JSON cannot
 * carry comment markers, crib-owned entries are identified by the stable
 * {@link CAPTURE_HOOK_COMMAND_MARKER} prefix in their `command` — the begin-marker analogue — and
 * this writer REFUSES to touch a file whose structure it cannot interpret safely (unparseable JSON,
 * a non-object `hooks` key, a non-array event bucket, or a marker-carrying entry it cannot parse)
 * rather than guessing a boundary and discarding user config.
 *
 * Only Claude gets a writer: its settings.json hooks are the one lifecycle surface the matrix marks
 * `verified-upstream-doc`. Every other client reports "instruction-based recall only" — as data,
 * never as a failure (the doctor check-7 not-initialized-is-✓+hint precedent).
 */

/** Claude Code hook event key each lifecycle event maps to (upstream settings.json hook names:
 *  SessionStart fires once per session, Stop when the main agent finishes a turn, PostToolUse after
 *  each tool call; `matcher` is omitted, which upstream treats as match-all). */
const CLAUDE_HOOK_EVENT_KEYS: Record<LifecycleEvent, string> = {
  'session-start': 'SessionStart',
  'turn-end': 'Stop',
  'tool-use': 'PostToolUse',
};

/** True when a hook command entry is crib-managed: the marker prefix in `command` is the managed
 *  block's begin marker analogue. */
function isCribHookEntry(entry: unknown): entry is Record<string, unknown> {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    typeof (entry as Record<string, unknown>).command === 'string' &&
    ((entry as Record<string, unknown>).command as string).startsWith(CAPTURE_HOOK_COMMAND_MARKER)
  );
}

/** The lifecycle event a crib-owned hook entry was written for, or `null` when unparseable. */
function eventOfCribHook(entry: Record<string, unknown>): LifecycleEvent | null {
  const m = /--event (session-start|turn-end|tool-use)(?:\s|;|$)/.exec(entry.command as string);
  const event = m?.[1];
  return event && (LIFECYCLE_EVENTS as readonly string[]).includes(event)
    ? (event as LifecycleEvent)
    : null;
}

export interface HookInstallResult {
  client: ClientId;
  scope: AdapterScope;
  /** Absolute settings file path (or `''` when the client has no hook target). */
  path: string;
  written: boolean;
  /** The lifecycle events wired (install) / removed (remove) by this operation. */
  events: LifecycleEvent[];
  /** Non-fatal note (unsupported client/scope, or a refusal reason). */
  note?: string;
}

export interface HookListEntry {
  client: ClientId;
  scope: AdapterScope;
  path: string;
  /** The lifecycle events currently wired in the settings file. */
  events: LifecycleEvent[];
  note?: string;
}

function hookClients(opts: { client?: ClientId | 'all' }): ClientId[] {
  return opts.client && opts.client !== 'all' ? [opts.client] : ALL_CLIENTS;
}

function hookEventPairs(
  events: readonly LifecycleEvent[],
): { event: LifecycleEvent; key: string }[] {
  return events.map((event) => ({ event, key: CLAUDE_HOOK_EVENT_KEYS[event] }));
}

function parseJsonOrEmpty(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The orphan-marker refusal in JSON form: a reason string when the settings file cannot be safely
 *  rewritten (see the section comment), or `null` when the file is absent or safely interpretable. */
function hooksRefusal(path: string, events: readonly LifecycleEvent[]): string | null {
  if (!existsSync(path)) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return `refusing to write ${path}: not valid JSON — fix or remove the file first (a blind rewrite would discard it)`;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
    return `refusing to write ${path}: top level is not a JSON object`;
  const hooksRoot = (obj as Record<string, unknown>).hooks;
  if (hooksRoot === undefined) return null;
  if (typeof hooksRoot !== 'object' || hooksRoot === null || Array.isArray(hooksRoot))
    return `refusing to write ${path}: 'hooks' is not a JSON object`;
  for (const { key } of hookEventPairs(events)) {
    const bucket = (hooksRoot as Record<string, unknown>)[key];
    if (bucket === undefined) continue;
    if (!Array.isArray(bucket)) return `refusing to write ${path}: 'hooks.${key}' is not an array`;
    for (const entry of bucket) {
      if (isCribHookEntry(entry) && eventOfCribHook(entry) === null)
        return `refusing to write ${path}: a '${CAPTURE_HOOK_COMMAND_MARKER}' entry is present but unparseable — fix or remove it first`;
    }
  }
  return null;
}

/** Install/refresh the capture-hook entry for one client (or all). Clients without a hook surface
 *  (and unsupported scopes) get a data note and no write — the cursor-skillDest honesty precedent. */
export function installCaptureHooks(
  repoRoot: string,
  opts: { client?: ClientId | 'all'; scope?: AdapterScope } = {},
): HookInstallResult[] {
  const scope: AdapterScope = opts.scope ?? 'project';
  const out: HookInstallResult[] = [];
  for (const id of hookClients(opts)) {
    const adapter = clientAdapter(id);
    const hooks = adapter.lifecycle.lifecycleHooks;
    const settingsPath = hooks?.settingsPath;
    if (scope === 'global' || !hooks || !settingsPath) {
      out.push({
        client: id,
        scope,
        path: '',
        written: false,
        events: [],
        note: hooks
          ? `${adapter.label} capture hooks ship project-scope only; recall stays instruction-based.`
          : `${adapter.label} supports instruction-based recall only (no lifecycle-hook surface).`,
      });
      continue;
    }
    const path = settingsPath(repoRoot);
    const refusal = hooksRefusal(path, hooks.events);
    if (refusal) {
      out.push({ client: id, scope, path, written: false, events: [], note: refusal });
      continue;
    }
    const obj = parseJsonOrEmpty(path);
    const hooksRoot = { ...((obj.hooks as Record<string, unknown>) ?? {}) };
    const wired: LifecycleEvent[] = [];
    let changed = false;
    for (const { event, key } of hookEventPairs(hooks.events)) {
      const bucket = (hooksRoot[key] as unknown[] | undefined) ?? [];
      // Drop prior crib-owned entries, then append ours last — user entries keep their position and
      // the crib entry is byte-identical on re-runs (idempotent).
      const kept = bucket.filter((e) => !isCribHookEntry(e));
      kept.push({ type: 'command', command: captureHookCommand(event) });
      if (JSON.stringify(kept) !== JSON.stringify(bucket)) changed = true;
      hooksRoot[key] = kept;
      wired.push(event);
    }
    if (changed) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ ...obj, hooks: hooksRoot }, null, 2)}\n`, 'utf8');
    }
    out.push({ client: id, scope, path, written: changed, events: wired });
  }
  return out;
}

/** Report the currently wired capture hooks per client, without writing. */
export function listCaptureHooks(
  repoRoot: string,
  opts: { client?: ClientId | 'all'; scope?: AdapterScope } = {},
): HookListEntry[] {
  const scope: AdapterScope = opts.scope ?? 'project';
  const out: HookListEntry[] = [];
  for (const id of hookClients(opts)) {
    const adapter = clientAdapter(id);
    const hooks = adapter.lifecycle.lifecycleHooks;
    const settingsPath = hooks?.settingsPath;
    if (scope === 'global' || !hooks || !settingsPath) {
      out.push({
        client: id,
        scope,
        path: '',
        events: [],
        note: `${adapter.label} supports instruction-based recall only (no lifecycle-hook surface).`,
      });
      continue;
    }
    const path = settingsPath(repoRoot);
    const events: LifecycleEvent[] = [];
    if (existsSync(path)) {
      try {
        const obj = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        const hooksRoot = obj.hooks;
        if (typeof hooksRoot === 'object' && hooksRoot !== null && !Array.isArray(hooksRoot)) {
          for (const { key } of hookEventPairs(hooks.events)) {
            const bucket = (hooksRoot as Record<string, unknown>)[key];
            if (!Array.isArray(bucket)) continue;
            for (const entry of bucket) {
              if (!isCribHookEntry(entry)) continue;
              const event = eventOfCribHook(entry);
              if (event && !events.includes(event)) events.push(event);
            }
          }
        }
      } catch {
        /* unparseable settings — report not-installed rather than crashing a status command */
      }
    }
    out.push({ client: id, scope, path, events });
  }
  return out;
}

/** Remove the crib-owned capture-hook entries for one client (or all), leaving every sibling entry
 *  and key intact. An event bucket left empty — and an empty `hooks` key — are dropped. */
export function removeCaptureHooks(
  repoRoot: string,
  opts: { client?: ClientId | 'all'; scope?: AdapterScope } = {},
): HookInstallResult[] {
  const scope: AdapterScope = opts.scope ?? 'project';
  const out: HookInstallResult[] = [];
  for (const id of hookClients(opts)) {
    const adapter = clientAdapter(id);
    const hooks = adapter.lifecycle.lifecycleHooks;
    const settingsPath = hooks?.settingsPath;
    if (scope === 'global' || !hooks || !settingsPath) {
      out.push({
        client: id,
        scope,
        path: '',
        written: false,
        events: [],
        note: hooks
          ? `${adapter.label} capture hooks ship project-scope only.`
          : `${adapter.label} supports instruction-based recall only (no lifecycle-hook surface).`,
      });
      continue;
    }
    const path = settingsPath(repoRoot);
    const refusal = hooksRefusal(path, hooks.events);
    if (refusal) {
      out.push({ client: id, scope, path, written: false, events: [], note: refusal });
      continue;
    }
    if (!existsSync(path)) {
      out.push({ client: id, scope, path, written: false, events: [] });
      continue;
    }
    const obj = parseJsonOrEmpty(path);
    const hooksRoot = { ...((obj.hooks as Record<string, unknown>) ?? {}) };
    const removed: LifecycleEvent[] = [];
    let changed = false;
    for (const { event, key } of hookEventPairs(hooks.events)) {
      const bucket = hooksRoot[key];
      if (!Array.isArray(bucket)) continue;
      const kept = bucket.filter((e) => !isCribHookEntry(e));
      if (kept.length !== bucket.length) {
        removed.push(event);
        changed = true;
      }
      if (kept.length === 0) delete hooksRoot[key];
      else hooksRoot[key] = kept;
    }
    if (changed) {
      // The event buckets were emptied under `hooks` — keep the key only when something remains.
      const next: Record<string, unknown> = { ...obj };
      // An undefined property is omitted by JSON.stringify, so this drops the key exactly like a
      // delete would — without the delete operator the lint rules reject in hot config writers.
      if (Object.keys(hooksRoot).length === 0) next.hooks = undefined;
      else next.hooks = hooksRoot;
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    }
    out.push({ client: id, scope, path, written: changed, events: removed });
  }
  return out;
}

// ─── which client is the user ACTUALLY using? (client detection) ──────────────

/** One reason a client was detected, so the choice can be explained rather than asserted. */
export interface ClientSignal {
  client: ClientId;
  /** `env` = this process is running inside that client right now (strongest). `repo` = the
   *  repository already carries that client's own configuration. */
  source: 'env' | 'repo';
  /** The concrete variable or path that produced the signal — printed to the user verbatim. */
  evidence: string;
}

export interface ClientDetection {
  /** Detected clients, environment signals first, de-duplicated. Empty when nothing was detected. */
  clients: ClientId[];
  signals: ClientSignal[];
}

/**
 * Environment signals — what is running RIGHT NOW. Each entry names a variable the client itself
 * sets, never one a user might plausibly export for another reason (`GEMINI_API_KEY`, for example,
 * says a key exists, not that the Gemini CLI is driving this session).
 */
const ENV_SIGNALS: { client: ClientId; vars: string[]; termProgram?: string[] }[] = [
  { client: 'claude', vars: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] },
  { client: 'cursor', vars: ['CURSOR_TRACE_ID'], termProgram: ['cursor'] },
  { client: 'windsurf', vars: ['WINDSURF_SESSION_ID'], termProgram: ['windsurf'] },
  { client: 'codex', vars: ['CODEX_SANDBOX', 'CODEX_HOME'] },
  { client: 'gemini', vars: ['GEMINI_CLI', 'GEMINI_SANDBOX'] },
  // VS Code LAST among the editors: Cursor and Windsurf are VS Code forks and set VSCODE_* too, so
  // an earlier match must win. VS Code's own agent IS Copilot — the `vscode` adapter deliberately
  // has no instruction file and points here — so the detected client for instructions is `copilot`.
  { client: 'copilot', vars: ['VSCODE_PID', 'VSCODE_GIT_ASKPASS_MAIN'], termProgram: ['vscode'] },
];

/**
 * Repository signals — configuration THIS client created, used only when no environment signal
 * identifies the running client.
 *
 * `cribOwned` marks paths crib itself writes. Such a path is evidence only when it holds content
 * beyond crib's own managed block: after one over-broad install, `GEMINI.md` exists in every repo,
 * and treating crib's own output as proof the user runs Gemini would make the original mistake
 * permanent and self-justifying.
 */
const REPO_SIGNALS: { client: ClientId; path: string; cribOwned: boolean }[] = [
  { client: 'claude', path: '.claude', cribOwned: false },
  { client: 'claude', path: 'CLAUDE.md', cribOwned: true },
  { client: 'cursor', path: '.cursor', cribOwned: true },
  { client: 'copilot', path: '.github/copilot-instructions.md', cribOwned: true },
  { client: 'copilot', path: '.vscode', cribOwned: false },
  { client: 'windsurf', path: '.windsurfrules', cribOwned: true },
  { client: 'gemini', path: '.gemini', cribOwned: false },
  { client: 'gemini', path: 'GEMINI.md', cribOwned: true },
  { client: 'codex', path: '.codex', cribOwned: false },
];

/**
 * True when a file's ONLY substantive content is crib's managed block (plus optional Cursor
 * frontmatter). Such a file is crib's own footprint, not evidence that the user uses that client.
 */
function isCribOnlyFile(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  const begin = text.indexOf(ADAPTER_BEGIN);
  const end = text.indexOf(ADAPTER_END);
  if (begin === -1 || end === -1) return false;
  const outside = (text.slice(0, begin) + text.slice(end + ADAPTER_END.length))
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, '') // Cursor frontmatter crib writes itself
    .trim();
  return outside.length === 0;
}

/**
 * Which client(s) is this user actually working in?
 *
 * `crib init` used to wire EVERY known client unconditionally, so a developer working in one editor
 * got `GEMINI.md`, `.windsurfrules`, `.cursor/rules/` and `AGENTS.md` dropped into their repository
 * alongside the one file they wanted. Files a user did not ask for are not a harmless default: they
 * are committed, reviewed, and inherited by everyone who clones the repo.
 *
 * Environment signals win over repository signals — what is running now beats what was configured
 * once. Both are returned so the caller can SHOW its reasoning instead of silently choosing.
 */
export function detectClients(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ClientDetection {
  const signals: ClientSignal[] = [];
  const term = (env.TERM_PROGRAM ?? '').toLowerCase();
  for (const { client, vars, termProgram } of ENV_SIGNALS) {
    const hitVar = vars.find((v) => (env[v] ?? '').length > 0);
    if (hitVar) {
      signals.push({ client, source: 'env', evidence: hitVar });
      continue;
    }
    if (termProgram?.includes(term)) {
      signals.push({ client, source: 'env', evidence: `TERM_PROGRAM=${env.TERM_PROGRAM}` });
    }
  }
  // A running client is the answer; do not dilute it with stale repository configuration.
  if (signals.length === 0) {
    for (const { client, path, cribOwned } of REPO_SIGNALS) {
      const abs = join(repoRoot, path);
      if (!existsSync(abs)) continue;
      if (cribOwned && isCribOnlyFile(abs)) continue;
      signals.push({ client, source: 'repo', evidence: path });
    }
  }
  const clients: ClientId[] = [];
  for (const s of signals) if (!clients.includes(s.client)) clients.push(s.client);
  return { clients, signals };
}

/** The MCP config target for a detected client. Copilot has no MCP config of its own — VS Code's
 *  `.vscode/mcp.json` IS the Copilot config — so it maps onto the `vscode` writer. */
export function mcpIdeForClient(
  client: ClientId,
): 'claude' | 'cursor' | 'vscode' | 'codex' | 'windsurf' | 'gemini' {
  return client === 'copilot' ? 'vscode' : client;
}
