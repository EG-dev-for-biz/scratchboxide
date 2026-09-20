/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/
import type { GeminiGenerateRequest, GroundingMetadata } from '../../common/gemini-protocol';
import type {
    CanvasArtifact,
    CitationItem,
    CodeFileTab,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    MarkdownSection,
    McpExecutionState,
    PrimitiveType,
    SandboxTemplate,
    Scene3DData
} from '../../browser/generative-canvas/canvas-types';
import {
    synthesizeComprehensiveDocument as synthesizeDocumentFromEngine,
    ensureCompleteSections,
    synthesizeMediaDocument
} from '../../browser/generative-canvas/document-synthesis-engine';
import { synthesizeContextual3DScene } from '../../browser/generative-canvas/procedural-3d-synthesizer';
import type { VideoTimelineData } from '../../browser/generative-canvas/services/video/videoTypes';
import { synthesizeContextualVideoTimeline } from '../../browser/generative-canvas/services/video/videoTimelineSynthesizer';
import {
    classifyDomain,
    extractPromptEntities,
    synthesizeAdaptiveKanban,
    synthesizeAdaptiveNodeGraph,
    synthesizeAdaptiveMetrics,
    synthesizeAdaptiveSandbox
} from '../../browser/generative-canvas/services/adaptive-domain-engine';
export { synthesizeContextualVideoTimeline };

type CustomMesh = NonNullable<Scene3DData['customMeshes']>[number];

/** Neutral default attribution for synthesized documents. */
export const DEFAULT_DOCUMENT_AUTHOR = 'Scratchbox Studio';

export interface ExtractedScratchboxTag {
    matched: boolean;
    type?: string;
    title?: string;
    summary?: string;
    version?: number;
    rawPayload?: string;
    cleanText?: string;
}

/**
 * Parses canonical <scratchboxPrimitive type="..." title="..." summary="..." version="..."> tags
 * from model output, providing zero-overhead, deterministic artifact extraction without fragile regex heuristics.
 */
export function extractScratchboxPrimitiveTag(modelText: string): ExtractedScratchboxTag {
    if (!modelText || typeof modelText !== 'string') {
        return { matched: false };
    }
    const tagRegex = /<scratchboxPrimitive\s+([^>]*?)>([\s\S]*?)(?:<\/scratchboxPrimitive>|$)/i;
    const match = modelText.match(tagRegex);
    if (!match) {
        return { matched: false };
    }

    const attrStr = match[1];
    const rawPayload = match[2].trim();

    // Parse attributes
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
        attrs[attrMatch[1].toLowerCase()] = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
    }

    const rawType = (attrs.type || '').trim().toLowerCase();
    let normalizedType = rawType;
    if (normalizedType === 'action-checklist') normalizedType = 'checklist';
    if (normalizedType === 'skills-manager') normalizedType = 'skills-hub';
    if (normalizedType === 'rendered-document' || normalizedType === 'document' || normalizedType === 'doc') normalizedType = 'markdown-document';
    if (normalizedType === 'flow-graph' || normalizedType === 'graph') normalizedType = 'node-graph';
    if (normalizedType === 'metrics' || normalizedType === 'dashboard') normalizedType = 'metric-dashboard';
    if (normalizedType === 'kanban') normalizedType = 'kanban-board';
    if (normalizedType === 'form') normalizedType = 'interactive-form';
    if (normalizedType === 'sandbox' || normalizedType === 'code-sandbox' || normalizedType === 'playground' || normalizedType === 'code-playground') normalizedType = 'live-code-sandbox';
    if (normalizedType === '3d' || normalizedType === 'scene-3d' || normalizedType === 'spatial-scene' || normalizedType === '3d_scene' || normalizedType === '3d-world' || normalizedType === 'r3f-scene') normalizedType = '3d-scene';
    if (normalizedType === 'video-timeline' || normalizedType === 'video' || normalizedType === 'timeline' || normalizedType === 'video-editor' || normalizedType === 'nle' || normalizedType === 'video_timeline') normalizedType = 'video-timeline';

    const cleanText = modelText.replace(/<scratchboxPrimitive[\s\S]*?(?:<\/scratchboxPrimitive>|$)/gi, '').trim();

    return {
        matched: true,
        type: normalizedType || undefined,
        title: attrs.title || undefined,
        summary: attrs.summary || undefined,
        version: attrs.version ? parseInt(attrs.version, 10) : 1,
        rawPayload,
        cleanText
    };
}

/**
 * Convert markdown string to structured MarkdownSection items.
 */
