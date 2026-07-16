<!--
ADR — Installer signing: defer in favor of npm-first distribution.
Status: DRAFT (USER-ONLY approval — the plan's M4.7 gate is "Gatekeeper/SmartScreen clean, OR ADR deferring"). This is the deferral ADR; the user approves or rejects and buys certs instead.
-->

# ADR: Defer installer signing in favor of npm-first distribution

- **Status:** DRAFT — proposed (pending user approval)
- **Date:** 2026-07-13
- **Milestone:** M4.7
- **Supersedes:** none

## Context

M4.7 of the build plan calls for installer signing — macOS notarization + Windows code signing — so the beta installers (see `docs/knowledge-crib-beta-installers.md`) pass Gatekeeper / SmartScreen without warning. The plan's gate is explicitly a disjunction: **"Gatekeeper/SmartScreen clean, or ADR deferring."**

The same milestone (M4) ships **npm-first distribution** (M4.1): `npx knowledge-crib` is the primary install path. npm installs are not signed binaries — they're JS packages resolved by the user's `npx`/`pnpm`/`npm` toolchain, which is the trust path every Node developer already uses. The beta installers (`.pkg` / `.msi` bundling Node + the CLI) are a **secondary** path for users who want a double-click install and don't have Node.

The two paths have different threat models and different cost structures:

| Path | Trust mechanism | Signing requirement | Cost |
|---|---|---|---|
| `npx knowledge-crib` (npm) | npm registry + the user's Node toolchain | none (it's JS, not a signed binary) | $0 + the M4.1 publish runbook |
| Beta installers (`.pkg`/`.msi`) | OS notarization/signing | Apple Developer ID + Windows cert | Apple Developer Program $99/yr; Windows code-signing cert ~$200–400/yr (EV cert more, and required for immediate SmartScreen reputation) |

## Decision (proposed)

**Defer installer signing. Ship npm-first.** The beta installers remain buildable (`installer:build`/`installer:smoke` gates stay in `release:verify`) but ship **unsigned**, documented as "for users who prefer a double-click install and accept the Gatekeeper/SmartScreen first-run warning" — with the npm path as the recommended default.

Revisit signing when **either**:
1. an enterprise pilot requires signed installers for managed-deployment policy (a concrete deal, not speculation), **or**
2. installer adoption (telemetry opt-in, or support-load signal) shows users hitting the OS warning frequently enough that signing pays for itself.

## Rationale

- **The primary install path is unaffected.** `npx knowledge-crib` works on a clean machine with no cert, no warning, no notarization. M4.1's gate ("`npx knowledge-crib` works on a clean machine") is the load-bearing one; M4.7 is the disjunction, not a blocker.
- **Cost is real and recurring.** Apple Developer Program + a Windows cert (ideally EV for immediate SmartScreen reputation) are annual costs. For a pre-product-market-fit launch with the npm path as primary, they're speculative spend.
- **Reversibility.** Signing can be added later without breaking the unsigned installers or the npm path — it's a build-pipeline addition, not an architectural change. Deferring loses nothing structural.
- **The plan explicitly allows it.** The gate text "Gatekeeper/SmartScreen clean, **or ADR deferring**" makes this the sanctioned alternative.

## Consequences

- **Positive:** M4.7 closes via this ADR (the deferral half of the gate) with $0 and no cert procurement (a user-only action involving identity verification + payment). Launch is unblocked on the installable dimension.
- **Negative:** users who use the beta installers see a Gatekeeper ("unidentified developer") / SmartScreen ("Windows protected your PC") first-run warning and must right-click→Open (macOS) / "More info → Run anyway" (Windows). This is a documented, common experience for unsigned-but-legitimate dev tools; the installer docs + the social card should say "npm-first; installers are unsigned convenience builds."
- **Neutral:** the installer build/smoke gates stay in `release:verify` — they validate the bundling pipeline regardless of signing.

## Alternatives considered

1. **Sign now (the plan's first half).** Rejected as proposed-for-deferral: the cert procurement is a user-only action (identity verification + payment), and the npm-first path makes it non-blocking. Re-opens automatically under the revisit triggers above.
2. **Drop installers entirely.** Rejected: the bundling pipeline is built + gated (`docs/knowledge-crib-beta-installers.md`, `installer:build`/`smoke`); dropping it discards working infrastructure for a future where signing is justified. Keep it, ship unsigned.

## What the user does to close M4.7

- **Approve this ADR** → M4.7 closes (deferral half of the gate). Update `docs/knowledge-crib-beta-installers.md` with a one-line "installers are unsigned; npm-first" note + link this ADR. Stamp plan row 4.7 DONE.
- **Reject (sign instead)** → the user procures an Apple Developer ID + a Windows cert (user-only: identity verification + payment), and the signing step is wired into `scripts/build-installers.mjs`. Re-open as M4.7b.