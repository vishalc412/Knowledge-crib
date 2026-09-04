import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADAPTER_BEGIN,
  ADAPTER_END,
  ALL_CLIENTS,
  CAPTURE_HOOK_COMMAND_MARKER,
  type ClientId,
  LIFECYCLE_EVENTS,
  type ToolManifestView,
  captureHookCommand,
  captureLaneManifestViolations,
  captureLaneSummary,
  clientAdapter,
  installCaptureHooks,
  installInstructions,
  lifecycleInvariants,
  listCaptureHooks,
  listInstructions,
  neutralProtocolBody,
  removeAdapterBlock,
  removeCaptureHooks,
  removeInstructions,
  skillDestFor,
  spliceAdapterBlock,
} from './adapters.js';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-adapters-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('CLIENT_ADAPTERS — registry completeness', () => {
  it('has all 7 clients in a stable order', () => {
    expect(ALL_CLIENTS).toEqual([
      'claude',
      'cursor',
      'copilot',
      'vscode',
      'codex',
      'windsurf',
      'gemini',
    ]);
  });

  it('every client resolves a valid project-scope target (except vscode, which has none)', () => {
    for (const id of ALL_CLIENTS) {
      const adapter = clientAdapter(id);
      const targets = adapter.instructionTargets('project', repo);
      if (id === 'vscode') {
        expect(targets, `${id} should have no instruction target`).toBeNull();
      } else {
        expect(targets, `${id} should have a target`).not.toBeNull();
        expect(targets!.length).toBe(1);
        expect(targets![0]!.path.startsWith(repo)).toBe(true);
      }
    }
  });

  it('global scope yields no instruction targets for every client', () => {
    for (const id of ALL_CLIENTS) {
      expect(clientAdapter(id).instructionTargets('global', repo)).toBeNull();
    }
  });

  it('only claude has a skill destination (cursor loads .mdc rules, not SKILL.md dirs)', () => {
    expect(skillDestFor('claude', '/home/u')).toBe('/home/u/.claude/skills');
    for (const id of ALL_CLIENTS) {
      if (id !== 'claude') expect(skillDestFor(id, '/home/u'), `${id}`).toBeNull();
    }
  });
});

describe('neutralProtocolBody — vendor-neutral contract', () => {
  it('names the brief tool and the no-self-evaluate + non-destructive rules', () => {
    const body = neutralProtocolBody();
    expect(body).toContain('`brief`');
    expect(body).toMatch(/never self-evaluate/i);
    expect(body).toMatch(/non-destructive/i);
    expect(body).toContain('.crib/memory/');
    expect(body).toMatch(/removing this adapter/i);
  });

  it('carries crib-native code-intelligence rules, so no third-party block is needed', () => {
    const body = neutralProtocolBody();
    // crib's OWN verbs — the repo must never depend on another tool's instruction block for the
    // "analyse impact before you edit / graph changes before you commit" discipline.
    expect(body).toContain('`impact(');
    expect(body).toContain('`detect_changes(');
    expect(body).toContain('`rename(');
    expect(body).toMatch(/never rename with find-and-replace/i);
  });

  it("states crib's own honesty signals rather than another tool's verdicts", () => {
    const body = neutralProtocolBody();
    // crib grades `risk` by DISTANCE; it has no UNKNOWN verdict and no riskNote. Describing it with
    // another tool's contract would tell agents to look for fields crib never returns.
    expect(body).toMatch(/distance-derived/i);
    expect(body).not.toContain('UNKNOWN');
    expect(body).not.toContain('riskNote');
    // the three signals crib DOES return and an agent must not read as an all-clear
    expect(body).toMatch(/empty `affected` list is NOT evidence/i);
    expect(body).toContain('`truncated: true`');
    expect(body).toMatch(/a `note` QUALIFIES the report/i);
    expect(body).toContain('`uncommittedPaths`');
  });
});

describe('neutralProtocolBody — no third-party coupling', () => {
  it("never names another vendor's tooling", () => {
    const body = neutralProtocolBody().toLowerCase();
    // The protocol is spliced into every client's instruction file in every repo crib indexes, so a
    // third-party tool name here would make that tool a de-facto dependency of using crib at all.
    for (const vendor of ['gitnexus', 'graphify', '.gitnexus/']) {
      expect(body).not.toContain(vendor);
    }
  });
});

