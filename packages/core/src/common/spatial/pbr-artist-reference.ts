/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The texture artist's reference for building materials: how rough and how metallic a surface is, by how it looks and
 * behaves, and the rules an experienced PBR texture artist follows when setting a material's roughness and metalness.
 * Our own reference (user ask, 2026-11-08), written from published measured values and texturing practice, none of
 * their text or files copied:
 *  - the Physically Based database (physicallybased.info: measured, CC0 values);
 *  - Google's Filament material guide (dielectric reflectance 2-5 %, metals' reflectance 50-100 %, metalness binary);
 *  - Adobe Substance's PBR guide (metal/rough workflow: metalness 0 or 1, transitions only where one covers the other);
 *  - Sébastien Lagarde's DONTNOD material charts (glossiness ranges of dressed stone, concrete, painted and raw metal);
 *  - the glTF 2.0 metallic-roughness model (roughness perceptual, metallic a 0/1 mask, base colour the albedo).
 *
 * It is data the vision model is told (material-finish.ts, material-choice.ts) and the screenshot review skill reads
 * (.claude/skills/pbr-material-review): every entry's `look` is words for prompting, never a key anything branches on
 * (AGENTS.md section 1). The code reads only the numbers in ARTIST_FINISH.
 */

/** One reference finish: what the surface looks like and how it behaves, and its measured or practised ranges. */
export interface PbrReferenceFinish {
    /** How the surface looks and behaves, in words (a prompt label only). */
    look: string;
    /** Perceptual roughness (glTF), the range seen on real buildings, weathered as found. */
    roughness: [number, number];
    /** 0 a dielectric, 1 a bare metal: one or the other. */
    metalness: 0 | 1;
    /** Where the range comes from. */
    source: string;
}

/**
 * Exterior building surfaces as found in a city (weathered, not showroom-new). The roughness ranges are wide on purpose:
 * the artist picks within them by what the photo shows (grime, polish, waviness), never outside them without seeing it.
 */
export const PBR_REFERENCE: readonly PbrReferenceFinish[] = [
    { look: 'clean float glass, a sharp mirror image of the surroundings', roughness: [0.02, 0.08], metalness: 0, source: 'Physically Based (glass, roughness 0); Filament (glass a dielectric, reflectance about 4 %)' },
    { look: 'window glass in place, dust and film, the reflection slightly soft or wavy; opaque spandrel glass', roughness: [0.05, 0.15], metalness: 0, source: 'Lagarde chart (glass high gloss); practice: dust and float waviness soften the reflection' },
    { look: 'polished granite or marble, reflections of the street readable in it', roughness: [0.1, 0.3], metalness: 0, source: 'Lagarde chart (polished stone); Physically Based (marble)' },
    { look: 'honed or weathered polished stone, a soft sheen, no readable reflection', roughness: [0.35, 0.55], metalness: 0, source: 'Lagarde chart (honed stone)' },
    { look: 'dressed limestone or sandstone, weathered ashlar, sawn or tooled stone', roughness: [0.7, 0.95], metalness: 0, source: 'Lagarde chart (rough stone); Substance guide (stone 0.7 and up)' },
    { look: 'cast or precast concrete, exposed aggregate', roughness: [0.75, 0.95], metalness: 0, source: 'Physically Based (concrete); Lagarde chart (concrete)' },
    { look: 'render, stucco, plaster, paint over masonry', roughness: [0.8, 0.95], metalness: 0, source: 'Lagarde chart (plaster); Substance guide' },
    { look: 'brick and its mortar, unglazed terracotta', roughness: [0.75, 0.95], metalness: 0, source: 'Physically Based (brick); Lagarde chart (brick)' },
    { look: 'glazed terracotta or ceramic tile, a glossy glaze', roughness: [0.15, 0.4], metalness: 0, source: 'Lagarde chart (ceramic glaze)' },
    { look: 'painted or powder-coated metal panels, mullions and frames outdoors (the paint is what you see; weathering chalks and dulls it)', roughness: [0.45, 0.7], metalness: 0, source: 'Substance guide (paint over metal is a dielectric); Lagarde chart (painted metal, satin to matte); practice: exterior coatings lose gloss as they weather' },
    { look: 'anodised aluminium, a satin metallic sheen tinted by the anodising', roughness: [0.3, 0.6], metalness: 1, source: 'Physically Based (aluminium, reflectance about 91 %); practice: anodised satin 0.3-0.6' },
    { look: 'brushed or satin stainless steel', roughness: [0.25, 0.45], metalness: 1, source: 'Physically Based (iron and chromium reflectance); Lagarde chart (brushed metal)' },
    { look: 'bronze or brass weathered to a dark oiled or oxidised finish', roughness: [0.4, 0.7], metalness: 1, source: 'Physically Based (copper and brass reflectance); practice: oxidation roughens and darkens' },
    { look: 'copper or bronze under green or brown patina (the oxide is what you see)', roughness: [0.6, 0.9], metalness: 0, source: 'Substance guide (oxide and patina are dielectrics)' },
    { look: 'roofing membrane, asphalt, tar, gravel ballast', roughness: [0.85, 1], metalness: 0, source: 'Physically Based (asphalt); Lagarde chart' },
    { look: 'rusted steel (the rust is what you see)', roughness: [0.75, 0.95], metalness: 0, source: 'Substance guide (rust is a dielectric)' }
] as const;

