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

export type TrainedModelFamily = 'sbhuman' | 'performer_4dgs' | 'geobox' | 'depthbox';

export interface TrainedModelItem {
    id: string;
    name: string;
    family: TrainedModelFamily;
    format: string;
    filePath: string;
    webUri?: string;
    sizeBytes: number;
    status: 'ready' | 'missing';
    metadata?: Record<string, any>;
}

export interface Avatar4DGSManifest {
    id: string;
    title: string;
    description?: string;
    resolution?: string;
    fps?: number;
    featured?: boolean;
    plyPath: string;
    splatPath?: string;
    glbPath?: string;
    transformsPath?: string;
    camerasPath?: string;
    motionPath?: string;
    geoManifestPath?: string;
    canonicalFramePath?: string;
    splatBytes?: number;
}

export interface ModelCatalogSummary {
    totalModels: number;
    totalSizeBytes: number;
    families: Record<TrainedModelFamily, number>;
}

export class TrainedModelRegistryService {
    private repoRoot: string;

    constructor(customRepoRoot?: string) {
        this.repoRoot = customRepoRoot || this.findRepoRoot();
    }

    private findRepoRoot(): string {
        let cur = process.cwd();
        while (cur !== path.dirname(cur)) {
            if (fs.existsSync(path.join(cur, 'package.json')) && fs.existsSync(path.join(cur, 'models'))) {
                return cur;
            }
            cur = path.dirname(cur);
        }
        return process.cwd();
    }

    /**
     * Scans and returns all discovered trained models across the workspace.
     */
    public discoverAllModels(): TrainedModelItem[] {
        const models: TrainedModelItem[] = [];

        // 1. SB-Human Parametric Humanoid Models (Primary Native Standard)
        models.push(...this.discoverSbHumanModels());

        // 2. Performer 4DGS Humanoid Models (Demos & Artifacts)
        models.push(...this.discover4DGSModels());

        // 3. GeoBox Checkpoints & Coordinate Gallery
        models.push(...this.discoverGeoBoxModels());

        // 4. Standard Pre-converted Splat/GLB Avatars
        models.push(...this.discoverConvertedAvatars());

        return models;
    }

    /**
     * Filters discovered models by family category.
     */
    public getModelsByFamily(family: TrainedModelFamily): TrainedModelItem[] {
        return this.discoverAllModels().filter(m => m.family === family);
    }

    /**
     * Discovers SB-Human (.sbhuman) canonical parametric humanoid body models.
     */
    public discoverSbHumanModels(): TrainedModelItem[] {
        const results: TrainedModelItem[] = [];
        const candidateDirs = [
            path.join(this.repoRoot, 'public', 'models'),
            path.join(this.repoRoot, 'packages', 'core', 'assets', 'models')
        ];
        const dir = candidateDirs.find(d => fs.existsSync(path.join(d, 'sbhuman_neutral.sbhuman'))) || candidateDirs[0];
        const genders = [
            { id: 'sbhuman_neutral', name: 'SB-Human Neutral Body Model', file: 'sbhuman_neutral.sbhuman' },
            { id: 'sbhuman_male', name: 'SB-Human Male Body Model', file: 'sbhuman_male.sbhuman' },
            { id: 'sbhuman_female', name: 'SB-Human Female Body Model', file: 'sbhuman_female.sbhuman' }
        ];

        for (const g of genders) {
            const p = path.join(dir, g.file);
            const exists = fs.existsSync(p);
            const size = exists ? fs.statSync(p).size : 0;
            results.push({
                id: g.id,
                name: g.name,
                family: 'sbhuman',
                format: 'sbhuman',
                filePath: p,
                webUri: `/models/${g.file}`,
                sizeBytes: size,
                status: exists && size > 0 ? 'ready' : 'missing',
                metadata: {
                    gender: g.file.replace('sbhuman_', '').replace('.sbhuman', '').toLowerCase(),
                    numVertices: 10475,
                    numJoints: 55,
                    version: 2
                }
            });
        }
        return results;
    }