describe('spliceAdapterBlock — managed-block discipline', () => {
  const block = `${ADAPTER_BEGIN}\nbody\n${ADAPTER_END}`;

  it('appends the block on a fresh file with a separating newline', () => {
    expect(spliceAdapterBlock('hello', block)).toBe(`hello\n${block}\n`);
    expect(spliceAdapterBlock('', block)).toBe(`${block}\n`);
    expect(spliceAdapterBlock('hello\n', block)).toBe(`hello\n${block}\n`);
  });

  it('replaces an existing block in place, preserving sibling content byte-for-byte', () => {
    const before = 'TOP\n';
    const after = '\nBOTTOM\n';
    const existing = `${before}${ADAPTER_BEGIN}\nold\n${ADAPTER_END}${after}`;
    const out = spliceAdapterBlock(existing, block);
    expect(out).toBe(`${before}${block}\n${after.replace(/^\n/, '')}`);
    expect(out).toContain('TOP');
    expect(out).toContain('BOTTOM');
    expect(out).not.toContain('old');
  });

  it('is idempotent — splicing the same block twice yields the same bytes', () => {
    const once = spliceAdapterBlock('sibling\n', block);
    const twice = spliceAdapterBlock(once, block);
    expect(twice).toBe(once);
  });

  it('removeAdapterBlock strips the block and leaves sibling content intact', () => {
    const existing = `TOP\n${ADAPTER_BEGIN}\nbody\n${ADAPTER_END}\nBOTTOM\n`;
    expect(removeAdapterBlock(existing)).toBe('TOP\nBOTTOM\n');
    expect(removeAdapterBlock('no block here')).toBe('no block here');
  });

  it('an orphan begin marker (no end marker) is non-destructive: splice + remove refuse', () => {
    // A truncated/corrupted file with a begin marker but no end marker must NOT discard the unterminated
    // tail — splice returns content unchanged (block not refreshed), remove returns content unchanged.
    const orphan = `TOP\n${ADAPTER_BEGIN}\nUSER_NOTES_BELOW\n`;
    const block = `${ADAPTER_BEGIN}\nbody\n${ADAPTER_END}`;
    expect(spliceAdapterBlock(orphan, block)).toBe(orphan);
    expect(removeAdapterBlock(orphan)).toBe(orphan);
  });
});

describe('removeInstructions — frontmatter-only .md is user content (not deleted)', () => {
  it('does NOT delete a user frontmatter-only .md instruction file on remove', () => {
    // A user-committed CLAUDE.md holding only YAML frontmatter (no body) is sibling content, not a
    // crib-owned file. install appends the block after the frontmatter; remove must strip the block
    // and KEEP the user's frontmatter — never rmSync it.
    const p = join(repo, 'CLAUDE.md');
    writeFileSync(p, '---\ntitle: Mine\n---\n');
    installInstructions(repo, { client: 'claude', scope: 'project' });
    expect(readFileSync(p, 'utf8')).toContain(ADAPTER_BEGIN);
    removeInstructions(repo, { client: 'claude', scope: 'project' });
    expect(existsSync(p), 'user frontmatter-only .md must survive remove').toBe(true);
    const after = readFileSync(p, 'utf8');
    expect(after).not.toContain(ADAPTER_BEGIN);
    expect(after).toContain('title: Mine');
  });
});

describe('installInstructions — CRLF frontmatter', () => {
  it('preserves a user-edited CRLF frontmatter on refresh (no stacked duplicate)', () => {
    installInstructions(repo, { client: 'cursor', scope: 'project' });
    const mdc = join(repo, '.cursor', 'rules', 'crib.mdc');
    // User re-edits the rule with CRLF line endings (VS Code files.eol=\r\n, Notepad, hand-authoring).
    writeFileSync(
      mdc,
      '---\r\ndescription: custom\r\nalwaysApply: false\r\n---\r\n\r\nuser body\r\n',
    );
    installInstructions(repo, { client: 'cursor', scope: 'project' });
    const out = readFileSync(mdc, 'utf8');
    // Exactly one frontmatter block (two `---` fences), not a stacked duplicate.
    expect(out.split('\n').filter((l) => l.trim() === '---').length).toBe(2);
    expect(out).toContain('description: custom');
    expect(out).toContain('alwaysApply: false');
    expect(out).toContain('user body');
    expect(out).toContain(ADAPTER_BEGIN);
  });
});

