/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PROVENANCE, type StagedNodeExtras } from '../../common/spatial/staged-location-contracts';

/**
 * Extracts a district of Google Photorealistic 3D Tiles at the finest level of detail the service has,
 * and packages it as one binary glTF plus a commit manifest (anchor, frame, attribution, fetch time, hash).
 *
 * Selection is by ground footprint: every leaf tile whose bounding box, projected onto the local
 * tangent plane, touches the circle is taken whole, with no vertical limit. Leaf textures are copied
 * byte-for-byte (one material per tile) so no resolution is lost to atlas packing.
 */

const WGS84_A = 6378137.0;
const WGS84_F = 1.0 / 298.257223563;
const WGS84_E2 = WGS84_F * (2.0 - WGS84_F);
const TILES_ORIGIN = 'https://tile.googleapis.com';
const ROOT_PATH = '/v1/3dtiles/root.json';
/** Requests in flight per crawl (tileset JSON and leaf GLBs); 429/5xx answers back off and retry. */
const DEFAULT_CRAWL_CONCURRENCY = 16;

/** 3D Tiles runtime turn from glTF Y-up into the tileset's Z-up frame: (x, y, z) -> (x, -z, y). Column-major. */
const Y_UP_TO_Z_UP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

type Vec3 = [number, number, number];

export interface DistrictAnchor {
    lat: number;
    lng: number;
    /** Starting guess for the ground's ellipsoidal height; the builder measures the real ground from the geometry. */
    heightGuessM?: number;
}

export interface LocalFrame {
    origin: Vec3;
    east: Vec3;
    north: Vec3;
    up: Vec3;
}

export interface LeafTileRef {
    /** Stable identity (hash of bounding box and geometric error); content paths are session-scoped tokens. */
    id: string;
    /** Content path relative to tile.googleapis.com, with key and session removed. Valid for the crawl's session only. */
    path: string;
    geometricError: number;
    depth: number;
    box: number[];
}

export interface ParsedLeafTile {
    positions: Float32Array;
    uvs: Float32Array | null;
    indices: Uint8Array | Uint16Array | Uint32Array;
    /** Column-major 4x4 taking a vertex of this primitive to ECEF, including the Y-up -> Z-up turn. */
    worldMatrix: number[];
    image: { bytes: Buffer; mimeType: string } | null;
    copyright: string | null;
    /** The leaf this primitive came from (LeafTileRef.id), when the caller passed it; written into the node's extras. */
    leafId?: string;
    /** The geometric error the tileset states for that leaf (LeafTileRef.geometricError), when the caller passed it; written into the node's extras. */
    geometricErrorM?: number;
    /** That leaf's bounding box (LeafTileRef.box: ECEF centre and three half-axes), when the caller passed it; written into the node's extras. */
    box?: number[];
}

export interface DistrictGlbResult {
    glb: Buffer;
    tileCount: number;
    vertexCount: number;
    triangleCount: number;
    textureCount: number;
    originEllipsoidalHeightM: number;
    /** Column-major 4x4 from the GLB frame (x east, y up, z south) to ECEF. */
    localToEcef: number[];
    boundsLocal: { min: Vec3; max: Vec3 };
    /** Data providers, most frequent first, as Google's attribution rules require. */
    copyrights: string[];
}

export interface CommitLocation {
    query: string;
    formattedAddress: string;
    placeId: string;
    lat: number;
    lng: number;
    precision: string;
}

export interface WriteCommitOptions {
    outDir: string;
    commitId: string;
    glbFileName: string;
    location: CommitLocation;
    radiusMeters: number;
    dilateMeters: number;
    leaves: Array<{ id: string; geometricError: number; box?: number[] }>;
    fetchedAt: string;
    parent?: string | null;
}

export interface GoogleTileDistrictCrawlerOptions {
    apiKey: string;
    fetchImpl?: typeof fetch;
    concurrency?: number;
    /** Leaf GLB cache directory; tiles are keyed by content path. */
    cacheDir?: string;
    /** Leaves coarser than this are catch-all tiles (water, sparse regions) and are skipped. */
    maxLeafGeometricErrorM?: number;
    /** Safety cap on the number of leaves one crawl may select. */
    maxLeafTiles?: number;
    onProgress?: (phase: 'traverse' | 'download', done: number, total: number) => void;
    /**
     * How long a tileset traversal (leaf list + session) is reused for the same anchor, radius and key, in memory and
     * beside the leaf cache. A root request opens a session for about three hours, so the default is two hours;
     * 0 always walks the tileset.
     */
    traversalCacheTtlMs?: number;
}

export interface CollectedLeafTiles {
    leaves: LeafTileRef[];
    session: string | null;
    /** Tileset requests this call made (0 when the traversal came from the cache). */
    requests: number;
    excludedCoarseLeaves: number;
    /** Where the traversal came from when it was reused. */
    traversalCache?: 'memory' | 'disk';
}

interface CachedTraversal {
    key: string;
    savedAt: number;
    leaves: LeafTileRef[];
    session: string | null;
    excludedCoarseLeaves: number;
}

/** Traversals per transport (each fetch implementation has its own), then per traversal key. */
const traversalMemory = new WeakMap<typeof fetch, Map<string, CachedTraversal>>();
const DEFAULT_TRAVERSAL_TTL_MS = 2 * 60 * 60 * 1000;

