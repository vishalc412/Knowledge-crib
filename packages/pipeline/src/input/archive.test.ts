import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import {
  ARCHIVE_LIMITS,
  ArchiveExtractionError,
  extractArchive,
  safeArchiveRelativePath,
} from './archive.js';
import { prepareSourceInput } from './prepared-source.js';

/** Build an in-memory ZIP from {path, data} entries via yazl (deflated, realistic). */
function buildZip(dest: string, entries: Array<{ path: string; data: Buffer }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const zf = new yazl.ZipFile();
    for (const e of entries) zf.addBuffer(e.data, e.path);
    zf.outputStream.on('error', reject);
    const { createWriteStream } = require('node:fs') as typeof import('node:fs');
    zf.outputStream.pipe(createWriteStream(dest)).on('finish', resolve).on('error', reject);
    zf.end();
  });
}

/** Build a ZIP from STORED (uncompressed) entries with FULL control over entry names — so the test
 *  can craft names yazl refuses to build (traversal, trailing-slash dirs). Minimal hand-rolled ZIP:
 *  local headers + data + central directory + EOCD. */
function buildRawZip(dest: string, entries: Array<{ path: string; data: Buffer }>): void {
  const u16 = (n: number): Buffer => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 0xffff, 0);
    return b;
  };
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method (stored)
      u16(0),
      u16(0), // mod time/date
      u32(crc),
      u32(e.data.length),
      u32(e.data.length), // crc, comp, uncomp
      u16(name.length),
      u16(0), // name len, extra len
      name,
      e.data,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50), // central directory header signature
        u16(20),
        u16(20), // version made by / needed
        u16(0),
        u16(0), // flags, method
        u16(0),
        u16(0), // mod time/date
        u32(crc),
        u32(e.data.length),
        u32(e.data.length), // crc, comp, uncomp
        u16(name.length),
        u16(0),
        u16(0), // name/extra/comment len
        u16(0),
        u16(0),
        u32(0), // disk, internal, external attrs
        u32(offset), // local header offset
        name,
      ]),
    );
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), // EOCD signature
    u16(0),
    u16(0), // disk num / disk with cd
    u16(entries.length),
    u16(entries.length), // cd entries on this / total disk
    u32(cd.length),
    u32(offset), // cd size, cd offset
    u16(0), // comment len
  ]);
  writeFileSync(dest, Buffer.concat([...locals, cd, eocd]));
}

describe('safeArchiveRelativePath', () => {
  it('keeps a clean nested path', () => {
    expect(safeArchiveRelativePath('src/main/mule/api.xml')).toBe('src/main/mule/api.xml');
  });
  it('rejects an absolute path', () => {
    expect(() => safeArchiveRelativePath('/etc/passwd')).toThrow(ArchiveExtractionError);
  });
  it('rejects a Windows drive-relative path', () => {
    expect(() => safeArchiveRelativePath('C:/Windows/System32/x')).toThrow(ArchiveExtractionError);
  });
  it('rejects backslash traversal normalized to forward slashes', () => {
    expect(() => safeArchiveRelativePath('..\\..\\escape')).toThrow(ArchiveExtractionError);
  });
  it('rejects a leading-dotdot segment', () => {
    expect(() => safeArchiveRelativePath('../escape.txt')).toThrow(ArchiveExtractionError);
  });
  it('rejects a mid-path traversal segment', () => {
    expect(() => safeArchiveRelativePath('a/../../b')).toThrow(ArchiveExtractionError);
  });
  it('rejects an empty name', () => {
    expect(() => safeArchiveRelativePath('')).toThrow(ArchiveExtractionError);
  });
  it('collapses "." and empty segments', () => {
    expect(safeArchiveRelativePath('a/./b/')).toBe('a/b');
  });
  it('rejects a NUL byte', () => {
    expect(() => safeArchiveRelativePath('evil\0.txt')).toThrow(ArchiveExtractionError);
  });
});

