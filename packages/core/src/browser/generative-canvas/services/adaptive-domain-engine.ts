/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { DEFAULT_SCENE_RENDER_MODE } from '../../../common/scene-atmosphere-opt-in';
import type {
    KanbanBoardData,
    KanbanColumn,
    KanbanCard,
    MetricCardsData,
    MetricItem,
    NodeGraphData,
    GraphNode,
    GraphEdge,
    LiveCodeSandboxData,
    Scene3DData,
    AccentColor
} from '../canvas-types';
import type {
    VideoTimelineData,
    TimelineTrack
} from './video/videoTypes';

export type DomainCategory = string;

/**
 * Semantic Domain Identifier.
 * In Antigravity style, this is a lightweight semantic classifier rather than a rigid gating taxonomy.
 * Returns the semantic domain token or extracted subject, defaulting to 'general' for unspecific text.
 */
export function classifyDomain(text: string, context?: string): DomainCategory {
    const combined = `${text || ''} ${context || ''}`.toLowerCase();
    if (!combined.trim()) {
        return 'general';
    }

    // High-confidence semantic signifiers for common fields
    if (/\b(?:astronomy|astrophysics|celestial|planet|planetary|solar|orbit|orbital|kepler|keplerian|gravity|gravitational|satellite|galaxy|galaxies|star|stars|nebula|telescope|james\s*webb|jwst|hubble|redshift|cosmic|singularity|black\s*hole|parsec|astronomical|nasa|esa|spacecraft|propulsion|interstellar|exoplanet|supernova|quasar|pulsar|apollo|shuttle|rocket|perigee|apogee|trajectory)\b/i.test(combined)) {
        return 'astrophysics';
    }
    if (/\b(?:biology|genetics|genomic|genomics|dna|rna|mrna|crispr|cas9|nucleotide|base\s*pair|amino\s*acid|protein|proteomics|enzyme|ribosome|homology|alphafold|plddt|wet\s*lab|assay|sequencing|fasta|fastq|blast|mutation|transcriptome|transcriptomics|cellular|mitochondria|polymerase|ligase|plasmid|cloning|western\s*blot|in\s*vitro|in\s*vivo|in\s*silico|cryo-em|crystallography)\b/i.test(combined)) {
        return 'biology';
    }
    if (/\b(?:healthcare|medical|clinical|patient|patients|hospital|clinic|therapy|therapeutic|diagnosis|diagnostic|pathology|oncology|cardiology|pharmacology|pharmacokinetic|pharmacodynamics|drug|dosage|dose|pharma|pharmaceutical|biomarker|fda|cohort|double-blind|placebo|adverse\s*event|efficacy|remission|vaccine|immunology|surgery|surgical|physician|arrhythmia|icu|vital\s*signs|patient\s*telemetry)\b/i.test(combined)) {
        return 'healthcare';
    }
    if (/\b(?:game|gameplay|gamedev|unreal|unity|godot|ragdoll|shader|shaders|rigging|skeletal|collider|hitbox|rigid\s*body|xpbd|pbr|mesh|polygon|polycount|draw\s*call|framerate|fps|level\s*design|inventory|npc|ai\s*navmesh|raymarching|voxel|procedural\s*generation|arcade|mechanics|collision)\b/i.test(combined)) {
        return 'game-dev';
    }
    if (/\b(?:film|cinema|cinematic|cinematography|movie|screenplay|storyboard|a-roll|b-roll|dailies|color\s*grading|lut|davinci|resolve|premiere|final\s*cut|sound\s*design|foley|dialogue|audio\s*stem|composer|orchestra|photography|shutter|aperture|bokeh|music|synth|synthesizer|track|album|exhibition|gallery|symphonic)\b/i.test(combined)) {
        return 'creative-arts';
    }
    if (/\b(?:software|compiler|runtime|kernel|driver|operating\s*system|posix|linux|c\+\+|rust|golang|typescript|javascript|python|database|postgres|sql|nosql|redis|kafka|microservices|distributed|consensus|raft|paxos|sharding|ring\s*buffer|zero-copy|simd|sse|avx|mcp|grpc|rest\s*api|docker|kubernetes|cloud|serverless|latency|throughput)\b/i.test(combined)) {
        return 'technology';
    }
    if (/\b(?:business|finance|financial|saas|arr|mrr|ebitda|gross\s*margin|revenue|valuation|roi|ltv|cac|payback|cash\s*flow|burn\s*rate|runway|investor|venture\s*capital|seed\s*round|series\s*a|balance\s*sheet|p&l|pricing|monetization|stakeholder|procurement|tam|sam|som|market\s*share|quarterly)\b/i.test(combined)) {
        return 'business';
    }
    if (/\b(?:history|historical|historian|archaeology|archaeological|artifact|antiquity|ancient|century|dynasty|empire|roman|greek|medieval|renaissance|revolution|revolutionary|1776|lexington|concord|battle|battlefield|treaty|monarchy|republic|excavation|radiocarbon|stratigraphy|paleography|epigraphy|inscription|manuscript|parchment|codex|monograph|provenance|punic)\b/i.test(combined)) {
        return 'history';
    }

    // Ambiguous note or memo
    if (/^(a\s+)?(simple\s+)?(note|memo|scratchpad|test|demo|misc|miscellaneous)(\s+about.*)?$/i.test(combined.trim())) {
        return 'general';
    }

    return 'general';
}

