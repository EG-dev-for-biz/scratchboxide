/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Street View Panorama Projection Service:
 * Direct port and enhancement of the sister repo spce (https://github.com/EG-dev-for-biz/spce).
 *
 * 1. Retrieves Google Street View panoramas by panoID (or geodetic coordinates) with full metadata
 *    and historical capture timelines (dating back to 2007).
 * 2. Fetches 4 cardinal perspective faces (North: 0°, East: 90°, South: 180°, West: 270°, fov: 100°)
 *    and optional Up (+90°) / Down (-90°) faces.
 * 3. Projects cubic perspective faces onto a 2:1 Equirectangular Projection (ERP) canvas via
 *    spherical ray-casting (projectCubicFacesToErpCanvas from spce/panoramaPanoTransform.ts).
 * 4. Supports Three.js projection both as Inward Spherical Equirectangular and 6-Face Cubemap Skybox
 *    (CustomPanoViewer from spce/RestyleImageModal.tsx).
 * 5. Supports 3D spatial unprojection to point clouds and Gaussian splat buffers
 *    (spce/StreetViewDepthUnprojector.ts).
 ********************************************************************************/

import { decodePng, encodePng } from '../texture-processing';

export interface HistoricalPanoRecord {
    panoId: string;
    date: string; // "YYYY-MM" or "YYYY-MM-DD"
    year: number;
    month: number;
    lat: number;
    lng: number;
    heading?: number;
    pitch?: number;
    description?: string;
}

export interface StreetViewPanoMetadata {
    panoId: string;
    lat: number;
    lng: number;
    date?: string;
    year?: number;
    month?: number;
    copyright?: string;
    status: string;
    historicalPanos?: HistoricalPanoRecord[];
}

export type CardinalFaceName = 'North' | 'East' | 'South' | 'West' | 'Up' | 'Down';

export interface RawFaceImage {
    width: number;
    height: number;
    /** RGBA buffer, length = width * height * 4 */
    rgba: Buffer | Uint8Array;
}

export interface CubicFacesInput {
    North: Buffer | Uint8Array | RawFaceImage;
    East: Buffer | Uint8Array | RawFaceImage;
    South: Buffer | Uint8Array | RawFaceImage;
    West: Buffer | Uint8Array | RawFaceImage;
    Up?: Buffer | Uint8Array | RawFaceImage;
    Down?: Buffer | Uint8Array | RawFaceImage;
}

export interface ProjectFacesOptions {
    /** FOV in degrees of the perspective faces (default 100, matching spce) */
    fovDegrees?: number;
    /** Output equirectangular width in pixels (default 2048, 2:1 ratio) */
    canvasWidth?: number;
    /** Output equirectangular height in pixels (default 1024, 2:1 ratio) */
    canvasHeight?: number;
    /**
     * Uncovered polar fill style:
     * - 'green': Chroma green [0, 255, 0, 255] for downstream neural inpainting (default in spce)
     * - 'seamless': Procedural atmospheric zenith sky gradient & nadir ground blur
     * - 'black': Solid black [0, 0, 0, 255]
     */
    fillMode?: 'green' | 'seamless' | 'black';
    /** Optional custom RGBA fill color [r, g, b, a] */
    customFillColor?: [number, number, number, number];
}

export interface ProjectedErpResult {
    width: number;
    height: number;
    rgba: Buffer;
    png: Buffer;
}

export interface StreetViewFetchOptions {
    panoId?: string;
    lat?: number;
    lng?: number;
    radiusMeters?: number;
    apiKey?: string;
    faceSize?: number;
    fovDegrees?: number;
    includePoles?: boolean;
    fetchImpl?: typeof fetch;
}

export interface StreetViewPointCloudResult {
    positions: Float32Array; // [x, y, z] per point
    colors: Uint8Array;      // [r, g, b] per point
    count: number;
    splatBuffer?: ArrayBuffer;
}

// -----------------------------------------------------------------------------
// Helper: Parse Date String
// -----------------------------------------------------------------------------
export function parseStreetViewDate(dateStr?: string | null): { year: number; month: number } {
    if (!dateStr || typeof dateStr !== 'string') {
        const now = new Date();
        return { year: now.getFullYear(), month: now.getMonth() + 1 };
    }
    const parts = dateStr.trim().split('-');
    const year = parseInt(parts[0] ?? '', 10) || 2024;
    const month = parts[1] ? Math.min(12, Math.max(1, parseInt(parts[1], 10))) : 6;
    return { year, month };
}

// -----------------------------------------------------------------------------
// Helper: Normalize Raw Face Buffer to RawFaceImage
// -----------------------------------------------------------------------------
function normalizeFaceImage(input: Buffer | Uint8Array | RawFaceImage): RawFaceImage {
    if ('width' in input && 'height' in input && 'rgba' in input) {
        return input;
    }
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    // Check if JPEG header (0xFF 0xD8 0xFF)
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) {
        try {
            const cp = require('child_process');
            const fs = require('fs');
            const os = require('os');
            const path = require('path');
            const tmpJpg = path.join(os.tmpdir(), `sv_face_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
            const tmpPng = tmpJpg.replace('.jpg', '.png');
            fs.writeFileSync(tmpJpg, buf);
            cp.execSync(`sips -s format png "${tmpJpg}" --out "${tmpPng}"`, { stdio: 'pipe' });
            const pngBuf = fs.readFileSync(tmpPng);
            try { fs.unlinkSync(tmpJpg); } catch {}
            try { fs.unlinkSync(tmpPng); } catch {}
            const decoded = decodePng(pngBuf);
            return {
                width: decoded.width,
                height: decoded.height,
                rgba: decoded.rgba
            };
        } catch {
            // fall through to check other formats
        }
    }
    // Check if PNG header
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        const decoded = decodePng(buf);
        return {
            width: decoded.width,
            height: decoded.height,
            rgba: decoded.rgba
        };
    }
    // If raw square RGBA or RGB
    const pixelCount = buf.length / 4;
    const side = Math.round(Math.sqrt(pixelCount));
    if (side * side * 4 === buf.length) {
        return { width: side, height: side, rgba: buf };
    }
    const rgbSide = Math.round(Math.sqrt(buf.length / 3));
    if (rgbSide * rgbSide * 3 === buf.length) {
        const rgba = Buffer.alloc(rgbSide * rgbSide * 4);
        for (let i = 0; i < rgbSide * rgbSide; i++) {
            rgba[i * 4 + 0] = buf[i * 3 + 0]!;
            rgba[i * 4 + 1] = buf[i * 3 + 1]!;
            rgba[i * 4 + 2] = buf[i * 3 + 2]!;
            rgba[i * 4 + 3] = 255;
        }
        return { width: rgbSide, height: rgbSide, rgba };
    }
    throw new Error(`Unsupported face image buffer format (byteLength: ${buf.length}). Expected PNG, JPEG or raw RGBA.`);
}

/**
 * Projects cubic perspective faces onto a single 2:1 ERP equirectangular canvas.
 * Exact mathematical port and extension of projectCubicFacesToErpCanvas from spce/panoramaPanoTransform.ts.
 */
export function projectCubicFacesToErpBuffer(
    faces: CubicFacesInput,
    options: ProjectFacesOptions = {}
): ProjectedErpResult {
    const fovDegrees = options.fovDegrees ?? 100;
    const W = options.canvasWidth ?? 2048;
    const H = options.canvasHeight ?? 1024;
    const fillMode = options.fillMode ?? 'green';

    const northImg = normalizeFaceImage(faces.North);
    const eastImg = normalizeFaceImage(faces.East);
    const southImg = normalizeFaceImage(faces.South);
    const westImg = normalizeFaceImage(faces.West);
    const upImg = faces.Up ? normalizeFaceImage(faces.Up) : null;
    const downImg = faces.Down ? normalizeFaceImage(faces.Down) : null;

    const S = northImg.width;

    const rawFaces = {
        North: northImg.rgba,
        East: eastImg.rgba,
        South: southImg.rgba,
        West: westImg.rgba,
        Up: upImg ? upImg.rgba : null,
        Down: downImg ? downImg.rgba : null
    };

    // Initialize raw output buffer
    const outBuffer = Buffer.alloc(W * H * 4);
    let defaultR = 0, defaultG = 255, defaultB = 0, defaultA = 255; // Default chroma green
    if (options.customFillColor) {
        [defaultR, defaultG, defaultB, defaultA] = options.customFillColor;
    } else if (fillMode === 'black') {
        defaultR = 0; defaultG = 0; defaultB = 0; defaultA = 255;
    }

    for (let i = 0; i < W * H; i++) {
        outBuffer[i * 4 + 0] = defaultR;
        outBuffer[i * 4 + 1] = defaultG;
        outBuffer[i * 4 + 2] = defaultB;
        outBuffer[i * 4 + 3] = defaultA;
    }

    // Precompute face details: heading in radians (0: North, PI/2: East, PI: South, -PI/2: West)
    const cardinalFaces: Array<{ name: 'North' | 'East' | 'South' | 'West'; heading: number }> = [
        { name: 'North', heading: 0 },
        { name: 'East', heading: Math.PI / 2 },
        { name: 'South', heading: Math.PI },
        { name: 'West', heading: -Math.PI / 2 }
    ];

    const halfFovRad = (fovDegrees * Math.PI) / 360;
    const tanHalfFov = Math.tan(halfFovRad);

    for (let y = 0; y < H; y++) {
        // Latitude phi: range [PI/2, -PI/2] from top to bottom
        const phi = Math.PI / 2 - (y / (H - 1)) * Math.PI;
        const cosPhi = Math.cos(phi);
        const sinPhi = Math.sin(phi);

        for (let x = 0; x < W; x++) {
            // Longitude theta: range [-PI, PI] from left to right
            const theta = (x / (W - 1)) * 2 * Math.PI - Math.PI;

            // 3D unit ray direction vector v (pointing out to the skybox)
            const vx = cosPhi * Math.sin(theta);
            const vy = sinPhi;
            const vz = -cosPhi * Math.cos(theta); // vz = -1 is North

            let bestFaceName: CardinalFaceName | null = null;
            let maxZCam = -1;
            let bestPx = -1;
            let bestPy = -1;

            // 1. Check Cardinal Faces (North, East, South, West)
            for (const face of cardinalFaces) {
                const H_face = face.heading;
                // Project ray direction onto face camera's local axes
                const x_cam = vx * Math.cos(H_face) + vz * Math.sin(H_face);
                const y_cam = vy;
                const z_cam = vx * Math.sin(H_face) - vz * Math.cos(H_face);

                if (z_cam > 0) {
                    const u_cam = x_cam / z_cam;
                    const v_cam = y_cam / z_cam;

                    if (Math.abs(u_cam) <= tanHalfFov && Math.abs(v_cam) <= tanHalfFov) {
                        if (z_cam > maxZCam) {
                            const px = Math.round(((u_cam / tanHalfFov + 1) / 2) * (S - 1));
                            const py = Math.round(((1 - v_cam / tanHalfFov) / 2) * (S - 1));

                            if (px >= 0 && px < S && py >= 0 && py < S) {
                                maxZCam = z_cam;
                                bestFaceName = face.name;
                                bestPx = px;
                                bestPy = py;
                            }
                        }
                    }
                }
            }

            // 2. Check Up Face (Zenith, pitch +90°) if provided
            if (rawFaces.Up && vy > 0) {
                const z_cam = vy;
                const x_cam = vx;
                const y_cam = -vz;
                const u_cam = x_cam / z_cam;
                const v_cam = y_cam / z_cam;
                if (Math.abs(u_cam) <= tanHalfFov && Math.abs(v_cam) <= tanHalfFov && z_cam > maxZCam) {
                    const px = Math.round(((u_cam / tanHalfFov + 1) / 2) * (S - 1));
                    const py = Math.round(((1 - v_cam / tanHalfFov) / 2) * (S - 1));
                    if (px >= 0 && px < S && py >= 0 && py < S) {
                        maxZCam = z_cam;
                        bestFaceName = 'Up';
                        bestPx = px;
                        bestPy = py;
                    }
                }
            }

            // 3. Check Down Face (Nadir, pitch -90°) if provided
            if (rawFaces.Down && vy < 0) {
                const z_cam = -vy;
                const x_cam = vx;
                const y_cam = vz;
                const u_cam = x_cam / z_cam;
                const v_cam = y_cam / z_cam;
                if (Math.abs(u_cam) <= tanHalfFov && Math.abs(v_cam) <= tanHalfFov && z_cam > maxZCam) {
                    const px = Math.round(((u_cam / tanHalfFov + 1) / 2) * (S - 1));
                    const py = Math.round(((1 - v_cam / tanHalfFov) / 2) * (S - 1));
                    if (px >= 0 && px < S && py >= 0 && py < S) {
                        maxZCam = z_cam;
                        bestFaceName = 'Down';
                        bestPx = px;
                        bestPy = py;
                    }
                }
            }

            const outIdx = (y * W + x) * 4;

            if (bestFaceName !== null) {
                const faceBuffer = rawFaces[bestFaceName]!;
                const faceIdx = (bestPy * S + bestPx) * 4;

                outBuffer[outIdx + 0] = faceBuffer[faceIdx + 0]!;
                outBuffer[outIdx + 1] = faceBuffer[faceIdx + 1]!;
                outBuffer[outIdx + 2] = faceBuffer[faceIdx + 2]!;
                outBuffer[outIdx + 3] = faceBuffer[faceIdx + 3] ?? 255;
            } else if (fillMode === 'seamless') {
                // Procedural seamless pole interpolation
                if (vy > 0) {
                    // Zenith atmospheric gradient (sky blue to light horizon)
                    const t = Math.min(1, Math.max(0, vy));
                    outBuffer[outIdx + 0] = Math.round(135 * (1 - t) + 70 * t);
                    outBuffer[outIdx + 1] = Math.round(185 * (1 - t) + 130 * t);
                    outBuffer[outIdx + 2] = Math.round(235 * (1 - t) + 210 * t);
                    outBuffer[outIdx + 3] = 255;
                } else {
                    // Nadir roadway tone (asphalt dark gray)
                    outBuffer[outIdx + 0] = 45;
                    outBuffer[outIdx + 1] = 48;
                    outBuffer[outIdx + 2] = 52;
                    outBuffer[outIdx + 3] = 255;
                }
            }
        }
    }

    const png = encodePng(W, H, outBuffer);
    return { width: W, height: H, rgba: outBuffer, png };
}

export const DEFAULT_GOOGLE_MAPS_API_KEY = 'AIzaSyCSHRfQGTmZykmM4LA6mI7avjEQEkQive4';

/**
 * Historical and Metadata query for Google Street View.
 * Matches spce's HistoricalStreetViewProvider.
 */
export async function fetchStreetViewPanoMetadata(
    options: {
        panoId?: string;
        lat?: number;
        lng?: number;
        radiusMeters?: number;
        apiKey?: string;
        fetchImpl?: typeof fetch;
    }
): Promise<StreetViewPanoMetadata> {
    const key = options.apiKey
        || (typeof process !== 'undefined'
            ? process.env?.GOOGLE_MAPS_API_KEY || process.env?.MAP_TILES_API_KEY || ''
            : '')
        || DEFAULT_GOOGLE_MAPS_API_KEY;

    if (!key) {
        throw new Error('Google Maps API key is required to query Street View metadata.');
    }

    const fetchImpl = options.fetchImpl ?? fetch;
    const params = new URLSearchParams({ source: 'outdoor', key });

    if (options.panoId) {
        params.set('pano', options.panoId);
    } else if (options.lat !== undefined && options.lng !== undefined) {
        params.set('location', `${options.lat},${options.lng}`);
        params.set('radius', String(options.radiusMeters ?? 250));
    } else {
        throw new Error('Either panoId or lat/lng coordinates must be provided to query Street View.');
    }

    const metaRes = await fetchImpl(`https://maps.googleapis.com/maps/api/streetview/metadata?${params}`);
    if (!metaRes.ok) {
        throw new Error(`Street View metadata HTTP error: ${metaRes.statusText} (${metaRes.status})`);
    }

    const data = (await metaRes.json()) as any;
    if (data.status !== 'OK' || !data.pano_id) {
        throw new Error(`No Street View panorama found (${data.status || 'ZERO_RESULTS'}).`);
    }

    const { year, month } = parseStreetViewDate(data.date);
    const historicalPanos: HistoricalPanoRecord[] = [];
    const seenPanoIds = new Set<string>();

    // Primary pano
    historicalPanos.push({
        panoId: data.pano_id,
        date: data.date || `${year}-${month < 10 ? `0${month}` : month}`,
        year,
        month,
        lat: data.location?.lat ?? options.lat ?? 0,
        lng: data.location?.lng ?? options.lng ?? 0,
        description: `Street View capture from ${year}-${month}`
    });
    seenPanoIds.add(data.pano_id);

    // Parse historical panos array if provided by Street View API
    const rawHistorical = data.historical_panos || data.dates || data.panos || data.time_machine || [];
    if (Array.isArray(rawHistorical)) {
        for (const item of rawHistorical) {
            const pid = item.pano_id || item.panoId || item.pano || item.id;
            if (!pid || seenPanoIds.has(pid)) continue;
            const parsed = parseStreetViewDate(item.date || item.captureDate || item.time);
            historicalPanos.push({
                panoId: pid,
                date: item.date || `${parsed.year}-${parsed.month < 10 ? `0${parsed.month}` : parsed.month}`,
                year: parsed.year,
                month: parsed.month,
                lat: item.lat ?? item.location?.lat ?? data.location?.lat ?? 0,
                lng: item.lng ?? item.location?.lng ?? data.location?.lng ?? 0,
                heading: item.heading,
                description: `Historical Street View capture from ${parsed.year}-${parsed.month}`
            });
            seenPanoIds.add(pid);
        }
    }

    return {
        panoId: data.pano_id,
        lat: data.location?.lat ?? options.lat ?? 0,
        lng: data.location?.lng ?? options.lng ?? 0,
        date: data.date,
        year,
        month,
        copyright: data.copyright,
        status: data.status,
        historicalPanos
    };
}

/**
 * Downloads 4 cardinal perspective faces (North: 0°, East: 90°, South: 180°, West: 270°, fov: 100°)
 * from Google Street View Static API, matching spce's facesConfig in generateFlux360PanoErp / generate360StreetSplat.
 */
export async function fetchStreetViewCubicFaces(
    options: StreetViewFetchOptions
): Promise<{
    metadata: StreetViewPanoMetadata;
    faces: { North: Buffer; East: Buffer; South: Buffer; West: Buffer; Up?: Buffer; Down?: Buffer };
}> {
    const key = options.apiKey
        || (typeof process !== 'undefined'
            ? process.env?.GOOGLE_MAPS_API_KEY || process.env?.MAP_TILES_API_KEY || ''
            : '')
        || DEFAULT_GOOGLE_MAPS_API_KEY;

    if (!key) {
        throw new Error('Google Maps API key is required to download Street View cubic faces.');
    }

    const fetchImpl = options.fetchImpl ?? fetch;
    const metadata = await fetchStreetViewPanoMetadata(options);
    const panoId = metadata.panoId;
    const size = options.faceSize ?? 1024;
    const fov = options.fovDegrees ?? 100;

    const cardinalConfig: Array<{ name: 'North' | 'East' | 'South' | 'West'; heading: number; pitch: number }> = [
        { name: 'North', heading: 0, pitch: 0 },
        { name: 'East', heading: 90, pitch: 0 },
        { name: 'South', heading: 180, pitch: 0 },
        { name: 'West', heading: 270, pitch: 0 }
    ];

    if (options.includePoles) {
        // Optional Up & Down
        cardinalConfig.push({ name: 'North', heading: 0, pitch: 90 }); // Zenith
        cardinalConfig.push({ name: 'North', heading: 0, pitch: -90 }); // Nadir
    }

    const tasks = cardinalConfig.map(async (face) => {
        const url = `https://maps.googleapis.com/maps/api/streetview?size=${size}x${size}&pano=${encodeURIComponent(
            panoId
        )}&fov=${fov}&heading=${face.heading}&pitch=${face.pitch}&source=outdoor&key=${key}`;

        const res = await fetchImpl(url);
        if (!res.ok) {
            throw new Error(`Failed to download Street View face ${face.name} (H:${face.heading}, P:${face.pitch}): ${res.statusText}`);
        }
        const ab = await res.arrayBuffer();
        return { name: face.name, pitch: face.pitch, buffer: Buffer.from(ab) };
    });

    const downloaded = await Promise.all(tasks);
    const facesMap: any = {};
    for (const item of downloaded) {
        if (item.pitch === 90) facesMap.Up = item.buffer;
        else if (item.pitch === -90) facesMap.Down = item.buffer;
        else facesMap[item.name] = item.buffer;
    }

    return { metadata, faces: facesMap };
}

/**
 * End-to-end: Retrieves Street View imagery by Pano ID (or coordinates) and projects it onto
 * a 2:1 ERP equirectangular canvas buffer matching spce.
 */
export async function retrieveAndProjectStreetViewPano(
    options: StreetViewFetchOptions & ProjectFacesOptions
): Promise<{
    metadata: StreetViewPanoMetadata;
    projectedErp: ProjectedErpResult;
}> {
    const { metadata, faces } = await fetchStreetViewCubicFaces(options);
    const projectedErp = projectCubicFacesToErpBuffer(faces, options);
    return { metadata, projectedErp };
}

/**
 * Unprojects 4 cardinal Street View perspective faces into a 3D Gaussian Splat scene buffer
 * or point cloud. Direct port of unprojectFacesTo3DSplatBuffer from spce/streetSplatPipeline.ts.
 */
export function unprojectCubicFacesToPointCloud(
    faces: CubicFacesInput,
    options: {
        cameraHeightMeters?: number;
        maxRangeMeters?: number;
        stepPixels?: number;
        fovDegrees?: number;
    } = {}
): StreetViewPointCloudResult {
    const cameraHeight = options.cameraHeightMeters ?? 2.5; // Google Street View vehicle camera mast height
    const maxRange = options.maxRangeMeters ?? 60.0;
    const step = options.stepPixels ?? 4;
    const fovDegrees = options.fovDegrees ?? 100;

    const northImg = normalizeFaceImage(faces.North);
    const eastImg = normalizeFaceImage(faces.East);
    const southImg = normalizeFaceImage(faces.South);
    const westImg = normalizeFaceImage(faces.West);

    const faceList: Array<{ name: string; rgba: Buffer | Uint8Array; headingRad: number }> = [
        { name: 'North', rgba: northImg.rgba, headingRad: 0 },
        { name: 'East', rgba: eastImg.rgba, headingRad: Math.PI / 2 },
        { name: 'South', rgba: southImg.rgba, headingRad: Math.PI },
        { name: 'West', rgba: westImg.rgba, headingRad: -Math.PI / 2 }
    ];

    const S = northImg.width;
    const halfFovRad = (fovDegrees * Math.PI) / 360;
    const tanHalfFov = Math.tan(halfFovRad);

    const maxPoints = faceList.length * Math.ceil(S / step) * Math.ceil(S / step);
    const positions = new Float32Array(maxPoints * 3);
    const colors = new Uint8Array(maxPoints * 3);
    let count = 0;

    for (const face of faceList) {
        const H = face.headingRad;
        const cosH = Math.cos(H);
        const sinH = Math.sin(H);

        for (let py = 0; py < S; py += step) {
            const v_cam = (1 - (py / (S - 1)) * 2) * tanHalfFov;

            for (let px = 0; px < S; px += step) {
                const u_cam = ((px / (S - 1)) * 2 - 1) * tanHalfFov;

                // Local ray direction vector (z forward)
                const dirLen = Math.hypot(u_cam, v_cam, 1.0);
                const rx_local = u_cam / dirLen;
                const ry_local = v_cam / dirLen;
                const rz_local = 1.0 / dirLen;

                // World ray direction vector
                const rx_world = rx_local * cosH + rz_local * sinH;
                const ry_world = ry_local;
                const rz_world = -rx_local * sinH + rz_local * cosH;

                // Depth estimation: ground plane vs architectural facade
                let depth = maxRange;
                if (ry_world < -0.05) {
                    // Ground intersection: y = -cameraHeight
                    const groundDist = -cameraHeight / ry_world;
                    depth = Math.min(maxRange, Math.max(0.5, groundDist));
                } else {
                    // Facade depth estimation
                    depth = Math.min(maxRange, Math.max(4.0, 15.0 / (Math.abs(ry_world) + 0.3)));
                }

                const px_world = rx_world * depth;
                const py_world = cameraHeight + ry_world * depth;
                const pz_world = rz_world * depth;

                const srcIdx = (py * S + px) * 4;
                const r = face.rgba[srcIdx + 0] ?? 200;
                const g = face.rgba[srcIdx + 1] ?? 200;
                const b = face.rgba[srcIdx + 2] ?? 200;

                const outIdx = count * 3;
                positions[outIdx + 0] = px_world;
                positions[outIdx + 1] = py_world;
                positions[outIdx + 2] = pz_world;

                colors[outIdx + 0] = r;
                colors[outIdx + 1] = g;
                colors[outIdx + 2] = b;

                count++;
            }
        }
    }

    // Convert to 32-byte Gaussian splat buffer format (matching spce/streetSplatPipeline.ts)
    const splatBuffer = new ArrayBuffer(count * 32);
    const f32View = new Float32Array(splatBuffer);
    const u8View = new Uint8Array(splatBuffer);
    const splatScale = 0.035;

    for (let i = 0; i < count; i++) {
        const floatOffset = i * 8;
        f32View[floatOffset + 0] = positions[i * 3 + 0]!;
        f32View[floatOffset + 1] = positions[i * 3 + 1]!;
        f32View[floatOffset + 2] = positions[i * 3 + 2]!;
        f32View[floatOffset + 3] = splatScale;
        f32View[floatOffset + 4] = splatScale;
        f32View[floatOffset + 5] = splatScale;

        const byteOffset = i * 32;
        u8View[byteOffset + 24] = colors[i * 3 + 0]!;
        u8View[byteOffset + 25] = colors[i * 3 + 1]!;
        u8View[byteOffset + 26] = colors[i * 3 + 2]!;
        u8View[byteOffset + 27] = 255; // opacity
        u8View[byteOffset + 28] = 128; // rot x
        u8View[byteOffset + 29] = 128; // rot y
        u8View[byteOffset + 30] = 128; // rot z
        u8View[byteOffset + 31] = 255; // rot w
    }

    return {
        positions: positions.subarray(0, count * 3),
        colors: colors.subarray(0, count * 3),
        count,
        splatBuffer
    };
}
