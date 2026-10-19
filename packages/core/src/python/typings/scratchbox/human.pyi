"""
Scratchbox Humanoid Studio & DCC Figure Module
Provides a standard 3D DCC object model (armature.pose.bones, shape_keys, principled_bsdf)
powered by native C++20 biophysical skin optics, 52 FACS action units, and skeletal kinematics.
"""

import typing

__all__ = ['Any', 'Armature', 'CANONICAL_22_BONES', 'Dict', 'FACS_52_ACTION_UNITS', 'Human', 'List', 'Optional', 'PoseBone', 'PrincipledBsdfMaterial', 'ShapeKeyBlock', 'ShapeKeys', 'StudioHuman', 'Tuple', 'Union', 'create', 'create_human', 'math']

Any = typing.Any

class Armature:
    """DCC Armature representing skeletal joints and their posed runtime state."""
    def __init__(self): ...

    def get_bone(self, name: str) -> typing.Optional[PoseBone]: ...

    bones: typing.Any
    pose: typing.Any

CANONICAL_22_BONES: list
Dict = typing.Dict
FACS_52_ACTION_UNITS: list

class Human:
    """
    Architectural scale entourage figure.
    Grounded with analytical 2-bone IK and styled in 18% Studio Grey Clay.
    """
    def __init__(self, role: str = 'scale_figure', height: float = 1.76, gender_beta: float = 0.0, pose: str = 'standing_survey', position: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0), facing_deg: float = 0.0, surface: typing.Optional[typing.Any] = None, surface_y_offset: float = 0.0): ...

    def stand_on(self, surface: typing.Any, offset: typing.Tuple[float, float] = (0.0, 0.0), y_offset: float = 0.0, facing_deg: typing.Optional[float] = None) -> Human: ...

    @property
    def mesh(self) -> typing.Any: ...

    def build_mesh(self) -> typing.Any: ...

    def __repr__(self) -> str: ...

    role: typing.Any
    height: typing.Any
    gender_beta: typing.Any
    pose: typing.Any
    position: typing.Any
    facing_deg: typing.Any
    surface: typing.Any
    surface_y_offset: typing.Any

List = typing.List
Optional = typing.Optional

class PoseBone:
    """DCC Pose Bone with Euler, Quaternion, and translation transforms."""
    def __init__(self, name: str): ...

    def __repr__(self) -> str: ...

    name: typing.Any
    rotation_euler: typing.Any
    rotation_quaternion: typing.Any
    location: typing.Any
    scale: typing.Any


class PrincipledBsdfMaterial:
    """
    Biophysical Principled BSDF dermal material with melanin absorption,
    hemoglobin subsurface diffusion, and dual-lobe micro-specularity.
    """
    def __init__(self): ...

    def set_melanin(self, melanin_fraction: float, pheomelanin_ratio: float = 0.2): ...

    base_color: typing.Any
    melanin_fraction: typing.Any
    pheomelanin_ratio: typing.Any
    subsurface: typing.Any
    subsurface_radius: typing.Any
    subsurface_color: typing.Any
    roughness: typing.Any
    specular: typing.Any
    clearcoat: typing.Any
    clearcoat_roughness: typing.Any
    metallic: typing.Any
    ior: typing.Any


class ShapeKeyBlock:
    """A single facial morph target / FACS action unit."""
    def __init__(self, name: str, value: float = 0.0): ...

    def __repr__(self) -> str: ...

    name: typing.Any
    value: typing.Any


class ShapeKeys:
    """DCC Shape Keys collection with dictionary-like access matching standard 3D conventions."""
    def __init__(self): ...

    def __getitem__(self, key: str) -> ShapeKeyBlock: ...

    def __setitem__(self, key: str, val: typing.Union[float, ShapeKeyBlock]): ...

    def get(self, key: str, default: typing.Optional[ShapeKeyBlock] = None) -> typing.Optional[ShapeKeyBlock]: ...

    key_blocks: typing.Any


class StudioHuman:
    """
    High-fidelity DCC Humanoid Object.
    Offers standard 3D DCC semantics:
    - human.armature.pose.bones['head'].rotation_euler = (0.1, 0.0, 0.2)
    - human.shape_keys['mouthSmileLeft'].value = 0.85
    - human.material.principled_bsdf.subsurface = 0.85
    - human.export_glb('output.glb')
    """
    def __init__(self, name: str = 'Human', height: float = 1.78, gender_beta: float = 0.0, position: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0)): ...

    def export_glb(self, path: str) -> str:
        """
        Exports standard glTF 2.0 binary (.glb) with full 22-bone skinning,
        52 FACS action unit morph targets, and biophysical PBR materials.
        """

    def get_mesh(self) -> typing.Any:
        """Evaluates the deformed and morphed mesh using native C++20 engine."""

    def __repr__(self) -> str: ...

    name: typing.Any
    height: typing.Any
    gender_beta: typing.Any
    position: typing.Any
    armature: typing.Any
    shape_keys: typing.Any
    material: typing.Any

Tuple = typing.Tuple
Union = typing.Union

def create(name: str = 'Human', height: float = 1.78, gender_beta: float = 0.0, position: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0), **kwargs) -> StudioHuman:
    """
    Primary DCC factory function for creating a high-fidelity Studio Human.
    Exposes armature.pose.bones, shape_keys, and biophysical principled_bsdf.
    """


def create_human(role: str = 'scale_figure', height: float = 1.76, gender_beta: float = 0.0, pose: str = 'standing_survey', position: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0), facing_deg: float = 0.0, surface: typing.Optional[typing.Any] = None, surface_y_offset: float = 0.0, **kwargs) -> Human:
    """Factory function for synthesizing an architectural scale entourage human."""

import math
