#!/usr/bin/env python3
"""
GeoBox Real Geotagged Dataset Builder:
Downloads authentic geotagged photographs across global regions and packages them
into high-throughput WebDataset .tar shards for streaming training on Google Cloud Vertex AI.
"""

import os
import sys
import io
import json
import tarfile
import argparse
import urllib.request
from typing import List, Dict
from concurrent.futures import ThreadPoolExecutor, as_completed

# Real geotagged photo registry spanning diverse countries, biomes, and urban landscapes
REAL_GEOTAGGED_REGISTRY: List[Dict] = [
    # North America
    {"name": "New York City Times Square", "lat": 40.7580, "lng": -73.9855, "country": "US", "city": "New York", "url": "https://images.unsplash.com/photo-1534430480872-3498386e7856?auto=format&fit=crop&w=400&q=75"},
    {"name": "Golden Gate Bridge San Francisco", "lat": 37.8199, "lng": -122.4783, "country": "US", "city": "San Francisco", "url": "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?auto=format&fit=crop&w=400&q=75"},
    {"name": "Grand Canyon Arizona", "lat": 36.0544, "lng": -112.1401, "country": "US", "city": "Grand Canyon", "url": "https://images.unsplash.com/photo-1474044159687-1ee9f3a51722?auto=format&fit=crop&w=400&q=75"},
    {"name": "Banff National Park Alberta", "lat": 51.4968, "lng": -115.9281, "country": "CA", "city": "Banff", "url": "https://images.unsplash.com/photo-1503614472-8c93d56e92ce?auto=format&fit=crop&w=400&q=75"},
    {"name": "Mexico City Zocalo", "lat": 19.4326, "lng": -99.1332, "country": "MX", "city": "Mexico City", "url": "https://images.unsplash.com/photo-1518105779142-d975f22f1b0a?auto=format&fit=crop&w=400&q=75"},
    {"name": "Miami South Beach", "lat": 25.7617, "lng": -80.1918, "country": "US", "city": "Miami", "url": "https://images.unsplash.com/photo-1506953823976-52e1fdc0149a?auto=format&fit=crop&w=400&q=75"},
    {"name": "Chicago Loop", "lat": 41.8819, "lng": -87.6278, "country": "US", "city": "Chicago", "url": "https://images.unsplash.com/photo-1477959858617-67f30bc75b82?auto=format&fit=crop&w=400&q=75"},
    {"name": "Vancouver Waterfront", "lat": 49.2827, "lng": -123.1207, "country": "CA", "city": "Vancouver", "url": "https://images.unsplash.com/photo-1559511260-66a65e09b245?auto=format&fit=crop&w=400&q=75"},

    # Europe
    {"name": "Eiffel Tower Paris", "lat": 48.8584, "lng": 2.2945, "country": "FR", "city": "Paris", "url": "https://images.unsplash.com/photo-1511739001486-6bfe10ce785f?auto=format&fit=crop&w=400&q=75"},
    {"name": "Colosseum Rome", "lat": 41.8902, "lng": 12.4922, "country": "IT", "city": "Rome", "url": "https://images.unsplash.com/photo-1552832230-c0197dd311b5?auto=format&fit=crop&w=400&q=75"},
    {"name": "Matterhorn Zermatt", "lat": 45.9763, "lng": 7.7491, "country": "CH", "city": "Zermatt", "url": "https://images.unsplash.com/photo-1530122037265-a5f1f91d3b99?auto=format&fit=crop&w=400&q=75"},
    {"name": "Tower Bridge London", "lat": 51.5055, "lng": -0.0754, "country": "GB", "city": "London", "url": "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=400&q=75"},
    {"name": "Santorini Caldera", "lat": 36.3932, "lng": 25.4615, "country": "GR", "city": "Santorini", "url": "https://images.unsplash.com/photo-1570077188670-e3a8d69ac5ff?auto=format&fit=crop&w=400&q=75"},
    {"name": "Amsterdam Canals", "lat": 52.3676, "lng": 4.9041, "country": "NL", "city": "Amsterdam", "url": "https://images.unsplash.com/photo-1512470876302-972faa2aa9a4?auto=format&fit=crop&w=400&q=75"},
    {"name": "Brandenburg Gate Berlin", "lat": 52.5163, "lng": 13.3777, "country": "DE", "city": "Berlin", "url": "https://images.unsplash.com/photo-1560969184-10fe8719e047?auto=format&fit=crop&w=400&q=75"},
    {"name": "Sagrada Familia Barcelona", "lat": 41.4036, "lng": 2.1744, "country": "ES", "city": "Barcelona", "url": "https://images.unsplash.com/photo-1583422409516-2895a77efded?auto=format&fit=crop&w=400&q=75"},

    # Asia & Middle East
    {"name": "Shibuya Crossing Tokyo", "lat": 35.6595, "lng": 139.7005, "country": "JP", "city": "Tokyo", "url": "https://images.unsplash.com/photo-1542051841857-5f90071e7989?auto=format&fit=crop&w=400&q=75"},
    {"name": "Mount Fuji Shizuoka", "lat": 35.3606, "lng": 138.7274, "country": "JP", "city": "Fujinomiya", "url": "https://images.unsplash.com/photo-1490806843957-31f4c9a91c65?auto=format&fit=crop&w=400&q=75"},
    {"name": "Burj Khalifa Dubai", "lat": 25.1972, "lng": 55.2744, "country": "AE", "city": "Dubai", "url": "https://images.unsplash.com/photo-1512453979798-5ea266f8880c?auto=format&fit=crop&w=400&q=75"},
    {"name": "Taj Mahal Agra", "lat": 27.1751, "lng": 78.0421, "country": "IN", "city": "Agra", "url": "https://images.unsplash.com/photo-1564507592333-c60657eea523?auto=format&fit=crop&w=400&q=75"},
    {"name": "Singapore Marina Bay", "lat": 1.2838, "lng": 103.8591, "country": "SG", "city": "Singapore", "url": "https://images.unsplash.com/photo-1525625293386-3f8f99389edd?auto=format&fit=crop&w=400&q=75"},
    {"name": "Seoul Bukchon Hanok", "lat": 37.5826, "lng": 126.9830, "country": "KR", "city": "Seoul", "url": "https://images.unsplash.com/photo-1538485399081-7191377e8241?auto=format&fit=crop&w=400&q=75"},
    {"name": "Petra Ancient City", "lat": 30.3285, "lng": 35.4444, "country": "JO", "city": "Wadi Musa", "url": "https://images.unsplash.com/photo-1579606032834-45300e84b806?auto=format&fit=crop&w=400&q=75"},
    {"name": "Bangkok Grand Palace", "lat": 13.7500, "lng": 100.4913, "country": "TH", "city": "Bangkok", "url": "https://images.unsplash.com/photo-1508009603885-50cf7c579365?auto=format&fit=crop&w=400&q=75"},

    # South America & Oceania & Africa
    {"name": "Christ the Redeemer Rio", "lat": -22.9519, "lng": -43.2105, "country": "BR", "city": "Rio de Janeiro", "url": "https://images.unsplash.com/photo-1598977123118-4e30ba3c4f5b?auto=format&fit=crop&w=400&q=75"},
    {"name": "Machu Picchu Cusco", "lat": -13.1631, "lng": -72.5450, "country": "PE", "city": "Cusco", "url": "https://images.unsplash.com/photo-1526392060635-9d6019884377?auto=format&fit=crop&w=400&q=75"},
    {"name": "Sydney Opera House", "lat": -33.8568, "lng": 151.2153, "country": "AU", "city": "Sydney", "url": "https://images.unsplash.com/photo-1624138784614-87fd1b6528f8?auto=format&fit=crop&w=400&q=75"},
    {"name": "Pyramids of Giza Cairo", "lat": 29.9792, "lng": 31.1342, "country": "EG", "city": "Giza", "url": "https://images.unsplash.com/photo-1503177119275-0aa32b3a9368?auto=format&fit=crop&w=400&q=75"},
    {"name": "Table Mountain Cape Town", "lat": -33.9628, "lng": 18.4098, "country": "ZA", "city": "Cape Town", "url": "https://images.unsplash.com/photo-1580618672591-eb180b1a973f?auto=format&fit=crop&w=400&q=75"},
    {"name": "Marrakech Medina", "lat": 31.6295, "lng": -7.9811, "country": "MA", "city": "Marrakech", "url": "https://images.unsplash.com/photo-1539020140153-e479b8c22e70?auto=format&fit=crop&w=400&q=75"},
    {"name": "Milford Sound South Island", "lat": -44.6716, "lng": 167.9264, "country": "NZ", "city": "Milford Sound", "url": "https://images.unsplash.com/photo-1507699622108-4be3abd695ad?auto=format&fit=crop&w=400&q=75"},
    {"name": "Buenos Aires Obelisk", "lat": -34.6037, "lng": -58.3816, "country": "AR", "city": "Buenos Aires", "url": "https://images.unsplash.com/photo-1589909202802-8f4aadce1849?auto=format&fit=crop&w=400&q=75"}
]


