/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_MATH_HPP
#define SCRATCHBOX_MATH_HPP

#include <cmath>
#include <cstdint>
#include <algorithm>
#include <array>
#include <numbers>

namespace scratchbox {
namespace math {

constexpr float PI = 3.14159265358979323846f;
constexpr float TWO_PI = 6.28318530717958647692f;
constexpr float HALF_PI = 1.57079632679489661923f;
constexpr float DEG_TO_RAD = PI / 180.0f;
constexpr float RAD_TO_DEG = 180.0f / PI;

inline float smoothstep(float edge0, float edge1, float x) {
    if (std::abs(edge1 - edge0) < 1e-7f) return x >= edge1 ? 1.0f : 0.0f;
    float t = std::clamp((x - edge0) / (edge1 - edge0), 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}

template<typename T>
inline T lerp(const T& a, const T& b, float t) {
    return a + (b - a) * t;
}
inline float lerp(float a, float b, float t) {
    return std::lerp(a, b, t);
}

struct Vec2 {
    float x{0.0f}, y{0.0f};

    constexpr Vec2() = default;
    constexpr Vec2(float _x, float _y) : x(_x), y(_y) {}

    constexpr Vec2 operator+(const Vec2& v) const { return {x + v.x, y + v.y}; }
    constexpr Vec2 operator-(const Vec2& v) const { return {x - v.x, y - v.y}; }
    constexpr Vec2 operator*(float s) const { return {x * s, y * s}; }
    constexpr Vec2 operator/(float s) const { return {x / s, y / s}; }
    constexpr Vec2 operator-() const { return {-x, -y}; }

    Vec2& operator+=(const Vec2& v) { x += v.x; y += v.y; return *this; }
    Vec2& operator-=(const Vec2& v) { x -= v.x; y -= v.y; return *this; }
    Vec2& operator*=(float s) { x *= s; y *= s; return *this; }
    Vec2& operator/=(float s) { x /= s; y /= s; return *this; }

    float lengthSq() const { return x * x + y * y; }
    float lengthSquared() const { return lengthSq(); }
    float length() const { return std::sqrt(lengthSq()); }

    Vec2 normalized() const {
        float l = length();
        return l > 1e-6f ? (*this / l) : Vec2(0, 0);
    }
};

struct alignas(16) Vec3 {
    float x{0.0f}, y{0.0f}, z{0.0f};
    float _pad{0.0f};

    constexpr Vec3() = default;
    constexpr Vec3(float _x, float _y, float _z) : x(_x), y(_y), z(_z), _pad(0.0f) {}

    constexpr Vec3 operator+(const Vec3& v) const { return {x + v.x, y + v.y, z + v.z}; }
    constexpr Vec3 operator-(const Vec3& v) const { return {x - v.x, y - v.y, z - v.z}; }
    constexpr Vec3 operator*(float s) const { return {x * s, y * s, z * s}; }
    constexpr Vec3 operator*(const Vec3& v) const { return {x * v.x, y * v.y, z * v.z}; }
    constexpr Vec3 operator/(float s) const { return {x / s, y / s, z / s}; }
    constexpr Vec3 operator-() const { return {-x, -y, -z}; }

    Vec3& operator+=(const Vec3& v) { x += v.x; y += v.y; z += v.z; return *this; }
    Vec3& operator-=(const Vec3& v) { x -= v.x; y -= v.y; z -= v.z; return *this; }
    Vec3& operator*=(float s) { x *= s; y *= s; z *= s; return *this; }
    Vec3& operator/=(float s) { x /= s; y /= s; z /= s; return *this; }

    float lengthSq() const { return x * x + y * y + z * z; }
    float lengthSquared() const { return lengthSq(); }
    float length() const { return std::sqrt(lengthSq()); }

    Vec3 normalized() const {
        float l = length();
        return l > 1e-6f ? (*this / l) : Vec3(0, 0, 0);
    }

    float dot(const Vec3& v) const { return x * v.x + y * v.y + z * v.z; }

    Vec3 cross(const Vec3& v) const {
        return {
            y * v.z - z * v.y,
            z * v.x - x * v.z,
            x * v.y - y * v.x
        };
    }

    constexpr float operator[](int i) const {
        return (i == 0) ? x : ((i == 1) ? y : z);
    }
    constexpr float& operator[](int i) {
        return (i == 0) ? x : ((i == 1) ? y : z);
    }
};

inline Vec3 cross(const Vec3& a, const Vec3& b) { return a.cross(b); }
inline float dot(const Vec3& a, const Vec3& b) { return a.dot(b); }
inline Vec3 normalize(const Vec3& v) { return v.normalized(); }

struct alignas(16) Vec4 {
    float x{0.0f}, y{0.0f}, z{0.0f}, w{0.0f};

    constexpr Vec4() = default;
    constexpr Vec4(float _x, float _y, float _z, float _w) : x(_x), y(_y), z(_z), w(_w) {}
    constexpr Vec4(const Vec3& v, float _w) : x(v.x), y(v.y), z(v.z), w(_w) {}

    constexpr Vec4 operator+(const Vec4& v) const { return {x + v.x, y + v.y, z + v.z, w + v.w}; }
    constexpr Vec4 operator-(const Vec4& v) const { return {x - v.x, y - v.y, z - v.z, w - v.w}; }
    constexpr Vec4 operator*(float s) const { return {x * s, y * s, z * s, w * s}; }
    constexpr Vec4& operator+=(const Vec4& v) { x += v.x; y += v.y; z += v.z; w += v.w; return *this; }
};

struct Quat {
    float x{0.0f}, y{0.0f}, z{0.0f}, w{1.0f};

    constexpr Quat() = default;
    constexpr Quat(float _x, float _y, float _z, float _w) : x(_x), y(_y), z(_z), w(_w) {}

    static constexpr Quat identity() { return Quat(0.0f, 0.0f, 0.0f, 1.0f); }

    static Quat fromAxisAngle(const Vec3& axis, float angleRad) {
        float half = angleRad * 0.5f;
        float s = std::sin(half);
        Vec3 norm = axis.normalized();
        return {norm.x * s, norm.y * s, norm.z * s, std::cos(half)};
    }

    static Quat fromEuler(float pitch, float yaw, float roll) {
        float cp = std::cos(pitch * 0.5f);
        float sp = std::sin(pitch * 0.5f);
        float cy = std::cos(yaw * 0.5f);
        float sy = std::sin(yaw * 0.5f);
        float cr = std::cos(roll * 0.5f);
        float sr = std::sin(roll * 0.5f);
        return Quat(
            sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy,
            cr * cp * sy - sr * sp * cy,
            cr * cp * cy + sr * sp * sy
        );
    }

    static Quat fromEuler(const Vec3& euler) {
        return fromEuler(euler.x, euler.y, euler.z);
    }

    Quat operator*(const Quat& q) const {
        return {
            w * q.x + x * q.w + y * q.z - z * q.y,
            w * q.y - x * q.z + y * q.w + z * q.x,
            w * q.z + x * q.y - y * q.x + z * q.w,
            w * q.w - x * q.x - y * q.y - z * q.z
        };
    }

    Quat normalized() const {
        float len = std::sqrt(x * x + y * y + z * z + w * w);
        if (len < 1e-6f) return identity();
        float inv = 1.0f / len;
        return {x * inv, y * inv, z * inv, w * inv};
    }

    Vec3 rotate(const Vec3& v) const {
        Vec3 qv(x, y, z);
        Vec3 uv = qv.cross(v);
        Vec3 uuv = qv.cross(uv);
        return v + ((uv * w) + uuv) * 2.0f;
    }
};

struct Mat4 {
    std::array<float, 16> m{};

    static Mat4 identity() {
        Mat4 res;
        res.m = {
            1.0f, 0.0f, 0.0f, 0.0f,
            0.0f, 1.0f, 0.0f, 0.0f,
            0.0f, 0.0f, 1.0f, 0.0f,
            0.0f, 0.0f, 0.0f, 1.0f
        };
        return res;
    }

    static Mat4 translation(const Vec3& v) {
        Mat4 res = identity();
        res.m[12] = v.x;
        res.m[13] = v.y;
        res.m[14] = v.z;
        return res;
    }

    static Mat4 scaling(const Vec3& v) {
        Mat4 res = identity();
        res.m[0] = v.x;
        res.m[5] = v.y;
        res.m[10] = v.z;
        return res;
    }

    static Mat4 rotationY(float rad) {
        Mat4 res = identity();
        float c = std::cos(rad);
        float s = std::sin(rad);
        res.m[0] = c;  res.m[8] = s;
        res.m[2] = -s; res.m[10] = c;
        return res;
    }

    Vec3 transformPoint(const Vec3& p) const {
        return {
            m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
            m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
            m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]
        };
    }

    Vec3 transformDirection(const Vec3& d) const {
        return {
            m[0] * d.x + m[4] * d.y + m[8] * d.z,
            m[1] * d.x + m[5] * d.y + m[9] * d.z,
            m[2] * d.x + m[6] * d.y + m[10] * d.z
        };
    }

    Mat4 inverseRigid() const {
        Mat4 res = identity();
        res.m[0] = m[0]; res.m[4] = m[1]; res.m[8]  = m[2];
        res.m[1] = m[4]; res.m[5] = m[5]; res.m[9]  = m[6];
        res.m[2] = m[8]; res.m[6] = m[9]; res.m[10] = m[10];

        Vec3 t{m[12], m[13], m[14]};
        res.m[12] = -(res.m[0] * t.x + res.m[4] * t.y + res.m[8]  * t.z);
        res.m[13] = -(res.m[1] * t.x + res.m[5] * t.y + res.m[9]  * t.z);
        res.m[14] = -(res.m[2] * t.x + res.m[6] * t.y + res.m[10] * t.z);
        return res;
    }

    Mat4 operator*(const Mat4& o) const {
        Mat4 res;
        for (int c = 0; c < 4; ++c) {
            for (int r = 0; r < 4; ++r) {
                res.m[c * 4 + r] =
                    m[0 * 4 + r] * o.m[c * 4 + 0] +
                    m[1 * 4 + r] * o.m[c * 4 + 1] +
                    m[2 * 4 + r] * o.m[c * 4 + 2] +
                    m[3 * 4 + r] * o.m[c * 4 + 3];
            }
        }
        return res;
    }
};

struct Ray {
    Vec3 origin{0.0f, 0.0f, 0.0f};
    Vec3 direction{0.0f, 0.0f, 1.0f};
    Vec3 invDirection{0.0f, 0.0f, 1.0f};
    int sign[3]{0, 0, 0};

