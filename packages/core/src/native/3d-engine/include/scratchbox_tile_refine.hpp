/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_TILE_REFINE_HPP
#define SCRATCHBOX_TILE_REFINE_HPP

/**
 * Tile refine: one native pass from a raw photogrammetric tile (GLB, y = up, metric) to a better-defined
 * object, in one process and without intermediate files:
 *
 *   1. load       GlbSceneReader (per-triangle material, original encoded image bytes).
 *   1b. isolate   (optional) keep only the structure under the anchor plus a ground apron: the connected DSM footprint
 *                 nearest the anchor with its enclosed courtyards, every triangle above it (no height cap), closed over
 *                 mesh connectivity through raised triangles (attached neighbours come along rather than being cut);
 *                 it ends where the footprint meets open ground. The scene is compacted to that subset (vertices,
 *                 materials, and only the images those materials use), so every later stage runs on it alone.
 *   2. visibility rasterized triangle-ID buffers (multithreaded software z-buffer) from aerial rings, a nadir
 *                 orthographic view, and street-level / open-roof eyes sampled on open ground from a DSM/DTM of the
 *                 scan itself, then a targeted pass: walls still unseen that face open ground along their normal (narrow
 *                 streets the spread eyes cannot see into) get one wide view from that ground. A triangle seen in any
 *                 view, under either the two-sided rule (back faces occlude) or
 *                 the single-sided rule (back faces are transparent and invisible), is kept. Triangles too small to
 *                 cover a pixel centre are tested exactly: sample points on them are checked against the front-most
 *                 triangles of the surrounding pixels by ray intersection.
 *   3. rectify    ScanRectifier (plane / line / point snapping, tiers, seams, guards) fed with that visibility.
 *   4. relief     PhotometricRelief on facades inside a region of interest (default: the footprint under the
 *                 anchor grown by roiRadius), |dh| <= maxDepth, UVs kept on the original photos.
 *   5. write      textured GLB (one primitive per material, original image bytes) and studio-clay GLB.
 *   6. checks     per-stage timings, triangle counts, displacement, flips, open edges (crack proxy), plane RMS,
 *                 relief depth statistics; optional thumbnails (aerial, hero facade, street level; unlit "baked"
 *                 textured and shadowed clay, raw vs output, 1 sample per pixel).
 *
 * Everything scene-specific (ground, footprints, eyes, region of interest, hero facade) is derived from the scan at
 * runtime; the anchor and the radius are parameters. No closed taxonomies, no string branching.
 */

#include "scratchbox_photometric_relief.hpp"
#include "scratchbox_scan_rectifier.hpp"
#include "scratchbox_texture.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <filesystem>
#include <sys/resource.h>
#include <fstream>
#include <functional>
#include <limits>
#include <memory>
#include <numeric>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace tile_refine {

using scan_rectifier::V3;

// ============================================================================================
// Parameters
// ============================================================================================
struct VisibilityParams {
    int aerialAzimuths{8};             // cameras per elevation ring
    std::vector<double> aerialElevationsDeg{15.0, 32.0, 58.0};  // ring elevations (successive rings are staggered in azimuth)
    double aerialFovDeg{45.0};
    int aerialResolution{1536};
    bool nadir{true};                  // orthographic view straight down over the whole scan
    int nadirResolution{2048};
    int streetSites{16};               // eyes on open ground (farthest-point spread, first one nearest the anchor)
    int roofSites{4};                  // eyes on flat open-air surfaces above the ground (terraces, flat roofs)
    int cubeResolution{512};           // per cube face of an eye
    double eyeHeight{1.7};
    double siteMargin{10.0};           // eyes stay this far inside the scan's x/z bounds (m)
    double nearPlane{0.2};
    double occluderTolerance{0.02};    // a surface hides a sample point only when at least this far in front (m)
    int samplePoints{4};               // exact-test points per small triangle (centroid + 3 inner points)
    int occluderSearchRadiusPx{2};     // front-most triangles within this many pixels are tried as occluders first (<= 2)
    double dsmCell{1.0};
    double dtmCell{8.0};
    double dtmOpeningRadius{48.0};     // structures narrower than twice this are removed from the terrain (m)
    double openGroundTolerance{1.0};   // DSM within this of the DTM is open ground (m)
    double roofMinHeight{3.0};
    double flatTolerance{0.6};
    double flatMinNy{0.95};
    int fillMinVisibleNeighbours{2};   // a hidden triangle with visible neighbours across this many edges stays (0 = off)
    int fillPasses{2};
    // Targeted eyes (second pass): a wall the first views missed that faces open ground within targetReach gets an eye
    // on that ground (street canyons the spread eyes cannot see into). Eyes closer than targetCell share one site; the
    // sites serving the most missed wall area are rendered, at most targetedEyes of them per round.
    int targetedEyes{48};
    int targetRounds{1};
    double targetReach{80.0};          // m along the wall's horizontal normal
    double targetStreetDepth{16.0};    // the eye stands in the middle of the open run it found, at most half this deep (m)
    double targetCell{12.0};           // m
    double targetMinArea{4.0};         // a site serves at least this much missed wall area (m^2)
    double targetMaxAbsNy{0.7};        // walls: |ny| at most this
    double targetFovDeg{110.0};        // one square pinhole view per targeted eye, toward the walls it serves
    double targetPitchDeg{25.0};
    int targetResolution{768};
};

struct TileRefineParams {
    int threads{0};
    double anchorX{0}, anchorZ{0};
    double roiRadius{60.0};            // the region of interest is the anchor's footprint grown by this (m)
    bool relief{true};
    double creaseAngleDeg{30.0};
    VisibilityParams vis;
    scan_rectifier::ScanRectifierParams rect;
    photometric_relief::ReliefParams reliefParams;
    // Isolate: keep only the structure under the anchor plus a ground apron, then run every later stage on that subset.
    // The structure is the connected footprint (DSM above the terrain) nearest the anchor, with its enclosed courtyards,
    // taken whole: every triangle over it (no height cap), closed over mesh connectivity through raised triangles, so
    // attached neighbours come along instead of being cut; it ends where the footprint meets open ground (street canyons).
    bool isolate{false};
    double isolateMinHeight{3.0};      // footprint cells: DSM at least this above the terrain (m)
    double isolateSearchRadius{30.0};  // the footprint cell nearest the anchor within this is the seed (m)
    double isolateCoreGrow{2.0};       // triangles whose centroid lies within this of the footprint belong to it (m)
    double isolateReach{12.0};         // connectivity closure: raised triangles connected to the structure within this of the footprint (m)
    double isolateApron{4.0};          // ground kept around the footprint (m)
    double isolateApronMaxHeight{2.5}; // apron triangles: centroid at most this above the terrain (m); only without ground rebuild
    // Low attached structures (a sidewalk shed, a scaffold deck, a canopy): raised areas joined to the footprint whose top
    // stays below the structure's core are not the structure. The core is the footprint standing at least
    // min(isolateLowAttachmentMaxHeight, isolateLowAttachmentHeightFraction x the structure's height) above the terrain;
    // footprint cells outside the core's connected component (and not enclosed by it) are dropped with their low surfaces.
    // isolateLowAttachmentMaxHeight <= isolateMinHeight turns this off.
    double isolateLowAttachmentMaxHeight{8.0};
    double isolateLowAttachmentHeightFraction{0.5};
    // Ground: rebuild the apron as a ground patch on the street surface instead of keeping scan triangles (which carry
    // parked cars, poles and street furniture, and nothing where a dropped attachment hid the ground). The patch covers
    // the open cells within isolateApron of the footprint and gets a neutral material of its own.
    bool isolateRebuildGround{true};
    double isolateGroundOpeningRadius{6.0};  // the patch follows the scan's street surface with objects narrower than twice this removed (m)
    // The model ends at street level: surfaces more than this below the terrain are clipped off (straddling triangles are
    // cut at that level, so no hole opens). Negative turns it off.
    double isolateBelowGroundMargin{0.3};
    // Interior floors: upward-facing horizontal surfaces at least isolateInteriorMinAbove above the terrain, at least
    // isolateInteriorInset inside the footprint edge and isolateInteriorBelowTop below the top surface there, are scan
    // leftovers inside the walls and are dropped. isolateInteriorInset < 0 turns it off.
    double isolateInteriorInset{2.5};
    double isolateInteriorBelowTop{2.0};
    double isolateInteriorMinAbove{1.0};
    std::string rawClayPath;           // non-empty: also write the (isolated) raw scan, unmodified, as studio clay
    std::string thumbsDir;             // non-empty: write thumbnails there
    int thumbWidth{640}, thumbHeight{360};
    V3 aerialEye{150, 650, 250};       // aerial thumbnail eye / target; x and z are relative to the anchor
    V3 aerialTarget{0, 180, 0};
    std::vector<uint8_t> referenceVisibility;  // optional per-triangle visibility (non-zero = visible) to compare against
};

// ============================================================================================
// Software rasterizer (visibility buffer)
// ============================================================================================
struct Camera {
    V3 eye, fwd, right, up;
    int W{0}, H{0};
    bool ortho{false};
    double focal{1};   // pixels (perspective)
    double scale{1};   // pixels per metre (orthographic)
    double nearPlane{0.2};

    static Camera lookAt(const V3& eye, const V3& target, const V3& upHint, int W, int H, double vfovDeg, double nearPlane) {
        Camera c;
        c.eye = eye;
        c.fwd = (target - eye).normalized();
        V3 r = c.fwd.cross(upHint);
        if (r.norm() < 1e-9) r = c.fwd.cross(std::abs(c.fwd.x) < 0.9 ? V3{1, 0, 0} : V3{0, 0, 1});
        c.right = r.normalized();
        c.up = c.right.cross(c.fwd).normalized();
        c.W = W; c.H = H;
        c.focal = 0.5 * H / std::tan(0.5 * vfovDeg * 3.14159265358979323846 / 180.0);
        c.nearPlane = nearPlane;
        return c;
    }
    /** Pixel position and depth key (smaller = closer) of a camera-space point; false when behind the near plane. */
    bool project(double x, double y, double z, double& sx, double& sy, double& d) const {
        if (ortho) { sx = 0.5 * W + x * scale; sy = 0.5 * H - y * scale; d = z; return true; }
        if (z <= nearPlane) return false;
        sx = 0.5 * W + focal * x / z;
        sy = 0.5 * H - focal * y / z;
        d = -1.0 / z;
        return true;
    }
    V3 toCamera(const V3& p) const { const V3 q = p - eye; return {q.dot(right), q.dot(up), q.dot(fwd)}; }
};

/** Triangle soup view used by the rasterizer: float positions (3 per vertex) and corner indices (3 per triangle). */
struct MeshView {
    const float* pos{nullptr};
    size_t vertexCount{0};
    const uint32_t* idx{nullptr};
    size_t triangleCount{0};
    V3 P(uint32_t v) const { return {pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]}; }
};

class Raster {
public:
    // buffer 0: every triangle occludes (two-sided rule); buffer 1: front faces only (single-sided rule)
    std::vector<float> depth[2];
    std::vector<int32_t> id[2];
    std::vector<float> cx, cy, cz;  // camera-space vertex positions
    int buffers{1};

    void prepare(const Camera& cam, const MeshView& m, int nBuffers = 1) {
        const size_t n = static_cast<size_t>(cam.W) * cam.H;
        buffers = nBuffers;
        for (int b = 0; b < nBuffers; ++b) {
            depth[b].assign(n, std::numeric_limits<float>::infinity());
            id[b].assign(n, -1);
        }
        cx.resize(m.vertexCount); cy.resize(m.vertexCount); cz.resize(m.vertexCount);
        for (size_t v = 0; v < m.vertexCount; ++v) {
            const V3 q = cam.toCamera(m.P(static_cast<uint32_t>(v)));
            cx[v] = static_cast<float>(q.x); cy[v] = static_cast<float>(q.y); cz[v] = static_cast<float>(q.z);
        }
    }

    /**
     * Rasterizes every triangle for which mask(t) is non-zero: bit 0 = into buffer 0, bit 1 = into buffer 1
     * (camera-space vertices from prepare()).
     */
    template <class Mask>
    void draw(const Camera& cam, const MeshView& m, Mask mask) {
        for (size_t t = 0; t < m.triangleCount; ++t) {
            const int mk = mask(t);
            if (!mk) continue;
            const uint32_t a = m.idx[3 * t], b = m.idx[3 * t + 1], c = m.idx[3 * t + 2];
            double in[3][3] = {{cx[a], cy[a], cz[a]}, {cx[b], cy[b], cz[b]}, {cx[c], cy[c], cz[c]}};
            if (cam.ortho) {
                double s[3][3];
                for (int k = 0; k < 3; ++k) cam.project(in[k][0], in[k][1], in[k][2], s[k][0], s[k][1], s[k][2]);
                fill(cam, s[0], s[1], s[2], static_cast<int32_t>(t), mk);
                continue;
            }
            const double nearZ = cam.nearPlane;
            int behind = (in[0][2] <= nearZ) + (in[1][2] <= nearZ) + (in[2][2] <= nearZ);
            if (behind == 3) continue;
            // quick frustum reject (all three on the outside of one side plane)
            const double kx = 0.5 * cam.W / cam.focal, ky = 0.5 * cam.H / cam.focal;
            bool out = true;
            for (int k = 0; k < 3 && out; ++k) out = in[k][0] > kx * in[k][2];
            if (out) continue;
            out = true;
            for (int k = 0; k < 3 && out; ++k) out = in[k][0] < -kx * in[k][2];
            if (out) continue;
            out = true;
            for (int k = 0; k < 3 && out; ++k) out = in[k][1] > ky * in[k][2];
            if (out) continue;
            out = true;
            for (int k = 0; k < 3 && out; ++k) out = in[k][1] < -ky * in[k][2];
            if (out) continue;
            if (behind == 0) {
                double s[3][3];
                for (int k = 0; k < 3; ++k) cam.project(in[k][0], in[k][1], in[k][2], s[k][0], s[k][1], s[k][2]);
                fill(cam, s[0], s[1], s[2], static_cast<int32_t>(t), mk);
                continue;
            }
            // clip against the near plane (Sutherland-Hodgman, one plane): at most four vertices
            double poly[4][3];
            int np = 0;
            for (int k = 0; k < 3; ++k) {
                const double* A = in[k];
                const double* B = in[(k + 1) % 3];
                const bool ia = A[2] > nearZ, ib = B[2] > nearZ;
                if (ia) { poly[np][0] = A[0]; poly[np][1] = A[1]; poly[np][2] = A[2]; ++np; }
                if (ia != ib) {
                    const double f = (nearZ - A[2]) / (B[2] - A[2]);
                    poly[np][0] = A[0] + f * (B[0] - A[0]);
                    poly[np][1] = A[1] + f * (B[1] - A[1]);
                    poly[np][2] = nearZ * (1.0 + 1e-9);
                    ++np;
                }
            }
            if (np < 3) continue;
            double s[4][3];
            bool ok = true;
            for (int k = 0; k < np && ok; ++k) ok = cam.project(poly[k][0], poly[k][1], poly[k][2], s[k][0], s[k][1], s[k][2]);
            if (!ok) continue;
            for (int k = 1; k + 1 < np; ++k) fill(cam, s[0], s[k], s[k + 1], static_cast<int32_t>(t), mk);
        }
    }

private:
    void fill(const Camera& cam, const double* p0, const double* p1, const double* p2, int32_t tid, int mk) {
        const double area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
        if (!(std::abs(area) > 1e-12)) return;
        const double minXf = std::min({p0[0], p1[0], p2[0]}), maxXf = std::max({p0[0], p1[0], p2[0]});
        const double minYf = std::min({p0[1], p1[1], p2[1]}), maxYf = std::max({p0[1], p1[1], p2[1]});
        if (maxXf < 0 || maxYf < 0 || minXf > cam.W || minYf > cam.H) return;
        const int x0 = std::max(0, static_cast<int>(std::floor(minXf))), x1 = std::min(cam.W - 1, static_cast<int>(std::ceil(maxXf)));
        const int y0 = std::max(0, static_cast<int>(std::floor(minYf))), y1 = std::min(cam.H - 1, static_cast<int>(std::ceil(maxYf)));
        if (x0 > x1 || y0 > y1) return;
        const double inv = 1.0 / area;
        // barycentric weights are affine in the pixel centre: w_k = a_k x + b_k y + c_k
        const double A[3] = {(p1[1] - p2[1]) * inv, (p2[1] - p0[1]) * inv, 0};
        const double B[3] = {(p2[0] - p1[0]) * inv, (p0[0] - p2[0]) * inv, 0};
        const double C[3] = {(p1[0] * p2[1] - p2[0] * p1[1]) * inv, (p2[0] * p0[1] - p0[0] * p2[1]) * inv, 0};
        const double a2 = -A[0] - A[1], b2 = -B[0] - B[1], c2 = 1.0 - C[0] - C[1];
        const double ea[3] = {A[0], A[1], a2}, eb[3] = {B[0], B[1], b2}, ec[3] = {C[0], C[1], c2};
        const double d0 = p0[2], d1 = p1[2], d2 = p2[2];
        // depth is affine too
        const double da = A[0] * d0 + A[1] * d1 + a2 * d2, db = B[0] * d0 + B[1] * d1 + b2 * d2, dc = C[0] * d0 + C[1] * d1 + c2 * d2;
        const bool frontToo = (mk & 2) != 0, twoSided = (mk & 1) != 0;
        for (int y = y0; y <= y1; ++y) {
            const double py = y + 0.5;
            // the x span where all three weights are >= 0 (each weight is a line in x for this row)
            double lo = x0 + 0.5, hi = x1 + 0.5;
            bool empty = false;
            for (int k = 0; k < 3 && !empty; ++k) {
                const double base = eb[k] * py + ec[k];
                if (std::abs(ea[k]) < 1e-15) { if (base < 0) empty = true; continue; }
                const double xr = -base / ea[k];
                if (ea[k] > 0) lo = std::max(lo, xr); else hi = std::min(hi, xr);
            }
            if (empty || lo > hi) continue;
            const int xs = std::max(x0, static_cast<int>(std::ceil(lo - 0.5 - 1e-9))), xe = std::min(x1, static_cast<int>(std::floor(hi - 0.5 + 1e-9)));
            const size_t row = static_cast<size_t>(y) * cam.W;
            for (int x = xs; x <= xe; ++x) {
                const double px = x + 0.5;
                // exact inside test at the span ends (the span is computed in floating point)
                if (x == xs || x == xe) {
                    bool in = true;
                    for (int k = 0; k < 3 && in; ++k) in = ea[k] * px + eb[k] * py + ec[k] >= 0;
                    if (!in) continue;
                }
                const float d = static_cast<float>(da * px + db * py + dc);
                const size_t i = row + x;
                if (twoSided && d < depth[0][i]) { depth[0][i] = d; id[0][i] = tid; }
                if (frontToo && d < depth[1][i]) { depth[1][i] = d; id[1][i] = tid; }
            }
        }
    }
};

/** Ray (origin o, unit direction dir) against triangle (a, b, c), both sides: hit distance or -1. */
inline double rayTriangle(const V3& o, const V3& dir, const V3& a, const V3& b, const V3& c) {
    const V3 e1 = b - a, e2 = c - a;
    const V3 p = dir.cross(e2);
    const double det = e1.dot(p);
    if (std::abs(det) < 1e-14) return -1;
    const double inv = 1.0 / det;
    const V3 s = o - a;
    const double u = s.dot(p) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return -1;
    const V3 q = s.cross(e1);
    const double v = dir.dot(q) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return -1;
    return e2.dot(q) * inv;
}

