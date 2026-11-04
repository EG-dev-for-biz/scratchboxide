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
 *   crown      a branching crown grown, not modelled: an SB-Veggie tree (space colonisation inside the described crown
 *              envelope, SB-Veggie leaf clusters, levels of detail; scratchbox_sb_veggie_grove.hpp), for every tree,
 *              shrub or other branching living crown. Branches and foliage are never swept or revolved.
 * Labels are diagnostic text and nothing branches on them. A child part attaches by parameter on its
 * parent's evaluated surface, so connections hold by construction instead of by guessed coordinates.
 *
 * A sweep or revolve part may carry a `material`: its surface as continuous physical factors (linear RGB albedo,
 * roughness, metalness, transmission, index of refraction, clearcoat, emission). There is no material type or
 * preset: glass, brushed steel, enamel paint and an alien seed husk are all points in the same factor space, and
 * `description` is diagnostic text that nothing reads. The interpreter writes these factors into each part's glTF
 * material (factors only, no texture maps); a clay build ignores them and gives every part studio clay.
 */

import { expandBlueprintParts, validateBlueprintLoft, validateOutlines, type BlueprintLoft, type LoftSection, type ObjectOutlines } from './blueprint-loft';

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
    /**
     * In place of controlPoints and profile: the slice of the spec's blueprint this part is lofted from, straight along
     * Z through the blueprint's stations (blueprint-loft.ts). A root part only; the spec must carry blueprint.
     */
    fromBlueprint?: BlueprintLoft;
    /** The rings a fromBlueprint block expands to for the build (never authored; not kept in a stored spec). */
    sections?: LoftSection[];
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

/**
 * A part's surface as physical factors, the glTF 2.0 metallic-roughness model plus the clearcoat, transmission, ior
 * and emissive_strength extensions. All colours are linear RGB in 0..1 (not sRGB: an sRGB value v/255 is about
 * (v/255)^2.2 linear).
 */
export interface PartMaterial {
    /** Linear RGB albedo of a dielectric, or specular colour of a metal, 0..1 each. */
    baseColor: Vec3;
    /** 0 mirror-smooth .. 1 fully diffuse. */
    roughness: number;
    /** 0 dielectric .. 1 bare metal. */
    metalness: number;
    /** 0 opaque .. 1 fully see-through (light passes through the surface, tinted by baseColor). */
    transmission: number;
    /** Index of refraction, 1..3 (glTF default 1.5). */
    ior?: number;
    /** Strength of a clear lacquer layer over the surface, 0..1. */
    clearcoat?: number;
    /** Linear RGB colour the surface emits, 0..1 each. */
    emissive?: Vec3;
    /** Multiplier on `emissive` (glTF KHR_materials_emissive_strength), 0..MATERIAL_LIMITS.maxEmissiveStrength. */
    emissiveStrength?: number;
    /** What the surface looks like, in words (diagnostic only; nothing reads it). */
    description?: string;
}

/** Ranges every material factor is validated against. */
export const MATERIAL_LIMITS = {
    minIor: 1,
    maxIor: 3,
    maxEmissiveStrength: 100
} as const;

/**
 * A branching crown, grown as an SB-Veggie tree from its envelope (metres): the trunk base, the height to the crown
 * top, the crown's half spreads, and optionally where the crown begins, where it is widest (0 its base .. 1 its top),
 * the top's profile exponent (1 a cone, 2 a dome, more a flat top) and the trunk radius. A crown part is a root part
 * (no parent, no mirror, not a replicate seed); its material's baseColor, when given, is the foliage colour.
 */
export interface CrownOperator {
    trunkBaseMeters: Vec3;
    heightMeters: number;
    crownRadiiMeters: [number, number];
    crownBaseHeightMeters?: number;
    crownWidestAt?: number;
    crownTopExponent?: number;
    trunkRadiusMeters?: number;
}

