/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Geometric Complexity & Quality Gate (Anti-JS-Primitive Hardening)
 * 
 * In strict alignment with Scratchbox IDE Core Directives:
 * - "Lean on C/C++ First for 3D (C++20 as Geometry Generator, Three.js as Pure Viewport)"
 * - Prohibition of client-side toy primitives (THREE.BoxGeometry / THREE.CylinderGeometry)
 * - Minimum geometric entropy & density enforcement (>=25,000 vertices for full scenes)
 ********************************************************************************/

import { validateContract, type ProvenanceLabel, type StructureFit } from './staged-location-contracts';

export interface GeometricMeshSummary {
    name: string;
    vertexCount: number;
    triangleCount: number;
    generatorType?: string;
    isPrimitive?: boolean;
    bounds?: {
        min: [number, number, number];
        max: [number, number, number];
        dimensions: [number, number, number];
    };
    tag?: string;
    cardinalNormalRatio?: number;
}

export interface GeometricSceneMetrics {
    totalVertices: number;
    totalTriangles: number;
    submeshes: GeometricMeshSummary[];
    engineKernel?: string;
}

export interface ComplexityGateOptions {
    /**
     * Minimum vertex count threshold for generative 3D scenes.
     * Default: 25,000 for full procedural scenes.
     */
    minVertexCount?: number;

    /**
     * Minimum triangle count threshold for generative 3D scenes.
     * Default: 15,000.
     */
    minTriangleCount?: number;

    /**
     * Whether the scene must be decomposed into a multi-mesh hierarchy
     * (Primary massing, secondary pavilions, tertiary architectural/botanical detail).
     * Default: true.
     */
    requireMultiMeshHierarchy?: boolean;

    /**
     * Banned generator identifiers or primitive tags.
     */
    disallowedGenerators?: string[];

    /**
     * Whether to enforce correct kinematic orientation for wheels and rolling elements.
     * Flags flat pancake wheels lying horizontally on the ground.
     * Default: true.
     */
    enforceKinematicOrientation?: boolean;

    /**
     * Whether to audit primary massing for continuous compound curvature.
     * Detects and prohibits stacked flat box primitives.
     * Default: true.
     */
    enforceCompoundCurvature?: boolean;

    /**
     * Measured geometry is exempt from the vertex floor (AGENTS.md, Measured-Geometry Exemption) and judged by its fit
     * to the scan instead; it is never padded to pass. The density, triangle, hierarchy and curvature checks count only
     * the submeshes no exemption covers. A measured rebuild is exempt only when the gate itself finds its StructureFit
     * valid and accepted: numbers a caller passes in are never trusted.
     */
    exemptions?: ComplexityExemption[];
}

/** Why a submesh is exempt from the vertex floor. */
export type ComplexityExemption =
    /** Google 3D Tiles as scanned, flattened or remeshed: the tiles' own density at their leaf error. */
    | { scanDerived: { submeshes: string[]; label: ProvenanceLabel; leafGeometricErrorM: number } }
    /** A scan-fitted rebuild (fitted body, outlines, pass-through, its detail), exempt only on a valid, accepted StructureFit. */
    | { measuredRebuild: { submeshes: string[]; structureFit: StructureFit; structureFitSha256: string } }
    /**
     * SB-Veggie trees grown inside crowns measured in the tile scan: each tree's position, extent and height are the
     * scan's, so the layer's vertex count follows the crowns measured and is never padded. Exempt only for a positive
     * whole number of crowns, which the caller reads from the strip's crown list.
     */
    | { measuredCrowns: { submeshes: string[]; crowns: number } };

export interface ComplexityGateReport {
    passed: boolean;
    totalVertices: number;
    totalTriangles: number;
    submeshCount: number;
    violations: string[];
    isNativeKernel: boolean;
    /** Each exemption granted, with its basis ("vertex floor: scan-derived layer (…)"). */
    exemptions: string[];
    /** Exemptions asked for and refused, with why (their submeshes were counted). */
    exemptionsRefused: string[];
}

/** Minimums a StructureFit must meet, read from the StructureFit itself, for its rebuild to be exempt. */
export const MEASURED_REBUILD_MIN_COVERAGE = 0.85;
export const MEASURED_REBUILD_MAX_SCAN_TO_FIT_RMS_M = 0.06;

