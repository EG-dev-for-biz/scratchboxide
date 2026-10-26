"""
Scratchbox Agentic 3D Procedural Engine (Python SDK)
Autonomous, headless, real-time procedural creation with cinematic DCC fidelity.
"""

import collections.abc
import scratchbox.human
import scratchbox.plant
import scratchbox.structure
import scratchbox.terrain
import scratchbox.world
import scratchbox_native
import scratchbox_native.architecture
import scratchbox_native.geometry
import scratchbox_native.human
import scratchbox_native.math
import scratchbox_native.nature
import typing

__all__ = ['Any', 'Armature', 'Dict', 'Flora', 'Human', 'List', 'Optional', 'PbrMaterial', 'PbrMaterialWrapper', 'PlantPreset', 'PoseBone', 'PrincipledBsdfMaterial', 'RomanOrder', 'Scene', 'ShapeKeyBlock', 'ShapeKeys', 'Structure', 'StudioHuman', 'Terrain', 'Tuple', 'Union', 'World', 'adaptive_object', 'architecture', 'composer', 'constants', 'core', 'create_arched_blister', 'create_beveled_box', 'create_box', 'create_building', 'create_building_parts', 'create_cambered_foil', 'create_catenary_cable', 'create_character', 'create_cone', 'create_cube', 'create_curved_building', 'create_cylinder', 'create_envelope', 'create_form', 'create_human', 'create_hydraulic_actuator', 'create_intake_strainer', 'create_ivy', 'create_lathe', 'create_loft', 'create_lofted_hull', 'create_louver_bay', 'create_panelized_loft', 'create_plane', 'create_revolving_component', 'create_sphere', 'create_spline_conduit_harness', 'create_structural_truss_member', 'create_studio_pedestal', 'create_subdivided_box', 'create_tower', 'create_tree', 'create_vegetation', 'create_wheel', 'create_wheel_assembly', 'export_glb', 'geometry', 'geospatial', 'hair', 'human', 'io', 'k', 'layout', 'math', 'moulding_profile', 'nature', 'object_spec', 'os', 'pbr', 'plant', 'processing', 'py_math', 'random', 'replicate_metric_array', 'revolve_harmonic_solid', 'rig', 'sdf', 'shaper', 'structure', 'superellipse_loop', 'superellipse_point', 'sweep_curve_profile', 'sys', 'terrain', 'topology', 'validate_scene', 'validation', 'world', 'write_glb', 'write_textured_building']

Any = typing.Any
Armature = scratchbox.human.Armature
Dict = typing.Dict
Flora = scratchbox.plant.PlantPreset
Human = scratchbox.human.Human
List = typing.List
Optional = typing.Optional

