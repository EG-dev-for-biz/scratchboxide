/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_COLMAP_HPP
#define SCRATCHBOX_COLMAP_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include <vector>
#include <string>
#include <unordered_map>
#include <fstream>
#include <sstream>
#include <iostream>
#include <memory>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <cstring>

namespace scratchbox {
namespace colmap {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Mat3;
using math::Mat4;
using math::Quat;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;
using io::GlbWriter;

// ============================================================================
// 1. COLMAP Camera Models & Intrinsics
// ============================================================================

enum class CameraModelId : int {
    SIMPLE_PINHOLE = 0,
    PINHOLE = 1,
    SIMPLE_RADIAL = 2,
    RADIAL = 3,
    OPENCV = 4,
    OPENCV_FISHEYE = 5,
    FULL_OPENCV = 6,
    FOV = 7,
    SIMPLE_RADIAL_FISHEYE = 8,
    RADIAL_FISHEYE = 9,
    THIN_PRISM_FISHEYE = 10
};

inline std::string cameraModelToString(CameraModelId model) {
    switch (model) {
        case CameraModelId::SIMPLE_PINHOLE: return "SIMPLE_PINHOLE";
        case CameraModelId::PINHOLE: return "PINHOLE";
        case CameraModelId::SIMPLE_RADIAL: return "SIMPLE_RADIAL";
        case CameraModelId::RADIAL: return "RADIAL";
        case CameraModelId::OPENCV: return "OPENCV";
        case CameraModelId::OPENCV_FISHEYE: return "OPENCV_FISHEYE";
        case CameraModelId::FULL_OPENCV: return "FULL_OPENCV";
        case CameraModelId::FOV: return "FOV";
        case CameraModelId::SIMPLE_RADIAL_FISHEYE: return "SIMPLE_RADIAL_FISHEYE";
        case CameraModelId::RADIAL_FISHEYE: return "RADIAL_FISHEYE";
        case CameraModelId::THIN_PRISM_FISHEYE: return "THIN_PRISM_FISHEYE";
        default: return "UNKNOWN";
    }
}

inline CameraModelId stringToCameraModel(const std::string& name) {
    if (name == "SIMPLE_PINHOLE") return CameraModelId::SIMPLE_PINHOLE;
    if (name == "PINHOLE") return CameraModelId::PINHOLE;
    if (name == "SIMPLE_RADIAL") return CameraModelId::SIMPLE_RADIAL;
    if (name == "RADIAL") return CameraModelId::RADIAL;
    if (name == "OPENCV") return CameraModelId::OPENCV;
    if (name == "OPENCV_FISHEYE") return CameraModelId::OPENCV_FISHEYE;
    if (name == "FULL_OPENCV") return CameraModelId::FULL_OPENCV;
    if (name == "FOV") return CameraModelId::FOV;
    if (name == "SIMPLE_RADIAL_FISHEYE") return CameraModelId::SIMPLE_RADIAL_FISHEYE;
    if (name == "RADIAL_FISHEYE") return CameraModelId::RADIAL_FISHEYE;
    if (name == "THIN_PRISM_FISHEYE") return CameraModelId::THIN_PRISM_FISHEYE;
    return CameraModelId::PINHOLE;
}

inline size_t getNumParamsForModel(CameraModelId model) {
    switch (model) {
        case CameraModelId::SIMPLE_PINHOLE: return 3; // f, cx, cy
        case CameraModelId::PINHOLE: return 4;        // fx, fy, cx, cy
        case CameraModelId::SIMPLE_RADIAL: return 4; // f, cx, cy, k
        case CameraModelId::RADIAL: return 5;        // f, cx, cy, k1, k2
        case CameraModelId::OPENCV: return 8;        // fx, fy, cx, cy, k1, k2, p1, p2
        case CameraModelId::OPENCV_FISHEYE: return 8;// fx, fy, cx, cy, k1, k2, k3, k4
        case CameraModelId::FULL_OPENCV: return 12;  // fx, fy, cx, cy, k1, k2, p1, p2, k3, k4, k5, k6
        case CameraModelId::FOV: return 5;          // fx, fy, cx, cy, omega
        case CameraModelId::SIMPLE_RADIAL_FISHEYE: return 4; // f, cx, cy, k
        case CameraModelId::RADIAL_FISHEYE: return 5;        // f, cx, cy, k1, k2
        case CameraModelId::THIN_PRISM_FISHEYE: return 12;   // fx, fy, cx, cy, k1, k2, p1, p2, k3, k4, sx1, sy1
        default: return 4;
    }
}

struct ColmapCamera {
    uint32_t cameraId{0};
    CameraModelId model{CameraModelId::PINHOLE};
    uint64_t width{0};
    uint64_t height{0};
    std::vector<double> params;

