#!/usr/bin/env python3
"""
Downloads and manages the canonical 100,000-point land-filtered GPS gallery.
Saves locally as both CSV and binary numpy for microsecond loading.
"""

import os
import sys
import urllib.request
import numpy as np

GALLERY_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(GALLERY_DIR, "coordinates_100K.csv")
NPY_PATH = os.path.join(GALLERY_DIR, "coordinates_100K.npy")

URL = "https://raw.githubusercontent.com/VicenteVivan/geo-clip/main/geoclip/model/gps_gallery/coordinates_100K.csv"


def ensure_100k_gallery() -> np.ndarray:
    """Downloads and returns the 100,000-point land coordinate array (N, 2) in [lat, lng]."""
    os.makedirs(GALLERY_DIR, exist_ok=True)

    if os.path.exists(NPY_PATH):
        return np.load(NPY_PATH)

    if not os.path.exists(CSV_PATH):
        print(f"📥 [GeoBox Gallery] Downloading 100K land-filtered GPS gallery from GitHub...")
        headers = {"User-Agent": "Mozilla/5.0"}
        req = urllib.request.Request(URL, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp, open(CSV_PATH, "wb") as f:
            f.write(resp.read())
        print(f"✅ [GeoBox Gallery] Saved {os.path.getsize(CSV_PATH) / 1024 / 1024:.2f} MB to {CSV_PATH}")

    # Parse CSV into numpy array
    print(f"⚡ [GeoBox Gallery] Parsing CSV into optimized numpy binary...")
    coords = []
    with open(CSV_PATH, "r", encoding="utf-8") as f:
        lines = f.readlines()
        for line in lines[1:]: # skip header
            parts = line.strip().split(",")
            if len(parts) >= 2:
                try:
                    lat, lng = float(parts[0]), float(parts[1])
                    coords.append([lat, lng])
                except ValueError:
                    continue

    coords_np = np.array(coords, dtype=np.float32)
    np.save(NPY_PATH, coords_np)
    print(f"🎉 [GeoBox Gallery] Successfully cached {len(coords_np):,} land coordinates to {NPY_PATH}")
    return coords_np


if __name__ == "__main__":
    coords = ensure_100k_gallery()
    print(f"Validation: loaded array with shape {coords.shape}, dtype={coords.dtype}")
    print(f"Sample point 0: Lat {coords[0, 0]:.4f}°, Lng {coords[0, 1]:.4f}°")
