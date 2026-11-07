/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
#pragma once

// After de Goes & James, "Regularized Kelvinlets" (SIGGRAPH 2017) and "Sharp Kelvinlets" (DigiPro 2019).

/**
 * Kelvinlet deformation: the closed-form displacement of an infinite linear-elastic medium under a regularised
 * point load. A load is a force (the load point moves by a given displacement) plus an affine part, the velocity
 * gradient at the load point, which splits into a rotation (twist), a uniform scale and a traceless stretch
 * (pinch). The field has no falloff edge: it decays with distance as elasticity says, and bulges sideways when the
 * material is incompressible (Poisson ratio 0.5, where the field is exactly divergence free).
 *
 * Parameters are continuous only: the regularisation radius epsilon, the Poisson ratio, the number of scales the
 * field is extrapolated over (1, 2 or 3: the far field then decays as 1/r, 1/r^3 or 1/r^5 for a force) and the ratio
 * between those scales. The shear modulus cancels: every load is normalised so that the load point does exactly
 * what was asked (moves by the displacement, turns by the angle, scales by the factor).
 *
 * Large moves are integrated in time: the field is taken as a velocity over unit time and every point is advected
 * with RK4 in several small steps (the load point travelling with the force), so a big grab drags the surface
 * instead of folding it. A pure twist is integrated exactly: its field is tangent to the spheres about the load
 * point, so each point turns about the axis by the angle its distance gives.
 *
 * Optional per-point weights in [0, 1] scale the velocity (a weight of 0 holds a point still).
 */

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace scratchbox {
namespace kelvinlet {

using math::Vec3;

/** A 3 x 3 matrix in double precision, row major. */
struct Mat3d {
    double m[3][3]{{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
    static Mat3d zero() { return {}; }
    static Mat3d identity() { Mat3d r; r.m[0][0] = r.m[1][1] = r.m[2][2] = 1.0; return r; }
    double trace() const { return m[0][0] + m[1][1] + m[2][2]; }
    Mat3d transposed() const { Mat3d r; for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) r.m[i][j] = m[j][i]; return r; }
    Mat3d operator+(const Mat3d& o) const { Mat3d r; for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) r.m[i][j] = m[i][j] + o.m[i][j]; return r; }
    Mat3d operator-(const Mat3d& o) const { Mat3d r; for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) r.m[i][j] = m[i][j] - o.m[i][j]; return r; }
    Mat3d operator*(double s) const { Mat3d r; for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) r.m[i][j] = m[i][j] * s; return r; }
    double norm() const { double s = 0; for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) s += m[i][j] * m[i][j]; return std::sqrt(s); }
};

struct V3d {
    double x = 0, y = 0, z = 0;
    V3d() = default;
    V3d(double x_, double y_, double z_) : x(x_), y(y_), z(z_) {}
    explicit V3d(const Vec3& v) : x(v.x), y(v.y), z(v.z) {}
    Vec3 toVec3() const { return Vec3(static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)); }
    V3d operator+(const V3d& o) const { return {x + o.x, y + o.y, z + o.z}; }
    V3d operator-(const V3d& o) const { return {x - o.x, y - o.y, z - o.z}; }
    V3d operator*(double s) const { return {x * s, y * s, z * s}; }
    double dot(const V3d& o) const { return x * o.x + y * o.y + z * o.z; }
    V3d cross(const V3d& o) const { return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x}; }
    double lengthSq() const { return dot(*this); }
    double length() const { return std::sqrt(lengthSq()); }
};

inline V3d mul(const Mat3d& a, const V3d& v) {
    return {a.m[0][0] * v.x + a.m[0][1] * v.y + a.m[0][2] * v.z,
            a.m[1][0] * v.x + a.m[1][1] * v.y + a.m[1][2] * v.z,
            a.m[2][0] * v.x + a.m[2][1] * v.y + a.m[2][2] * v.z};
}

inline Mat3d outer(const V3d& a, const V3d& b) {
    Mat3d r;
    const double av[3] = {a.x, a.y, a.z}, bv[3] = {b.x, b.y, b.z};
    for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) r.m[i][j] = av[i] * bv[j];
    return r;
}

/** The skew matrix [n]x, so that [n]x r = n x r. */
inline Mat3d crossMatrix(const V3d& n) {
    Mat3d r;
    r.m[0][1] = -n.z; r.m[0][2] = n.y;
    r.m[1][0] = n.z;  r.m[1][2] = -n.x;
    r.m[2][0] = -n.y; r.m[2][1] = n.x;
    return r;
}