describe('installInstructions — non-destructive writes', () => {
  it('installs all clients (--client all) and reports vscode as a no-target note', () => {
    const results = installInstructions(repo, { client: 'all', scope: 'project' });
    expect(results.length).toBe(ALL_CLIENTS.length);
    // vscode has no instruction target → empty path + note.
    const vscode = results.find((r) => r.client === 'vscode')!;
    expect(vscode.path).toBe('');
    expect(vscode.written).toBe(false);
    expect(vscode.note).toBeDefined();
    // the other six each wrote a file with the managed block present.
    for (const id of ALL_CLIENTS.filter((c) => c !== 'vscode') as ClientId[]) {
      const r = results.find((x) => x.client === id)!;
      expect(r.written, `${id}`).toBe(true);
      expect(existsSync(r.path), `${id} file`).toBe(true);
      expect(readFileSync(r.path, 'utf8')).toContain(ADAPTER_BEGIN);
    }
  });

  it('preserves sibling user content outside the managed block', () => {
    // Pre-existing AGENTS.md with a GitNexus block + user prose must survive.
    const agentsPath = join(repo, 'AGENTS.md');
    writeFileSync(
      agentsPath,
      '# My repo\n\nSome user instructions.\n\n<!-- gitnexus:start -->\nGN\n<!-- gitnexus:end -->\n',
    );
    installInstructions(repo, { client: 'codex', scope: 'project' });
    const out = readFileSync(agentsPath, 'utf8');
    expect(out).toContain('# My repo');
    expect(out).toContain('Some user instructions.');
    expect(out).toContain('<!-- gitnexus:start -->');
    expect(out).toContain('GN');
    expect(out).toContain(ADAPTER_BEGIN);
    // crib block placed AFTER the existing content (append path).
    expect(out.indexOf('gitnexus:end')).toBeLessThan(out.indexOf(ADAPTER_BEGIN));
  });

  it('writes Cursor frontmatter on a fresh .mdc and preserves user frontmatter on refresh', () => {
    installInstructions(repo, { client: 'cursor', scope: 'project' });
    const mdc = join(repo, '.cursor', 'rules', 'crib.mdc');
    const out = readFileSync(mdc, 'utf8');
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('alwaysApply: true');
    expect(out).toContain(ADAPTER_BEGIN);
    // user-edited frontmatter is preserved on refresh (not overwritten with the crib default).
    writeFileSync(mdc, '---\ndescription: custom\nalwaysApply: false\n---\n\nuser body\n');
    installInstructions(repo, { client: 'cursor', scope: 'project' });
    const refreshed = readFileSync(mdc, 'utf8');
    expect(refreshed).toContain('description: custom');
    expect(refreshed).toContain('alwaysApply: false');
    expect(refreshed).toContain('user body');
    expect(refreshed).toContain(ADAPTER_BEGIN);
  });

  it('is idempotent — a second install reports written:false and changes no bytes', () => {
    installInstructions(repo, { client: 'claude', scope: 'project' });
    const p = join(repo, 'CLAUDE.md');
    const first = readFileSync(p, 'utf8');
    const second = installInstructions(repo, { client: 'claude', scope: 'project' });
    expect(second[0]!.written).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe(first);
  });
});

describe('removeInstructions — non-destructive removal (memory not in these files)', () => {
  it('removes the managed block and leaves sibling user content', () => {
    const p = join(repo, 'CLAUDE.md');
    writeFileSync(p, `# Mine\n\n${ADAPTER_BEGIN}\nx\n${ADAPTER_END}\n\nKeep me\n`);
    const out = removeInstructions(repo, { client: 'claude', scope: 'project' });
    expect(out[0]!.written).toBe(true);
    const after = readFileSync(p, 'utf8');
    expect(after).toContain('# Mine');
    expect(after).toContain('Keep me');
    expect(after).not.toContain(ADAPTER_BEGIN);
  });

  it('deletes a crib-owned file left empty after removal (no user content)', () => {
    installInstructions(repo, { client: 'gemini', scope: 'project' });
    const p = join(repo, 'GEMINI.md');
    expect(existsSync(p)).toBe(true);
    removeInstructions(repo, { client: 'gemini', scope: 'project' });
    expect(existsSync(p), 'empty GEMINI.md should be deleted').toBe(false);
  });

  it('deletes a Cursor rule left frontmatter-only after removal', () => {
    installInstructions(repo, { client: 'cursor', scope: 'project' });
    const mdc = join(repo, '.cursor', 'rules', 'crib.mdc');
    expect(existsSync(mdc)).toBe(true);
    removeInstructions(repo, { client: 'cursor', scope: 'project' });
    // frontmatter-only after block removal → deleted (crib-owned rule, no user body).
    expect(existsSync(mdc)).toBe(false);
  });

  it('removing one client leaves the others + memory intact', () => {
    installInstructions(repo, { client: 'all', scope: 'project' });
    removeInstructions(repo, { client: 'claude', scope: 'project' });
    expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(false);
    // sibling instruction files untouched.
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(repo, 'GEMINI.md'))).toBe(true);
    expect(existsSync(join(repo, '.github', 'copilot-instructions.md'))).toBe(true);
    // and a second remove of the same client is a no-op.
    const again = removeInstructions(repo, { client: 'claude', scope: 'project' });
    expect(again[0]!.written).toBe(false);
  });
});

