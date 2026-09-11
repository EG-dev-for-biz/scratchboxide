/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Stable on-disk byte cache for Google Photorealistic 3D Tiles in IndexedDB.
// Strips Google's rotating session & key query params so cache hits survive reloads.
// Adheres strictly to Google Terms with a hard 30-day TTL.

const DB_NAME = "scratchbox-photoreal-tiles-v1";
const STORE = "tiles";
const TS_INDEX = "ts";

/** 30 days — the standard Google Map Tiles caching TTL ceiling. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Persistent budget in bytes (1.5 GB). Oldest entries are pruned when exceeded. */
const MAX_BYTES = 1500 * 1024 * 1024;
const PRUNE_TARGET_FRACTION = 0.85;

export interface CacheEntry {
  bytes: ArrayBuffer;
  ts: number;
  size: number;
}

/**
 * Compresses a Uint8Array using the LZW algorithm.
 */
export function compressLZW(data: Uint8Array): Uint8Array {
  const dict = new Map<string, number>();
  for (let i = 0; i < 256; i++) {
    dict.set(String.fromCharCode(i), i);
  }

  let dictSize = 256;
  let currChar = "";
  const result: number[] = [];

  for (let i = 0; i < data.length; i++) {
    const byte = data[i] as number;
    const byteChar = String.fromCharCode(byte);
    const combined = currChar + byteChar;
    if (dict.has(combined)) {
      currChar = combined;
    } else {
      result.push(dict.get(currChar)!);
      if (dictSize < 65536) {
        dict.set(combined, dictSize++);
      }
      currChar = byteChar;
    }
  }
  if (currChar !== "") {
    result.push(dict.get(currChar)!);
  }

  const buffer = new ArrayBuffer(result.length * 2);
  const view = new Uint16Array(buffer);
  for (let i = 0; i < result.length; i++) {
    view[i] = result[i] as number;
  }
  return new Uint8Array(buffer);
}

/**
 * Decompresses a Uint8Array representing LZW compressed codes (as Uint16Array) back to a Uint8Array.
 */
export function decompressLZW(compressed: Uint8Array): Uint8Array {
  if (compressed.length === 0) return new Uint8Array(0);

  const codes = new Uint16Array(compressed.buffer, compressed.byteOffset, compressed.length / 2);
  const dict = new Map<number, string>();
  for (let i = 0; i < 256; i++) {
    dict.set(i, String.fromCharCode(i));
  }

  let dictSize = 256;
  const currCode = codes[0] as number;
  const val = dict.get(currCode);
  if (val === undefined) return new Uint8Array(0);

  const result: string[] = [val];
  let oldStr = val;

  for (let i = 1; i < codes.length; i++) {
    const code = codes[i] as number;
    let s = dict.get(code);
    if (s !== undefined) {
      // found
    } else if (code === dictSize) {
      s = oldStr + oldStr.charAt(0);
    } else {
      return new Uint8Array(0);
    }

    result.push(s);
    if (dictSize < 65536) {
      dict.set(dictSize++, oldStr + s.charAt(0));
    }
    oldStr = s;
  }

  const str = result.join("");
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i);
  }
  return out;
}

const MAGIC_GZIP = new Uint8Array([0x53, 0x50, 0x43, 0x31]); // "SPC1"
const MAGIC_LZW  = new Uint8Array([0x53, 0x50, 0x43, 0x32]); // "SPC2"

function matchesMagic(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Compresses an ArrayBuffer using native CompressionStream (gzip) if available,
 * otherwise falls back to a lightweight LZW implementation.
 */
export async function compressBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof globalThis !== "undefined" && "CompressionStream" in globalThis && typeof Response !== "undefined") {
    try {
      const stream = new Response(buffer).body?.pipeThrough(
        new (globalThis as any).CompressionStream("gzip")
      );
      if (stream) {
        const compressed = await new Response(stream).arrayBuffer();
        const out = new Uint8Array(compressed.byteLength + MAGIC_GZIP.length);
        out.set(MAGIC_GZIP, 0);
        out.set(new Uint8Array(compressed), MAGIC_GZIP.length);
        return out.buffer;
      }
    } catch {
      // fallback
    }
  }

  const compressed = compressLZW(new Uint8Array(buffer));
  const out = new Uint8Array(compressed.byteLength + MAGIC_LZW.length);
  out.set(MAGIC_LZW, 0);
  out.set(compressed, MAGIC_LZW.length);
  return out.buffer;
}

