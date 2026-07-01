/**
 * Workstream G — end-to-end dossier on the loan-rule-engine PL/SQL fixture.
 *
 * The proving chain: real PlSqlExtractor → indexRepo (parse + resolve + cfg + commit + persist
 * dossiers) → readDossier → markdown. Asserts the persisted "reusable deep context" artifact a
 * migration analyst (or a local LLM) consumes in ONE call actually surfaces the detailed-level
 * analysis: the decision table, every raise with its error code, the exception handlers, the cursor,
 * and the comment-derived explanation. This is the "does it capture detailed-level analysis?" gate.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, dossierToMarkdown, newManifest, readDossier } from '@knowledge-crib/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from './pipeline.js';

const LOAN_FIXTURE = fileURLToPath(
  new URL('../../parsers/fixtures/plsql/loan_rule_engine.pkb', import.meta.url),
);

let repo: string;
let crib: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-loan-e2e-'));
  crib = join(repo, '.crib');
  mkdirSync(repo, { recursive: true });
  // drop the loan-rule-engine fixture into the temp repo as a .pkb file the PL/SQL extractor picks up
  writeFileSync(join(repo, 'loan_rule_engine.pkb'), FIXTURE_TEXT);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const FIXTURE_TEXT = `CREATE TABLE loan_applications (
  id NUMBER, amount NUMBER, status VARCHAR2(20), credit_score NUMBER
);
CREATE OR REPLACE PACKAGE BODY loan_engine IS
  -- Assess one loan application: approve, reject, or escalate.
  PROCEDURE assess_application(p_id NUMBER) IS
    v_amt NUMBER; v_status VARCHAR2(20); v_score NUMBER; v_decision VARCHAR2(20);
    CURSOR c_app IS SELECT amount, status, credit_score FROM loan_applications WHERE id = p_id;
  BEGIN
    FOR rec IN c_app LOOP
      v_amt := rec.amount; v_status := rec.status; v_score := rec.credit_score;
      CASE
        WHEN v_amt > 50000 AND v_score >= 700 THEN v_decision := 'APPROVE';
        WHEN v_score >= 600 THEN v_decision := 'APPROVE';
        ELSE v_decision := 'REJECT';
      END CASE;
      IF v_decision = 'REJECT' THEN
        RAISE_APPLICATION_ERROR(-20001, 'application rejected: insufficient credit');
      END IF;
      UPDATE loan_applications SET status = v_decision WHERE id = p_id;
    END LOOP;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      v_decision := 'MISSING';
      UPDATE loan_applications SET status = 'MISSING' WHERE id = p_id;
    WHEN OTHERS THEN
      RAISE_APPLICATION_ERROR(-20002, 'assess_application failed');
  END assess_application;
END loan_engine;`;

function soulFor(): SoulStore {
  const s = new SoulStore(crib, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
  s.load();
  return s;
}

describe('dossier e2e — loan-rule-engine (Workstream G)', () => {
  it('indexes the fixture, persists a dossier, and the markdown surfaces detailed-level analysis', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, repo, { now: '2026-01-01T00:00:00.000Z' });
    expect(report.dossiers.written).toBeGreaterThanOrEqual(1);

    const proc = [...soul.iterate('symbol')].find(
      (n) => n.qualifiedName === 'loan_engine.assess_application',
    );
    expect(proc).toBeDefined();

    // the persisted artifact is fresh (hash-anchored) and carries the deep fields
    const read = readDossier(crib, proc!.id, {
      nodeHash: proc!.hash,
      schemaVersion: soul.getManifest().schemaVersion,
    });
    expect(read.missing).toBe(false);
    expect(read.stale).toBe(false);
    const d = read.dossier!;

    // callable → it has a decision table (the rule rows a migration analyst needs)
    expect(d.rules).toBeDefined();
    expect(d.rules!.rules.length).toBeGreaterThan(0);

    // control-flow constructs are folded in: the two raises + the two exception handlers
    expect(d.controlFlow).toBeDefined();
    const raiseCodes = d.controlFlow!.raises.map((r) => r.errorCode).sort();
    expect(raiseCodes).toEqual(['-20001', '-20002']);
    const handlers = d.controlFlow!.handles.map((h) => h.whenSelector).sort();
    expect(handlers).toEqual(['NO_DATA_FOUND', 'OTHERS']);

    // the markdown projection is what a local LLM consumes — assert the detailed-level sections
    const md = dossierToMarkdown(d);
    expect(md).toContain('# loan_engine.assess_application');
    expect(md).toContain('## Source');
    expect(md).toContain('## Decision table');
    expect(md).toContain('## Raises');
    expect(md).toContain('-20001');
    expect(md).toContain('application rejected: insufficient credit');
    expect(md).toContain('## Exception handlers');
    expect(md).toContain('NO_DATA_FOUND');
    expect(md).toContain('OTHERS');
    // the cursor the loop iterates is surfaced too
    expect(md).toContain('## Iterates');
    expect(md).toContain('c_app');
  });

  it('the dossier is byte-stable across a no-op re-index (deterministic deep context)', async () => {
    const a = soulFor();
    await indexRepo(a, repo, { now: '2026-01-01T00:00:00.000Z' });
    const proc = [...a.iterate('symbol')].find(
      (n) => n.qualifiedName === 'loan_engine.assess_application',
    )!;
    const md1 = dossierToMarkdown(
      readDossier(crib, proc.id, {
        nodeHash: proc.hash,
        schemaVersion: a.getManifest().schemaVersion,
      }).dossier!,
    );

    const b = soulFor();
    const report = await indexRepo(b, repo, { now: '2026-01-02T00:00:00.000Z' });
    // fresh artifacts are not rewritten
    expect(report.dossiers.written).toBe(0);
    const md2 = dossierToMarkdown(
      readDossier(crib, proc.id, {
        nodeHash: proc.hash,
        schemaVersion: b.getManifest().schemaVersion,
      }).dossier!,
    );
    expect(md2).toBe(md1);
  });
});
