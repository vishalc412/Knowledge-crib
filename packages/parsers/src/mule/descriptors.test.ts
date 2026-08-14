import { describe, expect, it } from 'vitest';
import { parseMuleArtifact, parsePom, parseProperties } from './descriptors.js';

describe('parseProperties — Java .properties (keys only, never values)', () => {
  it('returns sorted unique keys and discards values', () => {
    const result = parseProperties('db.user=alice\ndb.password=swordfish');
    expect(result.keys).toEqual(['db.password', 'db.user']);
    expect(result.diagnostics).toEqual([]);
  });

  it('ignores comments, blank lines, and key:value syntax', () => {
    const result = parseProperties(
      ['# a comment', '! another comment', '', 'host:localhost', 'port=8080'].join('\n'),
    );
    expect(result.keys).toEqual(['host', 'port']);
  });

  it('deduplicates keys (last-declaration wins for keys-only indexing)', () => {
    const result = parseProperties('a.x=1\na.x=2');
    expect(result.keys).toEqual(['a.x']);
  });

  it('never throws on malformed input', () => {
    const result = parseProperties('=novalue\nplainline\nkey=val=ue');
    expect(result.keys).toEqual(['key']); // '=novalue' has no key; 'plainline' has no delimiter
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('never includes a resolved value anywhere in the result', () => {
    const result = parseProperties('db.password=topsecret');
    expect(JSON.stringify(result)).not.toContain('topsecret');
    expect(JSON.stringify(result)).toContain('db.password');
  });
});

describe('parseMuleArtifact — mule-artifact.json descriptor', () => {
  it('lifts the minMuleVersion + requiredProduct fields', () => {
    const result = parseMuleArtifact(
      '{"minMuleVersion":"4.4.0","requiredProduct":"MULE_EE","classLoaderModelLoaderDescriptor":{"id":"test"}}',
    );
    expect(result).toMatchObject({ minMuleVersion: '4.4.0', requiredProduct: 'MULE_EE' });
    expect(result.diagnostics).toEqual([]);
  });

  it('reports invalid JSON as a diagnostic instead of throwing', () => {
    const result = parseMuleArtifact('{not valid json');
    expect(result.minMuleVersion).toBeUndefined();
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]?.code).toBe('mule:invalid-artifact-json');
  });
});

describe('parsePom — Maven POM (dependencies + property keys, values never stored)', () => {
  const POM = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <properties>
    <http.version>1.5.0</http.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.mule.connectors</groupId>
      <artifactId>mule-http-connector</artifactId>
      <version>\${http.version}</version>
    </dependency>
    <dependency>
      <groupId>org.mule.modules</groupId>
      <artifactId>mule-object-store</artifactId>
      <version>1.2.0</version>
    </dependency>
  </dependencies>
</project>`;

  it('extracts dependencies with versionRef (never resolved)', () => {
    const result = parsePom(POM);
    expect(result.dependencies).toContainEqual({
      groupId: 'org.mule.connectors',
      artifactId: 'mule-http-connector',
      versionRef: '${http.version}',
    });
    expect(result.dependencies).toContainEqual({
      groupId: 'org.mule.modules',
      artifactId: 'mule-object-store',
      versionRef: '1.2.0',
    });
  });

  it('extracts property keys but never their values', () => {
    const result = parsePom(POM);
    expect(result.propertyKeys).toEqual(['http.version']);
    expect(JSON.stringify(result)).not.toContain('1.5.0');
  });

  it('reports malformed XML as a diagnostic instead of throwing', () => {
    const result = parsePom('<project><dependency></dependencies>');
    expect(result.dependencies).toEqual([]);
    expect(result.diagnostics.length).toBe(1);
  });
});
