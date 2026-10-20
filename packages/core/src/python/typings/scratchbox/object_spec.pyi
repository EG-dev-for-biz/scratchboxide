"""
sb.object_spec: deterministic interpreter for an ObjectBuildSpec
(contract and JSON schema: packages/core/src/common/spatial/object-build-spec.ts).

    scene = sb.object_spec.build(spec)      # sb.Scene of clay meshes, one per part
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
carries the detail budget. Every mesh gets sb.PbrMaterial.clay(). Invalid input raises SpecError (a ValueError);
nothing is defaulted or substituted. Labels are never read.
"""

import scratchbox.world
import typing

__all__ = ['CREASE_DEGREES', 'MAX_TRIANGLES', 'PART_VERTEX_CAP', 'SpecError', 'TARGET_VERTICES', 'build', 'build_meshes', 'math', 'validate']

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

def build(spec) -> scratchbox.world.World:
    """Builds the spec into an sb.Scene: one clay mesh per part, the lowest point resting on y = 0."""


def build_meshes(spec):
    """Validates and builds the spec; returns [(part id, positions, normals, triangles)] in spec order."""

import math

def validate(spec):
    """Returns the list of problems with the spec (empty when it can be built)."""
