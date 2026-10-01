#include <iostream>
#include <vector>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <algorithm>
#include <string>
#include <thread>

// Ultra-Fine Master-Class Roman Travertine PBR Detail Map Synthesizer (4096x4096)
// Calibrated Physical Metric Scale: 1.0 UV unit = 1.0 meter (4096 px/m = 0.244 mm/px)
// Outputs 4-channel RGBA:
// R, G, B: Tangent-space normal vector [0..255] (Nx * 0.5 + 0.5, Ny * 0.5 + 0.5, Nz * 0.5 + 0.5)
// A: Metric surface height / cavitation depth [0..255] (0 = deep vacuole, 185 = honed stone plateau, 255 = calcite crystal facet)

struct Vec3 {
    float x, y, z;
    Vec3() : x(0), y(0), z(0) {}
    Vec3(float x_, float y_, float z_) : x(x_), y(y_), z(z_) {}
    Vec3 operator+(const Vec3& o) const { return Vec3(x + o.x, y + o.y, z + o.z); }
    Vec3 operator-(const Vec3& o) const { return Vec3(x - o.x, y - o.y, z - o.z); }
    Vec3 operator*(float s) const { return Vec3(x * s, y * s, z * s); }
    float length() const { return std::sqrt(x * x + y * y + z * z); }
    Vec3 normalize() const {
        float l = length();
        return l > 1e-6f ? Vec3(x / l, y / l, z / l) : Vec3(0, 0, 1);
    }
};

static inline float hash2(int ix, int iy, int seed) {
    uint32_t h = static_cast<uint32_t>(ix * 374761393 + iy * 668265263 + seed * 2147483647);
    h = (h ^ (h >> 13)) * 1274126177u;
    return static_cast<float>((h ^ (h >> 16))) / 4294967295.0f;
}

static inline float periodicValueNoise(float x, float y, float period, int seed) {
    int ix = static_cast<int>(std::floor(x));
    int iy = static_cast<int>(std::floor(y));
    float fx = x - ix;
    float fy = y - iy;
    float ux = fx * fx * (3.0f - 2.0f * fx);
    float uy = fy * fy * (3.0f - 2.0f * fy);

    int p = static_cast<int>(period);
    int x0 = ((ix % p) + p) % p;
    int y0 = ((iy % p) + p) % p;
    int x1 = ((ix + 1) % p + p) % p;
    int y1 = ((iy + 1) % p + p) % p;

    float a = hash2(x0, y0, seed);
    float b = hash2(x1, y0, seed);
    float c = hash2(x0, y1, seed);
    float d = hash2(x1, y1, seed);

    return (a * (1.0f - ux) + b * ux) * (1.0f - uy) + (c * (1.0f - ux) + d * ux) * uy;
}

static inline float periodicFbm(float x, float y, float basePeriod, int octaves, int seed) {
    float sum = 0.0f;
    float amp = 0.5f;
    float norm = 0.0f;
    for (int o = 0; o < octaves; ++o) {
        float f = static_cast<float>(1 << o);
        sum += amp * periodicValueNoise(x * f, y * f, basePeriod * f, seed + o * 19);
        norm += amp;
        amp *= 0.5f;
    }
    return sum / norm;
}

struct VacuoleSample {
    float cavity;
    float lip;
};

// Organic travertine vacuole evaluation with raised mineral calcite lip
// Evaluates true geological cavitation voids with irregular ragged contours and varied sizes
static inline VacuoleSample sampleTravertineVacuoles(float u, float v, float wx, float wy, int period, float probability, float baseRadius, int seed) {
    float x = u * static_cast<float>(period);
    float y = v * static_cast<float>(period);
    int ix = static_cast<int>(std::floor(x));
    int iy = static_cast<int>(std::floor(y));

    float maxCavity = 0.0f;
    float maxLip = 0.0f;

    for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
            int cx = ix + dx;
            int cy = iy + dy;
            int px = ((cx % period) + period) % period;
            int py = ((cy % period) + period) % period;

            float spawnRoll = hash2(px, py, seed + 307);
            if (spawnRoll > probability) continue;

            float jx = hash2(px, py, seed + 409);
            float jy = hash2(px, py, seed + 521);

            float rVar = 0.55f + 0.45f * hash2(px, py, seed + 631);
            float radius = baseRadius * rVar;
            float depth = 0.55f + 0.45f * hash2(px, py, seed + 743);

            float vx = (x + wx) - (cx + jx);
            float vy = (y + wy) - (cy + jy);
            
            // Subtle horizontal geological elongation (aspect ratio 1.3:1)
            vy *= 1.30f;

            float dist = std::sqrt(vx * vx + vy * vy);
            if (dist < radius) {
                float normD = dist / radius;
                // Steep-sided cliff-like rim with flat porous floor
                float rim = 1.0f - normD * normD;
                float cavity = (1.0f - normD * normD * normD) * depth;
                if (cavity > maxCavity) maxCavity = cavity;
            } else if (dist < radius * 1.45f) {
                // Raised mineralized calcite ridge/crust encircling the cavity
                float lipNorm = (dist - radius) / (radius * 0.45f);
                float lip = std::sin(lipNorm * 3.14159265f) * 0.22f * depth;
                if (lip > maxLip) maxLip = lip;
            }
        }
    }
    return { maxCavity, maxLip };
}

