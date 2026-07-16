# Nexus — Consolidated Decision Questionnaire (Q1–Q35 + Clarifications)

**Answer in one row at the bottom.** Each question has options + my recommended pick (⭐) and a one-line why. Override any with a letter; blank = accept my rec.

---

## My standing assumptions (correct me if wrong)
1. **GitNexus** = TypeScript/Node; owns LadybugDB (SQLite+DuckDB FTS+vector) + Web UI + MCP server; it's your working base.
2. **Graphify** = Python, **MIT**; multimodal + LLM extraction + EXTRACTED/INFERRED edge tags; freely reusable with attribution.
3. **Goal** = ONE fast TS MCP server, ONE store, ONE UI, works per-project. **Unified, not federated.** Delivered as an MCP, not a skill.
4. Privacy: local-by-default, cloud opt-in. Deterministic core; LLM is enrichment-only.
5. MVP validates the wedge (code↔doc impact) before full multimodal.
6. Wedge = **"architectural memory for AI agents."**

---

## Branch 1 — Strategic Intent & Ownership
- **Q1. Structural relationship?** A) true merge B) **GitNexus as base** C) Graphify as base D) federation — ⭐ **B** (GitNexus owns the hard assets + it's yours)
- **Q2. Rights to reuse graphify?** A) collaborate/co-maintain B) clean-room reimplement C) **fork & vendor under MIT (retain notice)** D) defer — ⭐ **C** (MIT confirmed; co-maintain = optional upside)
- **Q3. North-star wedge?** A) safe refactoring across code+docs B) map anything C) **architectural memory for AI agents** D) other — ⭐ **C** (union > parts; ownable category)
- **Q4. Build sequencing?** A) store first B) MCP first C) ingestion first D) **prototype wedge narrow** — ⭐ **D** (de-risk value before full unification)

## Branch 2 — Target User & Job
- **Q5. Primary persona?** A) **AI-IDE power dev on large/legacy codebase** B) team lead C) enterprise architect D) OSS maintainer — ⭐ **A**
- **Q6. Core job-to-be-done?** A) **"give agent trustworthy context so it stops breaking architecture"** B) "understand any project fast" C) "cut agent token cost" — ⭐ **A** (C is a supporting metric)
- **Q7. Emphasis?** A) **code-first, docs as first expansion** B) corpus-first (all inputs equal) C) code-only — ⭐ **A**
- **Q8. Primary pain to anchor messaging?** A) **breakage/rework** B) token cost/slowness C) onboarding/understanding — ⭐ **A**

## Branch 3 — Unified Graph & Data Architecture
- **Q9. Canonical store?** A) **LadybugDB canonical, graph.json export-only** B) graph.json canonical C) dual D) Neo4j — ⭐ **A**
- **Q10. Ontology?** A) **one unified schema (code+doc+media+explanation nodes, typed edges)** B) separate schemas joined at query — ⭐ **A**
- **Q11. Portability vs scale?** A) **scale-first (LadybugDB), portability via export** B) portability-first — ⭐ **A**
- **Q12. Incremental + git?** A) **adopt graphify post-commit hook + merge driver atop GitNexus incremental** B) full re-index each run C) manual — ⭐ **A**

## Branch 4 — Ingestion & Extraction
- **Q13. Pipeline architecture?** A) **one pluggable pipeline w/ extractor plugins** B) two pipelines → one store C) federation — ⭐ **A**
- **Q14. Depth vs breadth?** A) **preserve code depth (non-negotiable), breadth as plugins** B) equal C) breadth-first — ⭐ **A**
- **Q15. Multimodal scope @ MVP?** A) code+MD+PDF B) add media+Workspace now C) **code + Markdown only (pure TS)** — ⭐ **C** *(reconciled with Q32: PDF/media move to the offline worker, keeps MVP pure-TS & fast)*
- **Q16. Cross-modal linking?** A) **yes — auto-link doc↔symbol with provenance** B) no C) manual only — ⭐ **A** (the differentiator)

## Branch 5 — Intelligence Layer (LLM / Privacy)
- **Q17. Local vs cloud?** A) **local-by-default, opt-in cloud enrichment** B) cloud-first C) local-only strict — ⭐ **A**
- **Q18. LLM backend?** A) **pluggable multi-provider (graphify's), default local Ollama** B) single provider C) none — ⭐ **A**
- **Q19. LLM vs deterministic split?** A) **deterministic core never needs LLM; LLM = enrichment only** B) LLM in core — ⭐ **A**

