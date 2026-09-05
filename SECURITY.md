# Security Policy

## Supported Versions

Security fixes are accepted for the current `0.1.x` release candidate line. Until the first stable
release, older snapshots are not supported.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub private vulnerability reporting for the repository at:

https://github.com/KnowledgeCrib/knowledge-crib/security

If private reporting is unavailable, open a minimal public issue that says you have a security report
to share, without exploit details or sensitive data.

## Scope

Security-sensitive areas include:

- CLI commands that read or write repository files
- MCP server request handling and path/root resolution
- Package installers and npm publishing artifacts
- Graph ingestion of untrusted source trees
- Optional LLM enrichment input/output handling

## Project Security Principles

- The deterministic indexing and query path should work offline.
- The derived SQLite index is rebuildable and should not be treated as a source of truth.
- MCP responses should be token-bounded and provenance-tagged.
- Generated installer and package artifacts must be verifiable from source.

## Data Classification & the LLM Layer (M1.4)

The knowledge graph has two committed artifacts, and they carry different data classes:

| Path | Committed? | Carries verbatim source? | Class |
|------|-----------|--------------------------|-------|
| `.crib/soul/` | yes | no — names, signatures, spans, hashes only | structural metadata |
| `.crib/llm/` | yes | **yes** — `evidence[].quote` lifts verbatim spans | model-authored + source snippets |
| `.crib/index/`, `.crib/embeddings/` | no (gitignored) | rebuildable derived state | not a source of truth |

Because `evidence[].quote` is verbatim source, a secret in the indexed source could be copied into a
committed `.crib/llm` artifact. Two guards (M1.4) prevent this:

1. **Persist-time secret scan** — `crib enrich --save` (the `enrich_save` verb) scans every
   model-authored string (analysis, graph, evidence) with known-key-prefix + high-entropy detectors
   and rejects the whole item on any hit. A planted canary secret can never reach a committed
   artifact. Run `crib audit-llm` after a refactor to re-verify persisted artifacts.
2. **`crib export --format llm --redact`** (default) — strips every evidence `quote` to a span ref
   `{soulId, file, startLine, endLine}` and masks any secret-pattern substring in analysis/graph
   strings. Use this bundle — never the raw `.crib/llm` tree — when sharing the LLM graph
   externally. `--no-redact` emits verbatim quotes (local debugging only).

**Policy:** never commit `.crib/index/` or `.crib/embeddings/` (already gitignored). Before sharing a
`.crib/llm` bundle outside a trusted enclave, export it with `crib export --format llm --redact` and
verify the output contains no `[REDACTED:*]` markers — a marker means a secret was present and masked;
trace and remove the secret at source before any external share.

## Threat Model & Access Model (M3.7)

Knowledge-crib is a **local-first, stdio-served, offline-deterministic** code knowledge graph. This
section records the trust boundaries, the network surface inventory, and the access model so
operators and downstream integrators can place it correctly inside their own threat models. Every
claim below is verified against source (file:line in parentheses) and re-checked by the release
`security:check`-equivalent gates (Host-header curl, canary secret, redact).

### Assets & trust boundaries

| Asset | Location | Trust boundary | Why it matters |
|-------|----------|----------------|----------------|
| Source repo under analysis | user working copy | trusted (operator already has access) | crib reads it to build the graph |
| `.crib/soul/` | committed to the repo's git | inherits repo ACL | the portable artifact others clone |
| `.crib/llm/` | committed to the repo's git | inherits repo ACL | carries verbatim `evidence[].quote` (see M1.4) |
| `.crib/index/`, `.crib/embeddings/` | gitignored, derived | not a source of truth | rebuildable from soul + repo |
| `.crib/.lock` | gitignored | single-writer guard (M0.6) | prevents concurrent-write corruption |
| MCP transport | stdio (default) | the process boundary | whoever runs the CLI speaks to the server |
| MCP transport | loopback HTTP (`serve --http`, opt-in) | Host/Origin allowlist + 4 MiB body cap | any LOCAL process; not per-user authorization |

### Network surface inventory (the whole product)

There are exactly **three** network-reachable or network-originating surfaces. All are opt-in; the
deterministic path has none.

