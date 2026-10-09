/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_ENGINE_HPP
#define SCRATCHBOX_ENGINE_HPP

/**
 * Scratchbox Astro 3D Engine Core SDK (C++20)
 *
 * Provides high-performance SIMD vector math, signed distance fields (SDF),
 * procedural noise (Perlin/Simplex/Worley), marching cubes isosurface meshing,
 * dynamic spline extrusions, Verlet physics, and zero-dependency binary glTF 2.0
 * (.glb) serialization and streaming.
 */

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_sdf.hpp"
#include "scratchbox_physics.hpp"
#include "scratchbox_shaper.hpp"
#include "scratchbox_particles.hpp"
#include "scratchbox_fire_simulation.hpp"
#include "scratchbox_pbr.hpp"
#include "scratchbox_scene_composer.hpp"
#include "scratchbox_triplanar.hpp"
#include "scratchbox_sss.hpp"
#include "scratchbox_volumetrics.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_halfedge.hpp"
#include "scratchbox_csg.hpp"
#include "scratchbox_uv_tangent.hpp"
#include "scratchbox_ibl.hpp"
#include "scratchbox_kinematics.hpp"
#include "scratchbox_skinning.hpp"
#include "scratchbox_parametric_human.hpp"
#include "scratchbox_4dgs_humanoid.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_lighting.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_ephemeris.hpp"
#include "scratchbox_geospatial.hpp"
#include "scratchbox_footprints.hpp"
#include "scratchbox_bvh.hpp"
#include "scratchbox_rigidbody.hpp"
#include "scratchbox_xpbd.hpp"
#include "scratchbox_lod.hpp"
#include "scratchbox_hair.hpp"
#include "scratchbox_fabric.hpp"
#include "scratchbox_fracture.hpp"
#include "scratchbox_headless_realism.hpp"
#include "scratchbox_pbr_texture_expert.hpp"
#include "scratchbox_pbr_50_library.hpp"
#include "scratchbox_pbr_manifold.hpp"
#include "scratchbox_tiles.hpp"
#include "scratchbox_photoreal_reconstruction.hpp"
#include "scratchbox_tile_cleanup.hpp"
#include "scratchbox_delight.hpp"
#include "scratchbox_material.hpp"
#include "scratchbox_botanical_pipeline.hpp"
#include "scratchbox_texture_inducer.hpp"
#include "scratchbox_nanite.hpp"
#include "scratchbox_lumen.hpp"
#include "scratchbox_substrate.hpp"
#include "scratchbox_tile_abstractor.hpp"
#include "scratchbox_architecture.hpp"
#include "scratchbox_utdra.hpp"
#include "scratchbox_field_remesh.hpp"
#include "scratchbox_camera_reprojector.hpp"
#include "scratchbox_colmap.hpp"
#include "scratchbox_spz.hpp"
#include "scratchbox_gaussian_opt.hpp"
#include "scratchbox_jpeg.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_sky.hpp"
#include "scratchbox_view_transform.hpp"
#include "scratchbox_denoise.hpp"
#include "scratchbox_pathtracer.hpp"
#include "scratchbox_visual_hull.hpp"
#include "scratchbox_atmosphere.hpp"
#include "scratchbox_lens_shader.hpp"
#include "scratchbox_sb_veggie.hpp"
#include "scratchbox_sb_veggie_optimizer.hpp"
#include "scratchbox_sb_archi.hpp"
#include "scratchbox_sb_archi_optimizer.hpp"
#include "scratchbox_tectonics.hpp"
#include "scratchbox_tectonic_analyzer.hpp"
#include "scratchbox_plant_builder.hpp"
#include "scratchbox_botanical_texture.hpp"
#include "scratchbox_infiniti.hpp"
#include "scratchbox_infinigen.hpp"
#include "scratchbox_tile_restructurer.hpp"
#include "scratchbox_displacement.hpp"
#include "scratchbox_processing.hpp"

namespace sb = scratchbox;
namespace disp = scratchbox::displacement;
namespace vhull = scratchbox::visual_hull;
namespace gopt = scratchbox::gaussian_opt;
namespace geo = scratchbox::geometry;
namespace shp = scratchbox::shaper;
namespace proc = scratchbox::processing;
namespace ptc = scratchbox::particles;
namespace pbr = scratchbox::pbr;
namespace scn = scratchbox::composer;
namespace trp = scratchbox::triplanar;
namespace sss = scratchbox::sss;
namespace vol = scratchbox::volumetrics;
namespace nat = scratchbox::nature;
namespace he = scratchbox::halfedge;
namespace uv = scratchbox::uv;
namespace ibl = scratchbox::ibl;
namespace kin = scratchbox::kinematics;
namespace skn = scratchbox::skinning;
namespace human = scratchbox::parametric;
namespace tex = scratchbox::texture;
namespace eph = scratchbox::ephemeris;
namespace gsp = scratchbox::geospatial;
namespace ftp = scratchbox::footprints;
namespace tls = scratchbox::tiles;
namespace bvh = scratchbox::bvh;
namespace rb = scratchbox::rigidbody;
namespace xpbd = scratchbox::xpbd;
namespace lod = scratchbox::lod;
namespace hair = scratchbox::hair;
namespace fabric = scratchbox::fabric;
namespace lgt = scratchbox::lighting;
namespace frc = scratchbox::fracture;
namespace rls = scratchbox::realism;
namespace pbr_tex = scratchbox::pbr_texture;
namespace rcn = scratchbox::reconstruction;
namespace cln = scratchbox::cleanup;
namespace ind = scratchbox::inducer;
namespace nnt = scratchbox::nanite;
namespace lmn = scratchbox::lumen;
namespace sub = scratchbox::substrate;
namespace abs_tile = scratchbox::abstractor;
namespace arc = scratchbox::architecture;
namespace utdra = scratchbox::utdra;
namespace qrm = scratchbox::remesh;
namespace rep = scratchbox::reprojector;
namespace clm = scratchbox::colmap;
namespace spz = scratchbox::spz;
namespace smpl = scratchbox::smpl_tree;
namespace veggie = scratchbox::sb_veggie;
namespace sb_veggie = scratchbox::sb_veggie;
namespace archi = scratchbox::sb_archi;
namespace sb_archi = scratchbox::sb_archi;
namespace tct = scratchbox::tectonics;
namespace tectonics = scratchbox::tectonics;
namespace pln = scratchbox::plant;
namespace plant = scratchbox::plant;
namespace inf = scratchbox::infiniti;
namespace infiniti = scratchbox::infiniti;
namespace infinigen = scratchbox::infiniti;
namespace pbr_man = scratchbox::pbr_manifold;

namespace scratchbox {
// Phase 3: Continuous Texture Coordinate Tiling & Triplanar Projection Direct Integration
using triplanar::projectContinuousTriplanarCoords;
using triplanar::sampleContinuousManifoldTriplanar;
using triplanar::applyContinuousTriplanarToMesh;
using triplanar::generateContinuousTriplanarUvs;
using triplanar::ContinuousTriplanarCoords;
using triplanar::ContinuousTriplanarConfig;
} // namespace scratchbox

using namespace scratchbox;

#endif // SCRATCHBOX_ENGINE_HPP


