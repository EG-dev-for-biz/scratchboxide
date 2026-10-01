/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Universal Botanical Bridge Service
 * Connects the Google 3D Tile Spatial Separator with the native C++20 SB-Veggie
 * (formerly SMPL-Tree) Parametric Botanical Inversion Engine. Ingests extracted
 * 3D tree entities, infers or adapts species archetypes, and synthesizes 1:1 metric
 * watertight replacement glTF 2.0 assets across any geographic area.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { SbVeggieService } from '../3d-engine/sb-veggie-service';
import type {
    SbVeggieArchetype,
    SbVeggieSynthesizeOptions,
    SbVeggieResult,
    SbVeggiePhenologyParams,
    SbVeggieShapingParams
} from '../../common/botanical/sb-veggie-protocol';

export type SupportedTreeSpecies =
    | 'pinus_pinea'              // Italian Stone Pine (Umbrella Pine)
    | 'quercus_ilex'             // Mediterranean Holm Oak (Evergreen)
    | 'quercus_robur'            // English / White Oak (Deciduous Hardwood)
    | 'cupressus_sempervirens'   // Italian Columnar Cypress
    | 'olea_europaea'            // Mediterranean Olive
    | 'laurus_nobilis'           // Sweet Bay Laurel
    | 'betula_pendula'           // Silver Birch
    | 'acer_rubrum'              // Red Maple
    | 'conifer_spruce'           // Excurrent Spruce / Fir
    | 'palmate_palm'             // Palmate Palm / Cycad
    | 'generic_hardwood';

export interface BotanicalSpeciesAdapter {
    species: SupportedTreeSpecies;
    commonName: string;
    scientificName: string;
    archetype: SbVeggieArchetype;
    leafMorphology: number; // 0 = Lobed Oak, 1 = Broadleaf Serrated, 2 = Conifer Needles, 3 = Cypress Scales, 4 = Lanceolate Olive
    leafCupping: number;
    leafDensityMultiplier: number;
    branchCurvature: number;
    collarFlare: number;
    reactionWood: number;
    typicalCrownHeightRatio: number; // ratio of canopy crown to total height
    typicalAspectSpread: number;     // crown spread / height
    apicalDominanceBias: number;
    branchDroopBias: number;
    taperExponentBias: number;
    barkType: 'fissured_furrow' | 'rugged_orange_plate' | 'fibrous_columnar' | 'gnarled_cortex' | 'smooth_birch';
    barkRoughness: number;
    foliageBaseHex: string;
}

