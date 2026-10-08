/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { GoogleAuth } from 'google-auth-library';
import {
    fetchStreetViewPanoMetadata,
    fetchStreetViewCubicFaces,
    projectCubicFacesToErpBuffer,
    DEFAULT_GOOGLE_MAPS_API_KEY,
    StreetViewPanoMetadata,
    ProjectedErpResult
} from './StreetViewPanoramaProjectionService';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';

export interface MapsImageryGroundingQuery {
    /** Natural language prompt describing the vantage point or landmark (e.g. "Times Square looking south", "Colosseum facade"). */
    prompt?: string;
    /** Direct Google Street View / MIG Pano ID if already known (bypasses LLM lookup). */
    panoId?: string;
    /** Geodetic latitude. */
    lat?: number;
    /** Geodetic longitude. */
    lng?: number;
    /** Search radius in meters if coordinates provided (default 250). */
    radiusMeters?: number;
    /** Target face size for downloaded Street View cubic perspectives (default 1024). */
    faceSize?: number;
    /** Field of view in degrees per face (default 100). */
    fovDegrees?: number;
    /** ERP canvas width (default 2048). */
    canvasWidth?: number;
    /** ERP canvas height (default 1024). */
    canvasHeight?: number;
    /** Optional custom output file path on disk. */
    outputPath?: string;
    /** Optional Google Maps Platform API key. */
    apiKey?: string;
    /** Optional custom fetch implementation. */
    fetchImpl?: typeof fetch;
}

export interface MapsImageryChunk {
    panoId: string;
    captureDate?: string;
    uri?: string;
    latLng?: {
        latitude: number;
        longitude: number;
    };
    heading?: number;
    pitch?: number;
    roll?: number;
}

export interface MapsImageryGroundingResult {
    success: boolean;
    panoId: string;
    prompt?: string;
    captureDate?: string;
    year?: number;
    month?: number;
    lat: number;
    lng: number;
    copyright?: string;
    erpUrl?: string;
    erpPath?: string;
    erpWidth?: number;
    erpHeight?: number;
    status: string;
    embedUrl?: string;
    groundingChunks?: MapsImageryChunk[];
    error?: string;
}

/**
 * Service orchestrating Google Maps Imagery Grounding (MIG) on Vertex AI
 * and projecting Street View panoramas via PanoID for 360 abilities.
 */
export class MapsImageryGroundingService {
    /**
     * Resolves Google Maps API key from options, environment, or default fallback.
     */
    public static resolveApiKey(explicitKey?: string): string {
        return (
            explicitKey ||
            process.env.GOOGLE_MAPS_API_KEY ||
            process.env.MAP_TILES_API_KEY ||
            DEFAULT_GOOGLE_MAPS_API_KEY
        );
    }

