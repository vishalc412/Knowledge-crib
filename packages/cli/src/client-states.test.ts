import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntelligenceEventJournal, resolveServerIdentity } from '@knowledge-crib/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCaptureHooks, installInstructions } from './adapters.js';
import {
  clientOfReportedName,
  clientStateReport,
  unknownConnectedClients,
} from './client-states.js';
import { installMcp } from './mcp-install.js';

const EMPTY_ENV: NodeJS.ProcessEnv = {};
let repo: string;
let home: string;
let journalRoot: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-states-'));
  // An isolated HOME so the dev machine's real global MCP configs (crib is installed in all
  // six clients here) cannot leak into the report — the report reads user-scope config through
  // `home`, exactly as an operator on a clean machine would have it.
  home = mkdtempSync(join(tmpdir(), 'crib-states-home-'));
  journalRoot = join(repo, '.crib', 'intelligence');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function journal(): IntelligenceEventJournal {
  return new IntelligenceEventJournal({ rootDir: journalRoot });
}

function appendEvent(
  kind: 'mcp.connection' | 'mcp.tool-invoked' | 'agent.lifecycle',
  clientId: string,
  opts: { idempotencyKey?: string; occurredAt?: string } = {},
): void {
  journal().append({
    kind,
    idempotencyKey: opts.idempotencyKey ?? `${kind}:${clientId}:${Math.random()}`,
    source: { clientId },
    identity: resolveServerIdentity({}),
    occurredAt: opts.occurredAt ?? '2026-09-08T10:00:00.000Z',
  });
}

/**
 * WP2.5 — the install report's four states. The property under test is not the ladder order
 * alone but the honesty boundary: a client whose ONLY evidence is a config file must read as
 * `config-written`, never as connected or certified (WP2.7: "instructions say mandatory" is not
 * runtime proof).
 */
