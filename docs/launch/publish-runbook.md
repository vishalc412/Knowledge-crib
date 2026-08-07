<!-- M4.1 prep — npm publish runbook. The publish itself is a HARD-STOP USER-ONLY action (npm login + explicit go — public/irreversible). This doc is the autonomous prep so the user runs a clean sequence. Grounded in docs/knowledge-crib-production-readiness.md + release:verify green. -->

# Knowledge-crib — npm publish runbook (0.1.0)

**Status:** PREP complete. The publish is **USER-ONLY** — it needs `npm login` (currently ENEEDAUTH) + an explicit go-ahead, and it is **public and irreversible**. This runbook is everything prepped so the execution is a clean, ordered sequence with no ad-hoc decisions.

## Prerequisites (user actions, all gating)

1. **`npm login`** as the publishing account — `npm whoami` must return a username before step 1 below.
2. **Create the `@knowledge-crib` npm org** (if not already) at https://www.npmjs.com/org/create — name it `knowledge-crib`. The 7 packages are scoped `@knowledge-crib/*` (251 internal references — the scope is locked; do not rename). The org must exist before the first scoped package publishes.
3. **M4.5 repo identity: DECIDED (2026-07-18)** — canonical home is `https://github.com/KnowledgeCrib/knowledge-crib` (see [`repo-identity-decision.md`](repo-identity-decision.md)). Every package.json `repository.url` already points there (npm embeds it at publish).

## Pre-publish state (already verified, autonomous)

- All 7 packages at **v0.1.0**, all PUBLISHABLE (root is `private: true` — only the 7 `packages/*` publish):
  - `knowledge-crib` (the CLI — the `npx knowledge-crib` entry, package `packages/cli`)
  - `@knowledge-crib/soul-schema` → `@knowledge-crib/core` → `@knowledge-crib/parsers` → `@knowledge-crib/pipeline` → `@knowledge-crib/mcp` → `@knowledge-crib/ui` (dependency order)
- `corepack pnpm@9.15.0 run publish:dry-run` is wired into `release:verify` and is **green** — pack contents + tarball sizes are already validated every gate run.
- `release:verify` is green (build + ~1000 tests + every gate).
- `bin` entries + Node ≥22.5.0 guard are in place (`packages/cli/src/bin.ts`, `REQUIRED_NODE='22.5.0'`).

## Changelog cut (autonomous prep the user triggers)

The CHANGELOG has an `[Unreleased]` section. Before publish, cut it to a dated release:

```bash
# 1. Edit CHANGELOG.md: rename `## [Unreleased]` → `## [0.1.0] - <YYYY-MM-DD>`
#    (Keep a fresh empty `## [Unreleased]` above it for post-cut work.)
# 2. Commit the cut:
git commit -am "chore(release): cut changelog 0.1.0"
```

The [Unreleased] section already enumerates the M0→M4 shipped features (overview v2, functional map, retrieval eval harness, hybrid retrieval, rerank, linker, alias, JS coverage, ifHash, model-tier hints, ownership, federation, observability, parallel parse, fuzzing, scale bench, threat model, soul-refresh action, onboarding init/doctor, docs site). Verify the cut captures the full set before dating.

## Publish sequence (user executes, in dependency order)

The order matters — a package can only resolve its `@knowledge-crib/*` deps if they're already on the registry. pnpm `-r publish` with `--no-git-checks` handles topo order, but the explicit sequence is the safety net:

```bash
# from repo root, clean tree, on feature/audit-hardening merged to main
corepack pnpm@9.15.0 -r run build          # fresh build
corepack pnpm@9.15.0 run publish:dry-run   # final dry-run — eyeball tarballs + sizes

# publish in dependency order (scoped packages first, CLI last):
corepack pnpm@9.15.0 --filter @knowledge-crib/soul-schema publish --access public --no-git-checks
corepack pnpm@9.15.0 --filter @knowledge-crib/core          publish --access public --no-git-checks
corepack pnpm@9.15.0 --filter @knowledge-crib/parsers       publish --access public --no-git-checks
corepack pnpm@9.15.0 --filter @knowledge-crib/pipeline      publish --access public --no-git-checks
corepack pnpm@9.15.0 --filter @knowledge-crib/mcp           publish --access public --no-git-checks
corepack pnpm@9.15.0 --filter @knowledge-crib/ui            publish --access public --no-git-checks
corepack pnpm@9.15.0 --filter knowledge-crib                publish --access public --no-git-checks  # the CLI — `npx knowledge-crib`
```

`--access public` is required for scoped packages (scoped packages default to restricted/private otherwise — a common publish footgun). `--no-git-checks` skips the working-tree-clean + commit-after-tag checks pnpm enforces (the release commit pattern doesn't tag per-package).

## Post-publish verification (the M4.1 gate)

The plan's M4.1 gate is: **`npx knowledge-crib` works on a clean machine.** Verify on a machine/dir with no local checkout:

```bash
# clean machine / temp dir
npx knowledge-crib@0.1.0 --help          # prints the command list (index, init, doctor, mcp, viz, ...)
npx knowledge-crib@0.1.0 init . --ide claude   # the M4.2 5-minute onboarding, end-to-end via npx
npx knowledge-crib@0.1.0 doctor .        # 6/6 ✓
# then wire MCP in an IDE and run a real query — the stopwatch gate (< 5 min to first query)
```

If `npx` resolves + `init` produces an indexed/hooked/MCP-wired repo + `doctor` is 6/6 ✓, M4.1 is closed. The `npx` form of the M4.2 stopwatch gate (previously USER-ONLY pending publish) becomes satisfiable here.

## Rollback (if a package is broken post-publish)

npm publish is **irreversible** — you cannot delete a version after 72h (and scoped-package versions are unpublishable only within 72h). The safe rollback is **deprecate + republish a fix as a patch**:

```bash
npm deprecate @knowledge-crib/<pkg>@0.1.0 "known issue — use 0.1.1"
# fix, bump to 0.1.1 across affected packages, re-run the publish sequence
```

This is why the dry-run + `release:verify` green + clean-machine smoke are non-negotiable before the first `publish`.

## Pre-publish checklist (tick before the first `publish`)

- [ ] `npm whoami` returns the publishing account
- [ ] `@knowledge-crib` npm org exists
- [ ] M4.5 repo identity resolved; every package.json `repository.url` points at the canonical GitHub home
- [ ] CHANGELOG cut to `## [0.1.0] - <date>` + committed
- [ ] `release:verify` green on the exact commit being published
- [ ] `publish:dry-run` re-run on that commit; tarball sizes eyeballed
- [ ] Working tree clean; release commit on `main` (merged from `feature/audit-hardening` per the no-direct-main + no-self-merge convention)
- [ ] Post-publish clean-machine `npx knowledge-crib@0.1.0 init . --ide claude` + `doctor` planned