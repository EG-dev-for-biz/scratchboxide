# VFX Thinking Mode: Multi-Metric QA

> **When to load:** Any task involving verifying a composited or processed video plate — upscales, card replacements, retimes, color grades — where you need to confirm correctness beyond a visual check. Load when you need to catch: hallucinated detail, temporal slippage, geometric drift, color bias, or local artifacts that aren't visible in a quick playback.

---

## Platform note

In Scratchbox IDE, use the native **`video_qa_check`** Gemini tool to run the delta spike check, consecutive-frame and worst-block PSNR, 8×8 blockiness, temporal stability, and colour drift metrics automatically (all computed from decoded frames). This skill covers the interpretation of results and manual implementation for custom pipelines.

---

## The core idea

Different failure modes in VFX are invisible to different metrics. A single-metric QA catches only one category of problem. **Multi-metric QA** runs independent measurements that each catch a different failure class — so any single problem surfaces in at least one metric even if it passes the others.

| Metric | What it catches | What it misses |
|---|---|---|
| PSNR (global) | Overall signal quality vs. reference | Local artifacts hidden by global average |
| PSNR (worst block) | Single-frame local hallucinations | Temporal problems |
| MSE frame alignment | Temporal slip (frames out of sync) | Geometric or color issues |
| Phase correlation | Sub-pixel geometric registration at landmarks | Temporal or color issues |
| Delta spike check | Morph-cuts in generative video | Geometry, color, temporal slip |
| Temporal stability | Jitter or tremor in the replacement | Single-frame artifacts |
| Color bias | Systematic color shift per channel | Spatial or temporal issues |
| ECC correlation coefficient | Track quality for each frame | Content quality |

Run all of them. Each one is cheap; together they catch the full failure space.

---

## Metric 1: PSNR — global and worst block

```python
import numpy as np
import cv2

def psnr(a, b):
    """PSNR between two uint8 frames (same shape)."""
    mse = np.mean((a.astype(np.float32) - b.astype(np.float32)) ** 2)
    if mse == 0:
        return float('inf')
    return 10 * np.log10(255**2 / mse)

def worst_block_psnr(a, b, block_size=64):
    """
    Find the 64×64 block with the worst (lowest) PSNR.
    Flags local hallucinated detail that a global average hides.
    """
    H, W = a.shape[:2]
    worst = float('inf')
    worst_loc = (0, 0)
    for y in range(0, H - block_size, block_size // 2):
        for x in range(0, W - block_size, block_size // 2):
            block_a = a[y:y+block_size, x:x+block_size]
            block_b = b[y:y+block_size, x:x+block_size]
            p = psnr(block_a, block_b)
            if p < worst:
                worst = p
                worst_loc = (x, y)
    return worst, worst_loc
```

**Pass threshold:** global PSNR > 38 dB, worst block PSNR > 28 dB. A worst-block PSNR below 25 dB indicates a localized artifact.

---

## Metric 2: MSE frame alignment (temporal slip check)

For every frame, check whether the processed plate is temporally aligned to the source — compare it against source frames at offsets −3..+3. If offset 0 is not the closest match, the plate has slipped by at least one frame.

```python
def frame_alignment_check(processed_frames, source_frames, check_range=3):
    slipped_frames = []
    for i, proc in enumerate(processed_frames):
        proc_small = cv2.resize(proc, (480, 270))
        mse_at_offset = {}
        for offset in range(-check_range, check_range + 1):
            j = max(0, min(len(source_frames) - 1, i + offset))
            src_small = cv2.resize(source_frames[j], (480, 270))
            mse_at_offset[offset] = np.mean((proc_small.astype(float)
                                             - src_small.astype(float))**2)
        best_offset = min(mse_at_offset, key=mse_at_offset.get)
        if best_offset != 0:
            slipped_frames.append({
                'frame': i, 'best_offset': best_offset,
                'mse_0': mse_at_offset[0]
            })
    return slipped_frames
```

**Pass threshold:** Every frame's best offset should be 0. Any slip is a critical failure.

---

## Metric 3: Phase correlation (sub-pixel geometric registration)