class PbrMaterial(metaclass=_PbrMeta):
    def __new__(cls, name: str = 'defaultMaterial', **kwargs) -> PbrMaterial: ...

    @staticmethod
    def asphalt_street() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def basalt_rock() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def base_color(self) -> scratchbox_native.math.Vec4: ...
    @base_color.setter
    def base_color(self, value: scratchbox_native.math.Vec4) -> None: ...

    @staticmethod
    def carbon_composite() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def chrome() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def clearcoat(self) -> float: ...
    @clearcoat.setter
    def clearcoat(self, value: float) -> None: ...

    @property
    def clearcoat_roughness(self) -> float: ...
    @clearcoat_roughness.setter
    def clearcoat_roughness(self, value: float) -> None: ...

    @property
    def color(self) -> scratchbox_native.math.Vec4: ...
    @color.setter
    def color(self, value: scratchbox_native.math.Vec4) -> None: ...

    @staticmethod
    def concrete_brutalist() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def copper_bullet() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def double_sided(self) -> bool: ...
    @double_sided.setter
    def double_sided(self, value: bool) -> None: ...

    @property
    def emissive(self) -> scratchbox_native.math.Vec3: ...
    @emissive.setter
    def emissive(self, value: scratchbox_native.math.Vec3) -> None: ...

    @staticmethod
    def emissive_glow(color: scratchbox_native.math.Vec3, intensity: float = 1.0) -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def emissive_intensity(self) -> float: ...
    @emissive_intensity.setter
    def emissive_intensity(self, value: float) -> None: ...

    @staticmethod
    def glass_tinted(color: scratchbox_native.math.Vec4 = ..., roughness: float = 0.08, ior: float = 1.52) -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def gold() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def ior(self) -> float: ...
    @ior.setter
    def ior(self, value: float) -> None: ...

    @staticmethod
    def metal_brushed_steel() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def metal_dark_anodized() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def metallic(self) -> float: ...
    @metallic.setter
    def metallic(self, value: float) -> None: ...

    @property
    def metalness(self) -> float: ...
    @metalness.setter
    def metalness(self, value: float) -> None: ...

    @property
    def name(self) -> str: ...
    @name.setter
    def name(self, value: str) -> None: ...

    @staticmethod
    def obsidian() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def optical_glass() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def plastic_shiny(color: scratchbox_native.math.Vec4 = ...) -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def plastic_smooth_black() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def polished_brass() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def quartz_crystal() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def rough_wood() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def roughness(self) -> float: ...
    @roughness.setter
    def roughness(self, value: float) -> None: ...

    def set_base_color(self, color) -> None: ...

    def set_color(self, color) -> None: ...

    @staticmethod
    def stone_limestone() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def stone_rough(color: scratchbox_native.math.Vec4 = ...) -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def thickness(self) -> float: ...
    @thickness.setter
    def thickness(self, value: float) -> None: ...

    @staticmethod
    def titanium() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def transmission(self) -> float: ...
    @transmission.setter
    def transmission(self, value: float) -> None: ...

    @staticmethod
    def wood_oak() -> scratchbox_native.geometry.PbrMaterial: ...


class PbrMaterialWrapper:
    def __new__(cls, name: str = 'defaultMaterial', **kwargs) -> PbrMaterial: ...

    @staticmethod
    def asphalt_street() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def basalt_rock() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def base_color(self) -> scratchbox_native.math.Vec4: ...
    @base_color.setter
    def base_color(self, value: scratchbox_native.math.Vec4) -> None: ...

    @staticmethod
    def carbon_composite() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def chrome() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def clearcoat(self) -> float: ...
    @clearcoat.setter
    def clearcoat(self, value: float) -> None: ...

    @property
    def clearcoat_roughness(self) -> float: ...
    @clearcoat_roughness.setter
    def clearcoat_roughness(self, value: float) -> None: ...

    @property
    def color(self) -> scratchbox_native.math.Vec4: ...
    @color.setter
    def color(self, value: scratchbox_native.math.Vec4) -> None: ...

    @staticmethod
    def concrete_brutalist() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def copper_bullet() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def double_sided(self) -> bool: ...
    @double_sided.setter
    def double_sided(self, value: bool) -> None: ...

    @property
    def emissive(self) -> scratchbox_native.math.Vec3: ...
    @emissive.setter
    def emissive(self, value: scratchbox_native.math.Vec3) -> None: ...

    @staticmethod
    def emissive_glow(color: scratchbox_native.math.Vec3, intensity: float = 1.0) -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def emissive_intensity(self) -> float: ...
    @emissive_intensity.setter
    def emissive_intensity(self, value: float) -> None: ...

    @staticmethod
    def glass_tinted(color: scratchbox_native.math.Vec4 = ..., roughness: float = 0.08, ior: float = 1.52) -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def gold() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def ior(self) -> float: ...
    @ior.setter
    def ior(self, value: float) -> None: ...

    @staticmethod
    def metal_brushed_steel() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def metal_dark_anodized() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def metallic(self) -> float: ...
    @metallic.setter
    def metallic(self, value: float) -> None: ...

    @property
    def metalness(self) -> float: ...
    @metalness.setter
    def metalness(self, value: float) -> None: ...

    @property
    def name(self) -> str: ...
    @name.setter
    def name(self, value: str) -> None: ...

    @staticmethod
    def obsidian() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def optical_glass() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def plastic_shiny(color: scratchbox_native.math.Vec4 = ...) -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def plastic_smooth_black() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def polished_brass() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def quartz_crystal() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def rough_wood() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def roughness(self) -> float: ...
    @roughness.setter
    def roughness(self, value: float) -> None: ...

    def set_base_color(self, color) -> None: ...

    def set_color(self, color) -> None: ...

    @staticmethod
    def stone_limestone() -> scratchbox_native.geometry.PbrMaterial: ...

    @staticmethod
    def stone_rough(color: scratchbox_native.math.Vec4 = ...) -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def thickness(self) -> float: ...
    @thickness.setter
    def thickness(self, value: float) -> None: ...

    @staticmethod
    def titanium() -> scratchbox_native.geometry.PbrMaterial: ...

    @property
    def transmission(self) -> float: ...
    @transmission.setter
    def transmission(self, value: float) -> None: ...

    @staticmethod
    def wood_oak() -> scratchbox_native.geometry.PbrMaterial: ...

