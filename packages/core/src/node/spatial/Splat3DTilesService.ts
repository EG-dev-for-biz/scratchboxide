/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LocalTangentPlane, type LatLngAlt } from '../../common/coordinate/LocalTangentPlane';
import { NativeCppCompilerService } from '../3d-engine/native-compiler-service';

const execAsync = promisify(exec);

export interface Splat3DTilesOptions {
    inputPath: string;                 // .splat or .spz
    outDir: string;                    // tileset.json + tiles/ are written here
    /** Geodetic anchor of the splat frame origin. Omitted -> tileset stays in local metres (no transform). */
    origin?: LatLngAlt;
    /** Optional yaw (deg, clockwise from true north) applied before the geodetic placement. */
    headingDeg?: number;
    maxDepth?: number;                 // default 5
    leafCapacity?: number;             // default 65536
    interiorBudget?: number;           // default 32768
    geometricErrorScale?: number;      // default 0.25 (metres per metre of cell extent)
}

export interface Splat3DTilesResult {
    success: boolean;
    tilesetPath: string;
    treePath: string;
    tileCount: number;
    levels: number;
    numSplats: number;
    tileBytes: number;
    rootTransform: number[] | null;    // column-major 4x4, ENU(Three.js Y-up) -> ECEF
    durationMs: number;
    error?: string;
}

interface TreeNode {
    level: number; x: number; y: number; z: number;
    min: [number, number, number]; max: [number, number, number];
    contentMin: [number, number, number]; contentMax: [number, number, number];
    geometricError: number; splatCount: number; leafSplatCount: number; tileSplatCount: number;
    uri: string; children: TreeNode[];
}

/**
 * Gaussian splats -> OGC 3D Tiles 1.1 (KHR_gaussian_splatting + KHR_gaussian_splatting_compression_spz_2).
 *
 * The native tiler (scripts/splat_to_3dtiles.cpp) does the Morton octree, LOD simplification and
 * per-tile GLB packing. This service compiles/runs it and assembles tileset.json, including the
 * root transform that places the local Three.js frame (X east, Y up, Z south) onto WGS-84 so the
 * tileset can be overlaid on Google Photorealistic 3D Tiles in any 3D Tiles viewer.
 */
export class Splat3DTilesService {
    private compiler = new NativeCppCompilerService();
    private binaryPath = path.resolve(process.cwd(), 'build/splat_to_3dtiles');

    async ensureBinary(): Promise<string> {
        if (fs.existsSync(this.binaryPath)) return this.binaryPath;
        const src = path.resolve(process.cwd(), 'scripts/splat_to_3dtiles.cpp');
        if (!fs.existsSync(src)) throw new Error(`Tiler source not found: ${src}`);
        await fs.ensureDir(path.dirname(this.binaryPath));
        const include = this.compiler.getSdkIncludePath();
        await execAsync(`${process.env.CXX || 'clang++'} -std=c++20 -O3 -I "${include}" -lz "${src}" -o "${this.binaryPath}"`);
        return this.binaryPath;
    }

    async convert(options: Splat3DTilesOptions): Promise<Splat3DTilesResult> {
        const t0 = Date.now();
        const tilesetPath = path.join(options.outDir, 'tileset.json');
        const treePath = path.join(options.outDir, 'tree.json');
        try {
            const bin = await this.ensureBinary();
            await fs.ensureDir(options.outDir);
            const args = [
                `--input "${options.inputPath}"`,
                `--out-dir "${options.outDir}"`,
                `--max-depth ${options.maxDepth ?? 5}`,
                `--leaf-capacity ${options.leafCapacity ?? 65536}`,
                `--interior-budget ${options.interiorBudget ?? 32768}`,
                `--geometric-error-scale ${options.geometricErrorScale ?? 0.25}`,
                '--json'
            ];
            const { stdout } = await execAsync(`"${bin}" ${args.join(' ')}`, { maxBuffer: 16 * 1024 * 1024 });
            const stats = JSON.parse(stdout.trim());

            const tree = await fs.readJson(treePath) as { root: TreeNode; totalSplats: number; nodeCount: number };
            const rootTransform = options.origin ? Splat3DTilesService.computeRootTransform(options.origin, options.headingDeg ?? 0) : null;
            const tileset = Splat3DTilesService.buildTileset(tree.root, rootTransform, stats.numSplats);
            await fs.writeJson(tilesetPath, tileset);

            return {
                success: true, tilesetPath, treePath,
                tileCount: stats.tileCount, levels: stats.levels, numSplats: stats.numSplats, tileBytes: stats.tileBytes,
                rootTransform, durationMs: Date.now() - t0
            };
        } catch (err: any) {
            return { success: false, tilesetPath, treePath, tileCount: 0, levels: 0, numSplats: 0, tileBytes: 0, rootTransform: null, durationMs: Date.now() - t0, error: err?.message ?? String(err) };
        }
    }