1. **MCP server transport — stdio by default, no listener.** The default `crib serve` imports
   `StdioServerTransport` and runs `serveStdio()` (`packages/mcp/src/server.ts`). In this mode the
   MCP server **opens no TCP/HTTP/WS listener**: to talk to it you must spawn the process and write
   JSON-RPC to its stdin — the operating system's process-spawn ACL (not a crib layer) gates that.
   This is the transport every installed client config uses.

2. **`crib serve --http` shared daemon — opt-in, loopback only, Host/Origin-allowlisted and
   byte-capped.** A stdio server is one process per client and each holds its own full copy of the
   graph (~213 MB here), so a large agent swarm cannot fit in memory; `serveHttp()`
   (`packages/mcp/src/server.ts`) exists to let many local agents share ONE loaded graph. It is not
   started unless `--http` is passed, and it binds `127.0.0.1` by default.

   Its boundary is enforced before routing, for `/health` as well as JSON-RPC
   (`isAllowedHttpCaller`): the `Host` authority must be loopback (or exactly the host an operator
   deliberately bound to), and an `Origin`, when present at all, must also be loopback — a
   non-browser caller sends none, so a foreign `Origin` is by construction cross-site. A foreign
   `Host`/`Origin` is rejected with 403, closing the DNS-rebinding path by which a browser page can
   otherwise reach a loopback daemon "same-origin". Request bodies are capped at
   `MAX_HTTP_REQUEST_BYTES` (4 MiB) and the connection is destroyed rather than buffered past it,
   so one local process cannot exhaust the daemon every other agent depends on. Pinned by
   `packages/mcp/src/http-boundary.test.ts`, which replays the exact foreign-Host `initialize` that
   the 5 September 2026 audit observed answering 200 before this control existed.

   **Locality is not authorization.** This boundary establishes that the caller is local. It does
   **not** identify which local user is calling: the daemon runs as one OS user and its `verbs`
   object — the graph, the index, the caches — is shared by every request. Do not expose this
   transport as a multi-tenant or remote endpoint on the strength of this control.

3. **`crib viz` HTTP server — loopback only, Host-allowlisted (M0.3).** This is the **only** HTTP
   listener in the repo (`http.createServer` + `.listen(port, '127.0.0.1', …)` in
   `packages/cli/src/cli.ts:1339,1389`). It binds to `127.0.0.1` and enforces a Host-header
   allowlist `{'127.0.0.1','localhost','[::1]'}` (`packages/cli/src/viz-server.ts:15`, checker
   `isAllowedHost` at `:18-32`) **before any file or asset read** (`cli.ts:1353`). A request with a
   foreign `Host` header (DNS-rebinding exfiltration vector) is rejected with 403. It serves graph
   visualization assets for local development only.

**No other network surface exists.** Specifically:

- **The deterministic core is offline.** A grep for `fetch(`, `http.`/`https.`/`net.`, `node:http`,
  `node:https`, `node:net`, `WebSocket`, `XMLHttpRequest`, `axios`, `got(` over `packages/core/src`,
  `packages/parsers/src`, and `packages/pipeline/src` finds **zero** network calls. The single
  apparent hit, `packages/parsers/src/ts/http-client.ts`, is a **static analyzer** that *recognizes*
  `fetch`/`axios` call sites in the user's indexed source (AST matching) and extracts
  `{httpMethod, routePath, framework}` metadata — it issues no request. Index, parse, link, cluster,
  query, and persist run with no socket opened.

- **Cross-repo federation is filesystem-based, not HTTP.** The M3.2 "route-layer bridge" sounds
  networkish but is an **in-memory computation over loaded souls** (`packages/core/src/federation.ts:42`,
  `loadFederation(roots)` reads sibling repos' `.crib` dirs by path). A repo-A `http-call` node
  (metadata extracted from source by the analyzer above) is matched to a repo-B `route` node by
  `{httpMethod, routePath}`. **No cross-repo edge is committed and no network call is made** — the
  operator supplies repo working-copy paths the process already has filesystem access to.

- **LLM enrichment makes no outbound model call from the crib process.** The server "never calls a
  model" (`packages/mcp/src/enrichment.ts:2-5,48-53`); it exposes a deterministic work queue
  (`enrich_next`) and a validation/persistence surface (`enrich_save`). The **host IDE's** selected
  agent model authors the semantic graph; crib only validates, grounds (rehydrates every claimed
  evidence span, M1.3), and persists. `auditLlm` is "PURE over the soul + repoRoot — never calls a
  model" (`enrichment.ts:809`). Enrichment requires an explicit action (`/crib-enrich` skill or
  `crib enrich --next/--save`); `crib index`/`query`/`reindex` never trigger it (they only call
  `printLlmPending`, a read). Any outbound model traffic originates in the **IDE agent**, governed
  by that agent's own network policy — outside crib's trust boundary.

