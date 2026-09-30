/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * ASCII 3D Gaussian Splatting PLY codec shared by the performer 4DGS pipeline,
 * the Node avatar runtime and (mirrored) the browser performer studio.
 *
 * Written files follow the reference 3DGS layout: `f_dc_*` are degree-0 spherical-harmonic
 * coefficients (rgb = 0.5 + SH_C0 * f_dc), `opacity` is a logit, `scale_*` are log-scales and
 * `rot_0..3` is a (w, x, y, z) quaternion. Two historical encodings are still read:
 *   - legacy benchmark demos: plain RGB in `f_dc_*`, quaternion (w, x, y, z)
 *   - pre-codec performer pipeline output: SH in `f_dc_*`, quaternion (x, y, z, w), `joint_id` column
 */

export const SH_C0 = 0.28209479177387814;
export const SCRATCHBOX_PLY_ENCODING_COMMENT = 'scratchbox_encoding color=sh_dc quat=wxyz';

export type PlyColorEncoding = 'sh_dc' | 'rgb';
export type PlyQuatOrder = 'wxyz' | 'xyzw';

export interface GaussianPlyHeader {
    vertexCount: number;
    properties: string[];
    comments: string[];
    bodyLineIndex: number;
}

export interface GaussianPlyEncoding {
    color: PlyColorEncoding;
    quat: PlyQuatOrder;
    source: 'comment' | 'heuristic';
}

export interface DecodedGaussianRecord {
    position: [number, number, number];
    normal?: [number, number, number];
    colorRgb: [number, number, number];
    opacity: number;
    scale: [number, number, number];
    /** Always returned in (x, y, z, w) order regardless of file encoding. */
    quaternion: [number, number, number, number];
    boneIndices?: [number, number, number, number];
    boneWeights?: [number, number, number, number];
}

export interface EncodableGaussian {
    position: [number, number, number];
    normal?: [number, number, number];
    colorRgb: [number, number, number];
    opacity: number;
    scale: [number, number, number];
    quaternion?: [number, number, number, number];
    boneIndices?: [number, number, number, number];
    boneWeights?: [number, number, number, number];
}

export function parseGaussianPlyHeader(lines: string[]): GaussianPlyHeader {
    const properties: string[] = [];
    const comments: string[] = [];
    let vertexCount = 0;
    let inVertexElement = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === 'end_header') {
            return { vertexCount, properties, comments, bodyLineIndex: i + 1 };
        }
        const parts = line.split(/\s+/);
        if (parts[0] === 'comment') {
            comments.push(parts.slice(1).join(' '));
        } else if (parts[0] === 'element') {
            inVertexElement = parts[1] === 'vertex';
            if (inVertexElement) vertexCount = parseInt(parts[2], 10) || 0;
        } else if (parts[0] === 'property' && inVertexElement) {
            properties.push(parts[parts.length - 1]);
        } else if (parts[0] === 'format' && parts[1] !== 'ascii') {
            throw new Error(`Only ASCII Gaussian PLY is supported (got format "${parts[1]}")`);
        }
    }
    throw new Error('Gaussian PLY is missing end_header');
}

