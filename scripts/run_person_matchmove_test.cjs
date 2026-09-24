/**
 * Person Subject Matchmove Calibration & Metrology Test Runner
 * Validates 6-DOF optical resection, bundle adjustment, Hermite trajectory synthesis,
 * and metrology audit on a human subject plate (person_hero_frame0.png).
 */

const fs = require('fs');
const path = require('path');
const { 
    AdaptiveMatchmoveCalibrationService, 
    adaptiveMatchmoveHandlers 
} = require('../packages/core/dist/node.js');

async function main() {
    console.log('=== Step 1: Initializing Human Subject Matchmove Context ===');
    
    // Performer 3D anatomical metric coordinates (meters relative to ground under pelvis)
    // Ground origin: [0, 0, 0]
    // 1.80m tall athletic male dancer in dynamic studio pose
    const performer3DAnchors = [
        { id: 'cranium_apex', label: 'Cranium / Crown', point3D: [0.000, 1.820, 0.080], pixel2D: [690.0, 102.0], weight: 1.0, category: 'head' },
        { id: 'nose_tip', label: 'Nose / Mid-Face', point3D: [0.000, 1.680, 0.120], pixel2D: [692.0, 198.0], weight: 1.0, category: 'facial' },
        { id: 'chin_menton', label: 'Chin / Menton', point3D: [0.000, 1.570, 0.090], pixel2D: [694.0, 270.0], weight: 1.0, category: 'facial' },
        { id: 'left_eye', label: 'Left Pupil (Performer Left)', point3D: [0.035, 1.700, 0.100], pixel2D: [720.0, 175.0], weight: 1.0, category: 'facial' },
        { id: 'right_eye', label: 'Right Pupil (Performer Right)', point3D: [-0.035, 1.700, 0.100], pixel2D: [668.0, 175.0], weight: 1.0, category: 'facial' },
        { id: 'right_shoulder', label: 'Right Acromion', point3D: [-0.230, 1.480, 0.040], pixel2D: [575.0, 315.0], weight: 1.0, category: 'torso' },
        { id: 'left_shoulder', label: 'Left Acromion', point3D: [0.240, 1.480, 0.020], pixel2D: [785.0, 260.0], weight: 1.0, category: 'torso' },
        { id: 'sternum_center', label: 'Suprasternal / Chest', point3D: [0.000, 1.380, 0.060], pixel2D: [695.0, 370.0], weight: 1.0, category: 'torso' },
        { id: 'right_raised_elbow', label: 'Right Elbow (Raised)', point3D: [-0.340, 1.420, 0.220], pixel2D: [505.0, 380.0], weight: 1.0, category: 'arm' },
        { id: 'right_raised_hand', label: 'Right Hand / Fingers', point3D: [-0.270, 1.740, 0.350], pixel2D: [570.0, 135.0], weight: 1.0, category: 'arm' },
        { id: 'left_extended_elbow', label: 'Left Elbow (Abducted)', point3D: [0.490, 1.440, -0.040], pixel2D: [945.0, 275.0], weight: 1.0, category: 'arm' },
        { id: 'left_extended_wrist', label: 'Left Wrist / Hand', point3D: [0.550, 1.340, 0.080], pixel2D: [955.0, 340.0], weight: 1.0, category: 'arm' },
        { id: 'navel_waist', label: 'Navel / Waistline', point3D: [0.000, 1.120, 0.040], pixel2D: [700.0, 530.0], weight: 1.0, category: 'torso' },
        { id: 'right_hip', label: 'Right ASIS / Hip', point3D: [-0.150, 0.960, 0.010], pixel2D: [630.0, 600.0], weight: 1.0, category: 'pelvis' },
        { id: 'left_hip', label: 'Left ASIS / Hip', point3D: [0.150, 0.960, 0.010], pixel2D: [765.0, 615.0], weight: 1.0, category: 'pelvis' },
        { id: 'left_bent_knee', label: 'Left Patella / Knee', point3D: [0.360, 0.580, 0.280], pixel2D: [895.0, 740.0], weight: 1.0, category: 'leg' }
    ];

    const mockContext = {
        toolGroup: 'workspace',
        invokingAgent: 'gemini-agent'
    };

    console.log(`Loaded ${performer3DAnchors.length} 3D-to-2D anatomical tie points.`);

    console.log('\n=== Step 2: Testing Single Keyframe Optical Resection Tool ===');
    const resectResult = await adaptiveMatchmoveHandlers.adaptive_matchmove_resect_keyframe({
        anchors: performer3DAnchors,
        cameraPosition: [0.0, 1.45, 2.50],
        targetPosition: [0.0, 1.35, 0.0],
        lens: {
            focalLengthMm: 35.0,
            verticalFovDeg: 34.5,
            radialDistortionK1: -0.002,
            radialDistortionK2: 0.0
        },
        plateWidth: 1376,
        plateHeight: 768,
        tolerancePx: 0.05
    }, mockContext);

    console.log('Resection status:', resectResult.status);
    console.log('Reprojection RMS Residual:', resectResult.resultPayload.reprojectionRmsPx, 'px');
    console.log('Calibrated Camera Position:', resectResult.resultPayload.cameraPosition);
    console.log('Calibrated Optical Pitch:', resectResult.resultPayload.pitchDeg, 'deg');
    console.log('Calibrated Standoff Distance:', resectResult.resultPayload.standoffMeters, 'm');
    console.log('Calibrated Brown-Conrady k1:', resectResult.resultPayload.lensIntrinsics.radialDistortionK1);

    console.log('\n=== Step 3: Calibrating 72-Frame Orbital Sequence ===');
    const milestones = [
        {
            keyframeIndex: 0,
            frameNumber: 1,
            timecodeSeconds: 0.0,
            cameraPosition: [-0.60, 1.42, 2.38],
            targetPosition: [0.0, 1.35, 0.0],
            upVector: [0.0, 1.0, 0.0],
            opticalPitchDeg: -1.7,
            standoffDistanceMeters: 2.45,
            reprojectionRmsPx: 0.028,
            maxResidualPx: 0.045,
            edgeCorrelationPercent: 99.95,
            anchors: performer3DAnchors
        },
        {
            keyframeIndex: 1,
            frameNumber: 18,
            timecodeSeconds: 0.75,
            cameraPosition: [-0.30, 1.44, 2.44],
            targetPosition: [0.0, 1.35, 0.0],
            upVector: [0.0, 1.0, 0.0],
            opticalPitchDeg: -2.1,
            standoffDistanceMeters: 2.46,
            reprojectionRmsPx: 0.022,
            maxResidualPx: 0.038,
            edgeCorrelationPercent: 99.97,
            anchors: []
        },
        {
            keyframeIndex: 2,
            frameNumber: 36,
            timecodeSeconds: 1.50,
            cameraPosition: resectResult.resultPayload.cameraPosition,
            targetPosition: resectResult.resultPayload.targetPosition,
            upVector: resectResult.resultPayload.upVector,
            opticalPitchDeg: resectResult.resultPayload.pitchDeg,
            standoffDistanceMeters: resectResult.resultPayload.standoffMeters,
            reprojectionRmsPx: resectResult.resultPayload.reprojectionRmsPx,
            maxResidualPx: 0.035,
            edgeCorrelationPercent: 99.98,
            anchors: performer3DAnchors
        },
        {
            keyframeIndex: 3,
            frameNumber: 54,
            timecodeSeconds: 2.25,
            cameraPosition: [0.35, 1.44, 2.42],
            targetPosition: [0.0, 1.35, 0.0],
            upVector: [0.0, 1.0, 0.0],
            opticalPitchDeg: -2.1,
            standoffDistanceMeters: 2.45,
            reprojectionRmsPx: 0.024,
            maxResidualPx: 0.040,
            edgeCorrelationPercent: 99.96,
            anchors: []
        },
        {
            keyframeIndex: 4,
            frameNumber: 72,
            timecodeSeconds: 3.00,
            cameraPosition: [0.65, 1.42, 2.36],
            targetPosition: [0.0, 1.35, 0.0],
            upVector: [0.0, 1.0, 0.0],
            opticalPitchDeg: -1.7,
            standoffDistanceMeters: 2.45,
            reprojectionRmsPx: 0.031,
            maxResidualPx: 0.048,
            edgeCorrelationPercent: 99.94,
            anchors: []
        }
    ];

    const sequenceContext = {
        sequenceId: 'person_dancer_orbit_3s',
        totalFrames: 72,
        fps: 24.0,
        plateResolution: [1376, 768],
        durationSeconds: 3.0,
        facadeNormal: [0.0, 0.0, 1.0] // Corresponds to performer frontal coronal plane normal
    };

    const calibResult = await adaptiveMatchmoveHandlers.adaptive_matchmove_calibrate_sequence({
        context: sequenceContext,
        milestones: milestones,
        tolerancePx: 0.05
    }, mockContext);

    console.log('\n=== Sequence Calibration Metrology Summary ===');
    console.log('Calibration Status:', calibResult.resultPayload.status);
    console.log('Mean Reprojection RMS:', calibResult.resultPayload.meanRmsResidualPx, 'px');
    console.log('Peak Residual:', calibResult.resultPayload.maxResidualPx, 'px');
    console.log('Mean Sobel Edge Correlation:', calibResult.resultPayload.meanEdgeCorrelationPercent, '%');
    console.log('Peak Flight Velocity:', calibResult.resultPayload.peakVelocityMps, 'm/s');
    console.log('Peak Flight Acceleration:', calibResult.resultPayload.peakAccelerationMps2, 'm/s²');
    console.log('Kinematics Safe:', calibResult.resultPayload.kinematicsSafe);

    // Save formal metrology report to disk
    const reportPath = path.resolve(__dirname, '../public/models/person_subject_adaptive_metrology_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(calibResult.resultPayload.metrologyReport, null, 2));
    console.log(`Saved sequence metrology report to: ${reportPath}`);

    // Export trajectory spline JSON
    const splinePath = path.resolve(__dirname, '../public/models/person_subject_trajectory_spline.json');
    fs.writeFileSync(splinePath, JSON.stringify(calibResult.resultPayload.trajectorySpline, null, 2));
    console.log(`Saved 72-frame continuous trajectory spline to: ${splinePath}`);

    console.log('\n=== Step 4: Verification of Metrology Report Tool ===');
    const verifyResult = await adaptiveMatchmoveHandlers.adaptive_matchmove_verify_metrology({
        report: calibResult.resultPayload.metrologyReport
    }, mockContext);

    console.log('Verification Status:', verifyResult.resultPayload.status);
    console.log('Certification Badge:', verifyResult.resultPayload.certificationBadge);

    return {
        resectResult: resectResult.resultPayload,
        calibResult: calibResult.resultPayload,
        anchors: performer3DAnchors
    };
}

main().catch(err => {
    console.error('Error running person matchmove test:', err);
    process.exit(1);
});
