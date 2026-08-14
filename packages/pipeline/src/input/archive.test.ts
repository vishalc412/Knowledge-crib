import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import {
  ARCHIVE_LIMITS,
  ArchiveExtractionError,
  type ArchiveLimits,
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

/** Build a STORED (method 0) ZIP with FULL control over per-entry central-directory metadata — method,
 *  flags, declared compressed/uncompressed sizes, and external attributes — so a test can craft the
 *  adversarial shapes yauzl must reject at emit time WITHOUT allocating the declared expanded sizes.
 *
 *  yauzl emits each entry from the central directory BEFORE reading its local header (validateEntrySizes
 *  runs in openReadStream, which a rejected entry never reaches), so a central directory that claims a
 *  100 MiB+1 entry, a symlink mode, or an encrypted flag triggers extractArchive's validate() at the
 *  `entry` event and is rejected before any byte of the (absent) payload is read. The local header is
 *  written with the SAME sizes/method/flags as the central record so a passing entry's stream is sound. */
interface CraftedEntry {
  name: string;
  data?: Buffer;
  method?: number; // default 0 (stored)
  flags?: number; // default 0
  compressedSize?: number; // value written to BOTH local + central headers (default data.length)
  uncompressedSize?: number; // value written to BOTH local + central headers (default compressedSize)
  externalAttrs?: number; // default 0
}
function craftZip(dest: string, entries: CraftedEntry[]): void {
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
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data ?? Buffer.alloc(0);
    const crc = crc32(data) >>> 0;
    const method = e.method ?? 0;
    const flags = e.flags ?? 0;
    const compSize = e.compressedSize ?? data.length;
    const uncompSize = e.uncompressedSize ?? compSize;
    const extAttrs = e.externalAttrs ?? 0;
    const local = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(flags),
      u16(method),
      u16(0),
      u16(0), // mod time/date
      u32(crc),
      u32(compSize),
      u32(uncompSize), // crc, comp, uncomp
      u16(name.length),
      u16(0), // name len, extra len
      name,
      data,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50), // central directory header signature
        u16(20),
        u16(20), // version made by / needed
        u16(flags),
        u16(method),
        u16(0),
        u16(0), // mod time/date
        u32(crc),
        u32(compSize),
        u32(uncompSize), // crc, comp, uncomp
        u16(name.length),
        u16(0),
        u16(0), // name/extra/comment len
        u16(0),
        u16(0),
        u32(extAttrs), // disk, internal, external attrs
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

describe('ARCHIVE_LIMITS defaults', () => {
  it('matches the documented attack-matrix thresholds', () => {
    expect(ARCHIVE_LIMITS.entries).toBe(50_000);
    expect(ARCHIVE_LIMITS.entryBytes).toBe(100 * 1024 * 1024);
    expect(ARCHIVE_LIMITS.totalBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(ARCHIVE_LIMITS.compressionRatio).toBe(100);
  });
});

describe('extractArchive: adversarial attack matrix', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crib-adv-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Each case crafts a central-directory entry whose metadata triggers a specific validate() guard at
  // emit time. yauzl emits from the central directory before reading the local header, so none of these
  // allocate the declared expanded payload — the rejection fires before openReadStream.

  it('rejects a NUL byte in an entry name', async () => {
    const zip = join(root, 'nul.zip');
    buildRawZip(zip, [{ path: 'evil\0.txt', data: Buffer.from('x') }]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest)).rejects.toThrow(/NUL/i);
    expect(existsSync(join(dest, 'evil'))).toBe(false);
  });

  it('rejects a backslash-traversal entry and never writes outside destRoot', async () => {
    const zip = join(root, 'bs.zip');
    buildRawZip(zip, [
      { path: 'safe.txt', data: Buffer.from('ok') },
      { path: '..\\..\\escape.txt', data: Buffer.from('pwned') },
    ]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest)).rejects.toBeInstanceOf(ArchiveExtractionError);
    expect(existsSync(join(root, 'escape.txt'))).toBe(false);
  });

  it('rejects a symlink Unix mode', async () => {
    const zip = join(root, 'sym.zip');
    craftZip(zip, [{ name: 'link', data: Buffer.from('x'), externalAttrs: 0o120000 << 16 }]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest)).rejects.toThrow(/unsupported entry mode/i);
  });

  it('rejects a non-regular device/fifo mode (hardlink-class special entry)', async () => {
    const zip = join(root, 'fifo.zip');
    craftZip(zip, [{ name: 'dev', data: Buffer.from('x'), externalAttrs: 0o010000 << 16 }]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest)).rejects.toThrow(/unsupported entry mode/i);
  });

  it('rejects duplicate normalized paths', async () => {
    const zip = join(root, 'dupnorm.zip');
    buildRawZip(zip, [
      { path: 'a/b.txt', data: Buffer.from('1') },
      { path: 'a/./b.txt', data: Buffer.from('2') },
    ]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest)).rejects.toThrow(/duplicate/i);
  });

  it('rejects an encrypted entry (flags bit 0)', async () => {
    const zip = join(root, 'enc.zip');
    // yauzl's stored-size check (validateEntrySizes) expects compressedSize === uncompressedSize + 12
    // for an encrypted STORED entry (the 12-byte traditional-encryption header). Set comp = uncomp + 12
    // so yauzl emits the `entry` event, letting extractArchive's isEncrypted() guard reject it —
    // otherwise yauzl emits `error` first and the /encrypted/ branch never runs.
    craftZip(zip, [
      {
        name: 'secret.txt',
        data: Buffer.from('x'),
        flags: 0x1,
        uncompressedSize: 1,
        compressedSize: 13,
      },
    ]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest)).rejects.toThrow(/encrypted/i);
  });

  it('rejects an unsupported compression method (deflate64 / method 9)', async () => {
    const zip = join(root, 'comp.zip');
    craftZip(zip, [{ name: 'x.bin', data: Buffer.from('x'), method: 9 }]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest)).rejects.toThrow(/unsupported compression method/i);
  });

  it('rejects an archive exceeding the entry count (lowered limit)', async () => {
    const zip = join(root, 'count.zip');
    buildRawZip(
      zip,
      Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, data: Buffer.from('x') })),
    );
    const dest = join(root, 'out');
    // `entries` is a literal type (50000) under ARCHIVE_LIMITS' `as const`, so the override is cast
    // through `unknown` — the default constant itself is asserted in the ARCHIVE_LIMITS defaults test.
    const lowered = { ...ARCHIVE_LIMITS, entries: 4 } as unknown as ArchiveLimits;
    await expect(extractArchive(zip, dest, lowered)).rejects.toThrow(/too many entries/i);
  });

  it('rejects a single entry declared over the default per-entry limit (100 MiB+1, no allocation)', async () => {
    const zip = join(root, 'perentry.zip');
    craftZip(zip, [
      {
        name: 'huge.bin',
        // Declared uncompressed size one byte over the 100 MiB default per-entry limit. No payload is
        // allocated: yauzl emits the entry from the central directory and validate() rejects it at the
        // entryBytes guard before openReadStream reads a single byte.
        uncompressedSize: ARCHIVE_LIMITS.entryBytes + 1,
        compressedSize: ARCHIVE_LIMITS.entryBytes + 1,
      },
    ]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest)).rejects.toThrow(/per-entry limit/i);
  });

  it('rejects a compression-ratio bomb over 100:1 (no allocation)', async () => {
    const zip = join(root, 'bomb.zip');
    craftZip(zip, [
      {
        name: 'bomb.bin',
        method: 8, // deflate (so comp != uncomp is a believable lie the ratio guard catches)
        data: Buffer.from('x'), // 1 byte of real payload
        compressedSize: 1,
        uncompressedSize: 1000, // 1000:1 ratio > the 100 guard
      },
    ]);
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest)).rejects.toThrow(/compression ratio/i);
  });

  it('rejects when accumulated uncompressed size exceeds the total limit (lowered, real entries)', async () => {
    // The DEFAULT total limit is 2 GiB (asserted above), but it cannot be exercised via patched
    // metadata: yauzl's validateEntrySizes enforces compressedSize === uncompressedSize for STORED
    // entries at emit time, and wraps DEFLATE output in an AssertByteCountStream(uncompressedSize), so
    // every entry that passes emit must actually carry its declared uncompressed bytes. Crossing 2 GiB
    // would require 2 GiB of real allocation. The branch is instead proven here with a lowered limit
    // and three real 2-byte STORED entries whose running total (2, 4, 6) crosses 5 — entry 3 is rejected
    // at the totalBytes guard at emit time, before its stream opens.
    const zip = join(root, 'total.zip');
    buildRawZip(
      zip,
      Array.from({ length: 3 }, (_, i) => ({ path: `f${i}.txt`, data: Buffer.from('xx') })),
    );
    const dest = join(root, 'out');
    await expect(extractArchive(zip, dest, { ...ARCHIVE_LIMITS, totalBytes: 5 })).rejects.toThrow(
      /total limit/i,
    );
  });
});

