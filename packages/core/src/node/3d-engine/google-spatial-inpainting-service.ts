/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { GoogleGenAI, Type, type Schema } from '@google/genai';

export interface GroundPlaneSpecification {
    elevationMeters: number;
    slopeDegrees: number;
    walkableAreaRatio: number;
}

export interface ForegroundSilhouetteSpecification {
    label: string;
    boundingBoxNormalized: [number, number, number, number]; // [ymin, xmin, ymax, xmax] in 0..1
    estimatedDepthMeters: number;
    occludedBackgroundClass: string;
}

export interface BoxColliderSpecification {
    name: string;
    center: [number, number, number]; // [x, y, z] in metric meters
    extents: [number, number, number]; // half-widths [halfX, halfY, halfZ]
    isWalkableObstacle: boolean;
}

export interface OccludedBackgroundPrior {
    dominantEnvironment: string;
    ambientIlluminationLux: number;
    horizonRelativeY: number;
    infilledAtmosphereColor: [number, number, number]; // [r, g, b] in 0..1
}

export interface SpatialSceneDeconstruction {
    groundPlane: GroundPlaneSpecification;
    foregroundSilhouettes: ForegroundSilhouetteSpecification[];
    boxColliders: BoxColliderSpecification[];
    backgroundPrior: OccludedBackgroundPrior;
    source: 'google-genai' | 'heuristic-fallback';
}

const spatialDeconstructionSchema: Schema = {
    type: Type.OBJECT,
    properties: {
        groundPlane: {
            type: Type.OBJECT,
            properties: {
                elevationMeters: { type: Type.NUMBER, description: 'Ground elevation relative to camera in meters (typically -1.0 to -2.0m)' },
                slopeDegrees: { type: Type.NUMBER, description: 'Ground slope angle in degrees' },
                walkableAreaRatio: { type: Type.NUMBER, description: 'Fraction of foreground area that is walkable floor (0.0 to 1.0)' }
            },
            required: ['elevationMeters', 'slopeDegrees', 'walkableAreaRatio']
        },
        foregroundSilhouettes: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    label: { type: Type.STRING, description: 'Object label (e.g. column, building, tree, car)' },
                    boundingBoxNormalized: {
                        type: Type.ARRAY,
                        items: { type: Type.NUMBER },
                        description: '[ymin, xmin, ymax, xmax] in range 0.0 to 1.0'
                    },
                    estimatedDepthMeters: { type: Type.NUMBER, description: 'Estimated metric depth distance from camera in meters' },
                    occludedBackgroundClass: { type: Type.STRING, description: 'Predicted background behind this object (e.g. sky, wall, distant skyline)' }
                },
                required: ['label', 'boundingBoxNormalized', 'estimatedDepthMeters', 'occludedBackgroundClass']
            }
        },
        boxColliders: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING },
                    center: {
                        type: Type.ARRAY,
                        items: { type: Type.NUMBER },
                        description: '[x, y, z] 3D position in meters'
                    },
                    extents: {
                        type: Type.ARRAY,
                        items: { type: Type.NUMBER },
                        description: '[halfX, halfY, halfZ] dimensions in meters'
                    },
                    isWalkableObstacle: { type: Type.BOOLEAN }
                },
                required: ['name', 'center', 'extents', 'isWalkableObstacle']
            }
        },
        backgroundPrior: {
            type: Type.OBJECT,
            properties: {
                dominantEnvironment: { type: Type.STRING, description: 'e.g. urban, nature, indoor, alpine, coastal' },
                ambientIlluminationLux: { type: Type.NUMBER, description: 'Estimated ambient lighting in lux' },
                horizonRelativeY: { type: Type.NUMBER, description: 'Horizon line location in normalized coordinates (0.0 top, 1.0 bottom)' },
                infilledAtmosphereColor: {
                    type: Type.ARRAY,
                    items: { type: Type.NUMBER },
                    description: '[r, g, b] normalized color for inpainting atmospheric haze'
                }
            },
            required: ['dominantEnvironment', 'ambientIlluminationLux', 'horizonRelativeY', 'infilledAtmosphereColor']
        }
    },
    required: ['groundPlane', 'foregroundSilhouettes', 'boxColliders', 'backgroundPrior']
};

export class GoogleSpatialInpaintingService {
    private client?: GoogleGenAI;

    constructor(apiKey?: string) {
        const key = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (key) {
            this.client = new GoogleGenAI({ apiKey: key });
        }
    }