// Evaluates authentic Roman Travertine height field at normalized UV [0..1]
static inline float sampleTravertineHeight(float u, float v) {
    // 1. Sedimentary Flow & Bedding (gentle horizontal thermal spring deposition)
    float bedWarp = (periodicFbm(u * 8.0f, v * 8.0f, 8.0f, 3, 11) - 0.5f) * 0.04f;
    float bedding = std::sin((v + bedWarp) * 6.2831853f * 16.0f) * 0.02f;

    // 2. Honed Stone Surface Micro-Topography (broad 25cm planar variations from saw cutting)
    float planarWarp = (periodicFbm(u * 4.0f, v * 4.0f, 4.0f, 4, 37) - 0.5f) * 0.04f;

    // 3. High-Frequency Crystalline Calcite Tooth across 100% of the honed stone surface
    // Multi-octave continuous crystalline grit from 64 to 4096 (resolving every single texel!)
    float tooth1 = periodicFbm(u * 64.0f,   v * 64.0f,   64.0f,   3, 107) * 0.040f;
    float tooth2 = periodicFbm(u * 192.0f,  v * 192.0f,  192.0f,  3, 211) * 0.032f;
    float tooth3 = periodicFbm(u * 512.0f,  v * 512.0f,  512.0f,  3, 317) * 0.026f;
    float tooth4 = periodicFbm(u * 1280.0f, v * 1280.0f, 1280.0f, 2, 421) * 0.020f;
    float tooth5 = periodicValueNoise(u * 2800.0f, v * 2800.0f, 2800.0f, 523) * 0.015f;
    float tooth6 = periodicValueNoise(u * 4096.0f, v * 4096.0f, 4096.0f, 631) * 0.012f;
    float toothSum = tooth1 + tooth2 + tooth3 + tooth4 + tooth5 + tooth6;

    // High frequency fractal domain warp for ragged, organic cavity contours (computed once per pixel!)
    float warpAmp = 0.38f;
    float wx = (periodicFbm(u * 64.0f, v * 64.0f, 64.0f, 2, 101) - 0.5f) * warpAmp;
    float wy = (periodicFbm((u + 0.37f) * 64.0f, (v + 0.59f) * 64.0f, 64.0f, 2, 203) - 0.5f) * warpAmp;

    // 4. Multi-Scale Travertine Cavitation Pores (clustered in thermal deposit strata)
    float bandNoise = periodicFbm(u * 4.0f, v * 12.0f, 4.0f, 3, 401);
    float porosityBand = std::clamp((bandNoise - 0.25f) / 0.35f, 0.0f, 1.0f);

    // Tier 1: Macro Chasm Vacuoles (15mm - 35mm voids): period 14, 28% density in bands
    auto v1 = sampleTravertineVacuoles(u, v, wx, wy, 14, 0.28f * porosityBand, 0.45f, 503);
    
    // Tier 2: Meso Pockets (6mm - 16mm voids): period 36, 38% density in bands
    auto v2 = sampleTravertineVacuoles(u, v, wx, wy, 36, 0.38f * (0.3f + 0.7f * porosityBand), 0.42f, 613);
    
    // Tier 3: Micro Pinholes (2mm - 5mm pores): period 96, 48% density throughout
    auto v3 = sampleTravertineVacuoles(u, v, wx, wy, 96, 0.48f, 0.38f, 727);
    
    // Tier 4: Fine Pores (0.8mm - 2mm pits): period 240, 58% density throughout
    auto v4 = sampleTravertineVacuoles(u, v, wx, wy, 240, 0.58f, 0.34f, 839);
    
    // Tier 5: Sub-millimeter Micropores (0.3mm - 0.8mm): period 600, 68% density throughout
    auto v5 = sampleTravertineVacuoles(u, v, wx, wy, 600, 0.68f, 0.30f, 953);

    // Sum of cavities and raised mineral lips
    float totalCavity = v1.cavity * 0.50f + v2.cavity * 0.38f + v3.cavity * 0.26f + v4.cavity * 0.18f + v5.cavity * 0.12f;
    float totalLip = v1.lip * 0.45f + v2.lip * 0.35f + v3.lip * 0.25f + v4.lip * 0.18f + v5.lip * 0.10f;

    // 5. Combine into calibrated stone surface
    // Base plateau at ~0.66 (clean honed stone face)
    // Cavities dip down into shadowed recesses [0.10 .. 0.55]
    // Calcite lips & tooth rise up into sparkling crystal highlights [0.72 .. 0.95]
    float h = 0.66f 
            + bedding 
            + planarWarp 
            + toothSum 
            + totalLip 
            - totalCavity;

    return std::clamp(h, 0.05f, 0.98f);
}

