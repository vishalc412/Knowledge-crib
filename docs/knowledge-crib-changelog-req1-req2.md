# Knowledge-crib — Changelog: Single-Entry Resolution + Auto MCP Wiring (REQ-1, REQ-2)

> What changed, why, and the rationale behind each decision. Implements the two requests:
>
> - **REQ-1** — "every time for a new workspace I need a new entry; it should refer to root `~/.crib`
>   and from there point to the respective project `.crib` directory for the knowledge graph."
> - **REQ-2** — "add a CLI command to configure MCP to the respective IDE automatically rather than
>   the customer adding it manually."
>
> Scope: `packages/cli` only. No other package's behavior changed. 40 CLI tests (29 new), build +
> lint clean. Pre-existing untracked WIP in `packages/parsers/src/{rust,go,csharp,java}/` was
> deliberately left untouched (out of scope — someone else's in-progress work).

---

## REQ-1: One user-scope IDE entry serves every project

### The problem

Before this change, every IDE config entry had to point at a specific project root
(`crib serve /abs/path/to/project`). A new workspace meant a new entry. The user's ask: a single
machine-wide entry that resolves to the correct per-project `.crib/` via a `~/.crib` registry.

### What was built

**`packages/cli/src/registry.ts` (new, ~135 lines)** — `~/.crib/registry.json`, the local project
dispatch table.

- Shape: `{ version: 1, projects: { "<absolute project path>": { repoId, cribDir, vcsHead?, addedAt } } }`.
- `registryDir(env)` — `KCRIB_REGISTRY_DIR` override (tests) else `~/.crib`.
- `readRegistry`/`writeRegistry` — atomic (temp→rename), tolerant of absent/unparseable files.
- `lookupProject`, `listProjects`, `registerProject` (preserves `addedAt` on re-register),
  `unregisterProject`.

**Key design decisions and why:**

1. **The registry is a pointer/overlay layer, NOT a second store.** The soul (chunked JSONL +
   manifest) stays committed inside each project's `.crib/` and remains team-shared. The registry
   only maps an absolute path → the `.crib` dir that holds its soul. This corrects the user's
   mental model of "refer to root `~/.crib`" — the root `~/.crib` is a *pointer*, not where the graph
   lives. The graph stays in the project, committed and portable.

2. **Keyed by absolute project path, NOT `repo.id`.** `repo.id` is a `randomUUID()` persisted
   *inside* `.crib/crib.json`, so reading it requires locating `.crib` first — a chicken-and-egg.
   `repoId` is stored as a validation tag only. The registry is therefore machine-specific (absolute
   paths); the soul itself stays portable/committed.

3. **The registry is NOT the load-bearing resolution mechanism.** Root resolution is done by the
   env-var + upward-walk chain (below); the registry is consulted only as an *overlay* after a root
   is discovered, to honor a custom `.crib` location. This means the registry can be deleted and
   `crib serve` still works for the standard `<root>/.crib` layout. The registry's load-bearing value
   is (a) custom `.crib` locations and (b) an enumerable "known projects" list.

**`packages/cli/src/runtime.ts` (rewritten)** — central resolution logic.

- `resolveProjectRoot(opts): ResolvedRoot` — the priority chain:
  1. explicit positional arg (not `.`)
  2. `--cwd` flag
  3. `KCRIB_ROOT` env
  4. `CLAUDE_PROJECT_DIR` env — Claude Code's real workspace signal (its `cwd` field is ignored,
     issue #42883). This is what makes a single user-scope Claude entry serve every project.
  5. upward walk from CWD for `.crib/crib.json` (monorepo subdirs)
  6. CWD fallback (preserves pre-REQ-1 behavior)
  then the registry overlay: a registered custom `cribDir` wins, but only if it still exists on disk.
- `walkUpForCrib(start)` — 128-iteration guard against symlink/`..` loops.
- `openSoul(resolved: ResolvedRoot)` — signature changed from `openSoul(repoRoot: string)`. The soul
  is opened from `resolved.cribDir`, not assumed `<repoRoot>/.crib`.
- `resolveIndexPath(rel, repoRoot, cribDir)` — manifest index paths are repo-root-relative by
  convention. For the standard layout they resolve against `repoRoot` as before; for a custom
  `cribDir` the leading `.crib/` is stripped so the derived index lands *inside* `cribDir` (it's a
  derived artifact of the soul, so it travels with it). Absolute manifest paths are honored.
- `isIndexedRoot(resolved)` + back-compat `isIndexed(repoRoot)` shim.

**`packages/cli/src/cli.ts` (rewritten, ~570 lines)** — wiring.

- `extractCwdFlag(argv)` → `{ argv, cwdOverride }`. `--cwd` is the highest-priority explicit root
  and may appear before or after the command. (Previously documented but not implemented — this
  fixes that doc divergence.)
- `CmdCtx { cwdOverride? }` threaded to every command.
- `resolveRoot(args, ctx)` — for path-taking commands: positional arg other than `.` → explicit
  root; `.` → treated as "no explicit" → walks from cwd (backward-compat with `crib serve .`).
- `registerIndexed(repoRoot, cribDir, soul)` — after `index`/`reindex`/`update`, the project is
  upserted into `~/.crib/registry.json` (refreshing `repoId`/`cribDir`/`vcsHead`, preserving
  `addedAt`).
- `cmdQuery` — positionals are query text, NOT a root; root comes from `--cwd`/env/CWD only.

### Backward compatibility

- An explicit positional arg always wins, so existing per-project IDE entries that pass an absolute
  root keep working unchanged.
- `crib serve .` walks from cwd (same result as before when `.crib` is present).
- The `isIndexed(repoRoot)` shim keeps any external caller on the old signature working.
- The registry is additive — deleting it degrades gracefully to the standard layout.

### Tests

`packages/cli/src/registry.test.ts` (5) + `packages/cli/src/resolution.test.ts` (12) cover the full
priority chain, the upward walk, the registry overlay (custom cribDir wins / stale cribDir falls
back), `.` positional backward-compat, and the atomic write.

---

## REQ-2: `crib mcp install/list/remove` — auto-wire the IDE configs

### The problem

Users had to hand-edit four different config formats (JSON with two different root keys, TOML with
snake_case tables), each with its own pitfall (wrong root key silently loads nothing; Codex needs an
absolute path).

### What was built

**`packages/cli/src/mcp-install.ts` (new, ~380 lines)** — auto-wires the `knowledge-crib` MCP server
into each IDE's config file.

- `McpIde = 'claude'|'cursor'|'vscode'|'codex'`, `McpScope = 'project'|'global'`.
- `resolveBin(bin?)` — explicit override, else absolute `which crib` (so GUI-launched IDEs that
  don't inherit the shell PATH still find the server), else fall back to `'crib'`.
- `installMcp(repoRoot, opts): McpInstallResult[]`, `listMcp`, `removeMcp`.

**Two idempotency strategies, by format:**

- **TOML (Codex `config.toml`)** — reuses `spliceManaged` (exported from `hooks.ts`) with
  `# >>> knowledge-crib managed >>>` / `# <<< knowledge-crib managed <<<` hash-comment markers. TOML
  permits comments, exactly like the post-commit hook. Sibling `[mcp_servers.other]` tables survive
  byte-for-byte. Re-running replaces the block in place (no duplication).
- **JSON (`.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json`)** — JSON forbids comments, so the
  block-marker strategy cannot apply. Instead: parse → set `servers[name]` (or `mcpServers[name]`)
  in a canonical key order via `sortEntry` → reserialize. Byte-equality check makes re-running a
  no-op. Sibling servers and sibling top-level keys are preserved.

**`packages/cli/src/hooks.ts` (edited)** — `spliceManaged` promoted from private to `export` so
`mcp-install.ts` can reuse the exact same sentinel-block logic for TOML (consistent with the
post-commit hook).

**Per-IDE behavior (why each is the way it is):**

| IDE | Project-scope | Global/user-scope | Args embedded |
|---|---|---|---|
| **claude** | `.mcp.json` (`mcpServers`) | `claude mcp add -s user` (shells out — Claude's user config is CLI-managed, not a file we own) | project: `["serve","."]`; global: `["serve"]` (no path → resolution chain) |
| **cursor** | `.cursor/mcp.json` (`mcpServers`) | `~/.cursor/mcp.json` | `["serve","${workspaceFolder}"]` |
| **vscode** | `.vscode/mcp.json` (`servers` + `type:"stdio"`) | unsupported (upstream undocumented → notes + skips) | `["serve","${workspaceFolder}"]` |
| **codex** | `.codex/config.toml` (`[mcp_servers.knowledge-crib]`) | `~/.codex/config.toml` | `["serve","<abs root>"]` (Codex has no interpolation) |

**Why the args differ:**
- Cursor and VS Code interpolate `${workspaceFolder}` in a per-workspace file, so the same file
  works in every repo.
- Claude Code project-scope spawns with the project root as CWD, and `.` is treated as "no
  explicit root" → the resolution chain (CLAUDE_PROJECT_DIR → walk) finds the soul. This is portable
  and committable.
- The Claude *global* entry uses `["serve"]` (no path arg) deliberately — it relies on REQ-1's
  resolution chain (`CLAUDE_PROJECT_DIR` + registry) to pick the right soul per workspace. **This is
  the single-entry-serves-every-project path for Claude Code.**
- Codex has no `${workspaceFolder}` interpolation, so it must embed an absolute path. This is the
  one IDE where "one entry for every project" is not fully achievable (documented honestly below).

### Honest limitation documented

Codex cannot interpolate a workspace variable, so a single global Codex entry cannot transparently
serve multiple projects the way Claude/Cursor user-scope entries can. The `~/.crib` registry still
resolves a custom `.crib` location if the absolute path's `.crib` was moved, but it cannot make a
single Codex entry path-agnostic. This is stated plainly in the client-setup guide and CLI spec
rather than glossed over.

### Tests

`packages/cli/src/mcp-install.test.ts` (12) — covers all four IDEs × project/global scope, the
`servers` vs `mcpServers` distinction for VS Code, `type:"stdio"` requirement, TOML managed-block
idempotency + sibling preservation, `--ide all`, and `list`/`remove` (removing only the managed
entry, keeping siblings). `mcp-install.test.ts` sets `process.env.HOME` to a tmpdir to isolate
user-scope writes.

---

## Tests + build + lint

- **CLI tests: 40 pass** (registry 5, resolution 12, mcp-install 12, hooks 5, runtime 2, viz 4).
- **Affected packages build/test clean in isolation**: core 38, mcp 17, pipeline 61, cli 40
  (156 total, +29 new).
- **Biome lint clean** on all 9 touched/new files.
- The full-monorepo `pnpm build` has pre-existing failures in `packages/parsers` (untracked WIP:
  `rust/`, `go/`, `csharp/`, `java/` lexer dirs + modified `parsers/src/index.ts`) that are **not**
  from this work and were deliberately left untouched.

---

## Documents updated

- **`docs/knowledge-crib-client-setup.md`** — headline changed from "2-line per-project config" to
  "one user-scope entry that serves every project". Added §3 "Root resolution — one entry, every
  project" (the priority chain + registry-as-overlay) and a `crib mcp` subsection. Each IDE section
  now leads with the `crib mcp install` shortcut before the hand-edit fallback. **Fixed the false
  CWD claim** at the old §4 note ("Claude Code sets cwd to the project root") — replaced with the
  honest explanation that Claude Code ignores `cwd` (#42883) and the chain falls through to
  `CLAUDE_PROJECT_DIR` + the upward walk. Codex §7 now states the absolute-path limitation honestly
  and removed the inline `//Added by Vishal` feasibility-question comment.
- **`docs/knowledge-crib-cli.md`** — reconciled with the implemented `printHelp`: `--cwd` marked
  **Implemented** (was previously listed but not wired); unimplemented flags (`--json`,
  `--quiet/--verbose`, `--link-threshold`, `--include`, `--lang`, `--worker-timeout`, `--transport`,
  `--extracted-only`, `migrate`) explicitly marked **planned / not yet wired**. Added the full
  `crib mcp` command section and a "Root resolution (REQ-1)" section. `query` clarified as taking
  search-text positionals (not a root).
- **`docs/knowledge-crib-user-guide.md`** — added `crib mcp` to the commands table, a "One IDE entry
  for every project" subsection under §3, and the `crib mcp install` wiring in the worked example §5.8.
- **`README.md`** — `cli/` layout line updated to `crib index|update|export|serve|mcp|viz|install-hooks|merge-driver`.

---

## Decision item 4 — committing the soul

The user delegated the "should `.crib/` be committed" concern to best recommendation. `git ls-files
.crib/` returned 0 (the soul was not tracked). The design intent — stated across the docs, the
soul-format spec, and the merge driver — is that `.crib/` (minus the derived `index/`) is committed
and team-shared. **Recommendation applied: commit `.crib/`** (the chunked JSONL soul + `crib.json` +
`schema/`), with `.crib/index/` gitignored. This is consistent with the existing
`docs/knowledge-crib-soul-format.md` and the `crib install-hooks` merge driver, which only make sense
if the soul is shared. The registry (`~/.crib/registry.json`) stays machine-local and gitignored.

---

## Summary

Two user requests, both delivered in `packages/cli`:

1. **REQ-1** — Replaced "one IDE entry per project" with a **resolution chain** (explicit arg →
   `--cwd` → `KCRIB_ROOT` → `CLAUDE_PROJECT_DIR` → upward walk → cwd) plus a **`~/.crib/registry.json`
   pointer overlay**. A single user-scope IDE entry now serves every project, while every existing
   per-project entry keeps working (explicit always wins). The registry is a pointer layer, not a
   second store — the soul stays committed and portable inside each project's `.crib/`.

2. **REQ-2** — Added **`crib mcp install|list|remove`**, idempotent auto-wiring of the MCP server into
   all four IDEs' config files (two idempotency strategies: sentinel-block for TOML, parse/merge for
   JSON). It preserves sibling content, embeds a PATH-independent absolute binary, and surfaces an
   honest note for the one IDE (Codex) where a single path-agnostic entry isn't possible.

29 new tests (registry, resolution, mcp-install); 40 CLI tests pass; build + lint clean. All four
user-facing docs updated and reconciled with the actual implementation (including fixing a false
CWD claim and flagging spec'd-but-unimplemented flags). This changelog documents every change, its
rationale, and the one honest limitation.