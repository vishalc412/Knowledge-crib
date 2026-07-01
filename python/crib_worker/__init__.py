"""crib_worker — offline multimodal extraction subprocess for knowledge-crib (M13).

Invoked by the TS CLI as `python3 crib_worker/cli.py ...`; emits one JSON payload on stdout that the
TS ingest layer turns into soul-schema-conformant `media-seg` nodes + `member-of` edges. The worker
NEVER touches the soul store directly — it is a pure segment producer.

Backends:
  fake  — pure-stdlib, deterministic; reads a `<media>.txt` sidecar as the ground-truth transcript.
          Used by the gate tests and any offline/determinism run (no model, no network).
  pdf   — pypdf (zero-model) per-page text. Optional dep; degrades to [] if pypdf is absent.
  audio — faster-whisper transcription (greedy / temperature 0 for determinism). Optional dep + model.
  image — surya OCR. Optional dep + model.

Every backend degrades to an empty segment list on any failure (corrupt media, missing dep, missing
model) — the worker never raises and always exits 0 with valid JSON.
"""

__all__ = ["cli", "emit", "fake", "pdf", "audio", "image"]