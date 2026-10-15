/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * ObjectBuildSpec: what Gemini vision reads out of a reference image, and what the native interpreter
 * `sb.object_spec.build` (packages/core/src/python/scratchbox/object_spec.py) turns into geometry.
 *
 * Every value is continuous and metric: metres, degrees and ratios, +Y up, +X right, +Z toward the front,
 * origin at the centre of the ground contact. A part names exactly one of four geometry kernels; the kernels
 * say how a surface is generated, never what the object is:
 *   sweep      a cross-section swept along a smooth carrier curve
 *   revolve    a meridian revolved about an axis, with radial harmonic lobes and an optional helix
 *   replicate  copies of another part (with what is attached to it) around a ring or along a path
 *   relief     grooves or beads along curves on another part's surface
 * Labels are diagnostic text and nothing branches on them. A child part attaches by parameter on its
 * parent's evaluated surface, so connections hold by construction instead of by guessed coordinates.
 */

export type Vec3 = [number, number, number];

/** Where a child meets its parent: `u` along the parent (0..1), `angleDeg` around it, then along the surface normal. */
export interface PartAttachment {
    u: number;
    angleDeg: number;
    normalOffsetMeters: number;
}

/** Cross-section at `t` (0 at the first control point, 1 at the last): a superellipse of this width and height. */
export interface SweepProfileKey {
    t: number;
    widthMeters: number;
    heightMeters: number;
    /** Superellipse exponent: 2 is an ellipse, larger is boxier, below 2 is pinched. */
    exponent: number;
}

export interface SweepOperator {
    controlPoints: Vec3[];
    closedLoop: boolean;
    /** 0 = straight segments between control points, 1 = a smooth (centripetal Catmull-Rom) curve through them. */
    smoothing: number;
    profile: SweepProfileKey[];
    /** [t, degrees] rotation of the section about the carrier, interpolated linearly. */
    twistDegAlong?: Array<[number, number]>;
    /** Periodic radial ribbing along (and optionally around) the sweep. */
    modulation?: { amplitudeMeters: number; cyclesPerMeter: number; cyclesAround: number };
}

export interface RevolveOperator {
    axisOrigin: Vec3;
    axisDirection: Vec3;
    /** [distance along the axis, radius] points; radius 0 closes an end at the axis. */
    meridian: Array<[number, number]>;
    /** 0 = straight segments between meridian points, 1 = a smooth curve through them. */
    smoothing: number;
    lobeCount: number;
    lobeDepthRatio: number;
    /** Axial distance per full turn of the lobes; 0 keeps them straight, the sign sets the handedness. */
    helixPitchMeters: number;
}

export interface ReplicateRing {
    centerMeters: Vec3;
    axisDirection: Vec3;
    count: number;
    /** Total angle the copies are spread over; copy i is turned by i * spanDeg / count. */
    spanDeg: number;
    risePerCopyMeters: number;
}

export interface ReplicatePath {
    points: Vec3[];
    count: number;
    orientToPath: boolean;
}

export interface ReplicateOperator {
    seedPartId: string;
    ring?: ReplicateRing;
    path?: ReplicatePath;
}

export interface ReliefOperator {
    targetPartId: string;
    /** Polylines of [u, v]: u along the target (0..1), v = angle / 360 around it (values past 1 wrap). */
    curves: Array<Array<[number, number]>>;
    widthMeters: number;
    /** Negative cuts a groove, positive raises a bead. */
    depthMeters: number;
    /** 0 = rounded cross-section, toward 1 = crisp and flat-bottomed. */
    sharpness: number;
}

export interface ObjectPartSpec {
    id: string;
    label: string;
    parentId?: string;
    attach?: PartAttachment;
    /** Also emit this part (and what is attached to it) reflected across the plane through the origin with this normal. */
    mirrorPlaneNormal?: Vec3;
    sweep?: SweepOperator;
    revolve?: RevolveOperator;
    replicate?: ReplicateOperator;
    relief?: ReliefOperator;
}

export interface ObjectBuildSpec {
    subject: string;
    /** Overall width (X), height (Y) and depth (Z) of the object in metres. */
    boundingMeters: Vec3;
    /** How many separate pieces the object is meant to be (1 when everything is joined). */
    expectedBodies: number;
    observations: string[];
    parts: ObjectPartSpec[];
}

export const OPERATOR_KEYS = ['sweep', 'revolve', 'replicate', 'relief'] as const;
export type OperatorKey = typeof OPERATOR_KEYS[number];

/** Limits that keep a build inside the interpreter's and the connectivity check's budgets. */
export const OBJECT_SPEC_LIMITS = {
    maxParts: 48,
    maxPoints: 64,
    maxProfileKeys: 16,
    maxCurves: 16,
    maxCopies: 256,
    maxTotalInstances: 4096,
    maxLobes: 64,
    maxBoundingMeters: 1000,
    /** Coordinates beyond this multiple of the largest bounding dimension are a unit mistake (mm or cm for m). */
    coordinateReachFactor: 5
} as const;

