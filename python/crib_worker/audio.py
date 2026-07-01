"""The `audio` backend — faster-whisper, offline, deterministic greedy decoding.

Segments carry real millisecond timing from the model. Determinism: `beam_size=1` + `temperature=0`
+ a fixed `model_path` (no auto-download) → byte-identical output across runs. If faster-whisper is
not installed (no `uv sync --extra audio`), or no `--model-path` is given, or the audio is corrupt,
this degrades to an empty segment list — never raises. The caller MUST supply `--model-path` for a
real run; without it the worker stays offline (no network fetch).
"""
from __future__ import annotations

from .emit import Segment, segment


def extract(path: str, modality: str, model_path: str | None = None) -> list[Segment]:
    if not model_path:
        return []  # offline by default: never auto-download a model
    try:
        from faster_whisper import WhisperModel  # optional dep; import lazily
    except Exception:  # noqa: BLE001 — missing dep → degrade
        return []
    try:
        model = WhisperModel(model_path, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(
            path,
            beam_size=1,        # greedy
            temperature=0.0,    # deterministic
            vad_filter=True,
        )
        out: list[Segment] = []
        for s in segments:
            text = (s.text or "").strip()
            if text:
                out.append(segment(int(s.start * 1000), int(s.end * 1000), text, "en"))
        return out
    except Exception:  # noqa: BLE001 — corrupt audio / model error → degrade
        return []