    /**
     * Queries Vertex AI Gemini with Maps Imagery Grounding (MIG) tool definition
     * (`tools: [{ googleMaps: { groundingTypes: { streetviewImagery: {} } } }]`).
     */
    public static async queryVertexMapsImagery(
        prompt: string,
        options: {
            projectId?: string;
            location?: string;
            model?: string;
            fetchImpl?: typeof fetch;
        } = {}
    ): Promise<{
        text: string;
        groundingChunks: MapsImageryChunk[];
    }> {
        const fetchImpl = options.fetchImpl || fetch;
        const location = options.location || process.env.SCRATCHBOX_VERTEX_LOCATION || 'global';
        const model = options.model || 'gemini-3.1-flash-image';
        let projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT;
        if (!projectId) {
            try {
                const credService = new GoogleMediaCredentialsService();
                const authInfo = await credService.getVertexAuth();
                projectId = authInfo.project;
            } catch {
                projectId = 'scratchbox-ai';
            }
        }
        if (!projectId) {
            projectId = 'scratchbox-ai';
        }

        const payload = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: prompt }]
                }
            ],
            tools: [
                {
                    googleMaps: {
                        groundingTypes: {
                            streetviewImagery: {}
                        }
                    }
                }
            ],
            generationConfig: {
                temperature: 0.2
            }
        };

        const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
        const url = `https://${host}/v1beta1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

        const auth = new GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const client = await auth.getClient().catch(() => null);
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };

        if (client) {
            const tokenResponse = await client.getAccessToken().catch(() => null);
            if (tokenResponse?.token) {
                headers['Authorization'] = `Bearer ${tokenResponse.token}`;
            }
        }

        const res = await fetchImpl(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Vertex AI Maps Imagery Grounding error (${res.status}): ${errText}`);
        }

        const data = (await res.json()) as any;
        const candidate = data.candidates?.[0];
        const text = candidate?.content?.parts?.map((p: any) => p.text).filter(Boolean).join('\n') || '';

        const groundingChunks: MapsImageryChunk[] = [];
        const rawChunks = candidate?.groundingMetadata?.groundingChunks || candidate?.grounding_metadata?.grounding_chunks || [];

        for (const chunk of rawChunks) {
            const mi = chunk.mapsImagery || chunk.maps_imagery || chunk.streetviewImagery || chunk.streetview_imagery;
            if (mi) {
                groundingChunks.push({
                    panoId: mi.panoId || mi.pano_id || '',
                    captureDate: mi.captureDate || mi.capture_date,
                    uri: mi.uri,
                    latLng: mi.latLng || mi.lat_lng ? {
                        latitude: mi.latLng?.latitude ?? mi.lat_lng?.latitude ?? 0,
                        longitude: mi.latLng?.longitude ?? mi.lat_lng?.longitude ?? 0
                    } : undefined,
                    heading: mi.heading,
                    pitch: mi.pitch,
                    roll: mi.roll
                });
            }
        }

        return { text, groundingChunks };
    }

    /**
     * End-to-end: Accepts a prompt or direct panoId, queries Maps Imagery Grounding (MIG)
     * if necessary, downloads Street View cubic faces, and projects them onto an equirectangular
     * 360 panorama canvas for showcase demos and viewers.
     */
    public static async groundAndProjectStreetViewPanorama(
        query: MapsImageryGroundingQuery
    ): Promise<MapsImageryGroundingResult> {
        const apiKey = this.resolveApiKey(query.apiKey);
        const fetchImpl = query.fetchImpl || fetch;
        let panoId = query.panoId?.trim();
        let groundingChunks: MapsImageryChunk[] = [];

        // 1. If no panoId, resolve via Maps Imagery Grounding or Street View metadata
        if (!panoId) {
            if (query.prompt) {
                try {
                    const migResult = await this.queryVertexMapsImagery(query.prompt, { fetchImpl });
                    groundingChunks = migResult.groundingChunks;
                    const firstChunk = groundingChunks.find(c => c.panoId && c.panoId.length > 5);
                    if (firstChunk?.panoId) {
                        panoId = firstChunk.panoId;
                    }
                } catch (err: any) {
                    console.warn(`[MapsImageryGroundingService] MIG Vertex AI query failed, falling back to geocoding / metadata: ${err?.message}`);
                }
            }

            // Fallback: If still no panoId and we have lat/lng or prompt coordinates
            if (!panoId) {
                let lat = query.lat;
                let lng = query.lng;

                if ((lat === undefined || lng === undefined) && query.prompt) {
                    const coordMatch = query.prompt.match(/^(-?\d+(\.\d+)?)[,\s]+(-?\d+(\.\d+)?)$/);
                    if (coordMatch) {
                        lat = parseFloat(coordMatch[1]);
                        lng = parseFloat(coordMatch[3]);
                    }
                }

                if (lat !== undefined && lng !== undefined) {
                    const meta = await fetchStreetViewPanoMetadata({
                        lat,
                        lng,
                        radiusMeters: query.radiusMeters ?? 250,
                        apiKey,
                        fetchImpl
                    });
                    panoId = meta.panoId;
                }
            }
        }

        // If still no panoId, default to iconic Shibuya Crossing
        if (!panoId) {
            panoId = 'CAoSF0NJSE0wb2dLRUlDQWdJRHE4NkMtbXdF'; // Shibuya Crossing default
        }

        // 2. Fetch Street View metadata and 4/6 cubic perspective faces
        const { metadata, faces } = await fetchStreetViewCubicFaces({
            panoId,
            apiKey,
            faceSize: query.faceSize ?? 1024,
            fovDegrees: query.fovDegrees ?? 100,
            includePoles: false,
            fetchImpl
        });

        // 3. Project cubic faces into 2:1 ERP equirectangular canvas
        const canvasWidth = query.canvasWidth ?? 2048;
        const canvasHeight = query.canvasHeight ?? 1024;
        const erpResult: ProjectedErpResult = projectCubicFacesToErpBuffer(faces, {
            canvasWidth,
            canvasHeight,
            fovDegrees: query.fovDegrees ?? 100,
            fillMode: 'seamless'
        });

        // 4. Save projected ERP to disk
        const cleanPanoId = metadata.panoId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const defaultOutDir = path.resolve(process.cwd(), 'public/panoramas');
        await fs.mkdirp(defaultOutDir);

        const outPath = query.outputPath || path.resolve(defaultOutDir, `sv_${cleanPanoId}.png`);
        await fs.writeFile(outPath, erpResult.png);

        const relativeUrl = `/panoramas/sv_${cleanPanoId}.png`;
        const embedUrl = `https://www.google.com/maps/embed/v1/streetview?key=${apiKey}&pano=${encodeURIComponent(
            metadata.panoId
        )}&heading=0&pitch=0&fov=90`;

        return {
            success: true,
            panoId: metadata.panoId,
            prompt: query.prompt,
            captureDate: metadata.date,
            year: metadata.year,
            month: metadata.month,
            lat: metadata.lat,
            lng: metadata.lng,
            copyright: metadata.copyright,
            erpUrl: relativeUrl,
            erpPath: outPath,
            erpWidth: erpResult.width,
            erpHeight: erpResult.height,
            status: metadata.status || 'OK',
            embedUrl,
            groundingChunks: groundingChunks.length > 0 ? groundingChunks : undefined
        };
    }
}