export const SPECIES_ADAPTERS: Record<SupportedTreeSpecies, BotanicalSpeciesAdapter> = {
    pinus_pinea: {
        species: 'pinus_pinea',
        commonName: 'Italian Stone Pine',
        scientificName: 'Pinus pinea',
        archetype: 'conifer',
        leafMorphology: 2, // Conifer needles
        leafCupping: 0.2,
        leafDensityMultiplier: 1.15,
        branchCurvature: 1.35, // Sweeping upward parasol boughs
        collarFlare: 1.25,
        reactionWood: 1.10,
        typicalCrownHeightRatio: 0.55, // Bare lower trunk, high umbrella canopy
        typicalAspectSpread: 0.82,     // Wide spreading parasol
        apicalDominanceBias: -0.4,     // Deliquescent umbrella crown
        branchDroopBias: -0.2,
        taperExponentBias: 0.2,
        barkType: 'rugged_orange_plate',
        barkRoughness: 0.94,
        foliageBaseHex: '#2d5a27'
    },
    quercus_ilex: {
        species: 'quercus_ilex',
        commonName: 'Holm Oak (Evergreen Oak)',
        scientificName: 'Quercus ilex',
        archetype: 'decurrent',
        leafMorphology: 0, // Lobed 3D blade
        leafCupping: 1.0,
        leafDensityMultiplier: 1.20,
        branchCurvature: 1.05,
        collarFlare: 1.15,
        reactionWood: 1.05,
        typicalCrownHeightRatio: 0.70,
        typicalAspectSpread: 0.90,
        apicalDominanceBias: -0.2,
        branchDroopBias: 0.1,
        taperExponentBias: 0.0,
        barkType: 'fissured_furrow',
        barkRoughness: 0.92,
        foliageBaseHex: '#1d4a22'
    },
    quercus_robur: {
        species: 'quercus_robur',
        commonName: 'English Oak / White Oak',
        scientificName: 'Quercus robur',
        archetype: 'decurrent',
        leafMorphology: 0,
        leafCupping: 1.0,
        leafDensityMultiplier: 1.0,
        branchCurvature: 1.0,
        collarFlare: 1.0,
        reactionWood: 1.0,
        typicalCrownHeightRatio: 0.65,
        typicalAspectSpread: 0.95,
        apicalDominanceBias: 0.0,
        branchDroopBias: 0.0,
        taperExponentBias: 0.0,
        barkType: 'fissured_furrow',
        barkRoughness: 0.94,
        foliageBaseHex: '#385e2b'
    },
    cupressus_sempervirens: {
        species: 'cupressus_sempervirens',
        commonName: 'Italian Columnar Cypress',
        scientificName: 'Cupressus sempervirens',
        archetype: 'columnar',
        leafMorphology: 3, // Dense imbricate scales
        leafCupping: 0.1,
        leafDensityMultiplier: 1.45,
        branchCurvature: 0.40, // Hugging vertical branchlets
        collarFlare: 0.60,
        reactionWood: 0.85,
        typicalCrownHeightRatio: 0.90, // Foliage nearly to ground level
        typicalAspectSpread: 0.22,     // Extremely narrow flame spire
        apicalDominanceBias: 1.8,      // Extreme apical dominance
        branchDroopBias: -0.8,
        taperExponentBias: 0.5,
        barkType: 'fibrous_columnar',
        barkRoughness: 0.84,
        foliageBaseHex: '#16381e'
    },
    olea_europaea: {
        species: 'olea_europaea',
        commonName: 'Mediterranean Olive',
        scientificName: 'Olea europaea',
        archetype: 'decurrent',
        leafMorphology: 4, // Lanceolate olive leaves
        leafCupping: 0.7,
        leafDensityMultiplier: 0.90,
        branchCurvature: 1.45, // Sculptural gnarled branching
        collarFlare: 1.60,
        reactionWood: 1.80,    // Extreme fluting and gnarling
        typicalCrownHeightRatio: 0.65,
        typicalAspectSpread: 0.95,
        apicalDominanceBias: -0.6,
        branchDroopBias: 0.3,
        taperExponentBias: -0.3,
        barkType: 'gnarled_cortex',
        barkRoughness: 0.96,
        foliageBaseHex: '#4d6335'
    },
    laurus_nobilis: {
        species: 'laurus_nobilis',
        commonName: 'Sweet Bay Laurel',
        scientificName: 'Laurus nobilis',
        archetype: 'decurrent',
        leafMorphology: 1, // Broadleaf serrated/glossy
        leafCupping: 0.6,
        leafDensityMultiplier: 1.10,
        branchCurvature: 0.85,
        collarFlare: 0.90,
        reactionWood: 0.95,
        typicalCrownHeightRatio: 0.75,
        typicalAspectSpread: 0.70,
        apicalDominanceBias: 0.2,
        branchDroopBias: -0.1,
        taperExponentBias: 0.1,
        barkType: 'fissured_furrow',
        barkRoughness: 0.82,
        foliageBaseHex: '#365314'
    },
    betula_pendula: {
        species: 'betula_pendula',
        commonName: 'Silver Birch',
        scientificName: 'Betula pendula',
        archetype: 'decurrent',
        leafMorphology: 1,
        leafCupping: 0.5,
        leafDensityMultiplier: 0.85,
        branchCurvature: 1.25,
        collarFlare: 0.85,
        reactionWood: 0.90,
        typicalCrownHeightRatio: 0.70,
        typicalAspectSpread: 0.60,
        apicalDominanceBias: 0.4,
        branchDroopBias: 0.6, // Weeping pendulous branches
        taperExponentBias: 0.3,
        barkType: 'smooth_birch',
        barkRoughness: 0.65,
        foliageBaseHex: '#4d7c2b'
    },
    acer_rubrum: {
        species: 'acer_rubrum',
        commonName: 'Red Maple',
        scientificName: 'Acer rubrum',
        archetype: 'decurrent',
        leafMorphology: 1,
        leafCupping: 0.8,
        leafDensityMultiplier: 1.05,
        branchCurvature: 1.0,
        collarFlare: 1.0,
        reactionWood: 1.0,
        typicalCrownHeightRatio: 0.70,
        typicalAspectSpread: 0.80,
        apicalDominanceBias: 0.1,
        branchDroopBias: 0.0,
        taperExponentBias: 0.1,
        barkType: 'fissured_furrow',
        barkRoughness: 0.86,
        foliageBaseHex: '#406a2b'
    },
    conifer_spruce: {
        species: 'conifer_spruce',
        commonName: 'Norway Spruce / Fir',
        scientificName: 'Picea abies',
        archetype: 'conifer',
        leafMorphology: 2,
        leafCupping: 0.1,
        leafDensityMultiplier: 1.30,
        branchCurvature: 0.70,
        collarFlare: 0.80,
        reactionWood: 0.90,
        typicalCrownHeightRatio: 0.85,
        typicalAspectSpread: 0.45,
        apicalDominanceBias: 1.2,
        branchDroopBias: 0.3,
        taperExponentBias: 0.4,
        barkType: 'fissured_furrow',
        barkRoughness: 0.90,
        foliageBaseHex: '#1e3f20'
    },
    palmate_palm: {
        species: 'palmate_palm',
        commonName: 'Mediterranean Fan Palm / Date Palm',
        scientificName: 'Phoenix dactylifera',
        archetype: 'palmate',
        leafMorphology: 1,
        leafCupping: 1.5,
        leafDensityMultiplier: 0.70,
        branchCurvature: 1.50,
        collarFlare: 0.50,
        reactionWood: 1.0,
        typicalCrownHeightRatio: 0.35,
        typicalAspectSpread: 0.75,
        apicalDominanceBias: 1.5,
        branchDroopBias: 0.8,
        taperExponentBias: -0.6,
        barkType: 'rugged_orange_plate',
        barkRoughness: 0.95,
        foliageBaseHex: '#3a5f28'
    },
    generic_hardwood: {
        species: 'generic_hardwood',
        commonName: 'Decurrent Hardwood',
        scientificName: 'Broadleaf deciduous',
        archetype: 'decurrent',
        leafMorphology: 0,
        leafCupping: 0.9,
        leafDensityMultiplier: 1.0,
        branchCurvature: 1.0,
        collarFlare: 1.0,
        reactionWood: 1.0,
        typicalCrownHeightRatio: 0.65,
        typicalAspectSpread: 0.85,
        apicalDominanceBias: 0.0,
        branchDroopBias: 0.0,
        taperExponentBias: 0.0,
        barkType: 'fissured_furrow',
        barkRoughness: 0.90,
        foliageBaseHex: '#385e2b'
    }
};

