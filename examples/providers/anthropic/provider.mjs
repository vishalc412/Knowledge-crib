#!/usr/bin/env node
/**
 * A REFERENCE enrichment provider for `crib enrich run --provider`.
 *
 * Why this file exists as an EXAMPLE rather than as a shipped feature. The crib server deliberately
 * makes no model calls — that is what keeps it provider-neutral and offline by default — so the
 * headless enrichment path spawns a program the operator owns, configured in `~/.crib/providers.json`
 * (never in the repo, so a committed file can never smuggle a `command`). The consequence was that
 * the entire semantic layer was unreachable to anyone unwilling to write an LLM integration from
 * scratch: on a fresh index of the crib's own repository, 3,826 targets were pending and 0 were
 * fresh. This closes that gap without moving a model client into the server: it is a worked example
 * you copy, read, and point a provider entry at.
 *
 * THE PROTOCOL, which is the part worth copying if you write your own:
 *   • ONE work item per invocation, as JSON on stdin.
 *   • The whole of stdout must parse as ONE JSON object. Anything else — a log line, a banner, a
 *     stray newline before the brace — is a per-item failure. Every diagnostic here goes to stderr.
 *   • A non-zero exit, a timeout, malformed JSON, or a shape mismatch leaves the target PENDING and
 *     resumable. Failing is safe; failing quietly with a plausible-but-wrong payload is not, which is
 *     why the checks below refuse rather than repair.
 *   • `crib enrich save` re-validates everything on receipt and re-grounds every evidence quote
 *     against the real source. A provider cannot talk its way past that, so do not try: emit what the
 *     model actually produced, and let the grounding gate drop what it cannot verify.
 *
 * Setup:
 *   npm install @anthropic-ai/sdk
 *   export ANTHROPIC_API_KEY=...            # or run `ant auth login` and set nothing
 *   # ~/.crib/providers.json:
 *   { "providers": { "anthropic": { "command": ["node", "/abs/path/to/provider.mjs"] } } }
 *
 *   crib enrich run --provider anthropic --max-batches 1     # start small; see the README
 *
 * COST IS REAL AND IT IS PER TARGET. One call per work item, and a full repository has thousands.
 * Run `crib enrich --scopes` first to see the count, start with `--max-batches 1`, and read the cost
 * note in the README before turning this loose on a large tree.
 */
/**
 * The SDK is imported LAZILY, for two reasons. A bare top-level import fails with a raw
 * `ERR_MODULE_NOT_FOUND` stack before this file can say what to install — poor for a file whose
 * entire purpose is removing setup friction. And deferring it lets the protocol checks below (stdin
 * parsing, work-item shape) run and be tested without the SDK present at all.
 */
async function loadSdk() {
  try {
    return (await import('@anthropic-ai/sdk')).default;
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      fail('@anthropic-ai/sdk is not installed — run `npm install @anthropic-ai/sdk`');
    }
    fail(`could not load @anthropic-ai/sdk: ${e?.message ?? String(e)}`);
  }
}

/** Read all of stdin. The work item arrives as one JSON object. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Extract the first balanced top-level JSON object from a model response.
 *
 * The output contract is strict JSON, but a model may still wrap it in prose or a fenced block. This
 * scans for a balanced `{...}` while respecting string literals and escapes — a naive
 * `indexOf('{')`/`lastIndexOf('}')` slice breaks on a brace inside a quoted string, which analysis
 * prose contains routinely. Returns null when there is no balanced object, and the caller then FAILS
 * rather than guessing: a half-parsed analysis is worse than a pending target.
 */
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function fail(message) {
  process.stderr.write(`provider error: ${message}\n`);
  process.exit(1);
}

const raw = await readStdin();
let item;
try {
  item = JSON.parse(raw);
} catch (e) {
  fail(`work item on stdin is not valid JSON: ${e.message}`);
}
if (!item?.targetId || typeof item.instructions !== 'string') {
  fail('work item is missing targetId or instructions');
}

const Anthropic = await loadSdk();
const client = new Anthropic();

/**
 * The prompt is assembled from the work item, not authored here.
 *
 * `instructions`, `outputSchema`, `seed` and `lowerLayer` are produced by crib's enrichment planner,
 * which knows the layer being authored (symbol → file → cluster → system) and what grounded evidence
 * that layer is allowed to see. A provider that substitutes its own instructions is answering a
 * different question than the one the queue asked, and its output will be rejected by the save gate
 * or — worse — accepted while describing the wrong target. So: pass them through verbatim.
 */
