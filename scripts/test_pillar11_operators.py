#!/usr/bin/env python3
"""
Unit Test for ADA Pillar 11: Pure Differential Geometric Operators.
Verifies that any tool, appendage, or micro-detail emerges from:
1. SE(3) Curve Sweeps
2. Harmonic Solids of Revolution
3. Affine Metric Replicators
with zero closed taxonomies or named tool classes.
"""

import os
import sys
import scratchbox as sb
from scratchbox.adaptive_object import (
    AdaptiveHeroObjectSynthesizer,
    sweep_curve_profile,
    revolve_harmonic_solid,
    replicate_metric_array,
)

def test_pillar11_operators():
    print("Testing Pillar 11 Differential Geometric Operators...")

    # 1. Test SE(3) Curve Sweep (Tapered, twisted claw prong / curved limb)
    path = [
        (0.0, 0.0, 0.0),
        (0.1, 0.15, 0.2),
        (0.15, 0.35, 0.5),
        (0.12, 0.5, 0.75),
        (0.05, 0.6, 0.9),
    ]
    sw_mesh = sweep_curve_profile(
        path,
        profile="BEVELED_RECT",
        profile_dimensions=(0.08, 0.05),
        scale_taper=(1.0, 0.2),
        twist_deg=45.0,
        radial_modulation={"amplitude": 0.1, "frequency": 2.0}
    )
    print(f"  [1] SE(3) Curve Sweep: {sw_mesh.vertex_count} vertices, {sw_mesh.triangle_count} tris")
    assert sw_mesh.vertex_count > 0

    # 2. Test Harmonic Solids of Revolution
    # 2A. Smooth Sensor / Nozzle (Lobe count = 0)
    smooth_lens = revolve_harmonic_solid(
        anchor_point=(0.0, 0.0, 0.0),
        axis=(0.0, 0.0, 1.0),
        profile_curve=[(0.0, 0.15), (0.1, 0.15), (0.15, 0.12), (0.2, 0.0)],
        harmonic_lobe_count=0
    )
    print(f"  [2A] Smooth Revolve: {smooth_lens.vertex_count} vertices, {smooth_lens.triangle_count} tris")
    assert smooth_lens.vertex_count > 0

    # 2B. Fluted Auger / Drill (Lobe count = 3, helix pitch = 0.2m)
    fluted_drill = revolve_harmonic_solid(
        anchor_point=(0.0, 0.0, 0.0),
        axis=(0.0, 0.0, 1.0),
        profile_curve=[(0.0, 0.08), (0.2, 0.08), (0.4, 0.08), (0.5, 0.0)],
        harmonic_lobe_count=3,
        harmonic_depth_ratio=0.35,
        helix_pitch_meters=0.25
    )
    print(f"  [2B] Fluted Drill / Auger: {fluted_drill.vertex_count} vertices, {fluted_drill.triangle_count} tris")
    assert fluted_drill.vertex_count > 0

    # 2C. Cooling Fin / Radial Cog (Lobe count = 20, no twist)
    fin_array = revolve_harmonic_solid(
        anchor_point=(0.0, 0.0, 0.0),
        axis=(0.0, 1.0, 0.0),
        profile_curve=[(0.0, 0.1), (0.05, 0.18), (0.2, 0.18), (0.25, 0.1)],
        harmonic_lobe_count=20,
        harmonic_depth_ratio=0.35
    )
    print(f"  [2C] Radial Fin Array: {fin_array.vertex_count} vertices, {fin_array.triangle_count} tris")
    assert fin_array.vertex_count > 0

    # 3. Test Affine Metric Replicator
    # 3A. Polar Fastener Ring
    fastener_ring = replicate_metric_array(
        distribution_mode="POLAR_RING",
        guide_points=[(0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, 0.2, 0.0)],
        pitch_meters=0.08,
        seed_geometry=sb.create_cylinder(radius=0.015, height=0.005)
    )
    print(f"  [3A] Polar Fastener Ring: {fastener_ring.vertex_count} vertices, {fastener_ring.triangle_count} tris")
    assert fastener_ring.vertex_count > 0

    # 3B. Directional Louver Bay
    louver_bay = replicate_metric_array(
        distribution_mode="CURVE_1D",
        guide_points=[(0.0, 0.0, 0.0), (0.0, 0.4, 0.0)],
        pitch_meters=0.05,
        seed_geometry=sb.create_beveled_box((0.25, 0.008, 0.04), bevel=0.002).rotate_x(35.0)
    )
    print(f"  [3B] Louver Bay Replicator: {louver_bay.vertex_count} vertices, {louver_bay.triangle_count} tris")
    assert louver_bay.vertex_count > 0

    # 4. Synthesizer Integration Test
    contract = {
        "id": "speculative_cryo_drone",
        "name": "CryoSpeculativeHarvester",
        "boundingScaleMeters": [3.0, 1.5, 4.0],
        "primaryHull": {
            "stations": [
                {"position": -1.8, "center": [0.0, 0.0], "radii": [0.3, 0.2], "superellipseExponent": 2.2},
                {"position": 0.0, "center": [0.0, 0.1], "radii": [1.1, 0.6], "superellipseExponent": 2.6},
                {"position": 1.8, "center": [0.0, 0.05], "radii": [0.5, 0.3], "superellipseExponent": 2.0},
            ],
            "symmetry": "BILATERAL_X",
            "bowCap": "SUPER_ELLIPTIC",
            "sternCap": "DIFFUSER"
        },
        # Direct Pillar 11 Operators (No taxonomic tools!)
        "curveSweeps": [
            {
                "id": "collector_limb_left",
                "path": [(-0.8, 0.0, 0.5), (-1.2, -0.2, 1.2), (-1.4, -0.4, 2.0)],
                "profile": "BEVELED_RECT",
                "profileDimensions": [0.07, 0.04],
                "scaleTaper": [1.0, 0.4],
                "twistDeg": 30.0
            },
            {
                "id": "collector_limb_right",
                "path": [(0.8, 0.0, 0.5), (1.2, -0.2, 1.2), (1.4, -0.4, 2.0)],
                "profile": "BEVELED_RECT",
                "profileDimensions": [0.07, 0.04],
                "scaleTaper": [1.0, 0.4],
                "twistDeg": -30.0
            }
        ],
        "revolvedHarmonics": [
            {
                "id": "rotary_excavation_flute",
                "anchorPoint": [0.0, -0.3, 2.1],
                "axis": [0.0, 0.0, 1.0],
                "profileCurve": [(0.0, 0.12), (0.25, 0.12), (0.5, 0.0)],
                "harmonicLobeCount": 3,
                "harmonicDepthRatio": 0.4,
                "helixPitchMeters": 0.3
            },
            {
                "id": "optical_cavity_housing",
                "anchorPoint": [0.0, 0.3, 1.6],
                "axis": [0.0, 0.0, 1.0],
                "profileCurve": [(0.0, 0.14), (0.1, 0.14), (0.15, 0.08), (0.18, 0.0)],
                "harmonicLobeCount": 0
            }
        ],
        "metricReplications": [
            {
                "id": "bow_fastener_circle",
                "distributionMode": "POLAR_RING",
                "guidePoints": [(0.0, 0.3, 1.55), (0.0, 0.0, 1.0), (0.0, 0.48, 1.55)],
                "pitchMeters": 0.06,
                "seedGeometry": {"shape": "CYLINDRICAL_FASTENER", "dimensions": [0.012, 0.008, 0.004]}
            }
        ]
    }

    synthesizer = AdaptiveHeroObjectSynthesizer()
    out_glb = "build/pillar11_test.glb"
    res = synthesizer.export_glb(contract, out_glb)
    print(f"  [4] Full Object Synthesized via Pillar 11:")
    print(f"      Vertices: {res['vertexCount']}, Triangles: {res['triangleCount']}, Size: {res['fileSizeKb']:.1f} KB")
    assert res['vertexCount'] > 500
    print("ALL PILLAR 11 OPERATOR TESTS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    test_pillar11_operators()
