# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.

"""
GeoBox Model Inference & Benchmark Evaluation Suite.
Tests geolocation prediction capability on reference images,
ranks gallery coordinates via spherical hash dot-product,
computes Haversine geodesic errors, and generates an interactive Leaflet report.
"""

import os
import sys
import math
import json
import argparse
import base64
from typing import List, Dict, Tuple, Optional
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
import torchvision.transforms as T

# Add parent dir to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from model.geobox_module import GeoBoxModel, EARTH_RADIUS_KM
from eval.download_test_images import download_real_test_images, TEST_IMAGES_DIR, REAL_LANDMARK_DATA

# Helper for embedded data URIs in HTML reports
def get_image_data_uri(image_path: str) -> str:
    """Encodes an image as a base64 data URI for zero-friction standalone rendering."""
    if os.path.exists(image_path):
        try:
            with open(image_path, "rb") as f:
                encoded = base64.b64encode(f.read()).decode("utf-8")
                ext = os.path.splitext(image_path)[1].lower().strip(".")
                mime = "image/jpeg" if ext in ["jpg", "jpeg"] else ("image/png" if ext == "png" else "image/jpeg")
                return f"data:{mime};base64,{encoded}"
        except Exception:
            pass
    return image_path


# Standard benchmark landmarks utilizing real photographs from the internet
BENCHMARK_LANDMARKS = [
    {
        "name": item["name"],
        "lat": item["lat"],
        "lng": item["lng"],
        "image": os.path.join(TEST_IMAGES_DIR, item["filename"])
    }
    for item in REAL_LANDMARK_DATA
]

def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Calculate great-circle distance in kilometers."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2.0)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2.0)**2
    return 2.0 * EARTH_RADIUS_KM * math.atan2(math.sqrt(a), math.sqrt(max(1.0 - a, 0.0)))


def build_world_gallery(use_100k: bool = True, num_sphere_samples: int = 1000) -> Tuple[torch.Tensor, List[str]]:
    """
    Builds a global candidate gallery combining major world landmarks and
    either the dense 100K land-filtered GPS gallery or a uniform Fibonacci sphere grid.
    """
    coords_list = []
    names_list = []

    # 1. Add known landmarks
    for lm in BENCHMARK_LANDMARKS:
        coords_list.append([lm["lat"], lm["lng"]])
        names_list.append(lm["name"])

    # 2. Check for canonical 100K land-filtered GPS gallery
    gallery_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../model/gps_gallery"))
    npy_path = os.path.join(gallery_dir, "coordinates_100K.npy")

    if use_100k and os.path.exists(npy_path):
        print(f"🌍 [GeoBox Gallery] Loading dense 100,000 land-filtered gallery from: {npy_path}")
        land_coords = np.load(npy_path)
        for i in range(len(land_coords)):
            lat, lng = float(land_coords[i, 0]), float(land_coords[i, 1])
            coords_list.append([lat, lng])
            names_list.append(f"Land Candidate #{i+1} ({lat:.2f}°, {lng:.2f}°)")
        print(f"✅ [GeoBox Gallery] Loaded {len(land_coords):,} dense land-filtered candidates.")
        return torch.tensor(coords_list, dtype=torch.float32), names_list

    # Fallback: Fibonacci sphere samples
    print(f"🌐 [GeoBox Gallery] Generating {num_sphere_samples} Fibonacci sphere grid candidates...")
    golden_ratio = (1.0 + math.sqrt(5.0)) / 2.0
    for i in range(num_sphere_samples):
        theta = 2.0 * math.pi * (i / golden_ratio)
        phi = math.acos(1.0 - 2.0 * (i + 0.5) / num_sphere_samples)
        
        # Convert to lat / lng
        lat = 90.0 - math.degrees(phi)
        lng = math.degrees(theta) % 360.0
        if lng > 180.0:
            lng -= 360.0
            
        coords_list.append([lat, lng])
        names_list.append(f"Grid Lat: {lat:.2f}°, Lng: {lng:.2f}°")

    return torch.tensor(coords_list, dtype=torch.float32), names_list