    // Helper: Extract focal length (horizontal and vertical)
    void getFocalLength(float& fx, float& fy) const {
        if (params.empty()) {
            fx = fy = 500.0f;
            return;
        }
        if (model == CameraModelId::SIMPLE_PINHOLE ||
            model == CameraModelId::SIMPLE_RADIAL ||
            model == CameraModelId::RADIAL ||
            model == CameraModelId::SIMPLE_RADIAL_FISHEYE ||
            model == CameraModelId::RADIAL_FISHEYE) {
            fx = fy = static_cast<float>(params[0]);
        } else {
            fx = static_cast<float>(params[0]);
            fy = params.size() > 1 ? static_cast<float>(params[1]) : fx;
        }
    }

    // Helper: Extract principal point (cx, cy)
    void getPrincipalPoint(float& cx, float& cy) const {
        if (model == CameraModelId::SIMPLE_PINHOLE ||
            model == CameraModelId::SIMPLE_RADIAL ||
            model == CameraModelId::RADIAL ||
            model == CameraModelId::SIMPLE_RADIAL_FISHEYE ||
            model == CameraModelId::RADIAL_FISHEYE) {
            cx = params.size() > 1 ? static_cast<float>(params[1]) : static_cast<float>(width) * 0.5f;
            cy = params.size() > 2 ? static_cast<float>(params[2]) : static_cast<float>(height) * 0.5f;
        } else {
            cx = params.size() > 2 ? static_cast<float>(params[2]) : static_cast<float>(width) * 0.5f;
            cy = params.size() > 3 ? static_cast<float>(params[3]) : static_cast<float>(height) * 0.5f;
        }
    }

    // Horizontal Field-of-View in degrees
    float getFovXDegrees() const {
        float fx, fy;
        getFocalLength(fx, fy);
        if (fx <= 0.0f || width == 0) return 60.0f;
        return 2.0f * std::atan(static_cast<float>(width) / (2.0f * fx)) * math::RAD_TO_DEG;
    }

    // Vertical Field-of-View in degrees
    float getFovYDegrees() const {
        float fx, fy;
        getFocalLength(fx, fy);
        if (fy <= 0.0f || height == 0) return 45.0f;
        return 2.0f * std::atan(static_cast<float>(height) / (2.0f * fy)) * math::RAD_TO_DEG;
    }
};

// ============================================================================
// 2. COLMAP Image Pose & 2D Observations
// ============================================================================

struct Point2DTrack {
    Vec2 xy{0.0f, 0.0f};
    int64_t point3DId{-1};
};

struct ColmapImage {
    uint32_t imageId{0};
    Vec4 qvec{1.0f, 0.0f, 0.0f, 0.0f}; // (qw, qx, qy, qz) normalized quaternion World-to-Camera
    Vec3 tvec{0.0f, 0.0f, 0.0f};       // (tx, ty, tz) translation World-to-Camera
    uint32_t cameraId{0};
    std::string name;
    std::vector<Point2DTrack> points2D;

    /**
     * Compute World-to-Camera 3x3 rotation matrix (OpenCV frame: +X Right, +Y Down, +Z Forward).
     */
    Mat3 getRotationMatrixW2C() const {
        float qw = qvec.x;
        float qx = qvec.y;
        float qy = qvec.z;
        float qz = qvec.w;

        float x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
        float xx = qx * x2, xy = qx * y2, xz = qx * z2;
        float yy = qy * y2, yz = qy * z2, zz = qz * z2;
        float wx = qw * x2, wy = qw * y2, wz = qw * z2;

        return Mat3(
            1.0f - (yy + zz), xy - wz,          xz + wy,
            xy + wz,          1.0f - (xx + zz), yz - wx,
            xz - wy,          yz + wx,          1.0f - (xx + yy)
        );
    }

    /**
     * Compute Camera-to-World 3x3 rotation matrix (OpenCV frame).
     */
    Mat3 getRotationMatrixC2W() const {
        return getRotationMatrixW2C().transpose();
    }

    /**
     * Compute camera optical center in World Space: C = -R_w2c^T * T_w2c
     */
    Vec3 getCameraCenter() const {
        Mat3 R_c2w = getRotationMatrixC2W();
        return -(R_c2w * tvec);
    }

