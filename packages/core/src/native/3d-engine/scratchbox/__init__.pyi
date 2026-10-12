"""
Scratchbox Native C++20 3D Engine Python Bindings (powered by nanobind)
"""

from collections.abc import Sequence
import enum
from typing import overload

from scratchbox_native import (
    architecture as architecture,
    composer as composer,
    core as core,
    geometry as geometry,
    hair as hair,
    io as io,
    math as math,
    nature as nature,
    plant as plant,
    processing as processing,
    rig as rig,
    sdf as sdf,
    shaper as shaper,
    topology as topology
)


class RomanOrder(enum.Enum):
    Tuscan = 0

    Doric = 1

    Ionic = 2

    Corinthian = 3

    Composite = 4

    AtticPilaster = 5

def render_sensor_passes(mesh: geometry.Mesh, width: int = 512, height: int = 512, camera_position: math.Vec3 = ..., camera_target: math.Vec3 = ..., fov_degrees: float = 45.0, samples_per_pixel: int = 1, seed: int = 42) -> core.SensorPassesResult:
    """
    Render RGB beauty, metric linear depth, and surface normal validation passes
    """

@overload
def export_glb_bytes(mesh: geometry.Mesh) -> bytes:
    """
    Export ScratchboxMesh directly as a Python bytes object containing .glb data
    """

@overload
def export_glb_bytes(meshes: Sequence[geometry.Mesh]) -> bytes:
    """
    Export multiple ScratchboxMeshes directly as a Python bytes object containing .glb data
    """

Mesh = geometry.Mesh
PbrMaterial = geometry.PbrMaterial
Vec2 = math.Vec2
Vec3 = math.Vec3
Vec4 = math.Vec4
Quat = math.Quat
AABB = math.AABB

from .world import World as World

def create_box(*args, **kwargs) -> geometry.Mesh: ...
def create_cube(*args, **kwargs) -> geometry.Mesh: ...
def create_sphere(radius: float = 1.0, rings: int = 16, sectors: int = 32, color=None, material=None, **kwargs) -> geometry.Mesh: ...
def create_cylinder(radius_top: float = 1.0, radius_bottom: float = 1.0, height: float = 2.0, segments: int = 24, color=None, material=None, **kwargs) -> geometry.Mesh: ...
def create_cone(radius: float = 1.0, height: float = 2.0, segments: int = 24, color=None, material=None, **kwargs) -> geometry.Mesh: ...
def create_plane(width: float = 2.0, height: float = 2.0, seg_x: int = 4, seg_y: int = 4, color=None, material=None, **kwargs) -> geometry.Mesh: ...
def create_studio_pedestal(radius: float = 4.0, height: float = 0.25, bevel: float = 0.04, bevel_radius: float = None, segments: int = 64, **kwargs) -> geometry.Mesh: ...
def create_torus(main_radius: float = 1.0, tube_radius: float = 0.25, radial_segments: int = 24, tubular_segments: int = 36) -> geometry.Mesh: ...
def create_catenary_cable(p1: math.Vec3, p2: math.Vec3, sag: float = 0.5, radius: float = 0.02, segments: int = 32, radial_segments: int = 8, color=None) -> geometry.Mesh: ...
def create_beveled_box(*args, **kwargs) -> geometry.Mesh: ...
def create_subdivided_box(*args, **kwargs) -> geometry.Mesh: ...
def create_lathe(profile, segments: int = 32, total_angle_rad: float = None, color=None, material=None, **kwargs) -> geometry.Mesh: ...
def create_loft(slices, close_ends: bool = True, color=None, material=None, **kwargs) -> geometry.Mesh: ...

def write_glb(path: str, mesh: geometry.Mesh | Sequence[geometry.Mesh]) -> bool: ...
def export_glb(mesh: geometry.Mesh | Sequence[geometry.Mesh]) -> bytes: ...

