"""
SB-Veggie trees: the one vegetation generator for every scene a script builds.

A tree is described by continuous measurements (where its trunk stands, its height, its crown's radii, where the
crown begins and where it is widest, the shape of its top, its trunk radius and its leaf colour) and grown natively by
the same SB-Veggie pipeline a staged location's trees are: space-colonisation branching inside the described crown,
SB-Veggie leaf clusters, the tree species library chosen by the crown's measurements, the tree texture library chosen
by appearance, and the viewport's levels of detail. Nothing is keyed on a species name: a label is free text.

Trees are not meshes. sb.create_tree returns an SbVeggieTree; add it to a scene with scene.merge(tree) /
scene.append(tree) / world.add(tree) (or pass it in the list given to sb.io.write_glb), and the GLB writer grows every
tree of the written scene in one native run and writes them into the same GLB, each tree a node with its levels of
detail and its SB-Veggie extras. translate / rotate_y / scale move a tree; a scene mesh the tree was merged into
carries it along when that mesh is moved.
"""

import typing

__all__ = ['Any', 'Iterable', 'List', 'Optional', 'SPECIES_INDEX', 'SbVeggieTree', 'Sequence', 'TEXTURE_INDEX', 'TREES_SCHEMA', 'Tuple', 'Union', 'attach_trees', 'create_tree', 'create_vegetation', 'grow_trees', 'hashlib', 'is_tree', 'json', 'math', 'merge_glb', 'os', 'struct', 'trees_of']

Any = typing.Any
Iterable = typing.Iterable
List = typing.List
Optional = typing.Optional
SPECIES_INDEX: str

class SbVeggieTree:
    """One SB-Veggie tree, described by measurements (metres, y up). Grown when the scene that holds it is written."""
    def __init__(self, position: typing.Any = (0.0, 0.0, 0.0), height: float = 10.0, crown_radius: typing.Union[float, typing.Sequence[float]] = 3.5, crown_base_height: typing.Optional[float] = None, crown_widest_at: float = 0.5, crown_top_exponent: float = 2.0, trunk_radius: typing.Optional[float] = None, leaf_color: typing.Any = None, label: typing.Optional[str] = None, name: typing.Optional[str] = None): ...

    def translate(self, *args) -> SbVeggieTree: ...

    def rotate_y(self, angle_deg: float) -> SbVeggieTree:
        """Rotates the tree's position about the y axis through the origin (a crown is grown round, so it has no heading)."""

    def scale(self, *args) -> SbVeggieTree:
        """Scales position and size about the origin: one factor, or (sx, sy, sz) (sizes take sy for height, sx/sz for radii)."""

    def copy(self) -> SbVeggieTree: ...

    @property
    def bounds_min(self) -> typing.Tuple[float, float, float]: ...

    @property
    def bounds_max(self) -> typing.Tuple[float, float, float]: ...

    def to_spec(self) -> dict: ...

    def __getattr__(self, name: str): ...

    def __repr__(self) -> str: ...

    def __setattr__(self, name: str, value: typing.Any, /) -> None: ...

    position: typing.Any
    height: typing.Any
    crown_base_height: typing.Any
    crown_widest_at: typing.Any
    crown_top_exponent: typing.Any
    trunk_radius: typing.Any
    leaf_linear_rgb: typing.Any
    label: typing.Any
    name: typing.Any
    crown_radii: typing.Any

Sequence = typing.Sequence
TEXTURE_INDEX: str
TREES_SCHEMA: str
Tuple = typing.Tuple
Union = typing.Union

def attach_trees(glb: bytes, trees: typing.Sequence[SbVeggieTree], seed: typing.Optional[str] = None) -> bytes:
    """The scene GLB with its SB-Veggie trees grown and written into it."""


def create_tree(position: typing.Any = None, height: typing.Optional[float] = None, crown_radius: typing.Union[float, typing.Sequence[float], NoneType] = None, crown_base_height: typing.Optional[float] = None, crown_widest_at: float = 0.5, crown_top_exponent: float = 2.0, trunk_radius: typing.Optional[float] = None, leaf_color: typing.Any = None, label: typing.Optional[str] = None, name: typing.Optional[str] = None, **kwargs) -> SbVeggieTree:
    """
    One SB-Veggie tree described by measurements (metres): position = trunk base (x, y, z); height = base to crown top;
    crown_radius = crown half-spread (or (along x, along z)); crown_base_height = lowest crown above the base (None: from
    the species library by the crown's shape); crown_widest_at = share of the crown's depth where it is widest (0: a cone
    widest at its base, 0.5: a round crown, 0.8: an umbrella); crown_top_exponent = top profile (1 cone, 2 dome, 4 flat);
    trunk_radius (None: from the species); leaf_color = sRGB (r, g, b) / '#rrggbb' (chooses species and leaf textures);
    label = free text. Grown natively (space colonisation + SB-Veggie leaf clusters + levels of detail) when written.
    """


def create_vegetation(pos: typing.Any = (0.0, 0.0, 0.0), height: float = 12.0, crown_radius: typing.Union[float, typing.Sequence[float]] = 3.0, clear_trunk_height: typing.Optional[float] = None, **kwargs) -> SbVeggieTree:
    """Alias of create_tree with the older positional names (pos, height, crown_radius, clear_trunk_height = crown base)."""


def grow_trees(trees: typing.Iterable[SbVeggieTree], seed: typing.Optional[str] = None, triangle_budget: typing.Optional[float] = None, label: typing.Optional[str] = None) -> typing.Tuple[bytes, dict]:
    """Grows the trees natively (scratchbox_native.vegetation) and returns (trees GLB bytes, stats)."""

import hashlib

def is_tree(obj: typing.Any) -> bool: ...

import json
import math

def merge_glb(base: bytes, add: bytes) -> bytes:
    """
    Appends every node, mesh and buffer of `add` to `base` (one scene); `add`'s scene extras sbTrees / sbVeggie are
    carried to the merged scene (the viewport's tree levels of detail read them there).
    """

import os
import struct

def trees_of(target: typing.Any) -> typing.List[SbVeggieTree]:
    """Every SB-Veggie tree a write target holds: itself, list members, a mesh's merged trees, a World's trees."""
