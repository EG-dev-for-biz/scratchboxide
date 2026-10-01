/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    PhysicalSensorFormatId,
    PhysicalSensorFormat,
    PHYSICAL_SENSOR_PRESETS,
    FULL_FRAME_DIAGONAL_MM,
    PhysicalCameraConfig,
    OpticalFrustumCalculation,
    DynamicFocusTrackingState
} from './physical-camera-protocol';

/**
 * High-precision physical camera and optical geometry engine.
 * Converts real camera and lens specifications into exact Three.js viewport FOVs,
 * calculates hyperfocal and depth-of-field limits, and tracks dynamic focus planes.
 */
export class PhysicalCameraModel {

    /**
     * Resolves the effective physical sensor format from configuration.
     */
    public static resolveSensorFormat(config: PhysicalCameraConfig): PhysicalSensorFormat {
        if (config.customSensorDimensions) {
            const w = Math.max(config.customSensorDimensions.widthMm, 1.0);
            const h = Math.max(config.customSensorDimensions.heightMm, 1.0);
            const diag = Math.sqrt(w * w + h * h);
            return {
                id: 'custom',
                name: `Custom (${w.toFixed(1)}x${h.toFixed(1)}mm)`,
                widthMm: w,
                heightMm: h,
                diagonalMm: diag,
                cropFactor: FULL_FRAME_DIAGONAL_MM / diag,
                aspectRatio: w / h,
                description: 'Custom user-specified physical sensor format.'
            };
        }

        const formatId = config.sensorFormat ?? config.sensorFormatPreset ?? 'full_frame_35mm';
        if (formatId === 'custom') {
            return PHYSICAL_SENSOR_PRESETS.full_frame_35mm;
        }

        return PHYSICAL_SENSOR_PRESETS[formatId] ?? PHYSICAL_SENSOR_PRESETS.full_frame_35mm;
    }

    /**
     * Retrieves sensor dimensions by preset or custom dimensions.
     */
    public static getSensorDimensions(
        presetId?: PhysicalSensorFormatId,
        customWidthMm?: number,
        customHeightMm?: number
    ): PhysicalSensorFormat {
        if (presetId === 'custom' || (customWidthMm && customHeightMm)) {
            const w = Math.max(customWidthMm ?? 36.0, 1.0);
            const h = Math.max(customHeightMm ?? 24.0, 1.0);
            const diag = Math.sqrt(w * w + h * h);
            return {
                id: 'custom',
                name: `Custom (${w.toFixed(1)}x${h.toFixed(1)}mm)`,
                widthMm: w,
                heightMm: h,
                diagonalMm: diag,
                cropFactor: FULL_FRAME_DIAGONAL_MM / diag,
                aspectRatio: w / h,
                description: 'Custom user-specified physical sensor format.'
            };
        }
        const id = presetId ?? 'full_frame_35mm';
        return PHYSICAL_SENSOR_PRESETS[id] ?? PHYSICAL_SENSOR_PRESETS.full_frame_35mm;
    }

    /**
     * Calculates the field of view angle in degrees from focal length and sensor dimension.
     * Formula: FOV = 2 * arctan(sensorDimension / (2 * focalLength))
     */
    public static calculateFov(focalLengthMm: number, sensorDimensionMm: number): number {
        const safeFocal = Math.max(focalLengthMm, 0.5);
        const safeDim = Math.max(sensorDimensionMm, 0.1);
        const rad = 2.0 * Math.atan(safeDim / (2.0 * safeFocal));
        return (rad * 180.0) / Math.PI;
    }

    /**
     * Calculates optical focal length in mm from field of view angle and sensor dimension.
     * Formula: focalLength = sensorDimension / (2 * tan(FOV / 2))
     */
    public static calculateFocalLength(fovDegrees: number, sensorDimensionMm: number): number {
        const safeFov = Math.max(0.1, Math.min(179.0, fovDegrees));
        const radHalf = (safeFov * Math.PI) / 360.0;
        return sensorDimensionMm / (2.0 * Math.tan(radHalf));
    }

    /**
     * Alias for calculateFocalLength.
     */
    public static calculateFocalLengthFromFov(fovDegrees: number, sensorDimensionMm: number): number {
        return this.calculateFocalLength(fovDegrees, sensorDimensionMm);
    }