/** The rules a texture artist follows, told to the model as written. */
export const PBR_ARTIST_RULES: readonly string[] = [
    'Metalness is 0 or 1, never in between: a surface is a bare metal or it is not. Paint, powder coat, enamel, oxide, patina, rust and dirt are dielectrics (0) even on a metal object; only bare, anodised or plated metal you can see is 1.',
    'A dark colour is not metal, and a shaded part of a wall is not another material: shade, soot and dark stone are dielectrics.',
    'Exterior building stone, concrete, brick and render are rough (0.7 and up). Only a surface whose photo shows a readable reflection of its surroundings is polished.',
    'Dirt, dust, soot and weathering raise roughness; a city facade above the street has years of it. When unsure between two values, take the rougher.',
    'Glass is smooth (0.05 to 0.15), but the frames, mullions, sills and spandrels around it are not glass: painted frames 0.45 to 0.7, anodised ones 0.3 to 0.6, stone around a window as rough as the wall.',
    'A row that mixes materials takes the finish of what covers most of its area, and says how much that is; a wrongly matte surface looks less wrong than a wrongly shiny one.',
    'Grain is how much the surface varies at the scale of a metre: glass and polished stone nearly none, smooth paint little, weathered stone, brick and concrete a lot.'
] as const;

/**
 * The numbers the code applies to the expert's reading (material-finish.ts drawnMetalness, material-regions.ts applyFrameFinish): the metal a reading may draw
 * (metalness snapped to 0 or 1: 1 only when read at least metalAt, at confidence metalConf or more and covering at least
 * metalCoverage of the class's area; else 0), the roughness of window frames beside glass panes (frameRoughness, the
 * low end of painted and anodised frames), and the least roughness anything is drawn at (minRoughness: glass in place).
 */
export const ARTIST_FINISH = { metalAt: 0.5, metalConf: 70, metalCoverage: 0.6, frameRoughness: 0.45, minRoughness: 0.08 } as const;

/**
 * The roughness range of the reference finish a reading named (1-based, as the prompt numbers them; 0 or out of range:
 * none, a surface the reference does not hold). The code reads only the numbers of the row the model chose.
 */
export function referenceRange(ref: number | undefined): [number, number] | undefined {
    return ref !== undefined && Number.isInteger(ref) && ref >= 1 && ref <= PBR_REFERENCE.length ? [...PBR_REFERENCE[ref - 1].roughness] as [number, number] : undefined;
}

/** The reference as prompt lines: one numbered line a finish, then the rules. */
export function pbrReferenceLines(): string[] {
    const f = (v: number) => v.toFixed(2).replace(/0$/, '');
    return [
        'Reference finishes of exterior building surfaces as found (measured and practised values; roughness 0 a mirror, 1 fully matte; metalness 0 or 1):',
        ...PBR_REFERENCE.map((e, i) => `${i + 1}. ${e.look}: roughness ${f(e.roughness[0])}-${f(e.roughness[1])}, metalness ${e.metalness}`),
        'Rules a texture artist follows:',
        ...PBR_ARTIST_RULES.map(r => `- ${r}`)
    ];
}
