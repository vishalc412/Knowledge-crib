# Implemented Plan Memory

## Goal

When a project plan is explicitly declared implemented, Knowledge Crib records the plan and the exact code changes in a separate implementation lane. The archive is readable Markdown; agents can find it through memory retrieval and, when shared into the repository, through the normal code graph. A completion claim is never inferred from file names or a commit message.

## User workflow

`crib intake implement <intake-id> --plan <repo-relative-markdown> --base <git-ref> --category enhancement|addon|fix|refactor --summary <text> [--receipt <id> ...] [--team]` is the explicit completion action. It requires an existing intake owned by the caller, a readable Markdown plan inside the repository, an ancestor base commit, a clean committed HEAD, and a nonempty change set. The command reports the exact base and HEAD SHAs, commits, changed paths, archive path, implementation ID, graph refresh result, and any incomplete step.

The default archive and metadata remain private to the local repository memory store. `--team` is an explicit audience choice: it requires that the intake was already shared with the team, then also writes a repository Markdown archive and shares the implementation record through Git-backed team memory. Existing `crib intake complete` remains a task-close action and does not claim a plan was implemented.

## Data model and storage

An immutable `ImplementationRecord` lives in an `implementations` memory collection, separate from claim records and intake checkpoints. It has a content-addressed `impl:` ID, schema version, principal and repository IDs, intake ID, category, plan path and SHA-256, base and head commit SHAs, ordered commit IDs and changed paths, patch SHA-256, archive path and SHA-256, receipt IDs, actor, and recorded time. Its status describes an explicit implementation report, not release certification. Repeating the same command with the same plan and Git range returns the same ID and bytes.

The Markdown archive contains the verbatim plan, a concise change manifest, verification receipt IDs and their stated provenance, and the complete `git diff --binary <base>..<head>` in a separate `Raw patch` section. This preserves every text and binary Git change without making a generated prose summary the only account of the work. The archive records the exact revision hashes so later repository drift is visible. The local archive is stored under the local memory store; the team archive is stored under `docs/implemented-plans/` and linked to changed source paths in Markdown so the existing Markdown extractor and cross-modal linker can connect it to code.

## Completion sequence and recovery

Preflight all inputs and scan the archive for secrets before any write. Write the Markdown atomically, write the implementation record through `MemoryStore`, update the code graph, then append a completed intake checkpoint with archive and receipt references. The implementation search projection admits only records joined to a matching completed checkpoint, so an interrupted attempt is not displayed as finished work. If a step fails, return a nonzero result naming the successful prior steps; retries are idempotent and never report completion early. A team archive or mirror failure leaves the local record available and reports that sharing is incomplete. No implicit device sync or team share occurs.

## Retrieval

`crib memory implementations list|get|search`, `memory({op:"implementations"})`, and a separate budgeted `brief.implementations` group return authorized implementation hits. Ranking is deterministic lexical scoring; semantic scoring can be added without mixing these reports into trusted claim recall. Results cite archive hashes, Git revisions, changed paths, and receipts. Repository-shared Markdown is picked up by `crib update`, so `crib query`, `context`, and graph paths can find the plan and its changed code. The private archive stays outside the project code graph; its record remains searchable through private memory retrieval. Retrieval reports archive integrity and a graph state of private, indexed, stale, or unknown.

## Tests and acceptance

- A real temporary Git repository demonstrates plan + full diff archival, idempotent retry, and separation from unfinished intakes and ordinary claims.
- Private records are invisible to a second principal. Team visibility requires `--team` and respects the existing intake audience policy.
- Dirty trees, missing plans, nonancestor bases, empty diffs, secret-bearing archives, and write/index failures never produce a completed checkpoint.
- Search returns the implementation as a distinct result; a graph update exposes a team Markdown section with edges to changed files.
- Reopening the store reproduces the same record and archive checksums; a missing or modified archive is reported as degraded, never silently trusted.