    /**
     * 3D Tiles content frame. glTF tile content is Y-up; per the 3D Tiles spec viewers rotate it
     * +90 deg about X into the tileset's Z-up frame:  (x, y, z)_gltf -> (x, -z, y)_tileset.
     * Our splats are in the Three.js frame (x = east, y = up, z = south), so in the tileset frame
     * X = east, Y = -south = north, Z = up: a standard ENU frame. Bounding volumes must be written
     * in that frame, and the root transform is then plain ENU -> ECEF.
     */
    static gltfToTilesetFrame(p: [number, number, number]): [number, number, number] {
        return [p[0], -p[2], p[1]];
    }

    /**
     * Column-major 4x4 placing the tileset's ENU frame on the ellipsoid (Cesium's
     * eastNorthUpToFixedFrame), with an optional yaw of the content about Up.
     */
    static computeRootTransform(origin: LatLngAlt, headingDeg = 0): number[] {
        const ltp = new LocalTangentPlane(origin);
        const h = (headingDeg * Math.PI) / 180;
        // Tileset axes expressed in ENU: X = east rotated by heading (clockwise from north), Y = north rotated, Z = up
        const tsX_enu = [Math.cos(h), -Math.sin(h), 0];
        const tsY_enu = [Math.sin(h), Math.cos(h), 0];
        const tsZ_enu = [0, 0, 1];

        const originEcef = (ltp as any).geodeticToEcef(origin.lat * Math.PI / 180, origin.lng * Math.PI / 180, (origin.alt ?? 0)) as number[];
        const R = (ltp as any).invRotMatrix as number[][]; // ENU -> ECEF (rows)
        const enuToEcef = (v: number[]) => [
            R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
            R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
            R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]
        ];
        const cx = enuToEcef(tsX_enu), cy = enuToEcef(tsY_enu), cz = enuToEcef(tsZ_enu);
        return [
            cx[0], cx[1], cx[2], 0,
            cy[0], cy[1], cy[2], 0,
            cz[0], cz[1], cz[2], 0,
            originEcef[0], originEcef[1], originEcef[2], 1
        ];
    }

    static buildTileset(root: TreeNode, rootTransform: number[] | null, numSplats: number): any {
        const toTile = (n: TreeNode): any => {
            const min = n.contentMin, max = n.contentMax;
            const cG: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
            const hG = [Math.max(1e-3, (max[0] - min[0]) / 2), Math.max(1e-3, (max[1] - min[1]) / 2), Math.max(1e-3, (max[2] - min[2]) / 2)];
            // Express centre and half-extents in the tileset (Z-up) frame
            const c = Splat3DTilesService.gltfToTilesetFrame(cG);
            const hx = hG[0], hy = hG[2] /* gltf z -> tileset y */, hz = hG[1] /* gltf y -> tileset z */;
            const tile: any = {
                boundingVolume: { box: [c[0], c[1], c[2], hx, 0, 0, 0, hy, 0, 0, 0, hz] },
                geometricError: n.geometricError,
                refine: 'REPLACE',
                content: { uri: n.uri }
            };
            if (n.children && n.children.length > 0) tile.children = n.children.map(toTile);
            return tile;
        };
        const rootTile = toTile(root);
        if (rootTransform) rootTile.transform = rootTransform;
        return {
            asset: { version: '1.1', generator: 'scratchbox-splat-3dtiles', extras: { numSplats } },
            geometricError: Math.max(root.geometricError * 4, 1e-3),
            extensionsUsed: ['3DTILES_content_gltf'],
            extensionsRequired: ['3DTILES_content_gltf'],
            extensions: {
                '3DTILES_content_gltf': {
                    extensionsUsed: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
                    extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2']
                }
            },
            root: rootTile
        };
    }
}