describe('extractArchive', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crib-arch-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('extracts a well-formed multi-file archive', async () => {
    const zip = join(root, 'app.zip');
    await buildZip(zip, [
      { path: 'mule-artifact.json', data: Buffer.from('{"minMuleVersion":"4.4.0"}') },
      {
        path: 'src/main/mule/flow.xml',
        data: Buffer.from('<mule xmlns="http://www.mulesoft.org/schema/mule/core"/>'),
      },
    ]);
    const dest = join(root, 'out');
    const result = await extractArchive(zip, dest);
    expect(result.entries).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(dest, 'mule-artifact.json'), 'utf8')).toContain('4.4.0');
    expect(readFileSync(join(dest, 'src/main/mule/flow.xml'), 'utf8')).toContain('<mule');
  });

  it('creates directory entries and nested files', async () => {
    const zip = join(root, 'app.zip');
    buildRawZip(zip, [
      { path: 'src/', data: Buffer.alloc(0) },
      { path: 'src/main/', data: Buffer.alloc(0) },
      { path: 'src/main/mule/', data: Buffer.alloc(0) },
      { path: 'src/main/mule/api.xml', data: Buffer.from('<mule/>') },
    ]);
    const dest = join(root, 'out');
    await extractArchive(zip, dest);
    expect(existsSync(join(dest, 'src/main/mule/api.xml'))).toBe(true);
    expect(statSync(join(dest, 'src/main/mule')).isDirectory()).toBe(true);
  });

  it('rejects a traversal entry and never writes outside destRoot', async () => {
    const zip = join(root, 'evil.zip');
    buildRawZip(zip, [
      { path: 'safe.txt', data: Buffer.from('ok') },
      { path: '../escape.txt', data: Buffer.from('pwned') },
    ]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest)).rejects.toBeInstanceOf(ArchiveExtractionError);
    // The traversal entry must NOT have escaped destRoot — nothing written at the parent level.
    expect(existsSync(join(root, 'escape.txt'))).toBe(false);
    // extractArchive writes entries incrementally; cache-level atomicity (a failed extraction never
    // replaces a good cache) is the caller's job via staging+swap+discard (see prepareSourceInput).
    expect(existsSync(join(dest, 'safe.txt'))).toBe(true);
  });

  it('rejects a duplicate entry', async () => {
    const zip = join(root, 'dup.zip');
    await buildZip(zip, [
      { path: 'a.txt', data: Buffer.from('1') },
      { path: 'a.txt', data: Buffer.from('2') },
    ]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest)).rejects.toThrow(/duplicate/i);
  });

  it('rejects a case-colliding entry', async () => {
    const zip = join(root, 'case.zip');
    await buildZip(zip, [
      { path: 'Mule.xml', data: Buffer.from('1') },
      { path: 'mule.xml', data: Buffer.from('2') },
    ]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest)).rejects.toThrow(/case/i);
  });

  it('enforces the total-bytes limit', async () => {
    const zip = join(root, 'big.zip');
    await buildZip(zip, [{ path: 'big.bin', data: Buffer.alloc(10) }]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest, { ...ARCHIVE_LIMITS, totalBytes: 5 })).rejects.toThrow(
      /total limit/i,
    );
  });
});

describe('prepareSourceInput', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crib-prep-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes a directory through with <dir>/.crib', async () => {
    const dir = join(root, 'proj');
    const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(join(dir, 'src/main/mule'), { recursive: true });
    writeFileSync(join(dir, 'mule-artifact.json'), '{}');
    const prepared = await prepareSourceInput(dir, {});
    expect(prepared.kind).toBe('directory');
    expect(prepared.sourceRoot).toBe(dir);
    expect(prepared.cribDir).toBe(join(dir, '.crib'));
    expect(prepared.fingerprint).toBe('');
  });

  it('extracts an archive once and hits the cache on a repeat call', async () => {
    const importsDir = join(root, 'imports');
    const archive = join(root, 'app.jar');
    await buildZip(archive, [
      { path: 'mule-artifact.json', data: Buffer.from('{"minMuleVersion":"4.4.0"}') },
    ]);

    const first = await prepareSourceInput(archive, { importsDir });
    const second = await prepareSourceInput(archive, { importsDir });

    expect(first.kind).toBe('jar');
    expect(second.projectKey).toBe(first.projectKey);
    expect(second.sourceRoot).toBe(first.sourceRoot);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(readFileSync(join(second.sourceRoot, 'mule-artifact.json'), 'utf8')).toContain('4.4.0');
  });

  it('re-extracts when the archive content changes (fingerprint differs)', async () => {
    const importsDir = join(root, 'imports');
    const archive = join(root, 'app.zip');
    await buildZip(archive, [
      { path: 'mule-artifact.json', data: Buffer.from('{"minMuleVersion":"4.3.0"}') },
    ]);
    const first = await prepareSourceInput(archive, { importsDir });

    // Rewrite the archive at the same path with different content.
    await buildZip(archive, [
      {
        path: 'mule-artifact.json',
        data: Buffer.from('{"minMuleVersion":"4.5.0","redeploy":true}'),
      },
    ]);
    const second = await prepareSourceInput(archive, { importsDir });

    expect(second.projectKey).toBe(first.projectKey);
    expect(second.sourceRoot).toBe(first.sourceRoot);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(readFileSync(join(second.sourceRoot, 'mule-artifact.json'), 'utf8')).toContain(
      'redeploy',
    );
  });

  it('respects an explicit cribDir for archives', async () => {
    const importsDir = join(root, 'imports');
    const cribDir = join(root, 'custom-crib');
    const archive = join(root, 'app.zip');
    await buildZip(archive, [{ path: 'mule-artifact.json', data: Buffer.from('{}') }]);
    const prepared = await prepareSourceInput(archive, { importsDir, cribDir });
    expect(prepared.cribDir).toBe(cribDir);
  });

  it('throws on a non-existent input', async () => {
    await expect(prepareSourceInput(join(root, 'nope.zip'), {})).rejects.toThrow(/not found/i);
  });
});