/** A regularised point load. Both parts may be given together; they superpose. */
struct Load {
    Vec3 center{0, 0, 0};
    /** Force part: the load point moves by exactly this over the deformation. */
    Vec3 displacement{0, 0, 0};
    /** Affine part: the velocity gradient at the load point, integrated over unit time (zero = none). */
    Mat3d gradient{};

    /** The load point is dragged by `displacement`. */
    static Load grab(const Vec3& center, const Vec3& displacement) {
        Load l; l.center = center; l.displacement = displacement; return l;
    }
    /** The neighbourhood of the load point turns by `angleRad` about `axis` (right handed). */
    static Load twist(const Vec3& center, const Vec3& axis, float angleRad) {
        V3d n(axis);
        const double len = n.length();
        if (!(len > 0.0)) throw std::invalid_argument("kelvinlet twist needs a non-zero axis");
        Load l; l.center = center; l.gradient = crossMatrix(n * (1.0 / len)) * static_cast<double>(angleRad); return l;
    }
    /** The neighbourhood of the load point scales uniformly by `factor` (> 0). Needs a compressible material. */
    static Load scale(const Vec3& center, float factor) {
        if (!(factor > 0.0f)) throw std::invalid_argument("kelvinlet scale factor must be greater than 0");
        Load l; l.center = center; l.gradient = Mat3d::identity() * std::log(static_cast<double>(factor)); return l;
    }
    /**
     * A traceless stretch at the load point: along `direction` the neighbourhood stretches by exp(strength)
     * (a negative strength squeezes). With a `secondary` direction the stretch is planar (that direction gets the
     * opposite, the third none); without one the two perpendicular directions share the opposite equally.
     */
    static Load pinch(const Vec3& center, const Vec3& direction, float strength, const Vec3* secondary = nullptr) {
        V3d d(direction);
        const double dl = d.length();
        if (!(dl > 0.0)) throw std::invalid_argument("kelvinlet pinch needs a non-zero direction");
        d = d * (1.0 / dl);
        Mat3d g;
        if (secondary) {
            V3d e(*secondary);
            e = e - d * e.dot(d);
            const double el = e.length();
            if (!(el > 1e-9)) throw std::invalid_argument("kelvinlet pinch secondary direction must not be parallel to direction");
            e = e * (1.0 / el);
            g = outer(d, d) - outer(e, e);
        } else {
            g = outer(d, d) * 1.5 - Mat3d::identity() * 0.5;  // d d^T - (I - d d^T) / 2
        }
        Load l; l.center = center; l.gradient = g * static_cast<double>(strength); return l;
    }
};

struct Options {
    /** Regularisation radius (metres): the width of the load's core. */
    float epsilon = 1.0f;
    /** Poisson ratio in [0, 0.5]; 0.5 is incompressible (volume preserving). */
    float poissonRatio = 0.5f;
    /** Scales the field is extrapolated over: 1 (plain), 2 (bi-scale) or 3 (tri-scale, sharpest). */
    int falloffScales = 1;
    /** Ratio between successive scales' radii (> 1). */
    float falloffRatio = 1.5f;
    /** Time steps; 0 chooses enough steps for the move (each step moves the load point at most a fifth of epsilon). */
    int steps = 0;
};

/** The multi-scale kernel: radii and weights whose far fields cancel to the chosen order. */
struct Scales {
    int count = 1;
    std::array<double, 3> eps{1, 1, 1};
    std::array<double, 3> w{1, 0, 0};
};

/** Elastic constants with the shear modulus taken as 1 (it cancels in the normalisation): a = 1/(4 pi mu), b = a / (4 (1 - nu)). */
struct Constants {
    double a = 0, b = 0;
};

inline Constants constantsFor(float poissonRatio) {
    if (!(poissonRatio >= 0.0f && poissonRatio <= 0.5f)) {
        throw std::invalid_argument("kelvinlet poissonRatio must be in [0, 0.5]");
    }
    Constants c;
    c.a = 1.0 / (4.0 * math::PI);
    c.b = c.a / (4.0 * (1.0 - static_cast<double>(poissonRatio)));
    return c;
}

