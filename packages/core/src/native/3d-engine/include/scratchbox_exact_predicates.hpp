/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Exact geometric predicates on doubles: the sign of an orientation or in-circle determinant is always the sign of the
 * true determinant of the input numbers, never a rounding accident. A fast floating-point evaluation is tried first and
 * trusted only when its error bound says the sign cannot be wrong; otherwise the determinant is evaluated exactly in
 * expansion arithmetic (a value held as a sum of non-overlapping doubles, so sums and products lose nothing).
 * Method: Shewchuk, "Adaptive Precision Floating-Point Arithmetic and Fast Robust Geometric Predicates" (1997).
 *
 * orient3dPerturbed adds simulation of simplicity: each point carries one or two symbolic displacement vectors (point +
 * eps d1 + eps^2 d2 for an infinitesimal eps), and a determinant that is exactly zero takes the sign of its first nonzero
 * coefficient in eps. The perturbed points are a real configuration, so every decision made from them is consistent with
 * every other (the boolean's topology never contradicts itself on coplanar or touching input).
 *
 * Sign conventions (all ours):
 *  - orient2d(a, b, c) = det[b - a, c - a]: positive when c lies left of a->b (a, b, c counter-clockwise);
 *  - orient3d(a, b, c, d) = det[b - a, c - a, d - a]: positive when d lies on the side (b - a) x (c - a) points to;
 *  - incircle(a, b, c, d): positive when d lies inside the circle through a, b, c taken counter-clockwise.
 */

#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

// the error-free transformations below need every product and sum rounded on its own
#if defined(__clang__)
#pragma clang fp contract(off)
#endif

namespace scratchbox {
namespace exact {

using P2 = std::array<double, 2>;
using P3 = std::array<double, 3>;

/** A value as a sum of non-overlapping doubles, smallest magnitude first, zeros dropped. */
using Expansion = std::vector<double>;

inline void twoSum(double a, double b, double& x, double& y) {
    x = a + b;
    const double bv = x - a, av = x - bv;
    y = (a - av) + (b - bv);
}
inline void twoProduct(double a, double b, double& x, double& y) {
    x = a * b;
    y = std::fma(a, b, -x);
}

/** e + b (Shewchuk's GROW-EXPANSION with zero elimination). */
inline Expansion grow(const Expansion& e, double b) {
    Expansion h;
    h.reserve(e.size() + 1);
    double q = b;
    for (double ei : e) {
        double s, err;
        twoSum(q, ei, s, err);
        if (err != 0) h.push_back(err);
        q = s;
    }
    if (q != 0 || h.empty()) h.push_back(q);
    return h;
}

inline Expansion add(const Expansion& e, const Expansion& f) {
    Expansion h = e;
    for (double fi : f) h = grow(h, fi);
    return h;
}

inline Expansion negate(Expansion e) {
    for (double& x : e) x = -x;
    return e;
}

inline Expansion sub(const Expansion& e, const Expansion& f) { return add(e, negate(f)); }

/** e * b (SCALE-EXPANSION with zero elimination). */
inline Expansion scale(const Expansion& e, double b) {
    Expansion h;
    if (e.empty() || b == 0) return {0.0};
    h.reserve(e.size() * 2);
    double q, hh;
    twoProduct(e[0], b, q, hh);
    if (hh != 0) h.push_back(hh);
    for (size_t i = 1; i < e.size(); ++i) {
        double t1, t0, sum, err;
        twoProduct(e[i], b, t1, t0);
        twoSum(q, t0, sum, err);
        if (err != 0) h.push_back(err);
        twoSum(t1, sum, q, err);
        if (err != 0) h.push_back(err);
    }
    if (q != 0 || h.empty()) h.push_back(q);
    return h;
}

inline Expansion mul(const Expansion& e, const Expansion& f) {
    Expansion h{0.0};
    for (double fi : f) if (fi != 0) h = add(h, scale(e, fi));
    return h;
}

/** a - b, exactly. */
inline Expansion diff(double a, double b) {
    double x, y;
    twoSum(a, -b, x, y);
    if (y == 0) return {x};
    return {y, x};
}

/** The sign of an expansion: that of its largest nonzero component. */
inline int sign(const Expansion& e) {
    for (size_t i = e.size(); i-- > 0;) {
        if (e[i] > 0) return 1;
        if (e[i] < 0) return -1;
    }
    return 0;
}

/** An expansion's approximate value (its components summed largest last). */
inline double estimate(const Expansion& e) {
    double s = 0;
    for (double x : e) s += x;
    return s;
}

constexpr double kEps = 1.1102230246251565e-16;  // 2^-53
constexpr double kOrient2Bound = (3.0 + 16.0 * kEps) * kEps;
constexpr double kOrient3Bound = (7.0 + 56.0 * kEps) * kEps;
constexpr double kInCircleBound = (10.0 + 96.0 * kEps) * kEps;

// ------------------------------------------------------------------------------------------------ orient2d

inline Expansion orient2dExact(const P2& a, const P2& b, const P2& c) {
    const Expansion bax = diff(b[0], a[0]), bay = diff(b[1], a[1]), cax = diff(c[0], a[0]), cay = diff(c[1], a[1]);
    return sub(mul(bax, cay), mul(bay, cax));
}

/** The sign of det[b - a, c - a]. */
inline int orient2d(const P2& a, const P2& b, const P2& c) {
    const double l = (b[0] - a[0]) * (c[1] - a[1]), r = (b[1] - a[1]) * (c[0] - a[0]);
    const double det = l - r, bound = kOrient2Bound * (std::fabs(l) + std::fabs(r));
    if (det > bound) return 1;
    if (-det > bound) return -1;
    return sign(orient2dExact(a, b, c));
}

/** det[b - a, c - a] in floating point (for magnitudes, never for signs). */
inline double orient2dValue(const P2& a, const P2& b, const P2& c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }

// ------------------------------------------------------------------------------------------------ orient3d

/** det of three columns given as exact coordinates (u . (v x w)). */
inline Expansion det3(const std::array<Expansion, 3>& u, const std::array<Expansion, 3>& v, const std::array<Expansion, 3>& w) {
    const Expansion x = sub(mul(v[1], w[2]), mul(v[2], w[1]));
    const Expansion y = sub(mul(v[2], w[0]), mul(v[0], w[2]));
    const Expansion z = sub(mul(v[0], w[1]), mul(v[1], w[0]));
    return add(add(mul(u[0], x), mul(u[1], y)), mul(u[2], z));
}

inline std::array<Expansion, 3> diff3(const P3& p, const P3& q) { return {diff(p[0], q[0]), diff(p[1], q[1]), diff(p[2], q[2])}; }

inline Expansion orient3dExact(const P3& a, const P3& b, const P3& c, const P3& d) { return det3(diff3(b, a), diff3(c, a), diff3(d, a)); }

/** The sign of det[b - a, c - a, d - a]. */
inline int orient3d(const P3& a, const P3& b, const P3& c, const P3& d) {
    const double ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const double vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const double wx = d[0] - a[0], wy = d[1] - a[1], wz = d[2] - a[2];
    const double m1 = vy * wz - vz * wy, m2 = vz * wx - vx * wz, m3 = vx * wy - vy * wx;
    const double det = ux * m1 + uy * m2 + uz * m3;
    const double perm = std::fabs(ux) * (std::fabs(vy * wz) + std::fabs(vz * wy)) + std::fabs(uy) * (std::fabs(vz * wx) + std::fabs(vx * wz)) + std::fabs(uz) * (std::fabs(vx * wy) + std::fabs(vy * wx));
    const double bound = kOrient3Bound * perm;
    if (det > bound) return 1;
    if (-det > bound) return -1;
    return sign(orient3dExact(a, b, c, d));
}

inline double orient3dValue(const P3& a, const P3& b, const P3& c, const P3& d) {
    const double ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const double vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const double wx = d[0] - a[0], wy = d[1] - a[1], wz = d[2] - a[2];
    return ux * (vy * wz - vz * wy) + uy * (vz * wx - vx * wz) + uz * (vx * wy - vy * wx);
}

/** A point with its symbolic displacements: the point stands at p + eps d1 + eps^2 d2. */
struct PerturbedPoint {
    P3 p{};
    P3 d1{};
    P3 d2{};
};

/** A determinant of perturbed points as a polynomial in eps: its exact coefficients, degree 0 to 6. */
using Poly = std::array<Expansion, 7>;

/** det[b - a, c - a, d - a] for perturbed points, every coefficient (each column is r + eps s + eps^2 t; multilinear). */
inline Poly orient3dPoly(const PerturbedPoint& a, const PerturbedPoint& b, const PerturbedPoint& c, const PerturbedPoint& d) {
    const PerturbedPoint* q[3] = {&b, &c, &d};
    std::array<std::array<std::array<Expansion, 3>, 3>, 3> col;  // [column][degree][coordinate]
    for (int k = 0; k < 3; ++k) {
        col[k][0] = diff3(q[k]->p, a.p);
        col[k][1] = diff3(q[k]->d1, a.d1);
        col[k][2] = diff3(q[k]->d2, a.d2);
    }
    const auto isZero = [](const std::array<Expansion, 3>& v) { return sign(v[0]) == 0 && sign(v[1]) == 0 && sign(v[2]) == 0; };
    Poly out;
    for (auto& e : out) e = {0.0};
    for (int i = 0; i <= 2; ++i) for (int j = 0; j <= 2; ++j) for (int k = 0; k <= 2; ++k) {
        if (isZero(col[0][i]) || isZero(col[1][j]) || isZero(col[2][k])) continue;
        out[i + j + k] = add(out[i + j + k], det3(col[0][i], col[1][j], col[2][k]));
    }
    return out;
}

/** The sign of a polynomial in an infinitesimal eps: that of its first nonzero coefficient. */
template <size_t N>
inline int leadingSign(const std::array<Expansion, N>& p) {
    for (const auto& e : p) { const int s = sign(e); if (s) return s; }
    return 0;
}

/**
 * The sign of det[b - a, c - a, d - a] for perturbed points: the exact determinant when it is nonzero, else the sign of
 * the first nonzero coefficient of its polynomial in eps. Zero only when every coefficient vanishes, which the caller
 * breaks by its own rule.
 */
inline int orient3dPerturbed(const PerturbedPoint& a, const PerturbedPoint& b, const PerturbedPoint& c, const PerturbedPoint& d) {
    const int s0 = orient3d(a.p, b.p, c.p, d.p);
    if (s0 != 0) return s0;
    return leadingSign(orient3dPoly(a, b, c, d));
}

/** x * y - z * w of polynomials in eps, exactly (degree up to 12). */
inline std::array<Expansion, 13> crossPoly(const Poly& x, const Poly& y, const Poly& z, const Poly& w) {
    std::array<Expansion, 13> out;
    for (auto& e : out) e = {0.0};
    for (int i = 0; i < 7; ++i) for (int j = 0; j < 7; ++j) {
        if (sign(x[i]) != 0 && sign(y[j]) != 0) out[i + j] = add(out[i + j], mul(x[i], y[j]));
        if (sign(z[i]) != 0 && sign(w[j]) != 0) out[i + j] = sub(out[i + j], mul(z[i], w[j]));
    }
    return out;
}

// ------------------------------------------------------------------------------------------------ incircle

inline Expansion incircleExact(const P2& a, const P2& b, const P2& c, const P2& d) {
    const Expansion adx = diff(a[0], d[0]), ady = diff(a[1], d[1]);
    const Expansion bdx = diff(b[0], d[0]), bdy = diff(b[1], d[1]);
    const Expansion cdx = diff(c[0], d[0]), cdy = diff(c[1], d[1]);
    const Expansion alift = add(mul(adx, adx), mul(ady, ady));
    const Expansion blift = add(mul(bdx, bdx), mul(bdy, bdy));
    const Expansion clift = add(mul(cdx, cdx), mul(cdy, cdy));
    const Expansion bc = sub(mul(bdx, cdy), mul(cdx, bdy));
    const Expansion ca = sub(mul(cdx, ady), mul(adx, cdy));
    const Expansion ab = sub(mul(adx, bdy), mul(bdx, ady));
    return add(add(mul(alift, bc), mul(blift, ca)), mul(clift, ab));
}

/** Positive when d lies inside the circle through a, b, c (counter-clockwise), negative outside, zero on it. */
inline int incircle(const P2& a, const P2& b, const P2& c, const P2& d) {
    const double adx = a[0] - d[0], ady = a[1] - d[1], bdx = b[0] - d[0], bdy = b[1] - d[1], cdx = c[0] - d[0], cdy = c[1] - d[1];
    const double bdxcdy = bdx * cdy, cdxbdy = cdx * bdy, cdxady = cdx * ady, adxcdy = adx * cdy, adxbdy = adx * bdy, bdxady = bdx * ady;
    const double alift = adx * adx + ady * ady, blift = bdx * bdx + bdy * bdy, clift = cdx * cdx + cdy * cdy;
    const double det = alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) + clift * (adxbdy - bdxady);
    const double perm = (std::fabs(bdxcdy) + std::fabs(cdxbdy)) * alift + (std::fabs(cdxady) + std::fabs(adxcdy)) * blift + (std::fabs(adxbdy) + std::fabs(bdxady)) * clift;
    const double bound = kInCircleBound * perm;
    if (det > bound) return 1;
    if (-det > bound) return -1;
    return sign(incircleExact(a, b, c, d));
}

}  // namespace exact
}  // namespace scratchbox
