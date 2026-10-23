/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Modelling edits on a given mesh in the native engine (scripts/run_mesh_edit_pipeline.cpp, scratchbox_mesh_edit.hpp):
 * booleans with another GLB or a measured solid, plane cuts with a capped section, inset and extrude of a selected
 * region, chamfers and fillets on convex edges. Every operation is explicit; an invalid one fails the call with the reason. The result reports each
 * operation's counts and how many edges are left open (0 for a closed solid).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeCppCompilerService } from './native-compiler-service';
import { carryOverInputMaterial, ensurePipelineBinary, rawMeshReadIssues, runPipelineBinary } from './native-pipeline-binary';
import { GeneratorFailedError, MissingInputError } from '../../common/errors/pipeline-errors';

type V3 = [number, number, number];

export type MeshEditOperand =
    | { glbPath: string }
    | { box: { center: V3; size: V3; rotationDeg?: V3 } }
    | { cylinder: { start: V3; end: V3; radius: number; segments?: number } }
    | { sphere: { center: V3; radius: number; segments?: number } };

export type MeshEditOperation =
    | { type: 'boolean'; op: 'union' | 'subtract' | 'intersect'; operand: MeshEditOperand }
    | { type: 'cut'; point: V3; normal: V3 }
    | { type: 'extrude'; select: { direction?: V3; coneDeg?: number; regionMin?: V3; regionMax?: V3 }; distance?: number; inset?: number }
    | { type: 'bevel'; width: number; segments?: number; minAngleDeg?: number; select?: { regionMin?: V3; regionMax?: V3 } };

export interface MeshEditResult {
    outputGlbPath: string;
    inputTriangles: number;
    outputTriangles: number;
    outputVertices: number;
    /** Edges used by one triangle only: 0 when the result is a closed solid. */
    openEdges: number;
    boundsMin: V3;
    boundsMax: V3;
    processingTimeMs: number;
    operations: Array<Record<string, number | string>>;
}

export class NativeMeshEditService {
    private readonly compiler = new NativeCppCompilerService();

    private binaryPath(): string {
        return path.resolve(process.cwd(), 'build/3d-native/run_mesh_edit_pipeline');
    }

    async ensureBinary(): Promise<string> {
        return ensurePipelineBinary({
            binaryPath: this.binaryPath(),
            sourcePath: path.resolve(process.cwd(), 'scripts/run_mesh_edit_pipeline.cpp'),
            includeDir: this.compiler.getSdkIncludePath()
        });
    }

    /** Throws MissingInputError for a missing or unreadable mesh or an invalid operation, GeneratorFailedError for a failed run. */
    async edit(options: { inputGlbPath: string; operations: MeshEditOperation[]; outputGlbPath?: string; creaseDeg?: number }): Promise<MeshEditResult> {
        const { inputGlbPath, operations } = options;
        if (!Array.isArray(operations) || operations.length === 0) {
            throw new MissingInputError('mesh_edit', 'operations', 'give at least one operation; none is chosen for you');
        }
        if (!inputGlbPath || !fs.existsSync(inputGlbPath)) {
            throw new MissingInputError('mesh_edit', 'inputGlbPath', `${inputGlbPath || '(none)'} does not exist; no stand-in mesh is built`);
        }
        // the native reader ignores node transforms and the writer keeps one material and no textures: such a GLB is refused,
        // the operand GLBs of booleans alike, rather than returned moved or stripped
        const glbBytes = fs.readFileSync(inputGlbPath);
        const check = (file: string, bytes: Buffer, arg: string) => {
            const issues = rawMeshReadIssues(bytes);
            if (issues.geometry.length || issues.content.length) {
                throw new MissingInputError('mesh_edit', arg, `${file} cannot be edited faithfully: ${[...issues.geometry, ...issues.content].join('; ')}. `
                    + 'Bake node transforms into the vertices and use an untextured (clay) mesh with one material.');
            }
        };
        check(inputGlbPath, glbBytes, 'inputGlbPath');
        for (const op of operations) {
            const operand = (op as { operand?: { glbPath?: string } }).operand;
            if (operand?.glbPath) {
                if (!fs.existsSync(operand.glbPath)) throw new MissingInputError('mesh_edit', 'operand.glbPath', `${operand.glbPath} does not exist`);
                check(operand.glbPath, fs.readFileSync(operand.glbPath), 'operand.glbPath');
            }
        }

        const bin = await this.ensureBinary();
        const outputGlbPath = options.outputGlbPath
            || path.join(path.resolve(process.cwd(), '.scratchbox', 'artifacts'), `edited_${Date.now()}.glb`);
        fs.mkdirSync(path.dirname(outputGlbPath), { recursive: true });
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-mesh-edit-'));
        try {
            const operationsFile = path.join(scratch, 'operations.json');
            fs.writeFileSync(operationsFile, JSON.stringify(operations));
            const args = ['--input', inputGlbPath, '--output', outputGlbPath, '--operationsFile', operationsFile];
            if (options.creaseDeg !== undefined) args.push('--creaseDeg', String(options.creaseDeg));
            let stdout: string;
            try {
                ({ stdout } = await runPipelineBinary(bin, args));
            } catch (err: any) {
                const detail = String(err?.stderr || err?.message || err).trim().replace(/^Error:\s*/, '');
                if (err?.code === 2) throw new MissingInputError('mesh_edit', 'valid operations', detail);
                throw new GeneratorFailedError('cpp', `mesh edit failed: ${detail}`);
            }
            const line = stdout.match(/\[RESULT\]\s+(\{.*\})/);
            if (!line) throw new GeneratorFailedError('cpp', `the mesh edit pipeline reported no result. ${stdout.slice(-1500)}`);
            const r = JSON.parse(line[1]);
            if (r.status !== 'success' || !fs.existsSync(outputGlbPath)) {
                throw new GeneratorFailedError('cpp', `the mesh edit pipeline reported ${r.status} and ${fs.existsSync(outputGlbPath) ? 'a' : 'no'} GLB`);
            }
            // the writer's stock material replaced with the input's own (clay stays clay)
            carryOverInputMaterial(glbBytes, outputGlbPath);
            return {
                outputGlbPath, inputTriangles: r.inputTriangles, outputTriangles: r.outputTriangles, outputVertices: r.outputVertices,
                openEdges: r.openEdges, boundsMin: r.boundsMin, boundsMax: r.boundsMax, processingTimeMs: r.processingTimeMs, operations: r.operations
            };
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    }
}
