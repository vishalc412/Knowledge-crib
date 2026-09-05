# Cross-session Intake Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sanitized intake requirements and execution checkpoints durable, shareable, and automatically visible in new-session handoff across supported clients.

**Architecture:** Add content-addressed intake and checkpoint entries to the memory ledger, fold them through a pure resume projection, and expose them through the portable API, CLI, MCP handoff, encrypted sync, and managed client instructions. Remote I/O remains CLI/worker-only; MCP performs local ledger operations and read-only sync reporting.

**Tech Stack:** TypeScript 5.6, Node.js 22, Ajv JSON Schema, Vitest, MCP SDK/Zod, pnpm, append-only JSONL memory stores.

---

### Task 1: Intake domain, identity, validation, and storage

**Files:**
- Create: `packages/memory/src/intake.ts`
- Create: `packages/memory/src/intake.test.ts`
- Create: `packages/memory/src/schema/intake.schema.json`
- Create: `packages/memory/src/schema/intake-checkpoint.schema.json`
- Modify: `packages/memory/src/schemas.ts`
- Modify: `packages/memory/src/types.ts`
- Modify: `packages/memory/src/ids.ts`
- Modify: `packages/memory/src/validate.ts`
- Modify: `packages/memory/src/store.ts`
- Modify: `packages/memory/src/store.test.ts`
- Modify: `packages/memory/src/index.ts`

- [ ] **Step 1: Write failing domain and store tests**

```ts
it('creates a stable intake id while excluding timestamps', () => {
  const a = createIntakeRequirement(fixture({ createdAt: '2026-01-01T00:00:00.000Z' }));
  const b = createIntakeRequirement(fixture({ createdAt: '2026-02-01T00:00:00.000Z' }));
  expect(a.id).toBe(b.id);
});

it('stores intake entries only in the intake collection', () => {
  const store = MemoryStore.local('repo-1', { env });
  store.upsertEntries('intakes', [createIntakeRequirement(fixture())]);
  expect(store.readCollection('intakes').entries).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused tests and verify the expected RED state**

Run: `pnpm --filter @knowledge-crib/memory test -- intake.test.ts store.test.ts`

Expected: FAIL because `createIntakeRequirement`, the schemas, and the `intakes` collection do not exist.

- [ ] **Step 3: Define the immutable domain entries and builders**

```ts
export type IntakePhase = 'intake' | 'planning' | 'executing' | 'blocked' | 'verifying' | 'complete';
export type IntakeStatus = 'draft' | 'active' | 'blocked' | 'completed' | 'cancelled';
export type IntakeAudience = 'private' | 'devices' | 'team';

export interface IntakeRequirement {
  id: string;
  schemaVersion: '1';
  namespace: MemoryNamespace;
  original: string;
  interpretation: {
    outcome: string;
    scope: string[];
    constraints: string[];
    acceptanceCriteria: string[];
  };
  sensitivity: MemorySensitivity;
  retentionPolicyId: string;
  provenance: MemoryProvenance;
  createdAt: string;
}

export interface IntakeCheckpoint {
  id: string;
  schemaVersion: '1';
  intakeId: string;
  kind: 'structured' | 'plan-selected' | 'progress' | 'blocked' | 'resumed' | 'shared' | 'completed' | 'cancelled';
  phase: IntakePhase;
  nextSafeAction?: string;
  summary: string;
  completedStepIds?: string[];
  audience?: IntakeAudience;
  repository: { head?: string; branch?: string; dirty: boolean; changedPathsDigest?: string };
  artifactPaths?: string[];
  receiptIds?: string[];
  actor: string;
  recordedAt: string;
}
```

Implement `intakeRequirementId()` as `intake:<blake3(canonical semantic fields)>` and `intakeCheckpointId()` as `icp:<blake3(canonical checkpoint fields excluding recordedAt)>`. `createIntakeRequirement()` stores the sanitized original wording, normalizes whitespace, rejects an empty original or outcome, validates the built record, and returns it. `createIntakeCheckpoint()` requires `nextSafeAction` for non-terminal kinds.

- [ ] **Step 4: Register schemas and storage collections**

Add `IntakeRequirement | IntakeCheckpoint` to `MemoryEntry`; dispatch `intake:` and `icp:` in `assertValidMemoryEntry`; add `intakes` to team/local collections and map it to no manifest count key. Export the new types, builders, ids, and validators from `packages/memory/src/index.ts`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm --filter @knowledge-crib/memory test -- intake.test.ts store.test.ts`