// ---------------------------------------------------------------------------
// JSON Schema of the spec, stated in the vision request (JSON mode); every reply is validated below
// ---------------------------------------------------------------------------

const num = (description?: string, minimum?: number, maximum?: number): Record<string, unknown> => ({
    type: 'number',
    ...(description ? { description } : {}),
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {})
});
// Fixed-length number tuples as items + minItems + maxItems. A schema using prefixItems was refused by Vertex
// (gemini-4-argon, 400 "Request contains an invalid argument"); the validator still checks every length.
const tuple = (size: number, description: string): Record<string, unknown> => ({
    type: 'array',
    description,
    items: { type: 'number' },
    minItems: size,
    maxItems: size
});
const vec3 = (description: string) => tuple(3, description);

/**
 * The spec's schema as given to the vision model (kept to the JSON Schema subset Gemini understands). Rules a
 * schema cannot state, such as "exactly one operator block per part", are enforced by `validateObjectBuildSpec`.
 */
export const OBJECT_BUILD_SPEC_JSON_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        subject: { type: 'string', description: 'Short name of what is being built (diagnostic only).' },
        observations: {
            type: 'array',
            items: { type: 'string' },
            description: 'Short notes on what the reference shows: proportions, counts, how parts join, what is inferred for hidden sides.'
        },
        boundingMeters: vec3('Overall [width X, height Y, depth Z] of the object in metres at real-world scale.'),
        expectedBodies: { type: 'integer', minimum: 1, description: 'How many separate pieces the object is meant to be; 1 when everything is joined.' },
        parts: {
            type: 'array',
            minItems: 1,
            maxItems: OBJECT_SPEC_LIMITS.maxParts,
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Unique id (letters, digits, _ . -).' },
                    label: { type: 'string', description: 'What this part is (diagnostic only).' },
                    parentId: { type: 'string', description: 'Id of the sweep or revolve part this part attaches to. Omit only for root parts.' },
                    attach: {
                        type: 'object',
                        description: 'Required with parentId: the point on the parent surface where this part starts.',
                        properties: {
                            u: num('0..1 along the parent (along the carrier for a sweep, along the meridian for a revolve).', 0, 1),
                            angleDeg: num('Degrees around the parent from its reference direction.'),
                            normalOffsetMeters: num('Move along the parent surface normal; small negative values sink the part in.')
                        },
                        required: ['u', 'angleDeg', 'normalOffsetMeters']
                    },
                    mirrorPlaneNormal: vec3('Optional: also emit this part and what is attached to it reflected across the plane through the origin with this normal, e.g. [1,0,0].'),
                    sweep: {
                        type: 'object',
                        properties: {
                            controlPoints: {
                                type: 'array', minItems: 2, maxItems: OBJECT_SPEC_LIMITS.maxPoints,
                                items: vec3('[x, y, z] metres; absolute for a root part, an offset in object axes from the attach point for a child.')
                            },
                            closedLoop: { type: 'boolean', description: 'Join the end back to the start (rings, loops).' },
                            smoothing: num('0 = straight segments between points, 1 = smooth curve through them.', 0, 1),
                            profile: {
                                type: 'array', minItems: 1, maxItems: OBJECT_SPEC_LIMITS.maxProfileKeys,
                                items: {
                                    type: 'object',
                                    properties: {
                                        t: num('0 at the first control point, 1 at the last.', 0, 1),
                                        widthMeters: num('Section width across the carrier (sideways).', 0),
                                        heightMeters: num('Section height across the carrier (along its up direction).', 0),
                                        exponent: num('Superellipse exponent: 2 round, 4 or more boxy, below 2 pinched.', 0.5, 12)
                                    },
                                    required: ['t', 'widthMeters', 'heightMeters', 'exponent']
                                }
                            },
                            twistDegAlong: { type: 'array', items: tuple(2, '[t, degrees] twist of the section about the carrier.') },
                            modulation: {
                                type: 'object',
                                properties: {
                                    amplitudeMeters: num('Radial ribbing amplitude.'),
                                    cyclesPerMeter: num('Ribs per metre along the carrier.', 0),
                                    cyclesAround: { type: 'integer', minimum: 0, description: 'Ribs around the section (0 = rings).' }
                                },
                                required: ['amplitudeMeters', 'cyclesPerMeter', 'cyclesAround']
                            }
                        },
                        required: ['controlPoints', 'closedLoop', 'smoothing', 'profile']
                    },
                    revolve: {
                        type: 'object',
                        properties: {
                            axisOrigin: vec3('Where the axis starts; absolute for a root part, an offset in object axes from the attach point for a child.'),
                            axisDirection: vec3('Direction of the axis.'),
                            meridian: {
                                type: 'array', minItems: 2, maxItems: OBJECT_SPEC_LIMITS.maxPoints,
                                items: tuple(2, '[distance along the axis, radius] in metres; radius 0 closes the end at the axis.')
                            },
                            smoothing: num('0 = straight segments between meridian points, 1 = smooth curve.', 0, 1),
                            lobeCount: { type: 'integer', minimum: 0, maximum: OBJECT_SPEC_LIMITS.maxLobes, description: 'Radial lobes (flutes, teeth, petals); 0 for a plain solid of revolution.' },
                            lobeDepthRatio: num('Lobe depth as a fraction of the radius.', 0, 0.9),
                            helixPitchMeters: num('Axial distance per full turn of the lobes; 0 keeps them straight.')
                        },
                        required: ['axisOrigin', 'axisDirection', 'meridian', 'smoothing', 'lobeCount', 'lobeDepthRatio', 'helixPitchMeters']
                    },
                    replicate: {
                        type: 'object',
                        properties: {
                            seedPartId: { type: 'string', description: 'Part to copy, together with everything attached to it. It is emitted only through this replicate.' },
                            ring: {
                                type: 'object',
                                properties: {
                                    centerMeters: vec3('A point on the rotation axis.'),
                                    axisDirection: vec3('Rotation axis direction.'),
                                    count: { type: 'integer', minimum: 2, maximum: OBJECT_SPEC_LIMITS.maxCopies, description: 'Number of copies including the seed itself.' },
                                    spanDeg: num('Angle the copies are spread over: 360 evenly round a full circle, more for a helix.', 0, 3600),
                                    risePerCopyMeters: num('Shift along the axis per copy (0 for a flat ring).')
                                },
                                required: ['centerMeters', 'axisDirection', 'count', 'spanDeg', 'risePerCopyMeters']
                            },
                            path: {
                                type: 'object',
                                properties: {
                                    points: { type: 'array', minItems: 2, maxItems: OBJECT_SPEC_LIMITS.maxPoints, items: vec3('Path point; the seed as built sits at the first point.') },
                                    count: { type: 'integer', minimum: 2, maximum: OBJECT_SPEC_LIMITS.maxCopies, description: 'Copies spaced evenly from the first to the last point.' },
                                    orientToPath: { type: 'boolean', description: 'Turn each copy with the path direction.' }
                                },
                                required: ['points', 'count', 'orientToPath']
                            }
                        },
                        required: ['seedPartId']
                    },
                    relief: {
                        type: 'object',
                        properties: {
                            targetPartId: { type: 'string', description: 'Sweep or revolve part whose surface gets the relief.' },
                            curves: {
                                type: 'array', minItems: 1, maxItems: OBJECT_SPEC_LIMITS.maxCurves,
                                items: {
                                    type: 'array', minItems: 2, maxItems: OBJECT_SPEC_LIMITS.maxPoints,
                                    items: tuple(2, '[u along the part 0..1, v = angle/360 around it]; [[u,0],[u,1]] is a full ring.')
                                }
                            },
                            widthMeters: num('Width of the groove or bead.', 0),
                            depthMeters: num('Negative cuts a groove, positive raises a bead.'),
                            sharpness: num('0 rounded, toward 0.95 crisp and flat-bottomed.', 0, 0.95)
                        },
                        required: ['targetPartId', 'curves', 'widthMeters', 'depthMeters', 'sharpness']
                    }
                },
                required: ['id', 'label'],
                propertyOrdering: ['id', 'label', 'parentId', 'attach', 'mirrorPlaneNormal', 'sweep', 'revolve', 'replicate', 'relief']
            }
        }
    },
    required: ['subject', 'observations', 'boundingMeters', 'expectedBodies', 'parts'],
    propertyOrdering: ['subject', 'observations', 'boundingMeters', 'expectedBodies', 'parts']
};