describe('extractArchive: valid Mule archive shapes', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crib-shape-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('extracts a nested single project', async () => {
    const zip = join(root, 'app.zip');
    await buildZip(zip, [
      { path: 'mule-artifact.json', data: Buffer.from('{"minMuleVersion":"4.4.0"}') },
      {
        path: 'src/main/mule/api.xml',
        data: Buffer.from('<mule xmlns="http://www.mulesoft.org/schema/mule/core"/>'),
      },
      { path: 'src/main/mule/sub/flow.xml', data: Buffer.from('<mule/>') },
    ]);
    const dest = join(root, 'out');
    await extractArchive(zip, dest);
    expect(readFileSync(join(dest, 'mule-artifact.json'), 'utf8')).toContain('4.4.0');
    expect(readFileSync(join(dest, 'src/main/mule/api.xml'), 'utf8')).toContain('<mule');
    expect(existsSync(join(dest, 'src/main/mule/sub/flow.xml'))).toBe(true);
  });

  it('extracts two projects in one ZIP', async () => {
    const zip = join(root, 'multi.zip');
    await buildZip(zip, [
      { path: 'proj1/mule-artifact.json', data: Buffer.from('{}') },
      { path: 'proj1/src/main/mule/a.xml', data: Buffer.from('<mule/>') },
      { path: 'proj2/mule-artifact.json', data: Buffer.from('{}') },
      { path: 'proj2/src/main/mule/b.xml', data: Buffer.from('<mule/>') },
    ]);
    const dest = join(root, 'out');
    await extractArchive(zip, dest);
    expect(existsSync(join(dest, 'proj1/src/main/mule/a.xml'))).toBe(true);
    expect(existsSync(join(dest, 'proj2/src/main/mule/b.xml'))).toBe(true);
  });

  it('extracts a deployable JAR with root configuration', async () => {
    const zip = join(root, 'app.jar');
    await buildZip(zip, [
      { path: 'mule-artifact.json', data: Buffer.from('{"minMuleVersion":"4.4.0"}') },
      {
        path: 'api.xml',
        data: Buffer.from('<mule xmlns="http://www.mulesoft.org/schema/mule/core"/>'),
      },
      { path: 'classes/com/acme/Main.class', data: Buffer.from('CAFEBABE') },
      { path: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
    ]);
    const dest = join(root, 'out');
    await extractArchive(zip, dest);
    expect(readFileSync(join(dest, 'mule-artifact.json'), 'utf8')).toContain('4.4.0');
    expect(readFileSync(join(dest, 'api.xml'), 'utf8')).toContain('<mule');
    expect(existsSync(join(dest, 'classes/com/acme/Main.class'))).toBe(true);
  });

  it('extracts a JAR carrying both packaged XML and attached META-INF/mule-src', async () => {
    // A deployable JAR built with attached sources carries the original XML under
    // META-INF/mule-src/main/mule/ AND a packaged copy under classes/. Both are physically present
    // after extraction; precedence (attached source wins, packaged skipped) is a classify-layer concern
    // exercised in the mule classify tests, not the archive layer.
    const zip = join(root, 'app.jar');
    await buildZip(zip, [
      { path: 'mule-artifact.json', data: Buffer.from('{}') },
      {
        path: 'classes/api.xml',
        data: Buffer.from('<mule xmlns="http://www.mulesoft.org/schema/mule/core"/>'),
      },
      {
        path: 'META-INF/mule-src/main/mule/api.xml',
        data: Buffer.from('<mule xmlns="http://www.mulesoft.org/schema/mule/core"/>'),
      },
    ]);
    const dest = join(root, 'out');
    await extractArchive(zip, dest);
    expect(existsSync(join(dest, 'classes/api.xml'))).toBe(true);
    expect(existsSync(join(dest, 'META-INF/mule-src/main/mule/api.xml'))).toBe(true);
  });
});