    constexpr Ray() = default;
    Ray(const Vec3& o, const Vec3& d) : origin(o), direction(d.normalized()) {
        invDirection = Vec3(
            std::abs(direction.x) > 1e-8f ? 1.0f / direction.x : (direction.x >= 0.0f ? 1e8f : -1e8f),
            std::abs(direction.y) > 1e-8f ? 1.0f / direction.y : (direction.y >= 0.0f ? 1e8f : -1e8f),
            std::abs(direction.z) > 1e-8f ? 1.0f / direction.z : (direction.z >= 0.0f ? 1e8f : -1e8f)
        );
        sign[0] = invDirection.x < 0.0f ? 1 : 0;
        sign[1] = invDirection.y < 0.0f ? 1 : 0;
        sign[2] = invDirection.z < 0.0f ? 1 : 0;
    }

    Vec3 at(float t) const { return origin + direction * t; }
};

struct Mat3 {
    float m[9]{
        1, 0, 0,
        0, 1, 0,
        0, 0, 1
    };

    constexpr Mat3() = default;
    constexpr Mat3(float m00, float m01, float m02,
                   float m10, float m11, float m12,
                   float m20, float m21, float m22)
        : m{m00, m01, m02, m10, m11, m12, m20, m21, m22} {}

    static constexpr Mat3 identity() {
        return Mat3(1, 0, 0,
                    0, 1, 0,
                    0, 0, 1);
    }