/**
 * Lightweight entity and action extractor from user prompt.
 * Enables zero-preset, open-ended generation for infinite human disciplines.
 */
export function extractPromptEntities(prompt: string, fallbackSubject: string = 'System Execution'): {
    subject: string;
    action: string;
    keywords: string[];
} {
    let clean = prompt.trim();

    // 1. Remove meta-tags such as [Clarification Selection]: and [Execution Plan Approved]:
    clean = clean.replace(/^\[(?:Clarification\s+Selection|Execution\s+Plan[^\]]*)\]:?\s*/i, '');

    // 2. Remove question prompts before colon, e.g. "Which 3D representation: Photorealistic Google 3D Tiles"
    clean = clean.replace(/^(?:Which|What|How|Choose|Select)[^:]*:\s*/i, '');

    // 3. Remove execution confirmation prefixes like "Proceed with Tier 1 ... for "
    clean = clean.replace(/^Proceed(?:\s+with[^\n:]*?)?\s+for\s+/i, '');

    // 4. Remove command verbs, question intros, determiners and structural keywords from the start cleanly
    const leadingPrefixRegex = /^(?:(?:\/|\b)(?:explain|tell\s+me\s+about|describe|analyze|investigate|discuss|explore|compare|clarify|elaborate\s+on|what\s+is|what\s+are|what\s+were|how\s+does|how\s+do|how\s+is|how\s+are|why\s+is|why\s+are|why\s+did|why\s+does|can\s+you\s+explain|principles\s+of|mechanics\s+of|fundamentals\s+of|create|generate|build|make|draft|design|synthesize|plan|model|simulate|track|show|render|code|develop|assemble|an?|the|new|3d|2d|kanban|metrics|graph|dashboard|timeline|scene|sandbox|board|for|about|of|on|to|with)\b[\s:,-]*)+/i;
    clean = clean.replace(leadingPrefixRegex, '').replace(/[?.!]+$/, '').trim();

    // 5. Clean trailing comparative questions or punctuation
    clean = clean.replace(/\bdiffer\s+from\b/i, '&').replace(/\bversus\b/i, 'vs.').replace(/[?.!]+$/, '').trim();

    const stopWords = new Set(['and', 'the', 'for', 'with', 'about', 'from', 'into', 'your', 'this', 'that', 'an', 'a', 'of', 'in', 'on', 'to', 'by', 'as', 'is', 'are', 'was', 'were', 'how', 'what', 'why', 'where', 'when', 'who', 'does', 'do', 'did', 'can', 'could', 'would', 'should']);
    const words = clean.split(/\s+/).filter(w => !stopWords.has(w.toLowerCase()) && w.length > 1);

    const subject = clean.length > 2
        ? clean.split(' ').map((w, idx) => (idx === 0 || !stopWords.has(w.toLowerCase())) ? (w.charAt(0).toUpperCase() + w.slice(1)) : w.toLowerCase()).join(' ')
        : fallbackSubject;
    const action = words.find(w => /ing$|tion$|ment$|ance$/i.test(w)) || (words[1] || 'Processing');

    return {
        subject,
        action,
        keywords: words.slice(0, 6)
    };
}

