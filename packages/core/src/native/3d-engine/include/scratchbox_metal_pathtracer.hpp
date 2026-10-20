/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_METAL_PATHTRACER_HPP
#define SCRATCHBOX_METAL_PATHTRACER_HPP

/**
 * GPU path tracer on Metal's hardware ray intersector (Objective-C++: include from a .mm translation
 * unit). Geometry is a flat triangle list with a material id per triangle; materials and textures
 * come from a glTF scene (gltf::GltfScene) or one uniform material. The kernels in
 * scratchbox_metal_pathtracer_kernels.hpp are compiled at run time, so no shader toolchain is needed
 * on the machine.
 *
 * Every sample pass is one compute dispatch that adds to a per-pixel accumulation buffer, so a render
 * can be read back after any number of samples. Render time is the GPU's own (sum of the command
 * buffers' GPU start-to-end times), and ray counts are tallied by the kernels, never estimated.
 *
 * There is no fallback: a machine without a Metal device that supports ray tracing throws Error.
 */

#ifndef __OBJC__
#error "scratchbox_metal_pathtracer.hpp is Objective-C++; compile it in a .mm translation unit"
#endif

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_metal_pathtracer_kernels.hpp"
#include "scratchbox_pathtracer.hpp"
#include "scratchbox_sky.hpp"
#include <chrono>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace scratchbox {
namespace metalpt {

using math::Vec3;

struct Error : std::runtime_error {
    using std::runtime_error::runtime_error;
};

struct DeviceInfo {
    std::string name;
    bool raytracing{false};
    /** Apple GPU family generation (7 = M1, 8 = M2, 9 = M3 and later with the dedicated ray tracing unit). */
    int appleFamily{0};
    uint64_t recommendedWorkingSetBytes{0};
};

/** The default Metal device, or Error when there is none. */
inline DeviceInfo probeDevice() {
    @autoreleasepool {
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) throw Error("no Metal device");
        DeviceInfo info;
        info.name = device.name.UTF8String;
        info.raytracing = device.supportsRaytracing;
        if ([device supportsFamily:MTLGPUFamilyApple9]) info.appleFamily = 9;
        else if ([device supportsFamily:MTLGPUFamilyApple8]) info.appleFamily = 8;
        else if ([device supportsFamily:MTLGPUFamilyApple7]) info.appleFamily = 7;
        info.recommendedWorkingSetBytes = device.recommendedMaxWorkingSetSize;
        return info;
    }
}

struct Lighting {
    enum class Mode { Studio, Sky };
    Mode mode{Mode::Studio};
    /** Uniform environment radiance in Studio mode. */
    Vec3 studioRadiance{1.0f, 1.0f, 1.0f};
    /** Required in Sky mode. */
    const sky::PhysicalSky* sky{nullptr};
};

/** One material for every triangle (the studio clay by default). */
struct Material {
    Vec3 albedo{0.716f, 0.672f, 0.610f};
    float roughness{0.82f};
    float metallic{0.02f};
};

class MetalPathTracer {
public:
    MetalPathTracer() {
        @autoreleasepool {
            device_ = MTLCreateSystemDefaultDevice();
            if (!device_) throw Error("no Metal device");
            if (!device_.supportsRaytracing) throw Error(std::string("Metal device ") + device_.name.UTF8String + " does not support ray tracing");
            queue_ = [device_ newCommandQueue];
            MTLCompileOptions* options = [MTLCompileOptions new];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
            // Keep IEEE semantics so the GPU and CPU integrators agree beyond sampling noise.
            options.fastMathEnabled = NO;
#pragma clang diagnostic pop
            NSError* error = nil;
            id<MTLLibrary> library = [device_ newLibraryWithSource:[NSString stringWithUTF8String:kKernelSource] options:options error:&error];
            if (!library) throw Error(std::string("Metal kernel compilation failed: ") + (error ? error.localizedDescription.UTF8String : "unknown error"));
            initPso_ = makePipeline(library, "pt_init");
            samplePso_ = makePipeline(library, "pt_sample");
            deviceName_ = device_.name.UTF8String;
            // Bound when a render uses one uniform material; the kernel never reads them then.
            static const uint32_t zero = 0;
            static const MaterialRecord defaultRecord{};
            static const uint64_t noTexture = 0;
            emptyMaterialIds_ = [device_ newBufferWithBytes:&zero length:sizeof(zero) options:MTLResourceStorageModeShared];
            emptyMaterials_ = [device_ newBufferWithBytes:&defaultRecord length:sizeof(defaultRecord) options:MTLResourceStorageModeShared];
            emptyTextures_ = [device_ newBufferWithBytes:&noTexture length:sizeof(noTexture) options:MTLResourceStorageModeShared];
        }
    }

