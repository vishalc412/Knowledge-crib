/**
 * Dossier serializer (Workstream E) — render a {@link Dossier} as deterministic Markdown so a human
 * (or an LLM agent consuming text) can read the deep reusable context without parsing JSON. The
 * persisted artifact is JSON (see {@link './persist.js'}); this renderer is the human/agent-facing
 * projection used by the `dossier` verb's `format: 'markdown'` option and by parity-harness reports.
 */
import type { Dossier } from './builder.js';

/**
 * Render a dossier as Markdown. Deterministic: fields are emitted in a fixed order so diffing two
 * dossiers (PL/SQL vs C# migrated) is a clean textual diff. Behavior-bearing 1.2 constructs
 * (raises / exception handlers / cursors) get their own sections — these are what make the analysis
 * detailed-level rather than a shallow skeleton.
 */
export function dossierToMarkdown(d: Dossier): string {
  const n = d.node;
  const lines: string[] = [];
  const h = (s: string): void => void lines.push(s);

  h(`# ${String(n.qualifiedName ?? n.name ?? d.id)}`);
  h('');
  h(`- kind: ${String(n.kind)}`);
  if (n.type) h(`- type: ${String(n.type)}`);
  if (n.lang) h(`- lang: ${String(n.lang)}`);
  if (n.file)
    h(
      `- file: ${String(n.file)}${n.span ? `:${String((n.span as { start: number }).start)}` : ''}`,
    );
  if (n.signature) h(`- signature: \`${String(n.signature)}\``);
  if (n.schema) h(`- schema: ${String(n.schema)}`);
  if (n.table) h(`- table: ${String(n.table)}`);
  if (n.dataType) h(`- dataType: ${String(n.dataType)}`);
  if (n.sqlKind) h(`- sqlKind: ${String(n.sqlKind)}`);
  if (n.expr) h(`- expr: \`${String(n.expr)}\``);
  if (n.errorCode) h(`- errorCode: ${String(n.errorCode)}`);
  if (n.errorMessage) h(`- errorMessage: ${String(n.errorMessage)}`);
  if (n.whenSelector) h(`- whenSelector: ${String(n.whenSelector)}`);
  if (n.assignTarget) h(`- assignTarget: ${String(n.assignTarget)}`);
  if (n.cursorQuery) h(`- cursorQuery: \`${String(n.cursorQuery)}\``);
  h('');

  // source body (embedded; paging honored — only the returned page is rendered)
  h('## Source');
  h('```');
  h(d.source.text || '(no source on disk)');
  h('```');
  if (d.source.truncated) {
    h(
      `_truncated — totalLines=${d.source.totalLines}, resume at line ${d.source.nextLine ?? '?'}_`,
    );
  }
  h('');

  if (d.callers.length > 0) {
    h('## Callers');
    for (const c of d.callers) h(`- ${label(c)} (confidence ${c.confidence})`);
    h('');
  }
  if (d.callees.length > 0) {
    h('## Callees');
    for (const c of d.callees) h(`- ${label(c)} (confidence ${c.confidence})`);
    h('');
  }

  if (d.rules && d.rules.rules.length > 0) {
    h('## Decision table');
    h(`_conditions: ${d.rules.conditions.length}; rules: ${d.rules.rules.length}_`);
    h('');
    h('| # | guard | branch | loop | exc | action | line | sql | reads | writes |');
    h('|---|-------|--------|------|-----|--------|------|-----|-------|--------|');
    d.rules.rules.forEach((r, i) => {
      const a = r.action;
      h(
        `| ${i + 1} | ${r.guard ?? '—'} | ${r.branch ?? '—'} | ${r.inLoop ? '✓' : ''} | ${
          r.inException ? '✓' : ''
        } | ${a.kind} | ${a.line ?? '—'} | ${a.sqlKind ?? '—'} | ${a.reads?.join(',') ?? ''} | ${
          a.writes?.join(',') ?? ''
        } |`,
      );
    });
    h('');
  }

  if (d.controlFlow) {
    const cf = d.controlFlow;
    if (cf.raises.length > 0) {
      h('## Raises');
      for (const r of cf.raises) {
        h(`- ${String(r.errorCode ?? '?')} ${String(r.errorMessage ?? '')} (@${loc(r)})`);
      }
      h('');
    }
    if (cf.handles.length > 0) {
      h('## Exception handlers');
      for (const x of cf.handles) h(`- WHEN ${String(x.whenSelector ?? '?')} (@${loc(x)})`);
      h('');
    }
    if (cf.iterates.length > 0) {
      h('## Iterates (cursors)');
      for (const c of cf.iterates) h(`- ${String(c.name ?? '?')} (@${loc(c)})`);
      h('');
    }
    if (cf.declares.length > 0) {
      h('## Declares');
      for (const c of cf.declares) {
        h(
          `- ${String(c.kind)} ${String(c.name ?? '?')} ${c.cursorQuery ? `\`${String(c.cursorQuery)}\`` : ''} (@${loc(c)})`,
        );
      }
      h('');
    }
  }

  if (d.docs.length > 0) {
    h('## Docs');
    for (const doc of d.docs) {
      h(`- ${doc.edgeType} (${doc.provenance}, ${doc.confidence}): ${doc.snippet}`);
    }
    h('');
  }

  return lines.join('\n');
}

function label(b: { qualifiedName?: string; name?: string; id: string }): string {
  return String(b.qualifiedName ?? b.name ?? b.id);
}

function loc(r: Record<string, unknown>): string {
  const span = r.span as { start?: number } | undefined;
  const file = r.file as string | undefined;
  return `${file ?? '?'}:${span?.start ?? '?'}`;
}
