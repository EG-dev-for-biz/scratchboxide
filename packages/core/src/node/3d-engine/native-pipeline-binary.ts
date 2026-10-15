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
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GeneratorFailedError } from '../../common/errors/pipeline-errors';

const execFileAsync = promisify(execFile);

/** The newest modification time among the source file and the engine headers it can include. */
function newestSourceMtime(sourcePath: string, includeDir: string): number {
    let newest = fs.statSync(sourcePath).mtimeMs;
    if (fs.existsSync(includeDir)) {
        for (const name of fs.readdirSync(includeDir)) {
            if (/\.(h|hpp)$/.test(name)) {
                newest = Math.max(newest, fs.statSync(path.join(includeDir, name)).mtimeMs);
            }
        }
    }
    return newest;
}

/**
 * Returns a native pipeline binary built from the current source: it is (re)compiled when it is missing or older
 * than its source or any engine header, so a stale binary never runs an old contract (for example one that still
 * builds a stand-in mesh when --input is missing). `-march=native` only with SCRATCHBOX_NATIVE_ARCH=1. A compile
 * failure is a GeneratorFailedError carrying the compiler output.
 */
export async function ensurePipelineBinary(options: { binaryPath: string; sourcePath: string; includeDir: string }): Promise<string> {
    const { binaryPath, sourcePath, includeDir } = options;
    if (!fs.existsSync(sourcePath)) {
        if (fs.existsSync(binaryPath)) return binaryPath;
        throw new GeneratorFailedError('cpp', `neither the pipeline binary ${binaryPath} nor its source ${sourcePath} exists`);
    }
    if (fs.existsSync(binaryPath) && fs.statSync(binaryPath).mtimeMs >= newestSourceMtime(sourcePath, includeDir)) {
        return binaryPath;
    }
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    // Compile to a private name and rename into place, so concurrent callers never run a half-written binary.
    const tmp = `${binaryPath}.build-${process.pid}-${Date.now()}`;
    const args = ['-std=c++20', '-O3', ...(process.env.SCRATCHBOX_NATIVE_ARCH === '1' ? ['-march=native'] : []), '-I', includeDir, sourcePath, '-o', tmp];
    try {
        await execFileAsync(process.env.CXX || 'clang++', args, { maxBuffer: 1024 * 1024 * 16 });
    } catch (err: any) {
        fs.rmSync(tmp, { force: true });
        throw new GeneratorFailedError('cpp', `compiling ${path.basename(sourcePath)} failed: ${err?.stderr || err?.message || err}`);
    }
    fs.renameSync(tmp, binaryPath);
    return binaryPath;
}

/** Runs a pipeline binary without a shell. Exit code 2 is the binary's "invalid input" code. */
export async function runPipelineBinary(binary: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(binary, args, { maxBuffer: 1024 * 1024 * 64 });
    return { stdout: String(stdout), stderr: String(stderr) };
}

/** Reads `key=value` pairs from the binary's `[TELEMETRY]` line; throws when the line is missing. */
export function parseTelemetryLine(stdout: string, what: string): Map<string, string> {
    const line = stdout.match(/\[TELEMETRY\]\s+(.+)/);
    if (!line) {
        throw new GeneratorFailedError('cpp', `${what} reported no telemetry. ${stdout.trim().slice(-1500)}`);
    }
    const values = new Map<string, string>();
    for (const m of line[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g)) {
        values.set(m[1], m[2]);
    }
    return values;
}