function geodeticToEcef(latDeg: number, lngDeg: number, h: number): Vec3 {
    const lat = (latDeg * Math.PI) / 180;
    const lng = (lngDeg * Math.PI) / 180;
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
    return [
        (n + h) * Math.cos(lat) * Math.cos(lng),
        (n + h) * Math.cos(lat) * Math.sin(lng),
        (n * (1 - WGS84_E2) + h) * Math.sin(lat)
    ];
}

function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function mat4Multiply(a: number[], b: number[]): number[] {
    const out = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            out[c * 4 + r] = s;
        }
    }
    return out;
}

function nodeLocalMatrix(node: any): number[] {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
    const t = node.translation ?? [0, 0, 0];
    const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
    const s = node.scale ?? [1, 1, 1];
    const r = [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)
    ];
    return [
        r[0] * s[0], r[1] * s[0], r[2] * s[0], 0,
        r[3] * s[1], r[4] * s[1], r[5] * s[1], 0,
        r[6] * s[2], r[7] * s[2], r[8] * s[2], 0,
        t[0], t[1], t[2], 1
    ];
}

function pad4(buf: Buffer, fill = 0): Buffer {
    const rem = buf.length % 4;
    return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem, fill)]);
}

function stableTileId(box: number[], geometricError: number): string {
    const key = [...box.map(v => v.toFixed(2)), geometricError.toFixed(3)].join(',');
    return crypto.createHash('sha1').update(key).digest('hex');
}

/** The circle selects more leaf tiles than one crawl may take. Callers surface it rather than retry another way: the fix is a smaller radius. */
export class DistrictTooLargeError extends Error {
    readonly code = 'district_too_large';

    constructor(readonly maxLeafTiles: number, readonly radiusM: number) {
        super(`District selects more than ${maxLeafTiles} leaf tiles within ${radiusM} m of the anchor; reduce the radius.`);
        this.name = 'DistrictTooLargeError';
    }
}

function stripCredentials(uri: string): string {
    const url = new URL(uri, TILES_ORIGIN);
    url.searchParams.delete('key');
    url.searchParams.delete('session');
    const query = url.searchParams.toString();
    return query ? `${url.pathname}?${query}` : url.pathname;
}

