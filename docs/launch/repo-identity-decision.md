<!-- M4.5 — GitHub org identity decision. DECIDED 2026-07-18 (Option A). Historical options retained in git history (see pre-2026-07-18 revisions); this doc now records the decision and the alignment gate. -->

# Knowledge-crib — repo identity decision (M4.5)

**Status: DECIDED — Option A, `KnowledgeCrib` GitHub org (2026-07-18).**

Canonical home: **`https://github.com/KnowledgeCrib/knowledge-crib`**.

## Decision summary

- The `KnowledgeCrib` GitHub org and its public `knowledge-crib` repo exist; the release branch is pushed there as `main`.
- The npm scope **`@knowledge-crib`** (251 internal references across `packages/`) aligns with the org name — the "why is the package `@knowledge-crib` but the repo owned by a personal account?" question never arises.
- The pre-existing personal-account repo remains as a non-canonical archive with a description pointing here; it is not a mirror and receives no further pushes.

## Reference alignment (completed 2026-07-18)

- `docs/knowledge-crib-showcase.html` — 3 refs updated to the org.
- `docs/launch/show-hn.md` — placeholder URL resolved to the org.
- All `package.json` `repository.url` fields already pointed at the org — no change needed.

## Post-decision gate — zero mixed references

```
grep -rn "KnowledgeCrib/knowledge-crib\|vishalc412/Knowledge-crib" \
  --include="*.md" --include="*.json" --include="*.html" --include="*.ts" --include="*.mjs" . \
  | grep -v node_modules | grep -v ".crib/"
```

must return references to **exactly one** owner: `KnowledgeCrib`. (The personal-account slug appears in this file only inside the gate command itself, as the pattern being excluded.)

## Topics + social card (the rest of M4.5)

- **GitHub topics** on the org repo: `mcp`, `knowledge-graph`, `code-analysis`, `ai-agents`, `cli`, `developer-tools`, `code-intelligence`, `legacy-modernization`. (The root `package.json` already carries `["mcp","knowledge-graph","code-analysis","ai-agents","cli"]`.)
- **Social card:** a 1280×640 OG image for the repo + the docs site (`docs/site/index.html`) — reuse the comparison-matrix headline ("the only tool that combines deterministic git-committable code KG + per-edge provenance + behavior depth + agent-native MCP + federated blast-radius + grounded opt-in LLM"). Asset creation is a user/design step (open).
