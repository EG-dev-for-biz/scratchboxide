/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * High-performance 16-bit counting/radix sorter for 3D Gaussian Splats.
 * Supports synchronous O(N) sorting and asynchronous Web Worker sorting
 * off the main thread to sustain 60 FPS under >1M splat counts.
 */
export class SplatRadixSorter {
  private worker?: Worker;
  private isWorkerBusy = false;
  private pendingResolve?: (indices: Uint32Array) => void;
  private currentTaskId = 0;

  // Reusable buffers for synchronous radix sorting
  private syncCounts = new Uint32Array(65536);
  private syncOffsets = new Uint32Array(65536);

  constructor(enableWorker = false) {
    if (enableWorker && typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      this.initWorker();
    }
  }

  private initWorker(): void {
    const workerCode = `
      self.onmessage = function(e) {
        const { taskId, positions, cx, cy, cz, dx, dy, dz, count } = e.data;
        const posView = new Float32Array(positions);
        const dists = new Float32Array(count);
        let minDist = Infinity;
        let maxDist = -Infinity;

        for (let i = 0; i < count; i++) {
          const px = posView[i * 3 + 0] - cx;
          const py = posView[i * 3 + 1] - cy;
          const pz = posView[i * 3 + 2] - cz;
          const d = px * dx + py * dy + pz * dz;
          dists[i] = d;
          if (d < minDist) minDist = d;
          if (d > maxDist) maxDist = d;
        }

        const outIndices = new Uint32Array(count);
        const range = maxDist - minDist;

        if (range > 1e-6) {
          const BUCKETS = 65536;
          const counts = new Uint32Array(BUCKETS);
          const keys = new Uint16Array(count);
          const norm = 65535.0 / range;

          for (let i = 0; i < count; i++) {
            const k = Math.min(65535, Math.max(0, ((dists[i] - minDist) * norm) | 0));
            keys[i] = k;
            counts[k]++;
          }

          // Back-to-front cumulative prefix sum (descending order)
          const offsets = new Uint32Array(BUCKETS);
          let sum = 0;
          for (let k = BUCKETS - 1; k >= 0; k--) {
            offsets[k] = sum;
            sum += counts[k];
          }

          for (let i = 0; i < count; i++) {
            const k = keys[i];
            outIndices[offsets[k]++] = i;
          }
        } else {
          for (let i = 0; i < count; i++) outIndices[i] = i;
        }

        self.postMessage({ taskId, indices: outIndices.buffer }, [outIndices.buffer]);
      };
    `;

    try {
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      this.worker = new Worker(workerUrl);
      this.worker.onmessage = (e: MessageEvent) => {
        const { taskId, indices } = e.data;
        if (taskId === this.currentTaskId && this.pendingResolve) {
          const res = this.pendingResolve;
          this.pendingResolve = undefined;
          this.isWorkerBusy = false;
          res(new Uint32Array(indices));
        } else {
          this.isWorkerBusy = false;
        }
      };
    } catch {
      this.worker = undefined;
    }
  }

  /**
   * Fast synchronous 16-bit counting sort: O(N) runtime.
   * Sorts back-to-front (furthest splats first) along the camera direction.
   */
  public sortSync(
    positions: Float32Array,
    camPos: { x: number; y: number; z: number },
    camDir: { x: number; y: number; z: number },
    count: number,
    outIndices?: Uint32Array
  ): Uint32Array {
    const indices = outIndices && outIndices.length >= count ? outIndices : new Uint32Array(count);
    const dists = new Float32Array(count);

    let minDist = Infinity;
    let maxDist = -Infinity;

    const cx = camPos.x, cy = camPos.y, cz = camPos.z;
    const dx = camDir.x, dy = camDir.y, dz = camDir.z;

    for (let i = 0; i < count; i++) {
      const px = positions[i * 3 + 0] - cx;
      const py = positions[i * 3 + 1] - cy;
      const pz = positions[i * 3 + 2] - cz;
      const d = px * dx + py * dy + pz * dz;
      dists[i] = d;
      if (d < minDist) minDist = d;
      if (d > maxDist) maxDist = d;
    }

    const range = maxDist - minDist;
    if (range <= 1e-6) {
      for (let i = 0; i < count; i++) indices[i] = i;
      return indices;
    }

    const BUCKETS = 65536;
    const counts = this.syncCounts;
    counts.fill(0);

    const keys = new Uint16Array(count);
    const norm = 65535.0 / range;

    for (let i = 0; i < count; i++) {
      const k = Math.min(65535, Math.max(0, ((dists[i] - minDist) * norm) | 0));
      keys[i] = k;
      counts[k]++;
    }

    // Cumulative sum in reverse order: bucket 65535 (furthest) gets first offset
    const offsets = this.syncOffsets;
    let sum = 0;
    for (let k = BUCKETS - 1; k >= 0; k--) {
      offsets[k] = sum;
      sum += counts[k];
    }

    for (let i = 0; i < count; i++) {
      const k = keys[i];
      indices[offsets[k]++] = i;
    }

    return indices;
  }

  /**
   * Dispatches sorting to the background Web Worker if available and idle;
   * falls back to fast synchronous radix sort.
   */
  public sort(
    positions: Float32Array,
    camPos: { x: number; y: number; z: number },
    camDir: { x: number; y: number; z: number },
    count: number,
    onSorted: (indices: Uint32Array) => void
  ): void {
    if (this.worker && !this.isWorkerBusy) {
      this.isWorkerBusy = true;
      const taskId = ++this.currentTaskId;
      this.pendingResolve = onSorted;

      // Transfer position copy
      const posCopy = positions.slice(0, count * 3);
      this.worker.postMessage(
        {
          taskId,
          positions: posCopy.buffer,
          cx: camPos.x,
          cy: camPos.y,
          cz: camPos.z,
          dx: camDir.x,
          dy: camDir.y,
          dz: camDir.z,
          count
        },
        [posCopy.buffer]
      );
      return;
    }

    // Fallback: fast sync sort
    const sorted = this.sortSync(positions, camPos, camDir, count);
    onSorted(sorted);
  }

  public dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = undefined;
    }
  }
}
