const fs = require('fs');
const path = require('path');

const demoHtmlPath = path.join(__dirname, '../public/plaza_matchmove_demo.html');
const genScriptPath = path.join(__dirname, 'generate_plaza_hotel_camera_path.cjs');
const cameraPathJsonPath = path.join(__dirname, '../public/models/plaza_hotel_camera_path.json');

// Read generator script to extract MILESTONES
const genContent = fs.readFileSync(genScriptPath, 'utf8');
const milestoneMatch = genContent.match(/const MILESTONES = (\[[\s\S]*?\n\];)/);
if (!milestoneMatch) {
  console.error('Could not find MILESTONES in generator script');
  process.exit(1);
}

// Evaluate milestones from generator
const calibratedMilestones = eval(milestoneMatch[1]);

// Read camera path JSON
const cameraPathData = JSON.parse(fs.readFileSync(cameraPathJsonPath, 'utf8'));
const k1 = cameraPathData.lensDistortion ? cameraPathData.lensDistortion.k1 : -0.015;

const groundTruthArray = cameraPathData.frames.map(f => [
  f.position[0],
  f.position[1],
  f.position[2],
  f.target[0],
  f.target[1],
  f.target[2],
  f.pitch,
  f.fov,
  f.standoffMeters,
  k1
]);

// Read demo html
let demoHtml = fs.readFileSync(demoHtmlPath, 'utf8');

// 1. Update MILESTONES
calibratedMilestones.forEach((calM, idx) => {
  const kfNum = idx + 1;
  const regex = new RegExp(`(\\{\\s*index:\\s*${idx},[\\s\\S]*?kfNumber:\\s*${kfNum},[\\s\\S]*?frame:\\s*${calM.frame},[\\s\\S]*?imgComparison:[^}]+?\\})`, 'g');
  
  demoHtml = demoHtml.replace(regex, (match) => {
    let updated = match.replace(/pos:\s*\[[\d\.\s,-]+\]/, `pos: [${calM.pos.join(', ')}]`);
    updated = updated.replace(/target:\s*\[[\d\.\s,-]+\]/, `target: [${calM.target.join(', ')}]`);
    updated = updated.replace(/pitch:\s*[\d\.-]+/, `pitch: ${calM.pitch}`);
    updated = updated.replace(/alt:\s*[\d\.-]+/, `alt: ${calM.pos[1]}`);
    const dx = calM.pos[0] - calM.target[0];
    const dy = calM.pos[1] - calM.target[1];
    const dz = calM.pos[2] - calM.target[2];
    const standoff = Math.sqrt(dx*dx + dy*dy + dz*dz).toFixed(2);
    updated = updated.replace(/standoff:\s*[\d\.-]+/, `standoff: ${standoff}`);
    return updated;
  });
});

// 2. Update GROUND_TRUTH_TRAJECTORY_361
const gtString = JSON.stringify(groundTruthArray);
demoHtml = demoHtml.replace(/const GROUND_TRUTH_TRAJECTORY_361 = \[\[[\s\S]*?\]\];/, `const GROUND_TRUTH_TRAJECTORY_361 = ${gtString};`);

fs.writeFileSync(demoHtmlPath, demoHtml, 'utf8');
console.log('✅ Successfully synchronized both MILESTONES and GROUND_TRUTH_TRAJECTORY_361 in public/plaza_matchmove_demo.html');
