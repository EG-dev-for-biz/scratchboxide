"""Scratchbox Native C++20 3D Engine Python Bindings (powered by nanobind)"""

import collections.abc
import enum
import scratchbox_native.core
import scratchbox_native.geometry
import scratchbox_native.math
import typing

__all__ = ['RomanOrder', 'architecture', 'composer', 'core', 'export_glb_bytes', 'geometry', 'hair', 'human', 'io', 'math', 'meshops', 'nature', 'processing', 'relief', 'render_sensor_passes', 'rig', 'scan_massing', 'sdf', 'shaper', 'surface', 'topology', 'vegetation', 'weathering']


class RomanOrder(enum.Enum):
    Tuscan = 0
    Doric = 1
    Ionic = 2
    Corinthian = 3
    Composite = 4
    AtticPilaster = 5

import scratchbox_native.architecture as architecture
import scratchbox_native.composer as composer
import scratchbox_native.core as core

@typing.overload
def export_glb_bytes(mesh: scratchbox_native.geometry.Mesh) -> bytes:
    """Export ScratchboxMesh directly as a Python bytes object containing .glb data"""

@typing.overload
def export_glb_bytes(meshes: collections.abc.Sequence[scratchbox_native.geometry.Mesh]) -> bytes:
    """Export multiple ScratchboxMeshes directly as a Python bytes object containing .glb data"""

import scratchbox_native.geometry as geometry
import scratchbox_native.hair as hair
import scratchbox_native.human as human
import scratchbox_native.io as io
import scratchbox_native.math as math
import scratchbox_native.meshops as meshops
import scratchbox_native.nature as nature
import scratchbox_native.processing as processing
import scratchbox_native.relief as relief

def render_sensor_passes(mesh: scratchbox_native.geometry.Mesh, width: int = 512, height: int = 512, camera_position: scratchbox_native.math.Vec3 = ..., camera_target: scratchbox_native.math.Vec3 = ..., fov_degrees: float = 45.0, samples_per_pixel: int = 1, seed: int = 42) -> scratchbox_native.core.SensorPassesResult:
    """Render RGB beauty, metric linear depth, and surface normal validation passes"""

import scratchbox_native.rig as rig
import scratchbox_native.scan_massing as scan_massing
import scratchbox_native.sdf as sdf
import scratchbox_native.shaper as shaper
import scratchbox_native.surface as surface
import scratchbox_native.topology as topology
import scratchbox_native.vegetation as vegetation
import scratchbox_native.weathering as weathering