export interface ObjectPartSpec {
    id: string;
    label: string;
    /** Surface factors of a sweep or revolve part (and its replicated and mirrored copies). */
    material?: PartMaterial;
    parentId?: string;
    attach?: PartAttachment;
    /** Also emit this part (and what is attached to it) reflected across the plane through the origin with this normal. */
    mirrorPlaneNormal?: Vec3;
    /**
     * Radius of the part's rounded edges in metres (sweep and revolve parts): a revolve's sharp corners are filleted and
     * a sweep's section corners and open ends rounded at it. 0 keeps the edges sharp; omitted, the build uses about 1.5 %
     * of the part's smallest dimension, clamped to OBJECT_SPEC_LIMITS.minEdgeRadiusMeters..maxEdgeRadiusMeters (and at
     * most 5 % of a part under 4 cm). Generated, never measured.
     */
    edgeRadiusMeters?: number;
    sweep?: SweepOperator;
    revolve?: RevolveOperator;
    replicate?: ReplicateOperator;
    relief?: ReliefOperator;
    crown?: CrownOperator;
}

export interface ObjectBuildSpec {
    subject: string;
    /** Overall width (X), height (Y) and depth (Z) of the object in metres. */
    boundingMeters: Vec3;
    /** How many separate pieces the object is meant to be (1 when everything is joined); each crown part is one piece. */
    expectedBodies: number;
    observations: string[];
    parts: ObjectPartSpec[];
    /** The object's blueprint outlines (object_blueprint_outlines), which fromBlueprint parts are lofted from. */
    blueprint?: ObjectOutlines;
}

/**
 * metadata.source of every object build_3d_object_from_reference adds to a scene; such an object also carries its
 * own spec (and placement, at a place) in metadata.objectBuild, so each object in a scene can be changed later.
 */
export const OBJECT_BUILD_SOURCE = 'build_3d_object_from_reference';

/** What a built object keeps about itself in its scene object's metadata.objectBuild. */
export interface BuiltObjectRecord {
    spec: ObjectBuildSpec;
    /** Set when it was built all in studio clay (on request); otherwise its parts carry their materials. */
    clay?: boolean;
    /** Where it stands, when it was staged at a place (east, north and heading relative to the place's anchor). */
    placement?: { eastMeters: number; northMeters: number; headingDeg: number; surfaceYMeters: number };
}

export const OPERATOR_KEYS = ['sweep', 'revolve', 'replicate', 'relief', 'crown'] as const;
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
    /** Edge radius range (object_spec.py EDGE_RADIUS_MIN / EDGE_RADIUS_MAX); 0 is also allowed, for a sharp part. */
    minEdgeRadiusMeters: 0.002,
    maxEdgeRadiusMeters: 0.05,
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

const unit = (description: string) => num(description, 0, 1);
const rgb = (description: string): Record<string, unknown> => ({ ...tuple(3, description), items: { type: 'number', minimum: 0, maximum: 1 } });

/** The material block of a part, as stated to the vision model. */
export const PART_MATERIAL_JSON_SCHEMA: Record<string, unknown> = {
    type: 'object',
    description: 'The surface of this sweep or revolve part as physical factors read from the picture (also used by its copies). Not for replicate or relief parts.',
    properties: {
        description: { type: 'string', description: 'The surface in a few words, e.g. "gloss red enamel paint" (diagnostic only).' },
        baseColor: rgb('LINEAR RGB 0..1 of the surface colour (for a metal, its tint), not sRGB: convert each sRGB channel v/255 to about (v/255)^2.2.'),
        roughness: unit('0 mirror-smooth, 0.3 satin, 0.6 matte, 1 chalky.'),
        metalness: unit('1 for bare metal, 0 for everything else (paint, plastic, glass, stone, wood, organic tissue).'),
        transmission: unit('How much light passes through: 0 opaque, about 0.9-1 for clear glass, clear liquid or transparent plastic.'),
        ior: num('Index of refraction: about 1.33 water, 1.45-1.55 glass and plastics, 2.4 diamond. Omit for the 1.5 default.', MATERIAL_LIMITS.minIor, MATERIAL_LIMITS.maxIor),
        clearcoat: unit('Clear lacquer over the surface: 1 for glossy car paint or varnish, else omit or 0.'),
        emissive: rgb('Only for surfaces that glow: the LINEAR RGB colour they emit.'),
        emissiveStrength: num('Only with emissive: brightness multiplier (1 a dim glow, 5-20 a bright lamp).', 0, MATERIAL_LIMITS.maxEmissiveStrength)
    },
    required: ['baseColor', 'roughness', 'metalness', 'transmission'],
    propertyOrdering: ['description', 'baseColor', 'roughness', 'metalness', 'transmission', 'ior', 'clearcoat', 'emissive', 'emissiveStrength']
};