Expected: PASS with no schema or collection errors.

- [ ] **Step 6: Commit the domain slice**

```bash
git add packages/memory/src/intake.ts packages/memory/src/intake.test.ts packages/memory/src/schema/intake.schema.json packages/memory/src/schema/intake-checkpoint.schema.json packages/memory/src/schemas.ts packages/memory/src/types.ts packages/memory/src/ids.ts packages/memory/src/validate.ts packages/memory/src/store.ts packages/memory/src/store.test.ts packages/memory/src/index.ts
git commit -m "feat(memory): add durable intake entries"
```

### Task 2: Deterministic resume projection and handoff

**Files:**
- Create: `packages/memory/src/intake-projection.ts`
- Create: `packages/memory/src/intake-projection.test.ts`
- Modify: `packages/memory/src/handoff.ts`
- Modify: `packages/memory/src/handoff.test.ts`
- Modify: `packages/memory/src/api.ts`
- Modify: `packages/memory/src/api.test.ts`
- Modify: `packages/memory/src/index.ts`

- [ ] **Step 1: Write failing projection tests**

```ts
it('selects the only active intake as the primary resume brief', () => {
  const result = projectIntakes([intake], [checkpoint('progress')], currentRepository);
  expect(result.primary?.intakeId).toBe(intake.id);
  expect(result.primary?.nextSafeAction).toBe('Run the parser tests');
});

it('does not guess when multiple intakes are active', () => {
  const result = projectIntakes([older, newer], checkpoints, currentRepository);
  expect(result.primary).toBeUndefined();
  expect(result.choices.map((x) => x.intakeId)).toEqual([newer.id, older.id]);
});

it('surfaces incompatible terminal outcomes as a conflict', () => {
  const result = projectIntakes([intake], [checkpoint('completed'), checkpoint('cancelled')], currentRepository);
  expect(result.choices[0]?.conflicts).toContainEqual(expect.objectContaining({ field: 'status' }));
});
```

- [ ] **Step 2: Run projection tests and verify RED**

Run: `pnpm --filter @knowledge-crib/memory test -- intake-projection.test.ts handoff.test.ts api.test.ts`

Expected: FAIL because the projection and intake-aware handoff are absent.

- [ ] **Step 3: Implement the pure projection**

```ts
export interface ResumeBrief {
  intakeId: string;
  original: string;
  interpretation: IntakeRequirement['interpretation'];
  phase: IntakePhase;
  status: IntakeStatus;
  nextSafeAction?: string;
  completedStepIds: string[];
  blockers: string[];
  audience: IntakeAudience;
  repositoryDrift: boolean;
  conflicts: Array<{ field: string; values: string[] }>;
  lastActivity: string;
}

export function projectIntakes(
  requirements: readonly IntakeRequirement[],
  checkpoints: readonly IntakeCheckpoint[],
  repository: IntakeCheckpoint['repository'],
): { primary?: ResumeBrief; choices: ResumeBrief[] };
```

Fold events by intake id, sort events by id for deterministic processing, union completed step ids, retain explicit same-field conflicts, and sort active/blocked briefs by `lastActivity` descending with intake id as the tiebreak. Set `primary` only when one resumable brief remains.

- [ ] **Step 4: Integrate the projection into `MemoryApi.handoff()`**

