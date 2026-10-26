/********************************************************************************
 * Scratchbox Coursed Surface Texture Synthesizer
 *
 * One continuous generator for any surface laid in courses of units separated by
 * joints, parameterised in real-world metres: unit size, joint width and depth, bond
 * offset between courses, per-unit colour and roughness variance, face relief, edge
 * wear and joint grime. Points in this space cover laid masonry of any unit size,
 * overlapping roof courses, tiled cladding and (with jointWidthM = 0) continuous
 * renders and plasters, without a closed list of material kinds.
 *
 * The tile holds a whole number of units per course and a whole number of courses,
 * chosen so the bond offset also repeats, and all noise is periodic over the tile,
 * so the maps wrap seamlessly. Normals come from the height field scaled by the
 * physical joint depth and pixel size (glTF convention: +X right, +Y up the image).
 ********************************************************************************/

#ifndef SCRATCHBOX_COURSED_SURFACE_HPP
#define SCRATCHBOX_COURSED_SURFACE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_texture.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <cstdint>

namespace scratchbox {
namespace pbr_texture {

using math::Vec3;
using texture::ImageBuffer;

struct CoursedSurfaceParams {
    float unitWidthM{0.215f};          // unit length along the course (metres); <= 0 means no units
    float unitHeightM{0.065f};         // unit height across courses (metres)
    float jointWidthM{0.010f};         // joint gap between units (metres); 0 = continuous surface
    float jointDepthM{0.006f};         // how far joints sit behind the unit face (metres)
    float bondOffset{0.5f};            // shift of each course, as a fraction of a unit (0..1)
    float targetTileM{1.2f};           // approximate tile edge; snapped to whole units and courses

    Vec3 unitColor{0.62f, 0.38f, 0.30f};   // mean unit colour (sRGB, 0..1)
    float unitColorVariance{0.10f};        // per-unit brightness spread
    float unitHueVariance{0.04f};          // per-unit chroma spread
    Vec3 jointColor{0.70f, 0.68f, 0.64f};  // joint colour (sRGB, 0..1)

    float unitRoughness{0.82f};
    float jointRoughness{0.92f};
    float roughnessVariance{0.06f};
    float metallic{0.0f};

    float faceReliefM{0.0015f};        // undulation of unit faces (metres)
    float grain{0.35f};                // fine surface grain, 0..1
    float edgeWear{0.35f};             // rounding / chipping of unit edges, 0..1
    float grime{0.25f};                // darkening gathered in joints and low spots, 0..1
    float streaking{0.15f};            // vertical weathering streaks, 0..1

