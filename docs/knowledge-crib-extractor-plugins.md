# Knowledge-crib — Extractor Plugin Spec

> Breadth comes from plugins, never from bloating the core [Q13, Q14]. An extractor turns a file
> into nodes + intra-file edges. Languages and formats are both extractors. This is the contract a
> dev (or the community) implements to add support.

---

## 1. Contract
```ts
interface Extractor {
  /** unique id, e.g. "lang:rust", "doc:markdown" */
  name: string;
  /** which files this handles (by extension/mime/heuristic) */
  supports(file: FileMeta): boolean;
  /** parse ONE file → nodes + INTRA-FILE edges only (cross-file is the resolver's job) */
  extract(file: FileMeta, ctx: ExtractCtx): Promise<ExtractResult>;
}

interface FileMeta { path: string; lang?: string; bytes: number; mtime: number; }
interface ExtractCtx {
  readText(): Promise<string>;          // lazy source read
  treeSitter(grammar: string): Parser;  // shared WASM parser pool
  hash(s: string): string;              // blake3
  idFor(kind: NodeKind, parts: object): string;  // ID-grammar helper (keeps ids canonical)
}
interface ExtractResult { nodes: Node[]; edges: Edge[]; }  // edges: member-of, local calls, etc.
```

**Rules**
- Emit only **intra-file** edges. Cross-file resolution (`calls`/`imports`/`inherits`) is the
  resolver phase — extractors must not guess across files.
- Use `ctx.idFor(...)` for every id so the ID grammar stays canonical.
- Set `provenance:"EXTRACTED"` for anything deterministic. Never call an LLM in an extractor (that's
  the optional enrichment phase).
- Be resilient: a parse failure degrades to a file-level node, never throws the pipeline.

## 2. Two extractor families
### Language extractor
- Wraps a tree-sitter grammar; emits `symbol` nodes (class/fn/method/interface/enum/field) with
  `qualifiedName`, `span`, `signature`, and `member-of` edges.
- Declares a **capability matrix** (what it resolves): `{ imports, calls, inheritance, types }`.
  Lower-capability langs still index at symbol level.

### Format extractor (docs/data)
- e.g. Markdown → `doc-section` nodes + `member-of` (heading hierarchy) + code-span metadata for the linker.
- Future: PDF/image/audio handled by the **offline Python worker** [Q32], which emits the same node/edge
  records into the soul — *not* an in-process TS extractor (keeps the MCP path pure-TS/fast).

### Multimodal worker (M13 — shipped)
PDF/image/whisper-audio extraction is a **subprocess extractor**, not a TS `Extractor` plugin: a
sibling `python/crib_worker` (uv-managed, outside `packages/*`) invoked as `python3 -m
crib_worker.cli` by `packages/pipeline/src/multimodal/worker.ts`. It emits one JSON payload per media
file (`{schemaVersion, file, modality, segments:[{tStartMs,tEndMs,text,lang}], dropped}`); the TS side
owns node ids (`media:<path>#<tStartMs`) + blake3 hashing, turns segments into `media-seg` nodes +
`member-of` edges to the Phase-1 `file:<path>` node, and links them to symbols via the deterministic
`explicitSignal`/`identifierSignal` (dotted qualified-name refs in transcript text → `describes`).
- **Backends:** `fake` (default, pure-stdlib, reads a `<media>.txt` sidecar — fully offline, drives the
  gate tests), `pdf` (pypdf, zero-model), `audio` (faster-whisper, needs `--model-path`), `image`
  (surya, needs `--model-path`). Real backends are import-guarded runtime plugins; all degrade to `[]`
  on missing dep/model/corrupt media — the worker always exits 0, `runWorker` never throws.
- **Pure-TS safety:** `crib index`/`crib serve` never spawn; only `crib multimodal` or
  `indexRepo({multimodal})` do. Absent worker → graceful no-op (no crash, no media nodes).
- **Capability:** a successful ingest flips `manifest.capabilities.multimodal = true` (via
  `SoulStore.setCapabilities`); a fully-degraded run leaves it `false` (honest).

## 3. Registration & discovery
```ts
// packages/parsers/registry.ts
registerExtractor(new TypeScriptExtractor());
registerExtractor(new MarkdownExtractor());
// resolution: first extractor whose supports() returns true wins (priority-ordered)
```
Third-party plugins ship as `knowledge-crib-extractor-<x>` packages exporting a default `Extractor`;
discovered via config (`crib.config.ts`) `extractors: [...]`.

## 4. Adding a language (worked: Rust)
1. Add the `tree-sitter-rust` WASM grammar to `packages/parsers/grammars/`.
2. Implement `RustExtractor implements Extractor` (`supports`: `.rs`; map AST nodes → symbol kinds;
   emit `member-of`).
3. Declare capabilities (`imports:true, calls:true, inheritance:false, types:partial`).
4. Add the resolver hooks for Rust `use`/path resolution in `pipeline/resolve`.
5. Add fixtures (`fixtures/rust/`) + golden node/edge expectations.
6. Register it. Done — soul/index/MCP are unchanged (schema is language-agnostic).

## 5. Testing a plugin (required for merge)
- **Golden test:** fixture file → exact expected nodes/edges (ids, spans, rels).
- **Degradation test:** malformed file → file-level node, no throw.
- **ID stability test:** re-run → identical ids/hashes.
- **Capability honesty:** declared capabilities match what resolver actually produces.

## 6. Anti-requirements
- No network. No cross-file assumptions. No copied source from GitNexus/Graphify grammars beyond the
  upstream tree-sitter grammars (which carry their own permissive licenses — vendor with notices).
