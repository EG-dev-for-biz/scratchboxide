/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

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
// 6. Zero-Preset Adaptive 3D Scene Synthesis
// ============================================================================

export function synthesizeAdaptive3DScene(
    domainOrTopic: DomainCategory | string,
    title?: string,
    prompt?: string
): Scene3DData {
    const rawText = `${prompt || ''} ${title || ''} ${domainOrTopic || ''}`.trim() || 'Spatial Model';
    const effectiveDomain = (domainOrTopic && domainOrTopic !== 'general')
        ? domainOrTopic
        : classifyDomain(rawText);
    const { subject, keywords } = extractPromptEntities(title || prompt || rawText, 'Spatial Model');
    const sceneTitle = title || `${subject} - 3D Spatial Scene`;

    const isSpace = effectiveDomain === 'astrophysics' || /\b(?:space|astro|orbit|planet|celestial|star|nebula|hubble|jwst|kepler)\b/i.test(rawText);
    const isMicro = effectiveDomain === 'biology' || effectiveDomain === 'healthcare' || /\b(?:molecular|protein|cell|dna|rna|atom|enzyme|receptor|ligand)\b/i.test(rawText);
    const isTech = effectiveDomain === 'technology' || effectiveDomain === 'game-dev' || /\b(?:robot|reactor|quantum|engine|fusion|cyber|server|chip|hardware|thruster)\b/i.test(rawText);
    const isGeology = effectiveDomain === 'geology' || /\b(?:alpine|mountain|valley|matterhorn|canyon|glacier|rock|strata|terrain|geology|cliff|volcano)\b/i.test(rawText);
    const isHistory = effectiveDomain === 'history' || /\b(?:ziggurat|temple|ancient|monument|pyramid|mesopotamia|babylon|ruins|excavation|relic)\b/i.test(rawText);
    const isInfrastructure = effectiveDomain === 'infrastructure' || /\b(?:highway|overpass|viaduct|bridge|tower|skyline|building|architecture|interchange|flyover)\b/i.test(rawText);
    const isBotanical = /\b(?:flower|garden|plant|flora|botan|tree|foliage|petal|leaf|leaves|blossom|bloom|sprout|nature|meadow|rose)\b/i.test(rawText);

    let skybox = 'studio';
    let lighting = 'cinematic_3point_studio';
    let ground = true;
    let cameraPos: [number, number, number] = [12, 9, 14];
    let cameraTarget: [number, number, number] = [0, 1.8, 0];
    let cameraFov = 45;
    let customMeshes: Scene3DData['customMeshes'] = [];

    if (isSpace) {
        skybox = 'deep_space';
        lighting = 'orbital';
        ground = false;
        cameraPos = [20, 14, 22];
        cameraTarget = [0, 0, 0];
        cameraFov = 45;
        customMeshes = [
            {
                id: 'mesh-body-1',
                name: `${keywords[0] || 'Primary'} Celestial Core`,
                type: 'sphere',
                position: [0, 0, 0],
                scale: [4.2, 4.2, 4.2],
                tier: 'primary',
                material: { color: 0x38bdf8, roughness: 0.6, metalness: 0.1, emissive: 0x0284c7, emissiveIntensity: 0.6 }
            },
            {
                id: 'mesh-body-2',
                name: `${keywords[1] || 'Secondary'} Orbital Body`,
                type: 'sphere',
                position: [12, 3, -6],
                scale: [1.6, 1.6, 1.6],
                tier: 'secondary',
                material: { color: 0xec4899, roughness: 0.4, metalness: 0.3 }
            },
            {
                id: 'mesh-body-3',
                name: 'Orbital Telemetry Relay',
                type: 'cylinder',
                position: [6, 1.5, 3],
                scale: [0.5, 1.2, 0.5],
                tier: 'tertiary',
                material: { color: 0xffd700, roughness: 0.2, metalness: 0.95, preset: 'polished_gold_24k' }
            }
        ];
    } else if (isMicro) {
        skybox = 'dark_studio';
        lighting = 'rim_lit';
        ground = false;
        cameraPos = [10, 8, 12];
        cameraTarget = [0, 0.5, 0];
        cameraFov = 40;
        customMeshes = [
            {
                id: 'mesh-pocket-1',
                name: `${keywords[0] || 'Molecular'} Binding Pocket`,
                type: 'sphere',
                position: [0, 0, 0],
                scale: [2.5, 2.5, 2.5],
                tier: 'primary',
                material: { color: 0x10b981, roughness: 0.3, metalness: 0.2 }
            },
            {
                id: 'mesh-helix-1',
                name: `${keywords[1] || 'Alpha'} Backbone Helix`,
                type: 'cylinder',
                position: [3, 2, 0],
                scale: [0.8, 4.0, 0.8],
                tier: 'secondary',
                material: { color: 0x6366f1, roughness: 0.2, metalness: 0.4 }
            },
            {
                id: 'mesh-cofactor-1',
                name: 'Catalytic Cofactor Complex',
                type: 'sphere',
                position: [-1.8, -1.2, 1.5],
                scale: [0.6, 0.6, 0.6],
                tier: 'tertiary',
                material: { color: 0xf59e0b, emissive: 0xd97706, emissiveIntensity: 2.0, roughness: 0.1 }
            }
        ];
    } else if (isTech) {
        skybox = 'studio';
        lighting = 'cinematic_3point_studio';
        ground = true;
        cameraPos = [9, 6, 10];
        cameraTarget = [0, 1.4, 0];
        cameraFov = 42;
        customMeshes = [
            {
                id: 'tech-primary-chassis',
                name: `${subject} Functional Chassis`,
                type: 'cylinder',
                position: [0, 1.5, 0],
                scale: [2.2, 2.8, 2.2],
                tier: 'primary',
                material: { color: 0xd0d8e2, metalness: 0.95, roughness: 0.22, preset: 'titanium_grade5' }
            },
            {
                id: 'tech-secondary-ring',
                name: `${keywords[0] || 'Flux'} Containment Torus`,
                parentId: 'tech-primary-chassis',
                type: 'torus',
                position: [0, 2.2, 0],
                scale: [1.8, 0.25, 1.8],
                tier: 'secondary',
                material: { color: 0xffd700, metalness: 0.96, roughness: 0.18, preset: 'polished_gold_24k' }
            },
            {
                id: 'tech-tertiary-emitter',
                name: 'Plasma Emission Core',
                parentId: 'tech-primary-chassis',
                type: 'sphere',
                position: [0, 1.5, 0],
                scale: [0.75, 0.75, 0.75],
                tier: 'tertiary',
                material: { color: 0x1af0ff, emissive: 0x33ccff, emissiveIntensity: 4.0, roughness: 0.05 }
            },
            {
                id: 'tech-ground-pedestal',
                name: 'Chamfered Studio Pedestal',
                type: 'cylinder',
                position: [0, -0.15, 0],
                scale: [6.0, 0.3, 6.0],
                tier: 'primary',
                material: { color: 0x121418, metalness: 0.06, roughness: 0.25, preset: 'black_onyx' }
            }
        ];
    } else if (isGeology) {
        skybox = 'realistic-sky';
        lighting = 'daylight';
        ground = true;
        cameraPos = [16, 11, 20];
        cameraTarget = [0, 2.2, 0];
        cameraFov = 45;
        customMeshes = [
            {
                id: 'geo-massif-primary',
                name: `${subject} Geological Massif`,
                type: 'box',
                position: [0, 2.5, 0],
                scale: [5.5, 4.5, 5.0],
                tier: 'primary',
                material: { color: 0x57534e, roughness: 0.88, metalness: 0.06, preset: 'granite' }
            },
            {
                id: 'geo-scree-secondary',
                name: `${keywords[0] || 'Flank'} Ridge Buttress`,
                parentId: 'geo-massif-primary',
                type: 'box',
                position: [3.0, 1.2, 1.2],
                scale: [3.0, 2.2, 2.5],
                tier: 'secondary',
                material: { color: 0x78716c, roughness: 0.85, metalness: 0.05 }
            },
            {
                id: 'geo-summit-tertiary',
                name: 'Glacial Summit Outcrop',
                parentId: 'geo-massif-primary',
                type: 'cone',
                position: [0, 5.2, 0],
                scale: [2.0, 1.4, 2.0],
                tier: 'tertiary',
                material: { color: 0xf8fafc, roughness: 0.25, metalness: 0.1, preset: 'snow_ice' }
            },
            {
                id: 'geo-valley-floor',
                name: 'Valley Meadow Floor',
                type: 'cylinder',
                position: [0, -0.2, 0],
                scale: [14.0, 0.4, 14.0],
                tier: 'primary',
                material: { color: 0x3f6212, roughness: 0.92, metalness: 0.02 }
            }
        ];
    } else if (isHistory) {
        skybox = 'golden_hour';
        lighting = 'daylight';
        ground = true;
        cameraPos = [18, 12, 22];
        cameraTarget = [0, 2.0, 0];
        cameraFov = 45;
        customMeshes = [
            {
                id: 'hist-monument-base',
                name: `${subject} Monumental Foundation`,
                type: 'box',
                position: [0, 1.0, 0],
                scale: [7.0, 2.0, 7.0],
                tier: 'primary',
                material: { color: 0xdcd6cd, roughness: 0.85, metalness: 0.04, preset: 'weathered_limestone' }
            },
            {
                id: 'hist-terrace-tier',
                name: `${keywords[0] || 'Upper'} Terraced Sanctuary`,
                parentId: 'hist-monument-base',
                type: 'box',
                position: [0, 2.6, 0],
                scale: [4.4, 1.6, 4.4],
                tier: 'secondary',
                material: { color: 0xc8bba8, roughness: 0.80, metalness: 0.05, preset: 'travertine' }
            },
            {
                id: 'hist-summit-cella',
                name: 'Summit Cella Observatory',
                parentId: 'hist-monument-base',
                type: 'cylinder',
                position: [0, 3.9, 0],
                scale: [1.8, 1.0, 1.8],
                tier: 'tertiary',
                material: { color: 0x3b82f6, emissive: 0x1d4ed8, emissiveIntensity: 1.0, roughness: 0.35, metalness: 0.3 }
            },
            {
                id: 'hist-ground-pavement',
                name: 'Excavated Courtyard Pavement',
                type: 'cylinder',
                position: [0, -0.1, 0],
                scale: [14.0, 0.2, 14.0],
                tier: 'primary',
                material: { color: 0x78716c, roughness: 0.90, metalness: 0.02 }
            }
        ];
    } else if (isInfrastructure) {
        skybox = 'overcast';
        lighting = 'daylight';
        ground = true;
        cameraPos = [15, 10, 18];
        cameraTarget = [0, 2.8, 0];
        cameraFov = 46;
        customMeshes = [
            {
                id: 'infra-deck-primary',
                name: `${subject} Spanning Viaduct Deck`,
                type: 'box',
                position: [0, 3.2, 0],
                scale: [14.0, 0.8, 3.0],
                tier: 'primary',
                material: { color: 0x94a3b8, roughness: 0.65, metalness: 0.12, preset: 'weathered_concrete' }
            },
            {
                id: 'infra-pier-left',
                name: 'Reinforced Column West',
                parentId: 'infra-deck-primary',
                type: 'cylinder',
                position: [-3.2, 1.6, 0],
                scale: [1.1, 3.2, 1.1],
                tier: 'secondary',
                material: { color: 0x64748b, roughness: 0.70, metalness: 0.10 }
            },
            {
                id: 'infra-pier-right',
                name: 'Reinforced Column East',
                parentId: 'infra-deck-primary',
                type: 'cylinder',
                position: [3.2, 1.6, 0],
                scale: [1.1, 3.2, 1.1],
                tier: 'secondary',
                material: { color: 0x64748b, roughness: 0.70, metalness: 0.10 }
            },
            {
                id: 'infra-gantry-sign',
                name: 'Overhead Gantry Truss',
                parentId: 'infra-deck-primary',
                type: 'box',
                position: [0, 4.5, 0],
                scale: [3.6, 1.6, 0.3],
                tier: 'tertiary',
                material: { color: 0x16a34a, roughness: 0.35, metalness: 0.85 }
            },
            {
                id: 'infra-ground-corridor',
                name: 'Highway Ground Corridor',
                type: 'box',
                position: [0, -0.1, 0],
                scale: [20.0, 0.2, 20.0],
                tier: 'primary',
                material: { color: 0x1e293b, roughness: 0.90, metalness: 0.05, preset: 'bitumen_asphalt' }
            }
        ];
    } else if (isBotanical) {
        skybox = 'studio';
        lighting = 'cinematic_3point_studio';
        ground = true;
        cameraPos = [2.6, 2.0, 2.8];
        cameraTarget = [0, 1.2, 0];
        cameraFov = 38;

        const isRose = /rose/i.test(rawText);
        const petalColor = isRose ? 0xe11d48 : (/sunflower/i.test(rawText) ? 0xfacc15 : 0xf43f5e);

        customMeshes = [
            {
                id: 'botanical-soil-bed',
                name: 'Organic Garden Soil Bed',
                type: 'cylinder',
                position: [0, -0.08, 0],
                scale: [3.2, 0.16, 3.2],
                tier: 'primary',
                material: { color: 0x3d2817, roughness: 0.95, metalness: 0.05, preset: 'dark_soil' }
            },
            {
                id: 'botanical-stem-primary',
                name: `${subject} Central Stem`,
                type: 'cylinder',
                position: [0, 0.85, 0],
                scale: [0.08, 1.7, 0.08],
                tier: 'primary',
                material: { color: 0x2e7d32, roughness: 0.65, metalness: 0.08 }
            },
            {
                id: 'botanical-leaf-left',
                name: 'Lower Foliage Leaf',
                parentId: 'botanical-stem-primary',
                type: 'box',
                position: [0.38, 0.55, 0],
                scale: [0.65, 0.04, 0.28],
                rotation: [0, 0, 0.3],
                tier: 'secondary',
                material: { color: 0x388e3c, roughness: 0.55, metalness: 0.05 }
            },
            {
                id: 'botanical-leaf-right',
                name: 'Upper Foliage Leaf',
                parentId: 'botanical-stem-primary',
                type: 'box',
                position: [-0.34, 0.95, 0.12],
                scale: [0.58, 0.04, 0.24],
                rotation: [0, 0.6, -0.35],
                tier: 'secondary',
                material: { color: 0x2e7d32, roughness: 0.55, metalness: 0.05 }
            },
            {
                id: 'botanical-calyx',
                name: 'Botanical Sepal & Calyx',
                parentId: 'botanical-stem-primary',
                type: 'cylinder',
                position: [0, 1.7, 0],
                scale: [0.26, 0.12, 0.26],
                tier: 'secondary',
                material: { color: 0x1b5e20, roughness: 0.70, metalness: 0.05 }
            },
            {
                id: 'botanical-pollen-core',
                name: 'Stamen & Pollen Receptacle',
                parentId: 'botanical-stem-primary',
                type: 'sphere',
                position: [0, 1.78, 0],
                scale: [0.36, 0.22, 0.36],
                tier: 'tertiary',
                material: { color: 0xf59e0b, roughness: 0.80, metalness: 0.10, emissive: 0xd97706, emissiveIntensity: 0.35 }
            }
        ];

        // 6 radial petals arranged symmetrically around the calyx
        const petalCount = 6;
        for (let i = 0; i < petalCount; ++i) {
            const rad = (i * Math.PI * 2) / petalCount;
            const px = Math.cos(rad) * 0.42;
            const pz = Math.sin(rad) * 0.42;
            customMeshes.push({
                id: `botanical-petal-${i + 1}`,
                name: `${subject} Petal ${i + 1}`,
                parentId: 'botanical-stem-primary',
                type: 'box',
                position: [px, 1.76, pz],
                rotation: [0, -rad, 0.15],
                scale: [0.26, 0.04, 0.52],
                tier: 'secondary',
                material: { color: petalColor, roughness: 0.35, metalness: 0.05 }
            });
        }
    } else {
        // Universal Open-Ended Adaptive Domain Architecture
        // Dynamically inferred form, scale, and material hierarchy from prompt semantics
        skybox = 'studio';
        lighting = 'cinematic_3point_studio';
        ground = true;

        const isRocket = /\b(?:rocket|rocketship|spacecraft|shuttle|booster|launch\s*vehicle|saturn\s*v|falcon|starship|missile)\b/i.test(rawText);
        const isMartialArts = /\b(?:dojo|karate|judo|martial\s*arts|taekwondo|tatami|training\s*hall)\b/i.test(rawText);
        const isFurniture = /\b(?:desk|table|workbench|chair|seating|bench|shelf|cabinet)\b/i.test(rawText);
        const isVertical = /\b(?:column|tower|pillar|tank|silo|vessel|reactor|tube|cylinder|bottle|pole|chimney|flue|standpipe|beacon)\b/i.test(rawText);
        const isPlanar = /\b(?:board|chassis|platform|stage|deck|rack|bed)\b/i.test(rawText);
        const isSpherical = /\b(?:orb|sphere|ball|globe|planet|core|bubble|droplet|head|bead|sensor)\b/i.test(rawText);

        // Infer material cues
        const isWood = /\b(?:wood|timber|oak|teak|walnut|birch|pine)\b/i.test(rawText);
        const isGold = /\b(?:gold|brass|bronze|gilded)\b/i.test(rawText);
        const isGlass = /\b(?:glass|crystal|lens|transparent|optic)\b/i.test(rawText);
        const isMetal = /\b(?:metal|steel|iron|titanium|chrome|aluminum|alloy)\b/i.test(rawText) || (!isWood && !isGlass && !isGold);

        const primaryMat = isWood
            ? { color: 0x8b5a2b, roughness: 0.75, metalness: 0.05, preset: 'polished_wood' }
            : isGold
            ? { color: 0xf59e0b, roughness: 0.25, metalness: 0.95, preset: 'polished_gold_24k' }
            : isGlass
            ? { color: 0xe0f2fe, roughness: 0.10, metalness: 0.10, transmission: 0.88, opacity: 0.65 }
            : isMetal
            ? { color: 0x334155, roughness: 0.32, metalness: 0.85, preset: 'titanium_grade5' }
            : { color: 0x475569, roughness: 0.40, metalness: 0.30 };

        const secondaryMat = isGold
            ? { color: 0x1e293b, roughness: 0.40, metalness: 0.50 }
            : isWood
            ? { color: 0x3e2723, roughness: 0.60, metalness: 0.10 }
            : { color: 0x0284c7, roughness: 0.30, metalness: 0.70 };

        const tertiaryMat = {
            color: 0x10b981,
            emissive: 0x059669,
            emissiveIntensity: 1.8,
            roughness: 0.20,
            metalness: 0.60
        };

        const primaryId = 'adaptive-primary-core';

        if (isRocket) {
            cameraPos = [7.5, 6.0, 9.5];
            cameraTarget = [0, 4.0, 0];
            cameraFov = 46;
            customMeshes = [
                // 1. Primary Cylindrical Rocket Fuselage / Booster
                {
                    id: primaryId,
                    name: `${subject} Rocket Fuselage`,
                    type: 'cylinder',
                    position: [0, 4.2, 0],
                    scale: [1.4, 6.4, 1.4],
                    tier: 'primary',
                    material: { color: 0xf8fafc, roughness: 0.25, metalness: 0.85, preset: 'titanium_grade5' }
                },
                // 2. Aerodynamic Nosecone / Payload Fairing
                {
                    id: 'rocket-nosecone',
                    name: 'Aerodynamic Payload Nosecone',
                    parentId: primaryId,
                    type: 'cone',
                    position: [0, 8.8, 0],
                    scale: [1.4, 2.8, 1.4],
                    tier: 'secondary',
                    material: { color: 0x0f172a, roughness: 0.18, metalness: 0.90 }
                },
                // 3. Four Symmetrical Stabilizer Delta Fins
                {
                    id: 'rocket-fin-north',
                    name: 'Stabilizer Delta Fin North',
                    parentId: primaryId,
                    type: 'box',
                    position: [0, 1.8, 1.3],
                    scale: [0.1, 2.0, 1.2],
                    tier: 'secondary',
                    material: { color: 0xdc2626, roughness: 0.40, metalness: 0.15 }
                },
                {
                    id: 'rocket-fin-south',
                    name: 'Stabilizer Delta Fin South',
                    parentId: primaryId,
                    type: 'box',
                    position: [0, 1.8, -1.3],
                    scale: [0.1, 2.0, 1.2],
                    tier: 'secondary',
                    material: { color: 0xdc2626, roughness: 0.40, metalness: 0.15 }
                },
                {
                    id: 'rocket-fin-east',
                    name: 'Stabilizer Delta Fin East',
                    parentId: primaryId,
                    type: 'box',
                    position: [1.3, 1.8, 0],
                    scale: [1.2, 2.0, 0.1],
                    tier: 'secondary',
                    material: { color: 0xdc2626, roughness: 0.40, metalness: 0.15 }
                },
                {
                    id: 'rocket-fin-west',
                    name: 'Stabilizer Delta Fin West',
                    parentId: primaryId,
                    type: 'box',
                    position: [-1.3, 1.8, 0],
                    scale: [1.2, 2.0, 0.1],
                    tier: 'secondary',
                    material: { color: 0xdc2626, roughness: 0.40, metalness: 0.15 }
                },
                // 4. Propulsion Engine Exhaust Bell
                {
                    id: 'rocket-engine-nozzle',
                    name: 'Rocket Engine Bell Nozzle',
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [0, 0.6, 0],
                    scale: [1.1, 0.8, 1.1],
                    tier: 'tertiary',
                    material: { color: 0x1e293b, roughness: 0.15, metalness: 0.95, emissive: 0xff4500, emissiveIntensity: 2.2 }
                },
                // 5. Ground Launch Stand / Pedestal
                {
                    id: 'adaptive-ground-pedestal',
                    name: 'Launch Pad Platform',
                    type: 'cylinder',
                    position: [0, -0.1, 0],
                    scale: [4.6, 0.25, 4.6],
                    tier: 'primary',
                    material: { color: 0x1e293b, roughness: 0.85, metalness: 0.15, preset: 'dark_slate' }
                }
            ];
        } else if (isMartialArts) {
            cameraPos = [10.0, 7.0, 12.0];
            cameraTarget = [0, 2.2, 0];
            cameraFov = 46;
            customMeshes = [
                // 1. Elevated Hinoki Wood Training Platform
                {
                    id: primaryId,
                    name: `${subject} Hinoki Platform`,
                    type: 'box',
                    position: [0, 0.3, 0],
                    scale: [15.0, 0.6, 13.0],
                    tier: 'primary',
                    material: { color: 0x8b5a2b, roughness: 0.70, metalness: 0.05, preset: 'polished_wood' }
                },
                // 2. Interior Tatami Mat Surface
                {
                    id: 'dojo-tatami-mat',
                    name: 'Woven Tatami Training Floor',
                    parentId: primaryId,
                    type: 'box',
                    position: [0, 0.64, 0],
                    scale: [11.0, 0.08, 9.0],
                    tier: 'secondary',
                    material: { color: 0xa3b18a, roughness: 0.88, metalness: 0.02 }
                },
                // 3. Four Perimeter Structural Timber Pillars
                {
                    id: 'dojo-pillar-fl',
                    name: 'Perimeter Column Front-Left',
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [-5.8, 2.5, 4.8],
                    scale: [0.35, 4.4, 0.35],
                    tier: 'secondary',
                    material: { color: 0x5c3d2e, roughness: 0.75, metalness: 0.05 }
                },
                {
                    id: 'dojo-pillar-fr',
                    name: 'Perimeter Column Front-Right',
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [5.8, 2.5, 4.8],
                    scale: [0.35, 4.4, 0.35],
                    tier: 'secondary',
                    material: { color: 0x5c3d2e, roughness: 0.75, metalness: 0.05 }
                },
                {
                    id: 'dojo-pillar-rl',
                    name: 'Perimeter Column Rear-Left',
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [-5.8, 2.5, -4.8],
                    scale: [0.35, 4.4, 0.35],
                    tier: 'secondary',
                    material: { color: 0x5c3d2e, roughness: 0.75, metalness: 0.05 }
                },
                {
                    id: 'dojo-pillar-rr',
                    name: 'Perimeter Column Rear-Right',
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [5.8, 2.5, -4.8],
                    scale: [0.35, 4.4, 0.35],
                    tier: 'secondary',
                    material: { color: 0x5c3d2e, roughness: 0.75, metalness: 0.05 }
                },
                // 4. North Kamiza Honor Screen Wall
                {
                    id: 'dojo-kamiza-wall',
                    name: 'Kamiza Honor Wall & Scroll',
                    parentId: primaryId,
                    type: 'box',
                    position: [0, 2.6, -4.6],
                    scale: [9.0, 3.8, 0.2],
                    tier: 'secondary',
                    material: { color: 0xf8fafc, roughness: 0.90, metalness: 0.02 }
                },
                // 5. Makiwara Training Dummy
                {
                    id: 'dojo-makiwara',
                    name: 'Makiwara Strike Dummy',
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [-4.2, 1.6, 3.0],
                    scale: [0.3, 1.8, 0.3],
                    tier: 'tertiary',
                    material: { color: 0x8b5a2b, roughness: 0.85, metalness: 0.05 }
                },
                // 6. Overhanging Eaves Roof Beam
                {
                    id: 'dojo-roof-eaves',
                    name: 'Irimoya Overhanging Eaves',
                    parentId: primaryId,
                    type: 'box',
                    position: [0, 4.9, 0],
                    scale: [16.0, 0.4, 14.0],
                    tier: 'secondary',
                    material: { color: 0x262626, roughness: 0.60, metalness: 0.20 }
                }
            ];
        } else if (isFurniture) {
            cameraPos = [4.5, 3.5, 5.0];
            cameraTarget = [0, 1.0, 0];
            cameraFov = 45;
            customMeshes = [
                // Tabletop work surface
                {
                    id: primaryId,
                    name: `${subject} Surface`,
                    type: 'box',
                    position: [0, 1.4, 0],
                    scale: [3.4, 0.15, 2.0],
                    tier: 'primary',
                    material: primaryMat
                },
                // Four symmetrical legs
                {
                    id: 'desk-leg-fl',
                    name: 'Support Leg Front-Left',
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [-1.5, 0.7, 0.8],
                    scale: [0.12, 1.4, 0.12],
                    tier: 'secondary',
                    material: secondaryMat
                },
                {
                    id: 'desk-leg-fr',
                    name: 'Support Leg Front-Right',
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [1.5, 0.7, 0.8],
                    scale: [0.12, 1.4, 0.12],
                    tier: 'secondary',
                    material: secondaryMat
                },
                {
                    id: 'desk-leg-rl',
                    name: 'Support Leg Rear-Left',
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [-1.5, 0.7, -0.8],
                    scale: [0.12, 1.4, 0.12],
                    tier: 'secondary',
                    material: secondaryMat
                },
                {
                    id: 'desk-leg-rr',
                    name: 'Support Leg Rear-Right',
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [1.5, 0.7, -0.8],
                    scale: [0.12, 1.4, 0.12],
                    tier: 'secondary',
                    material: secondaryMat
                },
                // Tertiary accessory / module
                {
                    id: 'desk-accessory',
                    name: 'Workstation Terminal Unit',
                    parentId: primaryId,
                    type: 'box',
                    position: [0.8, 1.6, -0.3],
                    scale: [0.8, 0.35, 0.5],
                    tier: 'tertiary',
                    material: tertiaryMat
                },
                {
                    id: 'adaptive-ground-pedestal',
                    name: 'Level Floor Surface',
                    type: 'box',
                    position: [0, -0.05, 0],
                    scale: [5.5, 0.1, 4.5],
                    tier: 'primary',
                    material: { color: 0x1e293b, roughness: 0.85, metalness: 0.15 }
                }
            ];
        } else if (isVertical) {
            cameraPos = [6.0, 4.5, 7.5];
            cameraTarget = [0, 1.8, 0];
            cameraFov = 42;
            customMeshes = [
                {
                    id: primaryId,
                    name: `${subject} Primary Column`,
                    type: 'cylinder',
                    position: [0, 1.8, 0],
                    scale: [1.4, 3.6, 1.4],
                    tier: 'primary',
                    material: primaryMat
                },
                {
                    id: 'adaptive-secondary-collar',
                    name: `${keywords[0] || 'Reinforcement'} Flange Collar`,
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [0, 2.8, 0],
                    scale: [1.8, 0.25, 1.8],
                    tier: 'secondary',
                    material: secondaryMat
                },
                {
                    id: 'adaptive-secondary-manifold',
                    name: `${keywords[1] || 'Flow'} Manifold Port`,
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [0, 1.2, 0],
                    scale: [1.6, 0.5, 1.6],
                    tier: 'secondary',
                    material: secondaryMat
                },
                {
                    id: 'adaptive-tertiary-gauge',
                    name: `${keywords[2] || 'Telemetry'} Digital Indicator`,
                    parentId: primaryId,
                    type: 'sphere',
                    position: [0, 3.8, 0],
                    scale: [0.5, 0.5, 0.5],
                    tier: 'tertiary',
                    material: tertiaryMat
                },
                {
                    id: 'adaptive-ground-pedestal',
                    name: 'Structural Base Pedestal',
                    type: 'cylinder',
                    position: [0, -0.1, 0],
                    scale: [3.4, 0.2, 3.4],
                    tier: 'primary',
                    material: { color: 0x1e293b, roughness: 0.85, metalness: 0.15, preset: 'dark_slate' }
                }
            ];
        } else if (isPlanar) {
            cameraPos = [5.5, 4.0, 6.5];
            cameraTarget = [0, 1.0, 0];
            cameraFov = 45;
            customMeshes = [
                {
                    id: primaryId,
                    name: `${subject} Main Chassis Platform`,
                    type: 'box',
                    position: [0, 1.0, 0],
                    scale: [3.6, 0.3, 2.2],
                    tier: 'primary',
                    material: primaryMat
                },
                {
                    id: 'adaptive-secondary-subframe',
                    name: `${keywords[0] || 'Structural'} Subframe Support`,
                    parentId: primaryId,
                    type: 'box',
                    position: [0, 0.45, 0],
                    scale: [3.2, 0.8, 1.8],
                    tier: 'secondary',
                    material: secondaryMat
                },
                {
                    id: 'adaptive-tertiary-module',
                    name: `${keywords[1] || 'Control'} Terminal Interface`,
                    parentId: primaryId,
                    type: 'box',
                    position: [0.8, 1.3, 0.4],
                    scale: [0.8, 0.3, 0.6],
                    tier: 'tertiary',
                    material: tertiaryMat
                },
                {
                    id: 'adaptive-ground-pedestal',
                    name: 'Level Floor Surface',
                    type: 'box',
                    position: [0, -0.05, 0],
                    scale: [6.0, 0.1, 5.0],
                    tier: 'primary',
                    material: { color: 0x1e293b, roughness: 0.85, metalness: 0.15 }
                }
            ];
        } else if (isSpherical) {
            cameraPos = [4.5, 3.2, 5.5];
            cameraTarget = [0, 1.4, 0];
            cameraFov = 45;
            customMeshes = [
                {
                    id: primaryId,
                    name: `${subject} Spherical Core`,
                    type: 'sphere',
                    position: [0, 1.4, 0],
                    scale: [1.8, 1.8, 1.8],
                    tier: 'primary',
                    material: primaryMat
                },
                {
                    id: 'adaptive-secondary-ring',
                    name: `${keywords[0] || 'Equatorial'} Gimbal Ring`,
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [0, 1.4, 0],
                    scale: [2.5, 0.12, 2.5],
                    tier: 'secondary',
                    material: secondaryMat
                },
                {
                    id: 'adaptive-tertiary-beacon',
                    name: `${keywords[1] || 'Optical'} Feedback Sensor`,
                    parentId: primaryId,
                    type: 'sphere',
                    position: [0, 2.45, 0],
                    scale: [0.35, 0.35, 0.35],
                    tier: 'tertiary',
                    material: tertiaryMat
                },
                {
                    id: 'adaptive-ground-pedestal',
                    name: 'Magnetic Standoff Mount',
                    type: 'cylinder',
                    position: [0, -0.05, 0],
                    scale: [2.8, 0.15, 2.8],
                    tier: 'primary',
                    material: { color: 0x0f172a, roughness: 0.80, metalness: 0.20 }
                }
            ];
        } else {
            cameraPos = [5.0, 3.8, 6.2];
            cameraTarget = [0, 1.2, 0];
            cameraFov = 45;
            customMeshes = [
                {
                    id: primaryId,
                    name: `${subject} Primary Edifice`,
                    type: 'box',
                    position: [0, 1.2, 0],
                    scale: [2.6, 2.2, 2.2],
                    tier: 'primary',
                    material: primaryMat
                },
                {
                    id: 'adaptive-secondary-wing-left',
                    name: `${keywords[0] || 'Left'} Articulation Module`,
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [-1.6, 1.2, 0],
                    scale: [0.6, 1.6, 0.6],
                    tier: 'secondary',
                    material: secondaryMat
                },
                {
                    id: 'adaptive-secondary-wing-right',
                    name: `${keywords[0] || 'Right'} Articulation Module`,
                    parentId: primaryId,
                    type: 'cylinder',
                    position: [1.6, 1.2, 0],
                    scale: [0.6, 1.6, 0.6],
                    tier: 'secondary',
                    material: secondaryMat
                },
                {
                    id: 'adaptive-tertiary-indicator',
                    name: `${keywords[1] || 'System'} Telemetry Emitter`,
                    parentId: primaryId,
                    type: 'sphere',
                    position: [0, 2.55, 0],
                    scale: [0.45, 0.45, 0.45],
                    tier: 'tertiary',
                    material: tertiaryMat
                },
                {
                    id: 'adaptive-ground-pedestal',
                    name: 'Chamfered Studio Pedestal',
                    type: 'cylinder',
                    position: [0, -0.08, 0],
                    scale: [4.6, 0.16, 4.6],
                    tier: 'primary',
                    material: { color: 0x1e293b, roughness: 0.80, metalness: 0.15, preset: 'dark_slate' }
                }
            ];
        }
    }

    return {
        title: sceneTitle,
        subtitle: `PBR spatial environment tailored for ${subject}`,
        worldBranch: `spatial/${subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
        sceneType: isSpace ? 'space' : isMicro ? 'molecular' : 'adaptive',
        renderMode: 'pbr',
        cameraMode: 'orbit',
        animation: 'orbit',
        camera: {
            position: cameraPos,
            target: cameraTarget,
            fov: cameraFov
        },
        environment: {
            skybox,
            lighting,
            ground
        },
        features: {
            pbrMaterials: true,
            curvatureAO: true,
            multiLayerWeathering: true,
            cinematic3PointLighting: true,
            studioPedestal: ground
        },
        timeline: {
            currentTimeMs: 0,
            durationMs: 12000,
            isPlaying: true,
            speed: 1.0,
            playbackSpeed: 1.0,
            isLooping: true
        },
        cppGenerator: {
            enabled: true,
            filename: 'world_generator.cpp',
            sourceCode: `// Generated dynamically via Scratchbox Adaptive Domain Architecture
// Open-domain procedural C++20 geometry generator for "${subject}".
#include "scratchbox_engine.hpp"
#include "scratchbox_architecture.hpp"
#include "scratchbox_io.hpp"

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::io;

int main() {
    UniversalSceneComposer scene("${subject}");
    // 70-20-10 Geometric Form Hierarchy
    ScratchboxMesh primaryMesh = ScratchboxMesh::createBox(Vec3(2.4f, 2.4f, 2.4f), Vec4(0.35f, 0.45f, 0.65f, 1.0f));
    primaryMesh.name = "${subject}_Primary";
    scene.addNode("primary_massing", primaryMesh, FormTier::Primary, Vec3(0, 1.2f, 0));

    GlbWriter::serializeMultiMeshToGlb("output.glb", scene.buildSceneMeshes());
    return 0;
}`,
            vertexCount: 16384,
            triangleCount: 8192
        },
        customMeshes
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

