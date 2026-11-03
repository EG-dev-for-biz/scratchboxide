/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's infill, natively: the geometry of pipeline-k/lattice-stitch.ts fillOpenLoops (whose comments say why each
 * step is there). The mesh welded, its open edges walked into loops, each loop split where it comes closest to itself,
 * capped in its best-fitting plane (earcut, a port of the mapbox/earcut 3.0.2 three.js ships) or by greedy Liepa ears
 * inside the building's envelope, the caps turned to face out, fill doubling the scan or a rebuilt wall dropped, and the
 * kept fill cut into the pieces the textured twin judges. The GLBs are written by the TypeScript (appendTriangles).
 *
 * Parallel where the TypeScript's order allows it, with the same result: the loops (the TypeScript's stack runs each
 * loop's splits before the next loop, so loops are independent and their caps are numbered in that order), the caps'
 * rays, the drop tests and the pieces each on the pool; every sum the report rounds is added in the TypeScript's order.
 * Floating point as JavaScript evaluates it (no fused multiply-add, Math.hypot's compensated sum).
 */

#pragma once

#include "scratchbox_thread_pool.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <deque>
#include <limits>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#if defined(__clang__)
#pragma clang fp contract(off)
#endif

namespace scratchbox {
namespace open_loop_fill {

/** LATTICE_STITCH_PARAMS' fill fields, in the order open-loop-fill-native.ts writes them. */
struct Params {
    double weldM, splitPerimeterM, splitRatio, doubledM, coveredByWallM, coveredByWallCellM, envelopeCellM, envelopeMarginM;
    double skinM, skinShare, rimPlanarM, offRimCapM2, capRayM, capRayStartM, capRaySamples, pieceM;
    static constexpr size_t kCount = 16;
    static Params from(const std::vector<double>& v) {
        Params p{};
        double* f = &p.weldM;
        for (size_t i = 0; i < kCount && i < v.size(); ++i) f[i] = v[i];
        return p;
    }
};
static_assert(sizeof(Params) == Params::kCount * sizeof(double), "Params is a flat list of doubles");

/** One triangle primitive of the clay: its positions, indices (none: a triangle soup) and the rebuilt wall it belongs to (-1: scan). */
struct Prim { int wall = -1; std::vector<double> X; std::vector<uint32_t> I; bool indexed = false; };

using V3 = std::array<double, 3>;
using Tri = std::array<int, 3>;

struct Piece { int parent; int of; std::array<V3, 3> p; std::array<V3, 3> w; };

struct Report {
    int openBefore = 0;
    std::vector<std::pair<std::string, int>> kinds;
    int loops = 0, split = 0, filled = 0, clipped3d = 0, skippedWallOnly = 0, rejectedTriangles = 0, unclosedLoops = 0, refusedCaps = 0;
    double refusedCapM2 = 0, droppedDoubledM2 = 0, droppedCoveredM2 = 0;
    int turnedCaps = 0;
    double skinHiddenM2 = 0;
    int openPathEdges = 0, openAfter = 0, nonManifoldAfter = 0;
    double addedAreaM2 = 0;
};

struct Result { std::vector<std::array<V3, 3>> out; std::vector<Piece> pieces; Report report; };

namespace detail {

inline double jsRound(double x) { const double f = std::floor(x); return x - f >= 0.5 ? f + 1 : f; }
/** Math.hypot: the arguments over their largest, squared with a compensated sum, its root times the largest. */
inline double hypot(std::initializer_list<double> xs) {
    double mx = 0;
    bool nan = false;
    for (double v : xs) { if (std::isnan(v)) nan = true; else mx = std::max(mx, std::fabs(v)); }
    if (mx == std::numeric_limits<double>::infinity()) return mx;
    if (nan) return std::numeric_limits<double>::quiet_NaN();
    if (mx == 0) return 0;
    double sum = 0, comp = 0;
    for (double v : xs) {
        const double n = std::fabs(v) / mx, summand = n * n - comp, prelim = sum + summand;
        comp = (prelim - sum) - summand;
        sum = prelim;
    }
    return std::sqrt(sum) * mx;
}
inline V3 sub3(const V3& a, const V3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
inline V3 cross3(const V3& a, const V3& b) { return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]}; }
inline double dot(const V3& a, const V3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline double len3(const V3& a) { return hypot({a[0], a[1], a[2]}); }
inline double dist3(const V3& a, const V3& b) { return hypot({a[0] - b[0], a[1] - b[1], a[2] - b[2]}); }

constexpr uint64_t kEdgeBase = uint64_t(1) << 26;
inline uint64_t ekey(int a, int b) { return a < b ? uint64_t(a) * kEdgeBase + b : uint64_t(b) * kEdgeBase + a; }

struct CellKey {
    int64_t x, y, z;
    bool operator==(const CellKey& o) const { return x == o.x && y == o.y && z == o.z; }
};
struct CellHash {
    size_t operator()(const CellKey& k) const {
        uint64_t h = static_cast<uint64_t>(k.x) * 0x9E3779B97F4A7C15ull;
        h ^= static_cast<uint64_t>(k.y) + 0x9E3779B97F4A7C15ull + (h << 6) + (h >> 2);
        h ^= static_cast<uint64_t>(k.z) + 0x9E3779B97F4A7C15ull + (h << 6) + (h >> 2);
        return static_cast<size_t>(h ^ (h >> 31));
    }
};
inline CellKey cellOf(double x, double y, double z, double C) { return {static_cast<int64_t>(std::floor(x / C)), static_cast<int64_t>(std::floor(y / C)), static_cast<int64_t>(std::floor(z / C))}; }

/** A plan point's distance outside the footprint (0 inside any loop). */
inline double dist2Seg(double px, double pz, const std::array<double, 2>& a, const std::array<double, 2>& b) {
    const double dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    const double t = l2 > 0 ? std::max(0.0, std::min(1.0, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2)) : 0;
    return hypot({px - a[0] - t * dx, pz - a[1] - t * dz});
}
inline double outsideFootprint(double x, double z, const std::vector<std::vector<std::array<double, 2>>>& loops) {
    bool inside = false;
    double best = std::numeric_limits<double>::infinity();
    for (const auto& loop : loops) {
        bool inLoop = false;
        const size_t n = loop.size();
        for (size_t i = 0, j = n - 1; i < n; j = i++) {
            const auto& a = loop[i];
            const auto& b = loop[j];
            if ((a[1] > z) != (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inLoop = !inLoop;
            best = std::min(best, dist2Seg(x, z, a, b));
        }
        if (inLoop) inside = true;
    }
    return inside ? 0 : best;
}

// ------------------------------------------------------------------------------------------------ earcut (mapbox 3.0.2)

class Earcut {
public:
    /** Triangles (indices into the points) of a polygon without holes; as mapbox/earcut 3.0.2. */
    std::vector<int> run(const std::vector<double>& data) {
        nodes_.clear();
        triangles_.clear();
        const int dim = 2, outerLen = static_cast<int>(data.size());
        Node* outerNode = linkedList(data, 0, outerLen, dim, true);
        if (!outerNode || outerNode->next == outerNode->prev) return triangles_;
        double minX = 0, minY = 0, invSize = 0;
        if (data.size() > 80 * static_cast<size_t>(dim)) {
            minX = data[0]; minY = data[1];
            double maxX = minX, maxY = minY;
            for (int i = dim; i < outerLen; i += dim) {
                const double x = data[i], y = data[i + 1];
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
            invSize = std::max(maxX - minX, maxY - minY);
            invSize = invSize != 0 ? 32767 / invSize : 0;
        }
        earcutLinked(outerNode, minX, minY, invSize, 0);
        return triangles_;
    }

private:
    struct Node {
        int i;
        double x, y;
        Node* prev = nullptr;
        Node* next = nullptr;
        int32_t z = 0;
        Node* prevZ = nullptr;
        Node* nextZ = nullptr;
        bool steiner = false;
    };
    std::deque<Node> nodes_;
    std::vector<int> triangles_;

    static bool truthy(double v) { return v != 0 && !std::isnan(v); }

    Node* createNode(int i, double x, double y) { nodes_.push_back(Node{i, x, y}); return &nodes_.back(); }
    Node* insertNode(int i, double x, double y, Node* last) {
        Node* p = createNode(i, x, y);
        if (!last) { p->prev = p; p->next = p; }
        else { p->next = last->next; p->prev = last; last->next->prev = p; last->next = p; }
        return p;
    }
    static void removeNode(Node* p) {
        p->next->prev = p->prev;
        p->prev->next = p->next;
        if (p->prevZ) p->prevZ->nextZ = p->nextZ;
        if (p->nextZ) p->nextZ->prevZ = p->prevZ;
    }
    static double signedArea(const std::vector<double>& data, int start, int end, int dim) {
        double sum = 0;
        for (int i = start, j = end - dim; i < end; i += dim) { sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]); j = i; }
        return sum;
    }
    Node* linkedList(const std::vector<double>& data, int start, int end, int dim, bool clockwise) {
        Node* last = nullptr;
        if (clockwise == (signedArea(data, start, end, dim) > 0)) { for (int i = start; i < end; i += dim) last = insertNode(i / dim, data[i], data[i + 1], last); }
        else { for (int i = end - dim; i >= start; i -= dim) last = insertNode(i / dim, data[i], data[i + 1], last); }
        if (last && equals(last, last->next)) { removeNode(last); last = last->next; }
        return last;
    }
    static double area(const Node* p, const Node* q, const Node* r) { return (q->y - p->y) * (r->x - q->x) - (q->x - p->x) * (r->y - q->y); }
    static bool equals(const Node* a, const Node* b) { return a->x == b->x && a->y == b->y; }
    static int sign(double v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
    static bool onSegment(const Node* p, const Node* q, const Node* r) { return q->x <= std::max(p->x, r->x) && q->x >= std::min(p->x, r->x) && q->y <= std::max(p->y, r->y) && q->y >= std::min(p->y, r->y); }
    static bool intersects(const Node* p1, const Node* q1, const Node* p2, const Node* q2) {
        const int o1 = sign(area(p1, q1, p2)), o2 = sign(area(p1, q1, q2)), o3 = sign(area(p2, q2, p1)), o4 = sign(area(p2, q2, q1));
        if (o1 != o2 && o3 != o4) return true;
        if (o1 == 0 && onSegment(p1, p2, q1)) return true;
        if (o2 == 0 && onSegment(p1, q2, q1)) return true;
        if (o3 == 0 && onSegment(p2, p1, q2)) return true;
        if (o4 == 0 && onSegment(p2, q1, q2)) return true;
        return false;
    }
    static bool pointInTriangle(double ax, double ay, double bx, double by, double cx, double cy, double px, double py) {
        return (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py);
    }
    static bool pointInTriangleExceptFirst(double ax, double ay, double bx, double by, double cx, double cy, double px, double py) {
        return !(ax == px && ay == py) && pointInTriangle(ax, ay, bx, by, cx, cy, px, py);
    }
    static bool locallyInside(const Node* a, const Node* b) {
        return area(a->prev, a, a->next) < 0 ? area(a, b, a->next) >= 0 && area(a, a->prev, b) >= 0 : area(a, b, a->prev) < 0 || area(a, a->next, b) < 0;
    }
    static bool middleInside(const Node* a, const Node* b) {
        const Node* p = a;
        bool inside = false;
        const double px = (a->x + b->x) / 2, py = (a->y + b->y) / 2;
        do {
            if (((p->y > py) != (p->next->y > py)) && p->next->y != p->y && (px < (p->next->x - p->x) * (py - p->y) / (p->next->y - p->y) + p->x)) inside = !inside;
            p = p->next;
        } while (p != a);
        return inside;
    }
    static bool intersectsPolygon(const Node* a, const Node* b) {
        const Node* p = a;
        do {
            if (p->i != a->i && p->next->i != a->i && p->i != b->i && p->next->i != b->i && intersects(p, p->next, a, b)) return true;
            p = p->next;
        } while (p != a);
        return false;
    }
    static bool isValidDiagonal(const Node* a, const Node* b) {
        return a->next->i != b->i && a->prev->i != b->i && !intersectsPolygon(a, b) &&
               ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) && (truthy(area(a->prev, a, b->prev)) || truthy(area(a, b->prev, b)))) ||
                (equals(a, b) && area(a->prev, a, a->next) > 0 && area(b->prev, b, b->next) > 0));
    }
    Node* splitPolygon(Node* a, Node* b) {
        Node* a2 = createNode(a->i, a->x, a->y);
        Node* b2 = createNode(b->i, b->x, b->y);
        Node* an = a->next;
        Node* bp = b->prev;
        a->next = b; b->prev = a;
        a2->next = an; an->prev = a2;
        b2->next = a2; a2->prev = b2;
        bp->next = b2; b2->prev = bp;
        return b2;
    }
    static Node* filterPoints(Node* start, Node* end = nullptr) {
        if (!start) return start;
        if (!end) end = start;
        Node* p = start;
        bool again;
        do {
            again = false;
            if (!p->steiner && (equals(p, p->next) || area(p->prev, p, p->next) == 0)) {
                removeNode(p);
                p = end = p->prev;
                if (p == p->next) break;
                again = true;
            } else p = p->next;
        } while (again || p != end);
        return end;
    }
    static int32_t zOrder(double xd, double yd, double minX, double minY, double invSize) {
        int32_t x = static_cast<int32_t>((xd - minX) * invSize), y = static_cast<int32_t>((yd - minY) * invSize);
        x = (x | (x << 8)) & 0x00FF00FF; x = (x | (x << 4)) & 0x0F0F0F0F; x = (x | (x << 2)) & 0x33333333; x = (x | (x << 1)) & 0x55555555;
        y = (y | (y << 8)) & 0x00FF00FF; y = (y | (y << 4)) & 0x0F0F0F0F; y = (y | (y << 2)) & 0x33333333; y = (y | (y << 1)) & 0x55555555;
        return x | (y << 1);
    }
    static void sortLinked(Node* list) {
        int numMerges, inSize = 1;
        do {
            Node* p = list;
            Node* e;
            list = nullptr;
            Node* tail = nullptr;
            numMerges = 0;
            while (p) {
                numMerges++;
                Node* q = p;
                int pSize = 0;
                for (int i = 0; i < inSize; i++) { pSize++; q = q->nextZ; if (!q) break; }
                int qSize = inSize;
                while (pSize > 0 || (qSize > 0 && q)) {
                    if (pSize != 0 && (qSize == 0 || !q || p->z <= q->z)) { e = p; p = p->nextZ; pSize--; }
                    else { e = q; q = q->nextZ; qSize--; }
                    if (tail) tail->nextZ = e; else list = e;
                    e->prevZ = tail;
                    tail = e;
                }
                p = q;
            }
            tail->nextZ = nullptr;
            inSize *= 2;
        } while (numMerges > 1);
    }
    static void indexCurve(Node* start, double minX, double minY, double invSize) {
        Node* p = start;
        do {
            if (p->z == 0) p->z = zOrder(p->x, p->y, minX, minY, invSize);
            p->prevZ = p->prev;
            p->nextZ = p->next;
            p = p->next;
        } while (p != start);
        p->prevZ->nextZ = nullptr;
        p->prevZ = nullptr;
        sortLinked(p);
    }
    static bool isEar(const Node* ear) {
        const Node* a = ear->prev;
        const Node* b = ear;
        const Node* c = ear->next;
        if (area(a, b, c) >= 0) return false;
        const double ax = a->x, bx = b->x, cx = c->x, ay = a->y, by = b->y, cy = c->y;
        const double x0 = std::min({ax, bx, cx}), y0 = std::min({ay, by, cy}), x1 = std::max({ax, bx, cx}), y1 = std::max({ay, by, cy});
        const Node* p = c->next;
        while (p != a) {
            if (p->x >= x0 && p->x <= x1 && p->y >= y0 && p->y <= y1 && pointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, p->x, p->y) && area(p->prev, p, p->next) >= 0) return false;
            p = p->next;
        }
        return true;
    }
    static bool isEarHashed(const Node* ear, double minX, double minY, double invSize) {
        const Node* a = ear->prev;
        const Node* b = ear;
        const Node* c = ear->next;
        if (area(a, b, c) >= 0) return false;
        const double ax = a->x, bx = b->x, cx = c->x, ay = a->y, by = b->y, cy = c->y;
        const double x0 = std::min({ax, bx, cx}), y0 = std::min({ay, by, cy}), x1 = std::max({ax, bx, cx}), y1 = std::max({ay, by, cy});
        const int32_t minZ = zOrder(x0, y0, minX, minY, invSize), maxZ = zOrder(x1, y1, minX, minY, invSize);
        const Node* p = ear->prevZ;
        const Node* n = ear->nextZ;
        const auto blocks = [&](const Node* q) { return q->x >= x0 && q->x <= x1 && q->y >= y0 && q->y <= y1 && q != a && q != c && pointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, q->x, q->y) && area(q->prev, q, q->next) >= 0; };
        while (p && p->z >= minZ && n && n->z <= maxZ) {
            if (blocks(p)) return false;
            p = p->prevZ;
            if (blocks(n)) return false;
            n = n->nextZ;
        }
        while (p && p->z >= minZ) { if (blocks(p)) return false; p = p->prevZ; }
        while (n && n->z <= maxZ) { if (blocks(n)) return false; n = n->nextZ; }
        return true;
    }
    Node* cureLocalIntersections(Node* start) {
        Node* p = start;
        do {
            Node* a = p->prev;
            Node* b = p->next->next;
            if (!equals(a, b) && intersects(a, p, p->next, b) && locallyInside(a, b) && locallyInside(b, a)) {
                triangles_.push_back(a->i); triangles_.push_back(p->i); triangles_.push_back(b->i);
                removeNode(p);
                removeNode(p->next);
                p = start = b;
            }
            p = p->next;
        } while (p != start);
        return filterPoints(p);
    }
    void splitEarcut(Node* start, double minX, double minY, double invSize) {
        Node* a = start;
        do {
            Node* b = a->next->next;
            while (b != a->prev) {
                if (a->i != b->i && isValidDiagonal(a, b)) {
                    Node* c = splitPolygon(a, b);
                    a = filterPoints(a, a->next);
                    c = filterPoints(c, c->next);
                    earcutLinked(a, minX, minY, invSize, 0);
                    earcutLinked(c, minX, minY, invSize, 0);
                    return;
                }
                b = b->next;
            }
            a = a->next;
        } while (a != start);
    }
    void earcutLinked(Node* ear, double minX, double minY, double invSize, int pass) {
        if (!ear) return;
        if (!pass && truthy(invSize)) indexCurve(ear, minX, minY, invSize);
        Node* stop = ear;
        while (ear->prev != ear->next) {
            Node* prev = ear->prev;
            Node* next = ear->next;
            if (truthy(invSize) ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
                triangles_.push_back(prev->i); triangles_.push_back(ear->i); triangles_.push_back(next->i);
                removeNode(ear);
                ear = next->next;
                stop = next->next;
                continue;
            }
            ear = next;
            if (ear == stop) {
                if (!pass) earcutLinked(filterPoints(ear), minX, minY, invSize, 1);
                else if (pass == 1) { ear = cureLocalIntersections(filterPoints(ear)); earcutLinked(ear, minX, minY, invSize, 2); }
                else if (pass == 2) splitEarcut(ear, minX, minY, invSize);
                break;
            }
        }
    }
};

/** lattice-stitch.ts triangulate on one loop: earcut in 2D, undefined (empty) when it drops a loop edge. */
inline std::optional<std::vector<Tri>> triangulate(const std::vector<int>& outer, const std::vector<std::array<double, 2>>& xy, Earcut& ec) {
    const size_t n = outer.size();
    std::vector<std::array<double, 2>> contour(xy);
    double a = 0;
    for (size_t i = 0; i < n; ++i) { const auto& p = contour[i]; const auto& q = contour[(i + 1) % n]; a = a + p[0] * q[1] - q[0] * p[1]; }
    std::vector<int> ids(outer);
    if (a < 0) { std::reverse(contour.begin(), contour.end()); std::reverse(ids.begin(), ids.end()); }
    // three's ShapeUtils.triangulateShape: a closing point equal to the first is dropped
    if (contour.size() > 2 && contour.back()[0] == contour.front()[0] && contour.back()[1] == contour.front()[1]) contour.pop_back();
    std::vector<double> data;
    data.reserve(contour.size() * 2);
    for (const auto& p : contour) { data.push_back(p[0]); data.push_back(p[1]); }
    const auto tri = ec.run(data);
    std::vector<Tri> out;
    std::unordered_set<uint64_t> got;
    for (size_t i = 0; i + 2 < tri.size(); i += 3) {
        const Tri t{ids[tri[i]], ids[tri[i + 1]], ids[tri[i + 2]]};
        out.push_back(t);
        for (int k = 0; k < 3; ++k) got.insert(ekey(t[k], t[(k + 1) % 3]));
    }
    for (size_t k = 0; k < n; ++k) if (!got.count(ekey(outer[k], outer[(k + 1) % n]))) return std::nullopt;
    return out;
}

/** Whether a point lies on one of these triangles (within tol, inside it, facing like n within about 25 degrees), none touching `not`. */
class SurfaceProbe {
public:
    SurfaceProbe(const std::vector<V3>& pos, const std::vector<Tri>& tris, const std::vector<int>* subset, double tol, double C, const std::vector<std::array<V3, 3>>& near)
        : tris_(tris), tol_(tol), C_(C) {
        // the cells any point of the near triangles can fall in (each sampled no coarser than C, the cell and its neighbours)
        std::unordered_set<CellKey, CellHash> seen, focus;
        for (const auto& t : near) {
            const auto& a = t[0];
            const auto& b = t[1];
            const auto& c = t[2];
            const int div = std::max(1, static_cast<int>(std::ceil(std::max({dist3(a, b), dist3(b, c), dist3(c, a)}) / C)));
            for (int i = 0; i <= div; ++i) for (int j = 0; i + j <= div; ++j) {
                const double u = static_cast<double>(i) / div, v = static_cast<double>(j) / div;
                const CellKey k = cellOf(a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v, a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v, a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v, C);
                if (!seen.insert(k).second) continue;
                for (int dx = -1; dx <= 1; ++dx) for (int dy = -1; dy <= 1; ++dy) for (int dz = -1; dz <= 1; ++dz) focus.insert({k.x + dx, k.y + dy, k.z + dz});
            }
        }
        if (focus.empty()) return;
        const size_t nt = subset ? subset->size() : tris.size();
        T_.resize(nt * 13);
        ids_.resize(nt);
        for (size_t s = 0; s < nt; ++s) {
            const int t = subset ? (*subset)[s] : static_cast<int>(s);
            ids_[s] = t;
            const auto& a = pos[tris[t][0]];
            const auto& b = pos[tris[t][1]];
            const auto& c = pos[tris[t][2]];
            const V3 m = cross3(sub3(b, a), sub3(c, a));
            const double vals[13] = {a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], m[0], m[1], m[2], len3(m)};
            std::copy(vals, vals + 13, T_.begin() + s * 13);
            int64_t lo[3], hi[3];
            for (int k = 0; k < 3; ++k) { lo[k] = static_cast<int64_t>(std::floor((std::min({a[k], b[k], c[k]}) - tol) / C)); hi[k] = static_cast<int64_t>(std::floor((std::max({a[k], b[k], c[k]}) + tol) / C)); }
            if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 4000) continue;
            for (int64_t x = lo[0]; x <= hi[0]; ++x) for (int64_t y = lo[1]; y <= hi[1]; ++y) for (int64_t z = lo[2]; z <= hi[2]; ++z) {
                const CellKey k{x, y, z};
                if (!focus.count(k)) continue;
                grid_[k].push_back(static_cast<int>(s));
            }
        }
    }
    bool operator()(const V3& q, const V3& n, const Tri* notOf = nullptr) const {
        const double nl = len3(n);
        if (!(nl > 0)) return false;
        const auto it = grid_.find(cellOf(q[0], q[1], q[2], C_));
        if (it == grid_.end()) return false;
        for (int s : it->second) {
            if (notOf) { const auto& f = tris_[ids_[s]]; bool touch = false; for (int v : f) if (v == (*notOf)[0] || v == (*notOf)[1] || v == (*notOf)[2]) touch = true; if (touch) continue; }
            const double* o = T_.data() + static_cast<size_t>(s) * 13;
            const double m0 = o[9], m1 = o[10], m2 = o[11], ml = o[12];
            if (!(ml > 0) || std::fabs(m0 * n[0] + m1 * n[1] + m2 * n[2]) < 0.9 * ml * nl) continue;
            const double ax = o[0], ay = o[1], az = o[2], bx = o[3], by = o[4], bz = o[5], cx = o[6], cy = o[7], cz = o[8];
            const double d = ((q[0] - ax) * m0 + (q[1] - ay) * m1 + (q[2] - az) * m2) / ml;
            if (std::fabs(d) > tol_) continue;
            const double r0 = q[0] - (m0 * d) / ml, r1 = q[1] - (m1 * d) / ml, r2 = q[2] - (m2 * d) / ml;
            const auto crossDot = [&](double ux, double uy, double uz, double vx, double vy, double vz) { return (uy * vz - uz * vy) * m0 + (uz * vx - ux * vz) * m1 + (ux * vy - uy * vx) * m2; };
            const double s1 = crossDot(bx - ax, by - ay, bz - az, r0 - ax, r1 - ay, r2 - az);
            const double s2 = crossDot(cx - bx, cy - by, cz - bz, r0 - bx, r1 - by, r2 - bz);
            const double s3 = crossDot(ax - cx, ay - cy, az - cz, r0 - cx, r1 - cy, r2 - cz);
            if (s1 >= 0 && s2 >= 0 && s3 >= 0) return true;
        }
        return false;
    }