PlantPreset = scratchbox.plant.PlantPreset
PoseBone = scratchbox.human.PoseBone
PrincipledBsdfMaterial = scratchbox.human.PrincipledBsdfMaterial
RomanOrder = scratchbox_native.RomanOrder
Scene = scratchbox.world.World
ShapeKeyBlock = scratchbox.human.ShapeKeyBlock
ShapeKeys = scratchbox.human.ShapeKeys
Structure = scratchbox.structure.Structure
StudioHuman = scratchbox.human.StudioHuman
Terrain = scratchbox.terrain.Terrain
Tuple = typing.Tuple
Union = typing.Union
World = scratchbox.world.World
import scratchbox.adaptive_object as adaptive_object
architecture: _ArchitectureModule
import scratchbox_native.composer as composer
constants: _ConstantsModule
import scratchbox_native.core as core

def create_arched_blister(bounds=(0.35, 0.45, 0.9), arch_radius=0.4, swell=0.08, side=1.0, grid=(16, 8), color=None, material=None, **kwargs) -> scratchbox_native.geometry.Mesh: ...


def create_beveled_box(size=(1.0, 1.0, 1.0), bevel=0.02, color=None, material=None, **kwargs) -> scratchbox_native.geometry.Mesh: ...


def create_box(*args, **kwargs) -> scratchbox_native.geometry.Mesh: ...


def create_building(width: float = 18.0, depth: float = 14.0, floors: int = 4, floor_height: float = 3.4, ground_floor_height: float = 4.2, plinth_height: float = 0.8, bay_width: float = 3.2, window_width: float = 1.8, window_height: float = 2.0, window_recess_depth: float = 0.25, roof: typing.Any = 'mansard', roof_height: float = 3.5, roof_overhang: float = 0.4, roof_pitch_degrees: float = 55.0, parapet_height: float = 0.8, curvature: float = 0.0, superellipse_exponent: float | None = None, twist_degrees: float = 0.0, taper: float = 1.0, bulge: float = 0.0, bay_count: int | None = None, bake_curvature_ao: bool = True, details: typing.Dict[str, typing.Any] | None = None, name: str = 'ProceduralBuilding', **kwargs) -> scratchbox_native.geometry.Mesh:
    """
    Constructs multi-story procedural architecture with rhythmic fenestration,
    recessed reveals, continuous compound curvature manifolds, and modeled roofs.
    """


def create_building_parts(width: float = 18.0, depth: float = 14.0, floors: int = 4, floor_height: float = 3.4, ground_floor_height: float = 4.2, plinth_height: float = 0.8, bay_width: float = 3.2, window_width: float = 1.8, window_height: float = 2.0, window_recess_depth: float = 0.25, roof: typing.Any = 'mansard', roof_height: float = 3.5, roof_overhang: float = 0.4, roof_pitch_degrees: float = 55.0, parapet_height: float = 0.8, curvature: float = 0.0, superellipse_exponent: float | None = None, twist_degrees: float = 0.0, taper: float = 1.0, bulge: float = 0.0, bay_count: int | None = None, bake_curvature_ao: bool = True, details: typing.Dict[str, typing.Any] | None = None, name: str = 'ProceduralBuilding', **kwargs) -> _BuildingParts:
    """
    The building create_building makes, as one mesh per material slot (<name>_wall, _glass,
    _frame, _roof, _foundation) with world-metre UVs, ready for write_textured_building.
    """