/** Why a StructureFit does not earn the measured-rebuild exemption, or undefined when it does. */
export function measuredRebuildRefusal(fit: StructureFit): string | undefined {
    const problems = validateContract('StructureFit', fit);
    if (problems.length) return `its StructureFit is not valid (${problems.slice(0, 3).join('; ')})`;
    if (fit.accepted !== true) return 'its StructureFit was not accepted';
    const failed = fit.gates.filter(g => !g.passed);
    if (failed.length) return `its StructureFit failed ${failed.map(g => g.gate).join(', ')}`;
    if (!(fit.metrics.coverage >= MEASURED_REBUILD_MIN_COVERAGE)) return `its coverage ${Math.round(fit.metrics.coverage * 100)}% is under ${Math.round(MEASURED_REBUILD_MIN_COVERAGE * 100)}%`;
    if (!(fit.metrics.scanToFit.rmsM <= MEASURED_REBUILD_MAX_SCAN_TO_FIT_RMS_M)) return `its scan→fit rms ${(fit.metrics.scanToFit.rmsM * 100).toFixed(1)} cm is over ${MEASURED_REBUILD_MAX_SCAN_TO_FIT_RMS_M * 100} cm`;
    return undefined;
}

export class GeometricFidelityViolationError extends Error {
    public readonly violations: string[];
    public readonly metrics: GeometricSceneMetrics;

    constructor(message: string, violations: string[], metrics: GeometricSceneMetrics) {
        super(message);
        this.name = 'GeometricFidelityViolationError';
        this.violations = violations;
        this.metrics = metrics;
    }
}

export class GeometricComplexityGate {
    public static readonly DEFAULT_SCENE_MIN_VERTICES = 25000;
    public static readonly DEFAULT_SCENE_MIN_TRIANGLES = 15000;
    public static readonly DEFAULT_SINGLE_ASSET_MIN_VERTICES = 5000;

    public static readonly BANNED_PRIMITIVE_GENERATORS = [
        'THREE.BoxGeometry',
        'THREE.CylinderGeometry',
        'THREE.ConeGeometry',
        'THREE.SphereGeometry',
        'ClientSideJsPrimitives',
        'Tier0PrimitiveFallback'
    ];