// ============================================================================================
// Height grids (DSM / DTM) and eye sites
// ============================================================================================
struct HeightGrid {
    double x0{0}, z0{0}, cell{1};
    int nx{0}, nz{0};
    std::vector<float> h;   // NaN = no data
    std::vector<float> ny;  // |ny| of the surface giving h
    void init(double minX, double minZ, double maxX, double maxZ, double c) {
        x0 = minX; z0 = minZ; cell = c;
        nx = std::max(1, static_cast<int>(std::ceil((maxX - minX) / c)) + 1);
        nz = std::max(1, static_cast<int>(std::ceil((maxZ - minZ) / c)) + 1);
        h.assign(static_cast<size_t>(nx) * nz, std::numeric_limits<float>::quiet_NaN());
        ny.assign(h.size(), 0.0f);
    }
    double cx(int i) const { return x0 + (i + 0.5) * cell; }
    double cz(int k) const { return z0 + (k + 0.5) * cell; }
    int ix(double x) const { return static_cast<int>(std::floor((x - x0) / cell)); }
    int iz(double z) const { return static_cast<int>(std::floor((z - z0) / cell)); }
    bool inside(int i, int k) const { return i >= 0 && k >= 0 && i < nx && k < nz; }
    float& at(int i, int k) { return h[static_cast<size_t>(k) * nx + i]; }
    float at(int i, int k) const { return h[static_cast<size_t>(k) * nx + i]; }
    void maxIn(int i, int k, float v, float n) {
        if (!inside(i, k)) return;
        float& c = at(i, k);
        if (std::isnan(c) || v > c) { c = v; ny[static_cast<size_t>(k) * nx + i] = n; }
    }
    /** Bilinear sample over cell centres (NaN-free grids only). */
    double sample(double x, double z) const {
        double fx = (x - x0) / cell - 0.5, fz = (z - z0) / cell - 0.5;
        int i = static_cast<int>(std::floor(fx)), k = static_cast<int>(std::floor(fz));
        double tx = fx - i, tz = fz - k;
        auto g = [&](int a, int b) { a = std::clamp(a, 0, nx - 1); b = std::clamp(b, 0, nz - 1); return static_cast<double>(at(a, b)); };
        return (g(i, k) * (1 - tx) + g(i + 1, k) * tx) * (1 - tz) + (g(i, k + 1) * (1 - tx) + g(i + 1, k + 1) * tx) * tz;
    }
};

struct EyeSite { V3 eye; bool roof{false}; bool targeted{false}; };

// ============================================================================================
// Stats helpers
// ============================================================================================
struct Distribution {
    size_t count{0};
    double max{0}, mean{0}, p95{0}, p50{0};
    static Distribution of(std::vector<double> v) {
        Distribution d;
        d.count = v.size();
        if (v.empty()) return d;
        double s = 0;
        for (double x : v) { s += x; d.max = std::max(d.max, x); }
        d.mean = s / static_cast<double>(v.size());
        auto pct = [&](double q) {
            size_t k = std::min(v.size() - 1, static_cast<size_t>(std::floor(q * static_cast<double>(v.size() - 1))));
            std::nth_element(v.begin(), v.begin() + static_cast<std::ptrdiff_t>(k), v.end());
            return v[k];
        };
        d.p95 = pct(0.95);
        d.p50 = pct(0.5);
        return d;
    }
};

struct OpenEdgeStats {
    size_t triangles{0}, weldedVertices{0}, boundaryEdges{0}, nonManifoldEdges{0};
    double boundaryLength{0};
    size_t nearGaps{0};        // boundary edges whose midpoint lies within (1 mm, gapSearch] of another, non-adjacent boundary edge
    double maxGap{0};          // the widest such gap (m; bounded by the search radius)
    double gapP50{0}, gapP95{0};  // their median and 95th percentile (m)
    size_t newBoundaryEdges{0};     // vs a reference: boundary edges not lying on a reference boundary edge
    double newBoundaryLength{0};
    double newMaxGap{0};       // widest gap at a new boundary edge (0 = T-junction, a vertex on the partner edge)
    bool hasReference{false};
};

struct Segment { V3 a, b; uint32_t va, vb; };

inline double pointSegmentDistance(const V3& p, const V3& a, const V3& b) {
    const V3 ab = b - a;
    const double L2 = ab.dot(ab);
    double t = L2 > 0 ? (p - a).dot(ab) / L2 : 0.0;
    t = std::clamp(t, 0.0, 1.0);
    return (p - (a + ab * t)).norm();
}

/**
 * Uniform grid over segments: each segment is registered in the cells of points sampled along it every quarter cell,
 * and a query visits the 27 cells around the point, so every segment within `reach` of the query point is visited
 * when reach <= 0.75 cell. Long segments cost proportionally to their length, not to their bounding box.
 */
class SegmentGrid {
public:
    SegmentGrid(const std::vector<Segment>& segs, double reach, double cell = 0.25) : segs_(segs), cell_(std::max(cell, reach / 0.75)) {
        // flat (cell key, segment) array sorted by key: no per-cell allocations, lookups by binary search
        entries_.reserve(segs.size() * 4);
        for (uint32_t i = 0; i < segs.size(); ++i) {
            const V3& a = segs[i].a;
            const V3& b = segs[i].b;
            const double L = (b - a).norm();
            // sample spacing h: the nearest sample to the closest point is within h/2, so reach + h/2 <= cell suffices
            const double h = 0.9 * std::min(cell_, 2.0 * (cell_ - std::min(reach, 0.75 * cell_)));
            const int n = std::max(1, static_cast<int>(std::ceil(L / h)));
            int64_t last = std::numeric_limits<int64_t>::min();
            for (int k = 0; k <= n; ++k) {
                const V3 q = a + (b - a) * (static_cast<double>(k) / n);
                const int64_t hk = hash(key(q.x), key(q.y), key(q.z));
                if (hk == last) continue;
                last = hk;
                entries_.push_back({hk, i});
            }
        }
        std::sort(entries_.begin(), entries_.end());
        entries_.erase(std::unique(entries_.begin(), entries_.end()), entries_.end());
    }
    template <class Visit>
    void near(const V3& p, Visit visit) const {
        const int64_t x = key(p.x), y = key(p.y), z = key(p.z);
        for (int64_t dx = -1; dx <= 1; ++dx)
            for (int64_t dy = -1; dy <= 1; ++dy)
                for (int64_t dz = -1; dz <= 1; ++dz) {
                    const int64_t hk = hash(x + dx, y + dy, z + dz);
                    auto it = std::lower_bound(entries_.begin(), entries_.end(), std::pair<int64_t, uint32_t>{hk, 0u});
                    for (; it != entries_.end() && it->first == hk; ++it)
                        if (visit(segs_[it->second], it->second)) return;  // the visitor asks to stop
                }
    }

private:
    const std::vector<Segment>& segs_;
    double cell_;
    std::vector<std::pair<int64_t, uint32_t>> entries_;
    int64_t key(double v) const { return static_cast<int64_t>(std::floor(v / cell_)); }
    static int64_t hash(int64_t x, int64_t y, int64_t z) {
        return static_cast<int64_t>(static_cast<uint64_t>(x) * 0x9E3779B97F4A7C15ull ^ static_cast<uint64_t>(y) * 0xC2B2AE3D27D4EB4Full ^ static_cast<uint64_t>(z) * 0x165667B19E3779F9ull);
    }
};

/**
 * Open-edge census of a triangle set: positions welded at 0.01 mm, an edge used by one triangle is a boundary edge.
 * With a reference census, boundary edges that do not lie on a reference boundary edge (midpoint and both ends within
 * 1 mm) are new; their gap is the distance from the midpoint to the nearest other boundary edge not sharing a vertex.
 */
inline OpenEdgeStats openEdgeCensus(const std::vector<V3>& pos, const std::vector<std::array<uint32_t, 3>>& tris,
                                    std::vector<Segment>* boundaryOut = nullptr, const std::vector<Segment>* reference = nullptr,
                                    const std::vector<V3>* matchPos = nullptr, double gapSearch = 0.1, unsigned threads = 1) {
    OpenEdgeStats st;
    st.triangles = tris.size();
    // weld: sort the quantized positions (0.01 mm), equal keys share an id
    std::vector<uint32_t> wid(pos.size());
    std::vector<V3> wpos;
    {
        auto q = [](double v) { return static_cast<int64_t>(std::llround(v * 1e5)); };
        std::vector<std::array<int64_t, 3>> key(pos.size());
        for (size_t v = 0; v < pos.size(); ++v) key[v] = {q(pos[v].x), q(pos[v].y), q(pos[v].z)};
        std::vector<uint32_t> order(pos.size());
        std::iota(order.begin(), order.end(), 0u);
        std::sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return key[a] != key[b] ? key[a] < key[b] : a < b; });
        for (size_t i = 0; i < order.size(); ++i) {
            if (i == 0 || key[order[i]] != key[order[i - 1]]) wpos.push_back(pos[order[i]]);
            wid[order[i]] = static_cast<uint32_t>(wpos.size() - 1);
        }
    }
    st.weldedVertices = wpos.size();
    std::vector<uint64_t> ekeys;
    ekeys.reserve(tris.size() * 3);
    for (const auto& t : tris) {
        const uint32_t w[3] = {wid[t[0]], wid[t[1]], wid[t[2]]};
        if (w[0] == w[1] || w[1] == w[2] || w[0] == w[2]) continue;
        for (int k = 0; k < 3; ++k) {
            const uint32_t a = std::min(w[k], w[(k + 1) % 3]), b = std::max(w[k], w[(k + 1) % 3]);
            ekeys.push_back((static_cast<uint64_t>(a) << 32) | b);
        }
    }
    std::sort(ekeys.begin(), ekeys.end());
    std::vector<Segment> bnd;
    for (size_t i = 0; i < ekeys.size();) {
        size_t e = i;
        while (e < ekeys.size() && ekeys[e] == ekeys[i]) ++e;
        const size_t count = e - i;
        if (count > 2) ++st.nonManifoldEdges;
        if (count == 1) {
            const uint32_t a = static_cast<uint32_t>(ekeys[i] >> 32), b = static_cast<uint32_t>(ekeys[i] & 0xffffffffu);
            bnd.push_back({wpos[a], wpos[b], a, b});
            st.boundaryLength += (wpos[a] - wpos[b]).norm();
        }
        i = e;
    }
    std::sort(bnd.begin(), bnd.end(), [](const Segment& x, const Segment& y) { return x.va != y.va ? x.va < y.va : x.vb < y.vb; });
    st.boundaryEdges = bnd.size();
    // near gaps: another boundary edge (no shared vertex) within (1 mm, gapSearch] of the midpoint
    std::vector<double> gapOf(bnd.size(), -1.0);
    if (gapSearch > 0) {
    SegmentGrid grid(bnd, gapSearch);
    scan_rectifier::detail::parallelFor(bnd.size(), threads, 2048, [&](size_t b0, size_t b1, unsigned) {
        for (size_t i = b0; i < b1; ++i) {
            const Segment& e = bnd[i];
            const V3 m = (e.a + e.b) * 0.5;
            double best = 1e300;
            grid.near(m, [&](const Segment& o, uint32_t j) {
                if (j == i || o.va == e.va || o.va == e.vb || o.vb == e.va || o.vb == e.vb) return false;
                best = std::min(best, pointSegmentDistance(m, o.a, o.b));
                return best <= 1e-3;  // closed (a T-junction partner): not a gap, no need to look further
            });
            if (best <= gapSearch) gapOf[i] = best;
        }
    });
    std::vector<double> gaps;
    for (size_t i = 0; i < bnd.size(); ++i)
        if (gapOf[i] > 1e-3) { ++st.nearGaps; st.maxGap = std::max(st.maxGap, gapOf[i]); gaps.push_back(gapOf[i]); }
    if (!gaps.empty()) {
        std::sort(gaps.begin(), gaps.end());
        st.gapP50 = gaps[gaps.size() / 2];
        st.gapP95 = gaps[std::min(gaps.size() - 1, static_cast<size_t>(0.95 * static_cast<double>(gaps.size())))];
    }
    }
    if (reference) {
        st.hasReference = true;
        SegmentGrid rg(*reference, 2e-3);
        // a representative input vertex of every welded vertex, for the match positions
        std::vector<uint32_t> repOf(wpos.size(), 0);
        for (size_t v = 0; v < pos.size(); ++v) repOf[wid[v]] = static_cast<uint32_t>(v);
        std::vector<uint8_t> matched(bnd.size(), 0);
        scan_rectifier::detail::parallelFor(bnd.size(), threads, 2048, [&](size_t b0, size_t b1, unsigned) {
            for (size_t i = b0; i < b1; ++i) {
                Segment e = bnd[i];
                if (matchPos) { e.a = (*matchPos)[repOf[e.va]]; e.b = (*matchPos)[repOf[e.vb]]; }
                const V3 m = (e.a + e.b) * 0.5;
                bool ok = true;
                for (const V3* p : {static_cast<const V3*>(&e.a), static_cast<const V3*>(&e.b), &m}) {
                    bool hit = false;
                    rg.near(*p, [&](const Segment& o, uint32_t) { hit = pointSegmentDistance(*p, o.a, o.b) <= 1e-3; return hit; });
                    ok = ok && hit;
                    if (!ok) break;
                }
                matched[i] = ok ? 1 : 0;
            }
        });
        for (size_t i = 0; i < bnd.size(); ++i) {
            if (matched[i]) continue;
            if (std::getenv("SB_DEBUG_NEWEDGES") && st.newBoundaryEdges < 40) {
                const V3 a = matchPos ? (*matchPos)[repOf[bnd[i].va]] : bnd[i].a, b = matchPos ? (*matchPos)[repOf[bnd[i].vb]] : bnd[i].b;
                std::fprintf(stderr, "new boundary edge %u-%u (%.3f %.3f %.3f)-(%.3f %.3f %.3f) len %.3f gap %.4f\n", repOf[bnd[i].va], repOf[bnd[i].vb], a.x, a.y, a.z, b.x, b.y, b.z, (a - b).norm(), gapOf[i]);
            }
            ++st.newBoundaryEdges;
            st.newBoundaryLength += (bnd[i].a - bnd[i].b).norm();
            if (gapOf[i] >= 0) st.newMaxGap = std::max(st.newMaxGap, gapOf[i]);
        }
    }
    if (boundaryOut) *boundaryOut = std::move(bnd);
    return st;
}

// ============================================================================================
// The pipeline
// ============================================================================================
class TileRefine {
public:
    using Clock = std::chrono::steady_clock;

    struct Result {
        bool ok{false};
        std::string error;
        std::string statsJson;
        size_t outputTriangles{0};
        double totalMs{0};
    };

    static Result runFile(const std::string& input, const std::string& outTextured, const std::string& outClay, const std::string& statsPath,
                          const TileRefineParams& params) {
        TileRefine engine(params);
        return engine.execute(input, outTextured, outClay, statsPath);
    }

private:
    explicit TileRefine(const TileRefineParams& p) : P(p) {
        threads = scan_rectifier::detail::resolveThreads(p.threads);
    }

    TileRefineParams P;
    unsigned threads{1};
    std::vector<std::pair<std::string, double>> timings;
    Clock::time_point lapStart;
    std::ostringstream js;  // stats body (comma-separated members)

    std::vector<std::pair<std::string, double>> cpuTimings;
    double lapCpu{0};
    static double processCpuMs() {
        rusage ru{};
        getrusage(RUSAGE_SELF, &ru);
        return (ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) * 1e3 + (ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) * 1e-3;
    }
    void lap(const std::string& name) {
        const auto now = Clock::now();
        const double cpu = processCpuMs();
        timings.push_back({name, std::chrono::duration<double, std::milli>(now - lapStart).count()});
        cpuTimings.push_back({name, cpu - lapCpu});
        lapStart = now;
        lapCpu = cpu;
    }
    static std::string num(double v) {
        if (!std::isfinite(v)) return "null";
        std::ostringstream s;
        s.precision(9);
        s << v;
        return s.str();
    }
    static std::string vec(const V3& v) { return "[" + num(v.x) + "," + num(v.y) + "," + num(v.z) + "]"; }
    static std::string dist(const Distribution& d) {
        return "{\"count\": " + std::to_string(d.count) + ", \"max\": " + num(d.max) + ", \"p95\": " + num(d.p95) + ", \"p50\": " + num(d.p50) +
               ", \"mean\": " + num(d.mean) + "}";
    }
    static std::string edges(const OpenEdgeStats& s) {
        std::string o = "{\"triangles\": " + std::to_string(s.triangles) + ", \"weldedVertices\": " + std::to_string(s.weldedVertices) +
                        ", \"boundaryEdges\": " + std::to_string(s.boundaryEdges) + ", \"boundaryLength_m\": " + num(s.boundaryLength) +
                        ", \"nonManifoldEdges\": " + std::to_string(s.nonManifoldEdges) + ", \"nearGaps_1mm_100mm\": " + std::to_string(s.nearGaps) +
                        ", \"maxGap_m\": " + num(s.maxGap) + ", \"gapP50_m\": " + num(s.gapP50) + ", \"gapP95_m\": " + num(s.gapP95);
        if (s.hasReference)
            o += ", \"newBoundaryEdges\": " + std::to_string(s.newBoundaryEdges) + ", \"newBoundaryLength_m\": " + num(s.newBoundaryLength) +
                 ", \"newMaxGap_m\": " + num(s.newMaxGap);
        return o + "}";
    }

    // scan data
    gltf::GltfScene scene;
    std::vector<float> rawPos;                 // 3V, as loaded
    std::vector<uint32_t> rawIdx;              // 3F, as loaded
    std::vector<uint32_t> rawMat;              // F
    size_t V{0}, F{0};
    V3 bbMin, bbMax;
    // derived
    HeightGrid dsm, dtm;
    std::vector<EyeSite> sites;
    std::vector<uint8_t> visible;
    scan_rectifier::ScanRectifierResult rect;
    photometric_relief::ReliefResult relief;
    std::vector<uint32_t> keptTris;            // raw triangle index of every rectified triangle passed on
    bool roiEnabled{false};
    double roiMinX{0}, roiMaxX{0}, roiMinZ{0}, roiMaxZ{0};

