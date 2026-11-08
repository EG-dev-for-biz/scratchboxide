/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What each step of a staged build reads and makes, so the node graph wires a step to the steps whose results it uses
 * (staged-build-graph.ts). A step is a stage (`resolve`, `tiles`) or a timed step inside one, by the key the run records
 * it under (StagedBuildState.steps: `remesh.windowFit`, `polish.lattice`, `twin.materials`). Keep it in step with the
 * orchestrator: a key the run never records is simply not drawn, and a recorded step missing here is drawn unwired.
 */

export interface BuildStepSpec {
    /** A stage id, or a step key "<group>.<step>". */
    key: string;
    /** The stage it runs in. */
    stage: string;
    title: string;
    /** Results it reads (made by other steps). */
    needs: string[];
    /** Results it makes. */
    makes: string[];
}

/** What a result is, for the edge labels. */
export const BUILD_RESULTS: Record<string, string> = {
    place: 'the place', tiles: 'tile mesh', surveyPhotos: 'Street View photos', canopy: 'canopy',
    scanClay: 'remeshed scan', orthos: 'facade orthophotos', straightOrthos: 'straightened facade photos', occlusion: 'occlusion masks', windows: 'windows', planeReadings: 'openings read by the vision agent',
    depth: 'window depth', cleanClay: 'cleaned scan', latticeClay: 'facades rebuilt', baseClay: 'base cleaned',
    sealedClay: 'sealed shell', closedClay: 'closed from outside', finalClay: 'final model', score: 'relief score', holes: 'holes seen',
    ownerViews: 'ownership views', ownerMasks: 'ownership vote', votedClay: 'voted remesh', registeredPoses: 'registered photos', treeStrip: 'trees', delit: 'de-lit photos',
    harmonised: 'harmonised photos', materials: 'material maps', partyWall: 'party wall', facadeDetail: 'upscaled facade photos', relief: 'displaced near surfaces', late: 'later layers', published: 'scene'
};

/** Pipeline K's steps, in run order. */
export const BUILD_STEPS: BuildStepSpec[] = [
    { key: 'resolve', stage: 'resolve', title: 'Resolve the place', needs: [], makes: ['place'] },
    { key: 'tiles', stage: 'tiles', title: 'Google 3D Tiles', needs: ['place'], makes: ['tiles'] },
    { key: 'survey', stage: 'survey', title: 'Street View survey', needs: ['place', 'tiles'], makes: ['surveyPhotos'] },
    { key: 'trees-measure', stage: 'trees-measure', title: 'Measure the canopy', needs: ['tiles'], makes: ['canopy'] },
    { key: 'remesh.tileRefine', stage: 'remesh', title: 'tile_refine: isolate, remesh, flatten', needs: ['tiles'], makes: ['scanClay', 'orthos'] },
    { key: 'remesh.occlusion', stage: 'remesh', title: 'What stood in front of each facade', needs: ['tiles'], makes: ['occlusion'] },
    { key: 'remesh.pipelineK', stage: 'remesh', title: 'Straighten the facade photos', needs: ['orthos', 'occlusion'], makes: ['straightOrthos'] },
    { key: 'remesh.windowFit', stage: 'remesh', title: 'Window fit', needs: ['straightOrthos'], makes: ['windows'] },
    { key: 'remesh.windowArray', stage: 'remesh', title: 'Window array per facade', needs: ['windows'], makes: ['windows'] },
    { key: 'remesh.facadeRead', stage: 'remesh', title: 'Read every plane\'s openings', needs: ['straightOrthos', 'tiles'], makes: ['planeReadings'] },
    { key: 'remesh.revealDepth', stage: 'remesh', title: 'Window depth from Street View', needs: ['windows', 'surveyPhotos'], makes: ['depth'] },
    { key: 'polish.cleanup', stage: 'remesh', title: 'Remesh cleanup', needs: ['scanClay'], makes: ['cleanClay'] },
    { key: 'polish.lattice', stage: 'remesh', title: 'Facades rebuilt on the lattice', needs: ['cleanClay', 'straightOrthos', 'windows', 'planeReadings', 'depth'], makes: ['latticeClay'] },
    { key: 'polish.latticeCut', stage: 'remesh', title: 'Scan cut at the rebuilt cells', needs: ['latticeClay'], makes: ['latticeClay'] },
    { key: 'polish.base', stage: 'remesh', title: 'Base cleanup', needs: ['latticeClay'], makes: ['baseClay'] },
    { key: 'polish.clip', stage: 'remesh', title: 'Clip at the footprint', needs: ['baseClay'], makes: ['baseClay'] },
    { key: 'polish.infill', stage: 'remesh', title: 'Fill the openings', needs: ['baseClay'], makes: ['baseClay'] },
    { key: 'polish.seal', stage: 'remesh', title: 'Seal (cut and stitch)', needs: ['baseClay'], makes: ['sealedClay'] },
    { key: 'polish.orient', stage: 'remesh', title: 'Turn inward faces outward', needs: ['baseClay'], makes: ['finalClay'] },
    { key: 'polish.closure', stage: 'remesh', title: 'Close from outside: joins, inner core, hole repair', needs: ['finalClay', 'cleanClay'], makes: ['finalClay'] },
    { key: 'remesh.streetViewScore', stage: 'remesh', title: 'Relief score against Street View', needs: ['scanClay', 'finalClay', 'surveyPhotos'], makes: ['score'] },
    { key: 'remesh.visibleDefects', stage: 'remesh', title: 'Holes seen from outside', needs: ['finalClay'], makes: ['holes'] },
    { key: 'ownership', stage: 'ownership', title: 'Ownership vote', needs: ['tiles', 'finalClay'], makes: ['ownerMasks'] },
    { key: 'ownership.ownershipViews', stage: 'ownership', title: 'Ownership: render the views', needs: ['tiles', 'finalClay'], makes: ['ownerViews'] },
    { key: 'ownership.ownershipVision', stage: 'ownership', title: 'Ownership: outline the structure', needs: ['ownerViews'], makes: ['ownerMasks'] },
    { key: 'ownership.tileRefine', stage: 'ownership', title: 'Ownership: remesh by the vote', needs: ['ownerMasks', 'tiles'], makes: ['votedClay'] },
    { key: 'evidence', stage: 'evidence', title: 'Street View close-ups', needs: ['surveyPhotos', 'tiles'], makes: ['registeredPoses'] },
    { key: 'trees', stage: 'trees', title: 'Trees', needs: ['canopy', 'finalClay'], makes: ['treeStrip'] },
    { key: 'textures.tileRefineTwins', stage: 'textures', title: 'De-lit photo twin', needs: ['finalClay', 'tiles'], makes: ['delit'] },
    { key: 'twin.viewRelight', stage: 'textures', title: 'Relight from views', needs: ['delit'], makes: ['relit'] },
    { key: 'twin.roofShadow', stage: 'textures', title: 'Lift roof shadows', needs: ['delit'], makes: ['roofLit'] },
    { key: 'twin.harmonize', stage: 'textures', title: 'Harmonise the photos', needs: ['delit'], makes: ['harmonised'] },
    { key: 'twin.materials', stage: 'textures', title: 'Material regions', needs: ['harmonised', 'planeReadings'], makes: ['materials'] },
    { key: 'twin.partyWall', stage: 'textures', title: 'Party wall', needs: ['harmonised', 'baseClay'], makes: ['partyWall'] },
    { key: 'twin.detailBake', stage: 'textures', title: 'Swatch detail', needs: ['harmonised', 'tiles'], makes: ['detail'] },
    { key: 'twin.facadeUpscale', stage: 'textures', title: 'Upscale the facade photos', needs: ['harmonised', 'latticeClay'], makes: ['facadeDetail'] },
    { key: 'twin.heightRelief', stage: 'textures', title: 'Displace the near surfaces', needs: ['materials', 'latticeClay'], makes: ['relief'] },
    { key: 'textures.lateLayers', stage: 'textures', title: 'Textures of later layers', needs: ['materials'], makes: ['late'] },
    { key: 'textures-late', stage: 'textures-late', title: 'Textures of later layers', needs: ['materials'], makes: ['late'] }
];

