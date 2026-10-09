/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Humanoid Avatar & Multi-Modality Skinning Protocol.
 *
 * Decouples the 22-joint SB-Human kinematic and morphological substrate from the
 * surface rendering / rasterization modality. 4DGS, 3DGS, PBR polygonal mesh,
 * 2D planar surfels, and volumetric grooms are treated as pluggable skinning adapters
 * driven by identical joint matrices G_j(t) and partition-of-unity skin weights.
 */

export type HumanoidSkinModality =
    | 'pbr-standard'
    | 'pbr-video-projected'
    | 'pbr-melanin'
    | '4dgs-radiance'
    | '2dgs-planar-surfel'
    | 'hybrid-pbr-hair-groom'
    | (string & {});

export interface HumanoidActorMetadata {
    actorId: string;
    name: string;
    sourceType: 'performer-demo' | 'sbhuman-model' | 'synthetic' | (string & {});
    gender?: 'neutral' | 'male' | 'female' | (string & {});
    heightMeters?: number;
    frameCount?: number;
    fps?: number;
    durationSeconds?: number;
    hasSkeletalMotion: boolean;
    availableModalities: HumanoidSkinModality[];
    canonicalJoints: Array<[number, number, number]>;
    jointNames: readonly string[];
    jointParents: number[];
    bounds?: {
        min: [number, number, number];
        max: [number, number, number];
    };
    paths: {
        baseDir?: string;
        plyPath?: string;
        splatPath?: string;
        glbPath?: string;
        motionPath?: string;
        bodyJsonPath?: string;
        sbhumanPath?: string;
    };
}

export interface SkinFrameResult {
    frameIndex: number;
    modality: HumanoidSkinModality;
    vertexCount?: number;
    gaussianCount?: number;
    positions?: Float32Array;
    normals?: Float32Array;
    colors?: Float32Array;
    splatBuffer?: Uint8Array;
}

export interface SkinExportOptions {
    modality?: HumanoidSkinModality;
    format?: 'glb' | 'splat' | 'ply' | 'spz' | (string & {});
    frameIndex?: number;
    subdivisionLevels?: number;
    includeSkin?: boolean;
    melaninFraction?: number;
    pheomelaninRatio?: number;
    roughness?: number;
    metalness?: number;
}

/**
 * Pluggable skinning modality adapter interface.
 */
export interface ISbHumanSkinAdapter {
    readonly modality: HumanoidSkinModality;
    readonly actorId: string;
    isAvailable(): Promise<boolean> | boolean;
    evaluateFrame(frameIndex: number, jointTransforms?: any[]): Promise<SkinFrameResult> | SkinFrameResult;
    exportArtifact(options?: SkinExportOptions): Promise<Buffer | Uint8Array>;
}

/**
 * Analytical forward mapping from biophysical melanin concentration to linear PBR baseColor RGB.
 * Melanin fraction f_mel in [0, 1]: 0 = very light/pale, 1 = deep dark complexion.
 * Pheomelanin ratio rho_pheo in [0, 1]: 0 = pure eumelanin (black/brown), 1 = pure pheomelanin (red/warm).
 */
export function computeMelaninAlbedo(
    melaninFraction: number = 0.35,
    pheomelaninRatio: number = 0.2
): [number, number, number, number] {
    const f = Math.max(0.0, Math.min(1.0, melaninFraction));
    const p = Math.max(0.0, Math.min(1.0, pheomelaninRatio));

    // Base dermal albedo before melanin absorption (epidermal scatter reflectance)
    const baseR = 0.82;
    const baseG = 0.62;
    const baseB = 0.52;

    // Spectral absorption factors for eumelanin (neutral-brown) and pheomelanin (reddish-yellow)
    const euAbsorption = [1.8, 3.2, 5.5];
    const phAbsorption = [0.8, 2.4, 6.2];

    const effAbsR = (1 - p) * euAbsorption[0] + p * phAbsorption[0];
    const effAbsG = (1 - p) * euAbsorption[1] + p * phAbsorption[1];
    const effAbsB = (1 - p) * euAbsorption[2] + p * phAbsorption[2];

    const r = baseR * Math.exp(-f * effAbsR);
    const g = baseG * Math.exp(-f * effAbsG);
    const b = baseB * Math.exp(-f * effAbsB);

    return [
        Math.max(0.02, Math.min(1.0, r)),
        Math.max(0.015, Math.min(1.0, g)),
        Math.max(0.01, Math.min(1.0, b)),
        1.0
    ];
}