    // ----------------------------------------------------------------------------------------
    Result execute(const std::string& input, const std::string& outTextured, const std::string& outClay, const std::string& statsPath) {
        Result res;
        const auto t0 = Clock::now();
        lapStart = t0;
        lapCpu = processCpuMs();
        double load[3] = {0, 0, 0};
        getloadavg(load, 3);
        scene = gltf::GlbSceneReader::readFile(input);
        if (!scene.ok) { res.error = "failed to read " + input + ": " + scene.error; return res; }
        if (scene.mesh.indices.size() < 3) { res.error = "scan has no triangles"; return res; }
        adoptSceneGeometry();
        lap("load");

        js << "  \"input\": {\"path\": \"" << jsonEscape(input) << "\", \"vertices\": " << V << ", \"triangles\": " << F << ", \"images\": " << scene.images.size()
           << ", \"materials\": " << scene.materials.size() << ", \"boundsMin\": " << vec(bbMin) << ", \"boundsMax\": " << vec(bbMax) << "},\n";

        // 1b. isolate the structure under the anchor (every later stage sees only that subset)
        if (P.isolate) {
            if (!isolateStructure(res)) return res;
            lap("isolate");
        } else {
            js << "  \"isolate\": {\"enabled\": false},\n";
        }
        if (!P.rawClayPath.empty()) {
            const auto rawClay = photometric_relief::PhotometricRelief::writeClayGlb(passThroughMesh(), P.creaseAngleDeg, "TileRefine_RawScanClay");
            if (!writeFile(P.rawClayPath, rawClay)) { res.error = "cannot write " + P.rawClayPath; return res; }
            js << "  \"rawClay\": {\"path\": \"" << jsonEscape(P.rawClayPath) << "\", \"bytes\": " << rawClay.size() << ", \"triangles\": " << F << "},\n";
            lap("write_raw_clay");
        }

        // 2. visibility
        computeVisibility();
        lap("visibility");

        // 3. rectify
        {
            scan_rectifier::ScanRectifierParams rp = P.rect;
            rp.threads = static_cast<int>(threads);
            rp.anchorX = P.anchorX;
            rp.anchorZ = P.anchorZ;
            rp.denoise = false;
            rp.cullHidden = true;
            rp.precomputedVisibility = visible;
            rect = scan_rectifier::ScanRectifier::rectifyMesh(scene.mesh, rp);
            if (!rect.ok) { res.error = "rectifier failed: " + rect.error; return res; }
        }
        lap("rectify");
        if (const char* dump = std::getenv("SB_DUMP_RECTIFIED")) {
            // diagnostics: rectified positions (float32 x 3V) then flags (uint8 x T)
            std::vector<uint8_t> bytes(rect.positions.size() * 4 + rect.flags.size());
            std::memcpy(bytes.data(), rect.positions.data(), rect.positions.size() * 4);
            std::memcpy(bytes.data() + rect.positions.size() * 4, rect.flags.data(), rect.flags.size());
            writeFile(dump, bytes);
        }
        if (const char* dump = std::getenv("SB_DUMP_REGIONS")) {
            // diagnostics: per-triangle region (int32 x T), region count (uint32), then 16 doubles per region (regionPlanes)
            const uint32_t R = static_cast<uint32_t>(rect.regionPlanes.size());
            std::vector<uint8_t> bytes(rect.triangleRegion.size() * 4 + 4 + static_cast<size_t>(R) * 128);
            std::memcpy(bytes.data(), rect.triangleRegion.data(), rect.triangleRegion.size() * 4);
            std::memcpy(bytes.data() + rect.triangleRegion.size() * 4, &R, 4);
            if (R) std::memcpy(bytes.data() + rect.triangleRegion.size() * 4 + 4, rect.regionPlanes.data(), static_cast<size_t>(R) * 128);
            writeFile(dump, bytes);
        }
        rectifyChecksAndApply();
        lap("rectify_checks_and_apply");

        // 4. relief (inside the region of interest)
        photometric_relief::ReliefMesh outMesh;
        if (P.relief) {
            photometric_relief::ReliefParams rp = P.reliefParams;
            rp.threads = static_cast<int>(threads);
            rp.roiEnabled = roiEnabled;
            rp.roiMinX = roiMinX; rp.roiMaxX = roiMaxX; rp.roiMinZ = roiMinZ; rp.roiMaxZ = roiMaxZ;
            rp.creaseAngleDeg = P.creaseAngleDeg;
            // diagnostics: SB_DEBUG_RELIEF_DIR receives annotated orthophotos of the largest analysed regions
            const char* reliefDebug = std::getenv("SB_DEBUG_RELIEF_DIR");
            if (reliefDebug) std::filesystem::create_directories(reliefDebug);
            relief = photometric_relief::PhotometricRelief::run(scene, rp, reliefDebug ? reliefDebug : "", reliefDebug ? 24 : 0);
            if (!relief.ok) { res.error = "relief failed: " + relief.error; return res; }
            outMesh = std::move(relief.mesh);
        } else {
            outMesh = passThroughMesh();
        }
        lap("relief");

        // 5. write
        size_t texturedBytes = 0, clayBytes = 0;
        {
            std::vector<uint8_t> textured, clay;
            std::thread tw([&]() { if (!outTextured.empty()) textured = photometric_relief::PhotometricRelief::writeTexturedGlb(scene, outMesh, P.creaseAngleDeg); });
            if (!outClay.empty()) clay = photometric_relief::PhotometricRelief::writeClayGlb(outMesh, P.creaseAngleDeg, "TileRefine_StudioGreyClay");
            tw.join();
            texturedBytes = textured.size();
            clayBytes = clay.size();
            if (!outTextured.empty() && !writeFile(outTextured, textured)) { res.error = "cannot write " + outTextured; return res; }
            if (!outClay.empty() && !writeFile(outClay, clay)) { res.error = "cannot write " + outClay; return res; }
        }
        lap("write");

        // 6. checks on the final mesh
        finalChecks(outMesh);
        lap("final_checks");

        if (!P.thumbsDir.empty()) {
            writeThumbnails(outMesh);
            lap("thumbnails");
        }

        res.totalMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
        res.outputTriangles = outMesh.triangles.size();
        std::ostringstream o;
        o << "{\n  \"ok\": true,\n";
        o << "  \"outputs\": {\"textured\": \"" << jsonEscape(outTextured) << "\", \"texturedBytes\": " << texturedBytes << ", \"clay\": \"" << jsonEscape(outClay)
          << "\", \"clayBytes\": " << clayBytes << ", \"triangles\": " << outMesh.triangles.size() << ", \"positions\": " << outMesh.positions.size() << "},\n";
        o << "  \"threads\": " << threads << ",\n";
        o << "  \"machineLoadAverage1mAtStart\": " << num(load[0]) << ",\n";
        o << "  \"processCpuMs\": " << num(processCpuMs()) << ",\n";
        o << "  \"stagesCpuMs\": {";
        for (size_t i = 0; i < cpuTimings.size(); ++i) o << (i ? ", " : "") << "\"" << cpuTimings[i].first << "\": " << num(cpuTimings[i].second);
        o << "},\n";
        o << "  \"totalMs\": " << num(res.totalMs) << ",\n";
        o << "  \"stagesMs\": {";
        for (size_t i = 0; i < timings.size(); ++i) o << (i ? ", " : "") << "\"" << timings[i].first << "\": " << num(timings[i].second);
        o << "},\n";
        o << js.str();
        o << "  \"rectifierStagesMs\": {";
        for (size_t i = 0; i < rect.stats.timingsMs.size(); ++i) o << (i ? ", " : "") << "\"" << rect.stats.timingsMs[i].first << "\": " << num(rect.stats.timingsMs[i].second);
        o << "},\n  \"reliefStagesMs\": {";
        for (size_t i = 0; i < relief.timingsMs.size(); ++i) o << (i ? ", " : "") << "\"" << relief.timingsMs[i].first << "\": " << num(relief.timingsMs[i].second);
        o << "}\n}\n";
        res.statsJson = o.str();
        if (!statsPath.empty()) {
            std::vector<uint8_t> bytes(res.statsJson.begin(), res.statsJson.end());
            if (!writeFile(statsPath, bytes)) { res.error = "cannot write " + statsPath; return res; }
        }
        res.ok = true;
        return res;
    }

    static std::string jsonEscape(const std::string& s) {
        std::string o;
        for (char c : s) {
            if (c == '"' || c == '\\') { o += '\\'; o += c; }
            else if (static_cast<unsigned char>(c) < 0x20) o += ' ';
            else o += c;
        }
        return o;
    }

    static bool writeFile(const std::string& path, const std::vector<uint8_t>& bytes) {
        std::filesystem::path p(path);
        if (p.has_parent_path()) std::filesystem::create_directories(p.parent_path());
        std::ofstream f(path, std::ios::binary | std::ios::trunc);
        if (!f) return false;
        f.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        return static_cast<bool>(f);
    }

    MeshView rawView() const { return MeshView{rawPos.data(), V, rawIdx.data(), F}; }

    /** The raw arrays (positions, indices, materials, bounds) from scene.mesh, as loaded or as isolated. */
    void adoptSceneGeometry() {
        V = scene.mesh.vertices.size();
        F = scene.mesh.indices.size() / 3;
        rawPos.resize(V * 3);
        bbMin = V3{1e300, 1e300, 1e300};
        bbMax = V3{-1e300, -1e300, -1e300};
        for (size_t v = 0; v < V; ++v) {
            const auto& p = scene.mesh.vertices[v].position;
            rawPos[3 * v] = p.x; rawPos[3 * v + 1] = p.y; rawPos[3 * v + 2] = p.z;
            bbMin = V3{std::min(bbMin.x, (double)p.x), std::min(bbMin.y, (double)p.y), std::min(bbMin.z, (double)p.z)};
            bbMax = V3{std::max(bbMax.x, (double)p.x), std::max(bbMax.y, (double)p.y), std::max(bbMax.z, (double)p.z)};
        }
        rawIdx = scene.mesh.indices;
        rawMat = scene.triangleMaterial;
        rawMat.resize(F, 0);
    }