    /**
     * Deconstructs a 2D scene into 3D physics colliders, ground planes, and
     * occluded background hallucination priors using Google Gemini AI or robust heuristic.
     */
    async deconstructScene(params: {
        prompt?: string;
        base64Image?: string;
        mimeType?: string;
        imageWidth?: number;
        imageHeight?: number;
        fovDegrees?: number;
    }): Promise<SpatialSceneDeconstruction> {
        if (!this.client) {
            return this.deconstructSceneHeuristic(params);
        }

        try {
            const systemInstruction = `You are an expert Computer Vision and 3D Generative AI spatial architect.
Your task is to analyze an input image or scene description, segment foreground silhouettes that cause occlusion voids in 3D Gaussian Splatting, compute metric bounding boxes for physics colliders, and predict the continuous background surface hidden behind foreground objects.

Format all spatial quantities in standard metric units:
- Ground level should normally be between -1.4m and -1.8m relative to camera eye height.
- Obstacle bounding boxes must enclose foreground monolithic structures so that simulated walking physics or robotics colliders will not penetrate walls.
- Provide background priors to guide generative inpainting behind occluded silhouettes.`;

            const contents: any[] = [];
            if (params.base64Image) {
                contents.push({
                    inlineData: {
                        mimeType: params.mimeType || 'image/jpeg',
                        data: params.base64Image
                    }
                });
            }

            const promptText = params.prompt
                ? `Analyze the spatial geometry, depth silhouettes, and physics colliders for this scene: "${params.prompt}"`
                : 'Analyze the spatial geometry, depth silhouettes, and physics colliders for this scene.';

            contents.push(promptText);

            const response = await this.client.models.generateContent({
                model: 'gemini-2.5-flash',
                contents,
                config: {
                    systemInstruction,
                    responseMimeType: 'application/json',
                    responseSchema: spatialDeconstructionSchema,
                    temperature: 0.15
                }
            });

            const text = response.text || '{}';
            const parsed = JSON.parse(text) as SpatialSceneDeconstruction;

            if (parsed && parsed.groundPlane && parsed.boxColliders && parsed.backgroundPrior) {
                parsed.source = 'google-genai';
                return parsed;
            }
        } catch (err) {
            console.warn('[GoogleSpatialInpaintingService] Gemini inference failed, using heuristic fallback:', err);
        }

        return this.deconstructSceneHeuristic(params);
    }

    /**
     * High-speed deterministic geometric heuristic for offline testing or instant fallback.
     */
    deconstructSceneHeuristic(params: {
        prompt?: string;
        imageWidth?: number;
        imageHeight?: number;
        fovDegrees?: number;
    }): SpatialSceneDeconstruction {
        const isUrban = !params.prompt || /city|street|building|shibuya|manhattan|plaza|colonnade|temple/i.test(params.prompt);

        return {
            source: 'heuristic-fallback',
            groundPlane: {
                elevationMeters: -1.65,
                slopeDegrees: 0.0,
                walkableAreaRatio: 0.72
            },
            foregroundSilhouettes: [
                {
                    label: isUrban ? 'left_monolith_facade' : 'left_terrain_promontory',
                    boundingBoxNormalized: [0.15, 0.0, 0.85, 0.35],
                    estimatedDepthMeters: 14.5,
                    occludedBackgroundClass: isUrban ? 'distant_skyline' : 'background_mountains'
                },
                {
                    label: isUrban ? 'right_monolith_facade' : 'right_terrain_promontory',
                    boundingBoxNormalized: [0.15, 0.65, 0.85, 1.0],
                    estimatedDepthMeters: 15.2,
                    occludedBackgroundClass: isUrban ? 'distant_skyline' : 'background_mountains'
                },
                {
                    label: isUrban ? 'center_colonnade_arch' : 'center_boulder_formation',
                    boundingBoxNormalized: [0.25, 0.35, 0.75, 0.65],
                    estimatedDepthMeters: 18.0,
                    occludedBackgroundClass: 'open_sky'
                }
            ],
            boxColliders: [
                {
                    name: 'collider_left_wall',
                    center: [-5.5, 1.2, -14.0],
                    extents: [2.5, 4.0, 6.0],
                    isWalkableObstacle: true
                },
                {
                    name: 'collider_right_wall',
                    center: [5.8, 1.2, -14.5],
                    extents: [2.5, 4.0, 6.0],
                    isWalkableObstacle: true
                },
                {
                    name: 'collider_center_feature',
                    center: [0.0, 0.8, -19.0],
                    extents: [3.2, 3.5, 2.0],
                    isWalkableObstacle: true
                }
            ],
            backgroundPrior: {
                dominantEnvironment: isUrban ? 'urban_architectural' : 'natural_landscape',
                ambientIlluminationLux: 10500,
                horizonRelativeY: 0.42,
                infilledAtmosphereColor: isUrban ? [0.68, 0.76, 0.88] : [0.55, 0.72, 0.92]
            }
        };
    }
}