// ---------------------------------------------------------------------------
// Validation (reports every problem; never repairs)
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function isFiniteNumber(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Absent and null both mean "not given" for optional fields. */
function given(v: unknown): boolean {
    return v !== undefined && v !== null;
}

/**
 * Checks a spec against the contract the interpreter relies on. Returns every problem found, each naming the
 * field, so a model can correct them in one pass. An empty list means the spec can be built.
 */
export function validateObjectBuildSpec(input: unknown): string[] {
    const errors: string[] = [];
    if (!isRecord(input)) return ['spec must be a JSON object'];
    const spec = input;

    if (typeof spec.subject !== 'string' || !spec.subject.trim()) errors.push('subject must be a non-empty string');
    if (!Array.isArray(spec.observations) || spec.observations.some(o => typeof o !== 'string')) {
        errors.push('observations must be an array of strings');
    }
    let reach = Infinity;
    if (!isVec3(spec.boundingMeters)) {
        errors.push('boundingMeters must be [width, height, depth] in metres');
    } else {
        const b = spec.boundingMeters as number[];
        if (b.some(x => x <= 0 || x > OBJECT_SPEC_LIMITS.maxBoundingMeters)) {
            errors.push(`boundingMeters values must be greater than 0 and at most ${OBJECT_SPEC_LIMITS.maxBoundingMeters} m`);
        } else {
            reach = Math.max(...b) * OBJECT_SPEC_LIMITS.coordinateReachFactor;
        }
    }
    if (!Number.isInteger(spec.expectedBodies) || (spec.expectedBodies as number) < 1) {
        errors.push('expectedBodies must be an integer of at least 1');
    }
    if (!Array.isArray(spec.parts) || spec.parts.length === 0) {
        errors.push('parts must be a non-empty array');
        return errors;
    }
    if (spec.parts.length > OBJECT_SPEC_LIMITS.maxParts) {
        errors.push(`parts has ${spec.parts.length} entries; at most ${OBJECT_SPEC_LIMITS.maxParts} are allowed`);
    }

    const parts = spec.parts as unknown[];
    const byId = new Map<string, Record<string, unknown>>();
    const operatorOf = new Map<string, OperatorKey>();
    parts.forEach((raw, index) => {
        if (!isRecord(raw)) {
            errors.push(`parts[${index}] must be an object`);
            return;
        }
        const where = typeof raw.id === 'string' && raw.id ? `part "${raw.id}"` : `parts[${index}]`;
        if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
            errors.push(`${where}: id must be 1-64 letters, digits, "_", "." or "-"`);
        } else if (byId.has(raw.id)) {
            errors.push(`${where}: id is used by more than one part`);
        } else {
            byId.set(raw.id, raw);
        }
        if (typeof raw.label !== 'string') errors.push(`${where}: label must be a string`);
        const present = OPERATOR_KEYS.filter(k => given(raw[k]));
        if (present.length !== 1) {
            errors.push(`${where}: must have exactly one of ${OPERATOR_KEYS.join(', ')} (found ${present.length ? present.join(', ') : 'none'})`);
        } else if (typeof raw.id === 'string') {
            operatorOf.set(raw.id, present[0]);
        }
        if (given(raw.mirrorPlaneNormal) && !isNonZeroVec3(raw.mirrorPlaneNormal)) {
            errors.push(`${where}: mirrorPlaneNormal must be a non-zero [x, y, z] vector`);
        }
    });

    const pointInReach = (p: number[], where: string, field: string) => {
        if (p.some(x => Math.abs(x) > reach)) {
            errors.push(`${where}: ${field} [${p.join(', ')}] lies far outside boundingMeters; coordinates are metres`);
        }
    };

    for (const [id, part] of byId) {
        const where = `part "${id}"`;
        const op = operatorOf.get(id);
        const geometric = op === 'sweep' || op === 'revolve';

        // Attachment
        if (given(part.parentId)) {
            if (op && !geometric) {
                errors.push(`${where}: a ${op} part has no geometry of its own, so it cannot attach to a parent; remove parentId and attach`);
            } else if (typeof part.parentId !== 'string' || !byId.has(part.parentId)) {
                errors.push(`${where}: parentId "${String(part.parentId)}" does not name a part`);
            } else if (part.parentId === id) {
                errors.push(`${where}: a part cannot be its own parent`);
            } else {
                const parentOp = operatorOf.get(part.parentId);
                if (parentOp !== 'sweep' && parentOp !== 'revolve') {
                    errors.push(`${where}: parent "${part.parentId}" is a ${parentOp ?? 'invalid'} part; attach to a sweep or revolve part`);
                }
            }
            if (!isRecord(part.attach)) {
                errors.push(`${where}: attach {u, angleDeg, normalOffsetMeters} is required with parentId`);
            } else {
                const a = part.attach;
                if (!isFiniteNumber(a.u) || a.u < 0 || a.u > 1) errors.push(`${where}: attach.u must be between 0 and 1`);
                if (!isFiniteNumber(a.angleDeg)) errors.push(`${where}: attach.angleDeg must be a number`);
                if (!isFiniteNumber(a.normalOffsetMeters) || Math.abs(a.normalOffsetMeters) > reach) {
                    errors.push(`${where}: attach.normalOffsetMeters must be a number within the object's size`);
                }
            }
        } else if (given(part.attach)) {
            errors.push(`${where}: attach is given without parentId`);
        }

        const isChild = given(part.parentId);
        if (op === 'sweep') validateSweep(part.sweep, where, isChild, errors, pointInReach);
        if (op === 'revolve') validateRevolve(part.revolve, where, isChild, errors, pointInReach);
        if (op === 'replicate') validateReplicate(part.replicate, id, where, byId, operatorOf, errors, pointInReach);
        if (op === 'relief') validateRelief(part.relief, where, byId, operatorOf, errors, reach);
    }

    // Parent chains must end at a root.
    for (const id of byId.keys()) {
        const seen = new Set<string>();
        let cur: string | undefined = id;
        while (cur !== undefined) {
            if (seen.has(cur)) {
                errors.push(`part "${id}": parentId chain forms a cycle (${[...seen].join(' -> ')})`);
                break;
            }
            seen.add(cur);
            const parent: unknown = byId.get(cur)?.parentId;
            cur = typeof parent === 'string' && byId.has(parent) ? parent : undefined;
        }
    }

    // Each part may be the seed of one replicate, and replicate chains must not loop.
    const seedUse = new Map<string, string>();
    for (const [id, part] of byId) {
        if (operatorOf.get(id) !== 'replicate' || !isRecord(part.replicate)) continue;
        const seed = part.replicate.seedPartId;
        if (typeof seed !== 'string') continue;
        const previous = seedUse.get(seed);
        if (previous) errors.push(`part "${id}": seed "${seed}" is already copied by "${previous}"; each part can seed one replicate`);
        else seedUse.set(seed, id);
    }
    for (const start of seedUse.values()) {
        const seen = new Set<string>();
        let cur: string | undefined = start;
        while (cur !== undefined && operatorOf.get(cur) === 'replicate') {
            if (seen.has(cur)) {
                errors.push(`part "${start}": replicate seeds form a cycle (${[...seen].join(' -> ')})`);
                break;
            }
            seen.add(cur);
            const rep: unknown = byId.get(cur)?.replicate;
            cur = isRecord(rep) && typeof rep.seedPartId === 'string' ? rep.seedPartId : undefined;
        }
    }

    if (errors.length === 0) {
        const instances = countInstances(spec as unknown as ObjectBuildSpec);
        if (instances > OBJECT_SPEC_LIMITS.maxTotalInstances) {
            errors.push(`the spec emits ${instances} part instances after replicate and mirror; at most ${OBJECT_SPEC_LIMITS.maxTotalInstances} are allowed`);
        }
    }
    return errors;
}

