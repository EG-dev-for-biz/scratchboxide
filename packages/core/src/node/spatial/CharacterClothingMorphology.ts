/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export interface CharacterClothingMorphologyOptions {
    /** Target radius for wide palazzo pants around leg bone axis (meters). Default 0.135m. */
    palazzoPantsRadius?: number;
    /** Flare addition at bottom pant hem/cuff (meters). Default 0.025m. */
    palazzoFlareRadius?: number;
    /** Lateral half-width for boxy untucked tunic button-down shirt (meters). Default 0.225m. */
    tunicHalfWidth?: number;
    /** Sagittal half-depth for boxy untucked tunic button-down shirt (meters). Default 0.135m. */
    tunicHalfDepth?: number;
    /** Bottom Y elevation for tunic hem over thighs (meters). Default 0.72m. */
    tunicHemY?: number;
    /** Billowy sleeve radius for upper arm and forearm (meters). Default 0.088m. */
    sleeveRadius?: number;
    /** Outer lateral half-width of over-ear headphones at ears (meters). Default 0.118m. */
    headphoneLateralOffset?: number;
    /** Height lift for headphone overhead headband arch (meters). Default 0.025m. */
    headbandArchLift?: number;
    /** Lateral leg abduction spread for wide grounded dance stance (meters). Default 0.30m. */
    legStanceSpread?: number;
}

export class CharacterClothingMorphology {
    /**
     * Maps 55 SbHuman joints or raw joint IDs down to the standard 22 SB-Human body joints.
     */
    public static mapJointTo22(j: number): number {
        if (j <= 21 && j >= 0) return j;
        if (j >= 22 && j <= 24) return 15; // Jaw, eyes -> Head
        if (j >= 25 && j <= 39) return 20; // Left hand fingers -> LeftWrist
        if (j >= 40 && j <= 54) return 21; // Right hand fingers -> RightWrist
        return 0;
    }

