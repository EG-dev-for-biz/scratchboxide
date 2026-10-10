# Unity Deep Mastery: URP, HDRP, Shader Graph & Procedural C#

> *"Unity's power lies in its modularity: from Scriptable Render Pipelines and Shader Graph to Burst-compiled compute and C# procedural geometry."*

---

## 1. Render Pipelines: URP vs HDRP

| Feature | Universal Render Pipeline (URP) | High Definition Render Pipeline (HDRP) |
| :--- | :--- | :--- |
| **Target Platform** | Mobile, Switch, VR, PC, Consoles (Scalable) | High-end PC, PS5, Xbox Series X (Photorealistic) |
| **Renderer Architecture** | Forward+ / Deferred | Tile/Cluster Deferred & Forward |
| **Lighting Model** | Physically Based (Simple/Standard) | Physical Light Units (Lux, Lumen, EV100, Nit) |
| **Volumetrics** | Height Fog, Simple Raymarched Volumetrics | True Volumetric Clouds, Fog Volumes, Density Masks |
| **Ray Tracing** | Limited / Screen-Space | Native DXR Ray Tracing (GI, Reflections, Shadows) |
| **Decals** | Screen Space / DBuffer Decal Pass | Clustered DBuffer Decal System |

---

## 2. Scriptable Renderer Features & Custom Passes

To inject custom visual effects (screen-space outlines, scanlines, thermal vision, or custom stencil tests) in URP without modifying engine source:

### The ScriptableRenderPass Architecture:
1. Inherit from `ScriptableRendererFeature`.
2. Implement a `ScriptableRenderPass` injected at an explicit injection point:
   - `RenderPassEvent.AfterRenderingOpaques`: For depth-based edge detection, water distortion.
   - `RenderPassEvent.BeforeRenderingPostProcessing`: For custom stylized color grading or cel-outline blits.
   - `RenderPassEvent.AfterRenderingTransparents`: For UI or final overlay effects.

```csharp
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

public class CustomOutlineFeature : ScriptableRendererFeature
{
    class OutlinePass : ScriptableRenderPass
    {
        public Material outlineMaterial;
        private RTHandle tempColorTexture;

        public OutlinePass(Material mat)
        {
            this.outlineMaterial = mat;
            renderPassEvent = RenderPassEvent.BeforeRenderingPostProcessing;
        }

        public override void Execute(ScriptableRenderContext context, ref RenderingData renderingData)
        {
            if (outlineMaterial == null) return;
            CommandBuffer cmd = CommandBufferPool.Get("CustomOutline");
            
            // Blit using camera color target
            RTHandle source = renderingData.cameraData.renderer.cameraColorTargetHandle;
            cmd.Blit(source, source, outlineMaterial);
            
            context.ExecuteCommandBuffer(cmd);
            CommandBufferPool.Release(cmd);
        }
    }

    public Material material;
    private OutlinePass pass;

    public override void Create()
    {
        pass = new OutlinePass(material);
    }

    public override void AddRenderPasses(ScriptableRenderer renderer, ref RenderingData renderingData)
    {
        renderer.EnqueuePass(pass);
    }
}
```

---

## 3. Shader Graph Mastery & Custom HLSL

### 3.1 Reconstructing World Position from Scene Depth
A fundamental building block for volumetric fog, water shorelines, and ground scanlines:
In a `Custom Function` node (HLSL):
```hlsl
void ReconstructWorldPos_float(
    float2 screenUV,
    float rawDepth,
    out float3 worldPos)
{
    // Convert Screen UV and Depth to Clip Space (-1 to 1)
    #if UNITY_UV_STARTS_AT_TOP
    screenUV.y = 1.0 - screenUV.y;
    #endif

    float4 clipPos = float4(screenUV * 2.0 - 1.0, rawDepth, 1.0);
    
    // Multiply by inverse View-Projection matrix
    float4 viewPos = mul(UNITY_MATRIX_I_VP, clipPos);
    worldPos = viewPos.xyz / viewPos.w;
}
```

### 3.2 Screen Position Node Types
- **Default (Normalized)**: $UV \in [0, 1]$. Used for sampling `_CameraOpaqueTexture` or post-process passes.
- **Raw**: Un-divided by $W$ component $(x, y, z, w)$. Must plug directly into texture samplers that perform perspective division (`tex2Dproj`).
- **Center**: Origin $(0, 0)$ at center of screen, ranging $[-0.5, 0.5]$. Ideal for vignettes and radial blur.

---

## 4. C# Procedural Geometry & The Burst Compiler

Generating or deforming meshes via standard `mesh.vertices = array` generates tons of garbage collection (GC) and blocks the main thread.

### The High-Performance Job System + NativeArray Workflow:
```csharp
using UnityEngine;
using Unity.Collections;
using Unity.Jobs;
using Unity.Mathematics;
using Unity.Burst;

[BurstCompile]
public struct DeformMeshJob : IJobParallelFor
{
    [ReadOnly] public NativeArray<float3> InitialPositions;
    [WriteOnly] public NativeArray<float3> ModifiedPositions;
    public float Time;
    public float Frequency;
    public float Amplitude;

    public void Execute(int index)
    {
        float3 pos = InitialPositions[index];
        float wave = math.sin(pos.x * Frequency + Time) * math.cos(pos.z * Frequency + Time);
        pos.y += wave * Amplitude;
        ModifiedPositions[index] = pos;
    }
}
```
- Runs across all CPU worker threads simultaneously.
- Burst compiles directly to vectorized SIMD machine code ($8\times - 20\times$ faster than standard C#).
- Can deform a $100,000$ vertex ocean surface or soft-body character at **over 120 FPS**.

---

## 5. Lightmapping & Light Probes

### 5.1 Light Probe Proxy Volumes (LPPV)
- **The Problem**: Standard Light Probes sample ambient lighting at a **single point** (the object's pivot). A 50-meter long train or bridge moving through a dark tunnel will instantly pop from 100% lit to 100% dark when its pivot crosses into shadow.
- **The Solution**: Add a `Light Probe Proxy Volume` component to the large object. It generates a 3D grid of interpolated lighting samples across the entire bounding box, allowing the train to slide smoothly from sun into shadow.

### 5.2 Eliminating Lightmap Seams on Modular Architecture
1. In the Mesh Import settings, check `Generate Lightmap UVs` with:
   - `Margin Method`: Calculate
   - `Pack Margin`: Minimum **4 pixels** (prevents mipmap color bleed from neighboring charts).
2. Align modular wall seams to whole grid units that divide evenly into the lightmap resolution.
3. In Lighting Settings, enable `Stitch Seams` on the Baked GI settings.
