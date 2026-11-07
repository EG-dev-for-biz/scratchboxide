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
 * Sign conventions (all ours):
 *  - orient2d(a, b, c) = det[b - a, c - a]: positive when c lies left of a->b (a, b, c counter-clockwise);
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
