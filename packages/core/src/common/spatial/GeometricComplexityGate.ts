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
}

export interface ComplexityGateReport {
    passed: boolean;
    totalVertices: number;
    totalTriangles: number;
    submeshCount: number;
    violations: string[];
    isNativeKernel: boolean;
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

        // 1. Vertex Density Audit
        if (metrics.totalVertices < minVertices) {
            violations.push(
                `Insufficient geometric density: scene has ${metrics.totalVertices.toLocaleString()} vertices, minimum required is ${minVertices.toLocaleString()} vertices. ` +
                `This indicates a prohibited low-fidelity JavaScript primitive fallback.`
            );
        }

        // 2. Triangle Count Audit
        if (metrics.totalTriangles < minTriangles) {
            violations.push(
                `Insufficient polygon resolution: scene has ${metrics.totalTriangles.toLocaleString()} triangles, minimum required is ${minTriangles.toLocaleString()} triangles.`
            );
        }

        // 3. Multi-Mesh Hierarchy Audit
        if (requireMultiMesh && metrics.submeshes.length < 2) {
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
        const kernel = (metrics.engineKernel || '').toLowerCase();
        const isNativeKernel = kernel.includes('c++') || kernel.includes('nanobind') || kernel.includes('scratchbox');
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
            const curvatureViolations = this.evaluateCurvatureFidelity(metrics);
            violations.push(...curvatureViolations);
        }

        return {
            passed: violations.length === 0,
            totalVertices: metrics.totalVertices,
            totalTriangles: metrics.totalTriangles,
            submeshCount: metrics.submeshes.length,
            violations,
            isNativeKernel
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
            const isCylindricalDisc = (dy < 0.65 * diam) && (Math.abs(dx - dz) / Math.max(1e-4, diam) < 0.35);

            // If explicitly named wheel/tire OR if it's a disc sitting near the ground
            if (isWheelCandidate || (isCylindricalDisc && submesh.bounds.min[1] < 0.5)) {
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
