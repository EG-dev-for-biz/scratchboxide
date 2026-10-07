import { synthesizeContextual3DScene } from './packages/core/src/browser/generative-canvas/procedural-3d-synthesizer.ts';
const res = synthesizeContextual3DScene("Build a procedural 3D sci-fi exploration environment with terrain and lighting");
console.log(JSON.stringify(res, null, 2));
