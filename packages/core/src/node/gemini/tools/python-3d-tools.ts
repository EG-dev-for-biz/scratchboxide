/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Python 3D Procedural Scripting Tools
 * Exposes NativePythonRunnerService to Gemini agents, allowing Blender-style
 * procedural Python scripting (import scratchbox as sb) backed by native C++20
 * Astra engine nanobind bindings to stream binary .glb directly into the viewport.
 ********************************************************************************/

import type { ToolDeclaration, ToolHandlerOutcome } from './types';
import { NativePythonRunnerService } from '../../3d-engine/native-python-runner-service';

export const PYTHON_3D_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'execute_3d_python_script',
        description: 'Executes a procedural Python 3 script using the Scratchbox 3D Engine (import scratchbox as sb). Follows a Blender-style procedural mental model to generate 3D architecture (mansard roofs, townhouses, facades), nature (space colonization trees, foliage), and procedural geometry (pedestals, primitives, custom meshes), streaming a valid binary glTF 2.0 (.glb) directly into the Three.js viewport.',
        parameters: {
            type: 'OBJECT',
            properties: {
                script: {
                    type: 'STRING',
                    description: 'The procedural Python 3 script. Must import scratchbox as sb and write the resulting scene to OUTPUT_GLB_PATH via sb.io.write_glb(OUTPUT_GLB_PATH, scene).'
                },
                description: {
                    type: 'STRING',
                    description: 'Optional human-readable description of the 3D scene or asset being generated.'
                },
                timeoutMs: {
                    type: 'NUMBER',
                    description: 'Execution timeout in milliseconds (default 30000).'
                }
            },
            required: ['script']
        }
    }
];

export const python3DHandlers: Record<string, (args: Record<string, unknown>) => Promise<ToolHandlerOutcome>> = {
    execute_3d_python_script: async (args: Record<string, unknown>): Promise<ToolHandlerOutcome> => {
        const script = typeof args.script === 'string' ? args.script : '';
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30000;

        if (!script.trim()) {
            return {
                status: 'failed',
                resultPayload: {
                    success: false,
                    error: 'Empty script provided. Must provide a valid Python script importing scratchbox.'
                },
                summaryResult: 'Failed: script argument was empty.'
            };
        }

        const runner = NativePythonRunnerService.getInstance();
        const result = await runner.runScript(script, { timeoutMs });

        if (!result.success) {
            return {
                status: 'failed',
                resultPayload: {
                    success: false,
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    errorDetails: result.errorDetails,
                    executionTimeMs: result.executionTimeMs
                },
                summaryResult: `Python 3D execution failed: ${result.errorDetails || result.stderr || 'Non-zero exit code'}`
            };
        }

        return {
            status: 'completed',
            resultPayload: {
                success: true,
                glbPath: result.glbPath,
                glbBase64: result.glbBase64,
                executionTimeMs: result.executionTimeMs,
                stdout: result.stdout,
                description: args.description || 'Procedural 3D Python Scene'
            },
            summaryResult: `Successfully generated 3D GLB via Python (${result.executionTimeMs}ms). GLB written to ${result.glbPath}.`
        };
    }
};