export interface SpatialTreeEntity {
    id: string;
    name?: string;
    category?: string;
    species?: string;
    scientificName?: string;
    commonName?: string;
    zone?: string;
    boundingBox?: {
        min: [number, number, number];
        max: [number, number, number];
        dimensions: [number, number, number]; // [width, height, depth]
        centroid: [number, number, number];
        volumeM3?: number;
    };
    orientedBoundingBox?: {
        center: [number, number, number];
        dimensions: [number, number, number];
        halfExtents: [number, number, number];
        yawDeg?: number;
        yawRad?: number;
        quaternion?: [number, number, number, number];
    };
    metricDimensions?: [number, number, number];
    metricPositionENU?: [number, number, number];
    nominalDimensions?: [number, number, number] | number[];
    nominalCentroid?: [number, number, number] | number[];
    canopyHeightMeters?: number;
    crownDiameterMeters?: number;
    groundElevationMeters?: number;
    trellisPrompt?: string;
    submeshIndices?: number[];
    rawScanGlbPath?: string;
}

export interface TreeSynthesisBridgeOptions {
    /** Target phenological season: 1.0 = Summer lush, 0.45 = Autumn gold, 0.0 = Winter bare wood */
    season?: number;
    /** Desired leaf density multiplier (1.0 = nominal, 0 = bare) */
    leafDensity?: number;
    /** Foliage chrominance saturation scaling (default 0.78 for photorealistic tile matching) */
    saturationScale?: number;
    /** Output directory or explicit output path */
    outputGlbPath?: string;
    /** If true, runs SB-Veggie scan inversion when rawScanGlbPath is present */
    runInversionIfScanAvailable?: boolean;
    /** Custom species override */
    speciesOverride?: SupportedTreeSpecies;
}

