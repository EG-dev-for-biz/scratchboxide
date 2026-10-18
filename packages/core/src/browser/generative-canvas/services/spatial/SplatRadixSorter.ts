/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Back-to-front sort of splat indices by view-axis depth: an LSD radix sort over the full 32-bit float key in two
 * 16-bit passes, so ordering keeps float32 precision at any depth range (a single 16-bit bucket pass over min..max
 * depth loses it at geo-tile scale: 1e4 m / 65536 = 15 cm buckets). Self-contained so the worker runs the same code.
 * `dists`' buffer is reused as the key array.
 */
export function radixSortBackToFront(dists: Float32Array, count: number, out: Uint32Array, scratch: Uint32Array, counts: Uint32Array): void {
  const keys = new Uint32Array(dists.buffer, dists.byteOffset, count);
  // Order-preserving float -> uint map, inverted so ascending key = descending depth (furthest first).
  for (let i = 0; i < count; i++) {
    const f = keys[i];
    keys[i] = ~((f & 0x80000000) !== 0 ? ~f : (f | 0x80000000)) >>> 0;
  }
  // Pass 1: low 16 bits, identity -> scratch.
  counts.fill(0);
  for (let i = 0; i < count; i++) counts[keys[i] & 0xffff]++;
  let sum = 0;
  for (let k = 0; k < 65536; k++) { const c = counts[k]; counts[k] = sum; sum += c; }
  for (let i = 0; i < count; i++) scratch[counts[keys[i] & 0xffff]++] = i;
  // Pass 2: high 16 bits, stable, scratch -> out.
  counts.fill(0);
  for (let i = 0; i < count; i++) counts[keys[i] >>> 16]++;
  sum = 0;
  for (let k = 0; k < 65536; k++) { const c = counts[k]; counts[k] = sum; sum += c; }
  for (let i = 0; i < count; i++) { const idx = scratch[i]; out[counts[keys[idx] >>> 16]++] = idx; }
}

/**
 * Splat depth sorter: synchronous O(N) two-pass radix sort, with optional Web Worker dispatch off the main thread.
 */
export class SplatRadixSorter {
  private worker?: Worker;
  private isWorkerBusy = false;
  private pendingResolve?: (indices: Uint32Array) => void;
  private currentTaskId = 0;

  // Reusable buffers for synchronous radix sorting
  private syncCounts = new Uint32Array(65536);
  private syncDists?: Float32Array;
  private syncScratch?: Uint32Array;

  constructor(enableWorker = false) {
    if (enableWorker && typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      this.initWorker();
    }
  }

  /** Source of the sort worker (the same radixSortBackToFront as the synchronous path). */
  public static workerSource(): string {
    return `
      self.onmessage = function(e) {
        const { taskId, positions, cx, cy, cz, dx, dy, dz, count } = e.data;
        const posView = new Float32Array(positions);
        const dists = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          const px = posView[i * 3 + 0] - cx;
          const py = posView[i * 3 + 1] - cy;
          const pz = posView[i * 3 + 2] - cz;
          dists[i] = px * dx + py * dy + pz * dz;
        }

        const outIndices = new Uint32Array(count);
        radixSortBackToFront(dists, count, outIndices, new Uint32Array(count), new Uint32Array(65536));

        self.postMessage({ taskId, indices: outIndices.buffer }, [outIndices.buffer]);
      };
      const radixSortBackToFront = (${radixSortBackToFront.toString()});
    `;
  }

  private initWorker(): void {
    const workerCode = SplatRadixSorter.workerSource();

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
   * Synchronous two-pass 32-bit radix sort, O(N). Sorts back-to-front (furthest splats first) along the camera direction.
   */
  public sortSync(
    positions: Float32Array,
    camPos: { x: number; y: number; z: number },
    camDir: { x: number; y: number; z: number },
    count: number,
    outIndices?: Uint32Array
  ): Uint32Array {
    const indices = outIndices && outIndices.length >= count ? outIndices : new Uint32Array(count);
    if (!this.syncDists || this.syncDists.length < count) {
      this.syncDists = new Float32Array(count);
      this.syncScratch = new Uint32Array(count);
    }
    const dists = this.syncDists;
    const cx = camPos.x, cy = camPos.y, cz = camPos.z;
    const dx = camDir.x, dy = camDir.y, dz = camDir.z;
    for (let i = 0; i < count; i++) {
      const px = positions[i * 3 + 0] - cx;
      const py = positions[i * 3 + 1] - cy;
      const pz = positions[i * 3 + 2] - cz;
      dists[i] = px * dx + py * dy + pz * dz;
    }
    radixSortBackToFront(dists, count, indices, this.syncScratch!, this.syncCounts);
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
