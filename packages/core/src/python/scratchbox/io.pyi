"""glTF 2.0 binary (.glb) packing and file serialization"""

from collections.abc import Sequence
from typing import overload

import scratchbox_native.geometry


@overload
def write_glb(path: str, mesh: scratchbox_native.geometry.Mesh) -> bool:
    """
    Save a ScratchboxMesh directly to a standard binary glTF 2.0 (.glb) file
    """

@overload
def write_glb(path: str, meshes: Sequence[scratchbox_native.geometry.Mesh]) -> bool:
    """
    Save multiple ScratchboxMeshes with distinct PBR materials to a multi-mesh glTF 2.0 (.glb) file
    """

@overload
def export_glb_bytes(mesh: scratchbox_native.geometry.Mesh) -> bytes:
    """
    Export ScratchboxMesh directly as a Python bytes object containing .glb data
    """

@overload
def export_glb_bytes(meshes: Sequence[scratchbox_native.geometry.Mesh]) -> bytes:
    """
    Export multiple ScratchboxMeshes directly as a Python bytes object containing .glb data
    """

def write_botanical_glb(path: str, meshes: Sequence[scratchbox_native.geometry.Mesh], texture_res: int = 512, season: float = 1.0, seed: int = 42) -> bool:
    """
    Save botanical tree meshes to GLB embedding procedural Worley bark and botanical foliage PBR texture maps (Albedo, Normal, ORM)
    """
