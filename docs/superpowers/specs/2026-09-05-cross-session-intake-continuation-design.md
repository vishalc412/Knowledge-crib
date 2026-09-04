# Cross-session intake continuation design

**Status:** Approved in conversation on 2026-09-05

## Purpose

Knowledge-crib must preserve a user's requested work and execution position across context windows, supported agent clients, and machines. A returning session must be able to answer: what outcome was requested, what interpretation was agreed, what has completed, what is blocked, what changed in the repository, and what is the next safe action?

Continuation means reconstructing durable work state. It does not mean restoring a model's hidden reasoning, replaying a transcript, reviving a process, or executing automatically.

## Goals

- Capture an intake requirement as sanitized original wording plus a structured interpretation.
- Checkpoint planning and execution progress as immutable events.
- Produce a deterministic resume brief for every new session.
- Share private intake state across the same principal's devices through encrypted sync.
- Share selected intake state with project collaborators only through explicit Git-visible promotion.
- Make the resume protocol the default instruction for Claude, Codex, Cursor, Copilot/VS Code, Windsurf, and Gemini.
- Refuse unsafe sharing and surface cross-device conflicts without last-write-wins.

## Non-goals

- Persisting raw transcripts, chain-of-thought, command output, credentials, or arbitrary process memory.
- Replaying uncommitted filesystem changes on another machine.
- Letting an MCP call silently push or pull from a remote backend.
- Operating a knowledge-crib-hosted multi-tenant synchronization service.
- Replacing the host client's own task scheduler or runtime.

## Considered approaches

### First-class intake event model — selected

Add a typed intake aggregate, immutable lifecycle events, and a pure projection. This creates a stable contract for validation, sync, conflict handling, CLI/MCP operations, and handoff.

### Generic memory claims

Represent each field as an ordinary fact, decision, procedure, or convention with a shared subject. This reuses storage but makes completeness, lifecycle ordering, atomic creation, and conflict detection conventions rather than enforceable behavior.

### Markdown-only intake artifacts

Write a task document into the repository. This is easy to inspect and share through Git, but it cannot serve private device sharing, structured queries, deterministic projections, or per-field conflict handling.

## Domain model

### Intake requirement

An `IntakeRequirement` is immutable and content-addressed. It contains:

- stable intake id and schema version;
- principal, workspace, project, and agent-profile namespace;
- sanitized original wording;
- structured `outcome`, `scope`, `constraints`, and `acceptanceCriteria`;
- sensitivity and retention classifications;
- provenance and creation timestamp.

The original wording is evidence of user intent. The structured fields are an interpretation and can be corrected by later events without rewriting the source.

### Intake checkpoint

An `IntakeCheckpoint` is an immutable event for one intake. Its event kinds are:

- `structured` — corrects or supersedes the structured interpretation;
- `plan-selected` — records the selected plan artifact, digest, and summary;
- `progress` — records completed step ids and a concise result;
- `blocked` — records a blocker and required resolution;
- `resumed` — records the repository state from which work resumed;
- `shared` — changes the delivery audience for the intake and future checkpoints;
- `completed` or `cancelled` — terminal outcomes.

Every non-terminal checkpoint records `phase`, `nextSafeAction`, and a repository anchor containing the Git HEAD, branch when available, dirty-state flag, and changed-path digest. It may name artifact paths and receipt ids, but it never stores raw diffs or command output.

Allowed phases are `intake`, `planning`, `executing`, `blocked`, `verifying`, and `complete`. Status is projected as `draft`, `active`, `blocked`, `completed`, or `cancelled`.

### Resume brief

The pure `IntakeProjection` folds the requirement and checkpoints into a `ResumeBrief` containing:

- the source wording and current structured interpretation;
- current phase and status;
- completed and remaining plan steps when a plan is attached;
- blockers and the next safe action;
- the recorded repository anchor and any drift from the current checkout;
- audience and sync state;
- explicit conflicts requiring human choice.

If exactly one intake is active, session bootstrap returns it as the primary continuation. If several are active, bootstrap returns a deterministic newest-activity ordering and requires selection. It never guesses which intake to execute.

## Storage and identity

Intake requirements and checkpoints use a dedicated collection within the existing memory stores. They do not masquerade as generic memory claims or attempt events. Entry ids are content-addressed from canonical semantic content; timestamps and device ids are metadata, never identity seeds.

Local intake entries live in the repo-scoped local store. Team-shared entries use a reviewable team-store shard under `.crib/memory/team/`. Store writes reuse the existing lock, validation, secret-scanning, atomic-write, and merge infrastructure. The merge rule is id union plus content equality; same-id/different-bytes is a hard conflict.

## Sharing

### Device share — default