/**
 * Decompresses an ArrayBuffer representing compressed bytes back to its original form.
 */
export async function decompressBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4) return buffer;

  const isGzip = matchesMagic(bytes, MAGIC_GZIP);
  const isLzw = matchesMagic(bytes, MAGIC_LZW);

  if (!isGzip && !isLzw) {
    return buffer;
  }

  const data = bytes.slice(4);

  if (isGzip) {
    if (typeof globalThis !== "undefined" && "DecompressionStream" in globalThis && typeof Response !== "undefined") {
      try {
        const stream = new Response(data).body?.pipeThrough(
          new (globalThis as any).DecompressionStream("gzip")
        );
        if (stream) {
          return await new Response(stream).arrayBuffer();
        }
      } catch {
        // fallback
      }
    }
  } else if (isLzw) {
    return decompressLZW(data).buffer as ArrayBuffer;
  }

  return buffer;
}

/**
 * Normalizes a tile URL to a stable key: origin + pathname, dropping rotating session queries.
 */
export function tileCacheKey(url: string): string | null {
  try {
    let u: URL;
    if (url.startsWith("/") || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      u = new URL(url, "https://tile.googleapis.com");
    } else {
      u = new URL(url);
    }
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

export class PhotorealTileCache {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private totalBytes = 0;
  private totalsSeeded = false;
  private pruning = false;
  private memoryCache = new Map<string, ArrayBuffer>();
  private inMemoryFallbackStore = new Map<string, CacheEntry>();

  public isAvailable(): boolean {
    return (
      typeof globalThis !== "undefined" &&
      typeof (globalThis as any).indexedDB !== "undefined"
    );
  }

  private getDb(): Promise<IDBDatabase> {
    if (!this.isAvailable()) {
      return Promise.reject(new Error("IndexedDB unavailable"));
    }
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE);
          store.createIndex(TS_INDEX, "ts", { unique: false });
        }
      };
      req.onsuccess = (event) =>
        resolve((event.target as IDBOpenDBRequest).result);
      req.onerror = (event) =>
        reject((event.target as IDBOpenDBRequest).error);
    });
    return this.dbPromise;
  }

  private async seedTotals(db: IDBDatabase): Promise<void> {
    if (this.totalsSeeded) return;
    this.totalsSeeded = true;

    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem("scratchbox_photoreal_cache_size");
      if (stored !== null) {
        this.totalBytes = Number(stored);
        return;
      }
    }

    try {
      const count = await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      this.totalBytes = count === 0 ? 0 : count * 15000;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("scratchbox_photoreal_cache_size", String(this.totalBytes));
      }
    } catch (err) {
      this.totalBytes = 0;
    }
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    if (this.memoryCache.has(key)) {
      return this.memoryCache.get(key)!;
    }

    // In-memory fallback if IndexedDB is unavailable
    if (!this.isAvailable()) {
      const entry = this.inMemoryFallbackStore.get(key);
      if (!entry) return null;
      if (Date.now() - entry.ts > TTL_MS) {
        this.inMemoryFallbackStore.delete(key);
        return null;
      }
      return decompressBuffer(entry.bytes);
    }

    try {
      const db = await this.getDb();
      const entry = await new Promise<CacheEntry | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      if (!entry) return null;

      if (Date.now() - entry.ts > TTL_MS) {
        void this.delete(key);
        return null;
      }

      const decompressed = await decompressBuffer(entry.bytes);
      if (this.memoryCache.size > 200) {
        const firstKey = this.memoryCache.keys().next().value;
        if (firstKey) this.memoryCache.delete(firstKey);
      }
      this.memoryCache.set(key, decompressed);
      return decompressed;
    } catch {
      return null;
    }
  }

  async set(key: string, bytes: ArrayBuffer): Promise<void> {
    try {
      if (this.memoryCache.size > 200) {
        const firstKey = this.memoryCache.keys().next().value;
        if (firstKey) this.memoryCache.delete(firstKey);
      }
      this.memoryCache.set(key, bytes);

      const compressed = await compressBuffer(bytes);
      const size = compressed.byteLength;
      const entry: CacheEntry = {
        bytes: compressed,
        ts: Date.now(),
        size,
      };

      if (!this.isAvailable()) {
        const oldEntry = this.inMemoryFallbackStore.get(key);
        if (oldEntry) {
          this.totalBytes -= oldEntry.size;
        }
        this.inMemoryFallbackStore.set(key, entry);
        this.totalBytes += size;
        return;
      }

      const db = await this.getDb();
      await this.seedTotals(db);

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const req = tx.objectStore(STORE).put(entry, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });

      this.totalBytes += size;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("scratchbox_photoreal_cache_size", String(this.totalBytes));
      }
      if (this.totalBytes > MAX_BYTES) {
        void this.prune();
      }
    } catch {
      // Ignore
    }
  }

  public async delete(key: string): Promise<void> {
    this.memoryCache.delete(key);
    const existing = this.inMemoryFallbackStore.get(key);
    if (existing) {
      this.totalBytes = Math.max(0, this.totalBytes - existing.size);
      this.inMemoryFallbackStore.delete(key);
    }

    if (!this.isAvailable()) return;

    try {
      const db = await this.getDb();
      const size = await new Promise<number>((resolve) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result?.size ?? 0);
        req.onerror = () => resolve(0);
      });

      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, "readwrite");
        const req = tx.objectStore(STORE).delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });

      this.totalBytes = Math.max(0, this.totalBytes - size);
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("scratchbox_photoreal_cache_size", String(this.totalBytes));
      }
    } catch {
      // Ignore
    }
  }

  private async prune(): Promise<void> {
    if (this.pruning || !this.isAvailable()) return;
    this.pruning = true;
    try {
      const db = await this.getDb();
      const target = MAX_BYTES * PRUNE_TARGET_FRACTION;

      while (this.totalBytes > target) {
        const oldestKey = await new Promise<string | null>((resolve) => {
          const tx = db.transaction(STORE, "readonly");
          const index = tx.objectStore(STORE).index(TS_INDEX);
          const req = index.openCursor(null, "next");
          req.onsuccess = () => {
            const cursor = req.result;
            resolve(cursor ? (cursor.primaryKey as string) : null);
          };
          req.onerror = () => resolve(null);
        });

        if (!oldestKey) break;
        await this.delete(oldestKey);
      }
    } finally {
      this.pruning = false;
    }
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    this.inMemoryFallbackStore.clear();

    if (!this.isAvailable()) return;

    try {
      const db = await this.getDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const req = tx.objectStore(STORE).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      this.totalBytes = 0;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("scratchbox_photoreal_cache_size", "0");
      }
    } catch (err) {
      console.warn("[PhotorealTileCache] Failed to clear IndexedDB cache:", err);
    }
  }

  /**
   * Alias for set() for API compatibility.
   */
  public async put(key: string, bytes: ArrayBuffer, _contentType?: string): Promise<void> {
    return this.set(key, bytes);
  }

  /**
   * Retrieves cache statistics.
   */
  public async getStats(): Promise<{ entryCount: number; totalSizeBytes: number }> {
    const memoryCount = this.inMemoryFallbackStore.size;
    return {
      entryCount: memoryCount,
      totalSizeBytes: this.totalBytes
    };
  }
}

export const photorealTileCache = new PhotorealTileCache();
