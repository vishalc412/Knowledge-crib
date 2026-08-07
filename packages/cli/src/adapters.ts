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
 * This module is the per-client registry: which instruction file each client reads, and where each
 * client installs skills. MCP config wiring lives in `mcp-install.ts` (reusing its writers); adding a
 * client = add a `ClientAdapter` entry here + an `McpIde` target there, not a third hardcoded switch.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

export interface ClientAdapter {
  id: ClientId;
  /** Human-readable label for `crib adapters list`. */
  label: string;
  /** Instruction file targets for a scope (the neutral protocol), or `null` when this client reads
   *  no dedicated instruction file (VS Code's agent IS Copilot → `.github/copilot-instructions.md`). */
  instructionTargets(scope: AdapterScope, repoRoot: string): InstructionTarget[] | null;
  /** Skill install destination root, or `null` when this client has no skill mechanism. */
  skillDest(home: string): string | null;
}

/** HTML-comment markers delimiting the managed block. Chosen so the block is invisible to a markdown
 *  renderer (renders as an HTML comment) yet trivially locatable for idempotent replace/remove. */
export const ADAPTER_BEGIN = '<!-- crib:start -->';
export const ADAPTER_END = '<!-- crib:end -->';

/** Cursor `.mdc` rule frontmatter (written above the managed block on a fresh file). `alwaysApply`
 *  makes Cursor inject the rule into every session, matching the AGENTS.md-always-loaded contract. */
export const CURSOR_FRONTMATTER = [
  '---',
  'description: Knowledge-crib agent memory protocol — recall via brief, record reusable learnings, provide evidence, never self-evaluate.',
  'globs: "**/*"',
  'alwaysApply: true',
  '---',
  '',
].join('\n');

/**
 * The neutral protocol body — the SAME content for every client's instruction file and the root
 * `AGENTS.md`. Vendor-neutral: names the `brief` MCP tool (not a client-specific command), states the
 * record-only-reusable-learnings rule, the admissible-evidence/no-self-evaluation rule, and the
 * non-destructive rule (memory is not in this file). Exported so tests assert it without re-deriving.
 */
export function neutralProtocolBody(): string {
  return [
    '## Knowledge-crib agent memory protocol (vendor-neutral)',
    '',
    'This repository uses knowledge-crib as a shared, vendor-neutral memory substrate. Every agent session — Claude, Cursor, Copilot/VS Code, Codex, Windsurf, Gemini, or any MCP-capable tool — follows this protocol. It does not change your tool; it tells you how to use memory safely.',
    '',
    '### 1. Recall before you act',
    '- Before relying on a reusable claim, call the `brief` MCP tool (or `crib memory recall "<query>"`) to surface team + local memory for this repository. Memory is the source of truth across sessions — do not assume last session’s state still holds.',
    '- `brief` returns typed groups: team before local, valid before degraded, current before needs-review. Never mix memory results with BM25 code-search results into one opaque list.',
    '',
    '### 2. Record only reusable learnings',
    '- Persist a memory (via `memory_observe`, or `crib memory propose/attest`) ONLY when it is reusable beyond the current task: a non-obvious fact, a verified procedure, a decision with rationale, a pitfall and its fix, or a convention.',
    '- NEVER persist ephemeral state, full transcripts, chain-of-thought, raw command output, or secrets. Default `brief` stays within 2,000 tokens; default recall within 1,200.',
    '',
    '### 3. Provide evidence — never self-evaluate',
    '- Every memory must carry admissible evidence grounded in the repository: source-quote, execution-assertion, committed-policy, human-attestation, or receipt-pair. An agent NEVER self-asserts a pass: a passing local gate produces a receipt; team trust requires both CI success AND presence on a configured trusted Git ref.',
    '- Never claim a memory is verified, trusted, or current on your own authority. State what you observed; the freshness engine derives those verdicts from the evidence.',
    '',
    '### 4. Non-destructive',
    '- Memory lives in `.crib/memory/` (team) and `~/.crib/memory/` (local/global) — NOT in this file. Removing this adapter (or this client) removes only this managed block; it does not delete memory. On disagreement do not delete team memory; supersede or quarantine it with admissible counter-evidence instead.',
  ].join('\n');
}

/** The full managed block (markers + body) spliced into each instruction file. */
export function neutralProtocolBlock(): string {
  return `${ADAPTER_BEGIN}\n${neutralProtocolBody()}\n${ADAPTER_END}`;
}

// ─── client registry ──────────────────────────────────────────────────────────

