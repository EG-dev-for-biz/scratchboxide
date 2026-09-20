# Copyright (C) 2026 Scratchbox IDE.
# SPDX-License-Identifier: MIT

"""
ONNX Exporter for DepthBox.
Exports the dual-head Depth-Ray model into an ONNX graph for local execution
via ONNX Runtime / WebGPU / CoreML in Scratchbox IDE.
"""

import os
import sys
import argparse
import torch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from model.depthbox_module import DepthBoxModel


class DepthBoxONNXWrapper(torch.nn.Module):
    """
    Wraps DepthBox for standard single-view runtime inference with clean output names.
    """
    def __init__(self, model: DepthBoxModel):
        super().__init__()
        self.model = model

    def forward(self, image: torch.Tensor):
        # image: (B, 3, H, W)
        depth, rays = self.model(image)
        return depth, rays


def parse_args():
    parser = argparse.ArgumentParser(description="Export DepthBox to ONNX")
    parser.add_argument("--checkpoint", type=str, default="", help="Path to PyTorch checkpoint")
    parser.add_argument("--output", type=str, default="depthbox_vitb14.onnx", help="Output ONNX filename")
    parser.add_argument("--height", type=int, default=518, help="Export height (multiple of 14)")
    parser.add_argument("--width", type=int, default=518, help="Export width (multiple of 14)")
    parser.add_argument("--opset", type=int, default=17, help="ONNX opset version")
    return parser.parse_args()


def main():
    args = parse_args()
    print(f"📦 [DepthBox Exporter] Initializing model for ONNX export at {args.height}x{args.width}...")

    model = DepthBoxModel(backbone_name="dinov2_vitb14_reg", pretrained_backbone=False)
    if args.checkpoint and os.path.exists(args.checkpoint):
        print(f"🔄 Loading weights from {args.checkpoint}")
        ckpt = torch.load(args.checkpoint, map_location="cpu")
        model.load_state_dict(ckpt.get("model_state", ckpt), strict=False)

    model.eval()
    wrapper = DepthBoxONNXWrapper(model)

    dummy_input = torch.randn(1, 3, args.height, args.width, dtype=torch.float32)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    print(f"🚀 Exporting ONNX model to {args.output} (opset {args.opset})...")

    torch.onnx.export(
        wrapper,
        dummy_input,
        args.output,
        export_params=True,
        opset_version=args.opset,
        do_constant_folding=True,
        input_names=["image"],
        output_names=["depth_meters", "ray_map"],
        dynamic_axes={
            "image": {0: "batch_size", 2: "height", 3: "width"},
            "depth_meters": {0: "batch_size", 2: "height", 3: "width"},
            "ray_map": {0: "batch_size", 2: "height", 3: "width"}
        }
    )

    print(f"✅ Export completed successfully: {args.output}")


if __name__ == "__main__":
    main()
