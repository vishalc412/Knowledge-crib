import { type AtomicWriteDurability, atomicWriteDurability } from '@knowledge-crib/core';
/**
 * WP1 defects D1-f and D1-g — the durability limit must not be docs-only, and on darwin the
 * acknowledgement must not claim more than `fsync` performs.
 *
 * D1-f: before WP1 the only place the durability limit existed was a row in
 * `docs/design/02-lld.md`'s failure table. A limit documented and nowhere reported is a limit the
 * operator cannot see, which is why obligation 2's exit criterion is *"persistence failures do not
 * produce successful acknowledgements"* and not merely *"the limit is written down"*.
 *
 * D1-g: on darwin `fsync` is a host-to-device flush, not a platter flush — `man 2 fsync` says the
 * drive "may not physically write the data to the platters for quite some time", and `F_FULLFSYNC`
 * is the barrier that would, unreachable from Node core without a native dependency. So a check
 * whose wording says "durable" because a flush happened would be a false claim on the platform this
 * product primarily runs on. `powerLossDurable` is the value that keeps that honest, and this file
 * pins the wording to it.
 *
 * WHAT MAKES THIS A TEST AND NOT A TRANSCRIPTION. The capability reading and the platform are both
 * parameters of {@link durabilityDoctorCheck}, so the darwin wording is asserted ON ANY HOST — a
 * linux CI runs the same assertions about darwin that a developer's laptop does, and vice versa.
 * The two platform readings asserted below are the two the probe can actually produce (`fsync`
 * reaching media is derived from `process.platform === 'linux'` in the primitive), so neither is a
 * hypothetical shape.
 *
 * HONESTY CONSTRAINT (spec §11.1). Nothing here asserts a power-loss guarantee, and nothing here
 * measures one. The subject is the Wording: what the diagnostic says, given a capability reading.
 * The agreement between that reading and the syscalls the writer actually issues is asserted in
 * `packages/core/src/atomic-write.test.ts`, where the fs primitives are instrumented.
 */
import { describe, expect, it } from 'vitest';
import { durabilityCheck, durabilityDoctorCheck } from './durability-check.js';

/** The reading a modern linux reaches: `fsync` transfers to the device and issues a cache flush. */
const LINUX: AtomicWriteDurability = {
  fileFlush: true,
  dirFlush: true,
  powerLossDurable: true,
};

/** The reading darwin reaches: both barriers perform, but neither survives power loss. */
const DARWIN: AtomicWriteDurability = {
  fileFlush: true,
  dirFlush: true,
  powerLossDurable: false,
};

describe('the doctor reports the durability model the platform actually provides', () => {
  it('names itself as a diagnosable check — D1-f: the limit has a surface, not only a doc row', () => {
    const check = durabilityDoctorCheck(DARWIN, 'darwin');

    expect(check.name).toBe('durability model');
    expect(check.detail.length).toBeGreaterThan(0);
  });

  it('does NOT claim power-loss durability where fsync stops at the drive — D1-g', () => {
    const check = durabilityDoctorCheck(DARWIN, 'darwin');

    // The barriers performed, so the store is not faulty: this is the honest ✓.
    expect(check.ok).toBe(true);
    // …but the sentence must not let an operator read it as a power-loss guarantee.
    expect(check.detail).toContain('power-loss durability is NOT claimed');
    expect(check.detail).toContain('darwin');
    // The exact defect D1-g names: an acknowledgement described as durable because a flush happened.
    expect(check.detail).not.toMatch(/power-loss durable modulo/i);
  });

  it('does not deny power-loss durability where fsync reaches the media — the mirror of D1-g', () => {
    const check = durabilityDoctorCheck(LINUX, 'linux');

    expect(check.ok).toBe(true);
    // A single sentence reused across platforms would have to be wrong on one of them. On linux the
    // deny-clause would be the false claim, so it must be absent.
    expect(check.detail).not.toContain('NOT claimed');
    expect(check.detail).toContain('linux');
    expect(check.detail).toMatch(/power-loss durable modulo hardware/i);
  });

  it('reports `false/false` as a real ✗, with a fix that names where writes can go', () => {
    const check = durabilityDoctorCheck(
      { fileFlush: false, dirFlush: false, powerLossDurable: false },
      'darwin',
    );

    expect(check.ok).toBe(false);
    // The acknowledgement is back to a page-cache claim — the defect this workstream removes.
    expect(check.detail).toContain('handed to the page cache');
    expect(check.detail).toContain('does not survive a process crash');
    expect(check.fix).toBeTruthy();
  });

  it('reports a working file flush with no directory flush as ✗, naming what is lost', () => {
    const check = durabilityDoctorCheck(
      { fileFlush: true, dirFlush: false, powerLossDurable: false },
      'win32',
    );

    expect(check.ok).toBe(false);
    // The asymmetry that matters operationally: the bytes are safe, the NAME is not.
    expect(check.detail).toContain('directory entry is not flushed');
    expect(check.detail).toContain('the bytes are safe');
    expect(check.fix).toBeTruthy();
  });

  it('always renders a ✗ with a fix — the remediation text is never empty (the D3-b failure mode)', () => {
    const readings: AtomicWriteDurability[] = [
      { fileFlush: false, dirFlush: false, powerLossDurable: false },
      { fileFlush: true, dirFlush: false, powerLossDurable: false },
      { fileFlush: false, dirFlush: true, powerLossDurable: false },
    ];

    for (const reading of readings) {
      const check = durabilityDoctorCheck(reading, 'darwin');
      expect(check.ok, JSON.stringify(reading)).toBe(false);
      // `cmdDoctor` prints the fix only when `!ok`; an `ok:false` with no fix would print a ✗ whose
      // operator-visible remediation is a dangling label — the same class of defect as a fix text
      // naming a command that does not do the thing.
      expect(check.fix?.length ?? 0, JSON.stringify(reading)).toBeGreaterThan(0);
    }
  });
});

describe('the live check agrees with the capability this process probed', () => {
  it('is derived from the probed reading, never asserted', () => {
    const probed = atomicWriteDurability();
    const check = durabilityCheck();

    // The check is a function of the probe on this host, for every shape the probe can return.
    expect(check).toEqual(durabilityDoctorCheck(probed));
    expect(check.ok).toBe(probed.fileFlush && probed.dirFlush);
  });

  it('only ever reports power-loss durability where the platform’s fsync reaches the media', () => {
    const probed = atomicWriteDurability();

    // The regression this catches: flipping `powerLossDurable` true without the platform to back it.
    if (probed.powerLossDurable) expect(process.platform).toBe('linux');
    // …and the one it catches in the other direction: the probe failing to notice a working barrier.
    if (!probed.fileFlush || !probed.dirFlush) expect(probed.powerLossDurable).toBe(false);
  });
});
