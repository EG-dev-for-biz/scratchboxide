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
 * The scene's own lights (emissive triangles of the traced geometry and the glTF punctual lights given to
 * setLights) are sampled from the light tree of scratchbox_light_tree.hpp, built here and uploaded as it is.
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
#import <MetalFX/MetalFX.h>

#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_light_tree.hpp"
#include "scratchbox_metal_pathtracer_kernels.hpp"
#include "scratchbox_pathtracer.hpp"
#include "scratchbox_sky.hpp"
#include <chrono>
#include <cstring>
#include <mutex>
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

/** Filter settings (denoise::DenoiseSettings) plus temporal reuse. */
struct DenoiseOptions {
    int iterations{5};
    float sigmaNormal{128.0f};
    float sigmaDepth{1.0f};
    float sigmaLuminance{4.0f};
    /** Reproject the committed history of the previous view into this frame before filtering. */
    bool temporal{false};
    /** Most samples a history pixel may stand for, so stale history gives way to new samples. */
    int historyCap{32};
};

/** A camera as the kernels see it, kept per frame so a later view can reproject into it. */
struct ViewBasis {
    Vec3 position, forward, right, up;
    float tanHalf{1.0f}, aspect{1.0f};
    int width{0}, height{0};
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
            const std::string source = std::string(kKernelSource) + render::detail::ggxEssMetalSource() + kDenoiseKernelSource;
            id<MTLLibrary> library = [device_ newLibraryWithSource:[NSString stringWithUTF8String:source.c_str()] options:options error:&error];
            if (!library) throw Error(std::string("Metal kernel compilation failed: ") + (error ? error.localizedDescription.UTF8String : "unknown error"));
            initPso_ = makePipeline(library, "pt_init");
            samplePso_ = makePipeline(library, "pt_sample");
            restirSpatialPso_ = makePipeline(library, "restir_spatial");
            guideCommitPso_ = makePipeline(library, "guide_commit");
            dnPreparePso_ = makePipeline(library, "dn_prepare");
            dnGradientsPso_ = makePipeline(library, "dn_gradients");
            dnBlurPso_ = makePipeline(library, "dn_blur");
            dnAtrousPso_ = makePipeline(library, "dn_atrous");
            dnFinishPso_ = makePipeline(library, "dn_finish");
            displayPso_ = makePipeline(library, "pt_display");
            inFlight_ = dispatch_semaphore_create(kMaxInFlight);
            {
                MTLRenderPipelineDescriptor* desc = [MTLRenderPipelineDescriptor new];
                desc.vertexFunction = [library newFunctionWithName:@"vis_vertex"];
                desc.fragmentFunction = [library newFunctionWithName:@"vis_fragment"];
                desc.colorAttachments[0].pixelFormat = MTLPixelFormatR32Uint;
                desc.depthAttachmentPixelFormat = MTLPixelFormatDepth32Float;
                NSError* rasterError = nil;
                visPso_ = [device_ newRenderPipelineStateWithDescriptor:desc error:&rasterError];
                if (!visPso_) throw Error(std::string("visibility pipeline creation failed: ") + (rasterError ? rasterError.localizedDescription.UTF8String : "unknown error"));
                MTLDepthStencilDescriptor* depth = [MTLDepthStencilDescriptor new];
                depth.depthCompareFunction = MTLCompareFunctionLess;
                depth.depthWriteEnabled = YES;
                visDepthState_ = [device_ newDepthStencilStateWithDescriptor:depth];
                MTLTextureDescriptor* dummy = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR32Uint width:1 height:1 mipmapped:NO];
                dummy.usage = MTLTextureUsageShaderRead;
                dummyVisibility_ = [device_ newTextureWithDescriptor:dummy];
            }
            deviceName_ = device_.name.UTF8String;
            // Bound when a render uses one uniform material; the kernel never reads them then.
            static const uint32_t zero = 0;
            static const MaterialRecord defaultRecord{};
            static const uint64_t noTexture = 0;
            emptyMaterialIds_ = [device_ newBufferWithBytes:&zero length:sizeof(zero) options:MTLResourceStorageModeShared];
            emptyMaterials_ = [device_ newBufferWithBytes:&defaultRecord length:sizeof(defaultRecord) options:MTLResourceStorageModeShared];
            emptyTextures_ = [device_ newBufferWithBytes:&noTexture length:sizeof(noTexture) options:MTLResourceStorageModeShared];
            static const render::lights::LightRecord noLight{};
            static const render::lights::LightNode noNode{};
            emptyLightRecords_ = [device_ newBufferWithBytes:&noLight length:sizeof(noLight) options:MTLResourceStorageModeShared];
            emptyLightNodes_ = [device_ newBufferWithBytes:&noNode length:sizeof(noNode) options:MTLResourceStorageModeShared];
            const std::vector<uint32_t> sobol = sobolDirectionVectors(64);
            sobolDims_ = static_cast<uint32_t>(sobol.size() / 32);
            sobolBuffer_ = [device_ newBufferWithBytes:sobol.data() length:sobol.size() * sizeof(uint32_t) options:MTLResourceStorageModeShared];
        }
    }

    // Sample passes still running hold `this` in their completion handlers.
    ~MetalPathTracer() {
        if (!inFlight_) return;
        for (int k = 0; k < kMaxInFlight; ++k) dispatch_semaphore_wait(inFlight_, DISPATCH_TIME_FOREVER);
        for (int k = 0; k < kMaxInFlight; ++k) dispatch_semaphore_signal(inFlight_);
    }
    MetalPathTracer(const MetalPathTracer&) = delete;
    MetalPathTracer& operator=(const MetalPathTracer&) = delete;

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
            vertexBuffer_ = [device_ newBufferWithBytes:vertices.data() length:vertices.size() * sizeof(float) options:MTLResourceStorageModeShared];
            triangleCount_ = static_cast<uint32_t>(indices.size() / 3);
            boundsMin_ = Vec3(vertices[0], vertices[1], vertices[2]);
            boundsMax_ = boundsMin_;
            for (size_t v = 0; v < vertexCount; ++v) {
                const float* p = vertices.data() + v * floats;
                boundsMin_ = Vec3(std::min(boundsMin_.x, p[0]), std::min(boundsMin_.y, p[1]), std::min(boundsMin_.z, p[2]));
                boundsMax_ = Vec3(std::max(boundsMax_.x, p[0]), std::max(boundsMax_.y, p[1]), std::max(boundsMax_.z, p[2]));
            }
            triMaterials_ = triMaterials;
            Built b = buildAccel(indices, triMaterials);
            indexBuffer_ = b.indices;
            materialIdBuffer_ = b.materials;
            accel_ = b.accel;
            accelerationBuildMs_ = b.buildMs;
            bounceAccel_ = nil;
            lightsDirty_ = true;
        }
    }

    /**
     * A second, coarser triangle list over the same vertices that bounce and shadow rays trace instead
     * of the primary cut. `errorPerDistance` is the cut's screen-space threshold divided by the LOD scale:
     * its surface may sit that far (per unit of distance from the camera) from the primary one, and
     * secondary rays start twice that far out so they do not hit the coarse surface they left.
     */
    void setBounceGeometry(const std::vector<uint32_t>& indices, const std::vector<uint32_t>& triMaterials, float errorPerDistance) {
        if (!vertexBuffer_) throw Error("setGeometry must come before setBounceGeometry");
        if (indices.size() % 3 != 0 || indices.empty()) throw Error("bounce index buffer is not 3 indices per triangle");
        if (triMaterials.size() != indices.size() / 3) throw Error("one material id per bounce triangle is required");
        const uint32_t vertexCount = static_cast<uint32_t>(vertexBuffer_.length / sizeof(Vertex));
        for (uint32_t i : indices) {
            if (i >= vertexCount) throw Error("bounce index past the vertex buffer");
        }
        @autoreleasepool {
            Built b = buildAccel(indices, triMaterials);
            bounceIndexBuffer_ = b.indices;
            bounceMaterialIdBuffer_ = b.materials;
            bounceAccel_ = b.accel;
            bounceBuildMs_ = b.buildMs;
            bounceTriangleCount_ = static_cast<uint32_t>(indices.size() / 3);
            bounceErrorPerDistance_ = std::max(0.0f, errorPerDistance);
            lightsDirty_ = true;
        }
    }

    void clearBounceGeometry() {
        bounceAccel_ = nil;
        lightsDirty_ = true;
    }

    /**
     * The scene's punctual lights (gltf::GltfScene::lights), in the geometry's coordinates. Emissive triangles need
     * no call: they are found in the traced geometry by their materials (setMaterials) when a frame begins.
     */
    void setLights(const std::vector<gltf::SceneLight>& punctual) {
        punctual_ = punctual;
        lightsDirty_ = true;
    }

    /** Off: no light samples, and emission is found by BSDF rays alone (the tracer before its light tree). */
    void setLightSampling(bool enabled) {
        if (enabled != lightSampling_) lightsDirty_ = true;
        lightSampling_ = enabled;
    }
    bool lightSampling() const { return lightSampling_; }

    /** The light set the last frame sampled (built in beginFrame). */
    const render::lights::LightSet& lightSet() const { return lightSet_; }
    /** Whether shadow rays trace the bounce geometry too (default) or stay on the primary cut. */
    void setBounceShadowRays(bool enabled) { bounceShadowRays_ = enabled; }

    /** 0: PCG32 per pixel (the CPU tracer's stream); 1: per-pixel Owen-scrambled Sobol. */
    void setSampler(uint32_t sampler) { sampler_ = sampler; }

    /**
     * ReSTIR for the sky at the first hit: `candidates` cosine-sampled sky directions per pixel per pass are
     * resampled into a reservoir kept across the frame's passes, `spatial` random neighbours (within 16 px,
     * same facing and depth) are merged in between passes, and the chosen direction is shaded with one
     * visibility ray. Sky lighting only (`lighting.sun`); the sun keeps its own shadow ray.
     */
    /**
     * Visibility-guided sky sampling at the first hit: each pixel learns, over the frame's passes, which of 32
     * world-space directions reach the sky, draws one sky sample per hit from that histogram (times the cosine)
     * and combines it with the BSDF ray by the balance heuristic. Unbiased; sky lighting only.
     */
    void setGuidedSky(bool enabled, uint32_t tile = 8, uint32_t bands = 4, uint32_t sectors = 8, uint32_t samples = 1) {
        guided_ = enabled;
        guideSamples_ = std::max<uint32_t>(1, samples);
        guideTile_ = std::max<uint32_t>(1, tile);
        guideBands_ = std::max<uint32_t>(1, bands);
        guideSectors_ = std::max<uint32_t>(1, sectors);
        if (guideBands_ * guideSectors_ > kGuideMaxBins) throw Error("the visibility histogram may have at most 1024 bins");
    }

    /**
     * ReSTIR GI: a path's second hit with the radiance it sends back to the first hit is resampled with
     * `spatial` neighbours' samples of the previous pass (reconnected with the Jacobian, one visibility ray
     * for the choice). Passes stay independent; the choice's visibility is not part of the selection, which
     * is the method's known bias.
     */
    void setRestirGi(bool enabled, uint32_t spatial = 3) {
        restirGi_ = enabled;
        giSpatial_ = spatial;
    }

    void setRestir(bool enabled, uint32_t candidates = 8, uint32_t spatial = 3, bool temporal = true) {
        restir_ = enabled;
        restirTemporal_ = temporal;
        restirCandidates_ = std::max<uint32_t>(1, candidates);
        restirSpatial_ = spatial;
    }

    /**
     * Rasterize the primary cut once per frame into a visibility texture (triangle id per pixel centre);
     * each sample's jittered camera ray then meets that triangle directly and only edge pixels trace.
     */
    void setPrimaryRaster(bool enabled) { primaryRaster_ = enabled; }
    /** GPU time of the visibility pass of the current frame, in ms (counted in frameGpuMs too). */
    double rasterMs() const { return rasterSeconds_ * 1000.0; }

    /**
     * Upscales a display-ready 8-bit RGBA image with MetalFX's spatial scaler (perceptual mode, so the
     * input is the tonemapped frame). upscaleGpuMs() is the scaler's GPU time.
     */
    std::vector<uint8_t> upscaleRgba(const std::vector<uint8_t>& rgba, int width, int height, int outWidth, int outHeight) {
        if (rgba.size() != static_cast<size_t>(width) * height * 4) throw Error("upscale input is not width * height * 4 bytes");
        if (outWidth < width || outHeight < height) throw Error("MetalFX spatial scaling only enlarges");
        @autoreleasepool {
            ensureScaler(width, height, outWidth, outHeight);
            if (!scaleIn_ || scaleIn_.width != static_cast<NSUInteger>(width) || scaleIn_.height != static_cast<NSUInteger>(height)) {
                MTLTextureDescriptor* in = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:static_cast<NSUInteger>(width) height:static_cast<NSUInteger>(height) mipmapped:NO];
                in.usage = MTLTextureUsageShaderRead;
                in.storageMode = MTLStorageModeShared;
                scaleIn_ = [device_ newTextureWithDescriptor:in];
                if (!scaleIn_) throw Error("could not allocate the upscale textures");
            }
            [scaleIn_ replaceRegion:MTLRegionMake2D(0, 0, static_cast<NSUInteger>(width), static_cast<NSUInteger>(height)) mipmapLevel:0 withBytes:rgba.data() bytesPerRow:static_cast<NSUInteger>(width) * 4];
            scaler_.colorTexture = scaleIn_;
            scaler_.outputTexture = scaleOut_;
            id<MTLCommandBuffer> commands = [queue_ commandBuffer];
            [scaler_ encodeToCommandBuffer:commands];
            [commands commit];
            [commands waitUntilCompleted];
            if (commands.error) throw Error(std::string("MetalFX upscale failed: ") + commands.error.localizedDescription.UTF8String);
            upscaleSeconds_ = commands.GPUEndTime - commands.GPUStartTime;
            std::vector<uint8_t> out(static_cast<size_t>(outWidth) * outHeight * 4);
            [scaleOut_ getBytes:out.data() bytesPerRow:static_cast<NSUInteger>(outWidth) * 4 fromRegion:MTLRegionMake2D(0, 0, static_cast<NSUInteger>(outWidth), static_cast<NSUInteger>(outHeight)) mipmapLevel:0];
            return out;
        }
    }

    double upscaleGpuMs() const { return upscaleSeconds_ * 1000.0; }

    /**
     * The current frame as the viewer shows it, display-ready 8-bit RGBA, made on the GPU: the denoised colour
     * (after denoiseGpu) or the accumulated mean, at 2^exposureEv, through the AgX view transform
     * (view::toDisplayImage's), MetalFX-upscaled when out differs from the traced size. One command buffer;
     * only the bytes come back. upscaleGpuMs() is the scaler's share when it ran, else 0.
     */
    std::vector<uint8_t> displayRgba(bool denoised, float exposureEv, int outWidth, int outHeight) {
        if (!framePixels_) throw Error("beginFrame was not called");
        if (denoised && !dnColor_) throw Error("denoiseGpu was not called for this frame");
        drain();
        const int w = frameWidth_, h = frameHeight_;
        if (outWidth < w || outHeight < h) throw Error("the display size is smaller than the traced frame");
        @autoreleasepool {
            if (!displayTex_ || displayTex_.width != static_cast<NSUInteger>(w) || displayTex_.height != static_cast<NSUInteger>(h)) {
                MTLTextureDescriptor* desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:static_cast<NSUInteger>(w) height:static_cast<NSUInteger>(h) mipmapped:NO];
                desc.usage = MTLTextureUsageShaderWrite | MTLTextureUsageShaderRead;
                desc.storageMode = MTLStorageModeShared;
                displayTex_ = [device_ newTextureWithDescriptor:desc];
                if (!displayTex_) throw Error("could not allocate the display texture");
            }
            const bool scale = outWidth != w || outHeight != h;
            if (scale) ensureScaler(w, h, outWidth, outHeight);
            DisplayUniforms d;
            d.width = static_cast<uint32_t>(w);
            d.height = static_cast<uint32_t>(h);
            d.spp = static_cast<uint32_t>(std::max(1, frameSpp_));
            d.fromDenoised = denoised ? 1 : 0;
            d.scale = std::exp2(exposureEv);
            id<MTLCommandBuffer> commands = [queue_ commandBuffer];
            id<MTLComputeCommandEncoder> encoder = [commands computeCommandEncoder];
            [encoder setComputePipelineState:displayPso_];
            [encoder setBuffer:framePixels_ offset:0 atIndex:0];
            [encoder setBuffer:(denoised ? dnColor_ : framePixels_) offset:0 atIndex:1];
            [encoder setBytes:&d length:sizeof(d) atIndex:2];
            [encoder setTexture:displayTex_ atIndex:0];
            [encoder dispatchThreads:MTLSizeMake(static_cast<NSUInteger>(w), static_cast<NSUInteger>(h), 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
            [encoder endEncoding];
            if (scale) {
                scaler_.colorTexture = displayTex_;
                scaler_.outputTexture = scaleOut_;
                [scaler_ encodeToCommandBuffer:commands];
            }
            [commands commit];
            [commands waitUntilCompleted];
            if (commands.error) throw Error(std::string("display pass failed: ") + commands.error.localizedDescription.UTF8String);
            upscaleSeconds_ = scale ? commands.GPUEndTime - commands.GPUStartTime : 0.0;
            id<MTLTexture> src = scale ? scaleOut_ : displayTex_;
            std::vector<uint8_t> out(static_cast<size_t>(outWidth) * outHeight * 4);
            [src getBytes:out.data() bytesPerRow:static_cast<NSUInteger>(outWidth) * 4 fromRegion:MTLRegionMake2D(0, 0, static_cast<NSUInteger>(outWidth), static_cast<NSUInteger>(outHeight)) mipmapLevel:0];
            return out;
        }
    }

    /** The counters a frame reports (rays, NaN samples, geometry coverage), without reading back the image. */
    struct FrameCounters {
        uint64_t rays{0};
        uint64_t nanSamples{0};
        float coverage{0.0f};
    };
    FrameCounters frameCounters() const {
        if (!framePixels_) throw Error("beginFrame was not called");
        drain();
        const size_t n = static_cast<size_t>(frameWidth_) * frameHeight_;
        const PixelState* state = static_cast<const PixelState*>(framePixels_.contents);
        const uint32_t spp = static_cast<uint32_t>(std::max(1, frameSpp_));
        FrameCounters c;
        size_t covered = 0;
        for (size_t i = 0; i < n; ++i) {
            c.rays += state[i].rays;
            c.nanSamples += state[i].nan;
            if (state[i].hits * 2 >= spp) ++covered;
        }
        c.coverage = n ? static_cast<float>(covered) / static_cast<float>(n) : 0.0f;
        return c;
    }

    /** The current frame's scene-linear colour (denoised after denoiseGpu, else the mean), for metering exposure. */
    std::vector<Vec3> frameColor(bool denoised) const {
        if (!framePixels_) throw Error("beginFrame was not called");
        drain();
        const size_t n = static_cast<size_t>(frameWidth_) * frameHeight_;
        std::vector<Vec3> out(n);
        if (denoised && dnColor_) {
            const float* c = static_cast<const float*>(dnColor_.contents);
            for (size_t i = 0; i < n; ++i) out[i] = Vec3(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]);
        } else {
            const PixelState* state = static_cast<const PixelState*>(framePixels_.contents);
            const float inv = 1.0f / static_cast<float>(std::max(1, frameSpp_));
            for (size_t i = 0; i < n; ++i) out[i] = Vec3(state[i].color[0], state[i].color[1], state[i].color[2]) * inv;
        }
        return out;
    }
    uint32_t bounceTriangleCount() const { return bounceAccel_ ? bounceTriangleCount_ : 0; }
    double bounceBuildMs() const { return bounceAccel_ ? bounceBuildMs_ : 0.0; }

    /** Build acceleration structures for a fast build rather than fast traversal (MTLAccelerationStructureUsagePreferFastBuild). */
    void setPreferFastBuild(bool fast) { preferFastBuild_ = fast; }

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
                r.emissiveImage = imageRef(m.emissiveImage);
                r.emissiveWrapS = m.emissiveWrapS;
                r.emissiveWrapT = m.emissiveWrapT;
                records.push_back(r);
            }
            defaultMaterial_ = static_cast<uint32_t>(records.size());
            records.push_back(MaterialRecord{});
            materialCount_ = static_cast<uint32_t>(scene.materials.size());
            materialBuffer_ = [device_ newBufferWithBytes:records.data() length:records.size() * sizeof(MaterialRecord) options:MTLResourceStorageModeShared];
            textureRefBuffer_ = [device_ newBufferWithBytes:refs.data() length:refs.size() * sizeof(uint64_t) options:MTLResourceStorageModeShared];
            if (!materialBuffer_ || !textureRefBuffer_) throw Error("could not allocate the material buffers");
            hasMaterials_ = true;
            sceneMaterials_ = scene.materials;
            // The emissive textures stay on the host too: the light tree reads each emitter's power from them.
            emissiveImages_.assign(scene.images.size(), texture::ImageBuffer{});
            for (const gltf::SceneMaterial& m : scene.materials) {
                const int i = m.emissiveImage;
                if (i >= 0 && i < static_cast<int>(scene.images.size()) && scene.images[static_cast<size_t>(i)].decoded) {
                    emissiveImages_[static_cast<size_t>(i)] = scene.images[static_cast<size_t>(i)].pixels;
                }
            }
            lightsDirty_ = true;
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
        beginFrame(camera, lighting, settings, uniformMaterial);
        const int spp = std::max(1, settings.samplesPerPixel);
        // A few sample passes per command buffer: the GPU watchdog bounds how long one may run.
        for (int s = 0; s < spp; s += 4) samplePasses(std::min(4, spp - s));
        return readback();
    }

    /** Samples accumulated since beginFrame (committed; the last kMaxInFlight passes may still be running). */
    int samplesPerPixel() const { return frameSpp_; }
    /** GPU time of the accumulation since beginFrame, in ms (of the passes that have finished). */
    double frameGpuMs() const {
        std::lock_guard<std::mutex> lock(gpuTimeMutex_);
        return frameGpuSeconds_ * 1000.0;
    }

    /**
     * Starts a progressive frame: allocates the accumulation buffer for the view and seeds every pixel's
     * sample stream. samplePasses adds samples; readback returns the image so far. Same arguments as render.
     */
    void beginFrame(const render::CameraSpec& camera, const Lighting& lighting, const render::RenderSettings& settings,
                    const Material* uniformMaterial) {
        if (!accel_) throw Error("setGeometry was not called");
        if (lighting.mode == Lighting::Mode::Sky && !lighting.sky) throw Error("Sky lighting needs a PhysicalSky");
        drain();
        if (!uniformMaterial && !hasMaterials_) throw Error("setMaterials was not called and no uniform material was given");
        if (!uniformMaterial) {
            for (uint32_t id : triMaterials_) {
                if (id != 0xFFFFFFFFu && id >= materialCount_) throw Error("a triangle names a material the scene does not have");
            }
        }
        const int w = std::max(1, settings.width);
        const int h = std::max(1, settings.height);
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
        frameView_ = ViewBasis{camera.position, forward, right, up, u.tanHalf, u.aspect, w, h};
        historyOutFresh_ = false;
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
        u.useBounceAccel = bounceAccel_ ? 1 : 0;
        u.bounceErrorPerDistance = bounceAccel_ ? bounceErrorPerDistance_ : 0.0f;
        u.bounceShadowRays = bounceShadowRays_ ? 1 : 0;
        u.sampler = sampler_;
        u.usePrimaryRaster = primaryRaster_ ? 1 : 0;
        u.restir = restir_ && lighting.mode == Lighting::Mode::Sky ? (restirTemporal_ ? 1 : 2) : 0;
        u.restirCandidates = restirCandidates_;
        u.restirSpatial = restirSpatial_;
        u.guided = guided_ && lighting.mode == Lighting::Mode::Sky ? 1 : 0;
        u.guideTile = guideTile_;
        u.guideBands = guideBands_;
        u.guideSectors = guideSectors_;
        u.guideSamples = guideSamples_;
        u.restirGi = restirGi_ ? 1 : 0;
        u.giSpatial = giSpatial_;
        ensureLights(!uniformMaterial);
        u.localLights = lightSet_.localCount;
        u.distantLights = lightSet_.distantCount;

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

        @autoreleasepool {
            framePixels_ = [device_ newBufferWithLength:n * sizeof(PixelState) options:MTLResourceStorageModeShared];
            frameUniforms_ = [device_ newBufferWithBytes:&u length:sizeof(Uniforms) options:MTLResourceStorageModeShared];
            frameLut_ = [device_ newBufferWithBytes:lut.data() length:lut.size() * sizeof(float) options:MTLResourceStorageModeShared];
            if (!framePixels_ || !frameUniforms_ || !frameLut_) throw Error("could not allocate render buffers");
            if (u.restir != 0) {
                reservoirA_ = [device_ newBufferWithLength:n * sizeof(Reservoir) options:MTLResourceStorageModePrivate];
                reservoirB_ = [device_ newBufferWithLength:n * sizeof(Reservoir) options:MTLResourceStorageModePrivate];
                surfaces_ = [device_ newBufferWithLength:n * sizeof(PrimarySurface) options:MTLResourceStorageModePrivate];
                surfacesB_ = [device_ newBufferWithLength:n * sizeof(PrimarySurface) options:MTLResourceStorageModePrivate];
                if (!reservoirA_ || !reservoirB_ || !surfaces_ || !surfacesB_) throw Error("could not allocate the ReSTIR buffers");
            } else {
                reservoirA_ = reservoirB_ = surfaces_ = surfacesB_ = nil;
            }
            if (!dummyRestir_) dummyRestir_ = [device_ newBufferWithLength:2 * kGuideMaxBins * sizeof(uint32_t) options:MTLResourceStorageModePrivate];
            frameRestir_ = u.restir != 0;
            frameGuided_ = u.guided != 0;
            frameGi_ = u.restirGi != 0;
            if (frameGi_) {
                giA_ = [device_ newBufferWithLength:n * sizeof(GiSample) options:MTLResourceStorageModePrivate];
                giB_ = [device_ newBufferWithLength:n * sizeof(GiSample) options:MTLResourceStorageModePrivate];
                if (!giA_ || !giB_) throw Error("could not allocate the ReSTIR GI sample buffers");
            } else {
                giA_ = giB_ = nil;
            }
            if (!dummyGi_) dummyGi_ = [device_ newBufferWithLength:sizeof(GiSample) options:MTLResourceStorageModePrivate];
            if (frameGuided_) {
                const size_t tilesX = (static_cast<size_t>(w) + guideTile_ - 1) / guideTile_;
                const size_t tilesY = (static_cast<size_t>(h) + guideTile_ - 1) / guideTile_;
                guideWords_ = static_cast<uint32_t>(tilesX * tilesY * 2 * guideBands_ * guideSectors_);
                guideHistograms_ = [device_ newBufferWithLength:guideWords_ * sizeof(uint32_t) options:MTLResourceStorageModePrivate];
                guidePending_ = [device_ newBufferWithLength:guideWords_ * sizeof(uint32_t) options:MTLResourceStorageModePrivate];
                if (!guideHistograms_ || !guidePending_) throw Error("could not allocate the visibility histograms");
            } else {
                guideHistograms_ = guidePending_ = nil;
            }
            frameUniform_ = uniformMaterial != nullptr;
            frameWidth_ = w;
            frameHeight_ = h;
            frameSpp_ = 0;
            frameGpuSeconds_ = 0.0;
            rasterSeconds_ = 0.0;
            if (primaryRaster_) rasterVisibility();

            id<MTLCommandBuffer> commands = [queue_ commandBuffer];
            id<MTLComputeCommandEncoder> encoder = [commands computeCommandEncoder];
            [encoder setComputePipelineState:initPso_];
            [encoder setBuffer:framePixels_ offset:0 atIndex:0];
            [encoder setBuffer:frameUniforms_ offset:0 atIndex:1];
            [encoder setBuffer:(frameRestir_ ? reservoirA_ : dummyRestir_) offset:0 atIndex:2];
            [encoder setBuffer:(frameRestir_ ? surfaces_ : dummyRestir_) offset:0 atIndex:3];
            [encoder setBuffer:(frameRestir_ ? reservoirB_ : dummyRestir_) offset:0 atIndex:4];
            [encoder setBuffer:(frameRestir_ ? surfacesB_ : dummyRestir_) offset:0 atIndex:5];
            [encoder setBuffer:(frameGuided_ ? guideHistograms_ : dummyRestir_) offset:0 atIndex:6];
            [encoder setBuffer:(frameGuided_ ? guidePending_ : dummyRestir_) offset:0 atIndex:7];
            [encoder setBuffer:(frameGi_ ? giA_ : dummyGi_) offset:0 atIndex:8];
            [encoder setBuffer:(frameGi_ ? giB_ : dummyGi_) offset:0 atIndex:9];
            [encoder dispatchThreads:MTLSizeMake(static_cast<NSUInteger>(w), static_cast<NSUInteger>(h), 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
            [encoder endEncoding];
            submit(commands);
        }
    }

    /**
     * Adds `passes` samples to every pixel of the current frame, in one command buffer. It returns once the
     * buffer is committed: up to kMaxInFlight run on the GPU while the next is encoded, and every read of the
     * frame (readback, denoise, display, counters, the next beginFrame) waits for them first.
     */
    void samplePasses(int passes) {
        if (!framePixels_) throw Error("beginFrame was not called");
        @autoreleasepool {
            id<MTLBuffer> materialIds = frameUniform_ ? emptyMaterialIds_ : materialIdBuffer_;
            id<MTLBuffer> materials = frameUniform_ ? emptyMaterials_ : materialBuffer_;
            id<MTLBuffer> textureRefs = frameUniform_ ? emptyTextures_ : textureRefBuffer_;
            const MTLSize grid = MTLSizeMake(static_cast<NSUInteger>(frameWidth_), static_cast<NSUInteger>(frameHeight_), 1);
            const MTLSize group = MTLSizeMake(8, 8, 1);
            id<MTLCommandBuffer> commands = [queue_ commandBuffer];
            for (int k = 0; k < std::max(1, passes); ++k) {
                id<MTLComputeCommandEncoder> encoder = [commands computeCommandEncoder];
                [encoder setComputePipelineState:samplePso_];
                [encoder setBuffer:framePixels_ offset:0 atIndex:0];
                [encoder setBuffer:frameUniforms_ offset:0 atIndex:1];
                [encoder setBuffer:vertexBuffer_ offset:0 atIndex:2];
                [encoder setBuffer:indexBuffer_ offset:0 atIndex:3];
                [encoder setBuffer:frameLut_ offset:0 atIndex:4];
                [encoder setAccelerationStructure:accel_ atBufferIndex:5];
                [encoder setBuffer:materialIds offset:0 atIndex:6];
                [encoder setBuffer:materials offset:0 atIndex:7];
                [encoder setBuffer:textureRefs offset:0 atIndex:8];
                [encoder setAccelerationStructure:(bounceAccel_ ? bounceAccel_ : accel_) atBufferIndex:9];
                [encoder setBuffer:(bounceAccel_ ? bounceIndexBuffer_ : indexBuffer_) offset:0 atIndex:10];
                [encoder setBuffer:(bounceAccel_ ? bounceMaterialIdBuffer_ : materialIdBuffer_) offset:0 atIndex:11];
                [encoder setTexture:(primaryRaster_ && visibility_ ? visibility_ : dummyVisibility_) atIndex:0];
                const uint32_t pass[4] = {static_cast<uint32_t>(frameSpp_ + k), sobolDims_, 0, 0};
                [encoder setBytes:pass length:sizeof(pass) atIndex:12];
                [encoder setBuffer:sobolBuffer_ offset:0 atIndex:13];
                [encoder setBuffer:(frameRestir_ ? reservoirA_ : dummyRestir_) offset:0 atIndex:14];
                [encoder setBuffer:(frameRestir_ ? surfaces_ : dummyRestir_) offset:0 atIndex:15];
                [encoder setBuffer:(frameRestir_ ? reservoirB_ : dummyRestir_) offset:0 atIndex:16];
                [encoder setBuffer:(frameRestir_ ? surfacesB_ : dummyRestir_) offset:0 atIndex:17];
                [encoder setBuffer:(frameGuided_ ? guideHistograms_ : dummyRestir_) offset:0 atIndex:18];
                [encoder setBuffer:(frameGuided_ ? guidePending_ : dummyRestir_) offset:0 atIndex:19];
                [encoder setBuffer:(frameGi_ ? giA_ : dummyGi_) offset:0 atIndex:20];
                [encoder setBuffer:(frameGi_ ? giB_ : dummyGi_) offset:0 atIndex:21];
                [encoder setBuffer:(lightRecordBuffer_ ? lightRecordBuffer_ : emptyLightRecords_) offset:0 atIndex:22];
                [encoder setBuffer:(lightNodeBuffer_ ? lightNodeBuffer_ : emptyLightNodes_) offset:0 atIndex:23];
                [encoder setBuffer:(triangleLightBuffer_ ? triangleLightBuffer_ : emptyMaterialIds_) offset:0 atIndex:24];
                if (!frameUniform_) {
                    for (id<MTLTexture> texture : textures_) [encoder useResource:texture usage:MTLResourceUsageRead];
                }
                [encoder dispatchThreads:grid threadsPerThreadgroup:group];
                [encoder endEncoding];
                if (frameGi_) std::swap(giA_, giB_); // this pass's samples are the next pass's neighbours
                if (frameGuided_) {
                    id<MTLComputeCommandEncoder> commit = [commands computeCommandEncoder];
                    [commit setComputePipelineState:guideCommitPso_];
                    [commit setBuffer:guideHistograms_ offset:0 atIndex:0];
                    [commit setBuffer:guidePending_ offset:0 atIndex:1];
                    [commit setBytes:&guideWords_ length:sizeof(guideWords_) atIndex:2];
                    [commit dispatchThreads:MTLSizeMake(guideWords_, 1, 1) threadsPerThreadgroup:MTLSizeMake(64, 1, 1)];
                    [commit endEncoding];
                }
                if (frameRestir_ && !restirTemporal_) {
                    // Fresh mode merges neighbours inside the pass from the previous pass's buffers: swap both pairs.
                    std::swap(reservoirA_, reservoirB_);
                    std::swap(surfaces_, surfacesB_);
                } else if (frameRestir_ && restirSpatial_ > 0) {
                    // Neighbours' reservoirs merge into a second buffer, which the next pass reads.
                    id<MTLComputeCommandEncoder> spatial = [commands computeCommandEncoder];
                    [spatial setComputePipelineState:restirSpatialPso_];
                    [spatial setBuffer:reservoirA_ offset:0 atIndex:0];
                    [spatial setBuffer:reservoirB_ offset:0 atIndex:1];
                    [spatial setBuffer:surfaces_ offset:0 atIndex:2];
                    [spatial setBuffer:frameUniforms_ offset:0 atIndex:3];
                    [spatial setBuffer:frameLut_ offset:0 atIndex:4];
                    [spatial setBytes:pass length:sizeof(pass) atIndex:5];
                    [spatial dispatchThreads:grid threadsPerThreadgroup:group];
                    [spatial endEncoding];
                    std::swap(reservoirA_, reservoirB_);
                }
            }
            dispatch_semaphore_wait(inFlight_, DISPATCH_TIME_FOREVER);
            dispatch_semaphore_t inFlight = inFlight_;
            [commands addCompletedHandler:^(id<MTLCommandBuffer> done) {
                {
                    std::lock_guard<std::mutex> lock(gpuTimeMutex_);
                    if (done.error) asyncError_ = std::string("GPU render failed: ") + done.error.localizedDescription.UTF8String;
                    frameGpuSeconds_ += done.GPUEndTime - done.GPUStartTime;
                }
                dispatch_semaphore_signal(inFlight);
            }];
            [commands commit];
            frameSpp_ += std::max(1, passes);
        }
    }

    /** Waits until no sample passes are running; rethrows a failure one of them reported. */
    void drain() const {
        for (int k = 0; k < kMaxInFlight; ++k) dispatch_semaphore_wait(inFlight_, DISPATCH_TIME_FOREVER);
        for (int k = 0; k < kMaxInFlight; ++k) dispatch_semaphore_signal(inFlight_);
        std::lock_guard<std::mutex> lock(gpuTimeMutex_);
        if (!asyncError_.empty()) {
            const std::string message = asyncError_;
            asyncError_.clear();
            throw Error(message);
        }
    }

    /** The current frame's image: the mean of the samples so far, with the guide buffers and counts. */
    render::RenderOutput readback() const {
        if (!framePixels_) throw Error("beginFrame was not called");
        drain();
        const int w = frameWidth_, h = frameHeight_;
        const int spp = std::max(1, frameSpp_);
        const size_t n = static_cast<size_t>(w) * h;
        render::RenderOutput out;
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
        const PixelState* state = static_cast<const PixelState*>(framePixels_.contents);
        const float inv = 1.0f / static_cast<float>(spp);
        size_t covered = 0;
        uint64_t giCandidates = 0;
        for (size_t i = 0; i < n; ++i) {
            const PixelState& p = state[i];
            out.color[i] = Vec3(p.color[0], p.color[1], p.color[2]) * inv;
            const double mean = static_cast<double>(p.lum) / spp;
            out.guides.variance[i] = static_cast<float>(std::max(0.0, static_cast<double>(p.lumSq) / spp - mean * mean) / spp);
            out.rays += p.rays;
            out.nanSamples += p.nan;
            giCandidates += p.pad;
            if (p.hits * 2 >= static_cast<uint32_t>(spp)) {
                out.guides.geometryMask[i] = 1;
                out.guides.albedo[i] = Vec3(p.albedo[0], p.albedo[1], p.albedo[2]) / static_cast<float>(p.hits);
                out.guides.normal[i] = Vec3(p.normal[0], p.normal[1], p.normal[2]).normalized();
                out.guides.depth[i] = p.depth / static_cast<float>(p.hits);
                ++covered;
            }
        }
        out.geometryCoverage = static_cast<float>(covered) / static_cast<float>(n);
        out.renderMs = frameGpuMs();
        giMeanCandidates_ = frameGi_ ? static_cast<double>(giCandidates) / (static_cast<double>(n) * spp) : 0.0;
        return out;
    }

    /** ReSTIR GI: mean samples resampled per first hit (the path's own plus accepted neighbours) over the last readback. */
    double giMeanCandidates() const { return giMeanCandidates_; }

    /**
     * Denoises the current frame on the GPU (the a-trous filter of scratchbox_denoise.hpp) and returns the
     * scene-linear colour. With `temporal`, the previous view's history (commitHistory) is reprojected into
     * this view first and the result is kept for the next commit. denoiseGpuMs() is the filter's GPU time.
     */
    std::vector<Vec3> denoise(const DenoiseOptions& options) {
        denoiseGpu(options);
        const size_t n = static_cast<size_t>(frameWidth_) * frameHeight_;
        std::vector<Vec3> out(n);
        const float* c = static_cast<const float*>(dnColor_.contents);
        for (size_t i = 0; i < n; ++i) out[i] = Vec3(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]);
        return out;
    }

    /** denoise without copying the result out: it stays on the GPU for displayRgba (and frameColor). */
    void denoiseGpu(const DenoiseOptions& options) {
        if (!framePixels_) throw Error("beginFrame was not called");
        drain();
        const int w = frameWidth_, h = frameHeight_;
        const size_t n = static_cast<size_t>(w) * h;
        @autoreleasepool {
            ensureDenoiseBuffers(n);
            DenoiseUniforms u;
            u.width = static_cast<uint32_t>(w);
            u.height = static_cast<uint32_t>(h);
            u.spp = static_cast<uint32_t>(std::max(1, frameSpp_));
            u.sigmaNormal = options.sigmaNormal;
            u.sigmaDepth = options.sigmaDepth;
            u.sigmaLuminance = options.sigmaLuminance;
            u.historyCap = static_cast<uint32_t>(std::max(1, options.historyCap));
            put(u.camPos, frameView_.position);
            put(u.forward, frameView_.forward);
            put(u.right, frameView_.right);
            put(u.up, frameView_.up);
            u.tanHalf = frameView_.tanHalf;
            u.aspect = frameView_.aspect;
            const bool useHistory = options.temporal && historyValid_ && historyBuffer_;
            u.useHistory = useHistory ? 1 : 0;
            if (useHistory) {
                u.prevWidth = static_cast<uint32_t>(historyView_.width);
                u.prevHeight = static_cast<uint32_t>(historyView_.height);
                put(u.prevCamPos, historyView_.position);
                put(u.prevForward, historyView_.forward);
                put(u.prevRight, historyView_.right);
                put(u.prevUp, historyView_.up);
                u.prevTanHalf = historyView_.tanHalf;
                u.prevAspect = historyView_.aspect;
            }
            std::memset(historyHits_.contents, 0, n * sizeof(uint32_t));
            id<MTLBuffer> history = useHistory ? historyBuffer_ : historyOut_;
            const MTLSize grid = MTLSizeMake(static_cast<NSUInteger>(w), static_cast<NSUInteger>(h), 1);
            const MTLSize group = MTLSizeMake(8, 8, 1);
            id<MTLCommandBuffer> commands = [queue_ commandBuffer];
            auto dispatch = [&](id<MTLComputePipelineState> pso, std::vector<id<MTLBuffer>> buffers, const DenoiseUniforms& uniforms) {
                id<MTLComputeCommandEncoder> encoder = [commands computeCommandEncoder];
                [encoder setComputePipelineState:pso];
                for (NSUInteger k = 0; k < buffers.size(); ++k) {
                    if (k == 1) [encoder setBytes:&uniforms length:sizeof(DenoiseUniforms) atIndex:1];
                    else [encoder setBuffer:buffers[k] offset:0 atIndex:k];
                }
                [encoder dispatchThreads:grid threadsPerThreadgroup:group];
                [encoder endEncoding];
            };
            dispatch(dnPreparePso_, {framePixels_, nil, dnA_, history, historyHits_}, u);
            dispatch(dnGradientsPso_, {dnA_, nil}, u);
            id<MTLBuffer> src = dnA_, dst = dnB_;
            for (int iteration = 0; iteration < std::max(0, options.iterations); ++iteration) {
                u.step = 1u << iteration;
                dispatch(dnBlurPso_, {src, nil, dnBlurred_}, u);
                dispatch(dnAtrousPso_, {src, nil, dnBlurred_, dst}, u);
                std::swap(src, dst);
            }
            dispatch(dnFinishPso_, {framePixels_, nil, src, dnColor_, historyOut_}, u);
            [commands commit];
            [commands waitUntilCompleted];
            if (commands.error) throw Error(std::string("GPU denoise failed: ") + commands.error.localizedDescription.UTF8String);
            denoiseGpuSeconds_ = commands.GPUEndTime - commands.GPUStartTime;
            historyOutFresh_ = true;
            historyPixels_ = 0;
            const uint32_t* hits = static_cast<const uint32_t*>(historyHits_.contents);
            for (size_t i = 0; i < n; ++i) historyPixels_ += hits[i];
        }
    }

    /** GPU time of the last denoise, in ms. */
    double denoiseGpuMs() const { return denoiseGpuSeconds_ * 1000.0; }
    /** Pixels of the last denoise that took illumination from the previous view. */
    uint32_t historyPixels() const { return historyPixels_; }

    /** Keeps the last denoised frame as the history the next view reprojects from (needs a denoise of this frame). */
    void commitHistory() {
        if (!historyOutFresh_ || !historyOut_) {
            historyValid_ = false;
            return;
        }
        std::swap(historyBuffer_, historyOut_);
        historyView_ = frameView_;
        historyValid_ = true;
        historyOutFresh_ = false;
    }

    void clearHistory() { historyValid_ = false; }

private:
    /**
     * Builds the light set when the geometry, materials or punctual lights changed, or when a frame switches
     * between scene materials and the uniform one (which emits nothing: then only the punctual lights).
     * Emissive triangles are taken from the geometry bounce rays trace, since that is what their rays find.
     */
    void ensureLights(bool triangles) {
        if (!lightsDirty_ && lightsWithTriangles_ == triangles) return;
        if (!lightSampling_) {
            lightSet_ = render::lights::LightSet{};
            lightRecordBuffer_ = lightNodeBuffer_ = triangleLightBuffer_ = nil;
            lightsDirty_ = false;
            lightsWithTriangles_ = triangles;
            return;
        }
        const bool bounce = bounceAccel_ != nil;
        id<MTLBuffer> indexBuffer = bounce ? bounceIndexBuffer_ : indexBuffer_;
        id<MTLBuffer> materialBuffer = bounce ? bounceMaterialIdBuffer_ : materialIdBuffer_;
        const size_t indexCount = indexBuffer.length / sizeof(uint32_t);
        const uint32_t* idx = static_cast<const uint32_t*>(indexBuffer.contents);
        const std::vector<uint32_t> indices(idx, idx + indexCount);
        const uint32_t* mats = static_cast<const uint32_t*>(materialBuffer.contents);
        const float* verts = static_cast<const float*>(vertexBuffer_.contents);
        constexpr size_t floats = sizeof(Vertex) / sizeof(float);
        // The kernels' triangleEmission: the material's factor times its emissive texture at the interpolated uv.
        auto emittedAt = [&](size_t t, float bu, float bv) {
            const uint32_t id = mats[t];
            if (id >= sceneMaterials_.size()) return Vec3(0, 0, 0);
            const gltf::SceneMaterial& m = sceneMaterials_[id];
            Vec3 e = m.emissiveFactor;
            if (!(render::detail::luminance(e) > 0.0f)) return Vec3(0, 0, 0);
            if (m.emissiveImage >= 0 && m.emissiveImage < static_cast<int>(emissiveImages_.size()) && emissiveImages_[static_cast<size_t>(m.emissiveImage)].width > 0) {
                const float* v0 = verts + static_cast<size_t>(indices[t * 3]) * floats;
                const float* v1 = verts + static_cast<size_t>(indices[t * 3 + 1]) * floats;
                const float* v2 = verts + static_cast<size_t>(indices[t * 3 + 2]) * floats;
                const float bw = 1.0f - bu - bv;
                const math::Vec2 uv(v0[6] * bw + v1[6] * bu + v2[6] * bv, v0[7] * bw + v1[7] * bu + v2[7] * bv);
                e = e * render::detail::sampleTextureLinear(emissiveImages_[static_cast<size_t>(m.emissiveImage)], uv, m.emissiveWrapS, m.emissiveWrapT);
            }
            return e;
        };
        lightSet_ = render::lights::buildLightSet(
            [&](uint32_t i) { const float* p = verts + static_cast<size_t>(i) * floats; return Vec3(p[0], p[1], p[2]); }, indices,
            emittedAt, punctual_, triangles && hasMaterials_);
        @autoreleasepool {
            lightRecordBuffer_ = lightSet_.records.empty() ? nil
                : [device_ newBufferWithBytes:lightSet_.records.data() length:lightSet_.records.size() * sizeof(render::lights::LightRecord) options:MTLResourceStorageModeShared];
            lightNodeBuffer_ = lightSet_.nodes.empty() ? nil
                : [device_ newBufferWithBytes:lightSet_.nodes.data() length:lightSet_.nodes.size() * sizeof(render::lights::LightNode) options:MTLResourceStorageModeShared];
            triangleLightBuffer_ = lightSet_.triangleLight.empty() ? nil
                : [device_ newBufferWithBytes:lightSet_.triangleLight.data() length:lightSet_.triangleLight.size() * sizeof(uint32_t) options:MTLResourceStorageModeShared];
        }
        lightsDirty_ = false;
        lightsWithTriangles_ = triangles;
    }

    void rasterVisibility() {
        const int w = frameWidth_, h = frameHeight_;
        if (!visibility_ || visibility_.width != static_cast<NSUInteger>(w) || visibility_.height != static_cast<NSUInteger>(h)) {
            MTLTextureDescriptor* vis = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR32Uint width:static_cast<NSUInteger>(w) height:static_cast<NSUInteger>(h) mipmapped:NO];
            vis.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
            vis.storageMode = MTLStorageModePrivate;
            visibility_ = [device_ newTextureWithDescriptor:vis];
            MTLTextureDescriptor* depth = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatDepth32Float width:static_cast<NSUInteger>(w) height:static_cast<NSUInteger>(h) mipmapped:NO];
            depth.usage = MTLTextureUsageRenderTarget;
            depth.storageMode = MTLStorageModePrivate;
            visDepth_ = [device_ newTextureWithDescriptor:depth];
            if (!visibility_ || !visDepth_) throw Error("could not allocate the visibility textures");
        }
        RasterUniforms r;
        put(r.camPos, frameView_.position);
        put(r.forward, frameView_.forward);
        put(r.right, frameView_.right);
        put(r.up, frameView_.up);
        r.tanHalf = frameView_.tanHalf;
        r.aspect = frameView_.aspect;
        float farZ = 0.0f;
        for (int corner = 0; corner < 8; ++corner) {
            Vec3 c(corner & 1 ? boundsMax_.x : boundsMin_.x, corner & 2 ? boundsMax_.y : boundsMin_.y, corner & 4 ? boundsMax_.z : boundsMin_.z);
            farZ = std::max(farZ, (c - frameView_.position).dot(frameView_.forward));
        }
        r.far = std::max(farZ * 1.05f, 1.0f);
        r.near = std::max(r.far * 2e-5f, 1e-3f);

        MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor renderPassDescriptor];
        pass.colorAttachments[0].texture = visibility_;
        pass.colorAttachments[0].loadAction = MTLLoadActionClear;
        pass.colorAttachments[0].storeAction = MTLStoreActionStore;
        pass.colorAttachments[0].clearColor = MTLClearColorMake(4294967295.0, 0, 0, 0);
        pass.depthAttachment.texture = visDepth_;
        pass.depthAttachment.loadAction = MTLLoadActionClear;
        pass.depthAttachment.storeAction = MTLStoreActionDontCare;
        pass.depthAttachment.clearDepth = 1.0;
        id<MTLCommandBuffer> commands = [queue_ commandBuffer];
        id<MTLRenderCommandEncoder> encoder = [commands renderCommandEncoderWithDescriptor:pass];
        [encoder setRenderPipelineState:visPso_];
        [encoder setDepthStencilState:visDepthState_];
        [encoder setCullMode:MTLCullModeNone];
        [encoder setVertexBuffer:vertexBuffer_ offset:0 atIndex:0];
        [encoder setVertexBuffer:indexBuffer_ offset:0 atIndex:1];
        [encoder setVertexBytes:&r length:sizeof(r) atIndex:2];
        [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:static_cast<NSUInteger>(triangleCount_) * 3];
        [encoder endEncoding];
        [commands commit];
        [commands waitUntilCompleted];
        if (commands.error) throw Error(std::string("visibility pass failed: ") + commands.error.localizedDescription.UTF8String);
        rasterSeconds_ = commands.GPUEndTime - commands.GPUStartTime;
        std::lock_guard<std::mutex> lock(gpuTimeMutex_);
        frameGpuSeconds_ += rasterSeconds_;
    }

    struct Built {
        id<MTLBuffer> indices;
        id<MTLBuffer> materials;
        id<MTLAccelerationStructure> accel;
        double buildMs{0.0};
    };

    Built buildAccel(const std::vector<uint32_t>& indices, const std::vector<uint32_t>& triMaterials) {
        auto start = std::chrono::steady_clock::now();
        Built b;
        b.indices = [device_ newBufferWithBytes:indices.data() length:indices.size() * sizeof(uint32_t) options:MTLResourceStorageModeShared];
        b.materials = [device_ newBufferWithBytes:triMaterials.data() length:triMaterials.size() * sizeof(uint32_t) options:MTLResourceStorageModeShared];
        MTLAccelerationStructureTriangleGeometryDescriptor* geometry = [MTLAccelerationStructureTriangleGeometryDescriptor descriptor];
        geometry.vertexBuffer = vertexBuffer_;
        geometry.vertexStride = sizeof(Vertex);
        geometry.vertexFormat = MTLAttributeFormatFloat3;
        geometry.indexBuffer = b.indices;
        geometry.indexType = MTLIndexTypeUInt32;
        geometry.triangleCount = static_cast<NSUInteger>(indices.size() / 3);
        geometry.opaque = YES;
        MTLPrimitiveAccelerationStructureDescriptor* descriptor = [MTLPrimitiveAccelerationStructureDescriptor descriptor];
        descriptor.geometryDescriptors = @[geometry];
        descriptor.usage = preferFastBuild_ ? MTLAccelerationStructureUsagePreferFastBuild : MTLAccelerationStructureUsageNone;
        MTLAccelerationStructureSizes sizes = [device_ accelerationStructureSizesWithDescriptor:descriptor];
        b.accel = [device_ newAccelerationStructureWithSize:sizes.accelerationStructureSize];
        id<MTLBuffer> scratch = [device_ newBufferWithLength:sizes.buildScratchBufferSize options:MTLResourceStorageModePrivate];
        if (!b.indices || !b.materials || !b.accel || !scratch) throw Error("could not allocate the acceleration structure");
        id<MTLCommandBuffer> commands = [queue_ commandBuffer];
        id<MTLAccelerationStructureCommandEncoder> encoder = [commands accelerationStructureCommandEncoder];
        [encoder buildAccelerationStructure:b.accel descriptor:descriptor scratchBuffer:scratch scratchBufferOffset:0];
        [encoder endEncoding];
        [commands commit];
        [commands waitUntilCompleted];
        if (commands.error) throw Error(std::string("acceleration structure build failed: ") + commands.error.localizedDescription.UTF8String);
        b.buildMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        return b;
    }

    void ensureDenoiseBuffers(size_t n) {
        if (dnCapacity_ != n || !dnA_) {
            dnA_ = [device_ newBufferWithLength:n * sizeof(DenoisePixel) options:MTLResourceStorageModeShared];
            dnB_ = [device_ newBufferWithLength:n * sizeof(DenoisePixel) options:MTLResourceStorageModeShared];
            dnBlurred_ = [device_ newBufferWithLength:n * sizeof(float) options:MTLResourceStorageModeShared];
            dnColor_ = [device_ newBufferWithLength:n * 3 * sizeof(float) options:MTLResourceStorageModeShared];
            historyHits_ = [device_ newBufferWithLength:n * sizeof(uint32_t) options:MTLResourceStorageModeShared];
            if (!dnA_ || !dnB_ || !dnBlurred_ || !dnColor_ || !historyHits_) throw Error("could not allocate denoise buffers");
            dnCapacity_ = n;
        }
        // commitHistory swaps this with the history buffer, which may be nil or of the previous view's size;
        // the committed history keeps its own size (dn_prepare reprojects by the previous view's dimensions).
        if (!historyOut_ || historyOut_.length != n * sizeof(HistoryPixel)) {
            historyOut_ = [device_ newBufferWithLength:n * sizeof(HistoryPixel) options:MTLResourceStorageModeShared];
            if (!historyOut_) throw Error("could not allocate the history buffer");
        }
    }

    void submit(id<MTLCommandBuffer> commands) {
        [commands commit];
        [commands waitUntilCompleted];
        if (commands.error) throw Error(std::string("GPU render failed: ") + commands.error.localizedDescription.UTF8String);
        std::lock_guard<std::mutex> lock(gpuTimeMutex_);
        frameGpuSeconds_ += commands.GPUEndTime - commands.GPUStartTime;
    }

    /** The MetalFX scaler and its output texture for in -> out (rebuilt when either size changes). */
    void ensureScaler(int width, int height, int outWidth, int outHeight) {
        if (scaler_ && scaler_.inputWidth == static_cast<NSUInteger>(width) && scaler_.inputHeight == static_cast<NSUInteger>(height)
            && scaler_.outputWidth == static_cast<NSUInteger>(outWidth) && scaler_.outputHeight == static_cast<NSUInteger>(outHeight)) return;
        MTLFXSpatialScalerDescriptor* desc = [MTLFXSpatialScalerDescriptor new];
        desc.colorTextureFormat = MTLPixelFormatRGBA8Unorm;
        desc.outputTextureFormat = MTLPixelFormatRGBA8Unorm;
        desc.inputWidth = static_cast<NSUInteger>(width);
        desc.inputHeight = static_cast<NSUInteger>(height);
        desc.outputWidth = static_cast<NSUInteger>(outWidth);
        desc.outputHeight = static_cast<NSUInteger>(outHeight);
        desc.colorProcessingMode = MTLFXSpatialScalerColorProcessingModePerceptual;
        scaler_ = [desc newSpatialScalerWithDevice:device_];
        if (!scaler_) throw Error("MetalFX spatial scaler is not available on this device");
        MTLTextureDescriptor* out = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:desc.outputWidth height:desc.outputHeight mipmapped:NO];
        out.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderWrite | MTLTextureUsageShaderRead;
        out.storageMode = MTLStorageModeShared;
        scaleOut_ = [device_ newTextureWithDescriptor:out];
        if (!scaleOut_) throw Error("could not allocate the upscale textures");
    }

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
    id<MTLComputePipelineState> restirSpatialPso_{nil};
    id<MTLBuffer> reservoirA_{nil};
    id<MTLBuffer> reservoirB_{nil};
    id<MTLBuffer> surfaces_{nil};
    id<MTLBuffer> surfacesB_{nil};
    id<MTLBuffer> dummyRestir_{nil};
    bool frameRestir_{false};
    bool frameGuided_{false};
    bool guided_{false};
    uint32_t guideTile_{8};
    uint32_t guideBands_{4};
    uint32_t guideSectors_{8};
    uint32_t guideSamples_{1};
    uint32_t guideWords_{0};
    bool restirGi_{false};
    bool frameGi_{false};
    mutable double giMeanCandidates_{0.0};
    uint32_t giSpatial_{3};
    id<MTLBuffer> giA_{nil};
    id<MTLBuffer> giB_{nil};
    id<MTLBuffer> dummyGi_{nil};
    id<MTLComputePipelineState> guideCommitPso_{nil};
    id<MTLBuffer> guideHistograms_{nil};
    id<MTLBuffer> guidePending_{nil};
    bool restir_{false};
    bool restirTemporal_{true};
    uint32_t restirCandidates_{8};
    uint32_t restirSpatial_{3};
    id<MTLComputePipelineState> dnPreparePso_{nil};
    id<MTLComputePipelineState> dnGradientsPso_{nil};
    id<MTLComputePipelineState> dnBlurPso_{nil};
    id<MTLComputePipelineState> dnAtrousPso_{nil};
    id<MTLComputePipelineState> dnFinishPso_{nil};
    id<MTLComputePipelineState> displayPso_{nil};
    id<MTLTexture> displayTex_{nil};
    /** Sample command buffers allowed on the GPU at once (encoding the next overlaps running the last). */
    static constexpr int kMaxInFlight = 2;
    dispatch_semaphore_t inFlight_{nullptr};
    mutable std::mutex gpuTimeMutex_;
    mutable std::string asyncError_;
    id<MTLBuffer> dnA_{nil};
    id<MTLBuffer> dnB_{nil};
    id<MTLBuffer> dnBlurred_{nil};
    id<MTLBuffer> dnColor_{nil};
    id<MTLBuffer> historyOut_{nil};
    id<MTLBuffer> historyBuffer_{nil};
    id<MTLBuffer> historyHits_{nil};
    size_t dnCapacity_{0};
    ViewBasis frameView_;
    ViewBasis historyView_;
    bool historyValid_{false};
    bool historyOutFresh_{false};
    double denoiseGpuSeconds_{0.0};
    uint32_t historyPixels_{0};
    id<MTLBuffer> vertexBuffer_{nil};
    id<MTLBuffer> indexBuffer_{nil};
    id<MTLBuffer> materialIdBuffer_{nil};
    id<MTLBuffer> materialBuffer_{nil};
    id<MTLBuffer> textureRefBuffer_{nil};
    id<MTLBuffer> emptyMaterialIds_{nil};
    id<MTLBuffer> emptyMaterials_{nil};
    id<MTLBuffer> emptyTextures_{nil};
    id<MTLAccelerationStructure> accel_{nil};
    id<MTLAccelerationStructure> bounceAccel_{nil};
    id<MTLBuffer> bounceIndexBuffer_{nil};
    id<MTLBuffer> bounceMaterialIdBuffer_{nil};
    uint32_t bounceTriangleCount_{0};
    double bounceBuildMs_{0.0};
    float bounceErrorPerDistance_{0.0f};
    bool bounceShadowRays_{true};
    bool preferFastBuild_{false};
    uint32_t sampler_{0};
    id<MTLBuffer> sobolBuffer_{nil};
    uint32_t sobolDims_{0};
    bool primaryRaster_{false};
    id<MTLRenderPipelineState> visPso_{nil};
    id<MTLDepthStencilState> visDepthState_{nil};
    id<MTLTexture> visibility_{nil};
    id<MTLTexture> visDepth_{nil};
    id<MTLTexture> dummyVisibility_{nil};
    Vec3 boundsMin_, boundsMax_;
    double rasterSeconds_{0.0};
    id<MTLFXSpatialScaler> scaler_{nil};
    id<MTLTexture> scaleIn_{nil};
    id<MTLTexture> scaleOut_{nil};
    double upscaleSeconds_{0.0};
    id<MTLBuffer> framePixels_{nil};
    id<MTLBuffer> frameUniforms_{nil};
    id<MTLBuffer> frameLut_{nil};
    bool frameUniform_{true};
    int frameWidth_{0};
    int frameHeight_{0};
    int frameSpp_{0};
    double frameGpuSeconds_{0.0};
    std::vector<id<MTLTexture>> textures_;
    std::vector<uint32_t> triMaterials_;
    std::string deviceName_;
    double accelerationBuildMs_{0.0};
    uint32_t triangleCount_{0};
    uint32_t materialCount_{0};
    uint32_t defaultMaterial_{0};
    uint64_t textureBytes_{0};
    bool hasMaterials_{false};
    std::vector<gltf::SceneMaterial> sceneMaterials_;
    std::vector<texture::ImageBuffer> emissiveImages_;
    std::vector<gltf::SceneLight> punctual_;
    render::lights::LightSet lightSet_;
    bool lightsDirty_{true};
    bool lightSampling_{true};
    bool lightsWithTriangles_{false};
    id<MTLBuffer> lightRecordBuffer_{nil};
    id<MTLBuffer> lightNodeBuffer_{nil};
    id<MTLBuffer> triangleLightBuffer_{nil};
    id<MTLBuffer> emptyLightRecords_{nil};
    id<MTLBuffer> emptyLightNodes_{nil};
};

} // namespace metalpt
} // namespace scratchbox

#endif // SCRATCHBOX_METAL_PATHTRACER_HPP
