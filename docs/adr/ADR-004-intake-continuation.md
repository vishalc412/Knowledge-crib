# First-class intake requirements for cross-session continuation

Knowledge-crib will model intake requirements and their checkpoints as immutable, content-addressed domain events with a deterministic resume projection. Device sharing uses the encrypted user-owned sync channel by default; team sharing is an explicit Git-visible promotion. This preserves original intent and auditable progress without treating chat transcripts or live processes as resumable state.

The alternatives were generic memory claims, which cannot enforce a coherent work lifecycle, and Markdown-only intake files, which cannot support private encrypted device sharing. A non-terminal checkpoint must name a next safe action and repository anchor; a new session loads the resulting resume brief but never executes work merely because it was loaded.
