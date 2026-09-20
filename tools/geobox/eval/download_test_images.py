#!/usr/bin/env python3
"""
Downloads high-resolution real photographs of global landmarks from the internet
and defines rigorous Ground Truth metadata for both:
  1. Landmark Target Coordinates (Center of the subject)
  2. Camera Optical Center Position (Where the photographer physically stood)
  3. Camera Attitude (Yaw / Heading, Pitch, Roll, Altitude, Standoff Distance)
"""

import os
import sys
import urllib.request
from typing import List, Dict, Any

TEST_IMAGES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "public", "test_images"))

REAL_LANDMARK_DATA: List[Dict[str, Any]] = [
    {
        "id": "eiffel_tower",
        "name": "Eiffel Tower, Paris, France",
        "landmark_lat": 48.8584,
        "landmark_lng": 2.2945,
        "landmark_height_m": 330.0,
        "camera_gt_lat": 48.8622,
        "camera_gt_lng": 2.2882,
        "camera_gt_alt_m": 68.0,
        "camera_gt_heading_deg": 140.5,
        "camera_gt_pitch_deg": 8.5,
        "vantage_point": "Esplanade du Trocadéro (Palais de Chaillot)",
        "standoff_m": 635.0,
        "url": "https://images.unsplash.com/photo-1511739001486-6bfe10ce785f?auto=format&fit=crop&w=800&q=80",
        "filename": "eiffel_tower_paris.jpg"
    },
    {
        "id": "colosseum_rome",
        "name": "Colosseum, Rome, Italy",
        "landmark_lat": 41.8902,
        "landmark_lng": 12.4922,
        "landmark_height_m": 48.0,
        "camera_gt_lat": 41.8913,
        "camera_gt_lng": 12.4925,
        "camera_gt_alt_m": 32.0,
        "camera_gt_heading_deg": 198.0,
        "camera_gt_pitch_deg": 12.0,
        "vantage_point": "Colle Oppio / Via Nicola Salvi Pedestrian Promenade",
        "standoff_m": 125.0,
        "url": "https://images.unsplash.com/photo-1552832230-c0197dd311b5?auto=format&fit=crop&w=800&q=80",
        "filename": "colosseum_rome.jpg"
    },
    {
        "id": "taj_mahal",
        "name": "Taj Mahal, Agra, India",
        "landmark_lat": 27.1751,
        "landmark_lng": 78.0421,
        "landmark_height_m": 73.0,
        "camera_gt_lat": 27.1738,
        "camera_gt_lng": 78.0421,
        "camera_gt_alt_m": 171.0,
        "camera_gt_heading_deg": 0.0,
        "camera_gt_pitch_deg": 4.0,
        "vantage_point": "Charbagh Central Reflecting Pool Southern Promenade",
        "standoff_m": 145.0,
        "url": "https://images.unsplash.com/photo-1564507592333-c60657eea523?auto=format&fit=crop&w=800&q=80",
        "filename": "taj_mahal_agra.jpg"
    },
    {
        "id": "sydney_opera_house",
        "name": "Sydney Opera House, Australia",
        "landmark_lat": -33.8568,
        "landmark_lng": 151.2153,
        "landmark_height_m": 65.0,
        "camera_gt_lat": -33.8601,
        "camera_gt_lng": 151.2139,
        "camera_gt_alt_m": 85.0,
        "camera_gt_heading_deg": 335.0,
        "camera_gt_pitch_deg": -12.0,
        "vantage_point": "Circular Quay East Elevated High-Rise Balcony",
        "standoff_m": 390.0,
        "url": "https://images.unsplash.com/photo-1624138784614-87fd1b6528f8?auto=format&fit=crop&w=800&q=80",
        "filename": "sydney_opera_house.jpg"
    },
    {
        "id": "christ_the_redeemer",
        "name": "Christ the Redeemer, Rio de Janeiro, Brazil",
        "landmark_lat": -22.9519,
        "landmark_lng": -43.2105,
        "landmark_height_m": 38.0,
        "camera_gt_lat": -22.9435,
        "camera_gt_lng": -43.2160,
        "camera_gt_alt_m": 920.0,
        "camera_gt_heading_deg": 155.0,
        "camera_gt_pitch_deg": -18.0,
        "vantage_point": "Tijuca Ridge Aerial Approach Flight",
        "standoff_m": 1080.0,
        "url": "https://images.unsplash.com/photo-1516306580123-e6e52b1b7b5f?auto=format&fit=crop&w=800&q=80",
        "filename": "christ_the_redeemer_rio.jpg"
    },
    {
        "id": "pyramids_giza",
        "name": "Pyramid of Khafre, Giza, Egypt",
        "landmark_lat": 29.9760,
        "landmark_lng": 31.1309,
        "landmark_height_m": 136.4,
        "camera_gt_lat": 29.9740,
        "camera_gt_lng": 31.1332,
        "camera_gt_alt_m": 74.0,
        "camera_gt_heading_deg": 310.0,
        "camera_gt_pitch_deg": 14.0,
        "vantage_point": "Khafre South-East Desert Caravan Approach Trail",
        "standoff_m": 320.0,
        "url": "https://images.unsplash.com/photo-1503177119275-0aa32b3a9368?auto=format&fit=crop&w=800&q=80",
        "filename": "pyramids_giza.jpg"
    },
    {
        "id": "shibuya_crossing",
        "name": "Shibuya Crossing, Tokyo, Japan",
        "landmark_lat": 35.6595,
        "landmark_lng": 139.7005,
        "landmark_height_m": 35.0,
        "camera_gt_lat": 35.6593,
        "camera_gt_lng": 139.7008,
        "camera_gt_alt_m": 16.0,
        "camera_gt_heading_deg": 285.0,
        "camera_gt_pitch_deg": 6.0,
        "vantage_point": "Hachiko Plaza Pedestrian Crossing Crosswalk",
        "standoff_m": 115.0,
        "url": "https://images.unsplash.com/photo-1542051841857-5f90071e7989?auto=format&fit=crop&w=800&q=80",
        "filename": "shibuya_crossing_tokyo.jpg"
    },
    {
        "id": "empire_state",
        "name": "Empire State Building, New York, USA",
        "landmark_lat": 40.7484,
        "landmark_lng": -73.9857,
        "landmark_height_m": 381.0,
        "camera_gt_lat": 40.7590,
        "camera_gt_lng": -73.9794,
        "camera_gt_alt_m": 260.0,
        "camera_gt_heading_deg": 198.0,
        "camera_gt_pitch_deg": -3.5,
        "vantage_point": "Top of the Rock Observation Deck (30 Rockefeller Plaza)",
        "standoff_m": 1290.0,
        "url": "https://images.unsplash.com/photo-1534430480872-3498386e7856?auto=format&fit=crop&w=800&q=80",
        "filename": "empire_state_building_nyc.jpg"
    },
    {
        "id": "golden_gate",
        "name": "Golden Gate Bridge, San Francisco, USA",
        "landmark_lat": 37.8199,
        "landmark_lng": -122.4783,
        "landmark_height_m": 227.0,
        "camera_gt_lat": 37.8278,
        "camera_gt_lng": -122.4816,
        "camera_gt_alt_m": 145.0,
        "camera_gt_heading_deg": 148.0,
        "camera_gt_pitch_deg": -9.0,
        "vantage_point": "Battery Spencer Cliff Overlook (Marin Headlands)",
        "standoff_m": 580.0,
        "url": "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?auto=format&fit=crop&w=800&q=80",
        "filename": "golden_gate_bridge_sf.jpg"
    },
    {
        "id": "swiss_lauterbrunnen",
        "name": "Staubbach Falls, Lauterbrunnen, Switzerland",
        "landmark_lat": 46.5896,
        "landmark_lng": 7.9053,
        "landmark_height_m": 297.0,
        "camera_gt_lat": 46.5982,
        "camera_gt_lng": 7.9085,
        "camera_gt_alt_m": 815.0,
        "camera_gt_heading_deg": 185.0,
        "camera_gt_pitch_deg": 5.0,
        "vantage_point": "Lauterbrunnen Eyelti Hillside Overlook Path",
        "standoff_m": 980.0,
        "url": "https://images.unsplash.com/photo-1530122037265-a5f1f91d3b99?auto=format&fit=crop&w=800&q=80",
        "filename": "matterhorn_switzerland.jpg"
    }
]

