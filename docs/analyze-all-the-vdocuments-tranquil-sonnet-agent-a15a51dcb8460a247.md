# Adversarial Claim Verification — Broadcom cobol-control-flow

## Claim
"The Broadcom cobol-control-flow VS Code extension models COBOL control flow only as paragraph nodes with edges drawn exclusively from PERFORM execution statements, and does not represent GO TO, GOBACK, EVALUATE, paragraph/section fallthrough, or conditional branch logic in its graph."

## Verdict: REFUTED (high confidence)

### Evidence
1. README quote ("edges drawn based on the 'PERFORM' COBOL execution statements") supports only the narrow fact that PERFORM drives edge generation in the documented overview. It does NOT support the strong negative claim that GO TO / conditional logic are absent.
2. Primary contradicting source: maintainer Leonid Baranov's official v1.2.1 release article (Medium "Modern Mainframe") states the engine now:
   - handles GO TO with multiple targets
   - processes ALTER statements that redirect GO TO targets (tracks runtime redirection)
   - improved PERFORM UNTIL
   - tracks control-altering statements inside conditional (IF) blocks
   - handles CICS/SQL control-altering statements
   - handles PERFORM sections containing GO TO with target inside the section
   - "build control flow graphs that more accurately reflect the actual runtime behavior" via execution-context tracking
3. This directly refutes "exclusively from PERFORM" and "does not represent GO TO ... or conditional branch logic."
4. Claim is outdated (relies on stale README) + overreach (misreads a sparse doc as a complete capability inventory). GOBACK, EVALUATE, fallthrough remain unmentioned either way, but the compound "OR" claim is falsified because several listed constructs ARE represented.

## Sources
- https://github.com/BroadcomMFD/cobol-control-flow (README)
- https://medium.com/modern-mainframe/new-code4z-cobol-control-flow-1-2-1-better-and-faster-dfe74594c6e9 (maintainer release notes)