private:
    const std::vector<Tri>& tris_;
    double tol_, C_;
    std::vector<double> T_;
    std::vector<int> ids_;
    std::unordered_map<CellKey, std::vector<int>, CellHash> grid_;
};

/** Does a ray meet a triangle of the mesh: cells walked (Amanatides-Woo), each cell's triangles tested once (Moller-Trumbore). */
class RayIndex {
public:
    RayIndex(const std::vector<V3>& pos, const std::vector<Tri>& tris, double C = 2) : pos_(pos), tris_(tris), C_(C) {
        for (size_t t = 0; t < tris.size(); ++t) {
            const auto& a = pos[tris[t][0]];
            const auto& b = pos[tris[t][1]];
            const auto& c = pos[tris[t][2]];
            int64_t lo[3], hi[3];
            for (int k = 0; k < 3; ++k) { lo[k] = static_cast<int64_t>(std::floor(std::min({a[k], b[k], c[k]}) / C)); hi[k] = static_cast<int64_t>(std::floor(std::max({a[k], b[k], c[k]}) / C)); }
            if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 20000) continue;
            for (int64_t x = lo[0]; x <= hi[0]; ++x) for (int64_t y = lo[1]; y <= hi[1]; ++y) for (int64_t z = lo[2]; z <= hi[2]; ++z) grid_[{x, y, z}].push_back(static_cast<int>(t));
        }
    }
    bool meets(const V3& o, const V3& d, double maxM) const {
        int64_t cell[3];
        int step[3];
        double tMax[3], tDelta[3];
        for (int k = 0; k < 3; ++k) {
            cell[k] = static_cast<int64_t>(std::floor(o[k] / C_));
            step[k] = d[k] > 0 ? 1 : d[k] < 0 ? -1 : 0;
            tMax[k] = d[k] == 0 ? std::numeric_limits<double>::infinity() : ((cell[k] + (d[k] > 0 ? 1 : 0)) * C_ - o[k]) / d[k];
            tDelta[k] = d[k] == 0 ? std::numeric_limits<double>::infinity() : C_ / std::fabs(d[k]);
        }
        std::unordered_set<int> seen;
        for (int guard = 0; guard < 10000; ++guard) {
            const auto it = grid_.find({cell[0], cell[1], cell[2]});
            if (it != grid_.end()) for (int t : it->second) { if (!seen.insert(t).second) continue; if (hit(t, o, d, maxM)) return true; }
            const int k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
            if (tMax[k] > maxM) return false;
            cell[k] += step[k];
            tMax[k] += tDelta[k];
        }
        return false;
    }