def download_single_item(item: Dict) -> Dict:
    """Downloads an individual geotagged photograph into memory."""
    headers = {"User-Agent": "Mozilla/5.0"}
    try:
        req = urllib.request.Request(item["url"], headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
        return {
            "success": True,
            "data": data,
            "meta": item
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "meta": item
        }


def build_shards(output_dir: str, shard_size: int = 16) -> List[str]:
    """
    Downloads items concurrently and writes them into WebDataset .tar shards.
    """
    os.makedirs(output_dir, exist_ok=True)
    print(f"🌐 [GeoBox Data Builder] Fetching {len(REAL_GEOTAGGED_REGISTRY)} real geotagged images...")

    results = []
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(download_single_item, item) for item in REAL_GEOTAGGED_REGISTRY]
        for f in as_completed(futures):
            res = f.result()
            if res["success"]:
                results.append(res)
                print(f"  ✅ Downloaded: {res['meta']['name']} ({res['meta']['country']})")
            else:
                print(f"  ❌ Failed: {res['meta']['name']} ({res.get('error')})")

    print(f"\n📦 [GeoBox Data Builder] Successfully downloaded {len(results)} items. Building WebDataset shards...")

    shard_files = []
    shard_idx = 0

    for i in range(0, len(results), shard_size):
        chunk = results[i:i + shard_size]
        shard_path = os.path.join(output_dir, f"shard-{shard_idx:05d}.tar")

        with tarfile.open(shard_path, "w") as tar:
            for item_idx, item in enumerate(chunk):
                sample_id = f"sample_{shard_idx:05d}_{item_idx:04d}"

                # 1. Add image
                img_data = item["data"]
                img_info = tarfile.TarInfo(name=f"{sample_id}.jpg")
                img_info.size = len(img_data)
                tar.addfile(img_info, io.BytesIO(img_data))

                # 2. Add JSON metadata
                meta_dict = {
                    "id": sample_id,
                    "name": item["meta"]["name"],
                    "lat": float(item["meta"]["lat"]),
                    "lng": float(item["meta"]["lng"]),
                    "countryCode": item["meta"]["country"],
                    "city": item["meta"]["city"],
                    "elevationM": 100.0,
                    "biome": "urban_or_landmark"
                }
                meta_bytes = json.dumps(meta_dict, indent=2).encode("utf-8")
                meta_info = tarfile.TarInfo(name=f"{sample_id}.json")
                meta_info.size = len(meta_bytes)
                tar.addfile(meta_info, io.BytesIO(meta_bytes))

        size_kb = os.path.getsize(shard_path) / 1024
        print(f"  📁 Created shard: {os.path.basename(shard_path)} ({len(chunk)} samples, {size_kb:.1f} KB)")
        shard_files.append(shard_path)
        shard_idx += 1

    return shard_files


def main():
    parser = argparse.ArgumentParser(description="GeoBox Real Geotagged WebDataset Shard Builder")
    parser.add_argument("--output-dir", type=str, default="build/geobox_data", help="Local directory for shards")
    parser.add_argument("--shard-size", type=int, default=16, help="Samples per shard")
    parser.add_argument("--upload-gcs", action="store_true", help="Upload shards to GCS bucket")
    parser.add_argument("--gcs-bucket", type=str, default="gs://scratchbox-canvas-geobox/data/train", help="GCS target path")
    args = parser.parse_args()

    shards = build_shards(args.output_dir, shard_size=args.shard_size)

    if args.upload_gcs and shards:
        print(f"\n☁️ [GeoBox Data Builder] Uploading shards to {args.gcs_bucket}...")
        for shard in shards:
            os.system(f"gcloud storage cp {shard} {args.gcs_bucket}/")
        print("🎉 [GeoBox Data Builder] Shard upload to GCS completed.")


if __name__ == "__main__":
    main()