```python
def patch_shift(a_patch, b_patch):
    """Sub-pixel (dx, dy) shift of b relative to a via Hanning-windowed phase correlation."""
    h, w = a_patch.shape[:2]
    win = np.outer(np.hanning(h), np.hanning(w))
    A = np.fft.fft2(a_patch.astype(np.float32) * win)
    B = np.fft.fft2(b_patch.astype(np.float32) * win)
    cross = A * np.conj(B)
    cross /= (np.abs(cross) + 1e-8)
    R = np.real(np.fft.ifft2(cross))
    peak_y, peak_x = np.unravel_index(R.argmax(), R.shape)
    if 0 < peak_y < h-1 and 0 < peak_x < w-1:
        dy = peak_y - (R[peak_y+1, peak_x] - R[peak_y-1, peak_x]) / \
             (2*(2*R[peak_y, peak_x] - R[peak_y+1, peak_x] - R[peak_y-1, peak_x]) + 1e-8)
        dx = peak_x - (R[peak_y, peak_x+1] - R[peak_y, peak_x-1]) / \
             (2*(2*R[peak_y, peak_x] - R[peak_y, peak_x+1] - R[peak_y, peak_x-1]) + 1e-8)
        if dy > h // 2: dy -= h
        if dx > w // 2: dx -= w
        return dx, dy
    return float(peak_x), float(peak_y)
```

**Pass threshold:** |dx| < 0.5 px, |dy| < 0.5 px at all landmark regions.

---

## Metric 4: Delta spike check (generative video continuity)

```python
def frame_deltas(frames_gray):
    """Per-frame mean absolute pixel change. High spikes = morph-cut."""
    deltas = []
    for i in range(1, len(frames_gray)):
        delta = np.mean(np.abs(frames_gray[i].astype(float)
                               - frames_gray[i-1].astype(float)))
        deltas.append(delta)
    return np.array(deltas)
```

| Delta | Status |
|---|---|
| < 4.1 | Clean interpolation |
| 4.1 – 15.0 | Acceptable |
| > 15.0 | Morph-cut — conditioning failed |

---

## Metric 5: Temporal stability (jitter measurement)

```python
def temporal_stability(processed_region_sequence, source_region_sequence):
    """Mean |d_processed - d_source| where d = frame-to-frame change."""
    dp = np.diff(processed_region_sequence.astype(float), axis=0)
    ds = np.diff(source_region_sequence.astype(float), axis=0)
    return np.mean(np.abs(dp - ds))
```

---

## Metric 6: Color bias

```python
def color_bias(processed_frames, source_frames):
    """Mean (processed - source) per BGR channel across all frames."""
    diffs = [proc.astype(float) - src.astype(float)
             for proc, src in zip(processed_frames, source_frames)]
    per_channel = np.mean([d.mean(axis=(0,1)) for d in diffs], axis=0)
    return {'B': per_channel[0], 'G': per_channel[1], 'R': per_channel[2]}
```

**Pass threshold:** |bias| < 2 DN per channel. Larger bias indicates a systematic grade difference.

---

## QA report format

```python
def print_qa_report(results):
    print("─" * 60)
    print("VFX QA REPORT")
    print("─" * 60)
    print(f"PSNR (global mean):      {results['psnr_mean']:.1f} dB  {'✓' if results['psnr_mean']>38 else '✗'}")
    print(f"PSNR (worst block):      {results['psnr_worst_block']:.1f} dB  {'✓' if results['psnr_worst_block']>28 else '✗'}")
    print(f"Temporal slip frames:    {len(results['slipped_frames'])}  {'✓' if not results['slipped_frames'] else '✗'}")
    print(f"Phase error (max):       {results['phase_error_max']:.2f} px  {'✓' if results['phase_error_max']<0.5 else '✗'}")
    print(f"Delta spike (max):       {results['delta_max']:.1f}  {'✓' if results['delta_max']<15 else '✗'}")
    print(f"Temporal stability:      {results['temporal_stability']:.2f}  {'✓' if results['temporal_stability']<2 else '✗'}")
    print(f"Color bias B/G/R:        {results['color_bias']['B']:.1f} / {results['color_bias']['G']:.1f} / {results['color_bias']['R']:.1f}")
    print("─" * 60)
```

---

## Which metrics to run per task type

| Task | Required metrics |
|---|---|
| AI generative video QC | Delta spike, temporal stability |
| Upscale plate QC | PSNR global + worst block, phase correlation, color bias |
| Card/product replacement | Phase correlation at corners, temporal stability, color bias |
| Retime / frame interpolation | MSE frame alignment, temporal stability |
| Full composite | All 6 |
