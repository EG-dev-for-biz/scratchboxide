"""glTF 2.0 binary (.glb) packing and file serialization"""

import scratchbox_native.geometry


def write_glb(path: str, mesh: scratchbox_native.geometry.Mesh) -> bool:
    """
    Save a ScratchboxMesh directly to a standard binary glTF 2.0 (.glb) file
    """

def export_glb_bytes(mesh: scratchbox_native.geometry.Mesh) -> bytes:
    """
    Export ScratchboxMesh directly as a Python bytes object containing .glb data
    """
