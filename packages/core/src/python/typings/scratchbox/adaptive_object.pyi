"""
Adaptive Domain Architecture (ADA) 3D Hero Object Procedural Engine.
Provides domain-agnostic, schema-driven procedural synthesis for any 3D entity:
- Zero closed taxonomies or noun-dictionary categorizations.
- 5 Universal Geometric Operators of Mechanical Fidelity:
  1. Panelized Compound-Curvature Lofts (with recessed shut lines & fastener pitch)
  2. Kinematic Actuator & Linkage Chains (dual-acting hydraulic rams & clevis pins)
  3. Protective Fluid/Debris Interfaces (directional louvers & intake strainers)
  4. Spline-Swept Umbilical & Conduit Harnesses (hoses with P-clamp brackets)
  5. Structural Spaceframe & Lightening Topology (beams with lightening pockets & gussets)
- Ephemeral in-memory generation streaming binary glTF 2.0 (.glb).
"""

import scratchbox_native.geometry
import typing

__all__ = ['Any', 'CLAY_BASE', 'CLAY_DARK', 'CLAY_LIGHT', 'Dict', 'List', 'Optional', 'Tuple', 'annotations', 'create_cambered_foil', 'create_hydraulic_actuator', 'create_intake_strainer', 'create_lofted_hull', 'create_louver_bay', 'create_panelized_loft', 'create_revolving_component', 'create_spline_conduit_harness', 'create_structural_truss_member', 'create_wheel', 'create_wheel_assembly', 'math', 'os', 'replicate_metric_array', 'revolve_harmonic_solid', 'sbg', 'sbio', 'sbm', 'superellipse_loop', 'superellipse_point', 'sweep_curve_profile', 'sys', 'validate_scene']

Any = typing.Any
CLAY_BASE: tuple
CLAY_DARK: tuple
CLAY_LIGHT: tuple
Dict = typing.Dict
List = typing.List
Optional = typing.Optional
Tuple = typing.Tuple
annotations: typing.Any

def create_cambered_foil(span: float = 1.8, chord: float = 0.45, camber: float = 0.04, thickness: float = 0.05, angle_of_attack_deg: float = -4.0, axis: str = 'x', endplates: bool = True, endplate_height: float = 0.25, endplate_thickness: float = 0.015, color: typing.Tuple[float, float, float, float] | None = None, material: typing.Any = None, **kwargs) -> scratchbox_native.geometry.Mesh:
    """
    Cambered Aerodynamic Foil / Wing Generator.
    Synthesizes downforce wings, airplane wings, hydrofoil rudders, or turbine blades
    with smooth NACA camber profiles and optional vertical endplates.
    """


def create_hydraulic_actuator(anchor_a: typing.Tuple[float, float, float], anchor_b: typing.Tuple[float, float, float], barrel_radius: float = 0.035, rod_radius: float = 0.02, rod_extension_ratio: float = 0.45, barrel_color: typing.Tuple[float, float, float, float] = (0.42, 0.44, 0.47, 1.0), rod_color: typing.Tuple[float, float, float, float] = (0.68, 0.7, 0.73, 1.0)) -> scratchbox_native.geometry.Mesh:
    """
    Operator 2: Universal dual-acting hydraulic / pneumatic ram assembly.
    Generates outer cylinder barrel, telescoping chrome rod, and clevis hinge knuckles.
    """


def create_intake_strainer(center: typing.Tuple[float, float, float], normal: typing.Tuple[float, float, float] = (0.0, 0.0, 1.0), radius: float = 0.24, ring_count: int = 3, spoke_count: int = 4, color: typing.Tuple[float, float, float, float] = (0.68, 0.7, 0.73, 1.0)) -> scratchbox_native.geometry.Mesh:
    """Operator 3: Concentric and radial debris strainer screen for fluid intake/exhaust."""


def create_lofted_hull(stations, profile: str = 'superellipse', m: float = 2.8, close_ends: bool = True, n_pts: int = 32, color: typing.Tuple[float, float, float, float] | None = None, material: typing.Any = None, **kwargs) -> scratchbox_native.geometry.Mesh:
    """
    Continuous Compound-Curvature Hull Generator (ADA Invariant 1 & 6).
    Synthesizes continuous streamlined bodies (monocoques, fuselages, hulls, organ bodies)
    by lofting 2D stations along a carrier axis.

    stations: list of dicts or tuples:
      - dict: {"z": float, "width": float, "height": float, "y": float, "m": float, "roll": float}
      - tuple: (z, width, height) or (z, y, width, height)
    """