// ============================================================================
// 1. Zero-Preset Adaptive Kanban Board Synthesis
// ============================================================================

export function synthesizeAdaptiveKanban(
    domainOrTopic: DomainCategory | string,
    title?: string,
    prompt?: string
): KanbanBoardData {
    const rawText = prompt || title || domainOrTopic || 'Strategic Roadmap';
    const { subject, action, keywords } = extractPromptEntities(rawText, 'Operational Roadmap');
    const boardTitle = title || `${subject} - Operational Roadmap`;

    const kw1 = keywords[0] || 'Specification';
    const kw2 = keywords[1] || 'Core Pipeline';
    const kw3 = keywords[2] || 'Verification';
    const kw4 = keywords[3] || 'Deployment';

    const columns: KanbanColumn[] = [
        {
            id: 'col-planning',
            title: `${kw1} & Planning`,
            color: 'blue',
            cards: [
                {
                    id: 'card-plan-1',
                    title: `Define ${kw1} Baseline & Constraints`,
                    description: `Formulate architectural requirements, domain parameters, and operational bounds for ${subject}.`,
                    tag: kw1,
                    tagColor: 'blue',
                    priority: 'high',
                    completedSubtasks: 3,
                    totalSubtasks: 4
                },
                {
                    id: 'card-plan-2',
                    title: `Ingestion & Schema Standardization`,
                    description: `Establish data contracts and ingestion pipelines tailored to ${subject}.`,
                    tag: 'Architecture',
                    tagColor: 'purple',
                    priority: 'medium'
                }
            ]
        },
        {
            id: 'col-execution',
            title: `${kw2} & ${action}`,
            color: 'amber',
            cards: [
                {
                    id: 'card-exec-1',
                    title: `Implement ${kw2} Core Engine`,
                    description: `Execute primary computation, modeling, and state transitions for ${subject}.`,
                    tag: kw2,
                    tagColor: 'amber',
                    priority: 'urgent',
                    completedSubtasks: 2,
                    totalSubtasks: 5
                },
                {
                    id: 'card-exec-2',
                    title: `${kw3} Integration & Optimization`,
                    description: `Harmonize sub-pipelines and tune performance parameters.`,
                    tag: 'Optimization',
                    tagColor: 'rose',
                    priority: 'high'
                }
            ]
        },
        {
            id: 'col-validation',
            title: `${kw3} & Quality Assurance`,
            color: 'indigo',
            cards: [
                {
                    id: 'card-val-1',
                    title: `Run Empirical Benchmarks & Test Suite`,
                    description: `Validate operational accuracy, fidelity, and adherence to ${subject} standards.`,
                    tag: 'Validation',
                    tagColor: 'indigo',
                    priority: 'high',
                    completedSubtasks: 4,
                    totalSubtasks: 4
                }
            ]
        },
        {
            id: 'col-delivery',
            title: `${kw4} & Rollout`,
            color: 'emerald',
            cards: [
                {
                    id: 'card-del-1',
                    title: `Deploy ${subject} to Production Stage`,
                    description: `Final sign-off, artifact serialization, and active lifecycle monitoring.`,
                    tag: 'Production',
                    tagColor: 'emerald',
                    priority: 'low',
                    completedSubtasks: 2,
                    totalSubtasks: 2
                }
            ]
        }
    ];

    return {
        title: boardTitle,
        subtitle: `Schema-guided operational architecture tailored for ${subject}`,
        columns
    };
}

// ============================================================================
// 2. Zero-Preset Adaptive Metric Cards Synthesis
// ============================================================================

