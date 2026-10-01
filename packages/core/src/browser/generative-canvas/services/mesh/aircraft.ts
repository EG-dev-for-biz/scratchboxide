/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

/**
 * Articulated aircraft generator with dynamic control surfaces.
 *
 * This is the single source of truth for the procedural aircraft used by the Scene3D viewport.
 * The Live Code Sandbox template string that mirrors these helpers lives next door in
 * `aircraft-template.ts`; a test asserts the two stay in sync (names + signatures).
 */
export interface ArticulatedAircraftComponents {
    group: THREE.Group;
    leftAileron: THREE.Mesh;
    rightAileron: THREE.Mesh;
    rudder: THREE.Mesh;
    leftElevator: THREE.Mesh;
    rightElevator: THREE.Mesh;
    turbines: THREE.Mesh[];
    thrusters: THREE.Mesh[];
    exhausts: THREE.Points[];
    thrusterMat: THREE.MeshBasicMaterial;
    contrailEmitters: THREE.Object3D[];
}

export const createArticulatedAircraft = (): ArticulatedAircraftComponents => {
    const planeGroup = new THREE.Group();

    // Materials
    const fuselageMat = new THREE.MeshStandardMaterial({
        color: 0xecf0f1,
        metalness: 0.85,
        roughness: 0.15
    });
    const wingMat = new THREE.MeshStandardMaterial({
        color: 0x0088ff,
        metalness: 0.7,
        roughness: 0.2
    });
    const controlSurfaceMat = new THREE.MeshStandardMaterial({
        color: 0x0055cc,
        metalness: 0.8,
        roughness: 0.25
    });
    const canopyMat = new THREE.MeshPhysicalMaterial({
        color: 0x00f0ff,
        metalness: 0.1,
        roughness: 0.1,
        transparent: true,
        opacity: 0.75,
        transmission: 0.7
    });
    const engineMat = new THREE.MeshStandardMaterial({
        color: 0x2c3e50,
        metalness: 0.9,
        roughness: 0.1
    });
    const thrusterGlowMat = new THREE.MeshBasicMaterial({
        color: 0x00f6ff
    });

    // 1. Fuselage (main body: tapered cylinder aligned along Z axis)
    const bodyGeo = new THREE.CylinderGeometry(0.4, 0.55, 5.0, 16);
    bodyGeo.rotateX(Math.PI / 2); // Orient along Z axis
    const bodyMesh = new THREE.Mesh(bodyGeo, fuselageMat);
    planeGroup.add(bodyMesh);

    // Nose Cone (streamlined aerodynamic tip)
    const noseGeo = new THREE.ConeGeometry(0.4, 1.4, 16);
    noseGeo.rotateX(-Math.PI / 2); // Point forward along +Z
    const noseMesh = new THREE.Mesh(noseGeo, fuselageMat);
    noseMesh.position.set(0, 0, 3.2);
    planeGroup.add(noseMesh);

    // 2. Cockpit Glass Canopy
    const canopyGeo = new THREE.SphereGeometry(0.38, 16, 16);
    canopyGeo.scale(0.75, 0.7, 1.8);
    const canopyMesh = new THREE.Mesh(canopyGeo, canopyMat);
    canopyMesh.position.set(0, 0.42, 1.0);
    planeGroup.add(canopyMesh);

    // 3. Swept Delta Main Wings
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 1.2);
    wingShape.lineTo(4.8, -1.0);
    wingShape.lineTo(4.5, -1.8);
    wingShape.lineTo(0, -0.6);
    wingShape.closePath();

    const extrudeSettings = { depth: 0.08, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.02, bevelThickness: 0.02 };
    const rightWingGeo = new THREE.ExtrudeGeometry(wingShape, extrudeSettings);
    rightWingGeo.rotateX(Math.PI / 2);
    const rightWing = new THREE.Mesh(rightWingGeo, wingMat);
    rightWing.position.set(0, 0.06, 0.3);
    planeGroup.add(rightWing);

    const leftWingShape = new THREE.Shape();
    leftWingShape.moveTo(0, 1.2);
    leftWingShape.lineTo(-4.8, -1.0);
    leftWingShape.lineTo(-4.5, -1.8);
    leftWingShape.lineTo(0, -0.6);
    leftWingShape.closePath();

    const leftWingGeo = new THREE.ExtrudeGeometry(leftWingShape, extrudeSettings);
    leftWingGeo.rotateX(Math.PI / 2);
    const leftWing = new THREE.Mesh(leftWingGeo, wingMat);
    leftWing.position.set(0, 0.06, 0.3);
    planeGroup.add(leftWing);

    // Articulated Left & Right Ailerons on Wing Trailing Edges
    const aileronGeo = new THREE.BoxGeometry(1.4, 0.06, 0.35);
    const leftAileron = new THREE.Mesh(aileronGeo, controlSurfaceMat);
    leftAileron.position.set(-3.2, 0.06, -1.4);
    planeGroup.add(leftAileron);

    const rightAileron = new THREE.Mesh(aileronGeo, controlSurfaceMat);
    rightAileron.position.set(3.2, 0.06, -1.4);
    planeGroup.add(rightAileron);

    // 4. Vertical Tail Fin with Articulated Rudder
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0);
    finShape.lineTo(0, 1.5);
    finShape.lineTo(-0.8, 1.5);
    finShape.lineTo(-1.4, 0);
    finShape.closePath();

    const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.06, bevelEnabled: false });
    finGeo.rotateY(Math.PI / 2);
    const finMesh = new THREE.Mesh(finGeo, wingMat);
    finMesh.position.set(0.03, 0.35, -1.6);
    planeGroup.add(finMesh);

    const rudderGeo = new THREE.BoxGeometry(0.05, 1.2, 0.35);
    const rudder = new THREE.Mesh(rudderGeo, controlSurfaceMat);
    rudder.position.set(0.03, 0.95, -2.1);
    planeGroup.add(rudder);

    // 5. Horizontal Tail Stabilizers with Articulated Elevators
    const stabShape = new THREE.Shape();
    stabShape.moveTo(0, 0.2);
    stabShape.lineTo(1.8, -0.5);
    stabShape.lineTo(1.6, -0.8);
    stabShape.lineTo(0, -0.5);
    stabShape.closePath();

    const stabGeo = new THREE.ExtrudeGeometry(stabShape, extrudeSettings);
    stabGeo.rotateX(Math.PI / 2);
    const rightStab = new THREE.Mesh(stabGeo, wingMat);
    rightStab.position.set(0, 0.18, -2.0);
    planeGroup.add(rightStab);

    const leftStabShape = new THREE.Shape();
    leftStabShape.moveTo(0, 0.2);
    leftStabShape.lineTo(-1.8, -0.5);
    leftStabShape.lineTo(-1.6, -0.8);
    leftStabShape.lineTo(0, -0.5);
    leftStabShape.closePath();

    const leftStabGeo = new THREE.ExtrudeGeometry(leftStabShape, extrudeSettings);
    leftStabGeo.rotateX(Math.PI / 2);
    const leftStab = new THREE.Mesh(leftStabGeo, wingMat);
    leftStab.position.set(0, 0.18, -2.0);
    planeGroup.add(leftStab);

    const elevGeo = new THREE.BoxGeometry(1.2, 0.05, 0.25);
    const leftElevator = new THREE.Mesh(elevGeo, controlSurfaceMat);
    leftElevator.position.set(-1.0, 0.18, -2.6);
    planeGroup.add(leftElevator);

    const rightElevator = new THREE.Mesh(elevGeo, controlSurfaceMat);
    rightElevator.position.set(1.0, 0.18, -2.6);
    planeGroup.add(rightElevator);

    // Navigation lights (Red on Port/Left, Green on Starboard/Right, White on Tail)
    const portLight = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xff0044 })
    );
    portLight.position.set(-4.75, 0.08, -1.1);
    planeGroup.add(portLight);

    const starboardLight = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0x00ff66 })
    );
    starboardLight.position.set(4.75, 0.08, -1.1);
    planeGroup.add(starboardLight);

    const tailStrobe = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    tailStrobe.position.set(0.03, 1.85, -2.1);
    planeGroup.add(tailStrobe);

    // Cockpit internal HUD glow panel
    const hudPanel = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 0.15, 0.02),
        new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.9 })
    );
    hudPanel.position.set(0, 0.42, 1.4);
    hudPanel.rotateX(-0.3);
    planeGroup.add(hudPanel);

    // 6. Dual Turbofan Engines & Afterburners Under Wings
    const turbines: THREE.Mesh[] = [];
    const thrusters: THREE.Mesh[] = [];
    const exhausts: THREE.Points[] = [];

    const createEngine = (xPos: number) => {
        const engGroup = new THREE.Group();
        const engBody = new THREE.Mesh(
            new THREE.CylinderGeometry(0.24, 0.26, 1.6, 16),
            engineMat
        );
        engBody.rotateX(Math.PI / 2);
        engGroup.add(engBody);

        // Rotating turbine intake fan disk
        const turbineGeo = new THREE.CircleGeometry(0.22, 10);
        const turbineMat = new THREE.MeshBasicMaterial({ color: 0x111111, wireframe: true });
        const turbine = new THREE.Mesh(turbineGeo, turbineMat);
        turbine.position.set(0, 0, 0.81);
        engGroup.add(turbine);
        turbines.push(turbine);

        // Glowing cyan thruster ring / afterburner
        const thruster = new THREE.Mesh(
            new THREE.CylinderGeometry(0.2, 0.2, 0.1, 16),
            thrusterGlowMat
        );
        thruster.rotateX(Math.PI / 2);
        thruster.position.set(0, 0, -0.8);
        engGroup.add(thruster);
        thrusters.push(thruster);

        // Jet exhaust particle trail
        const pCount = 30;
        const pPositions = new Float32Array(pCount * 3);
        for (let p = 0; p < pCount; p++) {
            pPositions[p * 3] = (Math.random() - 0.5) * 0.16;
            pPositions[p * 3 + 1] = (Math.random() - 0.5) * 0.16;
            pPositions[p * 3 + 2] = -0.9 - Math.random() * 2.2;
        }
        const pGeo = new THREE.BufferGeometry();
        pGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
        const pMat = new THREE.PointsMaterial({
            color: 0x00f6ff,
            size: 0.12,
            transparent: true,
            opacity: 0.75,
            blending: THREE.AdditiveBlending
        });
        const exhaust = new THREE.Points(pGeo, pMat);
        engGroup.add(exhaust);
        exhausts.push(exhaust);

        engGroup.position.set(xPos, -0.28, 0.2);
        return engGroup;
    };

    planeGroup.add(createEngine(1.6));
    planeGroup.add(createEngine(-1.6));

    // Wingtip contrail emitter anchors
    const leftEmitter = new THREE.Object3D();
    leftEmitter.position.set(-4.75, 0.08, -1.6);
    planeGroup.add(leftEmitter);

    const rightEmitter = new THREE.Object3D();
    rightEmitter.position.set(4.75, 0.08, -1.6);
    planeGroup.add(rightEmitter);

    planeGroup.userData = {
        leftAileron,
        rightAileron,
        rudder,
        leftElevator,
        rightElevator,
        turbines,
        thrusters,
        exhausts,
        thrusterMat: thrusterGlowMat,
        contrailEmitters: [leftEmitter, rightEmitter]
    };

    return {
        group: planeGroup,
        leftAileron,
        rightAileron,
        rudder,
        leftElevator,
        rightElevator,
        turbines,
        thrusters,
        exhausts,
        thrusterMat: thrusterGlowMat,
        contrailEmitters: [leftEmitter, rightEmitter]
    };
};

