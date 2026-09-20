# Copyright (C) 2026 Scratchbox IDE.
# SPDX-License-Identifier: MIT


"""
High-throughput WebDataset & GCS Streaming Dataloader for GeoBox.
Supports streaming or caching .tar shards from Google Cloud Storage or local disk.
"""

import os
import io
import glob
import json
import tarfile
from typing import Iterator, Dict, Any, Optional, List
import torch
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms
from PIL import Image

class GeoBoxDataTransform:
    """
    Standard visual augmentations for GeoBox training and evaluation.
    """
    def __init__(self, image_size: int = 224, is_train: bool = True):
        if is_train:
            self.transform = transforms.Compose([
                transforms.RandomResizedCrop(image_size, scale=(0.7, 1.0)),
                transforms.RandomHorizontalFlip(p=0.5),
                transforms.ColorJitter(brightness=0.15, contrast=0.15, saturation=0.15),
                transforms.ToTensor(),
                transforms.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5]) # SigLIP standard
            ])
        else:
            self.transform = transforms.Compose([
                transforms.Resize((image_size, image_size)),
                transforms.ToTensor(),
                transforms.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5])
            ])

    def __call__(self, img: Image.Image) -> torch.Tensor:
        return self.transform(img)


class TarShardGeoDataset(Dataset):
    """
    High-performance dataset that directly reads paired .jpg and .json from WebDataset tar shards.
    """
    def __init__(self, shard_paths: List[str], image_size: int = 224, is_train: bool = True):
        self.transform = GeoBoxDataTransform(image_size=image_size, is_train=is_train)
        self.samples = []

        for shard_path in shard_paths:
            if not os.path.exists(shard_path):
                continue
            with tarfile.open(shard_path, "r") as tar:
                members = tar.getmembers()
                # Group by sample basename
                file_map: Dict[str, Dict[str, tarfile.TarInfo]] = {}
                for m in members:
                    base, ext = os.path.splitext(m.name)
                    ext = ext.lstrip(".").lower()
                    if base not in file_map:
                        file_map[base] = {}
                    file_map[base][ext] = m

                for base, exts in file_map.items():
                    img_ext = None
                    for candidate in ["jpg", "jpeg", "png"]:
                        if candidate in exts:
                            img_ext = candidate
                            break

                    if img_ext and "json" in exts:
                        # Extract into memory
                        img_f = tar.extractfile(exts[img_ext])
                        json_f = tar.extractfile(exts["json"])
                        if img_f and json_f:
                            try:
                                img_bytes = img_f.read()
                                meta = json.loads(json_f.read().decode("utf-8"))
                                lat = float(meta.get("lat", 0.0))
                                lng = float(meta.get("lng", 0.0))
                                self.samples.append({
                                    "img_bytes": img_bytes,
                                    "lat": lat,
                                    "lng": lng,
                                    "meta": meta
                                })
                            except Exception:
                                continue

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> Dict[str, Any]:
        item = self.samples[idx]
        img = Image.open(io.BytesIO(item["img_bytes"])).convert("RGB")
        img_tensor = self.transform(img)
        coords = torch.tensor([item["lat"], item["lng"]], dtype=torch.float32)

        meta = item["meta"]
        text_str = (
            f"Location: {meta.get('name', 'Landmark')} | "
            f"City: {meta.get('city', 'Unknown')} | "
            f"Country: {meta.get('countryCode', 'Unknown')}"
        )

        return {
            "image": img_tensor,
            "coords": coords,
            "metadata": meta,
            "text": text_str
        }


class SyntheticGeoDataset(Dataset):
    """
    Fast synthetic/mock dataset for testing pipeline dataflow when no shards exist.
    """
    def __init__(self, num_samples: int = 256, image_size: int = 224):
        self.num_samples = num_samples
        self.image_size = image_size
        self.transform = GeoBoxDataTransform(image_size=image_size, is_train=True)

    def __len__(self) -> int:
        return self.num_samples

    def __getitem__(self, idx: int) -> Dict[str, Any]:
        img = Image.new("RGB", (self.image_size, self.image_size), color=(
            (idx * 37) % 255,
            (idx * 73) % 255,
            (idx * 109) % 255
        ))
        img_tensor = self.transform(img)

        lat = (torch.rand(1).item() * 140.0) - 70.0
        lng = (torch.rand(1).item() * 360.0) - 180.0
        coords = torch.tensor([lat, lng], dtype=torch.float32)

        meta = {
            "id": f"sample_{idx}",
            "lat": lat,
            "lng": lng,
            "elevationM": 100.0,
            "countryCode": "US" if lng < -50 else "EU",
            "biome": "temperate_forest"
        }

        return {
            "image": img_tensor,
            "coords": coords,
            "metadata": meta,
            "text": f"Synthetic Sample {idx}"
        }


def create_gcs_webdataset_loader(
    gcs_tar_pattern: str,
    batch_size: int = 64,
    num_workers: int = 2,
    image_size: int = 224,
    is_train: bool = True
) -> DataLoader:
    """
    Resolves local or GCS tar shards and returns an optimized DataLoader.
    """
    shard_paths = []

    if gcs_tar_pattern.startswith("gs://"):
        cache_dir = "/tmp/geobox_cache"
        os.makedirs(cache_dir, exist_ok=True)
        print(f"☁️ [GeoBox Loader] Fetching shards from GCS: {gcs_tar_pattern}...")
        # Download shards to local cache
        os.system(f"gcloud storage cp {gcs_tar_pattern} {cache_dir}/")
        shard_paths = sorted(glob.glob(os.path.join(cache_dir, "*.tar")))
    elif os.path.exists(gcs_tar_pattern) or "*" in gcs_tar_pattern:
        shard_paths = sorted(glob.glob(gcs_tar_pattern))

    if shard_paths:
        print(f"📦 [GeoBox Loader] Loading from {len(shard_paths)} tar shards...")
        ds = TarShardGeoDataset(shard_paths, image_size=image_size, is_train=is_train)
        if len(ds) > 0:
            print(f"✅ [GeoBox Loader] Initialized dataset with {len(ds)} real geotagged images.")
            return DataLoader(
                ds,
                batch_size=min(batch_size, len(ds)),
                shuffle=is_train,
                num_workers=num_workers,
                pin_memory=True
            )

    print("⚠️ [GeoBox Loader] No valid shards found. Falling back to SyntheticGeoDataset.")
    fallback_ds = SyntheticGeoDataset(num_samples=batch_size * 4, image_size=image_size)
    return DataLoader(fallback_ds, batch_size=batch_size, shuffle=is_train)
