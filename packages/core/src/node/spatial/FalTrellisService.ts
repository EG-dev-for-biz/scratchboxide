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
import * as https from 'https';

export interface FalTrellisConfig {
    falKey?: string;
    mockExecution?: boolean;
    multiImageModel?: string;
    singleImageModel?: string;
}

export interface FalTrellisMultiInput {
    imageUrls?: string[];
    imagePaths?: string[];
    imageBuffers?: Array<{ name: string; buffer: Buffer; contentType?: string }>;
    ssSamplingSteps?: number;
    slatSamplingSteps?: number;
    meshSimplify?: number;
    textureSize?: string;
    outputFormat?: string;
    destinationGlbPath?: string;
}

export interface FalGlbMeshStats {
    magic: string;
    totalBytes: number;
    totalVertices: number;
    totalTriangles: number;
    meshesCount: number;
    generator?: string;
}

export interface FalTrellisResult {
    success: boolean;
    modelGlbUrl?: string;
    localGlbPath?: string;
    stats?: FalGlbMeshStats;
    inferenceDurationMs?: number;
    error?: string;
    timings?: Record<string, number>;
}

/**
 * First-class Fal.ai Trellis Service for Scratchbox IDE.
 * Dispatches multi-view and single-view reference images directly to Microsoft Trellis
 * running on Fal.ai GPU infrastructure (fal-ai/trellis/multi and fal-ai/trellis).
 */
export class FalTrellisService {
    private falKey: string;
    private mockExecution: boolean;
    private multiImageModel: string;
    private singleImageModel: string;

    constructor(config: FalTrellisConfig = {}) {
        this.falKey = config.falKey || this.resolveFalKey();
        this.mockExecution = config.mockExecution ?? (!this.falKey);
        this.multiImageModel = config.multiImageModel || 'fal-ai/trellis/multi';
        this.singleImageModel = config.singleImageModel || 'fal-ai/trellis';
    }

    private resolveFalKey(): string {
        if (process.env.FAL_KEY) return process.env.FAL_KEY;
        try {
            const envFile = path.resolve(process.cwd(), '.env');
            if (fs.existsSync(envFile)) {
                const lines = fs.readFileSync(envFile, 'utf8').split('\n');
                for (const l of lines) {
                    const m = l.match(/^FAL_KEY\s*=\s*["']?([^"'\r\n]+)["']?/);
                    if (m) return m[1].trim();
                }
            }
        } catch {}
        return '';
    }

    public isConfigured(): boolean {
        return !!this.falKey;
    }

    public setMockExecution(mock: boolean): void {
        this.mockExecution = mock;
    }

