#!/usr/bin/env python3
"""
ADA Verification Test: Europa Cryovolcanic Hydrothermal Core Penetrator.
Tests synthesis of an entirely new speculative exploration probe
under the 4 Universal Differential Geometric Operators (Pillar 6 / Pillar 11)
and the 70-20-10 Geometric Form Hierarchy.
"""

import os
import sys
import scratchbox as sb
from scratchbox.adaptive_object import AdaptiveHeroObjectSynthesizer

def create_europa_penetrator_contract():
    return {
        "id": "europa_core_penetrator_mk1",
        "name": "EuropaCryovolcanicCorePenetrator",
        "boundingScaleMeters": [2.8, 2.2, 5.2],
        
        # --------------------------------------------------------------------
        # 1. 70% PRIMARY EDIFICE: Compound-Curvature Titanium Pressure Hull
        # --------------------------------------------------------------------
        "primaryHull": {
            "stations": [
                {"position": -2.20, "center": [0.0, 0.05], "radii": [0.38, 0.38], "superellipseExponent": 2.0},
                {"position": -1.60, "center": [0.0, 0.08], "radii": [0.78, 0.72], "superellipseExponent": 2.4},
                {"position": -0.80, "center": [0.0, 0.10], "radii": [1.08, 0.98], "superellipseExponent": 2.8},
                {"position":  0.00, "center": [0.0, 0.12], "radii": [1.22, 1.08], "superellipseExponent": 3.2},
                {"position":  0.80, "center": [0.0, 0.10], "radii": [1.12, 0.98], "superellipseExponent": 3.0},
                {"position":  1.40, "center": [0.0, 0.08], "radii": [0.88, 0.82], "superellipseExponent": 2.6},
                {"position":  1.80, "center": [0.0, 0.05], "radii": [0.62, 0.62], "superellipseExponent": 2.2},
                {"position":  2.10, "center": [0.0, 0.02], "radii": [0.44, 0.44], "superellipseExponent": 2.0},
                {"position":  2.25, "center": [0.0, 0.00], "radii": [0.30, 0.30], "superellipseExponent": 2.0},
            ],
            "symmetry": "BILATERAL_X",
            "bowCap": "SUPER_ELLIPTIC",
            "sternCap": "DIFFUSER"
        },
        
        # Lateral Thermal-Radiator Sponsons
        "secondaryHulls": [
            # Port thermal sponson
            {
                "id": "sponson_port",
                "stations": [
                    {"position": -0.90, "center": [-1.10, 0.10], "radii": [0.14, 0.22], "superellipseExponent": 2.4},
                    {"position":  0.00, "center": [-1.22, 0.12], "radii": [0.24, 0.35], "superellipseExponent": 2.8},
                    {"position":  0.90, "center": [-1.10, 0.10], "radii": [0.14, 0.22], "superellipseExponent": 2.4},
                ]
            },
            # Starboard thermal sponson
            {
                "id": "sponson_starboard",
                "stations": [
                    {"position": -0.90, "center": [1.10, 0.10], "radii": [0.14, 0.22], "superellipseExponent": 2.4},
                    {"position":  0.00, "center": [1.22, 0.12], "radii": [0.24, 0.35], "superellipseExponent": 2.8},
                    {"position":  0.90, "center": [1.10, 0.10], "radii": [0.14, 0.22], "superellipseExponent": 2.4},
                ]
            }
        ],

        # --------------------------------------------------------------------
        # 2. 20% SECONDARY ARTICULATED ASSEMBLIES: THE 4 UNIVERSAL OPERATORS
        # --------------------------------------------------------------------
        # Operator 1: SE(3) Lie Group Curve Sweeps (Articulated benthic anchor limbs)
        "curveSweeps": [
            # Fore-Port Anchor Limb
            {
                "id": "anchor_limb_fp",
                "path": [
                    [-0.70, 0.05, 1.30],
                    [-1.15, -0.20, 1.70],
                    [-1.45, -0.55, 2.10],
                    [-1.60, -0.90, 2.30]
                ],
                "profile": "BEVELED_RECT",
                "profileDimensions": [0.08, 0.06],
                "scaleTaper": [1.0, 0.35],
                "twistDeg": 35.0,
                "radialModulation": {"amplitude": 0.08, "frequency": 2.0}
            },
            # Fore-Starboard Anchor Limb
            {
                "id": "anchor_limb_fs",
                "path": [
                    [0.70, 0.05, 1.30],
                    [1.15, -0.20, 1.70],
                    [1.45, -0.55, 2.10],
                    [1.60, -0.90, 2.30]
                ],
                "profile": "BEVELED_RECT",
                "profileDimensions": [0.08, 0.06],
                "scaleTaper": [1.0, 0.35],
                "twistDeg": -35.0,
                "radialModulation": {"amplitude": 0.08, "frequency": 2.0}
            },
            # Aft-Port Anchor Limb
            {
                "id": "anchor_limb_ap",
                "path": [
                    [-0.75, 0.05, -0.90],
                    [-1.25, -0.25, -1.30],
                    [-1.50, -0.60, -1.70],
                    [-1.65, -0.95, -1.90]
                ],
                "profile": "BEVELED_RECT",
                "profileDimensions": [0.08, 0.06],
                "scaleTaper": [1.0, 0.35],
                "twistDeg": -25.0
            },
            # Aft-Starboard Anchor Limb
            {
                "id": "anchor_limb_as",
                "path": [
                    [0.75, 0.05, -0.90],
                    [1.25, -0.25, -1.30],
                    [1.50, -0.60, -1.70],
                    [1.65, -0.95, -1.90]
                ],
                "profile": "BEVELED_RECT",
                "profileDimensions": [0.08, 0.06],
                "scaleTaper": [1.0, 0.35],
                "twistDeg": 25.0
            },
            # High-Pressure Cryo Flexible Umbilicals
            {
                "id": "cryo_hose_port",
                "path": [
                    [-0.50, 0.70, 0.80],
                    [-0.85, 0.65, 1.30],
                    [-1.10, 0.35, 1.75],
                    [-1.40, -0.45, 2.05]
                ],
                "profile": "CIRCULAR",
                "profileDimensions": [0.035, 0.035],
                "radialModulation": {"amplitude": 0.15, "frequency": 12.0}
            },
            {
                "id": "cryo_hose_stbd",
                "path": [
                    [0.50, 0.70, 0.80],
                    [0.85, 0.65, 1.30],
                    [1.10, 0.35, 1.75],
                    [1.40, -0.45, 2.05]
                ],
                "profile": "CIRCULAR",
                "profileDimensions": [0.035, 0.035],
                "radialModulation": {"amplitude": 0.15, "frequency": 12.0}
            }
        ],

        # Operator 2: Harmonic Solids of Revolution
        "revolvedHarmonics": [
            # Forward Thermal-Mechanical Excavator Fluted Drill (K=4, helical pitch 0.35m)
            {
                "id": "thermal_excavator_fluted_nose",
                "anchorPoint": [0.0, 0.0, 2.25],
                "axis": [0.0, 0.0, 1.0],
                "profileCurve": [
                    [0.00, 0.28],
                    [0.15, 0.28],
                    [0.35, 0.22],
                    [0.55, 0.12],
                    [0.65, 0.00]
                ],
                "harmonicLobeCount": 4,
                "harmonicDepthRatio": 0.45,
                "helixPitchMeters": 0.35
            },
            # Midship Hydrothermal Cooling Turbine (K=26 radial heat-sink fins)
            {
                "id": "hydrothermal_cooling_turbine",
                "anchorPoint": [0.0, 0.12, 0.0],
                "axis": [0.0, 0.0, 1.0],
                "profileCurve": [
                    [-0.30, 1.15],
                    [-0.20, 1.32],
                    [ 0.20, 1.32],
                    [ 0.30, 1.15]
                ],
                "harmonicLobeCount": 26,
                "harmonicDepthRatio": 0.50
            },
            # Aft Magnetohydrodynamic Thruster Nozzle (K=0 smooth solid of revolution)
            {
                "id": "aft_mhd_thruster_nozzle",
                "anchorPoint": [0.0, 0.05, -2.20],
                "axis": [0.0, 0.0, -1.0],
                "profileCurve": [
                    [0.00, 0.38],
                    [0.12, 0.32],
                    [0.28, 0.42],
                    [0.35, 0.48]
                ],
                "harmonicLobeCount": 0
            },
            # Dorsal Multi-Spectral Lidar & Sonar Turret (K=0 smooth dome)
            {
                "id": "dorsal_sensor_turret",
                "anchorPoint": [0.0, 1.25, 0.60],
                "axis": [0.0, 1.0, 0.0],
                "profileCurve": [
                    [0.00, 0.25],
                    [0.10, 0.25],
                    [0.18, 0.18],
                    [0.22, 0.00]
                ],
                "harmonicLobeCount": 0
            },
            # Counter-Rotating Hydrodynamic Impeller (K=6)
            {
                "id": "stabilizer_impeller",
                "anchorPoint": [0.0, 0.05, -1.85],
                "axis": [0.0, 0.0, 1.0],
                "profileCurve": [
                    [0.00, 0.30],
                    [0.08, 0.65],
                    [0.16, 0.65],
                    [0.22, 0.30]
                ],
                "harmonicLobeCount": 6,
                "harmonicDepthRatio": 0.40,
                "helixPitchMeters": 0.45
            }
        ],

        # Operator 3: Affine Metric Replicators
        "metricReplications": [
            # Bow Collar Polar Fastener Ring
            {
                "id": "fastener_ring_bow",
                "distributionMode": "POLAR_RING",
                "guidePoints": [[0.0, 0.0, 2.10], [0.0, 0.0, 1.0]],
                "pitchMeters": 0.07,
                "seedGeometry": {
                    "shape": "CYLINDRICAL_FASTENER",
                    "dimensions": [0.015, 0.012, 0.006]
                }
            },
            # Midship Bulkhead Fastener Ring
            {
                "id": "fastener_ring_mid",
                "distributionMode": "POLAR_RING",
                "guidePoints": [[0.0, 0.12, 0.45], [0.0, 0.0, 1.0]],
                "pitchMeters": 0.08,
                "seedGeometry": {
                    "shape": "CYLINDRICAL_FASTENER",
                    "dimensions": [0.018, 0.014, 0.007]
                }
            },
            # Hydrothermal Sampling Louver Array - Port Flank
            {
                "id": "sampling_louvers_port",
                "distributionMode": "CURVE_1D",
                "guidePoints": [[-1.25, 0.25, -0.40], [-1.25, 0.25, 0.40]],
                "pitchMeters": 0.06,
                "seedGeometry": {
                    "shape": "ANGLED_LOUVER_VANE",
                    "dimensions": [0.04, 0.006, 0.22],
                    "tiltAngleDeg": 40.0
                }
            },
            # Hydrothermal Sampling Louver Array - Starboard Flank
            {
                "id": "sampling_louvers_stbd",
                "distributionMode": "CURVE_1D",
                "guidePoints": [[1.25, 0.25, -0.40], [1.25, 0.25, 0.40]],
                "pitchMeters": 0.06,
                "seedGeometry": {
                    "shape": "ANGLED_LOUVER_VANE",
                    "dimensions": [0.04, 0.006, 0.22],
                    "tiltAngleDeg": -40.0
                }
            },
            # Ice Anchor Gripper Carbide Teeth - Fore Port Pad
            {
                "id": "anchor_teeth_fp",
                "distributionMode": "CURVE_1D",
                "guidePoints": [[-1.55, -0.92, 2.15], [-1.65, -0.92, 2.45]],
                "pitchMeters": 0.04,
                "seedGeometry": {
                    "shape": "TRIANGULAR_TOOTH",
                    "dimensions": [0.018, 0.025, 0.018]
                }
            },
            # Ice Anchor Gripper Carbide Teeth - Fore Starboard Pad
            {
                "id": "anchor_teeth_fs",
                "distributionMode": "CURVE_1D",
                "guidePoints": [[1.55, -0.92, 2.15], [1.65, -0.92, 2.45]],
                "pitchMeters": 0.04,
                "seedGeometry": {
                    "shape": "TRIANGULAR_TOOTH",
                    "dimensions": [0.018, 0.025, 0.018]
                }
            }
        ],

        # Kinematic hydraulic links supporting anchor limbs
        "kinematics": [
            {
                "id": "ram_strut_fp",
                "anchorPoint": [-0.60, -0.10, 1.20],
                "endPoint": [-1.45, -0.55, 2.10],
                "crossSectionThickness": [0.05, 0.05],
                "driveType": "HYDRAULIC_RAM",
                "hasHydraulicRamPair": True,
                "lighteningPocketRatio": 0.35
            },
            {
                "id": "ram_strut_fs",
                "anchorPoint": [0.60, -0.10, 1.20],
                "endPoint": [1.45, -0.55, 2.10],
                "crossSectionThickness": [0.05, 0.05],
                "driveType": "HYDRAULIC_RAM",
                "hasHydraulicRamPair": True,
                "lighteningPocketRatio": 0.35
            },
            {
                "id": "ram_strut_ap",
                "anchorPoint": [-0.65, -0.10, -0.80],
                "endPoint": [-1.50, -0.60, -1.70],
                "crossSectionThickness": [0.05, 0.05],
                "driveType": "HYDRAULIC_RAM",
                "hasHydraulicRamPair": True,
                "lighteningPocketRatio": 0.35
            },
            {
                "id": "ram_strut_as",
                "anchorPoint": [0.65, -0.10, -0.80],
                "endPoint": [1.50, -0.60, -1.70],
                "crossSectionThickness": [0.05, 0.05],
                "driveType": "HYDRAULIC_RAM",
                "hasHydraulicRamPair": True,
                "lighteningPocketRatio": 0.35
            }
        ],

        # --------------------------------------------------------------------
        # 3. 10% TERTIARY MICRO-DETAIL: Normal Relief, Strainers, Louvers
        # --------------------------------------------------------------------
        "microDetail": {
            "panelSeamFrequency": 2.2,
            "fastenerPitchMeters": 0.14,
            "grooveDimensions": [0.012, 0.008],
            
            # Debris intake strainers
            "intakeScreens": [
                {"center": [-0.75, 0.85, 1.20], "normal": [0.0, 0.6, 0.8], "outerRadiusMeters": 0.18, "ringCount": 3, "spokeCount": 6},
                {"center": [ 0.75, 0.85, 1.20], "normal": [0.0, 0.6, 0.8], "outerRadiusMeters": 0.18, "ringCount": 3, "spokeCount": 6},
            ]
        }
    }

def main():
    print("=" * 80)
    print("EUROPA CRYOVOLCANIC CORE PENETRATOR - ADA PROCEDURAL SYNTHESIS")
    print("=" * 80)
    
    contract = create_europa_penetrator_contract()
    synthesizer = AdaptiveHeroObjectSynthesizer()
    out_glb = "build/europa_penetrator_clay.glb"
    
    print("Executing synthesis via the 4 Universal Differential Geometric Operators...")
    res = synthesizer.export_glb(contract, out_glb)
    
    print(f"Synthesis Successful!")
    print(f"  Asset:          {contract['name']}")
    print(f"  GLB Output:     {res['path']}")
    print(f"  Vertex Count:   {res['vertexCount']:,}")
    print(f"  Triangle Count: {res['triangleCount']:,}")
    print(f"  File Size:      {res['fileSizeKb']:.1f} KB")
    
    # Verify Geometric Complexity Floor
    assert res['vertexCount'] >= 5000, f"Vertex count {res['vertexCount']} below prop floor!"
    print(f"Complexity Gate: PASSED (Authentic 70-20-10 multi-part hierarchy)")

if __name__ == "__main__":
    main()
