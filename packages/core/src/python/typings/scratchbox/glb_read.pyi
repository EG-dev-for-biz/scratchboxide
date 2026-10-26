"""
Reading a GLB back into meshes, so a script can start from an existing model (a staged build's massing, an earlier
script's output) and sculpt, add to and rebuild it, instead of only writing new geometry.

``read_glb(path)`` returns one ``Mesh`` per mesh primitive, each in world space (its node's transform applied, through
the node hierarchy), named after its node, with its vertex normals and first UV set when the file has them and its
material's base colour as the vertex colour. Textures are not read: a mesh comes back in its base colour. Positions,
normals, UVs and indices are read from any accessor layout glTF 2.0 allows (strided or tightly packed, float positions,
8, 16 or 32-bit indices); a primitive without indices is read as a triangle list.
"""

import typing

__all__ = ['Dict', 'List', 'Optional', 'Tuple', 'read_glb', 'struct']

Dict = typing.Dict
List = typing.List
Optional = typing.Optional
Tuple = typing.Tuple

def read_glb(path: str, max_triangles: int | None = None) -> list:
    """
    The meshes of the GLB at ``path``, in world space (see the module docstring). ``max_triangles`` stops reading once
    that many triangles are read (a very large scan), with the meshes read so far.
    """

import struct
