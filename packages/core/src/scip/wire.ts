/**
 * A protobuf wire codec covering exactly the subset SCIP needs — and nothing else.
 *
 * WHY HAND-WRITTEN. `protobufjs` and `@bufbuild/protobuf` both work, and both cost more than this
 * file is worth here: the packaged CLI is budgeted under 5 MB with at most 6 runtime dependencies
 * (docs/capability-matrix.md), and SCIP uses a deliberately small slice of proto3 — no maps, no
 * groups, no 64-bit scalars, no floats, and every integer non-negative. Decoding that slice is the
 * ~120 lines below. A general-purpose runtime would add a dependency and a code-generation step to
 * read the same bytes.
 *
 * WHAT MAKES IT SAFE RATHER THAN MERELY SMALL. Two properties, both load-bearing:
 *
 *  1. UNKNOWN FIELDS ARE SKIPPED, NEVER FATAL. SCIP is a living standard under a steering committee
 *     that adds fields; an index written by a newer indexer must still decode. {@link skip} advances
 *     past any field this codec does not model, which is also what makes the deprecated/typed range
 *     duality in `Occurrence` tractable.
 *  2. EVERY READ IS BOUNDS-CHECKED. The input is a third-party file. A truncated or hostile varint
 *     must raise a named error, not read past the buffer or loop forever — so the varint reader caps
 *     at 10 bytes and every slice validates its end offset.
 */

/** Thrown on malformed input. Named so a caller can report "this is not a SCIP index" honestly. */
export class WireError extends Error {
  constructor(message: string) {
    super(`malformed protobuf: ${message}`);
    this.name = 'WireError';
  }
}

/** Proto3 wire types. Types 3 and 4 (start/end group) are proto2-only and never appear in SCIP. */
export const WIRE = {
  VARINT: 0,
  FIXED64: 1,
  LENGTH: 2,
  FIXED32: 5,
} as const;

/** One decoded field header plus its payload, as {@link fields} yields it. */
export interface Field {
  no: number;
  wire: number;
  /** Varint/fixed value (numbers), or the raw bytes of a length-delimited field. */
  varint: number;
  bytes?: Uint8Array;
}

/**
 * Read a base-128 varint at `pos`, returning the value and the offset just past it.
 *
 * Capped at 10 bytes: that is the maximum proto3 varint width, so a longer run is corruption rather
 * than a large number, and stopping is what keeps a hostile input from spinning here. Values are
 * returned as `number`, which is exact for everything SCIP encodes (field numbers, wire types, enum
 * values, lengths, and line/character offsets — all well inside 2^53).
 */
export function readVarint(buf: Uint8Array, pos: number): [value: number, next: number] {
  let result = 0;
  let shift = 0;
  let at = pos;
  for (let i = 0; i < 10; i++) {
    if (at >= buf.length) throw new WireError(`varint at ${pos} runs past the end of the buffer`);
    const byte = buf[at++] as number;
    // Multiply rather than shift: `<<` is 32-bit in JS and would silently wrap past the 5th byte.
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, at];
    shift += 7;
  }
  throw new WireError(`varint at ${pos} exceeds 10 bytes`);
}

/** Advance past a field whose contents this codec does not model. */
function skip(buf: Uint8Array, wire: number, pos: number): number {
  switch (wire) {
    case WIRE.VARINT:
      return readVarint(buf, pos)[1];
    case WIRE.FIXED64:
      if (pos + 8 > buf.length) throw new WireError(`fixed64 at ${pos} runs past the end`);
      return pos + 8;
    case WIRE.FIXED32:
      if (pos + 4 > buf.length) throw new WireError(`fixed32 at ${pos} runs past the end`);
      return pos + 4;
    case WIRE.LENGTH: {
      const [len, next] = readVarint(buf, pos);
      if (next + len > buf.length) throw new WireError(`length-delimited field at ${pos} overruns`);
      return next + len;
    }
    default:
      // Groups (3/4) are proto2 and absent from SCIP; anything else is corruption. Either way there
      // is no defined way to find the end of this field, so decoding cannot continue.
      throw new WireError(`unsupported wire type ${wire} at ${pos}`);
  }
}

/**
 * Iterate the fields of one encoded message. Lazy by design: a SCIP index for a large repository is
 * tens of megabytes, and the caller decodes documents one at a time rather than materializing every
 * sub-message first.
 */
