"""Scene staging, instance scattering and lighting"""

import scratchbox_native.geometry
import scratchbox_native.math


class InstanceTransform:
    def __init__(self) -> None: ...

    @property
    def position(self) -> scratchbox_native.math.Vec3: ...

    @position.setter
    def position(self, arg: scratchbox_native.math.Vec3, /) -> None: ...

    @property
    def scale(self) -> scratchbox_native.math.Vec3: ...

    @scale.setter
    def scale(self, arg: scratchbox_native.math.Vec3, /) -> None: ...

    @property
    def rotation(self) -> scratchbox_native.math.Quat: ...

    @rotation.setter
    def rotation(self, arg: scratchbox_native.math.Quat, /) -> None: ...

def scatter_instances(base_mesh: scratchbox_native.geometry.Mesh, count: int, min_scale: float = 0.6000000238418579, max_scale: float = 1.399999976158142, seed: int = 42) -> list[InstanceTransform]:
    """
    Scatter object transforms across mesh surface using Poisson-disk area-weighting
    """

class MeshCurvatureResult:
    @property
    def pointiness(self) -> list[float]: ...

    @property
    def cavity_ao(self) -> list[float]: ...

def compute_curvature(mesh: scratchbox_native.geometry.Mesh) -> MeshCurvatureResult:
    """
    Extract Blender-style Pointiness (convex edge wear) and Cavity AO (concave dirt)
    """

class StudioLight:
    @property
    def name(self) -> str: ...

    @name.setter
    def name(self, arg: str, /) -> None: ...

    @property
    def position(self) -> scratchbox_native.math.Vec3: ...

    @position.setter
    def position(self, arg: scratchbox_native.math.Vec3, /) -> None: ...

    @property
    def color(self) -> scratchbox_native.math.Vec3: ...

    @color.setter
    def color(self, arg: scratchbox_native.math.Vec3, /) -> None: ...

    @property
    def intensity(self) -> float: ...

    @intensity.setter
    def intensity(self, arg: float, /) -> None: ...

    @property
    def color_temperature_kelvin(self) -> float: ...

    @color_temperature_kelvin.setter
    def color_temperature_kelvin(self, arg: float, /) -> None: ...

class StudioLightingRig:
    @property
    def key_light(self) -> StudioLight: ...

    @key_light.setter
    def key_light(self, arg: StudioLight, /) -> None: ...

    @property
    def fill_light(self) -> StudioLight: ...

    @fill_light.setter
    def fill_light(self, arg: StudioLight, /) -> None: ...

    @property
    def rim_light(self) -> StudioLight: ...

    @rim_light.setter
    def rim_light(self, arg: StudioLight, /) -> None: ...

    @property
    def floor_bounce(self) -> StudioLight: ...

    @floor_bounce.setter
    def floor_bounce(self, arg: StudioLight, /) -> None: ...

def create_cinematic_studio_lighting(target_center: scratchbox_native.math.Vec3 = ..., rig_scale: float = 5.0) -> StudioLightingRig: ...