    int pixelsPerMetre{512};
    int maxResolution{1024};
    uint32_t seed{7};
};

struct CoursedSurfaceTextures {
    ImageBuffer albedo;   // RGB, sRGB
    ImageBuffer normal;   // RGB tangent-space normal
    ImageBuffer orm;      // R occlusion, G roughness, B metallic
    float tileWidthM{1.0f};
    float tileHeightM{1.0f};
};

namespace coursed_detail {

inline uint32_t hash3(int x, int y, uint32_t seed) {
    uint32_t h = static_cast<uint32_t>(x) * 0x8da6b343u ^ static_cast<uint32_t>(y) * 0xd8163841u ^ seed * 0xcb1ab31fu;
    h ^= h >> 13; h *= 0x5bd1e995u; h ^= h >> 15;
    return h;
}

inline float hashUnit(int x, int y, uint32_t seed) {
    return static_cast<float>(hash3(x, y, seed) & 0xffffffu) / static_cast<float>(0xffffff);
}

inline int wrapIndex(int i, int period) {
    int m = i % period;
    return m < 0 ? m + period : m;
}

// Periodic value noise on a periodX x periodY lattice over the unit square.
inline float periodicNoise(float u, float v, int periodX, int periodY, uint32_t seed) {
    float x = u * periodX, y = v * periodY;
    int x0 = static_cast<int>(std::floor(x)), y0 = static_cast<int>(std::floor(y));
    float fx = x - x0, fy = y - y0;
    fx = fx * fx * (3.0f - 2.0f * fx);
    fy = fy * fy * (3.0f - 2.0f * fy);
    auto at = [&](int ix, int iy) { return hashUnit(wrapIndex(ix, periodX), wrapIndex(iy, periodY), seed) * 2.0f - 1.0f; };
    float a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

inline float periodicFbm(float u, float v, int baseX, int baseY, int octaves, uint32_t seed) {
    float sum = 0.0f, amp = 0.5f, norm = 0.0f;
    int px = std::max(1, baseX), py = std::max(1, baseY);
    for (int o = 0; o < octaves; ++o) {
        sum += amp * periodicNoise(u, v, px, py, seed + static_cast<uint32_t>(o) * 131u);
        norm += amp;
        amp *= 0.5f; px *= 2; py *= 2;
    }
    return sum / std::max(1e-6f, norm);
}

inline float smoothstep(float e0, float e1, float x) {
    float t = std::clamp((x - e0) / std::max(1e-6f, e1 - e0), 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}

} // namespace coursed_detail

inline CoursedSurfaceTextures synthesizeCoursedSurface(const CoursedSurfaceParams& p) {
    using namespace coursed_detail;
    CoursedSurfaceTextures out;

    const bool hasUnits = p.unitWidthM > 1e-4f && p.unitHeightM > 1e-4f && p.jointWidthM > 1e-5f;
    const float pitchU = hasUnits ? p.unitWidthM + p.jointWidthM : 1.0f;
    const float pitchV = hasUnits ? p.unitHeightM + p.jointWidthM : 1.0f;

    int unitsPerCourse = 1, courses = 1;
    if (hasUnits) {
        unitsPerCourse = std::max(1, static_cast<int>(std::lround(p.targetTileM / pitchU)));
        int target = std::max(1, static_cast<int>(std::lround(p.targetTileM / pitchV)));
        float bond = p.bondOffset - std::floor(p.bondOffset);
        courses = target;
        for (int n = target; n < target + 64; ++n) {
            float shift = bond * n;
            if (std::abs(shift - std::round(shift)) < 1e-3f) { courses = n; break; }
        }
        out.tileWidthM = unitsPerCourse * pitchU;
        out.tileHeightM = courses * pitchV;
    } else {
        out.tileWidthM = out.tileHeightM = std::max(0.25f, p.targetTileM);
    }

    const int w = std::clamp(static_cast<int>(out.tileWidthM * p.pixelsPerMetre), 64, p.maxResolution);
    const int h = std::clamp(static_cast<int>(out.tileHeightM * p.pixelsPerMetre), 64, p.maxResolution);
    const float pxU = out.tileWidthM / w, pxV = out.tileHeightM / h;
    const float totalDepth = std::max(1e-5f, p.jointDepthM + p.faceReliefM);

    std::vector<float> height(static_cast<size_t>(w) * h);
    std::vector<float> jointMask(height.size());
    std::vector<Vec3> color(height.size());
    std::vector<float> rough(height.size());

    const int noiseX = std::max(2, static_cast<int>(std::lround(out.tileWidthM * 4.0f)));
    const int noiseY = std::max(2, static_cast<int>(std::lround(out.tileHeightM * 4.0f)));

    for (int y = 0; y < h; ++y) {
        // Image row 0 is the top of the tile; metres increase upwards.
        float vM = (h - 0.5f - y) * pxV;
        float vN = vM / out.tileHeightM;
        for (int x = 0; x < w; ++x) {
            float uM = (x + 0.5f) * pxU;
            float uN = uM / out.tileWidthM;

            float joint = 0.0f;
            int unitX = 0, unitY = 0;
            if (hasUnits) {
                unitY = static_cast<int>(std::floor(vM / pitchV));
                float inCourseV = vM - unitY * pitchV;
                float shiftM = (p.bondOffset - std::floor(p.bondOffset)) * pitchU * wrapIndex(unitY, courses);
                float uShifted = uM + shiftM;
                unitX = static_cast<int>(std::floor(uShifted / pitchU));
                float inUnitU = uShifted - unitX * pitchU;
                unitX = wrapIndex(unitX, unitsPerCourse);
                unitY = wrapIndex(unitY, courses);

                // Distance (metres) from this point to the nearest unit edge; negative inside the joint.
                float halfJ = p.jointWidthM * 0.5f;
                float du = std::min(inUnitU - halfJ, pitchU - halfJ - inUnitU);
                float dv = std::min(inCourseV - halfJ, pitchV - halfJ - inCourseV);
                float edge = std::min(du, dv);
                float wear = p.edgeWear * (0.5f + 0.5f * periodicFbm(uN, vN, noiseX * 8, noiseY * 8, 3, p.seed + 11));
                float bevel = std::max(pxU, p.jointWidthM * (0.15f + 0.85f * wear));
                joint = 1.0f - smoothstep(-0.5f * pxU, bevel, edge);
            }

            float unitRand = hasUnits ? hashUnit(unitX, unitY, p.seed) : 0.5f;
            float unitRand2 = hasUnits ? hashUnit(unitX, unitY, p.seed + 1) : 0.5f;
            float unitRand3 = hasUnits ? hashUnit(unitX, unitY, p.seed + 2) : 0.5f;

            float macro = periodicFbm(uN, vN, noiseX, noiseY, 4, p.seed + 3);
            float fine = periodicFbm(uN, vN, noiseX * 16, noiseY * 16, 3, p.seed + 5);
            float face = p.faceReliefM * (0.5f + 0.5f * macro) + p.faceReliefM * 0.5f * p.grain * fine;
            float hM = (1.0f - joint) * (p.jointDepthM + face) + joint * (0.3f * p.faceReliefM * fine);
            size_t i = static_cast<size_t>(y) * w + x;
            height[i] = std::clamp(hM / totalDepth, 0.0f, 1.0f);
            jointMask[i] = joint;

            float bright = 1.0f + p.unitColorVariance * (unitRand * 2.0f - 1.0f) + 0.06f * macro + 0.05f * p.grain * fine;
            Vec3 hue((unitRand2 - 0.5f) * p.unitHueVariance, 0.0f, (unitRand3 - 0.5f) * p.unitHueVariance);
            Vec3 unitCol = (p.unitColor + hue) * bright;
            Vec3 jointCol = p.jointColor * (1.0f + 0.08f * fine);
            Vec3 col = unitCol * (1.0f - joint) + jointCol * joint;

            float streak = periodicFbm(uN, 0.0f, noiseX * 6, 1, 3, p.seed + 7) * 0.5f + 0.5f;
            float streakDark = 1.0f - p.streaking * 0.25f * smoothstep(0.55f, 0.9f, streak);
            col = col * streakDark;
            color[i] = col;

            float r = p.unitRoughness * (1.0f - joint) + p.jointRoughness * joint;
            r += p.roughnessVariance * ((unitRand3 - 0.5f) * 2.0f + 0.5f * fine);
            rough[i] = std::clamp(r, 0.04f, 1.0f);
        }
    }

    out.albedo = ImageBuffer(w, h, 3);
    out.normal = ImageBuffer(w, h, 3);
    out.orm = ImageBuffer(w, h, 3);
    auto H = [&](int x, int y) { return height[static_cast<size_t>(wrapIndex(y, h)) * w + wrapIndex(x, w)]; };

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            size_t i = static_cast<size_t>(y) * w + x;
            // Slopes in metres per metre: height spans totalDepth, pixels span pxU / pxV.
            float dhdx = (H(x + 1, y) - H(x - 1, y)) * totalDepth / (2.0f * pxU);
            float dhdUp = (H(x, y - 1) - H(x, y + 1)) * totalDepth / (2.0f * pxV);
            Vec3 n = Vec3(-dhdx, -dhdUp, 1.0f).normalized();
            out.normal.setPixelRGB(x, y, Vec3(n.x * 0.5f + 0.5f, n.y * 0.5f + 0.5f, n.z * 0.5f + 0.5f));

            // Cavity occlusion: how far this point sits below its neighbourhood.
            float around = 0.0f;
            const int rad = std::max(1, static_cast<int>(std::lround(p.jointWidthM / pxU)));
            for (int k = -1; k <= 1; k += 2) around += H(x + k * rad, y) + H(x, y + k * rad);
            float cavity = std::clamp(around * 0.25f - height[i], 0.0f, 1.0f);
            float ao = std::clamp(1.0f - cavity * 2.5f - 0.35f * jointMask[i] * (p.jointDepthM / totalDepth), 0.15f, 1.0f);

            float grime = 1.0f - p.grime * (0.55f * jointMask[i] + 0.45f * (1.0f - height[i]));
            out.albedo.setPixelRGB(x, y, color[i] * std::clamp(grime, 0.0f, 1.0f));
            out.orm.setPixelRGB(x, y, Vec3(ao, rough[i], std::clamp(p.metallic, 0.0f, 1.0f)));
        }
    }
    return out;
}

} // namespace pbr_texture
} // namespace scratchbox

#endif // SCRATCHBOX_COURSED_SURFACE_HPP
