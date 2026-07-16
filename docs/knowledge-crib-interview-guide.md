# Nexus — User Research Interview Guide

**Goal:** validate the riskiest assumption [Q27] before building wide:
> *Developers actually want — and will trust — doc/spec context fused into code impact, rather
> than just wanting better code-only context.*

**Format:** 60-min moderated remote interview, recorded with consent. 5–8 participants [Q28].
**Method:** semi-structured interview + a reaction segment on the MVP concept.

---

## Objectives
1. **Primary:** Is missing **doc/spec** context (not just code) a real cause of agent failures?
2. **Trust:** Will devs trust auto-linked doc↔code mappings? What makes a link credible?
3. **Behavior:** Would persistent multimodal memory change how much they delegate to the agent?
4. **Secondary:** Does the token-savings framing land as a reason to adopt? [Q25 efficiency]

---

## Participants & screener [Q30]
Recruit across 3 segments (aim 2–3 each):
- **S1 — GitNexus users** (warm; test retention/depth)
- **S2 — Graphify users** (warm; test breadth/multimodal appetite)
- **S3 — Cold AI-IDE devs on large codebases** (expose onboarding/positioning gaps)

**Screen in:** uses an AI coding agent (Claude Code / Cursor / Copilot / Aider) ≥3×/week; works in
a codebase >50k LOC or with meaningful docs/specs; has hit an agent making a wrong/breaking change.
**Screen out:** hobby-only; greenfield tiny projects; no agent usage.
**Incentive:** standard rate (~$100/hr equiv) or comparable.

---

## Guide

### Warm-up (5 min) — rapport, framing
- Quick intro. "No right answers, we're testing the idea not you. OK to record?"
- "Walk me through your stack — which agent, what kind of codebase?"

### Context (10 min) — current workflow
- "Last time you used the agent on something non-trivial — what did you do, step by step?"
- "How do you give it context today? Paste files? Let it explore? Something else?"
- *Probe:* "Where does that break down or annoy you?"

### Deep dive 1 (7 min) — what context was missing [Q29.1]
> "Think of the **last time the agent broke something** or made a wrong change."
- What was the change? What broke?
- In hindsight, what context was it missing — **code, docs, or both**?
- *Probe:* Was there a doc/spec/ticket that *would* have prevented it? Did the agent have access?
- *Probe:* How often does this happen? What do you do to recover?
- **Listen for:** spontaneous mention of docs/specs vs. pure code context. (Core signal for Obj 1.)

### Deep dive 2 (8 min) — trust in auto-links [Q29.2]
> Show two concrete examples: (a) a **correct** doc→symbol link with a provenance snippet,
> (b) a **plausibly wrong** link.
- Reaction to (a): would you act on this? What makes it credible?
- Reaction to (b): how would a wrong link affect your trust in the whole feature?
- *Probe:* What would you need to see to trust a link — the snippet? a confidence score? the rule
  that made it?
- *Probe:* Is a wrong link worse than no link? (Tests the precision/recall tradeoff + threshold.)
- **Listen for:** provenance/confidence as trust prerequisites. (Validates [Q27] design choice.)

### Deep dive 3 (5 min) — behavior change [Q29.3]
- "If the agent reliably had **persistent memory of code + its docs**, what would you delegate that
  you don't today?"
- *Probe:* What would still block you from trusting it with that?
- **Listen for:** concrete new tasks (signals real value) vs. vague interest (weak signal).

### Reaction (10 min) — the MVP concept
> Show the demo flow: `impact("AuthService")` returning **code blast-radius + the spec sections
> describing it**, with provenance.
- First reaction — what is this, in your words?
- Would you use it on your current project? Why / why not?
- *Probe (token savings):* "It also means the agent queries this instead of reading raw files —
  fewer tokens per task." Does that matter to you? (Gauge if efficiency is a buy reason.)
- *Probe:* What's missing before you'd adopt?

### Wrap-up (5 min)
- "Anything about agent context we didn't cover that frustrates you?"
- "If you could wave a wand and fix one thing about how agents understand your code — what?"
- Thank. Ask: OK to follow up / join MVP beta?

---

## Synthesis plan
1. **Affinity map** transcript observations → themes.
2. **Impact/effort matrix** on requested capabilities.
3. **Decision on the wedge** against explicit criteria below.

### Go / pivot criteria (decide before interviews, judge after)
| Signal | Threshold | Read |
|--------|-----------|------|
| "Missing context was docs/both" (DD1) | ≥ 5/8 | **Go** — wedge is real |
| Trust links *given provenance+confidence* (DD2) | ≥ 5/8 | **Go** — design holds |
| Names concrete new delegation (DD3) | ≥ 4/8 | strong value signal |
| Wants **code-only**, docs seen as noise | majority | **Pivot** — lead with code depth, demote doc-link |
| Trust collapses on one wrong link, no provenance fix | majority | raise `--link-threshold`, precision-first MVP |

**Highlight reel:** pull 5–8 verbatim quotes (the breakage stories + trust reactions) for the
build team and any co-maintainer conversation.
