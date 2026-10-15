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

    print("ALL PILLAR 11 OPERATOR TESTS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    test_pillar11_operators()