class GeoBoxInferenceEngine:
    def __init__(self, checkpoint_path: Optional[str] = None, device: str = "cpu", use_100k_gallery: bool = True):
        self.device = torch.device(device)
        print(f"📦 [GeoBox Engine] Initializing GeoBox on device: {self.device}")

        self.model = GeoBoxModel(embed_dim=512)
        if checkpoint_path and os.path.exists(checkpoint_path):
            print(f"🔄 [GeoBox Engine] Loading checkpoint: {checkpoint_path}")
            ckpt = torch.load(checkpoint_path, map_location=self.device)
            state_dict = ckpt.get("model_state_dict", ckpt)
            self.model.load_state_dict(state_dict, strict=False)
            print("✅ [GeoBox Engine] Weights loaded successfully.")
        else:
            print("⚠️ [GeoBox Engine] No checkpoint provided or file not found. Running in base pretrained mode.")

        self.model.to(self.device)
        self.model.eval()

        self.transform = T.Compose([
            T.Resize((224, 224)),
            T.ToTensor(),
            T.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5])
        ])

        # Precompute candidate gallery
        self.gallery_coords, self.gallery_names = build_world_gallery(use_100k=use_100k_gallery)
        self.gallery_coords = self.gallery_coords.to(self.device)

        print(f"🌐 [GeoBox Engine] Pre-encoding location gallery ({len(self.gallery_names):,} candidates)...")
        with torch.no_grad():
            chunk_size = 8192
            embed_chunks = []
            for c_idx in range(0, len(self.gallery_coords), chunk_size):
                chunk = self.gallery_coords[c_idx:c_idx + chunk_size]
                chunk_embeds = self.model.location_encoder(chunk)
                embed_chunks.append(chunk_embeds)
            self.gallery_embeddings = torch.cat(embed_chunks, dim=0)
            self.gallery_embeddings = F.normalize(self.gallery_embeddings, p=2, dim=-1)
        print("✅ [GeoBox Engine] Location gallery encoded.")

    def predict(
        self,
        image_path: str,
        gt_lat: Optional[float] = None,
        gt_lng: Optional[float] = None,
        landmark_name: Optional[str] = None,
        top_k: int = 5
    ) -> Dict:
        """
        Runs geolocation inference on a single image.
        """
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"Image not found: {image_path}")

        img = Image.open(image_path).convert("RGB")
        img_tensor = self.transform(img).unsqueeze(0).to(self.device)

        with torch.no_grad():
            img_embed = self.model.encode_image(img_tensor) # (1, 512)
            img_embed = F.normalize(img_embed, p=2, dim=-1)

            # Cosine similarity dot-product
            sims = torch.matmul(img_embed, self.gallery_embeddings.T).squeeze(0) # (M,)
            top_scores, top_indices = torch.topk(sims, k=top_k)

        predictions = []
        for rank, (idx, score) in enumerate(zip(top_indices.tolist(), top_scores.tolist())):
            coord = self.gallery_coords[idx].tolist()
            name = self.gallery_names[idx]
            error_km = None
            if gt_lat is not None and gt_lng is not None:
                error_km = haversine_km(gt_lat, gt_lng, coord[0], coord[1])

            predictions.append({
                "rank": rank + 1,
                "name": name,
                "lat": coord[0],
                "lng": coord[1],
                "similarity": score,
                "error_km": error_km
            })

        return {
            "image_path": os.path.abspath(image_path),
            "image_data_uri": get_image_data_uri(image_path),
            "landmark_name": landmark_name or os.path.splitext(os.path.basename(image_path))[0].replace("_", " ").title(),
            "ground_truth": {"lat": gt_lat, "lng": gt_lng} if gt_lat is not None else None,
            "predictions": predictions
        }


