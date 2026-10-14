const fs = require('fs');
const path = require('path');
const { SbHumanLoader } = require('../packages/core/dist/common/spatial/SbHumanLoader.js');

const sbHumanPath = path.resolve('public/models/sbhuman_neutral.sbhuman');
const buf = fs.readFileSync(sbHumanPath);
const loader = SbHumanLoader.parse(buf);

const wrist = loader.joints[20].pos;
const j39 = loader.joints[39].pos;
const j37 = loader.joints[37].pos;

console.log('Wrist joint:', wrist);
console.log('Thumb IP joint (j39):', j39);
console.log('Thumb CMC joint (j37):', j37);