    const std::string& deviceName() const { return deviceName_; }
    double accelerationBuildMs() const { return accelerationBuildMs_; }
    uint32_t triangleCount() const { return triangleCount_; }
    uint32_t textureCount() const { return static_cast<uint32_t>(textures_.size()); }
    uint32_t materialCount() const { return materialCount_; }
    uint64_t textureBytes() const { return textureBytes_; }

    /**
     * Uploads `vertices` (position xyz, normal xyz, uv per vertex), `indices` (3 per triangle) and
     * `triMaterials` (a glTF material index or vgeo::kNoMaterial per triangle) and builds the
     * acceleration structure.
     */
    void setGeometry(const std::vector<float>& vertices, const std::vector<uint32_t>& indices, const std::vector<uint32_t>& triMaterials) {
        constexpr size_t floats = sizeof(Vertex) / sizeof(float);
        if (vertices.size() % floats != 0) throw Error("vertex buffer is not 8 floats per vertex");
        if (indices.size() % 3 != 0 || indices.empty()) throw Error("index buffer is not 3 indices per triangle");
        if (triMaterials.size() != indices.size() / 3) throw Error("one material id per triangle is required");
        const uint32_t vertexCount = static_cast<uint32_t>(vertices.size() / floats);
        for (uint32_t i : indices) {
            if (i >= vertexCount) throw Error("index past the vertex buffer");
        }
        @autoreleasepool {
            auto start = std::chrono::steady_clock::now();
            vertexBuffer_ = [device_ newBufferWithBytes:vertices.data() length:vertices.size() * sizeof(float) options:MTLResourceStorageModeShared];
            indexBuffer_ = [device_ newBufferWithBytes:indices.data() length:indices.size() * sizeof(uint32_t) options:MTLResourceStorageModeShared];
            materialIdBuffer_ = [device_ newBufferWithBytes:triMaterials.data() length:triMaterials.size() * sizeof(uint32_t) options:MTLResourceStorageModeShared];
            triangleCount_ = static_cast<uint32_t>(indices.size() / 3);
            triMaterials_ = triMaterials;

            MTLAccelerationStructureTriangleGeometryDescriptor* geometry = [MTLAccelerationStructureTriangleGeometryDescriptor descriptor];
            geometry.vertexBuffer = vertexBuffer_;
            geometry.vertexStride = sizeof(Vertex);
            geometry.vertexFormat = MTLAttributeFormatFloat3;
            geometry.indexBuffer = indexBuffer_;
            geometry.indexType = MTLIndexTypeUInt32;
            geometry.triangleCount = triangleCount_;
            geometry.opaque = YES;
            MTLPrimitiveAccelerationStructureDescriptor* descriptor = [MTLPrimitiveAccelerationStructureDescriptor descriptor];
            descriptor.geometryDescriptors = @[geometry];
            MTLAccelerationStructureSizes sizes = [device_ accelerationStructureSizesWithDescriptor:descriptor];
            accel_ = [device_ newAccelerationStructureWithSize:sizes.accelerationStructureSize];
            id<MTLBuffer> scratch = [device_ newBufferWithLength:sizes.buildScratchBufferSize options:MTLResourceStorageModePrivate];
            if (!accel_ || !scratch) throw Error("could not allocate the acceleration structure");
            id<MTLCommandBuffer> commands = [queue_ commandBuffer];
            id<MTLAccelerationStructureCommandEncoder> encoder = [commands accelerationStructureCommandEncoder];
            [encoder buildAccelerationStructure:accel_ descriptor:descriptor scratchBuffer:scratch scratchBufferOffset:0];
            [encoder endEncoding];
            [commands commit];
            [commands waitUntilCompleted];
            if (commands.error) throw Error(std::string("acceleration structure build failed: ") + commands.error.localizedDescription.UTF8String);
            accelerationBuildMs_ = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        }
    }

