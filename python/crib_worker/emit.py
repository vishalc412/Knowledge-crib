"""Build the worker's JSON payload (pure, no I/O).

The contract is intentionally minimal — the TS ingest layer computes the soul-conformant node id
(`media:<path>#<tStartMs>`) and the blake3 content hash; the worker only reports timing + text +
modality per segment. This keeps hashing deterministic and soul-side, and means a worker payload
round-trips through the TS layer with no Python-side dependency on the soul schema.
"""
from __future__ import annotations

from typing import Iterable, Mapping, TypedDict

SCHEMA_VERSION = "1.1"


class Segment(TypedDict):
    tStartMs: int
    tEndMs: int
    text: str
    lang: str | None


def segment(t_start_ms: int, t_end_ms: int, text: str, lang: str | None = "en") -> Segment:
    """Construct one transcript/OCR segment with millisecond timing."""
    return {"tStartMs": int(t_start_ms), "tEndMs": int(t_end_ms), "text": text, "lang": lang}


def build_payload(
    file: str,
    modality: str,
    segments: Iterable[Mapping[str, object]],
    schema_version: str = SCHEMA_VERSION,
) -> dict[str, object]:
    """Wrap a backend's segments in the worker → TS contract envelope.

    Always returns a valid envelope (possibly with an empty segment list) so the TS side never has to
    handle a missing field. `dropped` counts segments a backend intentionally threw away (corrupt
    pages, undecodable audio); it is informational only.
    """
    segs = [dict(s) for s in segments]
    return {
        "schemaVersion": schema_version,
        "file": file,
        "modality": modality,
        "segments": segs,
        "dropped": 0,
    }


def empty_payload(file: str, modality: str, dropped: int = 1) -> dict[str, object]:
    """A degradation payload: no segments, never a throw."""
    return {
        "schemaVersion": SCHEMA_VERSION,
        "file": file,
        "modality": modality,
        "segments": [],
        "dropped": dropped,
    }