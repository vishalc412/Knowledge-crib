import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALIASES_SCHEMA_VERSION,
  type AliasMap,
  loadAliases,
  parseAliases,
  rewriteQuery,
  writeAliases,
} from './aliases.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'crib-aliases-'));

describe('parseAliases', () => {
  it('loads entry-list shape ordered, first-write-wins', () => {
    const map = parseAliases({
      version: 1,
      aliases: [
        { alias: 'DTI', expand: 'debt to income' },
        { alias: 'LTV', expand: 'loan to value' },
        { alias: 'DTI', expand: 'duplicate' }, // ignored — first wins
        { alias: '', expand: 'empty alias' }, // dropped
        { alias: 'bad', expand: '' }, // dropped
      ],
    });
    expect(map.size).toBe(2);
    expect(map.get('DTI')).toBe('debt to income');
    expect(map.get('LTV')).toBe('loan to value');
  });

  it('tolerates legacy plain-string-map', () => {
    const map = parseAliases({ DTI: 'debt to income', LTV: 'loan to value' });
    expect(map.size).toBe(2);
    expect(map.get('DTI')).toBe('debt to income');
  });

  it('returns empty map for non-object/empty input', () => {
    expect(parseAliases(null).size).toBe(0);
    expect(parseAliases(undefined).size).toBe(0);
    expect(parseAliases('string').size).toBe(0);
    expect(parseAliases({}).size).toBe(0);
  });
});

describe('rewriteQuery', () => {
  it('no-op with empty map (zero regression baseline)', () => {
    const empty: AliasMap = new Map();
    expect(rewriteQuery('DTI calculator', empty)).toBe('DTI calculator');
    expect(rewriteQuery('', empty)).toBe('');
  });

  it('appends expansion for whole-word alias match', () => {
    const map = new Map<string, string>([['DTI', 'debt to income']]);
    // "DTI" sits between word boundaries → expansion appended; original text preserved.
    expect(rewriteQuery('DTI', map)).toBe('DTI debt to income');
    expect(rewriteQuery('how does DTI work', map)).toBe('how does DTI work debt to income');
  });

  it('does NOT fire on substring alias (case-sensitive whole word)', () => {
    const map = new Map<string, string>([['DTI', 'debt to income']]);
    // "dti" lowercase inside a token — must not fire.
    expect(rewriteQuery('the dtiCalculator path', map)).toBe('the dtiCalculator path');
    // Bare lowercase "dti" also must not fire (case-sensitive).
    expect(rewriteQuery('dti threshold', map)).toBe('dti threshold');
    // "DTI" as a true substring inside a larger token must not fire.
    expect(rewriteQuery('ADTIVE thing', map)).toBe('ADTIVE thing');
  });

  it('appends multiple aliases in first-seen order', () => {
    const map = new Map<string, string>([
      ['DTI', 'debt to income'],
      ['LTV', 'loan to value'],
      ['AML', 'anti money laundering'],
    ]);
    expect(rewriteQuery('DTI and LTV gates', map)).toBe(
      'DTI and LTV gates debt to income loan to value',
    );
  });

  it('expands the same alias once even if it appears twice in text', () => {
    const map = new Map<string, string>([['DTI', 'debt to income']]);
    expect(rewriteQuery('DTI DTI', map)).toBe('DTI DTI debt to income');
  });

  it('is deterministic (same input → same output)', () => {
    const map = new Map<string, string>([
      ['DTI', 'debt to income'],
      ['LTV', 'loan to value'],
    ]);
    const a = rewriteQuery('check DTI and LTV limits', map);
    const b = rewriteQuery('check DTI and LTV limits', map);
    expect(a).toBe(b);
  });
});

describe('loadAliases', () => {
  it('absent file returns empty map (common no-dict case)', () => {
    const dir = tmp();
    try {
      expect(loadAliases(dir).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unreadable/invalid JSON returns empty map', () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, 'llm'), { recursive: true });
      writeFileSync(join(dir, 'llm', 'aliases.json'), '{ not valid json', 'utf8');
      expect(loadAliases(dir).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeAliases + loadAliases', () => {
  it('round-trip committed shape', () => {
    const dir = tmp();
    try {
      writeAliases(dir, [
        { alias: 'DTI', expand: 'debt to income' },
        { alias: 'LTV', expand: 'loan to value' },
      ]);
      const map = loadAliases(dir);
      expect(map.size).toBe(2);
      expect(map.get('DTI')).toBe('debt to income');
      expect(map.get('LTV')).toBe('loan to value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ALIASES_SCHEMA_VERSION', () => {
  it('exposed as a non-empty string for assertions', () => {
    expect(typeof ALIASES_SCHEMA_VERSION).toBe('string');
    expect(ALIASES_SCHEMA_VERSION.length).toBeGreaterThan(0);
  });
});