describe('listInstructions — status report', () => {
  it('reports absent before install and present after', () => {
    const before = listInstructions(repo, { client: 'all', scope: 'project' });
    expect(before.every((e) => !e.present)).toBe(true);
    installInstructions(repo, { client: 'all', scope: 'project' });
    const after = listInstructions(repo, { client: 'all', scope: 'project' });
    // vscode has no target → not listed; the other six are present.
    expect(after.length).toBe(ALL_CLIENTS.length - 1);
    expect(after.every((e) => e.present)).toBe(true);
  });
});

// ─── G2.1 — capture-lane matrix ───────────────────────────────────────────────

describe('capture-lane matrix (G2.1) — registry coverage', () => {
  // tsc enforces the REQUIRED `lifecycle` field at compile time; these pin it at runtime (the
  // release gate re-asserts both through the built dist).
  it('every ALL_CLIENTS client has a lane row keyed by ClientId (not McpIde)', () => {
    for (const id of ALL_CLIENTS) {
      const lc = clientAdapter(id).lifecycle;
      expect(lc, `${id} must declare a capture-lane row`).toBeDefined();
      // Lane 1 is universal: every registry client runs the memory MCP server.
      expect(lc.portableCapture.tool, id).toBe('memory');
      expect(lc.portableCapture.op, id).toBe('capture');
      expect(lc.portableCapture.evidence, id).toBe('in-repo-writer');
    }
    // copilot and vscode are distinct rows even though they share .vscode/mcp.json.
    expect(clientAdapter('copilot').lifecycle).toBeDefined();
    expect(clientAdapter('vscode').lifecycle).toBeDefined();
  });

  it('only claude carries a lifecycle-hooks lane, with events from the closed enum', () => {
    for (const id of ALL_CLIENTS) {
      const hooks = clientAdapter(id).lifecycle.lifecycleHooks;
      if (id === 'claude') {
        expect(hooks, 'claude must declare lane 2').not.toBeNull();
        expect(hooks!.events.length).toBeGreaterThan(0);
        for (const event of hooks!.events) expect(LIFECYCLE_EVENTS).toContain(event);
        // The hook claim carries upstream-doc evidence, not in-repo-writer: the writer below
        // installs the entry, but the fired-event guarantee is upstream documentation.
        expect(hooks!.evidence).toBe('verified-upstream-doc');
        expect(hooks!.settingsPath?.(repo)).toBe(join(repo, '.claude', 'settings.json'));
      } else {
        // Honest reporting: no hook surface → null, never a fabricated row.
        expect(hooks, `${id} must report instruction-based recall only`).toBeNull();
      }
    }
  });

  it('lifecycleInvariants is empty for the shipped registry and catches broken rows', () => {
    expect(lifecycleInvariants()).toEqual([]);
    const base = clientAdapter('claude');
    expect(lifecycleInvariants([{ id: 'claude' }])).toContainEqual(
      "client 'claude' has no capture-lane row",
    );
    expect(
      lifecycleInvariants([
        { id: 'claude', lifecycle: base.lifecycle },
        { id: 'claude', lifecycle: base.lifecycle },
      ]),
    ).toContainEqual("duplicate capture-lane row for 'claude'");
    // Deliberately invalid enum values, so the double cast bypasses the compiler while the
    // invariant walk — which validates at runtime, not by types — must still catch them.
    const badEvidence = {
      ...base.lifecycle,
      portableCapture: { ...base.lifecycle.portableCapture, evidence: 'trust-me' },
    } as unknown as typeof base.lifecycle;
    expect(lifecycleInvariants([{ id: 'claude', lifecycle: badEvidence }]).join('\n')).toMatch(
      /not a known evidence class/,
    );
    const badEvent = {
      ...base.lifecycle,
      lifecycleHooks: { ...base.lifecycle.lifecycleHooks!, events: ['on-crash'] },
    } as unknown as typeof base.lifecycle;
    expect(lifecycleInvariants([{ id: 'claude', lifecycle: badEvent }]).join('\n')).toMatch(
      /'on-crash' is not one of/,
    );
  });

  it('red-on-renamed-op: captureLaneManifestViolations rejects unknown tools/ops', () => {
    // The manifest view the gate builds from the mcp dist: every tool + its op names.
    const manifest: ToolManifestView = {
      tools: ['memory', 'brief', 'memory_recall', 'memory_observe'],
      opsOf: (tool) => (tool === 'memory' ? ['capture', 'status'] : []),
    };
    expect(captureLaneManifestViolations(manifest)).toEqual([]);
    // Renaming the capture op breaks the gate — not silently every installed client's protocol.
    const renamed: ToolManifestView = {
      ...manifest,
      opsOf: (tool) => (tool === 'memory' ? ['record', 'status'] : []),
    };
    const problems = captureLaneManifestViolations(renamed);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/'capture'.*'memory'/);
    // A renamed standalone protocol tool (memory_observe → memory_observe_v2) breaks the gate too.
    const noObserve: ToolManifestView = { ...manifest, tools: manifest.tools.slice(0, 3) };
    expect(captureLaneManifestViolations(noObserve).join('\n')).toMatch(/memory_observe/);
  });

  it('captureLaneSummary renders the lane data (regenerated, never hand-written)', () => {
    expect(captureLaneSummary('claude')).toMatch(
      /Claude Code: portable capture via memory\(\{op:'capture'\}\) \[in-repo-writer\]; lifecycle hooks \(session-start, turn-end, tool-use\) \[verified-upstream-doc\]/,
    );
    expect(captureLaneSummary('cursor')).toMatch(
      /Cursor: portable capture via memory\(\{op:'capture'\}\) \[in-repo-writer\]; instruction-based recall only \(no lifecycle-hook surface\)/,
    );
  });
});

