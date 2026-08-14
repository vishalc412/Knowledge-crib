/**
 * Deterministic synthetic Mule 4 project generator (license-safe acceptance corpus).
 *
 * Produces a self-contained Mule 4 application tree under `root` that exercises every MuleSoft
 * extraction path the knowledge-crib Mule extractor + resolver support, at exact known counts so an
 * acceptance checker can verify topology, redaction, and extraction altitude. NO proprietary code is
 * embedded — every file is generated from scratch, so this corpus is safe to commit and run in CI.
 *
 * The generated project yields these graph counts (the checker's expected baseline):
 *   flows=18  subflows=7  flowRefs=39  choices=10  transforms=27  inlineDw2=30
 *   listeners=2  apiOperations=8  outboundCalls=4  errorHandlers=15
 *   productionDwl=1  testDwl=21  munitTests=6  mocks=6  externalFlowTargets=3
 *
 * SECURITY canaries (the locked constraint: keys + references only, never values):
 *   - application.properties  → ordinary keys (app.name, app.region), values never stored.
 *   - secure.properties       → sensitive-named file; keys (db.password, http.port) recorded as
 *                               references with `valueRedacted`, the secret VALUE never enters the graph.
 *   - reports/assets/js/tsorter.min.js → a declaration-free vendor stub; yields zero semantic nodes so
 *                               report/asset JavaScript does not pollute the topology counts.
 *
 * `inlineDw2` (the `#[...]` DataWeave blocks) are NOT graph nodes — they are counted by scanning the
 * source `.xml` files. Exactly 30 `#[` appear: 10 from `<choice>` `when` expressions + 20 from
 * `<ee:transform>` set-payload bodies. The 7 empty `<ee:transform/>` contribute none, and no other
 * file (configs, MUnit, descriptors) contains a `#[`.
 *
 * Usage: `syntheticMuleProject(root)` writes the tree; the caller indexes `root` with the CLI.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Canary secret value — the checker asserts this substring never appears in the graph. */
export const SECRET_CANARY = 'SUPER_SECRET_CANARY_VALUE_xyz';

/** All 25 defined flow/subflow names (f1..f18 flows, sf1..sf7 subflows). */
const FLOW_NAMES = [
  ...Array.from({ length: 18 }, (_, i) => `f${i + 1}`),
  ...Array.from({ length: 7 }, (_, i) => `sf${i + 1}`),
];

/** Three unresolved flow-ref targets → three unique external-flow placeholders. */
const MISSING = ['missingFlowA', 'missingFlowB', 'missingFlowC'];

/** Build the 39 flow-ref target names: 36 defined names (cycling) + 3 unresolved, each once. */
function flowRefTargets() {
  const targets = [];
  for (let i = 0; i < 39; i++) targets.push(FLOW_NAMES[i % FLOW_NAMES.length]);
  targets[5] = MISSING[0];
  targets[15] = MISSING[1];
  targets[25] = MISSING[2];
  return targets;
}

/** Container name for index 0..24 (f1..f18 then sf1..sf7). */
const containerName = (i) => (i < 18 ? `f${i + 1}` : `sf${i - 17}`);
const isFlow = (i) => i < 18;

/** Mule 4 root namespaces for config files. */
const MULE_NS =
  'xmlns="http://www.mulesoft.org/schema/mule/core" ' +
  'xmlns:http="http://www.mulesoft.org/schema/mule/http" ' +
  'xmlns:ee="http://www.mulesoft.org/schema/mule/ee/core"';

