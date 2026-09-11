import { join } from 'node:path';
import { IntelligenceEventJournal } from '@knowledge-crib/memory';
import {
  ALL_CLIENTS,
  type ClientId,
  type ClientSignal,
  detectClients,
  listCaptureHooks,
  listInstructions,
} from './adapters.js';
import { type McpIde, listMcp } from './mcp-install.js';

/**
 * WP2.5 / WP2.7 — the four install states, as a ladder a client climbs only on EVIDENCE:
 *
 *   absent            — crib wrote nothing for this client
 *   config-written    — crib wrote config (instruction block, capture hooks, or MCP entry)
 *   client-detected   — AND this machine shows the client (env or repo signal)
 *   mcp-connected     — AND the intelligence journal shows a real MCP handshake from that client
 *   runtime-certified — AND the journal shows that client actually USING crib (tool invocation or
 *                       a lifecycle capture hook firing)
 *
 * The gap this closes: an install report used to say "installed" the moment a file was written,
 * which quietly treated "the instructions say mandatory" as proof the client was running (WP2.7).
 * Configuration is state 1 of 4, never the end of the story. States 3 and 4 cannot be derived
 * from any file — they come from `mcp.connection` / `mcp.tool-invoked` / hook-lane
 * `agent.lifecycle` events in the intelligence journal, which the MCP server and capture hooks
 * append as runtime evidence.
 */
export type ClientInstallState =
  | 'absent'
  | 'config-written'
  | 'client-detected'
  | 'mcp-connected'
  | 'runtime-certified';

/** Which MCP-config lane a ClientId maps onto (VS Code's agent is Copilot; one config surface). */
const MCP_IDE_OF: Record<ClientId, McpIde> = {
  claude: 'claude',
  cursor: 'cursor',
  copilot: 'vscode',
  vscode: 'vscode',
  codex: 'codex',
  windsurf: 'windsurf',
  gemini: 'gemini',
};

/**
 * The MCP handshake reports each client's own `clientInfo.name`; the capture hooks report a
 * `client_id` payload (default `claude-code-hook`). Both must map back onto a ClientId before
 * their evidence can raise a client's state — an unrecognized name is reported as unknown
 * evidence, never folded into a plausible client.
 */
const CLIENT_NAME_ALIASES: Record<string, ClientId> = {
  // Claude Code (CLI, IDE extension, and the capture-hook lane's default id)
  claudecode: 'claude',
  claude: 'claude',
  claudecli: 'claude',
  claudecodehook: 'claude',
  // Cursor
  cursor: 'cursor',
  cursorvscode: 'cursor',
  // Codex
  codex: 'codex',
  codexcli: 'codex',
  openaicodex: 'codex',
  // Windsurf
  windsurf: 'windsurf',
  codeium: 'windsurf',
  // Gemini CLI
  geminicli: 'gemini',
  gemini: 'gemini',
  googlegemini: 'gemini',
  // VS Code / Copilot
  vscode: 'copilot',
  visualstudiocode: 'copilot',
  copilot: 'copilot',
  githubcopilot: 'copilot',
  copilotvscode: 'copilot',
};

/** Resolve a client-reported name to a ClientId, or `undefined` when crib does not know it. */
export function clientOfReportedName(name: string): ClientId | undefined {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return CLIENT_NAME_ALIASES[key];
}

/** The timestamps and signals behind each rung, so a report can SHOW its reasoning. */
export interface ClientStateEvidence {
  /** Which config lanes are written, and where. */
  instructions: boolean;
  hooks: string[];
  mcpEntry: boolean;
  /** The concrete detection signal (`CLAUDECODE` / `.claude` exists), verbatim. */
  detection?: string;
  /** ISO time of the latest `mcp.connection` event from this client. */
  connectedAt?: string;
  /** ISO time of the latest `mcp.tool-invoked` event from this client. */
  invokedAt?: string;
  /** ISO time of the latest hook-lane `agent.lifecycle` event from this client. */
  hookFiredAt?: string;
  /** The journal could not be read (corruption/permission). Rungs 3-4 are unknown, not absent. */
  journalNote?: string;
}