// ─── lane-2 capture-hook writer (G2.1) ────────────────────────────────────────

describe('capture-hook writer (G2.1) — Claude settings.json', () => {
  const settingsPath = () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    return join(repo, '.claude', 'settings.json');
  };

  it('installs one managed entry per declared event, mapped to the upstream hook keys', () => {
    const results = installCaptureHooks(repo, { client: 'claude', scope: 'project' });
    expect(results[0]!.written).toBe(true);
    expect(results[0]!.events).toEqual(['session-start', 'turn-end', 'tool-use']);
    const obj = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
    const hooks = obj.hooks as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'SessionStart', 'Stop']);
    for (const key of Object.keys(hooks)) {
      const bucket = hooks[key] as Record<string, unknown>[];
      expect(bucket).toHaveLength(1);
      expect(bucket[0]).toEqual({
        type: 'command',
        command: expect.stringMatching(/^crib memory capture-hook --event /),
      });
    }
    expect((hooks.SessionStart as unknown[])[0]).toBeDefined();
  });

  it('is idempotent — a second install reports written:false and changes no bytes', () => {
    installCaptureHooks(repo, { client: 'claude', scope: 'project' });
    const first = readFileSync(settingsPath(), 'utf8');
    const second = installCaptureHooks(repo, { client: 'claude', scope: 'project' });
    expect(second[0]!.written).toBe(false);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(first);
  });

  it('preserves sibling top-level keys and user hook entries (non-clobber)', () => {
    writeFileSync(
      settingsPath(),
      `${JSON.stringify(
        {
          permissions: { allow: ['Bash(ls)'] },
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-own-hook' }] }] },
        },
        null,
        2,
      )}\n`,
    );
    installCaptureHooks(repo, { client: 'claude', scope: 'project' });
    const obj = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
    expect(obj.permissions).toEqual({ allow: ['Bash(ls)'] });
    const stop = (obj.hooks as Record<string, unknown>).Stop as Record<string, unknown>[];
    expect(stop).toHaveLength(2);
    expect(JSON.stringify(stop)).toContain('user-own-hook');
    expect(JSON.stringify(stop)).toContain(CAPTURE_HOOK_COMMAND_MARKER);
    // The user's entry keeps its position (first).
    expect((stop[0]!.hooks as { command: string }[])[0]!.command).toBe('user-own-hook');
  });

  it('refuses to write an unparseable settings file (the orphan-marker rule in JSON form)', () => {
    writeFileSync(settingsPath(), '{ "hooks": {'); // truncated file
    const before = readFileSync(settingsPath(), 'utf8');
    const result = installCaptureHooks(repo, { client: 'claude', scope: 'project' });
    expect(result[0]!.written).toBe(false);
    expect(result[0]!.note).toMatch(/refusing to write/);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(before);
  });

  it('refuses when the hooks key or an event bucket has an unexpected shape', () => {
    writeFileSync(settingsPath(), '{"hooks": ["not-an-object"]}\n');
    let result = installCaptureHooks(repo, { client: 'claude', scope: 'project' });
    expect(result[0]!.written).toBe(false);
    expect(result[0]!.note).toMatch(/'hooks' is not a JSON object/);

    writeFileSync(settingsPath(), '{"hooks": {"Stop": {"not": "an array"}}}\n');
    result = installCaptureHooks(repo, { client: 'claude', scope: 'project' });
    expect(result[0]!.written).toBe(false);
    expect(result[0]!.note).toMatch(/'hooks\.Stop' is not an array/);

    // A marker-carrying entry this writer cannot parse: refuse rather than guess.
    writeFileSync(
      settingsPath(),
      `${JSON.stringify({ hooks: { Stop: [{ command: CAPTURE_HOOK_COMMAND_MARKER }] } }, null, 2)}\n`,
    );
    result = installCaptureHooks(repo, { client: 'claude', scope: 'project' });
    expect(result[0]!.written).toBe(false);
    expect(result[0]!.note).toMatch(/unparseable/);
  });

  it('remove strips only the crib-owned entries and drops the empty hooks key', () => {
    writeFileSync(
      settingsPath(),
      `${JSON.stringify(
        {
          permissions: { deny: [] },
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-own-hook' }] }] },
        },
        null,
        2,
      )}\n`,
    );
    installCaptureHooks(repo, { client: 'claude', scope: 'project' });
    const result = removeCaptureHooks(repo, { client: 'claude', scope: 'project' });
    expect(result[0]!.written).toBe(true);
    expect(result[0]!.events).toEqual(['session-start', 'turn-end', 'tool-use']);
    const obj = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
    // The user's own Stop hook survives; the crib SessionStart/PostToolUse buckets are gone and
    // the hooks key itself is dropped (only Stop remained, and its only entry is the user's).
    expect(JSON.stringify(obj)).toContain('user-own-hook');
    expect(JSON.stringify(obj)).not.toContain(CAPTURE_HOOK_COMMAND_MARKER);
    expect(Object.keys(obj.hooks as object)).toEqual(['Stop']);
    expect(obj.permissions).toEqual({ deny: [] });
    // A second remove is a no-op.
    expect(removeCaptureHooks(repo, { client: 'claude', scope: 'project' })[0]!.written).toBe(
      false,
    );
  });

  it('non-claude clients and global scope are a data note, never a write', () => {
    const results = installCaptureHooks(repo, { client: 'all', scope: 'project' });
    for (const r of results.filter((x) => x.client !== 'claude')) {
      expect(r.written).toBe(false);
      expect(r.note).toMatch(/instruction-based recall only/);
      expect(r.path).toBe('');
      expect(r.events).toEqual([]);
    }
    expect(installCaptureHooks(repo, { client: 'claude', scope: 'global' })[0]!.note).toMatch(
      /project-scope only/,
    );
    // And the protocol body itself stays the recall mechanism for hook-less clients.
    expect(neutralProtocolBody()).toContain('`brief`');
  });

  it('list reports the wired events, and nothing when the file is absent', () => {
    expect(listCaptureHooks(repo, { client: 'claude', scope: 'project' })[0]!.events).toEqual([]);
    installCaptureHooks(repo, { client: 'claude', scope: 'project' });
    expect(listCaptureHooks(repo, { client: 'claude', scope: 'project' })[0]!.events).toEqual([
      'session-start',
      'turn-end',
      'tool-use',
    ]);
    expect(captureHookCommand('turn-end')).toBe(`${CAPTURE_HOOK_COMMAND_MARKER} --event turn-end`);
  });
});