/**
 * The spec's schema as given to the vision model (kept to the JSON Schema subset Gemini understands). Rules a
 * schema cannot state, such as "exactly one operator block per part", are enforced by `validateObjectBuildSpec`.
 * With `materials: false` (a clay build) parts have no material block to fill.
 */
export function objectBuildSpecJsonSchema(options: { materials: boolean; blueprint?: boolean }): Record<string, unknown> {
    const base = options.blueprint ? withBlueprintSweeps(OBJECT_BUILD_SPEC_JSON_SCHEMA as any) : OBJECT_BUILD_SPEC_JSON_SCHEMA as any;
    if (!options.materials) return base;
    const items = base.properties.parts.items;
    return {
        ...base,
        properties: {
            ...base.properties,
            parts: {
                ...base.properties.parts,
                items: {
                    ...items,
                    properties: { ...items.properties, material: PART_MATERIAL_JSON_SCHEMA },
                    propertyOrdering: [...items.propertyOrdering, 'material']
                }
            }
        }
    };
}

/** The schema with a sweep's fromBlueprint block, which stands in for its controlPoints and profile. */
function withBlueprintSweeps(base: any): any {
    const items = base.properties.parts.items;
    const sweep = items.properties.sweep;
    const m = (d: string) => num(d);
    return {
        ...base,
        properties: {
            ...base.properties,
            parts: {
                ...base.properties.parts,
                items: {
                    ...items,
                    properties: {
                        ...items.properties,
                        sweep: {
                            ...sweep,
                            properties: {
                                ...sweep.properties,
                                fromBlueprint: {
                                    type: 'object',
                                    description: 'Root parts only, in place of controlPoints and profile: loft this part straight along Z through the blueprint\'s stations, each section the blueprint\'s outline there. Every field is optional and narrows the slice.',
                                    properties: {
                                        yFromMeters: m('Lowest height kept.'),
                                        yToMeters: m('Highest height kept.'),
                                        fromTopMeters: m('Keep only this depth under the outline\'s top at each station (a roof panel).'),
                                        zFromMeters: m('Rearmost station kept.'),
                                        zToMeters: m('Frontmost station kept.'),
                                        insetMeters: m('Shrink the half width by this much; negative grows it.'),
                                        clearances: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: { zMeters: m('Circle centre along the length.'), yMeters: m('Circle centre height.'), radiusMeters: m('Circle radius.') },
                                                required: ['zMeters', 'yMeters', 'radiusMeters']
                                            },
                                            description: 'Circles (side view) the underside is lifted over, such as a wheel arch round its hub.'
                                        }
                                    }
                                }
                            },
                            required: []
                        }
                    }
                }
            }
        }
    };
}