    /**
     * Compute Camera-to-World 4x4 matrix converted into OpenGL / Three.js convention:
     * - Inverts Y and Z camera axes (+Y Up, -Z Forward, +X Right).
     */
    Mat4 getOpenGLCameraToWorldMatrix() const {
        Mat3 R_c2w = getRotationMatrixC2W();
        Vec3 center = getCameraCenter();

        // OpenCV: +X right, +Y down, +Z forward
        // OpenGL: +X right, +Y up, -Z forward
        // Apply column flipping: col1 (Y) = -col1, col2 (Z) = -col2
        Mat4 m = Mat4::identity();
        // Column 0 (+X right)
        m.m[0] = R_c2w.m[0];
        m.m[1] = R_c2w.m[3];
        m.m[2] = R_c2w.m[6];

        // Column 1 (+Y up = -Y_cv)
        m.m[4] = -R_c2w.m[1];
        m.m[5] = -R_c2w.m[4];
        m.m[6] = -R_c2w.m[7];

        // Column 2 (+Z back = -Z_cv, so viewing direction is -Z)
        m.m[8]  = -R_c2w.m[2];
        m.m[9]  = -R_c2w.m[5];
        m.m[10] = -R_c2w.m[8];

        // Column 3 (World Position)
        m.m[12] = center.x;
        m.m[13] = center.y;
        m.m[14] = center.z;

        return m;
    }

    /**
     * Compute OpenGL View Matrix (World-to-Camera with OpenGL convention).
     */
    Mat4 getOpenGLViewMatrix() const {
        Mat3 R_w2c = getRotationMatrixW2C();
        Vec3 center = getCameraCenter();

        // Row flipping for OpenCV to OpenGL:
        // OpenGL row 0 = OpenCV row 0 (+X)
        // OpenGL row 1 = -OpenCV row 1 (+Y up)
        // OpenGL row 2 = -OpenCV row 2 (-Z forward)
        Mat4 v = Mat4::identity();

        Vec3 right(R_w2c.m[0], R_w2c.m[1], R_w2c.m[2]);
        Vec3 up(-R_w2c.m[3], -R_w2c.m[4], -R_w2c.m[5]);
        Vec3 forward(R_w2c.m[6], R_w2c.m[7], R_w2c.m[8]);

        v.m[0] = right.x;    v.m[4] = right.y;    v.m[8]  = right.z;    v.m[12] = -right.dot(center);
        v.m[1] = up.x;       v.m[5] = up.y;       v.m[9]  = up.z;       v.m[13] = -up.dot(center);
        v.m[2] = forward.x;  v.m[6] = forward.y;  v.m[10] = forward.z;  v.m[14] = -forward.dot(center);
        v.m[3] = 0.0f;       v.m[7] = 0.0f;       v.m[11] = 0.0f;       v.m[15] = 1.0f;

        return v;
    }

    /**
     * Get optical viewing direction ray in world space (normalized).
     */
    Vec3 getViewingDirection() const {
        Mat3 R_c2w = getRotationMatrixC2W();
        // Forward in OpenCV is +Z (third column of R_c2w)
        return Vec3(R_c2w.m[2], R_c2w.m[5], R_c2w.m[8]).normalized();
    }
};

// ============================================================================
// 3. COLMAP Sparse 3D Points
// ============================================================================

struct PointTrackElement {
    uint32_t imageId{0};
    uint32_t point2DIdx{0};
};

struct ColmapPoint3D {
    uint64_t point3DId{0};
    Vec3 xyz{0.0f, 0.0f, 0.0f};
    Vec4 rgb{1.0f, 1.0f, 1.0f, 1.0f}; // [0, 1] normalized
    double error{0.0};
    std::vector<PointTrackElement> track;
};

// ============================================================================
// 4. COLMAP Sparse Reconstruction Dataset
// ============================================================================

struct ColmapReconstruction {
    std::unordered_map<uint32_t, ColmapCamera> cameras;
    std::unordered_map<uint32_t, ColmapImage> images;
    std::unordered_map<uint64_t, ColmapPoint3D> points3D;

    size_t numCameras() const { return cameras.size(); }
    size_t numImages() const { return images.size(); }
    size_t numPoints3D() const { return points3D.size(); }

    geometry::AABB computeBoundingBox() const {
        geometry::AABB aabb;
        for (const auto& [id, pt] : points3D) {
            aabb.min.x = std::min(aabb.min.x, pt.xyz.x);
            aabb.min.y = std::min(aabb.min.y, pt.xyz.y);
            aabb.min.z = std::min(aabb.min.z, pt.xyz.z);
            aabb.max.x = std::max(aabb.max.x, pt.xyz.x);
            aabb.max.y = std::max(aabb.max.y, pt.xyz.y);
            aabb.max.z = std::max(aabb.max.z, pt.xyz.z);
        }
        return aabb;
    }