## Branch 6 — Interface & Output Surface
- **Q20. Unified MCP verbs?** A) **GitNexus verbs canonical, map graphify's in, add `shortest_path`** B) keep both sets C) new namespace — ⭐ **A**
- **Q21. Visualization?** A) **GitNexus Web UI primary + Mermaid/report/HTML exports + wiki** B) graphify static HTML primary C) both separate — ⭐ **A**
- **Q22. MCP-first vs UI-first?** A) **MCP-first** B) UI-first C) equal — ⭐ **A**

## Branch 7 — MVP Scope & Roadmap
- **Q23. MVP slice?** A) **doc-extractor (MD) + cross-modal linker + extend `impact`/`context`** B) full unification C) viz-only — ⭐ **A**
- **Q24. v2 deferrals (media, Workspace, store-swap, multi-repo multimodal, cloud SaaS)?** A) **accept list** B) trim more C) add items — ⭐ **A**
- **Q25. Metrics?** A) **activation (doc-link verb wk1) + efficiency (tokens/task) + guardrail (index time, p99)** B) revenue C) stars — ⭐ **A**
- **Q26. License/commercial?** A) **PolyForm NC core + akonlabs commercial, MIT parts attributed** B) fully open-source C) fully commercial — ⭐ **A** *(gated on C1 below)*

## Branch 8 — User Research Plan
- **Q27. Riskiest assumption to validate first?** A) **devs want + trust doc↔code fusion (vs code-only)** B) devs want multimodal C) devs want token savings — ⭐ **A**
- **Q28. Method + sample?** A) **5–8 interviews + moderated usability test** B) survey 100+ C) none — ⭐ **A**
- **Q29. Keep the 3 deep-dive questions** (missing context? trust links? behavior change?)? A) **accept** B) revise — ⭐ **A**
- **Q30. Recruit pool?** A) **both user bases + 2–3 cold AI-IDE devs** B) only warm C) only cold — ⭐ **A**

## Branch 9 — Architecture Reconciliation (unified vs federated)
- **Q31. Runtime model?** A) **single runtime (GitNexus TS base)** B) federation (research doc) C) single Python (Graphify base) — ⭐ **A**
- **Q32. Python-only heavy extractors (PDF/image/whisper/LLM)?** A) offline Python "extractor worker" at index-time (writes to LadybugDB via shared schema) B) port all to TS now C) **drop multimodal for v1 (code+MD)** — ⭐ **C for v1, A as growth path**
- **Q33. How many MCP servers?** A) **one TS MCP server, unified namespace, per-project** B) two (GitNexus stdio + Graphify Starlette) — ⭐ **A**
- **Q34. Single UI?** A) **GitNexus Web UI + layers (code/docs/concepts), per-project** B) graphify static HTML separate — ⭐ **A**
- **Q35. EXTRACTED/INFERRED edge tagging?** A) **yes — fold into `{method, provenance, confidence}`; static outranks inferred on conflict** B) GitNexus confidence only — ⭐ **A**

---

## Clarifications I need (answer alongside — some are blockers)
- **C1. GitNexus authorship/commercial rights** — are you the **original author**, or is `vishalc412/GitNexus` a **fork of `abhigyanpatwari/GitNexus`**? PolyForm Noncommercial means a commercial tier needs the original author's grant. *(Blocks Q26.)*
- **C2. Clustering algorithm** — Louvain or Leiden in GitNexus actual? (Your research says Louvain; README said Leiden.)
- **C3. LadybugDB** — licensing/embeddability terms for a commercial tier confirmed?
- **C4. Target scale** — largest repo you must handle (files / LOC)? (UI warns >5000 nodes.)
- **C5. Deployment** — purely local per-dev MCP, or also a hosted/team server? (Drives auth/multi-tenant.)
- **C6. Resourcing** — solo or team? Python skills available for the offline worker? (Drives Q32 timing.)
- **C7. Brand/name** — keep "GitNexus", go "Nexus", or new name?
- **C8. Commercial intent** — is a paid tier actually a goal, or OSS-only? (If OSS-only, C1's risk softens.)

---

## Answer template (fill one row)
```
Q1:  Q2:  Q3:  Q4:  Q5:  Q6:  Q7:  Q8:  Q9:  Q10:
Q11: Q12: Q13: Q14: Q15: Q16: Q17: Q18: Q19: Q20:
Q21: Q22: Q23: Q24: Q25: Q26: Q27: Q28: Q29: Q30:
Q31: Q32: Q33: Q34: Q35:
C1:  C2:  C3:  C4:  C5:  C6:  C7:  C8:
```
Blank = accept ⭐ rec. Letter = override.
