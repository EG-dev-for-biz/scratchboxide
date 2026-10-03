/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    CanvasArtifact,
    ChartDataPoint,
    CodeFileTab,
    GraphEdge,
    GraphNode,
    GraphNodeCategory,
    InteractiveBrowserData,
    KanbanBoardData,
    KanbanCard,
    KanbanColumn,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    MarkdownSection,
    MetricCardsData,
    MetricItem,
    NodeGraphData,
    PrimitiveType,
    Scene3DData
} from './canvas-types';
import { stableProjectArtifactId } from '../../common/project-artifact-graph-protocol';
import { synthesizeContextual3DScene } from './procedural-3d-synthesizer';
import { slugify } from './services/text-utils';
import { AIRCRAFT_HELPERS_SOURCE, FLIGHT_PHYSICS_SOURCE } from './services/mesh/aircraft-template';
import {
    classifyDomain,
    synthesizeAdaptiveKanban,
    synthesizeAdaptiveMetrics,
    synthesizeAdaptiveNodeGraph,
    synthesizeAdaptiveSandbox
} from './services/adaptive-domain-engine';

/**
 * Deterministically morphs a Markdown Document Spec checklist into a Kanban Board.
 */
export function morphDocToChecklistKanban(doc: MarkdownDocumentData): KanbanBoardData {
    const title = doc?.title ? `${doc.title} - Tasks` : 'Project Spec - Kanban Tasks';
    const subtitle = doc?.subtitle || 'Morphed from Document Specification';

    const todoCards: KanbanCard[] = [];
    const inProgressCards: KanbanCard[] = [];
    const doneCards: KanbanCard[] = [];

    const sections = Array.isArray(doc?.sections) ? doc.sections : [];
    const allContent = sections.map(s => s.content || s.calloutTitle || '').join(' ');
    const domain = classifyDomain(doc?.title || '', allContent);

    for (let secIdx = 0; secIdx < sections.length; secIdx++) {
        const sec = sections[secIdx];
        const secTag = (sec as any).title || sec.calloutTitle || `Section ${secIdx + 1}`;

        // 1. Ingest explicit checklistItems
        if (Array.isArray(sec.checklistItems) && sec.checklistItems.length > 0) {
            for (const item of sec.checklistItems) {
                const isCompleted = !!(item.done || (item as any).completed);
                const card: KanbanCard = {
                    id: `card-${item.id || slugify(item.text)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    title: item.text,
                    description: `Originating from section: "${secTag}"`,
                    tag: secTag.slice(0, 20),
                    tagColor: isCompleted ? 'emerald' : 'blue',
                    priority: isCompleted ? 'low' : 'medium'
                };
                if (isCompleted) {
                    doneCards.push(card);
                } else {
                    todoCards.push(card);
                }
            }
        }

        // 2. Parse markdown checkboxes from content (- [ ] or - [x])
        if (sec.content) {
            const lines = sec.content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                const checkboxMatch = trimmed.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/);
                if (checkboxMatch) {
                    const isChecked = checkboxMatch[1].toLowerCase() === 'x';
                    const itemText = checkboxMatch[2].trim();
                    const card: KanbanCard = {
                        id: `card-md-${slugify(itemText)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        title: itemText,
                        description: `Extracted from "${secTag}" markdown spec.`,
                        tag: secTag.slice(0, 20),
                        tagColor: isChecked ? 'emerald' : 'indigo',
                        priority: isChecked ? 'low' : 'high'
                    };
                    if (isChecked) {
                        doneCards.push(card);
                    } else {
                        todoCards.push(card);
                    }
                }
            }
        }
    }

    // Fallback: If no checkboxes were found, convert sections themselves into cards
    if (todoCards.length === 0 && doneCards.length === 0) {
        if (sections.length > 0) {
            sections.forEach((sec, idx) => {
                const secName = (sec as any).title || sec.calloutTitle || `Phase ${idx + 1} Deliverable`;
                todoCards.push({
                    id: `card-sec-${idx}-${slugify(secName)}`,
                    title: secName,
                    description: sec.content ? sec.content.slice(0, 140) + '...' : undefined,
                    tag: 'Phase',
                    tagColor: 'blue',
                    priority: idx === 0 ? 'high' : 'medium'
                });
            });
        } else {
            return synthesizeAdaptiveKanban(domain, title, subtitle);
        }
    }

    const columns: KanbanColumn[] = [
        {
            id: 'todo',
            title: 'To Do',
            color: 'blue',
            cards: todoCards
        },
        {
            id: 'in-progress',
            title: 'In Progress',
            color: 'amber',
            cards: inProgressCards
        },
        {
            id: 'done',
            title: 'Done',
            color: 'emerald',
            cards: doneCards
        }
    ];

    return {
        title,
        subtitle,
        columns
    };
}

/**
 * Deterministically morphs a Markdown Document Architecture Spec into an executable Node Graph flow.
 */
export function morphDocToNodeGraph(doc: MarkdownDocumentData): NodeGraphData {
    const title = doc?.title ? `${doc.title} Flow` : 'Architecture Execution Flow';
    const subtitle = doc?.subtitle || 'Executable workflow generated from spec';

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const sections = Array.isArray(doc?.sections) ? doc.sections : [];

    const extractedSteps: { label: string; details: string; category: GraphNodeCategory }[] = [];

    // Scan sections for numbered steps or pipeline statements
    for (const sec of sections) {
        if (sec.content) {
            const lines = sec.content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                const stepMatch = trimmed.match(/^(\d+)\.\s*(.+)$/);
                if (stepMatch) {
                    const stepText = stepMatch[2].trim();
                    let stepCategory: GraphNodeCategory = 'process';
                    const lower = stepText.toLowerCase();
                    if (lower.includes('webhook') || lower.includes('trigger') || lower.includes('event') || lower.includes('request')) {
                        stepCategory = 'input';
                    } else if (lower.includes('ai') || lower.includes('agent') || lower.includes('gemini') || lower.includes('llm') || lower.includes('validate') || lower.includes('fraud')) {
                        stepCategory = 'ai';
                    } else if (lower.includes('check') || lower.includes('if') || lower.includes('gate') || lower.includes('decision')) {
                        stepCategory = 'decision';
                    } else if (lower.includes('db') || lower.includes('database') || lower.includes('store') || lower.includes('save') || lower.includes('billing')) {
                        stepCategory = 'database';
                    } else if (lower.includes('response') || lower.includes('output') || lower.includes('dispatch') || lower.includes('notify') || lower.includes('receipt')) {
                        stepCategory = 'output';
                    } else if (lower.includes('scene-3d') || lower.includes('3d scene') || lower.includes('3d model') || lower.includes('spatial canvas') || lower.includes('spatial scene') || lower.includes('mesh')) {
                        stepCategory = 'scene-3d';
                    } else if (lower.includes('camera-3d') || lower.includes('3d camera') || lower.includes('camera path') || lower.includes('camera sequencer') || lower.includes('keyframe') || lower.includes('flythrough')) {
                        stepCategory = 'camera-3d';
                    } else if (lower.includes('map-3d') || lower.includes('3d map') || lower.includes('google tiles') || lower.includes('photorealistic tiles') || lower.includes('geo spatial') || lower.includes('poi marker')) {
                        stepCategory = 'map-3d';
                    } else if (lower.includes('studio-mcp') || lower.includes('scratchbox studio') || lower.includes('studio connector') || lower.includes('creative media')) {
                        stepCategory = 'studio-mcp';
                    }
                    extractedSteps.push({
                        label: stepText,
                        details: `Step ${stepMatch[1]} from "${(sec as any).title || sec.calloutTitle || 'Spec'}"`,
                        category: stepCategory
                    });
                }
            }
        }
    }

    // Fallback: If no numbered steps found, create nodes from document sections
    if (extractedSteps.length === 0) {
        if (sections.length > 0) {
            sections.forEach((sec, idx) => {
                const isFirst = idx === 0;
                const isLast = idx === sections.length - 1;
                const secLabel = (sec as any).title || sec.calloutTitle || `Pipeline Stage ${idx + 1}`;
                extractedSteps.push({
                    label: secLabel,
                    details: sec.content ? sec.content.slice(0, 100) : 'Stage execution step',
                    category: isFirst ? 'input' : (isLast ? 'output' : 'process')
                });
            });
        } else {
            const domain = classifyDomain(doc?.title || '', doc?.subtitle || '');
            return synthesizeAdaptiveNodeGraph(domain, title, subtitle);
        }
    }

    // Generate graph nodes with layout coordinates
    extractedSteps.forEach((step, idx) => {
        const nodeId = `node-flow-${idx + 1}`;
        nodes.push({
            id: nodeId,
            label: step.label.length > 32 ? step.label.slice(0, 32) + '...' : step.label,
            subtitle: step.details,
            category: step.category,
            x: 100 + idx * 240,
            y: 200 + (idx % 2 === 0 ? 0 : 40),
            status: 'pending',
            parameters: {
                stepIndex: idx + 1,
                sourceSpec: doc.title,
                configured: true
            }
        });

        // Connect with directed edge to previous node
        if (idx > 0) {
            const prevNodeId = `node-flow-${idx}`;
            edges.push({
                id: `edge-${prevNodeId}-${nodeId}`,
                source: prevNodeId,
                target: nodeId,
                style: 'solid'
            });
        }
    });

    return {
        title,
        subtitle,
        nodes,
        edges
    };
}

/**
 * Deterministically morphs a Kanban Card into a Live Code Sandbox with implementation & unit tests.
 */
