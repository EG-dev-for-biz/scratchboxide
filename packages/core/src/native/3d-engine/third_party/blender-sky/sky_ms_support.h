/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/*
 * Not an upstream file. Written by Scratchbox for the vendored sky_multiple_scattering.cpp (MIT),
 * in place of Blender's sky_math.h and sky_nishita.h, which are GPL-2.0-or-later and are not taken.
 * It gives the vendored file only what it uses: small float vector types and their arithmetic,
 * a ray-sphere distance, the sun direction for a zenith cosine, a parallel loop and the
 * declarations of the file's three entry points.
 *
 * The vendored file is included by include/scratchbox_sky_ms.hpp inside a namespace, so every
 * name here lands in that namespace too; the standard headers it needs are included by the
 * adapter first, outside the namespace.
 */

#ifndef SCRATCHBOX_THIRD_PARTY_SKY_MS_SUPPORT_H
#define SCRATCHBOX_THIRD_PARTY_SKY_MS_SUPPORT_H

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <thread>
#include <vector>

#ifndef M_PI_F
#  define M_PI_F 3.14159265358979323846f
#endif
#ifndef M_PI_2_F
#  define M_PI_2_F 1.57079632679489661923f
#endif
#ifndef M_2PI_F
#  define M_2PI_F 6.28318530717958647692f
#endif
#ifndef M_1_PI_F
#  define M_1_PI_F 0.31830988618379067154f
#endif
#ifndef M_1_4PI_F
#  define M_1_4PI_F 0.07957747154594766788f
#endif

struct float2 {
  float x, y;
};
inline float2 make_float2(float x, float y) { return {x, y}; }

struct float3 {
  float x, y, z;
  float length() const { return std::sqrt(x * x + y * y + z * z); }
  float3 &operator+=(const float3 &o) { x += o.x; y += o.y; z += o.z; return *this; }
};
inline float3 make_float3(float x, float y, float z) { return {x, y, z}; }
inline float3 operator+(const float3 &a, const float3 &b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline float3 operator-(const float3 &a) { return {-a.x, -a.y, -a.z}; }
inline float3 operator*(const float3 &a, float s) { return {a.x * s, a.y * s, a.z * s}; }
inline float3 operator/(const float3 &a, float s) { return {a.x / s, a.y / s, a.z / s}; }
inline float dot(const float3 &a, const float3 &b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

struct float4 {
  float v[4];
  float operator[](int i) const { return v[i]; }
  float4 &operator+=(const float4 &o) { for (int i = 0; i < 4; i++) v[i] += o.v[i]; return *this; }
  float4 &operator*=(const float4 &o) { for (int i = 0; i < 4; i++) v[i] *= o.v[i]; return *this; }
};
inline float4 make_float4(float a, float b, float c, float d) { return {{a, b, c, d}}; }
template<class F> inline float4 map4(const float4 &a, const float4 &b, F f)
{
  return {{f(a.v[0], b.v[0]), f(a.v[1], b.v[1]), f(a.v[2], b.v[2]), f(a.v[3], b.v[3])}};
}
inline float4 operator+(const float4 &a, const float4 &b) { return map4(a, b, [](float p, float q) { return p + q; }); }
inline float4 operator-(const float4 &a, const float4 &b) { return map4(a, b, [](float p, float q) { return p - q; }); }
inline float4 operator*(const float4 &a, const float4 &b) { return map4(a, b, [](float p, float q) { return p * q; }); }
inline float4 operator/(const float4 &a, const float4 &b) { return map4(a, b, [](float p, float q) { return p / q; }); }
inline float4 operator*(const float4 &a, float s) { return {{a.v[0] * s, a.v[1] * s, a.v[2] * s, a.v[3] * s}}; }
inline float4 operator*(float s, const float4 &a) { return a * s; }
inline float4 operator/(const float4 &a, float s) { return a * (1.0f / s); }
inline float4 operator-(const float4 &a) { return a * -1.0f; }
inline float4 exp(const float4 &a) { return {{std::exp(a.v[0]), std::exp(a.v[1]), std::exp(a.v[2]), std::exp(a.v[3])}}; }
inline float4 max(const float4 &a, float m)
{
  return {{std::max(a.v[0], m), std::max(a.v[1], m), std::max(a.v[2], m), std::max(a.v[3], m)}};
}

inline float sqr(float a) { return a * a; }
inline float clamp(float a, float lo, float hi) { return std::min(std::max(a, lo), hi); }
inline float saturate(float a) { return clamp(a, 0.0f, 1.0f); }
inline float safe_sqrtf(float a) { return std::sqrt(std::max(a, 0.0f)); }
inline float mix(float a, float b, float t) { return a + (b - a) * t; }
inline float4 mix(const float4 &a, const float4 &b, float t) { return a + (b - a) * t; }

/* Distance along the unit direction `dir` from `origin` to the sphere of radius `radius` about the
 * origin of coordinates: the nearer crossing ahead of the ray, the farther one when the ray starts
 * inside, and -1 when the line misses the sphere or both crossings lie behind. */
inline float ray_sphere_intersection(const float3 &origin, const float3 &dir, float radius)
{
  const float b = dot(origin, dir);
  const float c = dot(origin, origin) - radius * radius;
  const float disc = b * b - c;
  if (disc < 0.0f) {
    return -1.0f;
  }
  const float root = std::sqrt(disc);
  const float near_t = -b - root;
  if (near_t >= 0.0f) {
    return near_t;
  }
  const float far_t = -b + root;
  return far_t >= 0.0f ? far_t : -1.0f;
}

/* The sun's unit direction in the vendored file's frame (+Z up, the sun in the X-Z plane at
 * azimuth 0) for the cosine of its zenith angle. */
inline float3 sun_direction(float cos_zenith)
{
  return make_float3(safe_sqrtf(1.0f - cos_zenith * cos_zenith), 0.0f, cos_zenith);
}

/* Runs fn(chunk_begin, chunk_end) over [begin, end) in chunks of `grain`, spread over the
 * machine's threads (SCRATCHBOX_K_NATIVE_THREADS is not read: the sky is small). */
template<class Fn> inline void SKY_parallel_for(size_t begin, size_t end, size_t grain, const Fn &fn)
{
  if (end <= begin) {
    return;
  }
  grain = std::max<size_t>(grain, 1);
  const size_t chunks = (end - begin + grain - 1) / grain;
  const size_t threads = std::min<size_t>(chunks, std::max(1u, std::min(16u, std::thread::hardware_concurrency())));
  if (threads <= 1) {
    fn(begin, end);
    return;
  }
  std::vector<std::thread> pool;
  pool.reserve(threads);
  for (size_t t = 0; t < threads; t++) {
    pool.emplace_back([&, t]() {
      for (size_t chunk = t; chunk < chunks; chunk += threads) {
        const size_t b = begin + chunk * grain;
        fn(b, std::min(end, b + grain));
      }
    });
  }
  for (std::thread &th : pool) {
    th.join();
  }
}

/* The vendored file's entry points. */
void SKY_multiple_scattering_precompute_texture(float *pixels, int stride, int width, int height,
                                                float sun_elevation, float altitude,
                                                float air_density, float aerosol_density,
                                                float ozone_density);
void SKY_multiple_scattering_precompute_sun(float sun_elevation, float angular_diameter,
                                            float altitude, float air_density,
                                            float aerosol_density, float ozone_density,
                                            float r_pixel_bottom[3], float r_pixel_top[3]);
float SKY_earth_intersection_angle(float altitude);

#endif /* SCRATCHBOX_THIRD_PARTY_SKY_MS_SUPPORT_H */