export function synthesizeAdaptiveMetrics(
    domainOrTopic: DomainCategory | string,
    title?: string,
    prompt?: string
): MetricCardsData {
    const rawText = prompt || title || domainOrTopic || 'System Telemetry';
    const { subject, keywords } = extractPromptEntities(rawText, 'System Telemetry');
    const metricTitle = title || `${subject} - Telemetry & KPIs`;

    const kw1 = keywords[0] || 'Throughput';
    const kw2 = keywords[1] || 'Fidelity';
    const kw3 = keywords[2] || 'Efficiency';
    const kw4 = keywords[3] || 'Coverage';

    // Universal schema-guided open-ended metrics synthesized from prompt entities & keywords
    const metrics: MetricItem[] = [
        { id: 'met-1', label: `${kw1} Efficacy & Alignment`, value: '94.6%', change: '+3.8%', trend: 'up', icon: 'activity', color: 'emerald', sparkline: [82, 85, 88, 91, 93, 94.6] },
        { id: 'met-2', label: `${kw2} Yield & Quality`, value: '88.2%', change: '+2.1%', trend: 'up', icon: 'shield-check', color: 'blue', sparkline: [76, 79, 82, 85, 87, 88.2] },
        { id: 'met-3', label: `${kw3} Throughput`, value: '142 ops/s', change: '+18%', trend: 'up', icon: 'zap', color: 'indigo', sparkline: [105, 114, 122, 130, 138, 142] },
        { id: 'met-4', label: `${kw4} System Reliability`, value: '99.2%', change: '+0.4%', trend: 'up', icon: 'check-circle', color: 'cyan', sparkline: [97, 97.5, 98, 98.6, 99, 99.2] }
    ];

    return {
        title: metricTitle,
        subtitle: `Precision telemetry model aligned with ${subject}`,
        metrics,
        chart: {
            type: 'bar',
            title: `${subject} - Phase Distribution & Cadence`,
            data: [
                { label: kw1.slice(0, 14), value: 78 },
                { label: kw2.slice(0, 14), value: 92 },
                { label: kw3.slice(0, 14), value: 85 },
                { label: kw4.slice(0, 14), value: 96 }
            ]
        },
        insights: [
            `Empirical validation active across all ${subject} operational phases.`,
            `Telemetry tracking confirms high adherence to domain-specific quality thresholds.`
        ]
    };
}

// ============================================================================
// 3. Zero-Preset Adaptive Node Graph Synthesis
// ============================================================================

export function synthesizeAdaptiveNodeGraph(
    domainOrTopic: DomainCategory | string,
    title?: string,
    prompt?: string
): NodeGraphData {
    const rawText = prompt || title || domainOrTopic || 'Architecture Pipeline';
    const { subject, action, keywords } = extractPromptEntities(rawText, 'Architecture Pipeline');
    const graphTitle = title || `${subject} - Execution DAG`;

    const kw1 = keywords[0] || 'Ingestion';
    const kw2 = keywords[1] || 'Processing';
    const kw3 = keywords[2] || 'Optimization';
    const kw4 = keywords[3] || 'Evaluation';

    const nodes: GraphNode[] = [
        {
            id: 'node-1',
            label: `${kw1} Stream Source`,
            subtitle: `Raw telemetry & parameter ingest`,
            category: 'input',
            x: 100,
            y: 200,
            status: 'running'
        },
        {
            id: 'node-2',
            label: `${kw2} Transformation`,
            subtitle: `${action} & structural solver`,
            category: 'process',
            x: 340,
            y: 160,
            status: 'pending'
        },
        {
            id: 'node-3',
            label: `${kw3} Engine`,
            subtitle: `High-precision numerical tuning`,
            category: 'process',
            x: 580,
            y: 220,
            status: 'pending'
        },
        {
            id: 'node-4',
            label: `${kw4} Quality Gate`,
            subtitle: `Automated convergence testing`,
            category: 'decision',
            x: 820,
            y: 180,
            status: 'pending'
        },
        {
            id: 'node-5',
            label: `${subject} Output Stage`,
            subtitle: `Target artifact delivery & rendering`,
            category: 'output',
            x: 1060,
            y: 200,
            status: 'pending'
        }
    ];

    const edges: GraphEdge[] = [
        { id: 'edge-1-2', source: 'node-1', target: 'node-2', label: 'Raw Feed' },
        { id: 'edge-2-3', source: 'node-2', target: 'node-3', label: 'Transformed Stream' },
        { id: 'edge-3-4', source: 'node-3', target: 'node-4', label: 'Tuned Metrics' },
        { id: 'edge-4-5', source: 'node-4', target: 'node-5', label: 'Validated Contract' }
    ];

    return {
        title: graphTitle,
        subtitle: `Interactive execution graph for ${subject}`,
        nodes,
        edges
    };
}

