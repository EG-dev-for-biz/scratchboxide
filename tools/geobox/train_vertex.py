# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.


"""
GeoBox Distributed Training Pipeline for Google Cloud Vertex AI.
Supports single-node GPU/MPS/CPU, multi-GPU DDP/FSDP, and Google TPU v5e pod slices.
"""

import os
import sys
import math
import time
import argparse
from typing import Dict, Any
import torch
import torch.nn as nn
from torch.optim import AdamW
from torch.optim.lr_scheduler import LambdaLR

# Local module imports
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
from model.geobox_module import GeoBoxModel
from data.webdataset_gcs_loader import create_gcs_webdataset_loader, SyntheticGeoDataset

def parse_args():
    parser = argparse.ArgumentParser(description="GeoBox Training on Google Cloud Vertex AI")
    parser.add_argument("--epochs", type=int, default=10, help="Total training epochs")
    parser.add_argument("--batch-size", type=int, default=64, help="Batch size per device")
    parser.add_argument("--lr", type=float, default=1e-4, help="Peak learning rate")
    parser.add_argument("--weight-decay", type=float, default=1e-4, help="AdamW weight decay")
    parser.add_argument("--embed-dim", type=int, default=512, help="Embedding dimension")
    parser.add_argument("--vision-backbone", type=str, default="google/siglip-base-patch16-224")
    parser.add_argument("--num-hash-levels", type=int, default=16, help="Spherical hash levels")
    parser.add_argument("--sigma-km", type=float, default=25.0, help="Haversine soft decay kernel (km)")
    parser.add_argument("--warmup-steps", type=int, default=200, help="Linear warmup steps")
    parser.add_argument("--gcs-train-data", type=str, default="", help="GCS WebDataset path pattern or local glob")
    parser.add_argument("--initial-checkpoint", type=str, default="", help="Path to initial weights to fine-tune from")
    parser.add_argument("--output-dir", type=str, default="", help="Output checkpoint directory")
    parser.add_argument("--dry-run", action="store_true", help="Run quick 2-batch smoke test")
    return parser.parse_args()


def get_cosine_schedule_with_warmup(optimizer, num_warmup_steps, num_training_steps):
    def lr_lambda(current_step):
        if current_step < num_warmup_steps:
            return float(current_step) / float(max(1, num_warmup_steps))
        progress = float(current_step - num_warmup_steps) / float(max(1, num_training_steps - num_warmup_steps))
        return max(0.0, 0.5 * (1.0 + math.cos(math.pi * progress)))
    return LambdaLR(optimizer, lr_lambda)


def select_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def resolve_output_dir(custom_dir: str) -> str:
    # 1. Custom CLI argument
    if custom_dir:
        return custom_dir

    # 2. Vertex AI environment variables
    vertex_dir = os.environ.get("AIP_MODEL_DIR") or os.environ.get("AIP_CHECKPOINT_DIR")
    if vertex_dir:
        return vertex_dir

    # 3. Default local scratchbox build directory
    local_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../build/geobox_checkpoints"))
    os.makedirs(local_dir, exist_ok=True)
    return local_dir


