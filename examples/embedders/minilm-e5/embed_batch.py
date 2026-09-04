"""Batch embedder for knowledge-crib's on-device semantic tier. Fully offline at query time.

Protocol (one process per batch, so the model load is amortised):
    stdin  {"texts": ["...", ...]}
    stdout {"dim": 1024, "vectors": [[...], ...]}

Vectors are L2-normalised, so the consumer's cosine is a plain dot product.

OFFLINE by default: HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE are set here, so a query never reaches the
network — the weights must already be in the local HuggingFace cache. See README.md for the one-time
download, which is the ONLY step that touches the network.
"""

import json
import os
import sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODEL = os.environ.get("KCRIB_EMBED_MODEL", "intfloat/multilingual-e5-large")
BATCH = int(os.environ.get("KCRIB_EMBED_BATCH", "64"))


def main() -> int:
    payload = json.load(sys.stdin)
    texts = payload.get("texts") or []
    if not texts:
        json.dump({"dim": 1024, "vectors": []}, sys.stdout)
        return 0

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        # A clear, actionable failure: crib treats any adapter error as "no tier" and falls back to
        # lexical-only, so this message is the operator's only clue about why.
        print(
            "knowledge-crib embedder: sentence-transformers is not installed.\n"
            "  pip install sentence-transformers\n"
            "  (or set KCRIB_EMBED_PYTHON to a interpreter that has it)",
            file=sys.stderr,
        )
        return 1

    model = SentenceTransformer(MODEL, device="cpu")
    vecs = model.encode(
        texts,
        normalize_embeddings=True,
        convert_to_numpy=True,
        batch_size=BATCH,
        show_progress_bar=False,
    )
    json.dump(
        {"dim": int(vecs.shape[1]), "vectors": [[float(x) for x in v] for v in vecs]},
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