export function* fields(buf: Uint8Array): Generator<Field> {
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos);
    const no = tag >>> 3;
    const wire = tag & 0x07;
    if (no === 0) throw new WireError(`field number 0 at ${pos}`);
    if (wire === WIRE.LENGTH) {
      const [len, afterLen] = readVarint(buf, afterTag);
      const end = afterLen + len;
      if (end > buf.length) throw new WireError(`field ${no} at ${pos} overruns the buffer`);
      yield { no, wire, varint: 0, bytes: buf.subarray(afterLen, end) };
      pos = end;
    } else if (wire === WIRE.VARINT) {
      const [value, next] = readVarint(buf, afterTag);
      yield { no, wire, varint: value };
      pos = next;
    } else {
      // Fixed-width: SCIP declares none, so surface it as an unmodelled field rather than guess.
      yield { no, wire, varint: 0 };
      pos = skip(buf, wire, afterTag);
    }
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: false });

/** Decode a length-delimited field as a UTF-8 string. Lone surrogates are replaced, never thrown. */
export function asString(field: Field): string {
  return field.bytes ? UTF8.decode(field.bytes) : '';
}

/**
 * Read a `repeated int32` field, accepting BOTH encodings.
 *
 * Proto3 defaults repeated scalars to packed, so `range` normally arrives as one length-delimited
 * run of varints — but the encoding is a choice of the writer, and an unpacked writer emits one
 * varint-typed field per element. A decoder that handled only the packed form would read empty
 * ranges from a conformant index, so both are folded into the same accumulator by the caller.
 */
export function appendInt32s(field: Field, into: number[]): void {
  if (field.wire === WIRE.VARINT) {
    into.push(field.varint);
    return;
  }
  const bytes = field.bytes;
  if (!bytes) return;
  let pos = 0;
  while (pos < bytes.length) {
    const [value, next] = readVarint(bytes, pos);
    into.push(value);
    pos = next;
  }
}

// ─── encoding ────────────────────────────────────────────────────────────────

/**
 * A growable output buffer.
 *
 * Length-delimited fields need their own length as a prefix, which is not known until the body is
 * written. Rather than pre-computing every nested size (two passes over the whole graph), a
 * sub-message is written into its own {@link Writer} and spliced in with its byte length — the
 * standard approach, and the reason {@link message} takes a callback.
 */
export class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;

  private need(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
  }

  private byte(value: number): void {
    this.need(1);
    this.buf[this.len++] = value;
  }

  varint(value: number): this {
    if (value < 0 || !Number.isFinite(value)) {
      // Every SCIP integer this codec writes is a count, an enum, or a 0-based offset. A negative
      // one means the caller computed something wrong, and encoding it as a 10-byte two's-complement
      // varint would hide that in a file someone else has to read.
      throw new WireError(`refusing to encode a negative or non-finite int32: ${value}`);
    }
    let rest = Math.trunc(value);
    while (rest >= 0x80) {
      this.byte((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    this.byte(rest);
    return this;
  }

  private tag(no: number, wire: number): this {
    return this.varint(no * 8 + wire);
  }

  /** Write a varint field. Omitted entirely when `value` is 0 — proto3 default-value semantics. */
  int32(no: number, value: number | undefined): this {
    if (!value) return this;
    return this.tag(no, WIRE.VARINT).varint(value);
  }

  bytes(no: number, payload: Uint8Array): this {
    if (payload.length === 0) return this;
    this.tag(no, WIRE.LENGTH).varint(payload.length);
    this.need(payload.length);
    this.buf.set(payload, this.len);
    this.len += payload.length;
    return this;
  }

  /** Write a string field. An empty string is omitted (proto3 default). */
  string(no: number, value: string | undefined): this {
    if (!value) return this;
    return this.bytes(no, new TextEncoder().encode(value));
  }

  /** Write a nested message, computing its length from what `build` actually wrote. */
  message(no: number, build: (w: Writer) => void): this {
    const inner = new Writer();
    build(inner);
    const payload = inner.finish();
    // An all-defaults sub-message still has to be written when its PRESENCE is the signal (e.g.
    // `Metadata.tool_info`), so emit the field even at zero length.
    this.tag(no, WIRE.LENGTH).varint(payload.length);
    this.need(payload.length);
    this.buf.set(payload, this.len);
    this.len += payload.length;
    return this;
  }

  /** Write a `repeated int32` in the packed form proto3 defaults to. */
  packedInt32(no: number, values: readonly number[]): this {
    if (values.length === 0) return this;
    const inner = new Writer();
    for (const value of values) inner.varint(value);
    return this.bytes(no, inner.finish());
  }

  /** Write a `repeated string` — one length-delimited field per element. */
  repeatedString(no: number, values: readonly string[] | undefined): this {
    for (const value of values ?? []) this.string(no, value);
    return this;
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}
