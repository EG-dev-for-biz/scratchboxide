/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
#ifndef SCRATCHBOX_RELIEF_NORMALS_HPP
#define SCRATCHBOX_RELIEF_NORMALS_HPP
/**
 * Relief between height maps and normal maps, on a regular grid of square texels (metres), no model involved:
 *   - heightToNormals: a height map (metres, toward the viewer) to unit normals by the Sobel gradient. Unknown texels
 *     (NaN) take no part: a gradient is read only from known neighbours, and an unknown texel gets the flat normal.
 *   - integrateNormals: a normal map back to the height it implies, by Frankot and Chellappa's projection of the gradient
 *     field onto integrable fields in the Fourier basis (Frankot & Chellappa 1988; Queau, Durou & Aujol, "Normal
 *     integration: a survey", 2018). The grid is mirrored on both axes before the transform, so the solution is not
 *     forced to be periodic (the bias the survey points out), and the 2*pi of the frequency is kept. Height is known up
 *     to a constant: the result has zero mean over the known texels.
 * Image convention: row 0 at the top, x to the right; the normal's x along +x, its y up the image (toward row 0), z out.
 */
#include <cmath>
#include <complex>
#include <cstdint>
#include <vector>

namespace scratchbox {
namespace relief_normals {

struct NormalMap { int width{0}, height{0}; std::vector<float> n; /** x, y, z per texel */ };

/** Unit normals from heights (metres) at texelM per texel; NaN heights are unknown. */
inline NormalMap heightToNormals(int W, int H, const std::vector<float>& h, double texelM) {
    NormalMap out{W, H, std::vector<float>(static_cast<size_t>(W) * H * 3, 0.0f)};
    auto at = [&](int x, int y) -> float { x = x < 0 ? 0 : x >= W ? W - 1 : x; y = y < 0 ? 0 : y >= H ? H - 1 : y; return h[static_cast<size_t>(y) * W + x]; };
    for (int y = 0; y < H; ++y) for (int x = 0; x < W; ++x) {
        float* o = &out.n[(static_cast<size_t>(y) * W + x) * 3];
        const float c = at(x, y);
        if (!std::isfinite(c)) { o[2] = 1.0f; continue; }
        // Sobel, each tap replaced by the centre where unknown (so an unknown neighbour adds no slope)
        auto v = [&](int dx, int dy) { const float s = at(x + dx, y + dy); return std::isfinite(s) ? s : c; };
        const double gx = ((v(1, -1) + 2 * v(1, 0) + v(1, 1)) - (v(-1, -1) + 2 * v(-1, 0) + v(-1, 1))) / (8.0 * texelM);
        // image y runs down; the normal's y runs up
        const double gyDown = ((v(-1, 1) + 2 * v(0, 1) + v(1, 1)) - (v(-1, -1) + 2 * v(0, -1) + v(1, -1))) / (8.0 * texelM);
        const double gy = -gyDown;
        const double l = std::sqrt(gx * gx + gy * gy + 1.0);
        o[0] = static_cast<float>(-gx / l); o[1] = static_cast<float>(-gy / l); o[2] = static_cast<float>(1.0 / l);
    }
    return out;
}

namespace detail {
/** In-place radix-2 FFT (n a power of two); inverse scales by 1/n. */
inline void fft(std::vector<std::complex<double>>& a, bool inverse) {
    const size_t n = a.size();
    for (size_t i = 1, j = 0; i < n; ++i) { size_t bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) std::swap(a[i], a[j]); }
    for (size_t len = 2; len <= n; len <<= 1) {
        const double ang = 2.0 * M_PI / static_cast<double>(len) * (inverse ? 1.0 : -1.0);
        const std::complex<double> wl(std::cos(ang), std::sin(ang));
        for (size_t i = 0; i < n; i += len) {
            std::complex<double> w(1.0, 0.0);
            for (size_t k = 0; k < len / 2; ++k) { const auto u = a[i + k], t = a[i + k + len / 2] * w; a[i + k] = u + t; a[i + k + len / 2] = u - t; w *= wl; }
        }
    }
    if (inverse) for (auto& x : a) x /= static_cast<double>(n);
}
inline size_t pow2(size_t v) { size_t p = 1; while (p < v) p <<= 1; return p; }
/** 2D FFT of a row-major grid w x h (both powers of two). */
inline void fft2(std::vector<std::complex<double>>& g, size_t w, size_t h, bool inverse) {
    std::vector<std::complex<double>> line;
    line.resize(w);
    for (size_t y = 0; y < h; ++y) { for (size_t x = 0; x < w; ++x) line[x] = g[y * w + x]; fft(line, inverse); for (size_t x = 0; x < w; ++x) g[y * w + x] = line[x]; }
    line.resize(h);
    for (size_t x = 0; x < w; ++x) { for (size_t y = 0; y < h; ++y) line[y] = g[y * w + x]; fft(line, inverse); for (size_t y = 0; y < h; ++y) g[y * w + x] = line[y]; }
}
} // namespace detail

/**
 * The height (metres) a normal map implies, by Frankot-Chellappa on the mirrored grid. Texels whose normal is not finite
 * or faces away (z <= 0.05) take zero gradient. `known` (optional, 1 per texel) limits the zero-mean to those texels.
 */
inline std::vector<float> integrateNormals(const NormalMap& m, double texelM, const std::vector<uint8_t>* known = nullptr) {
    const int W = m.width, H = m.height;
    // gradients in image coordinates (x right, y down), metres per metre
    std::vector<double> p(static_cast<size_t>(W) * H, 0.0), q(static_cast<size_t>(W) * H, 0.0);
    for (size_t i = 0; i < p.size(); ++i) {
        const float nx = m.n[i * 3], ny = m.n[i * 3 + 1], nz = m.n[i * 3 + 2];
        if (!(nz > 0.05f) || !std::isfinite(nx) || !std::isfinite(ny)) continue;
        p[i] = -nx / nz;            // dh/dx
        q[i] = ny / nz;             // dh/dy (y down): the normal's y is up
    }
    // mirrored grid 2W x 2H (p odd under the x mirror, q odd under the y mirror), padded to powers of two
    const size_t MW = 2 * static_cast<size_t>(W), MH = 2 * static_cast<size_t>(H);
    const size_t FW = detail::pow2(MW), FH = detail::pow2(MH);
    std::vector<std::complex<double>> P(FW * FH), Q(FW * FH);
    for (size_t y = 0; y < MH; ++y) for (size_t x = 0; x < MW; ++x) {
        const bool fx = x >= static_cast<size_t>(W), fy = y >= static_cast<size_t>(H);
        const size_t sx = fx ? MW - 1 - x : x, sy = fy ? MH - 1 - y : y;
        const size_t s = sy * W + sx;
        P[y * FW + x] = (fx ? -p[s] : p[s]);
        Q[y * FW + x] = (fy ? -q[s] : q[s]);
    }
    detail::fft2(P, FW, FH, false);
    detail::fft2(Q, FW, FH, false);
    std::vector<std::complex<double>> Z(FW * FH);
    const std::complex<double> I(0.0, 1.0);
    for (size_t v = 0; v < FH; ++v) for (size_t u = 0; u < FW; ++u) {
        // signed frequencies with the 2*pi kept, per texel
        const double wu = 2.0 * M_PI * (u <= FW / 2 ? static_cast<double>(u) : static_cast<double>(u) - static_cast<double>(FW)) / static_cast<double>(FW);
        const double wv = 2.0 * M_PI * (v <= FH / 2 ? static_cast<double>(v) : static_cast<double>(v) - static_cast<double>(FH)) / static_cast<double>(FH);
        const double d = wu * wu + wv * wv;
        if (d < 1e-18) { Z[v * FW + u] = 0.0; continue; }
        Z[v * FW + u] = (-I * wu * P[v * FW + u] - I * wv * Q[v * FW + u]) / d;
    }
    detail::fft2(Z, FW, FH, true);
    std::vector<float> h(static_cast<size_t>(W) * H);
    double sum = 0.0; size_t n = 0;
    for (int y = 0; y < H; ++y) for (int x = 0; x < W; ++x) {
        const double z = Z[static_cast<size_t>(y) * FW + x].real() * texelM;
        h[static_cast<size_t>(y) * W + x] = static_cast<float>(z);
        if (!known || (*known)[static_cast<size_t>(y) * W + x]) { sum += z; ++n; }
    }
    const float mean = n ? static_cast<float>(sum / static_cast<double>(n)) : 0.0f;
    for (auto& z : h) z -= mean;
    return h;
}

} // namespace relief_normals
} // namespace scratchbox

#endif // SCRATCHBOX_RELIEF_NORMALS_HPP