function isVec3(v: unknown): v is Vec3 {
    return Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);
}

function isNonZeroVec3(v: unknown): v is Vec3 {
    return isVec3(v) && Math.hypot(v[0], v[1], v[2]) > 1e-9;
}

function isPair(v: unknown): v is [number, number] {
    return Array.isArray(v) && v.length === 2 && v.every(isFiniteNumber);
}

function validateSweep(
    sweep: unknown,
    where: string,
    isChild: boolean,
    errors: string[],
    pointInReach: (p: number[], where: string, field: string) => void
): void {
    if (!isRecord(sweep)) {
        errors.push(`${where}: sweep must be an object`);
        return;
    }
    const pts = sweep.controlPoints;
    if (!Array.isArray(pts) || pts.length < 2 || pts.length > OBJECT_SPEC_LIMITS.maxPoints || !pts.every(isVec3)) {
        errors.push(`${where}: sweep.controlPoints must be 2-${OBJECT_SPEC_LIMITS.maxPoints} [x, y, z] points`);
    } else {
        for (let i = 1; i < pts.length; i++) {
            const [a, b] = [pts[i - 1] as Vec3, pts[i] as Vec3];
            if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6) {
                errors.push(`${where}: sweep.controlPoints ${i - 1} and ${i} coincide`);
            }
        }
        pts.forEach((p, i) => pointInReach(p as number[], where, `sweep.controlPoints[${i}]`));
        if (sweep.closedLoop === true && pts.length < 3) errors.push(`${where}: a closed sweep needs at least 3 control points`);
        // A child starts where it attaches; that is what keeps it joined to its parent.
        if (isChild && Math.hypot(...(pts[0] as Vec3)) > 1e-6) {
            errors.push(`${where}: a child sweep starts at its attach point, so controlPoints[0] must be [0, 0, 0]`);
        }
    }
    if (typeof sweep.closedLoop !== 'boolean') errors.push(`${where}: sweep.closedLoop must be true or false`);
    if (!isFiniteNumber(sweep.smoothing) || sweep.smoothing < 0 || sweep.smoothing > 1) errors.push(`${where}: sweep.smoothing must be between 0 and 1`);
    const profile = sweep.profile;
    if (!Array.isArray(profile) || profile.length < 1 || profile.length > OBJECT_SPEC_LIMITS.maxProfileKeys) {
        errors.push(`${where}: sweep.profile must have 1-${OBJECT_SPEC_LIMITS.maxProfileKeys} keys`);
    } else {
        const ts: number[] = [];
        profile.forEach((key, i) => {
            if (!isRecord(key)) {
                errors.push(`${where}: sweep.profile[${i}] must be an object`);
                return;
            }
            if (!isFiniteNumber(key.t) || key.t < 0 || key.t > 1) errors.push(`${where}: sweep.profile[${i}].t must be between 0 and 1`);
            else ts.push(key.t);
            if (!isFiniteNumber(key.widthMeters) || key.widthMeters <= 0) errors.push(`${where}: sweep.profile[${i}].widthMeters must be greater than 0`);
            if (!isFiniteNumber(key.heightMeters) || key.heightMeters <= 0) errors.push(`${where}: sweep.profile[${i}].heightMeters must be greater than 0`);
            if (!isFiniteNumber(key.exponent) || key.exponent < 0.5 || key.exponent > 12) errors.push(`${where}: sweep.profile[${i}].exponent must be between 0.5 and 12`);
        });
        if (new Set(ts).size !== ts.length) errors.push(`${where}: sweep.profile keys must have distinct t values`);
    }
    if (given(sweep.twistDegAlong)) {
        const twist = sweep.twistDegAlong;
        if (!Array.isArray(twist) || twist.length > OBJECT_SPEC_LIMITS.maxProfileKeys || !twist.every(isPair) || twist.some(p => (p as number[])[0] < 0 || (p as number[])[0] > 1)) {
            errors.push(`${where}: sweep.twistDegAlong must be [t, degrees] pairs with t between 0 and 1`);
        } else if (new Set(twist.map(p => (p as number[])[0])).size !== twist.length) {
            errors.push(`${where}: sweep.twistDegAlong must have distinct t values`);
        }
    }
    if (given(sweep.modulation)) {
        const m = sweep.modulation;
        if (!isRecord(m) || !isFiniteNumber(m.amplitudeMeters) || !isFiniteNumber(m.cyclesPerMeter) || m.cyclesPerMeter < 0 ||
            !Number.isInteger(m.cyclesAround) || (m.cyclesAround as number) < 0) {
            errors.push(`${where}: sweep.modulation needs amplitudeMeters, cyclesPerMeter >= 0 and an integer cyclesAround >= 0`);
        } else if (Array.isArray(profile) && profile.every(isRecord)) {
            const thinnest = Math.min(...profile.map(k => Math.min(Number(k.widthMeters), Number(k.heightMeters))));
            if (Math.abs(m.amplitudeMeters) >= thinnest / 2) {
                errors.push(`${where}: sweep.modulation.amplitudeMeters must be smaller than half the thinnest section (${(thinnest / 2).toFixed(4)} m)`);
            }
        }
    }
}

