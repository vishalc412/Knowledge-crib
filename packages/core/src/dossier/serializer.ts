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

  // TOP BANNER (Phase 1 — impossible to miss): when a callable's body is unavailable or fidelity is
  // partial, say so BEFORE anything else, so an LLM building a migration plan gates on it instead of
  // back-filling the gap with assumptions. This is the single most important honesty signal.
  if (d.coverage) {
    if (d.coverage.readiness === 'unimplemented') {
      h(
        '> ⛔ **ANALYSIS BLOCKED — body unavailable.** This callable has no indexed body statements; ' +
          'its behavior, scoring formulas, and migration logic are NOT in this graph. Locate and index ' +
          'the implementation (e.g. the PL/SQL package body) before planning any change against it.',
      );
      h('');
    } else if (d.coverage.readiness === 'partial') {
      h(`> ⚠ **PARTIAL FIDELITY.** ${d.coverage.caveats.join(' ')}`);
      h('');
    }
  }

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
  // framework-semantics 1.3 identity — the handler's own route verb/path + the symbol's framework role.
  if (n.framework) h(`- framework: ${String(n.framework)}`);
  if (n.stereotype) h(`- stereotype: ${String(n.stereotype)}`);
  if (n.httpMethod) h(`- httpMethod: ${String(n.httpMethod)}`);
  if (n.routePath) h(`- routePath: ${String(n.routePath)}`);
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

  // implementation completeness — the LOUD "body missing" signal. When unimplemented, the decision
  // table + control-flow sections below are necessarily empty; this section says why, so an analyst
  // never mistakes a spec-only skeleton for a complete analysis.
  if (d.implementation) {
    h('## Implementation status');
    if (d.implementation.status === 'implemented') {
      h(`Implemented — ${d.implementation.executesCount} body statement(s) indexed.`);
    } else {
      h(
        '⚠ **Unimplemented** — no body statements found for this callable. The implementation may ' +
          'live in a missing file (e.g. a PL/SQL package body) or be a spec-only declaration. ' +
          'Decision-table / control-flow fields are unavailable; locate the body before relying on ' +
          'behavior here.',
      );
    }
    if (d.implementation.referencedByFiles.length > 0) {
      h(
        `Referenced from ${d.implementation.referencedByFiles.length} file(s): ${d.implementation.referencedByFiles.join(', ')}`,
      );
    } else if (d.implementation.status === 'unimplemented') {
      h('Not referenced by any indexed callable.');
    }
    h('');
  }

  // Coverage self-report (Phase 4) — the 360° inventory of what the graph knows about this callable,
  // so the reader sees fidelity at a glance instead of inferring it from the presence/absence of
  // later sections.
  if (d.coverage) {
    const c = d.coverage;
    h('## Coverage');
    h(`- readiness: **${c.readiness}**`);
    h(
      `- body statements: ${c.executes} · assignments: ${c.assignments} · conditions: ${c.conditions} · case-branches: ${c.caseBranches}`,
    );
    h(`- raises: ${c.raises} · handlers: ${c.handlers} · cursors: ${c.cursors}`);
    h(
      `- calls: ${c.calls.resolved} resolved / ${c.calls.recorded} recorded / ${c.calls.unresolved} unresolved${c.recursive ? ' · recursive' : ''}`,
    );
    if (c.exprTruncated > 0)
      h(`- ⚠ ${c.exprTruncated} clipped expression(s) — rehydrate source for verbatim text`);
    for (const cav of c.caveats) h(`- caveat: ${cav}`);
    h('');
  }

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

  // Framework-semantics 1.3 — the resolved framework relationships. The method-scoped persisted
  // dossier carries only the LEAN subset (Routes + Produces the callable owns); the context verb
  // carries the full set (Dependencies/Dependents/Relations/Renders via member-of aggregation for a
  // class). Fixed order Routes → Produces → Dependencies → Dependents → Relations → Renders; each
  // subsection emitted ONLY when its array is non-empty (mirrors the Callers/Callees conditional style).
  // Routes + Relations render as deterministic tables (diff-friendly for the parity harness); the
  // rest as bullets. Unresolved entries carry a `⚠ unresolved` marker (parity with coverage caveats).
  if (d.framework) {
    const f = d.framework;
    if (f.routes && f.routes.length > 0) {
      h('## Routes');
      h('| # | verb | path | params | security | handler |');
      h('|---|------|------|--------|----------|---------|');
      f.routes.forEach((r, i) => {
        const params =
          (r.params ?? [])
            .map((p) => `${p.name}${p.type ? `:${p.type}` : ''}@${p.in}`)
            .join(', ') || '—';
        const sec =
          r.security && Object.keys(r.security).length > 0
            ? Object.entries(r.security)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(', ')
            : '—';
        const handler = r.handler ? label(r.handler) : '—';
        h(
          `| ${i + 1} | ${r.httpMethod ?? (r.unresolved ? '⚠' : '—')} | ${
            r.routePath ?? r.name ?? (r.unresolved ? '⚠ unresolved' : '—')
          } | ${params} | ${sec} | ${handler} |`,
        );
      });
      h('');
    }
    if (f.produces && f.produces.length > 0) {
      h('## Produces');
      for (const p of f.produces) {
        const rt = [p.returnType, p.returnElementType].filter(Boolean).join('<');
        h(
          `- ${label(p.brief)}${rt ? ` (returns ${rt})` : ''}${
            p.producer ? ` — declared by ${label(p.producer)}` : ''
          }${p.unresolved ? ' ⚠ unresolved' : ''} (confidence ${p.confidence})`,
        );
      }
      h('');
    }
    if (f.dependencies && f.dependencies.length > 0) {
      h('## Dependencies');
      for (const dep of f.dependencies) {
        h(
          `- [${dep.kind}] ${label(dep.brief)}${
            dep.injectedAs ? ` (as ${dep.injectedAs})` : ''
          }${dep.producer ? ` — supplied by ${label(dep.producer)}` : ''}${
            dep.unresolved ? ' ⚠ unresolved' : ''
          } (confidence ${dep.confidence})`,
        );
      }
      h('');
    }
    if (f.dependents && f.dependents.length > 0) {
      h('## Dependents');
      for (const dep of f.dependents) {
        h(
          `- ${label(dep.brief)}${dep.injectedAs ? ` (as ${dep.injectedAs})` : ''} (confidence ${
            dep.confidence
          })`,
        );
      }
      h('');
    }
    if (f.relations && f.relations.length > 0) {
      h('## Relations');
      h('| # | field | type | cardinality | cascade | fetch | mappedBy | orphanRemoval |');
      h('|---|-------|------|------------|--------|-------|---------|--------------|');
      f.relations.forEach((r, i) => {
        h(
          `| ${i + 1} | ${r.field ?? '—'} | ${label(r.brief)} | ${
            r.cardinality ?? '—'
          } | ${r.cascade ?? '—'} | ${r.fetch ?? '—'} | ${r.mappedBy ?? '—'} | ${
            r.orphanRemoval ?? '—'
          } |`,
        );
      });
      h('');
    }
    if (f.renders && f.renders.length > 0) {
      h('## Renders');
      for (const r of f.renders) {
        h(
          `- ${label(r.brief)}${r.framework ? ` (${r.framework})` : ''} (confidence ${r.confidence})`,
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