    Vec3 computeCentroid() const {
        if (points3D.empty()) {
            if (images.empty()) return Vec3(0, 0, 0);
            Vec3 sum(0, 0, 0);
            for (const auto& [id, img] : images) {
                sum += img.getCameraCenter();
            }
            return sum / static_cast<float>(images.size());
        }
        Vec3 sum(0, 0, 0);
        for (const auto& [id, pt] : points3D) {
            sum += pt.xyz;
        }
        return sum / static_cast<float>(points3D.size());
    }
};

// ============================================================================
// 5. Zero-Dependency Text & Binary Parsers
// ============================================================================

class ColmapParser {
public:
    // ------------------------------------------------------------------------
    // Cameras Text Parser
    // ------------------------------------------------------------------------
    static bool parseCamerasText(const std::string& content, std::unordered_map<uint32_t, ColmapCamera>& outCameras) {
        std::istringstream stream(content);
        std::string line;
        while (std::getline(stream, line)) {
            if (line.empty() || line[0] == '#') continue;
            std::istringstream lineStream(line);
            ColmapCamera cam;
            std::string modelStr;
            if (!(lineStream >> cam.cameraId >> modelStr >> cam.width >> cam.height)) {
                continue;
            }
            cam.model = stringToCameraModel(modelStr);
            double val;
            while (lineStream >> val) {
                cam.params.push_back(val);
            }
            outCameras[cam.cameraId] = cam;
        }
        return !outCameras.empty();
    }

    // ------------------------------------------------------------------------
    // Images Text Parser
    // ------------------------------------------------------------------------
    static bool parseImagesText(const std::string& content, std::unordered_map<uint32_t, ColmapImage>& outImages) {
        std::istringstream stream(content);
        std::string line;
        while (std::getline(stream, line)) {
            if (line.empty() || line[0] == '#') continue;
            std::istringstream lineStream(line);
            ColmapImage img;
            double qw, qx, qy, qz, tx, ty, tz;
            if (!(lineStream >> img.imageId >> qw >> qx >> qy >> qz >> tx >> ty >> tz >> img.cameraId >> img.name)) {
                continue;
            }
            img.qvec = Vec4(static_cast<float>(qw), static_cast<float>(qx), static_cast<float>(qy), static_cast<float>(qz));
            img.tvec = Vec3(static_cast<float>(tx), static_cast<float>(ty), static_cast<float>(tz));

            // Parse line 2: 2D points
            if (std::getline(stream, line)) {
                std::istringstream ptStream(line);
                float x, y;
                int64_t pt3DId;
                while (ptStream >> x >> y >> pt3DId) {
                    img.points2D.push_back({Vec2(x, y), pt3DId});
                }
            }
            outImages[img.imageId] = img;
        }
        return !outImages.empty();
    }

    // ------------------------------------------------------------------------
    // Points3D Text Parser
    // ------------------------------------------------------------------------
    static bool parsePoints3DText(const std::string& content, std::unordered_map<uint64_t, ColmapPoint3D>& outPoints) {
        std::istringstream stream(content);
        std::string line;
        while (std::getline(stream, line)) {
            if (line.empty() || line[0] == '#') continue;
            std::istringstream lineStream(line);
            ColmapPoint3D pt;
            double x, y, z;
            int r, g, b;
            if (!(lineStream >> pt.point3DId >> x >> y >> z >> r >> g >> b >> pt.error)) {
                continue;
            }
            pt.xyz = Vec3(static_cast<float>(x), static_cast<float>(y), static_cast<float>(z));
            pt.rgb = Vec4(static_cast<float>(r) / 255.0f, static_cast<float>(g) / 255.0f, static_cast<float>(b) / 255.0f, 1.0f);

            uint32_t imgId, pt2DIdx;
            while (lineStream >> imgId >> pt2DIdx) {
                pt.track.push_back({imgId, pt2DIdx});
            }
            outPoints[pt.point3DId] = pt;
        }
        return !outPoints.empty();
    }