export const createAirplaneMesh = (): THREE.Group => {
    return createArticulatedAircraft().group;
};

export const updateFlightPhysics = (
    aircraft: THREE.Group,
    time: number,
    delta: number,
    options: { bankScale?: number; pitchScale?: number } = {}
) => {
    const bankScale = options.bankScale || 1.0;
    const pitchScale = options.pitchScale || 1.0;

    const bankAngle = Math.sin(time * 2.0) * 0.15 * bankScale;
    const pitchAngle = Math.cos(time * 1.2) * 0.08 * pitchScale;
    const altitudeBob = Math.sin(time * 2.0) * 0.45;
    const yawAngle = time * 0.8;

    aircraft.rotation.z = bankAngle;
    aircraft.rotation.x = pitchAngle;
    aircraft.position.y = 3.5 + altitudeBob;
    aircraft.position.x = Math.sin(yawAngle) * 3.5;
    aircraft.position.z = Math.cos(yawAngle) * 3.5;
    aircraft.rotation.y = yawAngle + Math.PI / 2;

    const ud = aircraft.userData;
    if (ud) {
        if (ud.leftAileron && ud.rightAileron) {
            ud.leftAileron.rotation.x = bankAngle * 2.0;
            ud.rightAileron.rotation.x = -bankAngle * 2.0;
        }
        if (ud.leftElevator && ud.rightElevator) {
            ud.leftElevator.rotation.x = pitchAngle * 2.5;
            ud.rightElevator.rotation.x = pitchAngle * 2.5;
        }
        if (ud.rudder) {
            ud.rudder.rotation.y = -Math.cos(time * 2.0) * 0.25;
        }
        if (ud.turbines && Array.isArray(ud.turbines)) {
            for (const turb of ud.turbines) {
                turb.rotation.z += delta * 40;
            }
        }
    }
};