    /**
     * Computes the optical hyperfocal distance in meters.
     * Formula: H = (f^2 / (N * c)) + f
     * where f = focal length, N = f-stop, c = circle of confusion (diagonal / 1500).
     */
    public static calculateHyperfocalDistance(
        focalLengthMm: number,
        fStop: number,
        sensorDiagonalMm: number = FULL_FRAME_DIAGONAL_MM
    ): number {
        const safeFocalMm = Math.max(focalLengthMm, 1.0);
        const safeFStop = Math.max(fStop, 0.5);
        const cocMm = Math.max(sensorDiagonalMm / 1500.0, 0.001); // Standard Zeiss circle of confusion formula

        const focalMeters = safeFocalMm * 1e-3;
        const cocMeters = cocMm * 1e-3;

        // Hyperfocal distance in meters
        return (focalMeters * focalMeters) / (safeFStop * cocMeters) + focalMeters;
    }

    /**
     * Computes acceptable focus boundaries (near limit, far limit, and depth of field thickness) in meters.
     */
    public static calculateDepthOfField(
        focalLengthMm: number,
        fStop: number,
        focusDistMeters: number,
        sensorDiagonalMm: number = FULL_FRAME_DIAGONAL_MM
    ): {
        nearLimitMeters: number;
        farLimitMeters: number;
        thicknessMeters: number;
        hyperfocalMeters: number;
        nearFocusLimitMeters: number;
        farFocusLimitMeters: number;
        dofThicknessMeters: number;
        hyperfocalDistanceMeters: number;
        isInfinitelyDeep: boolean;
    } {
        const safeFocusDist = Math.max(focusDistMeters, 0.01);
        const focalMeters = Math.max(focalLengthMm, 1.0) * 1e-3;
        const hyperfocalMeters = this.calculateHyperfocalDistance(focalLengthMm, fStop, sensorDiagonalMm);

        const denomNear = hyperfocalMeters + (safeFocusDist - focalMeters);
        const nearLimitMeters = denomNear > 0 ? (hyperfocalMeters * safeFocusDist) / denomNear : 0.0;

        const denomFar = hyperfocalMeters - (safeFocusDist - focalMeters);
        let farLimitMeters = Number.POSITIVE_INFINITY;
        let isInfinitelyDeep = true;
        if (denomFar > 0.001) {
            farLimitMeters = (hyperfocalMeters * safeFocusDist) / denomFar;
            isInfinitelyDeep = !Number.isFinite(farLimitMeters);
        }

        const thicknessMeters = Number.isFinite(farLimitMeters) ? farLimitMeters - nearLimitMeters : Number.POSITIVE_INFINITY;

        return {
            nearLimitMeters,
            farLimitMeters,
            thicknessMeters,
            hyperfocalMeters,
            nearFocusLimitMeters: nearLimitMeters,
            farFocusLimitMeters: farLimitMeters,
            dofThicknessMeters: thicknessMeters,
            hyperfocalDistanceMeters: hyperfocalMeters,
            isInfinitelyDeep
        };
    }

    /**
     * Calculates the signed Circle of Confusion (CoC) in millimeters and viewport pixels for a given object distance.
     * Negative values indicate foreground blur (in front of focal plane).
     * Positive values indicate background blur (behind focal plane).
     */
    public static calculateCircleOfConfusion(
        focalLengthMm: number,
        fStop: number,
        focusDistMeters: number,
        objectDistMeters: number,
        viewportHeightPx: number = 1080,
        sensorHeightMm: number = 24.0
    ): { cocSensorMm: number; cocPixels: number } {
        const d = Math.max(objectDistMeters, 0.01);
        const df = Math.max(focusDistMeters, 0.01);
        const f = Math.max(focalLengthMm, 1.0) * 1e-3;
        const n = Math.max(fStop, 0.5);

        if (Math.abs(df - f) < 1e-6) {
            return { cocSensorMm: 0, cocPixels: 0 };
        }

        const apertureDiameterM = f / n;
        // cocSensorM = A * (f / (df - f)) * ((d - df) / d)
        const cocSensorM = apertureDiameterM * (f / (df - f)) * ((d - df) / d);
        const cocSensorMm = cocSensorM * 1000.0;

        const sensorHeightM = Math.max(sensorHeightMm, 1.0) * 1e-3;
        const cocPixels = (cocSensorM / sensorHeightM) * viewportHeightPx;

        return { cocSensorMm, cocPixels };
    }