    /**
     * Uploads the scene's materials and decoded images. Material ids in the geometry index
     * `scene.materials`; a default material is appended for triangles without one. Images that
     * failed to decode are left out, and the materials that name them render with their factors.
     */
    void setMaterials(const gltf::GltfScene& scene) {
        @autoreleasepool {
            textures_.clear();
            textureBytes_ = 0;
            std::vector<int32_t> textureOf(scene.images.size(), -1);
            std::vector<uint64_t> refs;
            for (size_t i = 0; i < scene.images.size(); ++i) {
                const gltf::SceneImage& image = scene.images[i];
                if (!image.decoded || image.pixels.width <= 0 || image.pixels.height <= 0) continue;
                const texture::ImageBuffer& px = image.pixels;
                std::vector<uint8_t> rgba(static_cast<size_t>(px.width) * px.height * 4);
                for (size_t p = 0; p < static_cast<size_t>(px.width) * px.height; ++p) {
                    const uint8_t* src = px.data.data() + p * px.channels;
                    uint8_t* dst = rgba.data() + p * 4;
                    if (px.channels >= 3) {
                        dst[0] = src[0];
                        dst[1] = src[1];
                        dst[2] = src[2];
                    } else {
                        dst[0] = dst[1] = dst[2] = src[0];
                    }
                    dst[3] = 255;
                }
                // Stored as given; colour maps are sRGB-decoded in the kernel, data maps are not.
                MTLTextureDescriptor* desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
                                                                                               width:static_cast<NSUInteger>(px.width)
                                                                                              height:static_cast<NSUInteger>(px.height)
                                                                                           mipmapped:NO];
                desc.usage = MTLTextureUsageShaderRead;
                desc.storageMode = MTLStorageModeShared;
                id<MTLTexture> texture = [device_ newTextureWithDescriptor:desc];
                if (!texture) throw Error("could not allocate a texture");
                [texture replaceRegion:MTLRegionMake2D(0, 0, static_cast<NSUInteger>(px.width), static_cast<NSUInteger>(px.height))
                           mipmapLevel:0
                             withBytes:rgba.data()
                           bytesPerRow:static_cast<NSUInteger>(px.width) * 4];
                textureOf[i] = static_cast<int32_t>(textures_.size());
                textures_.push_back(texture);
                MTLResourceID rid = texture.gpuResourceID;
                uint64_t bits;
                static_assert(sizeof(rid) == sizeof(bits), "MTLResourceID is 8 bytes");
                std::memcpy(&bits, &rid, sizeof(bits));
                refs.push_back(bits);
                textureBytes_ += rgba.size();
            }
            if (refs.empty()) refs.push_back(0);

            std::vector<MaterialRecord> records;
            records.reserve(scene.materials.size() + 1);
            auto imageRef = [&](int image) { return image >= 0 && image < static_cast<int>(textureOf.size()) ? textureOf[static_cast<size_t>(image)] : -1; };
            for (const gltf::SceneMaterial& m : scene.materials) {
                MaterialRecord r;
                r.baseColor[0] = m.baseColorFactor.x;
                r.baseColor[1] = m.baseColorFactor.y;
                r.baseColor[2] = m.baseColorFactor.z;
                r.baseColor[3] = m.baseColorFactor.w;
                r.metallic = m.metallicFactor;
                r.roughness = m.roughnessFactor;
                r.normalScale = m.normalScale;
                r.occlusionStrength = m.occlusionStrength;
                r.emissive[0] = m.emissiveFactor.x;
                r.emissive[1] = m.emissiveFactor.y;
                r.emissive[2] = m.emissiveFactor.z;
                r.baseColorImage = imageRef(m.baseColorImage);
                r.wrapS = m.wrapS;
                r.wrapT = m.wrapT;
                r.normalImage = imageRef(m.normalImage);
                r.normalWrapS = m.normalWrapS;
                r.normalWrapT = m.normalWrapT;
                r.mrImage = imageRef(m.metallicRoughnessImage);
                r.mrWrapS = m.mrWrapS;
                r.mrWrapT = m.mrWrapT;
                r.occlusionImage = imageRef(m.occlusionImage);
                records.push_back(r);
            }
            defaultMaterial_ = static_cast<uint32_t>(records.size());
            records.push_back(MaterialRecord{});
            materialCount_ = static_cast<uint32_t>(scene.materials.size());
            materialBuffer_ = [device_ newBufferWithBytes:records.data() length:records.size() * sizeof(MaterialRecord) options:MTLResourceStorageModeShared];
            textureRefBuffer_ = [device_ newBufferWithBytes:refs.data() length:refs.size() * sizeof(uint64_t) options:MTLResourceStorageModeShared];
            if (!materialBuffer_ || !textureRefBuffer_) throw Error("could not allocate the material buffers");
            hasMaterials_ = true;
        }
    }

    /**
     * Renders `settings.samplesPerPixel` samples of every pixel. `camera` is in the geometry's coordinates.
     * With `uniformMaterial`, every triangle takes that material; without it, the materials given to
     * setMaterials shade the triangles by their ids. The result follows render::PathTracer::render's
     * conventions (scene-linear radiance, guide buffers, variance, NaN and ray counts); renderMs is GPU time.
     */
    render::RenderOutput render(const render::CameraSpec& camera, const Lighting& lighting, const render::RenderSettings& settings,
                                const Material* uniformMaterial) {
        if (!accel_) throw Error("setGeometry was not called");
        if (lighting.mode == Lighting::Mode::Sky && !lighting.sky) throw Error("Sky lighting needs a PhysicalSky");
        if (!uniformMaterial && !hasMaterials_) throw Error("setMaterials was not called and no uniform material was given");
        if (!uniformMaterial) {
            for (uint32_t id : triMaterials_) {
                if (id != 0xFFFFFFFFu && id >= materialCount_) throw Error("a triangle names a material the scene does not have");
            }
        }
        const int w = std::max(1, settings.width);
        const int h = std::max(1, settings.height);
        const int spp = std::max(1, settings.samplesPerPixel);
        const size_t n = static_cast<size_t>(w) * h;

        Uniforms u;
        u.width = static_cast<uint32_t>(w);
        u.height = static_cast<uint32_t>(h);
        u.maxBounces = static_cast<uint32_t>(std::max(0, settings.maxBounces));
        u.clampIndirect = settings.clampIndirect;
        Vec3 forward = (camera.target - camera.position).normalized();
        if (forward.lengthSquared() < 0.5f) forward = Vec3(0, 0, -1);
        Vec3 right = forward.cross(camera.up).normalized();
        if (right.lengthSquared() < 0.5f) right = Vec3(1, 0, 0);
        const Vec3 up = right.cross(forward);
        put(u.camPos, camera.position);
        put(u.forward, forward);
        put(u.right, right);
        put(u.up, up);
        u.tanHalf = std::tan(0.5f * camera.verticalFovDeg * math::DEG_TO_RAD);
        u.aspect = static_cast<float>(w) / static_cast<float>(h);
        u.apertureRadius = camera.apertureRadius;
        u.focusDistance = camera.focusDistance > 0.0f ? camera.focusDistance : (camera.target - camera.position).length();
        if (uniformMaterial) {
            u.useMaterials = 0;
            put(u.albedo, uniformMaterial->albedo);
            u.roughness = std::clamp(uniformMaterial->roughness, 0.02f, 1.0f);
            u.metallic = std::clamp(uniformMaterial->metallic, 0.0f, 1.0f);
        } else {
            u.useMaterials = 1;
            u.defaultMaterial = defaultMaterial_;
        }
        const uint64_t seed = render::detail::splitmix64(settings.seed);
        u.seedLo = static_cast<uint32_t>(seed & 0xFFFFFFFFull);
        u.seedHi = static_cast<uint32_t>(seed >> 32);

        std::vector<float> lut(3, 0.0f);
        if (lighting.mode == Lighting::Mode::Sky) {
            const sky::PhysicalSky& sky = *lighting.sky;
            u.lighting = 1;
            put(u.sunDir, sky.sunDirection());
            put(u.sunTangent, sky.sunTangent());
            put(u.sunBitangent, sky.sunBitangent());
            u.sunCosHalfAngle = sky.sunCosHalfAngle();
            u.sunSolidAngle = sky.sunSolidAngle();
            put(u.sunIrradiance, sky.sunIrradiance());
            u.sunVisible = render::detail::luminance(sky.sunIrradiance()) > 1e-8f ? 1 : 0;
            put(u.hazeExtinction, sky.hazeExtinction());
            u.limbDarkening = static_cast<float>(sky::detail::kLimbDarkening);
            u.azimuthRes = static_cast<uint32_t>(sky.azimuthResolution());
            u.elevationRes = static_cast<uint32_t>(sky.elevationResolution());
            const std::vector<Vec3>& table = sky.skyLut();
            lut.resize(table.size() * 3);
            for (size_t i = 0; i < table.size(); ++i) {
                lut[i * 3] = table[i].x;
                lut[i * 3 + 1] = table[i].y;
                lut[i * 3 + 2] = table[i].z;
            }
        } else {
            u.lighting = 0;
            put(u.studioRadiance, lighting.studioRadiance);
        }

        render::RenderOutput out;
        @autoreleasepool {
            id<MTLBuffer> pixels = [device_ newBufferWithLength:n * sizeof(PixelState) options:MTLResourceStorageModeShared];
            id<MTLBuffer> uniforms = [device_ newBufferWithBytes:&u length:sizeof(Uniforms) options:MTLResourceStorageModeShared];
            id<MTLBuffer> lutBuffer = [device_ newBufferWithBytes:lut.data() length:lut.size() * sizeof(float) options:MTLResourceStorageModeShared];
            if (!pixels || !uniforms || !lutBuffer) throw Error("could not allocate render buffers");
            id<MTLBuffer> materialIds = uniformMaterial ? emptyMaterialIds_ : materialIdBuffer_;
            id<MTLBuffer> materials = uniformMaterial ? emptyMaterials_ : materialBuffer_;
            id<MTLBuffer> textureRefs = uniformMaterial ? emptyTextures_ : textureRefBuffer_;

            const MTLSize grid = MTLSizeMake(static_cast<NSUInteger>(w), static_cast<NSUInteger>(h), 1);
            const MTLSize group = MTLSizeMake(8, 8, 1);
            double gpuSeconds = 0.0;
            auto submit = [&](id<MTLCommandBuffer> commands) {
                [commands commit];
                [commands waitUntilCompleted];
                if (commands.error) throw Error(std::string("GPU render failed: ") + commands.error.localizedDescription.UTF8String);
                gpuSeconds += commands.GPUEndTime - commands.GPUStartTime;
            };
            {
                id<MTLCommandBuffer> commands = [queue_ commandBuffer];
                id<MTLComputeCommandEncoder> encoder = [commands computeCommandEncoder];
                [encoder setComputePipelineState:initPso_];
                [encoder setBuffer:pixels offset:0 atIndex:0];
                [encoder setBuffer:uniforms offset:0 atIndex:1];
                [encoder dispatchThreads:grid threadsPerThreadgroup:group];
                [encoder endEncoding];
                submit(commands);
            }
            // A few sample passes per command buffer: the GPU watchdog bounds how long one may run.
            const int passesPerBuffer = 4;
            for (int s = 0; s < spp; s += passesPerBuffer) {
                id<MTLCommandBuffer> commands = [queue_ commandBuffer];
                for (int k = s; k < std::min(spp, s + passesPerBuffer); ++k) {
                    id<MTLComputeCommandEncoder> encoder = [commands computeCommandEncoder];
                    [encoder setComputePipelineState:samplePso_];
                    [encoder setBuffer:pixels offset:0 atIndex:0];
                    [encoder setBuffer:uniforms offset:0 atIndex:1];
                    [encoder setBuffer:vertexBuffer_ offset:0 atIndex:2];
                    [encoder setBuffer:indexBuffer_ offset:0 atIndex:3];
                    [encoder setBuffer:lutBuffer offset:0 atIndex:4];
                    [encoder setAccelerationStructure:accel_ atBufferIndex:5];
                    [encoder setBuffer:materialIds offset:0 atIndex:6];
                    [encoder setBuffer:materials offset:0 atIndex:7];
                    [encoder setBuffer:textureRefs offset:0 atIndex:8];
                    if (!uniformMaterial) {
                        for (id<MTLTexture> texture : textures_) [encoder useResource:texture usage:MTLResourceUsageRead];
                    }
                    [encoder dispatchThreads:grid threadsPerThreadgroup:group];
                    [encoder endEncoding];
                }
                submit(commands);
            }

            out.width = w;
            out.height = h;
            out.color.assign(n, Vec3(0, 0, 0));
            out.guides.width = w;
            out.guides.height = h;
            out.guides.albedo.assign(n, Vec3(0, 0, 0));
            out.guides.normal.assign(n, Vec3(0, 0, 0));
            out.guides.depth.assign(n, 0.0f);
            out.guides.variance.assign(n, 0.0f);
            out.guides.geometryMask.assign(n, 0);
            const PixelState* state = static_cast<const PixelState*>(pixels.contents);
            const float inv = 1.0f / static_cast<float>(spp);
            size_t covered = 0;
            for (size_t i = 0; i < n; ++i) {
                const PixelState& p = state[i];
                out.color[i] = Vec3(p.color[0], p.color[1], p.color[2]) * inv;
                const double mean = static_cast<double>(p.lum) / spp;
                out.guides.variance[i] = static_cast<float>(std::max(0.0, static_cast<double>(p.lumSq) / spp - mean * mean) / spp);
                out.rays += p.rays;
                out.nanSamples += p.nan;
                if (p.hits * 2 >= static_cast<uint32_t>(spp)) {
                    out.guides.geometryMask[i] = 1;
                    out.guides.albedo[i] = Vec3(p.albedo[0], p.albedo[1], p.albedo[2]) / static_cast<float>(p.hits);
                    out.guides.normal[i] = Vec3(p.normal[0], p.normal[1], p.normal[2]).normalized();
                    out.guides.depth[i] = p.depth / static_cast<float>(p.hits);
                    ++covered;
                }
            }
            out.geometryCoverage = static_cast<float>(covered) / static_cast<float>(n);
            out.renderMs = gpuSeconds * 1000.0;
        }
        return out;
    }