/** All supported clients, in the order `crib adapters install --client all` writes them. */
export const CLIENT_ADAPTERS: ClientAdapter[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    instructionTargets: (scope, repoRoot) =>
      scope === 'project' ? [{ path: join(repoRoot, 'CLAUDE.md'), format: 'md' }] : null,
    skillDest: (home) => join(home, '.claude', 'skills'),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    instructionTargets: (scope, repoRoot) =>
      scope === 'project'
        ? [{ path: join(repoRoot, '.cursor', 'rules', 'crib.mdc'), format: 'mdc' }]
        : null,
    skillDest: (home) => join(home, '.cursor', 'rules'),
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    instructionTargets: (scope, repoRoot) =>
      scope === 'project'
        ? [{ path: join(repoRoot, '.github', 'copilot-instructions.md'), format: 'md' }]
        : null,
    skillDest: () => null,
  },
  {
    id: 'vscode',
    label: 'VS Code',
    // VS Code's agent IS Copilot, which reads `.github/copilot-instructions.md`; VS Code has no
    // separate agent-instruction file, so no instruction target here. MCP wiring is offered via
    // `crib mcp install --ide vscode`.
    instructionTargets: () => null,
    skillDest: () => null,
  },
  {
    id: 'codex',
    label: 'Codex',
    // Codex reads `AGENTS.md` natively (same file as the root neutral protocol).
    instructionTargets: (scope, repoRoot) =>
      scope === 'project' ? [{ path: join(repoRoot, 'AGENTS.md'), format: 'md' }] : null,
    skillDest: () => null,
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    instructionTargets: (scope, repoRoot) =>
      scope === 'project' ? [{ path: join(repoRoot, '.windsurfrules'), format: 'md' }] : null,
    skillDest: () => null,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    instructionTargets: (scope, repoRoot) =>
      scope === 'project' ? [{ path: join(repoRoot, 'GEMINI.md'), format: 'md' }] : null,
    skillDest: () => null,
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

/** Resolve the skill install destination for a client (or `null` if it has no skill mechanism). */
export function skillDestFor(client: ClientId, home?: string): string | null {
  return clientAdapter(client).skillDest(home ?? process.env.HOME ?? '');
}

// ─── managed-block splice (markdown) ──────────────────────────────────────────

/** Read a file as text, or `''` if absent. */
function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Splice the managed block into `content`, replacing any existing block in place (never duplicating).
 *  Everything outside the markers is preserved byte-for-byte. */
export function spliceAdapterBlock(content: string, block: string): string {
  const beginIdx = content.indexOf(ADAPTER_BEGIN);
  if (beginIdx === -1) {
    const tail = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    return `${content}${tail}${block}\n`;
  }
  const endIdx = content.indexOf(ADAPTER_END, beginIdx);
  const before = content.slice(0, beginIdx);
  const after = endIdx === -1 ? '' : content.slice(endIdx + ADAPTER_END.length);
  const ensuredNl = (s: string) => (s.length > 0 && !s.endsWith('\n') ? `${s}\n` : s);
  return `${ensuredNl(before)}${block}\n${after.replace(/^\n/, '')}`;
}

/** Remove the managed block from `content`, preserving everything outside the markers. */
export function removeAdapterBlock(content: string): string {
  const beginIdx = content.indexOf(ADAPTER_BEGIN);
  if (beginIdx === -1) return content;
  const endIdx = content.indexOf(ADAPTER_END, beginIdx);
  const before = content.slice(0, beginIdx);
  const after = endIdx === -1 ? '' : content.slice(endIdx + ADAPTER_END.length);
  return `${before}${after.replace(/^\n/, '')}`;
}

/** Build the full on-disk content for an instruction target's managed block (mdc prepends
 *  frontmatter when the file is fresh; existing frontmatter is preserved on refresh). */
function blockForTarget(target: InstructionTarget): string {
  return neutralProtocolBlock();
}

/** True if `content` is empty or ONLY Cursor frontmatter (no user body) — i.e. a crib-owned rule file
 *  that is safe to delete on remove. */
function isOnlyFrontmatter(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed === '') return true;
  return /^---\n[\s\S]*\n---\s*$/.test(trimmed);
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
        // user-edited frontmatter above the managed block).
        const hasFrontmatter = /^---\n[\s\S]*?\n---/.test(existing);
        const withFrontmatter = hasFrontmatter ? existing : `${CURSOR_FRONTMATTER}${existing}`;
        next = spliceAdapterBlock(withFrontmatter, blockForTarget(target));
      } else {
        next = spliceAdapterBlock(existing, blockForTarget(target));
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
        if (isOnlyFrontmatter(next)) {
          // crib-owned rule file (empty or frontmatter-only after block removal) → delete it.
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
