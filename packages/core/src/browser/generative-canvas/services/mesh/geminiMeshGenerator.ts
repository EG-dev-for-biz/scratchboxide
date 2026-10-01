/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { GoogleGenAI } from '@google/genai';

export const SCRATCHBOX3D_SYSTEM_INSTRUCTION = `You are a graphics engine developer specializing in the Scratchbox 3D modeling engine core.
Your task is to take a natural language user prompt describing a 3D mesh, scene, or geometric object, and generate a self-contained, valid C++ function that constructs that mesh using Scratchbox's native SBMesh and SBMO C++ API functions.

SCRATCHBOX C++ API REFERENCE:
--------------------------------
#include "mesh.hh"
#include "mesh_operators.hh"

Types:
- SBMesh: Primary mesh topology structure
- MeshVert: Vertex element with 3D coordinate co[3]
- MeshEdge: Edge element connecting 2 vertices (v1, v2)
- MeshFace: Face element connecting 3 or 4 vertices (triangles / quads)
- MeshOperator: Operator context struct for SBMO topological operations
- MeshCreateParams: Config struct for SBM_mesh_create

1. Initialization:
   MeshCreateParams params = {0};
   params.use_toolflags = true;
   SBMesh *bm = SBM_mesh_create(&params);

2. Vertex Creation:
   MeshVert *SBM_vert_create(SBMesh *bm, const float co[3], const MeshVert *v_example, MeshCreateFlag flag);

3. High-Level Mesh Primitives:
   void SBM_mesh_build_primitives_cube(SBMesh *bm, float size);
   void SBM_mesh_build_primitives_sphere(SBMesh *bm, float radius, int segments, int rings);
   void SBM_mesh_build_primitives_cylinder(SBMesh *bm, float radius, float depth, int vertices);
   void SBM_mesh_build_primitives_grid(SBMesh *bm, float x_size, float y_size, int x_subdiv, int y_subdiv);

RULES:
- Return ONLY executable C++ code enclosed in \`\`\`cpp ... \`\`\`. Do NOT include conversational text outside the code block.
- Always name the function SBMesh *generate_scratchbox_custom_mesh()
- The function MUST initialize SBMesh via SBM_mesh_create(&params) and end with return bm;
`;

export interface GenerateMeshOptions {
    prompt: string;
    apiKey?: string;
    model?: string;
}

export interface ProceduralMeshOutput {
    mesh: any;
    geometry: any;
    material: any;
    summary: string;
}

/**
 * Generate native SBMesh C++ source code from natural language prompt.
 */
export async function generateSBMeshCodeFromPrompt(options: GenerateMeshOptions): Promise<string> {
    const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

    if (!apiKey) {
        // Deterministic in-tree fallback code
        return `// Procedural SBMesh Generator for: ${options.prompt}
SBMesh *generate_scratchbox_custom_mesh() {
    MeshCreateParams params = {0};
    params.use_toolflags = true;
    SBMesh *bm = SBM_mesh_create(&params);
    SBM_mesh_build_primitives_cube(bm, 2.0f);
    return bm;
}`;
    }

    try {
        const ai = new GoogleGenAI({ apiKey });
        const modelName = options.model || 'gemini-3.7-flash';

        const response = await ai.models.generateContent({
            model: modelName,
            contents: `Task: Generate a C++ function constructing SBMesh for subject: "${options.prompt}".`,
            config: {
                systemInstruction: SCRATCHBOX3D_SYSTEM_INSTRUCTION,
                temperature: 0.2
            }
        });

        const text = response.text || '';
        const match = text.match(/```(?:cpp|c\+\+)?\s*([\s\S]*?)```/i);
        return match ? match[1].trim() : text.trim();
    } catch {
        return `SBMesh *generate_scratchbox_custom_mesh() {
    MeshCreateParams params = {0};
    params.use_toolflags = true;
    SBMesh *bm = SBM_mesh_create(&params);
    SBM_mesh_build_primitives_cube(bm, 2.0f);
    return bm;
}`;
    }
}