export class GoogleTileDistrictCrawler {
    private readonly apiKey: string;
    private readonly fetchImpl: typeof fetch;
    private readonly concurrency: number;
    private readonly cacheDir?: string;
    private readonly maxLeafGeometricErrorM: number;
    private readonly maxLeafTiles: number;
    private readonly onProgress?: GoogleTileDistrictCrawlerOptions['onProgress'];
    private readonly traversalTtlMs: number;
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(options: GoogleTileDistrictCrawlerOptions) {
        if (!options.apiKey) {
            throw new Error('GoogleTileDistrictCrawler needs a Google Maps API key (GOOGLE_MAPS_API_KEY); it never substitutes synthetic geometry.');
        }
        this.apiKey = options.apiKey;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CRAWL_CONCURRENCY);
        this.cacheDir = options.cacheDir;
        this.maxLeafGeometricErrorM = options.maxLeafGeometricErrorM ?? 64;
        this.maxLeafTiles = options.maxLeafTiles ?? 6000;
        this.onProgress = options.onProgress;
        this.traversalTtlMs = Math.max(0, options.traversalCacheTtlMs ?? DEFAULT_TRAVERSAL_TTL_MS);
    }

    /** East/north/up axes at a geodetic point, in ECEF. */
    static localFrame(latDeg: number, lngDeg: number, heightM: number): LocalFrame {
        const lat = (latDeg * Math.PI) / 180;
        const lng = (lngDeg * Math.PI) / 180;
        return {
            origin: geodeticToEcef(latDeg, lngDeg, heightM),
            east: [-Math.sin(lng), Math.cos(lng), 0],
            north: [-Math.sin(lat) * Math.cos(lng), -Math.sin(lat) * Math.sin(lng), Math.cos(lat)],
            up: [Math.cos(lat) * Math.cos(lng), Math.cos(lat) * Math.sin(lng), Math.sin(lat)]
        };
    }

    /** Whether a 3D Tiles oriented box, projected onto the tangent plane, touches the circle of `radiusM` around the frame origin. */
    static footprintIntersectsCircle(box: number[], frame: LocalFrame, radiusM: number): boolean {
        return GoogleTileDistrictCrawler.footprintDistance(box, frame) <= radiusM;
    }

    /**
     * Whether a 3D Tiles oriented box, projected onto the tangent plane, touches a rectangle of that plane (x east, z south,
     * metres about the frame origin; the staged scan frame's axes): the box's projected corners' extent against it.
     */
    static footprintIntersectsRect(box: number[], frame: LocalFrame, rect: { x0: number; z0: number; x1: number; z1: number }): boolean {
        const c: Vec3 = [box[0], box[1], box[2]];
        const axes: Vec3[] = [[box[3], box[4], box[5]], [box[6], box[7], box[8]], [box[9], box[10], box[11]]];
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
            const p: Vec3 = [0, 1, 2].map(i => c[i] + sx * axes[0][i] + sy * axes[1][i] + sz * axes[2][i] - frame.origin[i]) as Vec3;
            const x = dot(p, frame.east), z = -dot(p, frame.north);
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        }
        return x1 >= rect.x0 && x0 <= rect.x1 && z1 >= rect.z0 && z0 <= rect.z1;
    }

    /** Horizontal distance from the frame origin to a 3D Tiles oriented box projected onto the tangent plane (0 when the footprint covers the origin). */
    static footprintDistance(box: number[], frame: LocalFrame): number {
        const c: Vec3 = [box[0], box[1], box[2]];
        const axes: Vec3[] = [[box[3], box[4], box[5]], [box[6], box[7], box[8]], [box[9], box[10], box[11]]];
        const pts: Array<[number, number]> = [];
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
            const p: Vec3 = [0, 1, 2].map(i => c[i] + sx * axes[0][i] + sy * axes[1][i] + sz * axes[2][i] - frame.origin[i]) as Vec3;
            pts.push([dot(p, frame.east), dot(p, frame.north)]);
        }
        pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lower: Array<[number, number]> = [];
        for (const p of pts) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
            lower.push(p);
        }
        const upper: Array<[number, number]> = [];
        for (const p of [...pts].reverse()) {
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
            upper.push(p);
        }
        const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
        if (hull.length < 3) return Math.hypot(pts[0][0], pts[0][1]);
        let inside = true;
        for (let i = 0; i < hull.length; i++) {
            if (cross(hull[i], hull[(i + 1) % hull.length], [0, 0]) < 0) { inside = false; break; }
        }
        if (inside) return 0;
        let nearest = Infinity;
        for (let i = 0; i < hull.length; i++) {
            const a = hull[i], b = hull[(i + 1) % hull.length];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const t = Math.max(0, Math.min(1, (-a[0] * dx - a[1] * dy) / (dx * dx + dy * dy || 1)));
            nearest = Math.min(nearest, Math.hypot(a[0] + t * dx, a[1] + t * dy));
        }
        return nearest;
    }

    private async limited<T>(task: () => Promise<T>): Promise<T> {
        while (this.active >= this.concurrency) await new Promise<void>(resolve => this.waiters.push(resolve));
        this.active++;
        try {
            return await task();
        } finally {
            this.active--;
            this.waiters.shift()?.();
        }
    }

    private buildUrl(uri: string, session: string | null): URL {
        const url = new URL(uri, TILES_ORIGIN);
        url.searchParams.set('key', this.apiKey);
        if (session && !url.searchParams.has('session')) url.searchParams.set('session', session);
        return url;
    }

    /**
     * One request and its body (`read`), retried with backoff on HTTP 429 and 5xx and on a connection dropped while it was
     * sent or read (Google closes a socket mid-tile now and then, and a district downloads hundreds of tiles). A stop
     * (AbortError) is never retried.
     */
    private async fetchWithRetry<T>(url: URL, read: (res: Response) => Promise<T>): Promise<T> {
        let lastError = '';
        for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt) await new Promise(r => setTimeout(r, 400 * 2 ** (attempt - 1)));
            let status: number;
            try {
                const res = await this.fetchImpl(url.toString());
                if (res.ok) return await read(res);
                status = res.status;
            } catch (err) {
                if ((err as Error)?.name === 'AbortError') throw err;
                lastError = (err as Error)?.message ?? String(err);
                continue;
            }
            lastError = `HTTP ${status}`;
            if (status !== 429 && status < 500) break;
        }
        throw new Error(`Google 3D Tiles request failed (${lastError}) for ${stripCredentials(url.toString())}`);
    }

    /**
     * Every fine leaf whose footprint touches the circle. The traversal is reused for `traversalCacheTtlMs` (memory,
     * then the file beside the leaf cache), so a repeat crawl of the same district makes no tileset requests.
     */
    async collectLeafTiles(anchor: DistrictAnchor, radiusM: number): Promise<CollectedLeafTiles> {
        if (this.traversalTtlMs <= 0) return this.walkTileset(anchor, radiusM);
        const key = [anchor.lat.toFixed(7), anchor.lng.toFixed(7), (anchor.heightGuessM ?? 0).toFixed(2), radiusM, this.maxLeafGeometricErrorM, this.maxLeafTiles,
            // Sessions belong to the key's project, so another key never reuses them.
            crypto.createHash('sha1').update(this.apiKey).digest('hex').slice(0, 16)].join('|');
        const fresh = (c: CachedTraversal | undefined) => c && c.key === key && Date.now() - c.savedAt < this.traversalTtlMs ? c : undefined;
        let memory = traversalMemory.get(this.fetchImpl);
        if (!memory) traversalMemory.set(this.fetchImpl, (memory = new Map()));
        const fromMemory = fresh(memory.get(key));
        if (fromMemory) return { leaves: fromMemory.leaves.map(l => ({ ...l })), session: fromMemory.session, requests: 0, excludedCoarseLeaves: fromMemory.excludedCoarseLeaves, traversalCache: 'memory' };
        const diskPath = this.cacheDir ? path.join(this.cacheDir, 'traversals', `${crypto.createHash('sha1').update(key).digest('hex')}.json`) : null;
        if (diskPath && fs.existsSync(diskPath)) {
            let fromDisk: CachedTraversal | undefined;
            try { fromDisk = fresh(JSON.parse(fs.readFileSync(diskPath, 'utf8'))); } catch { fromDisk = undefined; /* unreadable entry: walk again and overwrite it */ }
            if (fromDisk) {
                memory.set(key, fromDisk);
                return { leaves: fromDisk.leaves.map(l => ({ ...l })), session: fromDisk.session, requests: 0, excludedCoarseLeaves: fromDisk.excludedCoarseLeaves, traversalCache: 'disk' };
            }
        }
        const walked = await this.walkTileset(anchor, radiusM);
        const entry: CachedTraversal = { key, savedAt: Date.now(), leaves: walked.leaves.map(l => ({ ...l })), session: walked.session, excludedCoarseLeaves: walked.excludedCoarseLeaves };
        memory.set(key, entry);
        if (diskPath) {
            fs.mkdirSync(path.dirname(diskPath), { recursive: true });
            const tmp = `${diskPath}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(entry));
            fs.renameSync(tmp, diskPath);
        }
        return walked;
    }

    /** Walks the tileset and returns every fine leaf whose footprint touches the circle. */
    private async walkTileset(anchor: DistrictAnchor, radiusM: number): Promise<CollectedLeafTiles> {
        const frame = GoogleTileDistrictCrawler.localFrame(anchor.lat, anchor.lng, anchor.heightGuessM ?? 0);
        const leaves: LeafTileRef[] = [];
        let session: string | null = null;
        let requests = 0;
        let excludedCoarseLeaves = 0;

        const fetchJson = (uri: string) => this.limited(async () => {
            requests++;
            const json = await this.fetchWithRetry(this.buildUrl(uri, session), res => res.json() as Promise<any>);
            this.onProgress?.('traverse', leaves.length, requests);
            return json;
        });

        const visit = async (tile: any, depth: number): Promise<void> => {
            const box = tile?.boundingVolume?.box;
            if (Array.isArray(box) && !GoogleTileDistrictCrawler.footprintIntersectsCircle(box, frame, radiusM)) return;
            const children: any[] = tile.children ?? [];
            const uri: string | undefined = tile.content?.uri ?? tile.content?.url;
            const work: Array<Promise<void>> = [];
            if (uri) {
                const parsed = new URL(uri, TILES_ORIGIN);
                const s = parsed.searchParams.get('session');
                if (s && !session) session = s;
                if (parsed.pathname.endsWith('.json')) {
                    work.push(fetchJson(uri).then(sub => visit(sub.root, depth + 1)));
                } else if (children.length === 0) {
                    if (tile.geometricError <= this.maxLeafGeometricErrorM) {
                        const leafBox: number[] = Array.isArray(box) ? box : [];
                        leaves.push({
                            id: stableTileId(leafBox, tile.geometricError),
                            path: stripCredentials(uri),
                            geometricError: tile.geometricError,
                            depth,
                            box: leafBox
                        });
                        if (leaves.length > this.maxLeafTiles) {
                            throw new DistrictTooLargeError(this.maxLeafTiles, radiusM);
                        }
                    } else {
                        excludedCoarseLeaves++;
                    }
                }
            }
            for (const child of children) work.push(visit(child, depth + 1));
            await Promise.all(work);
        };

        const root = await fetchJson(ROOT_PATH);
        await visit(root.root, 0);
        leaves.sort((a, b) => a.id.localeCompare(b.id));
        return { leaves, session, requests, excludedCoarseLeaves };
    }

    /**
     * Downloads leaf GLBs (using the cache when present), preserving the input order. `onComplete(index, rank)` is
     * called as each leaf lands: its place in `leaves` and its 0-based completion rank. The ranks vary with network
     * timing, so they belong in a sidecar beside the district GLB and never in its bytes.
     */
    async downloadLeaves(leaves: LeafTileRef[], session: string | null, onComplete?: (leafIndex: number, rank: number) => void): Promise<Buffer[]> {
        if (this.cacheDir) fs.mkdirSync(this.cacheDir, { recursive: true });
        let done = 0;
        return Promise.all(leaves.map((leaf, i) => this.limited(async () => {
            const cachePath = this.cacheDir ? path.join(this.cacheDir, `${leaf.id}.glb`) : null;
            let bytes: Buffer | null = cachePath && fs.existsSync(cachePath) ? fs.readFileSync(cachePath) : null;
            if (!bytes) {
                bytes = await this.fetchWithRetry(this.buildUrl(leaf.path, session), async res => Buffer.from(await res.arrayBuffer()));
                if (bytes.length < 12 || bytes.toString('utf8', 0, 4) !== 'glTF') {
                    throw new Error(`Leaf tile is not a binary glTF: ${leaf.path}`);
                }
                if (cachePath) fs.writeFileSync(cachePath, bytes);
            }
            const rank = done++;
            onComplete?.(i, rank);
            this.onProgress?.('download', done, leaves.length);
            return bytes;
        })));
    }

    /** Parses every triangle primitive of a leaf GLB. */
    static parseLeafGlbPrimitives(glb: Buffer, leafId?: string, geometricErrorM?: number, box?: number[]): ParsedLeafTile[] {
        if (glb.toString('utf8', 0, 4) !== 'glTF' || glb.readUInt32LE(4) !== 2) throw new Error('Not a glTF 2.0 binary');
        let offset = 12;
        let json: any = null;
        let bin: Buffer | null = null;
        while (offset + 8 <= glb.length) {
            const len = glb.readUInt32LE(offset);
            const type = glb.readUInt32LE(offset + 4);
            const body = glb.subarray(offset + 8, offset + 8 + len);
            if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
            else if (type === 0x004e4942) bin = body;
            offset += 8 + len;
        }
        if (!json || !bin) throw new Error('Leaf GLB is missing its JSON or BIN chunk');
        const binary = bin;

        const view = (bvIndex: number): { data: Buffer; stride?: number } => {
            const bv = json.bufferViews[bvIndex];
            const start = bv.byteOffset ?? 0;
            return { data: binary.subarray(start, start + bv.byteLength), stride: bv.byteStride };
        };
        const readFloat = (accIndex: number, comps: number): Float32Array => {
            const acc = json.accessors[accIndex];
            if (acc.componentType !== 5126) throw new Error(`Unsupported vertex component type ${acc.componentType} (quantized tiles are not handled)`);
            const { data, stride } = view(acc.bufferView);
            const out = new Float32Array(acc.count * comps);
            const step = stride ?? comps * 4;
            const base = acc.byteOffset ?? 0;
            for (let i = 0; i < acc.count; i++) {
                for (let k = 0; k < comps; k++) out[i * comps + k] = data.readFloatLE(base + i * step + k * 4);
            }
            return out;
        };
        const readIndices = (accIndex: number): Uint8Array | Uint16Array | Uint32Array => {
            const acc = json.accessors[accIndex];
            const bytesPer = acc.componentType === 5125 ? 4 : acc.componentType === 5123 ? 2 : acc.componentType === 5121 ? 1 : 0;
            if (!bytesPer) throw new Error(`Unsupported index component type ${acc.componentType}`);
            const { data } = view(acc.bufferView);
            const base = acc.byteOffset ?? 0;
            const ab = new ArrayBuffer(acc.count * bytesPer);
            new Uint8Array(ab).set(data.subarray(base, base + acc.count * bytesPer));
            return bytesPer === 4 ? new Uint32Array(ab) : bytesPer === 2 ? new Uint16Array(ab) : new Uint8Array(ab);
        };
        const readImage = (materialIndex: number | undefined): ParsedLeafTile['image'] => {
            if (materialIndex === undefined) return null;
            const texIndex = json.materials?.[materialIndex]?.pbrMetallicRoughness?.baseColorTexture?.index;
            if (texIndex === undefined) return null;
            const image = json.images?.[json.textures?.[texIndex]?.source];
            if (!image) return null;
            if (image.bufferView === undefined) throw new Error('Leaf texture is referenced by URI; only embedded images are supported');
            return { bytes: Buffer.from(view(image.bufferView).data), mimeType: image.mimeType ?? 'image/jpeg' };
        };

        const copyright: string | null = json.asset?.copyright ?? null;
        const out: ParsedLeafTile[] = [];
        const walk = (nodeIndex: number, parent: number[]) => {
            const node = json.nodes[nodeIndex];
            const world = mat4Multiply(parent, nodeLocalMatrix(node));
            if (node.mesh !== undefined) {
                for (const prim of json.meshes[node.mesh].primitives) {
                    if ((prim.mode ?? 4) !== 4) continue;
                    if (prim.extensions?.KHR_draco_mesh_compression) throw new Error('Draco-compressed leaf tiles are not handled');
                    const positions = readFloat(prim.attributes.POSITION, 3);
                    const uvs = prim.attributes.TEXCOORD_0 !== undefined ? readFloat(prim.attributes.TEXCOORD_0, 2) : null;
                    const indices = prim.indices !== undefined
                        ? readIndices(prim.indices)
                        : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
                    out.push({ positions, uvs, indices, worldMatrix: world, image: readImage(prim.material), copyright, ...(leafId ? { leafId } : {}), ...(Number.isFinite(geometricErrorM) ? { geometricErrorM } : {}), ...(box && box.length >= 12 ? { box: box.slice(0, 12) } : {}) });
                }
            }
            for (const child of node.children ?? []) walk(child, world);
        };
        const scene = json.scenes?.[json.scene ?? 0];
        const roots: number[] = scene?.nodes ?? json.nodes.map((_: any, i: number) => i);
        for (const r of roots) walk(r, Y_UP_TO_Z_UP);
        return out;
    }

    /** Parses a single-primitive leaf (the layout Google serves). */
    static parseLeafGlb(glb: Buffer): ParsedLeafTile {
        const prims = GoogleTileDistrictCrawler.parseLeafGlbPrimitives(glb);
        if (prims.length !== 1) throw new Error(`Expected one primitive in the leaf tile, found ${prims.length}`);
        return prims[0];
    }

    static leafVertexEcef(leaf: ParsedLeafTile, vertexIndex: number): Vec3 {
        const m = leaf.worldMatrix;
        const x = leaf.positions[vertexIndex * 3], y = leaf.positions[vertexIndex * 3 + 1], z = leaf.positions[vertexIndex * 3 + 2];
        return [
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14]
        ];
    }

    /**
     * Street height near the anchor: the area-weighted mode (0.25 m bins) of level triangles within
     * `radiusM`, restricted to the lowest 35 % of level area so roofs cannot win and small pits
     * (stairwells, drains) cannot drag it down.
     */
    static estimateGroundHeight(leaves: ParsedLeafTile[], local: Float64Array[], radiusM: number): number {
        const flats: Array<{ y: number; area: number }> = [];
        leaves.forEach((leaf, li) => {
            const p = local[li];
            const idx = leaf.indices;
            for (let t = 0; t + 2 < idx.length; t += 3) {
                const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
                if (Math.hypot((p[a] + p[b] + p[c]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3) > radiusM) continue;
                const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
                const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
                const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                const len = Math.hypot(nx, ny, nz);
                if (len === 0 || Math.abs(ny) / len < 0.9) continue;
                flats.push({ y: (p[a + 1] + p[b + 1] + p[c + 1]) / 3, area: len / 2 });
            }
        });
        if (flats.length === 0) {
            const heights: number[] = [];
            for (const p of local) for (let i = 0; i < p.length; i += 3) if (Math.hypot(p[i], p[i + 2]) <= radiusM) heights.push(p[i + 1]);
            if (heights.length === 0) throw new Error(`No geometry within ${radiusM} m of the anchor to measure the ground from`);
            heights.sort((x, y) => x - y);
            return heights[Math.floor(heights.length * 0.03)];
        }
        flats.sort((x, y) => x.y - y.y);
        const total = flats.reduce((s, f) => s + f.area, 0);
        const bins = new Map<number, number>();
        let covered = 0;
        let bestBin = Math.round(flats[0].y / 0.25);
        let bestArea = -1;
        for (const f of flats) {
            if (covered > total * 0.35) break;
            covered += f.area;
            const k = Math.round(f.y / 0.25);
            const v = (bins.get(k) ?? 0) + f.area;
            bins.set(k, v);
            if (v > bestArea) { bestArea = v; bestBin = k; }
        }
        return bestBin * 0.25;
    }

    /**
     * Places every leaf in one frame (x east, y up, z south, metres) whose origin sits on the street
     * below the anchor, and serializes them as one GLB with one mesh, material and texture per leaf.
     */
    static buildDistrictGlb(
        leaves: ParsedLeafTile[],
        anchor: DistrictAnchor,
        options: {
            groundSearchRadiusM?: number;
            name?: string;
            /** Use this frame origin (e.g. the parent commit's) instead of estimating the street height. */
            originEllipsoidalHeightM?: number;
            clay?: boolean;
            clayPreset?: string;
            /**
             * The staged build's first layer: the same triangles as downloaded, with no images, textures, samplers or
             * UVs and one clay material (so the browser holds a fraction of the textured bytes). Implies `clay`.
             */
            geometryOnly?: boolean;
        } = {}
    ): DistrictGlbResult {
        if (options.geometryOnly) options = { ...options, clay: true };
        if (leaves.length === 0) throw new Error('No leaf tiles to build a district from');
        const heightGuess = anchor.heightGuessM ?? 0;
        const frame0 = GoogleTileDistrictCrawler.localFrame(anchor.lat, anchor.lng, heightGuess);

        const local: Float64Array[] = leaves.map(leaf => {
            const n = leaf.positions.length / 3;
            const out = new Float64Array(n * 3);
            for (let i = 0; i < n; i++) {
                const e = GoogleTileDistrictCrawler.leafVertexEcef(leaf, i);
                const d: Vec3 = [e[0] - frame0.origin[0], e[1] - frame0.origin[1], e[2] - frame0.origin[2]];
                out[i * 3] = dot(d, frame0.east);
                out[i * 3 + 1] = dot(d, frame0.up);
                out[i * 3 + 2] = -dot(d, frame0.north);
            }
            return out;
        });

        // Run-independent build order: the leaf primitives by the distance of their centroid from the anchor (the frame
        // origin), then by leaf id. It is what the staged viewport replays; the download order is a sidecar instead.
        const centroidDistanceM = local.map(arr => {
            const n = Math.max(1, arr.length / 3);
            let sx = 0, sz = 0;
            for (let i = 0; i < arr.length; i += 3) { sx += arr[i]; sz += arr[i + 2]; }
            return Math.round(Math.hypot(sx / n, sz / n) * 1000) / 1000;
        });
        const buildOrder = new Array<number>(leaves.length);
        leaves.map((_, i) => i)
            .sort((a, b) => centroidDistanceM[a] - centroidDistanceM[b] || (leaves[a].leafId ?? '').localeCompare(leaves[b].leafId ?? '') || a - b)
            .forEach((li, rank) => { buildOrder[li] = rank; });

        const ground = options.originEllipsoidalHeightM !== undefined
            ? options.originEllipsoidalHeightM - heightGuess
            : GoogleTileDistrictCrawler.estimateGroundHeight(leaves, local, options.groundSearchRadiusM ?? 100);

        const originH = options.originEllipsoidalHeightM ?? heightGuess + ground;
        const frame = GoogleTileDistrictCrawler.localFrame(anchor.lat, anchor.lng, originH);
        const south: Vec3 = [-frame.north[0], -frame.north[1], -frame.north[2]];
        const localToEcef = [...frame.east, 0, ...frame.up, 0, ...south, 0, ...frame.origin, 1];

        const chunks: Buffer[] = [];
        let binLength = 0;
        const bufferViews: any[] = [];
        const accessors: any[] = [];
        const images: any[] = [];
        const textures: any[] = [];
        const materials: any[] = [];
        const meshes: any[] = [];
        const nodes: any[] = [{ name: options.name ?? 'district', children: [] as number[] }];
        const addView = (data: Buffer, target?: number): number => {
            const padded = pad4(data);
            bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.length, ...(target ? { target } : {}) });
            chunks.push(padded);
            binLength += padded.length;
            return bufferViews.length - 1;
        };

        if (options.clay) {
            materials.push({
                name: 'StudioGreyClay',
                pbrMetallicRoughness: {
                    baseColorFactor: [0.55, 0.57, 0.60, 1.0],
                    metallicFactor: 0.0,
                    roughnessFactor: 0.85
                }
            });
        }

        const min: Vec3 = [Infinity, Infinity, Infinity];
        const max: Vec3 = [-Infinity, -Infinity, -Infinity];
        const providerCounts = new Map<string, number>();
        let vertexCount = 0;
        let triangleCount = 0;

        leaves.forEach((leaf, li) => {
            const arr = local[li];
            const pos = new Float32Array(arr.length);
            const pmin: Vec3 = [Infinity, Infinity, Infinity];
            const pmax: Vec3 = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < arr.length; i += 3) {
                const v: Vec3 = [arr[i], arr[i + 1] - ground, arr[i + 2]];
                for (let k = 0; k < 3; k++) {
                    pos[i + k] = v[k];
                    if (pos[i + k] < pmin[k]) pmin[k] = pos[i + k];
                    if (pos[i + k] > pmax[k]) pmax[k] = pos[i + k];
                }
            }
            for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pmin[k]); max[k] = Math.max(max[k], pmax[k]); }

            const attributes: Record<string, number> = {};
            const posView = addView(Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength), 34962);
            accessors.push({ bufferView: posView, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: pmin, max: pmax });
            attributes.POSITION = accessors.length - 1;

            const idx = leaf.indices;
            const componentType = idx instanceof Uint32Array ? 5125 : idx instanceof Uint16Array ? 5123 : 5121;
            const idxView = addView(Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength), 34963);
            accessors.push({ bufferView: idxView, componentType, count: idx.length, type: 'SCALAR' });
            const indicesAccessor = accessors.length - 1;

            // Generate smooth vertex normals for architectural clay lighting
            const numVerts = pos.length / 3;
            const norm = new Float32Array(pos.length);
            for (let t = 0; t < idx.length; t += 3) {
                const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
                const v0x = pos[i0 * 3], v0y = pos[i0 * 3 + 1], v0z = pos[i0 * 3 + 2];
                const v1x = pos[i1 * 3], v1y = pos[i1 * 3 + 1], v1z = pos[i1 * 3 + 2];
                const v2x = pos[i2 * 3], v2y = pos[i2 * 3 + 1], v2z = pos[i2 * 3 + 2];
                const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
                const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
                const nx = e1y * e2z - e1z * e2y;
                const ny = e1z * e2x - e1x * e2z;
                const nz = e1x * e2y - e1y * e2x;
                norm[i0 * 3] += nx; norm[i0 * 3 + 1] += ny; norm[i0 * 3 + 2] += nz;
                norm[i1 * 3] += nx; norm[i1 * 3 + 1] += ny; norm[i1 * 3 + 2] += nz;
                norm[i2 * 3] += nx; norm[i2 * 3 + 1] += ny; norm[i2 * 3 + 2] += nz;
            }
            for (let i = 0; i < numVerts; i++) {
                const len = Math.hypot(norm[i * 3], norm[i * 3 + 1], norm[i * 3 + 2]) || 1;
                norm[i * 3] /= len; norm[i * 3 + 1] /= len; norm[i * 3 + 2] /= len;
            }
            const normView = addView(Buffer.from(norm.buffer, norm.byteOffset, norm.byteLength), 34962);
            accessors.push({ bufferView: normView, componentType: 5126, count: numVerts, type: 'VEC3' });
            attributes.NORMAL = accessors.length - 1;

            if (leaf.uvs && !options.clay) {
                const uvView = addView(Buffer.from(leaf.uvs.buffer, leaf.uvs.byteOffset, leaf.uvs.byteLength), 34962);
                accessors.push({ bufferView: uvView, componentType: 5126, count: leaf.uvs.length / 2, type: 'VEC2' });
                attributes.TEXCOORD_0 = accessors.length - 1;
            }

            let materialIndex: number | undefined;
            if (options.clay) {
                materialIndex = 0;
            } else if (leaf.image) {
                const imgView = addView(leaf.image.bytes);
                images.push({ bufferView: imgView, mimeType: leaf.image.mimeType });
                textures.push({ source: images.length - 1, sampler: 0 });
                materials.push({
                    pbrMetallicRoughness: { baseColorTexture: { index: textures.length - 1 }, metallicFactor: 0, roughnessFactor: 1 },
                    extensions: { KHR_materials_unlit: {} }
                });
                materialIndex = materials.length - 1;
            }
            meshes.push({ primitives: [{ attributes, indices: indicesAccessor, mode: 4, ...(materialIndex !== undefined ? { material: materialIndex } : {}) }] });
            const nodeExtras: StagedNodeExtras = {
                sb: {
                    schema: 'scratchbox.staged-node/2',
                    stage: 'tiles',
                    provenance: {
                        label: PROVENANCE.asScanned, measuredGeometry: true, method: 'Google Photorealistic 3D Tiles leaf, as downloaded',
                        sources: leaf.leafId ? [{ kind: 'tile-leaf', id: leaf.leafId }] : []
                    },
                    buildOrder: buildOrder[li],
                    buildCount: leaves.length,
                    revealKind: 'appear',
                    reveal: { attribute: null, displacement: null, durationShare: 1 / Math.max(1, leaves.length) },
                    ids: leaf.leafId ? { leafId: leaf.leafId } : {},
                    ...(leaf.geometricErrorM !== undefined || leaf.box ? { tile: { ...(leaf.geometricErrorM !== undefined ? { geometricErrorM: leaf.geometricErrorM } : {}), ...(leaf.box ? { box: leaf.box } : {}) } } : {}),
                    counts: { vertices: pos.length / 3, triangles: Math.floor(idx.length / 3) }
                }
            };
            nodes.push({ name: `tile_${li}`, mesh: meshes.length - 1, extras: nodeExtras });
            nodes[0].children.push(nodes.length - 1);

            vertexCount += pos.length / 3;
            triangleCount += Math.floor(idx.length / 3);
            for (const provider of (leaf.copyright ?? '').split(';').map(s => s.trim()).filter(Boolean)) {
                providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
            }
        });

        const copyrights = [...providerCounts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
        const json = {
            asset: { version: '2.0', generator: 'scratchbox-google-tile-district-crawler', copyright: copyrights.join('; ') },
            extensionsUsed: (!options.clay && materials.length) ? ['KHR_materials_unlit'] : undefined,
            scene: 0,
            scenes: [{ nodes: [0] }],
            nodes,
            meshes,
            materials: materials.length ? materials : undefined,
            textures: textures.length ? textures : undefined,
            images: images.length ? images : undefined,
            samplers: textures.length ? [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }] : undefined,
            accessors,
            bufferViews,
            buffers: [{ byteLength: binLength }],
            extras: {
                frame: 'x = east, y = up, z = south (metres)',
                anchor: { lat: anchor.lat, lng: anchor.lng, ellipsoidalHeightM: originH },
                localToEcef
            }
        };
        const jsonBuf = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
        const bin = Buffer.concat(chunks);
        const header = Buffer.alloc(12);
        header.write('glTF', 0, 'utf8');
        header.writeUInt32LE(2, 4);
        header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
        const jsonHeader = Buffer.alloc(8);
        jsonHeader.writeUInt32LE(jsonBuf.length, 0);
        jsonHeader.writeUInt32LE(0x4e4f534a, 4);
        const binHeader = Buffer.alloc(8);
        binHeader.writeUInt32LE(bin.length, 0);
        binHeader.writeUInt32LE(0x004e4942, 4);

        return {
            glb: Buffer.concat([header, jsonHeader, jsonBuf, binHeader, bin]),
            tileCount: leaves.length,
            vertexCount,
            triangleCount,
            textureCount: images.length,
            originEllipsoidalHeightM: originH,
            localToEcef,
            boundsLocal: { min, max },
            copyrights
        };
    }

    /** Writes the GLB and its commit manifest; the manifest records everything needed to re-derive or branch from it. */
    static writeCommit(result: DistrictGlbResult, options: WriteCommitOptions): { glbPath: string; manifestPath: string; manifest: any } {
        fs.mkdirSync(options.outDir, { recursive: true });
        const glbPath = path.join(options.outDir, options.glbFileName);
        fs.writeFileSync(glbPath, result.glb);
        const errors = options.leaves.map(l => l.geometricError);
        const manifest = {
            schema: 'scratchbox.tile-commit/1',
            id: options.commitId,
            parent: options.parent ?? null,
            createdAt: new Date().toISOString(),
            location: options.location,
            frame: {
                convention: 'x = east, y = up, z = south (metres); origin on the ground below the anchor',
                anchor: { lat: options.location.lat, lng: options.location.lng },
                originEllipsoidalHeightM: result.originEllipsoidalHeightM,
                headingDeg: 0,
                localToEcef: result.localToEcef
            },
            extent: {
                radiusMeters: options.radiusMeters,
                dilateMeters: options.dilateMeters,
                selection: 'whole leaf tiles whose ground footprint touches radius + dilation',
                verticalExtent: 'unbounded',
                boundsLocal: result.boundsLocal
            },
            source: {
                provider: 'Google Photorealistic 3D Tiles',
                endpoint: `${TILES_ORIGIN}${ROOT_PATH}`,
                tileCount: options.leaves.length,
                leafGeometricErrorM: errors.length ? { min: Math.min(...errors), max: Math.max(...errors) } : null,
                tileIdentity: 'sha1 of the ECEF bounding box (cm) and geometric error; content paths are session-scoped and not recorded',
                tiles: options.leaves
            },
            attribution: result.copyrights,
            glb: {
                path: options.glbFileName,
                bytes: result.glb.length,
                sha256: crypto.createHash('sha256').update(result.glb).digest('hex'),
                vertexCount: result.vertexCount,
                triangleCount: result.triangleCount,
                textureCount: result.textureCount
            },
            time: { fetchedAt: options.fetchedAt }
        };
        const manifestPath = path.join(options.outDir, 'commit.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        return { glbPath, manifestPath, manifest };
    }
}
