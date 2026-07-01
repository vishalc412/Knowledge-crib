"""crib_worker unit tests — pure stdlib (unittest), run with `python3 -m unittest discover`.

Exercises the contract + fake backend + degradation paths without any third-party install, so the
gate is fully green offline. The real pdf/audio/image backends are import-guarded and only run when
their optional deps + a `--model-path` are supplied (covered at runtime, not here).
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Make `crib_worker` importable when run from the repo root or the python/ dir.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from crib_worker import cli, emit, fake  # noqa: E402


class TestEmit(unittest.TestCase):
    def test_segment_shape(self):
        s = emit.segment(0, 1500, "hi", "en")
        self.assertEqual(s, {"tStartMs": 0, "tEndMs": 1500, "text": "hi", "lang": "en"})

    def test_build_payload_envelope(self):
        payload = emit.build_payload("a.wav", "audio", [emit.segment(0, 1000, "hi")])
        self.assertEqual(payload["schemaVersion"], emit.SCHEMA_VERSION)
        self.assertEqual(payload["file"], "a.wav")
        self.assertEqual(payload["modality"], "audio")
        self.assertEqual(len(payload["segments"]), 1)
        self.assertEqual(payload["dropped"], 0)

    def test_empty_payload_degrades(self):
        p = emit.empty_payload("x.pdf", "pdf", dropped=2)
        self.assertEqual(p["segments"], [])
        self.assertEqual(p["dropped"], 2)


class TestFakeBackend(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def _sidecar(self, name: str, text: str) -> str:
        media = os.path.join(self.dir, name)
        Path(media).write_bytes(b"\x00\x01\x02")  # a media stub
        Path(f"{media}.txt").write_text(text, encoding="utf-8")
        return media

    def test_reads_sidecar_and_segments_per_line(self):
        media = self._sidecar("talk.wav", "The AuthService.login method handles auth.\nSecond line.\n")
        segs = fake.extract(media, "audio")
        self.assertEqual(len(segs), 2)
        self.assertEqual(segs[0]["tStartMs"], 0)
        self.assertEqual(segs[0]["tEndMs"], 1000)
        self.assertEqual(segs[0]["text"], "The AuthService.login method handles auth.")
        self.assertEqual(segs[1]["tStartMs"], 1000)
        self.assertEqual(segs[1]["text"], "Second line.")

    def test_deterministic(self):
        media = self._sidecar("talk.wav", "alpha\nbeta\n")
        a = fake.extract(media, "audio")
        b = fake.extract(media, "audio")
        self.assertEqual(a, b)

    def test_missing_sidecar_degrades_to_empty(self):
        media = os.path.join(self.dir, "corrupt.wav")
        Path(media).write_bytes(b"\xff\xff")  # media but no sidecar
        self.assertEqual(fake.extract(media, "audio"), [])


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_cli_emits_valid_json_fake(self):
        media = os.path.join(self.dir, "talk.wav")
        Path(media).write_bytes(b"\x00")
        Path(f"{media}.txt").write_text("AuthService.login rocks\n", encoding="utf-8")
        argv = ["--backend", "fake", media]
        buf = self._run(argv)
        payload = json.loads(buf)
        self.assertEqual(payload["modality"], "audio")
        self.assertEqual(len(payload["segments"]), 1)
        self.assertIn("AuthService.login", payload["segments"][0]["text"])

    def test_cli_corrupt_media_degrades_no_throw(self):
        media = os.path.join(self.dir, "corrupt.pdf")
        Path(media).write_bytes(b"not a pdf")  # no sidecar, fake → empty; pdf backend would too
        buf = self._run(["--backend", "fake", media])
        payload = json.loads(buf)
        self.assertEqual(payload["segments"], [])

    def test_cli_modality_inferred_from_ext(self):
        media = os.path.join(self.dir, "notes.pdf")
        Path(media).write_bytes(b"\x00")
        Path(f"{media}.txt").write_text("page one\n", encoding="utf-8")
        payload = json.loads(self._run(["--backend", "fake", media]))
        self.assertEqual(payload["modality"], "pdf")

    def test_cli_missing_dep_backend_degrades(self):
        # audio backend without --model-path → empty, no throw, valid JSON.
        media = os.path.join(self.dir, "talk.wav")
        Path(media).write_bytes(b"\x00")
        payload = json.loads(self._run(["--backend", "audio", media]))
        self.assertEqual(payload["segments"], [])

    def _run(self, argv: list[str]) -> str:
        import io

        sys.stdout = io.StringIO()
        try:
            rc = cli.main(argv)
            out = sys.stdout.getvalue()
        finally:
            sys.stdout = sys.__stdout__
        self.assertEqual(rc, 0)
        return out


if __name__ == "__main__":
    unittest.main()