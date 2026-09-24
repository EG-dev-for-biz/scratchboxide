const fs = require('fs');
const path = require('path');

const demoPath = path.resolve(__dirname, '../public/plaza_matchmove_demo.html');
let content = fs.readFileSync(demoPath, 'utf8');

// 1. Replace all dense_plaza_comparison_kf with dense_plaza_omni_kf
const compMatches = content.match(/dense_plaza_comparison_kf\d{2}_f\d+\.png/g);
console.log(`Found ${compMatches ? compMatches.length : 0} occurrences of dense_plaza_comparison_kf to replace with dense_plaza_omni_kf`);

content = content.replace(/images\/dense_plaza_comparison_kf(\d{2})_f(\d+)\.png/g, 'images/dense_plaza_omni_kf$1_f$2.png');

// 2. Load 361 ground-truth frames from public/models/plaza_hotel_camera_path.json
const cameraPathJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../public/models/plaza_hotel_camera_path.json'), 'utf8'));
const compact361 = cameraPathJson.frames.map(f => [
  +f.position[0].toFixed(3), +f.position[1].toFixed(3), +f.position[2].toFixed(3),
  +f.target[0].toFixed(3), +f.target[1].toFixed(3), +f.target[2].toFixed(3),
  +f.pitch.toFixed(1), +f.fov.toFixed(1), +(f.standoffMeters || 16).toFixed(2),
  +(f.k1 || -0.018).toFixed(4)
]);

console.log(`Prepared compact 361 ground truth frames. Total count: ${compact361.length}`);

// 3. Inject GROUND_TRUTH_TRAJECTORY_361 and sampleTrajectoryAtTime
const trajectoryCode = `
    // 361-Frame Ground-Truth Flight Trajectory (calibrated at 24fps across 15.04s)
    const GROUND_TRUTH_TRAJECTORY_361 = ${JSON.stringify(compact361)};

    function sampleTrajectoryAtTime(t) {
      const clampedT = Math.max(0.0, Math.min(15.0, t));
      const totalFrames = GROUND_TRUTH_TRAJECTORY_361.length;
      const frameFloat = (clampedT / 15.0) * (totalFrames - 1);
      const idx0 = Math.floor(frameFloat);
      const idx1 = Math.min(totalFrames - 1, idx0 + 1);
      const frac = frameFloat - idx0;

      const f0 = GROUND_TRUTH_TRAJECTORY_361[idx0];
      const f1 = GROUND_TRUTH_TRAJECTORY_361[idx1];

      // Exact temporal sub-frame linear interpolation
      const pos = new THREE.Vector3(
        f0[0] * (1 - frac) + f1[0] * frac,
        f0[1] * (1 - frac) + f1[1] * frac,
        f0[2] * (1 - frac) + f1[2] * frac
      );

      const target = new THREE.Vector3(
        f0[3] * (1 - frac) + f1[3] * frac,
        f0[4] * (1 - frac) + f1[4] * frac,
        f0[5] * (1 - frac) + f1[5] * frac
      );

      const up = computeUpVector(clampedT);
      const pitch = f0[6] * (1 - frac) + f1[6] * frac;
      const fov = f0[7] * (1 - frac) + f1[7] * frac;
      const standoff = f0[8] * (1 - frac) + f1[8] * frac;
      const k1 = f0[9] * (1 - frac) + f1[9] * frac;

      return {
        pos,
        target,
        up,
        pitch,
        fov,
        standoff,
        k1,
        frameNumber: Math.min(361, Math.round(frameFloat) + 1)
      };
    }
`;

// Insert after computeUpVector definition
const upVectorAnchor = `    function computeUpVector(t) {
      const tiltFrac = Math.min(1.0, Math.max(0.0, (t - 4.0) / 7.0));
      const angle = tiltFrac * (Math.PI / 2.0);
      return new THREE.Vector3(
        Math.sin(angle) * FACADE_NORMAL[0],
        Math.cos(angle) * 1.0,
        Math.sin(angle) * FACADE_NORMAL[2]
      ).normalize();
    }`;

if (!content.includes(upVectorAnchor)) {
  throw new Error('Could not find computeUpVector anchor in plaza_matchmove_demo.html');
}

content = content.replace(upVectorAnchor, upVectorAnchor + '\n' + trajectoryCode);

// 4. Update splineCurve to construct from GROUND_TRUTH_TRAJECTORY_361
const oldSplineDef = `    // 3D Spline Path & Milestone Markers
    const curvePoints = MILESTONES.map(m => new THREE.Vector3(m.pos[0], m.pos[1], m.pos[2]));
    const splineCurve = new THREE.CatmullRomCurve3(curvePoints);
    const splineGeo = new THREE.TubeGeometry(splineCurve, 120, 0.6, 8, false);`;

