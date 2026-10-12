"""
SB-Rig: geometry-derived joint trees and geodesic 4-bone skin weights for any mesh
"""

from collections.abc import Sequence

import scratchbox_native.geometry
import scratchbox_native.human


class Params:
    """
    All lengths are dimensionless fractions of lengths the mesh measures itself (geodesic diameter D, bbox diagonal, ring radius).
    """

    def __init__(self) -> None: ...

    @property
    def weld_frac(self) -> float: ...

    @weld_frac.setter
    def weld_frac(self, arg: float, /) -> None: ...

    @property
    def refine_edge_multiple(self) -> float: ...

    @refine_edge_multiple.setter
    def refine_edge_multiple(self, arg: float, /) -> None: ...

    @property
    def agd_samples(self) -> int: ...

    @agd_samples.setter
    def agd_samples(self, arg: int, /) -> None: ...

    @property
    def band_frac(self) -> float: ...

    @band_frac.setter
    def band_frac(self, arg: float, /) -> None: ...

    @property
    def band_edge_multiple(self) -> float: ...

    @band_edge_multiple.setter
    def band_edge_multiple(self, arg: float, /) -> None: ...

    @property
    def loop_contract_ratio(self) -> float: ...

    @loop_contract_ratio.setter
    def loop_contract_ratio(self, arg: float, /) -> None: ...

    @property
    def min_node_frac(self) -> float: ...

    @min_node_frac.setter
    def min_node_frac(self, arg: float, /) -> None: ...

    @property
    def min_branch_frac(self) -> float: ...

    @min_branch_frac.setter
    def min_branch_frac(self, arg: float, /) -> None: ...

    @property
    def hub_merge_frac(self) -> float: ...

    @hub_merge_frac.setter
    def hub_merge_frac(self, arg: float, /) -> None: ...

    @property
    def joint_deviation_frac(self) -> float: ...

    @joint_deviation_frac.setter
    def joint_deviation_frac(self, arg: float, /) -> None: ...

    @property
    def radius_weight(self) -> float: ...

    @radius_weight.setter
    def radius_weight(self, arg: float, /) -> None: ...

    @property
    def bend_threshold_rad(self) -> float: ...

    @bend_threshold_rad.setter
    def bend_threshold_rad(self, arg: float, /) -> None: ...

    @property
    def min_bone_frac(self) -> float: ...

    @min_bone_frac.setter
    def min_bone_frac(self, arg: float, /) -> None: ...

    @property
    def max_bone_frac(self) -> float: ...

    @max_bone_frac.setter
    def max_bone_frac(self, arg: float, /) -> None: ...

    @property
    def min_leaf_chain_segments(self) -> int: ...

    @min_leaf_chain_segments.setter
    def min_leaf_chain_segments(self, arg: int, /) -> None: ...

    @property
    def blend_scale(self) -> float: ...

    @blend_scale.setter
    def blend_scale(self, arg: float, /) -> None: ...

    @property
    def emit_tip_joints(self) -> bool: ...

    @emit_tip_joints.setter
    def emit_tip_joints(self, arg: bool, /) -> None: ...

    @property
    def root_hint(self) -> list[float] | None:
        """
        World-space point near where the hierarchy should start (e.g. the cut end of a limb); None = geodesic centre.
        """

    @root_hint.setter
    def root_hint(self, arg: Sequence[float] | None, /) -> None: ...

    @property
    def chain_hints(self) -> list[list[list[float]]]:
        """
        Extra chains, each a base-to-tip list of points (surface points are pulled to the local axis).
        """

    @chain_hints.setter
    def chain_hints(self, arg: Sequence[Sequence[Sequence[float]]], /) -> None: ...

    def set(self, name: str, value: str) -> None:
        """
        Set a parameter by its camelCase name, e.g. set('minBranchFrac', '0.06')
        """

    def validate(self) -> None: ...

class Chain:
    @property
    def name(self) -> str: ...

    @property
    def parent_joint(self) -> int: ...

    @property
    def joints(self) -> list[int]: ...

    @property
    def leaf(self) -> bool: ...

    @property
    def hinted(self) -> bool: ...

    @property
    def length(self) -> float: ...

    def __repr__(self) -> str: ...

class Result:
    @property
    def skeleton(self) -> scratchbox_native.human.Skeleton: ...

    @property
    def chains(self) -> list[Chain]: ...

    @property
    def joint_names(self) -> list[str]: ...

    @property
    def parents(self) -> list[int]: ...

    @property
    def rest_positions(self) -> list[list[float]]: ...

    @property
    def tip_joints(self) -> list:
        """True for end-effector joints, which carry no weight."""

    @property
    def joint_indices(self) -> list[int]:
        """Flat list, 4 joint indices per input vertex (glTF JOINTS_0 order)."""

    @property
    def joint_weights(self) -> list[float]:
        """
        Flat list, 4 weights per input vertex summing to 1 (glTF WEIGHTS_0 order).
        """

    @property
    def vertex_owner(self) -> list[int]: ...

    @property
    def leaf_count(self) -> int: ...

    def rename(self, mapping: dict) -> None:
        """
        Rename joints in dict order. A chain name (e.g. 'Chain3') renames its joints to <value>1..n; any other key must be an exact joint name.
        """

    def report_json(self, params: Params = ..., include_tree: bool = False) -> str: ...

    def __repr__(self) -> str: ...

def solve(mesh: scratchbox_native.geometry.Mesh, params: Params = ...) -> Result:
    """Discover a joint tree and 4-bone skin weights for an in-memory mesh."""

def rig_glb(input_path: str, output_path: str, params: Params = ..., rename: dict | None = None, report_path: str | None = None) -> Result:
    """
    Rig a GLB file and write the skinned GLB; images, UVs and materials are carried over byte for byte.
    """

def export_skinned_glb_bytes(mesh: scratchbox_native.geometry.Mesh, result: Result) -> bytes:
    """Serialise an in-memory mesh with its SB-Rig skin as .glb bytes."""
