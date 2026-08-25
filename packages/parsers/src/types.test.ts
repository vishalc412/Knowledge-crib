import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type {
  Capabilities,
  ExtractDiagnostic,
  ExtractResult,
  FileClassification,
  FileMeta,
  MuleFileRole,
} from './types.js';

describe('extractor contracts', () => {
  it('carries clone-safe Mule classification and diagnostics', () => {
    const file: FileMeta = {
      path: 'app/src/main/mule/api.xml',
      bytes: 12,
      mtime: 1,
      classification: {
        family: 'mule',
        projectId: 'app',
        projectRoot: 'app',
        dialect: 'mule4',
        role: 'config',
      },
    };
    const diagnostic: ExtractDiagnostic = {
      code: 'mule:unsupported-expression',
      severity: 'warning',
      message: 'dynamic flow name',
      file: file.path,
      projectId: 'app',
      span: { start: 4, end: 4 },
    };
    expect(structuredClone({ file, diagnostic })).toEqual({ file, diagnostic });
  });

  it('keeps non-Mule FileMeta valid without classification', () => {
    const file: FileMeta = { path: 'src/index.ts', bytes: 1, mtime: 1 };
    expect(file.classification).toBeUndefined();
  });

  it('keeps ExtractResult valid without diagnostics (existing extractors)', () => {
    const result: ExtractResult = { nodes: [] as Node[], edges: [] as Edge[] };
    expect(result.diagnostics).toBeUndefined();
  });

  it('covers every Mule file role', () => {
    const roles: MuleFileRole[] = [
      'config',
      'dataweave',
      'mel',
      'raml',
      'munit',
      'descriptor',
      'properties',
      'resource',
    ];
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('marks sensitive secure property classifications', () => {
    const classification: FileClassification = {
      family: 'mule',
      projectId: 'app',
      projectRoot: 'app',
      dialect: 'mule4',
      role: 'properties',
      sensitive: true,
    };
    expect(classification.sensitive).toBe(true);
  });

  it('capability matrix stays compatible with non-source extractors', () => {
    const muleCaps: Capabilities = {
      imports: true,
      calls: true,
      inheritance: false,
      types: 'none',
    };
    expect(muleCaps.inheritance).toBe(false);
  });
});