const newSplineDef = `    // 3D Spline Path & Milestone Markers (Constructed from authentic 361 Ground-Truth Knots)
    const trajectoryPoints = GROUND_TRUTH_TRAJECTORY_361.map(f => new THREE.Vector3(f[0], f[1], f[2]));
    const splineCurve = new THREE.CatmullRomCurve3(trajectoryPoints);
    const splineGeo = new THREE.TubeGeometry(splineCurve, 240, 0.45, 8, false);`;

if (!content.includes(oldSplineDef)) {
  throw new Error('Could not find oldSplineDef anchor');
}
content = content.replace(oldSplineDef, newSplineDef);

// 5. Update updateSceneState camera evaluation to use sampleTrajectoryAtTime(currentTime)
const oldCameraEval = `      // Spline camera position evaluation
      const tNorm = currentTime / 15.0;
      const camPos = splineCurve.getPoint(tNorm);
      camFrustumGroup.position.copy(camPos);

      // Continuous target lookat from target spline
      const targetVec = targetSplineCurve.getPoint(tNorm);

      // Gimbal-free up-vector
      const curUp = computeUpVector(currentTime);
      camFrustumGroup.up.copy(curUp);
      camFrustumGroup.lookAt(targetVec);

      // Scale optical axis sight line to reach the target point
      const distToTarget = camPos.distanceTo(targetVec);
      targetLine.scale.set(1, 1, Math.max(1.0, distToTarget));
      targetLine.computeLineDistances();

      // Dynamic pitch angle derived directly from line-of-sight vector
      const lookDir = new THREE.Vector3().subVectors(targetVec, camPos).normalize();
      const dynPitch = (Math.asin(lookDir.y) * 180 / Math.PI);`;

const newCameraEval = `      // Continuous exact 361-frame ground truth trajectory evaluation
      const traj = sampleTrajectoryAtTime(currentTime);
      const camPos = traj.pos;
      const targetVec = traj.target;
      const curUp = traj.up;

      camFrustumGroup.position.copy(camPos);
      camFrustumGroup.up.copy(curUp);
      camFrustumGroup.lookAt(targetVec);

      // Scale optical axis sight line to reach the target point
      const distToTarget = camPos.distanceTo(targetVec);
      targetLine.scale.set(1, 1, Math.max(1.0, distToTarget));
      targetLine.computeLineDistances();

      // Dynamic pitch angle derived from calibrated camera attitude
      const dynPitch = traj.pitch;`;

if (!content.includes(oldCameraEval)) {
  throw new Error('Could not find oldCameraEval anchor');
}
content = content.replace(oldCameraEval, newCameraEval);

// 6. Update vfxPerspectiveCam projection update in updateSceneState
const oldVfxCamUpdate = `      // Update VFX camera projection matrix for 2D overlays
      vfxPerspectiveCam.position.copy(camPos);
      vfxPerspectiveCam.up.copy(curUp);
      vfxPerspectiveCam.lookAt(targetVec);
      vfxPerspectiveCam.updateMatrixWorld();
      vfxPerspectiveCam.updateProjectionMatrix();`;

const newVfxCamUpdate = `      // Update VFX camera projection matrix for 2D overlays (including dynamic lens breathing FOV)
      vfxPerspectiveCam.fov = traj.fov;
      vfxPerspectiveCam.position.copy(camPos);
      vfxPerspectiveCam.up.copy(curUp);
      vfxPerspectiveCam.lookAt(targetVec);
      vfxPerspectiveCam.updateMatrixWorld();
      vfxPerspectiveCam.updateProjectionMatrix();`;

content = content.replace(oldVfxCamUpdate, newVfxCamUpdate);

// 7. Update teleSampling readout to reflect 361-FRAME EXACT
content = content.replace(
  "document.getElementById('teleSampling').textContent = 'DENSE 25-KF';",
  "document.getElementById('teleSampling').textContent = '361-FRAME EXACT';"
);

// 8. Update render2DTrajectory camera eval
const old2dCamEval = `      // 8. 6-DOF Camera Frustum & Line of Sight in Neon Pink
      const tNorm = currentTime / 15.0;
      const camPos = splineCurve.getPoint(tNorm);
      const kf = MILESTONES[currentKfIndex];
      const targetVec = new THREE.Vector3(kf.target[0], kf.target[1], kf.target[2]);`;

const new2dCamEval = `      // 8. 6-DOF Camera Frustum & Line of Sight in Neon Pink (Exact 361-Frame Sync)
      const traj2d = sampleTrajectoryAtTime(currentTime);
      const camPos = traj2d.pos;
      const targetVec = traj2d.target;`;

if (!content.includes(old2dCamEval)) {
  throw new Error('Could not find old2dCamEval anchor');
}
content = content.replace(old2dCamEval, new2dCamEval);