/**
 * Per-frame aircraft animation used by the Scene3D viewport render loop: flight kinematics plus
 * afterburner pulse and exhaust particle streaming. `playbackSpeed` scales engine-related motion.
 */
export const animateAircraftFrame = (
    aircraft: THREE.Group,
    time: number,
    deltaMs: number,
    playbackSpeed: number = 1.0
): void => {
    const bankAngle = Math.sin(time * 2.0) * 0.15;
    const pitchAngle = Math.cos(time * 1.2) * 0.08;
    const altitudeBob = Math.sin(time * 2.0) * 0.45;
    const yawAngle = time * 0.8;

    aircraft.rotation.z = bankAngle;
    aircraft.rotation.x = pitchAngle;
    aircraft.position.y = 3.5 + altitudeBob;
    aircraft.position.x = Math.sin(yawAngle) * 3.5;
    aircraft.position.z = Math.cos(yawAngle) * 3.5;
    aircraft.rotation.y = yawAngle + Math.PI / 2;

    const ud = aircraft.userData;
    if (!ud) return;

    // Articulated aileron roll deflections
    if (ud.leftAileron && ud.rightAileron) {
        ud.leftAileron.rotation.x = bankAngle * 2.0;
        ud.rightAileron.rotation.x = -bankAngle * 2.0;
    }
    // Articulated elevator pitch deflections
    if (ud.leftElevator && ud.rightElevator) {
        ud.leftElevator.rotation.x = pitchAngle * 2.5;
        ud.rightElevator.rotation.x = pitchAngle * 2.5;
    }
    // Articulated rudder yaw deflections
    if (ud.rudder) {
        ud.rudder.rotation.y = -Math.cos(time * 2.0) * 0.25;
    }
    // Turbofan engine spin
    if (ud.turbines && Array.isArray(ud.turbines)) {
        for (const turb of ud.turbines) {
            turb.rotation.z += (deltaMs * 0.04) * playbackSpeed;
        }
    }
    // Afterburner thruster pulsation
    if (ud.thrusterMat && ud.thrusterMat.color) {
        const pulse = 0.7 + Math.sin(time * 15.0) * 0.3;
        ud.thrusterMat.color.setRGB(0, 0.9 * pulse, 1.0 * pulse);
    }
    // Jet exhaust particle trail
    if (ud.exhausts && Array.isArray(ud.exhausts)) {
        for (const exhaust of ud.exhausts) {
            const posAttr = exhaust.geometry?.attributes?.position as THREE.BufferAttribute | undefined;
            if (posAttr) {
                for (let j = 0; j < posAttr.count; j++) {
                    let pz = posAttr.getZ(j);
                    pz -= (deltaMs * 0.008) * playbackSpeed;
                    if (pz < -3.5) {
                        pz = -0.9 + Math.random() * 0.2;
                    }
                    posAttr.setZ(j, pz);
                }
                posAttr.needsUpdate = true;
            }
        }
    }
};
