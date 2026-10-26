"""glTF 2.0 binary (.glb) packing and file serialization"""

import collections.abc
import scratchbox_native.geometry
import typing

__all__ = ['export_glb', 'export_glb_bytes', 'write_botanical_glb', 'write_glb', 'write_glb_textured']


def export_glb(arg1, arg2=None) -> bytes: ...


@typing.overload
def export_glb_bytes(mesh: scratchbox_native.geometry.Mesh) -> bytes:
    """Export ScratchboxMesh directly as a Python bytes object containing .glb data"""

@typing.overload
def export_glb_bytes(meshes: collections.abc.Sequence[scratchbox_native.geometry.Mesh]) -> bytes:
    """Export multiple ScratchboxMeshes directly as a Python bytes object containing .glb data"""


def write_botanical_glb(path: str, meshes: collections.abc.Sequence[scratchbox_native.geometry.Mesh], texture_res: int = 512, season: float = 1.0, seed: int = 42) -> bool:
    """Save botanical tree meshes to GLB embedding procedural Worley bark and botanical foliage PBR texture maps (Albedo, Normal, ORM)"""


def write_glb(arg1, arg2=None) -> bool:
    """Save a ScratchboxMesh directly to a standard binary glTF 2.0 (.glb) file"""


def write_glb_textured(path: str, meshes: collections.abc.Sequence[scratchbox_native.geometry.Mesh], textures: collections.abc.Sequence[tuple[str, str, bytes, str, float, float]]) -> bool:
    """Save meshes to a GLB embedding image textures. Each texture is (material_name, usage, image_bytes, mime_type, scale_u, scale_v); it attaches to the sub-mesh whose material or mesh name contains material_name, and the scale is written as KHR_texture_transform (use 1 / tile size in metres with world-metre UVs)"""