export interface ClientStateReport {
  client: ClientId;
  state: ClientInstallState;
  /** The rung booleans are reported independently: state is the highest achieved, but a gap in a
   *  lower rung (config written, client never detected) stays visible instead of being averaged
   *  away. */
  configWritten: boolean;
  clientDetected: boolean;
  mcpConnected: boolean;
  runtimeCertified: boolean;
  evidence: ClientStateEvidence;
  /** The honest sentence: what this state rests on, and what is still missing. */
  note: string;
}

export interface ClientStateOptions {
  client?: ClientId | 'all';
  /** Scope for the instruction/hook config lanes, matching `crib adapters` (default project). */
  scope?: 'project' | 'global';
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** The repo's intelligence journal root. Defaults to `<repoRoot>/.crib/intelligence`. */
  journalRoot?: string;
}

/** Journal runtime evidence per client, plus the names crib could not attribute. */
interface RuntimeEvidence {
  connectedAt: Map<ClientId, string>;
  invokedAt: Map<ClientId, string>;
  hookFiredAt: Map<ClientId, string>;
  unknownClients: string[];
  note?: string;
}

/** Read the intelligence journal for runtime evidence. A client's own `clientInfo.name` (or hook
 *  `client_id`) is provenance: it selects which client's rung the event raises, nothing more. */
function runtimeEvidence(journalRoot: string | undefined): RuntimeEvidence {
  const out: RuntimeEvidence = {
    connectedAt: new Map(),
    invokedAt: new Map(),
    hookFiredAt: new Map(),
    unknownClients: [],
  };
  if (!journalRoot) return out;
  try {
    const journal = new IntelligenceEventJournal({ rootDir: journalRoot });
    for (const event of journal.read({ includeExpired: true })) {
      const client = clientOfReportedName(event.source.clientId);
      if (!client) {
        if (
          event.kind === 'mcp.connection' &&
          event.source.clientId !== 'knowledge-crib-mcp' &&
          !out.unknownClients.includes(event.source.clientId)
        )
          out.unknownClients.push(event.source.clientId);
        continue;
      }
      const latest = (map: Map<ClientId, string>): void => {
        const prev = map.get(client);
        if (prev === undefined || prev < event.occurredAt) map.set(client, event.occurredAt);
      };
      if (event.kind === 'mcp.connection') latest(out.connectedAt);
      else if (event.kind === 'mcp.tool-invoked') latest(out.invokedAt);
      // Hook-lane lifecycle events: the capture hooks append `agent.lifecycle` with the client's
      // own id (`claude-code-hook`). The MCP server's `noteSessionActivity` uses the reserved
      // `knowledge-crib-mcp` id, which `clientOfReportedName` deliberately does not resolve — its
      // activity proves the SERVER ran, not that this client's hook lane fired.
      else if (event.kind === 'agent.lifecycle' && event.idempotencyKey.startsWith('hook:'))
        latest(out.hookFiredAt);
    }
  } catch (error) {
    // The journal is evidence, not infrastructure: an unreadable journal must never fail the
    // report, but its rungs read as UNKNOWN — the note says so, so "absent" is never claimed
    // where "could not check" is the truth.
    const message = error instanceof Error ? error.message : String(error);
    out.note = `intelligence journal unreadable — runtime states unknown, not absent (${message})`;
  }
  return out;
}

