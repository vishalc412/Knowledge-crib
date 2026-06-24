# Source Extraction: digitalapplied.com MCP Adoption Statistics 2026

URL: https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol
Publish date: April 20, 2026 (updated May 24, 2026)
Source quality: blog (aggregator that cites primary sources — Anthropic, MCP Registry API, GitHub API, Stacklok survey — and explicitly retracts unsourced claims; not original research itself)

## Extracted claims (bearing on research question part C: MCP ecosystem status & IDE sampling adoption)

1. CENTRAL — Client/host MCP support breadth: verified first-party MCP support in Claude/Claude Desktop, ChatGPT, Cursor, Google Gemini, Vertex AI Agent Builder, Microsoft Copilot Studio, GitHub, Vercel; Anthropic Dec 2025 list names "ChatGPT, Cursor, Gemini, Microsoft Copilot, Visual Studio Code, and other products."
2. CENTRAL — Spec defines sampling as a client capability: latest spec (2025-11-25) transports are stdio + Streamable HTTP (HTTP+SSE deprecated); client features include "sampling, roots, and elicitation." Supports the Knowledge-crib bet that sampling exists as an opt-in host-IDE capability — but does NOT prove every IDE implements it.
3. SUPPORTING — SDK scale: Anthropic Dec 2025 ecosystem update cites "97M+ Monthly SDK Downloads" across Python and TypeScript combined, and 10K+ active public servers. Supports TS SDK maturity (part C) but no separate TS-only figure.
4. SUPPORTING — Registry/GitHub ecosystem size: 9,652 records in official MCP registry, ~15,926 GitHub repos tagged mcp-server, modelcontextprotocol/servers repo 86,148 stars / 10,799 forks (May 24, 2026 snapshots). Tangential evidence of ecosystem maturity.
5. TANGENTIAL — Enterprise production adoption: Stacklok 2026 survey (n=100 senior tech leaders) → 41% in some production form (29% limited + 12% broad); software-industry cohort 45%. Note: article retracted an earlier "78% in production" claim as unsourced — demonstrates the blog self-corrects.

## Caveat for the parent research
The article confirms sampling is part of the MCP client spec and that the major agentic IDEs (Claude, Cursor, Copilot/VS Code) are MCP clients — but it does NOT independently verify which IDEs have actually implemented the sampling capability (only that they support MCP broadly). This distinction matters for the "MCP sampling capability support across IDEs" sub-question: cross-check with each IDE's own MCP docs.