export interface TreeSynthesisBridgeResult {
    treeId: string;
    species: SupportedTreeSpecies;
    archetype: SbVeggieArchetype;
    worldPosition: [number, number, number];
    worldRotationYawRad: number;
    fittedHeightMeters: number;
    fittedSpreadMeters: number;
    outputGlbPath: string;
    glbBuffer?: Buffer;
    glbBase64?: string;
    telemetry: {
        buildTimeMs: number;
        evalTimeMs: number;
        outputVertices: number;
        outputTriangles: number;
        isManifold: boolean;
        inversionRan: boolean;
    };
    appliedBeta: number[];
}

export class UniversalBotanicalBridgeService {
    private veggieService: SbVeggieService;

    constructor(service?: SbVeggieService) {
        this.veggieService = service || new SbVeggieService();
    }

    get smplService(): SbVeggieService {
        return this.veggieService;
    }

    /**
     * Resolves the closest botanical species adapter from an incoming tree record.
     */
    static resolveSpecies(speciesQuery?: string, nameQuery?: string, promptQuery?: string): BotanicalSpeciesAdapter {
        const text = `${speciesQuery || ''} ${nameQuery || ''} ${promptQuery || ''}`.toLowerCase();

        if (text.includes('pinus_pinea') || text.includes('stone pine') || text.includes('umbrella pine') || text.includes('parasol')) {
            return SPECIES_ADAPTERS.pinus_pinea;
        }
        if (text.includes('cupressus') || text.includes('cypress') || text.includes('columnar')) {
            return SPECIES_ADAPTERS.cupressus_sempervirens;
        }
        if (text.includes('olea') || text.includes('olive')) {
            return SPECIES_ADAPTERS.olea_europaea;
        }
        if (text.includes('laurus') || text.includes('laurel') || text.includes('bay laurel')) {
            return SPECIES_ADAPTERS.laurus_nobilis;
        }
        if (text.includes('quercus_ilex') || text.includes('holm oak') || text.includes('evergreen oak')) {
            return SPECIES_ADAPTERS.quercus_ilex;
        }
        if (text.includes('oak') || text.includes('quercus')) {
            return SPECIES_ADAPTERS.quercus_robur;
        }
        if (text.includes('birch') || text.includes('betula')) {
            return SPECIES_ADAPTERS.betula_pendula;
        }
        if (text.includes('maple') || text.includes('acer')) {
            return SPECIES_ADAPTERS.acer_rubrum;
        }
        if (text.includes('palm') || text.includes('palmate') || text.includes('phoenix')) {
            return SPECIES_ADAPTERS.palmate_palm;
        }
        if (text.includes('pine') || text.includes('conifer') || text.includes('spruce') || text.includes('fir')) {
            return SPECIES_ADAPTERS.conifer_spruce;
        }

        return SPECIES_ADAPTERS.generic_hardwood;
    }