const prompt = [
  item.instructions,
  '',
  'GROUNDED SEED (the only facts you may rely on — do not invent code, names, or behaviour):',
  JSON.stringify(item.seed ?? {}, null, 2),
  '',
  'LOWER-LAYER ANALYSIS (already authored for the layers beneath this target):',
  JSON.stringify(item.lowerLayer ?? {}, null, 2),
  '',
  'Reply with ONE JSON object and nothing else — no prose, no markdown fence — matching this schema:',
  JSON.stringify(item.outputSchema ?? {}, null, 2),
  '',
  'Every quote in `evidence` must be copied EXACTLY from the seed above. Crib re-grounds each quote',
  'against the real source file and silently drops any that does not match, so an approximated or',
  'reflowed quote is a quote you have thrown away. Prefer fewer exact quotes to more loose ones.',
].join('\n');

let message;
try {
  // Streaming because enrichment output is large and structured; a non-streaming call at this
  // max_tokens risks an HTTP timeout. `finalMessage()` gives the assembled result.
  //
  // `fallbacks` is on by default per Anthropic's guidance for Opus-5-class models: a policy decline
  // would otherwise end the turn with no output, which here means a permanently stuck target. A
  // decline before output is not billed; the rescue bills at the fallback model's own rate.
  const stream = client.beta.messages.stream({
    model: 'claude-opus-5',
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-06-01'],
    fallbacks: [{ model: 'claude-opus-4-8' }],
    // Adaptive thinking: authoring a grounded architectural summary is exactly the kind of work that
    // benefits, and `budget_tokens` is rejected on this model family.
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });
  message = await stream.finalMessage();
} catch (e) {
  // Typed SDK errors, most specific first. A rate limit or a 5xx is worth retrying at the QUEUE
  // level (the target stays pending, so the next `crib enrich run` re-offers it); a 400 or 401 is
  // not, and saying which is which in stderr is the difference between a fixable run and a mystery.
  if (e instanceof Anthropic.AuthenticationError) {
    fail('authentication failed — set ANTHROPIC_API_KEY or run `ant auth login`');
  } else if (e instanceof Anthropic.RateLimitError) {
    fail('rate limited — lower --concurrency or retry; this target stays pending');
  } else if (e instanceof Anthropic.BadRequestError) {
    fail(`request rejected: ${e.message}`);
  } else if (e instanceof Anthropic.APIError) {
    fail(`API error ${e.status}: ${e.message}`);
  }
  fail(`unexpected failure: ${e?.message ?? String(e)}`);
}

// A refusal is HTTP 200 with no usable content. Check it BEFORE reading content, or the JSON scan
// below reports "no JSON object" and hides the real reason.
if (message.stop_reason === 'refusal') {
  fail(
    `model declined this target (${message.stop_details?.category ?? 'unspecified'}) — left pending`,
  );
}
if (message.stop_reason === 'max_tokens') {
  fail('response hit max_tokens and is truncated — left pending rather than saved half-formed');
}

const text = message.content
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('');
const jsonText = extractJsonObject(text);
if (jsonText === null) fail('model response contained no balanced JSON object');

let authored;
try {
  authored = JSON.parse(jsonText);
} catch (e) {
  fail(`model response was not valid JSON: ${e.message}`);
}

// Shape guard. crib's save gate checks this too, but failing HERE names the provider as the culprit
// instead of surfacing as an opaque rejection one layer up.
if (!authored || typeof authored !== 'object') fail('model response is not a JSON object');
if (!authored.analysis) fail('model response is missing `analysis`');

/**
 * The `targetId` is taken from the WORK ITEM, never from the model.
 *
 * `runProviderOnce` checks that the returned id matches the id it dispatched, so a model that echoes
 * a different target — easy when the seed mentions several symbols — would fail the item. Using the
 * dispatched id makes that class of mismatch impossible instead of merely detected.
 */
const out = {
  targetId: item.targetId,
  model: message.model,
  analysis: authored.analysis,
  graph: {
    nodes: authored.graph?.nodes ?? [],
    edges: authored.graph?.edges ?? [],
  },
  evidence: authored.evidence ?? [],
};

// stdout is the protocol: one JSON object, nothing else.
process.stdout.write(JSON.stringify(out));
