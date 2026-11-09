/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Street View restyle: removes every vehicle and person from a street-level image and, optionally, relights it
 * for a time of day or weather. Port of spce's `cleanStreetViewImage` (apps/web/app/actions.ts); the prompt and
 * lighting clauses are kept identical so both apps produce the same restyle.
 ********************************************************************************/

import type { GoogleGenAI } from '@google/genai';
import { finalImagePart } from '../google-media-generation-service';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';

export const STREET_VIEW_RESTYLE_MODEL = 'gemini-3.1-flash-lite-image';

const REMOVAL_INSTRUCTION = 'CRITICAL INSTRUCTION: Erase and completely remove ALL vehicles (including taxis, yellow cabs, cars, trucks, buses, vans, SUVs, motorcycles, bicycles, trailers, or wheels), license plates, and ALL people, pedestrians, tourists, crowds, and children from the image. Every single vehicle and person must be completely scrubbed out of existence. Seamlessly fill the regions where vehicles and people were with clean asphalt pavement, realistic black road textures, yellow/white road lane markings, and concrete sidewalk lines matching the surroundings. There must be zero ghosts, zero silhouettes, zero blurry blobs, and zero traces of any cars or people left behind. The entire street, roads, and sidewalks must be a pristine, completely empty, clean city street with absolute clarity and no vehicles or pedestrians whatsoever. Do not change, modify, or add any buildings, trees, structures, or the camera perspective.';

export interface StreetViewLighting {
    /** Local solar hour, e.g. 17.5 for 17:30. */
    timeOfDay?: number;
    /** 'overcast' | 'rain' | 'fog' switch to diffuse overcast lighting. */
    weather?: string;
    /** Camera heading in degrees, used to place the sun relative to the frame. */
    heading?: number;
}

export interface StreetViewRestyleRequest extends StreetViewLighting {
    image: Buffer;
    mimeType?: string;
    /** Output aspect ratio requested from the model; spce always uses '3:2'. */
    aspectRatio?: string;
}

export interface StreetViewRestyleResult {
    image: Buffer;
    mimeType: string;
    model: string;
    prompt: string;
}

export interface StreetViewShotRequest {
    lat: number;
    lng: number;
    panoId?: string;
    heading?: number;
    pitch?: number;
    fov?: number;
    width?: number;
    height?: number;
    radiusMeters?: number;
    apiKey: string;
    fetchImpl?: typeof fetch;
}

export interface StreetViewShot {
    image: Buffer;
    mimeType: string;
    panoId: string;
    date?: string;
    location?: { lat: number; lng: number };
    copyright?: string;
}