    /**
     * Calculates signed CoC directly in pixels.
     */
    public static calculateSignedCircleOfConfusion(
        distanceMeters: number,
        focusDistMeters: number,
        focalLengthMm: number,
        fStop: number,
        sensorHeightMm: number,
        viewportHeightPx: number
    ): number {
        return this.calculateCircleOfConfusion(
            focalLengthMm,
            fStop,
            focusDistMeters,
            distanceMeters,
            viewportHeightPx,
            sensorHeightMm
        ).cocPixels;
    }

    /**
     * Dynamically computes the focus distance to a 3D target, applying exponential damping (rack focus).
     */
    public static evaluateDynamicFocus(
        cameraPos: [number, number, number],
        targetPos: [number, number, number],
        currentFocusDistanceMeters: number,
        dampingFactor: number = 0.0,
        deltaTimeSeconds: number = 0.016
    ): DynamicFocusTrackingState {
        const dx = targetPos[0] - cameraPos[0];
        const dy = targetPos[1] - cameraPos[1];
        const dz = targetPos[2] - cameraPos[2];
        const instantaneousDist = Math.max(0.1, Math.sqrt(dx * dx + dy * dy + dz * dz));

        let smoothedDist = instantaneousDist;
        if (dampingFactor > 0.0 && Number.isFinite(currentFocusDistanceMeters) && currentFocusDistanceMeters > 0.0) {
            const alpha = 1.0 - Math.exp(-dampingFactor * Math.max(deltaTimeSeconds, 0.001));
            smoothedDist = currentFocusDistanceMeters + (instantaneousDist - currentFocusDistanceMeters) * alpha;
        }

        return {
            cameraPosition: [cameraPos[0], cameraPos[1], cameraPos[2]],
            targetPosition: [targetPos[0], targetPos[1], targetPos[2]],
            instantaneousDistanceMeters: instantaneousDist,
            smoothedFocusDistanceMeters: smoothedDist
        };
    }

    /**
     * Updates dynamic focus tracking per frame with exponential rack focus smoothing.
     */
    public static updateDynamicFocusTracking(
        cameraPos: [number, number, number],
        targetPos: [number, number, number],
        currentFocusDistanceMeters: number,
        deltaTimeSeconds: number = 0.016,
        dampingLambda: number = 8.0
    ): DynamicFocusTrackingState & { currentFocusDistanceMeters: number; targetDistanceMeters: number } {
        const res = this.evaluateDynamicFocus(
            cameraPos,
            targetPos,
            currentFocusDistanceMeters,
            dampingLambda,
            deltaTimeSeconds
        );
        return {
            ...res,
            currentFocusDistanceMeters: res.smoothedFocusDistanceMeters,
            targetDistanceMeters: res.instantaneousDistanceMeters
        };
    }

    /**
     * Computes the complete optical frustum and depth of field parameters from config.
     */
    public static computeOpticalFrustum(
        config: PhysicalCameraConfig,
        focusDistanceMeters?: number
    ): OpticalFrustumCalculation {
        const sensor = this.resolveSensorFormat(config);
        const focal = config.focalLengthMm ?? 50.0;
        const fStop = config.apertureFStop ?? 2.8;
        const focusDist = Math.max(focusDistanceMeters ?? config.focusDistanceMeters ?? 5.0, 0.1);

        const squeeze = config.anamorphicSqueeze ?? config.anamorphicRatio ?? 1.0;
        const effectiveWidthMm = sensor.widthMm * squeeze;
        const effectiveDiagMm = Math.sqrt(effectiveWidthMm * effectiveWidthMm + sensor.heightMm * sensor.heightMm);

        const fovV = this.calculateFov(focal, sensor.heightMm);
        const fovH = this.calculateFov(focal, effectiveWidthMm);
        const fovDiag = this.calculateFov(focal, effectiveDiagMm);
        const eqFocal = focal * (FULL_FRAME_DIAGONAL_MM / sensor.diagonalMm);
        const cocMm = sensor.diagonalMm / 1500.0;

        const dof = this.calculateDepthOfField(focal, fStop, focusDist, sensor.diagonalMm);

        return {
            fovVerticalDeg: fovV,
            fovHorizontalDeg: fovH,
            fovDiagonalDeg: fovDiag,
            verticalFovDeg: fovV,
            horizontalFovDeg: fovH,
            diagonalFovDeg: fovDiag,
            aspectRatio: (sensor.widthMm * squeeze) / sensor.heightMm,
            sensorDimensions: sensor,
            equivalentFocalLength35Mm: eqFocal,
            circleOfConfusionMm: cocMm,
            hyperfocalDistanceMeters: dof.hyperfocalMeters,
            nearFocusLimitMeters: dof.nearLimitMeters,
            farFocusLimitMeters: dof.farLimitMeters,
            depthOfFieldThicknessMeters: dof.thicknessMeters,
            focusDistanceMeters: focusDist
        };
    }

