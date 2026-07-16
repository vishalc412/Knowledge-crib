<!-- M4.5 prep — GitHub org identity decision. The choice is USER-ONLY (org creation / repo transfer is user action). This doc is the autonomous prep: both options, the reference-alignment checklist, the recommendation. Grounded in the grep of current references (2026-07-13). -->

# Knowledge-crib — repo identity decision (M4.5)

**Status:** DECISION REQUIRED (USER-ONLY — org creation / repo transfer is a user action). This doc is the prep: the two options, the exact reference-alignment checklist for each, and a recommendation. The npm publish runbook ([`publish-runbook.md`](publish-runbook.md)) blocks on this — `repository.url` is embedded in every published tarball.

## What's locked (not affected by this decision)

- **npm scope `@knowledge-crib`** — 251 internal references across `packages/`. The scope is the npm org name, **independent of the GitHub org**. Do not rename regardless of the GitHub choice. (The npm org `knowledge-crib` must be created for publish either way.)

## The current mix (grep, 2026-07-13)

| Reference | Count | Files |
|---|---|---|
| `github.com/KnowledgeCrib/knowledge-crib` (org) | 13 files | `package.json` (root + per-package `repository.url`), docs |
| `github.com/vishalc412/Knowledge-crib` (personal) | 2 files | `docs/knowledge-crib-showcase.html` (3 occurrences, from commit a182c0b), `docs/launch/show-hn.md` (1 placeholder, explicitly marked pending this decision) |

Preponderance already favors the **KnowledgeCrib org**. The showcase is the outlier from a recent commit; the show-hn placeholder self-resolves once this decision lands.

## Option A — `KnowledgeCrib` GitHub org (RECOMMENDED)

**Why recommended:** the npm scope is `@knowledge-crib`; org + scope aligning avoids the "why is the package `@knowledge-crib` but the repo `vishalc412`?" question forever. It also reads as a product, not a personal fork, which matters for the launch (Show HN, LinkedIn, enterprise pilot credibility).

**User actions:**
1. Create the `KnowledgeCrib` GitHub org (if it doesn't exist).
2. Transfer/rename the repo to `github.com/KnowledgeCrib/knowledge-crib` (GitHub redirects the old URL automatically — existing clones keep working).
3. Create the `@knowledge-crib` npm org (separate from GitHub org — needed for publish regardless).

**Reference alignment (autonomous after the transfer):** update the 2 outlier files to `KnowledgeCrib`:
- `docs/knowledge-crib-showcase.html` — 3 refs (lines 115, 170, 359).
- `docs/launch/show-hn.md` — replace the placeholder URL line.
- Re-grep to confirm zero `vishalc412/Knowledge-crib` references remain → "zero mixed references" gate.
- Re-run `docs-site:check` (site links to `../README.md` + the showcase HTML — confirm no broken links after rename; GitHub redirects cover the URL change but internal references should be canonical).

The 13 files already pointing at `KnowledgeCrib` need **no change** under Option A.

## Option B — `vishalc412` personal account

**Why one might choose it:** no org to create; the repo already exists at `vishalc412/Knowledge-crib` (per commit a182c0b's reference). Lower friction for a solo launch.

**Cost:** the npm scope `@knowledge-crib` and the GitHub owner `vishalc412` **don't align** — a permanent minor cognitive friction for every reader. And 13 files (incl. every package.json `repository.url`) must be updated from `KnowledgeCrib` → `vishalc412`, a larger change than Option A's 2-file fix.

**Reference alignment (autonomous):** update 13 files from `KnowledgeCrib` → `vishalc412`; the 2 outlier files already match. Re-grep → zero mixed references.

## Recommendation

**Option A (KnowledgeCrib org).** Lower total change (2 files vs 13), scope+org alignment, product-not-personal framing for the launch. The only added user step is org creation (one-time, free).

## Post-decision gate

`grep -rn "KnowledgeCrib/knowledge-crib\|vishalc412/Knowledge-crib" --include="*.md" --include="*.json" --include="*.html" --include="*.ts" --include="*.mjs" . | grep -v node_modules | grep -v ".crib/"` must return references to **exactly one** owner. That is the M4.5 "zero mixed references" gate.

## Topics + social card (the rest of M4.5)

Once the canonical home is chosen:
- **GitHub topics** on the repo: `mcp`, `knowledge-graph`, `code-analysis`, `ai-agents`, `cli`, `developer-tools`, `code-intelligence`, `legacy-modernization`. (The root `package.json` already carries `["mcp","knowledge-graph","code-analysis","ai-agents","cli"]`.)
- **Social card:** a 1280×640 OG image for the repo + the docs site (`docs/site/index.html`) — reuse the comparison-matrix headline ("the only tool that combines deterministic git-committable code KG + per-edge provenance + behavior depth + agent-native MCP + federated blast-radius + grounded opt-in LLM"). Asset creation is a user/design step.