/** What the native GLB reader would get wrong about a GLB, by consequence. */
export interface RawMeshReadIssues {
    /**
     * What the reader would misread (node transforms, instancing, non-triangle primitives, compressed or sparse
     * accessors, unreadable component types, a corrupt file): measured bounds and output would be wrong.
     */
    geometry: string[];
    /** Content the native writer cannot carry over (textures, several materials): the output would silently lose it. */
    content: string[];
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;

/** The parsed JSON chunk of a binary glTF, or the reason it cannot be read. */
function parseGlbJson(glb: Buffer): { json: any; jsonEnd: number } | { error: string } {
    if (glb.length < 20 || glb.readUInt32LE(0) !== GLB_MAGIC) return { error: 'it is not a binary glTF (.glb) file' };
    if (glb.readUInt32LE(4) !== 2) return { error: `it is glTF version ${glb.readUInt32LE(4)}, not 2` };
    const jsonLength = glb.readUInt32LE(12);
    if (glb.readUInt32LE(16) !== JSON_CHUNK) return { error: 'its first chunk is not the JSON chunk' };
    if (20 + jsonLength > glb.length) return { error: `its JSON chunk claims ${jsonLength} bytes but the file has ${glb.length - 20} after the header (truncated)` };
    try {
        return { json: JSON.parse(glb.toString('utf8', 20, 20 + jsonLength)), jsonEnd: 20 + jsonLength };
    } catch (err: any) {
        return { error: `its JSON chunk is not valid JSON (${err?.message || err})` };
    }
}

/** Accessor component types the native reader decodes as values; it reads 5123 colours and UVs unnormalised and skips signed types. */
const READER_FLOAT_ATTRIBUTES = ['POSITION', 'NORMAL', 'TANGENT'];
const READER_UNORM_ATTRIBUTES = ['TEXCOORD_0', 'COLOR_0'];

/**
 * The native pipelines read a GLB with GlbReader, which merges every primitive's raw vertex data into one triangle
 * list (ignoring node transforms, instancing and primitive modes, and decoding only float and unsigned-byte
 * attributes) and write it with GlbWriter, which writes one primitive with one material and no textures. This lists
 * what that would get wrong for `glb`, so callers can refuse the input instead of returning a moved, rescaled,
 * scrambled or stripped mesh as done. A file that cannot be parsed is reported as a geometry issue.
 */
export function rawMeshReadIssues(glb: Buffer): RawMeshReadIssues {
    const parsed = parseGlbJson(glb);
    if ('error' in parsed) {
        return { geometry: [parsed.error], content: [] };
    }
    const json = parsed.json;
    const nodes: any[] = Array.isArray(json.nodes) ? json.nodes : [];
    const meshes: any[] = Array.isArray(json.meshes) ? json.meshes : [];
    const accessors: any[] = Array.isArray(json.accessors) ? json.accessors : [];
    const geometry: string[] = [];
    const content: string[] = [];
    const hasMesh = (index: number, seen = new Set<number>()): boolean => {
        if (seen.has(index) || !nodes[index]) return false;
        seen.add(index);
        return nodes[index].mesh !== undefined || (nodes[index].children || []).some((c: number) => hasMesh(c, seen));
    };
    const near = (a: unknown, b: number[]) => Array.isArray(a) && a.length === b.length && a.every((v, i) => Math.abs(Number(v) - b[i]) < 1e-9);
    nodes.forEach((node, index) => {
        const moved = (node.matrix !== undefined && !near(node.matrix, IDENTITY_MATRIX))
            || (node.translation !== undefined && !near(node.translation, [0, 0, 0]))
            || (node.rotation !== undefined && !near(node.rotation, [0, 0, 0, 1]))
            || (node.scale !== undefined && !near(node.scale, [1, 1, 1]));
        if (moved && hasMesh(index)) {
            const parts = ['matrix', 'translation', 'rotation', 'scale'].filter(k => node[k] !== undefined).map(k => `${k} ${JSON.stringify(node[k])}`);
            geometry.push(`node ${node.name ? `"${node.name}"` : index} places its mesh with ${parts.join(', ')}`);
        }
    });
    const uses = new Map<number, number>();
    for (const node of nodes) if (node.mesh !== undefined) uses.set(node.mesh, (uses.get(node.mesh) || 0) + 1);
    for (const [mesh, count] of uses) if (count > 1) geometry.push(`mesh ${mesh} is instanced by ${count} nodes`);

    const required: string[] = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
    if (required.length) geometry.push(`it requires ${required.join(', ')}, which the native reader does not decode`);
    const describedAccessors = new Set<number>();
    const materialsUsed = new Set<string>();
    meshes.forEach((mesh, m) => {
        (Array.isArray(mesh?.primitives) ? mesh.primitives : []).forEach((prim: any, p: number) => {
            const where = `mesh ${m} primitive ${p}`;
            const mode = prim?.mode ?? 4;
            if (mode !== 4) geometry.push(`${where} has primitive mode ${mode} (not a triangle list), which the reader would read as triangles`);
            materialsUsed.add(prim?.material === undefined ? 'none' : String(prim.material));
            const attributes = prim?.attributes || {};
            const accessorIssue = (semantic: string, index: number | undefined) => {
                const acc = index === undefined ? undefined : accessors[index];
                if (!acc || describedAccessors.has(index!)) return;
                if (acc.sparse) { describedAccessors.add(index!); geometry.push(`${where} ${semantic} is a sparse accessor, which the reader ignores`); return; }
                if (acc.bufferView === undefined) { describedAccessors.add(index!); geometry.push(`${where} ${semantic} has no buffer view`); return; }
                const ok = READER_FLOAT_ATTRIBUTES.includes(semantic) ? acc.componentType === 5126
                    : READER_UNORM_ATTRIBUTES.includes(semantic) ? (acc.componentType === 5126 || acc.componentType === 5121)
                        : true;
                if (!ok) { describedAccessors.add(index!); geometry.push(`${where} ${semantic} uses component type ${acc.componentType}, which the reader does not decode correctly`); }
            };
            for (const semantic of [...READER_FLOAT_ATTRIBUTES, ...READER_UNORM_ATTRIBUTES]) accessorIssue(semantic, attributes[semantic]);
        });
    });
    if (materialsUsed.size > 1) {
        content.push(`its primitives use ${materialsUsed.size} different materials (${[...materialsUsed].join(', ')}), and the native writer writes one`);
    }
    const textures = Array.isArray(json.textures) ? json.textures.length : 0;
    if (textures > 0) content.push(`it has ${textures} texture(s), which the native writer does not carry over`);
    return { geometry, content };
}

/** Replaces the JSON chunk of a GLB, keeping every chunk after it byte for byte. */
function withGlbJson(glb: Buffer, json: unknown): Buffer {
    const parsed = parseGlbJson(glb);
    if ('error' in parsed) throw new GeneratorFailedError('cpp', `the native pipeline wrote an unreadable GLB: ${parsed.error}`);
    let chunk = Buffer.from(JSON.stringify(json), 'utf8');
    chunk = Buffer.concat([chunk, Buffer.alloc((4 - (chunk.length % 4)) % 4, 0x20)]);
    const rest = glb.subarray(parsed.jsonEnd);
    const header = Buffer.alloc(20);
    header.writeUInt32LE(GLB_MAGIC, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(20 + chunk.length + rest.length, 8);
    header.writeUInt32LE(chunk.length, 12);
    header.writeUInt32LE(JSON_CHUNK, 16);
    return Buffer.concat([header, chunk, rest]);
}

/**
 * GlbWriter gives its single output primitive a stock material (its own base colour, metalness and roughness). This
 * rewrites the output GLB at `outputPath` so its primitive carries the input's own material instead (the one material
 * every input primitive uses, copied with its extensions), or no material when the input had none. Inputs with
 * several materials or textures are refused before the run (rawMeshReadIssues), so one material always describes
 * the input. Returns the rewritten GLB.
 */
export function carryOverInputMaterial(inputGlb: Buffer, outputPath: string): Buffer {
    const input = parseGlbJson(inputGlb);
    if ('error' in input) throw new GeneratorFailedError('cpp', `cannot carry the material over: the input ${input.error}`);
    const prims: any[] = (Array.isArray(input.json.meshes) ? input.json.meshes : []).flatMap((m: any) => (Array.isArray(m?.primitives) ? m.primitives : []));
    const used = new Set(prims.map(p => p?.material));
    if (used.size > 1) {
        throw new GeneratorFailedError('cpp', `cannot carry the material over: the input's primitives use ${used.size} materials`);
    }
    const materialIndex = prims.length ? prims[0]?.material : undefined;
    const material = materialIndex === undefined ? undefined : input.json.materials?.[materialIndex];
    if (materialIndex !== undefined && !material) {
        throw new GeneratorFailedError('cpp', `cannot carry the material over: the input names material ${materialIndex}, which it does not define`);
    }

    const outputGlb = fs.readFileSync(outputPath);
    const output = parseGlbJson(outputGlb);
    if ('error' in output) throw new GeneratorFailedError('cpp', `the native pipeline wrote an unreadable GLB to ${outputPath}: ${output.error}`);
    const json = output.json;
    for (const mesh of Array.isArray(json.meshes) ? json.meshes : []) {
        for (const prim of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
            if (material) prim.material = 0; else delete prim.material;
        }
    }
    if (material) json.materials = [JSON.parse(JSON.stringify(material))]; else delete json.materials;
    // Material extensions the writer declared for its own material go; the input material's extensions come along.
    const kept = (Array.isArray(json.extensionsUsed) ? json.extensionsUsed : []).filter((name: string) => !name.startsWith('KHR_materials_'));
    const unique = Array.from(new Set<string>([...kept, ...Object.keys(material?.extensions || {})]));
    if (unique.length) json.extensionsUsed = unique; else delete json.extensionsUsed;
    const rewritten = withGlbJson(outputGlb, json);
    fs.writeFileSync(outputPath, rewritten);
    return rewritten;
}
