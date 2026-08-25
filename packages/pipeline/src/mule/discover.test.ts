import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileMeta } from '@knowledge-crib/parsers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverFiles, fileNode } from '../structure.js';
import {
  classifyMuleDiscovery,
  keyOnlyHash,
  pathOnlyHash,
  propertyKeys,
  secureContentHash,
} from './discover.js';

function meta(path: string, bytes = 1): FileMeta {
  return { path, bytes, mtime: 1 };
}

describe('propertyKeys + keyOnlyHash', () => {
  it('extracts keys from .properties, ignoring comments and values', () => {
    const text = [
      '# comment line',
      'db.host=localhost',
      'db.password=supersecret',
      'db.port=5432',
      '! another comment',
    ].join('\n');
    expect(propertyKeys(text).sort()).toEqual(['db.host', 'db.password', 'db.port']);
  });

  it('extracts keys from YAML-style key: value', () => {
    expect(propertyKeys('http:\n  port: 8081\n  path: /api').sort()).toEqual([
      'http',
      'path',
      'port',
    ]);
  });

  it('keyOnlyHash is stable across value edits (only keys matter)', () => {
    const a = keyOnlyHash('db.user=alice\ndb.pass=secret-a');
    const b = keyOnlyHash('db.user=bob\ndb.pass=secret-b');
    expect(a).toBe(b);
    expect(a).toMatch(/^blake3:[0-9a-f]+$/);
  });

  it('keyOnlyHash changes when a key is added', () => {
    const a = keyOnlyHash('db.user=alice');
    const b = keyOnlyHash('db.user=alice\ndb.pass=x');
    expect(a).not.toBe(b);
  });

  it('keyOnlyHash never contains any value', () => {
    const h = keyOnlyHash('db.password=supersecret-value-123');
    expect(h).not.toContain('supersecret');
  });
});

describe('secureContentHash', () => {
  it('uses full content hash for non-sensitive files', () => {
    const file = meta('app/src/main/mule/api.xml');
    const c = secureContentHash(file, '<mule/>');
    expect(c).toMatch(/^blake3:[0-9a-f]+$/);
  });

  it('uses key-only hash for sensitive properties files', () => {
    const file: FileMeta = {
      path: 'app/src/main/resources/secure.properties',
      bytes: 1,
      mtime: 1,
      classification: {
        family: 'mule',
        projectId: 'app',
        projectRoot: 'app',
        dialect: 'mule4',
        role: 'properties',
        sensitive: true,
      },
    };
    const c = secureContentHash(file, 'db.password=topsecret\ndb.user=admin');
    expect(c).toMatch(/^blake3:[0-9a-f]+$/);
    // Different KEYS → different hash; same keys with different values would be equal (the point).
    expect(c).not.toBe(keyOnlyHash('db.password=other\ndb.username=other'));
    expect(c).toBe(keyOnlyHash('db.password=topsecret\ndb.user=admin'));
    // value never hashed
    expect(c).not.toContain('topsecret');
  });

  it('uses path-only hash for sensitive binary stores (bytes never hashed)', () => {
    const file: FileMeta = {
      path: 'app/src/main/resources/keystore.jks',
      bytes: 999,
      mtime: 1,
      classification: {
        family: 'mule',
        projectId: 'app',
        projectRoot: 'app',
        dialect: 'mule4',
        role: 'resource',
        sensitive: true,
      },
    };
    const c = secureContentHash(file, 'BINARY-SECRET-BYTES');
    expect(c).toBe(pathOnlyHash('app/src/main/resources/keystore.jks'));
    expect(c).toMatch(/^blake3:[0-9a-f]+$/);
    expect(c).not.toContain('BINARY');
  });
});

describe('classifyMuleDiscovery', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crib-mulediscover-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('stamps classification + role lang onto Mule files and leaves non-Mule files untouched', () => {
    mkdirSync(join(root, 'app/src/main/mule'), { recursive: true });
    mkdirSync(join(root, 'app/src/main/resources'), { recursive: true });
    writeFileSync(join(root, 'app/mule-artifact.json'), '{"minMuleVersion":"4.4.0"}');
    writeFileSync(
      join(root, 'app/src/main/mule/api.xml'),
      '<mule xmlns="http://www.mulesoft.org/schema/mule/core"/>',
    );
    writeFileSync(join(root, 'app/src/main/resources/secure.properties'), 'db.password=topsecret');
    writeFileSync(join(root, 'README.md'), '# not mule');

    const files = discoverFiles(root);
    const diagnostics = classifyMuleDiscovery(root, files);

    const api = files.find((f) => f.path === 'app/src/main/mule/api.xml')!;
    expect(api.classification).toMatchObject({ family: 'mule', dialect: 'mule4', role: 'config' });
    expect(api.lang).toBe('mule');

    const secure = files.find((f) => f.path === 'app/src/main/resources/secure.properties')!;
    expect(secure.classification).toMatchObject({ role: 'properties', sensitive: true });
    expect(secure.lang).toBe('mule-properties');

    const readme = files.find((f) => f.path === 'README.md')!;
    expect(readme.classification).toBeUndefined();

    expect(diagnostics).toHaveLength(0);
  });

  it('reports an ambiguous-dialect diagnostic for a conflicting root', () => {
    mkdirSync(join(root, 'app/src/main/app'), { recursive: true });
    writeFileSync(join(root, 'app/mule-artifact.json'), '{}');
    writeFileSync(join(root, 'app/src/main/app/legacy.xml'), '<mule><inbound-endpoint/></mule>');

    const files = discoverFiles(root);
    const diagnostics = classifyMuleDiscovery(root, files);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'mule:ambiguous-dialect' }));
  });

  it('fileNode hashes a sensitive properties file by keys only (value never in the soul)', () => {
    mkdirSync(join(root, 'app/src/main/resources'), { recursive: true });
    writeFileSync(join(root, 'app/mule-artifact.json'), '{}');
    mkdirSync(join(root, 'app/src/main/mule'), { recursive: true });
    writeFileSync(join(root, 'app/src/main/mule/f.xml'), '<mule/>');
    writeFileSync(
      join(root, 'app/src/main/resources/secure.properties'),
      'db.password=TOPSECRET-1234',
    );

    const files = discoverFiles(root);
    classifyMuleDiscovery(root, files);
    const secure = files.find((f) => f.path === 'app/src/main/resources/secure.properties')!;
    const node = fileNode(root, secure);
    expect(node.hash).toMatch(/^blake3:[0-9a-f]+$/);
    // The secret value must not appear anywhere in the node's hash.
    expect(node.hash).not.toContain('TOPSECRET');
    // Same keys → same hash even if the value differs.
    writeFileSync(
      join(root, 'app/src/main/resources/secure.properties'),
      'db.password=different-value-5678',
    );
    const files2 = discoverFiles(root);
    classifyMuleDiscovery(root, files2);
    const secure2 = files2.find((f) => f.path === 'app/src/main/resources/secure.properties')!;
    expect(fileNode(root, secure2).hash).toBe(node.hash);
  });
});
