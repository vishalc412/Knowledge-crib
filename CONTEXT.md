# Knowledge-crib

Knowledge-crib preserves project understanding so agents and people can continue work across sessions, tools, and devices without reconstructing intent from chat history.

## Language

**Continuation**:
The ability for a new session or device to reconstruct the intended outcome, current progress, unresolved blockers, and next safe action from durable project knowledge. It does not mean reviving an arbitrary live process.
_Avoid_: Process resumption, chat replay

**Checkpointed Work**:
Unfinished work whose intent, progress, blockers, and next action are recorded well enough for another session to continue without guessing.
_Avoid_: In-flight process, session transcript

**Intake Requirement**:
A durable statement of requested work that can be kept private or explicitly shared across systems. It preserves the sanitized original wording as its source and a structured interpretation of the outcome, scope, constraints, acceptance criteria, and status.
_Avoid_: Prompt, chat message, task transcript

**Device Share**:
Distribution of private project knowledge among devices controlled by the same principal. It is not visible to project collaborators and never enters Git.
_Avoid_: Personal sync, private team share

**Team Share**:
An explicit promotion that makes an intake requirement and its future checkpoints visible to project collaborators through the repository. It is durable Git history and cannot promise retroactive secrecy.
_Avoid_: Public share, device sync

**Resume Brief**:
The deterministic new-session view of active intake requirements, current checkpoints, repository drift, blockers, and next safe actions.
_Avoid_: Transcript summary, automatic execution