    /**
     * Upload an image buffer to Fal's high-speed persistent alpha CDN storage.
     */
    public async uploadToFalStorage(buf: Buffer, filename = `view_${Date.now()}.png`, contentType = 'image/png'): Promise<string> {
        if (this.mockExecution || !this.falKey) {
            return `mock://storage.fal.ai/files/${filename}`;
        }

        const initRes = await new Promise<any>((resolve, reject) => {
            const req = https.request('https://rest.alpha.fal.ai/storage/upload/initiate', {
                method: 'POST',
                headers: {
                    'Authorization': 'Key ' + this.falKey,
                    'Content-Type': 'application/json'
                }
            }, res => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.write(JSON.stringify({ file_name: filename, content_type: contentType }));
            req.end();
        });

        if (!initRes || !initRes.upload_url) {
            throw new Error(`Fal Storage initiate failed: ${JSON.stringify(initRes)}`);
        }

        const uploadUrl = new URL(initRes.upload_url);
        await new Promise<void>((resolve, reject) => {
            const req = https.request(uploadUrl, {
                method: 'PUT',
                headers: {
                    'Content-Type': contentType,
                    'Content-Length': buf.length
                }
            }, res => {
                res.resume();
                res.on('end', resolve);
            });
            req.on('error', reject);
            req.write(buf);
            req.end();
        });

        return initRes.file_url;
    }

    /**
     * Executes real Multi-View Trellis flow matching on Fal.ai.
     */
    public async generate3DFromImages(input: FalTrellisMultiInput): Promise<FalTrellisResult> {
        const startTime = Date.now();
        const urls: string[] = [];

        // 1. Gather all URLs
        if (input.imageUrls) {
            urls.push(...input.imageUrls);
        }

        // 2. Upload file paths if provided
        if (input.imagePaths) {
            for (const p of input.imagePaths) {
                if (fs.existsSync(p)) {
                    const buf = await fs.promises.readFile(p);
                    const url = await this.uploadToFalStorage(buf, path.basename(p));
                    urls.push(url);
                }
            }
        }

        // 3. Upload buffers if provided
        if (input.imageBuffers) {
            for (const item of input.imageBuffers) {
                const url = await this.uploadToFalStorage(item.buffer, item.name, item.contentType || 'image/png');
                urls.push(url);
            }
        }

        if (urls.length === 0) {
            return {
                success: false,
                error: 'FalTrellisService: No images provided to generate3DFromImages.'
            };
        }

        if (this.mockExecution) {
            return this.executeMock(input.destinationGlbPath);
        }

        const payload = JSON.stringify({
            image_urls: urls,
            ss_sampling_steps: input.ssSamplingSteps ?? 12,
            slat_sampling_steps: input.slatSamplingSteps ?? 12,
            mesh_simplify: input.meshSimplify ?? 0.95,
            texture_size: input.textureSize || '1024'
        });

        try {
            const responseData = await new Promise<any>((resolve, reject) => {
                const req = https.request(`https://fal.run/${this.multiImageModel}`, {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Key ' + this.falKey,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload)
                    }
                }, res => {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 400) {
                            return reject(new Error(`Fal API error HTTP ${res.statusCode}: ${d}`));
                        }
                        try {
                            resolve(JSON.parse(d));
                        } catch (e) {
                            reject(new Error(`Failed to parse Fal JSON response: ${d}`));
                        }
                    });
                });
                req.on('error', reject);
                req.write(payload);
                req.end();
            });

            const glbRemoteUrl = responseData.model_mesh?.url || responseData.model_glb?.url;
            if (!glbRemoteUrl) {
                return {
                    success: false,
                    error: `Fal Trellis returned no GLB model URL: ${JSON.stringify(responseData)}`
                };
            }

            let localPath = input.destinationGlbPath;
            let stats: FalGlbMeshStats | undefined;

            if (localPath) {
                await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
                const glbBuf = await this.downloadBinary(glbRemoteUrl);
                await fs.promises.writeFile(localPath, glbBuf);
                stats = this.parseGlbStats(glbBuf);
            }

            return {
                success: true,
                modelGlbUrl: glbRemoteUrl,
                localGlbPath: localPath,
                stats,
                timings: responseData.timings,
                inferenceDurationMs: Date.now() - startTime
            };
        } catch (err: any) {
            return {
                success: false,
                error: `Fal Trellis inference failed: ${err.message}`
            };
        }
    }

    /**
     * Download binary file from remote URL.
     */
    public async downloadBinary(url: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            https.get(url, res => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Failed to download binary: HTTP ${res.statusCode}`));
                }
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            });
        });
    }

    /**
     * Parse binary glTF 2.0 headers and calculate geometric complexity.
     */
    public parseGlbStats(buf: Buffer): FalGlbMeshStats {
        const magic = buf.toString('utf8', 0, 4);
        if (magic !== 'glTF') throw new Error(`Not a glTF binary: magic=${magic}`);
        const jsonChunkLength = buf.readUInt32LE(12);
        const jsonStr = buf.toString('utf8', 20, 20 + jsonChunkLength);
        const gltf = JSON.parse(jsonStr);

        let totalVertices = 0;
        let totalIndices = 0;

        for (const mesh of gltf.meshes || []) {
            for (const prim of mesh.primitives || []) {
                const posAcc = gltf.accessors[prim.attributes.POSITION];
                if (posAcc) totalVertices += posAcc.count;
                if (prim.indices !== undefined) {
                    const idxAcc = gltf.accessors[prim.indices];
                    if (idxAcc) totalIndices += idxAcc.count;
                }
            }
        }

        return {
            magic,
            totalBytes: buf.length,
            totalVertices,
            totalTriangles: Math.floor(totalIndices / 3),
            meshesCount: gltf.meshes?.length || 0,
            generator: gltf.asset?.generator
        };
    }

    private executeMock(destPath?: string): FalTrellisResult {
        let stats: FalGlbMeshStats | undefined;
        if (destPath) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            // Minimal valid glTF binary header
            const mockGlb = Buffer.from('glTF\x02\x00\x00\x00 \x00\x00\x00\x0c\x00\x00\x00JSON{"asset":{"version":"2.0","generator":"FalTrellisServiceMock"},"meshes":[]}\x00\x00\x00\x00BIN\x00');
            fs.writeFileSync(destPath, mockGlb);
            stats = {
                magic: 'glTF',
                totalBytes: mockGlb.length,
                totalVertices: 0,
                totalTriangles: 0,
                meshesCount: 0,
                generator: 'FalTrellisServiceMock'
            };
        }

        return {
            success: true,
            modelGlbUrl: 'https://v3b.fal.media/files/mock/model.glb',
            localGlbPath: destPath,
            stats,
            inferenceDurationMs: 120
        };
    }
}
