"""The `image` backend — surya OCR, offline.

One segment per detected text region with bounding-box-derived timing (top→ms). If surya is not
installed (no `uv sync --extra image`), or no `--model-path` is given, or the image is corrupt, this
degrades to an empty segment list — never raises. As with audio, the caller MUST supply
`--model-path`; the worker never fetches a model over the network.
"""
from __future__ import annotations

from .emit import Segment, segment

# Coarse vertical→ms scale so image text regions get ordered, comparable tStart/tEnd values.
_Y_MS_SCALE = 10


def extract(path: str, modality: str, model_path: str | None = None) -> list[Segment]:
    if not model_path:
        return []  # offline by default
    try:
        from surya.recognition import RecognitionPredictor  # optional dep; import lazily
        from surya.detection import DetectionPredictor
    except Exception:  # noqa: BLE001 — missing dep → degrade
        return []
    try:
        det = DetectionPredictor()
        rec = RecognitionPredictor()
        from PIL import Image  # type: ignore

        img = Image.open(path)
        predictions = rec([img], langs=["en"], det_predictor=det)
        out: list[Segment] = []
        for i, pred in enumerate(predictions or []):
            for line in getattr(pred, "text_lines", []) or []:
                text = (getattr(line, "text", "") or "").strip()
                if not text:
                    continue
                top = int(getattr(line, "polygon", None) and getattr(line.polygon[0], "y", 0) or 0)
                t0 = top * _Y_MS_SCALE
                t1 = t0 + len(text) * _Y_MS_SCALE
                out.append(segment(t0, t1, text, "en"))
        return out
    except Exception:  # noqa: BLE001 — corrupt image / model error → degrade
        return []