    // ------------------------------------------------------------------------
    // Cameras Binary Parser (.bin)
    // ------------------------------------------------------------------------
    static bool parseCamerasBinary(std::istream& stream, std::unordered_map<uint32_t, ColmapCamera>& outCameras) {
        uint64_t numCameras = 0;
        stream.read(reinterpret_cast<char*>(&numCameras), sizeof(numCameras));
        if (stream.fail()) return false;

        for (uint64_t i = 0; i < numCameras; ++i) {
            ColmapCamera cam;
            int32_t modelIdRaw = 0;
            stream.read(reinterpret_cast<char*>(&cam.cameraId), sizeof(cam.cameraId));
            stream.read(reinterpret_cast<char*>(&modelIdRaw), sizeof(modelIdRaw));
            stream.read(reinterpret_cast<char*>(&cam.width), sizeof(cam.width));
            stream.read(reinterpret_cast<char*>(&cam.height), sizeof(cam.height));

            cam.model = static_cast<CameraModelId>(modelIdRaw);
            size_t numParams = getNumParamsForModel(cam.model);
            cam.params.resize(numParams);
            stream.read(reinterpret_cast<char*>(cam.params.data()), numParams * sizeof(double));

            outCameras[cam.cameraId] = cam;
        }
        return true;
    }

    // ------------------------------------------------------------------------
    // Images Binary Parser (.bin)
    // ------------------------------------------------------------------------
    static bool parseImagesBinary(std::istream& stream, std::unordered_map<uint32_t, ColmapImage>& outImages) {
        uint64_t numImages = 0;
        stream.read(reinterpret_cast<char*>(&numImages), sizeof(numImages));
        if (stream.fail()) return false;

        for (uint64_t i = 0; i < numImages; ++i) {
            ColmapImage img;
            double qw, qx, qy, qz, tx, ty, tz;
            stream.read(reinterpret_cast<char*>(&img.imageId), sizeof(img.imageId));
            stream.read(reinterpret_cast<char*>(&qw), sizeof(qw));
            stream.read(reinterpret_cast<char*>(&qx), sizeof(qx));
            stream.read(reinterpret_cast<char*>(&qy), sizeof(qy));
            stream.read(reinterpret_cast<char*>(&qz), sizeof(qz));
            stream.read(reinterpret_cast<char*>(&tx), sizeof(tx));
            stream.read(reinterpret_cast<char*>(&ty), sizeof(ty));
            stream.read(reinterpret_cast<char*>(&tz), sizeof(tz));
            stream.read(reinterpret_cast<char*>(&img.cameraId), sizeof(img.cameraId));

            img.qvec = Vec4(static_cast<float>(qw), static_cast<float>(qx), static_cast<float>(qy), static_cast<float>(qz));
            img.tvec = Vec3(static_cast<float>(tx), static_cast<float>(ty), static_cast<float>(tz));

            char c;
            img.name.clear();
            while (stream.get(c) && c != '\0') {
                img.name += c;
            }

            uint64_t numPoints2D = 0;
            stream.read(reinterpret_cast<char*>(&numPoints2D), sizeof(numPoints2D));
            for (uint64_t p = 0; p < numPoints2D; ++p) {
                double x, y;
                uint64_t point3DId;
                stream.read(reinterpret_cast<char*>(&x), sizeof(x));
                stream.read(reinterpret_cast<char*>(&y), sizeof(y));
                stream.read(reinterpret_cast<char*>(&point3DId), sizeof(point3DId));
                img.points2D.push_back({Vec2(static_cast<float>(x), static_cast<float>(y)), static_cast<int64_t>(point3DId)});
            }
            outImages[img.imageId] = img;
        }
        return true;
    }

    // ------------------------------------------------------------------------
    // Points3D Binary Parser (.bin)
    // ------------------------------------------------------------------------
    static bool parsePoints3DBinary(std::istream& stream, std::unordered_map<uint64_t, ColmapPoint3D>& outPoints) {
        uint64_t numPoints = 0;
        stream.read(reinterpret_cast<char*>(&numPoints), sizeof(numPoints));
        if (stream.fail()) return false;

        for (uint64_t i = 0; i < numPoints; ++i) {
            ColmapPoint3D pt;
            double x, y, z;
            uint8_t r, g, b;
            stream.read(reinterpret_cast<char*>(&pt.point3DId), sizeof(pt.point3DId));
            stream.read(reinterpret_cast<char*>(&x), sizeof(x));
            stream.read(reinterpret_cast<char*>(&y), sizeof(y));
            stream.read(reinterpret_cast<char*>(&z), sizeof(z));
            stream.read(reinterpret_cast<char*>(&r), sizeof(r));
            stream.read(reinterpret_cast<char*>(&g), sizeof(g));
            stream.read(reinterpret_cast<char*>(&b), sizeof(b));
            stream.read(reinterpret_cast<char*>(&pt.error), sizeof(pt.error));

            pt.xyz = Vec3(static_cast<float>(x), static_cast<float>(y), static_cast<float>(z));
            pt.rgb = Vec4(static_cast<float>(r) / 255.0f, static_cast<float>(g) / 255.0f, static_cast<float>(b) / 255.0f, 1.0f);

            uint64_t trackLen = 0;
            stream.read(reinterpret_cast<char*>(&trackLen), sizeof(trackLen));
            for (uint64_t t = 0; t < trackLen; ++t) {
                uint32_t imgId, pt2DIdx;
                stream.read(reinterpret_cast<char*>(&imgId), sizeof(imgId));
                stream.read(reinterpret_cast<char*>(&pt2DIdx), sizeof(pt2DIdx));
                pt.track.push_back({imgId, pt2DIdx});
            }
            outPoints[pt.point3DId] = pt;
        }
        return true;
    }

