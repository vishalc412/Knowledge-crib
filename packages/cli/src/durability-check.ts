/**
 * The `crib doctor` durability line — the surface that makes WP1 obligation 2's *"surface unsupported
 * guarantees explicitly"* observable, instead of a documented limit that lives only in
 * `docs/design/02-lld.md`.
 *
 * WHY THIS IS ITS OWN MODULE. The check is three-valued (`fileFlush`, `dirFlush`, `powerLossDurable`)
 * and the whole point is that the sentence shown to an operator matches the capability the platform
 * actually has. A check built inline inside `cmdDoctor` can only be tested by running the entire
 * doctor against an indexed repo, so the honesty of the wording would be the one thing no test could
 * pin — and the wording is precisely where the honesty lives. Taking the platform as a parameter
 * (defaulting to the real one) means the darwin wording is assertable on every host.
 *
 * WHAT `ok` MEANS, AND WHAT IT DELIBERATELY DOES NOT. `ok` tracks the barriers the platform can
 * PERFORM, not power-loss durability. On darwin the two differ, and marking the primary platform ✗
 * for a limitation no Node program can escape would be a false alarm that trains operators to ignore
 * the check. Power-loss durability is reported in the `detail` instead — named as explicitly not
 * claimed — because that is a claim about the hardware, not a fault in the repo.
 *
 * `false/false` IS a real ✗: when the probe finds no file flush at all, the acknowledgement is back
 * to being a page-cache claim, which is the defect this workstream exists to remove.
 */
import { type AtomicWriteDurability, atomicWriteDurability } from '@knowledge-crib/core';

/** The shape `cmdDoctor` pushes into its `checks` array. */
export interface DurabilityCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

/** Where the probe fails is where the writes will fail too, so the fix points at the mount. */
const MOUNT_FIX =
  'keep `.crib` (and the OS temp dir the probe writes through) on a local filesystem — network and some FUSE mounts are where the flush probe fails';

/**
 * The doctor check for one capability reading. Pure: same capability + platform in, same check out.
 */
export function durabilityDoctorCheck(
  capability: AtomicWriteDurability,
  platform: string = process.platform,
): DurabilityCheck {
  const { fileFlush, dirFlush, powerLossDurable } = capability;
  const flushesRename = fileFlush && dirFlush;
  if (!flushesRename) {
    return {
      name: 'durability model',
      ok: false,
      detail: fileFlush
        ? 'write: flush file → rename; the directory entry is not flushed, so a crash can lose the name while the bytes are safe'
        : 'write: rename only — an acknowledgement means "handed to the page cache" and does not survive a process crash',
      fix: MOUNT_FIX,
    };
  }
  return {
    name: 'durability model',
    ok: true,
    detail: powerLossDurable
      ? `write: flush file → rename → flush directory; ${platform} fsync transfers to the device and issues a cache flush, so an acknowledgement survives a process crash and is ordered on the device — power-loss durable modulo hardware that reports a flush it did not perform`
      : `write: flush file → rename → flush directory; ${platform} fsync is a host-to-device flush and the full barrier is unreachable without a native dependency, so an acknowledgement survives a PROCESS crash and is device-ordered — power-loss durability is NOT claimed`,
  };
}

/** The check for THIS process, probed once by `atomicWriteDurability`. */
export function durabilityCheck(): DurabilityCheck {
  return durabilityDoctorCheck(atomicWriteDurability());
}