    static constexpr Mat3 diagonal(float x, float y, float z) {
        return Mat3(x, 0, 0,
                    0, y, 0,
                    0, 0, z);
    }

    static Mat3 fromQuat(const Quat& q) {
        float x2 = q.x + q.x, y2 = q.y + q.y, z2 = q.z + q.z;
        float xx = q.x * x2,  xy = q.x * y2,  xz = q.x * z2;
        float yy = q.y * y2,  yz = q.y * z2,  zz = q.z * z2;
        float wx = q.w * x2,  wy = q.w * y2,  wz = q.w * z2;

        return Mat3(
            1.0f - (yy + zz), xy - wz,          xz + wy,
            xy + wz,          1.0f - (xx + zz), yz - wx,
            xz - wy,          yz + wx,          1.0f - (xx + yy)
        );
    }

    Mat3 transpose() const {
        return Mat3(
            m[0], m[3], m[6],
            m[1], m[4], m[7],
            m[2], m[5], m[8]
        );
    }

    float determinant() const {
        return m[0] * (m[4] * m[8] - m[5] * m[7])
             - m[1] * (m[3] * m[8] - m[5] * m[6])
             + m[2] * (m[3] * m[7] - m[4] * m[6]);
    }

    Mat3 inverse() const {
        float det = determinant();
        if (std::abs(det) < 1e-12f) return identity();
        float invDet = 1.0f / det;

        return Mat3(
            (m[4] * m[8] - m[5] * m[7]) * invDet,
            (m[2] * m[7] - m[1] * m[8]) * invDet,
            (m[1] * m[5] - m[2] * m[4]) * invDet,

            (m[5] * m[6] - m[3] * m[8]) * invDet,
            (m[0] * m[8] - m[2] * m[6]) * invDet,
            (m[2] * m[3] - m[0] * m[5]) * invDet,

            (m[3] * m[7] - m[4] * m[6]) * invDet,
            (m[1] * m[6] - m[0] * m[7]) * invDet,
            (m[0] * m[4] - m[1] * m[3]) * invDet
        );
    }