// ============================================================================
// 4. Zero-Preset Adaptive Live Code Sandbox Synthesis
// ============================================================================

export function synthesizeAdaptiveSandbox(
    domainOrTopic: DomainCategory | string,
    title?: string,
    prompt?: string
): LiveCodeSandboxData {
    const rawText = prompt || title || domainOrTopic || 'Interactive Simulation';
    const { subject, keywords } = extractPromptEntities(rawText, 'Interactive Simulation');
    const sandboxTitle = title || `${subject} Simulation`;

    const code = `import React, { useState, useEffect, useRef } from 'react';

export default function ${subject.replace(/[^a-zA-Z0-9]/g, '') || 'Simulation'}App() {
    const [intensity, setIntensity] = useState(75);
    const [running, setRunning] = useState(true);
    const [elapsed, setElapsed] = useState(0);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        if (!running) return;
        const interval = setInterval(() => {
            setElapsed(e => e + 1);
        }, 100);
        return () => clearInterval(interval);
    }, [running]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let frameId: number;
        const render = () => {
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const cx = canvas.width / 2;
            const cy = canvas.height / 2;
            const t = Date.now() * 0.002 * (intensity / 50);

            // Dynamic interactive wave / trajectory rendering
            ctx.beginPath();
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 3;
            for (let x = 0; x < canvas.width; x += 4) {
                const y = cy + Math.sin(x * 0.02 + t) * (intensity * 0.4) * Math.cos(t * 0.5);
                if (x === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();

            // Accent particles
            for (let i = 0; i < 5; i++) {
                const px = cx + Math.cos(t + (i * Math.PI * 2) / 5) * (intensity * 0.8);
                const py = cy + Math.sin(t + (i * Math.PI * 2) / 5) * (intensity * 0.8);
                ctx.beginPath();
                ctx.arc(px, py, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#10b981';
                ctx.fill();
            }

            frameId = requestAnimationFrame(render);
        };

        render();
        return () => cancelAnimationFrame(frameId);
    }, [intensity]);

    return (
        <div style={{ padding: '24px', fontFamily: 'system-ui, sans-serif', color: '#f8fafc', background: '#090d16', minHeight: '100vh' }}>
            <header style={{ borderBottom: '1px solid #1e293b', paddingBottom: '16px', marginBottom: '20px' }}>
                <h1 style={{ fontSize: '22px', margin: '0 0 6px 0', color: '#38bdf8' }}>${sandboxTitle}</h1>
                <p style={{ margin: 0, color: '#94a3b8', fontSize: '13px' }}>Dynamic simulation prototype for ${subject}</p>
            </header>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: '20px' }}>
                <div style={{ background: '#0f172a', borderRadius: '10px', padding: '16px', border: '1px solid #1e293b' }}>
                    <canvas ref={canvasRef} width={500} height={320} style={{ width: '100%', height: '320px', borderRadius: '6px', background: '#020617' }} />
                </div>

                <div style={{ background: '#0f172a', borderRadius: '10px', padding: '16px', border: '1px solid #1e293b' }}>
                    <h3 style={{ fontSize: '14px', textTransform: 'uppercase', color: '#64748b', margin: '0 0 16px 0' }}>Controls</h3>
                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ display: 'block', fontSize: '12px', color: '#cbd5e1', marginBottom: '6px' }}>Simulation Intensity: {intensity}%</label>
                        <input type="range" min="10" max="150" value={intensity} onChange={e => setIntensity(Number(e.target.value))} style={{ width: '100%' }} />
                    </div>
                    <button onClick={() => setRunning(r => !r)} style={{ width: '100%', padding: '10px', background: running ? '#ef4444' : '#10b981', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                        {running ? 'Pause Engine' : 'Resume Engine'}
                    </button>
                    <div style={{ marginTop: '16px', padding: '12px', background: '#1e293b', borderRadius: '6px', fontSize: '12px', color: '#94a3b8' }}>
                        Active Keywords: ${keywords.slice(0, 4).join(', ')}
                    </div>
                </div>
            </div>
        </div>
    );
}`;

    return {
        template: 'react',
        title: sandboxTitle,
        activeFileId: 'file-app',
        files: [
            {
                id: 'file-app',
                name: 'App.tsx',
                language: 'react',
                content: code,
                isEntry: true
            }
        ]
    };
}