export function markdownStringToSections(md: string): MarkdownSection[] {
    const lines = md.split('\n');
    const sections: MarkdownSection[] = [];
    let currentParagraph: string[] = [];
    let inTable = false;
    let tableHeaders: string[] = [];
    let tableRows: string[][] = [];
    let currentChecklist: Array<{ id: string; text: string; done: boolean }> = [];
    let inCodeBlock = false;
    let codeLanguage = '';
    let codeLines: string[] = [];

    const flushParagraph = () => {
        if (currentParagraph.length > 0) {
            const firstLine = currentParagraph[0].trim();
            // Check for explicit GitHub/Markdown style callout syntax on first line: > [!NOTE], > [!TIP], > [!INFO], > [!WARNING], > [!IMPORTANT]
            const calloutMatch = firstLine.match(/^>\s*\[!(NOTE|TIP|INFO|WARNING|IMPORTANT|CAUTION)\](?:\s+(.+))?$/i);

            if (calloutMatch) {
                const rawType = calloutMatch[1].toLowerCase();
                let calloutType: 'info' | 'tip' | 'warning' = 'info';
                if (rawType === 'tip') calloutType = 'tip';
                else if (rawType === 'warning' || rawType === 'caution' || rawType === 'important') calloutType = 'warning';

                const rawTitle = calloutMatch[2] ? calloutMatch[2].replace(/^[-:\s]+/, '').trim() : '';
                const defaultTitle = rawType.charAt(0).toUpperCase() + rawType.slice(1);
                const calloutTitle = rawTitle || defaultTitle;

                const bodyLines = currentParagraph.slice(1).map(l => l.replace(/^>\s*/, '').trim()).filter(Boolean);
                const calloutBody = bodyLines.join(' ').trim();

                sections.push({
                    id: `sec-callout-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    type: 'callout',
                    calloutType,
                    calloutTitle,
                    content: calloutBody || calloutTitle
                });
            } else if (firstLine.startsWith('>')) {
                // Check if blockquote has a bold title prefix like: > **Primary Source Callout:** ... or > **Key Insight**: ...
                const cleanQuote = currentParagraph.map(l => l.replace(/^>\s*/, '').trim()).join(' ').trim();
                const boldCalloutMatch = cleanQuote.match(/^\*\*([^*:]+?)(?:\s*Callout)?:\*\*\s*([\s\S]*)$/i);
                if (boldCalloutMatch) {
                    const calloutTitle = boldCalloutMatch[1].trim();
                    const calloutBody = boldCalloutMatch[2].trim() || cleanQuote;
                    sections.push({
                        id: `sec-callout-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'callout',
                        calloutType: 'info',
                        calloutTitle,
                        content: calloutBody
                    });
                } else if (cleanQuote) {
                    sections.push({
                        id: `sec-quote-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'quote',
                        content: cleanQuote
                    });
                }
            } else {
                // Standard rich paragraph (NOT converted to callouts)
                const text = currentParagraph.join(' ').trim();
                if (text) {
                    sections.push({
                        id: `sec-p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'paragraph',
                        content: text
                    });
                }
            }
            currentParagraph = [];
        }
    };

    const flushTable = () => {
        if (inTable && tableHeaders.length > 0) {
            sections.push({
                id: `sec-tbl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: 'table',
                tableHeaders,
                tableRows
            });
            tableHeaders = [];
            tableRows = [];
            inTable = false;
        }
    };

    const flushChecklist = () => {
        if (currentChecklist.length > 0) {
            sections.push({
                id: `sec-chk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: 'checklist',
                checklistItems: currentChecklist
            });
            currentChecklist = [];
        }
    };

    const flushCodeBlock = () => {
        if (inCodeBlock) {
            sections.push({
                id: `sec-code-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: 'code',
                codeLanguage: codeLanguage || 'typescript',
                content: codeLines.join('\n')
            });
            codeLines = [];
            codeLanguage = '';
            inCodeBlock = false;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Handle fenced code blocks
        if (trimmed.startsWith('```')) {
            if (inCodeBlock) {
                flushCodeBlock();
            } else {
                flushParagraph();
                flushTable();
                flushChecklist();
                inCodeBlock = true;
                codeLanguage = trimmed.slice(3).trim();
                codeLines = [];
            }
            continue;
        }

        if (inCodeBlock) {
            codeLines.push(line);
            continue;
        }

        // Headings (#, ##, ###, ####, etc.)
        if (trimmed.startsWith('#')) {
            flushParagraph();
            flushTable();
            flushChecklist();
            const levelMatch = trimmed.match(/^(#{1,6})\s*(.*)$/);
            if (levelMatch) {
                const level = Math.min(3, Math.max(1, levelMatch[1].length)) as (1 | 2 | 3);
                const headingContent = levelMatch[2].trim();
                if (headingContent) {
                    sections.push({
                        id: `sec-h${level}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'heading',
                        level,
                        content: headingContent
                    });
                }
            }
        }
        // Checklist items (- [ ] or - [x] or * [ ] or * [x])
        else if (/^[-*]\s+\[([ xX])\]\s+(.+)$/.test(trimmed)) {
            flushParagraph();
            flushTable();
            const checkMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
            if (checkMatch) {
                const done = checkMatch[1].toLowerCase() === 'x';
                const text = checkMatch[2].trim();
                currentChecklist.push({
                    id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    text,
                    done
                });
            }
        }
        // Tables (| col 1 | col 2 |)
        else if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
            flushParagraph();
            flushChecklist();
            const cells = trimmed
                .split('|')
                .map(c => c.trim())
                .filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);

            if (cells.every(c => /^:?-+:?$/.test(c))) {
                // separator line
                inTable = true;
            } else if (!inTable && tableHeaders.length === 0) {
                tableHeaders = cells;
            } else {
                inTable = true;
                tableRows.push(cells);
            }
        }
        // Explicit callout header line (e.g. > [!NOTE] or > [!TIP])
        else if (/^>\s*\[!(NOTE|TIP|INFO|WARNING|IMPORTANT|CAUTION)\]/i.test(trimmed)) {
            flushParagraph();
            flushTable();
            flushChecklist();
            currentParagraph.push(trimmed);
        }
        // Blank lines flush active paragraph/table/checklist
        else if (trimmed === '') {
            flushParagraph();
            flushTable();
            flushChecklist();
        } else {
            if (inTable) {
                flushTable();
            }
            if (currentChecklist.length > 0) {
                flushChecklist();
            }
            currentParagraph.push(trimmed);
        }
    }

    flushParagraph();
    flushTable();
    flushChecklist();
    flushCodeBlock();

    return sections.length > 0
        ? sections
        : [
              {
                  id: `sec-default`,
                  type: 'paragraph',
                  content: md.slice(0, 2000)
              }
          ];
}

/**
 * Detects whether the prompt or title indicates a 3D procedural/mesh/engine studio request.
 */
export function is3DStudioIntent(prompt: string, title: string): boolean {
    const lower = (prompt + ' ' + title).toLowerCase();
    return lower.includes('3d') || lower.includes('mesh') || lower.includes('terrain') ||
        lower.includes('procedural') || lower.includes('marching cubes') ||
        lower.includes('sdf') || lower.includes('cpp') || lower.includes('c++') ||
        lower.includes('glb') || lower.includes('gltf') || lower.includes('three');
}

/**
 * Generates modern C++20 procedural world generator code adhering to AGENTS.md directives.
 */
export function generateNativeCppGenerator(title: string): string {
    return `// ==============================================================================
// Scratchbox Native 3D Engine — Procedural World Generator (C++20)
// Module: ${title}
// Compiler: Apple Clang (-std=c++20 -O3 -march=native -ffast-math)
// Target: Binary glTF 2.0 (.glb) direct streaming to Three.js viewport
// ==============================================================================

#include "scratchbox_engine.hpp"
#include "scratchbox_math.hpp"
#include <iostream>
#include <vector>
#include <cmath>

using namespace scratchbox;

// Signed Distance Field (SDF) definition combining smooth noise and geometry primitives
struct ProceduralTerrainSDF {
    float frequency = 0.08f;
    float amplitude = 4.5f;
    int octaves = 5;
    float roughness = 0.45f;
    float lacunarity = 2.0f;

    // Evaluates Signed Distance Function at world coordinate p (SIMD Vec3f)
    inline float evaluate(const Vec3f& p) const {
        // Base planar distance: y = 0
        float baseDist = p.y;
        
        // Fractal Brownian Motion (FBM) with SIMD vector evaluation
        float noiseVal = 0.0f;
        float freq = frequency;
        float amp = amplitude;
        for (int i = 0; i < octaves; ++i) {
            noiseVal += FastNoise3D::Simplex(p.x * freq, p.z * freq, 0.42f) * amp;
            freq *= lacunarity;
            amp *= 0.5f;
        }

        // Combine SDF terrain displacement with smooth sphere bounds
        float sphereBound = SDF::Sphere(p - Vec3f(0.0f, 0.0f, 0.0f), 24.0f);
        float terrainSurface = baseDist - noiseVal;
        return SDF::SmoothUnion(terrainSurface, sphereBound * 0.15f, 1.2f);
    }
};

int main(int argc, char** argv) {
    std::cout << "[Scratchbox Engine] Initializing Native C++20 Mesh Studio..." << std::endl;

    ProceduralTerrainSDF terrain;
    MarchingCubesVolume volume(Vec3i(48, 32, 48), Vec3f(-12.0f, -4.0f, -12.0f), Vec3f(12.0f, 12.0f, 12.0f));

    // Polygonize volumetric SDF with SIMD Marching Cubes
    MeshGeometry mesh = volume.Polygonize([&](const Vec3f& pos) {
        return terrain.evaluate(pos);
    });

    // Compute analytic surface normals & vertex colors (COLOR_0)
    mesh.ComputeSmoothNormals();
    mesh.GenerateProceduralColors([](const Vec3f& pos, const Vec3f& normal) {
        // Biome gradient: grass / rock / snow based on elevation and slope
        float slope = 1.0f - normal.y;
        if (pos.y > 6.0f) return Vec4f(0.95f, 0.95f, 0.98f, 1.0f); // Snow
        if (slope > 0.45f) return Vec4f(0.45f, 0.42f, 0.38f, 1.0f); // Cliff Rock
        return Vec4f(0.18f, 0.55f, 0.24f, 1.0f); // Lush Meadow
    });

    // Setup PBR Metallic-Roughness Material
    PBRMaterial material;
    material.metallic = 0.1f;
    material.roughness = terrain.roughness;
    material.name = "Scratchbox_PBR_Terrain";

    // Encode and stream binary glTF 2.0 (.glb) to stdout / output buffer
    GLBOutputStream glbStream;
    glbStream.AppendMesh("ProceduralMesh", mesh, material);
    glbStream.Emit();

    std::cout << "[Scratchbox Engine] glTF 2.0 streaming complete. Triangles: " 
              << mesh.triangleCount() << std::endl;
    return 0;
}
`;
}

/**
 * Generates Controls.tsx parameter panel for the 3D Studio.
 */
export function generate3DControls(): string {
    return `import React from 'react';
import { Sliders, RefreshCw, Wand2, Download, CheckCircle2 } from 'lucide-react';

interface ControlsProps {
  octaves: number;
  setOctaves: (v: number) => void;
  frequency: number;
  setFrequency: (v: number) => void;
  roughness: number;
  setRoughness: (v: number) => void;
  onRecompile: () => void;
  isCompiling: boolean;
}

export default function Controls({
  octaves,
  setOctaves,
  frequency,
  setFrequency,
  roughness,
  setRoughness,
  onRecompile,
  isCompiling
}: ControlsProps) {
  const [exported, setExported] = React.useState(false);

  const handleExportState = async () => {
    if (window.scratchbox && window.scratchbox.storage) {
      await window.scratchbox.storage.exportState({ octaves, frequency, roughness, timestamp: Date.now() });
      setExported(true);
      setTimeout(() => setExported(false), 2000);
    }
  };

  const handleAiRefine = () => {
    if (window.scratchbox && window.scratchbox.ai) {
      window.scratchbox.ai.refine('Add volcanic crater SDF and Worley noise ridges to world_generator.cpp with octaves=' + octaves);
    }
  };

  return (
    <div className="w-80 h-full bg-zinc-900/95 border-l border-zinc-800/80 p-5 flex flex-col justify-between backdrop-blur-xl shadow-2xl z-20">
      <div className="space-y-6">
        <div className="flex items-center gap-2 pb-3 border-b border-zinc-800">
          <Sliders className="w-4 h-4 text-blue-400" />
          <h2 className="text-sm font-bold text-white tracking-wide">Engine Parameters</h2>
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-xs text-zinc-400 mb-1.5">
              <span>SDF Noise Octaves</span>
              <span className="font-mono text-zinc-200">{octaves}</span>
            </div>
            <input
              type="range"
              min="1"
              max="8"
              step="1"
              value={octaves}
              onChange={e => setOctaves(parseInt(e.target.value))}
              className="w-full accent-blue-500 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs text-zinc-400 mb-1.5">
              <span>Spatial Frequency</span>
              <span className="font-mono text-zinc-200">{frequency.toFixed(3)}</span>
            </div>
            <input
              type="range"
              min="0.01"
              max="0.25"
              step="0.005"
              value={frequency}
              onChange={e => setFrequency(parseFloat(e.target.value))}
              className="w-full accent-cyan-500 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs text-zinc-400 mb-1.5">
              <span>Material Roughness</span>
              <span className="font-mono text-zinc-200">{roughness.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="1.0"
              step="0.05"
              value={roughness}
              onChange={e => setRoughness(parseFloat(e.target.value))}
              className="w-full accent-emerald-500 cursor-pointer"
            />
          </div>
        </div>

        <button
          type="button"
          onClick={onRecompile}
          disabled={isCompiling}
          className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-xs flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20 transition-all cursor-pointer"
        >
          <RefreshCw className={\`w-3.5 h-3.5 \${isCompiling ? 'animate-spin' : ''}\`} />
          <span>{isCompiling ? 'Compiling C++20...' : 'Recompile & Stream glTF'}</span>
        </button>
      </div>

      <div className="space-y-2 pt-4 border-t border-zinc-800">
        <button
          type="button"
          onClick={handleExportState}
          className="w-full py-2 px-3 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 text-xs font-medium flex items-center justify-center gap-2 transition cursor-pointer"
        >
          {exported ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Download className="w-3.5 h-3.5 text-zinc-400" />}
          <span>{exported ? 'State Exported to Host!' : 'Export State to Session'}</span>
        </button>

        <button
          type="button"
          onClick={handleAiRefine}
          className="w-full py-2 px-3 rounded-xl bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 text-purple-300 text-xs font-medium flex items-center justify-center gap-2 transition cursor-pointer"
        >
          <Wand2 className="w-3.5 h-3.5" />
          <span>Refine Generator with AI</span>
        </button>
      </div>
    </div>
  );
}
`;
}

/**
 * Generates Three.js App.tsx for the Native C++20 3D Studio.
 */
export function generate3DStudioApp(title: string): string {
    return `import React, { useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import Controls from './Controls';
import { Box, Layers, Cpu } from 'lucide-react';

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [octaves, setOctaves] = useState(5);
  const [frequency, setFrequency] = useState(0.08);
  const [roughness, setRoughness] = useState(0.45);
  const [polyCount, setPolyCount] = useState(12800);
  const [isCompiling, setIsCompiling] = useState(false);
  const [compileStatus, setCompileStatus] = useState<string>('Ready (Clang C++20 -O3)');
  
  const meshRef = useRef<THREE.Mesh | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 640;
    const height = container.clientHeight || 480;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x09090b);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(20, 16, 24);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    // Grid & Lighting
    const grid = new THREE.GridHelper(40, 40, 0x3b82f6, 0x27272a);
    grid.position.y = -4;
    scene.add(grid);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x222230, 0.7);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(15, 25, 15);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // Procedural Initial Surface Mesh (fallback / preview)
    const geom = new THREE.PlaneGeometry(24, 24, 48, 48);
    geom.rotateX(-Math.PI / 2);
    const pos = geom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = Math.sin(x * frequency * 2) * Math.cos(z * frequency * 2) * 2.5;
      pos.setY(i, y);
    }
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      roughness: roughness,
      metalness: 0.15,
      wireframe: false,
      flatShading: true
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    meshRef.current = mesh;

    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      if (meshRef.current) {
        meshRef.current.rotation.y += 0.003;
      }
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', handleResize);
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, []);

  const handleRecompile = async () => {
    setIsCompiling(true);
    setCompileStatus('Compiling C++20 via Clang...');
    try {
      const cppSource = '// Scratchbox Engine C++20 Generator\\\\n#include "scratchbox_engine.hpp"\\\\n// Octaves: ' + octaves + ', Freq: ' + frequency;
      if (window.scratchbox && window.scratchbox.native3d) {
        const res = await window.scratchbox.native3d.generateGlb(cppSource);
        if (res.success) {
          setCompileStatus('Compiled & Streamed glTF 2.0');
          setPolyCount(res.triangleCount || 16400);
        } else {
          setCompileStatus('Native engine fallback (WebGL SDF)');
        }
      } else {
        setCompileStatus('Preview mode: Simulating C++20 SDF');
      }

      // Update mesh geometry in preview
      if (meshRef.current) {
        const geom = meshRef.current.geometry as THREE.PlaneGeometry;
        const pos = geom.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const z = pos.getZ(i);
          let y = 0;
          let amp = 3.0;
          let freq = frequency;
          for (let o = 0; o < octaves; o++) {
            y += Math.sin(x * freq + o) * Math.cos(z * freq - o) * amp;
            amp *= 0.5;
            freq *= 2.0;
          }
          pos.setY(i, y);
        }
        geom.computeVertexNormals();
        pos.needsUpdate = true;
        (meshRef.current.material as THREE.MeshStandardMaterial).roughness = roughness;
      }
    } catch (e: any) {
      setCompileStatus('Fallback: ' + (e.message || 'Complete'));
    } finally {
      setIsCompiling(false);
    }
  };

  return (
    <div className="flex h-screen w-screen bg-zinc-950 text-zinc-100 font-sans overflow-hidden select-none">
      <div className="flex-1 relative flex flex-col">
        <div className="absolute top-4 left-4 z-20 flex items-center gap-2 bg-zinc-900/85 backdrop-blur-md border border-zinc-800/80 px-3.5 py-2 rounded-2xl shadow-xl">
          <div className="p-1.5 rounded-lg bg-blue-500/20 text-blue-400">
            <Cpu className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <div className="text-xs font-bold text-white flex items-center gap-1.5">
              <span>Scratchbox C++20 3D Studio</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 font-mono">Clang -O3</span>
            </div>
            <div className="text-[10px] text-zinc-400 font-mono">{compileStatus}</div>
          </div>
        </div>

        <div className="absolute top-4 right-4 z-20 flex items-center gap-3 bg-zinc-900/85 backdrop-blur-md border border-zinc-800/80 px-3.5 py-2 rounded-2xl shadow-xl">
          <div className="flex items-center gap-1.5 text-xs font-mono text-zinc-300">
            <Layers className="w-3.5 h-3.5 text-emerald-400" />
            <span>Triangles: <strong className="text-white">{polyCount.toLocaleString()}</strong></span>
          </div>
        </div>

        <div ref={mountRef} className="w-full h-full relative cursor-grab active:cursor-grabbing" />
      </div>

      <Controls
        octaves={octaves}
        setOctaves={setOctaves}
        frequency={frequency}
        setFrequency={setFrequency}
        roughness={roughness}
        setRoughness={setRoughness}
        onRecompile={handleRecompile}
        isCompiling={isCompiling}
      />
    </div>
  );
}
`;
}

/**
 * Synthesizes rich interactive React components tailored to user intent.
 */
export function generateContextualReactApp(prompt: string, title: string): string {
    const lower = (prompt + ' ' + title).toLowerCase();
    
    if (is3DStudioIntent(prompt, title)) {
        return generate3DStudioApp(title);
    }

    if (lower.includes('calculator')) {
        return `import React, { useState } from 'react';
import { Calculator as CalcIcon, History, Trash2, ArrowLeft } from 'lucide-react';

export default function App() {
  const [display, setDisplay] = useState('0');
  const [equation, setEquation] = useState('');
  const [history, setHistory] = useState<string[]>([]);

  const handleDigit = (digit: string) => {
    setDisplay(prev => (prev === '0' || prev === 'Error' ? digit : prev + digit));
  };

  const handleOp = (op: string) => {
    setEquation(\`\${display} \${op} \`);
    setDisplay('0');
  };

  const handleClear = () => {
    setDisplay('0');
    setEquation('');
  };

  const handleCalculate = () => {
    try {
      const fullExpr = equation + display;
      const sanitized = fullExpr.replace(/[^0-9+\\-*\\/().]/g, '');
      const result = Function(\`'use strict'; return (\${sanitized})\`)();
      const resStr = String(Math.round(result * 100000000) / 100000000);
      setHistory(prev => [\`\${fullExpr} = \${resStr}\`, ...prev.slice(0, 9)]);
      setDisplay(resStr);
      setEquation('');
    } catch {
      setDisplay('Error');
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-950 text-zinc-100 p-4 font-sans select-none">
      <div className="w-full max-w-sm bg-zinc-900/90 border border-zinc-800 rounded-3xl p-6 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between mb-4 pb-2 border-b border-zinc-800">
          <div className="flex items-center gap-2 text-blue-400 font-semibold text-sm">
            <CalcIcon className="w-4 h-4" />
            <span>Interactive Calculator</span>
          </div>
          <button onClick={() => setHistory([])} className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1">
            <Trash2 className="w-3 h-3" /> Clear History
          </button>
        </div>

        <div className="bg-zinc-950/80 rounded-2xl p-4 mb-5 border border-zinc-800/80 text-right">
          <div className="text-xs text-zinc-500 h-5 overflow-hidden">{equation}</div>
          <div className="text-4xl font-extrabold tracking-tight text-white overflow-x-auto">{display}</div>
        </div>

        <div className="grid grid-cols-4 gap-2.5">
          <button onClick={handleClear} className="p-3.5 rounded-xl bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 font-bold text-sm">C</button>
          <button onClick={() => setDisplay(prev => prev.length > 1 ? prev.slice(0, -1) : '0')} className="p-3.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold text-sm flex items-center justify-center"><ArrowLeft className="w-4 h-4" /></button>
          <button onClick={() => handleOp('%')} className="p-3.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold text-sm">%</button>
          <button onClick={() => handleOp('/')} className="p-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm">÷</button>

          {['7', '8', '9'].map(d => <button key={d} onClick={() => handleDigit(d)} className="p-3.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/80 text-zinc-100 font-medium text-lg">{d}</button>)}
          <button onClick={() => handleOp('*')} className="p-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm">×</button>

          {['4', '5', '6'].map(d => <button key={d} onClick={() => handleDigit(d)} className="p-3.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/80 text-zinc-100 font-medium text-lg">{d}</button>)}
          <button onClick={() => handleOp('-')} className="p-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm">−</button>

          {['1', '2', '3'].map(d => <button key={d} onClick={() => handleDigit(d)} className="p-3.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/80 text-zinc-100 font-medium text-lg">{d}</button>)}
          <button onClick={() => handleOp('+')} className="p-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm">+</button>

          <button onClick={() => handleDigit('0')} className="col-span-2 p-3.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/80 text-zinc-100 font-medium text-lg">0</button>
          <button onClick={() => handleDigit('.')} className="p-3.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/80 text-zinc-100 font-bold text-lg">.</button>
          <button onClick={handleCalculate} className="p-3.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-lg shadow-lg shadow-blue-500/25">=</button>
        </div>

        {history.length > 0 && (
          <div className="mt-4 pt-3 border-t border-zinc-800/80">
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-1.5 font-medium">
              <History className="w-3.5 h-3.5" /> Recent Calculations
            </div>
            <div className="space-y-1 max-h-24 overflow-y-auto text-xs text-zinc-400">
              {history.map((h, i) => (
                <div key={i} className="flex justify-between py-0.5 px-1.5 rounded hover:bg-zinc-800/40">
                  <span>{h}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}`;
    }

    if (lower.includes('lexington') || lower.includes('concord') || lower.includes('1776') || lower.includes('revolution') || lower.includes('battle')) {
        return `import React, { useState } from 'react';
import { Compass, Clock, Award, Flag, MapPin, ChevronRight } from 'lucide-react';
import confetti from 'canvas-confetti';

interface BattlePhase {
  id: string;
  time: string;
  title: string;
  location: string;
  description: string;
  significance: string;
  colonistCasualties: number;
  britishCasualties: number;
  tacticalAdvantage: 'colonists' | 'british' | 'stalemate';
}

const PHASES: BattlePhase[] = [
  {
    id: 'phase-1',
    time: 'April 18, 10:00 PM',
    title: 'The Midnight Ride',
    location: 'Boston to Lexington',
    description: 'Paul Revere and William Dawes set out on horseback to sound the alarm that British regulars were marching toward Concord.',
    significance: 'Allowed colonial militia (Minutemen) to muster and conceal military stores.',
    colonistCasualties: 0,
    britishCasualties: 0,
    tacticalAdvantage: 'colonists'
  },
  {
    id: 'phase-2',
    time: 'April 19, 5:00 AM',
    title: 'The Shot Heard \\'Round the World',
    location: 'Lexington Common',
    description: 'Captain John Parker and roughly 77 Minutemen stood on the green. An unknown shot rang out, followed by British volleys.',
    significance: 'First military confrontation marking the official outbreak of the American Revolutionary War.',
    colonistCasualties: 8,
    britishCasualties: 1,
    tacticalAdvantage: 'british'
  },
  {
    id: 'phase-3',
    time: 'April 19, 9:00 AM',
    title: 'The Stand at North Bridge',
    location: 'Concord, Massachusetts',
    description: 'Hundreds of Massachusetts militia under Major John Buttrick engaged British light infantry holding North Bridge.',
    significance: 'First time colonial troops advanced in formation against British regulars and forced a retreat.',
    colonistCasualties: 2,
    britishCasualties: 3,
    tacticalAdvantage: 'colonists'
  },
  {
    id: 'phase-4',
    time: 'April 19, 12:00 PM - 7:00 PM',
    title: 'The Running Battle along Battle Road',
    location: 'Concord to Charlestown',
    description: 'Over 4,000 militia swarmed stone walls and tree lines, relentlessly harrying Colonel Smith\\'s retreating column.',
    significance: 'Decisive tactical defeat of the British expedition, leading directly to the Siege of Boston.',
    colonistCasualties: 39,
    britishCasualties: 269,
    tacticalAdvantage: 'colonists'
  }
];

export default function App() {
  const [activePhaseIndex, setActivePhaseIndex] = useState(0);

  const currentPhase = PHASES[activePhaseIndex];

  const handleSelectPhase = (index: number) => {
    setActivePhaseIndex(index);
    if (index === PHASES.length - 1) {
      confetti({ particleCount: 70, spread: 60, origin: { y: 0.6 } });
    }
  };

  const totalColonist = PHASES.reduce((acc, p) => acc + p.colonistCasualties, 0);
  const totalBritish = PHASES.reduce((acc, p) => acc + p.britishCasualties, 0);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-zinc-100 p-6 font-sans">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-6 bg-zinc-900/80 border border-zinc-800 rounded-2xl shadow-xl backdrop-blur">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 text-xs font-semibold border border-amber-500/20">
              <Compass className="w-3.5 h-3.5" />
              <span>April 19, 1775 • Massachusetts Bay</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Battles of Lexington & Concord: Live Timeline Explorer</h1>
            <p className="text-sm text-zinc-400">Interactive military timeline, tactical casualty analysis, and pivotal battle phases.</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-center p-3 bg-zinc-950/60 rounded-xl border border-zinc-800">
              <div className="text-xs text-zinc-400 font-medium">Colonial Militia</div>
              <div className="text-xl font-bold text-blue-400">{totalColonist} lost</div>
            </div>
            <div className="text-center p-3 bg-zinc-950/60 rounded-xl border border-zinc-800">
              <div className="text-xs text-zinc-400 font-medium">British Regulars</div>
              <div className="text-xl font-bold text-rose-400">{totalBritish} casualties</div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {PHASES.map((p, idx) => {
            const isActive = idx === activePhaseIndex;
            return (
              <button
                key={p.id}
                onClick={() => handleSelectPhase(idx)}
                className={\`p-4 rounded-xl text-left border transition-all \${
                  isActive
                    ? 'bg-blue-600/15 border-blue-500/50 text-white shadow-lg shadow-blue-500/10'
                    : 'bg-zinc-900/60 border-zinc-800/80 text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                }\`}
              >
                <div className="text-xs font-semibold text-zinc-500 mb-1">Phase 0{idx + 1}</div>
                <div className="font-bold text-sm text-zinc-100 line-clamp-1">{p.title}</div>
                <div className="text-xs text-zinc-400 mt-1 flex items-center gap-1">
                  <Clock className="w-3 h-3" /> {p.time}
                </div>
              </button>
            );
          })}
        </div>

        <div className="p-6 bg-zinc-900/90 border border-zinc-800 rounded-2xl shadow-xl space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-zinc-800 gap-2">
            <div>
              <div className="text-xs text-blue-400 font-medium uppercase tracking-wider">{currentPhase.time}</div>
              <h2 className="text-xl font-bold text-white mt-0.5">{currentPhase.title}</h2>
              <div className="flex items-center gap-1.5 text-xs text-zinc-400 mt-1">
                <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                <span>{currentPhase.location}</span>
              </div>
            </div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-800 border border-zinc-700/80 text-xs">
              <Flag className="w-3.5 h-3.5 text-amber-400" />
              <span>Advantage: <strong className="text-white capitalize">{currentPhase.tacticalAdvantage}</strong></span>
            </div>
          </div>

          <p className="text-zinc-300 text-sm leading-relaxed">{currentPhase.description}</p>

          <div className="p-4 rounded-xl bg-zinc-950/70 border border-zinc-800/80 flex items-start gap-3">
            <Award className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Historical Significance</div>
              <div className="text-sm text-zinc-300 mt-0.5">{currentPhase.significance}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="p-3 bg-zinc-950/50 rounded-xl border border-zinc-800 flex items-center justify-between">
              <span className="text-xs text-zinc-400">Minutemen Casualties</span>
              <span className="text-sm font-bold text-blue-400">{currentPhase.colonistCasualties}</span>
            </div>
            <div className="p-3 bg-zinc-950/50 rounded-xl border border-zinc-800 flex items-center justify-between">
              <span className="text-xs text-zinc-400">British Column Casualties</span>
              <span className="text-sm font-bold text-rose-400">{currentPhase.britishCasualties}</span>
            </div>
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-zinc-800">
            <button
              onClick={() => handleSelectPhase(Math.max(0, activePhaseIndex - 1))}
              disabled={activePhaseIndex === 0}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-zinc-800 text-zinc-200 transition"
            >
              Previous Phase
            </button>
            <div className="text-xs text-zinc-500 font-medium">Phase {activePhaseIndex + 1} of {PHASES.length}</div>
            <button
              onClick={() => handleSelectPhase(Math.min(PHASES.length - 1, activePhaseIndex + 1))}
              disabled={activePhaseIndex === PHASES.length - 1}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 text-white transition flex items-center gap-1.5"
            >
              <span>Next Phase</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}`;
    }

    if (lower.includes('gravity') || lower.includes('orbit') || lower.includes('physics') || lower.includes('celestial') || lower.includes('planetary') || lower.includes('n-body') || lower.includes('pendulum')) {
        return `import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, RotateCcw, Orbit, Zap } from 'lucide-react';

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
  radius: number;
  color: string;
  trail: { x: number; y: number }[];
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isRunning, setIsRunning] = useState(true);
  const [timeSpeed, setTimeSpeed] = useState(1);
  const [gravityG, setGravityG] = useState(0.8);
  const [trailLength, setTrailLength] = useState(40);
  const [bodyCount, setBodyCount] = useState(4);
  const bodiesRef = useRef<Body[]>([]);

  const initSystem = () => {
    const bodies: Body[] = [
      { x: 300, y: 250, vx: 0, vy: 0, mass: 1000, radius: 14, color: '#f59e0b', trail: [] },
      { x: 300, y: 150, vx: 2.8, vy: 0, mass: 10, radius: 6, color: '#38bdf8', trail: [] },
      { x: 300, y: 80, vx: 2.1, vy: 0, mass: 25, radius: 8, color: '#34d399', trail: [] },
      { x: 300, y: 20, vx: 1.6, vy: 0, mass: 60, radius: 10, color: '#a855f7', trail: [] }
    ];
    bodiesRef.current = bodies;
    setBodyCount(bodies.length);
  };

  useEffect(() => {
    initSystem();
  }, []);

  useEffect(() => {
    let animId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const loop = () => {
      if (isRunning) {
        const bodies = bodiesRef.current;
        const dt = 0.5 * timeSpeed;

        for (let i = 0; i < bodies.length; i++) {
          let fx = 0;
          let fy = 0;
          for (let j = 0; j < bodies.length; j++) {
            if (i === j) continue;
            const dx = bodies[j].x - bodies[i].x;
            const dy = bodies[j].y - bodies[i].y;
            const distSq = dx * dx + dy * dy + 100;
            const force = (gravityG * bodies[i].mass * bodies[j].mass) / distSq;
            const dist = Math.sqrt(distSq);
            fx += force * (dx / dist);
            fy += force * (dy / dist);
          }
          if (bodies[i].mass < 800) {
            bodies[i].vx += (fx / bodies[i].mass) * dt;
            bodies[i].vy += (fy / bodies[i].mass) * dt;
            bodies[i].x += bodies[i].vx * dt;
            bodies[i].y += bodies[i].vy * dt;
          }

          bodies[i].trail.push({ x: bodies[i].x, y: bodies[i].y });
          if (bodies[i].trail.length > trailLength) {
            bodies[i].trail.shift();
          }
        }
      }

      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = '#27272a';
      ctx.lineWidth = 0.5;
      for (let x = 0; x < canvas.width; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      const bodies = bodiesRef.current;
      for (const b of bodies) {
        if (b.trail.length > 1) {
          ctx.beginPath();
          ctx.moveTo(b.trail[0].x, b.trail[0].y);
          for (let k = 1; k < b.trail.length; k++) {
            ctx.lineTo(b.trail[k].x, b.trail[k].y);
          }
          ctx.strokeStyle = b.color + '44';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      for (const b of bodies) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
        ctx.fillStyle = b.color;
        ctx.shadowColor = b.color;
        ctx.shadowBlur = b.mass > 500 ? 25 : 8;
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.fillStyle = '#a1a1aa';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(b.mass > 500 ? 'Star' : \`m=\${Math.round(b.mass)}\`, b.x + b.radius + 4, b.y + 3);
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [isRunning, timeSpeed, gravityG, trailLength]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const dx = x - 300;
    const dy = y - 250;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const speed = Math.sqrt((gravityG * 1000) / Math.max(30, dist));
    const colors = ['#f43f5e', '#ec4899', '#8b5cf6', '#06b6d4', '#10b981'];
    const chosenColor = colors[bodiesRef.current.length % colors.length];

    bodiesRef.current.push({
      x,
      y,
      vx: -dy / dist * speed,
      vy: dx / dist * speed,
      mass: 8 + Math.random() * 15,
      radius: 5,
      color: chosenColor,
      trail: []
    });
    setBodyCount(bodiesRef.current.length);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-950 text-zinc-100 p-4 font-sans select-none">
      <div className="w-full max-w-4xl bg-zinc-900/90 border border-zinc-800 rounded-3xl p-6 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Orbit className="w-5 h-5 animate-spin" style={{ animationDuration: '10s' }} />
            </div>
            <div>
              <h1 className="text-base font-bold text-white">Orbital Gravity Simulator</h1>
              <p className="text-xs text-zinc-400">Interactive Newtonian N-Body Gravitational Physics</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsRunning(!isRunning)}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1.5 transition"
            >
              {isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{isRunning ? 'Pause' : 'Resume'}</span>
            </button>
            <button
              onClick={initSystem}
              className="p-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
              title="Reset Bodies"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="relative border border-zinc-800/80 rounded-2xl overflow-hidden bg-black flex items-center justify-center">
          <canvas
            ref={canvasRef}
            width={640}
            height={500}
            onClick={handleCanvasClick}
            className="cursor-crosshair w-full max-w-[640px] h-[500px]"
          />
          <div className="absolute top-3 left-3 bg-zinc-900/80 backdrop-blur border border-zinc-800/80 rounded-lg px-2.5 py-1 text-[11px] text-zinc-300">
            Click anywhere on the cosmos to spawn a new orbiting body!
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4 mt-5 p-4 rounded-2xl bg-zinc-950/60 border border-zinc-800/80">
          <div>
            <div className="flex justify-between text-xs text-zinc-400 mb-1">
              <span>Time Warp</span>
              <span className="font-mono text-zinc-200">{timeSpeed}x</span>
            </div>
            <input
              type="range"
              min="0.2"
              max="3.0"
              step="0.1"
              value={timeSpeed}
              onChange={e => setTimeSpeed(parseFloat(e.target.value))}
              className="w-full accent-blue-500"
            />
          </div>
          <div>
            <div className="flex justify-between text-xs text-zinc-400 mb-1">
              <span>Gravity (G)</span>
              <span className="font-mono text-zinc-200">{gravityG.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min="0.1"
              max="2.5"
              step="0.1"
              value={gravityG}
              onChange={e => setGravityG(parseFloat(e.target.value))}
              className="w-full accent-amber-500"
            />
          </div>
          <div>
            <div className="flex justify-between text-xs text-zinc-400 mb-1">
              <span>Trail Length</span>
              <span className="font-mono text-zinc-200">{trailLength}</span>
            </div>
            <input
              type="range"
              min="10"
              max="120"
              step="5"
              value={trailLength}
              onChange={e => setTrailLength(parseInt(e.target.value))}
              className="w-full accent-purple-500"
            />
          </div>
          <div className="flex items-center justify-between pl-4 border-l border-zinc-800">
            <div>
              <div className="text-[11px] text-zinc-500 uppercase tracking-wider">Celestial Bodies</div>
              <div className="text-xl font-black text-white mt-0.5">{bodyCount}</div>
            </div>
            <div className="p-2 rounded-xl bg-purple-500/10 text-purple-400">
              <Zap className="w-4 h-4" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}`;
    }

    if (lower.includes('synth') || lower.includes('synthesizer') || lower.includes('audio') || lower.includes('piano') || lower.includes('keyboard') || lower.includes('sound') || lower.includes('music') || lower.includes('sequencer')) {
        return `import React, { useState, useEffect, useRef } from 'react';
import { Volume2, Music, Waves, Activity, Sparkles } from 'lucide-react';

interface KeyConfig {
  note: string;
  freq: number;
  isBlack: boolean;
  keyLabel: string;
}

const KEYS: KeyConfig[] = [
  { note: 'C4', freq: 261.63, isBlack: false, keyLabel: 'A' },
  { note: 'C#4', freq: 277.18, isBlack: true, keyLabel: 'W' },
  { note: 'D4', freq: 293.66, isBlack: false, keyLabel: 'S' },
  { note: 'D#4', freq: 311.13, isBlack: true, keyLabel: 'E' },
  { note: 'E4', freq: 329.63, isBlack: false, keyLabel: 'D' },
  { note: 'F4', freq: 349.23, isBlack: false, keyLabel: 'F' },
  { note: 'F#4', freq: 369.99, isBlack: true, keyLabel: 'T' },
  { note: 'G4', freq: 392.00, isBlack: false, keyLabel: 'G' },
  { note: 'G#4', freq: 415.30, isBlack: true, keyLabel: 'Y' },
  { note: 'A4', freq: 440.00, isBlack: false, keyLabel: 'H' },
  { note: 'A#4', freq: 466.16, isBlack: true, keyLabel: 'U' },
  { note: 'B4', freq: 493.88, isBlack: false, keyLabel: 'J' },
  { note: 'C5', freq: 523.25, isBlack: false, keyLabel: 'K' }
];

export default function App() {
  const [waveform, setWaveform] = useState<OscillatorType>('sawtooth');
  const [filterCutoff, setFilterCutoff] = useState(2500);
  const [attack, setAttack] = useState(0.05);
  const [release, setRelease] = useState(0.4);
  const [volume, setVolume] = useState(0.3);
  const [activeNote, setActiveNote] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeOscs = useRef<Map<string, { osc: OscillatorNode; gain: GainNode }>>(new Map());

  const getAudioContext = () => {
    if (!audioCtxRef.current) {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      audioCtxRef.current = ctx;
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  };

  const playNote = (note: string, freq: number) => {
    const ctx = getAudioContext();
    setActiveNote(note);

    if (activeOscs.current.has(note)) {
      stopNote(note);
    }

    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = waveform;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterCutoff, ctx.currentTime);

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + attack);

    osc.connect(filter);
    filter.connect(gain);
    if (analyserRef.current) {
      gain.connect(analyserRef.current);
      analyserRef.current.connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }

    osc.start(now);
    activeOscs.current.set(note, { osc, gain });
  };

  const stopNote = (note: string) => {
    const item = activeOscs.current.get(note);
    if (item && audioCtxRef.current) {
      const now = audioCtxRef.current.currentTime;
      item.gain.gain.cancelScheduledValues(now);
      item.gain.gain.setValueAtTime(item.gain.gain.value, now);
      item.gain.gain.exponentialRampToValueAtTime(0.0001, now + release);
      item.osc.stop(now + release + 0.05);
      activeOscs.current.delete(note);
    }
    if (activeNote === note) {
      setActiveNote(null);
    }
  };

  useEffect(() => {
    let animId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      animId = requestAnimationFrame(draw);
      const analyser = analyserRef.current;
      if (!analyser) {
        ctx.fillStyle = '#09090b';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return;
      }

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyser.getByteTimeDomainData(dataArray);

      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#38bdf8';
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 10;
      ctx.beginPath();

      const sliceWidth = canvas.width / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    draw();
    return () => cancelAnimationFrame(animId);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-950 text-zinc-100 p-4 font-sans select-none">
      <div className="w-full max-w-3xl bg-zinc-900/90 border border-zinc-800 rounded-3xl p-6 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              <Waves className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white">Web Audio Synthesizer</h1>
              <p className="text-xs text-zinc-400">Real-time Web Audio API Engine with Visual Oscilloscope</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(['sawtooth', 'square', 'sine', 'triangle'] as OscillatorType[]).map(type => (
              <button
                key={type}
                onClick={() => setWaveform(type)}
                className={\`px-3 py-1 rounded-xl text-xs font-semibold capitalize transition \${
                  waveform === type
                    ? 'bg-cyan-600 text-white shadow-md shadow-cyan-500/25'
                    : 'bg-zinc-800/80 text-zinc-400 hover:text-zinc-200'
                }\`}
              >
                {type}
              </button>
            ))}
          </div>
        </div>

        <div className="border border-zinc-800/80 rounded-2xl overflow-hidden bg-zinc-950 mb-5 relative">
          <canvas ref={canvasRef} width={640} height={120} className="w-full h-28" />
          <div className="absolute top-2 right-3 text-[10px] font-mono text-cyan-400/80 uppercase tracking-widest flex items-center gap-1.5">
            <Activity className="w-3 h-3" /> Live Oscilloscope
          </div>
        </div>

        <div className="relative flex justify-center h-44 bg-zinc-950 p-3 rounded-2xl border border-zinc-800/80 shadow-inner">
          <div className="relative flex">
            {KEYS.filter(k => !k.isBlack).map(k => {
              const isActive = activeNote === k.note;
              return (
                <button
                  key={k.note}
                  onMouseDown={() => playNote(k.note, k.freq)}
                  onMouseUp={() => stopNote(k.note)}
                  onMouseLeave={() => stopNote(k.note)}
                  className={\`w-12 h-40 border border-zinc-700/60 rounded-b-xl flex flex-col justify-end items-center pb-2 transition-all \${
                    isActive
                      ? 'bg-cyan-200 text-zinc-950 shadow-lg shadow-cyan-500/30 translate-y-0.5'
                      : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-800'
                  }\`}
                >
                  <span className="font-bold text-xs">{k.note}</span>
                  <span className="text-[10px] text-zinc-500 font-mono">[{k.keyLabel}]</span>
                </button>
              );
            })}

            <div className="absolute top-0 left-0 flex pointer-events-none w-full h-24">
              <div className="w-8"></div>
              {KEYS.filter(k => k.isBlack).map((k, idx) => {
                const isActive = activeNote === k.note;
                const offsets = [32, 80, 176, 224, 272];
                return (
                  <button
                    key={k.note}
                    style={{ position: 'absolute', left: \`\${offsets[idx] || 0}px\` }}
                    onMouseDown={() => playNote(k.note, k.freq)}
                    onMouseUp={() => stopNote(k.note)}
                    onMouseLeave={() => stopNote(k.note)}
                    className={\`pointer-events-auto w-8 h-24 border border-zinc-900 rounded-b-lg flex flex-col justify-end items-center pb-1.5 z-10 transition-all \${
                      isActive
                        ? 'bg-cyan-500 text-white shadow-lg shadow-cyan-500/40 translate-y-0.5'
                        : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300'
                    }\`}
                  >
                    <span className="font-bold text-[10px]">{k.note}</span>
                    <span className="text-[9px] text-zinc-400 font-mono">{k.keyLabel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4 mt-5 p-4 rounded-2xl bg-zinc-950/60 border border-zinc-800/80">
          <div>
            <div className="flex justify-between text-xs text-zinc-400 mb-1">
              <span>Filter Cutoff</span>
              <span className="font-mono text-zinc-200">{filterCutoff}Hz</span>
            </div>
            <input
              type="range"
              min="200"
              max="8000"
              step="50"
              value={filterCutoff}
              onChange={e => setFilterCutoff(parseInt(e.target.value))}
              className="w-full accent-cyan-500"
            />
          </div>
          <div>
            <div className="flex justify-between text-xs text-zinc-400 mb-1">
              <span>Attack</span>
              <span className="font-mono text-zinc-200">{attack.toFixed(2)}s</span>
            </div>
            <input
              type="range"
              min="0.01"
              max="0.5"
              step="0.01"
              value={attack}
              onChange={e => setAttack(parseFloat(e.target.value))}
              className="w-full accent-blue-500"
            />
          </div>
          <div>
            <div className="flex justify-between text-xs text-zinc-400 mb-1">
              <span>Release</span>
              <span className="font-mono text-zinc-200">{release.toFixed(2)}s</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="1.5"
              step="0.05"
              value={release}
              onChange={e => setRelease(parseFloat(e.target.value))}
              className="w-full accent-purple-500"
            />
          </div>
          <div>
            <div className="flex justify-between text-xs text-zinc-400 mb-1">
              <span>Master Volume</span>
              <span className="font-mono text-zinc-200">{Math.round(volume * 100)}%</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="0.8"
              step="0.05"
              value={volume}
              onChange={e => setVolume(parseFloat(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>
        </div>
      </div>
    </div>
  );
}`;
    }

    if (lower.includes('game') || lower.includes('arcade') || lower.includes('pong') || lower.includes('breakout') || lower.includes('retro') || lower.includes('invader') || lower.includes('brick')) {
        return `import React, { useState, useEffect, useRef } from 'react';
import { Play, Award, Heart, Sparkles, Gamepad2 } from 'lucide-react';
import confetti from 'canvas-confetti';

interface Brick {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  points: number;
  alive: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  alpha: number;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [gameState, setGameState] = useState<'start' | 'playing' | 'gameover' | 'victory'>('start');

  const stateRef = useRef({
    paddleX: 250,
    paddleW: 90,
    paddleH: 12,
    ballX: 300,
    ballY: 350,
    ballVx: 3.5,
    ballVy: -4,
    ballRadius: 7,
    bricks: [] as Brick[],
    particles: [] as Particle[]
  });

  const initGame = () => {
    const bricks: Brick[] = [];
    const colors = ['#f43f5e', '#f59e0b', '#10b981', '#38bdf8', '#8b5cf6'];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 8; c++) {
        bricks.push({
          x: 20 + c * 72,
          y: 40 + r * 22,
          w: 64,
          h: 16,
          color: colors[r],
          points: (5 - r) * 10,
          alive: true
        });
      }
    }
    stateRef.current.bricks = bricks;
    stateRef.current.ballX = 300;
    stateRef.current.ballY = 350;
    stateRef.current.ballVx = 3.5 * (Math.random() > 0.5 ? 1 : -1);
    stateRef.current.ballVy = -4;
    stateRef.current.particles = [];
    setScore(0);
    setLives(3);
    setGameState('playing');
  };

  useEffect(() => {
    let animId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const loop = () => {
      const state = stateRef.current;

      if (gameState === 'playing') {
        state.ballX += state.ballVx;
        state.ballY += state.ballVy;

        if (state.ballX - state.ballRadius <= 0 || state.ballX + state.ballRadius >= canvas.width) {
          state.ballVx = -state.ballVx;
        }
        if (state.ballY - state.ballRadius <= 0) {
          state.ballVy = -state.ballVy;
        }

        const paddleY = canvas.height - 25;
        if (
          state.ballY + state.ballRadius >= paddleY &&
          state.ballY - state.ballRadius <= paddleY + state.paddleH &&
          state.ballX >= state.paddleX &&
          state.ballX <= state.paddleX + state.paddleW
        ) {
          const hitOffset = (state.ballX - (state.paddleX + state.paddleW / 2)) / (state.paddleW / 2);
          state.ballVx = hitOffset * 5.5;
          state.ballVy = -Math.abs(state.ballVy);
        }

        if (state.ballY > canvas.height) {
          setLives(l => {
            if (l <= 1) {
              setGameState('gameover');
              return 0;
            }
            state.ballX = state.paddleX + state.paddleW / 2;
            state.ballY = 350;
            state.ballVy = -4;
            return l - 1;
          });
        }

        let aliveCount = 0;
        for (const b of state.bricks) {
          if (!b.alive) continue;
          aliveCount++;
          if (
            state.ballX + state.ballRadius >= b.x &&
            state.ballX - state.ballRadius <= b.x + b.w &&
            state.ballY + state.ballRadius >= b.y &&
            state.ballY - state.ballRadius <= b.y + b.h
          ) {
            b.alive = false;
            state.ballVy = -state.ballVy;
            setScore(s => s + b.points);

            for (let p = 0; p < 8; p++) {
              state.particles.push({
                x: b.x + b.w / 2,
                y: b.y + b.h / 2,
                vx: (Math.random() - 0.5) * 6,
                vy: (Math.random() - 0.5) * 6,
                color: b.color,
                alpha: 1.0
              });
            }
          }
        }

        if (aliveCount === 0) {
          setGameState('victory');
          confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
        }
      }

      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const b of state.bricks) {
        if (!b.alive) continue;
        ctx.fillStyle = b.color;
        ctx.shadowColor = b.color;
        ctx.shadowBlur = 8;
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.shadowBlur = 0;
      }

      for (let i = state.particles.length - 1; i >= 0; i--) {
        const p = state.particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.alpha -= 0.03;
        if (p.alpha <= 0) {
          state.particles.splice(i, 1);
          continue;
        }
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.alpha;
        ctx.fillRect(p.x, p.y, 3, 3);
        ctx.globalAlpha = 1.0;
      }

      const paddleY = canvas.height - 25;
      ctx.fillStyle = '#38bdf8';
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 12;
      ctx.fillRect(state.paddleX, paddleY, state.paddleW, state.paddleH);
      ctx.shadowBlur = 0;

      ctx.beginPath();
      ctx.arc(state.ballX, state.ballY, state.ballRadius, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [gameState]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    stateRef.current.paddleX = Math.max(0, Math.min(canvas.width - stateRef.current.paddleW, mouseX - stateRef.current.paddleW / 2));
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-950 text-zinc-100 p-4 font-sans select-none">
      <div className="w-full max-w-2xl bg-zinc-900/90 border border-zinc-800 rounded-3xl p-6 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20">
              <Gamepad2 className="w-5 h-5 animate-bounce" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white">Retro Space Breakout</h1>
              <p className="text-xs text-zinc-400">Playable 60FPS HTML5 Canvas Arcade Micro-Game</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 text-rose-400">
              {Array.from({ length: lives }).map((_, i) => (
                <Heart key={i} className="w-4 h-4 fill-rose-500 text-rose-500" />
              ))}
            </div>
            <div className="text-sm font-bold text-amber-400 flex items-center gap-1">
              <Award className="w-4 h-4" /> Score: {score}
            </div>
          </div>
        </div>

        <div className="relative border border-zinc-800/80 rounded-2xl overflow-hidden bg-black flex items-center justify-center">
          <canvas
            ref={canvasRef}
            width={600}
            height={420}
            onMouseMove={handleMouseMove}
            className="cursor-none w-full max-w-[600px] h-[420px]"
          />

          {gameState !== 'playing' && (
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center space-y-4">
              {gameState === 'victory' ? (
                <>
                  <Sparkles className="w-12 h-12 text-emerald-400 animate-spin" />
                  <h2 className="text-2xl font-black text-emerald-400">VICTORY! All Bricks Cleared!</h2>
                  <p className="text-xs text-zinc-400">Final Score: {score}</p>
                </>
              ) : gameState === 'gameover' ? (
                <>
                  <h2 className="text-2xl font-black text-rose-500">GAME OVER</h2>
                  <p className="text-xs text-zinc-400">You scored {score} points</p>
                </>
              ) : (
                <>
                  <Gamepad2 className="w-12 h-12 text-blue-400 animate-pulse" />
                  <h2 className="text-xl font-bold text-white">Ready to Play?</h2>
                  <p className="text-xs text-zinc-400">Move your mouse across the canvas to steer the paddle.</p>
                </>
              )}
              <button
                onClick={initGame}
                className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm shadow-lg shadow-blue-500/25 flex items-center gap-2 transition"
              >
                <Play className="w-4 h-4" />
                <span>{gameState === 'start' ? 'Start Game' : 'Play Again'}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}`;
    }

    if (lower.includes('sort') || lower.includes('algorithm') || lower.includes('visualizer') || lower.includes('array') || lower.includes('bubble') || lower.includes('quicksort')) {
        return `import React, { useState, useEffect } from 'react';
import { Play, Shuffle, BarChart3 } from 'lucide-react';
import confetti from 'canvas-confetti';

export default function App() {
  const [array, setArray] = useState<number[]>([]);
  const [comparing, setComparing] = useState<number[]>([]);
  const [swapping, setSwapping] = useState<number[]>([]);
  const [sorted, setSorted] = useState<number[]>([]);
  const [isSorting, setIsSorting] = useState(false);
  const [speed, setSpeed] = useState(30);
  const [comparisons, setComparisons] = useState(0);

  const resetArray = (size = 32) => {
    const arr: number[] = [];
    for (let i = 0; i < size; i++) {
      arr.push(Math.floor(Math.random() * 85) + 10);
    }
    setArray(arr);
    setComparing([]);
    setSwapping([]);
    setSorted([]);
    setComparisons(0);
    setIsSorting(false);
  };

  useEffect(() => {
    resetArray();
  }, []);

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const runBubbleSort = async () => {
    setIsSorting(true);
    const arr = [...array];
    let cmpCount = 0;
    const n = arr.length;

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i - 1; j++) {
        setComparing([j, j + 1]);
        cmpCount++;
        setComparisons(cmpCount);
        await sleep(speed);

        if (arr[j] > arr[j + 1]) {
          setSwapping([j, j + 1]);
          const temp = arr[j];
          arr[j] = arr[j + 1];
          arr[j + 1] = temp;
          setArray([...arr]);
          await sleep(speed);
        }
      }
      setSorted(prev => [...prev, n - i - 1]);
    }
    setComparing([]);
    setSwapping([]);
    setIsSorting(false);
    confetti({ particleCount: 60, spread: 50, origin: { y: 0.7 } });
  };

  const handleStartSort = () => {
    if (isSorting) return;
    runBubbleSort();
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-950 text-zinc-100 p-4 font-sans select-none">
      <div className="w-full max-w-3xl bg-zinc-900/90 border border-zinc-800 rounded-3xl p-6 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <BarChart3 className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white">Algorithm Sorting Visualizer</h1>
              <p className="text-xs text-zinc-400">Step-by-step Real-time Array Transformation</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleStartSort}
              disabled={isSorting}
              className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white flex items-center gap-1.5 transition"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Sort</span>
            </button>
            <button
              onClick={() => resetArray()}
              disabled={isSorting}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 flex items-center gap-1.5 transition"
            >
              <Shuffle className="w-3.5 h-3.5" />
              <span>Shuffle</span>
            </button>
          </div>
        </div>

        <div className="h-64 bg-zinc-950 p-4 rounded-2xl border border-zinc-800/80 flex items-end gap-1.5 justify-center shadow-inner">
          {array.map((val, idx) => {
            const isCmp = comparing.includes(idx);
            const isSwp = swapping.includes(idx);
            const isSrt = sorted.includes(idx);

            let bg = 'bg-blue-600';
            if (isSwp) bg = 'bg-rose-500 shadow-md shadow-rose-500/50';
            else if (isCmp) bg = 'bg-amber-400 shadow-md shadow-amber-500/50';
            else if (isSrt) bg = 'bg-emerald-500';

            return (
              <div
                key={idx}
                style={{ height: \`\${val}%\` }}
                className={\`flex-1 rounded-t-sm transition-all duration-75 \${bg}\`}
              />
            );
          })}
        </div>

        <div className="grid grid-cols-3 gap-4 mt-5 p-4 rounded-2xl bg-zinc-950/60 border border-zinc-800/80">
          <div>
            <div className="flex justify-between text-xs text-zinc-400 mb-1">
              <span>Speed (Delay)</span>
              <span className="font-mono text-zinc-200">{speed}ms</span>
            </div>
            <input
              type="range"
              min="5"
              max="100"
              step="5"
              value={speed}
              onChange={e => setSpeed(parseInt(e.target.value))}
              disabled={isSorting}
              className="w-full accent-emerald-500"
            />
          </div>
          <div className="text-center border-l border-zinc-800">
            <div className="text-[11px] text-zinc-500 uppercase tracking-wider">Comparisons</div>
            <div className="text-xl font-black text-amber-400 mt-0.5">{comparisons}</div>
          </div>
          <div className="text-center border-l border-zinc-800">
            <div className="text-[11px] text-zinc-500 uppercase tracking-wider">Array Size</div>
            <div className="text-xl font-black text-white mt-0.5">{array.length}</div>
          </div>
        </div>
      </div>
    </div>
  );
}`;
    }

    // Generic modern interactive web preview
    return `import React, { useState } from 'react';
import { Sparkles, Play, CheckCircle2 } from 'lucide-react';
import confetti from 'canvas-confetti';

export default function App() {
  const [count, setCount] = useState(0);
  const [intensity, setIntensity] = useState(75);
  const [activeTab, setActiveTab] = useState<'overview' | 'metrics' | 'controls'>('overview');

  const handleAction = () => {
    setCount(prev => prev + 1);
    confetti({ particleCount: 50, spread: 60, origin: { y: 0.7 } });
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-zinc-950 text-zinc-100 selection:bg-blue-500 selection:text-white font-sans">
      <div className="w-full max-w-lg p-8 bg-zinc-900/80 backdrop-blur-xl border border-zinc-800/80 rounded-3xl shadow-2xl space-y-6">
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">${title.replace(/"/g, '\\"')}</h1>
              <p className="text-xs text-zinc-400">Live Interactive Scratchbox Preview</p>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Ready
          </span>
        </div>

        <div className="flex gap-2 p-1 bg-zinc-950/60 rounded-xl border border-zinc-800/80">
          {(['overview', 'metrics', 'controls'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={\`flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold capitalize transition-all \${
                activeTab === tab
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20'
                  : 'text-zinc-400 hover:text-zinc-200'
              }\`}
            >
              {tab}
            </button>
          ))}
        </div>

        {activeTab === 'overview' && (
          <div className="space-y-4">
            <div className="p-4 bg-zinc-950/50 rounded-2xl border border-zinc-800/50 flex items-center justify-around">
              <div>
                <div className="text-xs text-zinc-500 font-medium">Interactions</div>
                <div className="text-3xl font-extrabold text-blue-400">{count}</div>
              </div>
              <div className="h-8 w-px bg-zinc-800"></div>
              <div>
                <div className="text-xs text-zinc-500 font-medium">Intensity</div>
                <div className="text-3xl font-extrabold text-emerald-400">{intensity}%</div>
              </div>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              This interactive component is running live inside Scratchbox Canvas via Babel Standalone and React 19. All states, events, and styling are hot-reloaded automatically.
            </p>
          </div>
        )}

        {activeTab === 'metrics' && (
          <div className="space-y-3">
            <div className="p-3 bg-zinc-950/40 rounded-xl border border-zinc-800 flex justify-between text-xs">
              <span className="text-zinc-400">FPS / Render Rate</span>
              <span className="text-emerald-400 font-bold">60.0 fps</span>
            </div>
            <div className="p-3 bg-zinc-950/40 rounded-xl border border-zinc-800 flex justify-between text-xs">
              <span className="text-zinc-400">WASM Runtime</span>
              <span className="text-blue-400 font-bold">Active</span>
            </div>
            <div className="p-3 bg-zinc-950/40 rounded-xl border border-zinc-800 flex justify-between text-xs">
              <span className="text-zinc-400">Component Mount</span>
              <span className="text-zinc-300 font-mono">App.tsx</span>
            </div>
          </div>
        )}

        {activeTab === 'controls' && (
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-zinc-400">
                <span>Simulation Parameter</span>
                <span>{intensity}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={intensity}
                onChange={e => setIntensity(Number(e.target.value))}
                className="w-full accent-blue-500 bg-zinc-800 rounded-lg cursor-pointer"
              />
            </div>
          </div>
        )}

        <button
          onClick={handleAction}
          className="w-full py-3 px-6 rounded-xl font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-500/25 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
        >
          <Play className="w-4 h-4 fill-current" />
          <span>Trigger Interactive Event ({count})</span>
        </button>
      </div>
    </div>
  );
}`;
}

/**
 * Extracts runnable code blocks from AI output or synthesizes an interactive live sandbox
 * with viewMode: 'preview' for immediate hot-reloading execution.
 */
export function extractCodeSandboxArtifact(
    prompt: string,
    cleanContent: string,
    activeArtifact?: CanvasArtifact
): { artifact: CanvasArtifact; hasRunnableCode: boolean } | null {
    // Match all fenced code blocks in cleanContent
    const codeBlockRegex = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
    const matches: Array<{ language: string; content: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(cleanContent)) !== null) {
        const rawLang = (match[1] || '').trim().toLowerCase();
        const code = match[2];
        if (code && code.trim().length > 0) {
            matches.push({ language: rawLang, content: code.trim() });
        }
    }

    const runnableMatches = matches.filter(m => 
        ['tsx', 'jsx', 'react', 'html', 'htm', 'svg', 'javascript', 'js', 'typescript', 'ts', 'css', 'python', 'py'].includes(m.language) ||
        /import\s+React|export\s+default\s+function|<\w+[\s>]|<!DOCTYPE\s+html|<svg/i.test(m.content)
    );

    const isSandboxExplicit = /preview|sandbox|\bapp\b|web\s*app|landing\s*page|calculator|game|arcade|gravity|orbit|physics|celestial|synth|synthesizer|piano|keyboard|audio|music|sound|sorting|visualizer|dashboard|component|widget|mockup|\bui\b|react|html|css|javascript|typescript|python|interactive|simulator|timeline/i.test(prompt);

    if (runnableMatches.length === 0 && !isSandboxExplicit) {
        return null;
    }

    const timestamp = new Date().toISOString();
    let title = extractDocumentTitle(prompt, 'Interactive Live Preview');
    if (title.toLowerCase().startsWith('strategic') || title.toLowerCase().startsWith('project specification')) {
        title = 'Interactive Live Preview';
    }

    let template: SandboxTemplate = 'react';
    const files: CodeFileTab[] = [];
    const dependencies: Record<string, string> = {
        'lucide-react': '^0.468.0',
        'canvas-confetti': '^1.9.3',
        'three': '^0.160.0',
        'framer-motion': '^11.0.0'
    };

    if (runnableMatches.length > 0) {
        const hasReact = runnableMatches.some(m => ['tsx', 'jsx', 'react'].includes(m.language) || (['typescript', 'ts', 'javascript', 'js'].includes(m.language) && /import\s+React|export\s+default\s+function|<\w+[\s>]/.test(m.content)));
        const hasHtml = runnableMatches.some(m => ['html', 'htm', 'svg'].includes(m.language) || m.content.includes('<!DOCTYPE') || m.content.includes('<html') || m.content.trim().startsWith('<svg'));
        const hasPython = runnableMatches.some(m => ['python', 'py'].includes(m.language));

        if (hasReact || (!hasHtml && !hasPython)) {
            template = 'react';
            let appFound = false;
            runnableMatches.forEach((m, idx) => {
                const isCodeReact = ['tsx', 'jsx', 'react', 'typescript', 'ts', 'javascript', 'js'].includes(m.language) || /import\s+React|export\s+default\s+function|<\w+[\s>]/.test(m.content);
                if (isCodeReact && !appFound) {
                    files.push({
                        id: 'file-app',
                        name: 'App.tsx',
                        language: 'react',
                        content: m.content,
                        isEntry: true
                    });
                    appFound = true;
                } else if (m.language === 'css') {
                    files.push({
                        id: `file-css-${idx}`,
                        name: 'styles.css',
                        language: 'css',
                        content: m.content
                    });
                } else {
                    files.push({
                        id: `file-${idx}`,
                        name: `Component_${idx}.tsx`,
                        language: 'react',
                        content: m.content
                    });
                }
            });
            if (!files.some(f => f.name === 'styles.css')) {
                files.push({
                    id: 'file-css-default',
                    name: 'styles.css',
                    language: 'css',
                    content: `/* Studio Sandbox Styles */\nbody { margin: 0; padding: 0; }`
                });
            }
        } else if (hasHtml) {
            template = 'vanilla-html';
            const htmlMatch = runnableMatches.find(m => ['html', 'htm', 'svg'].includes(m.language) || m.content.includes('<!DOCTYPE') || m.content.includes('<html') || m.content.trim().startsWith('<svg'));
            let htmlContent = htmlMatch ? htmlMatch.content : '<div>Live Preview</div>';
            if (htmlMatch?.language === 'svg' || htmlContent.trim().startsWith('<svg')) {
                htmlContent = `<!DOCTYPE html>\n<html>\n<head>\n  <style>\n    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #09090b; color: #fff; }\n    svg { max-width: 90vw; max-height: 85vh; filter: drop-shadow(0 20px 30px rgba(0,0,0,0.5)); }\n  </style>\n</head>\n<body>\n  ${htmlContent}\n</body>\n</html>`;
            }
            files.push({
                id: 'file-index',
                name: 'index.html',
                language: 'html',
                content: htmlContent,
                isEntry: true
            });
            const cssMatch = runnableMatches.find(m => m.language === 'css');
            if (cssMatch) {
                files.push({
                    id: 'file-styles',
                    name: 'styles.css',
                    language: 'css',
                    content: cssMatch.content
                });
            }
        } else if (hasPython) {
            template = 'python';
            const pyMatch = runnableMatches.find(m => ['python', 'py'].includes(m.language));
            files.push({
                id: 'file-main-py',
                name: 'main.py',
                language: 'python',
                content: pyMatch?.content || '# Live Python WASM Sandbox\nprint("Hello from Scratchbox!")',
                isEntry: true
            });
        }
    }

    // If no code files extracted but isSandboxExplicit is true, synthesize a rich interactive application
    if (files.length === 0) {
        template = 'react';
        if (is3DStudioIntent(prompt, title)) {
            files.push({
                id: 'file-app',
                name: 'App.tsx',
                language: 'react',
                content: generate3DStudioApp(title),
                isEntry: true
            });
            files.push({
                id: 'file-controls',
                name: 'Controls.tsx',
                language: 'react',
                content: generate3DControls(),
                isEntry: false
            });
            files.push({
                id: 'file-cpp',
                name: 'world_generator.cpp',
                language: 'cpp',
                content: generateNativeCppGenerator(title),
                isEntry: false
            });
            files.push({
                id: 'file-css',
                name: 'styles.css',
                language: 'css',
                content: `/* Studio Sandbox Styles */\nbody { margin: 0; padding: 0; background: #09090b; }`
            });
            dependencies['three'] = '^0.160.0';
            dependencies['lucide-react'] = '^0.468.0';
        } else {
            files.push({
                id: 'file-app',
                name: 'App.tsx',
                language: 'react',
                content: generateContextualReactApp(prompt, title),
                isEntry: true
            });
            files.push({
                id: 'file-css',
                name: 'styles.css',
                language: 'css',
                content: `/* Studio Sandbox Styles */\nbody { margin: 0; padding: 0; }`
            });
        }
    }

    const sandboxData: LiveCodeSandboxData = {
        title,
        subtitle: `Live interactive preview generated for ${title}`,
        template,
        files,
        activeFileId: files.find(f => f.isEntry)?.id || files[0]?.id,
        viewMode: 'preview',
        viewportMode: 'desktop',
        autoRun: true,
        dependencies
    };

    const artifact: CanvasArtifact = {
        id: (activeArtifact?.type === 'live-code-sandbox' ? activeArtifact.id : undefined) || `art-sandbox-${Date.now()}`,
        type: 'live-code-sandbox',
        title,
        summary: sandboxData.subtitle || `Interactive live preview for ${title}`,
        version: (activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.version || 1) + 1 : 1),
        createdAt: timestamp,
        data: sandboxData
    };

    return {
        artifact,
        hasRunnableCode: runnableMatches.length > 0
    };
}

/**
 * Extract a rich, specific document title from prompt context, avoiding generic strings.
 */
export function extractDocumentTitle(prompt: string, fallback: string = 'Strategic Specification & Notes'): string {
    if (/1776/i.test(prompt)) {
        return 'The Profound Significance of 1776: Liberty, Revolution, and Democratic Thought';
    }
    if (/auth(entication)?|oauth|jwt|security|identity|zero[- ]trust/i.test(prompt)) {
        return 'Technical Specification: Scalable Authentication & Zero-Trust Identity Infrastructure';
    }
    if (/proposal|roadmap|business plan/i.test(prompt)) {
        return 'Executive Project Proposal & Strategic Roadmap';
    }
    const cleanPrompt = prompt
        .replace(/^[\s\W]*(write|create|generate|draft|build|make)?\s*(a|an|the)?\s*(document|spec|specification|overview|notes|guide|report|proposal)?\s*(about|for|on|of)?\s*/i, '')
        .replace(/for section ["'].*?["']/i, '')
        .replace(/in document ["'](.*?)["']/i, '$1')
        .replace(/[?.!]+$/, '')
        .trim();

    if (cleanPrompt.length > 2 && cleanPrompt !== 'selected content') {
        return cleanPrompt.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 75);
    }
    return fallback && fallback !== 'Markdown Document' ? fallback : 'Project Specification & Strategic Notes';
}

/**
 * Synthesize a comprehensive, executive document hierarchy for any topic with rich 4D capabilities.
 */
export function synthesizeComprehensiveDocument(prompt: string, customTitle?: string): MarkdownDocumentData {
    return synthesizeDocumentFromEngine(prompt, customTitle || extractDocumentTitle(prompt));
}

/**
 * Parse JSON from AI model output or wrap markdown into a structured canvas primitive.
 */
export function parseOrSynthesizeArtifact(
    prompt: string,
    modelText: string,
    request: GeminiGenerateRequest,
    _mcpExecutions: McpExecutionState[],
    groundingMetadata?: GroundingMetadata
): CanvasArtifact {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const enrichGroundedCitations = (targetSections: MarkdownSection[]): MarkdownSection[] => {
        if (!groundingMetadata?.groundingChunks || groundingMetadata.groundingChunks.length === 0) {
            return targetSections;
        }
        const groundedCitations: CitationItem[] = groundingMetadata.groundingChunks
            .filter(c => c.web && (c.web.uri || c.web.title))
            .map((c, idx) => ({
                id: `cite-google-${idx + 1}-${Date.now()}`,
                sourceTitle: c.web?.title || c.web?.uri || `Google Search Grounded Reference ${idx + 1}`,
                url: c.web?.uri,
                verified: true,
                badgeText: 'Google Search Verified',
                archiveName: 'Google Search Grounding'
            }));

        if (groundedCitations.length === 0) return targetSections;

        const citeIdx = targetSections.findIndex(s => s.type === 'citation');
        if (citeIdx !== -1) {
            const existingSec = targetSections[citeIdx];
            const existingUrls = new Set((existingSec.citationItems || []).map(ci => ci.url).filter(Boolean));
            const merged = [
                ...groundedCitations,
                ...(existingSec.citationItems || []).filter(ci => !ci.url || !existingUrls.has(ci.url))
            ];
            const newSections = [...targetSections];
            newSections[citeIdx] = {
                ...existingSec,
                citationItems: merged
            };
            return newSections;
        } else {
            return [
                ...targetSections,
                {
                    id: `sec-citations-grounded-${Date.now()}`,
                    type: 'citation' as const,
                    citationItems: groundedCitations
                }
            ];
        }
    };

    // 0. Unified Artifact Tag Architecture (<scratchboxPrimitive type="..." title="..." summary="..." version="...">)
    const primitiveTag = extractScratchboxPrimitiveTag(modelText);
    if (primitiveTag.matched && primitiveTag.type) {
        let tagType = primitiveTag.type as PrimitiveType;
        const tagPayload = primitiveTag.rawPayload || '';

        // Attempt 1: Inner payload is a JSON code block or raw JSON object
        const jsonInTag = tagPayload.match(/```json\s*([\s\S]*?)\s*```/) || (tagPayload.startsWith('{') && tagPayload.endsWith('}') ? [null, tagPayload] : null);
        let parsedTagData: any = null;
        if (jsonInTag) {
            try {
                const parsed = JSON.parse(jsonInTag[1]!);
                if (parsed) {
                    parsedTagData = parsed.data !== undefined ? parsed.data : parsed;
                    if (parsed.type) tagType = parsed.type;
                }
            } catch {
                // Ignore JSON parse error, fall through to specialized tagType synthesizers
            }
        }

        // Attempt 2: If live-code-sandbox and inner payload is raw code / component
        if (tagType === 'live-code-sandbox') {
            if (!parsedTagData || !parsedTagData.files) {
                const codeMatch = tagPayload.match(/```(?:tsx|jsx|react|typescript|ts|javascript|js|html)?\s*\n([\s\S]*?)```/) || [null, tagPayload];
                const rawCode = (codeMatch[1] || tagPayload).trim();
                const template: SandboxTemplate = rawCode.includes('def ') || rawCode.includes('import numpy') ? 'python' : 'react';
                const entryName = template === 'python' ? 'main.py' : 'App.tsx';
                const entryLang = template === 'python' ? 'python' : 'react';

                parsedTagData = {
                    title: primitiveTag.title || 'Interactive Micro-App',
                    subtitle: primitiveTag.summary || 'Live interactive micro-app generated by Scratchbox AI',
                    template,
                    viewMode: 'preview',
                    viewportMode: 'desktop',
                    dependencies: {
                        'lucide-react': '^0.468.0',
                        'canvas-confetti': '^1.9.3',
                        'three': '^0.160.0',
                        'framer-motion': '^11.0.0'
                    },
                    files: (!rawCode && is3DStudioIntent(prompt, primitiveTag.title || 'Interactive Micro-App')) ? [
                        {
                            id: 'file-entry',
                            name: 'App.tsx',
                            language: 'react',
                            content: generate3DStudioApp(primitiveTag.title || '3D Mesh Studio'),
                            isEntry: true
                        },
                        {
                            id: 'file-controls',
                            name: 'Controls.tsx',
                            language: 'react',
                            content: generate3DControls(),
                            isEntry: false
                        },
                        {
                            id: 'file-cpp',
                            name: 'world_generator.cpp',
                            language: 'cpp',
                            content: generateNativeCppGenerator(primitiveTag.title || '3D Mesh Studio'),
                            isEntry: false
                        },
                        {
                            id: 'file-css',
                            name: 'styles.css',
                            language: 'css',
                            content: '/* Scratchbox Sandbox Styles */\nbody { margin: 0; padding: 0; background: #09090b; }'
                        }
                    ] : [
                        {
                            id: 'file-entry',
                            name: entryName,
                            language: entryLang,
                            content: rawCode || generateContextualReactApp(prompt, primitiveTag.title || 'Interactive Micro-App'),
                            isEntry: true
                        },
                        {
                            id: 'file-css',
                            name: 'styles.css',
                            language: 'css',
                            content: '/* Scratchbox Sandbox Styles */\nbody { margin: 0; padding: 0; }'
                        }
                    ],
                    activeFileId: 'file-entry'
                };
            }
        }

        // Attempt 3: If markdown-document and inner payload is markdown
        if (tagType === 'markdown-document') {
            if (!parsedTagData || !parsedTagData.sections) {
                const docTitle = primitiveTag.title || extractDocumentTitle(prompt, 'Project Specification');
                const rawSections = markdownStringToSections(tagPayload);
                const completeSections = rawSections.length > 0 ? ensureCompleteSections(rawSections, docTitle) : synthesizeComprehensiveDocument(prompt, docTitle).sections;
                parsedTagData = {
                    title: docTitle,
                    subtitle: primitiveTag.summary || 'Synthesized with Studio AI Engine',
                    author: DEFAULT_DOCUMENT_AUTHOR,
                    lastUpdated: 'Just now',
                    tags: ['Specification', 'Architecture'],
                    sections: enrichGroundedCitations(completeSections)
                };
            }
        }

        if (parsedTagData) {
            const isSameType = request.activeArtifact?.type === tagType;
            const effectiveVersion = (isSameType && request.activeArtifact) ? (request.activeArtifact.version || 1) + 1 : (primitiveTag.version || 1);
            const effectiveId = (isSameType && request.activeArtifact) ? request.activeArtifact.id : `art-${tagType}-${Date.now()}`;

            return {
                id: effectiveId,
                type: tagType,
                title: primitiveTag.title || parsedTagData.title || `${tagType} Artifact`,
                summary: primitiveTag.summary || parsedTagData.subtitle || `Interactive ${tagType} mounted via unified primitive tag.`,
                version: effectiveVersion,
                createdAt: timestamp,
                data: parsedTagData
            };
        }
    }

    // Extract clean text and JSON codeblock
    const cleanContent = modelText
        .replace(/<scratchboxPrimitive[\s\S]*?(?:<\/scratchboxPrimitive>|$)/gi, '')
        .replace(/```json[\s\S]*?```/g, '')
        .trim() || modelText;
    const jsonMatch = modelText.match(/```json\s*([\s\S]*?)\s*```/) || modelText.match(/(\{[\s\S]*"type"[\s\S]*"data"[\s\S]*\})/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[1]);
            if (parsed) {
                let type = parsed.type as string;
                if (type === 'action-checklist') type = 'checklist';
                if (type === 'skills-manager') type = 'skills-hub';
                if (type === 'rendered-document' || type === 'document') type = 'markdown-document';
                if (type === 'flow-graph' || type === 'graph') type = 'node-graph';
                if (type === 'metrics' || type === 'dashboard') type = 'metric-dashboard';
                if (type === 'kanban') type = 'kanban-board';
                if (type === 'form') type = 'interactive-form';
                if (type === 'sandbox' || type === 'code-sandbox' || type === 'playground' || type === 'code-playground') type = 'live-code-sandbox';
                if (type === '3d' || type === 'scene-3d' || type === 'spatial-scene' || type === '3d_scene' || type === '3d-world' || type === 'r3f-scene') type = '3d-scene';
                if (type === 'video-timeline' || type === 'video' || type === 'timeline' || type === 'video-editor' || type === 'nle' || type === 'video_timeline') type = 'video-timeline';

                let data = parsed.data;
                const isVideoTimelineRequest = type === 'video-timeline' || request.activeArtifact?.type === 'video-timeline' ||
                    /split\s+(?:active\s+)?clip|ripple\s+delete|playhead|video\s+timeline|timeline\s+editor|video\s+editor|\bnle\b|cut\s+clip|trim\s+clip|multi-track\s+video|b-roll|a-roll|video\s+track|audio\s+mixer\s+track|color\s+grade\s+clip|chroma\s*key|green\s*screen|blue\s*screen|despill|video\s+composite|composite\s+clip|light\s*wrap/i.test(prompt) ||
                    ((prompt.toLowerCase().includes('clip') || prompt.toLowerCase().includes('timeline')) && (prompt.toLowerCase().includes('split') || prompt.toLowerCase().includes('cut') || prompt.toLowerCase().includes('delete') || prompt.toLowerCase().includes('playhead') || prompt.toLowerCase().includes('ripple') || prompt.toLowerCase().includes('track') || prompt.toLowerCase().includes('video') || prompt.toLowerCase().includes('composite') || prompt.toLowerCase().includes('key')));

                const isImageRequest = /create\s+(?:a\s+)?picture|generate\s+(?:a\s+)?picture|picture\s+of|draw\s+(?:a\s+)?picture|image\s+of|generate\s+(?:an?\s+)?image|create\s+(?:an?\s+)?image|photo\s+of|photograph\s+of|illustration\s+of|painting\s+of|artwork\s+of|draw\s+(?:an?\s+)?image|make\s+(?:a\s+)?picture|make\s+(?:an?\s+)?image|\bpicture\b|\bphoto\b|\billustration\b|\bpainting\b/i.test(prompt);
                const isVideoRequest = !isVideoTimelineRequest && (/create\s+(?:a\s+)?video|generate\s+(?:a\s+)?video|video\s+of|make\s+(?:a\s+)?video|film\s+of|motion\s+clip|video\s+clip|record\s+(?:a\s+)?video|\bvideo\s+file\b|\bvideo\b/i.test(prompt));
                const isMediaRequest = isImageRequest || isVideoRequest;

                const is3DActive = request.activeArtifact?.type === '3d-scene';
                const is3DFollowUpKeywords = /animate|fly|flight|motion|orbit|play|simulation|bank|roll|spin|takeoff|speed|camera|view|scene|heading|pitch|thrust|god\s*ray|crepuscular|light\s*shaft|contrail|control\s*surface|aileron|elevator|rudder|biome|terrain|atmosphere|scattering|shader/i.test(prompt) ||
                    prompt.toLowerCase().includes('animate') || prompt.toLowerCase().includes('fly') || prompt.toLowerCase().includes('play') || prompt.toLowerCase().includes('orbit') || prompt.toLowerCase().includes('motion') || prompt.toLowerCase().includes('takeoff');

                const isSandboxOrAppRequest = !isVideoTimelineRequest && !isMediaRequest && (!is3DActive || !is3DFollowUpKeywords) && (/preview|sandbox|\bapp\b|web\s*app|landing\s*page|calculator|game|arcade|gravity|orbit|physics|celestial|synth|synthesizer|piano|keyboard|audio|music|sound|sorting|visualizer|dashboard|component|widget|mockup|\bui\b|react|html|css|javascript|typescript|python|interactive|simulator/i.test(prompt));
                const isDocExplicitRequest = /document|doc\b|spec|write\s+(?:a\s+)?(?:doc|document|spec|essay|report|paper)|article|research\s+paper/i.test(prompt);

                const is3DFollowUp = !isMediaRequest && !isDocExplicitRequest && !isVideoTimelineRequest && is3DActive && is3DFollowUpKeywords;

                const isExplicit3DIntent = !isVideoTimelineRequest && !isMediaRequest && (
                    /\b3d\s+(?:car|vehicle|automobile|truck|sports\s*car|plane|scene|model|world|building|robot|character|mesh|room|furniture|object|simulation|asset)\b/i.test(prompt) ||
                    /\b(?:build|make|create|generate|render|simulate)\s+(?:me\s+)?(?:a\s+)?3d\b/i.test(prompt) ||
                    /\b(?:build|make|create|generate|render|simulate)\s+(?:me\s+)?(?:a\s+)?(?:3d\s+)?scene\b/i.test(prompt) ||
                    /\b(?:three\.js|threejs|webgl|wgsl|mesh|geometry|sdf|marching\s+cubes|pbr\s+material|procedural\s+terrain)\b/i.test(prompt) ||
                    /planetary\s+orbit|cyberpunk\s+city|architectural\s+blueprint/i.test(prompt)
                );

                if (isVideoTimelineRequest && type !== 'video-timeline') {
                    type = 'video-timeline';
                } else if (isExplicit3DIntent) {
                    type = '3d-scene';
                } else if (isDocExplicitRequest && type === '3d-scene' && !/3d\s+scene|3d\s+plane|3d\s+world|3d\s+model|spatial\s+scene|three\.js|threejs/i.test(prompt)) {
                    type = 'markdown-document';
                } else if (is3DFollowUp && type !== '3d-scene') {
                    type = '3d-scene';
                } else if (isMediaRequest && type === '3d-scene') {
                    type = 'markdown-document';
                } else if (isSandboxOrAppRequest && type === '3d-scene' && !isExplicit3DIntent && !is3DFollowUp) {
                    type = 'live-code-sandbox';
                }

                if (type === '3d-scene') {
                    const active3DData = is3DActive ? (request.activeArtifact?.data as Scene3DData) : undefined;
                    const isExplicitFlight = /plane|airplane|jet\s+aircraft|jet\s+transit|flight\s+corridor|aviation\s+sim/i.test(prompt) ||
                        (parsed.title && /plane|airplane|jet\s+aircraft|jet\s+transit/i.test(parsed.title)) ||
                        (data?.title && /plane|airplane|jet\s+aircraft|jet\s+transit/i.test(data.title));
                    
                    const isAnimateOnly = is3DFollowUp && !/new|change|build|create|switch/i.test(prompt) && /animate|fly|flight|motion|orbit|play|simulation|bank|roll|spin|takeoff/i.test(prompt);

                    const isTopicChange = !isAnimateOnly && (
                        /build|make|create|generate|new\s+scene|car|vehicle|automobile|truck|sports\s*car|sedan/i.test(prompt) ||
                        (parsed.title && /car|vehicle|automobile|truck|sports\s*car|sedan/i.test(parsed.title)) ||
                        (active3DData && !/car|vehicle|automobile|truck|sports\s*car|sedan/i.test(active3DData.title || '') && /car|vehicle|automobile|truck|sports\s*car|sedan/i.test(prompt))
                    );

                    // Synthesize procedural scene baseline based on prompt & active context
                    const docContent = request.activeArtifact?.type === 'markdown-document'
                        ? (request.activeArtifact.data as MarkdownDocumentData)?.sections?.map(s => s.content || s.calloutTitle || '').join(' ')
                        : undefined;
                    const contextualSynthesized = synthesizeContextual3DScene(prompt, {
                        activeArtifact: request.activeArtifact,
                        chatHistory: request.chatHistory,
                        docTitle: request.activeArtifact?.title,
                        docContent
                    });

                    const effectiveTitle = parsed.title || data?.title || (isAnimateOnly && active3DData ? active3DData.title : contextualSynthesized.title);
                    const effectiveSubtitle = isAnimateOnly && isExplicitFlight
                        ? 'Animated 3D flight trajectory: dynamic bank, roll, and engine thrust active.'
                        : (parsed.summary || data?.subtitle || (isAnimateOnly && active3DData ? active3DData.subtitle : contextualSynthesized.subtitle));

                    const defaultObjects = isExplicitFlight
                        ? [
                            {
                                id: 'obj-aircraft-1',
                                content: {
                                    type: '3d-scene' as const,
                                    durableUri: 'internal:plane',
                                    mimeType: 'model/procedural-aircraft',
                                    metadata: { dims: { width: 12, height: 4, depth: 14 } }
                                },
                                space: {
                                    spatial3d: { x: 0, y: 3.5, z: 0, pitch: 0, yaw: 0, roll: 0 }
                                },
                                time: { startMs: 0, durationMs: 10000 },
                                lineage: { version: 1 }
                            }
                        ]
                        : (data?.objects || contextualSynthesized.objects || []);

                    const sceneTimeline = isAnimateOnly ? {
                        currentTimeMs: data?.timeline?.currentTimeMs ?? 0,
                        durationMs: data?.timeline?.durationMs ?? active3DData?.timeline?.durationMs ?? 10000,
                        isPlaying: true,
                        speed: data?.timeline?.speed ?? data?.timeline?.playbackSpeed ?? 1.0,
                        playbackSpeed: data?.timeline?.playbackSpeed ?? data?.timeline?.speed ?? 1.0,
                        isLooping: true,
                        ...(data?.timeline || {})
                    } : (data?.timeline || contextualSynthesized.timeline);

                    const sceneAnimation = isAnimateOnly
                        ? (data?.animation || (prompt.toLowerCase().includes('orbit') ? 'orbit' : 'flight'))
                        : (data?.animation || contextualSynthesized.animation);

                    const hasGodRays = /god\s*ray|crepuscular|light\s*shaft|volumetric\s*light/i.test(prompt) || !!data?.features?.godRays || !!active3DData?.features?.godRays;
                    const hasAtmosphere = /\b(?:atmosphere|atmospheric|scattering|rayleigh|mie|realistic\s*sky|aerial\s*perspective)\b/i.test(prompt) || !!data?.features?.atmosphericScattering || !!active3DData?.features?.atmosphericScattering;
                    const hasContrails = /contrail|vapor|vortex|wingtip\s*trail/i.test(prompt) || !!data?.features?.contrails || !!active3DData?.features?.contrails;
                    const hasControlSurfaces = /control\s*surface|aileron|elevator|rudder|flap/i.test(prompt) || !!data?.features?.controlSurfaces || !!active3DData?.features?.controlSurfaces;
                    const hasTerrainBiomes = /biome|terrain|canyon|alpine|mountain|coastal|desert/i.test(prompt) || !!data?.features?.terrainBiomes || !!active3DData?.features?.terrainBiomes;

                    const effectiveFeatures = {
                        ...(contextualSynthesized.features || {}),
                        ...(isTopicChange ? {} : (active3DData?.features || {})),
                        ...(data?.features || {}),
                        ...(hasGodRays && hasAtmosphere ? { godRays: true } : {}),
                        ...(hasAtmosphere ? { atmosphericScattering: true } : {}),
                        ...(hasContrails ? { contrails: true } : {}),
                        ...(hasControlSurfaces ? { controlSurfaces: true } : {}),
                        ...(hasTerrainBiomes ? { terrainBiomes: (data?.features?.terrainBiomes || active3DData?.features?.terrainBiomes || { biomeType: 'alpine' as const }) } : {})
                    };

                    const isVehicleTheme = /car|vehicle|automobile|truck|sports\s*car|sedan/i.test(prompt) || /car|vehicle|automobile|truck|sports\s*car|sedan/i.test(effectiveTitle);

                    const scene3DData: Scene3DData = {
                        title: effectiveTitle,
                        subtitle: effectiveSubtitle,
                        worldBranch: isVehicleTheme ? (data?.worldBranch && !/city|urban|street/i.test(data.worldBranch) ? data.worldBranch : 'studio/showroom') : (data?.worldBranch || (isTopicChange ? undefined : active3DData?.worldBranch) || contextualSynthesized.worldBranch),
                        sceneType: isVehicleTheme ? 'custom' : (data?.sceneType || (isTopicChange ? undefined : active3DData?.sceneType) || contextualSynthesized.sceneType),
                        renderMode: data?.renderMode || (isTopicChange ? undefined : active3DData?.renderMode) || contextualSynthesized.renderMode || 'pbr',
                        cameraMode: data?.cameraMode || (isTopicChange ? undefined : active3DData?.cameraMode) || contextualSynthesized.cameraMode || 'orbit',
                        animation: sceneAnimation,
                        camera: data?.camera || (isTopicChange ? contextualSynthesized.camera : (active3DData?.camera || contextualSynthesized.camera)) || {
                            position: [15, 12, 20],
                            target: [0, 2, 0],
                            fov: 45
                        },
                        environment: isTopicChange ? {
                            lighting: isVehicleTheme ? 'studio' : 'daylight',
                            ground: true,
                            ...(contextualSynthesized.environment || {}),
                            ...(data?.environment || {})
                        } : {
                            lighting: 'daylight',
                            ground: true,
                            ...(active3DData?.environment || {}),
                            ...(contextualSynthesized.environment || {}),
                            ...(data?.environment || {}),
                            skybox: data?.environment?.skybox || (hasAtmosphere ? 'realistic-sky' : (active3DData?.environment?.skybox || contextualSynthesized.environment?.skybox || 'studio')),
                        },
                        timeline: sceneTimeline,
                        customScript: data?.customScript || data?.code || (isTopicChange ? undefined : active3DData?.customScript) || contextualSynthesized.customScript,
                        code: data?.code || data?.customScript || (isTopicChange ? undefined : active3DData?.code) || contextualSynthesized.code,
                        shaders: data?.shaders || (isTopicChange ? undefined : active3DData?.shaders) || contextualSynthesized.shaders,
                        features: effectiveFeatures,
                        customMeshes: (() => {
                            if (data?.customMeshes && Array.isArray(data.customMeshes) && data.customMeshes.length > 0) {
                                if (!isTopicChange && active3DData?.customMeshes && active3DData.customMeshes.length > 0) {
                                    const map = new Map<string, CustomMesh>();
                                    active3DData.customMeshes.forEach(m => map.set(m.id, m));
                                    (data.customMeshes as CustomMesh[]).forEach(m => map.set(m.id, m));
                                    return Array.from(map.values());
                                }
                                return data.customMeshes;
                            }
                            return isTopicChange ? contextualSynthesized.customMeshes : (active3DData?.customMeshes || contextualSynthesized.customMeshes);
                        })(),
                        objects: isTopicChange ? (contextualSynthesized.objects || []) : (isExplicitFlight ? defaultObjects : (active3DData?.objects && active3DData.objects.length > 0 ? active3DData.objects : defaultObjects)),
                        operatorStack: data?.operatorStack || (isTopicChange ? [] : active3DData?.operatorStack) || [],
                        actionLog: data?.actionLog || (isTopicChange ? [] : active3DData?.actionLog) || [],
                        sculptSettings: data?.sculptSettings || (isTopicChange ? undefined : active3DData?.sculptSettings),
                        selectedMeshId: data?.selectedMeshId || (isTopicChange ? undefined : active3DData?.selectedMeshId),
                        wasmPhysics: data?.wasmPhysics || (isTopicChange ? undefined : active3DData?.wasmPhysics) || contextualSynthesized.wasmPhysics,
                        geoAnchor: data?.geoAnchor || (isTopicChange ? undefined : active3DData?.geoAnchor) || contextualSynthesized.geoAnchor,
                        droneRoute: data?.droneRoute || (isTopicChange ? undefined : active3DData?.droneRoute) || contextualSynthesized.droneRoute,
                        cppGenerator: data?.cppGenerator || (isTopicChange ? contextualSynthesized.cppGenerator : (active3DData?.cppGenerator || contextualSynthesized.cppGenerator))
                    };
                    data = scene3DData;
                    parsed.title = effectiveTitle;
                }
                if (type === 'video-timeline') {
                    const isVideoActive = request.activeArtifact?.type === 'video-timeline';
                    const activeVideoData = isVideoActive ? (request.activeArtifact?.data as VideoTimelineData) : undefined;
                    const timelineData = synthesizeContextualVideoTimeline(
                        prompt,
                        parsed.title || data?.title,
                        data?.tracks && data.tracks.length > 0 ? (data as VideoTimelineData) : activeVideoData
                    );
                    if (data && typeof data === 'object') {
                        if (data.aspectRatio) timelineData.aspectRatio = data.aspectRatio;
                        if (data.fps) timelineData.fps = data.fps;
                        if (data.duration) timelineData.duration = data.duration;
                        if (data.currentTime !== undefined) timelineData.currentTime = data.currentTime;
                        if (data.tracks && Array.isArray(data.tracks) && data.tracks.length > 0) timelineData.tracks = data.tracks;
                    }
                    data = timelineData;
                    parsed.title = parsed.title || timelineData.title;
                    parsed.summary = parsed.summary || timelineData.subtitle;
                }
                if (type === 'markdown-document') {
                    const fallbackTitle = request.activeArtifact?.title && request.activeArtifact.title !== 'Markdown Document'
                        ? request.activeArtifact.title
                        : extractDocumentTitle(prompt);

                    let effectiveDocTitle = parsed.title && parsed.title !== 'Markdown Document'
                        ? parsed.title
                        : (data?.title && data.title !== 'Markdown Document' ? data.title : fallbackTitle);

                    const isFullDocRequest = /write|create|generate|draft|paper|research|essay|article|report|guide|brief|memo|spec|overview|summary|proposal|1776|auth|history|battle/i.test(prompt) ||
                        !data?.sections || data.sections.length <= 1;
                    const isMinimal = /concise|minimal|text[- ]only|no[- ]media|no[- ]images?|no[- ]video/i.test(prompt);

                    if (typeof data === 'string') {
                        const sections = markdownStringToSections(data);
                        data = {
                            title: effectiveDocTitle,
                            subtitle: parsed.summary || 'Strategic overview',
                            sections
                        };
                    } else if (data && typeof data === 'object') {
                        let sections = Array.isArray(data.sections) ? data.sections : [];
                        if (sections.length === 0 && cleanContent) {
                            sections = markdownStringToSections(cleanContent);
                        }
                        data = {
                            ...data,
                            title: effectiveDocTitle,
                            sections
                        };
                    }

                    // If it's a full document request or sections are missing/incomplete, synthesize rich 4D sections
                    if ((isFullDocRequest || !data?.sections || data.sections.length <= 2) && (!isMinimal || !data?.sections || data.sections.length <= 2)) {
                        const synthesized = synthesizeComprehensiveDocument(prompt, effectiveDocTitle);
                        data = {
                            ...synthesized,
                            title: effectiveDocTitle || synthesized.title
                        };
                    }

                    // If request has activeArtifact that is markdown-document, and prompt is a section modification, surgically merge
                    if (request.activeArtifact?.type === 'markdown-document' && request.activeArtifact.data) {
                        const activeDoc = request.activeArtifact.data as MarkdownDocumentData;
                        const sectionMatch = prompt.match(/for section ["'](.*?)["']/i) || prompt.match(/selected excerpt: ["'](.*?)["']/i);
                        if (sectionMatch && activeDoc.sections && activeDoc.sections.length > 0) {
                            const targetQuery = sectionMatch[1].toLowerCase().trim();
                            const targetIdx = activeDoc.sections.findIndex(s => (s.content || s.calloutTitle || '').toLowerCase().includes(targetQuery));
                            if (targetIdx !== -1 && data?.sections && data.sections.length > 0) {
                                const mergedSections = [...activeDoc.sections];
                                mergedSections.splice(targetIdx, 1, ...data.sections);
                                data.sections = mergedSections;
                                data.title = activeDoc.title || effectiveDocTitle;
                                effectiveDocTitle = data.title;
                            }
                        }
                    }

                    // Sanitize and guarantee all headings and callouts are fully populated
                    if (data && Array.isArray(data.sections)) {
                        let headingCount = 0;
                        data.sections = data.sections.map((sec: any, idx: number) => {
                            if (!sec || typeof sec !== 'object') return sec;
                            const secType = sec.type || 'paragraph';
                            const id = sec.id || `sec-${secType}-${idx + 1}`;

                            if (secType === 'heading') {
                                const rawContent = sec.content ?? sec.heading ?? sec.title ?? sec.text ?? sec.name ?? sec.headingText ?? sec.value ?? '';
                                let content = typeof rawContent === 'string' ? rawContent.trim() : '';
                                const currentHeadingIdx = headingCount++;

                                if (!content || /^(heading(\s+text)?\.{0,3}|new\s+section(\s+heading)?\.{0,3}|untitled(\s+section)?\.{0,3})$/i.test(content)) {
                                    const num = currentHeadingIdx + 1;
                                    const titleLower = effectiveDocTitle.toLowerCase();

                                    // Dynamically determine domain-appropriate opening and section headings on the fly
                                    let h1Prefix = 'Overview & Core Concepts';
                                    let h2Pillar = 'Theoretical Foundations & Mechanics';
                                    let h2Sub1 = 'Core Principles & Architecture';
                                    let h2Sub2 = 'Methodologies & Structural Analysis';
                                    let h3Milestone = 'Key Findings & Future Trajectory';

                                    if (/science|physics|astronomy|eclipse|biology|chemistry|quantum|genetics/i.test(titleLower)) {
                                        h1Prefix = 'Overview & Theoretical Foundations';
                                        h2Pillar = 'Empirical Mechanics & Observational Data';
                                        h2Sub1 = 'Fundamental Physical Principles';
                                        h2Sub2 = 'Experimental Verification & Dynamics';
                                        h3Milestone = 'Research Frontiers & Open Inquiries';
                                    } else if (/history|revolution|war|treaty|ancient|medieval|empire|century|founding|1776/i.test(titleLower)) {
                                        h1Prefix = 'Historical Context & Genesis';
                                        h2Pillar = 'Chronology & Transformational Milestones';
                                        h2Sub1 = 'Catalysts & Primary Grievances';
                                        h2Sub2 = 'Institutional Evolution & Legacy';
                                        h3Milestone = 'Historical Assessment & Modern Impact';
                                    } else if (/auth|security|identity|zero[- ]trust|crypto|network|infrastructure/i.test(titleLower)) {
                                        h1Prefix = 'System Overview & Threat Model';
                                        h2Pillar = 'Protocol Architecture & Trust Boundaries';
                                        h2Sub1 = 'Handshake Specifications & Token Lifecycles';
                                        h2Sub2 = 'Automated Verification & Guardrails';
                                        h3Milestone = 'Deployment Milestones & Convergence Checklist';
                                    } else if (/strategy|business|proposal|pitch|roadmap|product/i.test(titleLower)) {
                                        h1Prefix = 'Strategic Overview & Vision';
                                        h2Pillar = 'Market Pillars & Execution Roadmap';
                                        h2Sub1 = 'Value Proposition & Architecture';
                                        h2Sub2 = 'Operational Mechanics & Risk Matrix';
                                        h3Milestone = 'Key Milestones & Convergence Checklist';
                                    }

                                    const dynamicHeadings = [
                                        `1. ${h1Prefix}: ${effectiveDocTitle}`,
                                        `2. ${h2Pillar}`,
                                        `2.1 ${h2Sub1}`,
                                        `2.2 ${h2Sub2}`,
                                        `3. ${h3Milestone}`
                                    ];
                                    content = dynamicHeadings[currentHeadingIdx] || `${num}. Analysis & System Specification for ${effectiveDocTitle}`;
                                }

                                return {
                                    ...sec,
                                    id,
                                    type: 'heading',
                                    level: sec.level === 1 || sec.level === 2 || sec.level === 3 ? sec.level : (currentHeadingIdx === 0 ? 1 : 2),
                                    content
                                };
                            } else if (secType === 'callout') {
                                let calloutTitle = sec.calloutTitle ?? sec.title ?? sec.heading ?? sec.name ?? '';
                                let content = sec.content ?? sec.text ?? sec.body ?? '';

                                if (!calloutTitle || /^(callout(\s+title)?\.{0,3}|note\.{0,3}|title\.{0,3})$/i.test(calloutTitle.trim())) {
                                    const boldPrefixMatch = content.match(/^\*\*([^*:]+?)(?:\s*Callout)?:\*\*\s*([\s\S]*)$/i) || content.match(/^\[!([A-Z]+)\]\s*(.*)$/i);
                                    if (boldPrefixMatch) {
                                        calloutTitle = boldPrefixMatch[1].trim();
                                        content = boldPrefixMatch[2].trim() || content;
                                    } else if (/1776/i.test(effectiveDocTitle)) {
                                        calloutTitle = 'Primary Source & Historical Context';
                                    } else if (/auth|security/i.test(effectiveDocTitle)) {
                                        calloutTitle = 'Security Guardrail & Cryptographic Protocol';
                                    } else {
                                        calloutTitle = 'Core Architecture Insight';
                                    }
                                }

                                return {
                                    ...sec,
                                    id,
                                    type: 'callout',
                                    calloutType: sec.calloutType || 'info',
                                    calloutTitle,
                                    content: content || calloutTitle
                                };
                            }
                            return sec;
                        });

                        const rawSub = data.subtitle || (data as any).docSubtitle || (data as any).description;
                        if (!rawSub || /^(click\s+to\s+add\s+document\s+subtitle|document\s+subtitle|subtitle)\.{0,3}$/i.test(rawSub.trim())) {
                            if (/1776/i.test(effectiveDocTitle)) {
                                data.subtitle = 'Examining the Birth of a Nation, Enlightenment Philosophy, and the Crucible of Liberty';
                            } else if (/auth|security|identity|zero[- ]trust/i.test(effectiveDocTitle)) {
                                data.subtitle = 'Comprehensive Architecture, Protocol Specifications, Token Lifecycle, and Security Guardrails';
                            } else {
                                data.subtitle = `Strategic overview, architectural pillars, and execution roadmap for ${effectiveDocTitle}`;
                            }
                        }
                        if (data.sections) {
                            data.sections = ensureCompleteSections(data.sections, effectiveDocTitle);
                            data.sections = enrichGroundedCitations(data.sections);
                        }
                    }

                    if (isMediaRequest && type === 'markdown-document') {
                        const kind = isVideoRequest ? 'video' : 'image';
                        const hasMediaSection = data?.sections?.some((s: any) => s.type === 'editorial-image' || s.type === 'image' || s.type === 'video');
                        if (!hasMediaSection) {
                            const mediaDoc = synthesizeMediaDocument(prompt, kind, effectiveDocTitle);
                            data = {
                                ...mediaDoc,
                                ...(data || {}),
                                sections: [
                                    ...mediaDoc.sections.filter(s => s.type === 'editorial-image' || s.type === 'image' || s.type === 'video'),
                                    ...(data?.sections || mediaDoc.sections.filter(s => s.type !== 'editorial-image' && s.type !== 'image' && s.type !== 'video'))
                                ]
                            };
                        }
                    }

                    parsed.title = effectiveDocTitle;
                }

                const isSameType = request.activeArtifact?.type === type;
                const effectiveVersion = (isSameType && request.activeArtifact) ? (request.activeArtifact.version || 1) + 1 : (parsed.version || 1);
                const effectiveId = (isSameType && request.activeArtifact) ? request.activeArtifact.id : (parsed.id || `art-${type}-${Date.now()}`);

                return {
                    id: effectiveId,
                    type: (type as PrimitiveType) || 'markdown-document',
                    title: parsed.title || 'Synthesized Canvas Artifact',
                    summary: parsed.summary || 'Generated with High Reasoning Engine.',
                    version: effectiveVersion,
                    createdAt: timestamp,
                    data: data || {}
                };
            }
        } catch {
            // If parsing failed, fallback below
        }
    }

    const lower = prompt.toLowerCase();
    const isVideoTimelineFallback = request.activeArtifact?.type === 'video-timeline' ||
        /split\s+(?:active\s+)?clip|ripple\s+delete|playhead|video\s+timeline|timeline\s+editor|video\s+editor|\bnle\b|cut\s+clip|trim\s+clip|multi-track\s+video|b-roll|a-roll|video\s+track|audio\s+mixer\s+track|color\s+grade\s+clip|chroma\s*key|green\s*screen|blue\s*screen|despill|video\s+composite|composite\s+clip|light\s*wrap/i.test(prompt) ||
        ((lower.includes('clip') || lower.includes('timeline')) && (lower.includes('split') || lower.includes('cut') || lower.includes('delete') || lower.includes('playhead') || lower.includes('ripple') || lower.includes('track') || lower.includes('video') || lower.includes('composite') || lower.includes('key')));

    if (isVideoTimelineFallback) {
        const isVideoActive = request.activeArtifact?.type === 'video-timeline';
        const activeVideoData = isVideoActive ? (request.activeArtifact?.data as VideoTimelineData) : undefined;
        const timelineData = synthesizeContextualVideoTimeline(prompt, undefined, activeVideoData);
        return {
            id: (isVideoActive ? request.activeArtifact?.id : undefined) || `art-video-${Date.now()}`,
            type: 'video-timeline',
            title: timelineData.title,
            summary: timelineData.subtitle || 'Multi-track non-linear video editing timeline with real-time WebGL compositor',
            version: isVideoActive ? (request.activeArtifact?.version || 1) + 1 : 1,
            createdAt: timestamp,
            data: timelineData
        };
    }

    const isImageRequest = /create\s+(?:a\s+)?picture|generate\s+(?:a\s+)?picture|picture\s+of|draw\s+(?:a\s+)?picture|image\s+of|generate\s+(?:an?\s+)?image|create\s+(?:an?\s+)?image|photo\s+of|photograph\s+of|illustration\s+of|painting\s+of|artwork\s+of|draw\s+(?:an?\s+)?image|make\s+(?:a\s+)?picture|make\s+(?:an?\s+)?image|\bpicture\b|\bphoto\b|\billustration\b|\bpainting\b/i.test(prompt);
    const isVideoRequest = !isVideoTimelineFallback && (/create\s+(?:a\s+)?video|generate\s+(?:a\s+)?video|video\s+of|make\s+(?:a\s+)?video|film\s+of|motion\s+clip|video\s+clip|record\s+(?:a\s+)?video|\bvideo\s+file\b|\bvideo\b/i.test(prompt));
    const isMediaRequest = isImageRequest || isVideoRequest;

    if (isMediaRequest) {
        const kind = isVideoRequest ? 'video' : 'image';
        const synthesizedDoc = synthesizeMediaDocument(prompt, kind);
        return {
            id: `art-doc-${Date.now()}`,
            type: 'markdown-document',
            title: synthesizedDoc.title,
            summary: kind === 'video'
                ? `Generated cinematic video document: "${synthesizedDoc.title}" on the visual canvas.`
                : `Generated editorial illustration and visual document: "${synthesizedDoc.title}" on the visual canvas.`,
            version: 1,
            createdAt: timestamp,
            data: synthesizedDoc
        };
    }

    const is3DActive = request.activeArtifact?.type === '3d-scene';
    const is3DFollowUpKeywords = /animate|fly|flight|motion|orbit|play|simulation|bank|roll|spin|takeoff|speed|camera|view|scene|heading|pitch|thrust/i.test(prompt) ||
        lower.includes('animate') || lower.includes('fly') || lower.includes('play') || lower.includes('orbit') || lower.includes('takeoff');

    // Check if query is 3D scene / 3D model / 3D plane / spatial scene
    const isSandboxOrAppRequest = !isMediaRequest && !isVideoTimelineFallback && (!is3DActive || !is3DFollowUpKeywords) && (
        /preview|sandbox|\bapp\b|web\s*app|landing\s*page|calculator|game|arcade|gravity|orbit|physics|celestial|synth|synthesizer|piano|keyboard|audio|music|sound|sorting|visualizer|dashboard|component|widget|mockup|\bui\b|react|html|css|javascript|typescript|python|interactive|simulator/i.test(prompt) ||
        lower.includes('preview') || lower.includes('sandbox') || lower.includes('calculator') || lower.includes('landing page') ||
        lower.includes('web app') || lower.includes('react app') || lower.includes('dashboard') || lower.includes('widget') ||
        lower.includes('interactive') || lower.includes('simulator') || lower.includes('game') || lower.includes('arcade') ||
        lower.includes('synth') || lower.includes('synthesizer') || lower.includes('piano') || lower.includes('sorting visualizer') ||
        lower.includes('gravity') || lower.includes('physics sim')
    );
    const isDocExplicitRequest = /document|doc\b|spec|write\s+(?:a\s+)?(?:doc|document|spec|essay|report|paper)|article|research\s+paper/i.test(prompt);

    const is3DFollowUp = !isMediaRequest && !isDocExplicitRequest && is3DActive && is3DFollowUpKeywords;
    const is3DSceneRequest = !isMediaRequest && !isDocExplicitRequest && (
        is3DFollowUp ||
        /3d\s+(?:scene|plane|world|model|flight|visual|mesh|field|generator|simulation|landscape|terrain|engine|orrery|solar|asteroid|molecular|lattice|city|corridor|environment)/i.test(prompt) ||
        /three\.js|webgl|r3f|airplane|aircraft|flight\s+corridor|asteroid\s+field|solar\s+system|planetary\s+orbit|molecular\s+lattice|cppgenerator|scratchbox_engine/i.test(prompt) ||
        /god\s*ray|crepuscular|contrail|control\s*surface|terrain\s*biome|volumetric\s*light|aerial\s*perspective/i.test(prompt) ||
        ((lower.includes('3d') || lower.includes('spatial')) && (
            lower.includes('scene') || lower.includes('plane') || lower.includes('world') || lower.includes('model') ||
            lower.includes('flight') || lower.includes('render') || lower.includes('environment') || lower.includes('asteroid') ||
            lower.includes('orbit') || lower.includes('solar') || lower.includes('mesh') || lower.includes('procedural') ||
            lower.includes('field') || lower.includes('physics') || lower.includes('generator') || lower.includes('terrain')
        ))
    );

    if (is3DSceneRequest) {
        const active3DData = is3DActive ? (request.activeArtifact?.data as Scene3DData) : undefined;
        const isExplicitFlight = /plane|airplane|jet\s+aircraft|jet\s+transit|flight\s+corridor|aviation\s+sim/i.test(prompt);
        const isAnimateOnly = is3DFollowUp && !/new|change|build|create|switch/i.test(prompt) && /animate|fly|flight|motion|orbit|play|simulation|bank|roll|spin|takeoff/i.test(prompt);

        const docContent = request.activeArtifact?.type === 'markdown-document'
            ? (request.activeArtifact.data as MarkdownDocumentData)?.sections?.map(s => s.content || s.calloutTitle || '').join(' ')
            : undefined;
        const contextualSynthesized = synthesizeContextual3DScene(prompt, {
            activeArtifact: request.activeArtifact,
            chatHistory: request.chatHistory,
            docTitle: request.activeArtifact?.title,
            docContent
        });

        const sceneTitle = (isAnimateOnly && active3DData) ? active3DData.title : (isExplicitFlight ? '3D Aircraft & Flight Corridor' : contextualSynthesized.title);
        const sceneSummary = isAnimateOnly && isExplicitFlight
            ? 'Animated 3D flight trajectory: dynamic bank, roll, and engine thrust active.'
            : (isExplicitFlight ? 'Interactive procedural 3D plane and spatial flight environment.' : (contextualSynthesized.subtitle || 'Interactive 3D spatial scene synthesized with Studio 3D Engine.'));

        const planeObjects = [
            {
                id: 'obj-aircraft-1',
                content: {
                    type: '3d-scene' as const,
                    durableUri: 'internal:plane',
                    mimeType: 'model/procedural-aircraft',
                    metadata: { dims: { width: 12, height: 4, depth: 14 } }
                },
                space: {
                    spatial3d: { x: 0, y: 3.5, z: 0, pitch: 0, yaw: 0, roll: 0 }
                },
                time: { startMs: 0, durationMs: 10000 },
                lineage: { version: 1 }
            }
        ];

        const defaultObjects = isExplicitFlight
            ? planeObjects
            : (contextualSynthesized.objects || []);

        const hasGodRays = /god\s*ray|crepuscular|light\s*shaft|volumetric\s*light/i.test(prompt) || !!active3DData?.features?.godRays;
        const hasAtmosphere = /\b(?:atmosphere|atmospheric|scattering|rayleigh|mie|realistic\s*sky|aerial\s*perspective)\b/i.test(prompt) || !!active3DData?.features?.atmosphericScattering;
        const hasContrails = /contrail|vapor|vortex|wingtip\s*trail/i.test(prompt) || !!active3DData?.features?.contrails;
        const hasControlSurfaces = /control\s*surface|aileron|elevator|rudder|flap/i.test(prompt) || !!active3DData?.features?.controlSurfaces;
        const hasTerrainBiomes = /biome|terrain|canyon|alpine|mountain|coastal|desert/i.test(prompt) || !!active3DData?.features?.terrainBiomes;

        const fallbackFeatures = {
            ...(contextualSynthesized.features || {}),
            ...(active3DData?.features || {}),
            ...(hasGodRays ? { godRays: true } : {}),
            ...(hasAtmosphere || hasGodRays ? { atmosphericScattering: true } : {}),
            ...(hasContrails ? { contrails: true } : {}),
            ...(hasControlSurfaces ? { controlSurfaces: true } : {}),
            ...(hasTerrainBiomes ? { terrainBiomes: (active3DData?.features?.terrainBiomes || { biomeType: 'alpine' as const }) } : {})
        };

        const fallback3DData: Scene3DData = {
            title: active3DData?.title || sceneTitle,
            subtitle: (isAnimateOnly && active3DData?.subtitle) ? active3DData.subtitle : (active3DData?.subtitle || sceneSummary),
            worldBranch: active3DData?.worldBranch || contextualSynthesized.worldBranch,
            sceneType: active3DData?.sceneType || contextualSynthesized.sceneType,
            renderMode: active3DData?.renderMode || contextualSynthesized.renderMode || 'pbr',
            cameraMode: lower.includes('fps') ? 'fps' : (lower.includes('orbit') ? 'orbit' : (active3DData?.cameraMode || contextualSynthesized.cameraMode || 'orbit')),
            animation: isAnimateOnly ? (lower.includes('orbit') ? 'orbit' : 'flight') : (active3DData?.animation || contextualSynthesized.animation),
            timeline: isAnimateOnly ? {
                currentTimeMs: active3DData?.timeline?.currentTimeMs ?? 0,
                durationMs: active3DData?.timeline?.durationMs ?? 10000,
                isPlaying: true,
                speed: active3DData?.timeline?.speed ?? 1.0,
                playbackSpeed: active3DData?.timeline?.playbackSpeed ?? 1.0,
                isLooping: true,
                ...(active3DData?.timeline || {})
            } : (active3DData?.timeline || contextualSynthesized.timeline),
            camera: active3DData?.camera || contextualSynthesized.camera || {
                position: [15, 12, 20],
                target: [0, 2, 0],
                fov: 45
            },
            environment: {
                lighting: (lower.includes('dimmer') || lower.includes('dim') || lower.includes('darker')) ? 'twilight' : (active3DData?.environment?.lighting || 'daylight'),
                lightingPreset: (lower.includes('dimmer') || lower.includes('dim') || lower.includes('darker')) ? 'twilight' : (active3DData?.environment?.lightingPreset || active3DData?.environment?.lighting || 'daylight'),
                ambientIntensity: (lower.includes('dimmer') || lower.includes('dim') || lower.includes('darker')) ? 0.3 : (active3DData?.environment?.ambientIntensity),
                ground: true,
                ...(active3DData?.environment || {}),
                ...(contextualSynthesized.environment || {}),
                skybox: ((hasAtmosphere || hasGodRays) ? 'realistic-sky' : (active3DData?.environment?.skybox || contextualSynthesized.environment?.skybox || 'studio'))
            },
            geoAnchor: active3DData?.geoAnchor || contextualSynthesized.geoAnchor || {
                lat: 37.7900,
                lng: -122.4000,
                elevation: 15.2,
                active: true,
                landmarkName: isExplicitFlight ? 'Flight Corridor' : 'San Francisco Bay Airspace'
            },
            objects: active3DData?.objects || defaultObjects,
            customScript: active3DData?.customScript || active3DData?.code || contextualSynthesized.customScript,
            code: active3DData?.code || active3DData?.customScript || contextualSynthesized.code,
            shaders: active3DData?.shaders,
            features: fallbackFeatures,
            customMeshes: (() => {
                const base = active3DData?.customMeshes ? [...active3DData.customMeshes] : (contextualSynthesized.customMeshes ? [...contextualSynthesized.customMeshes] : []);
                if (lower.includes('add') && (lower.includes('building') || lower.includes('tower') || lower.includes('structure') || lower.includes('box') || lower.includes('mesh') || lower.includes('sphere') || lower.includes('cylinder'))) {
                    const meshType = lower.includes('sphere') ? 'sphere' : lower.includes('cylinder') ? 'cylinder' : 'box';
                    const newMeshId = `mesh-added-${Date.now()}`;
                    const refMesh = base[base.length - 1];
                    const newPos: [number, number, number] = refMesh?.position ? [refMesh.position[0] + 8, refMesh.position[1], refMesh.position[2]] : [8, 4, 0];
                    base.push({
                        id: newMeshId,
                        name: lower.includes('building') ? 'Adjacent Tower' : 'Added Geometry',
                        type: meshType as CustomMesh['type'],
                        position: newPos,
                        rotation: [0, 0, 0],
                        scale: refMesh?.scale ? [...refMesh.scale] : [4, 8, 4],
                        material: { color: 0x10b981, roughness: 0.4, metalness: 0.3 }
                    });
                }
                return base;
            })(),
            operatorStack: active3DData?.operatorStack || [],
            actionLog: active3DData?.actionLog || [],
            sculptSettings: active3DData?.sculptSettings,
            selectedMeshId: active3DData?.selectedMeshId,
            cppGenerator: active3DData?.cppGenerator || contextualSynthesized.cppGenerator
        };

        return {
            id: (is3DActive ? request.activeArtifact?.id : undefined) || `art-3d-${Date.now()}`,
            type: '3d-scene',
            title: fallback3DData.title,
            summary: sceneSummary,
            version: is3DActive ? (request.activeArtifact?.version || 1) + 1 : 1,
            createdAt: timestamp,
            data: fallback3DData
        };
    }

    // Check if query is flow/graph
    if (lower.includes('flow') || lower.includes('graph') || lower.includes('pipeline')) {
        const domain = classifyDomain(prompt);
        const { subject } = extractPromptEntities(prompt, 'System Architecture');
        const title = `${subject} - Pipeline & Architecture Flow`;
        const adaptiveGraph = synthesizeAdaptiveNodeGraph(domain, title, prompt);
        return {
            id: `art-graph-${Date.now()}`,
            type: 'node-graph',
            title: adaptiveGraph.title,
            summary: `Interactive pipeline flow graph for ${subject} synthesized with Studio AI Engine.`,
            version: 1,
            createdAt: timestamp,
            data: adaptiveGraph
        };
    }

    // Check if query is kanban / sprint board
    if (lower.includes('kanban') || lower.includes('sprint') || (lower.includes('board') && !lower.includes('keyboard') && !lower.includes('dashboard'))) {
        const domain = classifyDomain(prompt);
        const { subject } = extractPromptEntities(prompt, 'Project Roadmap');
        const title = `${subject} - Roadmap & Sprint Board`;
        const adaptiveBoard = synthesizeAdaptiveKanban(domain, title, prompt);
        return {
            id: `art-kanban-${Date.now()}`,
            type: 'kanban-board',
            title: adaptiveBoard.title,
            summary: `Interactive Kanban board for ${subject} synthesized with Studio AI Engine.`,
            version: 1,
            createdAt: timestamp,
            data: adaptiveBoard
        };
    }

    // Check if query is metrics / KPI / telemetry dashboard
    if (lower.includes('metric') || lower.includes('telemetry') || lower.includes('kpi') || lower.includes('analytics dashboard')) {
        const domain = classifyDomain(prompt);
        const { subject } = extractPromptEntities(prompt, 'System Telemetry');
        const title = `${subject} - Telemetry & Performance Dashboard`;
        const adaptiveMetrics = synthesizeAdaptiveMetrics(domain, title, prompt);
        return {
            id: `art-metrics-${Date.now()}`,
            type: 'metric-dashboard',
            title: adaptiveMetrics.title,
            summary: `Interactive telemetry dashboard for ${subject} synthesized with Studio AI Engine.`,
            version: 1,
            createdAt: timestamp,
            data: adaptiveMetrics
        };
    }

    // Check if query is sandbox / live preview / interactive web app OR cleanContent contains runnable code blocks
    const isSandboxExplicit = isSandboxOrAppRequest || /preview|sandbox|\bapp\b|web\s*app|landing\s*page|calculator|game|arcade|gravity|orbit|physics|celestial|synth|synthesizer|piano|keyboard|audio|music|sound|sorting|visualizer|dashboard|component|widget|mockup|\bui\b|react|html|css|javascript|typescript|python|interactive|simulator/i.test(prompt);

    const extractedSandbox = extractCodeSandboxArtifact(prompt, cleanContent, request.activeArtifact);
    if (extractedSandbox && (isSandboxExplicit || extractedSandbox.hasRunnableCode)) {
        return extractedSandbox.artifact;
    }

    // Default: rich Markdown Document artifact wrapping model text
    const newSections = markdownStringToSections(cleanContent);
    
    let finalTitle = extractDocumentTitle(prompt, request.activeArtifact?.title || 'Strategic Specification & Notes');
    let finalSections = newSections;

    if (request.activeArtifact?.type === 'markdown-document' && request.activeArtifact.data) {
        const activeDoc = request.activeArtifact.data as MarkdownDocumentData;
        finalTitle = activeDoc.title && activeDoc.title !== 'Markdown Document' ? activeDoc.title : finalTitle;
        const sectionMatch = prompt.match(/for section ["'](.*?)["']/i) || prompt.match(/selected excerpt: ["'](.*?)["']/i);
        if (sectionMatch && activeDoc.sections && activeDoc.sections.length > 0) {
            const targetQuery = sectionMatch[1].toLowerCase().trim();
            const targetIdx = activeDoc.sections.findIndex(s => (s.content || s.calloutTitle || '').toLowerCase().includes(targetQuery));
            if (targetIdx !== -1) {
                const merged = [...activeDoc.sections];
                merged.splice(targetIdx, 1, ...newSections);
                finalSections = merged;
            }
        }
    } else if (newSections[0]?.type === 'heading' && newSections[0].content) {
        finalTitle = newSections[0].content;
    }

    const isDocRequest = lower.includes('write') || lower.includes('document') || lower.includes('spec') || lower.includes('proposal') || lower.includes('1776') || lower.includes('guide') || lower.includes('report') || lower.includes('auth') || lower.includes('paper') || lower.includes('research') || lower.includes('essay') || lower.includes('article') || lower.includes('lexington') || lower.includes('battle');

    let docData: MarkdownDocumentData;
    if (isDocRequest || lower.includes('1776') || finalSections.length <= 1) {
        docData = synthesizeComprehensiveDocument(prompt, finalTitle);
    } else if (newSections.length > 2) {
        docData = {
            title: finalTitle,
            subtitle: `Synthesized with Studio AI & ${request.attachedSkills?.map(s => s.name).join(', ') || 'Superpowers'}`,
            author: DEFAULT_DOCUMENT_AUTHOR,
            lastUpdated: 'Just now',
            tags: ['Reasoning', 'CupertinoDesign', 'Artifacts', 'Specification'],
            sections: finalSections
        };
    } else {
        docData = synthesizeComprehensiveDocument(prompt, finalTitle);
    }

    if (docData && docData.sections) {
        docData.sections = ensureCompleteSections(docData.sections, finalTitle);
        docData.sections = enrichGroundedCitations(docData.sections);
    }

    return {
        id: request.activeArtifact?.id || `art-doc-${Date.now()}`,
        type: 'markdown-document',
        title: docData.title,
        summary: 'Executive brief synthesized with High Reasoning Engine.',
        version: (request.activeArtifact?.version || 0) + 1,
        createdAt: timestamp,
        data: docData
    };
}