/** Steps not drawn: wrappers whose parts are drawn instead (the polish), and waits that do no work of their own. */
export const WRAPPER_STEPS = new Set(['remesh.polish', 'textures.waitRebuildGrammar']);

/**
 * Steps the node graph can turn on or off for a build (StagedLocationRequest.steps), each with what it does when it is
 * off. The rest (the place, the tiles, tile_refine) every later step needs, so they have no switch.
 */
export const TOGGLEABLE_STEPS = new Map<string, string>([
    ['remesh.occlusion', 'a facade texel behind a tree, an awning or a neighbour is read as wall like any other'],
    ['remesh.windowFit', 'the facades are opened by their bay rhythm and the lattice\'s own window cells'],
    ['remesh.windowArray', 'each facade\'s windows stay as its bands read them, off their grid where a band drifted'],
    ['remesh.facadeRead', 'the window geometry stays as the window fit read it, and the material reads are told no brief of the building'],
    ['remesh.revealDepth', 'the recesses follow the photo-contrast rule'],
    ['polish.cleanup', 'the lattice works on the remesh as tile_refine left it'],
    ['polish.lattice', 'the facades stay as scanned'],
    ['polish.latticeCut', 'whole scan triangles are removed under the rebuilt facades, the rest left standing over them'],
    ['polish.base', 'the base is left as scanned, no skirt'],
    ['polish.clip', 'the building is not cut at its footprint'],
    ['polish.infill', 'the openings the clip leaves stay open'],
    ['polish.seal', 'the shell is left open'],
    ['polish.orient', 'inward-facing scan pieces stay as they are'],
    ['polish.closure', 'rebuilt facades are not joined where they meet, no inner core stands behind the holes and the holes found are not repaired'],
    ['remesh.streetViewScore', 'no relief score against Street View'],
    ['remesh.visibleDefects', 'holes are not looked for'],
    ['evidence', 'no Street View close-ups or their registration (a 3D Building reads neither)'],
    ['twin.viewRelight', 'the photos keep the lighting the de-light left (no image-model relight of rendered views)'],
    ['twin.roofShadow', 'the roof decks keep the shadows the building cast on them in the photos'],
    ['twin.harmonize', 'the de-lit photos are kept as they are, photo by photo'],
    ['twin.materials', 'no occlusion, roughness, metalness or normal maps: the photos only'],
    ['twin.partyWall', 'the party wall stays untextured'],
    ['twin.detailBake', 'the photo atlases keep the tile\'s own resolution, no swatch detail'],
    ['twin.facadeUpscale', 'the rebuilt facades keep their photo\'s own resolution (about 15 cm a texel), no image-model detail'],
    ['twin.heightRelief', 'the rebuilt facades stay flat up close: their materials\' height is drawn by the viewer\'s parallax only, no geometry moved']
]);
