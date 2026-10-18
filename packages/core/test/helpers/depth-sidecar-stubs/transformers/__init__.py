# Test stand-in for transformers (see ../README.md): a constant planar depth of STUB_DEPTH_METERS metres.
import os

if not os.environ.get("STUB_DEPTH_METERS"):
    raise ImportError("No module named 'transformers' (stub disabled: STUB_DEPTH_METERS is not set)")

import torch

_DEPTH = float(os.environ["STUB_DEPTH_METERS"])


class _Inputs(dict):
    def to(self, device):
        return self


class _Processor:
    def __call__(self, images, return_tensors):
        # One image, or a batch (list) of same-size images, like the real processor.
        batch = images if isinstance(images, list) else [images]
        h, w = batch[0].shape[:2]
        return _Inputs(pixel_values=torch.zeros(len(batch), 3, h, w))


class _Output:
    def __init__(self, depth):
        self.predicted_depth = depth


class _Model:
    def to(self, device):
        return self

    def eval(self):
        return self

    def __call__(self, pixel_values):
        n, _, h, w = pixel_values.shape
        return _Output(torch.full((n, h, w), _DEPTH))


class AutoImageProcessor:
    @staticmethod
    def from_pretrained(name):
        return _Processor()


class AutoModelForDepthEstimation:
    @staticmethod
    def from_pretrained(name):
        return _Model()