    Vec3 operator*(const Vec3& v) const {
        return Vec3(
            m[0] * v.x + m[1] * v.y + m[2] * v.z,
            m[3] * v.x + m[4] * v.y + m[5] * v.z,
            m[6] * v.x + m[7] * v.y + m[8] * v.z
        );
    }

    Mat3 operator*(const Mat3& o) const {
        Mat3 res;
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                res.m[r * 3 + c] =
                    m[r * 3 + 0] * o.m[0 * 3 + c] +
                    m[r * 3 + 1] * o.m[1 * 3 + c] +
                    m[r * 3 + 2] * o.m[2 * 3 + c];
            }
        }
        return res;
    }

    Mat3 operator*(float s) const {
        return Mat3(
            m[0] * s, m[1] * s, m[2] * s,
            m[3] * s, m[4] * s, m[5] * s,
            m[6] * s, m[7] * s, m[8] * s
        );
    }
};

struct AABB {
    Vec3 min{1e9f, 1e9f, 1e9f};
    Vec3 max{-1e9f, -1e9f, -1e9f};

    constexpr AABB() = default;
    constexpr AABB(const Vec3& _min, const Vec3& _max) : min(_min), max(_max) {}

    void expand(const Vec3& p) {
        min.x = std::min(min.x, p.x);
        min.y = std::min(min.y, p.y);
        min.z = std::min(min.z, p.z);
        max.x = std::max(max.x, p.x);
        max.y = std::max(max.y, p.y);
        max.z = std::max(max.z, p.z);
    }

    void expand(const AABB& o) {
        min.x = std::min(min.x, o.min.x);
        min.y = std::min(min.y, o.min.y);
        min.z = std::min(min.z, o.min.z);
        max.x = std::max(max.x, o.max.x);
        max.y = std::max(max.y, o.max.y);
        max.z = std::max(max.z, o.max.z);
    }

    Vec3 center() const { return (min + max) * 0.5f; }
    Vec3 size() const { return max - min; }

    float surfaceArea() const {
        Vec3 d = max - min;
        if (d.x < 0.0f || d.y < 0.0f || d.z < 0.0f) return 0.0f;
        return 2.0f * (d.x * d.y + d.y * d.z + d.z * d.x);
    }

    bool contains(const Vec3& p) const {
        return p.x >= min.x && p.x <= max.x &&
               p.y >= min.y && p.y <= max.y &&
               p.z >= min.z && p.z <= max.z;
    }

    bool intersects(const AABB& o) const {
        return min.x <= o.max.x && max.x >= o.min.x &&
               min.y <= o.max.y && max.y >= o.min.y &&
               min.z <= o.max.z && max.z >= o.min.z;
    }

    bool intersect(const Ray& ray, float& tMin, float& tMax) const {
        float t0x = (min.x - ray.origin.x) * ray.invDirection.x;
        float t1x = (max.x - ray.origin.x) * ray.invDirection.x;
        if (ray.invDirection.x < 0.0f) std::swap(t0x, t1x);

        float t0y = (min.y - ray.origin.y) * ray.invDirection.y;
        float t1y = (max.y - ray.origin.y) * ray.invDirection.y;
        if (ray.invDirection.y < 0.0f) std::swap(t0y, t1y);

        float t0z = (min.z - ray.origin.z) * ray.invDirection.z;
        float t1z = (max.z - ray.origin.z) * ray.invDirection.z;
        if (ray.invDirection.z < 0.0f) std::swap(t0z, t1z);

        float enter = std::max({t0x, t0y, t0z});
        float exit  = std::min({t1x, t1y, t1z});

        if (enter <= exit && exit >= 0.0f) {
            tMin = enter;
            tMax = exit;
            return true;
        }
        return false;
    }
};

// ============================================================================
// Procedural Coherent Noise (Simplex / Perlin / Worley 3D)
// ============================================================================
class FastNoise3D {
private:
    static inline uint32_t hash(uint32_t x) {
        x = ((x >> 16) ^ x) * 0x45d9f3b;
        x = ((x >> 16) ^ x) * 0x45d9f3b;
        x = (x >> 16) ^ x;
        return x;
    }