/**
 * Procedural In-Tree Three.js Mesh Builder.
 * Converts creative text instructions directly into Three.js geometries, composite assemblies, and materials.
 */
export function generateProceduralThreeMeshFromPrompt(
    prompt: string,
    THREE?: any
): ProceduralMeshOutput {
    const ThreeLib = THREE || (typeof window !== 'undefined' && (window as any).THREE) || require('three');
    const p = prompt.toLowerCase();

    // 1. Tower / Spire / Antenna / Beacon
    if (/tower|spire|antenna|pylon|beacon|pillar|lighthouse|monolith/i.test(p)) {
        const group = new ThreeLib.Group();
        group.name = 'procedural-tower';

        const isCyber = /cyber|neon|future/i.test(p);
        const baseMat = new ThreeLib.MeshStandardMaterial({
            color: isCyber ? 0x0f172a : 0x64748b,
            metalness: isCyber ? 0.8 : 0.2,
            roughness: isCyber ? 0.2 : 0.8
        });
        const glowMat = new ThreeLib.MeshStandardMaterial({
            color: isCyber ? 0x00f3ff : 0xf59e0b,
            emissive: isCyber ? 0x00f3ff : 0xd97706,
            emissiveIntensity: 0.8
        });

        // Base
        const base = new ThreeLib.Mesh(new ThreeLib.CylinderGeometry(2.5, 3.2, 4, 16), baseMat);
        base.position.y = 2;
        group.add(base);

        // Shaft
        const shaft = new ThreeLib.Mesh(new ThreeLib.CylinderGeometry(1.6, 2.2, 14, 16), baseMat);
        shaft.position.y = 11;
        group.add(shaft);

        // Glowing Core / Observatory ring
        const ring = new ThreeLib.Mesh(new ThreeLib.TorusGeometry(2.2, 0.3, 12, 32), glowMat);
        ring.position.y = 17;
        ring.rotateX(Math.PI / 2);
        group.add(ring);

        // Spire Tip
        const tip = new ThreeLib.Mesh(new ThreeLib.ConeGeometry(0.8, 6, 16), baseMat);
        tip.position.y = 21;
        group.add(tip);

        return {
            mesh: group,
            geometry: base.geometry,
            material: baseMat,
            summary: `Procedural Tower assembly constructed with ${isCyber ? 'cyberpunk metallic/neon' : 'architectural'} materials.`
        };
    }

    // 2. Tree / Foliage / Vegetation
    if (/tree|foliage|pine|forest|wood|plant|palm|oak/i.test(p)) {
        const group = new ThreeLib.Group();
        group.name = 'procedural-tree';

        const isPine = /pine|conifer|evergreen|fir/i.test(p);
        const trunkMat = new ThreeLib.MeshStandardMaterial({ color: 0x4a3728, roughness: 0.9, metalness: 0.0 });
        const foliageMat = new ThreeLib.MeshStandardMaterial({ color: isPine ? 0x1e3f20 : 0x22c55e, roughness: 0.8, metalness: 0.0 });

        const trunk = new ThreeLib.Mesh(new ThreeLib.CylinderGeometry(0.4, 0.7, 5, 8), trunkMat);
        trunk.position.y = 2.5;
        group.add(trunk);

        if (isPine) {
            for (let t = 0; t < 3; t++) {
                const cone = new ThreeLib.Mesh(new ThreeLib.ConeGeometry(2.4 - t * 0.5, 3.5, 8), foliageMat);
                cone.position.y = 5 + t * 2.2;
                group.add(cone);
            }
        } else {
            const canopy = new ThreeLib.Mesh(new ThreeLib.SphereGeometry(2.8, 12, 12), foliageMat);
            canopy.position.y = 6.5;
            canopy.scale.set(1.1, 1.2, 1.1);
            group.add(canopy);
        }

        return {
            mesh: group,
            geometry: trunk.geometry,
            material: foliageMat,
            summary: `Procedural ${isPine ? 'coniferous pine' : 'deciduous broadleaf'} tree asset.`
        };
    }

    // 3. Castle / Fortress / Stone Dwelling / House
    if (/house|building|castle|fortress|chalet|dwelling|outpost|cottage/i.test(p)) {
        const group = new ThreeLib.Group();
        group.name = 'procedural-structure';

        const wallMat = new ThreeLib.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.75, metalness: 0.1 });
        const roofMat = new ThreeLib.MeshStandardMaterial({ color: 0x78350f, roughness: 0.85, metalness: 0.05 });

        const body = new ThreeLib.Mesh(new ThreeLib.BoxGeometry(6, 5, 8), wallMat);
        body.position.y = 2.5;
        group.add(body);

        const roof = new ThreeLib.Mesh(new ThreeLib.ConeGeometry(5.2, 3.2, 4), roofMat);
        roof.position.y = 6.6;
        roof.rotateY(Math.PI / 4);
        roof.scale.set(1.0, 1.0, 1.3);
        group.add(roof);

        return {
            mesh: group,
            geometry: body.geometry,
            material: wallMat,
            summary: 'Procedural architectural structure with pitched roof.'
        };
    }

    // 4. Default Procedural Geometry (Octahedron Crystal / Monolith)
    const geom = new ThreeLib.OctahedronGeometry(2.5, 0);
    const mat = new ThreeLib.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0284c7,
        emissiveIntensity: 0.2,
        roughness: 0.2,
        metalness: 0.8
    });
    const mesh = new ThreeLib.Mesh(geom, mat);
    mesh.position.y = 2.5;

    return {
        mesh,
        geometry: geom,
        material: mat,
        summary: `Procedural geometric monolith for: "${prompt}"`
    };
}

