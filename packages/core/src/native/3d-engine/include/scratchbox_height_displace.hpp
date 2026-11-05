/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_HEIGHT_DISPLACE_HPP
#define SCRATCHBOX_HEIGHT_DISPLACE_HPP

/**
 * Real height: a surface tessellated and moved by its material's height (user ask, 2026-11-05). The relief is a scalar
 * field over the surface's UVs, a recess in metres below the surface as drawn (never above it):
 *
 *     recess(u, v) = depthM x (1 - tile[class(u, v)](u x uvMetresX / sizeX, v x uvMetresY / sizeY) / 255)
 *
 * a class map (one class a texel, or one class for the whole patch) choosing a recess tile that repeats at its real size
 * (pipeline-k/material-height.ts writes the tiles: 255 the surface, 0 a recess of depthM). The viewer's parallax marches
 * the same field (heightRelief.ts), so the displaced near surface and the parallax beyond it agree.
 *
 *  - Tessellation: conforming edge splits. An edge is split when it is longer than edgeMaxM, or longer than edgeMinM and
 *    the relief along it leaves the straight line between its ends by more than toleranceM; a triangle is cut by the
 *    edges it has split (1 into 2, 3 or 4). The decision is the edge's alone, so triangles sharing an edge by index stay
 *    joined, and flat stretches (a brick's face, a pane) keep their few triangles while joints and grooves get the detail.
 *  - Displacement: each vertex moves against its normal by the recess at its UV. Normals and UVs are kept (the material's
 *    normal map shades the relief as it does on the undisplaced surface).
 *  - Risers: every edge the patch does not share (its border, and seams where vertices are doubled for a hard edge) gets
 *    a strip from the displaced edge back to where the edge stood, so no gap opens beside an undisplaced neighbour.
 *
 * Any surface with UVs and a metric frame takes it: a rebuilt facade, a generated object's part. It is never run on
 * measured geometry (the callers choose the surfaces: pipeline-k/height-relief.ts).
 */

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <unordered_map>
#include <vector>

namespace scratchbox::height_displace {

/** A recess tile: 255 the surface, 0 a recess of the field's depth; it repeats every sizeX x sizeY metres. */
struct Tile { int w = 0, h = 0; std::vector<uint8_t> v; double sizeX = 1, sizeY = 1; bool has() const { return w > 0 && h > 0; } };

/** One class a texel over the patch's UVs (clamped at the border). */
struct ClassMap { int w = 0, h = 0; std::vector<uint8_t> c; };

struct Field {
    const std::vector<Tile>* tiles = nullptr;
    /** The class map, or null with constClass for the whole patch. */
    const ClassMap* map = nullptr;
    int constClass = 0;
    /** Metres one UV unit spans. */
    double uvMetresX = 1, uvMetresY = 1;
    double depthM = 0.03;