function validateRevolve(
    revolve: unknown,
    where: string,
    isChild: boolean,
    errors: string[],
    pointInReach: (p: number[], where: string, field: string) => void
): void {
    if (!isRecord(revolve)) {
        errors.push(`${where}: revolve must be an object`);
        return;
    }
    if (!isVec3(revolve.axisOrigin)) errors.push(`${where}: revolve.axisOrigin must be [x, y, z]`);
    else if (isChild && Math.hypot(...revolve.axisOrigin) > 1e-6) errors.push(`${where}: a child revolve's axis passes through its attach point, so axisOrigin must be [0, 0, 0]`);
    else pointInReach(revolve.axisOrigin, where, 'revolve.axisOrigin');
    if (!isNonZeroVec3(revolve.axisDirection)) errors.push(`${where}: revolve.axisDirection must be a non-zero [x, y, z] vector`);
    const m = revolve.meridian;
    if (!Array.isArray(m) || m.length < 2 || m.length > OBJECT_SPEC_LIMITS.maxPoints || !m.every(isPair)) {
        errors.push(`${where}: revolve.meridian must be 2-${OBJECT_SPEC_LIMITS.maxPoints} [axial, radius] points`);
    } else {
        const pairs = m as Array<[number, number]>;
        if (pairs.some(p => p[1] < 0)) errors.push(`${where}: revolve.meridian radii must be 0 or more`);
        if (pairs.every(p => p[1] <= 1e-9)) errors.push(`${where}: revolve.meridian needs at least one radius greater than 0`);
        for (let i = 1; i < pairs.length; i++) {
            if (Math.hypot(pairs[i][0] - pairs[i - 1][0], pairs[i][1] - pairs[i - 1][1]) < 1e-6) {
                errors.push(`${where}: revolve.meridian points ${i - 1} and ${i} coincide`);
            }
        }
        pairs.forEach((p, i) => pointInReach(p, where, `revolve.meridian[${i}]`));
        const axial = pairs.map(p => p[0]);
        if (isChild && (Math.min(...axial) > 1e-6 || Math.max(...axial) < -1e-6)) {
            errors.push(`${where}: a child revolve must reach its attach point: its meridian's axial distances must span 0`);
        }
    }
    if (!isFiniteNumber(revolve.smoothing) || revolve.smoothing < 0 || revolve.smoothing > 1) errors.push(`${where}: revolve.smoothing must be between 0 and 1`);
    if (!Number.isInteger(revolve.lobeCount) || (revolve.lobeCount as number) < 0 || (revolve.lobeCount as number) > OBJECT_SPEC_LIMITS.maxLobes) {
        errors.push(`${where}: revolve.lobeCount must be an integer from 0 to ${OBJECT_SPEC_LIMITS.maxLobes}`);
    }
    if (!isFiniteNumber(revolve.lobeDepthRatio) || revolve.lobeDepthRatio < 0 || revolve.lobeDepthRatio > 0.9) {
        errors.push(`${where}: revolve.lobeDepthRatio must be between 0 and 0.9`);
    }
    if (!isFiniteNumber(revolve.helixPitchMeters)) errors.push(`${where}: revolve.helixPitchMeters must be a number (0 for no helix)`);
}