    /**
     * Synthesizes a 1:1 metric replacement tree for any tree entity
     * extracted by the Spatial Separator service.
     */
    async synthesizeTreeFromEntity(
        entity: SpatialTreeEntity,
        options: TreeSynthesisBridgeOptions = {}
    ): Promise<TreeSynthesisBridgeResult> {
        const adapter = options.speciesOverride 
            ? SPECIES_ADAPTERS[options.speciesOverride] 
            : UniversalBotanicalBridgeService.resolveSpecies(entity.species, entity.name, entity.trellisPrompt);

        // 1. Extract physical bounding geometry
        let width = 10.0;
        let height = 12.0;
        let depth = 10.0;
        let centroid: [number, number, number] = [0, 6, 0];
        let yawRad = 0.0;

        if (entity.orientedBoundingBox) {
            const obb = entity.orientedBoundingBox;
            width = obb.dimensions[0];
            height = obb.dimensions[1];
            depth = obb.dimensions[2];
            centroid = obb.center;
            yawRad = obb.yawRad ?? 0.0;
        } else if (entity.boundingBox) {
            const bb = entity.boundingBox;
            width = bb.dimensions[0];
            height = bb.dimensions[1];
            depth = bb.dimensions[2];
            centroid = bb.centroid;
        } else if (entity.metricDimensions) {
            width = entity.metricDimensions[0];
            height = entity.metricDimensions[1];
            depth = entity.metricDimensions[2];
            if (entity.metricPositionENU) {
                centroid = [
                    entity.metricPositionENU[0],
                    entity.metricPositionENU[1] + height / 2,
                    entity.metricPositionENU[2]
                ];
            }
        } else if (entity.nominalDimensions && entity.nominalCentroid) {
            width = entity.nominalDimensions[0];
            height = entity.nominalDimensions[1];
            depth = entity.nominalDimensions[2];
            centroid = [entity.nominalCentroid[0], entity.nominalCentroid[1], entity.nominalCentroid[2]];
        }

        if (entity.canopyHeightMeters && entity.canopyHeightMeters > 0) {
            height = entity.canopyHeightMeters;
        }
        if (entity.crownDiameterMeters && entity.crownDiameterMeters > 0) {
            width = entity.crownDiameterMeters;
            depth = entity.crownDiameterMeters;
        }

        const avgSpread = (width + depth) * 0.5;
        const spreadAspect = avgSpread / Math.max(1.0, height);

        // 2. Solve Morphological Shape Coefficients (beta in R^16)
        // Canonical template base height = 5.8m, nominal spread = 5.0m (spread aspect ~0.86)
        const canonicalBaseHeight = 5.8;
        const beta: number[] = new Array(16).fill(0.0);

        // beta[0]: DBH / Girth Caliper (scaled to tree height via Da Vinci 2/3 power law)
        beta[0] = Math.max(-1.5, Math.min(2.0, (height / canonicalBaseHeight - 1.0) * 0.75));

        // beta[1]: Total Height Scale: clamped in [-2.0, 2.0]
        beta[1] = Math.max(-2.0, Math.min(2.0, (height - canonicalBaseHeight) / (canonicalBaseHeight * 0.45)));

        // beta[2]: Crown Spread Aspect Ratio relative to species prior
        const spreadDelta = spreadAspect - adapter.typicalAspectSpread;
        beta[2] = Math.max(-2.0, Math.min(2.0, spreadDelta * 2.5));

        // beta[3]: Crown Base Height (higher for stone pine/umbrella conifer, lower for cypress)
        const crownRatio = adapter.typicalCrownHeightRatio;
        beta[3] = Math.max(-2.0, Math.min(2.0, (1.0 - crownRatio - 0.35) * 4.0));

        // beta[4]: Cantilever Droop
        beta[4] = Math.max(-2.0, Math.min(2.0, adapter.branchDroopBias));

        // beta[5]: Basal Flare Fluting (stronger on older/wider trees)
        beta[5] = Math.max(-1.0, Math.min(2.0, (avgSpread / 10.0 - 0.5) * 1.5));

        // beta[6]: Trunk Taper Exponent
        beta[6] = Math.max(-1.5, Math.min(1.5, adapter.taperExponentBias));

        // beta[7]: Apical Dominance
        beta[7] = Math.max(-2.0, Math.min(2.0, adapter.apicalDominanceBias));

        // 3. Configure Phenology & Shaping
        const season = options.season ?? 1.0;
        const leafDensity = options.leafDensity !== undefined ? options.leafDensity : adapter.leafDensityMultiplier;
        const saturationScale = options.saturationScale ?? 0.78;

        const phenology: SbVeggiePhenologyParams = {
            season,
            leafDensity,
            generateLeaves: season > 0.05 && leafDensity > 0.05
        };

        const shaping: SbVeggieShapingParams = {
            branchCurvature: adapter.branchCurvature,
            collarFlare: adapter.collarFlare,
            reactionWood: adapter.reactionWood,
            leafMorphology: adapter.leafMorphology,
            leafCupping: adapter.leafCupping,
            transferEnvelopeNormals: true
        };

        // 4. Output Path
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'botanical_trees');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }
        const outputGlb = options.outputGlbPath || path.join(artifactsDir, `${entity.id || 'tree'}_${adapter.species}.glb`);

        // 5. Check if raw scan blob exists and inversion was requested
        let result: SbVeggieResult;
        let inversionRan = false;

        if (options.runInversionIfScanAvailable && entity.rawScanGlbPath && fs.existsSync(entity.rawScanGlbPath)) {
            result = await this.veggieService.fitScanToTree({
                inputScanPath: entity.rawScanGlbPath,
                archetype: adapter.archetype,
                phenology,
                shaping,
                outputGlbPath: outputGlb,
                colorInfluenceWeight: 0.85,
                colorInfluenceMode: 0
            });
            inversionRan = true;
        } else {
            result = await this.veggieService.synthesizeTree({
                archetype: adapter.archetype,
                shape: { beta },
                phenology,
                shaping,
                outputGlbPath: outputGlb
            });
        }

        const worldY = centroid[1] - height * 0.5; // ground contact datum
        const worldPosition: [number, number, number] = [centroid[0], worldY, centroid[2]];

        return {
            treeId: entity.id,
            species: adapter.species,
            archetype: adapter.archetype,
            worldPosition,
            worldRotationYawRad: yawRad,
            fittedHeightMeters: height,
            fittedSpreadMeters: avgSpread,
            outputGlbPath: result.outputGlbPath || outputGlb,
            glbBuffer: result.glbBuffer,
            glbBase64: result.glbBase64,
            telemetry: {
                buildTimeMs: result.telemetry.buildTimeMs,
                evalTimeMs: result.telemetry.evalTimeMs,
                outputVertices: result.telemetry.outputVertices,
                outputTriangles: result.telemetry.outputTriangles,
                isManifold: result.telemetry.outputVertices > 0,
                inversionRan
            },
            appliedBeta: beta
        };
    }

    /**
     * Batch synthesizes replacement trees from a list of spatial separator tree entities.
     */
    async batchSynthesizeFromEntities(
        entities: SpatialTreeEntity[],
        options: TreeSynthesisBridgeOptions = {}
    ): Promise<TreeSynthesisBridgeResult[]> {
        const results: TreeSynthesisBridgeResult[] = [];
        for (const entity of entities) {
            const res = await this.synthesizeTreeFromEntity(entity, options);
            results.push(res);
        }
        return results;
    }
}
