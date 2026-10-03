import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { ProjectContextGraphService } from '../src/node/project-context-graph-service';

async function runSemanticSymbolGraphTestSuite() {
    console.log('🧪 Running Semantic Codebase Indexing & Symbol Graph Retrieval Test Suite...');

    const contextGraph = new ProjectContextGraphService();

    // =========================================================================
    // SECTION 1: TypeScript AST Symbol Extraction
    // =========================================================================
    console.log('\n--- Section 1: TypeScript AST Symbol Extraction ---');

    const sampleTsCode = `
import { ILogger } from '@scratchbox/core';

/**
 * Coordinate spatial point in 3D frame.
 */
export interface SpatialCoordinate {
    x: number;
    y: number;
    z: number;
}

export type TransformMatrix = number[][];

export enum ProjectionMode {
    PERSPECTIVE = 'perspective',
    ORTHOGRAPHIC = 'orthographic'
}

/**
 * Calculates euclidean distance between two 3D spatial points.
 */
export function calculateEuclideanDistance(p1: SpatialCoordinate, p2: SpatialCoordinate): number {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dz = p1.z - p2.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class SpatialRendererEngine {
    private activeMode: ProjectionMode = ProjectionMode.PERSPECTIVE;

    constructor(private logger: ILogger) {}

    /**
     * Render the 3D scene.
     */
    public renderScene(coords: SpatialCoordinate[]): boolean {
        this.logger.info('Rendering scene with coords: ' + coords.length);
        return true;
    }
}
`;

    const symbols = contextGraph.indexSourceFile('src/spatial/spatial-renderer.ts', sampleTsCode, 'typescript');

    assert.ok(symbols.length >= 6, `Expected at least 6 extracted symbols, got ${symbols.length}`);

    const ifaceSym = symbols.find(s => s.name === 'SpatialCoordinate');
    assert.ok(ifaceSym, 'Should extract SpatialCoordinate interface');
    assert.strictEqual(ifaceSym?.kind, 'interface');
    assert.strictEqual(ifaceSym?.exported, true);
    assert.ok(ifaceSym?.docstring?.includes('Coordinate spatial point'));

    const typeSym = symbols.find(s => s.name === 'TransformMatrix');
    assert.ok(typeSym, 'Should extract TransformMatrix type alias');
    assert.strictEqual(typeSym?.kind, 'type');

    const enumSym = symbols.find(s => s.name === 'ProjectionMode');
    assert.ok(enumSym, 'Should extract ProjectionMode enum');
    assert.strictEqual(enumSym?.kind, 'enum');

    const fnSym = symbols.find(s => s.name === 'calculateEuclideanDistance');
    assert.ok(fnSym, 'Should extract calculateEuclideanDistance function');
    assert.strictEqual(fnSym?.kind, 'function');
    assert.ok(fnSym?.signature?.includes('SpatialCoordinate'));
    assert.ok(fnSym?.docstring?.includes('Calculates euclidean distance'));

    const classSym = symbols.find(s => s.name === 'SpatialRendererEngine');
    assert.ok(classSym, 'Should extract SpatialRendererEngine class');
    assert.strictEqual(classSym?.kind, 'class');

    const methodSym = symbols.find(s => s.name === 'SpatialRendererEngine.renderScene');
    assert.ok(methodSym, 'Should extract SpatialRendererEngine.renderScene method');
    assert.strictEqual(methodSym?.kind, 'method');
    assert.strictEqual(methodSym?.containerName, 'SpatialRendererEngine');

    console.log('  ✓ Test 1.1 Passed: TypeScript AST accurately extracts interfaces, types, enums, functions, classes, and methods with docstrings');

    // =========================================================================
    // SECTION 2: Multi-Language Symbol Extraction (Python, Rust, Go)
    // =========================================================================
    console.log('\n--- Section 2: Multi-Language Symbol Extraction ---');

    const samplePyCode = `
class NeuralVisionNetwork:
    """Convolutional neural network for image recognition."""
    def __init__(self, layers=10):
        self.layers = layers

def train_model(dataset, epochs=50):
    return {"accuracy": 0.98}
`;
    const pySymbols = contextGraph.indexSourceFile('scripts/vision.py', samplePyCode, 'python');
    assert.ok(pySymbols.some(s => s.name === 'NeuralVisionNetwork' && s.kind === 'class'));
    assert.ok(pySymbols.some(s => s.name === 'train_model' && s.kind === 'function'));
    console.log('  ✓ Test 2.1 Passed: Python classes and functions indexed correctly');

    const sampleRustCode = `
pub struct RayTracer {
    pub width: u32,
    pub height: u32,
}

pub fn render_frame(tracer: &RayTracer) -> Vec<u8> {
    vec![0; 100]
}
`;
    const rustSymbols = contextGraph.indexSourceFile('native/tracer.rs', sampleRustCode, 'rust');
    assert.ok(rustSymbols.some(s => s.name === 'RayTracer' && (s.kind === 'class' || s.kind === 'interface')));
    assert.ok(rustSymbols.some(s => s.name === 'render_frame' && s.kind === 'function'));
    console.log('  ✓ Test 2.2 Passed: Rust structs and functions indexed correctly');

    const sampleGoCode = `
type AudioSynthesizer struct {
    SampleRate int
}

func SynthesizeVoice(pitch float64) []byte {
    return nil
}
`;
    const goSymbols = contextGraph.indexSourceFile('audio/synth.go', sampleGoCode, 'go');
    assert.ok(goSymbols.some(s => s.name === 'AudioSynthesizer' && s.kind === 'class'));
    assert.ok(goSymbols.some(s => s.name === 'SynthesizeVoice' && s.kind === 'function'));
    console.log('  ✓ Test 2.3 Passed: Go structs and functions indexed correctly');

    // =========================================================================
    // SECTION 3: Semantic Relevance Scoring & Graph Retrieval
    // =========================================================================
    console.log('\n--- Section 3: Semantic Relevance Scoring & Graph Retrieval ---');

    const queryResult1 = contextGraph.retrieveSymbolGraph({
        query: 'calculate distance between spatial points',
        maxSymbols: 5
    });

    assert.ok(queryResult1.matchingSymbols.length > 0, 'Should return matching symbols');
    assert.strictEqual(queryResult1.matchingSymbols[0].name, 'calculateEuclideanDistance', 'calculateEuclideanDistance should rank #1 for spatial distance query');
    assert.ok(queryResult1.relevanceScores['calculateEuclideanDistance'] > 5.0, 'Relevance score should be significant');
    assert.ok(queryResult1.compressedPromptContext.includes('calculateEuclideanDistance'));
    console.log('  ✓ Test 3.1 Passed: Semantic relevance scoring correctly ranks top matching symbols based on query intent');

    // Test topological subgraph expansion
    const queryResult2 = contextGraph.retrieveSymbolGraph({
        query: 'SpatialRendererEngine renderScene',
        maxSymbols: 5
    });
    assert.ok(queryResult2.matchingSymbols.some(s => s.name.includes('SpatialRendererEngine')));
    assert.ok(queryResult2.referencedFiles.includes('src/spatial/spatial-renderer.ts'));
    console.log('  ✓ Test 3.2 Passed: Graph retrieval traverses edges and extracts referenced files');

    // =========================================================================
    // SECTION 4: Recursive Workspace Directory Indexing
    // =========================================================================
    console.log('\n--- Section 4: Recursive Workspace Directory Indexing ---');

    const tempDir = path.join(os.tmpdir(), `scratchbox-sym-test-${Date.now()}`);
    await fs.ensureDir(path.join(tempDir, 'src', 'components'));
    await fs.ensureDir(path.join(tempDir, 'src', 'utils'));

    await fs.writeFile(
        path.join(tempDir, 'src', 'components', 'Button.tsx'),
        `export interface ButtonProps { label: string; onClick?: () => void; }
export const Button: React.FC<ButtonProps> = (props) => <button>{props.label}</button>;`
    );

    await fs.writeFile(
        path.join(tempDir, 'src', 'utils', 'formatter.ts'),
        `/** Formats currency amounts */
export function formatCurrency(amount: number, currency: string = 'USD'): string {
    return currency + amount.toFixed(2);
}`
    );

    const indexedCount = await contextGraph.indexWorkspaceDirectory(tempDir);
    assert.strictEqual(indexedCount, 2, 'Should index 2 files in directory');

    const currencyQuery = contextGraph.retrieveSymbolGraph('format currency amount USD');
    assert.ok(currencyQuery.matchingSymbols.some(s => s.name === 'formatCurrency'));

    await fs.remove(tempDir);
    console.log('  ✓ Test 4.1 Passed: Recursive directory indexing successfully indexed workspace files and made symbols retrievable');

    console.log('\n🎉 ALL SEMANTIC SYMBOL GRAPH RETRIEVAL TESTS PASSED SUCCESSFULLY!');
}

test('semantic-symbol-graph.test', async () => {
    await runSemanticSymbolGraphTestSuite();
}, 180_000);