export function buildStreetViewLightingDescription({ timeOfDay, weather, heading }: StreetViewLighting = {}): string {
    if (weather === 'overcast' || weather === 'rain' || weather === 'fog') {
        return 'overcast sky, highly diffuse scattered atmospheric lighting with very soft, almost invisible ambient occlusion, wet surfaces, and cool slate-gray tones.';
    }
    if (timeOfDay === undefined) {
        return '';
    }
    const timeFloat = timeOfDay;
    const hour = Math.floor(timeFloat);
    const minute = Math.round((timeFloat - hour) * 60);
    const timeString = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    let sunAngle = 45;
    if (timeFloat >= 6.0 && timeFloat <= 18.0) {
        const dayFraction = (timeFloat - 6.0) / 12.0;
        sunAngle = Math.round(90 * Math.sin(dayFraction * Math.PI));
    } else {
        const nightFraction = timeFloat < 6.0 ? (timeFloat + 6.0) / 12.0 : (timeFloat - 18.0) / 12.0;
        sunAngle = Math.round(90 * Math.sin(nightFraction * Math.PI));
    }
    if (sunAngle < 5) sunAngle = 5;
    if (sunAngle > 85) sunAngle = 85;

    let lightingDescription = 'crisp mid-morning';
    if (hour < 5) lightingDescription = 'cool nighttime sky and moonlight';
    else if (hour < 7) lightingDescription = 'early dawn twilight';
    else if (hour < 9) lightingDescription = 'warm golden hour morning';
    else if (hour < 11) lightingDescription = 'crisp mid-morning';
    else if (hour < 14) lightingDescription = 'bright midday sun';
    else if (hour < 17) lightingDescription = 'clear afternoon';
    else if (hour < 19) lightingDescription = 'warm golden hour sunset';
    else if (hour < 22) lightingDescription = 'dusky twilight / blue hour';
    else lightingDescription = 'cool nighttime sky and moonlight';

    const angle = ((timeFloat - 6) / 24) * Math.PI * 2;
    const sunX = Math.cos(angle) * 100;
    const sunZ = 30;
    let sunHeading = (Math.atan2(sunX, -sunZ) * 180) / Math.PI;
    if (sunHeading < 0) sunHeading += 360;

    const relativeSunHeading = (sunHeading - (heading ?? 0) + 360) % 360;
    let relativeSunDesc = 'overhead';
    if (sunAngle > 70) {
        relativeSunDesc = 'overhead, casting short, direct shadows beneath structures';
    } else if (relativeSunHeading >= 340 || relativeSunHeading <= 20) {
        relativeSunDesc = 'directly in front of the camera, casting long shadows towards the viewer/foreground';
    } else if (relativeSunHeading > 20 && relativeSunHeading < 70) {
        relativeSunDesc = 'in the upper-right quadrant of the frame, casting shadows towards the left and front';
    } else if (relativeSunHeading >= 70 && relativeSunHeading <= 110) {
        relativeSunDesc = 'to the far-right of the frame, casting long side-lit shadows to the left';
    } else if (relativeSunHeading > 110 && relativeSunHeading < 160) {
        relativeSunDesc = 'behind and to the right of the camera, front-lighting features and casting shadows to the left-background';
    } else if (relativeSunHeading >= 160 && relativeSunHeading <= 200) {
        relativeSunDesc = 'directly behind the camera, front-lighting facades cleanly and casting shadows straight back away from the lens';
    } else if (relativeSunHeading > 200 && relativeSunHeading < 250) {
        relativeSunDesc = 'behind and to the left of the camera, front-lighting features and casting shadows to the right-background';
    } else if (relativeSunHeading >= 250 && relativeSunHeading <= 290) {
        relativeSunDesc = 'to the far-left of the frame, casting long side-lit shadows to the right';
    } else {
        relativeSunDesc = 'in the upper-left quadrant of the frame, casting shadows towards the right and front';
    }

    return `Apply realistic, ${lightingDescription} lighting at ${timeString} at a ${sunAngle}-degree angle with the sun positioned ${relativeSunDesc} to project clean, accurate shadow profiles across all features, emphasizing the site's true dimensions and height differences.`;
}