function validateReplicate(
    replicate: unknown,
    id: string,
    where: string,
    byId: Map<string, Record<string, unknown>>,
    operatorOf: Map<string, OperatorKey>,
    errors: string[],
    pointInReach: (p: number[], where: string, field: string) => void
): void {
    if (!isRecord(replicate)) {
        errors.push(`${where}: replicate must be an object`);
        return;
    }
    const seed = replicate.seedPartId;
    if (typeof seed !== 'string' || !byId.has(seed)) {
        errors.push(`${where}: replicate.seedPartId "${String(seed)}" does not name a part`);
    } else if (seed === id) {
        errors.push(`${where}: a replicate cannot copy itself`);
    } else if (operatorOf.get(seed) === 'relief') {
        errors.push(`${where}: replicate.seedPartId "${seed}" is a relief part, which has no geometry to copy`);
    }
    const hasRing = given(replicate.ring);
    const hasPath = given(replicate.path);
    if (hasRing === hasPath) {
        errors.push(`${where}: replicate needs exactly one of ring or path`);
        return;
    }
    if (hasRing) {
        const r = replicate.ring;
        if (!isRecord(r)) {
            errors.push(`${where}: replicate.ring must be an object`);
            return;
        }
        if (!isVec3(r.centerMeters)) errors.push(`${where}: replicate.ring.centerMeters must be [x, y, z]`);
        else pointInReach(r.centerMeters, where, 'replicate.ring.centerMeters');
        if (!isNonZeroVec3(r.axisDirection)) errors.push(`${where}: replicate.ring.axisDirection must be a non-zero vector`);
        if (!Number.isInteger(r.count) || (r.count as number) < 2 || (r.count as number) > OBJECT_SPEC_LIMITS.maxCopies) {
            errors.push(`${where}: replicate.ring.count must be an integer from 2 to ${OBJECT_SPEC_LIMITS.maxCopies}`);
        }
        if (!isFiniteNumber(r.spanDeg) || r.spanDeg <= 0 || r.spanDeg > 3600) errors.push(`${where}: replicate.ring.spanDeg must be greater than 0 and at most 3600`);
        if (!isFiniteNumber(r.risePerCopyMeters)) errors.push(`${where}: replicate.ring.risePerCopyMeters must be a number`);
    } else {
        const p = replicate.path;
        if (!isRecord(p)) {
            errors.push(`${where}: replicate.path must be an object`);
            return;
        }
        if (!Array.isArray(p.points) || p.points.length < 2 || p.points.length > OBJECT_SPEC_LIMITS.maxPoints || !p.points.every(isVec3)) {
            errors.push(`${where}: replicate.path.points must be 2-${OBJECT_SPEC_LIMITS.maxPoints} [x, y, z] points`);
        } else {
            const pts = p.points as Vec3[];
            for (let i = 1; i < pts.length; i++) {
                if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]) < 1e-6) {
                    errors.push(`${where}: replicate.path.points ${i - 1} and ${i} coincide`);
                }
            }
            pts.forEach((pt, i) => pointInReach(pt, where, `replicate.path.points[${i}]`));
        }
        if (!Number.isInteger(p.count) || (p.count as number) < 2 || (p.count as number) > OBJECT_SPEC_LIMITS.maxCopies) {
            errors.push(`${where}: replicate.path.count must be an integer from 2 to ${OBJECT_SPEC_LIMITS.maxCopies}`);
        }
        if (typeof p.orientToPath !== 'boolean') errors.push(`${where}: replicate.path.orientToPath must be true or false`);
    }
}