    // ------------------------------------------------------------------------
    // Unified Sparse Directory Loader (handles .bin and .txt)
    // ------------------------------------------------------------------------
    static bool loadFromDirectory(const std::string& dirPath, ColmapReconstruction& outReconstruction) {
        std::string base = dirPath;
        if (!base.empty() && base.back() != '/' && base.back() != '\\') {
            base += "/";
        }

        // 1. Cameras
        std::ifstream camBin(base + "cameras.bin", std::ios::binary);
        if (camBin.is_open()) {
            parseCamerasBinary(camBin, outReconstruction.cameras);
        } else {
            std::ifstream camTxt(base + "cameras.txt");
            if (camTxt.is_open()) {
                std::string str((std::istreambuf_iterator<char>(camTxt)), std::istreambuf_iterator<char>());
                parseCamerasText(str, outReconstruction.cameras);
            }
        }

        // 2. Images
        std::ifstream imgBin(base + "images.bin", std::ios::binary);
        if (imgBin.is_open()) {
            parseImagesBinary(imgBin, outReconstruction.images);
        } else {
            std::ifstream imgTxt(base + "images.txt");
            if (imgTxt.is_open()) {
                std::string str((std::istreambuf_iterator<char>(imgTxt)), std::istreambuf_iterator<char>());
                parseImagesText(str, outReconstruction.images);
            }
        }

        // 3. Points3D
        std::ifstream ptBin(base + "points3D.bin", std::ios::binary);
        if (ptBin.is_open()) {
            parsePoints3DBinary(ptBin, outReconstruction.points3D);
        } else {
            std::ifstream ptTxt(base + "points3D.txt");
            if (ptTxt.is_open()) {
                std::string str((std::istreambuf_iterator<char>(ptTxt)), std::istreambuf_iterator<char>());
                parsePoints3DText(str, outReconstruction.points3D);
            }
        }

        return !outReconstruction.cameras.empty() || !outReconstruction.images.empty();
    }

