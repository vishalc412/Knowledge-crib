<!-- Launch asset — demo recording recipe. The GIF/video itself is a USER action (needs a live viz server + screen capture); this is the shot list + exact commands so the capture is one take. Human-reviewed before recording (M4.6 gate). -->

# Knowledge-crib — demo recording recipe

The demo GIF/video is a **user action** — it needs a live `crib viz` server + screen capture (QuickTime / OBS / Loom). This file is the shot list + exact commands so the capture is one clean take. Goal: 60–90s, three beats — **viz graph → impact blast-radius → dossier flow** — that visibly demonstrate the zero-competitor capability set (deterministic committed graph + behavior depth + agent-native MCP).

## Prep (one-time, ~3 min)

```bash
# clone + onboarding (the M4.2 5-minute flow, compressed)
git clone <canonical-repo> knowledge-crib && cd knowledge-crib
corepack pnpm@9.15.0 install
corepack pnpm@9.15.0 -r run build
node packages/cli/dist/cli.js init . --ide claude   # index + hooks + MCP wiring in one command
node packages/cli/dist/cli.js doctor .              # 6/6 ✓ — proves a clean setup
```

The self-index is the demo corpus — the repo indexes itself (dogfood). No fixture needed.

## Shot 1 — the graph (viz)  · ~20s

```bash
node packages/cli/dist/cli.js viz . --open
# → browser opens the offline canvas graph of the self-index
```

**On camera:** zoom into a cluster (e.g. the `pipeline` or `mcp` cluster). Show nodes + edges. Pan to a doc-linked symbol (a doc-to-code edge). Narrate: *"This is the project's soul — a deterministic graph committed with the code. Every edge is git-diffable and carries provenance."*

**Optional credibility beat:** in a terminal, `git log --oneline -5 -- .crib/nodes .crib/edges` to show the soul is version-controlled history.

## Shot 2 — impact blast-radius (the enterprise pull)  · ~25s

```bash
# in an IDE with the MCP server wired (crib init did this), or via CLI:
node packages/cli/dist/cli.js query . --impact <a central symbol, e.g. SoulStore.getNode or Verbs.context>
```

**On camera:** show the impact tree — depth-1 callers (WILL BREAK), depth-2 (LIKELY AFFECTED), the affected processes + modules. Narrate: *"What breaks if I change this? The traversal walks the committed graph, not a re-index — deterministic, reproducible, and it names the execution flows that break."*

**Federation beat (optional, if a 2-repo fixture is set up):** show a cross-repo hop flagged `.crossRepo` — a client call in repo A resolving to a route in repo B. This is the federated blast-radius no competitor ships.

## Shot 3 — dossier / decision-table flow (the behavior-depth moat)  · ~25s

```bash
# the PL/SQL loan-rule fixture is the clearest behavior-depth demo
node packages/cli/dist/cli.js query . --rules <a PL/SQL rule package, e.g. assess_application>
# or the dossier verb for a symbol's full 360° context
```

**On camera:** show the decision table (conditions → actions, with the reads/writes per rule) + the Mermaid flow. Narrate: *"This isn't navigation — it's the behavior layer. The graph knows what the rule engine decides, not just where the symbols are. That's the legacy-modernization wedge."*

**Grounded-LLM beat (optional):** show an `enrich_save` submission getting rejected for missing quote overlap, then a grounded one passing + `crib audit-llm` re-verifying. This is the moat — unverifiable LLM claims don't persist.

## Shot 4 — the close (honest limits + reproducible)  · ~10s

**On camera:** terminal → `corepack pnpm@9.15.0 release:verify` (or a screenshot of the green run). Narrate: *"Reproducible — the gate is green, the eval harness has regression floors, the fuzzer found a real bug before ship. Honest limits are in the repo."*

## Capture notes

- **Resolution:** 1280×720 or 1920×1080; 15–24 fps for GIF size, 30+ for video.
- **Tooling:** GIF → `gifski` (post-capture) or Loom; video → QuickTime screen recording or OBS.
- **Length target:** 60–90s total. Cut hard between shots; no dead air.
- **On-screen text:** overlay the three beat titles ("1 · the soul", "2 · blast-radius", "3 · behavior depth") so the GIF works muted.
- **Don't show:** secrets, real customer code, or the `npx` form until M4.1 publish lands (use `node packages/cli/dist/cli.js`).

## After capture

Drop the final asset at `docs/launch/demo.gif` (or `demo.mp4`) and reference it from the README front page + the Show HN post body. The comparison matrix (`docs/launch/comparison.md`) is the static companion to this dynamic demo.