function validateRelief(
    relief: unknown,
    where: string,
    byId: Map<string, Record<string, unknown>>,
    operatorOf: Map<string, OperatorKey>,
    errors: string[],
    reach: number
): void {
    if (!isRecord(relief)) {
        errors.push(`${where}: relief must be an object`);
        return;
    }
    const target = relief.targetPartId;
    if (typeof target !== 'string' || !byId.has(target)) {
        errors.push(`${where}: relief.targetPartId "${String(target)}" does not name a part`);
    } else {
        const op = operatorOf.get(target);
        if (op !== 'sweep' && op !== 'revolve') errors.push(`${where}: relief.targetPartId "${target}" is a ${op ?? 'invalid'} part; relief needs a sweep or revolve surface`);
    }
    const curves = relief.curves;
    if (!Array.isArray(curves) || curves.length < 1 || curves.length > OBJECT_SPEC_LIMITS.maxCurves) {
        errors.push(`${where}: relief.curves must hold 1-${OBJECT_SPEC_LIMITS.maxCurves} polylines`);
    } else {
        curves.forEach((curve, i) => {
            if (!Array.isArray(curve) || curve.length < 2 || curve.length > OBJECT_SPEC_LIMITS.maxPoints || !curve.every(isPair)) {
                errors.push(`${where}: relief.curves[${i}] must be 2-${OBJECT_SPEC_LIMITS.maxPoints} [u, v] points`);
            } else if ((curve as Array<[number, number]>).some(([u, v]) => u < 0 || u > 1 || Math.abs(v) > 64)) {
                errors.push(`${where}: relief.curves[${i}] u values must be between 0 and 1 (v is turns around the part)`);
            }
        });
    }
    if (!isFiniteNumber(relief.widthMeters) || relief.widthMeters <= 0 || relief.widthMeters > reach) errors.push(`${where}: relief.widthMeters must be greater than 0 and within the object's size`);
    if (!isFiniteNumber(relief.depthMeters) || relief.depthMeters === 0) errors.push(`${where}: relief.depthMeters must be a non-zero number`);
    else if (isFiniteNumber(relief.widthMeters) && Math.abs(relief.depthMeters) > relief.widthMeters * 4) {
        errors.push(`${where}: relief.depthMeters must be at most four times widthMeters`);
    }
    if (!isFiniteNumber(relief.sharpness) || relief.sharpness < 0 || relief.sharpness > 0.95) errors.push(`${where}: relief.sharpness must be between 0 and 0.95`);
}