    static inline float grad(int hashVal, float x, float y, float z) {
        int h = hashVal & 15;
        float u = h < 8 ? x : y;
        float v = h < 4 ? y : (h == 12 || h == 14 ? x : z);
        return ((h & 1) == 0 ? u : -u) + ((h & 2) == 0 ? v : -v);
    }

    static inline float fade(float t) {
        return t * t * t * (t * (t * 6.0f - 15.0f) + 10.0f);
    }

public:
    uint32_t seed = 1337;
    FastNoise3D(uint32_t s = 1337) : seed(s) {}

    static float perlin(float x, float y, float z, uint32_t seed = 1337) {
        int X = static_cast<int>(std::floor(x));
        int Y = static_cast<int>(std::floor(y));
        int Z = static_cast<int>(std::floor(z));

        x -= std::floor(x);
        y -= std::floor(y);
        z -= std::floor(z);

        float u = fade(x);
        float v = fade(y);
        float w = fade(z);

        auto h3 = [&](int ix, int iy, int iz) {
            uint32_t ux = static_cast<uint32_t>(ix);
            uint32_t uy = static_cast<uint32_t>(iy);
            uint32_t uz = static_cast<uint32_t>(iz);
            return static_cast<int>(hash(seed ^ (ux + (uy * 57u) + (uz * 321u))));
        };

        int aaa = h3(X, Y, Z);
        int aba = h3(X, Y + 1, Z);
        int aab = h3(X, Y, Z + 1);
        int abb = h3(X, Y + 1, Z + 1);
        int baa = h3(X + 1, Y, Z);
        int bba = h3(X + 1, Y + 1, Z);
        int bab = h3(X + 1, Y, Z + 1);
        int bbb = h3(X + 1, Y + 1, Z + 1);

        float x1 = std::lerp(grad(aaa, x, y, z), grad(baa, x - 1, y, z), u);
        float x2 = std::lerp(grad(aba, x, y - 1, z), grad(bba, x - 1, y - 1, z), u);
        float y1 = std::lerp(x1, x2, v);

        float x3 = std::lerp(grad(aab, x, y, z - 1), grad(bab, x - 1, y, z - 1), u);
        float x4 = std::lerp(grad(abb, x, y - 1, z - 1), grad(bbb, x - 1, y - 1, z - 1), u);
        float y2 = std::lerp(x3, x4, v);

        return std::lerp(y1, y2, w);
    }

    static float fbm(float x, float y, float z, int octaves = 5, float lacunarity = 2.0f, float gain = 0.5f, uint32_t seed = 1337) {
        float sum = 0.0f;
        float amp = 1.0f;
        float freq = 1.0f;
        float maxAmp = 0.0f;

        for (int i = 0; i < octaves; ++i) {
            sum += perlin(x * freq, y * freq, z * freq, seed + i * 31) * amp;
            maxAmp += amp;
            amp *= gain;
            freq *= lacunarity;
        }

        return maxAmp > 0.0f ? (sum / maxAmp) : 0.0f;
    }

    static float fBm(float x, float y, float z, int octaves = 5, float lacunarity = 2.0f, float gain = 0.5f, uint32_t seed = 1337) {
        return fbm(x, y, z, octaves, lacunarity, gain, seed);
    }

    static float worley(float x, float y, float z, uint32_t seed = 42) {
        int xi = static_cast<int>(std::floor(x));
        int yi = static_cast<int>(std::floor(y));
        int zi = static_cast<int>(std::floor(z));

        float minDist = 1e9f;

        for (int dz = -1; dz <= 1; ++dz) {
            for (int dy = -1; dy <= 1; ++dy) {
                for (int dx = -1; dx <= 1; ++dx) {
                    int cx = xi + dx;
                    int cy = yi + dy;
                    int cz = zi + dz;

                    uint32_t h = hash(seed ^ (cx * 73856093 ^ cy * 19349663 ^ cz * 83492791));
                    float fx = cx + static_cast<float>(h & 1023) / 1024.0f;
                    float fy = cy + static_cast<float>((h >> 10) & 1023) / 1024.0f;
                    float fz = cz + static_cast<float>((h >> 20) & 1023) / 1024.0f;

                    float distSq = (x - fx) * (x - fx) + (y - fy) * (y - fy) + (z - fz) * (z - fz);
                    minDist = std::min(minDist, distSq);
                }
            }
        }

        return std::sqrt(minDist);
    }
};

} // namespace math
} // namespace scratchbox

#endif // SCRATCHBOX_MATH_HPP
