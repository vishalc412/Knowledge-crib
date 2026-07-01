"""The `pdf` backend — pypdf, zero-model, offline.

One segment per page (tStartMs = page index × 1000ms), text = the page body. pypdf is a pure-Python
(Apache-2.0/BSD-3) library with no model and no network — the only backend that is genuinely cheap
to run for real. If pypdf is not installed (no `uv sync --extra pdf`), or the PDF is corrupt, this
degrades to an empty segment list — never raises.
"""
from __future__ import annotations

from .emit import Segment, segment

_PAGE_SEP_MS = 1000


def extract(path: str, modality: str, model_path: str | None = None) -> list[Segment]:
    try:
        from pypdf import PdfReader  # optional dep; import lazily
    except Exception:  # noqa: BLE001 — missing dep is a normal degradation, not a bug
        return []
    try:
        reader = PdfReader(path)
        out: list[Segment] = []
        for i, page in enumerate(reader.pages):
            text = (page.extract_text() or "").strip()
            if text:
                out.append(segment(i * _PAGE_SEP_MS, (i + 1) * _PAGE_SEP_MS, text, "en"))
        return out
    except Exception:  # noqa: BLE001 — corrupt PDF / read error → degrade
        return []