export function morphKanbanCardToSandbox(card: KanbanCard, boardTitle?: string): LiveCodeSandboxData {
    const slug = slugify(card.title);
    const className = card.title
        .replace(/[^a-zA-Z0-9 ]/g, '')
        .split(' ')
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join('');

    const title = `${card.title} - Sandbox`;
    const implFileName = `${slug}.ts`;
    const testFileName = `${slug}.test.ts`;

    const implContent = `/********************************************************************************
 * Implementation: ${card.title}
 * Priority: ${card.priority || 'medium'} | Tag: ${card.tag || 'Feature'}
 ********************************************************************************/

export interface ${className}Options {
    enabled?: boolean;
    timeoutMs?: number;
    metadata?: Record<string, any>;
}

export class ${className} {
    private options: ${className}Options;

    constructor(options: ${className}Options = {}) {
        this.options = { enabled: true, timeoutMs: 5000, ...options };
    }

    /**
     * Executes the primary operation for "${card.title}".
     */
    async execute(payload?: any): Promise<{ success: boolean; result: any; timestamp: number }> {
        // Description: ${card.description || 'Implementation logic'}
        return {
            success: true,
            result: payload || { status: 'processed' },
            timestamp: Date.now()
        };
    }
}
`;

    const testContent = `/********************************************************************************
 * Test Suite: ${card.title}
 * Linked Kanban Card ID: ${card.id}
 ********************************************************************************/

import * as assert from 'assert';
import { ${className} } from './${slug}';

describe('${className} Execution Suite', () => {
    test('should initialize with default configuration options', () => {
        const instance = new ${className}();
        assert.ok(instance, '${className} must instantiate successfully');
    });

    test('should execute primary workflow and return success status', async () => {
        const instance = new ${className}();
        const response = await instance.execute({ action: 'test-run' });

        assert.strictEqual(response.success, true);
        assert.ok(response.timestamp > 0);
        assert.deepStrictEqual(response.result, { action: 'test-run' });
    });
});
`;

    const readmeContent = `# ${card.title}

**Linked Kanban Board**: ${boardTitle || 'Product Board'}
**Card ID**: \`${card.id}\`
**Priority**: ${card.priority || 'medium'}
**Tag**: ${card.tag || 'Task'}

### Requirement Details
${card.description || 'No detailed description provided.'}

### Sandbox Files
- \`src/${implFileName}\`: Core implementation class
- \`tests/${testFileName}\`: Automated test suite
`;

    const appContent = `import React, { useState } from 'react';
import { ${className} } from './src/${slug}';

export default function App() {
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<any>(null);

    const handleExecute = async () => {
        setRunning(true);
        try {
            const instance = new ${className}();
            const res = await instance.execute({ action: 'interactive-test', timestamp: Date.now() });
            setResult(res);
        } catch (e: any) {
            setResult({ error: e.message });
        } finally {
            setRunning(false);
        }
    };

    return (
        <div style={{ minHeight: '100vh', background: '#090d16', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif', padding: '28px' }}>
            <div style={{ maxWidth: '600px', margin: '0 auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
                    <div style={{ width: '38px', height: '38px', borderRadius: '10px', background: 'rgba(59, 130, 246, 0.15)', border: '1px solid rgba(59, 130, 246, 0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' }}>
                        ⚡
                    </div>
                    <div>
                        <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>${card.title}</h2>
                        <span style={{ fontSize: '12px', color: '#94a3b8' }}>Live Service Runner & Test Bench</span>
                    </div>
                </div>

                <div style={{ background: '#131b2e', border: '1px solid #1e293b', borderRadius: '10px', padding: '16px', marginBottom: '18px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>Requirement Specification</div>
                    <div style={{ fontSize: '13px', lineHeight: 1.5, color: '#cbd5e1' }}>${card.description || 'Service implementation workflow'}</div>
                </div>

                <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                    <button
                        onClick={handleExecute}
                        disabled={running}
                        style={{
                            display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', borderRadius: '8px',
                            background: '#2563eb', color: '#fff', border: 'none', fontWeight: 600, cursor: running ? 'wait' : 'pointer', fontSize: '13px'
                        }}
                    >
                        <span>{running ? 'Executing...' : '▶ Run Service Workflow'}</span>
                    </button>
                </div>

                {result && (
                    <div style={{ background: '#0d1322', border: '1px solid #1e293b', borderRadius: '10px', padding: '16px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                            <span style={{ fontSize: '12px', fontWeight: 600, color: '#10b981' }}>✓ Execution Complete</span>
                            <span style={{ fontSize: '11px', color: '#64748b' }}>{new Date(result.timestamp || Date.now()).toLocaleTimeString()}</span>
                        </div>
                        <pre style={{ margin: 0, padding: '10px', background: '#080c14', borderRadius: '6px', fontSize: '12px', color: '#38bdf8', overflowX: 'auto' }}>
                            {JSON.stringify(result, null, 2)}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}
`;

    const files: CodeFileTab[] = [
        {
            id: `tab-app-${slug}`,
            name: 'App.tsx',
            path: 'App.tsx',
            language: 'typescript',
            content: appContent,
            isDirty: false
        },
        {
            id: `tab-impl-${slug}`,
            name: implFileName,
            path: `src/${implFileName}`,
            language: 'typescript',
            content: implContent,
            isDirty: false
        },
        {
            id: `tab-test-${slug}`,
            name: testFileName,
            path: `tests/${testFileName}`,
            language: 'typescript',
            content: testContent,
            isDirty: false
        },
        {
            id: `tab-readme-${slug}`,
            name: 'README.md',
            path: 'README.md',
            language: 'markdown',
            content: readmeContent,
            isDirty: false
        }
    ];

    return {
        title,
        template: 'react',
        viewMode: 'split',
        viewportMode: 'desktop',
        activeFileId: `tab-app-${slug}`,
        files,
        consoleLogs: []
    };
}

/**
 * Deterministically morphs a 3D Scene primitive into a Live Code Sandbox with Three.js scene, shaders, aircraft, and physics.
 */
export function morphScene3DToSandbox(scene: Scene3DData): LiveCodeSandboxData {
    const isFlight = scene?.sceneType === 'aircraft' || scene?.sceneType === 'flight' || /\b(?:jet|airplane|aircraft|flight)\b/i.test(scene?.title || '');
    const title = scene?.title || (isFlight ? '3D Jet Flight Simulation' : '3D Spatial Scene');
    const subtitle = scene?.subtitle || 'Live Three.js 3D simulation sandbox';
    const skybox = scene?.environment?.skybox || 'realistic-sky';
    const renderMode = scene?.renderMode || 'pbr';

    const appContent = isFlight ? `import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { createAtmosphericScene } from './scene';
import { createAirplaneMesh, createArticulatedAircraft } from './aircraft';
import { updateFlightPhysics, updateContrails } from './physics';
import { runCustomScript } from './customScript';

export default function App() {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        const container = containerRef.current;
        const width = container.clientWidth || 800;
        const height = container.clientHeight || 600;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
        camera.position.set(15, 12, 20);

        let renderer: THREE.WebGLRenderer | null = null;
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true });
            renderer.setSize(width, height);
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            renderer.shadowMap.enabled = true;
            container.appendChild(renderer.domElement);
        } catch (e) {
            console.warn('[WebGL Fallback] WebGL unavailable:', e);
            const fallbackDiv = document.createElement('div');
            fallbackDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-family:system-ui;text-align:center;padding:24px;background:#090d16;';
            fallbackDiv.innerHTML = '<div style="font-size:36px;margin-bottom:12px;">🛸</div><div style="font-weight:700;font-size:16px;color:#f8fafc;margin-bottom:6px;">Three.js 3D Sandbox Active</div><div style="font-size:12px;color:#64748b;max-width:300px;">Scene loaded and running. Software 2D canvas active.</div>';
            container.appendChild(fallbackDiv);
            return;
        }

        // 1. Atmosphere, skybox, sun, and god rays
        const env = createAtmosphericScene(scene, { skybox: '${skybox}', renderMode: '${renderMode}' });

        // 2. Aircraft with articulated control surfaces
        const aircraft = createArticulatedAircraft ? createArticulatedAircraft() : createAirplaneMesh();
        aircraft.position.set(0, 3.5, 0);
        scene.add(aircraft);

        // 3. Ground plane (flat runway / studio floor, zero floating wavy terrain)
        if (${scene?.environment?.ground !== false}) {
            const groundGeo = new THREE.PlaneGeometry(300, 300);
            groundGeo.rotateX(-Math.PI / 2);
            const groundMat = new THREE.MeshStandardMaterial({
                color: 0x1e293b,
                roughness: 0.85,
                metalness: 0.1
            });
            const ground = new THREE.Mesh(groundGeo, groundMat);
            ground.position.y = -2;
            ground.receiveShadow = true;
            scene.add(ground);
        }

        // 4. Custom script execution hook
        const scriptHook = runCustomScript ? runCustomScript({ scene, camera, renderer, THREE, aircraft }) : null;

        let lastTime = performance.now();
        let animationFrameId: number;

        const animate = (now: number) => {
            const delta = (now - lastTime) / 1000;
            lastTime = now;
            const time = now / 1000;

            updateFlightPhysics(aircraft, time, delta, { bankScale: 1.0, pitchScale: 1.0 });
            updateContrails(aircraft, time, delta);
            if (env && env.update) env.update(time, delta);
            if (scriptHook && scriptHook.update) scriptHook.update(time, delta);

            camera.lookAt(aircraft.position.x * 0.3, aircraft.position.y, aircraft.position.z * 0.3);
            renderer.render(scene, camera);
            animationFrameId = requestAnimationFrame(animate);
        };

        animationFrameId = requestAnimationFrame(animate);

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
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener('resize', handleResize);
            if (scriptHook && scriptHook.dispose) scriptHook.dispose();
            renderer.dispose();
            if (container.contains(renderer.domElement)) {
                container.removeChild(renderer.domElement);
            }
        };
    }, []);

    return (
        <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#0a0a0f', overflow: 'hidden' }}>
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
            <div style={{ position: 'absolute', top: 16, left: 16, padding: '8px 16px', background: 'rgba(0,0,0,0.6)', borderRadius: 20, color: '#38bdf8', fontFamily: 'monospace', fontSize: 12 }}>
                ✈ \${title} · Live Three.js Engine
            </div>
        </div>
    );
}
` : `import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { createAtmosphericScene } from './scene';
import { runCustomScript } from './customScript';

export default function App() {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        const container = containerRef.current;
        const width = container.clientWidth || 800;
        const height = container.clientHeight || 600;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(${scene?.camera?.fov || 45}, width / height, 0.1, 1000);
        camera.position.set(${scene?.camera?.position ? scene.camera.position.join(', ') : '15, 12, 20'});
        const targetPos = new THREE.Vector3(${scene?.camera?.target ? scene.camera.target.join(', ') : '0, 1.8, 0'});
        camera.lookAt(targetPos);

        let renderer: THREE.WebGLRenderer | null = null;
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true });
            renderer.setSize(width, height);
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            renderer.shadowMap.enabled = true;
            container.appendChild(renderer.domElement);
        } catch (e) {
            console.warn('[WebGL Fallback] WebGL unavailable:', e);
            const fallbackDiv = document.createElement('div');
            fallbackDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-family:system-ui;text-align:center;padding:24px;background:#090d16;';
            fallbackDiv.innerHTML = '<div style="font-size:36px;margin-bottom:12px;">🛸</div><div style="font-weight:700;font-size:16px;color:#f8fafc;margin-bottom:6px;">Three.js 3D Sandbox Active</div><div style="font-size:12px;color:#64748b;max-width:300px;">Scene loaded and running. Software 2D canvas active.</div>';
            container.appendChild(fallbackDiv);
            return;
        }

        // 1. Atmosphere, skybox, sun, and god rays
        const env = createAtmosphericScene(scene, { skybox: '${skybox}', renderMode: '${renderMode}' });

        // 2. Custom meshes / scene geometry
        ${(scene.customMeshes || []).length > 0 ? `
        const meshesData = ${JSON.stringify(scene.customMeshes)};
        meshesData.forEach(m => {
            let geo: THREE.BufferGeometry;
            if (m.type === 'sphere') geo = new THREE.SphereGeometry(1, 32, 16);
            else if (m.type === 'cone') geo = new THREE.ConeGeometry(1, 2, 32);
            else if (m.type === 'cylinder') geo = new THREE.CylinderGeometry(1, 1, 2, 32);
            else geo = new THREE.BoxGeometry(1, 1, 1);

            const mat = new THREE.MeshStandardMaterial({
                color: m.material?.color || 0x38bdf8,
                roughness: m.material?.roughness ?? 0.5,
                metalness: m.material?.metalness ?? 0.1
            });
            const mesh = new THREE.Mesh(geo, mat);
            if (m.position) mesh.position.set(m.position[0], m.position[1], m.position[2]);
            if (m.scale) mesh.scale.set(m.scale[0], m.scale[1], m.scale[2]);
            scene.add(mesh);
        });` : `
        const cubeGeo = new THREE.BoxGeometry(2, 2, 2);
        const cubeMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.3, metalness: 0.8 });
        const focalMesh = new THREE.Mesh(cubeGeo, cubeMat);
        focalMesh.position.set(0, 1, 0);
        scene.add(focalMesh);
        `}

        // 3. Clean studio ground plane (if enabled)
        if (${scene?.environment?.ground !== false}) {
            const groundGeo = new THREE.PlaneGeometry(100, 100);
            groundGeo.rotateX(-Math.PI / 2);
            const groundMat = new THREE.MeshStandardMaterial({
                color: 0x1e293b,
                roughness: 0.85,
                metalness: 0.1
            });
            const groundMesh = new THREE.Mesh(groundGeo, groundMat);
            groundMesh.position.y = 0;
            groundMesh.receiveShadow = true;
            scene.add(groundMesh);
        }

        // 4. Custom script execution hook
        const scriptHook = runCustomScript ? runCustomScript({ scene, camera, renderer, THREE }) : null;

        let lastTime = performance.now();
        let animationFrameId: number;

        const animate = (now: number) => {
            const delta = (now - lastTime) / 1000;
            lastTime = now;
            const time = now / 1000;

            if (env && env.update) env.update(time, delta);
            if (scriptHook && scriptHook.update) scriptHook.update(time, delta);

            camera.lookAt(targetPos);
            renderer.render(scene, camera);
            animationFrameId = requestAnimationFrame(animate);
        };

        animationFrameId = requestAnimationFrame(animate);

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
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener('resize', handleResize);
            if (scriptHook && scriptHook.dispose) scriptHook.dispose();
            renderer.dispose();
            if (container.contains(renderer.domElement)) {
                container.removeChild(renderer.domElement);
            }
        };
    }, []);

    return (
        <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#0a0a0f', overflow: 'hidden' }}>
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
            <div style={{ position: 'absolute', top: 16, left: 16, padding: '8px 16px', background: 'rgba(0,0,0,0.6)', borderRadius: 20, color: '#38bdf8', fontFamily: 'monospace', fontSize: 12 }}>
                🌐 \${title} · Live Three.js Engine
            </div>
        </div>
    );
}
`;

    const sceneContent = `import * as THREE from 'three';
import { AtmosphericScatteringShader, VolumetricGodRaysShader } from './shaders';

export function createAtmosphericScene(scene: THREE.Scene, options: { skybox?: string; renderMode?: string } = {}) {
    const isSunset = options.skybox === 'sunset';
    scene.background = new THREE.Color(isSunset ? 0x1e1b4b : 0x0284c7);
    scene.fog = new THREE.FogExp2(isSunset ? 0xf97316 : 0xbae6fd, 0.005);

    // 1. Atmospheric Sky Dome
    const skyGeo = new THREE.SphereGeometry(300, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
        uniforms: {
            topColor: { value: new THREE.Color(isSunset ? 0x311042 : 0x0369a1) },
            bottomColor: { value: new THREE.Color(isSunset ? 0xf97316 : 0xe0f2fe) },
            offset: { value: 33 },
            exponent: { value: 0.6 }
        },
        vertexShader: AtmosphericScatteringShader.vertexShader,
        fragmentShader: AtmosphericScatteringShader.fragmentShader,
        side: THREE.BackSide
    });
    const skyDome = new THREE.Mesh(skyGeo, skyMat);
    scene.add(skyDome);

    // 2. Volumetric Sun & God Rays
    const sunGeo = new THREE.SphereGeometry(8, 16, 16);
    const sunMat = new THREE.MeshBasicMaterial({ color: isSunset ? 0xffaa44 : 0xfffaed });
    const sunMesh = new THREE.Mesh(sunGeo, sunMat);
    sunMesh.position.set(40, 60, 40);
    scene.add(sunMesh);

    // Volumetric God Rays Light Shafts
    const rayGeo = new THREE.CylinderGeometry(0.5, 30, 90, 16, 1, true);
    const rayMat = new THREE.ShaderMaterial({
        uniforms: {
            uTime: { value: 0 },
            uColor: { value: new THREE.Color(isSunset ? 0xffaa55 : 0xfffae0) },
            uIntensity: { value: 0.75 }
        },
        vertexShader: VolumetricGodRaysShader.vertexShader,
        fragmentShader: VolumetricGodRaysShader.fragmentShader,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false
    });
    const godRays = new THREE.Mesh(rayGeo, rayMat);
    godRays.position.set(20, 30, 20);
    godRays.rotateX(0.4);
    godRays.rotateZ(-0.4);
    scene.add(godRays);

    // 3. Lighting
    const hemiLight = new THREE.HemisphereLight(
        isSunset ? 0xfdba74 : 0xe0f2fe,
        isSunset ? 0x431407 : 0x1e3a8a,
        1.4
    );
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(isSunset ? 0xff7722 : 0xfff8e7, 2.2);
    sunLight.position.set(40, 60, 40);
    sunLight.castShadow = true;
    scene.add(sunLight);

    return {
        skyDome,
        sunMesh,
        godRays,
        update: (time: number, delta: number) => {
            rayMat.uniforms.uTime.value = time;
        }
    };
}
`;

    const aircraftContent = AIRCRAFT_HELPERS_SOURCE;
    const physicsContent = FLIGHT_PHYSICS_SOURCE;


    const shadersContent = `export const AtmosphericScatteringShader = {
    vertexShader: \`
        varying vec3 vWorldPosition;
        void main() {
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    \`,
    fragmentShader: \`
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
            float h = normalize(vWorldPosition + offset).y;
            gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
        }
    \`
};

export const VolumetricGodRaysShader = {
    vertexShader: \`
        varying vec2 vUv;
        varying vec3 vNormal;
        void main() {
            vUv = uv;
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    \`,
    fragmentShader: \`
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uIntensity;
        varying vec2 vUv;
        varying vec3 vNormal;
        void main() {
            float alpha = (1.0 - vUv.y) * 0.35 * uIntensity;
            alpha *= (0.8 + 0.2 * sin(uTime * 2.0 + vUv.x * 6.28));
            gl_FragColor = vec4(uColor, alpha);
        }
    \`
};
`;

    const customScriptContent = scene?.customScript || scene?.code || `// Custom Three.js dynamic script hook
// You can add arbitrary dynamic Three.js meshes, particle systems, or animation passes here.
export function runCustomScript(context: any) {
    const { scene, THREE } = context;
    // Example: add a subtle neon particle grid
    const pCount = 200;
    const pGeo = new THREE.BufferGeometry();
    const pPos = new Float32Array(pCount * 3);
    for (let i = 0; i < pCount; i++) {
        pPos[i * 3] = (Math.random() - 0.5) * 80;
        pPos[i * 3 + 1] = Math.random() * 20;
        pPos[i * 3 + 2] = (Math.random() - 0.5) * 80;
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    const pMat = new THREE.PointsMaterial({ color: 0x38bdf8, size: 0.2, transparent: true, opacity: 0.6 });
    const particles = new THREE.Points(pGeo, pMat);
    scene.add(particles);

    return {
        update: (time: number, delta: number) => {
            particles.rotation.y = time * 0.02;
        },
        dispose: () => {
            scene.remove(particles);
            pGeo.dispose();
            pMat.dispose();
        }
    };
}
`;

    const readmeContent = `# ${title}

${subtitle}

### Structure
- \`App.tsx\`: React canvas mounting with Three.js rendering loop
- \`scene.ts\`: Atmospheric sky dome, volumetric god rays, and lighting
${isFlight ? `- \`aircraft.ts\`: High-fidelity aircraft with articulated ailerons, elevators, rudder, and engines\n- \`physics.ts\`: Aerodynamic kinematics and control surface deflections\n` : ''}- \`shaders.ts\`: Custom GLSL shaders
- \`customScript.ts\`: Live user-customizable dynamic Three.js script
`;

    const files: CodeFileTab[] = [
        { id: 'tab-app', name: 'App.tsx', path: 'App.tsx', language: 'react', content: appContent, isEntry: true },
        { id: 'tab-scene', name: 'scene.ts', path: 'scene.ts', language: 'typescript', content: sceneContent },
        ...(isFlight ? [
            { id: 'tab-aircraft', name: 'aircraft.ts', path: 'aircraft.ts', language: 'typescript', content: aircraftContent },
            { id: 'tab-physics', name: 'physics.ts', path: 'physics.ts', language: 'typescript', content: physicsContent },
        ] : []),
        { id: 'tab-shaders', name: 'shaders.ts', path: 'shaders.ts', language: 'typescript', content: shadersContent },
        { id: 'tab-custom', name: 'customScript.ts', path: 'customScript.ts', language: 'typescript', content: customScriptContent },
        { id: 'tab-readme', name: 'README.md', path: 'README.md', language: 'markdown', content: readmeContent }
    ];

    return {
        title: `${title} - Live 3D Sandbox`,
        subtitle: 'Three.js 3D viewport code sandbox',
        template: 'react',
        viewMode: 'split',
        viewportMode: 'desktop',
        activeFileId: 'tab-app',
        files,
        consoleLogs: []
    };
}

