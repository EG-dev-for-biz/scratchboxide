#!/usr/bin/env python3
# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.
"""
Downloads the depth model's weights (Depth Anything V2 Small, Apache-2.0, the revision panorama_depth.py pins) from
Hugging Face into the gitignored model cache (SCRATCHBOX_MODEL_CACHE, else <repo>/.model-cache). Weights are never
committed. panorama_depth.py downloads them on first use too; this script does it ahead of time.

    .venv/bin/python tools/depth/fetch_depth_model.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from huggingface_hub import snapshot_download  # noqa: E402
from panorama_depth import MODEL_ID, MODEL_REVISION, MODEL_LICENSE, model_cache_dir  # noqa: E402


def main():
    path = snapshot_download(MODEL_ID, revision=MODEL_REVISION, cache_dir=model_cache_dir())
    print(f"{MODEL_ID}@{MODEL_REVISION[:8]} ({MODEL_LICENSE}) -> {path}")


if __name__ == "__main__":
    main()