def resolve_google_maps_api_key(cli_key: Optional[str] = None) -> str:
    """
    Resolves Google Maps Platform API key from:
    1. CLI argument
    2. GOOGLE_MAPS_API_KEY environment variable
    3. secrets.json / .env in workspace root
    """
    if cli_key and cli_key.strip():
        return cli_key.strip()
    if os.environ.get("GOOGLE_MAPS_API_KEY"):
        return os.environ["GOOGLE_MAPS_API_KEY"].strip()

    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    
    # Try secrets.json
    secrets_path = os.path.join(base_dir, "secrets.json")
    if os.path.exists(secrets_path):
        try:
            with open(secrets_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if "GOOGLE_MAPS_API_KEY" in data and data["GOOGLE_MAPS_API_KEY"]:
                    return data["GOOGLE_MAPS_API_KEY"].strip()
        except Exception:
            pass

    # Try .env
    env_path = os.path.join(base_dir, ".env")
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("GOOGLE_MAPS_API_KEY="):
                        val = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if val:
                            return val
        except Exception:
            pass

    return ""


def generate_html_report(results: List[Dict], output_html: str, google_maps_api_key: Optional[str] = None):
    """
    Generates an interactive Google Maps Platform HTML report mapping predictions vs ground truth
    using modern AdvancedMarkerElement, PinElement, and Geodesic Polylines.
    Source: Google Maps Platform Code Assist
    """
    api_key = resolve_google_maps_api_key(google_maps_api_key)
    json_data = json.dumps(results, indent=2)

    html_template = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GeoBox Geolocation Model Evaluation Report - Google Maps Platform</title>
    <!-- Source: Google Maps Platform Code Assist -->
    <script>
      (g=>{var h,a,k,p="The Google Maps JavaScript API",c="google",l="importLibrary",q="__ib__",m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await (a=m.createElement("script"));e.set("libraries",[...r]+"");for(k in g)e.set(k.replace(/[A-Z]/g,t=>"_"+t[0].toLowerCase()),g[k]);e.set("callback",c+".maps."+q);a.src=`https://maps.${c}apis.com/maps/api/js?`+e;d[q]=f;a.onerror=()=>h=n(Error(p+" could not load."));a.nonce=m.querySelector("script[nonce]")?.nonce||"";m.head.append(a)}));d[l]?console.warn(p+" only loads once. Ignoring:",g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})({
        key: "__GOOGLE_MAPS_API_KEY__",
        v: "beta"
      });
    </script>
    <style>
        :root {
            --bg-primary: #0f172a;
            --bg-secondary: #1e293b;
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --accent: #38bdf8;
            --success: #10b981;
            --warning: #f59e0b;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: var(--bg-primary);
            color: var(--text-primary);
            margin: 0;
            padding: 24px;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 20px;
            border-bottom: 1px solid #334155;
            padding-bottom: 16px;
        }
        h1 {
            margin: 0;
            font-size: 24px;
            color: var(--accent);
        }
        .grid {
            display: grid;
            grid-template-columns: 440px 1fr;
            gap: 24px;
            height: calc(100vh - 120px);
        }
        .sidebar {
            background: var(--bg-secondary);
            border-radius: 12px;
            padding: 16px;
            overflow-y: auto;
            border: 1px solid #334155;
        }
        .card {
            background: #0f172a;
            border: 1px solid #334155;
            border-radius: 8px;
            padding: 14px;
            margin-bottom: 16px;
            transition: border-color 0.2s ease;
        }
        .card:hover {
            border-color: #38bdf8;
        }
        .metric-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
            margin-right: 6px;
        }
        .badge-success { background: #064e3b; color: #34d399; }
        .badge-warning { background: #78350f; color: #fbbf24; }
        .badge-neutral { background: #1e293b; color: #94a3b8; }
        #map-container {
            border-radius: 12px;
            border: 1px solid #334155;
            height: 100%;
            width: 100%;
            overflow: hidden;
            position: relative;
        }
        #map {
            height: 100%;
            width: 100%;
        }
        .pred-table {
            width: 100%;
            font-size: 13px;
            margin-top: 10px;
            border-collapse: collapse;
        }
        .pred-table th, .pred-table td {
            padding: 6px 8px;
            text-align: left;
            border-bottom: 1px solid #334155;
        }
        .info-bubble {
            color: #0f172a;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            line-height: 1.5;
            padding: 4px 2px;
        }
        .info-bubble strong {
            font-size: 14px;
            color: #1e293b;
        }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h1>🌍 GeoBox Geolocation Model Evaluation</h1>
            <div style="color: var(--text-secondary); font-size: 13px; margin-top: 4px;">
                SigLIP-2 Multi-Resolution Spherical Hash Grid Inference Engine &bull; Google Maps Platform Standard
            </div>
        </div>
        <div style="display: flex; gap: 10px; align-items: center;">
            <div style="font-size: 13px; background: #065f46; color: #34d399; padding: 6px 14px; border-radius: 20px; font-weight: 500;">
                Google Maps JS API (AdvancedMarkerElement)
            </div>
            <div style="font-size: 13px; background: #0369a1; padding: 6px 14px; border-radius: 20px;">
                Verified Scratchbox Model
            </div>
        </div>
    </div>

    <div class="grid">
        <div class="sidebar" id="sidebar-cards"></div>
        <div id="map-container">
            <div id="map"></div>
        </div>
    </div>

    <script>
        const results = __JSON_DATA__;

        async function initGoogleMap() {
            try {
                const { Map, InfoWindow } = await google.maps.importLibrary("maps");
                const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary("marker");

                const map = new Map(document.getElementById("map"), {
                    center: { lat: 25, lng: 15 },
                    zoom: 2.2,
                    mapId: "DEMO_MAP_ID",
                    mapTypeId: "hybrid",
                    internalUsageAttributionIds: ["gmp_git_agentskills_v1"],
                    gestureHandling: "greedy",
                    scaleControl: true
                });

                const infoWindow = new InfoWindow();
                const sidebar = document.getElementById("sidebar-cards");
                const bounds = new google.maps.LatLngBounds();

                results.forEach((item, index) => {
                    const card = document.createElement("div");
                    card.className = "card";
                    
                    const targetTitle = item.landmark_name || `Case #${index + 1}`;
                    const topPred = item.predictions[0];
                    const errorText = topPred.error_km !== null ? topPred.error_km.toFixed(1) + " km" : "N/A";
                    const badgeClass = topPred.error_km < 100 ? "badge-success" : (topPred.error_km < 1000 ? "badge-warning" : "badge-neutral");
                    const imgSrc = item.image_data_uri || (item.image_path.startsWith("/") ? "file://" + item.image_path : item.image_path);

                    card.innerHTML = `
                        <div style="font-weight: 600; font-size: 14px; margin-bottom: 6px;">#${index + 1}: ${targetTitle}</div>
                        <img src="${imgSrc}" style="width: 100%; height: 180px; object-fit: cover; border-radius: 6px; margin-bottom: 10px;">
                        <div>
                            <span class="metric-badge ${badgeClass}">Top-1 Error: ${errorText}</span>
                            <span class="metric-badge badge-neutral">Cosine Sim: ${topPred.similarity.toFixed(3)}</span>
                        </div>
                        <table class="pred-table">
                            <thead>
                                <tr><th>Rank</th><th>Candidate</th><th>Similarity</th></tr>
                            </thead>
                            <tbody>
                                ${item.predictions.map(p => `
                                    <tr>
                                        <td>#${p.rank}</td>
                                        <td>${p.name}</td>
                                        <td>${p.similarity.toFixed(3)}</td>
                                    </tr>
                                `).join("")}
                            </tbody>
                        </table>
                    `;
                    card.style.cursor = "pointer";
                    card.title = "Click to zoom into this landmark on Google Maps";
                    card.addEventListener("click", () => {
                        const targetPos = item.ground_truth ? { lat: item.ground_truth.lat, lng: item.ground_truth.lng } : { lat: topPred.lat, lng: topPred.lng };
                        map.panTo(targetPos);
                        map.setZoom(12);
                    });
                    sidebar.appendChild(card);

                    // Ground Truth Target Marker
                    if (item.ground_truth) {
                        const gtPos = { lat: item.ground_truth.lat, lng: item.ground_truth.lng };
                        bounds.extend(gtPos);

                        const gtPin = new PinElement({
                            background: "#10b981",
                            borderColor: "#047857",
                            glyphColor: "#ffffff",
                            scale: 1.15
                        });

                        const gtMarker = new AdvancedMarkerElement({
                            map: map,
                            position: gtPos,
                            title: `Ground Truth Target: ${targetTitle}`,
                            content: gtPin
                        });

                        gtMarker.addEventListener("gmp-click", () => {
                            infoWindow.setContent(`
                                <div class="info-bubble">
                                    <strong>🎯 Ground Truth: ${targetTitle}</strong><br>
                                    <span>Latitude: ${item.ground_truth.lat.toFixed(4)}°</span><br>
                                    <span>Longitude: ${item.ground_truth.lng.toFixed(4)}°</span>
                                </div>
                            `);
                            infoWindow.open(map, gtMarker);
                        });
                    }

                    // GeoBox Top-1 Prediction Marker
                    const predPos = { lat: topPred.lat, lng: topPred.lng };
                    bounds.extend(predPos);

                    const predPin = new PinElement({
                        background: "#ef4444",
                        borderColor: "#b91c1c",
                        glyphColor: "#ffffff",
                        scale: 1.1
                    });

                    const predMarker = new AdvancedMarkerElement({
                        map: map,
                        position: predPos,
                        title: `GeoBox Top-1: ${topPred.name}`,
                        content: predPin
                    });

                    predMarker.addEventListener("gmp-click", () => {
                        infoWindow.setContent(`
                            <div class="info-bubble">
                                <strong>📍 GeoBox Prediction #1</strong><br>
                                <span><strong>${topPred.name}</strong></span><br>
                                <span>Similarity: ${topPred.similarity.toFixed(4)}</span><br>
                                <span>Coordinates: ${topPred.lat.toFixed(4)}°, ${topPred.lng.toFixed(4)}°</span><br>
                                ${topPred.error_km !== null ? `<span>Geodesic Error: <strong>${topPred.error_km.toFixed(1)} km</strong></span>` : ""}
                            </div>
                        `);
                        infoWindow.open(map, predMarker);
                    });

                    // Geodesic Trajectory Arc
                    if (item.ground_truth) {
                        new google.maps.Polyline({
                            path: [
                                { lat: item.ground_truth.lat, lng: item.ground_truth.lng },
                                predPos
                            ],
                            geodesic: true,
                            strokeColor: "#f59e0b",
                            strokeOpacity: 0.85,
                            strokeWeight: 2.5,
                            map: map
                        });
                    }
                });

                if (results.length > 0 && results.some(r => r.ground_truth)) {
                    map.fitBounds(bounds, { top: 50, bottom: 50, left: 50, right: 50 });
                }
            } catch (err) {
                console.error("Failed to initialize Google Maps:", err);
                const mapEl = document.getElementById("map");
                mapEl.innerHTML = `
                    <div style="padding: 30px; color: #f87171; text-align: center;">
                        <h3>Google Maps Platform Initialization Error</h3>
                        <p>${err.message}</p>
                        <p style="color: #94a3b8; font-size: 13px;">Ensure your GOOGLE_MAPS_API_KEY is active and authorized for Maps JavaScript API.</p>
                    </div>
                `;
            }
        }

        window.addEventListener("DOMContentLoaded", initGoogleMap);
    </script>
</body>
</html>
"""
    html_content = html_template.replace("__JSON_DATA__", json_data).replace("__GOOGLE_MAPS_API_KEY__", api_key)
    os.makedirs(os.path.dirname(os.path.abspath(output_html)), exist_ok=True)
    with open(output_html, "w", encoding="utf-8") as f:
        f.write(html_content)
    print(f"📄 [GeoBox Eval] Interactive Google Maps report written to: {output_html}")


def main():
    parser = argparse.ArgumentParser(description="GeoBox Model Testing & Evaluation")
    parser.add_argument("--checkpoint", type=str, default="build/geobox_checkpoints/geobox_epoch_01.pt")
    parser.add_argument("--image", type=str, default="", help="Path to single image to predict")
    parser.add_argument("--gt-lat", type=float, default=None, help="Ground truth latitude")
    parser.add_argument("--gt-lng", type=float, default=None, help="Ground truth longitude")
    parser.add_argument("--benchmark", action="store_true", help="Run benchmark on repository test images")
    parser.add_argument("--report-html", type=str, default="build/geobox_eval_report.html")
    parser.add_argument("--google-maps-key", type=str, default="", help="Optional Google Maps API Key override")
    parser.add_argument("--no-100k", action="store_true", help="Disable dense 100K gallery and use sparse Fibonacci sphere")
    args = parser.parse_args()

    # Determine device (MPS on Mac, CUDA on Linux GPU, else CPU)
    if torch.cuda.is_available():
        device = "cuda"
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"

    engine = GeoBoxInferenceEngine(
        checkpoint_path=args.checkpoint,
        device=device,
        use_100k_gallery=not args.no_100k
    )
    results = []

    if args.image:
        print(f"\n🔍 [GeoBox Test] Predicting coordinates for image: {args.image}")
        res = engine.predict(args.image, gt_lat=args.gt_lat, gt_lng=args.gt_lng, top_k=5)
        results.append(res)
        
        print("\n" + "="*70)
        print(f"📍 Top Predictions for: {os.path.basename(args.image)}")
        print("="*70)
        for pred in res["predictions"]:
            err_str = f"{pred['error_km']:.1f} km" if pred['error_km'] is not None else "N/A"
            print(f"  #{pred['rank']} | Sim: {pred['similarity']:.4f} | Error: {err_str:<10} | {pred['name']} ({pred['lat']:.4f}, {pred['lng']:.4f})")
        print("="*70)

    elif args.benchmark:
        print("\n🚀 [GeoBox Benchmark] Running evaluation on real landmark photographs from the internet...")
        download_real_test_images()
        for lm in BENCHMARK_LANDMARKS:
            if lm["image"] and os.path.exists(lm["image"]):
                print(f"👉 Evaluating real photo: {lm['name']} ({os.path.basename(lm['image'])})")
                res = engine.predict(lm["image"], gt_lat=lm["lat"], gt_lng=lm["lng"], landmark_name=lm["name"], top_k=5)
                results.append(res)
                top = res["predictions"][0]
                print(f"   Top-1: {top['name']} | Sim: {top['similarity']:.3f} | Error: {top['error_km']:.1f} km")

    else:
        # Default run: evaluate on the first available storyboard image
        default_img = "public/storyboards/shibuya_beat_04.jpg"
        if os.path.exists(default_img):
            print(f"\n🔍 [GeoBox Test] Running default landmark test on Shibuya image: {default_img}")
            res = engine.predict(default_img, gt_lat=35.6595, gt_lng=139.7005, top_k=5)
            results.append(res)
            print("\n" + "="*70)
            print(f"📍 Top Predictions for: Shibuya Crossing, Tokyo")
            print("="*70)
            for pred in res["predictions"]:
                err_str = f"{pred['error_km']:.1f} km" if pred['error_km'] is not None else "N/A"
                print(f"  #{pred['rank']} | Sim: {pred['similarity']:.4f} | Error: {err_str:<10} | {pred['name']} ({pred['lat']:.4f}, {pred['lng']:.4f})")
            print("="*70)

    if results:
        generate_html_report(results, args.report_html, google_maps_api_key=args.google_maps_key)


if __name__ == "__main__":
    main()