    /**
     * Discovers Performer 4D Gaussian Splatting humanoid avatars.
     */
     public discover4DGSModels(): TrainedModelItem[] {
        const results: TrainedModelItem[] = [];
        const demosDir = path.join(this.repoRoot, 'models', 'performer_4dgs', 'demos');

        if (fs.existsSync(demosDir)) {
            const catalogPath = path.join(demosDir, 'demos_catalog.json');
            let catalogList: any[] = [];
            if (fs.existsSync(catalogPath)) {
                try {
                    const parsed = fs.readJsonSync(catalogPath);
                    catalogList = parsed.demos || [];
                } catch {
                    // Ignore JSON parse errors
                }
            }

            const entries = fs.readdirSync(demosDir);
            for (const entry of entries) {
                const subDir = path.join(demosDir, entry);
                if (!fs.statSync(subDir).isDirectory()) continue;

                const plyPath = path.join(subDir, 'human_4dgs.ply');
                if (fs.existsSync(plyPath)) {
                    const size = fs.statSync(plyPath).size;
                    const catEntry = catalogList.find(d => d.id === entry);
                    results.push({
                        id: `4dgs_demo_${entry}`,
                        name: catEntry?.title || `Performer 4DGS Avatar (${entry})`,
                        family: 'performer_4dgs',
                        format: 'ply',
                        filePath: plyPath,
                        webUri: `/models/performer_4dgs/demos/${entry}/human_4dgs.ply`,
                        sizeBytes: size,
                        status: size > 0 ? 'ready' : 'missing',
                        metadata: {
                            demoId: entry,
                            featured: catEntry?.featured ?? false,
                            resolution: catEntry?.resolution,
                            fps: catEntry?.fps,
                            motionPath: path.join(subDir, 'motion.json'),
                            camerasPath: path.join(subDir, 'cameras.json'),
                            canonicalFrame: path.join(subDir, 'canonical_frame.jpg')
                        }
                    });
                }
            }
        }

        return results;
    }

    /**
     * Discovers pre-converted .splat and .glb humanoid models in public/models.
     */
    public discoverConvertedAvatars(): TrainedModelItem[] {
        const results: TrainedModelItem[] = [];
        const publicModels = path.join(this.repoRoot, 'public', 'models');
        if (!fs.existsSync(publicModels)) return results;

        const files = fs.readdirSync(publicModels);
        for (const file of files) {
            if (file.startsWith('humanoid_') && (file.endsWith('.splat') || file.endsWith('.glb'))) {
                const p = path.join(publicModels, file);
                const size = fs.statSync(p).size;
                const ext = path.extname(file).replace('.', '');
                results.push({
                    id: file.replace(`.${ext}`, ''),
                    name: `4DGS Humanoid Avatar (${ext.toUpperCase()})`,
                    family: 'performer_4dgs',
                    format: ext,
                    filePath: p,
                    webUri: `/models/${file}`,
                    sizeBytes: size,
                    status: size > 0 ? 'ready' : 'missing',
                    metadata: { optimizedViewportAsset: true }
                });
            }
        }
        return results;
    }


    /**
     * Discovers GeoBox vision-location foundation models and gallery embeddings.
     */
    public discoverGeoBoxModels(): TrainedModelItem[] {
        const results: TrainedModelItem[] = [];
        const geoboxDir = path.join(this.repoRoot, 'build', 'geobox_checkpoints');

        // Main trained checkpoint
        const realTrained = path.join(geoboxDir, 'geobox_real_trained.pt');
        const exists = fs.existsSync(realTrained);
        const size = exists ? fs.statSync(realTrained).size : 0;
        results.push({
            id: 'geobox_real_trained',
            name: 'GeoBox Tri-Modal Vision-Location Model',
            family: 'geobox',
            format: 'pt',
            filePath: realTrained,
            webUri: `/models/geobox/geobox_real_trained.pt`,
            sizeBytes: size,
            status: exists && size > 0 ? 'ready' : 'missing'
        });

        // 100K dense GPS gallery coordinates
        const coordsPath = path.join(geoboxDir, 'coordinates_100K.npy');
        const coordsExists = fs.existsSync(coordsPath);
        const coordsSize = coordsExists ? fs.statSync(coordsPath).size : 0;
        results.push({
            id: 'geobox_coords_100k',
            name: 'GeoBox Dense 100K Spherical Hash Gallery',
            family: 'geobox',
            format: 'npy',
            filePath: coordsPath,
            webUri: `/models/geobox/coordinates_100K.npy`,
            sizeBytes: coordsSize,
            status: coordsExists && coordsSize > 0 ? 'ready' : 'missing'
        });

        return results;
    }