    double recess(double u, double v) const {
        int c = constClass;
        if (map) {
            const int x = std::clamp(static_cast<int>(std::floor(u * map->w)), 0, map->w - 1), y = std::clamp(static_cast<int>(std::floor(v * map->h)), 0, map->h - 1);
            c = map->c[static_cast<size_t>(y) * map->w + x];
        }
        if (c < 0 || c >= static_cast<int>(tiles->size()) || !(*tiles)[c].has()) return 0;
        const Tile& t = (*tiles)[c];
        // bilinear between texel centres, the tile repeating (as a repeat-wrapped linear sampler reads it)
        const double fx = (u * uvMetresX / t.sizeX) * t.w - 0.5, fy = (v * uvMetresY / t.sizeY) * t.h - 0.5;
        const double x0f = std::floor(fx), y0f = std::floor(fy), ax = fx - x0f, ay = fy - y0f;
        auto wrap = [](double i, int n) { const int k = static_cast<int>(std::fmod(i, n)); return k < 0 ? k + n : k; };
        const int x0 = wrap(x0f, t.w), x1 = wrap(x0f + 1, t.w), y0 = wrap(y0f, t.h), y1 = wrap(y0f + 1, t.h);
        const double a = t.v[static_cast<size_t>(y0) * t.w + x0], b = t.v[static_cast<size_t>(y0) * t.w + x1], d = t.v[static_cast<size_t>(y1) * t.w + x0], e = t.v[static_cast<size_t>(y1) * t.w + x1];
        const double val = (a * (1 - ax) + b * ax) * (1 - ay) + (d * (1 - ax) + e * ax) * ay;
        return depthM * (1 - val / 255.0);
    }
};

struct Mesh { std::vector<float> pos, nrm, uv; std::vector<uint32_t> idx; };

struct Params {
    /** No edge is split shorter than this; every edge longer than edgeMaxM is. */
    double edgeMinM = 0.015, edgeMaxM = 0.25;
    /** An edge between the two is split when the relief leaves its chord by more than this. */
    double toleranceM = 0.0015;
    /** Tessellation stops adding triangles past this (the patch is then coarser than asked, and says so). */
    uint32_t maxTriangles = 400000;
};

struct Result {
    Mesh mesh;
    /** The surface's triangles (before the risers), the risers' triangles, and whether the triangle limit stopped the tessellation. */
    uint32_t surfaceTriangles = 0, riserTriangles = 0;
    bool limited = false;
    /** The deepest and the mean recess of the vertices, metres. */
    double maxRecessM = 0, meanRecessM = 0;
};

namespace detail {
inline uint64_t edgeKey(uint32_t a, uint32_t b) { return a < b ? (static_cast<uint64_t>(a) << 32) | b : (static_cast<uint64_t>(b) << 32) | a; }
}

/** The patch tessellated to the relief and displaced by it (see the file comment). `src` is not changed. */
inline Result displace(const Mesh& src, const Field& field, const Params& P) {
    Result out;
    Mesh& m = out.mesh;
    m = src;
    const size_t V0 = m.pos.size() / 3;
    if (m.nrm.size() != V0 * 3 || m.uv.size() != V0 * 2) return out;
    std::vector<double> rec(V0);
    for (size_t i = 0; i < V0; i++) rec[i] = field.recess(m.uv[i * 2], m.uv[i * 2 + 1]);

    auto length = [&](uint32_t a, uint32_t b) {
        const double dx = m.pos[a * 3] - m.pos[b * 3], dy = m.pos[a * 3 + 1] - m.pos[b * 3 + 1], dz = m.pos[a * 3 + 2] - m.pos[b * 3 + 2];
        return std::sqrt(dx * dx + dy * dy + dz * dz);
    };
    auto wantsSplit = [&](uint32_t a, uint32_t b) {
        const double len = length(a, b);
        if (len > P.edgeMaxM) return true;
        if (len <= P.edgeMinM) return false;
        // the relief along the edge against its chord, sampled at edgeMinM (a joint narrower than that is below the detail asked)
        const int n = std::clamp(static_cast<int>(std::ceil(len / P.edgeMinM)), 3, 24);
        for (int s = 1; s < n; s++) {
            const double t = static_cast<double>(s) / n;
            const double r = field.recess(m.uv[a * 2] + (m.uv[b * 2] - m.uv[a * 2]) * t, m.uv[a * 2 + 1] + (m.uv[b * 2 + 1] - m.uv[a * 2 + 1]) * t);
            if (std::abs(r - (rec[a] + (rec[b] - rec[a]) * t)) > P.toleranceM) return true;
        }
        return false;
    };
    auto midpoint = [&](uint32_t a, uint32_t b) {
        const uint32_t v = static_cast<uint32_t>(m.pos.size() / 3);
        for (int k = 0; k < 3; k++) m.pos.push_back((m.pos[a * 3 + k] + m.pos[b * 3 + k]) * 0.5f);
        float n[3];
        for (int k = 0; k < 3; k++) n[k] = m.nrm[a * 3 + k] + m.nrm[b * 3 + k];
        const float l = std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
        for (int k = 0; k < 3; k++) m.nrm.push_back(l > 1e-12f ? n[k] / l : m.nrm[a * 3 + k]);
        for (int k = 0; k < 2; k++) m.uv.push_back((m.uv[a * 2 + k] + m.uv[b * 2 + k]) * 0.5f);
        rec.push_back(field.recess(m.uv[v * 2], m.uv[v * 2 + 1]));
        return v;
    };

    constexpr uint32_t NONE = 0xFFFFFFFFu;
    for (int pass = 0; pass < 24; pass++) {
        std::unordered_map<uint64_t, uint32_t> mid;
        mid.reserve(m.idx.size());
        std::vector<uint32_t> next;
        next.reserve(m.idx.size() * 2);
        bool any = false;
        const size_t T = m.idx.size() / 3;
        // the limit is checked a pass at a time: a pass at most quadruples the triangles
        const bool room = T < P.maxTriangles;
        if (!room) { out.limited = true; break; }
        for (size_t t = 0; t < T; t++) {
            const uint32_t v[3] = { m.idx[t * 3], m.idx[t * 3 + 1], m.idx[t * 3 + 2] };
            uint32_t e[3];
            for (int k = 0; k < 3; k++) {
                const uint32_t a = v[k], b = v[(k + 1) % 3];
                const uint64_t key = detail::edgeKey(a, b);
                auto it = mid.find(key);
                if (it == mid.end()) it = mid.emplace(key, a != b && wantsSplit(a, b) ? midpoint(a, b) : NONE).first;
                e[k] = it->second;
            }
            const int n = (e[0] != NONE) + (e[1] != NONE) + (e[2] != NONE);
            auto tri = [&](uint32_t a, uint32_t b, uint32_t c) { next.push_back(a); next.push_back(b); next.push_back(c); };
            if (n == 0) { tri(v[0], v[1], v[2]); continue; }
            any = true;
            if (n == 3) { tri(v[0], e[0], e[2]); tri(e[0], v[1], e[1]); tri(e[2], e[1], v[2]); tri(e[0], e[1], e[2]); continue; }
            if (n == 1) {
                const int k = e[0] != NONE ? 0 : e[1] != NONE ? 1 : 2;
                const uint32_t a = v[k], b = v[(k + 1) % 3], c = v[(k + 2) % 3];
                tri(a, e[k], c); tri(e[k], b, c);
                continue;
            }
            // two split edges: the corner between them cut off, the rest a quad cut along its shorter diagonal
            const int k = e[0] == NONE ? 1 : e[1] == NONE ? 2 : 0; // edges k and k+1 are split; they meet at v[k+1]
            const uint32_t a = v[k], b = v[(k + 1) % 3], c = v[(k + 2) % 3], ab = e[k], bc = e[(k + 1) % 3];
            tri(ab, b, bc);
            if (length(a, bc) <= length(ab, c)) { tri(a, ab, bc); tri(a, bc, c); } else { tri(a, ab, c); tri(ab, bc, c); }
        }
        m.idx.swap(next);
        if (!any) break;
    }
    out.surfaceTriangles = static_cast<uint32_t>(m.idx.size() / 3);

    // displace against the normals; where each vertex stood is kept for the risers
    const size_t V = m.pos.size() / 3;
    const std::vector<float> stood = m.pos;
    double sum = 0;
    for (size_t i = 0; i < V; i++) {
        const double r = rec[i];
        const double nx = m.nrm[i * 3], ny = m.nrm[i * 3 + 1], nz = m.nrm[i * 3 + 2], l = std::sqrt(nx * nx + ny * ny + nz * nz);
        if (r > 0 && l > 1e-12) {
            m.pos[i * 3] = static_cast<float>(m.pos[i * 3] - nx / l * r);
            m.pos[i * 3 + 1] = static_cast<float>(m.pos[i * 3 + 1] - ny / l * r);
            m.pos[i * 3 + 2] = static_cast<float>(m.pos[i * 3 + 2] - nz / l * r);
        }
        out.maxRecessM = std::max(out.maxRecessM, r);
        sum += r;
    }
    out.meanRecessM = V ? sum / static_cast<double>(V) : 0;

    // risers along every edge one triangle alone has
    std::unordered_map<uint64_t, uint32_t> uses;
    uses.reserve(m.idx.size());
    const size_t T = m.idx.size() / 3;
    for (size_t t = 0; t < T; t++) for (int k = 0; k < 3; k++) uses[detail::edgeKey(m.idx[t * 3 + k], m.idx[t * 3 + (k + 1) % 3])]++;
    std::unordered_map<uint32_t, uint32_t> top; // a border vertex -> its copy where it stood
    auto topOf = [&](uint32_t i) {
        auto it = top.find(i);
        if (it != top.end()) return it->second;
        const uint32_t v = static_cast<uint32_t>(m.pos.size() / 3);
        for (int k = 0; k < 3; k++) { m.pos.push_back(stood[i * 3 + k]); m.nrm.push_back(m.nrm[i * 3 + k]); }
        for (int k = 0; k < 2; k++) m.uv.push_back(m.uv[i * 2 + k]);
        top.emplace(i, v);
        return v;
    };
    constexpr double EPS = 1e-5;
    for (size_t t = 0; t < T; t++) for (int k = 0; k < 3; k++) {
        const uint32_t a = m.idx[t * 3 + k], b = m.idx[t * 3 + (k + 1) % 3];
        if (uses[detail::edgeKey(a, b)] != 1 || (rec[a] <= EPS && rec[b] <= EPS)) continue;
        const uint32_t a0 = topOf(a), b0 = topOf(b);
        m.idx.push_back(b); m.idx.push_back(a); m.idx.push_back(a0);
        m.idx.push_back(b); m.idx.push_back(a0); m.idx.push_back(b0);
        out.riserTriangles += 2;
    }
    return out;
}

} // namespace scratchbox::height_displace

#endif // SCRATCHBOX_HEIGHT_DISPLACE_HPP
