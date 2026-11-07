"""
Scratchbox Agentic 3D Procedural Engine (Python SDK)
Autonomous, headless, real-time procedural creation with cinematic DCC fidelity.
"""

import collections.abc
import scratchbox.human
import scratchbox.structure
import scratchbox.terrain
import scratchbox.vegetation
import scratchbox.world
import scratchbox_native
import scratchbox_native.architecture
import scratchbox_native.geometry
import scratchbox_native.human
import scratchbox_native.math
import typing

__all__ = ['Any', 'Armature', 'Dict', 'Human', 'List', 'Optional', 'PbrMaterial', 'PbrMaterialWrapper', 'PoseBone', 'PrincipledBsdfMaterial', 'RomanOrder', 'SbVeggieTree', 'Scene', 'ShapeKeyBlock', 'ShapeKeys', 'Structure', 'StudioHuman', 'Terrain', 'Tuple', 'Union', 'World', 'adaptive_object', 'architecture', 'benchmark_massing', 'composer', 'constants', 'core', 'create_arched_blister', 'create_beveled_box', 'create_box', 'create_building', 'create_building_parts', 'create_cambered_foil', 'create_catenary_cable', 'create_character', 'create_cone', 'create_cube', 'create_curved_building', 'create_cylinder', 'create_envelope', 'create_form', 'create_human', 'create_hydraulic_actuator', 'create_intake_strainer', 'create_ivy', 'create_lathe', 'create_loft', 'create_lofted_hull', 'create_louver_bay', 'create_panelized_loft', 'create_plane', 'create_revolving_component', 'create_sphere', 'create_spline_conduit_harness', 'create_structural_truss_member', 'create_studio_pedestal', 'create_subdivided_box', 'create_tower', 'create_tree', 'create_vegetation', 'create_wheel', 'create_wheel_assembly', 'export_glb', 'geometry', 'geospatial', 'glb_read', 'hair', 'human', 'io', 'k', 'layout', 'library_surface', 'massing', 'massing_module', 'math', 'meshops', 'moulding_profile', 'nature', 'object_spec', 'os', 'pbr', 'processing', 'py_math', 'random', 'read_glb', 'relief', 'replicate_metric_array', 'revolve_harmonic_solid', 'rig', 'sdf', 'shaper', 'site', 'site_colors', 'site_crown', 'site_guides', 'site_lattice', 'site_part_colors', 'site_score', 'site_textures', 'site_tiers', 'stack_buildings', 'structure', 'superellipse_loop', 'superellipse_point', 'sweep_curve_profile', 'sys', 'terrain', 'topology', 'validate_scene', 'validation', 'vegetation', 'world', 'write_glb', 'write_textured_building']

Any = typing.Any
Armature = scratchbox.human.Armature
Dict = typing.Dict
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

    @property
    def extras_json(self) -> str: ...
    @extras_json.setter
    def extras_json(self, value: str) -> None: ...

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

    @property
    def extras_json(self) -> str: ...
    @extras_json.setter
    def extras_json(self, value: str) -> None: ...

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

PoseBone = scratchbox.human.PoseBone
PrincipledBsdfMaterial = scratchbox.human.PrincipledBsdfMaterial
RomanOrder = scratchbox_native.RomanOrder
SbVeggieTree = scratchbox.vegetation.SbVeggieTree
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

def benchmark_massing(plan: typing.Dict[str, typing.Any], benchmark: str, crown: typing.Dict[str, typing.Any] | None = None) -> typing.Dict[str, typing.Any]:
    """
    Scores a massing (sb.site_tiers' plan, and optionally sb.site_crown's result) against a building's documented form:
    a benchmark JSON (schema scratchbox.massing-benchmark/1, e.g. docs/benchmarks/<building>.json) giving documented
    setback floors, base footprint, roof and antenna heights with their sources, and the estimates used to turn floors
    into heights. Evaluation only: nothing here changes the plan.

    Returns {"setbacks": [{"floor", "expected_m", "nearest_m", "error_m", "found"}...], "found", "documented",
    "extra_levels": tier boundaries matching no documented setback, "mean_abs_error_m", "footprint": {"documented_m",
    "measured_m", "error_share"}, "heights": {...}, "tolerance_m", "notes"}.
    """

import scratchbox_native.composer as composer
constants: _ConstantsModule
import scratchbox_native.core as core

def create_arched_blister(bounds=(0.35, 0.45, 0.9), arch_radius=0.4, swell=0.08, side=1.0, grid=(16, 8), color=None, material=None, **kwargs) -> scratchbox_native.geometry.Mesh: ...