/** Pixel rectangle, [x0, x1) x [y0, y1). */
export interface PixelRegion {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

interface RgbaImage {
    width: number;
    height: number;
    rgba: Buffer | Uint8Array;
}

/**
 * Takes cleaned pixels only inside the given regions (feathered at the edges) and keeps the original everywhere
 * else, so generative edits outside the removed objects never reach the output. Each region's patch is shifted
 * by the integer offset that best matches the original in a ring around the region, because the model can move
 * content by a few pixels.
 */
export function compositeWithinRegions(
    original: RgbaImage,
    cleaned: RgbaImage,
    regions: PixelRegion[],
    { featherPx = 16, searchPx = 12, ringPx = 16 }: { featherPx?: number; searchPx?: number; ringPx?: number } = {}
): Buffer {
    const W = original.width, H = original.height;
    if (cleaned.width !== W || cleaned.height !== H) {
        throw new Error(`Original and cleaned images must be the same size (${W}x${H} vs ${cleaned.width}x${cleaned.height}).`);
    }
    const out = Buffer.from(original.rgba);
    const luma = (img: RgbaImage, x: number, y: number) => {
        const i = (y * W + x) * 4;
        return img.rgba[i] * 0.299 + img.rgba[i + 1] * 0.587 + img.rgba[i + 2] * 0.114;
    };
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

    for (const region of regions) {
        const x0 = clamp(Math.floor(region.x0), 0, W), x1 = clamp(Math.ceil(region.x1), 0, W);
        const y0 = clamp(Math.floor(region.y0), 0, H), y1 = clamp(Math.ceil(region.y1), 0, H);
        if (x1 <= x0 || y1 <= y0) continue;

        const rx0 = Math.max(0, x0 - ringPx), rx1 = Math.min(W, x1 + ringPx);
        const ry0 = Math.max(0, y0 - ringPx), ry1 = Math.min(H, y1 + ringPx);
        const step = (rx1 - rx0) * (ry1 - ry0) > 40000 ? 2 : 1;
        let best = { dx: 0, dy: 0, cost: Infinity };
        for (let dy = -searchPx; dy <= searchPx; dy++) {
            for (let dx = -searchPx; dx <= searchPx; dx++) {
                let cost = 0, n = 0;
                for (let y = ry0; y < ry1; y += step) {
                    for (let x = rx0; x < rx1; x += step) {
                        if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
                        const sx = x + dx, sy = y + dy;
                        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
                        cost += Math.abs(luma(original, x, y) - luma(cleaned, sx, sy));
                        n++;
                    }
                }
                if (n > 0 && cost / n < best.cost) best = { dx, dy, cost: cost / n };
            }
        }

        for (let y = Math.max(0, y0 - featherPx); y < Math.min(H, y1 + featherPx); y++) {
            for (let x = Math.max(0, x0 - featherPx); x < Math.min(W, x1 + featherPx); x++) {
                const d = Math.hypot(Math.max(x0 - x, 0, x - (x1 - 1)), Math.max(y0 - y, 0, y - (y1 - 1)));
                const m = d === 0 ? 1 : Math.max(0, 1 - d / featherPx);
                if (m <= 0) continue;
                const o = (y * W + x) * 4;
                const c = (clamp(y + best.dy, 0, H - 1) * W + clamp(x + best.dx, 0, W - 1)) * 4;
                for (let k = 0; k < 3; k++) {
                    out[o + k] = Math.round(out[o + k] * (1 - m) + cleaned.rgba[c + k] * m);
                }
                out[o + 3] = 255;
            }
        }
    }
    return out;
}

/**
 * Where the restyle removed something: compact areas that changed between the original and the cleaned image,
 * overlap a detection box, and do not reach the frame edge (edits that run off the frame, such as an invented
 * sidewalk band, are not object removals). Detection boxes can be loose; the change map sets the extent.
 */
export function removedObjectRegions(
    original: RgbaImage,
    cleaned: RgbaImage,
    detections: PixelRegion[],
    { threshold = 40, blockPx = 4, marginPx = 24 }: { threshold?: number; blockPx?: number; marginPx?: number } = {}
): PixelRegion[] {
    const W = original.width, H = original.height;
    if (cleaned.width !== W || cleaned.height !== H) {
        throw new Error(`Original and cleaned images must be the same size (${W}x${H} vs ${cleaned.width}x${cleaned.height}).`);
    }
    const bw = Math.ceil(W / blockPx), bh = Math.ceil(H / blockPx);
    const changed = new Uint8Array(bw * bh);
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            let sum = 0, n = 0;
            for (let y = by * blockPx; y < Math.min(H, (by + 1) * blockPx); y++) {
                for (let x = bx * blockPx; x < Math.min(W, (bx + 1) * blockPx); x++) {
                    const i = (y * W + x) * 4;
                    const a = original.rgba[i] * 0.299 + original.rgba[i + 1] * 0.587 + original.rgba[i + 2] * 0.114;
                    const b = cleaned.rgba[i] * 0.299 + cleaned.rgba[i + 1] * 0.587 + cleaned.rgba[i + 2] * 0.114;
                    sum += Math.abs(a - b);
                    n++;
                }
            }
            changed[by * bw + bx] = sum / n > threshold ? 1 : 0;
        }
    }

    const seen = new Uint8Array(bw * bh);
    const regions: PixelRegion[] = [];
    for (let start = 0; start < bw * bh; start++) {
        if (!changed[start] || seen[start]) continue;
        let minX = bw, minY = bh, maxX = -1, maxY = -1, touchesEdge = false;
        const stack = [start];
        seen[start] = 1;
        while (stack.length) {
            const cell = stack.pop() as number;
            const cx = cell % bw, cy = Math.floor(cell / bw);
            minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
            minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
            if (cx === 0 || cy === 0 || cx === bw - 1 || cy === bh - 1) touchesEdge = true;
            for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
                if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
                const next = ny * bw + nx;
                if (changed[next] && !seen[next]) {
                    seen[next] = 1;
                    stack.push(next);
                }
            }
        }
        if (touchesEdge) continue;
        const box = { x0: minX * blockPx, y0: minY * blockPx, x1: Math.min(W, (maxX + 1) * blockPx), y1: Math.min(H, (maxY + 1) * blockPx) };
        const overlaps = detections.some(d => box.x0 < d.x1 && box.x1 > d.x0 && box.y0 < d.y1 && box.y1 > d.y0);
        if (overlaps) {
            regions.push({
                x0: Math.max(0, box.x0 - marginPx), y0: Math.max(0, box.y0 - marginPx),
                x1: Math.min(W, box.x1 + marginPx), y1: Math.min(H, box.y1 + marginPx)
            });
        }
    }
    return regions;
}

