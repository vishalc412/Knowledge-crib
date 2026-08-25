import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Cross-language coverage + fidelity parity (Phase 3 — the keystone).
 *
 * The crib's promise is "trust the graph for ANY language, not just PL/SQL". This test proves it:
 * the SAME loan-scoring logic, written in all 7 supported languages, must produce the SAME classes
 * of behavior nodes (a guard condition, a formula-bearing assignment, a raise/throw) AND the SAME
 * coverage self-report — and crucially must capture the SCORING FORMULA verbatim (the Phase 2
 * full-fidelity expression win that closes the gap a graph-only plan had vs. a direct-source read).
 *
 * Each fixture is the minimal faithful port of:
 *   assess(amount, score):
 *     if amount > 50000 AND score < 700:
 *       risk = amount * 0.4 + score * 0.6      // the formula — must survive verbatim into `expr`
 *       raise / throw / panic "high risk"
 *
 * If a language fails to emit one of these, that is a REAL parity gap surfaced here (not hidden).
 */
import { SoulStore, computeCoverage, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, Node, NodeKind } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CsharpExtractor } from './csharp/CsharpExtractor.js';
import { GoExtractor } from './go/GoExtractor.js';
import { JavaExtractor } from './java/JavaExtractor.js';
import { PlSqlExtractor } from './plsql/PlSqlExtractor.js';
import { PythonExtractor } from './python/PythonExtractor.js';
import { RustExtractor } from './rust/RustExtractor.js';
import { TypeScriptExtractor } from './ts/TypeScriptExtractor.js';
import type { ExtractCtx, Extractor } from './types.js';

interface Case {
  lang: string;
  path: string;
  extractor: () => Extractor;
  source: string;
  /** the simple name of the callable to score. */
  proc: string;
}

const CASES: Case[] = [
  {
    lang: 'plsql',
    path: 'scoring.pkb',
    extractor: () => new PlSqlExtractor(),
    proc: 'assess',
    source: `CREATE OR REPLACE PACKAGE BODY scoring IS
  PROCEDURE assess(p_amount NUMBER, p_score NUMBER) IS
    v_risk NUMBER;
  BEGIN
    IF p_amount > 50000 AND p_score < 700 THEN
      v_risk := p_amount * 0.4 + p_score * 0.6;
      RAISE_APPLICATION_ERROR(-20001, 'high risk');
    END IF;
  END assess;
END scoring;
`,
  },
  {
    lang: 'csharp',
    path: 'Scoring.cs',
    extractor: () => new CsharpExtractor(),
    proc: 'Assess',
    source: `namespace Scoring {
  class Engine {
    public void Assess(double amount, double score) {
      double risk;
      if (amount > 50000 && score < 700) {
        risk = amount * 0.4 + score * 0.6;
        throw new System.InvalidOperationException("high risk");
      }
    }
  }
}
`,
  },
  {
    lang: 'java',
    path: 'Engine.java',
    extractor: () => new JavaExtractor(),
    proc: 'assess',
    source: `class Engine {
  void assess(double amount, double score) {
    double risk;
    if (amount > 50000 && score < 700) {
      risk = amount * 0.4 + score * 0.6;
      throw new IllegalStateException("high risk");
    }
  }
}
`,
  },
  {
    lang: 'go',
    path: 'scoring.go',
    extractor: () => new GoExtractor(),
    proc: 'Assess',
    source: `package scoring

func Assess(amount float64, score float64) {
	var risk float64
	if amount > 50000 && score < 700 {
		risk = amount*0.4 + score*0.6
		panic("high risk")
	}
	_ = risk
}
`,
  },
  {
    lang: 'rust',
    path: 'scoring.rs',
    extractor: () => new RustExtractor(),
    proc: 'assess',
    source: `fn assess(amount: f64, score: f64) {
    let risk;
    if amount > 50000.0 && score < 700.0 {
        risk = amount * 0.4 + score * 0.6;
        panic!("high risk");
    }
}
`,
  },
  {
    lang: 'python',
    path: 'scoring.py',
    extractor: () => new PythonExtractor(),
    proc: 'assess',
    source: `def assess(amount, score):
    if amount > 50000 and score < 700:
        risk = amount * 0.4 + score * 0.6
        raise ValueError("high risk")
`,
  },
  {
    lang: 'typescript',
    path: 'scoring.ts',
    extractor: () => new TypeScriptExtractor(),
    proc: 'assess',
    source: `function assess(amount: number, score: number): void {
  let risk: number;
  if (amount > 50000 && score < 700) {
    risk = amount * 0.4 + score * 0.6;
    throw new Error("high risk");
  }
}
`,
  },
  {
    // M2.5 — plain JS parity. The same TS extractor (ScriptKind.JS) must admit `.js` and emit the
    // SAME condition + formula-assignment + raise behavior nodes a `.ts` file would, tagged
    // `lang: 'javascript'`. This is the fidelity half of M2.5 (the js-coverage gate pins the
    // coverage/edges/determinism half); together they prove JS is a first-class citizen, not a
    // dropped Phase-1 file node.
    lang: 'javascript',
    path: 'scoring.js',
    extractor: () => new TypeScriptExtractor(),
    proc: 'assess',
    source: `function assess(amount, score) {
  let risk;
  if (amount > 50000 && score < 700) {
    risk = amount * 0.4 + score * 0.6;
    throw new Error("high risk");
  }
}
`,
  },
];

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used — hand-rolled parsers');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