describe('clientStateReport (WP2.5 four install states)', () => {
  it('reports every client absent in an empty repository', () => {
    const reports = clientStateReport(repo, { env: EMPTY_ENV, home });
    expect(reports.map((r) => r.client)).toHaveLength(7);
    for (const r of reports) {
      expect(r.state).toBe('absent');
      expect(r.configWritten).toBe(false);
      expect(r.clientDetected).toBe(false);
      expect(r.mcpConnected).toBe(false);
      expect(r.runtimeCertified).toBe(false);
    }
  });

  it('stops at config-written when only config exists — configuration is never runtime proof', () => {
    installInstructions(repo, { client: 'claude', scope: 'project' });
    installCaptureHooks(repo, { client: 'claude', scope: 'project', home: repo });
    const claude = clientStateReport(repo, { client: 'claude', env: EMPTY_ENV, home })[0]!;
    expect(claude.state).toBe('config-written');
    expect(claude.configWritten).toBe(true);
    expect(claude.evidence.instructions).toBe(true);
    expect(claude.evidence.hooks.length).toBeGreaterThan(0);
    expect(claude.evidence.mcpEntry).toBe(false); // neither lane writes the MCP config
    expect(claude.clientDetected).toBe(false);
    expect(claude.note).toContain('not runtime proof');
  });

  it('reaches client-detected on a machine signal', () => {
    installInstructions(repo, { client: 'codex', scope: 'project' });
    const codex = clientStateReport(repo, {
      client: 'codex',
      env: { CODEX_HOME: join(repo, '.codex') },
      home,
    })[0]!;
    expect(codex.state).toBe('client-detected');
    expect(codex.clientDetected).toBe(true);
    expect(codex.evidence.detection).toContain('CODEX_HOME');
  });

  it('reaches mcp-connected on a journal mcp.connection event, with the timestamp', () => {
    installInstructions(repo, { client: 'claude', scope: 'project' });
    appendEvent('mcp.connection', 'claude-code', { occurredAt: '2026-09-07T09:00:00.000Z' });
    const claude = clientStateReport(repo, { client: 'claude', env: EMPTY_ENV, home })[0]!;
    expect(claude.state).toBe('mcp-connected');
    expect(claude.evidence.connectedAt).toBe('2026-09-07T09:00:00.000Z');
    expect(claude.note).toContain('connected at 2026-09-07T09:00:00.000Z');
  });

  it('reaches runtime-certified on a tool-invoked event', () => {
    appendEvent('mcp.connection', 'claude-code');
    appendEvent('mcp.tool-invoked', 'claude-code', { occurredAt: '2026-09-08T09:12:00.000Z' });
    const claude = clientStateReport(repo, { client: 'claude', env: EMPTY_ENV, home })[0]!;
    expect(claude.state).toBe('runtime-certified');
    expect(claude.evidence.invokedAt).toBe('2026-09-08T09:12:00.000Z');
  });

  it('reaches runtime-certified through the hook lane (agent.lifecycle, hook: idempotency)', () => {
    appendEvent('agent.lifecycle', 'claude-code-hook', {
      idempotencyKey: 'hook:turn-end:session-1:3',
      occurredAt: '2026-09-08T08:00:00.000Z',
    });
    const claude = clientStateReport(repo, { client: 'claude', env: EMPTY_ENV, home })[0]!;
    expect(claude.state).toBe('runtime-certified');
    expect(claude.evidence.hookFiredAt).toBe('2026-09-08T08:00:00.000Z');
    expect(claude.evidence.invokedAt).toBeUndefined();
  });

  it('does not count the MCP server’s own activity breadcrumb as client runtime evidence', () => {
    appendEvent('agent.lifecycle', 'knowledge-crib-mcp', {
      idempotencyKey: 'mcp:activity:s1:abc:1',
    });
    const claude = clientStateReport(repo, { client: 'claude', env: EMPTY_ENV, home })[0]!;
    expect(claude.runtimeCertified).toBe(false);
  });

  it('treats a written MCP entry alone as config-written (no instruction file needed)', () => {
    installMcp(repo, { ide: 'cursor', scope: 'project' });
    const cursor = clientStateReport(repo, { client: 'cursor', env: EMPTY_ENV, home })[0]!;
    expect(cursor.state).toBe('config-written');
    expect(cursor.evidence.mcpEntry).toBe(true);
    expect(cursor.evidence.instructions).toBe(false);
  });

  it('reports an unreadable journal as unknown, never as proven-absent', () => {
    installInstructions(repo, { client: 'claude', scope: 'project' });
    mkdirSync(journalRoot, { recursive: true });
    writeFileSync(join(journalRoot, 'intelligence-events.jsonl'), '{corrupt\n{also-corrupt\n');
    const claude = clientStateReport(repo, { client: 'claude', env: EMPTY_ENV, home })[0]!;
    expect(claude.state).toBe('config-written');
    expect(claude.evidence.journalNote).toContain('unreadable');
  });

  it('attributes a connection with the latest timestamp when several exist', () => {
    appendEvent('mcp.connection', 'cursor', { occurredAt: '2026-09-01T00:00:00.000Z' });
    appendEvent('mcp.connection', 'cursor', { occurredAt: '2026-09-05T00:00:00.000Z' });
    const cursor = clientStateReport(repo, { client: 'cursor', env: EMPTY_ENV, home })[0]!;
    expect(cursor.evidence.connectedAt).toBe('2026-09-05T00:00:00.000Z');
  });
});

describe('clientOfReportedName', () => {
  it('maps the handshake names every client actually reports', () => {
    expect(clientOfReportedName('claude-code')).toBe('claude');
    expect(clientOfReportedName('Claude Code')).toBe('claude');
    expect(clientOfReportedName('claude-code-hook')).toBe('claude');
    expect(clientOfReportedName('cursor')).toBe('cursor');
    expect(clientOfReportedName('codex')).toBe('codex');
    expect(clientOfReportedName('windsurf')).toBe('windsurf');
    expect(clientOfReportedName('gemini-cli')).toBe('gemini');
    expect(clientOfReportedName('Visual Studio Code')).toBe('copilot');
    expect(clientOfReportedName('github-copilot')).toBe('copilot');
  });

  it('returns undefined for names crib does not know, and surfaces them as unknown evidence', () => {
    expect(clientOfReportedName('some-future-client')).toBeUndefined();
    appendEvent('mcp.connection', 'some-future-client');
    expect(unknownConnectedClients(journalRoot)).toEqual(['some-future-client']);
    // No known client's state was raised by the unknown connection.
    const claude = clientStateReport(repo, { client: 'claude', env: EMPTY_ENV, home })[0]!;
    expect(claude.mcpConnected).toBe(false);
  });
});