export function buildStreetViewRestylePrompt(lighting: StreetViewLighting = {}): string {
    const lightingDesc = buildStreetViewLightingDescription(lighting);
    return lightingDesc ? `${REMOVAL_INSTRUCTION} ${lightingDesc}` : REMOVAL_INSTRUCTION;
}

export class StreetViewRestyleService {
    constructor(private readonly deps: {
        client?: Pick<GoogleGenAI, 'models'>;
        credentials?: GoogleMediaCredentialsService;
        model?: string;
        /** Vertex AI location; preview image models are served from 'global'. */
        location?: string;
    } = {}) {}

    async restyle(request: StreetViewRestyleRequest): Promise<StreetViewRestyleResult> {
        const model = this.deps.model ?? STREET_VIEW_RESTYLE_MODEL;
        const client = this.deps.client
            ?? await (this.deps.credentials ?? new GoogleMediaCredentialsService()).createVertexClient(this.deps.location ?? 'global');
        const prompt = buildStreetViewRestylePrompt(request);
        const response = await client.models.generateContent({
            model,
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { mimeType: request.mimeType ?? 'image/jpeg', data: request.image.toString('base64') } },
                    { text: prompt }
                ]
            }],
            config: {
                responseModalities: ['IMAGE'],
                imageConfig: { aspectRatio: request.aspectRatio ?? '3:2' },
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }
                ]
            } as any
        });
        const part = finalImagePart(response.candidates?.[0]?.content?.parts);
        if (!part?.inlineData?.data) {
            throw new Error('No image data returned from Gemini for vehicle/pedestrian removal');
        }
        return {
            image: Buffer.from(part.inlineData.data, 'base64'),
            mimeType: part.inlineData.mimeType ?? 'image/png',
            model,
            prompt
        };
    }

    /** Street View Static API image for a location or panorama; throws when there is no outdoor coverage. */
    static async fetchStreetViewImage(request: StreetViewShotRequest): Promise<StreetViewShot> {
        if (!request.apiKey) {
            throw new Error('A Google Maps API key is required to fetch Street View imagery.');
        }
        const fetchImpl = request.fetchImpl ?? fetch;
        const metaParams = new URLSearchParams({ source: 'outdoor', key: request.apiKey });
        if (request.panoId) metaParams.set('pano', request.panoId);
        else {
            metaParams.set('location', `${request.lat},${request.lng}`);
            metaParams.set('radius', String(request.radiusMeters ?? 250));
        }
        const metaRes = await fetchImpl(`https://maps.googleapis.com/maps/api/streetview/metadata?${metaParams}`);
        const meta: any = await metaRes.json();
        if (!metaRes.ok || meta.status !== 'OK' || !meta.pano_id) {
            throw new Error(`No Street View coverage at ${request.panoId ?? `${request.lat},${request.lng}`} (${meta.status ?? metaRes.status}).`);
        }
        const imageParams = new URLSearchParams({
            size: `${request.width ?? 600}x${request.height ?? 400}`,
            pano: meta.pano_id,
            fov: String(request.fov ?? 90),
            heading: String(request.heading ?? 0),
            pitch: String(request.pitch ?? 10),
            source: 'outdoor',
            key: request.apiKey
        });
        const imageRes = await fetchImpl(`https://maps.googleapis.com/maps/api/streetview?${imageParams}`);
        if (!imageRes.ok) {
            throw new Error(`Street View image request failed (${imageRes.status}).`);
        }
        return {
            image: Buffer.from(await imageRes.arrayBuffer()),
            mimeType: imageRes.headers.get('content-type') ?? 'image/jpeg',
            panoId: meta.pano_id,
            date: meta.date,
            location: meta.location,
            copyright: meta.copyright
        };
    }
}
