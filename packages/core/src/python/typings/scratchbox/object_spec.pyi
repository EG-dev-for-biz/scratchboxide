"""
sb.object_spec: deterministic interpreter for an ObjectBuildSpec
(contract and JSON schema: packages/core/src/common/spatial/object-build-spec.ts).

    scene = sb.object_spec.build(spec)      # sb.Scene, one mesh per part, each with its material
    scene = sb.object_spec.build(spec, clay=True)   # the same geometry, every part studio clay
    sb.io.write_glb(OUTPUT_GLB_PATH, scene)

Units are metres, +Y up, +X right, +Z toward the front. Each part uses one of four geometry kernels:

  sweep      a superellipse section swept along a carrier through control points (centripetal Catmull-Rom
             blended with the polyline by `smoothing`), framed by rotation-minimising frames
  revolve    a meridian of [axial, radius] points revolved about an axis, with K radial harmonic lobes that a
             helix pitch twists along the axis
  replicate  copies of a seed part and everything attached to it, rotated around a ring or spaced along a path
  relief     grooves or beads applied as an offset field in the target's (u, v) parametrisation while its
             surface is generated

A child part attaches by parameter (u along, angle around, offset along the normal) on its parent's evaluated
surface, and its own coordinates are offsets in object axes from that point, so parts join by construction.
Sample density follows one target edge length derived from the object's surface area, so resolution, not padding,
carries the detail budget. A part's `material` (linear RGB baseColor, roughness, metalness, transmission, ior,
clearcoat, emissive, emissiveStrength) becomes its glTF material factors; a part without one, and every part of a
clay build, gets sb.PbrMaterial.clay(). Invalid input raises SpecError (a ValueError); nothing else is defaulted
or substituted. Labels and material descriptions are never read.
"""

import scratchbox.world
import typing

__all__ = ['CREASE_DEGREES', 'MAX_TRIANGLES', 'PART_VERTEX_CAP', 'SpecError', 'TARGET_VERTICES', 'build', 'build_meshes', 'math', 'part_material', 'validate']

CREASE_DEGREES: float
MAX_TRIANGLES: int
PART_VERTEX_CAP: int

class SpecError(ValueError):
    """
    The spec cannot be built as written. `problems` lists every problem found, one line each, naming the part and
    field, so whoever wrote the spec can correct them all at once. The message is those lines under one heading;
    the builder reads them back from the traceback (scratchbox.object_spec.SpecError: ...).
    """
    def __init__(self, problems) -> None: ...

    problems: typing.Any

TARGET_VERTICES: int

def build(spec, clay=False) -> scratchbox.world.World:
    """
    Builds the spec into an sb.Scene: one mesh per part, the lowest point resting on y = 0. Each part's mesh (with
    its replicated and mirrored copies) carries the part's material factors; with clay=True, or for a part without a
    material, it is studio clay.
    """


def build_meshes(spec):
    """Validates and builds the spec; returns [(part id, positions, normals, triangles)] in spec order."""

import math

def part_material(sb, pid, material):
    """A native PbrMaterial holding a part's material factors exactly (studio clay when it has none)."""


def validate(spec):
    """Returns the list of problems with the spec (empty when it can be built)."""