    /**
     * Evaluates a scene's geometric metrics against the complexity gate.
     */
    public static evaluate(
        metrics: GeometricSceneMetrics,
        options: ComplexityGateOptions = {}
    ): ComplexityGateReport {
        const minVertices = options.minVertexCount ?? this.DEFAULT_SCENE_MIN_VERTICES;
        const minTriangles = options.minTriangleCount ?? this.DEFAULT_SCENE_MIN_TRIANGLES;
        const requireMultiMesh = options.requireMultiMeshHierarchy ?? true;
        const disallowed = options.disallowedGenerators ?? this.BANNED_PRIMITIVE_GENERATORS;

        const violations: string[] = [];
        const kernel = (metrics.engineKernel || '').toLowerCase();
        const isNativeKernel = kernel.includes('c++') || kernel.includes('nanobind') || kernel.includes('scratchbox');

        // Exemptions: which submeshes are measured geometry, judged by their fit to the scan instead of the floor
        const exemptNames = new Set<string>();
        const exemptions: string[] = [];
        const exemptionsRefused: string[] = [];
        const byName = new Map(metrics.submeshes.map(m => [m.name, m]));
        const countOf = (names: string[]) => names.reduce((s, n) => s + (byName.get(n)?.vertexCount ?? 0), 0);
        for (const e of options.exemptions ?? []) {
            if ('scanDerived' in e) {
                const names = e.scanDerived.submeshes.filter(n => byName.has(n));
                if (!names.length) continue;
                names.forEach(n => exemptNames.add(n));
                exemptions.push(`vertex floor: scan-derived layer (${countOf(names).toLocaleString()} vertices, the tiles' own density at leaf error ${e.scanDerived.leafGeometricErrorM.toFixed(1)} m, ${e.scanDerived.label})`);
            } else if ('measuredCrowns' in e) {
                const names = e.measuredCrowns.submeshes.filter(n => byName.has(n));
                if (!names.length) continue;
                const crowns = e.measuredCrowns.crowns;
                if (!Number.isInteger(crowns) || crowns < 1) {
                    exemptionsRefused.push(`measured crowns ${names.join(', ')}: ${Number.isFinite(crowns) ? crowns : 'no'} measured crowns is not a whole number of at least 1`);
                    continue;
                }
                names.forEach(n => exemptNames.add(n));
                exemptions.push(`vertex floor: SB-Veggie trees grown to ${crowns.toLocaleString()} measured crown${crowns === 1 ? '' : 's'} (${countOf(names).toLocaleString()} vertices; each tree's position, extent and height come from the tile scan)`);
            } else {
                const names = e.measuredRebuild.submeshes.filter(n => byName.has(n));
                if (!names.length) continue;
                const fit = e.measuredRebuild.structureFit;
                const refusal = measuredRebuildRefusal(fit);
                if (refusal) {
                    exemptionsRefused.push(`measured rebuild ${names.join(', ')}: ${refusal}`);
                    continue;
                }
                names.forEach(n => exemptNames.add(n));
                exemptions.push(`vertex floor: measured rebuild (${countOf(names).toLocaleString()} vertices; StructureFit ${e.measuredRebuild.structureFitSha256.slice(0, 8)} accepted, ${(fit.metrics.scanToFit.rmsM * 100).toFixed(1)} cm rms over ${Math.round(fit.metrics.coverage * 100)}% of the visible scan)`);
            }
        }
        const counted = exemptNames.size ? metrics.submeshes.filter(m => !exemptNames.has(m.name)) : metrics.submeshes;
        const allExempt = exemptNames.size > 0 && counted.length === 0;
        const countedVertices = exemptNames.size ? counted.reduce((s, m) => s + m.vertexCount, 0) : metrics.totalVertices;
        const countedTriangles = exemptNames.size ? counted.reduce((s, m) => s + m.triangleCount, 0) : metrics.totalTriangles;
        const countedMetrics: GeometricSceneMetrics = { ...metrics, submeshes: counted };

        // 1. Vertex Density Audit
        if (!allExempt && countedVertices < minVertices) {
            violations.push(
                `Insufficient geometric density: scene has ${countedVertices.toLocaleString()} ${exemptNames.size ? 'non-exempt ' : ''}vertices, minimum required is ${minVertices.toLocaleString()} vertices.` +
                // only a script kernel can have fallen back to JavaScript primitives; a native or scanned layer has not
                (kernel && !isNativeKernel ? ' This indicates a prohibited low-fidelity JavaScript primitive fallback.' : '')
            );
        }

        // 2. Triangle Count Audit
        if (!allExempt && countedTriangles < minTriangles) {
            violations.push(
                `Insufficient polygon resolution: scene has ${countedTriangles.toLocaleString()} ${exemptNames.size ? 'non-exempt ' : ''}triangles, minimum required is ${minTriangles.toLocaleString()} triangles.`
            );
        }

        // 3. Multi-Mesh Hierarchy Audit (a generated scene's 70-20-10 rule; measured layers are what the scan holds)
        if (!allExempt && requireMultiMesh && metrics.submeshes.length < 2) {
            violations.push(
                `Missing architectural hierarchy: scene contains only ${metrics.submeshes.length} submesh. ` +
                `The 70-20-10 rule requires distinct primary massing, secondary wings, and tertiary botanical/architectural detail.`
            );
        }

        // 4. Banned Primitive Detection
        for (const submesh of metrics.submeshes) {
            if (submesh.isPrimitive) {
                violations.push(`Submesh "${submesh.name}" is flagged as a banned primitive.`);
            }
            if (submesh.generatorType && disallowed.includes(submesh.generatorType)) {
                violations.push(`Submesh "${submesh.name}" uses banned generator: ${submesh.generatorType}.`);
            }
        }

        // 5. Engine Kernel Audit
        if (kernel && !isNativeKernel) {
            violations.push(
                `Unsanctioned 3D engine kernel: "${metrics.engineKernel}". Only the native C++20 / Python engine kernels are permitted.`
            );
        }

        // 6. Kinematic Orientation Audit (Anti-Pancake Wheel Invariant)
        if (options.enforceKinematicOrientation ?? true) {
            const kinematicViolations = this.evaluateKinematicOrientation(metrics);
            violations.push(...kinematicViolations);
        }

        // 7. Compound Curvature Audit (Anti-Box-Stacking Invariant)
        if (options.enforceCompoundCurvature ?? true) {
            const curvatureViolations = this.evaluateCurvatureFidelity(countedMetrics);
            violations.push(...curvatureViolations);
        }

        return {
            passed: violations.length === 0,
            totalVertices: metrics.totalVertices,
            totalTriangles: metrics.totalTriangles,
            submeshCount: metrics.submeshes.length,
            violations,
            isNativeKernel,
            exemptions,
            exemptionsRefused
        };
    }