inline Scales scalesFor(const Options& o) {
    if (!(o.epsilon > 0.0f) || !std::isfinite(o.epsilon)) throw std::invalid_argument("kelvinlet epsilon must be greater than 0");
    if (o.falloffScales < 1 || o.falloffScales > 3) throw std::invalid_argument("kelvinlet falloffScales must be 1, 2 or 3");
    if (o.falloffScales > 1 && !(o.falloffRatio > 1.0f)) throw std::invalid_argument("kelvinlet falloffRatio must be greater than 1");
    Scales s;
    s.count = o.falloffScales;
    const double e1 = o.epsilon, r = o.falloffRatio;
    s.eps = {e1, e1 * r, e1 * r * r};
    if (s.count == 2) {
        // u_e1 - u_e2: the 1/r far field cancels.
        s.w = {1.0, -1.0, 0.0};
    } else if (s.count == 3) {
        // Weights with sum w = 0 and sum w eps^2 = 0: the 1/r and 1/r^3 far fields cancel.
        const double a2 = s.eps[0] * s.eps[0], b2 = s.eps[1] * s.eps[1], c2 = s.eps[2] * s.eps[2];
        s.w = {1.0, -(c2 - a2) / (c2 - b2), (b2 - a2) / (c2 - b2)};
    }
    return s;
}

/** Force kernel of one scale: u = [ (a-b)/re + a eps^2/(2 re^3) ] f + b/re^3 (r.f) r. */
inline V3d forceKernel(const V3d& r, const V3d& f, const Constants& k, double eps) {
    const double re2 = r.lengthSq() + eps * eps;
    const double re = std::sqrt(re2);
    const double re3 = re2 * re;
    const double A = (k.a - k.b) / re + k.a * eps * eps / (2.0 * re3);
    const double B = k.b / re3;
    return f * A + r * (B * r.dot(f));
}

/**
 * Affine (force dipole) kernel of one scale, the derivative of the force kernel along the load:
 * u = -a (1/re^3 + 3 eps^2/(2 re^5)) F r + b/re^3 (F + F^T + tr(F) I) r - 3b/re^5 (r.F r) r.
 */
inline V3d affineKernel(const V3d& r, const Mat3d& F, const Constants& k, double eps) {
    const double re2 = r.lengthSq() + eps * eps;
    const double re = std::sqrt(re2);
    const double re3 = re2 * re, re5 = re3 * re2;
    const V3d Fr = mul(F, r);
    const V3d FTr = mul(F.transposed(), r);
    const double tr = F.trace();
    const double rFr = r.dot(Fr);
    const double c1 = -k.a * (1.0 / re3 + 1.5 * eps * eps / re5);
    return Fr * c1 + (Fr + FTr + r * tr) * (k.b / re3) - r * (3.0 * k.b * rFr / re5);
}

/**
 * A load made ready to evaluate: the force and the dipole matrix scaled so that the load point does what was
 * asked. The gradient is split into its rotation, traceless stretch and uniform scale, each normalised by the
 * kernel's own gain at the load point.
 */
struct PreparedLoad {
    Constants k;
    Scales s;
    V3d center;
    V3d displacement;
    V3d force;           // per unit time
    Mat3d dipole;        // per unit time
    bool hasForce = false;
    bool hasDipole = false;
    bool pureRotation = false;
    V3d rotationAxis;    // unit, for the exact twist
    double rotationAngle = 0;
    double rotationGain0 = 1;  // sum w_i (-a)(5 / (2 eps_i^3)): the twist kernel's rate at the load point per unit dipole
};

inline double sumOver(const Scales& s, double (*g)(const Constants&, double), const Constants& k) {
    double t = 0;
    for (int i = 0; i < s.count; ++i) t += s.w[i] * g(k, s.eps[i]);
    return t;
}

