/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * EWA projection of a 3D Gaussian into screen space (Zwicker et al. 2001, "EWA Volume Splatting"), written from the
 * published equations.
 *
 *   Σ   = R S Sᵀ Rᵀ                      3D covariance from the unit quaternion q = (x, y, z, w) and the per-axis sigmas s
 *   Σ'  = J W Σ Wᵀ Jᵀ                    W: the rotation part of model-view, J: the Jacobian of the perspective map at the
 *                                         centre (u = fx·x/(-z), v = fy·y/(-z), in pixels)
 *   Σ'' = Σ' + (d + b) I                 d = 0.3 px² low-pass (one-pixel reconstruction filter), b = extra blur variance
 *   α'' = α · sqrt(det Σ' / det Σ'')     opacity compensation, so the splat's integrated coverage is unchanged by the filter
 *
 * The quad is spanned by the eigenvectors of Σ'' at 3 sigma. Σ' is formed as A Aᵀ with A = J W R S, so it is positive
 * semi-definite for any input, including flattened 2DGS surfels (one sigma ≈ 0): seen edge-on their det Σ' → 0 and the
 * compensation fades them out rather than drawing a full-strength line.
 *
 * The GLSL below and `projectSplatEwa` are the same arithmetic in the same order; the CPU function is the reference the
 * tests check against an independent numeric linearisation.
 */

/** Low-pass dilation added to the projected covariance, in pixels² (the standard 3DGS value). */
export const EWA_DILATION_PX2 = 0.3;
/** Quad half-extent in standard deviations. */
export const EWA_CUTOFF_SIGMA = 3.0;
/** The Jacobian is evaluated with x/z and y/z clamped to this multiple of the half-frustum tangent (guards off-screen
 * centres, whose Jacobian blows up). */
export const EWA_FRUSTUM_GUARD = 1.3;

/**
 * GLSL (ES 1.0 / 3.0) chunk. Call `sbEwaProject` with the view-space centre; it returns false when the splat is to be
 * culled (behind the camera or the near plane, entirely off-screen, or below 1/255 opacity after compensation).
 * `axisMajorPx`/`axisMinorPx` are the 3-sigma half-axes in pixels (NDC orientation, y up).
 */
export const EWA_SPLAT_GLSL = /* glsl */ `
  bool sbEwaProject(
    vec4 viewCenter, vec3 sigma, vec4 quat, mat3 viewRot, mat4 proj, vec2 viewportPx, float extraVarPx2, float opacity,
    out vec4 clipCenter, out vec2 axisMajorPx, out vec2 axisMinorPx, out float opacityOut
  ) {
    clipCenter = proj * viewCenter;
    axisMajorPx = vec2(0.0);
    axisMinorPx = vec2(0.0);
    opacityOut = 0.0;
    bool persp = abs(proj[2][3]) > 0.5;
    if (clipCenter.w <= 0.0) return false;
    if (clipCenter.z < -clipCenter.w || clipCenter.z > clipCenter.w) return false;

    float ql = length(quat);
    vec4 q = ql > 1e-8 ? quat / ql : vec4(0.0, 0.0, 0.0, 1.0);
    float xx = q.x * q.x, yy = q.y * q.y, zz = q.z * q.z;
    float xy = q.x * q.y, xz = q.x * q.z, yz = q.y * q.z;
    float wx = q.w * q.x, wy = q.w * q.y, wz = q.w * q.z;
    // Columns of R scaled by the sigmas (M = R S), then taken to view space (T = W M).
    vec3 t0 = viewRot * (vec3(1.0 - 2.0 * (yy + zz), 2.0 * (xy + wz), 2.0 * (xz - wy)) * sigma.x);
    vec3 t1 = viewRot * (vec3(2.0 * (xy - wz), 1.0 - 2.0 * (xx + zz), 2.0 * (yz + wx)) * sigma.y);
    vec3 t2 = viewRot * (vec3(2.0 * (xz + wy), 2.0 * (yz - wx), 1.0 - 2.0 * (xx + yy)) * sigma.z);

    float fx = proj[0][0] * 0.5 * viewportPx.x;
    float fy = proj[1][1] * 0.5 * viewportPx.y;
    float j00, j02, j11, j12;
    if (persp) {
      float tz = -viewCenter.z;
      float limX = ${EWA_FRUSTUM_GUARD.toFixed(2)} / proj[0][0];
      float limY = ${EWA_FRUSTUM_GUARD.toFixed(2)} / proj[1][1];
      float tx = clamp(viewCenter.x / tz, -limX, limX) * tz;
      float ty = clamp(viewCenter.y / tz, -limY, limY) * tz;
      j00 = fx / tz; j02 = fx * tx / (tz * tz);
      j11 = fy / tz; j12 = fy * ty / (tz * tz);
    } else {
      j00 = fx; j02 = 0.0; j11 = fy; j12 = 0.0;
    }
    // A = J T (2x3); Σ' = A Aᵀ.
    vec3 a0 = vec3(j00 * t0.x + j02 * t0.z, j00 * t1.x + j02 * t1.z, j00 * t2.x + j02 * t2.z);
    vec3 a1 = vec3(j11 * t0.y + j12 * t0.z, j11 * t1.y + j12 * t1.z, j11 * t2.y + j12 * t2.z);
    float s00 = dot(a0, a0), s01 = dot(a0, a1), s11 = dot(a1, a1);

    float det0 = max(s00 * s11 - s01 * s01, 0.0);
    float dil = ${EWA_DILATION_PX2.toFixed(2)} + max(extraVarPx2, 0.0);
    s00 += dil; s11 += dil;
    float det1 = s00 * s11 - s01 * s01;
    opacityOut = opacity * sqrt(det0 / det1);
    if (opacityOut < 1.0 / 255.0) return false;

    float mid = 0.5 * (s00 + s11);
    float rad = sqrt(max(0.25 * (s00 - s11) * (s00 - s11) + s01 * s01, 0.0));
    float l1 = mid + rad;
    float l2 = max(mid - rad, 0.0);
    vec2 v1 = abs(s01) > 1e-12 ? normalize(vec2(l1 - s11, s01)) : (s00 >= s11 ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
    float maxR = 2.0 * max(viewportPx.x, viewportPx.y);
    axisMajorPx = v1 * min(${EWA_CUTOFF_SIGMA.toFixed(1)} * sqrt(l1), maxR);
    axisMinorPx = vec2(-v1.y, v1.x) * min(${EWA_CUTOFF_SIGMA.toFixed(1)} * sqrt(l2), maxR);

    // Cull when the 3-sigma bounding box lies entirely outside the viewport.
    vec2 ndc = clipCenter.xy / clipCenter.w;
    vec2 extNdc = ${EWA_CUTOFF_SIGMA.toFixed(1)} * sqrt(vec2(s00, s11)) * 2.0 / viewportPx;
    if (abs(ndc.x) - extNdc.x > 1.0 || abs(ndc.y) - extNdc.y > 1.0) return false;
    return true;
  }
`;

export interface EwaProjectionInput {
    /** View-space centre (camera looks down -z). */
    viewCenter: [number, number, number];
    /** Per-axis standard deviations in the splat's local frame. */
    sigma: [number, number, number];
    /** Unit quaternion (x, y, z, w); normalised here. */
    quat: [number, number, number, number];
    /** Rotation part of model-view, row-major 3x3. */
    viewRot: number[];
    /** Projection matrix, column-major 4x4 (three.js `Matrix4.elements`). */
    proj: ArrayLike<number>;
    viewportPx: [number, number];
    extraVarPx2?: number;
    opacity?: number;
}

export interface EwaProjection {
    visible: boolean;
    /** Projected covariance before dilation, pixels² (s00, s01, s11). */
    cov2d: [number, number, number];
    /** After dilation. */
    cov2dDilated: [number, number, number];
    axisMajorPx: [number, number];
    axisMinorPx: [number, number];
    opacity: number;
    /** Projected centre in pixels from the viewport centre (y up). */
    centerPx: [number, number];
}

/** CPU mirror of `sbEwaProject` (same operations, double precision). */
export function projectSplatEwa(inp: EwaProjectionInput): EwaProjection {
    const [vx, vy, vz] = inp.viewCenter;
    const P = inp.proj;
    const [W, H] = inp.viewportPx;
    const out: EwaProjection = {
        visible: false, cov2d: [0, 0, 0], cov2dDilated: [0, 0, 0], axisMajorPx: [0, 0], axisMinorPx: [0, 0], opacity: 0, centerPx: [0, 0]
    };
    const cx = P[0] * vx + P[4] * vy + P[8] * vz + P[12];
    const cy = P[1] * vx + P[5] * vy + P[9] * vz + P[13];
    const cz = P[2] * vx + P[6] * vy + P[10] * vz + P[14];
    const cw = P[3] * vx + P[7] * vy + P[11] * vz + P[15];
    const persp = Math.abs(P[11]) > 0.5;
    if (cw <= 0 || cz < -cw || cz > cw) return out;
    out.centerPx = [(cx / cw) * 0.5 * W, (cy / cw) * 0.5 * H];

    let [qx, qy, qz, qw] = inp.quat;
    const ql = Math.hypot(qx, qy, qz, qw);
    if (ql > 1e-8) { qx /= ql; qy /= ql; qz /= ql; qw /= ql; } else { qx = 0; qy = 0; qz = 0; qw = 1; }
    const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
    const [sx, sy, sz] = inp.sigma;
    const m = [
        [(1 - 2 * (yy + zz)) * sx, (2 * (xy + wz)) * sx, (2 * (xz - wy)) * sx],
        [(2 * (xy - wz)) * sy, (1 - 2 * (xx + zz)) * sy, (2 * (yz + wx)) * sy],
        [(2 * (xz + wy)) * sz, (2 * (yz - wx)) * sz, (1 - 2 * (xx + yy)) * sz]
    ];
    const R = inp.viewRot;
    const t = m.map(c => [R[0] * c[0] + R[1] * c[1] + R[2] * c[2], R[3] * c[0] + R[4] * c[1] + R[5] * c[2], R[6] * c[0] + R[7] * c[1] + R[8] * c[2]]);

    const fx = P[0] * 0.5 * W, fy = P[5] * 0.5 * H;
    let j00: number, j02: number, j11: number, j12: number;
    if (persp) {
        const tz = -vz;
        const limX = EWA_FRUSTUM_GUARD / P[0], limY = EWA_FRUSTUM_GUARD / P[5];
        const tx = Math.min(limX, Math.max(-limX, vx / tz)) * tz;
        const ty = Math.min(limY, Math.max(-limY, vy / tz)) * tz;
        j00 = fx / tz; j02 = fx * tx / (tz * tz); j11 = fy / tz; j12 = fy * ty / (tz * tz);
    } else {
        j00 = fx; j02 = 0; j11 = fy; j12 = 0;
    }
    const a0 = t.map(c => j00 * c[0] + j02 * c[2]);
    const a1 = t.map(c => j11 * c[1] + j12 * c[2]);
    let s00 = a0[0] * a0[0] + a0[1] * a0[1] + a0[2] * a0[2];
    const s01 = a0[0] * a1[0] + a0[1] * a1[1] + a0[2] * a1[2];
    let s11 = a1[0] * a1[0] + a1[1] * a1[1] + a1[2] * a1[2];
    out.cov2d = [s00, s01, s11];

    const det0 = Math.max(s00 * s11 - s01 * s01, 0);
    const dil = EWA_DILATION_PX2 + Math.max(inp.extraVarPx2 ?? 0, 0);
    s00 += dil; s11 += dil;
    const det1 = s00 * s11 - s01 * s01;
    out.cov2dDilated = [s00, s01, s11];
    out.opacity = (inp.opacity ?? 1) * Math.sqrt(det0 / det1);
    if (out.opacity < 1 / 255) return out;

    const mid = 0.5 * (s00 + s11);
    const rad = Math.sqrt(Math.max(0.25 * (s00 - s11) * (s00 - s11) + s01 * s01, 0));
    const l1 = mid + rad, l2 = Math.max(mid - rad, 0);
    let v1: [number, number];
    if (Math.abs(s01) > 1e-12) { const a = l1 - s11, n = Math.hypot(a, s01); v1 = [a / n, s01 / n]; } else v1 = s00 >= s11 ? [1, 0] : [0, 1];
    const maxR = 2 * Math.max(W, H);
    const r1 = Math.min(EWA_CUTOFF_SIGMA * Math.sqrt(l1), maxR), r2 = Math.min(EWA_CUTOFF_SIGMA * Math.sqrt(l2), maxR);
    out.axisMajorPx = [v1[0] * r1, v1[1] * r1];
    out.axisMinorPx = [-v1[1] * r2, v1[0] * r2];

    const ndcX = cx / cw, ndcY = cy / cw;
    const extX = EWA_CUTOFF_SIGMA * Math.sqrt(s00) * 2 / W, extY = EWA_CUTOFF_SIGMA * Math.sqrt(s11) * 2 / H;
    out.visible = !(Math.abs(ndcX) - extX > 1 || Math.abs(ndcY) - extY > 1);
    return out;
}