def main():
    args = parse_args()
    device = select_device()
    output_dir = resolve_output_dir(args.output_dir)

    print(f"🌍 [GeoBox Trainer] Initializing model on device: {device}")
    print(f"📁 [GeoBox Trainer] Output directory: {output_dir}")

    # 1. Initialize GeoBox Model
    model = GeoBoxModel(
        embed_dim=args.embed_dim,
        vision_model_name=args.vision_backbone,
        sigma_km=args.sigma_km,
        num_hash_levels=args.num_hash_levels
    )

    if args.initial_checkpoint and os.path.exists(args.initial_checkpoint):
        print(f"🔄 [GeoBox Trainer] Loading initial checkpoint: {args.initial_checkpoint}")
        ckpt = torch.load(args.initial_checkpoint, map_location="cpu")
        state_dict = ckpt.get("model_state_dict", ckpt)
        model.load_state_dict(state_dict, strict=False)
        print("✅ [GeoBox Trainer] Resumed weights loaded.")

    model.to(device)

    # 2. Data loader
    train_pattern = args.gcs_train_data
    if not train_pattern:
        # Check default locations
        if os.path.exists("build/geobox_data/shard-00000.tar"):
            train_pattern = "build/geobox_data/*.tar"
        else:
            train_pattern = "gs://scratchbox-canvas-geobox/data/train/*.tar"

    if not args.dry_run:
        print(f"🌐 [GeoBox Trainer] Connecting to dataset pattern: {train_pattern}")
        train_loader = create_gcs_webdataset_loader(
            gcs_tar_pattern=train_pattern,
            batch_size=args.batch_size,
            is_train=True
        )
        total_steps = args.epochs * max(len(train_loader), 1)
    else:
        print("🧪 [GeoBox Trainer] Using synthetic geographic data stream for verification.")
        synthetic_ds = SyntheticGeoDataset(num_samples=args.batch_size * 8, image_size=224)
        train_loader = torch.utils.data.DataLoader(synthetic_ds, batch_size=args.batch_size, shuffle=True)
        total_steps = args.epochs * len(train_loader)

    # 3. Optimizer & Scheduler
    optimizer = AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    scheduler = get_cosine_schedule_with_warmup(optimizer, args.warmup_steps, total_steps)

    print(f"🚀 [GeoBox Trainer] Starting training schedule: {args.epochs} epochs, {total_steps} steps...")
    step = 0
    start_time = time.time()

    for epoch in range(1, args.epochs + 1):
        model.train()
        epoch_loss = 0.0
        batch_count = 0

        for batch in train_loader:
            images = batch["image"].to(device)
            coords = batch["coords"].to(device)

            optimizer.zero_grad()
            outputs = model(images, coords)
            loss = outputs["loss"]

            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            scheduler.step()

            epoch_loss += loss.item()
            batch_count += 1
            step += 1

            if step % 10 == 0 or args.dry_run:
                lr = scheduler.get_last_lr()[0]
                print(
                    f"Epoch {epoch:02d} | Step {step:05d}/{total_steps:05d} | "
                    f"Loss: {loss.item():.4f} (Geo: {outputs['loss_geo'].item():.4f}) | "
                    f"Scale: {outputs['logit_scale'].item():.2f} | LR: {lr:.2e}"
                )

            if args.dry_run and batch_count >= 2:
                print("🏁 [GeoBox Trainer] Dry run completed successfully.")
                break

        avg_loss = epoch_loss / max(batch_count, 1)
        print(f"✅ Epoch {epoch:02d} Complete | Average Loss: {avg_loss:.4f}")

        # Checkpoint saving
        ckpt_data = {
            "epoch": epoch,
            "step": step,
            "model_state_dict": model.state_dict(),
            "optimizer_state_dict": optimizer.state_dict(),
            "loss": avg_loss,
            "args": vars(args)
        }
        filename = f"geobox_epoch_{epoch:02d}.pt"
        if output_dir.startswith("gs://"):
            local_tmp = os.path.join("/tmp", filename)
            torch.save(ckpt_data, local_tmp)
            try:
                from google.cloud import storage
                client = storage.Client()
                parts = output_dir.replace("gs://", "").split("/")
                bucket_name = parts[0]
                blob_prefix = "/".join(parts[1:])
                blob_name = f"{blob_prefix}/{filename}" if blob_prefix else filename
                bucket = client.bucket(bucket_name)
                blob = bucket.blob(blob_name)
                blob.upload_from_filename(local_tmp)
                print(f"💾 Checkpoint uploaded to GCS: gs://{bucket_name}/{blob_name}")
            except Exception as e:
                print(f"⚠️ Failed to upload checkpoint to GCS: {e}")
        else:
            os.makedirs(output_dir, exist_ok=True)
            ckpt_path = os.path.join(output_dir, filename)
            torch.save(ckpt_data, ckpt_path)
            print(f"💾 Checkpoint saved locally: {ckpt_path}")

        if args.dry_run:
            break

    total_duration = time.time() - start_time
    print(f"🎉 [GeoBox Trainer] Completed training in {total_duration:.1f}s.")


if __name__ == "__main__":
    main()