def create_beveled_box(size=(1.0, 1.0, 1.0), bevel=0.02, color=None, material=None, **kwargs) -> scratchbox_native.geometry.Mesh: ...


def create_box(*args, **kwargs) -> scratchbox_native.geometry.Mesh:
    """Centred box; faces named top (+Y), bottom (-Y) and side, and with name given also name.top..."""


def create_building(width: float = 18.0, depth: float = 14.0, floors: int = 4, floor_height: float = 3.4, ground_floor_height: float = 4.2, plinth_height: float = 0.8, bay_width: float = 3.2, window_width: float = 1.8, window_height: float = 2.0, window_recess_depth: float = 0.25, roof: typing.Any = 'mansard', roof_height: float = 3.5, roof_overhang: float = 0.4, roof_pitch_degrees: float = 55.0, parapet_height: float = 0.8, curvature: float = 0.0, superellipse_exponent: float | None = None, twist_degrees: float = 0.0, taper: float = 1.0, bulge: float = 0.0, bay_count: int | None = None, bake_curvature_ao: bool = True, details: typing.Dict[str, typing.Any] | None = None, floor_heights: typing.List[float] | None = None, centre_bay_scale: float = 1.0, end_bay_scale: float = 1.0, facade_rules: typing.List[typing.Dict[str, typing.Any]] | None = None, name: str = 'ProceduralBuilding', **kwargs) -> scratchbox_native.geometry.Mesh:
    """
    Constructs multi-story procedural architecture with rhythmic fenestration,
    recessed reveals, continuous compound curvature manifolds, and modeled roofs.
    """