def create_cambered_foil(span: float = 1.8, chord: float = 0.45, camber: float = 0.04, thickness: float = 0.05, angle_of_attack_deg: float = -4.0, axis: str = 'x', endplates: bool = True, endplate_height: float = 0.25, endplate_thickness: float = 0.015, color: typing.Tuple[float, float, float, float] | None = None, material: typing.Any = None, **kwargs) -> scratchbox_native.geometry.Mesh:
    """
    Cambered Aerodynamic Foil / Wing Generator.
    Synthesizes downforce wings, airplane wings, hydrofoil rudders, or turbine blades
    with smooth NACA camber profiles and optional vertical endplates.
    """


def create_catenary_cable(start=(0, 0, 0), end=(10, 0, 0), sag=1.2, radius=0.03, segments=16, color=None, **kwargs) -> scratchbox_native.geometry.Mesh:
    """Constructs a catenary hanging curve cable between two 3D anchor points."""


def create_character(name: str = 'Human', height: float = 1.78, gender_beta: float = 0.0, position: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0), **kwargs) -> scratchbox.human.StudioHuman:
    """
    Primary DCC factory function for creating a high-fidelity Studio Human.
    Exposes armature.pose.bones, shape_keys, and biophysical principled_bsdf.
    """


def create_cone(radius=1.0, height=2.0, segments=24, color=None, material=None, **kwargs) -> scratchbox_native.geometry.Mesh: ...


def create_cube(*args, **kwargs) -> scratchbox_native.geometry.Mesh: ...


def create_curved_building(width: float = 18.0, depth: float = 18.0, floors: int = 6, curvature: float = 0.85, superellipse_exponent: float = 2.4, twist_degrees: float = 0.0, taper: float = 0.85, bulge: float = 0.12, roof: str = 'dome', roof_height: float = 4.0, bake_curvature_ao: bool = True, name: str = 'CurvedBuilding', **kwargs) -> scratchbox_native.geometry.Mesh:
    """
    Constructs a sculptural curved building using superelliptic floorplate lofts,
    continuous elevation scaling (taper/bulge), and automatic curvature-coupled AO.
    """


def create_cylinder(radius_top=1.0, radius_bottom=1.0, height=2.0, segments=24, color=None, material=None, capped=True, *, radius=None, **kwargs) -> scratchbox_native.geometry.Mesh: ...


def create_envelope(bounds=(1.0, 0.3, 1.5), crown=0.25, slope=0.3, center_dip=0.0, grid=(16, 16), color=None, material=None, **kwargs) -> scratchbox_native.geometry.Mesh: ...


def create_form(bounds=(1.0, 1.0, 1.0), curvature=0.0, bevel=0.02, axis_of_revolution=None, crown=0.25, slope=0.3, center_dip=0.0, color=None, material=None, **kwargs) -> scratchbox_native.geometry.Mesh:
    """Universal ADA Form Generator: Maps physical continuous parameters to the optimal 3D geometry engine."""


def create_human(role: str = 'scale_figure', height: float = 1.76, gender_beta: float = 0.0, pose: str = 'standing_survey', position: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0), facing_deg: float = 0.0, surface: typing.Any | None = None, surface_y_offset: float = 0.0, **kwargs) -> scratchbox.human.Human:
    """Factory function for synthesizing an architectural scale entourage human."""


def create_hydraulic_actuator(anchor_a: typing.Tuple[float, float, float], anchor_b: typing.Tuple[float, float, float], barrel_radius: float = 0.035, rod_radius: float = 0.02, rod_extension_ratio: float = 0.45, barrel_color: typing.Tuple[float, float, float, float] = (0.42, 0.44, 0.47, 1.0), rod_color: typing.Tuple[float, float, float, float] = (0.68, 0.7, 0.73, 1.0)) -> scratchbox_native.geometry.Mesh:
    """
    Operator 2: Universal dual-acting hydraulic / pneumatic ram assembly.
    Generates outer cylinder barrel, telescoping chrome rod, and clevis hinge knuckles.
    """


