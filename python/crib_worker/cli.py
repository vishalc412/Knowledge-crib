"""crib_worker CLI entry — invoked as `python3 crib_worker/cli.py ...` by the TS ingest layer.

Usage:
  python3 cli.py [--backend fake|pdf|audio|image] [--modality m] [--model-path P] <media-path>

Emits ONE JSON payload (see emit.build_payload) on stdout and always exits 0. Any failure — missing
dep, missing model, corrupt media, bad args — degrades to an empty-payload JSON, never a non-zero
exit or a traceback. The TS side therefore never has to handle a worker crash.

Modality is inferred from the file extension when `--modality` is omitted:
  .pdf → pdf | .wav/.mp3/.m4a/.flac/.ogg → audio | .png/.jpg/.jpeg/.webp/.tif/.tiff → image
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Callable

from . import audio as audio_backend
from . import fake as fake_backend
from . import image as image_backend
from . import pdf as pdf_backend
from .emit import empty_payload

_EXT_MODALITY = {
    ".pdf": "pdf",
    ".wav": "audio",
    ".mp3": "audio",
    ".m4a": "audio",
    ".flac": "audio",
    ".ogg": "audio",
    ".mp4": "audio",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".tif": "image",
    ".tiff": "image",
}

_BACKENDS: dict[str, Callable[[str, str, str | None], list]] = {
    "fake": fake_backend.extract,
    "pdf": pdf_backend.extract,
    "audio": audio_backend.extract,
    "image": image_backend.extract,
}


def _infer_modality(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return _EXT_MODALITY.get(ext, "audio")


def _parse(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="crib_worker",
        description="Offline multimodal segment producer for knowledge-crib.",
    )
    p.add_argument("path", help="absolute path to the media file")
    p.add_argument("--backend", default="fake", choices=sorted(_BACKENDS))
    p.add_argument("--modality", default=None, help="pdf | audio | image (inferred from ext if omitted)")
    p.add_argument("--model-path", default=None, help="path to a local model dir (audio/image); never fetched")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse(list(sys.argv[1:] if argv is None else argv))
    modality = args.modality or _infer_modality(args.path)
    backend = _BACKENDS.get(args.backend, fake_backend.extract)
    try:
        segments = backend(args.path, modality, args.model_path)
        from .emit import build_payload

        payload = build_payload(args.path, modality, segments)
    except Exception:  # noqa: BLE001 — ultimate safety net: degrade, never crash
        payload = empty_payload(args.path, modality, dropped=1)
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":  # pragma: no cover — exercised via subprocess
    sys.exit(main())