def create_louver_bay(center: typing.Tuple[float, float, float], dimensions: typing.Tuple[float, float, float] = (0.35, 0.25, 0.08), blade_count: int = 6, blade_angle_deg: float = 35.0, color: typing.Tuple[float, float, float, float] = (0.55, 0.57, 0.6, 1.0)) -> scratchbox_native.geometry.Mesh:
    """Operator 3: Directional venting louver bay with perimeter bezel and angled vanes."""


def create_panelized_loft(stations: typing.List[typing.Dict[str, typing.Any]], n_pts_per_slice: int = 36, panel_seam_frequency: float = 2.0, fastener_pitch_meters: float = 0.15, color: typing.Tuple[float, float, float, float] = (0.55, 0.57, 0.6, 1.0)) -> scratchbox_native.geometry.Mesh:
    """
    Operator 1: Lofts continuous compound-curvature skin while generating
    parametric panel shut-line reveals and counterbored fastener circles.
    """


def create_revolving_component(radius: float = 0.5, length: float = 1.0, axis='lateral', profile: str = 'cylinder', crown: float = 0.0, recess: float = 0.0, segments: int = 32, color: typing.Tuple[float, float, float, float] | None = None, material: typing.Any = None, **kwargs) -> scratchbox_native.geometry.Mesh:
    """
    Universal Kinematic Revolving Component Operator (ADA Invariant 6).
    Synthesizes revolving solids (wheels, drums, rollers, pulleys, turbine rotors,
    actuator cylinders, gun barrels) aligned to their functional kinematic axis.

    axis:
      - 'x' / 'lateral' / 'transverse': Rotated into lateral axle orientation (wheels/rollers).
      - 'y' / 'vertical' / 'load': Vertical axis (columns, turntables).
      - 'z' / 'longitudinal' / 'thrust': Thrust/propulsion axis (turbines, jet engines, torpedoes).
      - tuple/list (dx, dy, dz): Arbitrary 3D orientation vector.
    """


def create_spline_conduit_harness(spline_pts: typing.List[typing.Tuple[float, float, float]], radius: float = 0.016, n_pts: int = 12, color: typing.Tuple[float, float, float, float] = (0.42, 0.44, 0.47, 1.0), p_clamp_spacing: float = 0.35) -> scratchbox_native.geometry.Mesh:
    """
    Operator 4: Sweeps smooth flexible conduit/hydraulic lines along guide splines
    and generates mounting P-clamps/brackets at regular intervals.
    """


def create_structural_truss_member(pt_a: typing.Tuple[float, float, float], pt_b: typing.Tuple[float, float, float], thickness: typing.Tuple[float, float] = (0.05, 0.05), lightening_pocket_ratio: float = 0.35, has_gusset_plates: bool = True, color: typing.Tuple[float, float, float, float] = (0.55, 0.57, 0.6, 1.0)) -> scratchbox_native.geometry.Mesh:
    """
    Operator 5: Structural chassis beam with machined lightening pockets
    and reinforced triangular gusset plates.
    """


def create_wheel(radius: float = 0.35, width: float = 0.3, rim_radius: float | None = None, rim_recess: float = 0.04, tread_bevel: float = 0.025, axis: str = 'lateral', ground: bool = True, color: typing.Tuple[float, float, float, float] | None = None, material: typing.Any = None, **kwargs) -> scratchbox_native.geometry.Mesh:
    """
    Universal Rolling Wheel / Tire Operator.
    Synthesizes an authentic multi-element wheel:
      - Outer rubber tire with beveled shoulder crowns and contact patch
      - Inset recessed wheel rim with center hub cap
      - Brake rotor disc
    Pre-oriented with lateral rolling axis along X (R_z(90)) and seated on the ground (y_min = 0).
    """