// ============================================================================
// 5. Zero-Preset Adaptive Video NLE Timeline Synthesis
// ============================================================================

export function synthesizeAdaptiveVideoTimeline(
    domainOrTopic: DomainCategory | string,
    title?: string,
    prompt?: string
): VideoTimelineData {
    const rawText = prompt || title || domainOrTopic || 'Timeline Sequence';
    const { subject, keywords } = extractPromptEntities(rawText, 'Timeline Sequence');
    const timelineTitle = title || `${subject} - NLE Sequence`;

    const kw1 = keywords[0] || 'Establishing';
    const kw2 = keywords[1] || 'Core Subject';

    const tracks: TimelineTrack[] = [
        {
            id: 'track-v2',
            name: 'V2 Lower Thirds & HUD',
            type: 'video',
            color: '#8b5cf6',
            muted: false,
            locked: false,
            visible: true,
            elements: [
                {
                    id: 'el-v2-1',
                    name: `${kw1} Telemetry HUD`,
                    type: 'video',
                    startTime: 0.5,
                    duration: 4.5,
                    trimStart: 0,
                    trimEnd: 0,
                    color: '#7c3aed'
                },
                {
                    id: 'el-v2-2',
                    name: `${kw2} Annotation`,
                    type: 'video',
                    startTime: 6.0,
                    duration: 5.0,
                    trimStart: 0,
                    trimEnd: 0,
                    color: '#6d28d9'
                }
            ]
        },
        {
            id: 'track-v1',
            name: 'V1 Primary Video',
            type: 'video',
            color: '#3b82f6',
            muted: false,
            locked: false,
            visible: true,
            elements: [
                {
                    id: 'el-v1-1',
                    name: `${kw1} Sequence`,
                    type: 'video',
                    startTime: 0.0,
                    duration: 6.0,
                    trimStart: 0,
                    trimEnd: 0,
                    color: '#2563eb'
                },
                {
                    id: 'el-v1-2',
                    name: `${kw2} Deep Dive`,
                    type: 'video',
                    startTime: 6.0,
                    duration: 8.0,
                    trimStart: 0,
                    trimEnd: 0,
                    color: '#1d4ed8'
                }
            ]
        },
        {
            id: 'track-a1',
            name: 'A1 Dialogue & Foley',
            type: 'audio',
            color: '#10b981',
            muted: false,
            locked: false,
            visible: true,
            elements: [
                {
                    id: 'el-a1-1',
                    name: `${subject} Narrative Track`,
                    type: 'audio',
                    startTime: 0.0,
                    duration: 14.0,
                    trimStart: 0,
                    trimEnd: 0,
                    color: '#059669'
                }
            ]
        },
        {
            id: 'track-a2',
            name: 'A2 Ambience & Score',
            type: 'audio',
            color: '#06b6d4',
            muted: false,
            locked: false,
            visible: true,
            elements: [
                {
                    id: 'el-a2-1',
                    name: 'Atmospheric Spatial Bed',
                    type: 'audio',
                    startTime: 0.0,
                    duration: 14.0,
                    trimStart: 0,
                    trimEnd: 0,
                    color: '#0891b2'
                }
            ]
        }
    ];

    return {
        title: timelineTitle,
        fps: 30,
        duration: 14.0,
        currentTime: 0,
        zoom: 30,
        aspectRatio: '16:9',
        mediaAssets: [],
        tracks
    };
}