def create_intake_strainer(center: typing.Tuple[float, float, float], normal: typing.Tuple[float, float, float] = (0.0, 0.0, 1.0), radius: float = 0.24, ring_count: int = 3, spoke_count: int = 4, color: typing.Tuple[float, float, float, float] = (0.68, 0.7, 0.73, 1.0)) -> scratchbox_native.geometry.Mesh:
    """Operator 3: Concentric and radial debris strainer screen for fluid intake/exhaust."""


def create_ivy(root: typing.Any = (0.0, 0.0, 0.0), obstacle_min: typing.Any = (-4.0, 0.0, -4.0), obstacle_max: typing.Any = (4.0, 6.0, 4.0), max_steps: int = 60, cling_distance: float | None = None, material: typing.Any = None, name: str = 'IvyGrowth', **kwargs) -> scratchbox_native.geometry.Mesh:
    """Grows obstacle-clinging ivy vines from root across the obstacle AABB [obstacle_min, obstacle_max]."""


def create_lathe(profile, segments=32, total_angle_rad=None, color=None, material=None, **kwargs) -> scratchbox_native.geometry.Mesh: ...


def create_loft(slices, close_ends=True, color=None, material=None, **kwargs) -> scratchbox_native.geometry.Mesh: ...


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


def create_plane(width=2.0, height=2.0, depth=None, seg_x=4, seg_y=4, segments=None, width_segments=None, depth_segments=None, size=None, color=None, material=None, **kwargs) -> scratchbox_native.geometry.Mesh: ...


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


def create_sphere(radius=1.0, rings=16, sectors=32, color=None, segments=None, material=None, **kwargs) -> scratchbox_native.geometry.Mesh: ...


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


def create_studio_pedestal(radius=4.0, height=0.25, bevel=0.04, bevel_radius=None, segments=64, **kwargs) -> scratchbox_native.geometry.Mesh: ...


def create_subdivided_box(size=(1.0, 1.0, 1.0), subdivisions=4, color=None, material=None, **kwargs) -> scratchbox_native.geometry.Mesh: ...


def create_tower(width: float = 16.0, depth: float = 16.0, floors: int = 14, twist_degrees: float = 45.0, taper: float = 0.7, bulge: float = 0.08, superellipse_exponent: float = 2.6, roof: str = 'flat', bake_curvature_ao: bool = True, name: str = 'TwistingTower', **kwargs) -> scratchbox_native.geometry.Mesh:
    """
    Constructs a soaring parametric skyscraper tower with continuous helical twist,
    entasis taper, and surface-normal recessed fenestration bays.
    """


def create_tree(attractor_count: int = 120, crown_center: typing.Any = (0.0, 5.0, 0.0), crown_extents: typing.Any = (2.5, 3.5, 2.5), root_anchor: typing.Any = (0.0, 0.0, 0.0), perception_radius: float = 2.0, kill_radius: float = 0.5, branch_step_length: float = 0.25, clear_trunk_height: float = 1.5, base_radius: float = 0.25, tip_radius: float = 0.03, generate_leaves: bool = True, use_detailed_leaves: bool = True, leaf_density: float | None = None, season: float | None = None, material: typing.Any = None, name: str = 'SpaceColonizationTree', **kwargs) -> scratchbox_native.geometry.Mesh:
    """Synthesizes botanical trees and vegetation adhering to Runions space colonization."""