def create_wheel_assembly(track_width: float = 1.6, wheelbase: float = 3.2, wheel_radius: float = 0.35, tire_width: float = 0.3, ground_clearance: float = 0.05, axle_pairs: int = 2, camber_deg: float = 0.0, toe_deg: float = 0.0, suspension: str = 'double_wishbone', color: typing.Tuple[float, float, float, float] | None = None, material: typing.Any = None, **kwargs) -> scratchbox_native.geometry.Mesh:
    """
    Universal Ground Vehicle Wheel & Suspension Assembly.
    Spawns N axle pairs of upright, grounded rolling wheels spaced at track_width and wheelbase,
    with double-wishbone suspension linkages connecting to inner chassis pick-up points.
    """

import math
import os

def replicate_metric_array(distribution_mode: str = 'CURVE_1D', guide_points: typing.List[typing.Tuple[float, float, float]] | None = None, pitch_meters: float = 0.1, seed_geometry: typing.Any = None, color: typing.Tuple[float, float, float, float] = (0.55, 0.57, 0.6, 1.0)) -> 'scratchbox_native.geometry.Mesh':
    """
    Operator 3: Affine Metric Replicator (Pillar 11).
    Copies seed_geometry, any mesh built around the origin, to points at metric pitch p:
      CURVE_1D    along the polyline guide_points
      POLAR_RING  round the ring given as guide_points = [centre, axis normal, a point on the ring]
    The seed is arbitrary geometry (a fastener, vane, tooth or anything else), so no shape is named here.
    color is kept for call compatibility; copies keep the seed's own material.
    """


def revolve_harmonic_solid(anchor_point: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0), axis: typing.Tuple[float, float, float] = (0.0, 1.0, 0.0), profile_curve: typing.List[typing.Tuple[float, float]] | None = None, harmonic_lobe_count: int = 0, harmonic_depth_ratio: float = 0.2, helix_pitch_meters: float = 0.0, color: typing.Tuple[float, float, float, float] = (0.55, 0.57, 0.6, 1.0)) -> 'scratchbox_native.geometry.Mesh':
    """
    Operator 2: Harmonic Solid of Revolution (Pillar 11).
    Revolves a 2D meridian curve r(z) around a 3D axis with continuous radial harmonic lobes
    and helical twist.
    Generates smooth flanges, nozzles, lenses, fluted drills, spiral augers, cooling fins, and cogwheels.
    """

import scratchbox_native.geometry as sbg
import scratchbox_native.io as sbio
import scratchbox_native.math as sbm

def superellipse_loop(z: float, cx: float, cy: float, rx: float, ry: float, m: float = 2.4, n_pts: int = 24, roll_deg: float = 0.0) -> typing.List[typing.Any]:
    """Generates a closed 3D polygonal loop of a super-ellipse at coordinate z."""


def superellipse_point(cx: float, cy: float, rx: float, ry: float, theta: float, m: float = 2.4) -> typing.Tuple[float, float]:
    """Evaluates a 2D super-ellipse at parameter angle theta."""


def sweep_curve_profile(path: typing.List[typing.Tuple[float, float, float]], profile: str = 'CIRCULAR', profile_dimensions: typing.Tuple[float, float] = (0.04, 0.04), scale_taper: typing.Tuple[float, float] = (1.0, 1.0), twist_deg: float = 0.0, radial_modulation: typing.Dict[str, float] | None = None, color: typing.Tuple[float, float, float, float] = (0.55, 0.57, 0.6, 1.0)) -> 'scratchbox_native.geometry.Mesh':
    """
    Operator 1: SE(3) Lie Group Curve Sweep (Pillar 11).
    Sweeps a 2D cross-section P(u, v) along 3D carrier curve C(t) using Rotation-Minimizing Frames (RMF).
    Applies continuous scale taper, axial twist, and optional radial sinusoidal modulation.
    Generates limbs, claw prongs, hoses, struts, coils, tentacles, and truss members.
    """

import sys

def validate_scene(scene_or_mesh: typing.Any, auto_heal: bool = True) -> typing.Dict[str, typing.Any]:
    """
    In-Engine Kinematic & Geometric Invariant Validator.
    Audits:
      1. Wheel Orientation Invariant: Checks principal inertia axis of any ground-adjacent
         wheel/roller. If vertical (lying flat like a pancake), auto-rotates R_z(90) and grounds.
      2. Compound Curvature Invariant: Checks normal variance on primary hulls to flag
         primitive box stacking.
    """