    /**
     * Audits all submeshes to ensure wheels and rolling elements are not lying flat like pancakes.
     */
    public static evaluateKinematicOrientation(metrics: GeometricSceneMetrics): string[] {
        const violations: string[] = [];
        for (const submesh of metrics.submeshes) {
            const nameLower = (submesh.name || '').toLowerCase();
            const tagLower = (submesh.tag || '').toLowerCase();
            const isWheelCandidate = nameLower.includes('wheel') || nameLower.includes('tire') ||
                nameLower.includes('tyre') || nameLower.includes('roller') ||
                tagLower.includes('wheel') || tagLower.includes('tire');

            if (!submesh.bounds) continue;
            const [dx, dy, dz] = submesh.bounds.dimensions;
            const diam = Math.max(dx, dz);

            // Shape alone can't tell a flat wheel from a plinth, pond or rock outcrop, so only audit declared rolling parts.
            if (isWheelCandidate) {
                // Check if its thin dimension is vertical (Y)
                if (dy < 0.70 * diam) {
                    violations.push(
                        `Kinematic Orientation Violation: Submesh "${submesh.name}" is oriented as a flat horizontal disc ` +
                        `(thickness Y=${dy.toFixed(2)}m vs diameter=${diam.toFixed(2)}m). ` +
                        `Rolling elements must have their rotational symmetry axis aligned horizontally (pitch/lateral axis).`
                    );
                }
            }
        }
        return violations;
    }

    /**
     * Audits the primary edifice / hull to ensure it has compound curvature rather than stacked flat boxes.
     */
    public static evaluateCurvatureFidelity(metrics: GeometricSceneMetrics): string[] {
        const violations: string[] = [];
        if (!metrics.submeshes || metrics.submeshes.length === 0) return violations;

        let largestSubmesh: GeometricMeshSummary | null = null;
        let maxVolume = -1;
        for (const submesh of metrics.submeshes) {
            if (submesh.bounds) {
                const [dx, dy, dz] = submesh.bounds.dimensions;
                const vol = dx * dy * dz;
                if (vol > maxVolume) {
                    maxVolume = vol;
                    largestSubmesh = submesh;
                }
            }
        }

        if (largestSubmesh) {
            if (largestSubmesh.cardinalNormalRatio !== undefined && largestSubmesh.cardinalNormalRatio > 0.65 && largestSubmesh.vertexCount < 100) {
                violations.push(
                    `Curvature Fidelity Violation: Primary hull "${largestSubmesh.name}" consists of flat axis-aligned box faces ` +
                    `(cardinal normal ratio: ${(largestSubmesh.cardinalNormalRatio * 100).toFixed(0)}%). ` +
                    `Hero objects and streamlined hulls must use continuous compound curvature (create_lofted_hull or non-linear deformers).`
                );
            }
        }
        return violations;
    }

    /**
     * Asserts that a scene passes the complexity gate, throwing an error if it fails.
     */
    public static assertFidelity(
        metrics: GeometricSceneMetrics,
        options: ComplexityGateOptions = {}
    ): void {
        const report = this.evaluate(metrics, options);
        if (!report.passed) {
            throw new GeometricFidelityViolationError(
                `[GeometricComplexityGate] Scene failed geometric fidelity audit with ${report.violations.length} violation(s):\n - ` +
                report.violations.join('\n - '),
                report.violations,
                metrics
            );
        }
    }
}