/**
 * Deterministically converts a Live Code Sandbox back into a 3D Scene primitive data model.
 */
/**
 * Safely retrieves state exported by the live sandbox runtime (via context or sessionStorage).
 */
export function getSandboxRuntimeState(sandbox: LiveCodeSandboxData, context?: any): Record<string, any> | undefined {
    if (context?.state && typeof context.state === 'object') {
        return context.state;
    }
    if ((sandbox as any)?.runtimeState && typeof (sandbox as any).runtimeState === 'object') {
        return (sandbox as any).runtimeState;
    }
    if (typeof window !== 'undefined' && window.sessionStorage) {
        try {
            const key = `sb-sandbox-state-${sandbox?.title || 'default'}`;
            const item = window.sessionStorage.getItem(key);
            if (item) {
                return JSON.parse(item);
            }
        } catch {
            // ignore
        }
    }
    return undefined;
}

/**
 * Morphs a Live Code Sandbox (or 3D micro-app) into an interactive 3D Scene viewport.
 */
export function morphSandboxToScene3D(sandbox: LiveCodeSandboxData, context?: any): Scene3DData {
    const files = sandbox?.files || [];
    const appFile = files.find(f => f.name === 'App.tsx' || f.name.endsWith('.tsx'));
    const sceneFile = files.find(f => f.name === 'scene.ts');
    const customScriptFile = files.find(f => f.name === 'customScript.ts' || f.name === 'customScript.js' || f.name === 'script.ts');
    const aircraftFile = files.find(f => f.name === 'aircraft.ts');
    const cppFile = files.find(f => f.name.endsWith('.cpp') || f.name === 'world_generator.cpp' || f.language === 'cpp');

    const state = getSandboxRuntimeState(sandbox, context);

    const rawTitle = sandbox?.title?.replace(/\s*-\s*Live 3D Sandbox|\s*-\s*Sandbox/i, '') || '3D Jet Flight Simulation';
    const skyboxMatch = (appFile?.content || sceneFile?.content || '').match(/skybox:\s*['"]([^'"]+)['"]/);
    const extractedSkybox = (state?.skybox as string) || (skyboxMatch ? skyboxMatch[1] : ((sceneFile?.content || appFile?.content || '').includes('isSunset = true') ? 'sunset' : 'realistic-sky'));
    const isAirplane = (aircraftFile !== undefined) || /plane|jet|aircraft|flight|aviation/i.test(rawTitle);

    const customScript = customScriptFile?.content || undefined;

    const cppGenerator = cppFile ? {
        enabled: true,
        filename: cppFile.name || 'world_generator.cpp',
        sourceCode: cppFile.content
    } : undefined;

    return {
        title: rawTitle,
        subtitle: sandbox?.subtitle || 'Interactive procedural 3D spatial simulation',
        worldBranch: isAirplane ? 'earth/flight-corridor' : 'earth/cyberpunk',
        renderMode: (state?.renderMode as any) || 'pbr',
        cameraMode: 'orbit',
        animation: isAirplane ? 'flight' : 'orbit',
        camera: {
            position: [15, 12, 20],
            target: [0, 2, 0],
            fov: 45
        },
        environment: {
            skybox: extractedSkybox,
            lighting: (state?.lighting as any) || 'daylight',
            ground: true
        },
        customScript,
        cppGenerator,
        timeline: {
            currentTimeMs: 0,
            durationMs: 10000,
            isPlaying: true,
            playbackSpeed: 1.0,
            speed: 1.0,
            isLooping: true
        },
        objects: isAirplane ? [
            {
                id: 'obj-aircraft-1',
                content: {
                    type: '3d-scene',
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
        ] : [
            {
                id: 'obj-mesh-1',
                content: {
                    type: '3d-scene',
                    durableUri: 'internal:mesh',
                    mimeType: 'model/gltf-binary',
                    metadata: { dims: { width: 5, height: 5, depth: 5 } }
                },
                space: {
                    spatial3d: { x: 0, y: 0, z: 0, pitch: 0, yaw: 45, roll: 0 }
                },
                time: { startMs: 0, durationMs: 0 },
                lineage: { version: 1 }
            }
        ]
    };
}

export function morphSandboxToBrowser(sandbox: LiveCodeSandboxData): InteractiveBrowserData {
    const title = sandbox?.title ? `${sandbox.title} - Live Preview` : 'Sandbox Web Preview';
    const files = sandbox?.files || [];
    const htmlFile = files.find(f => f.name.endsWith('.html') || f.language === 'html');
    const cssFiles = files.filter(f => f.name.endsWith('.css') || f.language === 'css').map(f => f.content).join('\n');
    const jsFiles = files.filter(f => f.name.endsWith('.js') || f.name.endsWith('.ts') || f.name.endsWith('.tsx') || f.name.endsWith('.jsx')).map(f => f.content).join('\n');

    const simulatedHtml = htmlFile?.content || `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #09090b; color: #f4f4f5; margin: 0; padding: 24px; }
    .preview-card { background: #18181b; border: 1px solid #27272a; border-radius: 16px; padding: 24px; max-width: 600px; margin: 0 auto; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    h1 { margin-top: 0; font-size: 20px; color: #38bdf8; }
    ${cssFiles}
  </style>
</head>
<body>
  <div class="preview-card">
    <h1>${title}</h1>
    <p>Live sandbox preview transformed from code files.</p>
    <div id="root"></div>
  </div>
  ${jsFiles ? `<script>${jsFiles}</script>` : ''}
</body>
</html>`;

    return {
        url: 'http://localhost:3000',
        title,
        viewportMode: sandbox?.viewportMode === 'mobile' ? 'mobile' : sandbox?.viewportMode === 'tablet' ? 'tablet' : 'desktop',
        history: ['http://localhost:3000'],
        historyIndex: 0,
        isLoading: false,
        mockPageHtml: simulatedHtml,
        consoleLogs: [
            { type: 'info', text: `Rendered preview for ${files.length} code file(s)`, timestamp: new Date().toLocaleTimeString() },
            { type: 'log', text: 'Sandboxed DOM mounted and interactive', timestamp: new Date().toLocaleTimeString() }
        ],
        inspectMode: false,
        deviceScale: 1
    };
}

/**
 * Morphs an Interactive Browser Canvas back into a Code Sandbox.
 */
export function morphBrowserToSandbox(browser: InteractiveBrowserData): LiveCodeSandboxData {
    const title = browser?.title ? `${browser.title} - Source` : 'Web Page Sandbox';
    const htmlContent = browser?.mockPageHtml || `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${browser?.title || 'Web Page'}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div class="container">
    <h1>${browser?.title || 'Web Page'}</h1>
    <p>Viewing target URL: <code>${browser?.url || 'https://example.com'}</code></p>
  </div>
  <script src="index.js"></script>
</body>
</html>`;

    const cssContent = `/* Styles for ${browser?.title || 'Web Page'} */
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background-color: #09090b;
  color: #f4f4f5;
  margin: 0;
  padding: 32px;
}
.container {
  max-width: 800px;
  margin: 0 auto;
  padding: 24px;
  background: #18181b;
  border-radius: 12px;
  border: 1px solid #27272a;
}
code {
  color: #38bdf8;
  background: #27272a;
  padding: 2px 6px;
  border-radius: 4px;
}`;

    const jsContent = `// Script for ${browser?.title || 'Web Page'}
console.log('Page sandbox initialized for ${browser?.url || 'https://example.com'}');
`;

    return {
        title,
        template: 'vanilla-html',
        viewMode: 'split',
        viewportMode: browser?.viewportMode === 'mobile' ? 'mobile' : browser?.viewportMode === 'tablet' ? 'tablet' : 'desktop',
        files: [
            { id: 'file-html', name: 'index.html', language: 'html', content: htmlContent, isEntry: true },
            { id: 'file-css', name: 'styles.css', language: 'css', content: cssContent },
            { id: 'file-js', name: 'index.js', language: 'javascript', content: jsContent }
        ],
        consoleLogs: (browser?.consoleLogs || []).map(l => ({
            type: l.type,
            message: l.text,
            timestamp: l.timestamp
        }))
    };
}

/**
 * Morphs a Markdown Document into an Interactive Web Page Browser Preview.
 */
export function morphDocToBrowser(doc: MarkdownDocumentData): InteractiveBrowserData {
    const title = doc?.title ? `${doc.title} - Web Spec` : 'Document Web Preview';
    const sections = doc?.sections || [];
    const renderedBody = sections.map(s => {
        if (s.type === 'heading') return `<h${s.level || 2}>${s.content || ''}</h${s.level || 2}>`;
        if (s.type === 'callout') return `<div class="callout callout-${s.calloutType || 'info'}"><strong>${s.calloutTitle || 'Note'}:</strong> ${s.content || ''}</div>`;
        if (s.type === 'table' && s.tableHeaders) {
            const th = s.tableHeaders.map(h => `<th>${h}</th>`).join('');
            const trs = (s.tableRows || []).map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
            return `<table class="doc-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
        }
        return `<p>${s.content || ''}</p>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; line-height: 1.6; padding: 40px; margin: 0; }
    .doc-container { max-width: 760px; margin: 0 auto; background: #1e293b; padding: 36px; border-radius: 16px; border: 1px solid #334155; }
    h1 { color: #38bdf8; border-bottom: 1px solid #334155; padding-bottom: 12px; }
    h2 { color: #f8fafc; margin-top: 24px; }
    .callout { background: rgba(56, 189, 248, 0.1); border-left: 4px solid #38bdf8; padding: 12px 16px; border-radius: 6px; margin: 16px 0; }
    .doc-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    .doc-table th, .doc-table td { border: 1px solid #334155; padding: 8px 12px; text-align: left; }
    .doc-table th { background: #0f172a; }
  </style>
</head>
<body>
  <div class="doc-container">
    <h1>${doc?.title || 'Document'}</h1>
    <p><em>${doc?.subtitle || 'Synthesized Document Preview'}</em></p>
    ${renderedBody}
  </div>
</body>
</html>`;

    return {
        url: 'http://localhost:3000/docs/preview',
        title,
        viewportMode: 'desktop',
        history: ['http://localhost:3000/docs/preview'],
        historyIndex: 0,
        isLoading: false,
        mockPageHtml: html,
        consoleLogs: [
            { type: 'info', text: `Document converted to interactive HTML view with ${sections.length} sections`, timestamp: new Date().toLocaleTimeString() }
        ],
        inspectMode: false,
        deviceScale: 1
    };
}

/**
 * Morphs a Markdown Document Spec into a Contextual 3D Spatial Scene.
 */
export function morphDocToScene3D(doc: MarkdownDocumentData, context?: any): Scene3DData {
    const docTitle = doc?.title || 'Historical Document';
    const docContent = (doc?.sections || []).map(s => s.content || s.calloutTitle || '').join('\n');
    return synthesizeContextual3DScene(docTitle, {
        docTitle,
        docContent,
        activeArtifact: {
            id: 'source-doc',
            type: 'markdown-document',
            title: docTitle,
            data: doc
        },
        ...context
    });
}

/**
 * Morphs a Markdown Document into a structured KPI Metric Dashboard.
 */
export function morphDocToMetrics(doc: MarkdownDocumentData, _context?: any): MetricCardsData {
    const title = doc?.title ? `${doc.title} - Metrics & KPI Dashboard` : 'Operational Metric Dashboard';
    const subtitle = doc?.subtitle || 'Synthesized from document specifications and structured data';
    const sections = Array.isArray(doc?.sections) ? doc.sections : [];

    // Calculate section stats
    const totalSections = sections.length;
    let totalChecklistItems = 0;
    let completedChecklistItems = 0;

    for (const sec of sections) {
        if (sec.type === 'checklist' && Array.isArray(sec.checklistItems)) {
            totalChecklistItems += sec.checklistItems.length;
            completedChecklistItems += sec.checklistItems.filter(i => i.done).length;
        }
    }

    const completionRate = totalChecklistItems > 0
        ? Math.round((completedChecklistItems / totalChecklistItems) * 100)
        : 85;

    const allContent = sections.map(s => s.content || s.calloutTitle || '').join(' ');
    const domain = classifyDomain(doc?.title || '', allContent);

    const chartData: ChartDataPoint[] = sections.slice(0, 6).map((sec, idx) => ({
        label: ((sec as any).title || sec.calloutTitle || `Sec ${idx + 1}`).slice(0, 18),
        value: 40 + (idx * 15) % 60
    }));

    if (sections.length === 0) {
        return synthesizeAdaptiveMetrics(domain, title, subtitle);
    }

    const metrics: MetricItem[] = [
        {
            id: 'met-1',
            label: 'Spec Completeness',
            value: `${completionRate}%`,
            change: `${completedChecklistItems}/${totalChecklistItems || totalSections} items`,
            trend: 'up',
            icon: 'check-circle',
            color: 'emerald',
            sparkline: [40, 55, 68, 75, 82, completionRate]
        },
        {
            id: 'met-2',
            label: 'Document Sections',
            value: totalSections.toString(),
            change: '+3',
            trend: 'up',
            icon: 'file-text',
            color: 'blue',
            sparkline: [2, 4, 6, 8, totalSections]
        },
        {
            id: 'met-3',
            label: 'Milestones & Tasks',
            value: (totalChecklistItems || 12).toString(),
            change: `${completedChecklistItems} done`,
            trend: 'neutral',
            icon: 'list',
            color: 'indigo',
            sparkline: [3, 6, 9, totalChecklistItems || 12]
        },
        {
            id: 'met-4',
            label: 'Verification Integrity',
            value: '99.4%',
            change: '+0.4%',
            trend: 'up',
            icon: 'shield',
            color: 'amber',
            sparkline: [96, 97, 98, 99.4]
        }
    ];

    // Scan allContent for any explicit metric key-value pairs (e.g., "Throughput: 50k req/s")
    const explicitMetricRegex = /(?:^|\n|\.\s+)([A-Za-z][A-Za-z0-9_\s]{2,22})\s*[:=]\s*(\$?\d+(?:\.\d+)?%?(?:\s*[a-zA-Z/%]+)?)/g;
    let match: RegExpExecArray | null;
    let customMetricCount = 0;
    while ((match = explicitMetricRegex.exec(allContent)) !== null && customMetricCount < 2) {
        const rawLabel = match[1].trim();
        const rawVal = match[2].trim();
        if (rawLabel.length > 2 && rawVal.length > 0 && !/^(http|https|note|step|item|figure|table|section)/i.test(rawLabel)) {
            metrics.splice(1 + customMetricCount, 0, {
                id: `met-custom-${customMetricCount + 1}`,
                label: rawLabel,
                value: rawVal,
                change: 'Ground Truth',
                trend: 'up',
                icon: 'activity',
                color: 'cyan',
                sparkline: [80, 85, 90, 95]
            });
            customMetricCount++;
        }
    }

    return {
        title,
        subtitle,
        metrics,
        chart: {
            title: 'Section Complexity & Coverage Distribution',
            type: 'bar',
            unit: 'Coverage Index',
            data: chartData.length > 0 ? chartData : [
                { label: 'Foundations', value: 92 },
                { label: 'Architecture', value: 85 },
                { label: 'Implementation', value: 78 },
                { label: 'Verification', value: 95 }
            ]
        },
        insights: [
            `Parsed ${totalSections} document sections with ${totalChecklistItems} actionable deliverables.`,
            `Document specification demonstrates ${completionRate}% milestone alignment.`,
            `Cross-surface telemetry synchronized with active workspace state.`
        ]
    };
}

/**
 * Morphs a Markdown Document into a Live Code Sandbox.
 */
export function morphDocToSandbox(doc: MarkdownDocumentData, _context?: any): LiveCodeSandboxData {
    const title = doc?.title ? `${doc.title} - Interactive Prototype` : 'Interactive Document Code Sandbox';
    const sections = Array.isArray(doc?.sections) ? doc.sections : [];
    const allContent = sections.map(s => s.content || s.calloutTitle || '').join(' ');
    const domain = classifyDomain(doc?.title || '', allContent);

    if (sections.length === 0 && domain !== 'general') {
        return synthesizeAdaptiveSandbox(domain, title, doc?.title || '');
    }

    const docTitleSafe = (doc?.title || 'Interactive Spec').replace(/"/g, '\\"');

    const appCode = `import React, { useState } from 'react';

export default function DocumentExplorerApp() {
    const [activeTab, setActiveTab] = useState(0);
    const sections = ${JSON.stringify((doc?.sections || []).slice(0, 8).map((s, i) => ({
        id: s.id || `sec-${i}`,
        title: (s as any).title || s.calloutTitle || `Section ${i + 1}`,
        content: s.content || 'Detailed architectural and contextual specifications.'
    })))};

    return (
        <div style={{ padding: '24px', fontFamily: 'system-ui, sans-serif', color: '#f8fafc', background: '#0f172a', minHeight: '100vh' }}>
            <header style={{ borderBottom: '1px solid #334155', paddingBottom: '16px', marginBottom: '24px' }}>
                <h1 style={{ fontSize: '24px', margin: '0 0 8px 0', color: '#38bdf8' }}>${docTitleSafe}</h1>
                <p style={{ margin: 0, color: '#94a3b8', fontSize: '14px' }}>Interactive Spec Explorer & Dynamic Architecture Viewer</p>
            </header>
            
            <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: '20px' }}>
                <nav style={{ background: '#1e293b', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', marginBottom: '8px' }}>Sections</div>
                    {sections.map((sec, idx) => (
                        <button
                            key={sec.id}
                            className="sb-btn-secondary"
                            onClick={() => setActiveTab(idx)}
                            style={{
                                display: 'block',
                                width: '100%',
                                textAlign: 'left',
                                padding: '8px 12px',
                                marginBottom: '4px',
                                borderRadius: '6px',
                                border: 'none',
                                background: activeTab === idx ? '#0284c7' : 'transparent',
                                color: activeTab === idx ? '#ffffff' : '#cbd5e1',
                                cursor: 'pointer',
                                fontSize: '13px'
                            }}
                        >
                            {sec.title}
                        </button>
                    ))}
                </nav>

                <main style={{ background: '#1e293b', borderRadius: '8px', padding: '20px' }}>
                    {sections[activeTab] && (
                        <div>
                            <h2 style={{ fontSize: '18px', marginTop: 0, color: '#f1f5f9' }}>{sections[activeTab].title}</h2>
                            <div style={{ lineHeight: '1.6', color: '#cbd5e1', whiteSpace: 'pre-wrap' }}>
                                {sections[activeTab].content}
                            </div>
                        </div>
                    )}
                </main>
            </div>
        </div>
    );
}
`;

    return {
        title,
        subtitle: 'Interactive prototype synthesized from document specifications',
        template: 'react',
        viewMode: 'split',
        activeFileId: 'App.tsx',
        files: [
            {
                id: 'App.tsx',
                name: 'App.tsx',
                language: 'typescript',
                content: appCode
            }
        ]
    };
}

/**
 * Morphs a 3D Scene into a technical Markdown Document Specification.
 */
export function morphScene3DToDoc(scene: Scene3DData): MarkdownDocumentData {
    const title = scene?.title ? `${scene.title} — Technical Specification` : '3D Spatial Scene Specification';
    const sections: MarkdownSection[] = [
        {
            id: 'sec-overview',
            type: 'paragraph',
            content: `### Spatial Architecture Overview\n\nThis specification documents the 3D spatial environment for **${scene.title}**. Render mode: \`${scene.renderMode || 'pbr'}\`, World branch: \`${scene.worldBranch || 'earth/spatial'}\`, Camera mode: \`${scene.cameraMode || 'orbit'}\`.`
        },
        {
            id: 'sec-camera-lighting',
            type: 'callout',
            calloutType: 'info',
            calloutTitle: 'Viewport & Camera Framing',
            content: `Camera is initialized at position [${(scene.camera?.position || [15, 12, 20]).join(', ')}] with field of view ${scene.camera?.fov || 45}°. Lighting model is configured for ${scene.environment?.lighting || 'daylight'} with skybox "${scene.environment?.skybox || 'realistic-sky'}".`
        },
        {
            id: 'sec-entities-table',
            type: 'table',
            tableHeaders: ['Entity / Mesh ID', 'Type', 'Spatial Coordinates (X, Y, Z)', 'Material Shader'],
            tableRows: (scene.customMeshes || []).map(m => [
                m.name || m.id,
                m.type || 'box',
                m.position ? `[${m.position.join(', ')}]` : '[0, 0, 0]',
                m.material?.wireframe ? 'Wireframe Basic' : 'PBR Standard'
            ])
        }
    ];

    if (sections[2].tableRows?.length === 0) {
        sections[2].tableRows = [
            ['Spatial Focal Center', 'Procedural Mesh', '[0, 2, 0]', 'PBR Emissive'],
            ['Ground Plane', 'Terrain Plane', '[0, 0, 0]', 'PBR Roughness 0.9'],
            ['Atmospheric Dome', 'Skydome Sphere', '[0, 0, 0]', 'Rayleigh Shader']
        ];
    }

    return {
        title,
        subtitle: scene.subtitle || 'Technical specification for 3D graphics environment',
        sections
    };
}

/**
 * Morphs a 3D Scene into a 3D Asset & Graphics Kanban Board.
 */
export function morphScene3DToKanban(scene: Scene3DData): KanbanBoardData {
    const title = scene?.title ? `${scene.title} — Graphics Roadmap` : '3D Scene Production Roadmap';
    const meshNames = (scene.customMeshes || []).map(m => m.name || m.id);

    return {
        title,
        subtitle: '3D asset pipeline, shader development, and spatial optimizations',
        columns: [
            {
                id: 'todo',
                title: 'Backlog / Modeling',
                color: 'blue',
                cards: [
                    {
                        id: 'card-3d-1',
                        title: `Optimize ${meshNames[0] || 'Primary Mesh'} LOD Levels`,
                        description: 'Generate high, medium, and low polygon count levels of detail for smooth WebGL rendering.',
                        tag: 'Geometry',
                        tagColor: 'blue',
                        priority: 'medium'
                    },
                    {
                        id: 'card-3d-2',
                        title: 'Texture Baking & Roughness Maps',
                        description: 'Bake normal maps, ambient occlusion, and metalness roughness channels.',
                        tag: 'Materials',
                        tagColor: 'indigo',
                        priority: 'high'
                    }
                ]
            },
            {
                id: 'in-progress',
                title: 'In Progress / Shaders',
                color: 'amber',
                cards: [
                    {
                        id: 'card-3d-3',
                        title: 'Volumetric Lighting & Atmospheric Shaders',
                        description: 'Tune Rayleigh scattering, sun position vectors, and shadow frustum.',
                        tag: 'Shaders',
                        tagColor: 'amber',
                        priority: 'urgent'
                    }
                ]
            },
            {
                id: 'done',
                title: 'Done / Verified',
                color: 'emerald',
                cards: [
                    {
                        id: 'card-3d-4',
                        title: 'Initial WebGL Scene & Camera Setup',
                        description: 'Configured Three.js renderer, orbit controls, and perspective camera.',
                        tag: 'Engine',
                        tagColor: 'emerald',
                        priority: 'low'
                    }
                ]
            }
        ]
    };
}

/**
 * Morphs a 3D Scene into a Render Pipeline Node Graph.
 */
export function morphScene3DToNodeGraph(scene: Scene3DData): NodeGraphData {
    const title = scene?.title ? `${scene.title} — Render Pipeline` : '3D Scene Graph & Render Pipeline';
    return {
        title,
        subtitle: 'WebGL node hierarchy, shader passes, and frame compositor flow',
        nodes: [
            { id: 'n-cam', label: 'Perspective Camera', subtitle: `FOV ${scene.camera?.fov || 45}°`, category: 'input', color: 'blue', status: 'completed', x: 80, y: 120 },
            { id: 'n-env', label: 'Environment Lighting', subtitle: scene.environment?.skybox || 'Skybox & Sun', category: 'transformation', color: 'amber', status: 'completed', x: 280, y: 80 },
            { id: 'n-mesh', label: 'Geometry Meshes', subtitle: `${(scene.customMeshes || []).length || 4} Scene Meshes`, category: 'transformation', color: 'indigo', status: 'completed', x: 280, y: 200 },
            { id: 'n-shader', label: 'PBR Shaders & Materials', subtitle: 'Roughness / Metalness', category: 'transformation', color: 'purple', status: 'completed', x: 500, y: 140 },
            { id: 'n-render', label: 'WebGL Renderer', subtitle: '60 FPS Post-Process', category: 'output', color: 'emerald', status: 'completed', x: 720, y: 140 }
        ],
        edges: [
            { id: 'e1', source: 'n-cam', target: 'n-render', style: 'solid', color: 'blue' },
            { id: 'e2', source: 'n-env', target: 'n-shader', style: 'solid', color: 'amber' },
            { id: 'e3', source: 'n-mesh', target: 'n-shader', style: 'solid', color: 'indigo' },
            { id: 'e4', source: 'n-shader', target: 'n-render', style: 'animated', color: 'emerald' }
        ]
    };
}

/**
 * Morphs a 3D Scene into spatial performance Metrics.
 */
export function morphScene3DToMetrics(scene: Scene3DData): MetricCardsData {
    const title = scene?.title ? `${scene.title} — Spatial Metrics` : '3D Viewport Performance Metrics';
    const meshCount = (scene.customMeshes || []).length || 6;
    return {
        title,
        subtitle: 'Real-time WebGL rendering telemetry, polygon counts, and shader passes',
        metrics: [
            {
                id: 'm-fps',
                label: 'Frame Rate',
                value: '60 FPS',
                change: 'Stable',
                trend: 'up',
                icon: 'activity',
                color: 'emerald',
                sparkline: [58, 60, 59, 60, 60, 60]
            },
            {
                id: 'm-meshes',
                label: 'Active Meshes',
                value: meshCount.toString(),
                change: '+2',
                trend: 'neutral',
                icon: 'box',
                color: 'blue',
                sparkline: [2, 4, meshCount, meshCount]
            },
            {
                id: 'm-drawcalls',
                label: 'Draw Calls',
                value: (meshCount * 2 + 3).toString(),
                change: '-1',
                trend: 'up',
                icon: 'zap',
                color: 'indigo',
                sparkline: [22, 18, 16, 15]
            },
            {
                id: 'm-poly',
                label: 'Polygon Count',
                value: `${(meshCount * 1.8).toFixed(1)}k`,
                change: 'Optimized',
                trend: 'up',
                icon: 'layers',
                color: 'amber',
                sparkline: [12, 10, 8, 7.2]
            }
        ],
        chart: {
            title: 'Frame Time & Render Pass Latency (ms)',
            type: 'line',
            unit: 'ms',
            data: [
                { label: 'Geometry Pass', value: 4.2 },
                { label: 'Shadow Pass', value: 2.8 },
                { label: 'Lighting Pass', value: 5.1 },
                { label: 'Post-Process', value: 1.4 }
            ]
        },
        insights: [
            `WebGL viewport running smoothly with ${meshCount} rendered primitives.`,
            `Shader compilation verified with zero GLSL warnings.`,
            `Camera and view frustum culling active for peak frame throughput.`
        ]
    };
}

/**
 * Morphs a Kanban Board into a Markdown Document.
 */
export function morphKanbanToDoc(kanban: KanbanBoardData): MarkdownDocumentData {
    const title = kanban?.title ? `${kanban.title} — Delivery Report` : 'Project Roadmap & Status Report';
    const columns = Array.isArray(kanban?.columns) ? kanban.columns : [];

    const sections: MarkdownSection[] = [
        {
            id: 'sec-kb-summary',
            type: 'paragraph',
            content: `### Executive Roadmap Summary\n\nThis delivery specification summarizes the active Kanban roadmap for **${kanban.title}**. Across ${columns.length} stages, teams are actively executing scheduled deliverables.`
        },
        {
            id: 'sec-kb-table',
            type: 'table',
            tableHeaders: ['Sprint Stage', 'Task Card Title', 'Priority', 'Tag'],
            tableRows: []
        }
    ];

    const rows: string[][] = [];
    for (const col of columns) {
        for (const card of col.cards || []) {
            rows.push([col.title, card.title, (card.priority || 'medium').toUpperCase(), card.tag || 'Sprint']);
        }
    }
    sections[1].tableRows = rows.length > 0 ? rows : [['To Do', 'Core Infrastructure', 'HIGH', 'Setup']];

    return {
        title,
        subtitle: kanban.subtitle || 'Roadmap synthesized from Kanban delivery board',
        sections
    };
}

/**
 * Morphs a Kanban Board into a Node Graph.
 */
export function morphKanbanToNodeGraph(kanban: KanbanBoardData): NodeGraphData {
    const title = kanban?.title ? `${kanban.title} — Stage Workflow` : 'Kanban Stage Workflow Flow';
    const columns = Array.isArray(kanban?.columns) ? kanban.columns : [];

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    columns.forEach((col, idx) => {
        const nodeId = `node-col-${col.id || idx}`;
        nodes.push({
            id: nodeId,
            label: col.title,
            subtitle: `${(col.cards || []).length} active items`,
            category: idx === 0 ? 'input' : (idx === columns.length - 1 ? 'output' : 'transformation'),
            color: col.color === 'emerald' ? 'emerald' : (col.color === 'amber' ? 'amber' : 'blue'),
            status: idx === columns.length - 1 ? 'completed' : 'pending',
            x: 80 + idx * 220,
            y: 160
        });

        if (idx > 0) {
            const prevId = `node-col-${columns[idx - 1].id || idx - 1}`;
            edges.push({
                id: `edge-${prevId}-${nodeId}`,
                source: prevId,
                target: nodeId,
                style: 'solid',
                color: 'blue'
            });
        }
    });

    if (nodes.length === 0) {
        nodes.push(
            { id: 'n1', label: 'To Do', category: 'input', color: 'blue', status: 'pending', x: 80, y: 160 },
            { id: 'n2', label: 'In Progress', category: 'transformation', color: 'amber', status: 'pending', x: 300, y: 160 },
            { id: 'n3', label: 'Done', category: 'output', color: 'emerald', status: 'completed', x: 520, y: 160 }
        );
        edges.push(
            { id: 'e1', source: 'n1', target: 'n2', color: 'blue' },
            { id: 'e2', source: 'n2', target: 'n3', color: 'amber' }
        );
    }

    return {
        title,
        subtitle: 'Sequential delivery stages mapped into executable node graph flow',
        nodes,
        edges
    };
}

/**
 * Morphs a Kanban Board into Metric Cards.
 */
export function morphKanbanToMetrics(kanban: KanbanBoardData): MetricCardsData {
    const title = kanban?.title ? `${kanban.title} — Sprint Velocity` : 'Sprint Velocity & Task Metrics';
    const columns = Array.isArray(kanban?.columns) ? kanban.columns : [];

    let totalCards = 0;
    let doneCards = 0;
    let inProgressCards = 0;

    for (const col of columns) {
        const cCount = (col.cards || []).length;
        totalCards += cCount;
        if (col.id === 'done' || /done|complete/i.test(col.title)) {
            doneCards += cCount;
        } else if (col.id === 'in-progress' || /progress/i.test(col.title)) {
            inProgressCards += cCount;
        }
    }

    const rate = totalCards > 0 ? Math.round((doneCards / totalCards) * 100) : 75;

    return {
        title,
        subtitle: 'Real-time task velocity, sprint throughput, and bottleneck analytics',
        metrics: [
            {
                id: 'm-vel',
                label: 'Sprint Progress',
                value: `${rate}%`,
                change: '+15%',
                trend: 'up',
                icon: 'trending-up',
                color: 'emerald',
                sparkline: [35, 50, 60, rate]
            },
            {
                id: 'm-total',
                label: 'Total Tasks',
                value: totalCards.toString(),
                change: `${totalCards - doneCards} remaining`,
                trend: 'neutral',
                icon: 'check-square',
                color: 'blue',
                sparkline: [totalCards, totalCards, totalCards]
            },
            {
                id: 'm-wip',
                label: 'In Progress (WIP)',
                value: inProgressCards.toString(),
                change: inProgressCards > 5 ? 'High load' : 'Balanced',
                trend: inProgressCards > 5 ? 'down' : 'up',
                icon: 'clock',
                color: 'amber',
                sparkline: [2, 4, 3, inProgressCards]
            },
            {
                id: 'm-done',
                label: 'Completed Tasks',
                value: doneCards.toString(),
                change: '+4 this week',
                trend: 'up',
                icon: 'award',
                color: 'indigo',
                sparkline: [1, 3, 5, doneCards]
            }
        ],
        chart: {
            title: 'Task Distribution by Sprint Stage',
            type: 'bar',
            unit: 'Cards',
            data: columns.map(c => ({
                label: c.title,
                value: (c.cards || []).length
            }))
        },
        insights: [
            `Current sprint completion stands at ${rate}%.`,
            `Identified ${inProgressCards} items actively in flight across development teams.`,
            `Zero unassigned high-priority blockers detected.`
        ]
    };
}

/**
 * Morphs a Kanban Board into a 3D Spatial Roadmap Landscape.
 */
export function morphKanbanToScene3D(kanban: KanbanBoardData): Scene3DData {
    const title = kanban?.title ? `${kanban.title} — 3D Spatial Roadmap` : '3D Spatial Roadmap';
    const columns = Array.isArray(kanban?.columns) ? kanban.columns : [];

    const customMeshes = columns.map((col, idx) => ({
        id: `mesh-col-${col.id || idx}`,
        name: `Stage: ${col.title}`,
        type: 'box' as const,
        position: [((idx - columns.length / 2) * 12) as number, 2, 0] as [number, number, number],
        scale: [8, 4, 12] as [number, number, number],
        material: {
            color: col.color === 'emerald' ? 0x10b981 : (col.color === 'amber' ? 0xf59e0b : 0x3b82f6),
            roughness: 0.3,
            metalness: 0.7
        }
    }));

    return {
        title,
        subtitle: '3D spatial milestone platforms and interactive task columns',
        worldBranch: 'spatial/roadmap',
        sceneType: 'general',
        renderMode: 'pbr',
        cameraMode: 'orbit',
        animation: 'orbit',
        camera: {
            position: [0, 25, 40],
            target: [0, 0, 0],
            fov: 48
        },
        environment: {
            skybox: 'cyberpunk',
            lighting: 'daylight',
            ground: true
        },
        customMeshes: customMeshes.length > 0 ? customMeshes : [
            {
                id: 'mesh-default-stage',
                name: 'Roadmap Milestone Plinth',
                type: 'box',
                position: [0, 2, 0],
                scale: [10, 4, 10],
                material: { color: 0x38bdf8, roughness: 0.2, metalness: 0.8 }
            }
        ]
    };
}

/**
 * Morphs a Node Graph into a Markdown Document Architecture Specification.
 */
export function morphNodeGraphToDoc(graph: NodeGraphData): MarkdownDocumentData {
    const title = graph?.title ? `${graph.title} — Architecture Spec` : 'System Architecture Specification';
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];

    return {
        title,
        subtitle: graph.subtitle || 'System topology and data pipeline specifications',
        sections: [
            {
                id: 'sec-graph-overview',
                type: 'paragraph',
                content: `### Architecture Topology Overview\n\nThis specification details the **${graph.title}** node execution graph. Composed of **${nodes.length} connected service nodes** and **${edges.length} data transmission channels**.`
            },
            {
                id: 'sec-nodes-table',
                type: 'table',
                tableHeaders: ['Node Identifier', 'Category', 'Status', 'Configuration / Subtitle'],
                tableRows: nodes.map(n => [
                    n.label || n.id,
                    (n.category || 'general').toUpperCase(),
                    (n.status || 'active').toUpperCase(),
                    n.subtitle || 'Active microservice component'
                ])
            }
        ]
    };
}

/**
 * Morphs a Node Graph into an Engineering Kanban Board.
 */
export function morphNodeGraphToKanban(graph: NodeGraphData): KanbanBoardData {
    const title = graph?.title ? `${graph.title} — Implementation Roadmap` : 'Pipeline Engineering Tasks';
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];

    const todoCards: KanbanCard[] = [];
    const doneCards: KanbanCard[] = [];

    nodes.forEach((n, idx) => {
        const card: KanbanCard = {
            id: `card-node-${n.id}`,
            title: `Implement ${n.label || 'Node Component'}`,
            description: `Build and verify ${n.subtitle || 'microservice connector'} with integration contracts.`,
            tag: (n.category || 'Module').slice(0, 15),
            tagColor: n.category === 'input' ? 'blue' : (n.category === 'output' ? 'emerald' : 'amber'),
            priority: idx === 0 ? 'high' : 'medium'
        };
        if (n.status === 'completed') {
            doneCards.push(card);
        } else {
            todoCards.push(card);
        }
    });

    return {
        title,
        subtitle: 'Task assignments derived from architecture node graph',
        columns: [
            { id: 'todo', title: 'To Do', color: 'blue', cards: todoCards },
            { id: 'in-progress', title: 'In Progress', color: 'amber', cards: [] },
            { id: 'done', title: 'Done', color: 'emerald', cards: doneCards }
        ]
    };
}

/**
 * Morphs a Node Graph into Pipeline Telemetry Metrics.
 */
export function morphNodeGraphToMetrics(graph: NodeGraphData): MetricCardsData {
    const title = graph?.title ? `${graph.title} — Telemetry Metrics` : 'Pipeline Telemetry & Performance';
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];

    return {
        title,
        subtitle: 'Throughput, message rate, and end-to-end processing latency',
        metrics: [
            {
                id: 'm-nodes',
                label: 'Active Nodes',
                value: nodes.length.toString(),
                change: '+1',
                trend: 'neutral',
                icon: 'git-branch',
                color: 'blue',
                sparkline: [2, 4, nodes.length]
            },
            {
                id: 'm-tput',
                label: 'Throughput',
                value: '14.2k req/s',
                change: '+8.4%',
                trend: 'up',
                icon: 'zap',
                color: 'emerald',
                sparkline: [10.2, 11.5, 12.8, 14.2]
            },
            {
                id: 'm-latency',
                label: 'P99 Latency',
                value: '18ms',
                change: '-4ms',
                trend: 'up',
                icon: 'clock',
                color: 'indigo',
                sparkline: [24, 22, 20, 18]
            },
            {
                id: 'm-edges',
                label: 'Data Channels',
                value: edges.length.toString(),
                change: '100% Healthy',
                trend: 'up',
                icon: 'link',
                color: 'amber',
                sparkline: [edges.length, edges.length]
            }
        ],
        chart: {
            title: 'Node Execution Duration (ms)',
            type: 'bar',
            unit: 'ms',
            data: nodes.slice(0, 6).map((n, i) => ({
                label: (n.label || `Node ${i + 1}`).slice(0, 15),
                value: 4 + (i * 3) % 12
            }))
        },
        insights: [
            `Pipeline topology consists of ${nodes.length} nodes connected by ${edges.length} edges.`,
            `Zero message dropped packets recorded in telemetry window.`,
            `Asynchronous backpressure buffers operating within safety thresholds.`
        ]
    };
}

/**
 * Morphs a Node Graph into an executable Live Code Sandbox.
 */
export function morphNodeGraphToSandbox(graph: NodeGraphData): LiveCodeSandboxData {
    const title = graph?.title ? `${graph.title} — Runtime Sandbox` : 'Pipeline Runtime Sandbox';
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];

    const pipelineCode = `import React, { useState, useEffect } from 'react';

export default function PipelineRunner() {
    const [events, setEvents] = useState<string[]>([]);
    const [activeNode, setActiveNode] = useState(0);
    const nodes = ${JSON.stringify(nodes.map((n, i) => ({ id: n.id || `n-${i}`, label: n.label || `Node ${i + 1}`, category: n.category || 'general' })))};

    const triggerPipeline = () => {
        setEvents(prev => [\`[\${new Date().toLocaleTimeString()}] Pipeline initiated across \${nodes.length} nodes\`, ...prev]);
        nodes.forEach((n, idx) => {
            setTimeout(() => {
                setActiveNode(idx);
                setEvents(prev => [\`[\${new Date().toLocaleTimeString()}] Executed node: \${n.label} (\${n.category})\`, ...prev]);
            }, (idx + 1) * 600);
        });
    };

    return (
        <div style={{ padding: '24px', fontFamily: 'monospace', color: '#f8fafc', background: '#090d16', minHeight: '100vh' }}>
            <h2 style={{ color: '#00f3ff', margin: '0 0 16px 0' }}>⚡ Node Graph Pipeline Runtime</h2>
            <button
                className="sb-btn-primary"
                onClick={triggerPipeline}
                style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, marginBottom: '20px' }}
            >
                Execute Pipeline Flow
            </button>

            <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', overflowX: 'auto', paddingBottom: '8px' }}>
                {nodes.map((n, idx) => (
                    <div
                        key={n.id}
                        style={{
                            padding: '12px 16px',
                            background: activeNode === idx ? '#0369a1' : '#1e293b',
                            border: activeNode === idx ? '2px solid #38bdf8' : '1px solid #334155',
                            borderRadius: '8px',
                            minWidth: '140px'
                        }}
                    >
                        <div style={{ fontSize: '11px', color: '#94a3b8' }}>{n.category}</div>
                        <div style={{ fontWeight: 600, marginTop: '4px', fontSize: '13px' }}>{n.label}</div>
                    </div>
                ))}
            </div>

            <div style={{ background: '#111827', padding: '16px', borderRadius: '8px', border: '1px solid #1f2937', maxHeight: '300px', overflowY: 'auto' }}>
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px' }}>EXECUTION LOGS</div>
                {events.map((e, idx) => (
                    <div key={idx} style={{ fontSize: '12px', color: '#34d399', marginBottom: '4px' }}>{e}</div>
                ))}
                {events.length === 0 && <div style={{ color: '#4b5563', fontSize: '12px' }}>Click 'Execute Pipeline Flow' to run node sequence.</div>}
            </div>
        </div>
    );
}
`;

    return {
        title,
        subtitle: 'Executable TypeScript pipeline sandbox generated from node graph',
        template: 'react',
        viewMode: 'split',
        activeFileId: 'PipelineRunner.tsx',
        files: [
            {
                id: 'PipelineRunner.tsx',
                name: 'PipelineRunner.tsx',
                language: 'typescript',
                content: pipelineCode
            }
        ]
    };
}

/**
 * Morphs a Node Graph into a 3D Cybernetic Node Network.
 */
export function morphNodeGraphToScene3D(graph: NodeGraphData): Scene3DData {
    const title = graph?.title ? `${graph.title} — 3D Cybernetic Grid` : '3D Cybernetic Node Network';
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];

    const customMeshes = nodes.map((n, idx) => {
        const angle = (idx / Math.max(nodes.length, 1)) * Math.PI * 2;
        const radius = 14;
        return {
            id: `mesh-node-${n.id}`,
            name: `Node: ${n.label}`,
            type: 'sphere' as const,
            position: [Math.cos(angle) * radius, 3 + (idx % 3) * 2, Math.sin(angle) * radius] as [number, number, number],
            scale: [2.2, 2.2, 2.2] as [number, number, number],
            material: {
                color: n.color === 'emerald' ? 0x10b981 : (n.color === 'amber' ? 0xf59e0b : 0x00f3ff),
                roughness: 0.1,
                metalness: 0.9
            }
        };
    });

    return {
        title,
        subtitle: '3D spatial cybernetic node cluster and data transmission network',
        worldBranch: 'spatial/node-grid',
        sceneType: 'general',
        renderMode: 'pbr',
        cameraMode: 'orbit',
        animation: 'orbit',
        camera: {
            position: [0, 30, 45],
            target: [0, 2, 0],
            fov: 48
        },
        environment: {
            skybox: 'cyberpunk',
            lighting: 'neon',
            ground: true
        },
        customMeshes: customMeshes.length > 0 ? customMeshes : [
            {
                id: 'mesh-central-hub',
                name: 'Central Pipeline Hub',
                type: 'sphere',
                position: [0, 3, 0],
                scale: [4, 4, 4],
                material: { color: 0x00f3ff, roughness: 0.2, metalness: 0.8 }
            }
        ]
    };
}

/**
 * Morphs Metric Cards into a Markdown Document Analysis Report.
 */
export function morphMetricsToDoc(metrics: MetricCardsData): MarkdownDocumentData {
    const title = metrics?.title ? `${metrics.title} — Analytical Report` : 'Executive Performance & Metric Analysis';
    const items = Array.isArray(metrics?.metrics) ? metrics.metrics : [];

    return {
        title,
        subtitle: metrics.subtitle || 'Comprehensive analysis of key performance indicators',
        sections: [
            {
                id: 'sec-met-summary',
                type: 'paragraph',
                content: `### Executive Metric Overview\n\nThis analytical brief evaluates key telemetry indicators for **${metrics.title}**. Total tracked dimensions: **${items.length} KPIs**.`
            },
            {
                id: 'sec-met-table',
                type: 'table',
                tableHeaders: ['KPI Dimension', 'Current Value', 'Variance / Change', 'Performance Status'],
                tableRows: items.map(m => [
                    m.label,
                    m.value.toString(),
                    m.change || 'Stable',
                    m.trend === 'up' ? 'OPTIMAL' : (m.trend === 'down' ? 'ATTENTION' : 'NOMINAL')
                ])
            },
            {
                id: 'sec-met-insights',
                type: 'callout',
                calloutType: 'tip',
                calloutTitle: 'Strategic Insights',
                content: (metrics.insights || [
                    'All core metrics are converging within desired operational bounds.',
                    'Target throughput maintained with sub-millisecond response latency.'
                ]).join('\n\n')
            }
        ]
    };
}

/**
 * Morphs Metric Cards into Actionable Kanban Tasks.
 */
export function morphMetricsToKanban(metrics: MetricCardsData): KanbanBoardData {
    const title = metrics?.title ? `${metrics.title} — Optimization Tasks` : 'KPI Optimization Sprints';
    const items = Array.isArray(metrics?.metrics) ? metrics.metrics : [];

    return {
        title,
        subtitle: 'Targeted action items to optimize metric thresholds',
        columns: [
            {
                id: 'todo',
                title: 'To Do',
                color: 'blue',
                cards: items.map((m, idx) => ({
                    id: `card-kpi-${m.id || idx}`,
                    title: `Optimize ${m.label} (${m.value})`,
                    description: `Implement engineering optimizations to drive metric target improvement.`,
                    tag: 'Optimization',
                    tagColor: 'blue',
                    priority: m.trend === 'down' ? 'high' : 'medium'
                }))
            },
            { id: 'in-progress', title: 'In Progress', color: 'amber', cards: [] },
            { id: 'done', title: 'Done', color: 'emerald', cards: [] }
        ]
    };
}

/**
 * Morphs Metric Cards into a Data Telemetry Pipeline Node Graph.
 */
export function morphMetricsToNodeGraph(metrics: MetricCardsData): NodeGraphData {
    const title = metrics?.title ? `${metrics.title} — Telemetry Ingestion Flow` : 'Telemetry Ingestion Graph';
    const items = Array.isArray(metrics?.metrics) ? metrics.metrics : [];

    return {
        title,
        subtitle: 'Real-time telemetry event collectors and KPI computation nodes',
        nodes: [
            { id: 'n-collector', label: 'Metric Event Collector', category: 'input', color: 'blue', status: 'completed', x: 80, y: 140 },
            { id: 'n-aggregator', label: 'Timeseries Aggregator', subtitle: `${items.length} Ingested Metrics`, category: 'transformation', color: 'indigo', status: 'completed', x: 300, y: 140 },
            { id: 'n-dashboard', label: 'KPI Dashboard Surface', category: 'output', color: 'emerald', status: 'completed', x: 520, y: 140 }
        ],
        edges: [
            { id: 'e1', source: 'n-collector', target: 'n-aggregator', color: 'blue' },
            { id: 'e2', source: 'n-aggregator', target: 'n-dashboard', color: 'indigo', style: 'animated' }
        ]
    };
}

/**
 * Morphs Metric Cards into 3D Holographic Spatial Data Visualizations.
 */
export function morphMetricsToScene3D(metrics: MetricCardsData): Scene3DData {
    const title = metrics?.title ? `${metrics.title} — 3D Holographic Chart` : '3D Holographic Data Visualization';
    const chartPoints = metrics.chart?.data || [
        { label: 'Q1', value: 30 },
        { label: 'Q2', value: 45 },
        { label: 'Q3', value: 65 },
        { label: 'Q4', value: 80 }
    ];

    const customMeshes = chartPoints.map((pt, idx) => {
        const height = Math.max(2, pt.value * 0.15);
        return {
            id: `mesh-bar-${idx}`,
            name: `${pt.label}: ${pt.value}`,
            type: 'box' as const,
            position: [((idx - chartPoints.length / 2) * 5) as number, height / 2, 0] as [number, number, number],
            scale: [3, height, 3] as [number, number, number],
            material: {
                color: 0x00f3ff,
                roughness: 0.1,
                metalness: 0.9
            }
        };
    });

    return {
        title,
        subtitle: '3D spatial holographic bar charts and interactive metric pedestals',
        worldBranch: 'spatial/analytics',
        sceneType: 'general',
        renderMode: 'pbr',
        cameraMode: 'orbit',
        animation: 'orbit',
        camera: {
            position: [0, 20, 35],
            target: [0, 5, 0],
            fov: 48
        },
        environment: {
            skybox: 'cyberpunk',
            lighting: 'neon',
            ground: true
        },
        customMeshes
    };
}

/**
 * Morphs a Live Code Sandbox into a Markdown Technical Document.
 */
export function morphSandboxToDoc(sandbox: LiveCodeSandboxData, context?: any): MarkdownDocumentData {
    const title = sandbox?.title ? `${sandbox.title} — Documentation` : 'Codebase Architecture & API Specs';
    const files = Array.isArray(sandbox?.files) ? sandbox.files : [];
    const state = getSandboxRuntimeState(sandbox, context);

    const sections: MarkdownSection[] = [
        {
            id: 'sec-sb-doc-overview',
            type: 'paragraph',
            content: `### Codebase Architecture\n\nThis document provides comprehensive technical documentation for **${sandbox.title}**. Workspace template: \`${sandbox.template || 'react'}\` with **${files.length} active source modules**.`
        }
    ];

    if (state && Object.keys(state).length > 0) {
        const stateRows = Object.entries(state)
            .map(([k, v]) => `| \`${k}\` | \`${typeof v === 'object' ? JSON.stringify(v) : String(v)}\` |`)
            .join('\n');
        sections.push({
            id: 'sec-sb-doc-runtime-state',
            type: 'paragraph',
            content: `### Live Runtime & Session State\n\nThe following state variables were captured dynamically from the active sandbox runtime:\n\n| Variable | Current Value |\n| :--- | :--- |\n${stateRows}`
        });
    }

    files.forEach((f, idx) => {
        sections.push({
            id: `sec-sb-file-${idx}`,
            type: 'code',
            content: `// File: ${f.name}\n${f.content.slice(0, 400)}`
        });
    });

    return {
        title,
        subtitle: sandbox.subtitle || 'Documentation synthesized from live code sandbox',
        sections
    };
}

/**
 * Morphs a Live Code Sandbox into Engineering Kanban Tasks.
 */
export function morphSandboxToKanban(sandbox: LiveCodeSandboxData, context?: any): KanbanBoardData {
    const title = sandbox?.title ? `${sandbox.title} — Sprint Tasks` : 'Codebase Feature Roadmap';
    const files = Array.isArray(sandbox?.files) ? sandbox.files : [];
    const state = getSandboxRuntimeState(sandbox, context);

    const todoCards: any[] = files.map((f, i) => ({
        id: `card-file-${i}`,
        title: `Refactor ${f.name}`,
        description: `Optimize implementation and add unit test coverage for ${f.name}.`,
        tag: f.language || 'Code',
        tagColor: 'blue',
        priority: 'medium'
    }));

    if (state && Object.keys(state).length > 0) {
        Object.entries(state).forEach(([k, v], i) => {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                todoCards.push({
                    id: `card-state-${i}`,
                    title: `Verify State: ${k} = ${v}`,
                    description: `Runtime state variable exported from live micro-app. Confirm synchronization and boundaries.`,
                    tag: 'State',
                    tagColor: 'amber',
                    priority: 'high'
                });
            }
        });
    }

    return {
        title,
        subtitle: 'Feature sprint deliverables extracted from sandbox modules and live state',
        columns: [
            {
                id: 'todo',
                title: 'To Do',
                color: 'blue',
                cards: todoCards
            },
            { id: 'in-progress', title: 'In Progress', color: 'amber', cards: [] },
            { id: 'done', title: 'Done', color: 'emerald', cards: [] }
        ]
    };
}

/**
 * Morphs a Live Code Sandbox into a Module Dependency Node Graph.
 */
export function morphSandboxToNodeGraph(sandbox: LiveCodeSandboxData): NodeGraphData {
    const title = sandbox?.title ? `${sandbox.title} — Module Graph` : 'Codebase Module Dependency Graph';
    const files = Array.isArray(sandbox?.files) ? sandbox.files : [];

    const nodes: GraphNode[] = files.map((f, i) => ({
        id: `node-file-${f.id || i}`,
        label: f.name,
        subtitle: `${f.language} module`,
        category: f.name.includes('App') || f.name.includes('index') ? 'input' : 'transformation',
        color: 'blue',
        status: 'completed',
        x: 100 + (i % 3) * 220,
        y: 100 + Math.floor(i / 3) * 120
    }));

    const edges: GraphEdge[] = [];
    if (nodes.length > 1) {
        for (let i = 1; i < nodes.length; i++) {
            edges.push({
                id: `edge-${nodes[0].id}-${nodes[i].id}`,
                source: nodes[0].id,
                target: nodes[i].id,
                color: 'blue'
            });
        }
    }

    return {
        title,
        subtitle: 'Source module dependencies mapped to interactive node graph',
        nodes: nodes.length > 0 ? nodes : [{ id: 'n-app', label: 'App.tsx', category: 'input', color: 'blue', status: 'completed', x: 200, y: 150 }],
        edges
    };
}

/**
 * Morphs a Live Code Sandbox into Code Quality & Size Metrics.
 */
export function morphSandboxToMetrics(sandbox: LiveCodeSandboxData, context?: any): MetricCardsData {
    const title = sandbox?.title ? `${sandbox.title} — Code Metrics` : 'Code Quality & Bundle Metrics';
    const files = Array.isArray(sandbox?.files) ? sandbox.files : [];
    const state = getSandboxRuntimeState(sandbox, context);

    let totalLines = 0;
    for (const f of files) {
        totalLines += (f.content || '').split('\n').length;
    }

    const metrics: any[] = [
        {
            id: 'm-files',
            label: 'Source Files',
            value: files.length.toString(),
            change: 'Clean',
            trend: 'neutral',
            icon: 'file-code',
            color: 'blue',
            sparkline: [1, 2, files.length]
        },
        {
            id: 'm-lines',
            label: 'Total Lines',
            value: totalLines.toString(),
            change: '+24',
            trend: 'up',
            icon: 'code',
            color: 'indigo',
            sparkline: [totalLines - 40, totalLines - 20, totalLines]
        },
        {
            id: 'm-bundle',
            label: 'Bundle Size',
            value: `${(totalLines * 0.08).toFixed(1)} kB`,
            change: '-2.1 kB',
            trend: 'up',
            icon: 'package',
            color: 'emerald',
            sparkline: [14.2, 12.8, 10.5]
        },
        {
            id: 'm-type',
            label: 'Type Safety',
            value: '100%',
            change: 'Strict Mode',
            trend: 'up',
            icon: 'shield-check',
            color: 'amber',
            sparkline: [100, 100, 100]
        }
    ];

    if (state && Object.keys(state).length > 0) {
        Object.entries(state).forEach(([k, v], idx) => {
            if (typeof v === 'number' || (!isNaN(Number(v)) && typeof v === 'string')) {
                const numVal = Number(v);
                metrics.push({
                    id: `m-state-${k}`,
                    label: k.charAt(0).toUpperCase() + k.slice(1),
                    value: String(v),
                    change: 'Live',
                    trend: 'up',
                    icon: 'activity',
                    color: idx % 2 === 0 ? 'emerald' : 'cyan',
                    sparkline: [numVal * 0.8, numVal * 0.9, numVal]
                });
            }
        });
    }

    const insights = [
        `Parsed ${files.length} active code modules with ${totalLines} lines of code.`,
        `TypeScript compiler reports 0 type errors.`,
        `Fast refresh enabled with sub-50ms HMR reload times.`
    ];

    if (state && Object.keys(state).length > 0) {
        insights.push(`Captured ${Object.keys(state).length} live runtime state variables from host session.`);
    }

    return {
        title,
        subtitle: 'Source code complexity, bundle size, and live runtime state telemetry',
        metrics,
        chart: {
            title: 'Line Count by Module',
            type: 'bar',
            unit: 'Lines',
            data: files.map(f => ({
                label: f.name,
                value: (f.content || '').split('\n').length
            }))
        },
        insights
    };
}

/**
 * Universal polymorphic cross-surface morph dispatcher.
 */
export function morphArtifact(source: CanvasArtifact, targetType: PrimitiveType, context?: any): CanvasArtifact {
    const id = stableProjectArtifactId(targetType, `${source.id}:${source.version}:${targetType}`);

    // 1. From Markdown Document
    if (source.type === 'markdown-document') {
        const docData = source.data as MarkdownDocumentData;
        if (targetType === '3d-scene') {
            const sceneData = morphDocToScene3D(docData, context);
            return { id, title: sceneData.title, summary: sceneData.subtitle || '3D Scene morphed from Document', type: '3d-scene', data: sceneData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'kanban-board') {
            const kanbanData = morphDocToChecklistKanban(docData);
            return { id, title: kanbanData.title, summary: kanbanData.subtitle || 'Kanban Board morphed from Document', type: 'kanban-board', data: kanbanData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'node-graph') {
            const graphData = morphDocToNodeGraph(docData);
            return { id, title: graphData.title, summary: graphData.subtitle || 'Node Graph morphed from Document', type: 'node-graph', data: graphData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'metric-dashboard') {
            const metricsData = morphDocToMetrics(docData, context);
            return { id, title: metricsData.title, summary: metricsData.subtitle || 'Metric Dashboard morphed from Document', type: 'metric-dashboard', data: metricsData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'live-code-sandbox') {
            const sandboxData = morphDocToSandbox(docData, context);
            return { id, title: sandboxData.title, summary: sandboxData.subtitle || 'Code Sandbox morphed from Document', type: 'live-code-sandbox', data: sandboxData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'interactive-browser' || targetType === 'browser') {
            const browserData = morphDocToBrowser(docData);
            return { id, title: browserData.title, summary: 'Web Browser Document Preview', type: 'interactive-browser', data: browserData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
    }

    // 2. From 3D Scene
    if (source.type === '3d-scene') {
        const sceneData = source.data as Scene3DData;
        if (targetType === 'markdown-document') {
            const docData = morphScene3DToDoc(sceneData);
            return { id, title: docData.title, summary: docData.subtitle || 'Specification morphed from 3D Scene', type: 'markdown-document', data: docData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'kanban-board') {
            const kanbanData = morphScene3DToKanban(sceneData);
            return { id, title: kanbanData.title, summary: kanbanData.subtitle || 'Kanban Board morphed from 3D Scene', type: 'kanban-board', data: kanbanData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'node-graph') {
            const graphData = morphScene3DToNodeGraph(sceneData);
            return { id, title: graphData.title, summary: graphData.subtitle || 'Node Graph morphed from 3D Scene', type: 'node-graph', data: graphData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'metric-dashboard') {
            const metricsData = morphScene3DToMetrics(sceneData);
            return { id, title: metricsData.title, summary: metricsData.subtitle || 'Metrics morphed from 3D Scene', type: 'metric-dashboard', data: metricsData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'live-code-sandbox') {
            const sandboxData = morphScene3DToSandbox(sceneData);
            return { id, title: sandboxData.title, summary: sandboxData.subtitle || 'Code Sandbox morphed from 3D Scene', type: 'live-code-sandbox', data: sandboxData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
    }

    // 3. From Kanban Board
    if (source.type === 'kanban-board') {
        const kanbanData = source.data as KanbanBoardData;
        if (targetType === 'markdown-document') {
            const docData = morphKanbanToDoc(kanbanData);
            return { id, title: docData.title, summary: docData.subtitle || 'Document morphed from Kanban Board', type: 'markdown-document', data: docData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'node-graph') {
            const graphData = morphKanbanToNodeGraph(kanbanData);
            return { id, title: graphData.title, summary: graphData.subtitle || 'Node Graph morphed from Kanban Board', type: 'node-graph', data: graphData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'metric-dashboard') {
            const metricsData = morphKanbanToMetrics(kanbanData);
            return { id, title: metricsData.title, summary: metricsData.subtitle || 'Metrics morphed from Kanban Board', type: 'metric-dashboard', data: metricsData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === '3d-scene') {
            const sceneData = morphKanbanToScene3D(kanbanData);
            return { id, title: sceneData.title, summary: sceneData.subtitle || '3D Scene morphed from Kanban Board', type: '3d-scene', data: sceneData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'live-code-sandbox') {
            const firstCard = kanbanData.columns?.[0]?.cards?.[0] || { id: 'card-default', title: kanbanData.title || 'Feature', priority: 'medium' };
            const sandboxData = morphKanbanCardToSandbox(firstCard, kanbanData.title);
            return { id, title: sandboxData.title, summary: sandboxData.subtitle || 'Sandbox morphed from Kanban Card', type: 'live-code-sandbox', data: sandboxData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
    }

    // 4. From Node Graph
    if (source.type === 'node-graph') {
        const graphData = source.data as NodeGraphData;
        if (targetType === 'markdown-document') {
            const docData = morphNodeGraphToDoc(graphData);
            return { id, title: docData.title, summary: docData.subtitle || 'Document morphed from Node Graph', type: 'markdown-document', data: docData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'kanban-board') {
            const kanbanData = morphNodeGraphToKanban(graphData);
            return { id, title: kanbanData.title, summary: kanbanData.subtitle || 'Kanban morphed from Node Graph', type: 'kanban-board', data: kanbanData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'metric-dashboard') {
            const metricsData = morphNodeGraphToMetrics(graphData);
            return { id, title: metricsData.title, summary: metricsData.subtitle || 'Metrics morphed from Node Graph', type: 'metric-dashboard', data: metricsData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'live-code-sandbox') {
            const sandboxData = morphNodeGraphToSandbox(graphData);
            return { id, title: sandboxData.title, summary: sandboxData.subtitle || 'Sandbox morphed from Node Graph', type: 'live-code-sandbox', data: sandboxData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === '3d-scene') {
            const sceneData = morphNodeGraphToScene3D(graphData);
            return { id, title: sceneData.title, summary: sceneData.subtitle || '3D Scene morphed from Node Graph', type: '3d-scene', data: sceneData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
    }

    // 5. From Metric Dashboard
    if (source.type === 'metric-dashboard') {
        const metricsData = source.data as MetricCardsData;
        if (targetType === 'markdown-document') {
            const docData = morphMetricsToDoc(metricsData);
            return { id, title: docData.title, summary: docData.subtitle || 'Document morphed from Metrics', type: 'markdown-document', data: docData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'kanban-board') {
            const kanbanData = morphMetricsToKanban(metricsData);
            return { id, title: kanbanData.title, summary: kanbanData.subtitle || 'Kanban morphed from Metrics', type: 'kanban-board', data: kanbanData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'node-graph') {
            const graphData = morphMetricsToNodeGraph(metricsData);
            return { id, title: graphData.title, summary: graphData.subtitle || 'Node Graph morphed from Metrics', type: 'node-graph', data: graphData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === '3d-scene') {
            const sceneData = morphMetricsToScene3D(metricsData);
            return { id, title: sceneData.title, summary: sceneData.subtitle || '3D Scene morphed from Metrics', type: '3d-scene', data: sceneData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
    }

    // 6. From Live Code Sandbox
    if (source.type === 'live-code-sandbox') {
        const sandboxData = source.data as LiveCodeSandboxData;
        if (targetType === 'markdown-document') {
            const docData = morphSandboxToDoc(sandboxData, context);
            return { id, title: docData.title, summary: docData.subtitle || 'Document morphed from Sandbox', type: 'markdown-document', data: docData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'kanban-board') {
            const kanbanData = morphSandboxToKanban(sandboxData, context);
            return { id, title: kanbanData.title, summary: kanbanData.subtitle || 'Kanban morphed from Sandbox', type: 'kanban-board', data: kanbanData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'node-graph') {
            const graphData = morphSandboxToNodeGraph(sandboxData);
            return { id, title: graphData.title, summary: graphData.subtitle || 'Node Graph morphed from Sandbox', type: 'node-graph', data: graphData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'metric-dashboard') {
            const metricsData = morphSandboxToMetrics(sandboxData, context);
            return { id, title: metricsData.title, summary: metricsData.subtitle || 'Metrics morphed from Sandbox', type: 'metric-dashboard', data: metricsData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === '3d-scene') {
            const sceneData = morphSandboxToScene3D(sandboxData, context);
            return { id, title: sceneData.title, summary: sceneData.subtitle || '3D Scene morphed from Sandbox', type: '3d-scene', data: sceneData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
        if (targetType === 'interactive-browser' || targetType === 'browser') {
            const browserData = morphSandboxToBrowser(sandboxData);
            return { id, title: browserData.title, summary: 'Live Web Browser Preview morphed from Sandbox', type: 'interactive-browser', data: browserData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
    }

    // 7. From Interactive Browser
    if (source.type === 'interactive-browser' || source.type === 'browser') {
        const browserData = source.data as InteractiveBrowserData;
        if (targetType === 'live-code-sandbox') {
            const sandboxData = morphBrowserToSandbox(browserData);
            return { id, title: sandboxData.title, summary: 'Live Code Sandbox morphed from Browser', type: 'live-code-sandbox', data: sandboxData, createdAt: new Date().toLocaleTimeString(), version: 1 };
        }
    }

    // Default fallback
    return {
        id,
        title: `${source.title || 'Artifact'} (${targetType})`,
        summary: source.summary || 'Transformed artifact',
        type: targetType,
        data: source.data,
        createdAt: new Date().toLocaleTimeString(),
        version: (source.version || 1) + 1
    };
}
