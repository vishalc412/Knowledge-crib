/**
 * Source redaction policy — Foundation Task 6.
 *
 * A node may carry `meta.sourcePolicy` controlling how its on-disk text is surfaced (rehydrate) and
 * indexed (FTS body). The guarantee: a secret VALUE can never be returned by `rehydrate`/
 * `rehydrateBody` nor matched by the FTS body, while keys / structural placeholders remain so the
 * graph stays useful for a MuleSoft→Java migration analyst.
 *
 *   • `allow`              — no redaction (default).
 *   • `redact-properties`  — `.properties` files: keep keys, drop every value to `<redacted>`.
 *   • `redact-mule-secrets`— Mule XML config: redact `password`/`secret`/`token`/`credential`/
 *                            `private-key` attribute values, but keep `${placeholder}` / `secure::key`
 *                            references so the property key stays searchable.
 *   • `deny`               — encrypted/secure property files + key/trust stores: block the disk read
 *                            entirely. Nothing from the file body is surfaced or indexed.
 *
 * The extractor marks the FILE node's `meta.sourcePolicy` and every node emitted from a classified
 * file copies it; secure-property symbols omit spans. This module is pure (no I/O) so it is reused
 * by both the serving layer (source.ts) and the index builder (sqlite-index.ts).
 */
import type { Node } from '@knowledge-crib/soul-schema';

export type SourcePolicy = 'allow' | 'redact-properties' | 'redact-mule-secrets' | 'deny';

/**
 * Resolve a node's source policy. An explicit `meta.sourcePolicy` wins; absent that, a node whose
 * AST type is `property` (or flagged `meta.valueRedacted`) defaults to `redact-properties`.
 */
export function sourcePolicy(node: Node | undefined): SourcePolicy {
  const value = node?.meta?.sourcePolicy;
  if (value === 'deny' || value === 'redact-properties' || value === 'redact-mule-secrets') {
    return value;
  }
  // `meta.valueRedacted` is the EXPLICIT signal a config/properties extractor stamps on a key whose
  // value must never be surfaced (MuleExtractor sets it on every `property` symbol it emits).
  //
  // `type === 'property'` alone is NOT that signal: TypeScriptExtractor gives every class FIELD the
  // same type, so the old bare check ran `.properties`-style key=value redaction over ordinary
  // TypeScript source — mangling 206 nodes in this repo (and zero real config properties) both in
  // surfaced snippets and in the FTS body that makes them searchable. Every genuine config property
  // still redacts here via the explicit flag, so the "secret VALUE is never surfaced or indexed"
  // guarantee is unchanged.
  if (node?.meta?.valueRedacted === true) return 'redact-properties';
  return 'allow';
}

/**
 * Redact a `.properties` text block: keep keys (and structural position) but drop every value to
 * `<redacted>`. Comments (`#`/`!`) and blank lines are dropped entirely — they carry no searchable
 * structure and would only bloat the FTS body. A line without a `:`/`=` separator is treated as a
 * key with an empty value (`key=<redacted>`).
 */
export function redactPropertyText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return '';
      const at = line.search(/[:=]/);
      return at < 0 ? `${trimmed}=<redacted>` : `${line.slice(0, at).trim()}=<redacted>`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Redact secret attribute values in Mule XML config text while keeping placeholder references. An
 * attribute whose name matches `password|secret|token|credential|private-key` (case-insensitive) is
 * replaced by its placeholder when the value is a `${...}` or `secure::...` reference (so the
 * property key remains searchable), otherwise `<redacted>`. Non-secret attributes pass through.
 */
export function redactMuleSecretAttributes(text: string): string {
  const secret = /(password|secret|token|credential|private[-_]?key)/i;
  return text.replace(
    /([:\w.-]+)\s*=\s*(["'])(.*?)\2/g,
    (whole, name: string, quote: string, value: string) => {
      if (!secret.test(name)) return whole;
      const placeholder = value.match(/^\$\{([^}]+)\}$/)?.[1] ?? value.match(/^secure::(.+)$/)?.[1];
      return `${name}=${quote}${placeholder ? `\${${placeholder}}` : '<redacted>'}${quote}`;
    },
  );
}
