/**
 * Source rehydration — text is referenced (file + span) in the lean soul, never copied, so verbs and
 * the dossier builder read the source on demand. This module lives in core (not mcp) so the persisted
 * dossier builder can embed the rehydrated body into a self-contained artifact without a dependency
 * on the serving layer.
 *
 * Two depths:
 *   • {@link rehydrate} — the first non-blank line of the span (≤160 chars). Cheap; list views.
 *   • {@link rehydrateBody} — the FULL span text, char/line-budgeted with a `truncated` flag and
 *     line-offset paging (`startLine` + `nextLine` cursor). Used by `context`/`source`/`dossier`
 *     when an agent needs the actual code body / DDL / statement, not just the header. This is what
 *     turns crib from "high-level only" into deep low-level code context — for every language, since
 *     rehydration is span-only and language-agnostic.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
import { redactMuleSecretAttributes, redactPropertyText, sourcePolicy } from './source-policy.js';

export { redactMuleSecretAttributes, redactPropertyText, sourcePolicy };
export type { SourcePolicy } from './source-policy.js';

const MAX_SNIPPET = 160;

/** Default budget for full-body rehydration — generous enough for most procs/DDL, bounded so an
 * agent never pulls an unbounded payload. Tunable per call via {@link RehydrateBodyOpts}. */
export const DEFAULT_BODY_MAX_CHARS = 4000;
export const DEFAULT_BODY_MAX_LINES = 200;

/** A rehydrated full span. `truncated` is true iff the source span exceeded the char OR line budget. */
export interface RehydratedBody {
  /** the span text (lines joined by `\n`), capped to the budgets */
  text: string;
  /** true iff the on-disk span was longer than what was returned */
  truncated: boolean;
  /** number of lines in the on-disk span (the whole span, before any paging/capping) */
  totalLines: number;
  /** absolute (1-based) file line of the first line in `text` — the page window start. */
  startLine: number;
  /** absolute file line to fetch on the next page when `truncated` and more span lines remain after
   *  this page; absent when the page reached the span end. Pass it back as `startLine` to continue. */
  nextLine?: number;
}

/** First non-blank line of `node`'s span, trimmed to MAX_SNIPPET chars; '' if unavailable. */
export function rehydrate(repoRoot: string, node: Node | undefined): string {
  if (!node?.file || !node.span) return '';
  // deny blocks the disk read entirely — a secure/encrypted file is never surfaced.
  if (sourcePolicy(node) === 'deny') return '';
  try {
    const lines = readFileSync(join(repoRoot, node.file), 'utf8').split('\n');
    for (let i = node.span.start - 1; i < node.span.end && i < lines.length; i++) {
      const line = (lines[i] ?? '').trim().replace(/^#+\s*/, '');
      if (line.length > 0) return redactSnippet(node, line).slice(0, MAX_SNIPPET);
    }
  } catch {
    // fall through
  }
  return '';
}

/** Apply the node's redaction policy to a single in-span line (used by the cheap snippet view). */
function redactSnippet(node: Node, line: string): string {
  switch (sourcePolicy(node)) {
    case 'redact-properties': {
      // redactPropertyText drops comments + blank lines; a single non-comment line yields its key.
      const r = redactPropertyText(line);
      return r.length > 0 ? r : line;
    }
    case 'redact-mule-secrets':
      return redactMuleSecretAttributes(line);
    default:
      return line;
  }
}

/**
 * Full source text of `node`'s span, capped at `maxChars` / `maxLines`, with line-offset paging.
 * Returns '' with `truncated:false` when the node has no file/span or the file is unreadable. The
 * cap is honest: `truncated` reflects the on-disk span, not the post-trim string, so an agent knows
 * to page. `startLine` (1-based absolute file line, default = span start) opens a page window; when
 * that window does not reach the span end, `nextLine` carries the absolute line to resume at — pass
 * it back as `startLine` on the next call to page through a body too large for one round-trip.
 */
export function rehydrateBody(
  repoRoot: string,
  node: Node | undefined,
  opts: {
    maxChars?: number;
    maxLines?: number;
    startLine?: number;
    readLines?: (file: string) => string[] | undefined;
  } = {},
): RehydratedBody {
  const empty: RehydratedBody = { text: '', truncated: false, totalLines: 0, startLine: 0 };
  if (!node?.file || !node.span) return empty;
  // deny blocks the disk read entirely — a secure/encrypted file body is never surfaced.
  if (sourcePolicy(node) === 'deny') return empty;
  const maxChars = opts.maxChars ?? DEFAULT_BODY_MAX_CHARS;
  const maxLines = opts.maxLines ?? DEFAULT_BODY_MAX_LINES;
  const spanStart = node.span.start;
  const spanEnd = node.span.end;
  // page window start (1-based absolute), clamped into the span
  const winStart = Math.min(Math.max(opts.startLine ?? spanStart, spanStart), spanEnd);
  try {
    // When an injected reader is supplied (used by the index builder's file cache to avoid
    // re-reading the same file once per node), use it; otherwise read from disk directly.
    const lines = opts.readLines
      ? (opts.readLines(node.file) ?? [])
      : readFileSync(join(repoRoot, node.file), 'utf8').split('\n');
    const totalLines = spanEnd - spanStart + 1; // whole on-disk span, independent of paging
    // window end (1-based inclusive), bounded by the span end AND the line budget
    const winEnd = Math.min(winStart + maxLines - 1, spanEnd);
    const slice = lines.slice(winStart - 1, winEnd); // 0-based [winStart-1, winEnd)
    if (slice.length === 0) {
      return { text: '', truncated: false, totalLines, startLine: winStart };
    }

    let text = slice.join('\n');
    // Apply the node's redaction policy before any budgeting so a secret VALUE never surfaces.
    // `redact-properties` may drop comment/blank lines (fewer lines than the raw slice); recompute
    // linesReturned from the redacted text so paging stays consistent with what was returned.
    switch (sourcePolicy(node)) {
      case 'redact-properties':
        text = redactPropertyText(text);
        break;
      case 'redact-mule-secrets':
        text = redactMuleSecretAttributes(text);
        break;
    }
    let truncated = winEnd < spanEnd; // more span lines lie beyond this page window
    let linesReturned = text.length > 0 ? text.split('\n').length : 0;
    if (text.length > maxChars) {
      // char budget cuts within the window — trim at a line boundary so `nextLine` lands cleanly,
      // unless even the first line exceeds the budget (then return the capped fragment of it).
      const cut = text.slice(0, maxChars);
      const lastNl = cut.lastIndexOf('\n');
      if (lastNl > 0) {
        text = cut.slice(0, lastNl);
        linesReturned = text.split('\n').length;
      } else {
        text = cut;
        linesReturned = 1;
      }
      truncated = true;
    }
    // nextLine: the absolute line after the last returned line, when more span remains to page.
    let nextLine: number | undefined;
    const lastReturnedAbs = winStart + linesReturned - 1;
    if (truncated && lastReturnedAbs < spanEnd) {
      nextLine = lastReturnedAbs + 1;
    }
    return {
      text,
      truncated,
      totalLines,
      startLine: winStart,
      ...(nextLine !== undefined ? { nextLine } : {}),
    };
  } catch {
    return empty;
  }
}
