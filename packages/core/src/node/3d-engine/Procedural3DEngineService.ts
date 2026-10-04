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
import * as os from 'os';
import { NativePythonRunnerService, PythonExecutionResult } from './native-python-runner-service';
import { ProceduralAstGuard, AstGuardValidationResult } from './ProceduralAstGuard';

export interface Procedural3DExecutionOptions {
  seed?: number;
  timeoutMs?: number;
  outputGlbPath?: string;
  skipAstGuard?: boolean;
}

export interface ProceduralMeshStats {
  vertexCount: number;
  triangleCount: number;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

export interface Procedural3DExecutionResult {
  success: boolean;
  glbBuffer?: Buffer;
  glbPath?: string;
  vertexCount?: number;
  triangleCount?: number;
  meshStats?: ProceduralMeshStats;
  aabb?: {
    min: [number, number, number];
    max: [number, number, number];
    dimensions: [number, number, number];
    center: [number, number, number];
  };
  extractedParameters: Record<string, any>;
  astAudit: AstGuardValidationResult;
  executionMs: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export type ProceduralExecutionOptions = Procedural3DExecutionOptions;
export type ProceduralExecutionResult = Procedural3DExecutionResult;

/**
 * Service orchestrating Layer 1 (AST Guard) -> Layer 2 (Agentic DSL) ->
 * Layer 3 (Pre-compiled C++20 Invariant Kernel) -> glTF 2.0 Binary RAM Streaming.
 */
export class Procedural3DEngineService {
  private static instance: Procedural3DEngineService;
  private pythonRunner: NativePythonRunnerService;

  private constructor() {
    this.pythonRunner = NativePythonRunnerService.getInstance();
  }

  public static getInstance(): Procedural3DEngineService {
    if (!Procedural3DEngineService.instance) {
      Procedural3DEngineService.instance = new Procedural3DEngineService();
    }
    return Procedural3DEngineService.instance;
  }

  /**
   * Executes a high-level procedural script against the Scratchbox C++20 invariant kernel.
   */
  public async executeScript(
    script: string,
    options: Procedural3DExecutionOptions = {}
  ): Promise<Procedural3DExecutionResult> {
    const startTime = Date.now();

    // 1. Layer 1: AST Pre-flight Guard
    const astAudit = ProceduralAstGuard.validateScript(script);
    if (!options.skipAstGuard && !astAudit.valid) {
      return {
        success: false,
        error: `AST Guard Violation: ${astAudit.errors.join('; ')}`,
        astAudit,
        extractedParameters: astAudit.extractedParameters,
        executionMs: Date.now() - startTime,
        stdout: '',
        stderr: astAudit.errors.join('\n')
      };
    }

    // 2. Prepare ephemeral output GLB path if not specified
    const tempDir = os.tmpdir();
    const targetGlbPath = options.outputGlbPath || path.join(tempDir, `sb_proc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.glb`);

    // 3. Inject standard export footer if the script doesn't explicitly save to disk
    let runnableScript = script;
    if (!script.includes('compile_to_glb(') && !script.includes('world.compile_to_glb')) {
      runnableScript += `\n\nif 'world' in locals():\n    world.compile_to_glb("${targetGlbPath}")\n`;
    }

    const env: Record<string, string> = {
      OUTPUT_GLB_PATH: targetGlbPath,
      SCRATCHBOX_OUTPUT_GLB: targetGlbPath,
      PYTHONUNBUFFERED: '1'
    };

    // Ensure packages/core/src/python is in PYTHONPATH
    const pythonSrcDir = path.resolve(__dirname, '..', '..', 'python');
    const nativeBuildDir = path.resolve(__dirname, '..', '..', 'native', '3d-engine', 'build_py');
    const existingPythonPath = process.env.PYTHONPATH || '';
    env.PYTHONPATH = [pythonSrcDir, nativeBuildDir, existingPythonPath].filter(Boolean).join(path.delimiter);

    let pyResult: PythonExecutionResult;
    try {
      pyResult = await this.pythonRunner.runScript(runnableScript, {
        timeoutMs: options.timeoutMs || 30000,
        outputGlbPath: targetGlbPath,
        env
      });
    } catch (err: any) {
      return {
        success: false,
        error: `Python execution fault: ${err.message}`,
        astAudit,
        extractedParameters: astAudit.extractedParameters,
        executionMs: Date.now() - startTime,
        stdout: '',
        stderr: err.message
      };
    }

    if (!pyResult.success) {
      return {
        success: false,
        error: pyResult.stderr || pyResult.errorDetails || 'Execution failed',
        astAudit,
        extractedParameters: astAudit.extractedParameters,
        executionMs: Date.now() - startTime,
        stdout: pyResult.stdout,
        stderr: pyResult.stderr
      };
    }

    // 4. Ingest and validate binary glTF 2.0 (.glb)
    const resolvedGlbPath = fs.existsSync(targetGlbPath)
      ? targetGlbPath
      : (pyResult.glbPath && fs.existsSync(pyResult.glbPath) ? pyResult.glbPath : undefined);

    if (!resolvedGlbPath) {
      return {
        success: false,
        error: `Expected glTF output not found at ${targetGlbPath}`,
        astAudit,
        extractedParameters: astAudit.extractedParameters,
        executionMs: Date.now() - startTime,
        stdout: pyResult.stdout,
        stderr: pyResult.stderr
      };
    }

    const glbBuffer = fs.readFileSync(resolvedGlbPath);
    const parsedStats = this.parseGlbHeaderAndStats(glbBuffer);

    return {
      success: true,
      glbBuffer,
      glbPath: resolvedGlbPath,
      vertexCount: parsedStats.vertexCount,
      triangleCount: parsedStats.triangleCount,
      meshStats: {
        vertexCount: parsedStats.vertexCount,
        triangleCount: parsedStats.triangleCount,
        bounds: {
          min: parsedStats.aabb.min,
          max: parsedStats.aabb.max
        }
      },
      aabb: parsedStats.aabb,
      extractedParameters: astAudit.extractedParameters,
      astAudit,
      executionMs: Date.now() - startTime,
      stdout: pyResult.stdout,
      stderr: pyResult.stderr
    };
  }

