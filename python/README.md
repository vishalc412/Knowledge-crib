# crib_worker — offline multimodal extraction subprocess

A sibling Python project (outside the pnpm `packages/*` glob) that extracts text from media files for
[knowledge-crib](../README.md). The TS pipeline spawns it as `python3 -m crib_worker.cli` per media file
(see `packages/pipeline/src/multimodal/worker.ts`); the worker emits **one JSON payload** on stdout and
always exits 0 — any failure degrades to an empty segment list, so the pipeline never aborts on media.

## Payload

```json
{
  "schemaVersion": "1.1",
  "file": "<abs path>",
  "modality": "pdf | audio | image",
  "segments": [{ "tStartMs": 0, "tEndMs": 1000, "text": "...", "lang": "en" }],
  "dropped": 0
}
```

The TS side owns node ids (`media:<path>#<tStartMs`) + blake3 hashing and turns segments into
`media-seg` nodes + `member-of` edges to the file node, then links them to code symbols.

## Backends

| Backend  | Deps (optional extra)        | Model         | Notes                                   |
|----------|------------------------------|---------------|-----------------------------------------|
| `fake`   | none (pure stdlib)           | —             | reads a `<media>.txt` sidecar, 1 seg/line. Default; drives the gate tests offline. |
| `pdf`    | `pypdf>=4.0`                 | —             | one segment per page.                   |
| `audio`  | `faster-whisper>=1.0`        | `--model-path` | beam_size=1, temperature=0, vad_filter. |
| `image`  | `surya-ocr>=0.6`, `Pillow`   | `--model-path` | OCR.                                   |

Real backends are **import-guarded** — they degrade to `[]` if their dep or `--model-path` is missing.
Models are **never fetched over the network**; supply a local dir via `--model-path`.

## Install

```bash
cd python
uv sync                       # fake backend only (no required deps)
uv sync --extra pdf           # + pypdf
uv sync --extra audio         # + faster-whisper
uv sync --extra image         # + surya-ocr + Pillow
```

## Run

```bash
# directly (debug):
python3 -m crib_worker.cli --backend fake /path/to/talk.wav
# real whisper:
python3 -m crib_worker.cli --backend audio --model-path ~/.models/whisper-small /path/to/talk.wav
```

Via the CLI: `crib multimodal . --backend <b> [--model-path P]` (after `crib index`).

## Test

```bash
cd python && python3 -m unittest discover -s tests -p "test_*.py"
# or, with pytest (testpaths is configured in pyproject.toml):
cd python && pytest
```

Pure stdlib (no third-party install needed) — the fake backend exercises the full contract offline.