describe('prepareSourceInput: atomic failure semantics', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crib-atom-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a failed refresh leaves the previous source + fingerprint intact and no staging dir remains', async () => {
    const importsDir = join(root, 'imports');
    const archive = join(root, 'app.zip');
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const { readdirSync } = require('node:fs') as typeof import('node:fs');

    // 1. Build a valid cache.
    await buildZip(archive, [
      { path: 'mule-artifact.json', data: Buffer.from('{"minMuleVersion":"4.4.0"}') },
    ]);
    const first = await prepareSourceInput(archive, { importsDir });
    const sourceFile = join(first.sourceRoot, 'mule-artifact.json');
    const originalContent = readFileSync(sourceFile, 'utf8');
    // The cache manifest lives under <importsDir>/<sha256(realpath(projectKey))> — recompute that dir.
    const manifestBase = join(
      importsDir,
      createHash('sha256').update(first.projectKey).digest('hex'),
    );
    const manifestFp = (
      JSON.parse(readFileSync(join(manifestBase, 'input.json'), 'utf8')) as {
        fingerprint: string;
      }
    ).fingerprint;
    expect(manifestFp).toBe(first.fingerprint);

    // 2. Overwrite the archive with a DIFFERENT (poisoned) byte stream so the fingerprint differs and a
    //    refresh re-extracts into staging. A traversal entry makes extractArchive reject.
    buildRawZip(archive, [
      { path: 'safe.txt', data: Buffer.from('changed-bytes') },
      { path: '../escape.txt', data: Buffer.from('pwned') },
    ]);
    const poisonedFp = createHash('sha256').update(readFileSync(archive)).digest('hex');
    expect(poisonedFp).not.toBe(first.fingerprint);

    // 3. The refresh must fail (staging extraction rejected) without touching the good cache.
    await expect(prepareSourceInput(archive, { importsDir })).rejects.toBeInstanceOf(
      ArchiveExtractionError,
    );

    // 4. The previous source file is unchanged.
    expect(readFileSync(sourceFile, 'utf8')).toBe(originalContent);
    // 5. The cache fingerprint manifest is unchanged — still the valid fingerprint, NOT the poisoned one
    //    (the failed refresh never rewrote input.json).
    const stillFp = (
      JSON.parse(readFileSync(join(manifestBase, 'input.json'), 'utf8')) as {
        fingerprint: string;
      }
    ).fingerprint;
    expect(stillFp).toBe(manifestFp);
    expect(stillFp).not.toBe(poisonedFp);
    // 6. No staging directory remains — the failed extraction discarded it.
    const remaining = readdirSync(manifestBase).filter((n) => n.startsWith('source.staging-'));
    expect(remaining).toEqual([]);
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
