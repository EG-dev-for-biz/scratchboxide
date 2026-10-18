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
 *
 * The worker path allocates nothing per sort once warm: the positions transfer buffer and the result index buffer are
 * ping-ponged between threads as Transferables, and the worker keeps its key / scratch / histogram arrays.
 */
export class SplatRadixSorter {
  private worker?: Worker;
  private isWorkerBusy = false;
  private pendingResolve?: (indices: Uint32Array) => void;
  private currentTaskId = 0;
  /** Latest request that arrived while the worker was busy; dispatched when it frees (latest wins). */
  private queued?: { positions: Float32Array; camPos: Vec3Like; camDir: Vec3Like; count: number; onSorted: (indices: Uint32Array) => void };

  // Buffers ping-ponged with the worker: owned by this thread when non-null, by the worker while a sort is in flight.
  private _posTransferBuf: ArrayBuffer | null = null;
  private _indexTransferBuf: ArrayBuffer | null = null;

  // Reusable buffers for synchronous radix sorting
  private syncCounts = new Uint32Array(65536);
  private syncDists?: Float32Array;
  private syncScratch?: Uint32Array;

  constructor(enableWorker = true) {
    if (enableWorker && typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      this.initWorker();
    }
  }

  /** True when sorts run on the background worker (sort() then delivers results asynchronously). */
  public get usesWorker(): boolean {
    return this.worker !== undefined;
  }

  /** Source of the sort worker (the same radixSortBackToFront as the synchronous path). */
  public static workerSource(): string {
    return `
      let dists = new Float32Array(0), scratch = new Uint32Array(0);
      const counts = new Uint32Array(65536);
      self.onmessage = function(e) {
        const { taskId, positions, indices, cx, cy, cz, dx, dy, dz, count } = e.data;
        const posView = new Float32Array(positions);
        if (dists.length < count) { dists = new Float32Array(count); scratch = new Uint32Array(count); }
        for (let i = 0; i < count; i++) {
          const px = posView[i * 3 + 0] - cx;
          const py = posView[i * 3 + 1] - cy;
          const pz = posView[i * 3 + 2] - cz;
          dists[i] = px * dx + py * dy + pz * dz;
        }
        const outBuf = indices && indices.byteLength >= count * 4 ? indices : new ArrayBuffer(count * 4);
        const outIndices = new Uint32Array(outBuf, 0, count);
        radixSortBackToFront(dists, count, outIndices, scratch, counts);
        // Hand both buffers back: the sorted indices and the positions buffer, so the caller reuses them.
        self.postMessage({ taskId, count, indices: outBuf, positions }, [outBuf, positions]);
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
      URL.revokeObjectURL(workerUrl);
      this.worker.onmessage = (e: MessageEvent) => {
        const { taskId, count, indices, positions } = e.data as { taskId: number; count: number; indices: ArrayBuffer; positions: ArrayBuffer };
        this._posTransferBuf = positions;
        this.isWorkerBusy = false;
        const res = this.pendingResolve;
        this.pendingResolve = undefined;
        if (taskId === this.currentTaskId && res) {
          // The callback consumes the view synchronously; the buffer then goes back to the worker on the next sort.
          res(new Uint32Array(indices, 0, count));
        }
        this._indexTransferBuf = indices;
        const next = this.queued;
        if (next) {
          this.queued = undefined;
          this.sort(next.positions, next.camPos, next.camDir, next.count, next.onSorted);
        }
      };
    } catch {
      this.worker = undefined;
    }
  }

  /**
   * Synchronous two-pass 32-bit radix sort, O(N). Sorts back-to-front (furthest splats first) along the camera direction.
   * Supersedes any worker sort still in flight (its result is discarded).
   */
  public sortSync(
    positions: Float32Array,
    camPos: Vec3Like,
    camDir: Vec3Like,
    count: number,
    outIndices?: Uint32Array
  ): Uint32Array {
    this.currentTaskId++;
    this.queued = undefined;
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
   * Sorts on the background Web Worker when one is running (asynchronous; while a sort is in flight the latest request
   * is queued and dispatched when it completes), otherwise synchronously.
   */
  public sort(
    positions: Float32Array,
    camPos: Vec3Like,
    camDir: Vec3Like,
    count: number,
    onSorted: (indices: Uint32Array) => void
  ): void {
    if (!this.worker) {
      onSorted(this.sortSync(positions, camPos, camDir, count));
      return;
    }
    if (this.isWorkerBusy) {
      this.queued = { positions, camPos: { x: camPos.x, y: camPos.y, z: camPos.z }, camDir: { x: camDir.x, y: camDir.y, z: camDir.z }, count, onSorted };
      return;
    }
    this.isWorkerBusy = true;
    const taskId = ++this.currentTaskId;
    this.pendingResolve = onSorted;

    const needed = count * 3 * Float32Array.BYTES_PER_ELEMENT;
    if (!this._posTransferBuf || this._posTransferBuf.byteLength < needed) {
      this._posTransferBuf = new ArrayBuffer(needed);
    }
    new Float32Array(this._posTransferBuf, 0, count * 3).set(positions.subarray(0, count * 3));
    const posBuf = this._posTransferBuf;
    const idxBuf = this._indexTransferBuf;
    this._posTransferBuf = null;
    this._indexTransferBuf = null;
    const transfer: ArrayBuffer[] = idxBuf ? [posBuf, idxBuf] : [posBuf];
    this.worker.postMessage(
      { taskId, positions: posBuf, indices: idxBuf, cx: camPos.x, cy: camPos.y, cz: camPos.z,
        dx: camDir.x, dy: camDir.y, dz: camDir.z, count },
      transfer
    );
  }

  public dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = undefined;
    }
    this.queued = undefined;
    this.pendingResolve = undefined;
    this._posTransferBuf = null;
    this._indexTransferBuf = null;
  }
}

interface Vec3Like { x: number; y: number; z: number }