    /**
     * Alias for computeOpticalFrustum.
     */
    public static calculateFrustum(
        config: PhysicalCameraConfig,
        focusDistanceMeters?: number
    ): OpticalFrustumCalculation {
        return this.computeOpticalFrustum(config, focusDistanceMeters);
    }

    /**
     * Applies physical camera optics directly to a Three.js PerspectiveCamera instance.
     * Updates camera.fov, camera.filmGauge, updates projection matrix, and stores optical metadata.
     */
    public static applyToPerspectiveCamera(
        camera: {
            fov: number;
            filmGauge?: number;
            filmOffset?: number;
            aspect?: number;
            focus?: number;
            userData?: Record<string, any>;
            updateProjectionMatrix: () => void;
        },
        config: PhysicalCameraConfig,
        aspectRatioOrFocusDist?: number,
        explicitFocusDistance?: number
    ): OpticalFrustumCalculation {
        let aspectRatio: number | undefined;
        let focusDist: number | undefined = explicitFocusDistance;

        if (typeof aspectRatioOrFocusDist === 'number') {
            if (config.focusDistanceMeters !== undefined) {
                // If config already specifies focus distance, the 3rd argument is aspectRatio
                aspectRatio = aspectRatioOrFocusDist;
                focusDist = focusDist ?? config.focusDistanceMeters;
            } else if (aspectRatioOrFocusDist > 0.2 && aspectRatioOrFocusDist < 4.0 && typeof camera.aspect === 'number') {
                aspectRatio = aspectRatioOrFocusDist;
            } else {
                focusDist = aspectRatioOrFocusDist;
            }
        }

        if (aspectRatio !== undefined && typeof camera.aspect === 'number') {
            camera.aspect = aspectRatio;
        }

        const frustum = this.computeOpticalFrustum(config, focusDist ?? config.focusDistanceMeters);
        const sensor = this.resolveSensorFormat(config);

        camera.fov = frustum.fovVerticalDeg;
        if (typeof camera.filmGauge === 'number') {
            camera.filmGauge = sensor.widthMm;
        }

        camera.focus = frustum.focusDistanceMeters;

        if (!camera.userData) {
            camera.userData = {};
        }

        camera.userData.physicalCamera = {
            sensorFormat: sensor.id,
            sensorWidthMm: sensor.widthMm,
            sensorHeightMm: sensor.heightMm,
            focalLengthMm: config.focalLengthMm ?? 50.0,
            apertureFStop: config.apertureFStop ?? 2.8,
            focusDistanceMeters: frustum.focusDistanceMeters,
            hyperfocalDistanceMeters: frustum.hyperfocalDistanceMeters,
            nearFocusLimitMeters: frustum.nearFocusLimitMeters,
            farFocusLimitMeters: frustum.farFocusLimitMeters,
            depthOfFieldThicknessMeters: frustum.depthOfFieldThicknessMeters,
            anamorphicSqueeze: config.anamorphicSqueeze ?? config.anamorphicRatio ?? 1.0,
            enableDepthOfField: config.enableDepthOfField ?? false,
            bokehScale: config.bokehScale ?? 1.0
        };

        camera.updateProjectionMatrix();
        return frustum;
    }
}