  /**
   * Parses glTF 2.0 binary chunks to extract mesh statistics and AABB bounding envelope.
   */
  private parseGlbHeaderAndStats(buffer: Buffer): {
    vertexCount: number;
    triangleCount: number;
    aabb: {
      min: [number, number, number];
      max: [number, number, number];
      dimensions: [number, number, number];
      center: [number, number, number];
    };
  } {
    if (buffer.length < 20) {
      throw new Error('Invalid glTF buffer: file too small');
    }

    // Validate glTF magic 0x46546C67 ("glTF")
    const magic = buffer.readUInt32LE(0);
    if (magic !== 0x46546C67) {
      throw new Error(`Invalid glTF magic: 0x${magic.toString(16)}, expected 0x46546C67`);
    }

    const version = buffer.readUInt32LE(4);
    const jsonChunkLength = buffer.readUInt32LE(12);
    const jsonChunkType = buffer.readUInt32LE(16);

    let vertexCount = 0;
    let triangleCount = 0;
    let minBounds: [number, number, number] = [Infinity, Infinity, Infinity];
    let maxBounds: [number, number, number] = [-Infinity, -Infinity, -Infinity];

    try {
      const jsonStr = buffer.toString('utf8', 20, 20 + jsonChunkLength);
      const gltf = JSON.parse(jsonStr);

      if (gltf.accessors && Array.isArray(gltf.accessors)) {
        for (const acc of gltf.accessors) {
          if (acc.type === 'VEC3' && acc.min && acc.max) {
            minBounds[0] = Math.min(minBounds[0], acc.min[0]);
            minBounds[1] = Math.min(minBounds[1], acc.min[1]);
            minBounds[2] = Math.min(minBounds[2], acc.min[2]);

            maxBounds[0] = Math.max(maxBounds[0], acc.max[0]);
            maxBounds[1] = Math.max(maxBounds[1], acc.max[1]);
            maxBounds[2] = Math.max(maxBounds[2], acc.max[2]);
          }
        }
      }

      if (gltf.meshes && Array.isArray(gltf.meshes)) {
        for (const mesh of gltf.meshes) {
          if (mesh.primitives && Array.isArray(mesh.primitives)) {
            for (const prim of mesh.primitives) {
              if (prim.attributes && prim.attributes.POSITION !== undefined) {
                const posAcc = gltf.accessors[prim.attributes.POSITION];
                if (posAcc && posAcc.count) {
                  vertexCount += posAcc.count;
                }
              }
              if (prim.indices !== undefined) {
                const indAcc = gltf.accessors[prim.indices];
                if (indAcc && indAcc.count) {
                  triangleCount += Math.floor(indAcc.count / 3);
                }
              }
            }
          }
        }
      }
    } catch {
      // Fallback
    }

    if (!isFinite(minBounds[0])) {
      minBounds = [-10, 0, -10];
      maxBounds = [10, 10, 10];
    }

    const dimensions: [number, number, number] = [
      maxBounds[0] - minBounds[0],
      maxBounds[1] - minBounds[1],
      maxBounds[2] - minBounds[2]
    ];

    const center: [number, number, number] = [
      (minBounds[0] + maxBounds[0]) * 0.5,
      (minBounds[1] + maxBounds[1]) * 0.5,
      (minBounds[2] + maxBounds[2]) * 0.5
    ];

    return {
      vertexCount,
      triangleCount,
      aabb: {
        min: minBounds,
        max: maxBounds,
        dimensions,
        center
      }
    };
  }
}
