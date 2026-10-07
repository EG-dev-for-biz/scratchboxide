#!/usr/bin/env python3
"""
Alien Planet Test for Adaptive Domain Architecture (ADA) Hero Object Engine.
Validates open-domain synthesis of an unprecedented entity:
'Titan Cryogenic Atmospheric Methane Harvester Drone'

Tests the 5 Universal Geometric Operators of Mechanical Fidelity:
1. Panelized Compound-Curvature Lofts (lifting body with shutlines & fastener pitch)
2. Kinematic Actuator & Linkage Chains (cryogenic booms with hydraulic rams & clevis pins)
3. Protective Fluid Interfaces (directional louvers & concentric debris strainers)
4. Spline-Swept Umbilical Harnesses (cryo conduits with P-clamp brackets)
5. Structural Spaceframe & Lightening Topology (trusses with lightening pockets & gussets)
"""

import os
import sys

import scratchbox as sb
from scratchbox.adaptive_object import AdaptiveHeroObjectSynthesizer

def test_alien_harvester():
    contract = {
        "id": "drone_titan_harvester_01",
        "name": "TitanAtmosphericMethaneHarvester",
        "boundingScaleMeters": [3.4, 1.8, 4.2],
        
        # 70% Primary Edifice: Continuous lifting-body hull
        "primaryHull": {
            "stations": [
                {"z":  2.10, "center": [0.0, 0.85], "radii": [0.25, 0.14], "superellipseExponent": 2.2},
                {"z":  1.60, "center": [0.0, 0.95], "radii": [0.65, 0.28], "superellipseExponent": 2.5},
                {"z":  0.90, "center": [0.0, 1.05], "radii": [0.95, 0.38], "superellipseExponent": 2.8},
                {"z":  0.00, "center": [0.0, 1.10], "radii": [1.10, 0.42], "superellipseExponent": 3.0},
                {"z": -0.90, "center": [0.0, 1.05], "radii": [0.90, 0.35], "superellipseExponent": 2.6},
                {"z": -1.70, "center": [0.0, 0.95], "radii": [0.55, 0.22], "superellipseExponent": 2.2},
                {"z": -2.20, "center": [0.0, 0.90], "radii": [0.18, 0.10], "superellipseExponent": 2.0},
            ],
            "symmetry": "BILATERAL_X",
            "bowCap": "CONICAL",
            "sternCap": "DIFFUSER"
        },
        
        # Secondary Cowls: Dual lateral ram-intake sponsons
        "secondaryHulls": [
            {
                "stations": [
                    {"z":  1.20, "center": [-1.15, 0.95], "radii": [0.22, 0.18], "superellipseExponent": 2.0},
                    {"z":  0.40, "center": [-1.25, 0.95], "radii": [0.32, 0.24], "superellipseExponent": 2.4},
                    {"z": -0.60, "center": [-1.20, 0.95], "radii": [0.28, 0.20], "superellipseExponent": 2.4},
                    {"z": -1.30, "center": [-1.10, 0.95], "radii": [0.16, 0.12], "superellipseExponent": 2.0},
                ]
            },
            {
                "stations": [
                    {"z":  1.20, "center": [1.15, 0.95], "radii": [0.22, 0.18], "superellipseExponent": 2.0},
                    {"z":  0.40, "center": [1.25, 0.95], "radii": [0.32, 0.24], "superellipseExponent": 2.4},
                    {"z": -0.60, "center": [1.20, 0.95], "radii": [0.28, 0.20], "superellipseExponent": 2.4},
                    {"z": -1.30, "center": [1.10, 0.95], "radii": [0.16, 0.12], "superellipseExponent": 2.0},
                ]
            }
        ],
        
        # 20% Secondary Articulated Assemblies: Cryogenic harvesting booms & landing skids
        "kinematics": [
            # Port forward collector boom
            {
                "id": "boom_port",
                "anchorPoint": [-0.60, 0.75, 1.40],
                "endPoint": [-1.10, 0.45, 2.30],
                "crossSectionThickness": [0.065, 0.065],
                "driveType": "HYDRAULIC_RAM",
                "hasHydraulicRamPair": True,
                "lighteningPocketRatio": 0.40
            },
            # Starboard forward collector boom
            {
                "id": "boom_starboard",
                "anchorPoint": [0.60, 0.75, 1.40],
                "endPoint": [1.10, 0.45, 2.30],
                "crossSectionThickness": [0.065, 0.065],
                "driveType": "HYDRAULIC_RAM",
                "hasHydraulicRamPair": True,
                "lighteningPocketRatio": 0.40
            }
        ],
        
        # Grounding interface: Benthic / surface landing skids
        "grounding": [
            {
                "id": "skid_assembly",
                "type": "RUNNER_SKID",
                "stanceWidthMeters": 1.70,
                "wheelbaseMeters": 2.60,
                "groundClearanceMeters": 0.16,
                "tubularRadiusMeters": 0.038
            }
        ],
        
        # 10% Tertiary Micro-Detail: Louver bays, intake strainers, cryo conduits, fasteners
        "microDetail": {
            "panelSeamFrequency": 2.5,
            "fastenerPitchMeters": 0.16,
            "grooveDimensions": [0.012, 0.008],
            
            # Louver bays along dorsal engine deck
            "louverBays": [
                {"center": [-0.35, 1.48, -0.70], "dimensions": [0.28, 0.22, 0.06], "bladeCount": 5, "angleDeg": 30.0},
                {"center": [ 0.35, 1.48, -0.70], "dimensions": [0.28, 0.22, 0.06], "bladeCount": 5, "angleDeg": 30.0},
            ],
            
            # Concentric debris strainers on ram intake mouths
            "intakeScreens": [
                {"center": [-1.15, 0.95, 1.25], "normal": [0.0, 0.0, 1.0], "outerRadiusMeters": 0.20, "ringCount": 3, "spokeCount": 4},
                {"center": [ 1.15, 0.95, 1.25], "normal": [0.0, 0.0, 1.0], "outerRadiusMeters": 0.20, "ringCount": 3, "spokeCount": 4},
            ],
            
            # Cryo conduit harnesses with P-clamps running from hull to collector heads
            "conduitGuideSplines": [
                {
                    "path": [
                        [-0.50, 0.85, 1.20],
                        [-0.75, 0.70, 1.65],
                        [-1.05, 0.48, 2.25]
                    ],
                    "radiusMeters": 0.016,
                    "pClampSpacingMeters": 0.35
                },
                {
                    "path": [
                        [0.50, 0.85, 1.20],
                        [0.75, 0.70, 1.65],
                        [1.05, 0.48, 2.25]
                    ],
                    "radiusMeters": 0.016,
                    "pClampSpacingMeters": 0.35
                }
            ]
        }
    }

    print("Synthesizing Alien Harvest Drone via AdaptiveHeroObjectSynthesizer...")
    synth = AdaptiveHeroObjectSynthesizer()
    out_glb = "build/alien_harvester_clay.glb"
    res = synth.export_glb(contract, out_glb)
    
    print(f"Synthesis Complete! Vertices: {res['vertexCount']:,}, Triangles: {res['triangleCount']:,}, Size: {res['fileSizeKb']:.1f} KB")
    return out_glb

if __name__ == "__main__":
    test_alien_harvester()
