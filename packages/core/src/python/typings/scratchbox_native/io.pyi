"""glTF 2.0 binary (.glb) packing and file serialization"""

import collections.abc
import scratchbox_native.geometry
import typing

__all__ = ['export_glb', 'export_glb_bytes', 'write_glb']


def export_glb(arg1, arg2=None) -> bytes: ...


@typing.overload
def export_glb_bytes(mesh: scratchbox_native.geometry.Mesh) -> bytes:
    """Export ScratchboxMesh directly as a Python bytes object containing .glb data"""

@typing.overload
def export_glb_bytes(meshes: collections.abc.Sequence[scratchbox_native.geometry.Mesh]) -> bytes:
    """Export multiple ScratchboxMeshes directly as a Python bytes object containing .glb data"""


def write_glb(arg1, arg2=None) -> bool:
    """Save a ScratchboxMesh directly to a standard binary glTF 2.0 (.glb) file"""