### Access model — the soul inherits the repo ACL

The soul (`.crib/soul/` — nodes, edges, dossiers, clusters, manifest) is **ordinary files committed
to the repo's git** (`git ls-files .crib/` ≈ 2279 tracked files; `.crib/.gitignore` ignores only the
derived `index/` and `embeddings/`). There is **no separate authentication or authorization layer**
on top:

- `SoulStore.getNode(id)` is a bare `Map.get` (`packages/core/src/soul-store.ts:271`); `load()`
  reads files from disk with no access gate (`:80`).
- The MCP server registers tools with **no auth middleware** — every `registerTool` call is
  unguarded.
- A grep for `authn|authz|authenticate|authorize|password|permission|acl|access control|login|session`
  over `soul-store.ts`, `index-store.ts`, `server.ts`, `verbs.ts` finds no gating code.

**Consequence (intended and by design):** read access to the soul is governed **entirely** by the
repository/git ACL. Whoever can `git clone` the repo can read the soul; whoever cannot, cannot. This
is the property that makes the soul **portable and diff-able** — there is no crib-owned identity
system to integrate, revoke, or breach. Operators apply their existing repo-branch-protection,
signed-commit, and code-review controls to `.crib/` exactly as they do to source.

**Write access** is additionally constrained:

- Only `.crib/index/` and `.crib/embeddings/` are derived (gitignored); the committed soul is written
  by `crib index`/`reindex` under the `.crib/.lock` single-writer guard (M0.6), and `.crib/llm/` is
  written by `enrich_save` under the same lock and the M1.3 grounding + M1.4 secret-scan gates.
- `--extracted-only` produces byte-identical souls across machines (determinism inviolable) — a
  tampered soul is detectable by re-indexing and diffing.

### STRIDE summary

| Threat | Surface | Control |
|--------|---------|---------|
| **Spoofing** | `crib viz` HTTP | loopback bind + Host-header allowlist, checked before any read (M0.3) |
| **Tampering** | `.crib/soul`, `.crib/llm` | `.crib/.lock` single-writer (M0.6); `--extracted-only` byte-determinism; `enrich_save` grounding rejects unverifiable claims (M1.3); per-edge provenance/confidence |
| **Repudiation** | graph authorship | every edge carries `provenance` (EXTRACTED/INFERRED/…) + `confidence`; dossiers carry `evidence` spans — no anonymous claims |
| **Information disclosure** | `.crib/llm` `evidence[].quote` | persist-time secret scan + `crib audit-llm` (M1.4); `crib export --redact` default for external share |
| **Denial of service** | MCP verbs, parsers | hard caps `MAX_LIMIT=200`, `MAX_SCOPE_SYMBOLS=500`, `MAX_SOURCE_CHARS=512K`, `MAX_DEPTH=32`, `MAX_HOPS=64` (M0.5); seeded fast-check fuzz harness terminates-on-hang, budget-bounded (M3.5) |
| **Elevation of privilege** | soul reads | none possible — no crib authz layer exists; access == repo ACL |

### Operator checklist

1. Treat `.crib/` like source: branch protection, signed commits, code review on PRs that touch it.
2. Run `crib audit-llm` after any enrichment or refactor that moves code; investigate any
   `[REDACTED:*]` marker before sharing.
3. Share `.crib/llm` externally only via `crib export --format llm --redact`.
4. Keep `crib viz` on loopback; if you proxy it, preserve the `Host` header or extend the allowlist.
5. For cross-repo federation, the operator is responsible for filesystem-read ACL on the sibling
   repo roots they pass as `roots` — crib does not fetch them.