    // ----------------------------------------------------------------------------------------
    // Isolate: the structure under the anchor, whole, plus a ground apron
    // ----------------------------------------------------------------------------------------
    bool isolateStructure(Result& res) {
        const auto t0 = Clock::now();
        const size_t inputTris = F, inputVerts = V, inputMats = scene.materials.size(), inputImages = scene.images.size();
        buildTerrain();  // DSM / DTM of the whole tile
        const int nx = dsm.nx, nz = dsm.nz;
        const size_t N = static_cast<size_t>(nx) * nz;
        const double groundTol = P.vis.openGroundTolerance;

        // 1. footprint: the 4-connected component of cells raised above the terrain nearest the anchor
        std::vector<uint8_t> raised(N, 0);
        for (int k = 0; k < nz; ++k)
            for (int i = 0; i < nx; ++i) {
                const float h = dsm.at(i, k);
                raised[static_cast<size_t>(k) * nx + i] = !std::isnan(h) && h - dtm.sample(dsm.cx(i), dsm.cz(k)) > P.isolateMinHeight;
            }
        const int ai = dsm.ix(P.anchorX), ak = dsm.iz(P.anchorZ);
        const int sr = std::max(0, static_cast<int>(std::ceil(P.isolateSearchRadius / dsm.cell)));
        long seed = -1;
        long bestD2 = std::numeric_limits<long>::max();
        for (int dk = -sr; dk <= sr; ++dk)
            for (int di = -sr; di <= sr; ++di) {
                const int i = ai + di, k = ak + dk;
                const long d2 = static_cast<long>(di) * di + static_cast<long>(dk) * dk;
                if (!dsm.inside(i, k) || d2 > static_cast<long>(sr) * sr || d2 >= bestD2 || !raised[static_cast<size_t>(k) * nx + i]) continue;
                bestD2 = d2;
                seed = static_cast<long>(k) * nx + i;
            }
        if (seed < 0) {
            res.error = "isolate: no structure raised more than " + num(P.isolateMinHeight) + " m above the terrain within " + num(P.isolateSearchRadius) +
                        " m of the anchor (" + num(P.anchorX) + ", " + num(P.anchorZ) + ")";
            return false;
        }
        std::vector<uint8_t> comp(N, 0);  // 1 = footprint, 2 = enclosed by it
        auto flood = [&](std::vector<long>& stack, std::vector<uint8_t>& mark, uint8_t value, const std::function<bool(size_t)>& pass) {
            while (!stack.empty()) {
                const long c = stack.back();
                stack.pop_back();
                const int ci = static_cast<int>(c % nx), ck = static_cast<int>(c / nx);
                const int di[4] = {1, -1, 0, 0}, dk[4] = {0, 0, 1, -1};
                for (int q = 0; q < 4; ++q) {
                    const int ni = ci + di[q], nk = ck + dk[q];
                    if (!dsm.inside(ni, nk)) continue;
                    const size_t n = static_cast<size_t>(nk) * nx + ni;
                    if (mark[n] || !pass(n)) continue;
                    mark[n] = value;
                    stack.push_back(static_cast<long>(n));
                }
            }
        };
        std::vector<long> stack{seed};
        comp[static_cast<size_t>(seed)] = 1;
        flood(stack, comp, 1, [&](size_t n) { return raised[n] != 0; });
        // 1b. low attached structures: the core is the footprint standing at least coreHeight above the terrain, taken as the
        //     connected component nearest the seed; the rest of the footprint is a low attachment unless the core encloses it
        std::vector<uint8_t> lowCell(N, 0);
        double coreHeight = 0;  // 0: not applied
        size_t lowCells = 0;
        {
            std::vector<float> above(N, 0.0f);
            double maxAbove = 0;
            for (int k = 0; k < nz; ++k)
                for (int i = 0; i < nx; ++i) {
                    const size_t n = static_cast<size_t>(k) * nx + i;
                    if (comp[n] != 1) continue;
                    above[n] = static_cast<float>(dsm.at(i, k) - dtm.sample(dsm.cx(i), dsm.cz(k)));
                    maxAbove = std::max(maxAbove, static_cast<double>(above[n]));
                }
            const double hc = std::min(P.isolateLowAttachmentMaxHeight, P.isolateLowAttachmentHeightFraction * maxAbove);
            if (hc > P.isolateMinHeight) {
                // breadth-first through the footprint from the seed to the nearest cell of the core
                long coreSeed = -1;
                std::vector<uint8_t> seen(N, 0);
                std::vector<long> q{seed};
                seen[static_cast<size_t>(seed)] = 1;
                for (size_t qi = 0; qi < q.size() && coreSeed < 0; ++qi) {
                    const long c = q[qi];
                    if (above[static_cast<size_t>(c)] >= hc) { coreSeed = c; break; }
                    const int ci = static_cast<int>(c % nx), ck = static_cast<int>(c / nx);
                    const int di[4] = {1, -1, 0, 0}, dk[4] = {0, 0, 1, -1};
                    for (int d = 0; d < 4; ++d) {
                        const int ni = ci + di[d], nk = ck + dk[d];
                        if (!dsm.inside(ni, nk)) continue;
                        const size_t n = static_cast<size_t>(nk) * nx + ni;
                        if (seen[n] || comp[n] != 1) continue;
                        seen[n] = 1;
                        q.push_back(static_cast<long>(n));
                    }
                }
                if (coreSeed >= 0) {
                    std::vector<uint8_t> core(N, 0);
                    core[static_cast<size_t>(coreSeed)] = 1;
                    std::vector<long> cs{coreSeed};
                    flood(cs, core, 1, [&](size_t n) { return comp[n] == 1 && above[n] >= hc; });
                    for (size_t n = 0; n < N; ++n)
                        if (comp[n] == 1 && !core[n]) { comp[n] = 0; lowCell[n] = 1; }
                    coreHeight = hc;
                }
            }
        }
        size_t footprintCells = 0;
        for (uint8_t c : comp) footprintCells += c == 1;
        // courtyards and light wells: open cells the grid border cannot reach without crossing the footprint
        std::vector<uint8_t> outside(N, 0);
        for (int k = 0; k < nz; ++k)
            for (int i = 0; i < nx; ++i) {
                if (k != 0 && k != nz - 1 && i != 0 && i != nx - 1) continue;
                const size_t n = static_cast<size_t>(k) * nx + i;
                if (comp[n] || outside[n]) continue;
                outside[n] = 1;
                stack.push_back(static_cast<long>(n));
            }
        flood(stack, outside, 1, [&](size_t n) { return comp[n] == 0; });
        size_t enclosedCells = 0;
        for (size_t n = 0; n < N; ++n)
            if (!comp[n] && !outside[n]) { comp[n] = 2; ++enclosedCells; }
        for (size_t n = 0; n < N; ++n) {
            if (lowCell[n] && comp[n] == 2) lowCell[n] = 0;  // enclosed by the core: part of it (a courtyard wing, an atrium roof)
            lowCells += lowCell[n];
        }
        double fMinX = 1e300, fMaxX = -1e300, fMinZ = 1e300, fMaxZ = -1e300, fTop = -1e300;
        for (int k = 0; k < nz; ++k)
            for (int i = 0; i < nx; ++i) {
                if (comp[static_cast<size_t>(k) * nx + i] != 1) continue;
                fMinX = std::min(fMinX, dsm.cx(i)); fMaxX = std::max(fMaxX, dsm.cx(i));
                fMinZ = std::min(fMinZ, dsm.cz(k)); fMaxZ = std::max(fMaxZ, dsm.cz(k));
                fTop = std::max(fTop, static_cast<double>(dsm.at(i, k)));
            }

        // 2. distance to the footprint (m): two-pass chamfer, steps 1 and sqrt(2) cells
        const float inf = std::numeric_limits<float>::infinity();
        std::vector<float> dist(N, inf);
        for (size_t n = 0; n < N; ++n) if (comp[n]) dist[n] = 0;
        const float s1 = static_cast<float>(dsm.cell), s2 = static_cast<float>(dsm.cell * std::sqrt(2.0));
        auto relax = [&](int i, int k, int ni, int nk, float w) {
            if (!dsm.inside(ni, nk)) return;
            float& d = dist[static_cast<size_t>(k) * nx + i];
            d = std::min(d, dist[static_cast<size_t>(nk) * nx + ni] + w);
        };
        for (int k = 0; k < nz; ++k)
            for (int i = 0; i < nx; ++i) {
                relax(i, k, i - 1, k, s1); relax(i, k, i - 1, k - 1, s2); relax(i, k, i, k - 1, s1); relax(i, k, i + 1, k - 1, s2);
            }
        for (int k = nz - 1; k >= 0; --k)
            for (int i = nx - 1; i >= 0; --i) {
                relax(i, k, i + 1, k, s1); relax(i, k, i + 1, k + 1, s2); relax(i, k, i, k + 1, s1); relax(i, k, i - 1, k + 1, s2);
            }

        // distance (m) from the open cells into the footprint, for interior surfaces
        std::vector<float> inside(N, inf);
        for (size_t n = 0; n < N; ++n) if (comp[n] != 1) inside[n] = 0;
        auto relaxIn = [&](int i, int k, int ni, int nk, float w) {
            if (!dsm.inside(ni, nk)) return;
            float& d = inside[static_cast<size_t>(k) * nx + i];
            d = std::min(d, inside[static_cast<size_t>(nk) * nx + ni] + w);
        };
        for (int k = 0; k < nz; ++k)
            for (int i = 0; i < nx; ++i) {
                relaxIn(i, k, i - 1, k, s1); relaxIn(i, k, i - 1, k - 1, s2); relaxIn(i, k, i, k - 1, s1); relaxIn(i, k, i + 1, k - 1, s2);
            }
        for (int k = nz - 1; k >= 0; --k)
            for (int i = nx - 1; i >= 0; --i) {
                relaxIn(i, k, i + 1, k, s1); relaxIn(i, k, i + 1, k + 1, s2); relaxIn(i, k, i, k + 1, s1); relaxIn(i, k, i - 1, k + 1, s2);
            }

        // 3. triangles: core (over the footprint), apron (low, near it), closure candidates (raised, within reach); blocked
        //    ones never join: the surfaces of a low attachment (its roof, and its walls beyond the core's reach) and
        //    interior floors (upward-facing, well inside the footprint, with the top surface well above them)
        const MeshView m = rawView();
        std::vector<float> triDist(F, inf), triAbove(F, 0);
        std::vector<uint8_t> keep(F, 0);  // 1 core, 2 closure, 3 apron
        std::vector<uint8_t> blocked(F, 0);
        size_t lowDropped = 0, interiorDropped = 0;
        std::vector<uint32_t> interiorCandidates;
        for (size_t t = 0; t < F; ++t) {
            const V3 a = m.P(m.idx[3 * t]), b = m.P(m.idx[3 * t + 1]), cc = m.P(m.idx[3 * t + 2]);
            const V3 c = (a + b + cc) * (1.0 / 3.0);
            const V3 nrm = (b - a).cross(cc - a);
            const double nl = nrm.norm();
            const double ny = nl > 0 ? nrm.y / nl : 0.0;
            const int i = dsm.ix(c.x), k = dsm.iz(c.z);
            const bool in = dsm.inside(i, k);
            const size_t n = in ? static_cast<size_t>(k) * nx + i : 0;
            if (in) triDist[t] = dist[n];
            triAbove[t] = static_cast<float>(c.y - dtm.sample(c.x, c.z));
            // (a wall within the core's reach stays only if it rises above the attachment's top: the structure's own facade
            //  continues upward, the attachment's sides and posts end at its roof)
            const double topY = std::max({a.y, b.y, cc.y});
            const bool belowAttachmentTop = in && !std::isnan(dsm.at(i, k)) && topY <= dsm.at(i, k) + 0.3;
            if (in && coreHeight > 0 && lowCell[n] && triAbove[t] > groundTol && triAbove[t] < coreHeight + 0.5 &&
                (std::abs(ny) >= 0.7 || triDist[t] > P.isolateCoreGrow || belowAttachmentTop)) {
                blocked[t] = 1;
                ++lowDropped;
                continue;
            }
            if (in && P.isolateInteriorInset >= 0 && comp[n] == 1 && ny >= 0.9 && triAbove[t] >= P.isolateInteriorMinAbove && inside[n] >= P.isolateInteriorInset &&
                !std::isnan(dsm.at(i, k)) && dsm.at(i, k) - c.y >= P.isolateInteriorBelowTop) {
                interiorCandidates.push_back(static_cast<uint32_t>(t));  // confirmed below by rays straight up
            }
            if (triDist[t] <= P.isolateCoreGrow) keep[t] = 1;
            else if (!P.isolateRebuildGround && triDist[t] <= P.isolateApron && triAbove[t] <= P.isolateApronMaxHeight) keep[t] = 3;
        }
        // an interior floor candidate is dropped only when rays straight up from its centroid and six points toward its corners all hit
        // a kept, flat slab at least isolateInteriorBelowTop above it that is not itself a candidate (a terrace beside a
        // taller wall, a roof under a railing, mast or crown ornament, sees past them and stays)
        if (!interiorCandidates.empty()) {
            std::vector<uint8_t> isCandidate(F, 0);
            for (uint32_t t : interiorCandidates) isCandidate[t] = 1;
            const double bc = 2.0;  // bucket size (m) of the triangles' x/z bounds
            const int bnx = std::max(1, static_cast<int>(std::ceil((bbMax.x - bbMin.x) / bc)) + 1);
            const int bnz = std::max(1, static_cast<int>(std::ceil((bbMax.z - bbMin.z) / bc)) + 1);
            std::vector<std::vector<uint32_t>> bucket(static_cast<size_t>(bnx) * bnz);
            auto bix = [&](double x) { return std::clamp(static_cast<int>(std::floor((x - bbMin.x) / bc)), 0, bnx - 1); };
            auto biz = [&](double z) { return std::clamp(static_cast<int>(std::floor((z - bbMin.z) / bc)), 0, bnz - 1); };
            for (size_t t = 0; t < F; ++t) {
                const V3 a = m.P(m.idx[3 * t]), b = m.P(m.idx[3 * t + 1]), cc = m.P(m.idx[3 * t + 2]);
                for (int bk = biz(std::min({a.z, b.z, cc.z})); bk <= biz(std::max({a.z, b.z, cc.z})); ++bk)
                    for (int bi = bix(std::min({a.x, b.x, cc.x})); bi <= bix(std::max({a.x, b.x, cc.x})); ++bi)
                        bucket[static_cast<size_t>(bk) * bnx + bi].push_back(static_cast<uint32_t>(t));
            }
            auto covered = [&](const V3& p, uint32_t self) {
                for (uint32_t u : bucket[static_cast<size_t>(biz(p.z)) * bnx + bix(p.x)]) {
                    if (u == self || isCandidate[u] || blocked[u] || keep[u] != 1) continue;
                    const V3 a = m.P(m.idx[3 * u]), b = m.P(m.idx[3 * u + 1]), cc = m.P(m.idx[3 * u + 2]);
                    const V3 un = (b - a).cross(cc - a);
                    const double unl = un.norm();
                    if (!(unl > 0) || std::abs(un.y) < 0.9 * unl) continue;  // only a flat slab closes a floor in
                    const double d = (b.x - a.x) * (cc.z - a.z) - (cc.x - a.x) * (b.z - a.z);
                    if (std::abs(d) < 1e-12) continue;
                    const double w1 = ((p.x - a.x) * (cc.z - a.z) - (cc.x - a.x) * (p.z - a.z)) / d;
                    const double w2 = ((b.x - a.x) * (p.z - a.z) - (p.x - a.x) * (b.z - a.z)) / d;
                    if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
                    if (a.y + w1 * (b.y - a.y) + w2 * (cc.y - a.y) >= p.y + P.isolateInteriorBelowTop) return true;
                }
                return false;
            };
            for (uint32_t t : interiorCandidates) {
                const V3 a = m.P(m.idx[3 * t]), b = m.P(m.idx[3 * t + 1]), cc = m.P(m.idx[3 * t + 2]);
                const V3 c = (a + b + cc) * (1.0 / 3.0);
                // centroid, mid-way and near each corner: a long sliver reaching out from under a cover is not closed in
                bool all = covered(c, t);
                for (const V3* v : {&a, &b, &cc}) all = all && covered(c * 0.6 + *v * 0.4, t) && covered(c * 0.1 + *v * 0.9, t);
                if (!all) continue;
                blocked[t] = 1;
                keep[t] = 0;
                ++interiorDropped;
            }
        }
        // 4. closure over mesh connectivity (positions welded on a 1 cm lattice, so chunk seams connect): raised
        //    triangles reached from the structure join it while they stay within reach of the footprint; raised ones
        //    beyond reach are counted (they would be where the isolation cuts a connected surface)
        std::unordered_map<uint64_t, uint32_t> weld;
        weld.reserve(V);
        std::vector<uint32_t> wid(V);
        for (size_t v = 0; v < V; ++v) {
            auto q = [&](double x) { return static_cast<uint64_t>(std::clamp<long long>(std::llround(x * 100.0), -(1LL << 20) + 1, (1LL << 20) - 1) + (1LL << 20)); };
            const uint64_t key = q(rawPos[3 * v]) | (q(rawPos[3 * v + 1]) << 21) | (q(rawPos[3 * v + 2]) << 42);
            wid[v] = weld.emplace(key, static_cast<uint32_t>(weld.size())).first->second;
        }
        const size_t W = weld.size();
        std::vector<uint32_t> off(W + 1, 0), inc(3 * F);
        for (size_t t = 0; t < F; ++t) for (int k = 0; k < 3; ++k) ++off[wid[rawIdx[3 * t + k]] + 1];
        for (size_t w = 0; w < W; ++w) off[w + 1] += off[w];
        {
            std::vector<uint32_t> fill(off.begin(), off.end() - 1);
            for (size_t t = 0; t < F; ++t) for (int k = 0; k < 3; ++k) inc[fill[wid[rawIdx[3 * t + k]]]++] = static_cast<uint32_t>(t);
        }
        std::vector<uint32_t> queue;
        for (size_t t = 0; t < F; ++t) if (keep[t] == 1 && triAbove[t] > groundTol) queue.push_back(static_cast<uint32_t>(t));
        std::vector<uint8_t> cut(F, 0);
        size_t closure = 0, cutContacts = 0;
        for (size_t qi = 0; qi < queue.size(); ++qi) {
            const uint32_t t = queue[qi];
            for (int k = 0; k < 3; ++k) {
                const uint32_t w = wid[rawIdx[3 * t + k]];
                for (uint32_t j = off[w]; j < off[w + 1]; ++j) {
                    const uint32_t u = inc[j];
                    if (keep[u] == 1 || keep[u] == 2 || cut[u] || blocked[u] || !(triAbove[u] > groundTol)) continue;
                    if (triDist[u] <= P.isolateReach) {
                        if (keep[u] == 0) ++closure;
                        keep[u] = 2;  // (an apron triangle that is raised joins the structure)
                        queue.push_back(u);
                    } else {
                        cut[u] = 1;
                        ++cutContacts;
                    }
                }
            }
        }

        // 5. compact the scene to the kept triangles: vertices, materials and the images those materials use
        size_t nCore = 0, nApron = 0;
        std::vector<uint32_t> vmap(V, UINT32_MAX);
        decltype(scene.mesh.vertices) verts;
        std::vector<uint32_t> idx, triMat;
        std::vector<int> matMap(scene.materials.size(), -1);
        std::vector<gltf::SceneMaterial> mats;
        for (size_t t = 0; t < F; ++t) {
            if (!keep[t]) continue;
            nCore += keep[t] == 1;
            nApron += keep[t] == 3;
            for (int k = 0; k < 3; ++k) {
                const uint32_t v = rawIdx[3 * t + k];
                if (vmap[v] == UINT32_MAX) { vmap[v] = static_cast<uint32_t>(verts.size()); verts.push_back(scene.mesh.vertices[v]); }
                idx.push_back(vmap[v]);
            }
            uint32_t mi = rawMat[t];
            if (mi < scene.materials.size()) {
                if (matMap[mi] < 0) { matMap[mi] = static_cast<int>(mats.size()); mats.push_back(scene.materials[mi]); }
                mi = static_cast<uint32_t>(matMap[mi]);
            } else {
                mi = UINT32_MAX;  // no material: the writers fall back to their last / default material
            }
            triMat.push_back(mi);
        }
        if (idx.empty()) { res.error = "isolate: the structure under the anchor has no triangles"; return false; }
        for (auto& mi : triMat) if (mi == UINT32_MAX) mi = mats.empty() ? 0u : static_cast<uint32_t>(mats.size() - 1);

        // 5a. the street around the structure, measured on the scan (the ground patch rests on it; the clip level comes from it)
        std::vector<float> gnd;
        {
            // the street surface under the patch: a grey-scale opening of the scan's top surface over the open cells, so
            // objects narrower than twice the radius (cars, kiosks, street trees) go while a sloped street keeps its slope
            // (an opening reproduces a plane exactly; the coarse terrain model can be metres off on a hill or inside a large block)
            const int rg = std::max(1, static_cast<int>(std::ceil(P.isolateGroundOpeningRadius / dsm.cell)));
            const float nan = std::numeric_limits<float>::quiet_NaN();
            const double reach = P.isolateApron + rg * dsm.cell;
            std::vector<float> ero(N, nan);
            gnd.assign(N, nan);
            auto openCell = [&](size_t n) { return comp[n] == 0 && !std::isnan(dsm.h[n]) && dist[n] <= reach + rg * dsm.cell; };
            for (int k = 0; k < nz; ++k)
                for (int i = 0; i < nx; ++i) {
                    const size_t n = static_cast<size_t>(k) * nx + i;
                    if (!openCell(n) || dist[n] > reach) continue;
                    float lo = std::numeric_limits<float>::infinity();
                    for (int dk = -rg; dk <= rg; ++dk)
                        for (int di = -rg; di <= rg; ++di) {
                            if (!dsm.inside(i + di, k + dk)) continue;
                            const size_t q = static_cast<size_t>(k + dk) * nx + i + di;
                            if (openCell(q)) lo = std::min(lo, dsm.h[q]);
                        }
                    ero[n] = lo;
                }
            for (int k = 0; k < nz; ++k)
                for (int i = 0; i < nx; ++i) {
                    const size_t n = static_cast<size_t>(k) * nx + i;
                    if (comp[n] != 0 || !(dist[n] <= P.isolateApron)) continue;
                    float hi = -std::numeric_limits<float>::infinity();
                    for (int dk = -rg; dk <= rg; ++dk)
                        for (int di = -rg; di <= rg; ++di) {
                            if (!dsm.inside(i + di, k + dk)) continue;
                            const float e = ero[static_cast<size_t>(k + dk) * nx + i + di];
                            if (!std::isnan(e)) hi = std::max(hi, e);
                        }
                    gnd[n] = std::isfinite(hi) ? hi : static_cast<float>(dtm.sample(dsm.cx(i), dsm.cz(k)));
                }
        }

        // 5b. the model ends at street level: surfaces more than the margin below the lowest street around the structure
        //     (10th percentile of the measured street) are clipped there (Sutherland-Hodgman, so a straddling wall is cut,
        //     not dropped, and no hole opens). One level for the whole structure: the coarse terrain model can sit above
        //     the ground inside a large block, and a single level below every surrounding street never cuts a real wall.
        size_t clipDropped = 0, clipCut = 0;
        double clipLevel = std::numeric_limits<double>::quiet_NaN();
        const long trianglesBeforeClip = static_cast<long>(triMat.size());
        if (P.isolateBelowGroundMargin >= 0) {
            using Vtx = typename decltype(verts)::value_type;
            std::vector<float> street;
            for (float g : gnd) if (!std::isnan(g)) street.push_back(g);
            if (street.empty()) for (size_t n = 0; n < N; ++n) if (comp[n] == 1) street.push_back(static_cast<float>(dtm.sample(dsm.cx(static_cast<int>(n % nx)), dsm.cz(static_cast<int>(n / nx)))));
            std::nth_element(street.begin(), street.begin() + street.size() / 10, street.end());
            clipLevel = static_cast<double>(street[street.size() / 10]) - P.isolateBelowGroundMargin;
            auto level = [&](const Vtx& v) { return static_cast<double>(v.position.y) - clipLevel; };
            auto mix = [](const Vtx& p, const Vtx& q, float s) {
                Vtx r = p;
                r.position = p.position + (q.position - p.position) * s;
                r.normal = (p.normal + (q.normal - p.normal) * s).normalized();
                r.uv = p.uv + (q.uv - p.uv) * s;
                r.color = p.color + (q.color - p.color) * s;
                r.tangent = p.tangent + (q.tangent - p.tangent) * s;
                return r;
            };
            std::vector<uint32_t> cIdx, cMat;
            cIdx.reserve(idx.size());
            cMat.reserve(triMat.size());
            for (size_t t = 0; t < triMat.size(); ++t) {
                const uint32_t tv[3] = {idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]};
                double s[3];
                int above = 0;
                for (int k = 0; k < 3; ++k) { s[k] = level(verts[tv[k]]); above += s[k] >= 0; }
                if (above == 3) { cIdx.insert(cIdx.end(), tv, tv + 3); cMat.push_back(triMat[t]); continue; }
                if (above == 0) { ++clipDropped; continue; }
                ++clipCut;
                std::vector<uint32_t> poly;  // the part at or above the level, in the triangle's winding
                for (int k = 0; k < 3; ++k) {
                    const int j = (k + 1) % 3;
                    if (s[k] >= 0) poly.push_back(tv[k]);
                    if ((s[k] >= 0) != (s[j] >= 0)) {
                        const float u = static_cast<float>(s[k] / (s[k] - s[j]));
                        poly.push_back(static_cast<uint32_t>(verts.size()));
                        verts.push_back(mix(verts[tv[k]], verts[tv[j]], u));
                    }
                }
                for (size_t k = 1; k + 1 < poly.size(); ++k) {
                    cIdx.insert(cIdx.end(), {poly[0], poly[k], poly[k + 1]});
                    cMat.push_back(triMat[t]);
                }
            }
            idx = std::move(cIdx);
            triMat = std::move(cMat);
        }
        const long clipDelta = static_cast<long>(triMat.size()) - trianglesBeforeClip;

        // 5c. ground: a patch on the street surface over the open cells within the apron of the footprint (corners shared,
        //     two triangles per cell, facing up), with a neutral material of its own
        size_t groundTris = 0;
        double groundArea = 0;
        if (P.isolateRebuildGround && P.isolateApron > 0) {
            gltf::SceneMaterial ground;
            ground.baseColorFactor = {0.42f, 0.42f, 0.42f, 1.0f};
            ground.metallicFactor = 0.0f;
            ground.roughnessFactor = 0.95f;
            const uint32_t gm = static_cast<uint32_t>(mats.size());
            auto groundAt = [&](int ci, int ck) {  // a patch corner: the mean of the patch cells around it
                double sum = 0;
                int cnt = 0;
                for (int dk = -1; dk <= 0; ++dk)
                    for (int di = -1; di <= 0; ++di) {
                        if (!dsm.inside(ci + di, ck + dk)) continue;
                        const float g = gnd[static_cast<size_t>(ck + dk) * nx + ci + di];
                        if (!std::isnan(g)) { sum += g; ++cnt; }
                    }
                const double x = dsm.x0 + ci * dsm.cell, z = dsm.z0 + ck * dsm.cell;
                return cnt ? sum / cnt : dtm.sample(x, z);
            };
            std::unordered_map<uint64_t, uint32_t> corner;
            auto cornerVertex = [&](int ci, int ck) {
                const uint64_t key = (static_cast<uint64_t>(static_cast<uint32_t>(ck)) << 32) | static_cast<uint32_t>(ci);
                auto it = corner.find(key);
                if (it != corner.end()) return it->second;
                const double x = dsm.x0 + ci * dsm.cell, z = dsm.z0 + ck * dsm.cell;
                typename decltype(verts)::value_type v;
                v.position = {static_cast<float>(x), static_cast<float>(groundAt(ci, ck)), static_cast<float>(z)};
                v.normal = {0.0f, 1.0f, 0.0f};
                v.uv = {static_cast<float>(x * 0.25), static_cast<float>(z * 0.25)};
                const uint32_t id = static_cast<uint32_t>(verts.size());
                verts.push_back(v);
                corner.emplace(key, id);
                return id;
            };
            // the outer edge follows the apron's distance contour (marching squares on the corner distances) instead of
            // whole cells, so it is smooth rather than saw-toothed; a crossing vertex is shared by the two cells of its edge
            auto edgeOf = [&](int ci, int ck) {  // corner value: apron distance minus the apron width (inside: <= 0)
                double sum = 0;
                int cnt = 0;
                for (int dk = -1; dk <= 0; ++dk)
                    for (int di = -1; di <= 0; ++di) {
                        if (!dsm.inside(ci + di, ck + dk)) continue;
                        const size_t q = static_cast<size_t>(ck + dk) * nx + ci + di;
                        sum += comp[q] != 0 ? 0.0 : static_cast<double>(dist[q]);
                        ++cnt;
                    }
                return (cnt ? sum / cnt : 1e9) - P.isolateApron;
            };
            std::unordered_map<uint64_t, uint32_t> crossing;
            auto crossVertex = [&](int ai, int ak, int bi, int bk, double fa, double fb) {
                const uint64_t ka = (static_cast<uint64_t>(static_cast<uint32_t>(ak)) << 32) | static_cast<uint32_t>(ai);
                const uint64_t kb = (static_cast<uint64_t>(static_cast<uint32_t>(bk)) << 32) | static_cast<uint32_t>(bi);
                const uint64_t key = std::min(ka, kb) * 1000003ULL ^ std::max(ka, kb);
                auto it = crossing.find(key);
                if (it != crossing.end()) return it->second;
                const double u = fa / (fa - fb);
                const double x = dsm.x0 + (ai + u * (bi - ai)) * dsm.cell, z = dsm.z0 + (ak + u * (bk - ak)) * dsm.cell;
                typename decltype(verts)::value_type v;
                v.position = {static_cast<float>(x), static_cast<float>(groundAt(ai, ak) * (1 - u) + groundAt(bi, bk) * u), static_cast<float>(z)};
                v.normal = {0.0f, 1.0f, 0.0f};
                v.uv = {static_cast<float>(x * 0.25), static_cast<float>(z * 0.25)};
                const uint32_t id = static_cast<uint32_t>(verts.size());
                verts.push_back(v);
                crossing.emplace(key, id);
                return id;
            };
            for (int k = 0; k < nz; ++k)
                for (int i = 0; i < nx; ++i) {
                    const size_t n = static_cast<size_t>(k) * nx + i;
                    if (comp[n] != 0 || !(dist[n] <= P.isolateApron + 2 * dsm.cell)) continue;
                    // corners in the order that winds with the normal up (+x east, +z south, +y up)
                    const int ci[4] = {i, i, i + 1, i + 1}, ck[4] = {k, k + 1, k + 1, k};
                    double f[4];
                    for (int q = 0; q < 4; ++q) f[q] = edgeOf(ci[q], ck[q]);
                    std::vector<uint32_t> poly;
                    for (int q = 0; q < 4; ++q) {
                        const int r = (q + 1) % 4;
                        if (f[q] <= 0) poly.push_back(cornerVertex(ci[q], ck[q]));
                        if ((f[q] <= 0) != (f[r] <= 0)) poly.push_back(crossVertex(ci[q], ck[q], ci[r], ck[r], f[q], f[r]));
                    }
                    for (size_t q = 1; q + 1 < poly.size(); ++q) {
                        idx.insert(idx.end(), {poly[0], poly[q], poly[q + 1]});
                        triMat.push_back(gm);
                        ++groundTris;
                    }
                }
            if (groundTris) mats.push_back(ground);
            for (size_t t = triMat.size() - groundTris; t < triMat.size(); ++t) {
                const auto& pa = verts[idx[3 * t]].position, &pb = verts[idx[3 * t + 1]].position, &pc = verts[idx[3 * t + 2]].position;
                groundArea += 0.5 * std::abs((pb.x - pa.x) * (pc.z - pa.z) - (pc.x - pa.x) * (pb.z - pa.z));
            }
        }
        if (clipDropped || clipCut) {  // vertices only the clipped-away parts used
            std::vector<uint32_t> remap(verts.size(), UINT32_MAX);
            decltype(verts) used;
            used.reserve(verts.size());
            for (auto& v : idx) {
                if (remap[v] == UINT32_MAX) { remap[v] = static_cast<uint32_t>(used.size()); used.push_back(verts[v]); }
                v = remap[v];
            }
            verts = std::move(used);
        }
        std::vector<int> imgMap(scene.images.size(), -1);
        std::vector<gltf::SceneImage> imgs;
        for (auto& sm : mats)
            for (int* ref : {&sm.baseColorImage, &sm.metallicRoughnessImage, &sm.normalImage, &sm.occlusionImage}) {
                if (*ref < 0 || *ref >= static_cast<int>(scene.images.size())) { *ref = -1; continue; }
                if (imgMap[static_cast<size_t>(*ref)] < 0) {
                    imgMap[static_cast<size_t>(*ref)] = static_cast<int>(imgs.size());
                    imgs.push_back(std::move(scene.images[static_cast<size_t>(*ref)]));
                }
                *ref = imgMap[static_cast<size_t>(*ref)];
            }
        scene.mesh.vertices = std::move(verts);
        scene.mesh.indices = std::move(idx);
        scene.triangleMaterial = std::move(triMat);
        scene.materials = std::move(mats);
        scene.images = std::move(imgs);
        adoptSceneGeometry();
        scene.mesh.bounds = geometry::AABB();
        for (const auto& v : scene.mesh.vertices) scene.mesh.bounds.expand(v.position);
        scene.bounds = scene.mesh.bounds;

