/**
 * Hand-curated conceptual golden packs for the M1.1 eval harness.
 *
 * These are the ~100-conceptual-query set the plan calls for, started here at a representative
 * baseline (~4 per language × 9 fixture repos) and structured to extend. Each entry is a
 * natural-language retrieval question a real agent would ask, pinned to expected symbols by
 * NAME (resolved to concrete node ids at runtime by the harness — see harness.mjs
 * `resolveExpected`). Name-matching (not hardcoded ids) keeps the pack stable across re-indexes
 * and line-number drift; the harness resolves case-insensitively and supports an optional
 * `qualified` substring for disambiguation.
 *
 * Themes mirror the fixture repos (auth guards, behavior/decision, the loan rule engine, and
 * constants) so the conceptual set exercises the same cross-language parity the mechanical
 * seeders cover, but from a semantic-retrieval angle (plain questions, not qualifiedName lookups).
 */

export const CONCEPTUAL_PACKS = [
  // --- plsql: the canonical loan rule engine (M10/M12 golden) ---
  {
    lang: 'plsql',
    question: 'how is a loan application assessed',
    match: { name: 'assess_application' },
  },
  {
    lang: 'plsql',
    question: 'what procedure rejects a high-risk loan',
    match: { name: 'assess_application' },
  },
  {
    lang: 'plsql',
    question: 'how is an insurance claim validated',
    match: { name: 'validate_claim' },
  },
  { lang: 'plsql', question: 'how is a claim processed', match: { name: 'process_claim' } },
  {
    lang: 'plsql',
    question: 'where are the auto-approve and auto-reject thresholds defined',
    match: { name: 'evaluate' },
  },

  // --- csharp: the parallel loan rule engine + auth + behavior ---
  {
    lang: 'csharp',
    question: 'how does the rule engine assess a loan application',
    match: { name: 'AssessApplication' },
  },
  { lang: 'csharp', question: 'what classifies a loan decision', match: { name: 'Classify' } },
  { lang: 'csharp', question: 'where is the login request validated', match: { name: 'Validate' } },
  {
    lang: 'csharp',
    question: 'what approves or rejects a guarded request',
    match: { name: 'Decide' },
  },

  // --- java: Spring auth + Guarded/Behavior decision ---
  {
    lang: 'java',
    question: 'where is the auth token validated',
    match: { name: 'validate', qualified: 'AuthController' },
  },
  {
    lang: 'java',
    question: 'what decides a guarded action',
    match: { name: 'decide', qualified: 'Guarded' },
  },
  {
    lang: 'java',
    question: 'what handles a multi-way behavior decision',
    match: { name: 'multi' },
  },
  {
    lang: 'java',
    question: 'which controller method issues a token',
    match: { name: 'issue', qualified: 'AuthController' },
  },

  // --- go: auth guard + deep guard + generics ---
  { lang: 'go', question: 'where is the login validated', match: { name: 'Validate' } },
  { lang: 'go', question: 'what is the deep guard check', match: { name: 'deepGuard' } },
  { lang: 'go', question: 'how does the classifier route a value', match: { name: 'classify' } },
  { lang: 'go', question: 'what pushes onto the generic stack', match: { name: 'Push' } },

  // --- python: rules/grade + behavior + decorators ---
  {
    lang: 'python',
    question: 'how does the grade function decide honors',
    match: { name: 'grade' },
  },
  { lang: 'python', question: 'how is a value classified', match: { name: 'classify' } },
  { lang: 'python', question: 'how does process handle an exception', match: { name: 'process' } },
  { lang: 'python', question: 'which function issues an auth token', match: { name: 'issue' } },

  // --- rust: authorize/validate + behavior match ---
  { lang: 'rust', question: 'how is a request authorized', match: { name: 'authorize' } },
  { lang: 'rust', question: 'where is the token validated', match: { name: 'validate' } },
  { lang: 'rust', question: 'how is a label produced from a value', match: { name: 'mk_label' } },
  { lang: 'rust', question: 'what grants access', match: { name: 'grant' } },

  // --- ts: the rules.ts approve/review/deny flow ---
  { lang: 'ts', question: 'what approves a loan request', match: { name: 'approve' } },
  { lang: 'ts', question: 'what denies a loan request', match: { name: 'deny' } },
  { lang: 'ts', question: 'what reviews a loan request', match: { name: 'review' } },
  { lang: 'ts', question: 'how is a token made', match: { name: 'makeToken' } },

  // --- ts-min: the known call-graph golden (M2/M3) ---
  { lang: 'ts-min', question: 'how does login authenticate', match: { name: 'login' } },
  { lang: 'ts-min', question: 'what issues a session token', match: { name: 'issue' } },
  { lang: 'ts-min', question: 'how is a session created', match: { name: 'makeSession' } },

  // --- php: password hashing + verify (tree-sitter extractor) ---
  { lang: 'php', question: 'how is a password hashed', match: { name: 'hashPassword' } },
  { lang: 'php', question: 'how is a password verified', match: { name: 'verifyPassword' } },
  { lang: 'php', question: 'what issues an auth token', match: { name: 'issueToken' } },
  { lang: 'php', question: 'how does login work', match: { name: 'login' } },
];