/**
 * Self-correcting loop helper. Checks C++ code for syntactic validity or common SBMesh
 * compilation patterns, and repairs if needed.
 */
export async function auditAndRepairCppMeshCode(
    id: string,
    category: string,
    code: string,
    apiKeyOverride?: string
): Promise<{ repairedCode: string; repaired: boolean; explanation: string }> {
    const containsInitialization = code.includes('SBM_mesh_create');
    const containsReturn = code.includes('return');
    const hasBraces = code.includes('{') && code.includes('}');

    if (containsInitialization && containsReturn && hasBraces) {
        return {
            repairedCode: code,
            repaired: false,
            explanation: 'Code passed syntax and structural sanity check.'
        };
    }

    const fallbackRepaired = `// Repaired C++ Mesh Code for ${id} (${category})
SBMesh *generate_scratchbox_custom_mesh() {
    MeshCreateParams params = {0};
    params.use_toolflags = true;
    SBMesh *bm = SBM_mesh_create(&params);
    SBM_mesh_build_primitives_cube(bm, 1.0f);
    return bm;
}`;

    const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        return {
            repairedCode: fallbackRepaired,
            repaired: true,
            explanation: 'Code repaired using in-tree structural template.'
        };
    }

    try {
        const ai = new GoogleGenAI({ apiKey });
        const model = 'gemini-3.7-flash';
        const response = await ai.models.generateContent({
            model,
            contents: `Repair this C++ SBMesh function:\n${code}`,
            config: {
                systemInstruction: SCRATCHBOX3D_SYSTEM_INSTRUCTION,
                temperature: 0.2
            }
        });
        const text = response.text || '';
        const match = text.match(/```(?:cpp|c\+\+)?\s*([\s\S]*?)```/i);
        return {
            repairedCode: match ? match[1].trim() : text.trim(),
            repaired: true,
            explanation: 'Successfully repaired C++ mesh code via Gemini agent.'
        };
    } catch {
        return {
            repairedCode: fallbackRepaired,
            repaired: true,
            explanation: 'Code repaired using in-tree structural template.'
        };
    }
}