        isoGround = dtm.sample(0.5 * (fMinX + fMaxX), 0.5 * (fMinZ + fMaxZ));
        js << "  \"isolate\": {\"enabled\": true, \"anchor\": [" << num(P.anchorX) << "," << num(P.anchorZ) << "], \"minHeight_m\": " << num(P.isolateMinHeight)
           << ", \"apron_m\": " << num(P.isolateApron) << ", \"reach_m\": " << num(P.isolateReach) << ", \"footprintCells\": " << footprintCells
           << ", \"enclosedCells\": " << enclosedCells << ", \"footprintArea_m2\": " << num(static_cast<double>(footprintCells) * dsm.cell * dsm.cell)
           << ", \"footprintBounds\": [" << num(fMinX) << "," << num(fMinZ) << "," << num(fMaxX) << "," << num(fMaxZ) << "], \"groundY\": " << num(isoGround)
           << ", \"topY\": " << num(fTop) << ", \"height_m\": " << num(fTop - isoGround) << ", \"triangles\": {\"input\": " << inputTris << ", \"core\": " << nCore
           << ", \"closure\": " << closure << ", \"apron\": " << nApron << ", \"ground\": " << groundTris << ", \"belowGroundDelta\": " << clipDelta
           << ", \"kept\": " << F << "}, \"cutContacts\": " << cutContacts
           << ", \"lowAttachment\": {\"coreHeight_m\": " << num(coreHeight) << ", \"cells\": " << lowCells << ", \"area_m2\": " << num(static_cast<double>(lowCells) * dsm.cell * dsm.cell)
           << ", \"trianglesDropped\": " << lowDropped << "}, \"interiorFloorsDropped\": " << interiorDropped
           << ", \"belowGround\": {\"margin_m\": " << num(P.isolateBelowGroundMargin) << ", \"clipY\": " << num(clipLevel) << ", \"dropped\": " << clipDropped << ", \"cut\": " << clipCut << "}"
           << ", \"groundPatch\": {\"triangles\": " << groundTris << ", \"area_m2\": " << num(groundArea) << "}"
           << ", \"vertices\": {\"input\": " << inputVerts << ", \"kept\": " << V << "}, \"materials\": {\"input\": " << inputMats << ", \"kept\": " << scene.materials.size()
           << "}, \"images\": {\"input\": " << inputImages << ", \"kept\": " << scene.images.size() << "}, \"boundsMin\": " << vec(bbMin) << ", \"boundsMax\": " << vec(bbMax)
           << ", \"ms\": " << num(std::chrono::duration<double, std::milli>(Clock::now() - t0).count()) << "},\n";
        return true;
    }
    double isoGround{0};

    // ----------------------------------------------------------------------------------------
    // Visibility
    // ----------------------------------------------------------------------------------------
    void buildTerrain() {
        const VisibilityParams& vp = P.vis;
        dsm.init(bbMin.x, bbMin.z, bbMax.x, bbMax.z, vp.dsmCell);
        const MeshView m = rawView();
        for (size_t t = 0; t < F; ++t) {
            const V3 a = m.P(m.idx[3 * t]), b = m.P(m.idx[3 * t + 1]), c = m.P(m.idx[3 * t + 2]);
            const V3 n = (b - a).cross(c - a);
            const double nl = n.norm();
            if (!(nl > 0)) continue;
            const float any = static_cast<float>(std::abs(n.y) / nl);
            for (const V3* p : {&a, &b, &c}) dsm.maxIn(dsm.ix(p->x), dsm.iz(p->z), static_cast<float>(p->y), any);
            const double area2 = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
            if (std::abs(area2) < 1e-9) continue;
            const int i0 = std::max(0, dsm.ix(std::min({a.x, b.x, c.x}))), i1 = std::min(dsm.nx - 1, dsm.ix(std::max({a.x, b.x, c.x})));
            const int k0 = std::max(0, dsm.iz(std::min({a.z, b.z, c.z}))), k1 = std::min(dsm.nz - 1, dsm.iz(std::max({a.z, b.z, c.z})));
            for (int k = k0; k <= k1; ++k) {
                const double z = dsm.cz(k);
                for (int i = i0; i <= i1; ++i) {
                    const double x = dsm.cx(i);
                    const double w0 = ((b.x - x) * (c.z - z) - (c.x - x) * (b.z - z)) / area2;
                    const double w1 = ((c.x - x) * (a.z - z) - (a.x - x) * (c.z - z)) / area2;
                    const double w2 = 1 - w0 - w1;
                    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                    dsm.maxIn(i, k, static_cast<float>(w0 * a.y + w1 * b.y + w2 * c.y), any);
                }
            }
        }
        // DTM: per coarse cell the lowest top surface, then a morphological opening (erosion, dilation)
        dtm.init(bbMin.x, bbMin.z, bbMax.x, bbMax.z, vp.dtmCell);
        const float inf = std::numeric_limits<float>::infinity();
        std::vector<float> lo(dtm.h.size(), inf);
        for (int k = 0; k < dsm.nz; ++k)
            for (int i = 0; i < dsm.nx; ++i) {
                const float v = dsm.at(i, k);
                if (std::isnan(v)) continue;
                const int a = std::clamp(dtm.ix(dsm.cx(i)), 0, dtm.nx - 1), b = std::clamp(dtm.iz(dsm.cz(k)), 0, dtm.nz - 1);
                float& c = lo[static_cast<size_t>(b) * dtm.nx + a];
                c = std::min(c, v);
            }
        const int r = std::max(1, static_cast<int>(std::ceil(vp.dtmOpeningRadius / vp.dtmCell)));
        auto filter = [&](const std::vector<float>& in, bool takeMin) {
            std::vector<float> tmp(in.size()), out(in.size());
            for (int k = 0; k < dtm.nz; ++k)
                for (int i = 0; i < dtm.nx; ++i) {
                    float best = takeMin ? inf : -inf;
                    for (int d = -r; d <= r; ++d) {
                        const int ii = i + d;
                        if (ii < 0 || ii >= dtm.nx) continue;
                        const float v = in[static_cast<size_t>(k) * dtm.nx + ii];
                        if (!std::isfinite(v)) continue;
                        best = takeMin ? std::min(best, v) : std::max(best, v);
                    }
                    tmp[static_cast<size_t>(k) * dtm.nx + i] = best;
                }
            for (int k = 0; k < dtm.nz; ++k)
                for (int i = 0; i < dtm.nx; ++i) {
                    float best = takeMin ? inf : -inf;
                    for (int d = -r; d <= r; ++d) {
                        const int kk = k + d;
                        if (kk < 0 || kk >= dtm.nz) continue;
                        const float v = tmp[static_cast<size_t>(kk) * dtm.nx + i];
                        if (!std::isfinite(v)) continue;
                        best = takeMin ? std::min(best, v) : std::max(best, v);
                    }
                    out[static_cast<size_t>(k) * dtm.nx + i] = best;
                }
            return out;
        };
        std::vector<float> opened = filter(filter(lo, true), false);
        float fallback = inf;
        for (float v : opened) if (std::isfinite(v)) fallback = std::min(fallback, v);
        if (!std::isfinite(fallback)) fallback = static_cast<float>(bbMin.y);
        for (size_t i = 0; i < opened.size(); ++i) dtm.h[i] = std::isfinite(opened[i]) ? opened[i] : fallback;
    }

    void placeSites() {
        const VisibilityParams& vp = P.vis;
        struct Cand { int i, k; };
        std::vector<Cand> ground, roof;
        const double m = vp.siteMargin;
        for (int k = 1; k + 1 < dsm.nz; ++k)
            for (int i = 1; i + 1 < dsm.nx; ++i) {
                const float h = dsm.at(i, k);
                if (std::isnan(h)) continue;
                const double x = dsm.cx(i), z = dsm.cz(k);
                if (x < bbMin.x + m || x > bbMax.x - m || z < bbMin.z + m || z > bbMax.z - m) continue;
                const double above = h - dtm.sample(x, z);
                bool flat = dsm.ny[static_cast<size_t>(k) * dsm.nx + i] >= vp.flatMinNy;
                for (int dk = -1; dk <= 1 && flat; ++dk)
                    for (int di = -1; di <= 1 && flat; ++di) {
                        const float o = dsm.at(i + di, k + dk);
                        flat = !std::isnan(o) && std::abs(o - h) <= vp.flatTolerance;
                    }
                if (!flat) continue;
                if (above < vp.openGroundTolerance) ground.push_back({i, k});
                else if (above >= vp.roofMinHeight) roof.push_back({i, k});
            }
        auto fps = [&](const std::vector<Cand>& cand, int count, bool isRoof) {
            if (cand.empty() || count <= 0) return;
            std::vector<double> d2(cand.size(), 1e300);
            size_t first = 0;
            double best = 1e300;
            for (size_t j = 0; j < cand.size(); ++j) {
                const double dx = dsm.cx(cand[j].i) - P.anchorX, dz = dsm.cz(cand[j].k) - P.anchorZ;
                if (dx * dx + dz * dz < best) { best = dx * dx + dz * dz; first = j; }
            }
            size_t pick = first;
            for (int s = 0; s < count; ++s) {
                const Cand& c = cand[pick];
                sites.push_back({V3{dsm.cx(c.i), static_cast<double>(dsm.at(c.i, c.k)) + vp.eyeHeight, dsm.cz(c.k)}, isRoof});
                double far = -1;
                size_t next = pick;
                for (size_t j = 0; j < cand.size(); ++j) {
                    const double dx = dsm.cx(cand[j].i) - dsm.cx(c.i), dz = dsm.cz(cand[j].k) - dsm.cz(c.k);
                    d2[j] = std::min(d2[j], dx * dx + dz * dz);
                    if (d2[j] > far) { far = d2[j]; next = j; }
                }
                if (far <= 0) break;
                pick = next;
            }
        };
        fps(ground, vp.streetSites, false);
        fps(roof, vp.roofSites, true);
    }

    void computeVisibility() {
        const VisibilityParams& vp = P.vis;
        const auto tv = Clock::now();
        buildTerrain();
        placeSites();
        const double terrainMs = std::chrono::duration<double, std::milli>(Clock::now() - tv).count();
        // cameras
        std::vector<Camera> cams;
        const V3 center{0.5 * (bbMin.x + bbMax.x), 0.0, 0.5 * (bbMin.z + bbMax.z)};
        const double groundY = dtm.sample(center.x, center.z);
        const V3 target{center.x, 0.5 * (groundY + bbMax.y), center.z};
        const double radius = 0.5 * (bbMax - bbMin).norm();
        int aerial = 0;
        for (size_t ring = 0; ring < vp.aerialElevationsDeg.size(); ++ring) {
            const double el = vp.aerialElevationsDeg[ring] * 3.14159265358979323846 / 180.0;
            for (int a = 0; a < vp.aerialAzimuths; ++a) {
                const double az = 2.0 * 3.14159265358979323846 * (a + static_cast<double>(ring) / vp.aerialElevationsDeg.size()) / vp.aerialAzimuths;
                const double D = radius / std::sin(0.5 * vp.aerialFovDeg * 3.14159265358979323846 / 180.0) * 1.02;
                const V3 dir{std::cos(el) * std::sin(az), std::sin(el), std::cos(el) * std::cos(az)};
                cams.push_back(Camera::lookAt(target + dir * D, target, V3{0, 1, 0}, vp.aerialResolution, vp.aerialResolution, vp.aerialFovDeg, 1.0));
                ++aerial;
            }
        }
        if (vp.nadir) {
            Camera c;
            c.ortho = true;
            c.eye = V3{center.x, bbMax.y + 10.0, center.z};
            c.fwd = V3{0, -1, 0};
            c.right = V3{1, 0, 0};
            c.up = V3{0, 0, -1};
            c.W = c.H = vp.nadirResolution;
            c.scale = vp.nadirResolution / std::max(1e-6, std::max(bbMax.x - bbMin.x, bbMax.z - bbMin.z) * 1.01);
            cams.push_back(c);
        }
        // five cube faces per eye: the face looking straight down sees only the ground within an eye height of the eye,
        // which the side faces and the nadir view already cover
        const V3 dirs[5][2] = {{{1, 0, 0}, {0, 1, 0}}, {{-1, 0, 0}, {0, 1, 0}}, {{0, 0, 1}, {0, 1, 0}},
                               {{0, 0, -1}, {0, 1, 0}}, {{0, 1, 0}, {0, 0, -1}}};
        for (const EyeSite& s : sites)
            for (const auto& d : dirs) cams.push_back(Camera::lookAt(s.eye, s.eye + d[0], d[1], vp.cubeResolution, vp.cubeResolution, 90.0, vp.nearPlane));

        // world face normals (unnormalized) and areas
        const MeshView m = rawView();
        std::vector<V3> fn(F);
        std::vector<uint8_t> valid(F, 0);
        for (size_t t = 0; t < F; ++t) {
            const V3 a = m.P(m.idx[3 * t]), b = m.P(m.idx[3 * t + 1]), c = m.P(m.idx[3 * t + 2]);
            fn[t] = (b - a).cross(c - a);
            valid[t] = fn[t].norm() > 1e-12 ? 1 : 0;
        }
        // exact arbiter for sample points the front-most triangles around them do not hide: a ray to the eye against
        // the whole scan (both sides occlude under the two-sided rule, only faces turned to the eye under the single-sided one)
        const auto tb = Clock::now();
        bvhP.resize(V);
        for (size_t v = 0; v < V; ++v) bvhP[v] = m.P(static_cast<uint32_t>(v));
        bvhT.resize(F);
        for (size_t t = 0; t < F; ++t) bvhT[t] = {m.idx[3 * t], m.idx[3 * t + 1], m.idx[3 * t + 2]};
        bvhN = fn;
        bvh.build(bvhP, bvhT, bvhN);
        const double bvhMs = std::chrono::duration<double, std::milli>(Clock::now() - tb).count();
        std::unique_ptr<std::atomic<uint8_t>[]> vis(new std::atomic<uint8_t>[F]);
        for (size_t t = 0; t < F; ++t) vis[t].store(0, std::memory_order_relaxed);
        std::atomic<size_t> byId{0}, byQuery{0}, rayTests{0}, rayOccluded{0};
        std::vector<Raster> rasters(threads);
        const double tol = vp.occluderTolerance;
        const int nPts = std::clamp(vp.samplePoints, 1, 4);
        auto facingOf = [&](const Camera& cam, size_t t) {
            if (cam.ortho) return fn[t].dot(cam.fwd) < 0;
            return fn[t].dot(cam.eye - m.P(m.idx[3 * t])) > 0;
        };
        auto job = [&](const Camera& cam, Raster& R) {
            R.prepare(cam, m, 2);
            // one pass: every valid triangle into the two-sided buffer, front-facing ones into the single-sided buffer too
            R.draw(cam, m, [&](size_t t) { return valid[t] ? (facingOf(cam, t) ? 3 : 1) : 0; });
            for (int rule = 0; rule < 2; ++rule) {
                const bool single = rule == 1;
                const std::vector<int32_t>& ids = R.id[rule];
                size_t marked = 0;
                for (int32_t id : ids) {
                    if (id < 0) continue;
                    if (!vis[static_cast<size_t>(id)].load(std::memory_order_relaxed)) { vis[static_cast<size_t>(id)].store(1, std::memory_order_relaxed); ++marked; }
                }
                byId += marked;
                // exact test of the triangles that won no pixel: sample points against the front-most triangles around them
                size_t queried = 0;
                for (size_t t = 0; t < F; ++t) {
                    if (!valid[t] || vis[t].load(std::memory_order_relaxed)) continue;
                    if (single && !facingOf(cam, t)) continue;
                    const uint32_t ia = m.idx[3 * t], ib = m.idx[3 * t + 1], ic = m.idx[3 * t + 2];
                    const V3 A = m.P(ia), B = m.P(ib), C = m.P(ic);
                    bool seen = false;
                    // a triangle smaller than about a pixel in this view is tested at its centroid only
                    int pts = nPts;
                    {
                        double sx3[3], sy3[3], dd;
                        bool okp = true;
                        const V3* abc[3] = {&A, &B, &C};
                        for (int k = 0; k < 3 && okp; ++k) {
                            const V3 cc = cam.toCamera(*abc[k]);
                            okp = cam.project(cc.x, cc.y, cc.z, sx3[k], sy3[k], dd);
                        }
                        if (okp) {
                            const double ext = std::max(std::max(sx3[0], std::max(sx3[1], sx3[2])) - std::min(sx3[0], std::min(sx3[1], sx3[2])),
                                                        std::max(sy3[0], std::max(sy3[1], sy3[2])) - std::min(sy3[0], std::min(sy3[1], sy3[2])));
                            if (ext < 1.5) pts = 1;
                        }
                    }
                    for (int s = 0; s < pts && !seen; ++s) {
                        V3 q;
                        if (s == 0) q = (A + B + C) * (1.0 / 3.0);
                        else {
                            const V3& main = s == 1 ? A : (s == 2 ? B : C);
                            q = main * (2.0 / 3.0) + ((A + B + C) - main) * (1.0 / 6.0);
                        }
                        const V3 qc = cam.toCamera(q);
                        double sx, sy, d;
                        if (!cam.project(qc.x, qc.y, qc.z, sx, sy, d)) continue;
                        if (sx < 0 || sy < 0 || sx >= cam.W || sy >= cam.H) continue;
                        const int px = static_cast<int>(sx), py = static_cast<int>(sy);
                        V3 dir;
                        double maxT;
                        if (cam.ortho) { dir = cam.fwd * -1.0; maxT = 1e300; }
                        else { dir = cam.eye - q; maxT = dir.norm(); dir = dir * (1.0 / maxT); }
                        int32_t tested[25];
                        int nt = 0;
                        bool occluded = false;
                        const int rr = vp.occluderSearchRadiusPx;
                        for (int dy = -rr; dy <= rr && !occluded; ++dy)
                            for (int dx = -rr; dx <= rr && !occluded; ++dx) {
                                const int x = px + dx, y = py + dy;
                                if (x < 0 || y < 0 || x >= cam.W || y >= cam.H) continue;
                                const int32_t o = ids[static_cast<size_t>(y) * cam.W + x];
                                if (o < 0 || static_cast<size_t>(o) == t) continue;
                                bool dup = false;
                                for (int j = 0; j < nt; ++j) dup = dup || tested[j] == o;
                                if (dup) continue;
                                tested[nt++] = o;
                                const double h = rayTriangle(q, dir, m.P(m.idx[3 * o]), m.P(m.idx[3 * o + 1]), m.P(m.idx[3 * o + 2]));
                                if (h > tol && h < maxT) occluded = true;
                            }
                        if (!occluded) {
                            const double far = cam.ortho ? 1e5 : maxT;
                            occluded = single ? bvh.anyFront(q, dir, tol, far) : bvh.anyHit(q, dir, tol, far);
                            ++rayTests;
                            if (occluded) ++rayOccluded;
                        }
                        if (!occluded) seen = true;
                    }
                    if (seen) { vis[t].store(1, std::memory_order_relaxed); ++queried; }
                }
                byQuery += queried;
            }
        };
        auto render = [&](const std::vector<Camera>& cs) {
            // biggest images first
            std::vector<size_t> order(cs.size());
            std::iota(order.begin(), order.end(), 0);
            std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return cs[a].W * cs[a].H > cs[b].W * cs[b].H; });
            scan_rectifier::detail::parallelFor(order.size(), threads, 1, [&](size_t b0, size_t b1, unsigned th) {
                for (size_t i = b0; i < b1; ++i) job(cs[order[i]], rasters[th]);
            });
        };
        const auto tr = Clock::now();
        render(cams);
        const double rasterMs = std::chrono::duration<double, std::milli>(Clock::now() - tr).count();

        // Targeted eyes: every wall still unseen walks along its horizontal normal over the DSM; when it reaches open ground
        // before anything at least as tall as itself stands in the way, an eye on that ground (middle of the open run)
        // would face it. Eyes are pooled per targetCell block; the blocks serving the most missed area are rendered.
        const auto tt = Clock::now();
        size_t targeted = 0, targetCandidates = 0;
        double targetCandidateArea = 0;
        for (int round = 0; round < vp.targetRounds && vp.targetedEyes > 0; ++round) {
            struct Block { double ax{0}, az{0}, ay{0}, area{0}, bestArea{0}; V3 best, look; };
            std::unordered_map<int64_t, Block> blocks;
            const double step = dsm.cell;
            size_t cand = 0;
            double candArea = 0;
            for (size_t t = 0; t < F; ++t) {
                if (!valid[t] || vis[t].load(std::memory_order_relaxed)) continue;
                const double nl = fn[t].norm();
                const V3 n = fn[t] * (1.0 / nl);
                const double hl = std::sqrt(n.x * n.x + n.z * n.z);
                if (std::abs(n.y) > vp.targetMaxAbsNy || hl < 1e-6) continue;
                const V3 c = (m.P(m.idx[3 * t]) + m.P(m.idx[3 * t + 1]) + m.P(m.idx[3 * t + 2])) * (1.0 / 3.0);
                const double dx = n.x / hl, dz = n.z / hl;
                double s0 = -1, s1 = -1;
                for (double sd = step; sd <= vp.targetReach; sd += step) {
                    const double x = c.x + dx * sd, z = c.z + dz * sd;
                    const int i = dsm.ix(x), k = dsm.iz(z);
                    if (!dsm.inside(i, k)) break;
                    const float h = dsm.at(i, k);
                    if (std::isnan(h)) { if (s0 >= 0) break; continue; }
                    const bool open = h - dtm.sample(x, z) < vp.openGroundTolerance;
                    if (s0 < 0) {
                        if (open) s0 = s1 = sd;
                        else if (sd > 2.0 * step && h > c.y + 0.5) break;  // something as tall as this point stands in front
                    } else {
                        if (!open) break;
                        s1 = sd;
                        if (s1 - s0 >= vp.targetStreetDepth) break;
                    }
                }
                if (s0 < 0) continue;
                const double sd = 0.5 * (s0 + s1), area = 0.5 * nl;
                const double x = c.x + dx * sd, z = c.z + dz * sd;
                const int i = dsm.ix(x), k = dsm.iz(z);
                if (!dsm.inside(i, k) || std::isnan(dsm.at(i, k))) continue;
                const double gy = dsm.at(i, k);
                ++cand;
                candArea += area;
                Block& b = blocks[scan_rectifier::detail::cellKey(static_cast<int64_t>(std::floor(x / vp.targetCell)), 0, static_cast<int64_t>(std::floor(z / vp.targetCell)))];
                b.ax += x * area; b.az += z * area; b.ay += gy * area; b.area += area;
                b.look += V3{-dx, 0, -dz} * area;
                if (area > b.bestArea) { b.bestArea = area; b.best = V3{x, gy, z}; }
            }
            if (round == 0) { targetCandidates = cand; targetCandidateArea = candArea; }
            std::vector<std::pair<int64_t, const Block*>> ranked;
            for (const auto& kv : blocks) if (kv.second.area >= vp.targetMinArea) ranked.push_back({kv.first, &kv.second});
            std::sort(ranked.begin(), ranked.end(), [](const auto& a, const auto& b) { return a.second->area != b.second->area ? a.second->area > b.second->area : a.first < b.first; });
            if (ranked.size() > static_cast<size_t>(vp.targetedEyes)) ranked.resize(static_cast<size_t>(vp.targetedEyes));
            if (ranked.empty()) break;
            std::vector<Camera> tcams;
            for (const auto& rb : ranked) {
                const Block& b = *rb.second;
                V3 g{b.ax / b.area, b.ay / b.area, b.az / b.area};
                // the pooled position must itself be open ground; otherwise the eye stands where the block's largest
                // contributor put it
                const int i = dsm.ix(g.x), k = dsm.iz(g.z);
                if (!dsm.inside(i, k) || std::isnan(dsm.at(i, k)) || dsm.at(i, k) - dtm.sample(g.x, g.z) >= vp.openGroundTolerance) g = b.best;
                else g.y = dsm.at(i, k);
                const V3 eye{g.x, g.y + vp.eyeHeight, g.z};
                sites.push_back({eye, false, true});
                // one wide view toward the walls it serves, pitched up (they rise above the eye)
                V3 look = b.look;
                look.y = 0;
                const double ll = look.norm();
                look = ll > 1e-9 ? look * (1.0 / ll) : V3{1, 0, 0};
                const double pitch = vp.targetPitchDeg * 3.14159265358979323846 / 180.0;
                const V3 fwd{look.x * std::cos(pitch), std::sin(pitch), look.z * std::cos(pitch)};
                tcams.push_back(Camera::lookAt(eye, eye + fwd, V3{0, 1, 0}, vp.targetResolution, vp.targetResolution, vp.targetFovDeg, vp.nearPlane));
                ++targeted;
            }
            cams.insert(cams.end(), tcams.begin(), tcams.end());
            render(tcams);
        }
        const double targetMs = std::chrono::duration<double, std::milli>(Clock::now() - tt).count();
        const auto tf = Clock::now();
        visible.assign(F, 0);
        size_t nVisible = 0, nDegenerate = 0;
        for (size_t t = 0; t < F; ++t) {
            // degenerate triangles carry no area: they stay (the rectifier's own guards handle them)
            visible[t] = (vis[t].load() || !valid[t]) ? 1 : 0;
        }
        // Surface continuity: a hidden triangle with visible neighbours across at least two of its edges is a pinhole in a
        // seen surface (a sliver or a dimple the sparse views could not resolve), not part of an enclosed shell: it stays.
        size_t holeFilled = 0;
        if (vp.fillMinVisibleNeighbours > 0) {
            std::vector<uint32_t> wid(V);
            {
                std::vector<uint32_t> order(V);
                std::iota(order.begin(), order.end(), 0u);
                auto key = [&](uint32_t v) { return std::array<float, 3>{rawPos[3 * v], rawPos[3 * v + 1], rawPos[3 * v + 2]}; };
                std::sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return key(a) < key(b); });
                uint32_t id = 0;
                for (size_t i = 0; i < V; ++i) { if (i && key(order[i]) != key(order[i - 1])) ++id; wid[order[i]] = id; }
            }
            std::vector<std::pair<uint64_t, uint32_t>> half;
            half.reserve(F * 3);
            for (size_t t = 0; t < F; ++t)
                for (int k = 0; k < 3; ++k) {
                    const uint32_t a = wid[m.idx[3 * t + k]], b = wid[m.idx[3 * t + (k + 1) % 3]];
                    if (a != b) half.push_back({(static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b), static_cast<uint32_t>(t)});
                }
            std::sort(half.begin(), half.end());
            for (int pass = 0; pass < vp.fillPasses; ++pass) {
                std::vector<uint8_t> count(F, 0);
                for (size_t i = 0; i < half.size();) {
                    size_t e = i;
                    while (e < half.size() && half[e].first == half[i].first) ++e;
                    bool anyVisible = false;
                    for (size_t j = i; j < e; ++j) anyVisible = anyVisible || visible[half[j].second];
                    if (anyVisible)
                        for (size_t j = i; j < e; ++j) {
                            const uint32_t t = half[j].second;
                            if (visible[t]) continue;
                            // a neighbour across this edge other than t itself is visible
                            bool other = false;
                            for (size_t q = i; q < e; ++q) other = other || (half[q].second != t && visible[half[q].second]);
                            if (other && count[t] < 3) ++count[t];
                        }
                    i = e;
                }
                size_t filled = 0;
                for (size_t t = 0; t < F; ++t) if (!visible[t] && count[t] >= vp.fillMinVisibleNeighbours) { visible[t] = 1; ++filled; }
                holeFilled += filled;
                if (!filled) break;
            }
        }
        for (size_t t = 0; t < F; ++t) {
            nVisible += visible[t];
            nDegenerate += valid[t] ? 0 : 1;
        }
        const double fillMs = std::chrono::duration<double, std::milli>(Clock::now() - tf).count();
        js << "  \"visibility\": {\"method\": \"rasterized triangle-ID buffers + exact sample-point test\", \"aerialViews\": " << aerial
           << ", \"nadirViews\": " << (vp.nadir ? 1 : 0) << ", \"streetEyes\": " << std::count_if(sites.begin(), sites.end(), [](const EyeSite& s) { return !s.roof && !s.targeted; })
           << ", \"roofEyes\": " << std::count_if(sites.begin(), sites.end(), [](const EyeSite& s) { return s.roof; })
           << ", \"targetedEyes\": " << targeted << ", \"targetCandidates\": " << targetCandidates << ", \"targetCandidateArea_m2\": " << num(targetCandidateArea)
           << ", \"views\": " << (aerial + (vp.nadir ? 1 : 0) + static_cast<int>(sites.size())) << ", \"rasterImages\": " << cams.size() * 2
           << ", \"terrainMs\": " << num(terrainMs) << ", \"bvhMs\": " << num(bvhMs) << ", \"rasterAndTestMs\": " << num(rasterMs) << ", \"targetedMs\": " << num(targetMs) << ", \"pinholeFillMs\": " << num(fillMs) << ", \"visibleTriangles\": " << nVisible << ", \"hiddenTriangles\": " << (F - nVisible)
           << ", \"degenerateKept\": " << nDegenerate << ", \"markedByIdBuffer\": " << byId.load() << ", \"markedByExactTest\": " << byQuery.load() << ", \"exactRayTests\": " << rayTests.load() << ", \"exactRaysOccluded\": " << rayOccluded.load() << ", \"keptAsSurfacePinholes\": " << holeFilled;
        if (P.referenceVisibility.size() == F) {
            size_t bothVis = 0, bothHid = 0, rasterOnly = 0, refOnly = 0;
            double refOnlyArea = 0;
            for (size_t t = 0; t < F; ++t) {
                const bool a = visible[t] != 0, b = P.referenceVisibility[t] != 0;
                if (a && b) ++bothVis; else if (!a && !b) ++bothHid; else if (a) ++rasterOnly; else { ++refOnly; refOnlyArea += 0.5 * fn[t].norm(); }
            }
            if (const char* dump = std::getenv("SB_DUMP_VISIBILITY")) {
                // diagnostics: per triangle centroid xyz, unit normal xyz, area, visible here, visible in the reference
                std::vector<float> rows(F * 9);
                for (size_t t = 0; t < F; ++t) {
                    const V3 c = (m.P(m.idx[3 * t]) + m.P(m.idx[3 * t + 1]) + m.P(m.idx[3 * t + 2])) * (1.0 / 3.0);
                    const V3 n = fn[t].normalized();
                    const float r[9] = {(float)c.x, (float)c.y, (float)c.z, (float)n.x, (float)n.y, (float)n.z, (float)(0.5 * fn[t].norm()), (float)visible[t], (float)(P.referenceVisibility[t] != 0)};
                    std::memcpy(rows.data() + 9 * t, r, sizeof r);
                }
                std::vector<uint8_t> bytes(rows.size() * 4);
                std::memcpy(bytes.data(), rows.data(), bytes.size());
                writeFile(dump, bytes);
            }
            js << ", \"vsReference\": {\"bothVisible\": " << bothVis << ", \"bothHidden\": " << bothHid << ", \"visibleOnlyHere\": " << rasterOnly
               << ", \"visibleOnlyInReference\": " << refOnly << ", \"visibleOnlyInReferenceArea_m2\": " << num(refOnlyArea) << "}";
        }
        if (const char* dir = std::getenv("SB_DEBUG_VIS_RENDER")) {
            // diagnostics: the raw scan in clay, red = hidden here but visible in the reference, blue = the opposite;
            // triangles hidden in both are not drawn
            std::vector<math::Vec3> colours(F, math::Vec3(0.55f, 0.57f, 0.60f));
            RenderMesh rm = rawRenderMesh();
            RenderMesh shown;
            std::vector<math::Vec3> shownCol;
            shown.pos = rm.pos;
            for (size_t t = 0; t < F; ++t) {
                const bool a = visible[t] != 0, b = P.referenceVisibility.size() == F ? P.referenceVisibility[t] != 0 : a;
                if (!a && !b) continue;
                for (int k = 0; k < 3; ++k) shown.idx.push_back(rm.idx[3 * t + k]);
                for (int k = 0; k < 6; ++k) shown.uv.push_back(rm.uv[6 * t + k]);
                shown.mat.push_back(rm.mat[t]);
                shownCol.push_back(a && b ? math::Vec3(0.55f, 0.57f, 0.60f) : (b ? math::Vec3(1.0f, 0.1f, 0.1f) : math::Vec3(0.1f, 0.3f, 1.0f)));
            }
            tint = &shownCol;
            std::filesystem::create_directories(dir);
            const V3 ctr{0.5 * (bbMin.x + bbMax.x), 0, 0.5 * (bbMin.z + bbMax.z)};
            const double gy = dtm.sample(ctr.x, ctr.z);
            int shot = 0;
            for (double az : {0.3, 1.9, 3.5, 5.1}) {
                for (double el : {0.35, 0.9}) {
                    const V3 d{std::cos(el) * std::sin(az), std::sin(el), std::cos(el) * std::cos(az)};
                    const V3 tgt{P.anchorX, gy + 60.0, P.anchorZ};
                    const Camera cam = Camera::lookAt(tgt + d * 420.0, tgt, V3{0, 1, 0}, 960, 640, 50.0, 1.0);
                    texture::ImageBuffer img(960, 640, 3);
                    renderInto(shown, cam, true, img, 0, 0);
                    writeFile((std::filesystem::path(dir) / ("vis_" + std::to_string(shot++) + ".png")).string(), texture::encodePng(img));
                }
            }
            // street level: open-ground points around the anchor (not the eyes), four horizontal views each, 2x2
            int street = 0;
            for (int j = 0; j < 400 && street < 8; ++j) {
                const double a = 2.399963 * j, r = 25.0 + 4.0 * j;
                const double x = P.anchorX + r * std::cos(a), z = P.anchorZ + r * std::sin(a);
                const int i = dsm.ix(x), k = dsm.iz(z);
                if (!dsm.inside(i, k) || std::isnan(dsm.at(i, k)) || dsm.at(i, k) - dtm.sample(x, z) >= P.vis.openGroundTolerance) continue;
                const V3 eye{x, dsm.at(i, k) + P.vis.eyeHeight, z};
                texture::ImageBuffer img(1280, 960, 3);
                for (int q = 0; q < 4; ++q) {
                    const double az = q * 1.5707963;
                    const V3 d{std::sin(az), 0.35, std::cos(az)};
                    renderInto(shown, Camera::lookAt(eye, eye + d, V3{0, 1, 0}, 640, 480, 90.0, 0.2), true, img, (q % 2) * 640, (q / 2) * 480);
                }
                writeFile((std::filesystem::path(dir) / ("street_" + std::to_string(street++) + ".png")).string(), texture::encodePng(img));
            }
            tint = nullptr;
        }
        js << ", \"sites\": [";
        for (size_t i = 0; i < sites.size(); ++i) js << (i ? "," : "") << vec(sites[i].eye);
        js << "]},\n";
    }

    // ----------------------------------------------------------------------------------------
    // Rectifier checks; then the rectified, culled scan replaces the scene's geometry
    // ----------------------------------------------------------------------------------------
    void rectifyChecksAndApply() {
        const auto& S = rect.stats;
        const std::vector<float>& out = rect.positions;
        size_t hidden = 0, dropped = 0;
        keptTris.clear();
        for (size_t t = 0; t < F; ++t) {
            if (rect.flags[t] == scan_rectifier::kFlagKeep) keptTris.push_back(static_cast<uint32_t>(t));
            else if (rect.flags[t] == scan_rectifier::kFlagHidden) ++hidden;
            else ++dropped;
        }
        // displacement over the kept vertices, flips over the kept triangles
        std::vector<uint8_t> used(V, 0);
        for (uint32_t t : keptTris) for (int k = 0; k < 3; ++k) used[rawIdx[3 * t + k]] = 1;
        std::vector<double> disp, moved;
        for (size_t v = 0; v < V; ++v) {
            if (!used[v]) continue;
            const V3 a{rawPos[3 * v], rawPos[3 * v + 1], rawPos[3 * v + 2]}, b{out[3 * v], out[3 * v + 1], out[3 * v + 2]};
            const double d = (b - a).norm();
            disp.push_back(d);
            if (d > 1e-6) moved.push_back(d);
        }
        size_t flips = 0, collapsed = 0;
        auto P3 = [](const std::vector<float>& p, uint32_t v) { return V3{p[3 * v], p[3 * v + 1], p[3 * v + 2]}; };
        for (uint32_t t : keptTris) {
            const uint32_t a = rawIdx[3 * t], b = rawIdx[3 * t + 1], c = rawIdx[3 * t + 2];
            const V3 n0 = (P3(rawPos, b) - P3(rawPos, a)).cross(P3(rawPos, c) - P3(rawPos, a));
            const V3 n1 = (P3(out, b) - P3(out, a)).cross(P3(out, c) - P3(out, a));
            if (n0.norm() < 2e-8) continue;  // input slivers carry no orientation
            if (n1.norm() < 2e-8) { ++collapsed; continue; }
            if (n0.dot(n1) < 0) {
                ++flips;
                if (std::getenv("SB_DEBUG_FLIPS"))
                    std::fprintf(stderr, "rectify flip: tri %u area %.3g -> %.3g at (%.2f %.2f %.2f)\n", t, 0.5 * n0.norm(), 0.5 * n1.norm(), rawPos[3 * a], rawPos[3 * a + 1], rawPos[3 * a + 2]);
            }
        }
        // open edges: raw input, raw kept set, rectified kept set
        std::vector<V3> rp(V), op(V);
        for (size_t v = 0; v < V; ++v) { rp[v] = P3(rawPos, static_cast<uint32_t>(v)); op[v] = P3(out, static_cast<uint32_t>(v)); }
        std::vector<std::array<uint32_t, 3>> allT(F), keptT;
        for (size_t t = 0; t < F; ++t) allT[t] = {rawIdx[3 * t], rawIdx[3 * t + 1], rawIdx[3 * t + 2]};
        for (uint32_t t : keptTris) keptT.push_back(allT[t]);
        OpenEdgeStats eRaw, eRawKept, eRect;
        {
            const unsigned th3 = std::max(1u, threads / 3);
            std::thread a([&]() { eRaw = openEdgeCensus(rp, allT, nullptr, nullptr, nullptr, 0.1, th3); });
            std::thread b([&]() { eRawKept = openEdgeCensus(rp, keptT, nullptr, nullptr, nullptr, 0.0, th3); });  // counts only
            eRect = openEdgeCensus(op, keptT, &rectBoundary, nullptr, nullptr, 0.1, th3);
            a.join(); b.join();
        }
        rawInputEdges = eRaw;
        // plane RMS of the hero's planar regions (raw vs rectified), each region fitted on its own vertices
        std::string heroJson = heroPlaneRms(op);
        // region of interest: the anchor's footprint grown by roiRadius (or a square around the anchor)
        if (S.heroFound) {
            roiMinX = S.heroMinX - P.roiRadius; roiMaxX = S.heroMaxX + P.roiRadius;
            roiMinZ = S.heroMinZ - P.roiRadius; roiMaxZ = S.heroMaxZ + P.roiRadius;
        } else {
            roiMinX = P.anchorX - P.roiRadius; roiMaxX = P.anchorX + P.roiRadius;
            roiMinZ = P.anchorZ - P.roiRadius; roiMaxZ = P.anchorZ + P.roiRadius;
        }
        roiEnabled = P.roiRadius >= 0 && !P.isolate;  // isolated: the whole structure is the region of interest

        js << "  \"triangles\": {\"input\": " << F << ", \"hidden\": " << hidden << ", \"droppedDegenerate\": " << dropped << ", \"kept\": " << keptTris.size() << "},\n";
        js << "  \"rectify\": {\"displacementAll_m\": " << dist(Distribution::of(disp)) << ", \"displacementMoved_m\": " << dist(Distribution::of(moved))
           << ", \"flips\": " << flips << ", \"collapsedToZeroArea\": " << collapsed << ", \"movedGroups\": " << S.movedGroups
           << ", \"wallRegions\": " << S.wallRegions << ", \"roofRegions\": " << S.roofRegions << ", \"snapped\": {\"plane\": " << S.snappedGroups1
           << ", \"line\": " << S.snappedGroups2 << ", \"point\": " << S.snappedGroups3 << "}, \"guardReverted\": " << S.guardReverted
           << ", \"seamContacts\": " << S.seamContacts << ", \"seamSolves\": " << S.seamSolves << ", \"seamMaxResidual_m\": " << num(S.seamMaxResidual)
           << ", \"stitchSamples\": " << S.stitchSamples << ", \"stitchedGroups\": " << S.stitchedGroups << ", \"stitchHeld\": " << S.stitchHeld
           << ", \"seamGapHistogramEdges_m\": [0, 0.001, 0.005, 0.01, 0.03, 0.1], \"seamGapHistogramBefore\": [";
        for (size_t i = 0; i < 6; ++i) js << (i ? "," : "") << S.gapHistogramBefore[i];
        js << "], \"seamGapHistogramAfter\": [";
        for (size_t i = 0; i < 6; ++i) js << (i ? "," : "") << S.gapHistogramAfter[i];
        js << "], \"hero\": " << heroJson << "},\n";
        js << "  \"roi\": {\"enabled\": " << (roiEnabled ? "true" : "false") << ", \"wholeIsolatedStructure\": " << (P.isolate ? "true" : "false") << ", \"fromFootprint\": " << (S.heroFound ? "true" : "false") << ", \"minX\": " << num(roiMinX)
           << ", \"maxX\": " << num(roiMaxX) << ", \"minZ\": " << num(roiMinZ) << ", \"maxZ\": " << num(roiMaxZ) << "},\n";
        js << "  \"openEdges\": {\"rawInput\": " << edges(eRaw) << ",\n    \"rawKept\": " << edges(eRawKept) << ",\n    \"rectified\": " << edges(eRect) << ",\n";

        // the rectified, culled scan replaces the scene geometry (vertex order and attributes unchanged)
        for (size_t v = 0; v < V; ++v) {
            auto& p = scene.mesh.vertices[v].position;
            p.x = out[3 * v]; p.y = out[3 * v + 1]; p.z = out[3 * v + 2];
        }
        std::vector<uint32_t> idx;
        std::vector<uint32_t> mat;
        idx.reserve(keptTris.size() * 3);
        mat.reserve(keptTris.size());
        for (uint32_t t : keptTris) {
            for (int k = 0; k < 3; ++k) idx.push_back(rawIdx[3 * t + k]);
            mat.push_back(rawMat[t]);
        }
        scene.mesh.indices = std::move(idx);
        scene.triangleMaterial = std::move(mat);
    }

    std::vector<Segment> rectBoundary;
    // the raw scan's ray-query structure (visibility; reused to pick thumbnail eyes)
    std::vector<V3> bvhP, bvhN;
    std::vector<std::array<uint32_t, 3>> bvhT;
    scan_rectifier::SidedBvh bvh;
    OpenEdgeStats rawInputEdges;
    V3 heroFacadeCentroid, heroFacadeNormal;
    double heroFacadeArea{0};

    std::string heroPlaneRms(const std::vector<V3>& op) {
        const auto& S = rect.stats;
        if (!S.heroFound || rect.triangleRegion.size() != F) return "{\"found\": false}";
        const double minX = S.heroMinX - 2, maxX = S.heroMaxX + 2, minZ = S.heroMinZ - 2, maxZ = S.heroMaxZ + 2;
        const size_t R = rect.regionPlanes.size();
        std::vector<V3> csum(R), nsum(R);
        std::vector<double> area(R, 0);
        std::vector<std::vector<uint32_t>> verts(R);
        for (uint32_t t : keptTris) {
            const int32_t r = rect.triangleRegion[t];
            if (r < 0) continue;
            const uint32_t a = rawIdx[3 * t], b = rawIdx[3 * t + 1], c = rawIdx[3 * t + 2];
            const V3 A{rawPos[3 * a], rawPos[3 * a + 1], rawPos[3 * a + 2]}, B{rawPos[3 * b], rawPos[3 * b + 1], rawPos[3 * b + 2]}, C{rawPos[3 * c], rawPos[3 * c + 1], rawPos[3 * c + 2]};
            const V3 n = (B - A).cross(C - A);
            const double ar = 0.5 * n.norm();
            area[r] += ar;
            csum[r] += (A + B + C) * (ar / 3.0);
            nsum[r] += n;
            for (int k = 0; k < 3; ++k) verts[r].push_back(rawIdx[3 * t + k]);
        }
        auto fitRms = [](const std::vector<V3>& pts) {
            V3 c;
            for (const V3& p : pts) c += p;
            c = c * (1.0 / static_cast<double>(pts.size()));
            double A[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
            for (const V3& p : pts) {
                const V3 d = p - c;
                const double v[3] = {d.x, d.y, d.z};
                for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) A[i][j] += v[i] * v[j];
            }
            double ev[3];
            V3 vecs[3];
            scan_rectifier::detail::symmetricEigen3(A, ev, vecs);
            int k = 0;
            for (int i = 1; i < 3; ++i) if (ev[i] < ev[k]) k = i;
            const V3 n = vecs[k].normalized();
            double s = 0;
            for (const V3& p : pts) { const double d = (p - c).dot(n); s += d * d; }
            return std::sqrt(s / static_cast<double>(pts.size()));
        };
        double wBefore = 0, wAfter = 0, wArea = 0, wallArea = 0;
        size_t count = 0;
        struct Row { double area, before, after; int cls; };
        std::vector<Row> rows;
        for (size_t r = 0; r < R; ++r) {
            if (area[r] <= 0) continue;
            const V3 c = csum[r] * (1.0 / area[r]);
            if (c.x < minX || c.x > maxX || c.z < minZ || c.z > maxZ) continue;
            auto& vv = verts[r];
            std::sort(vv.begin(), vv.end());
            vv.erase(std::unique(vv.begin(), vv.end()), vv.end());
            if (vv.size() < 4) continue;
            std::vector<V3> before, after;
            for (uint32_t v : vv) { before.push_back(V3{rawPos[3 * v], rawPos[3 * v + 1], rawPos[3 * v + 2]}); after.push_back(op[v]); }
            const double rb = fitRms(before), ra = fitRms(after);
            const int cls = static_cast<int>(rect.regionPlanes[r][0]);
            rows.push_back({area[r], rb, ra, cls});
            wBefore += area[r] * rb * rb;
            wAfter += area[r] * ra * ra;
            wArea += area[r];
            ++count;
            if (cls == 0 && area[r] > heroFacadeArea) {
                heroFacadeArea = area[r];
                heroFacadeCentroid = c;
                heroFacadeNormal = nsum[r].normalized();
            }
            if (cls == 0) wallArea += area[r];
        }
        std::sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) { return a.area > b.area; });
        std::ostringstream o;
        o << "{\"found\": true, \"bounds\": [" << num(S.heroMinX) << "," << num(S.heroMinZ) << "," << num(S.heroMaxX) << "," << num(S.heroMaxZ)
          << "], \"maxHeight_m\": " << num(S.heroMaxHeight) << ", \"planarRegions\": " << count << ", \"regionArea_m2\": " << num(wArea)
          << ", \"wallArea_m2\": " << num(wallArea) << ", \"planeRmsBefore_m\": " << num(wArea > 0 ? std::sqrt(wBefore / wArea) : 0)
          << ", \"planeRmsAfter_m\": " << num(wArea > 0 ? std::sqrt(wAfter / wArea) : 0) << ", \"largest\": [";
        for (size_t i = 0; i < std::min<size_t>(5, rows.size()); ++i)
            o << (i ? "," : "") << "{\"area_m2\": " << num(rows[i].area) << ", \"class\": \"" << (rows[i].cls == 0 ? "wall" : "roof") << "\", \"rmsBefore_m\": "
              << num(rows[i].before) << ", \"rmsAfter_m\": " << num(rows[i].after) << "}";
        o << "]}";
        return o.str();
    }

    /** Without relief: the rectified, culled scan as a welded output mesh (no re-tessellation). */
    photometric_relief::ReliefMesh passThroughMesh() const {
        photometric_relief::ReliefMesh m;
        std::unordered_map<uint64_t, uint32_t> weld;
        std::vector<uint32_t> map(V, UINT32_MAX);
        const auto& verts = scene.mesh.vertices;
        auto id = [&](uint32_t v) {
            if (map[v] != UINT32_MAX) return map[v];
            const auto& p = verts[v].position;
            uint32_t bx, by, bz;
            std::memcpy(&bx, &p.x, 4); std::memcpy(&by, &p.y, 4); std::memcpy(&bz, &p.z, 4);
            const uint64_t k = (static_cast<uint64_t>(bx) * 0x9E3779B97F4A7C15ull) ^ (static_cast<uint64_t>(by) * 0xC2B2AE3D27D4EB4Full) ^ (static_cast<uint64_t>(bz) << 1);
            auto it = weld.find(k);
            if (it == weld.end()) {
                it = weld.emplace(k, static_cast<uint32_t>(m.positions.size())).first;
                m.positions.push_back(photometric_relief::P3(p.x, p.y, p.z));
                m.heights.push_back(0.0f);
                m.positionRegion.push_back(-1);
            }
            return map[v] = it->second;
        };
        const auto& idx = scene.mesh.indices;
        for (size_t t = 0; t < idx.size() / 3; ++t) {
            photometric_relief::OutputTriangle o;
            for (int k = 0; k < 3; ++k) {
                const uint32_t v = idx[3 * t + k];
                o.p[k] = id(v);
                o.uv[k][0] = verts[v].uv.x;
                o.uv[k][1] = verts[v].uv.y;
            }
            o.material = scene.triangleMaterial[t];
            o.region = -1;
            o.parent = static_cast<uint32_t>(t);
            m.triangles.push_back(o);
        }
        return m;
    }

    // ----------------------------------------------------------------------------------------
    // Final checks
    // ----------------------------------------------------------------------------------------
    void finalChecks(const photometric_relief::ReliefMesh& m) {
        const auto& verts = scene.mesh.vertices;
        const auto& idx = scene.mesh.indices;
        // Orientation: the relief is a height field over each treated region's plane, so a treated triangle folds over only
        // when its normal turns against the region normal; an untreated (possibly re-triangulated) one when it turns against
        // its parent. Reveal faces (the near-vertical sides of a recess) can tilt past the parent's own plane when the parent
        // lies a few degrees off the region plane: they are counted separately, they are not folds.
        std::unordered_map<int, V3> regionNormal;
        for (const auto& f : relief.facades) regionNormal[f.id] = V3{f.normal.x, f.normal.y, f.normal.z};
        size_t flips = 0, checked = 0, revealsPastParent = 0;
        for (const auto& t : m.triangles) {
            const V3 a{m.positions[t.p[0]].x, m.positions[t.p[0]].y, m.positions[t.p[0]].z};
            const V3 b{m.positions[t.p[1]].x, m.positions[t.p[1]].y, m.positions[t.p[1]].z};
            const V3 c{m.positions[t.p[2]].x, m.positions[t.p[2]].y, m.positions[t.p[2]].z};
            const V3 n1 = (b - a).cross(c - a);
            if (t.parent >= idx.size() / 3) continue;
            auto pv = [&](int k) { const auto& p = verts[idx[3 * t.parent + k]].position; return V3{p.x, p.y, p.z}; };
            const V3 n0 = (pv(1) - pv(0)).cross(pv(2) - pv(0));
            if (n0.norm() < 2e-8 || n1.norm() < 2e-8) continue;
            ++checked;
            bool fold = n0.dot(n1) < 0;
            if (t.region >= 0) {
                auto it = regionNormal.find(t.region);
                if (it != regionNormal.end()) {
                    const bool foldRegion = it->second.dot(n1) < 0;
                    if (fold && !foldRegion) ++revealsPastParent;
                    fold = foldRegion;
                }
            }
            if (fold) {
                ++flips;
                if (std::getenv("SB_DEBUG_FLIPS"))
                    std::fprintf(stderr, "relief fold: parent %u area %.3g out area %.3g region %d at (%.2f %.2f %.2f)\n", t.parent, 0.5 * n0.norm(), 0.5 * n1.norm(), t.region, a.x, a.y, a.z);
            }
        }
        // open edges of the output against the rectified boundary (relief keeps region borders in place)
        std::vector<V3> op(m.positions.size());
        for (size_t i = 0; i < op.size(); ++i) op[i] = V3{m.positions[i].x, m.positions[i].y, m.positions[i].z};
        std::vector<std::array<uint32_t, 3>> tris(m.triangles.size());
        for (size_t i = 0; i < tris.size(); ++i) tris[i] = {m.triangles[i].p[0], m.triangles[i].p[1], m.triangles[i].p[2]};
        // a boundary edge is matched on its pre-relief (base) position: the relief displaces open borders inside a region
        // (unwelded seams it merged) together with their surface, which moves a boundary but does not open one
        std::vector<V3> basePos = op;
        for (size_t i = 0; i < basePos.size(); ++i) {
            if (i >= m.heights.size() || m.heights[i] == 0 || m.positionRegion[i] < 0) continue;
            auto it = regionNormal.find(m.positionRegion[i]);
            if (it != regionNormal.end()) basePos[i] = basePos[i] - it->second * static_cast<double>(m.heights[i]);
        }
        const OpenEdgeStats eOut = openEdgeCensus(op, tris, nullptr, &rectBoundary, &basePos, 0.1, threads);
        // relief depth
        std::vector<double> absH;
        double hMin = 0, hMax = 0;
        for (size_t i = 0; i < m.heights.size(); ++i) {
            const double h = m.heights[i];
            if (h != 0) absH.push_back(std::abs(h));
            hMin = std::min(hMin, h);
            hMax = std::max(hMax, h);
        }
        js << "    \"final\": " << edges(eOut) << ",\n";
        js << "    \"finalVsRawInputBoundaryEdges\": " << static_cast<long long>(eOut.boundaryEdges) - static_cast<long long>(rawInputEdges.boundaryEdges)
           << ", \"finalVsRawInputBoundaryLength_m\": " << num(eOut.boundaryLength - rawInputEdges.boundaryLength) << "},\n";
        js << "  \"relief\": {\"enabled\": " << (P.relief ? "true" : "false") << ", \"regionsFound\": " << relief.regionsFound << ", \"regionsAnalysed\": " << relief.regionsAnalysed
           << ", \"regionsTreated\": " << relief.regionsTreated << ", \"candidateTriangles\": " << relief.candidateTriangles
           << ", \"heightMin_m\": " << num(hMin) << ", \"heightMax_m\": " << num(hMax) << ", \"absHeightDisplaced_m\": " << dist(Distribution::of(absH))
           << ", \"meanRecess_m\": " << num(relief.meanRecess) << ", \"meanProud_m\": " << num(relief.meanProud) << ", \"recessArea_m2\": " << num(relief.recessArea)
           << ", \"proudArea_m2\": " << num(relief.proudArea) << ", \"insertedBorderVertices\": " << relief.insertedBorderVertices << ", \"earClipFallbacks\": " << relief.earClipFallbacks << ", \"earClipUnfilled\": " << relief.earClipUnfilled
           << ", \"outputTriangles\": " << m.triangles.size() << ", \"flips\": " << flips << ", \"revealFacesTiltedPastParentPlane\": " << revealsPastParent
           << ", \"flipChecked\": " << checked << ", \"facades\": [";
        if (std::getenv("SB_DEBUG_FACADES"))
            for (const auto& f : relief.facades)
                std::fprintf(stderr, "facade %d area %.0f c (%.1f %.1f %.1f) n (%.2f %.2f %.2f) %s pattern %s pS %.2f(%.2f) pT %.2f(%.2f) cells %d/%d strips %d/%d lines %zu features %zu %s\n",
                             f.id, f.area, f.centroid.x, f.centroid.y, f.centroid.z, f.normal.x, f.normal.y, f.normal.z, f.treated ? "TREATED" : "skipped",
                             f.analysis.pattern.c_str(), f.analysis.periodS.pitch, f.analysis.periodS.periodicity, f.analysis.periodT.pitch, f.analysis.periodT.periodicity,
                             f.analysis.cellsAccepted, f.analysis.cellsTested, f.analysis.stripRuns, f.analysis.stripsTested, f.analysis.lines.size(), f.analysis.features.size(), f.skipReason.c_str());
        std::vector<const photometric_relief::FacadeReport*> treated;
        for (const auto& f : relief.facades) if (f.treated) treated.push_back(&f);
        std::sort(treated.begin(), treated.end(), [](auto* a, auto* b) { return a->area > b->area; });
        for (size_t i = 0; i < std::min<size_t>(8, treated.size()); ++i) {
            const auto& f = *treated[i];
            js << (i ? "," : "") << "{\"id\": " << f.id << ", \"area_m2\": " << num(f.area) << ", \"pattern\": \"" << jsonEscape(f.analysis.pattern)
               << "\", \"features\": " << f.analysis.features.size() << ", \"minHeight_m\": " << num(f.minHeight) << ", \"maxHeight_m\": " << num(f.maxHeight)
               << ", \"centroid\": " << vec(V3{f.centroid.x, f.centroid.y, f.centroid.z}) << "}";
        }
        js << "]},\n";
        finalFlips = flips;
    }
    size_t finalFlips{0};

    // ----------------------------------------------------------------------------------------
    // Thumbnails: unlit textured ("baked": the photo is the radiance) and clay, 1 sample per pixel, raw vs output
    // ----------------------------------------------------------------------------------------
    struct RenderMesh {
        std::vector<float> pos;
        std::vector<uint32_t> idx;
        std::vector<float> uv;      // 6 per triangle
        std::vector<uint32_t> mat;
    };

    RenderMesh rawRenderMesh() const {
        RenderMesh r;
        r.pos = rawPos;
        r.idx = rawIdx;
        r.mat = rawMat;
        r.uv.resize(F * 6);
        for (size_t t = 0; t < F; ++t)
            for (int k = 0; k < 3; ++k) {
                const auto& vv = scene.mesh.vertices[rawIdx[3 * t + k]];
                r.uv[6 * t + 2 * k] = vv.uv.x;
                r.uv[6 * t + 2 * k + 1] = vv.uv.y;
            }
        return r;
    }
    static RenderMesh outRenderMesh(const photometric_relief::ReliefMesh& m) {
        RenderMesh r;
        r.pos.resize(m.positions.size() * 3);
        for (size_t i = 0; i < m.positions.size(); ++i) {
            r.pos[3 * i] = static_cast<float>(m.positions[i].x);
            r.pos[3 * i + 1] = static_cast<float>(m.positions[i].y);
            r.pos[3 * i + 2] = static_cast<float>(m.positions[i].z);
        }
        r.idx.resize(m.triangles.size() * 3);
        r.uv.resize(m.triangles.size() * 6);
        r.mat.resize(m.triangles.size());
        for (size_t t = 0; t < m.triangles.size(); ++t) {
            for (int k = 0; k < 3; ++k) {
                r.idx[3 * t + k] = m.triangles[t].p[k];
                r.uv[6 * t + 2 * k] = m.triangles[t].uv[k][0];
                r.uv[6 * t + 2 * k + 1] = m.triangles[t].uv[k][1];
            }
            r.mat[t] = m.triangles[t].material;
        }
        return r;
    }

    const std::vector<math::Vec3>* tint{nullptr};  // diagnostics: per-triangle clay colour (raw mesh only)

    // clay: one key light from the camera's upper left (raking enough to show relief) with a short hard shadow ray when
    // `shadow` is given, plus a flat fill
    void renderInto(const RenderMesh& rm, const Camera& cam, bool clay, texture::ImageBuffer& img, int ox, int oy,
                    const scan_rectifier::SidedBvh* shadow = nullptr, unsigned workers = 0) const {
        MeshView mv{rm.pos.data(), rm.pos.size() / 3, rm.idx.data(), rm.idx.size() / 3};
        Raster R;
        R.prepare(cam, mv, 1);
        R.draw(cam, mv, [](size_t) { return 1; });
        // key light above the horizon whatever the camera's pitch: from behind the camera's left shoulder, about 33 degrees
        // up, so facades turned to the camera are lit and recesses cast short shadows to the lower right
        V3 fh{cam.fwd.x, 0, cam.fwd.z}, rh{cam.right.x, 0, cam.right.z};
        fh = fh.norm() > 1e-6 ? fh.normalized() : V3{0, 0, -1};
        rh = rh.norm() > 1e-6 ? rh.normalized() : V3{1, 0, 0};
        const V3 L = (rh * -0.6 + V3{0, 0.55, 0} - fh * 0.6).normalized();
        scan_rectifier::detail::parallelFor(static_cast<size_t>(cam.H), workers ? workers : threads, 8, [&](size_t y0, size_t y1, unsigned) {
        for (int y = static_cast<int>(y0); y < static_cast<int>(y1); ++y)
            for (int x = 0; x < cam.W; ++x) {
                const int32_t t = R.id[0][static_cast<size_t>(y) * cam.W + x];
                math::Vec3 col(0.80f, 0.84f, 0.90f);  // backdrop
                if (t >= 0) {
                    const V3 A = mv.P(mv.idx[3 * t]), B = mv.P(mv.idx[3 * t + 1]), C = mv.P(mv.idx[3 * t + 2]);
                    const double u = (x + 0.5 - 0.5 * cam.W) / cam.focal, v = (0.5 * cam.H - (y + 0.5)) / cam.focal;
                    const V3 dir = (cam.fwd + cam.right * u + cam.up * v).normalized();
                    V3 n = (B - A).cross(C - A).normalized();
                    if (n.dot(dir) > 0) n = n * -1.0;
                    if (clay) {
                        double direct = std::max(0.0, n.dot(L));
                        if (shadow && direct > 0) {
                            // the pixel's point on the triangle plane, nudged off the surface, toward the light
                            const double den = n.dot(dir);
                            if (std::abs(den) > 1e-12) {
                                const double th = n.dot(A - cam.eye) / den;
                                const V3 q = cam.eye + dir * th + n * 0.02;
                                // local occluders only (jambs, heads, cornices, setbacks): the city's long shadows
                                // would hide the relief the thumbnail is for
                                if (shadow->anyHit(q, L, 0.01, 4.0)) direct = 0;
                            }
                        }
                        const double lam = 0.30 + 0.70 * direct;
                        const math::Vec3 base = (tint && static_cast<size_t>(t) < tint->size()) ? (*tint)[static_cast<size_t>(t)] : math::Vec3(0.55f, 0.57f, 0.60f);
                        col = math::Vec3(static_cast<float>(base.x * lam * 1.25), static_cast<float>(base.y * lam * 1.25), static_cast<float>(base.z * lam * 1.25));
                    } else {
                        // barycentrics of the pixel ray on the triangle plane
                        const V3 e1 = B - A, e2 = C - A, pv = dir.cross(e2);
                        const double det = e1.dot(pv);
                        double bu = 0, bv = 0;
                        if (std::abs(det) > 1e-14) {
                            const V3 s = cam.eye - A;
                            bu = std::clamp(s.dot(pv) / det, 0.0, 1.0);
                            bv = std::clamp(dir.dot(s.cross(e1)) / det, 0.0, 1.0 - bu);
                        }
                        const double bw = 1.0 - bu - bv;
                        const float* uv = rm.uv.data() + 6 * t;
                        const double tu = bw * uv[0] + bu * uv[2] + bv * uv[4], tv = bw * uv[1] + bu * uv[3] + bv * uv[5];
                        col = math::Vec3(0.6f, 0.6f, 0.6f);
                        const uint32_t mi = rm.mat[t];
                        if (mi < scene.materials.size()) {
                            const auto& sm = scene.materials[mi];
                            math::Vec3 base(sm.baseColorFactor.x, sm.baseColorFactor.y, sm.baseColorFactor.z);
                            const int im = sm.baseColorImage;
                            if (im >= 0 && im < static_cast<int>(scene.images.size()) && scene.images[static_cast<size_t>(im)].decoded) {
                                const auto& pix = scene.images[static_cast<size_t>(im)].pixels;
                                const int px = static_cast<int>(std::floor(tu * pix.width)), py = static_cast<int>(std::floor(tv * pix.height));
                                const math::Vec3 tc = pix.getPixelRGB(px, py);
                                col = math::Vec3(tc.x * base.x, tc.y * base.y, tc.z * base.z);
                            } else {
                                col = base;
                            }
                        }
                    }
                }
                img.setPixelRGB(ox + x, oy + y, col);
            }
        });
    }

    void writeThumbnails(const photometric_relief::ReliefMesh& outMesh) {
        std::filesystem::create_directories(P.thumbsDir);
        const int W = P.thumbWidth, H = P.thumbHeight;
        const RenderMesh rawM = rawRenderMesh(), outM = outRenderMesh(outMesh);
        std::vector<Shot> shots;
        if (P.isolate) isolateShots(shots, W, H);
        else cityShots(shots, W, H);
        // diagnostics: SB_THUMB_EXTRA="name@ex,ey,ez@tx,ty,tz@vfov;..." adds shots (absolute scan coordinates)
        if (const char* extra = std::getenv("SB_THUMB_EXTRA")) {
            std::stringstream all(extra);
            std::string item;
            while (std::getline(all, item, ';')) {
                std::vector<std::string> f;
                std::stringstream is(item);
                std::string part;
                while (std::getline(is, part, '@')) f.push_back(part);
                if (f.size() < 3) continue;
                auto v3 = [](const std::string& s) {
                    V3 v;
                    std::sscanf(s.c_str(), "%lf,%lf,%lf", &v.x, &v.y, &v.z);
                    return v;
                };
                const double fov = f.size() > 3 ? std::atof(f[3].c_str()) : 45.0;
                shots.push_back({f[0], Camera::lookAt(v3(f[1]), v3(f[2]), V3{0, 1, 0}, W, H, fov > 0 ? fov : 45.0, 0.2)});
            }
        }
        // shadow rays: the raw scan's BVH (built for the visibility) and one over the output mesh
        std::vector<V3> oP(outMesh.positions.size()), oN(outMesh.triangles.size());
        std::vector<std::array<uint32_t, 3>> oT(outMesh.triangles.size());
        for (size_t i = 0; i < oP.size(); ++i) oP[i] = V3{outMesh.positions[i].x, outMesh.positions[i].y, outMesh.positions[i].z};
        for (size_t t = 0; t < oT.size(); ++t) {
            const auto& tr = outMesh.triangles[t];
            oT[t] = {tr.p[0], tr.p[1], tr.p[2]};
            oN[t] = (oP[tr.p[1]] - oP[tr.p[0]]).cross(oP[tr.p[2]] - oP[tr.p[0]]);
        }
        scan_rectifier::SidedBvh outBvh;
        outBvh.build(oP, oT, oN);
        // every pane (shot x raw/output x textured/clay) is independent: render them concurrently, one thread each
        // (panes write disjoint pixel blocks of their shot's image), then encode the shots concurrently
        std::vector<texture::ImageBuffer> images;
        images.reserve(shots.size());
        for (size_t i = 0; i < shots.size(); ++i) images.emplace_back(2 * W, 2 * H, 3);
        auto runAll = [&](size_t n, const std::function<void(size_t)>& job) {
            std::atomic<size_t> next{0};
            std::vector<std::thread> pool;
            const unsigned nt = static_cast<unsigned>(std::max<size_t>(1, std::min<size_t>(threads, n)));
            for (unsigned t = 0; t < nt; ++t)
                pool.emplace_back([&]() { for (size_t i; (i = next.fetch_add(1)) < n;) job(i); });
            for (auto& th : pool) th.join();
        };
        runAll(shots.size() * 4, [&](size_t i) {
            const size_t s = i / 4, pane = i % 4;
            const bool out = pane & 1, clay = pane >= 2;
            renderInto(out ? outM : rawM, shots[s].cam, clay, images[s], out ? W : 0, clay ? H : 0, clay ? (out ? &outBvh : &bvh) : nullptr, 1);
        });
        runAll(shots.size(), [&](size_t s) {
            writeFile((std::filesystem::path(P.thumbsDir) / (shots[s].name + ".png")).string(), texture::encodePng(images[s]));
        });
        js << "  \"thumbnails\": {\"dir\": \"" << jsonEscape(P.thumbsDir) << "\", \"layout\": \"2x2: raw textured | output textured / raw clay | output clay\", \"shading\": \"unlit baked texture; clay with one raking key light, local hard shadows (occluders within 4 m) and flat fill; 1 sample per pixel\", \"shots\": [";
        for (size_t i = 0; i < shots.size(); ++i)
            js << (i ? "," : "") << "{\"name\": \"" << shots[i].name << "\", \"eye\": " << vec(shots[i].cam.eye) << ", \"forward\": " << vec(shots[i].cam.fwd) << "}";
        js << "]},\n";
    }

    struct Shot { std::string name; Camera cam; };

    /**
     * Isolated structure: one view per side at mid height (the sides of the structure's cross-section there, from its
     * principal axes; 20 degrees off each side's normal, close: the side's width fits the frame with some margin) and one aerial view
     * of the whole structure. Shot names carry the compass azimuth the camera looks toward (0 = north = -z, 90 = east).
     */
    void isolateShots(std::vector<Shot>& shots, int W, int H) const {
        const double tol = P.vis.openGroundTolerance;
        std::vector<V3> pts;  // raised vertices of the isolated scan
        pts.reserve(V);
        double minX = 1e300, maxX = -1e300, minZ = 1e300, maxZ = -1e300, top = -1e300;
        for (size_t v = 0; v < V; ++v) {
            const V3 p{rawPos[3 * v], rawPos[3 * v + 1], rawPos[3 * v + 2]};
            if (p.y - dtm.sample(p.x, p.z) <= tol) continue;
            pts.push_back(p);
            minX = std::min(minX, p.x); maxX = std::max(maxX, p.x);
            minZ = std::min(minZ, p.z); maxZ = std::max(maxZ, p.z);
            top = std::max(top, p.y);
        }
        if (pts.size() < 8) return;
        const double ground = dtm.sample(0.5 * (minX + maxX), 0.5 * (minZ + maxZ));
        const double height = std::max(1.0, top - ground), mid = ground + 0.5 * height;
        // cross-section around mid height (widened until it holds enough points)
        std::vector<V3> sec;
        for (double band = std::max(4.0, 0.08 * height); sec.size() < 32 && band <= height; band *= 2.0) {
            sec.clear();
            for (const V3& p : pts) if (std::abs(p.y - mid) <= band) sec.push_back(p);
        }
        if (sec.size() < 3) sec = pts;
        double mx = 0, mz = 0;
        for (const V3& p : sec) { mx += p.x; mz += p.z; }
        mx /= static_cast<double>(sec.size()); mz /= static_cast<double>(sec.size());
        double cxx = 0, cxz = 0, czz = 0;
        for (const V3& p : sec) { cxx += (p.x - mx) * (p.x - mx); cxz += (p.x - mx) * (p.z - mz); czz += (p.z - mz) * (p.z - mz); }
        const double ang = 0.5 * std::atan2(2.0 * cxz, cxx - czz);
        const V3 u{std::cos(ang), 0, std::sin(ang)}, w{-std::sin(ang), 0, std::cos(ang)};
        double u0 = 1e300, u1 = -1e300, w0 = 1e300, w1 = -1e300;
        for (const V3& p : sec) {
            const V3 d{p.x - mx, 0, p.z - mz};
            u0 = std::min(u0, d.dot(u)); u1 = std::max(u1, d.dot(u));
            w0 = std::min(w0, d.dot(w)); w1 = std::max(w1, d.dot(w));
        }
        const V3 c2 = V3{mx, mid, mz} + u * (0.5 * (u0 + u1)) + w * (0.5 * (w0 + w1));
        const double hu = 0.5 * (u1 - u0), hw = 0.5 * (w1 - w0);
        const double vfov = 45.0, aspect = static_cast<double>(W) / H;
        const double tanH = std::tan(0.5 * vfov * 3.14159265358979323846 / 180.0) * aspect;
        const double yaw = 20.0 * 3.14159265358979323846 / 180.0;
        auto azimuthTag = [](const V3& look) {
            int deg = static_cast<int>(std::lround(std::atan2(look.x, -look.z) * 180.0 / 3.14159265358979323846));
            deg = ((deg % 360) + 360) % 360;
            char buf[16];
            std::snprintf(buf, sizeof(buf), "%03d", deg);
            return std::string(buf);
        };
        const std::pair<V3, double> sides[4] = {{u, hw}, {u * -1.0, hw}, {w, hu}, {w * -1.0, hu}};
        for (int s = 0; s < 4; ++s) {
            const V3 n = sides[s].first;
            const double halfOut = (s < 2) ? hu : hw;            // the side's offset from the centre along its normal
            const V3 face = c2 + n * halfOut;
            const double dist = std::clamp(sides[s].second / tanH * 1.8, 30.0, 300.0);  // the side's width with margin
            const V3 dir{n.x * std::cos(yaw) - n.z * std::sin(yaw), 0, n.x * std::sin(yaw) + n.z * std::cos(yaw)};
            const V3 eye = face + dir * dist;
            shots.push_back({"side_" + azimuthTag(dir * -1.0), Camera::lookAt(eye, face, V3{0, 1, 0}, W, H, vfov, 0.5)});
        }
        // aerial: the whole structure, from the diagonal between two sides, 30 degrees up
        const V3 cb{0.5 * (minX + maxX), ground + 0.45 * height, 0.5 * (minZ + maxZ)};
        const double radius = 0.5 * std::sqrt((maxX - minX) * (maxX - minX) + (maxZ - minZ) * (maxZ - minZ) + height * height);
        const double el = 30.0 * 3.14159265358979323846 / 180.0;
        const V3 hd = (u + w).normalized();
        const V3 dir{hd.x * std::cos(el), std::sin(el), hd.z * std::cos(el)};
        const double avfov = 40.0;
        const double dist = radius / std::sin(0.5 * avfov * 3.14159265358979323846 / 180.0) * 1.02;
        shots.push_back({"aerial", Camera::lookAt(cb + dir * dist, cb, V3{0, 1, 0}, W, H, avfov, 1.0)});
    }

    /** Whole tile: the configured aerial, the hero's largest facade and a street-level view in front of it. */
    void cityShots(std::vector<Shot>& shots, int W, int H) const {
        const V3 aEye{P.aerialEye.x + P.anchorX, P.aerialEye.y, P.aerialEye.z + P.anchorZ};
        const V3 aTgt{P.aerialTarget.x + P.anchorX, P.aerialTarget.y, P.aerialTarget.z + P.anchorZ};
        shots.push_back({"aerial", Camera::lookAt(aEye, aTgt, V3{0, 1, 0}, W, H, 40.0, 1.0)});
        if (heroFacadeArea > 0) {
            // the hero's largest wall, from 20 degrees off its normal, at the wall's own mid height
            V3 n{heroFacadeNormal.x, 0, heroFacadeNormal.z};
            n = n.normalized();
            const double c = std::cos(0.55), s = std::sin(0.55);
            const V3 d{n.x * c - n.z * s, 0, n.x * s + n.z * c};
            const double dist = std::clamp(std::sqrt(heroFacadeArea) * 0.5, 30.0, 120.0);
            shots.push_back({"hero_facade", Camera::lookAt(heroFacadeCentroid + d * dist, heroFacadeCentroid, V3{0, 1, 0}, W, H, 45.0, 0.5)});
        }
        {
            // street level in front of the hero: walk from its largest wall (else the footprint centre) along the wall's
            // horizontal normal (then around the compass) over the DSM to the first open ground, stand a few metres into
            // it and look back up at the building
            const auto& S = rect.stats;
            const V3 hc = S.heroFound ? V3{0.5 * (S.heroMinX + S.heroMaxX), 0, 0.5 * (S.heroMinZ + S.heroMaxZ)} : V3{P.anchorX, 0, P.anchorZ};
            std::vector<std::pair<V3, V3>> starts;  // (start, horizontal direction)
            if (heroFacadeArea > 0) {
                V3 n{heroFacadeNormal.x, 0, heroFacadeNormal.z};
                if (n.norm() > 1e-6) starts.push_back({heroFacadeCentroid, n.normalized()});
            }
            for (int a = 0; a < 8; ++a) starts.push_back({hc, V3{std::cos(a * 0.785398), 0, std::sin(a * 0.785398)}});
            for (const auto& st : starts) {
                const V3 o = st.first, d = st.second;
                double s0 = -1, s1 = -1;
                for (double sd = dsm.cell; sd <= 250.0; sd += dsm.cell) {
                    const double x = o.x + d.x * sd, z = o.z + d.z * sd;
                    const int i = dsm.ix(x), k = dsm.iz(z);
                    if (!dsm.inside(i, k)) break;
                    const float h = dsm.at(i, k);
                    const bool open = !std::isnan(h) && h - dtm.sample(x, z) < P.vis.openGroundTolerance;
                    if (s0 < 0) { if (open) s0 = s1 = sd; }
                    else if (open && sd - s0 <= 30.0) s1 = sd;
                    else break;
                }
                if (s0 < 0) continue;
                const double sd = s0 + std::min(0.6 * (s1 - s0), 12.0);
                const double x = o.x + d.x * sd, z = o.z + d.z * sd;
                const int i = dsm.ix(x), k = dsm.iz(z);
                if (!dsm.inside(i, k) || std::isnan(dsm.at(i, k))) continue;
                const V3 eye{x, dsm.at(i, k) + P.vis.eyeHeight, z};
                const double pitch = 0.6;  // about 34 degrees up
                const V3 fwd{-d.x * std::cos(pitch), std::sin(pitch), -d.z * std::cos(pitch)};
                shots.push_back({"street", Camera::lookAt(eye, eye + fwd, V3{0, 1, 0}, W, H, 75.0, 0.2)});
                break;
            }
        }
    }
};

}  // namespace tile_refine
}  // namespace scratchbox

#endif  // SCRATCHBOX_TILE_REFINE_HPP