def create_vegetation(pos: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0), height: float = 12.0, attractor_count: int = 120, crown_radius: float = 3.0, branch_step_length: float = 0.25, clear_trunk_height: float = 2.0, base_radius: float = 0.25, tip_radius: float = 0.03, perception_radius: float = 2.0, kill_radius: float = 0.5, generate_leaves: bool = True, use_detailed_leaves: bool = True, leaf_density: float | None = None, name: str = 'AdaptiveVegetation', **kwargs) -> typing.Any:
    """
    Creates open-domain continuous botanical flora or extraterrestrial vegetation
    adhering to Runions space colonization and Da Vinci pipe conservation.
    Satisfies ADA Pillar 1 (The Alien Planet Test).
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


def export_glb(arg1, arg2=None) -> bytes: ...

import scratchbox_native.geometry as geometry
geospatial: _GeospatialModule
import scratchbox_native.hair as hair
human: _human_namespace
import scratchbox_native.io as io
k: str
layout: _LayoutModule
import scratchbox_native.math as math

def moulding_profile(height: float, projection: float, tiers: int = 3, curvature: float = 0.6, invert: bool = False, samples: int = 4) -> typing.List[typing.Tuple[float, float]]:
    """
    A closed (outward, up) moulding section in metres for FacadeDetails profiles, hanging below
    its anchor line (y from -height to 0). Each of `tiers` steps rises and projects further; the
    step faces bow by `curvature` (0 = square fillets, 1 = full quarter rounds). invert=True puts
    the largest projection at the bottom (bases, plinth caps). The wall side is embedded 2 cm.
    """

nature: _NatureModule
import scratchbox.object_spec as object_spec
import os
pbr: _PbrModule
import scratchbox_native.plant as plant
import scratchbox_native.processing as processing
import math as py_math
import random

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

import scratchbox_native.rig as rig
import scratchbox_native.sdf as sdf
import scratchbox_native.shaper as shaper
import scratchbox.structure as structure

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
import scratchbox.terrain as terrain
import scratchbox_native.topology as topology

def validate_scene(scene_or_mesh: typing.Any, auto_heal: bool = True) -> typing.Dict[str, typing.Any]:
    """
    In-Engine Kinematic & Geometric Invariant Validator.
    Audits:
      1. Wheel Orientation Invariant: Checks principal inertia axis of any ground-adjacent
         wheel/roller. If vertical (lying flat like a pancake), auto-rotates R_z(90) and grounds.
      2. Compound Curvature Invariant: Checks normal variance on primary hulls to flag
         primitive box stacking.
    """

validation: _ValidationModule
import scratchbox.world as world

def write_glb(arg1, arg2=None) -> bool:
    """Save a ScratchboxMesh directly to a standard binary glTF 2.0 (.glb) file"""


def write_textured_building(path: str, parts, surfaces: typing.Dict[str, typing.Any] | None = None, weathering: typing.Dict[str, typing.Any] | None = None, decals: typing.List[typing.Dict[str, typing.Any]] | None = None) -> typing.Dict[str, typing.Any]:
    """
    Write building parts to a GLB with real-scale PBR textures per part.

    surfaces maps a part slot ("wall", "roof", "foundation", "frame", "glass") to either
      {"coursed": {<CoursedSurfaceParams fields>}}            procedural, synthesized natively
      {"albedo": file, "normal": file?, "orm": file?,          image maps from a material library or
       "tile_m": (w, h), "tint": (r, g, b)?, "source": str}   an image model, laid at tile_m metres
    Optional per-part "roughness" / "metallic" set the material factors. Parts without an
    entry keep their flat slot material.

    weathering, when given, bakes marks from the built geometry (run-off streaks under ledges,
    rain exposure wash, shelter and cavity grime, rising damp, soot around the chimney tops) into
    a unique atlas on an alpha-blended overlay shell over the "receivers" parts (default wall,
    foundation, roof). Its keys are WeatheringParams fields plus "receivers"; strengths are
    continuous and 0 turns a layer off.

    decals places images on the building. Each is a dict with
      placement: "facade" ("south" = +Z entrance side, "north", "east", "west") with "u" metres
                 along it from its start corner and "v" metres above the ground, or "center" and
                 "normal" (and optional "up") in world metres;
      "size": (width_m, height_m); "image": a PNG/JPEG path or {"blot": {<BlotParams fields>}};
      "mode": "paint" (default: painted into the weathering atlas, follows the surface and ages
              under decal_aging; PNG only) or "panel" (its own quad standing "standoff_m" off the
              wall, with "thickness_m" for boards and plaques, full image resolution);
      optional "opacity", "depth_m" (paint projection depth) and "source" (provenance label).
    Returns {"path", "parts": {...}, "decals": [...]} so the caller can label provenance
    honestly; weathering and procedural marks are reported as generated.
    """


class _PbrMeta(type):
    def __getattr__(cls, name): ...


class _ArchitectureModule:
    RomanOrder = scratchbox_native.RomanOrder
    @staticmethod
    def create_building(width: float = 18.0, depth: float = 14.0, floors: int = 4, floor_height: float = 3.4, ground_floor_height: float = 4.2, plinth_height: float = 0.8, bay_width: float = 3.2, window_width: float = 1.8, window_height: float = 2.0, window_recess_depth: float = 0.25, roof: typing.Any = 'mansard', roof_height: float = 3.5, roof_overhang: float = 0.4, roof_pitch_degrees: float = 55.0, parapet_height: float = 0.8, curvature: float = 0.0, superellipse_exponent: float | None = None, twist_degrees: float = 0.0, taper: float = 1.0, bulge: float = 0.0, bay_count: int | None = None, bake_curvature_ao: bool = True, details: typing.Dict[str, typing.Any] | None = None, name: str = 'ProceduralBuilding', **kwargs) -> scratchbox_native.geometry.Mesh:
        """
        Constructs multi-story procedural architecture with rhythmic fenestration,
        recessed reveals, continuous compound curvature manifolds, and modeled roofs.
        """

    BuildingConfig = scratchbox_native.architecture.BuildingConfig
    RoofType = scratchbox_native.architecture.RoofType
    @staticmethod
    def generate_building(config: scratchbox_native.architecture.BuildingConfig, name: str = 'ProceduralBuilding') -> scratchbox_native.geometry.Mesh: ...

    @staticmethod
    def generate_peripteral_temple(archetype: str = 'roman_peripteral', order: scratchbox_native.RomanOrder = ..., footprint_length: float = 42.0, footprint_width: float = 24.0, column_count_x: int = 8, column_count_y: int = 14, column_height: float = 7.5, plinth_height: float = 1.4, seed: int = 1337) -> scratchbox_native.geometry.Mesh:
        """Construct an authentic Vitruvian classical temple with peripteral colonnade and gable roof"""

    def __setattr__(self, name: str, value: typing.Any, /) -> None: ...


class _ConstantsModule:
    @property
    def OUTPUT_GLB_PATH(self): ...

    def __setattr__(self, name: str, value: typing.Any, /) -> None: ...


class _GeospatialModule:
    @staticmethod
    def load_location(query: str | None = None):
        """
        Scripts are not staged on real places, so there is no place to load. A place comes from the
        google_3d_tiles_get_clay tool, and one object standing at a place from build_3d_object_from_reference.
        """

    def __setattr__(self, name: str, value: typing.Any, /) -> None: ...


class _LayoutModule:
    class BoundingVolume:
        def __init__(self, extents=(10.0, 10.0, 10.0), center=(0.0, 0.0, 0.0)) -> None: ...

        def get_socket(self, target: typing.Any) -> scratchbox_native.math.Vec3: ...

        def __setattr__(self, name: str, value: typing.Any, /) -> None: ...

        extents: typing.Any
        center: typing.Any

    @property
    def SpatialConstraintSolver(self): ...

    @staticmethod
    def resolve_constraints(meshes, relations, terrain=None, collision_passes=8):
        """
        Resolve a relational scene graph against named meshes.

        meshes:    dict mapping entity name -> ScratchboxMesh
        relations: list of dicts, e.g.
                   {"subject": "hvac", "predicate": "attached_to_surface",
                    "target": "roof", "face": "top", "clearance": "0.0"}
                   Use target "terrain" to raycast-ground onto the terrain mesh.
        terrain:   optional terrain ScratchboxMesh used for ground snapping.
        Returns a list of ContactAuditViolation (empty when fully certified).
        """

    def __setattr__(self, name: str, value: typing.Any, /) -> None: ...


class _NatureModule:
    PlantPreset = scratchbox.plant.PlantPreset
    Flora = scratchbox.plant.PlantPreset
    @staticmethod
    def create_tree(attractor_count: int = 120, crown_center: typing.Any = (0.0, 5.0, 0.0), crown_extents: typing.Any = (2.5, 3.5, 2.5), root_anchor: typing.Any = (0.0, 0.0, 0.0), perception_radius: float = 2.0, kill_radius: float = 0.5, branch_step_length: float = 0.25, clear_trunk_height: float = 1.5, base_radius: float = 0.25, tip_radius: float = 0.03, generate_leaves: bool = True, use_detailed_leaves: bool = True, leaf_density: float | None = None, season: float | None = None, material: typing.Any = None, name: str = 'SpaceColonizationTree', **kwargs) -> scratchbox_native.geometry.Mesh:
        """Synthesizes botanical trees and vegetation adhering to Runions space colonization."""

    @staticmethod
    def create_ivy(root: typing.Any = (0.0, 0.0, 0.0), obstacle_min: typing.Any = (-4.0, 0.0, -4.0), obstacle_max: typing.Any = (4.0, 6.0, 4.0), max_steps: int = 60, cling_distance: float | None = None, material: typing.Any = None, name: str = 'IvyGrowth', **kwargs) -> scratchbox_native.geometry.Mesh:
        """Grows obstacle-clinging ivy vines from root across the obstacle AABB [obstacle_min, obstacle_max]."""

    SpaceColonizationConfig = scratchbox_native.nature.SpaceColonizationConfig
    SpaceColonizationTree: None
    @staticmethod
    def generate_tree(config: scratchbox_native.nature.SpaceColonizationConfig) -> scratchbox_native.geometry.Mesh:
        """Generate a realistic botanical tree using Runions space colonization"""

    def __setattr__(self, name: str, value: typing.Any, /) -> None: ...


class _PbrModule:
    @property
    def PbrMaterial(self): ...

    @property
    def ProceduralMaterial(self): ...

    def __getattr__(self, name): ...

    def __setattr__(self, name: str, value: typing.Any, /) -> None: ...


class _ValidationModule:
    @staticmethod
    def validate_scene(scene_or_mesh: typing.Any, auto_heal: bool = True) -> typing.Dict[str, typing.Any]:
        """
        In-Engine Kinematic & Geometric Invariant Validator.
        Audits:
          1. Wheel Orientation Invariant: Checks principal inertia axis of any ground-adjacent
             wheel/roller. If vertical (lying flat like a pancake), auto-rotates R_z(90) and grounds.
          2. Compound Curvature Invariant: Checks normal variance on primary hulls to flag
             primitive box stacking.
        """

    def __setattr__(self, name: str, value: typing.Any, /) -> None: ...


class _human_namespace:
    """Unified facade exposing both high-level DCC human objects and native C++20 kinematics."""
    Any = typing.Any
    Armature = scratchbox.human.Armature
    CANONICAL_22_BONES: list
    FACS_52_ACTION_UNITS: list
    GenderMorph = scratchbox_native.human.GenderMorph
    Human = scratchbox.human.Human
    PoseBone = scratchbox.human.PoseBone
    PrincipledBsdfMaterial = scratchbox.human.PrincipledBsdfMaterial
    SbHumanModel = scratchbox_native.human.SbHumanModel
    ShapeKeyBlock = scratchbox.human.ShapeKeyBlock
    ShapeKeys = scratchbox.human.ShapeKeys
    Skeleton = scratchbox_native.human.Skeleton
    StudioHuman = scratchbox.human.StudioHuman
    Union = typing.Union
    @staticmethod
    def create(name: str = 'Human', height: float = 1.78, gender_beta: float = 0.0, position: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0), **kwargs) -> scratchbox.human.StudioHuman:
        """
        Primary DCC factory function for creating a high-fidelity Studio Human.
        Exposes armature.pose.bones, shape_keys, and biophysical principled_bsdf.
        """

    @staticmethod
    def create_grounded_character(gender_beta: float = 0.0, target_height: float = 1.76, position: scratchbox_native.math.Vec3 = ..., facing_angle_deg: float = 0.0, pose_archetype: str = 'standing_survey', role: str = 'scale_figure', surface_mesh: scratchbox_native.geometry.Mesh | None = None, surface_y_offset: float = 0.0) -> scratchbox_native.geometry.Mesh:
        """Procedurally synthesizes and grounds an architectural scale entourage figure conforming to the 18% Studio Grey Clay Invariant"""

    @staticmethod
    def create_human(role: str = 'scale_figure', height: float = 1.76, gender_beta: float = 0.0, pose: str = 'standing_survey', position: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0), facing_deg: float = 0.0, surface: typing.Any | None = None, surface_y_offset: float = 0.0, **kwargs) -> scratchbox.human.Human:
        """Factory function for synthesizing an architectural scale entourage human."""