/** The spec's schema without material blocks (geometry only); objectBuildSpecJsonSchema adds them. */
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
        expectedBodies: { type: 'integer', minimum: 1, description: 'How many separate pieces the object is meant to be; 1 when everything is joined; each crown part counts as one piece.' },
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
                    edgeRadiusMeters: num(`Optional, sweep and revolve parts: radius of the part's rounded edges in metres, as the picture shows them (cast, moulded and worn edges are soft; machined and sheet edges small). 0 keeps them sharp (a blade, a knife edge); omit for the default, about 1.5 % of the part's smallest dimension. At most ${OBJECT_SPEC_LIMITS.maxEdgeRadiusMeters}.`, 0, OBJECT_SPEC_LIMITS.maxEdgeRadiusMeters),
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
                    },
                    crown: {
                        type: 'object',
                        description: 'A tree, shrub or any branching living crown: grown as an SB-Veggie tree (branching and foliage grown inside this envelope), never modelled with sweep or revolve. A root part only.',
                        properties: {
                            trunkBaseMeters: vec3('[x, y, z] where the trunk meets the ground, absolute metres.'),
                            heightMeters: num('Trunk base to the top of the crown.', 0),
                            crownRadiiMeters: tuple(2, '[half spread along X, half spread along Z] of the crown in metres.'),
                            crownBaseHeightMeters: num('Height of the lowest crown branches above the trunk base; omit when it cannot be seen.', 0),
                            crownWidestAt: num('Share of the crown depth where it is widest: 0 a cone widest at its base, 0.5 round, 0.8 an umbrella.', 0, 0.9),
                            crownTopExponent: num('Shape of the crown top: 1 a cone, 2 a dome, 4 flat.', 0.5, 8),
                            trunkRadiusMeters: num('Trunk radius above the root flare; omit when it cannot be seen.', 0)
                        },
                        required: ['trunkBaseMeters', 'heightMeters', 'crownRadiiMeters']
                    }
                },
                required: ['id', 'label'],
                propertyOrdering: ['id', 'label', 'parentId', 'attach', 'mirrorPlaneNormal', 'edgeRadiusMeters', 'sweep', 'revolve', 'replicate', 'relief', 'crown']
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
export function validateObjectBuildSpec(input: unknown, options: { requireMaterials?: boolean } = {}): string[] {
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
    if (given(spec.blueprint)) errors.push(...validateOutlines(spec.blueprint));
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
        const geometric = present.length === 1 && (present[0] === 'sweep' || present[0] === 'revolve');
        if (given(raw.edgeRadiusMeters)) {
            const r = raw.edgeRadiusMeters;
            if (present.length === 1 && !geometric) {
                errors.push(`${where}: a ${present[0]} part has no edges of its own, so it cannot have an edgeRadiusMeters`);
            } else if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > OBJECT_SPEC_LIMITS.maxEdgeRadiusMeters) {
                errors.push(`${where}: edgeRadiusMeters must be 0 (sharp) to ${OBJECT_SPEC_LIMITS.maxEdgeRadiusMeters} metres`);
            }
        }
        const crown = present.length === 1 && present[0] === 'crown';
        if (given(raw.material)) {
            if (present.length === 1 && !geometric && !crown) {
                errors.push(`${where}: a ${present[0]} part has no surface of its own, so it cannot have a material; give the material to the part it ${present[0] === 'replicate' ? 'copies' : 'cuts into'}`);
            } else {
                validatePartMaterial(raw.material, where, errors);
            }
        } else if (options.requireMaterials && geometric) {
            errors.push(`${where}: material is required: read this part's surface (baseColor, roughness, metalness, transmission) from the picture`);
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
        if (op === 'crown') {
            // a crown is grown where its trunk stands: never attached, mirrored or copied
            if (given(part.parentId) || given(part.attach)) errors.push(`${where}: a crown part is a root part; give its trunkBaseMeters instead of parentId and attach`);
            if (given(part.mirrorPlaneNormal)) errors.push(`${where}: a crown part cannot be mirrored; give each crown its own part`);
            validateCrown(part.crown, where, errors, pointInReach);
            continue;
        }
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
        if (op === 'sweep') validateSweep(part.sweep, where, isChild, errors, pointInReach, given(spec.blueprint));
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

function validateCrown(
    crown: unknown,
    where: string,
    errors: string[],
    pointInReach: (p: number[], where: string, field: string) => void
): void {
    if (!isRecord(crown)) {
        errors.push(`${where}: crown must be an object`);
        return;
    }
    if (!isVec3(crown.trunkBaseMeters)) errors.push(`${where}: crown.trunkBaseMeters must be [x, y, z] in metres`);
    else pointInReach(crown.trunkBaseMeters as number[], where, 'crown.trunkBaseMeters');
    const height = crown.heightMeters;
    if (!isFiniteNumber(height) || height <= 0.3) errors.push(`${where}: crown.heightMeters must be more than 0.3 m`);
    if (!isPair(crown.crownRadiiMeters) || (crown.crownRadiiMeters as number[]).some(r => r <= 0.1)) {
        errors.push(`${where}: crown.crownRadiiMeters must be [along X, along Z], each more than 0.1 m`);
    }
    if (given(crown.crownBaseHeightMeters) && (!isFiniteNumber(crown.crownBaseHeightMeters) || crown.crownBaseHeightMeters < 0 || (isFiniteNumber(height) && crown.crownBaseHeightMeters >= 0.95 * height))) {
        errors.push(`${where}: crown.crownBaseHeightMeters must be at least 0 and below 0.95 of heightMeters`);
    }
    if (given(crown.crownWidestAt) && (!isFiniteNumber(crown.crownWidestAt) || crown.crownWidestAt < 0 || crown.crownWidestAt > 0.9)) {
        errors.push(`${where}: crown.crownWidestAt must be between 0 and 0.9`);
    }
    if (given(crown.crownTopExponent) && (!isFiniteNumber(crown.crownTopExponent) || crown.crownTopExponent < 0.5 || crown.crownTopExponent > 8)) {
        errors.push(`${where}: crown.crownTopExponent must be between 0.5 and 8`);
    }
    if (given(crown.trunkRadiusMeters) && (!isFiniteNumber(crown.trunkRadiusMeters) || crown.trunkRadiusMeters <= 0 || (isFiniteNumber(height) && crown.trunkRadiusMeters >= 0.2 * height))) {
        errors.push(`${where}: crown.trunkRadiusMeters must be more than 0 and under 0.2 of heightMeters`);
    }
}

/** Checks one material block against the factor ranges; every problem is named. */
export function validatePartMaterial(material: unknown, where: string, errors: string[]): void {
    if (!isRecord(material)) {
        errors.push(`${where}: material must be an object`);
        return;
    }
    const m = material;
    const inUnit = (v: unknown) => isFiniteNumber(v) && v >= 0 && v <= 1;
    const isRgb = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(inUnit);
    if (!isRgb(m.baseColor)) errors.push(`${where}: material.baseColor must be [r, g, b] linear RGB, each between 0 and 1`);
    for (const key of ['roughness', 'metalness', 'transmission'] as const) {
        if (!inUnit(m[key])) errors.push(`${where}: material.${key} must be between 0 and 1`);
    }
    if (given(m.ior) && (!isFiniteNumber(m.ior) || m.ior < MATERIAL_LIMITS.minIor || m.ior > MATERIAL_LIMITS.maxIor)) {
        errors.push(`${where}: material.ior must be between ${MATERIAL_LIMITS.minIor} and ${MATERIAL_LIMITS.maxIor}`);
    }
    if (given(m.clearcoat) && !inUnit(m.clearcoat)) errors.push(`${where}: material.clearcoat must be between 0 and 1`);
    if (given(m.emissive) && !isRgb(m.emissive)) errors.push(`${where}: material.emissive must be [r, g, b] linear RGB, each between 0 and 1`);
    if (given(m.emissiveStrength)) {
        if (!isFiniteNumber(m.emissiveStrength) || m.emissiveStrength < 0 || m.emissiveStrength > MATERIAL_LIMITS.maxEmissiveStrength) {
            errors.push(`${where}: material.emissiveStrength must be between 0 and ${MATERIAL_LIMITS.maxEmissiveStrength}`);
        } else if (!given(m.emissive)) {
            errors.push(`${where}: material.emissiveStrength needs material.emissive (the colour it multiplies)`);
        }
    }
    if (given(m.description) && typeof m.description !== 'string') errors.push(`${where}: material.description must be a string`);
}

/**
 * Moves each child part's own geometry so it starts at its attach point, the way the spec's rules require: a child
 * sweep whose first control point is not [0, 0, 0] has every control point shifted by minus that point; a child
 * revolve's axisOrigin becomes [0, 0, 0] (the revolve moves with it), and a meridian whose axial distances do not
 * span 0 is shifted along the axis so its nearer end is at 0. Shapes are unchanged; only where the child sits on its
 * parent moves, so it touches the parent at the attach point. Returns the input untouched (and no notes) when
 * nothing needs moving or the input is not a spec-shaped object; each move is described in `notes`.
 */
export function normalizeChildOrigins(input: unknown): { value: unknown; notes: string[] } {
    if (!isRecord(input) || !Array.isArray(input.parts)) return { value: input, notes: [] };
    const notes: string[] = [];
    const round = (v: number) => +v.toFixed(4);
    const parts = input.parts.map(raw => {
        if (!isRecord(raw) || typeof raw.parentId !== 'string' || !raw.parentId) return raw;
        const id = typeof raw.id === 'string' ? raw.id : '?';
        const sweep = raw.sweep;
        if (isRecord(sweep) && Array.isArray(sweep.controlPoints) && sweep.controlPoints.length >= 2 && sweep.controlPoints.every(isVec3)) {
            const first = sweep.controlPoints[0] as Vec3;
            if (Math.hypot(...first) > 1e-6) {
                notes.push(`part "${id}": control points shifted by [${first.map(v => round(-v)).join(', ')}] m so the sweep starts at its attach point`);
                return { ...raw, sweep: { ...sweep, controlPoints: (sweep.controlPoints as Vec3[]).map(q => [q[0] - first[0], q[1] - first[1], q[2] - first[2]]) } };
            }
            return raw;
        }
        const revolve = raw.revolve;
        if (!isRecord(revolve)) return raw;
        let next = revolve;
        if (isVec3(revolve.axisOrigin) && Math.hypot(...revolve.axisOrigin) > 1e-6) {
            notes.push(`part "${id}": axisOrigin [${revolve.axisOrigin.map(round).join(', ')}] set to [0, 0, 0] so the revolve's axis passes through its attach point`);
            next = { ...next, axisOrigin: [0, 0, 0] };
        }
        const m = revolve.meridian;
        if (Array.isArray(m) && m.length >= 2 && m.every(isPair)) {
            const axial = (m as Array<[number, number]>).map(q => q[0]);
            const lo = Math.min(...axial), hi = Math.max(...axial);
            const shift = lo > 1e-6 ? -lo : hi < -1e-6 ? -hi : 0;
            if (shift !== 0) {
                notes.push(`part "${id}": meridian shifted ${round(shift)} m along the axis so it reaches its attach point`);
                next = { ...next, meridian: (m as Array<[number, number]>).map(q => [q[0] + shift, q[1]]) };
            }
        }
        return next === revolve ? raw : { ...raw, revolve: next };
    });
    return notes.length ? { value: { ...input, parts }, notes } : { value: input, notes };
}

/** Sweep and revolve parts with no material: a non-clay build gives them studio clay and says which they are. */
export function partsWithoutMaterial(spec: ObjectBuildSpec): string[] {
    return spec.parts.filter(p => (p.sweep || p.revolve) && !p.material).map(p => p.id);
}

function validateSweep(
    sweep: unknown,
    where: string,
    isChild: boolean,
    errors: string[],
    pointInReach: (p: number[], where: string, field: string) => void,
    hasBlueprint = false
): void {
    if (!isRecord(sweep)) {
        errors.push(`${where}: sweep must be an object`);
        return;
    }
    if (given(sweep.fromBlueprint)) {
        errors.push(...validateBlueprintLoft(sweep.fromBlueprint, where));
        if (isChild) errors.push(`${where}: a sweep lofted fromBlueprint is a root part, in object coordinates; remove parentId and attach`);
        if (!hasBlueprint) errors.push(`${where}: sweep.fromBlueprint needs the spec's blueprint outlines, and this spec has none`);
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
    } else if (operatorOf.get(seed) === 'crown') {
        errors.push(`${where}: replicate.seedPartId "${seed}" is a crown part; each tree is grown on its own: give every crown its own part`);
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
/** The spec as the build reads it: fromBlueprint parts already lofted, so the outlines themselves are not needed. */
function withoutBlueprint(spec: ObjectBuildSpec): ObjectBuildSpec {
    const { blueprint: _b, ...rest } = spec;
    return rest;
}

export function buildObjectSpecScript(spec: ObjectBuildSpec, options: { clay?: boolean } = {}): string {
    return [
        '# Built by build_3d_object_from_reference from SPEC (metres, +Y up). To change the object, pass the edited',
        '# spec to build_3d_object_from_reference as specJson (with its location and placement when it stands at a place).',
        options.clay
            ? '# clay=True: every part is studio clay; any material in SPEC is ignored.'
            : '# Each part\'s material factors become its glTF material; a part without one is studio clay.',
        'import scratchbox as sb',
        '',
        `SPEC = ${toPythonLiteral(withoutBlueprint(expandBlueprintParts(spec)))}`,
        '',
        `sb.io.write_glb(OUTPUT_GLB_PATH, sb.object_spec.build(SPEC${options.clay ? ', clay=True' : ''}))`,
        ''
    ].join('\n');
}