private:
    static void put(float* dst, const Vec3& v) {
        dst[0] = v.x;
        dst[1] = v.y;
        dst[2] = v.z;
    }

    id<MTLComputePipelineState> makePipeline(id<MTLLibrary> library, const char* name) {
        id<MTLFunction> fn = [library newFunctionWithName:[NSString stringWithUTF8String:name]];
        if (!fn) throw Error(std::string("kernel not found: ") + name);
        NSError* error = nil;
        id<MTLComputePipelineState> pso = [device_ newComputePipelineStateWithFunction:fn error:&error];
        if (!pso) throw Error(std::string("pipeline creation failed for ") + name + ": " + (error ? error.localizedDescription.UTF8String : "unknown error"));
        return pso;
    }

    id<MTLDevice> device_{nil};
    id<MTLCommandQueue> queue_{nil};
    id<MTLComputePipelineState> initPso_{nil};
    id<MTLComputePipelineState> samplePso_{nil};
    id<MTLBuffer> vertexBuffer_{nil};
    id<MTLBuffer> indexBuffer_{nil};
    id<MTLBuffer> materialIdBuffer_{nil};
    id<MTLBuffer> materialBuffer_{nil};
    id<MTLBuffer> textureRefBuffer_{nil};
    id<MTLBuffer> emptyMaterialIds_{nil};
    id<MTLBuffer> emptyMaterials_{nil};
    id<MTLBuffer> emptyTextures_{nil};
    id<MTLAccelerationStructure> accel_{nil};
    std::vector<id<MTLTexture>> textures_;
    std::vector<uint32_t> triMaterials_;
    std::string deviceName_;
    double accelerationBuildMs_{0.0};
    uint32_t triangleCount_{0};
    uint32_t materialCount_{0};
    uint32_t defaultMaterial_{0};
    uint64_t textureBytes_{0};
    bool hasMaterials_{false};
};

} // namespace metalpt
} // namespace scratchbox

#endif // SCRATCHBOX_METAL_PATHTRACER_HPP
