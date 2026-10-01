/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// TilesRenderer plugin that intercepts tile downloads to load them from IndexedDB.
// Serves from disk on hits, and populates the IndexedDB cache on a miss.

import { photorealTileCache, tileCacheKey } from "./photorealTileCache";

const GOOGLE_AUTH_PLUGIN_NAME = "GOOGLE_CLOUD_AUTH_PLUGIN";

interface TilesLike {
  rootURL?: string | null;
  getPluginByName?: (name: string) => {
    fetchData?: (uri: string, options: any) => Promise<any>;
  } | null;
}

export class PhotorealCachePlugin {
  // Priority lower than GoogleCloudAuthPlugin (which is usually 0) to intercept first
  readonly name = "PHOTOREAL_PERSISTENT_CACHE_PLUGIN";
  readonly priority = -100;

  enabled = true;
  private tiles: TilesLike | null = null;

  constructor(opts?: { enabled?: boolean }) {
    this.enabled = opts?.enabled ?? true;
  }

  init(tiles: TilesLike): void {
    this.tiles = tiles;
  }

  dispose(): void {
    this.tiles = null;
  }

  /**
   * Intercepts 3D tiles download requests. Serves from IndexedDB on hits.
   */
  fetchData(uri: string, options: any): Promise<Response> | null {
    if (!this.enabled) return null;

    let absoluteUri = uri;
    if (typeof window !== "undefined" && !uri.startsWith("http://") && !uri.startsWith("https://")) {
      try {
        absoluteUri = new URL(uri, window.location.href).toString();
      } catch {
        // ignore
      }
    }

    const key = tileCacheKey(absoluteUri);
    if (!key) return null;

    // Never cache root tileset (must always reach Google to refresh the session token)
    const rootURL = this.tiles?.rootURL;
    if (rootURL) {
      let absoluteRoot = rootURL;
      if (!rootURL.startsWith("http://") && !rootURL.startsWith("https://")) {
        try {
          absoluteRoot = new URL(rootURL, (typeof window !== "undefined" ? window.location.href : "https://tile.googleapis.com")).toString();
        } catch {
          // ignore
        }
      }
      if (tileCacheKey(absoluteRoot) === key) {
        return null;
      }
    }

    // Never cache .json tileset metadata (they contain short-lived rotating session tokens)
    if (key.endsWith(".json") || absoluteUri.includes(".json")) {
      return null;
    }

    return this.handle(absoluteUri, options, key);
  }

  private async handle(uri: string, options: any, key: string): Promise<Response> {
    // 1. Cache hit -> serve from persistent local disk!
    const cached = await photorealTileCache.get(key);
    if (cached) {
      return new Response(cached, { status: 200, statusText: "OK (cache)" });
    }

    // 2. Cache miss -> delegate to Google Cloud Auth Plugin or standard fetch
    const authPlugin = this.tiles?.getPluginByName?.(GOOGLE_AUTH_PLUGIN_NAME);
    let result: any;
    let lastErr: any;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result =
          authPlugin?.fetchData != null
            ? await authPlugin.fetchData(uri, options)
            : await fetch(uri, options as RequestInit);
        if (result instanceof Response && result.status !== 503 && result.status !== 429) {
          break;
        }
      } catch (err) {
        lastErr = err;
      }

      if (attempt < 3) {
        const delay = attempt * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (!result && lastErr) {
      throw lastErr;
    }

    if (result instanceof Response && result.ok) {
      try {
        const cloned = result.clone();
        const buffer = await cloned.arrayBuffer();
        if (buffer.byteLength > 0) {
          void photorealTileCache.set(key, buffer);
        }
      } catch {
        // Ignore caching error
      }
    }

    return result;
  }
}