`share` without an audience means `devices`. The intake stays private and is admitted to the existing encrypted repo sync channel. The sync protocol gains intake requirement and checkpoint payload kinds while retaining content-addressed routes, authenticated encryption, idempotent push/pull, and user-owned file or HTTP object storage.

Actual remote transfer remains a CLI or lifecycle-worker operation. MCP can create and checkpoint local intake state and report sync status, but cannot initiate network I/O.

### Team share — explicit

`share --audience team` secret-scans the full current intake history and promotes it to the team store. The promotion is append-only and records the audience decision. Once shared, future checkpoints are team-visible by default and each is scanned before admission.

Team sharing cannot promise deletion from Git history. Retraction stops future recall but does not erase prior commits.

## Conflict rules

- Identical content-addressed events deduplicate.
- Independent completed step ids merge by set union.
- Corrections to different structured fields compose.
- Concurrent incompatible values for the same structured field remain an explicit conflict.
- Concurrent terminal outcomes, or a terminal outcome concurrent with new progress, remain an explicit conflict.
- Repository drift is a warning, not a conflict; the next agent validates the checkout before continuing.
- No projection uses timestamp-based or arrival-order last-write-wins.

## API and command surfaces

The portable memory API gains methods to create, checkpoint, inspect, list, share, and project intakes. The MCP `memory` operation exposes the same local operations and includes the primary resume brief in `handoff`. Network sync and irreversible team-history operations stay outside MCP.

The CLI gains:

```text
crib intake create --from <file|stdin> [structured flags] [--json]
crib intake checkpoint <id> --phase <phase> --next <text> [progress flags] [--json]
crib intake show <id> [--json]
crib intake list [--status active,blocked] [--json]
crib intake share <id> [--audience devices|team] [--json]
crib intake complete <id> --summary <text> [--json]
crib session bootstrap [--json]
```

`crib session bootstrap` performs only local reads unless an operator-configured lifecycle worker has already pulled encrypted updates. It returns the same projection as MCP handoff.

## Client defaults

The managed instruction block installed for every supported client will require:

1. Run handoff/session bootstrap before relying on prior project context.
2. Create an intake when the user begins durable work and no matching active intake exists.
3. Checkpoint after plan approval, after a meaningful completed step, before yielding on a blocker, and before ending an unfinished session.
4. Validate repository drift before following the recorded next action.
5. Never promote private content or initiate remote synchronization without the configured policy and explicit audience.

Claude receives lifecycle hooks where its hook API supports them. Clients without reliable hooks use their native always-loaded instruction file and MCP handoff call. Installation remains idempotent and preserves unrelated client configuration.

## Initialization and restart behavior

Knowledge-crib remains the preferred intent and continuation system even when Seero or GitNexus is enabled. `crib mcp install --ide all` refreshes supported MCP declarations and managed instructions. A running MCP child must be restarted by its host client after installation; the installer reports which hosts need a new session or application restart rather than claiming a hot reload.

Encrypted device sharing is available only after `crib memory init-sync` receives a user-owned file or HTTP backend and key reference. The implementation must never invent a remote endpoint or commit a private key.

## Validation and failure behavior

- Empty source wording or an empty intended outcome is rejected.
- Drafts may omit acceptance criteria; activation requires at least one criterion or an explicit human waiver event.
- Secret findings block device or team sharing and identify only the finding location/category.
- Unknown schema versions and malformed events fail closed.
- A missing sync backend leaves the intake local and returns an actionable `not-initialized` status.
- An unreachable backend never destroys or marks local events as acknowledged.
- A stale repository anchor is reported before resumption; it does not mutate the checkout.
- Projection output is deterministic for identical event sets.

## Testing strategy

- Schema and id tests pin canonical identity, validation, and secret rejection.
- Projection unit tests cover each lifecycle, deterministic ordering, multiple-active selection, repository drift, and every conflict rule.
- Store tests cover crash-safe append, idempotency, team admission, and no-private-to-Git behavior.
- Sync tests use two memory homes and clones to prove encrypted cross-device intake convergence and replay safety.
- CLI tests exercise create, checkpoint, list, share, complete, bootstrap, malformed input, and missing backend behavior.
- MCP tests prove local intake writes and handoff output while proving push/pull remain unavailable through MCP.
- Adapter tests verify every supported client receives the session-bootstrap protocol without clobbering unrelated configuration.
- End-to-end tests create an intake on device A, sync or Git-share it, open device B, and assert an equivalent resume brief with the same next safe action.

## Delivery slices

1. Intake schemas, ids, store collection, and pure projection.
2. Portable API, CLI commands, and handoff integration.
3. Encrypted sync payloads and team promotion.
4. Cross-client bootstrap instructions/hooks and MCP restart reporting.
5. Cross-device and cross-client end-to-end verification plus operator documentation.
