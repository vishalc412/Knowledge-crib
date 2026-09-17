import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from '../pipeline.js';

// Caller-recall gate built from a real impact analysis in which crib found 4 of 15 grep-confirmed
// callers. The fixture reproduces each call shape crib missed: `Type.m()` static calls, `Type::m`
// method references, `param.m()` / `local.m()` / `field.m()` receivers (incl. an inherited method),
// arity-tied overloads that need access rules + argument types to pick, a chained
// `x.getType().isFll()`, an untyped lambda parameter, and Velocity templates.
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'java-callers',
);
const VALIDATOR = 'src/main/java/org/acme/event/EventTeamAuthorizationValidator.java';
const NOW = '2026-01-01T00:00:00.000Z';

let cribDir: string;
let soul: SoulStore;

beforeEach(async () => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-java-callers-'));
  soul = new SoulStore(cribDir, { manifest: newManifest({ now: NOW }) });
  soul.load();
  await indexRepo(soul, FIXTURE, { now: NOW, cluster: false, semantic: false });
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

function lineOf(rel: string, needle: string): number {
  const idx = readFileSync(join(FIXTURE, rel), 'utf8')
    .split('\n')
    .findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`needle not found in ${rel}: ${needle}`);
  return idx + 1;
}

function symbol(qualifiedName: string, line?: number): Node {
  const hits = [...soul.iterate('symbol')].filter(
    (n) => n.qualifiedName === qualifiedName && (line === undefined || n.span?.start === line),
  );
  if (hits.length !== 1) {
    throw new Error(`expected one symbol ${qualifiedName}@${line ?? '*'}, got ${hits.length}`);
  }
  return hits[0]!;
}

function label(id: string): string {
  const n = soul.getNode(id);
  if (!n) return id;
  if (n.kind === 'file') return `file:${n.file?.split('/').pop()}`;
  const q = n.qualifiedName ?? n.name ?? id;
  const dupes = [...soul.iterate('symbol')].filter((s) => s.qualifiedName === q).length;
  return dupes > 1 ? `${q}@L${n.span?.start}` : q;
}

/** Incoming `calls` edges of a symbol as `caller [PROVENANCE]`, sorted. */
function callers(target: Node): string[] {
  return [...soul.iterateEdges('calls')]
    .filter((e) => e.dst === target.id)
    .map((e) => `${label(e.src)} [${e.provenance}]`)
    .sort();
}

describe('Java caller recall (gate)', () => {
  it('resolves Type.m() static calls and picks the right arity-tied overload', () => {
    const pub = lineOf(VALIDATOR, 'public static void validateEventRequestType(CloudProfile');
    const four = lineOf(VALIDATOR, 'boolean canRequestWorldFestival, List<String> gradeBands) {');
    const three = lineOf(VALIDATOR, 'boolean canRequestWorldFestival) {');
    const q = 'EventTeamAuthorizationValidator.validateEventRequestType';

    // both route callers, and ONLY them: the package-private overloads are invisible from
    // org.acme.request, and neither overload calls the public one.
    expect(callers(symbol(q, pub))).toEqual([
      'RequestRoutesLogic.approve [EXTRACTED]',
      'RequestRoutesLogic.submit [EXTRACTED]',
    ]);
    // public (3 args) → 4-arg overload; 4-arg → 3-arg (EventType,boolean,boolean) — the arity tie with
    // the public (CloudProfile,EventType,List) overload is broken by the first argument's type.
    expect(callers(symbol(q, four))).toEqual([`${q}@L${pub} [EXTRACTED]`]);
    expect(callers(symbol(q, three))).toEqual([`${q}@L${four} [EXTRACTED]`]);
  });

  it('resolves Type::m method references and same-package static calls', () => {
    expect(callers(symbol('Event.isGradeBandLabelK2Only'))).toEqual([
      'EventGradeBandLabelTest.k2Labels [EXTRACTED]',
      'FllLeadCoachClassroomProvisioning.k2Bands [EXTRACTED]',
    ]);
  });

  it('resolves param / local / field receivers (incl. inherited), lambdas and templates', () => {
    expect(callers(symbol('Event.isFllGradeBandK2Only'))).toEqual([
      'Event.describe [EXTRACTED]',
      `EventTeamAuthorizationValidator.validateEventRequestType@L${lineOf(VALIDATOR, 'boolean canRequestWorldFestival, List<String> gradeBands) {')} [EXTRACTED]`,
      'FllMatchRoutesLogic.countK2 [INFERRED]',
      'FllMatchRoutesLogic.useK2Rules [EXTRACTED]',
      'FllUIRoutesLogic.rubric [EXTRACTED]',
      'FllUIRoutesLogic.scoreSheet [EXTRACTED]',
      'file:eventConfig.vm [INFERRED]',
      'file:eventHome.vm [INFERRED]',
    ]);
  });

  it('types chained receivers through return types and never bare-matches a chained call', () => {
    expect(callers(symbol('EventType.isFll'))).toEqual([
      'FllUIRoutesLogic.rubric [EXTRACTED]',
      'file:eventConfig.vm [INFERRED]',
      'file:eventHome.vm [INFERRED]',
    ]);
    expect(callers(symbol('RequestRoutesLogic.submit'))).toEqual([]);
    expect(callers(symbol('EventRequest.getType'))).toEqual([
      'RequestRoutesLogic.approve [EXTRACTED]',
      'RequestRoutesLogic.submit [EXTRACTED]',
    ]);
    expect(callers(symbol('EventRequestStore.find'))).toEqual([
      'RequestRoutesLogic.approve [EXTRACTED]',
    ]);
    expect(callers(symbol('CloudProfile.isAdmin'))).toEqual([
      'EventTeamAuthorizationValidator.canRequestClassroom [EXTRACTED]',
      'EventTeamAuthorizationValidator.canRequestWorldFestival [EXTRACTED]',
    ]);
  });

  it('inferred edges are labelled, never presented as certain', () => {
    for (const e of soul.iterateEdges('calls')) {
      if (e.provenance === 'EXTRACTED') {
        expect(e.confidence).toBe(1);
      } else {
        expect(e.method).toBe('inferred');
        expect(e.confidence).toBeLessThan(1);
      }
    }
  });
});