Read `intakes` from local and team stores, split requirements from checkpoints, call `projectIntakes`, and add `intakes: { primary?, choices, count }` to `HandoffResponse`. Add API methods `createIntake`, `checkpointIntake`, `listIntakes`, and `getIntake` that write/read through the store gates.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm --filter @knowledge-crib/memory test -- intake-projection.test.ts handoff.test.ts api.test.ts`

Expected: PASS; existing handoff fields remain backward compatible.

- [ ] **Step 6: Commit the projection slice**

```bash
git add packages/memory/src/intake-projection.ts packages/memory/src/intake-projection.test.ts packages/memory/src/handoff.ts packages/memory/src/handoff.test.ts packages/memory/src/api.ts packages/memory/src/api.test.ts packages/memory/src/index.ts
git commit -m "feat(memory): project resumable intake state"
```

### Task 3: CLI intake and session bootstrap surfaces

**Files:**
- Create: `packages/cli/src/intake-cli.test.ts`
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 1: Write failing CLI tests**

```ts
it('creates and checkpoints an intake, then returns it from session bootstrap', async () => {
  const created = await run(['intake', 'create', '--from', source, '--outcome', 'Ship continuation', '--accept', 'Device B sees the same next action', '--json']);
  const id = JSON.parse(created.stdout).id;
  await run(['intake', 'checkpoint', id, '--phase', 'executing', '--next', 'Run memory tests', '--summary', 'Domain model implemented', '--json']);
  const bootstrap = JSON.parse((await run(['session', 'bootstrap', '--json'])).stdout);
  expect(bootstrap.intakes.primary.intakeId).toBe(id);
});
```

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `pnpm --filter knowledge-crib test -- intake-cli.test.ts`

Expected: FAIL with `unknown command: intake`.

- [ ] **Step 3: Implement command parsing and output**

Add top-level `intake` and `session` dispatchers. `intake create` accepts `--from`, `--outcome`, repeatable `--scope`, `--constraint`, and `--accept`; `checkpoint` accepts the documented phase, summary, next action, completed step ids, and repository anchor derived from Git; `list/show/complete/share` return stable JSON. `session bootstrap` calls the same portable handoff projection as MCP.

- [ ] **Step 4: Test invalid and terminal behavior**

Add assertions that empty source/outcome return `BAD_ARGS`, active checkpoints without `--next` are refused, terminal checkpoints permit no next action, and multiple active intakes return choices without a primary.

- [ ] **Step 5: Run CLI tests and verify GREEN**

Run: `pnpm --filter knowledge-crib test -- intake-cli.test.ts cli.test.ts`

Expected: PASS with stable JSON and no regression in existing command dispatch.

- [ ] **Step 6: Commit the CLI slice**

```bash
git add packages/cli/src/cli.ts packages/cli/src/intake-cli.test.ts
git commit -m "feat(cli): add intake and session bootstrap commands"
```

### Task 4: MCP intake operations

**Files:**
- Create: `packages/mcp/src/verbs-intake.test.ts`
- Modify: `packages/mcp/src/server.ts`
- Modify: `packages/mcp/src/verbs.ts`

- [ ] **Step 1: Write failing MCP tests**

```ts
it('creates local intake state and returns it through handoff', async () => {
  const created = await callMemory({ op: 'intake_create', original: 'Add durable continuation', outcome: 'Resume on device B', acceptanceCriteria: ['Same next action'], actor: 'human:vishal' });
  await callMemory({ op: 'intake_checkpoint', id: created.id, phase: 'planning', summary: 'Design accepted', nextSafeAction: 'Write tests', actor: 'agent:codex' });
  const handoff = await callTool('memory_handoff', {});
  expect(handoff.intakes.primary.intakeId).toBe(created.id);
});

it('does not perform remote sync from an intake share MCP call', async () => {
  const result = await callMemory({ op: 'intake_share', id, audience: 'devices', actor: 'human:vishal' });
  expect(result.sync).toBe('staged-local-only');
});
```

- [ ] **Step 2: Run MCP tests and verify RED**

Run: `pnpm --filter @knowledge-crib/mcp test -- verbs-intake.test.ts verbs-memory.test.ts`

Expected: FAIL because intake operations are not registered.

- [ ] **Step 3: Add the Zod contract and verb dispatch**

Extend `memory` operations with `intake_create`, `intake_checkpoint`, `intake_list`, `intake_get`, and `intake_share`. Delegate to `MemoryApi`; cap arrays and strings consistently with existing memory operations. Device sharing records the local `shared` checkpoint and reports sync status only. Team sharing is refused from MCP with a CLI instruction because it writes Git-visible history.

- [ ] **Step 4: Run MCP tests and verify GREEN**

Run: `pnpm --filter @knowledge-crib/mcp test -- verbs-intake.test.ts verbs-memory.test.ts verbs-memory-v2.test.ts`

Expected: PASS; operation count and compatibility assertions are updated deliberately.

- [ ] **Step 5: Commit the MCP slice**

```bash
git add packages/mcp/src/server.ts packages/mcp/src/verbs.ts packages/mcp/src/verbs-intake.test.ts
git commit -m "feat(mcp): expose local intake continuation"
```

### Task 5: Encrypted device sync and explicit team promotion

**Files:**
- Modify: `packages/memory/src/schema/sync-event.schema.json`
- Modify: `packages/memory/src/sync/event.ts`
- Modify: `packages/memory/src/sync/event.test.ts`
- Modify: `packages/memory/src/sync/bootstrap.ts`
- Modify: `packages/memory/src/sync/bootstrap.test.ts`
- Modify: `packages/memory/src/sync/engine.ts`
- Modify: `packages/memory/src/sync/engine.test.ts`
- Modify: `packages/memory/src/sync/policy.ts`
- Modify: `packages/memory/src/sync/policy.test.ts`
- Modify: `packages/memory/src/api.ts`
- Modify: `packages/memory/src/api.test.ts`
- Modify: `packages/cli/src/intake-cli.test.ts`

- [ ] **Step 1: Write failing two-device and team-sharing tests**

```ts
it('converges intake checkpoints across two local stores through encrypted sync', async () => {
  await pushSync(deviceA.store, backend, syncOpts(deviceA));
  await pullSync(deviceB.store, backend, syncOpts(deviceB));
  expect(deviceB.store.readCollection('intakes').entries).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: intake.id }), expect.objectContaining({ intakeId: intake.id })]),
  );
});