    // ------------------------------------------------------------------------
    // Unified Sparse Directory Writer (writes standard COLMAP text format)
    // ------------------------------------------------------------------------
    static bool writeToDirectory(const std::string& dirPath, const ColmapReconstruction& reconstruction) {
        std::string base = dirPath;
        if (!base.empty() && base.back() != '/' && base.back() != '\\') {
            base += "/";
        }
        std::filesystem::create_directories(base);

        // 1. cameras.txt
        std::ofstream camFile(base + "cameras.txt");
        if (!camFile.is_open()) return false;
        camFile << "# Camera list with one line of data per camera:\n";
        camFile << "#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n";
        for (const auto& [camId, cam] : reconstruction.cameras) {
            camFile << cam.cameraId << " " << cameraModelToString(cam.model) << " " << cam.width << " " << cam.height;
            for (double p : cam.params) {
                camFile << " " << p;
            }
            camFile << "\n";
        }
        camFile.close();

        // 2. images.txt
        std::ofstream imgFile(base + "images.txt");
        if (!imgFile.is_open()) return false;
        imgFile << "# Image list with two lines of data per image:\n";
        imgFile << "#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n";
        imgFile << "#   POINTS2D[] as (X, Y, POINT3D_ID)\n";
        for (const auto& [imgId, img] : reconstruction.images) {
            imgFile << img.imageId << " "
                    << img.qvec.x << " " << img.qvec.y << " " << img.qvec.z << " " << img.qvec.w << " "
                    << img.tvec.x << " " << img.tvec.y << " " << img.tvec.z << " "
                    << img.cameraId << " " << img.name << "\n";
            for (size_t p = 0; p < img.points2D.size(); ++p) {
                if (p > 0) imgFile << " ";
                imgFile << img.points2D[p].xy.x << " " << img.points2D[p].xy.y << " " << img.points2D[p].point3DId;
            }
            imgFile << "\n";
        }
        imgFile.close();

        // 3. points3D.txt
        std::ofstream ptFile(base + "points3D.txt");
        if (!ptFile.is_open()) return false;
        ptFile << "# 3D point list with one line of data per point:\n";
        ptFile << "#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n";
        for (const auto& [ptId, pt] : reconstruction.points3D) {
            int r = std::clamp(static_cast<int>(pt.rgb.x * 255.0f), 0, 255);
            int g = std::clamp(static_cast<int>(pt.rgb.y * 255.0f), 0, 255);
            int b = std::clamp(static_cast<int>(pt.rgb.z * 255.0f), 0, 255);
            ptFile << pt.point3DId << " "
                   << pt.xyz.x << " " << pt.xyz.y << " " << pt.xyz.z << " "
                   << r << " " << g << " " << b << " "
                   << pt.error;
            for (const auto& trk : pt.track) {
                ptFile << " " << trk.imageId << " " << trk.point2DIdx;
            }
            ptFile << "\n";
        }
        ptFile.close();

        return true;
    }
};

// ============================================================================
// 6. Camera Frustum & Point Cloud Mesh Generators
// ============================================================================

class ColmapMeshBuilder {
public:
    /**
     * Build visual 3D frustum pyramids for all registered cameras in a reconstruction.
     * Frustums are sized proportionally and colored for high-contrast visibility.
     */
    static ScratchboxMesh buildCameraFrustums(
        const ColmapReconstruction& model,
        float frustumScale = 0.35f,
        const Vec4& frustumColor = Vec4(0.2f, 0.7f, 1.0f, 0.85f)
    ) {
        ScratchboxMesh mesh;

        for (const auto& [id, img] : model.images) {
            auto camIt = model.cameras.find(img.cameraId);
            float fovX = 60.0f;
            float fovY = 45.0f;
            if (camIt != model.cameras.end()) {
                fovX = camIt->second.getFovXDegrees();
                fovY = camIt->second.getFovYDegrees();
            }

            float radX = fovX * 0.5f * math::DEG_TO_RAD;
            float radY = fovY * 0.5f * math::DEG_TO_RAD;

            float depth = frustumScale;
            float halfW = depth * std::tan(radX);
            float halfH = depth * std::tan(radY);

            // Apex at camera center
            Vec3 apex = img.getCameraCenter();

            // Transform local corners in camera space into world space
            // In OpenCV camera space: +X right, +Y down, +Z forward
            Mat3 R_c2w = img.getRotationMatrixC2W();

            Vec3 cTL_cam(-halfW, -halfH, depth);
            Vec3 cTR_cam( halfW, -halfH, depth);
            Vec3 cBR_cam( halfW,  halfH, depth);
            Vec3 cBL_cam(-halfW,  halfH, depth);

            Vec3 cTL = apex + R_c2w * cTL_cam;
            Vec3 cTR = apex + R_c2w * cTR_cam;
            Vec3 cBR = apex + R_c2w * cBR_cam;
            Vec3 cBL = apex + R_c2w * cBL_cam;

            // Generate 4 pyramid sides (triangles)
            addTriangle(mesh, apex, cTL, cTR, frustumColor);
            addTriangle(mesh, apex, cTR, cBR, frustumColor);
            addTriangle(mesh, apex, cBR, cBL, frustumColor);
            addTriangle(mesh, apex, cBL, cTL, frustumColor);

            // Base rect (2 triangles)
            Vec4 baseColor(frustumColor.x * 0.6f, frustumColor.y * 0.6f, frustumColor.z * 0.6f, frustumColor.w);
            addTriangle(mesh, cTL, cBR, cTR, baseColor);
            addTriangle(mesh, cTL, cBL, cBR, baseColor);
        }

        return mesh;
    }