private:
    bool hit(int t, const V3& o, const V3& d, double maxM) const {
        const auto& a = pos_[tris_[t][0]];
        const auto& b = pos_[tris_[t][1]];
        const auto& c = pos_[tris_[t][2]];
        const V3 e1 = sub3(b, a), e2 = sub3(c, a), p = cross3(d, e2);
        const double det = dot(e1, p);
        if (std::fabs(det) < 1e-12) return false;
        const V3 s = sub3(o, a);
        const double u = dot(s, p) / det;
        if (u < 0 || u > 1) return false;
        const V3 q = cross3(s, e1);
        const double v = dot(d, q) / det;
        if (v < 0 || u + v > 1) return false;
        const double tt = dot(e2, q) / det;
        return tt > 0 && tt <= maxM;
    }
    const std::vector<V3>& pos_;
    const std::vector<Tri>& tris_;
    double C_;
    std::unordered_map<CellKey, std::vector<int>, CellHash> grid_;
};

struct Int3Hash {
    size_t operator()(const std::array<int64_t, 3>& k) const { return CellHash{}({k[0], k[1], k[2]}); }
};

/** One loop's caps: its triangles (vertex ids) with their cap number within the loop, and what it adds to the report. */
struct LoopOut {
    std::vector<Tri> tris;
    std::vector<int> cap;
    int popped = 0, split = 0, filled = 0, clipped3d = 0, skippedWallOnly = 0, rejectedTriangles = 0, unclosedLoops = 0, refusedCaps = 0;
    std::vector<double> refusedAreas;
};

}  // namespace detail