inline PreparedLoad prepare(const Load& load, const Options& o) {
    PreparedLoad p;
    p.k = constantsFor(o.poissonRatio);
    p.s = scalesFor(o);
    p.center = V3d(load.center);
    p.displacement = V3d(load.displacement);
    const Constants& k = p.k;

    // Force: the kernel at r = 0 is (3a - 2b) / (2 eps) times the force.
    if (p.displacement.lengthSq() > 0.0) {
        const double gain = sumOver(p.s, [](const Constants& c, double e) { return (3.0 * c.a - 2.0 * c.b) / (2.0 * e); }, k);
        p.force = p.displacement * (1.0 / gain);
        p.hasForce = true;
    }

    const Mat3d& G = load.gradient;
    if (G.norm() > 0.0) {
        double sigma = G.trace() / 3.0;
        if (std::abs(sigma) < 1e-9 * G.norm()) sigma = 0.0;  // traceless up to rounding (a pinch, a twist)
        const Mat3d W = (G - G.transposed()) * 0.5;
        const Mat3d S = (G + G.transposed()) * 0.5 - Mat3d::identity() * sigma;
        // Gradient of the dipole kernel at r = 0 per unit F: -5a/(2 eps^3) F + b/eps^3 (F + F^T + tr F I).
        const double gW = sumOver(p.s, [](const Constants& c, double e) { return -5.0 * c.a / (2.0 * e * e * e); }, k);
        const double gS = sumOver(p.s, [](const Constants& c, double e) { return (4.0 * c.b - 5.0 * c.a) / (2.0 * e * e * e); }, k);
        const double gI = sumOver(p.s, [](const Constants& c, double e) { return 5.0 * (2.0 * c.b - c.a) / (2.0 * e * e * e); }, k);
        Mat3d F = W * (1.0 / gW) + S * (1.0 / gS);
        if (sigma != 0.0) {
            // 2b - a = -a (1 - 2 nu) / (2 (1 - nu)): an incompressible medium has no uniform scale mode.
            if (std::abs(1.0 - 2.0 * static_cast<double>(o.poissonRatio)) < 1e-4) {
                throw std::invalid_argument("a uniform kelvinlet scale needs a compressible material (poissonRatio below 0.5): an incompressible medium cannot change volume");
            }
            F = F + Mat3d::identity() * (sigma / gI);
        }
        p.dipole = F;
        p.hasDipole = true;
        if (!p.hasForce && S.norm() < 1e-9 * G.norm() && sigma == 0.0) {
            // W = theta [n]x
            const V3d n(W.m[2][1], W.m[0][2], W.m[1][0]);
            const double theta = n.length();
            if (theta > 0.0) {
                p.pureRotation = true;
                p.rotationAxis = n * (1.0 / theta);
                p.rotationAngle = theta;
                p.rotationGain0 = gW;
            }
        }
    }
    if (!p.hasForce && !p.hasDipole) throw std::invalid_argument("kelvinlet load has no displacement and no gradient");
    return p;
}

/** The velocity at x when the load point is at c (unit-time field). */
inline V3d velocity(const PreparedLoad& p, const V3d& x, const V3d& c) {
    const V3d r = x - c;
    V3d v;
    for (int i = 0; i < p.s.count; ++i) {
        const double eps = p.s.eps[i], w = p.s.w[i];
        if (p.hasForce) v = v + forceKernel(r, p.force, p.k, eps) * w;
        if (p.hasDipole) v = v + affineKernel(r, p.dipole, p.k, eps) * w;
    }
    return v;
}

/** Twist rate at distance r from the load point, as a share of the rate at the load point (1 at r = 0). */
inline double rotationShare(const PreparedLoad& p, double r) {
    double rate = 0;
    for (int i = 0; i < p.s.count; ++i) {
        const double eps = p.s.eps[i];
        const double re2 = r * r + eps * eps, re = std::sqrt(re2), re3 = re2 * re, re5 = re3 * re2;
        rate += p.s.w[i] * (-p.k.a) * (1.0 / re3 + 1.5 * eps * eps / re5);
    }
    return rate / p.rotationGain0;
}

/**
 * The closed-form displacement at x, without time integration (the linear field the papers write down). The load
 * point moves by exactly the load's displacement and its neighbourhood by the load's gradient, to first order.
 */
inline Vec3 displacementAt(const Vec3& x, const Load& load, const Options& o) {
    const PreparedLoad p = prepare(load, o);
    return velocity(p, V3d(x), p.center).toVec3();
}

/**
 * Time steps: each moves the load point at most a fifth of epsilon and changes the local gradient by at most 0.1.
 * A pure twist is exact in one step.
 */
inline int stepsFor(const PreparedLoad& p, const Load& load, const Options& o) {
    if (o.steps > 0) return std::min(o.steps, 4096);
    if (p.pureRotation) return 1;
    double n = 1;
    if (p.hasForce) n = std::max(n, std::ceil(p.displacement.length() / (0.2 * p.s.eps[0])));
    if (p.hasDipole) n = std::max(n, std::ceil(load.gradient.norm() / 0.1));
    return static_cast<int>(std::clamp(n, 1.0, 512.0));
}

namespace detail {
template <typename F>
inline void parallelChunks(std::size_t n, F&& fn) {
    const unsigned hw = std::max(1u, std::thread::hardware_concurrency());
    const unsigned threads = n < 2048 ? 1u : static_cast<unsigned>(std::min<std::size_t>({hw, 16u, n / 1024}));
    if (threads <= 1) { fn(std::size_t{0}, n); return; }
    std::vector<std::thread> pool;
    const std::size_t chunk = (n + threads - 1) / threads;
    for (unsigned t = 0; t < threads; ++t) {
        const std::size_t b = t * chunk, e = std::min(n, b + chunk);
        if (b >= e) break;
        pool.emplace_back([&fn, b, e] { fn(b, e); });
    }
    for (auto& th : pool) th.join();
}
}  // namespace detail