    /**
     * Build a point cloud mesh from sparse 3D points.
     * Each point is generated as an optimized small diamond/octahedron splat.
     */
    static ScratchboxMesh buildPointCloudMesh(
        const ColmapReconstruction& model,
        float pointRadius = 0.015f
    ) {
        ScratchboxMesh mesh;
        mesh.vertices.reserve(model.points3D.size() * 6);
        mesh.indices.reserve(model.points3D.size() * 24);

        for (const auto& [id, pt] : model.points3D) {
            uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
            Vec3 p = pt.xyz;
            Vec4 c = pt.rgb;
            float r = pointRadius;

            // 6 vertices of octahedron
            Vertex vTop{p + Vec3(0, r, 0), Vec3(0, 1, 0), Vec2(0.5f, 1.0f), c};
            Vertex vBtm{p - Vec3(0, r, 0), Vec3(0, -1, 0), Vec2(0.5f, 0.0f), c};
            Vertex vR{p + Vec3(r, 0, 0), Vec3(1, 0, 0), Vec2(1.0f, 0.5f), c};
            Vertex vL{p - Vec3(r, 0, 0), Vec3(-1, 0, 0), Vec2(0.0f, 0.5f), c};
            Vertex vF{p + Vec3(0, 0, r), Vec3(0, 0, 1), Vec2(0.5f, 0.5f), c};
            Vertex vB{p - Vec3(0, 0, -r), Vec3(0, 0, -1), Vec2(0.5f, 0.5f), c};

            mesh.vertices.push_back(vTop); // 0
            mesh.vertices.push_back(vBtm); // 1
            mesh.vertices.push_back(vR);   // 2
            mesh.vertices.push_back(vL);   // 3
            mesh.vertices.push_back(vF);   // 4
            mesh.vertices.push_back(vB);   // 5

            // 8 triangular faces
            // Top pyramid
            mesh.indices.push_back(base + 0); mesh.indices.push_back(base + 4); mesh.indices.push_back(base + 2);
            mesh.indices.push_back(base + 0); mesh.indices.push_back(base + 2); mesh.indices.push_back(base + 5);
            mesh.indices.push_back(base + 0); mesh.indices.push_back(base + 5); mesh.indices.push_back(base + 3);
            mesh.indices.push_back(base + 0); mesh.indices.push_back(base + 3); mesh.indices.push_back(base + 4);

            // Bottom pyramid
            mesh.indices.push_back(base + 1); mesh.indices.push_back(base + 2); mesh.indices.push_back(base + 4);
            mesh.indices.push_back(base + 1); mesh.indices.push_back(base + 5); mesh.indices.push_back(base + 2);
            mesh.indices.push_back(base + 1); mesh.indices.push_back(base + 3); mesh.indices.push_back(base + 5);
            mesh.indices.push_back(base + 1); mesh.indices.push_back(base + 4); mesh.indices.push_back(base + 3);
        }

        return mesh;
    }

    /**
     * Merge camera frustums and point cloud into a single unified ScratchboxMesh.
     */
    static ScratchboxMesh buildUnifiedReconstructionMesh(
        const ColmapReconstruction& model,
        float frustumScale = 0.35f,
        float pointRadius = 0.015f
    ) {
        ScratchboxMesh frustumMesh = buildCameraFrustums(model, frustumScale);
        ScratchboxMesh pointMesh = buildPointCloudMesh(model, pointRadius);

        ScratchboxMesh combined = frustumMesh;
        uint32_t baseIdx = static_cast<uint32_t>(combined.vertices.size());

        combined.vertices.insert(combined.vertices.end(), pointMesh.vertices.begin(), pointMesh.vertices.end());
        for (uint32_t idx : pointMesh.indices) {
            combined.indices.push_back(baseIdx + idx);
        }

        return combined;
    }

    /**
     * Direct binary glTF 2.0 (.glb) export of the reconstruction.
     */
    static std::vector<uint8_t> exportToGlb(
        const ColmapReconstruction& model,
        float frustumScale = 0.35f,
        float pointRadius = 0.015f
    ) {
        ScratchboxMesh mesh = buildUnifiedReconstructionMesh(model, frustumScale, pointRadius);
        return GlbWriter::writeGlb(mesh);
    }

private:
    static void addTriangle(ScratchboxMesh& mesh, const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec4& color) {
        Vec3 edge1 = p1 - p0;
        Vec3 edge2 = p2 - p0;
        Vec3 normal = edge1.cross(edge2).normalized();
        if (normal.length() < 1e-4f) normal = Vec3(0, 1, 0);

        uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
        mesh.vertices.push_back({p0, normal, Vec2(0, 0), color});
        mesh.vertices.push_back({p1, normal, Vec2(1, 0), color});
        mesh.vertices.push_back({p2, normal, Vec2(0.5f, 1.0f), color});

        mesh.indices.push_back(base);
        mesh.indices.push_back(base + 1);
        mesh.indices.push_back(base + 2);
    }
};

} // namespace colmap
} // namespace scratchbox

#endif // SCRATCHBOX_COLMAP_HPP
