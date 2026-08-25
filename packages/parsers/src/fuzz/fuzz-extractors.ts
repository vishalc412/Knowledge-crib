import { CsharpExtractor } from '../csharp/CsharpExtractor.js';
import { GoExtractor } from '../go/GoExtractor.js';
import { JavaExtractor } from '../java/JavaExtractor.js';
import { MarkdownExtractor } from '../md/MarkdownExtractor.js';
import { MuleExtractor } from '../mule/MuleExtractor.js';
import { PhpExtractor } from '../php/PhpExtractor.js';
import { PlSqlExtractor } from '../plsql/PlSqlExtractor.js';
import { PythonExtractor } from '../python/PythonExtractor.js';
import { RustExtractor } from '../rust/RustExtractor.js';
import { TypeScriptExtractor } from '../ts/TypeScriptExtractor.js';
/**
 * M3.5 parser fuzzing — the extractor fleet under fuzz.
 *
 * One spec per shipped extractor: the constructor (so the worker can build it by name after the
 * message boundary — class instances can't be sent across an isolate) + a canonical file extension
 * (so the fuzz FileMeta's `path` ends with an ext the extractor's `supports()` matches — otherwise
 * the registry wouldn't route to it and we'd fuzz nothing).
 *
 * The fuzz harness identifies an extractor by `ctor.name` (the JS class name) — deterministic, and
 * decoupled from the production `Extractor.name` field (which a malformed extractor could lie about).
 *
 * Mule is the first NON-source-language extractor in the fleet. Its `supports()` gates on
 * `file.classification?.family === 'mule'`, so the spec carries a `classification` the fuzz worker
 * copies into the FileMeta — without it, supports() correctly refuses the input and the test would
 * fuzz nothing. The spec also carries `seedInputs`: deterministic XML adversarial corpora (namespaces,
 * CDATA, DataWeave expressions, quotes, deep nesting, U+FFFD replacement chars, large attribute
 * counts, unbound prefixes) the harness prepends to the generated inputs so the XML-specific
 * untrusted-input boundaries are exercised every run, not just when fast-check happens to emit them.
 */
import type { FileClassification } from '../types.js';
import type { Extractor } from '../types.js';

export interface FuzzExtractorSpec {
  /** identifier sent across the worker boundary = the JS class name. */
  name: string;
  /** builds a fresh extractor instance (extractors hold no per-run state that must persist). */
  ctor: new () => Extractor;
  /** file extension for the fuzz FileMeta.path so `supports()` matches. */
  ext: string;
  /** optional FileClassification copied into the fuzz FileMeta (Mule gates on family=mule). */
  classification?: FileClassification;
  /** optional deterministic seeded inputs prepended to the generated fast-check set. */
  seedInputs?: readonly string[];
}

/** Deterministic XML adversarial corpora for the Mule extractor — exercises the saxes boundary
 *  (declared + unbound namespaces, CDATA, entities, deep nesting, large attribute counts, U+FFFD
 *  replacement chars) and the mule4 normalizer (flows, subflows, flow-ref, choice, error-handler,
 *  outbound http:request, secure property-key expressions). A mix of well-formed seeds (parse OK →
 *  exercise emitConfig so the validator checks the emitted nodes/edges) and broken seeds (degrade to
 *  a parse-failed diagnostic → empty, the contract happy path). */