it('team share copies the intake history only after secret scanning', () => {
  expect(() => api.shareIntake(id, { audience: 'team', actor: 'human:vishal' })).not.toThrow();
  expect(team.readCollection('intakes').entries).toHaveLength(2);
});
```

- [ ] **Step 2: Run sync tests and verify RED**

Run: `pnpm --filter @knowledge-crib/memory test -- sync/event.test.ts sync/bootstrap.test.ts sync/engine.test.ts sync/policy.test.ts api.test.ts`

Expected: FAIL because sync rejects `intake:`/`icp:` payloads and does not walk `intakes`.

- [ ] **Step 3: Extend the immutable sync protocol**

Add `intake.upsert` and `intake-checkpoint.append` event kinds. Extend `SyncEventPayload`, schema dispatch, `verifyPayloadId`, `walkSyncableEntries`, `collectionForPayload`, and pull action reporting. Reuse the same encryption, content-route, queue, key, and conflict machinery; do not introduce another transport.

- [ ] **Step 4: Implement sharing admission**

Device share marks the intake audience and lets the next CLI/worker push stage its events. Team share acquires one store lock at a time, secret-scans the full history before any write, writes exact entries to the team `intakes` collection, and appends a team-audience checkpoint. Later checkpoints for a team-shared intake are written to both local and team stores in separate non-nested lock sections, with durable local success reported independently if the team write fails.

- [ ] **Step 5: Run sync and API tests and verify GREEN**

Run: `pnpm --filter @knowledge-crib/memory test -- sync/event.test.ts sync/bootstrap.test.ts sync/engine.test.ts sync/policy.test.ts api.test.ts`

Expected: PASS including replay, same-id/different-bytes conflict, secret refusal, and two-device convergence.

- [ ] **Step 6: Commit the sharing slice**

```bash
git add packages/memory/src/schema/sync-event.schema.json packages/memory/src/sync packages/memory/src/api.ts packages/memory/src/api.test.ts packages/cli/src/intake-cli.test.ts
git commit -m "feat(memory): sync and promote intake history"
```

### Task 6: Default session protocol across clients

**Files:**
- Modify: `packages/cli/src/adapters.ts`
- Modify: `packages/cli/src/adapters.test.ts`
- Modify: `packages/cli/src/hooks.ts`
- Modify: `packages/cli/src/mcp-install.ts`
- Modify: `packages/cli/src/mcp-install.test.ts`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `.github/copilot-instructions.md`
- Modify: `.cursor/rules/crib.mdc`

- [ ] **Step 1: Write failing adapter tests**

```ts
it.each(['claude', 'cursor', 'copilot', 'vscode', 'codex', 'windsurf', 'gemini'] as const)(
  'installs the session bootstrap and checkpoint protocol for %s',
  (client) => {
    const result = installAdapter({ client, scope: 'project', repoRoot, home });
    expect(readFileSync(result.paths[0]!, 'utf8')).toContain('Run handoff before relying on prior project context');
    expect(readFileSync(result.paths[0]!, 'utf8')).toContain('Checkpoint unfinished intake work');
  },
);
```

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `pnpm --filter knowledge-crib test -- adapters.test.ts mcp-install.test.ts`

Expected: FAIL because the managed protocol does not require intake bootstrap/checkpointing.

- [ ] **Step 3: Update the vendor-neutral managed block**

Add the five approved bootstrap rules: handoff first, create/match intake, checkpoint at plan/progress/block/end boundaries, validate repository drift, and never share or sync implicitly. Preserve every client-specific surrounding file and existing managed-marker behavior.

- [ ] **Step 4: Add restart reporting**

Make MCP install/list report `restartRequired: true` for updated running-host configurations and a concise host-specific instruction. Do not claim a process was hot-reloaded.

- [ ] **Step 5: Run adapter tests and verify GREEN**

Run: `pnpm --filter knowledge-crib test -- adapters.test.ts mcp-install.test.ts`

Expected: PASS for all clients and idempotent second installs.

- [ ] **Step 6: Commit the client-default slice**

```bash
git add packages/cli/src/adapters.ts packages/cli/src/adapters.test.ts packages/cli/src/hooks.ts packages/cli/src/mcp-install.ts packages/cli/src/mcp-install.test.ts AGENTS.md CLAUDE.md .github/copilot-instructions.md .cursor/rules/crib.mdc
git commit -m "feat(clients): default to intake handoff"
```

### Task 7: Documentation, full verification, installation, and MCP restart

**Files:**
- Modify: `docs/memory-sync.md`
- Modify: `docs/knowledge-crib-client-setup.md`
- Modify: `docs/knowledge-crib-mcp-api.md`
- Modify: `docs/knowledge-crib-user-guide.md`
- Create: `packages/cli/src/intake-e2e.test.ts`

- [ ] **Step 1: Write the cross-device end-to-end test**

```ts
it('resumes the same intake and next action in a second checkout', async () => {
  const created = await deviceA.createAndCheckpoint();
  await deviceA.syncPush();
  await deviceB.syncPull();
  const resumed = await deviceB.bootstrap();
  expect(resumed.intakes.primary).toMatchObject({
    intakeId: created.id,
    nextSafeAction: 'Run the MCP integration tests',
  });
});
```

- [ ] **Step 2: Run the end-to-end test and verify it passes through the implemented surfaces**

Run: `pnpm --filter knowledge-crib test -- intake-e2e.test.ts`

Expected: PASS with two isolated memory homes and one encrypted file backend.

- [ ] **Step 3: Document exact operator workflows**

Document create/checkpoint/bootstrap, devices-only sync initialization with a user-supplied backend, explicit team sharing, secret refusal, conflict resolution, repository drift, and the restart requirement. Examples must use placeholders such as `/path/to/user-owned-sync` and never embed credentials.

- [ ] **Step 4: Run package and repository verification**

Run:

```bash
pnpm --filter @knowledge-crib/memory typecheck
pnpm --filter @knowledge-crib/memory test
pnpm --filter @knowledge-crib/mcp typecheck
pnpm --filter @knowledge-crib/mcp test
pnpm --filter knowledge-crib typecheck
pnpm --filter knowledge-crib test
pnpm exec biome check packages/memory/src packages/mcp/src packages/cli/src
```

Expected: every command exits zero with no test failures or formatting errors.

- [ ] **Step 5: Refresh all client integrations**

Run:

```bash
crib mcp install --ide all /Users/vishalchawla/Documents/Knowlege-crib
crib adapters install --client all --scope project
crib adapters hooks install --client claude
```

Expected: every supported config lists knowledge-crib; unsupported hook clients return explicit non-fatal notes; unrelated config is preserved.

- [ ] **Step 6: Restart the local MCP process and verify health**

Stop only `crib serve /Users/vishalchawla/Documents/Knowlege-crib` processes resolved by exact command/path, then start a fresh bounded stdio probe and verify `crib doctor` plus `crib session bootstrap --json`. Do not kill unrelated Node or MCP processes.

- [ ] **Step 7: Commit documentation and end-to-end coverage**

```bash
git add docs/memory-sync.md docs/knowledge-crib-client-setup.md docs/knowledge-crib-mcp-api.md docs/knowledge-crib-user-guide.md packages/cli/src/intake-e2e.test.ts
git commit -m "docs: explain durable intake continuation"
```

- [ ] **Step 8: Run final change detection and branch verification**

Run the knowledge-crib `detect_changes` MCP operation; if unavailable, report the limitation and use `crib status --dirty`, `git diff --check`, the complete test commands above, and `git status --short`. Review every changed symbol and path before declaring completion.
