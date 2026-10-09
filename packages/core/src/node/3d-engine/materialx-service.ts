/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import type { ContinuousMaterialDescriptor } from '../../../common/adaptive-material-types';

export interface MaterialXTextureMapping {
    albedoFileName: string;
    normalFileName: string;
    ormFileName?: string;
    roughnessFileName?: string;
    metallicFileName?: string;
    aoFileName?: string;
    heightFileName?: string;
}

export interface MaterialXExportOptions {
    materialName?: string;
    descriptor?: ContinuousMaterialDescriptor;
    textures: MaterialXTextureMapping;
    uvTiling?: { u: number; v: number };
    outputPath?: string;
}

export interface MaterialXExportResult {
    xmlContent: string;
    filePath?: string;
    materialName: string;
}

/**
 * Service to generate OpenPBR-compliant MaterialX (.mtlx v1.38) documents
 * for high-end VFX and game engine pipelines (Houdini Karma, Unreal Engine 5.4+, Maya Arnold).
 */
export class MaterialXService {
    /**
     * Generates an OpenPBR v1.38 compliant MaterialX XML string.
     */
    public static generateOpenPbrDocument(options: MaterialXExportOptions): string {
        const matName = (options.materialName || 'PbrMaterial').replace(/[^a-zA-Z0-9_]/g, '_');
        const tilingU = options.uvTiling?.u ?? 1.0;
        const tilingV = options.uvTiling?.v ?? 1.0;

        const baseAlbedo = options.descriptor?.albedoLinear ?? [0.8, 0.8, 0.8];
        const conduction = options.descriptor?.conduction ?? 0.0;
        const roughness = options.descriptor?.roughnessBaseline ?? 0.5;

        const {
            albedoFileName,
            normalFileName,
            roughnessFileName,
            metallicFileName,
            aoFileName,
            heightFileName
        } = options.textures;

        const useSeparateChannels = !!(roughnessFileName && metallicFileName);

        return `<?xml version="1.0"?>
<materialx version="1.38">
  <!--
    Scratchbox IDE PBR MaterialX Document (OpenPBR v1.38 Standard)
    Compliant with Adaptive Domain Architecture (ADA) & Open-Domain Universality
  -->

  <!-- UV Coordinates with Continuous Tiling -->
  <texcoord name="uv_coords" type="vector2">
    <input name="index" type="integer" value="0" />
  </texcoord>

  <multiply name="tiled_uvs" type="vector2">
    <input name="in1" type="vector2" nodename="uv_coords" />
    <input name="in2" type="vector2" value="${tilingU.toFixed(4)}, ${tilingV.toFixed(4)}" />
  </multiply>

  <!-- Texture Inputs -->
  <image name="image_albedo" type="color3">
    <input name="file" type="filename" value="${albedoFileName}" />
    <input name="texcoord" type="vector2" nodename="tiled_uvs" />
    <input name="uaddressmode" type="string" value="periodic" />
    <input name="vaddressmode" type="string" value="periodic" />
  </image>

  <image name="image_normal" type="vector3">
    <input name="file" type="filename" value="${normalFileName}" />
    <input name="texcoord" type="vector2" nodename="tiled_uvs" />
    <input name="uaddressmode" type="string" value="periodic" />
    <input name="vaddressmode" type="string" value="periodic" />
  </image>

  <normalmap name="node_normalmap" type="vector3">
    <input name="in" type="vector3" nodename="image_normal" />
    <input name="scale" type="float" value="1.0" />
    <input name="space" type="string" value="tangent" />
  </normalmap>
${useSeparateChannels ? `
  <image name="image_roughness" type="float">
    <input name="file" type="filename" value="${roughnessFileName}" />
    <input name="texcoord" type="vector2" nodename="tiled_uvs" />
    <input name="uaddressmode" type="string" value="periodic" />
    <input name="vaddressmode" type="string" value="periodic" />
  </image>

  <image name="image_metallic" type="float">
    <input name="file" type="filename" value="${metallicFileName}" />
    <input name="texcoord" type="vector2" nodename="tiled_uvs" />
    <input name="uaddressmode" type="string" value="periodic" />
    <input name="vaddressmode" type="string" value="periodic" />
  </image>
` : options.textures.ormFileName ? `
  <image name="image_orm" type="color3">
    <input name="file" type="filename" value="${options.textures.ormFileName}" />
    <input name="texcoord" type="vector2" nodename="tiled_uvs" />
    <input name="uaddressmode" type="string" value="periodic" />
    <input name="vaddressmode" type="string" value="periodic" />
  </image>

  <extract name="extract_roughness" type="float">
    <input name="in" type="color3" nodename="image_orm" />
    <input name="index" type="integer" value="1" />
  </extract>

  <extract name="extract_metallic" type="float">
    <input name="in" type="color3" nodename="image_orm" />
    <input name="index" type="integer" value="2" />
  </extract>

  <extract name="extract_ao" type="float">
    <input name="in" type="color3" nodename="image_orm" />
    <input name="index" type="integer" value="0" />
  </extract>
` : ''}${heightFileName ? `
  <image name="image_displacement" type="float">
    <input name="file" type="filename" value="${heightFileName}" />
    <input name="texcoord" type="vector2" nodename="tiled_uvs" />
    <input name="uaddressmode" type="string" value="periodic" />
    <input name="vaddressmode" type="string" value="periodic" />
  </image>

  <displacement name="node_displacement" type="displacementshader">
    <input name="displacement" type="float" nodename="image_displacement" />
    <input name="scale" type="float" value="0.05" />
  </displacement>
` : ''}

  <!-- OpenPBR Surface Shader (Universal VFX Standard) -->
  <open_pbr_surface name="${matName}_openpbr" type="surfaceshader">
    <input name="base_weight" type="float" value="1.0" />
    <input name="base_color" type="color3" nodename="image_albedo" />
    <input name="base_metalness" type="float" ${useSeparateChannels ? 'nodename="image_metallic"' : options.textures.ormFileName ? 'nodename="extract_metallic"' : `value="${conduction.toFixed(3)}"`} />
    <input name="specular_roughness" type="float" ${useSeparateChannels ? 'nodename="image_roughness"' : options.textures.ormFileName ? 'nodename="extract_roughness"' : `value="${roughness.toFixed(3)}"`} />
    <input name="specular_ior" type="float" value="1.50" />
    <input name="geometry_normal" type="vector3" nodename="node_normalmap" />
  </open_pbr_surface>

  <!-- Standard Surface Shader (Autodesk Maya / Arnold / Houdini Compatibility) -->
  <standard_surface name="${matName}_standardsurface" type="surfaceshader">
    <input name="base" type="float" value="1.0" />
    <input name="base_color" type="color3" nodename="image_albedo" />
    <input name="metalness" type="float" ${useSeparateChannels ? 'nodename="image_metallic"' : options.textures.ormFileName ? 'nodename="extract_metallic"' : `value="${conduction.toFixed(3)}"`} />
    <input name="specular_roughness" type="float" ${useSeparateChannels ? 'nodename="image_roughness"' : options.textures.ormFileName ? 'nodename="extract_roughness"' : `value="${roughness.toFixed(3)}"`} />
    <input name="normal" type="vector3" nodename="node_normalmap" />
  </standard_surface>

  <!-- Output Material Assignment -->
  <surfacematerial name="${matName}" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="${matName}_openpbr" />
${heightFileName ? `    <input name="displacementshader" type="displacementshader" nodename="node_displacement" />\n` : ''}  </surfacematerial>
</materialx>
`;
    }

    /**
     * Writes the MaterialX document to disk.
     */
    public static exportMaterialX(options: MaterialXExportOptions): MaterialXExportResult {
        const xmlContent = this.generateOpenPbrDocument(options);
        const matName = options.materialName || 'PbrMaterial';

        if (options.outputPath) {
            const dir = path.dirname(options.outputPath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(options.outputPath, xmlContent, 'utf8');
            return {
                xmlContent,
                filePath: options.outputPath,
                materialName: matName
            };
        }

        return {
            xmlContent,
            materialName: matName
        };
    }
}