/** Write a file under root, creating parent dirs. */
function write(root, rel, content) {
  mkdirSync(join(root, ...rel.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

/** Build the processor body + optional error-handler for container index `i`.
 *  Each XML element is on its OWN line: a `<choice>` and its inner `<logger>` (and an
 *  `<ee:transform>` and its `<ee:set-payload>`) both emit `statement`-kind graph nodes keyed by
 *  start line. If they share a line they collide to one id and the child overwrites the parent —
 *  so choices and parent transforms would silently drop to zero. One element per line keeps every
 *  statement node on a distinct line with a distinct id. */
function containerBody(i, refs) {
  const ind = '      ';
  const lines = [];
  // Listeners (f1, f2): http:listener MUST be the first processor so it classifies as a source route.
  if (i < 2) {
    lines.push(`${ind}<http:listener config-ref="lc" path="/p${i + 1}" allowedMethods="GET"/>`);
  }
  // Flow-refs assigned to this container (each on its own line → distinct statement ids).
  for (const target of refs) lines.push(`${ind}<flow-ref name="${target}"/>`);
  // Choices (f1..f10): one each, with a `#[` when-expression (10 `#[` total).
  if (i < 10) {
    lines.push(`${ind}<choice>`);
    lines.push(`${ind}  <when expression="#[payload.id == ${i + 1}]">`);
    lines.push(`${ind}    <logger level="INFO" message="c${i}"/>`);
    lines.push(`${ind}  </when>`);
    lines.push(`${ind}  <otherwise>`);
    lines.push(`${ind}    <logger level="WARN" message="o${i}"/>`);
    lines.push(`${ind}  </otherwise>`);
    lines.push(`${ind}</choice>`);
  }
  // Transforms with a set-payload child (f1..f20): parent transform statement + set-payload child,
  // each on its own line so both survive (20 `#[` from the set-payload bodies).
  if (i < 20) {
    lines.push(`${ind}<ee:transform>`);
    lines.push(`${ind}  <ee:message>`);
    lines.push(`${ind}    <ee:set-payload><![CDATA[#[payload]]]></ee:set-payload>`);
    lines.push(`${ind}  </ee:message>`);
    lines.push(`${ind}</ee:transform>`);
  }
  // Empty transforms (f21..f25, plus a second for f1,f2): 7 total, each its own line.
  if (i >= 20 || i < 2) {
    lines.push(`${ind}<ee:transform/>`);
  }
  // Outbound HTTP (f1..f4): one http:request each.
  if (i < 4) {
    lines.push(`${ind}<http:request config-ref="rc" method="GET" path="/r${i + 1}"/>`);
  }
  // Tail logger (no `#[`).
  lines.push(`${ind}<logger level="INFO" message="end${i}"/>`);
  let body = lines.join('\n');
  // Error handlers (f1..f15): one on-error-propagate each (15 on-error elements).
  if (i < 15) {
    body +=
      `\n${ind}<error-handler>` +
      `\n${ind}  <on-error-propagate type="ANY">` +
      `\n${ind}    <logger level="ERROR" message="err${i}"/>` +
      `\n${ind}  </on-error-propagate>` +
      `\n${ind}</error-handler>`;
  }
  return body;
}

/**
 * Generate the full synthetic Mule 4 project under `root`. Deterministic: the same `root` always
 * yields byte-identical files. Returns the list of repo-relative paths written (for diagnostics).
 */
export function syntheticMuleProject(root) {
  const targets = flowRefTargets();

  // Distribute 39 flow-refs: containers 0..13 get 2, 14..24 get 1 (28 + 11 = 39).
  const refsByContainer = [];
  let ptr = 0;
  for (let c = 0; c < 25; c++) {
    const n = c < 14 ? 2 : 1;
    refsByContainer.push(targets.slice(ptr, ptr + n));
    ptr += n;
  }

  // --- Descriptors (anchor a single mule4 project at the repo root) -------------------------
  write(root, 'mule-artifact.json', `${JSON.stringify({ minMuleVersion: '4.4.0' }, null, 2)}\n`);
  write(
    root,
    'pom.xml',
    '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>' +
      '<packaging>mule-application</packaging><artifactId>synthetic-mule</artifactId></project>\n',
  );

  // --- Global configs (2 config symbols: lc, rc) --------------------------------------------
  write(
    root,
    'src/main/mule/configs.xml',
    `<mule ${MULE_NS}>\n  <http:listener-config name="lc" basePath="/api"><http:listener-connection host="0.0.0.0" port="8081"/></http:listener-config>\n  <http:request-config name="rc"><http:request-connection host="example.com"/></http:request-config>\n</mule>\n`,
  );

  // --- Flows + subflows split across two files (exercises cross-file flow-ref resolution) ----
  // main-flows.xml: f1..f12 + sf1..sf4 ; shared-flows.xml: f13..f18 + sf5..sf7.
  const mainContainers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18, 19, 20, 21];
  const sharedContainers = [12, 13, 14, 15, 16, 17, 22, 23, 24];
  const renderFile = (indices) =>
    `<mule ${MULE_NS}>\n${indices
      .map((i) => {
        const tag = isFlow(i) ? 'flow' : 'sub-flow';
        return `  <${tag} name="${containerName(i)}">\n      ${containerBody(i, refsByContainer[i])}\n    </${tag}>`;
      })
      .join('\n')}\n</mule>\n`;
  write(root, 'src/main/mule/main-flows.xml', renderFile(mainContainers));
  write(root, 'src/main/mule/shared-flows.xml', renderFile(sharedContainers));

  // --- RAML API: 8 resource methods → 8 route nodes -----------------------------------------
  write(
    root,
    'src/main/resources/api.raml',
    '#%RAML 1.0\ntitle: Billing API\nversion: v1\n/orders:\n  get:\n  post:\n/orders/{id}:\n  get:\n  put:\n  delete:\n/invoices:\n  get:\n  post:\n/customers:\n  get:\n',
  );

  // --- DataWeave: 1 production module + 21 test modules -------------------------------------
  write(
    root,
    'src/main/resources/transform.dwl',
    '%dw 2.0\noutput application/java\n---\npayload\n',
  );
  const dwBody = '%dw 2.0\noutput application/java\n---\n{}\n';
  for (let t = 1; t <= 21; t++) {
    const name = `test-${String(t).padStart(3, '0')}`;
    write(root, `src/test/resources/dw/${name}.dwl`, dwBody);
  }

  // --- Property canaries (keys + references only, never values) ------------------------------
  write(root, 'src/main/resources/application.properties', 'app.name=demo\napp.region=us-east\n');
  // Sensitive-named file: keys recorded as redacted references, the secret VALUE never persists.
  write(
    root,
    'src/main/resources/secure.properties',
    `db.password=${SECRET_CANARY}\nhttp.port=8081\n`,
  );

  // --- MUnit suite: 6 tests, 6 mocks (1 each), exercising existing flows f1..f6 ----------------
  const tests = Array.from({ length: 6 }, (_, t) => {
    const n = t + 1;
    return `  <munit:test name="test${n}" description="t${n}">\n    <munit:behavior>\n      <mock:when processor="http:request" config-ref="rc">\n        <mock:then-return>\n          <mock:payload mediaType="application/java"><![CDATA[fixed-value-${n}]]></mock:payload>\n        </mock:then-return>\n      </mock:when>\n    </munit:behavior>\n    <munit:execution>\n      <flow-ref name="f${n}"/>\n    </munit:execution>\n  </munit:test>`;
  }).join('\n');
  write(
    root,
    'src/test/munit/suite.xml',
    `<mule xmlns="http://www.mulesoft.org/schema/mule/core" xmlns:munit="http://www.mulesoft.org/schema/mule/munit" xmlns:mock="http://www.mulesoft.org/schema/mule/mock" xmlns:http="http://www.mulesoft.org/schema/mule/http">\n${tests}\n</mule>\n`,
  );

  // --- Report-JS canary: declaration-free vendor stub → zero semantic nodes -------------------
  write(
    root,
    'reports/assets/js/tsorter.min.js',
    '/*! tsorter.min.js — generated report bundle (table sorter). License: MIT. */\nvoid 0;\n',
  );
}
