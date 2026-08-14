import { describe, expect, it } from 'vitest';
import { classifyMuleFiles } from './classify.js';

const meta = (path: string) => ({ path, bytes: 1, mtime: 1 });

describe('classifyMuleFiles', () => {
  it('classifies independent Mule 3 and Mule 4 roots', () => {
    const result = classifyMuleFiles(
      [
        meta('modern/mule-artifact.json'),
        meta('modern/src/main/mule/api.xml'),
        meta('legacy/src/main/app/legacy.xml'),
        meta('legacy/src/test/munit/order-test.xml'),
      ],
      new Map([
        ['modern/mule-artifact.json', '{}'],
        ['modern/src/main/mule/api.xml', '<mule xmlns="http://www.mulesoft.org/schema/mule/core"/>'],
        ['legacy/src/main/app/legacy.xml', '<mule xmlns="http://www.mulesoft.org/schema/mule/core"><inbound-endpoint/></mule>'],
        ['legacy/src/test/munit/order-test.xml', '<munit:config xmlns:munit="http://www.mulesoft.org/schema/mule/munit"/>'],
      ]),
    );
    expect(result.files.get('modern/src/main/mule/api.xml')).toMatchObject({ dialect: 'mule4', role: 'config' });
    expect(result.files.get('legacy/src/main/app/legacy.xml')).toMatchObject({ dialect: 'mule3', role: 'config' });
    expect(result.files.get('legacy/src/test/munit/order-test.xml')).toMatchObject({ dialect: 'mule3', role: 'munit' });
  });

  it('does not semantically classify a root with conflicting strong signals', () => {
    const result = classifyMuleFiles(
      [meta('app/mule-artifact.json'), meta('app/src/main/app/api.xml')],
      new Map([
        ['app/mule-artifact.json', '{}'],
        ['app/src/main/app/api.xml', '<mule><inbound-endpoint/></mule>'],
      ]),
    );
    expect(result.files.has('app/src/main/app/api.xml')).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'mule:ambiguous-dialect', severity: 'error' }));
  });

  it('assigns roles by extension and path', () => {
    const result = classifyMuleFiles(
      [
        meta('app/mule-artifact.json'),
        meta('app/pom.xml'),
        meta('app/src/main/mule/flow.xml'),
        meta('app/src/main/resources/transform.dwl'),
        meta('app/src/main/resources/api.raml'),
        meta('app/src/main/resources/secure.properties'),
        meta('app/src/main/app/app.properties'),
      ],
      new Map([
        ['app/mule-artifact.json', '{}'],
        ['app/pom.xml', '<project><packaging>mule-application</packaging></project>'],
        ['app/src/main/mule/flow.xml', '<mule/>'],
        ['app/src/main/resources/transform.dwl', '%dw 2.0'],
        ['app/src/main/resources/api.raml', '#%RAML 1.0'],
        ['app/src/main/resources/secure.properties', 'db.password=x'],
        ['app/src/main/app/app.properties', 'key=val'],
      ]),
    );
    expect(result.files.get('app/mule-artifact.json')?.role).toBe('descriptor');
    expect(result.files.get('app/pom.xml')?.role).toBe('descriptor');
    expect(result.files.get('app/src/main/resources/transform.dwl')?.role).toBe('dataweave');
    expect(result.files.get('app/src/main/resources/api.raml')?.role).toBe('raml');
    expect(result.files.get('app/src/main/resources/secure.properties')).toMatchObject({ role: 'properties', sensitive: true });
    expect(result.files.get('app/src/main/app/app.properties')?.role).toBe('properties');
  });

  it('detects a Mule project from a packaging pom without standard layout', () => {
    const result = classifyMuleFiles(
      [meta('flat/pom.xml'), meta('flat/flows.xml')],
      new Map([
        ['flat/pom.xml', '<project><packaging>mule-application</packaging></project>'],
        ['flat/flows.xml', '<mule xmlns="http://www.mulesoft.org/schema/mule/core"/>'],
      ]),
    );
    expect(result.files.get('flat/flows.xml')).toMatchObject({ dialect: 'mule4', role: 'config', projectRoot: 'flat' });
  });

  it('ignores non-Mule files entirely', () => {
    const result = classifyMuleFiles(
      [meta('src/index.ts'), meta('README.md')],
      new Map([['src/index.ts', 'export {}'], ['README.md', '# hi']]),
    );
    expect(result.files.size).toBe(0);
    expect(result.diagnostics).toHaveLength(0);
  });
});