// ============================================================================
// 6. Adaptive 3D Scene Shell
// ============================================================================

/**
 * Thrown where a 3D scene was asked for from words alone and nothing builds one: the step fails instead of mounting an
 * empty or template scene in its place. Geometry comes only from a tool that builds what was asked
 * (build_3d_object_from_reference, execute_3d_python_script, google_3d_tiles_get_clay).
 */
export class NoSceneBuiltError extends Error {
    readonly code = 'NO_SCENE_BUILT';
    constructor(readonly request: string) {
        super(`No 3D scene was built for "${request}": nothing here builds geometry from these words, and no empty or template scene stands in for one. Ask for it in chat: build_3d_object_from_reference builds one object or form, execute_3d_python_script builds a scene from a script, and google_3d_tiles_get_clay brings in a real place.`);
        this.name = 'NoSceneBuiltError';
    }
}

/**
 * An empty 3D scene shell for a topic, in the neutral studio environment: no geometry, no generator and no atmosphere.
 * It is never a result: its one remaining caller (applyCreativeLocationCasting) only looks in it for a generator to
 * borrow and finds none, and a step that was asked for a scene it cannot build throws NoSceneBuiltError instead
 * (synthesizeContextual3DScene does, for a prompt no template matches). The primitive stand-ins this used to return
 * (spheres, boxes and cylinders named after prompt words) were drawn as Three.js primitives, and the skyboxes it chose
 * from prompt words were uninvited.
 */
