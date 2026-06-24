/**
 * Enricher — optional, opt-in, and NEVER on the deterministic verb path.
 *
 * Research §4.1: MCP `sampling/createMessage` was deprecated (SEP-2577, protocol 2026-07-28), so
 * enrichment is designed around a DIRECT LLM provider API as the primary mechanism (env-configured
 * key), with a capability-gated sampling fallback kept only for the 12-month transition window and
 * marked deprecated. Outputs are tagged INFERRED and capped — they can never outrank EXTRACTED.
 *
 * This is a scaffold: it declares availability from the environment and exposes the operations
 * (cluster labels, NL→query, explanation summaries) the pipeline/verbs will call lazily at M7+.
 */
export type EnrichOp = 'cluster-label' | 'nl-query' | 'explanation-summary';

export interface EnricherConfig {
  /** provider api key; when absent, the enricher is unavailable and all ops no-op. */
  apiKey?: string;
  provider?: 'anthropic' | 'openai';
  model?: string;
  /** capability-gated deprecated fallback: only if the host declares sampling support. */
  samplingFallback?: boolean;
}

export class Enricher {
  constructor(private readonly config: EnricherConfig = {}) {}

  /** True iff a direct provider key is configured (the primary, non-deprecated path). */
  available(): boolean {
    return Boolean(this.config.apiKey);
  }

  /**
   * Enrich via the direct provider API. Returns undefined when unavailable (graceful degrade) — the
   * deterministic core continues without it. Real provider calls are wired at M7; the contract and
   * gating live here now so nothing on the hot path ever reaches for an LLM.
   */
  async enrich(_op: EnrichOp, _input: string): Promise<string | undefined> {
    if (!this.available()) return undefined;
    throw new Error('Enricher provider call is not wired until M7 (cluster labels / NL→query).');
  }
}

/** Build an Enricher from environment variables (KCRIB_LLM_API_KEY / KCRIB_LLM_PROVIDER / _MODEL). */
export function enricherFromEnv(env: NodeJS.ProcessEnv = process.env): Enricher {
  const cfg: EnricherConfig = {};
  if (env.KCRIB_LLM_API_KEY) cfg.apiKey = env.KCRIB_LLM_API_KEY;
  if (env.KCRIB_LLM_PROVIDER === 'anthropic' || env.KCRIB_LLM_PROVIDER === 'openai') {
    cfg.provider = env.KCRIB_LLM_PROVIDER;
  }
  if (env.KCRIB_LLM_MODEL) cfg.model = env.KCRIB_LLM_MODEL;
  return new Enricher(cfg);
}