/** How many part instances the spec emits after replicate and mirror (a validated spec is assumed). */
export function countInstances(spec: ObjectBuildSpec): number {
    const byId = new Map(spec.parts.map(p => [p.id, p]));
    const children = new Map<string, string[]>();
    for (const p of spec.parts) {
        if (p.parentId) children.set(p.parentId, [...(children.get(p.parentId) || []), p.id]);
    }
    const seeds = new Set(spec.parts.filter(p => p.replicate).map(p => p.replicate!.seedPartId));
    const emitted = (id: string, depth = 0): number => {
        const part = byId.get(id);
        if (!part || part.relief || depth > OBJECT_SPEC_LIMITS.maxParts) return 0;
        let n: number;
        if (part.replicate) {
            const copies = part.replicate.ring?.count ?? part.replicate.path?.count ?? 1;
            n = copies * emitted(part.replicate.seedPartId, depth + 1);
        } else {
            n = 1 + (children.get(id) || []).filter(c => !seeds.has(c)).reduce((s, c) => s + emitted(c, depth + 1), 0);
        }
        return part.mirrorPlaneNormal ? n * 2 : n;
    };
    return spec.parts
        .filter(p => !p.parentId && !seeds.has(p.id))
        .reduce((s, p) => s + emitted(p.id), 0);
}

/**
 * The spec as a Python literal, for a build script a person or the agent can read and edit. Strings are written
 * as JSON string literals, which Python reads the same way, so no value can break out of the literal.
 */
export function toPythonLiteral(value: unknown, indent = 0): string {
    const pad = (n: number) => ' '.repeat(n);
    if (value === null || value === undefined) return 'None';
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`Cannot write non-finite number ${value} into a build script`);
        return JSON.stringify(value);
    }
    if (typeof value === 'string') return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    if (Array.isArray(value)) {
        if (value.every(v => typeof v === 'number')) return `[${value.map(v => toPythonLiteral(v)).join(', ')}]`;
        if (value.length === 0) return '[]';
        return `[\n${value.map(v => pad(indent + 4) + toPythonLiteral(v, indent + 4)).join(',\n')}\n${pad(indent)}]`;
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
        if (entries.length === 0) return '{}';
        return `{\n${entries.map(([k, v]) => `${pad(indent + 4)}${JSON.stringify(k)}: ${toPythonLiteral(v, indent + 4)}`).join(',\n')}\n${pad(indent)}}`;
    }
    throw new Error(`Cannot write a ${typeof value} into a build script`);
}

/**
 * The build script stored with the scene (data.pythonGenerator.sourceCode): running it rebuilds the object from SPEC.
 * The object is changed through build_3d_object_from_reference with the edited spec, which keeps it at its place.
 */
export function buildObjectSpecScript(spec: ObjectBuildSpec): string {
    return [
        '# Built by build_3d_object_from_reference from SPEC (metres, +Y up). To change the object, pass the edited',
        '# spec to build_3d_object_from_reference as specJson (with its location and placement when it stands at a place).',
        'import scratchbox as sb',
        '',
        `SPEC = ${toPythonLiteral(spec)}`,
        '',
        'sb.io.write_glb(OUTPUT_GLB_PATH, sb.object_spec.build(SPEC))',
        ''
    ].join('\n');
}
