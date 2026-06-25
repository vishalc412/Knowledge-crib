"""The `fake` backend — pure-stdlib, deterministic, offline.

Reads a `<media>.txt` sidecar as the ground-truth transcript and emits one segment per non-empty
line (tStartMs = line index × 1000ms). This is the backend the gate tests exercise: it needs no
model, no network, and no third-party package, yet drives the full worker→TS contract (golden ids,
byte-stable hashes, member-of, cross-modal linker, determinism, degradation). A missing/unreadable
sidecar yields no segments — the same degradation path a real backend takes on corrupt media.
"""
from __future__ import annotations

from .emit import Segment, segment

_SIDEKICK_SEP_MS = 1000


def extract(path: str, modality: str, model_path: str | None = None) -> list[Segment]:
    sidecar = f"{path}.txt"
    try:
        with open(sidecar, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return []  # corrupt / missing sidecar → degrade, no throw
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    return [
        segment(i * _SIDEKICK_SEP_MS, (i + 1) * _SIDEKICK_SEP_MS, ln, "en")
        for i, ln in enumerate(lines)
    ]