# Adversarial Claim Verification — voter 1/3

## Claim
Spantree tree-sitter-cobol-enterprise parses fixed-form IBM Enterprise COBOL across all four divisions; surfaces named fields for CICS/SQL embedded blocks (DATASET, INTO, FROM, RESP), COPY/REPLACE, REDEFINES, level-number data, PIC clauses (incl. COMP-3/packed decimal), nested programs, CALL statements as typed AST nodes.

## Verification result: NOT REFUTED (medium confidence)

### Checklist
1. Supported by quote? Yes — README directly states all four divisions, EXEC CICS typed nodes with DATASET/INTO/FROM/RESP (+RIDFLD), EXEC SQL typed nodes, COPY/REPLACE, REDEFINES, level-number data, PIC incl. COMP-3/packed decimal, nested programs, CALL statements.
2. Contradicting evidence? None found. proleap-cobol-parser (ANTLR4) treats EXEC blocks as opaque preprocessed text — actually *confirms* Spantree's differentiator (typed CICS/SQL nodes) is real/novel.
3. Source quality: primary source (the repo's own README). Matches claim strength for a feature-coverage claim.
4. Outdated? No — created 2026-03-01, current.
5. Marketing fluff? No — technical README with explicit limitations section.

### Caveats (why medium, not high)
- Repo is brand-new: 0 stars, 9 open issues, low visibility.
- NIST COBOL 85 clean-parse = 6.3%; legacy enterprise = 62.9%; z Open Editor = 66.7%. Only CardDemo hits 98.5%. So "parses across all four divisions" is reliable for the targeted enterprise-z/OS dialect but NOT universally robust.
- Minor imprecision: the named fields DATASET/INTO/FROM/RESP are CICS-specific; README only promises "EXEC SQL statements as typed AST nodes" without naming SQL fields. Claim's "CICS/SQL ... (DATASET, INTO, FROM, RESP)" conflates the two slightly.

### Conclusion
Claim accurately reflects the primary source's stated feature coverage. Not overreach for the scoped dialect. The mixed parse-success rates qualify reliability but do not refute the feature-coverage assertion.