// 9. Update applySplitWipe to prioritize continuous live 24fps video
const oldSplitBranch = `      if (currentView === 'split') {
        blockoutVideo.style.display = 'block';
        synthesisVideo.style.display = 'block';
        blockoutVideo.style.opacity = '1.0';
        synthesisVideo.style.opacity = '1.0';
        blockoutVideo.style.clipPath = \`polygon(0 0, \${pct}% 0, \${pct}% 100%, 0 100%)\`;
        synthesisVideo.style.clipPath = \`polygon(\${pct}% 0, 100% 0, 100% 100%, \${pct}% 100%)\`;
        
        overlayBlockout.style.display = 'block';
        overlaySynthesis.style.display = 'block';
        overlayBlockout.style.opacity = '1.0';
        overlaySynthesis.style.opacity = '1.0';
        overlayBlockout.style.clipPath = \`polygon(0 0, \${pct}% 0, \${pct}% 100%, 0 100%)\`;
        overlaySynthesis.style.clipPath = \`polygon(\${pct}% 0, 100% 0, 100% 100%, \${pct}% 100%)\`;

        splitDivider.style.display = 'flex';
        badgeLeft.style.display = 'block';
        badgeRight.style.display = 'block';
        badgeLeft.textContent = 'STEP 1: 3D TILES BLOCKOUT';
        badgeRight.textContent = 'STEP 3: OMNI NEURAL RECREATION';`;

const newSplitBranch = `      if (currentView === 'split') {
        blockoutVideo.style.display = 'block';
        synthesisVideo.style.display = 'block';
        blockoutVideo.style.opacity = '1.0';
        synthesisVideo.style.opacity = '1.0';
        blockoutVideo.style.clipPath = \`polygon(0 0, \${pct}% 0, \${pct}% 100%, 0 100%)\`;
        synthesisVideo.style.clipPath = \`polygon(\${pct}% 0, 100% 0, 100% 100%, \${pct}% 100%)\`;
        
        // Hide static milestone stills so continuous video streams smoothly across all 361 in-between frames
        const hasLiveVideo = (blockoutVideo.readyState >= 1 || synthesisVideo.readyState >= 1 || isPlaying);
        if (hasLiveVideo) {
          overlayBlockout.style.display = 'none';
          overlaySynthesis.style.display = 'none';
        } else {
          overlayBlockout.style.display = 'block';
          overlaySynthesis.style.display = 'block';
          overlayBlockout.style.opacity = '1.0';
          overlaySynthesis.style.opacity = '1.0';
          overlayBlockout.style.clipPath = \`polygon(0 0, \${pct}% 0, \${pct}% 100%, 0 100%)\`;
          overlaySynthesis.style.clipPath = \`polygon(\${pct}% 0, 100% 0, 100% 100%, \${pct}% 100%)\`;
        }

        splitDivider.style.display = 'flex';
        badgeLeft.style.display = 'block';
        badgeRight.style.display = 'block';
        badgeLeft.textContent = 'STEP 1: 3D TILES BLOCKOUT';
        badgeRight.textContent = 'STEP 3: OMNI NEURAL RECREATION';`;

if (!content.includes(oldSplitBranch)) {
  throw new Error('Could not find oldSplitBranch anchor');
}
content = content.replace(oldSplitBranch, newSplitBranch);

// 10. Update blockout only and synthesis only in applySplitWipe
const oldBlockoutOnly = `      } else if (currentView === 'blockout') {
        blockoutVideo.style.display = 'block';
        synthesisVideo.style.display = 'none';
        blockoutVideo.style.opacity = '1.0';
        blockoutVideo.style.clipPath = 'none';
        overlayBlockout.style.display = 'block';
        overlaySynthesis.style.display = 'none';
        overlayBlockout.style.opacity = '1.0';
        overlayBlockout.style.clipPath = 'none';
        splitDivider.style.display = 'none';
        badgeLeft.style.display = 'block';
        badgeRight.style.display = 'none';
        badgeLeft.textContent = 'STEP 1: 3D TILES BLOCKOUT';`;

const newBlockoutOnly = `      } else if (currentView === 'blockout') {
        blockoutVideo.style.display = 'block';
        synthesisVideo.style.display = 'none';
        blockoutVideo.style.opacity = '1.0';
        blockoutVideo.style.clipPath = 'none';

        const hasVideo = (blockoutVideo.readyState >= 1 || isPlaying);
        overlayBlockout.style.display = hasVideo ? 'none' : 'block';
        overlaySynthesis.style.display = 'none';
        overlayBlockout.style.opacity = '1.0';
        overlayBlockout.style.clipPath = 'none';
        splitDivider.style.display = 'none';
        badgeLeft.style.display = 'block';
        badgeRight.style.display = 'none';
        badgeLeft.textContent = 'STEP 1: 3D TILES BLOCKOUT';`;