describe('Phase 3 — cross-language coverage + fidelity parity (loan scoring)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crib-parity-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  for (const c of CASES) {
    it(`${c.lang}: emits condition + formula-assignment + raise and reports complete coverage`, async () => {
      const r = await c
        .extractor()
        .extract(
          { path: c.path, lang: c.lang, bytes: c.source.length, mtime: 0 },
          ctxFor(c.source),
        );

      const soul = new SoulStore(join(tmp, '.crib'), {
        manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
      });
      soul.load();
      soul.putNodes(r.nodes);
      soul.putEdges(r.edges);
      soul.commit('2026-01-01T00:00:00.000Z');

      // locate the `assess` callable by simple name (case-insensitive).
      const proc = [...soul.iterate('symbol')].find(
        (n) => (n.name ?? '').toLowerCase() === c.proc.toLowerCase(),
      );
      expect(proc, `${c.lang}: assess callable must be a symbol node`).toBeDefined();

      const cov = computeCoverage(soul, proc!.id);

      // 1. the body is present and behavior-bearing — the three classes every language must capture.
      expect(cov.bodyPresent, `${c.lang}: body must be present`).toBe(true);
      expect(cov.conditions, `${c.lang}: must capture the guard condition`).toBeGreaterThanOrEqual(
        1,
      );
      expect(cov.assignments, `${c.lang}: must capture the risk assignment`).toBeGreaterThanOrEqual(
        1,
      );
      expect(cov.raises, `${c.lang}: must capture the raise/throw/panic`).toBeGreaterThanOrEqual(1);

      // 2. coverage is clean: no unresolved calls, no clipped expressions → readiness complete.
      expect(cov.exprTruncated, `${c.lang}: no expression should be clipped`).toBe(0);
      expect(cov.readiness, `${c.lang}: readiness should be complete`).toBe('complete');

      // 3. FIDELITY: the scoring formula survives verbatim into an assignment node's `expr`.
      const assignments = [...soul.iterate()].filter((n: Node) => n.kind === 'assignment');
      const formula = assignments.find((a) => (a.expr ?? '').includes('0.4'));
      expect(
        formula,
        `${c.lang}: the assignment expr must capture the scoring formula (… 0.4 … 0.6 …)`,
      ).toBeDefined();
      expect(formula!.expr, `${c.lang}: formula must include the 0.6 weight`).toContain('0.6');
    });
  }
});

/**
 * Task 8 — MuleSoft capability honesty. Mule is a CONFIG language (XML), not a procedural one, so the
 * loan-scoring parity harness above does not apply. Instead this pins what Mule honestly IS: it emits
 * behavior nodes (flow / condition / statement / exception-handler / http-call) but, having no type
 * system, emits ZERO inherits/implements edges — and the property extractor is KEY-ONLY: a property
 * key becomes a `property` symbol node with `meta.valueRedacted: true`, while the VALUE never reaches
 * the graph (the security contract: never store values from secure/credential files).
 */