    /**
     * Applies non-rigid clothing morphology deformations to 3D surface vertices
     * (or sampled Gaussian centers), converting a bare anatomical body into authentic
     * character attire (flowing wide palazzo pants, boxy oversized tunic shirt,
     * billowy sleeves, over-ear headphones, and grounded dance stance).
     *
     * In-place deformation on `positions` array (Float32Array [x, y, z, ...]).
     */
    public static applyMorphology(
        positions: Float32Array,
        boneIndices: Uint8Array | Uint16Array | Uint32Array | Int32Array | number[],
        numVertices: number,
        options: CharacterClothingMorphologyOptions = {}
    ): Float32Array {
        const palazzoR = options.palazzoPantsRadius ?? 0.135;
        const palazzoFlare = options.palazzoFlareRadius ?? 0.025;
        const tunicW = options.tunicHalfWidth ?? 0.225;
        const tunicD = options.tunicHalfDepth ?? 0.135;
        const tunicHemY = options.tunicHemY ?? 0.72;
        const sleeveR = options.sleeveRadius ?? 0.088;
        const hpOffset = options.headphoneLateralOffset ?? 0.118;
        const hpLift = options.headbandArchLift ?? 0.025;
        const stanceSpread = options.legStanceSpread ?? 0.30;

        for (let i = 0; i < numVertices; i++) {
            const rawJ = Array.isArray(boneIndices) ? boneIndices[i * 4] : boneIndices[i * 4];
            const primaryJoint = this.mapJointTo22(rawJ);

            let x = positions[i * 3];
            let y = positions[i * 3 + 1];
            let z = positions[i * 3 + 2];

            const isLeftLeg = [1, 4, 7, 10].includes(primaryJoint);
            const isRightLeg = [2, 5, 8, 11].includes(primaryJoint);
            const isTorso = [0, 3, 6, 9].includes(primaryJoint);
            const isLeftArm = [16, 18, 20].includes(primaryJoint);
            const isRightArm = [17, 19, 21].includes(primaryJoint);
            const isHead = primaryJoint === 15;

            // 1. Wide Grounded Stance Abduction & Palazzo Pants (Legs Y in [0.11m .. 0.88m])
            if (isLeftLeg && y < 0.88) {
                const abductFrac = Math.max(0, Math.min(1.0, (0.88 - y) / 0.85));
                x += stanceSpread * abductFrac;

                // Palazzo pants radial cylinder expansion - strictly for pant legs above the ankle cuff (Y >= 0.11m)
                if (y >= 0.11) {
                    const axisX = 0.075 + stanceSpread * abductFrac;
                    const axisZ = -0.02;
                    const dx = x - axisX;
                    const dz = z - axisZ;
                    const r = Math.hypot(dx, dz) || 0.001;
                    const targetR = palazzoR + palazzoFlare * abductFrac;
                    if (r < targetR) {
                        const expFactor = targetR / r;
                        x = axisX + dx * expFactor;
                        z = axisZ + dz * expFactor;
                    }
                }
            } else if (isRightLeg && y < 0.88) {
                const abductFrac = Math.max(0, Math.min(1.0, (0.88 - y) / 0.85));
                x -= stanceSpread * abductFrac;

                if (y >= 0.11) {
                    const axisX = -0.075 - stanceSpread * abductFrac;
                    const axisZ = -0.02;
                    const dx = x - axisX;
                    const dz = z - axisZ;
                    const r = Math.hypot(dx, dz) || 0.001;
                    const targetR = palazzoR + palazzoFlare * abductFrac;
                    if (r < targetR) {
                        const expFactor = targetR / r;
                        x = axisX + dx * expFactor;
                        z = axisZ + dz * expFactor;
                    }
                }
            }

            // 2. Oversized Boxy Tunic Shirt (Torso and Upper Thighs Y in [tunicHemY .. 1.28m])
            // Smooth elliptical proportional cloth drape without hollow cavities or planar tears
            if (isTorso || (y >= (tunicHemY - 0.04) && y <= 1.28 && Math.abs(x) < 0.32)) {
                if (y >= (tunicHemY - 0.04) && y <= 1.28) {
                    const tau = Math.max(0, Math.min(1.0, (y - tunicHemY) / (1.28 - tunicHemY)));
                    // Tunic width: straight/relaxed drop from chest (0.21m) flaring slightly to hem (0.225m)
                    const targetW = tunicW * (0.93 + 0.07 * (1.0 - tau));
                    // Tunic depth: relaxed sagittal drape from chest (0.125m) flaring slightly to hem (0.135m)
                    const targetD = tunicD * (0.92 + 0.08 * (1.0 - tau));

                    const rho = Math.hypot(x / targetW, z / targetD) || 0.001;
                    if (rho < 1.0) {
                        // Smooth vertical transitions at collar/shoulders and bottom hem
                        const blendTop = Math.max(0, Math.min(1.0, (1.28 - y) / 0.06));
                        const blendBottom = Math.max(0, Math.min(1.0, (y - (tunicHemY - 0.04)) / 0.06));
                        const blend = blendTop * blendBottom;

                        const scale = 1.0 + ((1.0 / rho) - 1.0) * blend;
                        x *= scale;
                        z *= scale;
                    }
                }
            }

            // 3. Billowy Silk Sleeves & Dropped Shoulders
            if (isLeftArm || isRightArm) {
                const armSign = isLeftArm ? 1 : -1;
                if (y >= 1.00 && y <= 1.45) {
                    // Slight dropped shoulder expansion
                    if (y >= 1.32 && Math.abs(x) > 0.16) {
                        x += armSign * 0.035;
                    }
                    // Billowy sleeve cross-section
                    if (y >= 1.05 && y <= 1.35) {
                        const armAxisX = armSign * (0.24 + (1.35 - y) * 0.12);
                        const armAxisZ = -0.02;
                        const adx = x - armAxisX;
                        const adz = z - armAxisZ;
                        const ar = Math.hypot(adx, adz) || 0.001;
                        if (ar < sleeveR) {
                            const aScale = sleeveR / ar;
                            x = armAxisX + adx * aScale;
                            z = armAxisZ + adz * aScale;
                        }
                    }
                }
            }

            // 4. Over-Ear Pink Headphones (Head Y in [1.48 .. 1.74m])
            if (isHead) {
                // Lateral ear cups
                if (y >= 1.50 && y <= 1.66 && Math.abs(z) < 0.055) {
                    if (x > 0.065) x = Math.max(x, hpOffset);
                    if (x < -0.065) x = Math.min(x, -hpOffset);
                }
                // Headband top arch
                if (y >= 1.67 && y <= 1.73 && Math.abs(z) < 0.035) {
                    y += hpLift;
                }
            }

            // 5. Chunky Athletic Sneakers (Feet Y < 0.11m or joints 7, 8, 10, 11)
            const isFootRegion = (primaryJoint === 10 || primaryJoint === 11 || primaryJoint === 7 || primaryJoint === 8) && y < 0.11;
            if (isFootRegion || y < 0.08) {
                const footSign = (x >= 0 || primaryJoint === 10 || primaryJoint === 7) ? 1 : -1;
                const footAxisX = footSign * (0.075 + stanceSpread);

                // A. Ground Contact: strictly clamp to stage floor (Y >= 0.00m)
                y = Math.max(0.00, y);

                // B. Thick Outsole Rubber Platform (Y in [0.00m .. 0.035m])
                if (y <= 0.035) {
                    const dx = x - footAxisX;
                    // Slightly widen outsole platform for stability
                    x = footAxisX + dx * 1.15;
                }

                // C. Forward Toe Box Extension (Z > -0.01m)
                if (z > -0.01) {
                    const toeFrac = Math.max(0, Math.min(1.0, (z + 0.01) / 0.08));
                    z += 0.030 * toeFrac;
                }

                // D. Heel Counter Curve (Z < -0.03m)
                if (z < -0.03) {
                    const heelFrac = Math.max(0, Math.min(1.0, (-0.03 - z) / 0.04));
                    z -= 0.012 * heelFrac;
                }

                // E. Sneaker Upper lateral profile (half-width ~5.6cm)
                const dx = x - footAxisX;
                const currentHalfW = Math.abs(dx);
                const targetShoeHalfW = 0.056;
                if (currentHalfW > targetShoeHalfW && currentHalfW < 0.14) {
                    x = footAxisX + Math.sign(dx || 1) * targetShoeHalfW;
                }
            }

            positions[i * 3]     = x;
            positions[i * 3 + 1] = y;
            positions[i * 3 + 2] = z;
        }

        return positions;
    }