const MULE_SEED_INPUTS: readonly string[] = [
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core"><flow name="f"><logger level="INFO" message="x"/></flow></mule>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core" xmlns:http="http://www.mulesoft.org/schema/mule/http"><http:listener-config name="c" basePath="/api"><http:listener-connection host="0.0.0.0" port="8081"/></http:listener-config><flow name="f"><http:listener config-ref="c" path="/o" allowedMethods="GET"/><logger/></flow></mule>',
  '<mule><flow name="f"><flow-ref name="#[payload.x]"/><flow-ref name="missing"/><logger message="#[payload]"/></flow><sub-flow name="missing"><logger/></sub-flow></mule>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core"><flow name="f"><set-payload value="#[payload]"/><![CDATA[ raw cdata ]]></flow></mule>',
  '<flow name="a"><flow name="b"><flow name="c"><flow name="d"><flow name="e"><flow name="g"><logger/></flow></flow></flow></flow></flow></flow>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core"><flow name="f"><logger level="INFO" message="&lt;&gt;&amp;&quot;"/></flow></mule>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core" xmlns:http="http://www.mulesoft.org/schema/mule/http"><flow name="f"><http:request config-ref="c" method="GET" path="/x" a1="1" a2="2" a3="3" a4="4" a5="5" a6="6" a7="7" a8="8" a9="9" a10="10"/></flow></mule>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core"><flow name="f">�� bad bytes �</flow></mule>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core" xmlns:munit="http://www.mulesoft.org/schema/mule/munit" xmlns:mock="http://www.mulesoft.org/schema/mule/mock" xmlns:http="http://www.mulesoft.org/schema/mule/http"><munit:test name="t"><munit:behavior><mock:when processor="http:request" config-ref="c"><mock:then-return><mock:payload mediaType="application/java">#[p(\'db.password\')]</mock:payload></mock:then-return></mock:when></munit:behavior><munit:execution><flow-ref name="f"/></munit:execution></munit:test><flow name="f"><logger/></flow></mule>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core"><flow name="f"><choice><when expression="#[payload.id == 1]"><logger/></when><otherwise><logger level="WARN"/></otherwise></choice></flow></mule>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core"><sub-flow name="s"><logger level="INFO" message="#[\'quoted \'value\'"]/><set-payload value="${db.user}"/></sub-flow></mule>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core"><flow name="f"><error-handler><on-error-propagate type="ANY"><logger level="ERROR" message="#[error.description]"/></on-error-propagate></error-handler></flow></mule>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core" xmlns:doc="http://www.mulesoft.org/schema/mule/documentation"><flow name="f" doc:name="x"><logger doc:name="y"/></flow></mule>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core"><flow name="f"><ee:transform xmlns:ee="http://www.mulesoft.org/schema/mule/ee/core"><ee:message><ee:set-payload><![CDATA[#[payload]]]></ee:set-payload></ee:message></ee:transform></flow></mule>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core"><flow name="f"><unbound:thing ref="c"/></flow></mule>',
  '<mule xmlns="http://www.mulesoft.org/schema/mule/core"><flow name="f"><logger level="INFO"',
];

/** The 10 shipped extractors, fuzzed in M3.5 + the Mule hardening plan. */
export const FUZZ_EXTRACTORS: readonly FuzzExtractorSpec[] = [
  { name: MarkdownExtractor.name, ctor: MarkdownExtractor, ext: '.md' },
  { name: TypeScriptExtractor.name, ctor: TypeScriptExtractor, ext: '.ts' },
  { name: PlSqlExtractor.name, ctor: PlSqlExtractor, ext: '.pkb' },
  { name: PythonExtractor.name, ctor: PythonExtractor, ext: '.py' },
  { name: JavaExtractor.name, ctor: JavaExtractor, ext: '.java' },
  { name: CsharpExtractor.name, ctor: CsharpExtractor, ext: '.cs' },
  { name: GoExtractor.name, ctor: GoExtractor, ext: '.go' },
  { name: RustExtractor.name, ctor: RustExtractor, ext: '.rs' },
  { name: PhpExtractor.name, ctor: PhpExtractor, ext: '.php' },
  {
    name: MuleExtractor.name,
    ctor: MuleExtractor,
    ext: '.xml',
    classification: {
      family: 'mule',
      projectId: '.',
      projectRoot: '',
      dialect: 'mule4',
      role: 'config',
    },
    seedInputs: MULE_SEED_INPUTS,
  },
];