import { MuleExtractor } from './mule/MuleExtractor.js';

const MULE4_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:http="http://www.mulesoft.org/schema/mule/http">
  <http:listener-config name="httpConfig" basePath="/api">
    <http:listener-connection host="0.0.0.0" port="8081"/>
  </http:listener-config>
  <flow name="getOrders">
    <http:listener config-ref="httpConfig" path="/orders" allowedMethods="GET"/>
    <choice>
      <when expression="#[payload.id == 1]">
        <logger level="INFO" message="one"/>
      </when>
      <otherwise>
        <logger level="INFO" message="default"/>
      </otherwise>
    </choice>
    <http:request config-ref="httpConfig" method="GET" path="/downstream"/>
    <error-handler>
      <on-error-propagate type="ANY">
        <logger level="ERROR" message="#[error.description]"/>
      </on-error-propagate>
    </error-handler>
  </flow>
</mule>
`;

const MULE4_PROPS = `db.user=alice
db.password=swordfish
`;

describe('Task 8 — MuleSoft capability honesty (config language, no type system, key-only props)', () => {
  it('emits behavior nodes: a flow, a condition, a statement, an http-call, an exception-handler', async () => {
    const r = await new MuleExtractor().extract(
      {
        path: 'src/main/mule/orders.xml',
        lang: 'mule',
        bytes: MULE4_CONFIG.length,
        mtime: 0,
        classification: {
          family: 'mule',
          projectId: '.',
          projectRoot: '',
          dialect: 'mule4',
          role: 'config',
        },
      },
      ctxFor(MULE4_CONFIG),
    );

    const kinds = new Set(r.nodes.map((n) => n.kind));
    const types = new Set(r.nodes.map((n) => n.type));
    // flow is a symbol node typed `flow`
    expect(
      r.nodes.some((n) => n.kind === 'symbol' && n.type === 'flow' && n.name === 'getOrders'),
    ).toBe(true);
    expect(kinds.has('condition')).toBe(true);
    expect(kinds.has('statement')).toBe(true);
    expect(kinds.has('http-call')).toBe(true);
    expect(kinds.has('exception-handler')).toBe(true);
  });

  it('emits NO inherits or implements edges (no type system — capability honesty)', async () => {
    const r = await new MuleExtractor().extract(
      {
        path: 'src/main/mule/orders.xml',
        lang: 'mule',
        bytes: MULE4_CONFIG.length,
        mtime: 0,
        classification: {
          family: 'mule',
          projectId: '.',
          projectRoot: '',
          dialect: 'mule4',
          role: 'config',
        },
      },
      ctxFor(MULE4_CONFIG),
    );
    const rels = new Set(r.edges.map((e) => e.rel));
    expect(rels.has('inherits')).toBe(false);
    expect(rels.has('implements')).toBe(false);
  });

  it('properties extractor is key-only: persists the key node, never the value', async () => {
    const r = await new MuleExtractor().extract(
      {
        path: 'src/main/mule/app.properties',
        lang: 'mule-properties',
        bytes: MULE4_PROPS.length,
        mtime: 0,
        classification: {
          family: 'mule',
          projectId: '.',
          projectRoot: '',
          dialect: 'mule4',
          role: 'properties',
        },
      },
      ctxFor(MULE4_PROPS),
    );
    // the key becomes a `property` symbol node, redacted
    const pwd = r.nodes.find((n) => n.name === 'db.password');
    expect(pwd).toMatchObject({ kind: 'symbol', type: 'property', lang: 'properties' });
    expect((pwd?.meta as { valueRedacted?: boolean })?.valueRedacted).toBe(true);
    // the secret value must never reach the graph in any node or edge
    const dump = JSON.stringify({ nodes: r.nodes, edges: r.edges });
    expect(dump).not.toContain('swordfish');
    expect(dump).toContain('db.password');
  });
});