    /**
     * Recomputes surface vertex normals from triangle index buffer.
     */
    public static recomputeNormals(
        positions: Float32Array,
        normals: Float32Array,
        indices: Uint32Array | number[]
    ): void {
        normals.fill(0);
        const numTriangles = Math.floor(indices.length / 3);

        for (let t = 0; t < numTriangles; t++) {
            const i0 = indices[t * 3];
            const i1 = indices[t * 3 + 1];
            const i2 = indices[t * 3 + 2];

            const p0x = positions[i0 * 3],     p0y = positions[i0 * 3 + 1],     p0z = positions[i0 * 3 + 2];
            const p1x = positions[i1 * 3],     p1y = positions[i1 * 3 + 1],     p1z = positions[i1 * 3 + 2];
            const p2x = positions[i2 * 3],     p2y = positions[i2 * 3 + 1],     p2z = positions[i2 * 3 + 2];

            const ax = p1x - p0x, ay = p1y - p0y, az = p1z - p0z;
            const bx = p2x - p0x, by = p2y - p0y, bz = p2z - p0z;

            const nx = ay * bz - az * by;
            const ny = az * bx - ax * bz;
            const nz = ax * by - ay * bx;

            normals[i0 * 3]     += nx;
            normals[i0 * 3 + 1] += ny;
            normals[i0 * 3 + 2] += nz;

            normals[i1 * 3]     += nx;
            normals[i1 * 3 + 1] += ny;
            normals[i1 * 3 + 2] += nz;

            normals[i2 * 3]     += nx;
            normals[i2 * 3 + 1] += ny;
            normals[i2 * 3 + 2] += nz;
        }

        const numVerts = Math.floor(positions.length / 3);
        for (let v = 0; v < numVerts; v++) {
            const nx = normals[v * 3];
            const ny = normals[v * 3 + 1];
            const nz = normals[v * 3 + 2];
            const len = Math.hypot(nx, ny, nz) || 1.0;
            normals[v * 3]     = nx / len;
            normals[v * 3 + 1] = ny / len;
            normals[v * 3 + 2] = nz / len;
        }
    }

    /**
     * Widens leg joint positions in-place to match authentic grounded wide dance stance.
     * Abducts knees, ankles, and feet laterally while preserving spine, torso, and head alignment.
     */
    public static alignJointStance(
        joints: Array<[number, number, number] | number[]>,
        stanceSpread: number = 0.30
    ): void {
        const leftLegJoints = [4, 7, 10]; // LeftKnee, LeftAnkle, LeftFoot
        const rightLegJoints = [5, 8, 11]; // RightKnee, RightAnkle, RightFoot

        for (const j of leftLegJoints) {
            if (joints[j]) {
                const y = joints[j][1];
                const abductFrac = Math.max(0, Math.min(1.0, (0.88 - y) / 0.85));
                joints[j][0] += stanceSpread * abductFrac;
            }
        }

        for (const j of rightLegJoints) {
            if (joints[j]) {
                const y = joints[j][1];
                const abductFrac = Math.max(0, Math.min(1.0, (0.88 - y) / 0.85));
                joints[j][0] -= stanceSpread * abductFrac;
            }
        }
    }
}