/**
 * The open loops of the clay closed (lattice-stitch.ts fillOpenLoops' geometry). `prims` in the clay's mesh and primitive
 * order; `footprint` the structure's plan loops [x, z] (none: no footprint test).
 */
inline Result fillOpenLoops(const std::vector<Prim>& prims, const std::vector<std::vector<std::array<double, 2>>>& footprint, const Params& P, FixedThreadPool& pool) {
    using namespace detail;
    // the welded view: positions, faces and each face's rebuilt wall
    std::vector<V3> pos;
    std::vector<Tri> tris;
    std::vector<int> wall;
    {
        std::unordered_map<std::array<int64_t, 3>, int, Int3Hash> id;
        const auto q = [&](double x, double y, double z) {
            const std::array<int64_t, 3> k{static_cast<int64_t>(jsRound(x / P.weldM)), static_cast<int64_t>(jsRound(y / P.weldM)), static_cast<int64_t>(jsRound(z / P.weldM))};
            const auto [it, fresh] = id.emplace(k, static_cast<int>(pos.size()));
            if (fresh) pos.push_back({x, y, z});
            return it->second;
        };
        for (const auto& pr : prims) {
            const size_t n = pr.indexed ? pr.I.size() : pr.X.size() / 3;
            for (size_t t = 0; t + 2 < n; t += 3) {
                Tri f;
                for (int j = 0; j < 3; ++j) { const size_t i = pr.indexed ? pr.I[t + j] : t + j; f[j] = q(pr.X[i * 3], pr.X[i * 3 + 1], pr.X[i * 3 + 2]); }
                if (f[0] == f[1] || f[1] == f[2] || f[0] == f[2]) continue;
                tris.push_back(f);
                wall.push_back(pr.wall);
            }
        }
    }
    if (pos.size() >= kEdgeBase) throw std::runtime_error("the infill keys edges by vertex ids under " + std::to_string(kEdgeBase) + "; this mesh has " + std::to_string(pos.size()) + " vertices");
    // the open edges (an odd number of triangles), in the order their edge first appears; the last triangle owning each
    std::unordered_map<uint64_t, uint32_t> edgeAt;
    std::vector<std::pair<uint64_t, int>> edgeCount;
    std::vector<int> edgeOwner;
    edgeAt.reserve(tris.size() * 2);
    for (size_t t = 0; t < tris.size(); ++t) for (int k = 0; k < 3; ++k) {
        const uint64_t e = ekey(tris[t][k], tris[t][(k + 1) % 3]);
        const auto [it, fresh] = edgeAt.emplace(e, static_cast<uint32_t>(edgeCount.size()));
        if (fresh) { edgeCount.push_back({e, 0}); edgeOwner.push_back(-1); }
        edgeCount[it->second].second++;
        edgeOwner[it->second] = static_cast<int>(t);
    }
    std::vector<std::pair<int, int>> open;
    for (const auto& [e, c] : edgeCount) if (c % 2 == 1) open.push_back({static_cast<int>(e / kEdgeBase), static_cast<int>(e % kEdgeBase)});
    const auto ownerOf = [&](uint64_t e) -> int { const auto it = edgeAt.find(e); return it == edgeAt.end() ? -1 : edgeOwner[it->second]; };
    std::unordered_map<int, int> wallFacade;
    std::vector<uint8_t> scanVert(pos.size(), 0);
    for (size_t i = 0; i < tris.size(); ++i) {
        if (wall[i] >= 0) for (int v : tris[i]) wallFacade[v] = wall[i];
        else for (int v : tris[i]) scanVert[v] = 1;
    }
    const auto d2 = [&](int a, int b) { const double x = pos[a][0] - pos[b][0], y = pos[a][1] - pos[b][1], z = pos[a][2] - pos[b][2]; return x * x + y * y + z * z; };
    // loops: trails over the open edges, split where a walk comes back to a vertex, turning to the nearest edge at a junction
    std::unordered_map<int, std::vector<int>> adj;
    for (auto [a, b] : open) { adj[a].push_back(b); adj[b].push_back(a); }
    std::unordered_set<uint64_t> used;
    std::vector<std::vector<int>> loops;
    Result res;
    Report& report = res.report;
    for (auto [a0, b0] : open) {
        if (used.count(ekey(a0, b0))) continue;
        used.insert(ekey(a0, b0));
        std::vector<int> path{a0};
        std::unordered_map<int, int> at{{a0, 0}};
        int prev = a0, cur = b0;
        for (int guard = 0; guard < 500000; ++guard) {
            const auto k = at.find(cur);
            if (k != at.end()) {
                const int from = k->second;
                std::vector<int> loop(path.begin() + from, path.end());
                path.resize(from);
                for (int v : loop) at.erase(v);
                if (loop.size() >= 3) loops.push_back(std::move(loop)); else report.openPathEdges += static_cast<int>(loop.size()) - 1;
                if (path.empty()) break;
            }
            at[cur] = static_cast<int>(path.size());
            path.push_back(cur);
            int nx = -1;
            double bd = std::numeric_limits<double>::infinity();
            const auto& nb = adj[cur];
            for (int x : nb) if (!used.count(ekey(cur, x)) && x != prev) { const double d = d2(cur, x); if (d < bd) { bd = d; nx = x; } }
            if (nx < 0) for (int x : nb) if (!used.count(ekey(cur, x))) { nx = x; break; }
            if (nx < 0) break;
            used.insert(ekey(cur, nx));
            prev = cur;
            cur = nx;
        }
        report.openPathEdges += std::max(0, static_cast<int>(path.size()) - 1);
    }
    const char* kindNames[4] = {"inside one wall", "between two walls", "wall to scan", "scan"};
    int kindCount[4] = {0, 0, 0, 0}, kindOrder[4], kinds = 0;
    for (auto [a, b] : open) {
        const auto fa = wallFacade.find(a), fb = wallFacade.find(b);
        const bool ha = fa != wallFacade.end(), hb = fb != wallFacade.end();
        const int k = ha && hb ? (fa->second == fb->second ? 0 : 1) : ha || hb ? 2 : 3;
        if (!kindCount[k]++) kindOrder[kinds++] = k;
    }
    report.openBefore = static_cast<int>(open.size());
    for (int i = 0; i < kinds; ++i) report.kinds.push_back({kindNames[kindOrder[i]], kindCount[kindOrder[i]]});
    report.loops = static_cast<int>(loops.size());
    // the building's envelope before the fill: its top-down height map (the highest surface per cell), raised in parallel
    const double cell = P.envelopeCellM;
    using PlanMap = std::unordered_map<std::array<int64_t, 3>, double, Int3Hash>;
    PlanMap top;
    {
        const size_t chunks = std::max<size_t>(1, std::min<size_t>(pool.size() * 4, (tris.size() + 4095) / 4096));
        std::vector<PlanMap> part(chunks);
        pool.forEach(chunks, [&](size_t c) {
            auto& m = part[c];
            const size_t b = tris.size() * c / chunks, e = tris.size() * (c + 1) / chunks;
            for (size_t t = b; t < e; ++t) {
                const auto& a = pos[tris[t][0]];
                const auto& bb = pos[tris[t][1]];
                const auto& cc = pos[tris[t][2]];
                const int steps = std::min(30, std::max(1, static_cast<int>(std::ceil(std::max(hypot({bb[0] - a[0], bb[2] - a[2]}), hypot({cc[0] - a[0], cc[2] - a[2]})) / cell))));
                for (int p = 0; p <= steps; ++p) for (int q = 0; p + q <= steps; ++q) {
                    const double u = static_cast<double>(p) / steps, v = static_cast<double>(q) / steps;
                    const double x = a[0] + (bb[0] - a[0]) * u + (cc[0] - a[0]) * v, y = a[1] + (bb[1] - a[1]) * u + (cc[1] - a[1]) * v, z = a[2] + (bb[2] - a[2]) * u + (cc[2] - a[2]) * v;
                    const std::array<int64_t, 3> k{static_cast<int64_t>(std::floor(x / cell)), static_cast<int64_t>(std::floor(z / cell)), 0};
                    const auto [it, fresh] = m.emplace(k, y);
                    if (!fresh && y > it->second) it->second = y;
                }
            }
        });
        for (auto& m : part) for (const auto& [k, y] : m) { const auto [it, fresh] = top.emplace(k, y); if (!fresh && y > it->second) it->second = y; }
    }
    const auto topNear = [&](double x, double z) {
        double m = -std::numeric_limits<double>::infinity();
        const int64_t cx = static_cast<int64_t>(std::floor(x / cell)), cz = static_cast<int64_t>(std::floor(z / cell));
        for (int dx = -1; dx <= 1; ++dx) for (int dz = -1; dz <= 1; ++dz) { const auto it = top.find({cx + dx, cz + dz, 0}); if (it != top.end() && it->second > m) m = it->second; }
        return m;
    };
    const auto past = [&](const V3& p) { return !footprint.empty() ? std::max(0.0, outsideFootprint(p[0], p[2], footprint)) : 0.0; };
    const auto outsidePt = [&](const V3& p, double allowed) { return !(p[1] <= topNear(p[0], p[2]) + P.envelopeMarginM) || past(p) > allowed + P.envelopeMarginM; };
    const auto inside = [&](const Tri& t) {
        const auto& a = pos[t[0]];
        const auto& b = pos[t[1]];
        const auto& c = pos[t[2]];
        const double allowed = std::max({past(a), past(b), past(c)});
        const auto mid = [](const V3& p, const V3& q) { return V3{(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2}; };
        const V3 probes[4] = {{(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3}, mid(a, b), mid(b, c), mid(c, a)};
        for (const auto& p : probes) if (outsidePt(p, allowed)) return false;
        return true;
    };
    const auto dist = [&](int a, int b) { return std::sqrt(d2(a, b)); };
    // each loop (with its splits, which the TypeScript's stack runs before the next loop) closed on its own
    std::vector<LoopOut> per(loops.size());
    pool.forEach(loops.size(), [&](size_t li) {
        LoopOut& lo = per[li];
        Earcut ec;
        std::vector<std::vector<int>> stack{loops[li]};
        int capNo = -1;
        const auto emit = [&](const Tri& t) { lo.tris.push_back(t); lo.cap.push_back(capNo); };
        while (!stack.empty()) {
            const std::vector<int> l = std::move(stack.back());
            stack.pop_back();
            capNo++;
            lo.popped++;
            const size_t n = l.size();
            bool anyScan = false, single = true;
            int fac = -2;
            for (int v : l) {
                if (scanVert[v]) anyScan = true;
                const auto it = wallFacade.find(v);
                const int f = it == wallFacade.end() ? -1 : it->second;
                if (fac == -2) fac = f; else if (f != fac) single = false;
            }
            const bool wallOnly = !anyScan && single && fac != -1;
            std::vector<double> cum{0};
            for (size_t i = 0; i < n; ++i) cum.push_back(cum[i] + dist(l[i], l[(i + 1) % n]));
            const double perim = cum[n];
            if (perim > P.splitPerimeterM && n >= 6) {
                const size_t stepI = std::max<size_t>(1, static_cast<size_t>(std::ceil(n / 1500.0)));
                int bi = -1, bj = -1;
                double br = std::numeric_limits<double>::infinity();
                for (size_t i = 0; i < n; i += stepI) for (size_t j = i + 2; j < n; j += stepI) {
                    const double along = std::min(cum[j] - cum[i], perim - (cum[j] - cum[i]));
                    if (along < 3 * perim / n || (i == 0 && j == n - 1)) continue;
                    const double r = dist(l[i], l[j]) / along;
                    if (r < br) { br = r; bi = static_cast<int>(i); bj = static_cast<int>(j); }
                }
                if (bi >= 0 && br < P.splitRatio) {
                    const auto& pa = pos[l[bi]];
                    const auto& pb = pos[l[bj]];
                    const V3 m{(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2};
                    if (!outsidePt(m, std::max(past(pa), past(pb)))) {
                        stack.emplace_back(l.begin() + bi, l.begin() + bj + 1);
                        std::vector<int> other(l.begin() + bj, l.end());
                        other.insert(other.end(), l.begin(), l.begin() + bi + 1);
                        stack.push_back(std::move(other));
                        lo.split++;
                        continue;
                    }
                }
            }
            V3 nn{0, 0, 0};
            for (size_t i = 0; i < n; ++i) {
                const auto& a = pos[l[i]];
                const auto& b = pos[l[(i + 1) % n]];
                nn[0] += (a[1] - b[1]) * (a[2] + b[2]); nn[1] += (a[2] - b[2]) * (a[0] + b[0]); nn[2] += (a[0] - b[0]) * (a[1] + b[1]);
            }
            const double nl = len3(nn);
            if (nl > 1e-12) {
                const V3 N{nn[0] / nl, nn[1] / nl, nn[2] / nl};
                V3 c{0, 0, 0};
                for (int k = 0; k < 3; ++k) { double s = 0; for (int v : l) s += pos[v][k]; c[k] = s / n; }
                double off = -std::numeric_limits<double>::infinity();
                for (int v : l) off = std::max(off, std::fabs(dot(sub3(pos[v], c), N)));
                if (off > P.rimPlanarM && nl / 2 > P.offRimCapM2) { lo.refusedCaps++; lo.refusedAreas.push_back(nl / 2); continue; }
            }
            std::optional<std::vector<Tri>> tri;
            if (nl > 1e-12) {
                const V3 N{nn[0] / nl, nn[1] / nl, nn[2] / nl};
                const V3 ref = std::fabs(N[1]) < 0.9 ? V3{0, 1, 0} : V3{1, 0, 0};
                const V3 U0{ref[1] * N[2] - ref[2] * N[1], ref[2] * N[0] - ref[0] * N[2], ref[0] * N[1] - ref[1] * N[0]};
                const double ul = len3(U0);
                const V3 U{U0[0] / ul, U0[1] / ul, U0[2] / ul};
                const V3 V{N[1] * U[2] - N[2] * U[1], N[2] * U[0] - N[0] * U[2], N[0] * U[1] - N[1] * U[0]};
                const auto xy = [&](const V3& p) { return std::array<double, 2>{dot(p, U), dot(p, V)}; };
                std::vector<std::array<double, 2>> poly(n);
                for (size_t i = 0; i < n; ++i) poly[i] = xy(pos[l[i]]);
                if (wallOnly) {
                    // the wall beside the loop: a triangle owning one of its edges (a split loop's chord has none)
                    int ownerIdx = -1;
                    for (size_t i = 0; i < n && ownerIdx < 0; ++i) ownerIdx = ownerOf(ekey(l[i], l[(i + 1) % n]));
                    if (ownerIdx < 0) { lo.skippedWallOnly++; continue; }
                    const auto& t = tris[ownerIdx];
                    V3 c;
                    for (int k = 0; k < 3; ++k) c[k] = (pos[t[0]][k] + pos[t[1]][k] + pos[t[2]][k]) / 3;
                    const auto qq = xy(c);
                    bool within = false;
                    for (size_t i = 0, j = n - 1; i < n; j = i++) {
                        const auto& a = poly[i];
                        const auto& b = poly[j];
                        if ((a[1] > qq[1]) != (b[1] > qq[1]) && qq[0] < ((b[0] - a[0]) * (qq[1] - a[1])) / (b[1] - a[1]) + a[0]) within = !within;
                    }
                    if (within) { lo.skippedWallOnly++; continue; }
                }
                tri = triangulate(l, poly, ec);
            } else if (wallOnly) { lo.skippedWallOnly++; continue; }
            if (tri) {
                bool allIn = true;
                for (const auto& t : *tri) if (!inside(t)) { allIn = false; break; }
                if (allIn) { lo.filled++; for (const auto& t : *tri) emit(t); continue; }
            }
            // not flat, or poking out: greedy Liepa ears inside the building; when none is, the rest stays open
            std::vector<int> ring(l);
            bool closed = true;
            while (ring.size() >= 3) {
                const size_t R = ring.size();
                int bi = -1;
                double bd = std::numeric_limits<double>::infinity();
                for (size_t k = 0; k < R; ++k) {
                    const Tri t{ring[(k + R - 1) % R], ring[k], ring[(k + 1) % R]};
                    const double d = d2(t[0], t[2]);
                    if (d < bd && inside(t)) { bd = d; bi = static_cast<int>(k); }
                }
                if (bi < 0) { closed = false; lo.rejectedTriangles++; break; }
                emit({ring[(bi + R - 1) % R], ring[bi], ring[(bi + 1) % R]});
                if (R == 3) { ring.clear(); break; }
                ring.erase(ring.begin() + bi);
            }
            if (closed) lo.clipped3d++; else lo.unclosedLoops++;
        }
    });
    // the loops in the TypeScript's order (its stack pops the last first), their caps numbered on
    std::vector<Tri> addedFaces;
    std::vector<int> capOf;
    int capBase = 0;
    std::vector<double> refusedAreas;
    for (size_t r = loops.size(); r-- > 0;) {
        const LoopOut& lo = per[r];
        for (size_t i = 0; i < lo.tris.size(); ++i) { addedFaces.push_back(lo.tris[i]); capOf.push_back(capBase + lo.cap[i]); }
        capBase += lo.popped;
        report.split += lo.split; report.filled += lo.filled; report.clipped3d += lo.clipped3d; report.skippedWallOnly += lo.skippedWallOnly;
        report.rejectedTriangles += lo.rejectedTriangles; report.unclosedLoops += lo.unclosedLoops; report.refusedCaps += lo.refusedCaps;
        refusedAreas.insert(refusedAreas.end(), lo.refusedAreas.begin(), lo.refusedAreas.end());
    }
    for (double a : refusedAreas) report.refusedCapM2 += a;
    const auto corners = [&](const Tri& t) { return std::array<V3, 3>{pos[t[0]], pos[t[1]], pos[t[2]]}; };
    // each cap faced out of the building: a ray from it, the way it faces, that meets the building means it faces in
    {
        const RayIndex rays(pos, tris);
        std::vector<int> capIds;
        std::unordered_map<int, std::vector<int>> caps;
        for (size_t i = 0; i < capOf.size(); ++i) { auto& l = caps[capOf[i]]; if (l.empty()) capIds.push_back(capOf[i]); l.push_back(static_cast<int>(i)); }
        std::vector<uint8_t> turn(capIds.size(), 0);
        pool.forEach(capIds.size(), [&](size_t ci) {
            const auto& list = caps.at(capIds[ci]);
            const auto area = [&](int i) { const auto p = corners(addedFaces[i]); return len3(cross3(sub3(p[1], p[0]), sub3(p[2], p[0]))); };
            std::vector<std::pair<int, double>> byArea;
            for (int i : list) byArea.push_back({i, area(i)});
            std::stable_sort(byArea.begin(), byArea.end(), [](const auto& x, const auto& y) { return x.second > y.second; });
            int samples = 0, inward = 0;
            for (size_t s = 0; s < byArea.size() && s < static_cast<size_t>(P.capRaySamples); ++s) {
                if (!(byArea[s].second > 1e-9)) continue;
                samples++;
                const auto p = corners(addedFaces[byArea[s].first]);
                const V3 nv = cross3(sub3(p[1], p[0]), sub3(p[2], p[0]));
                const double nlen = len3(nv);
                const V3 d{nv[0] / nlen, nv[1] / nlen, nv[2] / nlen};
                V3 o;
                for (int k = 0; k < 3; ++k) o[k] = (p[0][k] + p[1][k] + p[2][k]) / 3 + d[k] * P.capRayStartM;
                if (rays.meets(o, d, P.capRayM)) inward++;
            }
            if (2 * inward > samples) turn[ci] = 1;
        });
        for (size_t ci = 0; ci < capIds.size(); ++ci) {
            if (!turn[ci]) continue;
            for (int i : caps.at(capIds[ci])) { auto& t = addedFaces[i]; t = {t[0], t[2], t[1]}; }
            report.turnedCaps++;
        }
    }
    // fill lying on a surface already there (a second skin) or where a rebuilt wall stands in is dropped
    std::vector<std::array<V3, 3>> out(addedFaces.size());
    for (size_t i = 0; i < addedFaces.size(); ++i) out[i] = corners(addedFaces[i]);
    {
        std::vector<int> wallTris;
        for (size_t i = 0; i < tris.size(); ++i) if (wall[i] >= 0) wallTris.push_back(static_cast<int>(i));
        std::optional<SurfaceProbe> onSurface, onWall;
        pool.forEach(2, [&](size_t k) {
            if (k == 0) onSurface.emplace(pos, tris, nullptr, P.doubledM, 1, out);
            else onWall.emplace(pos, tris, &wallTris, P.coveredByWallM, P.coveredByWallCellM, out);
        });
        std::vector<uint8_t> verdict(out.size(), 0);
        std::vector<double> areaOf(out.size(), 0);
        pool.forEach(out.size(), [&](size_t i) {
            const auto& [a, b, c] = out[i];
            const V3 n = cross3(sub3(b, a), sub3(c, a));
            const auto atL = [](const V3& p, const V3& q, double l) { return V3{p[0] + (q[0] - p[0]) * l, p[1] + (q[1] - p[1]) * l, p[2] + (q[2] - p[2]) * l}; };
            std::vector<V3> probes{{(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3}};
            for (const auto& [p, q] : {std::pair<const V3&, const V3&>{a, b}, {b, c}, {c, a}}) for (double l : {0.0, 0.25, 0.5, 0.75}) probes.push_back(atL(p, q, l));
            areaOf[i] = len3(n) / 2;
            bool all = true;
            for (const auto& q : probes) if (!(*onSurface)(q, n, &addedFaces[i])) { all = false; break; }
            if (all) { verdict[i] = 1; return; }
            all = true;
            for (const auto& q : probes) if (!(*onWall)(q, n)) { all = false; break; }
            if (all) verdict[i] = 2;
        });
        size_t kept = 0;
        for (size_t i = 0; i < out.size(); ++i) {
            if (verdict[i] == 1) { report.droppedDoubledM2 += areaOf[i]; continue; }
            if (verdict[i] == 2) { report.droppedCoveredM2 += areaOf[i]; continue; }
            out[kept] = out[i]; addedFaces[kept] = addedFaces[i]; kept++;
        }
        out.resize(kept);
        addedFaces.resize(kept);
    }
    report.droppedDoubledM2 = jsRound(report.droppedDoubledM2);
    report.droppedCoveredM2 = jsRound(report.droppedCoveredM2);
    report.refusedCapM2 = jsRound(report.refusedCapM2);
    // the textured twin judges the fill in pieces of at most pieceM: a piece lying over a surface already there is left out
    {
        const SurfaceProbe overSurface(pos, tris, nullptr, P.skinM, 1, out);
        struct Parent { std::vector<Piece> pieces; std::vector<double> hidden; };
        std::vector<Parent> per2(out.size());
        pool.forEach(out.size(), [&](size_t parent) {
            const auto& [a, b, c] = out[parent];
            const V3 n = cross3(sub3(b, a), sub3(c, a));
            const int div = std::max(1, static_cast<int>(std::ceil(std::max({dist3(a, b), dist3(b, c), dist3(c, a)}) / P.pieceM)));
            const auto bary = [&](int i, int j) { return V3{static_cast<double>(i) / div, static_cast<double>(j) / div, static_cast<double>(div - i - j) / div}; };
            const auto point = [&](const V3& q) { V3 r; for (int k = 0; k < 3; ++k) r[k] = a[k] * q[0] + b[k] * q[1] + c[k] * q[2]; return r; };
            auto& mine = per2[parent];
            for (int i = 0; i < div; ++i) for (int j = 0; i + j < div; ++j) {
                std::vector<std::array<V3, 3>> subs{{bary(i, j), bary(i + 1, j), bary(i, j + 1)}};
                if (i + j + 1 < div) subs.push_back({bary(i + 1, j), bary(i + 1, j + 1), bary(i, j + 1)});
                for (const auto& wq : subs) {
                    const std::array<V3, 3> p{point(wq[0]), point(wq[1]), point(wq[2])};
                    std::vector<V3> probes;
                    for (int x = 0; x <= 4; ++x) for (int y = 0; x + y <= 4; ++y) if (std::max({x, y, 4 - x - y}) < 4) {
                        V3 q;
                        for (int k = 0; k < 3; ++k) q[k] = (p[0][k] * x + p[1][k] * y + p[2][k] * (4 - x - y)) / 4;
                        probes.push_back(q);
                    }
                    V3 cen;
                    for (int k = 0; k < 3; ++k) cen[k] = (p[0][k] + p[1][k] + p[2][k]) / 3;
                    probes.push_back(cen);
                    const double area = len3(cross3(sub3(p[1], p[0]), sub3(p[2], p[0]))) / 2;
                    int over = 0;
                    for (const auto& q : probes) if (overSurface(q, n)) over++;
                    if (over >= P.skinShare * probes.size()) mine.hidden.push_back(area);
                    else mine.pieces.push_back({static_cast<int>(parent), div * div, p, wq});
                }
            }
        });
        for (auto& pp : per2) {
            for (double h : pp.hidden) report.skinHiddenM2 += h;
            for (auto& pc : pp.pieces) res.pieces.push_back(pc);
        }
    }
    report.skinHiddenM2 = jsRound(report.skinHiddenM2);
    // the edges counted again with the fill: every edge's count from the scan, plus the fill's
    for (const auto& f : addedFaces) for (int k = 0; k < 3; ++k) {
        const uint64_t e = ekey(f[k], f[(k + 1) % 3]);
        const auto [it, fresh] = edgeAt.emplace(e, static_cast<uint32_t>(edgeCount.size()));
        if (fresh) edgeCount.push_back({e, 0});
        edgeCount[it->second].second++;
    }
    for (const auto& [e, c] : edgeCount) { if (c % 2 == 1) report.openAfter++; else if (c > 2) report.nonManifoldAfter++; }
    for (const auto& t : out) {
        const auto& a = t[0];
        const auto& b = t[1];
        const auto& c = t[2];
        const double ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        report.addedAreaM2 += 0.5 * hypot({uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx});
    }
    report.addedAreaM2 = jsRound(report.addedAreaM2);
    res.out = std::move(out);
    return res;
}

/** The report as fillOpenLoops' FillReport JSON, its keys in the TypeScript's order. */
inline std::string reportJson(const Report& r) {
    const auto num = [](double v) { char b[64]; std::snprintf(b, sizeof b, "%.17g", v); return std::string(b); };
    std::string kinds = "{";
    for (size_t i = 0; i < r.kinds.size(); ++i) kinds += (i ? ",\"" : "\"") + r.kinds[i].first + "\":" + std::to_string(r.kinds[i].second);
    kinds += "}";
    return "{\"openBefore\":" + std::to_string(r.openBefore) + ",\"kinds\":" + kinds + ",\"loops\":" + std::to_string(r.loops) + ",\"split\":" + std::to_string(r.split) +
           ",\"filled\":" + std::to_string(r.filled) + ",\"clipped3d\":" + std::to_string(r.clipped3d) + ",\"skippedWallOnly\":" + std::to_string(r.skippedWallOnly) +
           ",\"rejectedTriangles\":" + std::to_string(r.rejectedTriangles) + ",\"unclosedLoops\":" + std::to_string(r.unclosedLoops) + ",\"refusedCaps\":" + std::to_string(r.refusedCaps) +
           ",\"refusedCapM2\":" + num(r.refusedCapM2) + ",\"droppedDoubledM2\":" + num(r.droppedDoubledM2) + ",\"droppedCoveredM2\":" + num(r.droppedCoveredM2) +
           ",\"turnedCaps\":" + std::to_string(r.turnedCaps) + ",\"skinHiddenM2\":" + num(r.skinHiddenM2) + ",\"openPathEdges\":" + std::to_string(r.openPathEdges) +
           ",\"openAfter\":" + std::to_string(r.openAfter) + ",\"nonManifoldAfter\":" + std::to_string(r.nonManifoldAfter) + ",\"addedAreaM2\":" + num(r.addedAreaM2) + "}";
}

}  // namespace open_loop_fill
}  // namespace scratchbox