if (!content.includes(oldBlockoutOnly)) {
  throw new Error('Could not find oldBlockoutOnly anchor');
}
content = content.replace(oldBlockoutOnly, newBlockoutOnly);

const oldSynthesisOnly = `      } else if (currentView === 'synthesis' || currentView === 'dual') {
        blockoutVideo.style.display = 'none';
        synthesisVideo.style.display = 'block';
        synthesisVideo.style.opacity = '1.0';
        synthesisVideo.style.clipPath = 'none';
        overlayBlockout.style.display = 'none';
        overlaySynthesis.style.display = 'block';
        overlaySynthesis.style.opacity = '1.0';
        overlaySynthesis.style.clipPath = 'none';
        splitDivider.style.display = 'none';
        badgeLeft.style.display = 'none';
        badgeRight.style.display = 'block';
        badgeRight.textContent = 'STEP 3: OMNI NEURAL RECREATION';`;

const newSynthesisOnly = `      } else if (currentView === 'synthesis' || currentView === 'dual') {
        blockoutVideo.style.display = 'none';
        synthesisVideo.style.display = 'block';
        synthesisVideo.style.opacity = '1.0';
        synthesisVideo.style.clipPath = 'none';

        const hasVideo = (synthesisVideo.readyState >= 1 || isPlaying);
        overlayBlockout.style.display = 'none';
        overlaySynthesis.style.display = hasVideo ? 'none' : 'block';
        overlaySynthesis.style.opacity = '1.0';
        overlaySynthesis.style.clipPath = 'none';
        splitDivider.style.display = 'none';
        badgeLeft.style.display = 'none';
        badgeRight.style.display = 'block';
        badgeRight.textContent = 'STEP 3: OMNI NEURAL RECREATION';`;

if (!content.includes(oldSynthesisOnly)) {
  throw new Error('Could not find oldSynthesisOnly anchor');
}
content = content.replace(oldSynthesisOnly, newSynthesisOnly);

// 11. In wireframe and tracking, hide overlaySynthesis if hasVideo
const oldWireOnly = `      } else if (currentView === 'wireframe') {
        synthesisVideo.style.display = 'block';
        synthesisVideo.style.opacity = '1.0';
        synthesisVideo.style.clipPath = 'none';
        blockoutVideo.style.display = 'none';

        overlaySynthesis.style.display = 'block';
        overlaySynthesis.style.opacity = '1.0';
        overlaySynthesis.style.clipPath = 'none';
        overlayBlockout.style.display = 'none';`;

const newWireOnly = `      } else if (currentView === 'wireframe') {
        synthesisVideo.style.display = 'block';
        synthesisVideo.style.opacity = '1.0';
        synthesisVideo.style.clipPath = 'none';
        blockoutVideo.style.display = 'none';

        const hasVideo = (synthesisVideo.readyState >= 1 || isPlaying);
        overlaySynthesis.style.display = hasVideo ? 'none' : 'block';
        overlaySynthesis.style.opacity = '1.0';
        overlaySynthesis.style.clipPath = 'none';
        overlayBlockout.style.display = 'none';`;

if (content.includes(oldWireOnly)) {
  content = content.replace(oldWireOnly, newWireOnly);
}

const oldTrackOnly = `      } else if (currentView === 'tracking') {
        synthesisVideo.style.display = 'block';
        synthesisVideo.style.opacity = '1.0';
        synthesisVideo.style.clipPath = 'none';
        blockoutVideo.style.display = 'none';

        overlaySynthesis.style.display = 'block';
        overlaySynthesis.style.opacity = '1.0';
        overlaySynthesis.style.clipPath = 'none';
        overlayBlockout.style.display = 'none';`;

const newTrackOnly = `      } else if (currentView === 'tracking') {
        synthesisVideo.style.display = 'block';
        synthesisVideo.style.opacity = '1.0';
        synthesisVideo.style.clipPath = 'none';
        blockoutVideo.style.display = 'none';

        const hasVideo = (synthesisVideo.readyState >= 1 || isPlaying);
        overlaySynthesis.style.display = hasVideo ? 'none' : 'block';
        overlaySynthesis.style.opacity = '1.0';
        overlaySynthesis.style.clipPath = 'none';
        overlayBlockout.style.display = 'none';`;

if (content.includes(oldTrackOnly)) {
  content = content.replace(oldTrackOnly, newTrackOnly);
}

// Write the updated file
fs.writeFileSync(demoPath, content, 'utf8');
console.log('✅ Successfully updated public/plaza_matchmove_demo.html with 361-frame continuous trajectory and clean Omni keyframe stills.');