/** One client's ladder position, with the evidence that put it there. */
function stateOf(
  id: ClientId,
  config: { instructions: boolean; hooks: string[]; mcpEntry: boolean },
  signals: ClientSignal[],
  runtime: RuntimeEvidence,
): ClientStateReport {
  const configWritten = config.instructions || config.hooks.length > 0 || config.mcpEntry;
  const clientDetected = signals.length > 0;
  const mcpConnected = runtime.connectedAt.get(id) !== undefined;
  const runtimeCertified =
    runtime.invokedAt.get(id) !== undefined || runtime.hookFiredAt.get(id) !== undefined;
  const evidence: ClientStateEvidence = {
    instructions: config.instructions,
    hooks: config.hooks,
    mcpEntry: config.mcpEntry,
    ...(signals[0] ? { detection: `${signals[0].source}: ${signals[0].evidence}` } : {}),
    ...(runtime.connectedAt.get(id) ? { connectedAt: runtime.connectedAt.get(id) } : {}),
    ...(runtime.invokedAt.get(id) ? { invokedAt: runtime.invokedAt.get(id) } : {}),
    ...(runtime.hookFiredAt.get(id) ? { hookFiredAt: runtime.hookFiredAt.get(id) } : {}),
    ...(runtime.note ? { journalNote: runtime.note } : {}),
  };

  const state: ClientInstallState = runtimeCertified
    ? 'runtime-certified'
    : mcpConnected
      ? 'mcp-connected'
      : clientDetected
        ? 'client-detected'
        : configWritten
          ? 'config-written'
          : 'absent';

  const lanes = [
    config.instructions ? 'instructions' : null,
    config.hooks.length > 0 ? `hooks (${config.hooks.join(', ')})` : null,
    config.mcpEntry ? 'mcp entry' : null,
  ].filter(Boolean);
  const note =
    state === 'absent'
      ? 'nothing written for this client'
      : state === 'config-written'
        ? `config written (${lanes.join(', ')}) but no evidence this client is present on this machine — configuration is not runtime proof`
        : state === 'client-detected'
          ? `config written (${lanes.join(', ')}) and client detected (${evidence.detection}); no MCP connection recorded yet — restart the client or run a crib tool once`
          : state === 'mcp-connected'
            ? `connected at ${evidence.connectedAt} but no tool invocation recorded — the client attached yet never used crib`
            : `runtime evidence recorded (last: ${
                evidence.invokedAt ?? evidence.hookFiredAt ?? ''
              }) — the client attached and used crib`;
  return {
    client: id,
    state,
    configWritten,
    clientDetected,
    mcpConnected,
    runtimeCertified,
    evidence,
    note,
  };
}

/**
 * Client names seen in `mcp.connection` journal events that crib cannot attribute to a known
 * client. Surfaced by `crib adapters status` so evidence is never silently dropped — a report
 * that ignored an unknown client would claim completeness it does not have.
 */
export function unknownConnectedClients(journalRoot: string | undefined): string[] {
  return runtimeEvidence(journalRoot).unknownClients;
}

/**
 * The four-state install report for every client (WP2.5). Pure read: config lanes via
 * `listInstructions` / `listCaptureHooks` / `listMcp`, detection via `detectClients`, and states
 * 3-4 from the intelligence journal. Never writes, never treats configuration as runtime proof.
 */
export function clientStateReport(
  repoRoot: string,
  opts: ClientStateOptions = {},
): ClientStateReport[] {
  const ids: ClientId[] = opts.client && opts.client !== 'all' ? [opts.client] : ALL_CLIENTS;
  const scope = opts.scope ?? 'project';
  const detection = detectClients(repoRoot, opts.env ?? process.env);
  const runtime = runtimeEvidence(opts.journalRoot ?? join(repoRoot, '.crib', 'intelligence'));

  const reports: ClientStateReport[] = [];
  for (const id of ids) {
    const listOpts = { client: id, scope, ...(opts.home ? { home: opts.home } : {}) } as const;
    const instructionEntry = listInstructions(repoRoot, listOpts).find((e) => e.client === id);
    const hookEntry = listCaptureHooks(repoRoot, listOpts).find((e) => e.client === id);
    // The MCP entry may live in project or global config — either is written config.
    const mcpEntry = listMcp(repoRoot, {
      ide: MCP_IDE_OF[id],
      ...(opts.home ? { home: opts.home } : {}),
    }).some((e) => e.present);
    reports.push(
      stateOf(
        id,
        {
          instructions: instructionEntry?.present ?? false,
          hooks: hookEntry?.events ?? [],
          mcpEntry,
        },
        detection.signals.filter((s) => s.client === id),
        runtime,
      ),
    );
  }
  return reports;
}