    /**
     * Returns detailed manifest for a 4DGS humanoid avatar demo by ID.
     */
    public get4DGSAvatar(id: string): Avatar4DGSManifest | undefined {
        const cleanId = id.replace('4dgs_demo_', '').replace('humanoid_', '');
        const demoDir = path.join(this.repoRoot, 'models', 'performer_4dgs', 'demos', cleanId);
        const plyPath = path.join(demoDir, 'human_4dgs.ply');

        if (!fs.existsSync(plyPath)) {
            return undefined;
        }

        const catalogPath = path.join(this.repoRoot, 'models', 'performer_4dgs', 'demos', 'demos_catalog.json');
        let meta: any = {};
        if (fs.existsSync(catalogPath)) {
            try {
                const cat = fs.readJsonSync(catalogPath);
                meta = (cat.demos || []).find((d: any) => d.id === cleanId) || {};
            } catch {
                // Ignore parse errors
            }
        }

        const splatPath = path.join(this.repoRoot, 'public', 'models', `humanoid_${cleanId}.splat`);
        const glbPath = path.join(this.repoRoot, 'public', 'models', `humanoid_${cleanId}.glb`);

        return {
            id: cleanId,
            title: meta.title || `Humanoid Avatar ${cleanId}`,
            description: meta.description,
            resolution: meta.resolution,
            fps: meta.fps,
            featured: meta.featured,
            plyPath,
            splatPath: fs.existsSync(splatPath) ? splatPath : undefined,
            glbPath: fs.existsSync(glbPath) ? glbPath : undefined,
            transformsPath: path.join(demoDir, 'transforms.json'),
            camerasPath: path.join(demoDir, 'cameras.json'),
            motionPath: path.join(demoDir, 'motion.json'),
            geoManifestPath: path.join(demoDir, 'geo_manifest.json'),
            canonicalFramePath: path.join(demoDir, 'canonical_frame.jpg'),
            splatBytes: fs.statSync(plyPath).size
        };
    }

    /**
     * Returns SB-Human (.sbhuman) model file path for the requested gender.
     */
    public getSbHumanModel(gender: 'neutral' | 'male' | 'female'): string | undefined {
        const filename = `sbhuman_${gender}.sbhuman`;
        const candidatePaths = [
            path.join(this.repoRoot, 'public', 'models', filename),
            path.join(this.repoRoot, 'packages', 'core', 'assets', 'models', filename)
        ];
        return candidatePaths.find(p => fs.existsSync(p));
    }

    /**
     * Returns GeoBox checkpoint path.
     */
    public getGeoBoxCheckpoint(version: string = 'real_trained'): string | undefined {
        const p = path.join(this.repoRoot, 'build', 'geobox_checkpoints', `geobox_${version}.pt`);
        return fs.existsSync(p) ? p : undefined;
    }

    /**
     * Returns a summary breakdown of all installed models.
     */
    public getCatalogSummary(): ModelCatalogSummary {
        const all = this.discoverAllModels();
        const families: Record<TrainedModelFamily, number> = {
            sbhuman: 0,
            performer_4dgs: 0,
            geobox: 0,
            depthbox: 0
        };

        let totalSizeBytes = 0;
        let readyCount = 0;

        for (const m of all) {
            if (m.status === 'ready') {
                families[m.family] = (families[m.family] || 0) + 1;
                totalSizeBytes += m.sizeBytes;
                readyCount++;
            }
        }

        return {
            totalModels: readyCount,
            totalSizeBytes,
            families
        };
    }
}