export function detectGaussianPlyEncoding(header: GaussianPlyHeader, bodyLines: string[]): GaussianPlyEncoding {
    for (const c of header.comments) {
        if (c.startsWith('scratchbox_encoding')) {
            const color = /color=(\w+)/.exec(c)?.[1] === 'rgb' ? 'rgb' : 'sh_dc';
            const quat = /quat=(\w+)/.exec(c)?.[1] === 'xyzw' ? 'xyzw' : 'wxyz';
            return { color, quat, source: 'comment' };
        }
    }

    const dc0 = header.properties.indexOf('f_dc_0');
    let outOfUnitRange = false;
    if (dc0 >= 0) {
        const sample = Math.min(bodyLines.length, 4000);
        for (let i = 0; i < sample && !outOfUnitRange; i++) {
            const parts = bodyLines[i].trim().split(/\s+/);
            for (let k = 0; k < 3; k++) {
                const v = parseFloat(parts[dc0 + k]);
                if (v < -1e-4 || v > 1.0001) {
                    outOfUnitRange = true;
                    break;
                }
            }
        }
    }
    const color: PlyColorEncoding = outOfUnitRange ? 'sh_dc' : 'rgb';
    const quat: PlyQuatOrder = color === 'sh_dc' && header.properties.includes('joint_id') ? 'xyzw' : 'wxyz';
    return { color, quat, source: 'heuristic' };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function decodeGaussianPly(
    text: string,
    options: { maxGaussians?: number } = {}
): { gaussians: DecodedGaussianRecord[]; header: GaussianPlyHeader; encoding: GaussianPlyEncoding } {
    const lines = text.split(/\r?\n/);
    const header = parseGaussianPlyHeader(lines);
    const bodyLines = lines.slice(header.bodyLineIndex).filter(l => l.trim().length > 0);
    const encoding = detectGaussianPlyEncoding(header, bodyLines);

    const idx = (name: string) => header.properties.indexOf(name);
    const iX = idx('x'), iNx = idx('nx'), iDc = idx('f_dc_0'), iRed = idx('red');
    const iOp = idx('opacity'), iS = idx('scale_0'), iR = idx('rot_0');
    const iB = idx('bone_idx_0'), iW = idx('bone_weight_0');
    if (iX < 0) throw new Error('Gaussian PLY has no x/y/z properties');

    const limit = options.maxGaussians ?? header.vertexCount;
    const gaussians: DecodedGaussianRecord[] = [];

    for (let i = 0; i < bodyLines.length && gaussians.length < limit; i++) {
        const p = bodyLines[i].trim().split(/\s+/).map(Number);
        if (p.length < header.properties.length) continue;

        let colorRgb: [number, number, number] = [0.5, 0.5, 0.5];
        if (iDc >= 0) {
            colorRgb = encoding.color === 'sh_dc'
                ? [clamp01(0.5 + SH_C0 * p[iDc]), clamp01(0.5 + SH_C0 * p[iDc + 1]), clamp01(0.5 + SH_C0 * p[iDc + 2])]
                : [clamp01(p[iDc]), clamp01(p[iDc + 1]), clamp01(p[iDc + 2])];
        } else if (iRed >= 0) {
            colorRgb = [p[iRed] / 255, p[iRed + 1] / 255, p[iRed + 2] / 255];
        }

        const opacity = iOp >= 0 ? 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, p[iOp])))) : 1;
        const scale: [number, number, number] = iS >= 0
            ? [Math.exp(p[iS]), Math.exp(p[iS + 1]), Math.exp(p[iS + 2])]
            : [0.005, 0.005, 0.005];

        let quaternion: [number, number, number, number] = [0, 0, 0, 1];
        if (iR >= 0) {
            const [a, b, c, d] = [p[iR], p[iR + 1], p[iR + 2], p[iR + 3]];
            const q: [number, number, number, number] = encoding.quat === 'wxyz' ? [b, c, d, a] : [a, b, c, d];
            const len = Math.hypot(q[0], q[1], q[2], q[3]);
            quaternion = len > 1e-8 ? [q[0] / len, q[1] / len, q[2] / len, q[3] / len] : [0, 0, 0, 1];
        }

        const record: DecodedGaussianRecord = {
            position: [p[iX], p[iX + 1], p[iX + 2]],
            colorRgb,
            opacity,
            scale,
            quaternion
        };
        if (iNx >= 0) record.normal = [p[iNx], p[iNx + 1], p[iNx + 2]];
        if (iB >= 0 && iW >= 0) {
            record.boneIndices = [p[iB], p[iB + 1], p[iB + 2], p[iB + 3]];
            record.boneWeights = [p[iW], p[iW + 1], p[iW + 2], p[iW + 3]];
        }
        gaussians.push(record);
    }

    return { gaussians, header, encoding };
}

export function encodeGaussianPly(gaussians: EncodableGaussian[]): string {
    const hasBones = gaussians.length > 0 && !!gaussians[0].boneIndices && !!gaussians[0].boneWeights;
    const header = [
        'ply',
        'format ascii 1.0',
        `comment ${SCRATCHBOX_PLY_ENCODING_COMMENT}`,
        `element vertex ${gaussians.length}`,
        'property float x', 'property float y', 'property float z',
        'property float nx', 'property float ny', 'property float nz',
        'property float f_dc_0', 'property float f_dc_1', 'property float f_dc_2',
        'property float opacity',
        'property float scale_0', 'property float scale_1', 'property float scale_2',
        'property float rot_0', 'property float rot_1', 'property float rot_2', 'property float rot_3'
    ];
    if (hasBones) {
        header.push(
            'property int bone_idx_0', 'property int bone_idx_1', 'property int bone_idx_2', 'property int bone_idx_3',
            'property float bone_weight_0', 'property float bone_weight_1', 'property float bone_weight_2', 'property float bone_weight_3'
        );
    }
    header.push('end_header');

    const lines: string[] = [];
    for (const g of gaussians) {
        const [x, y, z] = g.position;
        const [nx, ny, nz] = g.normal || [0, 1, 0];
        const sh = g.colorRgb.map(c => (c - 0.5) / SH_C0);
        const op = Math.max(1e-4, Math.min(0.9999, g.opacity));
        const logit = Math.log(op / (1 - op));
        const ls = g.scale.map(s => Math.log(Math.max(1e-6, s)));
        const [qx, qy, qz, qw] = g.quaternion || [0, 0, 0, 1];
        let line =
            `${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)} ` +
            `${nx.toFixed(4)} ${ny.toFixed(4)} ${nz.toFixed(4)} ` +
            `${sh[0].toFixed(4)} ${sh[1].toFixed(4)} ${sh[2].toFixed(4)} ` +
            `${logit.toFixed(4)} ` +
            `${ls[0].toFixed(4)} ${ls[1].toFixed(4)} ${ls[2].toFixed(4)} ` +
            `${qw.toFixed(5)} ${qx.toFixed(5)} ${qy.toFixed(5)} ${qz.toFixed(5)}`;
        if (hasBones) {
            const b = g.boneIndices!;
            const w = g.boneWeights!;
            line += ` ${b[0]} ${b[1]} ${b[2]} ${b[3]} ${w[0].toFixed(4)} ${w[1].toFixed(4)} ${w[2].toFixed(4)} ${w[3].toFixed(4)}`;
        }
        lines.push(line);
    }
    return header.join('\n') + '\n' + lines.join('\n') + '\n';
}