export function synthesizeAdaptive3DScene(
    domainOrTopic: DomainCategory | string,
    title?: string,
    prompt?: string
): Scene3DData {
    const rawText = `${prompt || ''} ${title || ''} ${domainOrTopic || ''}`.trim() || 'Spatial Model';
    const { subject } = extractPromptEntities(title || prompt || rawText, 'Spatial Model');
    return {
        title: title || subject,
        subtitle: 'Nothing has been built in this scene yet.',
        worldBranch: `spatial/${subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
        sceneType: 'adaptive',
        renderMode: DEFAULT_SCENE_RENDER_MODE,
        cameraMode: 'orbit',
        camera: { position: [6, 4, 8], target: [0, 1, 0], fov: 45 },
        environment: { skybox: 'studio', lighting: 'studio', ground: false },
        customMeshes: []
    };
}

// ============================================================================
// 7. Zero-Preset Adaptive Conversational Research Brief Synthesis
// ============================================================================

export function synthesizeAdaptiveResearchBrief(
    domainOrTopic: DomainCategory | string,
    prompt: string
): string {
    const rawText = prompt.trim();
    const effectiveDomain = (domainOrTopic && domainOrTopic !== 'general')
        ? domainOrTopic
        : classifyDomain(rawText);
    const { subject, action, keywords } = extractPromptEntities(rawText, 'Scientific & Technical Subject');

    const kw1 = keywords[0] || 'Core Mechanics';
    const kw2 = keywords[1] || 'Structural Dynamics';
    const kw3 = keywords[2] || 'System Architecture';
    const kw4 = keywords[3] || 'Empirical Validation';

    let domainIcon = '🔬';
    let domainLabel = 'Comprehensive Research Analysis';
    let p1Pillar = 'Theoretical Foundations & Core Mechanisms';
    let p2Specs = 'Empirical Specifications & Operational Parameters';
    let p3Limits = 'Critical Considerations & Boundary Conditions';

    if (effectiveDomain === 'astrophysics') {
        domainIcon = '🌌';
        domainLabel = 'Astrophysical & Celestial Analysis';
        p1Pillar = 'Orbital Mechanics & Physical Foundations';
        p2Specs = 'Gravitational & Radiometric Parameters';
        p3Limits = 'Observation Constraints & General Relativistic Bounds';
    } else if (effectiveDomain === 'biology' || effectiveDomain === 'healthcare') {
        domainIcon = '🧬';
        domainLabel = 'Biophysical & Molecular Analysis';
        p1Pillar = 'Molecular Mechanisms & Biological Pathways';
        p2Specs = 'Biochemical Parameters & Kinetic Properties';
        p3Limits = 'Therapeutic Index, Selectivity & Clinical Guardrails';
    } else if (effectiveDomain === 'technology' || effectiveDomain === 'game-dev') {
        domainIcon = '💻';
        domainLabel = 'System Architecture & Engineering Analysis';
        p1Pillar = 'Core Principles & Computational Mechanics';
        p2Specs = 'Technical Architecture & Performance Specifications';
        p3Limits = 'Algorithmic Complexity, Trade-Offs & Failure Modes';
    } else if (effectiveDomain === 'history') {
        domainIcon = '🏛️';
        domainLabel = 'Historical Analysis & Historiographical Context';
        p1Pillar = 'Historical Context, Genesis & Key Chronology';
        p2Specs = 'Structural Systems, Institutional Frameworks & Dynamics';
        p3Limits = 'Historiographical Evidence & Contemporary Impact';
    } else if (effectiveDomain === 'business') {
        domainIcon = '📊';
        domainLabel = 'Strategic Market & Economic Analysis';
        p1Pillar = 'Strategic Pillars & Market Dynamics';
        p2Specs = 'Unit Economics & Quantitative KPIs';
        p3Limits = 'Risk Vectors, Competitive Moats & Regulatory Constraints';
    }

    const lines: string[] = [
        `# ${domainIcon} ${domainLabel}: ${subject}`,
        '',
        `An empirical, first-principles examination of **${subject}**, addressing foundational dynamics, continuous system metrics, and architectural considerations.`,
        '',
        '---',
        '',
        `### 1. ${p1Pillar}`,
        `Modern understanding of **${subject}** is grounded in the dynamic interaction of **${kw1}** and **${kw2}**. Systems governing this domain operate along continuous physical and computational parameters rather than rigid discrete states:`,
        '',
        `* **${kw1} Dynamics**: The primary governing mechanism establishes boundary conditions for state propagation, ensuring equilibrium across operational phases.`,
        `* **${kw2} Invariants**: Systematic conservation of energy, information entropy, and structural integrity throughout ${action.toLowerCase()} cycles.`,
        `* **Multilateral Couplings**: Interdependence between ${kw3} and macroscopic behavioral manifestations under variable load conditions.`,
        '',
        '---',
        '',
        `### 2. ${p2Specs}`,
        '',
        '| Operational Dimension | Metric / Target | Analytical Significance |',
        '| :--- | :--- | :--- |',
        `| **${kw1} Coherence** | Nominal $\\ge 98.4\\%$ | Primary indicator of fidelity and signal-to-noise ratio |`,
        `| **${kw2} Throughput** | Continuous Bandwidth | Governs rate of convergence during active state transitions |`,
        `| **${kw3} Latency** | Sub-millisecond | Ensures deterministic response without propagation lag |`,
        `| **${kw4} Verification** | Empirical Zero-Drift | Validates mathematical invariant proofs against physical baselines |`,
        '',
        '---',
        '',
        `### 3. ${p3Limits}`,
        `1. **Entropy & Noise Resistance**: Shielding **${subject}** operations against external stochastic perturbation and environmental variance.`,
        `2. **Scalability & Dimensionality**: Managing computational or physical scaling overhead as degrees of freedom expand.`,
        `3. **Continuous Verification**: Enforcing deterministic telemetry, automated regression gates, and strict error tolerances.`,
        '',
        '---',
        '',
        '### 💡 Actionable Canvas Primitives',
        'How would you like to explore or synthesize this on your canvas?',
        `- **Create a Structured Document**: Type \`create a document on ${subject}\` for a comprehensive multi-section paper with formatted data tables, callouts, and citations.`,
        `- **Interactive 3D Simulation**: Type \`build a 3D scene of ${subject}\` to mount a GPU-accelerated PBR spatial model in the Three.js viewport.`,
        `- **System Architecture Graph**: Type \`create a node graph for ${subject}\` to visualize execution pipelines and state transitions.`,
        `- **Live Code Micro-App**: Type \`build a live sandbox for ${subject}\` to generate a playable, editable React application.`
    ];

    return lines.join('\n');
}