struct Report {
    int steps = 0;
    /** Largest distance any point moved (metres). */
    double maxMove = 0;
};

/**
 * Deforms `count` points stored as x, y, z floats at `xyz` (stride 3), in place. `weights` (count values in [0, 1],
 * or null) scale each point's velocity.
 */
inline Report deformPoints(float* xyz, std::size_t count, const Load& load, const Options& o, const float* weights = nullptr) {
    const PreparedLoad p = prepare(load, o);
    const int steps = stepsFor(p, load, o);
    Report rep;
    rep.steps = steps;
    std::vector<double> moved(count, 0.0);

    detail::parallelChunks(count, [&](std::size_t b, std::size_t e) {
        for (std::size_t i = b; i < e; ++i) {
            const double w = weights ? std::clamp(static_cast<double>(weights[i]), 0.0, 1.0) : 1.0;
            if (w <= 0.0) continue;
            V3d x(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
            const V3d x0 = x;
            if (p.pureRotation) {
                // Exact flow: |x - c| is constant along the orbit, so the point turns by angle * share(|r|).
                const V3d r = x - p.center;
                const double ang = p.rotationAngle * rotationShare(p, r.length()) * w;
                const V3d& n = p.rotationAxis;
                const double cs = std::cos(ang), sn = std::sin(ang);
                const V3d rr = r * cs + n.cross(r) * sn + n * (n.dot(r) * (1.0 - cs));
                x = p.center + rr;
            } else {
                const double h = 1.0 / steps;
                for (int s = 0; s < steps; ++s) {
                    const double t = s * h;
                    // The load point travels with the force: c(t) = c0 + t * displacement.
                    const V3d c0 = p.center + p.displacement * t;
                    const V3d cm = p.center + p.displacement * (t + 0.5 * h);
                    const V3d c1 = p.center + p.displacement * (t + h);
                    const V3d k1 = velocity(p, x, c0) * w;
                    const V3d k2 = velocity(p, x + k1 * (0.5 * h), cm) * w;
                    const V3d k3 = velocity(p, x + k2 * (0.5 * h), cm) * w;
                    const V3d k4 = velocity(p, x + k3 * h, c1) * w;
                    x = x + (k1 + k2 * 2.0 + k3 * 2.0 + k4) * (h / 6.0);
                }
            }
            xyz[3 * i] = static_cast<float>(x.x);
            xyz[3 * i + 1] = static_cast<float>(x.y);
            xyz[3 * i + 2] = static_cast<float>(x.z);
            moved[i] = (x - x0).length();
        }
    });
    for (double m : moved) rep.maxMove = std::max(rep.maxMove, m);
    return rep;
}

inline Report deformPoints(std::vector<Vec3>& points, const Load& load, const Options& o, const std::vector<float>* weights = nullptr) {
    if (weights && weights->size() != points.size()) throw std::invalid_argument("kelvinlet weights must have one value per point");
    std::vector<float> xyz(points.size() * 3);
    for (std::size_t i = 0; i < points.size(); ++i) { xyz[3 * i] = points[i].x; xyz[3 * i + 1] = points[i].y; xyz[3 * i + 2] = points[i].z; }
    const Report r = deformPoints(xyz.data(), points.size(), load, o, weights ? weights->data() : nullptr);
    for (std::size_t i = 0; i < points.size(); ++i) points[i] = Vec3(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
    return r;
}

/** Deforms a mesh's vertices in place, then recomputes its smooth normals and bounds. */
inline Report deformMesh(geometry::ScratchboxMesh& mesh, const Load& load, const Options& o, const std::vector<float>* weights = nullptr) {
    if (weights && weights->size() != mesh.vertices.size()) throw std::invalid_argument("kelvinlet weights must have one value per vertex");
    std::vector<float> xyz(mesh.vertices.size() * 3);
    for (std::size_t i = 0; i < mesh.vertices.size(); ++i) {
        const Vec3& v = mesh.vertices[i].position;
        xyz[3 * i] = v.x; xyz[3 * i + 1] = v.y; xyz[3 * i + 2] = v.z;
    }
    const Report r = deformPoints(xyz.data(), mesh.vertices.size(), load, o, weights ? weights->data() : nullptr);
    for (std::size_t i = 0; i < mesh.vertices.size(); ++i) mesh.vertices[i].position = Vec3(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
    mesh.recomputeSmoothNormals();
    mesh.recomputeBounds();
    return r;
}

}  // namespace kelvinlet
}  // namespace scratchbox