def create_building_parts(width: float = 18.0, depth: float = 14.0, floors: int = 4, floor_height: float = 3.4, ground_floor_height: float = 4.2, plinth_height: float = 0.8, bay_width: float = 3.2, window_width: float = 1.8, window_height: float = 2.0, window_recess_depth: float = 0.25, roof: typing.Any = 'mansard', roof_height: float = 3.5, roof_overhang: float = 0.4, roof_pitch_degrees: float = 55.0, parapet_height: float = 0.8, curvature: float = 0.0, superellipse_exponent: float | None = None, twist_degrees: float = 0.0, taper: float = 1.0, bulge: float = 0.0, bay_count: int | None = None, bake_curvature_ao: bool = True, details: typing.Dict[str, typing.Any] | None = None, floor_heights: typing.List[float] | None = None, centre_bay_scale: float = 1.0, end_bay_scale: float = 1.0, facade_rules: typing.List[typing.Dict[str, typing.Any]] | None = None, footprint: typing.List[typing.Tuple[float, float]] | None = None, courtyards: typing.List[typing.List[typing.Tuple[float, float]]] | None = None, entrance_edge: int | None = None, entrance: bool = True, base_y: float = 0.0, offset: typing.Tuple[float, float] = (0.0, 0.0), name: str = 'ProceduralBuilding', **kwargs) -> _BuildingParts:
    """
    The building create_building makes, as one mesh per material slot (<name>_wall, _glass,
    _frame, _roof, _foundation, _trim) with world-metre UVs, ready for write_textured_building.
    foundation is the plinth alone; trim is the horizontal trim of every floor (sills, ledges, belt
    and string courses, cornices, floor-slab edges); roof includes the top deck, the terrace a tier
    above stands on when stacked.

    Both builders take the same layout controls:
      floor_heights: storey heights from the ground floor up (entries override the defaults);
      centre_bay_scale / end_bay_scale: width of the middle and outermost bays relative to the rest;
      windows_per_bay / window_gap: openings side by side in each bay (2 = a pair), window_width each, with
        window_gap metres of wall between them; a bay too narrow for them keeps one;
      facade_rules: dicts applied in order (later wins). Selectors: "floors" (n or (lo, hi), 0 =
        ground), "sides" ("south" = +Z entrance side, "north", "east", "west" or 0..3),
        "bay_stride"/"bay_offset", "centre_span" / "end_span" (bays within n of the middle / an
        end). Overrides: window_width_m, window_height_m, sill_height_m, opening (False = blank
        wall), sill, hood (False removes), sill_profile, hood_profile, hood_pitch_deg, balcony
        ("none", "bay", "continuous" along adjacent bays). The entrance bay keeps its door.

    base_y and offset (x, z) place the building: a tier of a set-back tower stands at the height of
    the tier below (see stack_buildings), a wing beside it at an offset.

    footprint [(x, z), ...] (x east, z south, metres) builds any plan outline instead of the width x
    depth rectangle, with courtyards as holes inside it: one facade per edge (facades "edge0", ... outer
    edges first, each with its compass "heading_deg"), quoins and corner pilasters on outside corners,
    plain returns at inside ones, edges too short for a window left blank. Points under 5 cm apart and
    bends under 10 degrees are merged. The entrance goes on the longest outer edge unless entrance_edge
    picks one; facade rule "sides" are edge indices. Outlines take roof="flat" for now.
    entrance=False gives no door at all: an upper tier of a set-back tower opens onto its terrace
    through windows, not a front door.
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


def create_cube(*args, **kwargs) -> scratchbox_native.geometry.Mesh:
    """Centred box; faces named top (+Y), bottom (-Y) and side, and with name given also name.top..."""


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


def create_tree(position: typing.Any = None, height: float | None = None, crown_radius: float | typing.Sequence[float] | None = None, crown_base_height: float | None = None, crown_widest_at: float = 0.5, crown_top_exponent: float = 2.0, trunk_radius: float | None = None, leaf_color: typing.Any = None, label: str | None = None, name: str | None = None, **kwargs) -> scratchbox.vegetation.SbVeggieTree:
    """
    One SB-Veggie tree described by measurements (metres): position = trunk base (x, y, z); height = base to crown top;
    crown_radius = crown half-spread (or (along x, along z)); crown_base_height = lowest crown above the base (None: from
    the species library by the crown's shape); crown_widest_at = share of the crown's depth where it is widest (0: a cone
    widest at its base, 0.5: a round crown, 0.8: an umbrella); crown_top_exponent = top profile (1 cone, 2 dome, 4 flat);
    trunk_radius (None: from the species); leaf_color = sRGB (r, g, b) / '#rrggbb' (chooses species and leaf textures);
    label = free text. Grown natively (space colonisation + SB-Veggie leaf clusters + levels of detail) when written.
    """


def create_vegetation(pos: typing.Any = (0.0, 0.0, 0.0), height: float = 12.0, crown_radius: float | typing.Sequence[float] = 3.0, clear_trunk_height: float | None = None, **kwargs) -> scratchbox.vegetation.SbVeggieTree:
    """Alias of create_tree with the older positional names (pos, height, crown_radius, clear_trunk_height = crown base)."""


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
import scratchbox.glb_read as glb_read
import scratchbox_native.hair as hair
human: _human_namespace
import scratchbox_native.io as io
k: str
layout: _LayoutModule

def library_surface(candidates, tile_m=None, target_color=None, target_roughness: float | None = None, max_size: int = 1024, confidence: float = 0.5, target_spread=None) -> typing.Dict[str, typing.Any]:
    """
    A write_textured_building surface from the texture library (photographed and scanned ambientCG and Poly Haven PBR
    sets), chosen by appearance and tinted to a measured colour. The sets must be fetched before the script runs: find
    them with texture_library_search and name them in execute_3d_python_script's librarySets. A name the library does
    not have is reported with the closest names it does.

    candidates: one set name or several; with target_color (sRGB 0..1, e.g. plan["colors"]["wall"]) and/or
    target_roughness (0 polished .. 1 matte) the set nearest in mean colour and roughness wins, and its maps are remapped
    to the targets (the colour in linear light), so the surface keeps the set's grain, veining and relief at the measured
    colour and finish. Library sets range from polished slabs to rough rock, so give target_roughness whenever the finish
    matters (a weathered stone facade is about 0.8). Without targets the first candidate is used as it is.
    tile_m: the real size (width, height) in metres one tile of the set covers. Leave it out to use the chosen set's
    real size from the library index (its publisher's measurement; "tile_m_source" says where it came from). Required,
    as the script's estimate, when the chosen set's size is unknown; a tile_m given is always reported as estimated.
    Maps are shrunk to at most max_size pixels a side and packed (albedo, OpenGL normal, ORM), cached beside the set.
    1024 is a millimetre or two per pixel on a building's metre-scale tiles; a whole building's surfaces at 2048 can
    outgrow what the viewport loads.

    The colour map is baked once per set to a neutral mean and the target colour is returned as the surface's "tint"
    (the base colour factor), so tiers tinted to different measured colours (sb.site_colors) share one image. The bake
    moves the map's CIELAB distribution, not one multiplier per channel: its mean goes to a neutral grey and its colour
    variation is kept, or scaled to target_spread (a measured CIELAB standard deviation [L, a, b] of the surface, e.g.
    from photo texels) when given; a negative component keeps the set's own spread in that channel. A greyscale set has no hue variation to keep, so on a coloured target it would give
    one flat hue: among candidates such a set ranks lower, and "lab_bake" says when it was used anyway.

    Returns the surfaces entry ({"albedo", "normal", "orm", "tint", "tile_m", "source", "provenance": "generated",
    "confidence"}) plus "library": {"chosen", "candidates": [{"name", "mean_srgb", "mean_roughness", "distance"}],
    "lab_bake", "color_factor", "target_srgb", "target_spread", "target_roughness", "roughness_remap", "missing", "tile_m_estimated", "tile_m_source",
    "indexed_tile_m"}. Raises with the closest set names when no candidate was fetched, and when tile_m is left out but
    the chosen set has no known real size.
    """

import scratchbox.massing as massing
import scratchbox.massing as massing_module
import scratchbox_native.math as math
import scratchbox_native.meshops as meshops

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
import scratchbox_native.processing as processing
import math as py_math
import random

def read_glb(path: str, max_triangles: int | None = None) -> list:
    """
    The meshes of the GLB at ``path``, in world space (see the module docstring). ``max_triangles`` stops reading once
    that many triangles are read (a very large scan), with the meshes read so far.
    """

import scratchbox_native.relief as relief

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

def site() -> typing.Dict[str, typing.Any]:
    """
    The measured massing of the real building passed as execute_3d_python_script's site: place, frame (x east,
    z south, metres from the place point, y up from the building's lowest point), "tiers" (each base_m, top_m,
    area_m2, plan "loops", provenance, source, confidence), "top_m" (the highest point the vector data reaches),
    "wall_direction_deg" and notes. Raises when the call gave no site.
    """


def site_colors(plan: typing.Dict[str, typing.Any], massing: typing.Dict[str, typing.Any] | None = None, spacing_m: float = 0.5, margin_m: float = 2.0, terrace_band_m: float = 3.0) -> typing.Dict[str, typing.Any]:
    """
    The real building's colours, tier by tier, read from the 3D tiles' photos (photo-inferred): targets for tinting
    surfaces (sb.library_surface(..., target_color=...), or a coursed surface's unit_color) per tier with per-part
    surfaces keys ("<name>T4_wall"). Needs sb.site_tiers' plan and a site with a scan.

    Per tier, from the photo samples on the building in its height band (sRGB 0..1):
      "wall"       the sunlit sides' lit colour (the photos bake sun and shade in: the brighter half of the sides);
      "wall_spread_lab" the sunlit sides' CIELAB standard deviation [L, a, b] (the photo's texture spread at tile
                   resolution: windows and joints raise it), for sb.library_surface(target_spread=...);
      "wall_shade" the shaded sides' (how far the photos' shade darkens it);
      "sides"      each side's lit colour (N, NE, ... NW of the outward normal);
      "glass"      the dark population of the walls (windows, and the shade between piers, at tile resolution);
      "terrace"    up-facing surfaces within terrace_band_m of the tier's top (its roof deck: a setback terrace
                   when a tier stands on it), or None, with its "terrace_spread_lab";
    and "crown": the same above the last tier. Every reading says how many samples it rests on. A texel can hold stone
    and window together, so these are readings of the photo, not of materials; the Street View facade colours
    (plan["colors"]) read the lower floors closer up. Returns {"tiers": [...], "crown", "provenance", "source", "method"}.
    """


def site_crown(massing: typing.Dict[str, typing.Any] | None = None, slot: str = 'wall', min_confidence: float = 0.0) -> typing.Dict[str, typing.Any]:
    """
    The crown of the site's building (whatever stands above its last full tier: spire, mast, lantern, drums, fins), fitted
    from the 3D tiles when execute_3d_python_script ran with siteFacade's sibling siteCrown=True. Each fitted piece is
    built as a closed mesh with flat faces (hard edges stay hard), in the same frame as sb.site_tiers (x east, z south,
    y above the street), ready for write_textured_building(extras=...).

    Returns {"extras": [{"mesh", "slot", "provenance", "confidence", "source"}...], "pieces": [{"id", "operator",
    "label", "provenance", "measured", "generated"}...], "silhouette": the fit's outline disagreement with the tiles
    (0 = identical), "matched", "from_m", "to_m", "notes"}. Raises when the site has no fitted crown.
    """


def site_guides(massing: typing.Dict[str, typing.Any] | None = None):
    """
    The real building's straightened facade photos from a 3D Building run of the same building (pipeline K): its finished
    model (rebuilt facades carrying the straightened, de-lit and harmonised photos) seen straight on at each facade, or
    K's rectified orthos when the model is not found; on their planes in sb.site_tiers' frame: (guides, info). guides is None when there are none, and
    info["reason"] says why (run the 3D Building for the place first). Used by sb.site_part_colors and, on its own, by
    write_textured_building's default weathering (the photos' residual against their own repeats is its stain).
    """


def site_lattice(plan: typing.Dict[str, typing.Any], massing: typing.Dict[str, typing.Any] | None = None, apply: bool = True, min_piers: int = 4, min_contrast: float = 1.3) -> typing.Dict[str, typing.Any]:
    """
    The real building's facade lattice per tier, read from its straightened facade photos (sb.site_guides): each photo's
    column profile split into light pier columns and dark infill (the windows and spandrels between them), giving the
    pier pitch and width and three colours: the pier stone, the infill and the glass (the darkest fifth of the infill).
    A tier takes the width-weighted median over the photos that cross its height and show a clear lattice (at least
    min_piers piers, light over dark at least min_contrast, piers narrower than 60% of the pitch); a tier no such photo
    crosses repeats the nearest one below or above (labelled so).

    Each tier's bay is also read from the same photos' median bay (sb.site_textures' cell): how many windows sit side by
    side in it (dark runs across its window rows), their width and the wall between them, and whether any band across
    the bay is light like the stone ("light_band", the brightest row against the pier).

    With apply (default) each of plan's tiers (sb.site_tiers) is changed in place to that lattice: bay_width = the
    pitch, a pilaster of the pier's width at every bay (details pilaster_width_m, pilaster_bay_stride 1), the windows
    the bay shows (windows_per_bay, window_width, window_gap), else window_width = the infill's width less 0.3 m. Where
    no band across the bay is light (light_band under 0.8), the photo shows no sills, ledges or belt courses there, so the
    tier gets none (sill off, belt_projection_m 0, sill_profile and string courses dropped) and the piers run unbroken.
    Colours are returned, not applied:
    {"trim": pier (the pilasters are trim), "wall": infill (the spandrels between windows are wall), "glass"}, sRGB.

    Returns {"tiers": [{"name", "pitch_m", "pier_width_m", "colors", "facades": ids, "provenance": "photo-inferred" or
    "generated", "note"}], "source"}. Raises with the reason when the site has no guides.
    """


def site_part_colors(parts, extras=None, massing: typing.Dict[str, typing.Any] | None = None, spacing_m: float = 0.25) -> typing.Dict[str, typing.Any]:
    """
    Every built part's colour read from the real building's straightened facade photos (sb.site_guides), after each
    photo is registered to the build: slid within half a bay and half a storey to where the build's glass lands on the
    photo's dark windows and its walls on the photo's light surfaces. A part's colour is the lit middle of the photo
    under it (40th-95th luminance percentile, linear mean), so a tier's wall, trim, frame and glass each get their own.

    parts: building parts (sb.stack_buildings / create_building_parts); extras: add-on dicts with "mesh" (optional).
    Returns {"parts": {name: {"color": sRGB, "samples", "provenance": "photo-inferred"} or {"color": None, "samples"}},
    "facades": [{"id", "shift_s", "shift_t", "score", "score_at_zero", ...}], "source"}. Raises with the reason when the
    site has no guides. A part the photos do not cover (a roof, a hidden face) gets None: tint it from sb.site_colors.
    """


def site_score(*built, massing: typing.Dict[str, typing.Any] | None = None, plan: typing.Dict[str, typing.Any] | None = None, min_coverage: float = 0.9, min_precision: float = 0.85, relief: float = 2.5, band_m: float = 10.0) -> typing.Dict[str, typing.Any]:
    """
    How well what the script built explains the real building: every mesh given (building parts, stacked tiers, crown
    or other add-on meshes, in sb.site_tiers' frame) is measured against the site's 3D-tiles scan with sb.massing's
    height-balanced coverage (share of the scan the build lies on, within `relief` metres: a cornice or a recessed window
    is detail, not missed shape) and precision (share of the build's visible surface the scan supports). It explains the
    scan when banded coverage >= min_coverage and banded precision >= min_precision (sb.massing.choose's thresholds).
    Both sides are compared by their outer shells (_outer_shell_interior): the build's floor slabs and the roofs hidden
    under the tier above, and the scan's inner surfaces (tile seams, nested detail levels, the walls of overlapping
    parts), are set aside and counted, since nothing outside can see them.
    Returns {"coverage", "precision", "f", "banded_coverage", "banded_precision", "banded_f", "worst_band_coverage",
    "explains", "thresholds", "scan", "build_interior_samples_set_aside", "scan_interior_samples_set_aside",
    "scan_shell_samples", "gaps"}. "gaps" says where the build and the scan disagree, band_m by band_m in height and by
    compass side (see _gap_report; with `plan`, split into inside and outside the tier's walls), worst places first.
    """


def site_textures(plan: typing.Dict[str, typing.Any], massing: typing.Dict[str, typing.Any] | None = None, px_per_m: float = 64.0, course_m: float = 0.6, head_m: float = 1.2, out_dir: str | None = None) -> typing.Dict[str, typing.Any]:
    """
    Each tier's own textures, made from the real building's straightened facade photos (sb.site_guides) instead of a
    library: within the tier's height, every pier is stacked storey by storey into one pier tile (the pier's width by one
    storey) and every bay's infill into one cell, and each pixel is the median over all those repeats, so the stone,
    spandrels and frames stay and one-off stains, reflections and smears drop out. The spandrel tile is the cell's band
    between windows; glass is the darkest fifth of its window rows. The photos are about 8 cm a pixel, so stone joints
    (courses course_m tall, blocks head_m long, half-bond) and a slight per-block tone are drawn on at px_per_m (generated).

    Returns {"surfaces": {f"{tier}_trim": pier tile (the pilasters are trim), f"{tier}_wall": spandrel tile (the wall
    between windows), f"{tier}_glass": flat colour}, "tiers": [{"name", "pier_width_m", "storey_m", "pitch_m",
    "spandrel_height_m", "samples", "facades", "provenance", "note"}], "source"}; pass surfaces into
    write_textured_building's surfaces (add the roof's yourself). Use with sb.site_lattice(plan) so the build's piers and
    bays have the photos' sizes. A tier no clear photo crosses takes the nearest tier's textures (labelled generated).
    Raises with the reason when the site has no guides.
    """


def site_tiers(massing: typing.Dict[str, typing.Any] | None = None, name: str = 'Site', floor_height: float = 3.7, ground_floor_height: float = 4.5, plinth_height: float = 0.6, min_tier_m: float = 2.4, spire_area_m2: float = 200.0, source: str = 'auto', scan_setback: float = 0.12, scan_window_m: float = 45.0, scan_outline_tol: float = 0.6, **common) -> typing.Dict[str, typing.Any]:
    """
    Turns measured massing (sb.site() by default) into create_building_parts arguments, one tier per level of the
    setback stack, sized to the measurement: each tier's outline is its measured plan, base_y its measured base, and
    its storeys fill exactly from base to measured top. Storey heights are not measured: the ground floor takes
    ground_floor_height and the rest floor_height (norms), all scaled together so they land on the measured top, and
    the report says so ("generated"). A tier thinner than min_tier_m joins the tier above; one under spire_area_m2
    (a mast or spire) is returned under "spires" for the script to build as an add-on, not as storeys. Every tier
    above the ground one gets entrance=False. **common (bay_width, window sizes, details, facade_rules, roof...) is
    passed to every tier.

    When the site was measured with siteFacade, its facade readings are applied per tier (the reading covering the
    tier's height; tiers above every reading repeat the highest one, labelled so): storey heights, bay width, window
    size, sill and recess, ground-floor openings, plinth, parapet, piers (as pilasters) and cornice (as a moulding).
    A read value replaces the same setting in **common, and the report lists each replacement; values a reading
    dropped (out of range, not fitting the measured tiers, failing the cross-check) are not used.

    source picks the setback stack: "auto" (default) takes Google's modeled volume when there is one, else the
    building's 3D-tiles scan read into tiers by sb.massing (labelled measured), else the vector extrusions; "modeled",
    "scan" or "vector" force one. plan["source"] says which was used. Scan tiers are read from the scan's fine levels: a
    scan loses parts of a slice (a wing, a notch's walls) far more often than it adds any, so a straight shaft's plan
    flickers while its largest extent holds. A new tier starts where the largest convex extent in the next scan_window_m
    metres falls more than scan_setback below the current tier's largest (or rises 30% above it); each tier takes its
    fullest slice's outline. Each outline is rebuilt square to the walls: filled on a 1 m
    grid turned to the walls' direction (the base's minimum-area enclosing rectangle), single-cell noise removed, and its
    edge traced back as straight wall runs; a plan that loses over a fifth of its area that way (curved, mostly
    diagonal) is instead simplified as read (Douglas-Peucker from scan_outline_tol metres) and checked not to cross.

    Returns {"tiers": [kwargs...], "spires": [...], "above_top_m": metres the vector top rises above the last tier
    (an antenna), "colors": the read wall / trim / glass colours (sRGB) with their provenance, or None,
    "report": [...]}; build with
        parts = sb.stack_buildings(*[sb.create_building_parts(**t) for t in plan["tiers"]]).
    """


def stack_buildings(*tiers) -> _BuildingParts:
    """
    Combine buildings made by create_building_parts (each with its own name, placed with base_y and
    offset) into one parts list for write_textured_building: set-back towers as tiers standing on each
    other, wings beside a block. Surfaces and weathering apply to every tier's parts by slot; soot
    sources are merged; facades are addressed as "<tier name>/south" etc., and the first tier's also
    as plain "south". The tier below a set-back usually takes roof="flat" (its parapet edges the
    terrace); only the top tier carries the pitched roof.
    """

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
import scratchbox.vegetation as vegetation
import scratchbox.world as world

def write_glb(arg1, arg2=None) -> bool:
    """Save a ScratchboxMesh directly to a standard binary glTF 2.0 (.glb) file"""


def write_textured_building(path: str, parts, surfaces: typing.Dict[str, typing.Any] | None = None, weathering: typing.Dict[str, typing.Any] | bool | None = None, decals: typing.List[typing.Dict[str, typing.Any]] | None = None, extras: typing.List[typing.Dict[str, typing.Any]] | None = None) -> typing.Dict[str, typing.Any]:
    """
    Write building parts to a GLB with real-scale PBR textures per part.

    surfaces maps a part slot ("wall", "roof", "foundation", "trim", "frame", "glass"), or one part's full
    name (a tier's "<name>T4_wall", which wins over its slot: per-tier colours from sb.site_colors), to either
      {"coursed": {<CoursedSurfaceParams fields>}}            procedural, synthesized natively
      {"albedo": file, "normal": file?, "orm": file?,          image maps from a material library or
       "tile_m": (w, h), "tint": (r, g, b)?, "source": str}   an image model, laid at tile_m metres
      {"color": (r, g, b), "source": str?}                       a flat colour (sRGB), no maps
    Optional per-part "roughness" / "metallic" set the material factors. Parts without an
    entry keep their flat slot material.

    weathering (on by default when the script has a site, i.e. the build stands for a real place; a
    dict sets it, False turns it off) bakes marks from the built geometry (run-off streaks under ledges,
    rain exposure wash, shelter and cavity grime, rising damp, soot around the chimney tops) into
    a unique atlas over the "receivers" parts (default wall, foundation, roof). With "mode":
    "layer" (the default) the receivers carry it on a second UV set and the viewer blends it over
    their own materials (SB_material_weathering), adding no geometry, so even a skyscraper fits;
    "overlay" adds an alpha-blended shell over them instead, which any glTF viewer shows (for export)
    but which doubles their triangles. When the script has a site with photo tiles the weathering is
    measured ("measured", default on): the photos' staining wider than a bay (run-off columns, grime
    under setbacks, damp) is read per height band and facing and painted where the photos cover the
    surface (photo-inferred); the procedural layers fill the rest, scaled per band to the measured mean
    (generated). "photo_bay_m" / "photo_storey_m" set the filter that averages away the window and floor
    rhythm. Its other keys are WeatheringParams fields plus "receivers";
    strengths are continuous and 0 turns a layer off.

    decals places images on the building. Each is a dict with
      placement: "facade" ("south" = +Z entrance side, "north", "east", "west") with "u" metres
                 along it from its start corner and "v" metres above the ground, or "center" and
                 "normal" (and optional "up") in world metres;
      "size": (width_m, height_m); "image": a PNG/JPEG path or {"blot": {<BlotParams fields>}};
      "mode": "paint" (default: painted into the weathering atlas, follows the surface and ages
              under decal_aging; PNG only) or "panel" (its own quad standing "standoff_m" off the
              wall, with "thickness_m" for boards and plaques, full image resolution);
      optional "opacity", "depth_m" (paint projection depth) and "source" (provenance label).

    extras attaches closed add-ons built with sb.sdf, sb.meshops or sb.relief (ornaments, dormer and
    chimney bodies, fluted pilasters) to the building. Each is a dict with "mesh" and "slot" (which
    surface it takes: "wall", "foundation", "trim", "roof", "frame", "glass", or a new slot name given its own
    surfaces entry), optional "color" (r, g, b) for an untextured slot, "provenance" (default
    "generated"), "confidence" (default 1.0), "source" (what made it) and "weather" (receives the
    weathering bake; default True up to 20,000 triangles, False above, since the bake's overlay copies
    every receiving triangle; every add-on blocks it either way). Each gets world-metre UVs, so tiled
    surfaces lie at the same scale as the building's; add-ons of one slot share one set of maps.
    Returns {"path", "parts": {...}, "decals": [...], "extras": [...]} so the caller can label
    provenance honestly; weathering and procedural marks are reported as generated.
    """


class _PbrMeta(type):
    def __getattr__(cls, name): ...


class _ArchitectureModule:
    RomanOrder = scratchbox_native.RomanOrder
    @staticmethod
    def create_building(width: float = 18.0, depth: float = 14.0, floors: int = 4, floor_height: float = 3.4, ground_floor_height: float = 4.2, plinth_height: float = 0.8, bay_width: float = 3.2, window_width: float = 1.8, window_height: float = 2.0, window_recess_depth: float = 0.25, roof: typing.Any = 'mansard', roof_height: float = 3.5, roof_overhang: float = 0.4, roof_pitch_degrees: float = 55.0, parapet_height: float = 0.8, curvature: float = 0.0, superellipse_exponent: float | None = None, twist_degrees: float = 0.0, taper: float = 1.0, bulge: float = 0.0, bay_count: int | None = None, bake_curvature_ao: bool = True, details: typing.Dict[str, typing.Any] | None = None, floor_heights: typing.List[float] | None = None, centre_bay_scale: float = 1.0, end_bay_scale: float = 1.0, facade_rules: typing.List[typing.Dict[str, typing.Any]] | None = None, name: str = 'ProceduralBuilding', **kwargs) -> scratchbox_native.geometry.Mesh:
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
    """Trees are SB-Veggie trees (sb.create_tree, sb.vegetation); ivy is grown on an obstacle box."""
    SbVeggieTree = scratchbox.vegetation.SbVeggieTree
    @staticmethod
    def create_tree(position: typing.Any = None, height: float | None = None, crown_radius: float | typing.Sequence[float] | None = None, crown_base_height: float | None = None, crown_widest_at: float = 0.5, crown_top_exponent: float = 2.0, trunk_radius: float | None = None, leaf_color: typing.Any = None, label: str | None = None, name: str | None = None, **kwargs) -> scratchbox.vegetation.SbVeggieTree:
        """
        One SB-Veggie tree described by measurements (metres): position = trunk base (x, y, z); height = base to crown top;
        crown_radius = crown half-spread (or (along x, along z)); crown_base_height = lowest crown above the base (None: from
        the species library by the crown's shape); crown_widest_at = share of the crown's depth where it is widest (0: a cone
        widest at its base, 0.5: a round crown, 0.8: an umbrella); crown_top_exponent = top profile (1 cone, 2 dome, 4 flat);
        trunk_radius (None: from the species); leaf_color = sRGB (r, g, b) / '#rrggbb' (chooses species and leaf textures);
        label = free text. Grown natively (space colonisation + SB-Veggie leaf clusters + levels of detail) when written.
        """

    @staticmethod
    def create_vegetation(pos: typing.Any = (0.0, 0.0, 0.0), height: float = 12.0, crown_radius: float | typing.Sequence[float] = 3.0, clear_trunk_height: float | None = None, **kwargs) -> scratchbox.vegetation.SbVeggieTree:
        """Alias of create_tree with the older positional names (pos, height, crown_radius, clear_trunk_height = crown base)."""

    @staticmethod
    def create_ivy(root: typing.Any = (0.0, 0.0, 0.0), obstacle_min: typing.Any = (-4.0, 0.0, -4.0), obstacle_max: typing.Any = (4.0, 6.0, 4.0), max_steps: int = 60, cling_distance: float | None = None, material: typing.Any = None, name: str = 'IvyGrowth', **kwargs) -> scratchbox_native.geometry.Mesh:
        """Grows obstacle-clinging ivy vines from root across the obstacle AABB [obstacle_min, obstacle_max]."""

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