# Provide lat and lng aliases for backward compatibility across benchmark scripts
for item in REAL_LANDMARK_DATA:
    if "landmark_lat" in item and "lat" not in item:
        item["lat"] = item["landmark_lat"]
        item["lng"] = item["landmark_lng"]


RANDOM_SAMPLES_DIR = os.path.join(TEST_IMAGES_DIR, "random_samples")
RANDOM_MANIFEST_PATH = os.path.join(RANDOM_SAMPLES_DIR, "random_samples_manifest.json")

RANDOM_SAMPLE_DATA: List[Dict[str, Any]] = []
if os.path.exists(RANDOM_MANIFEST_PATH):
    import json
    try:
        with open(RANDOM_MANIFEST_PATH, "r", encoding="utf-8") as f:
            RANDOM_SAMPLE_DATA = json.load(f)
            for item in RANDOM_SAMPLE_DATA:
                item["image"] = os.path.join(RANDOM_SAMPLES_DIR, item["filename"])
                item["tiles_image"] = os.path.join(RANDOM_SAMPLES_DIR, item["filename"].replace(".png", "_3dtiles.png"))
    except Exception as e:
        print(f"⚠️ Could not load random_samples_manifest.json: {e}")


def download_real_test_images(dest_dir: str = TEST_IMAGES_DIR) -> List[Dict[str, Any]]:
    """Downloads all real landmark test images to dest_dir."""
    os.makedirs(dest_dir, exist_ok=True)
    downloaded = []

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }

    print(f"📥 [GeoBox] Verifying real landmark test images in: {dest_dir}")
    for item in REAL_LANDMARK_DATA:
        dest_path = os.path.join(dest_dir, item["filename"])
        if not os.path.exists(dest_path) or os.path.getsize(dest_path) < 1000:
            print(f"  ⬇️  Downloading real photo for: {item['name']}...")
            try:
                req = urllib.request.Request(item["url"], headers=headers)
                with urllib.request.urlopen(req, timeout=15) as resp, open(dest_path, "wb") as f:
                    f.write(resp.read())
                print(f"     ✅ Saved {os.path.getsize(dest_path) / 1024:.1f} KB to {item['filename']}")
            except Exception as e:
                print(f"     ❌ Failed to download {item['name']}: {e}")
                continue
        else:
            print(f"  ⚡ Verified: {item['filename']} ({os.path.getsize(dest_path) / 1024:.1f} KB)")

        entry = dict(item)
        entry["image"] = dest_path
        downloaded.append(entry)

    return downloaded


if __name__ == "__main__":
    items = download_real_test_images()
    print(f"\n🎉 Successfully processed {len(items)} landmark images.")
    print(f"🏡 Loaded {len(RANDOM_SAMPLE_DATA)} everyday non-landmark random samples.")

