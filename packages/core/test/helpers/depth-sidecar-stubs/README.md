Test-only stand-ins for the depth sidecar's Python dependencies (tools/depth/panorama_depth.py), put on PYTHONPATH
by depth-sidecar tests so the real sidecar script runs without downloading model weights:

- `PIL/`: reads 8-bit RGB/RGBA PNGs written by the tests (filter type 0 rows) and saves previews as raw numpy.
- `transformers/`: a depth "model" that answers a constant planar depth (STUB_DEPTH_METERS). It exists only when
  STUB_DEPTH_METERS is set; otherwise importing it fails exactly like a missing transformers install.

Nothing here is used outside tests.