int main(int argc, char** argv) {
    int size = 4096;
    if (argc > 1) {
        size = std::atoi(argv[1]);
        if (size <= 0) size = 4096;
    }

    std::string outBin = "/tmp/travertine_detail_raw.bin";
    if (argc > 2) {
        outBin = argv[2];
    }

    std::cout << "Synthesizing ultra-fine master Roman Travertine Detail Map (" << size << "x" << size << ")...\n";

    unsigned int numThreads = std::max(1u, std::thread::hardware_concurrency());
    std::cout << "Running multithreaded across " << numThreads << " worker threads...\n";

    // Step 1: Evaluate height field in parallel
    std::vector<float> height(size * size);
    std::vector<std::thread> workers;
    for (unsigned int t = 0; t < numThreads; ++t) {
        int yStart = (size * t) / numThreads;
        int yEnd = (size * (t + 1)) / numThreads;
        workers.emplace_back([&, yStart, yEnd]() {
            for (int y = yStart; y < yEnd; ++y) {
                float v = static_cast<float>(y) / static_cast<float>(size);
                for (int x = 0; x < size; ++x) {
                    float u = static_cast<float>(x) / static_cast<float>(size);
                    height[y * size + x] = sampleTravertineHeight(u, v);
                }
            }
        });
    }
    for (auto& w : workers) w.join();
    workers.clear();

    float minH = 1e9f, maxH = -1e9f;
    double sumH = 0.0;
    for (float val : height) {
        if (val < minH) minH = val;
        if (val > maxH) maxH = val;
        sumH += val;
    }

    std::cout << "Height field computed: min=" << minH << " max=" << maxH << " mean=" << (sumH / height.size()) << "\n";
    std::cout << "Computing 3x3 Scharr Tangent-Space Normals & Cavity Relief with seamless periodic wrapping...\n";

    // Step 2: Compute tangent-space normals via Scharr 3x3 filter
    std::vector<uint8_t> rgba(size * size * 4);
    // Calibrated tangent normal strength: 5.2 gives crisp, tactile relief under raking sunlight without harsh black clamp
    float normalStrength = 5.2f;

    auto sampleH = [&](int px, int py) -> float {
        int wrappedX = ((px % size) + size) % size;
        int wrappedY = ((py % size) + size) % size;
        return height[wrappedY * size + wrappedX];
    };

    for (unsigned int t = 0; t < numThreads; ++t) {
        int yStart = (size * t) / numThreads;
        int yEnd = (size * (t + 1)) / numThreads;
        workers.emplace_back([&, yStart, yEnd]() {
            for (int y = yStart; y < yEnd; ++y) {
                for (int x = 0; x < size; ++x) {
                    // Scharr 3x3 filter kernel for isotropic gradient
                    float dx = 3.0f * (sampleH(x + 1, y - 1) - sampleH(x - 1, y - 1))
                             + 10.0f * (sampleH(x + 1, y)     - sampleH(x - 1, y))
                             + 3.0f * (sampleH(x + 1, y + 1) - sampleH(x - 1, y + 1));
                    dx /= 32.0f;

                    float dy = 3.0f * (sampleH(x - 1, y + 1) - sampleH(x - 1, y - 1))
                             + 10.0f * (sampleH(x,     y + 1) - sampleH(x,     y - 1))
                             + 3.0f * (sampleH(x + 1, y + 1) - sampleH(x + 1, y - 1));
                    dy /= 32.0f;

                    Vec3 norm(-dx * normalStrength, -dy * normalStrength, 1.0f);
                    norm = norm.normalize();

                    float hVal = sampleH(x, y);

                    int idx = (y * size + x) * 4;
                    rgba[idx + 0] = static_cast<uint8_t>(std::clamp((norm.x * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
                    rgba[idx + 1] = static_cast<uint8_t>(std::clamp((norm.y * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
                    rgba[idx + 2] = static_cast<uint8_t>(std::clamp((norm.z * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
                    rgba[idx + 3] = static_cast<uint8_t>(std::clamp(hVal * 255.0f, 0.0f, 255.0f));
                }
            }
        });
    }
    for (auto& w : workers) w.join();

    std::ofstream out(outBin, std::ios::binary);
    if (!out) {
        std::cerr << "Failed to open " << outBin << " for writing\n";
        return 1;
    }
    out.write(reinterpret_cast<const char*>(rgba.data()), rgba.size());
    out.close();

    std::cout << "Wrote raw RGBA (" << (rgba.size() / 1024 / 1024) << " MB) to " << outBin << "\n";
    return 0;
}
