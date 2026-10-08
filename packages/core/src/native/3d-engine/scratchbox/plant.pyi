"""Procedural botanical plant presets and heroic biome assets"""

import scratchbox_native.geometry
import scratchbox_native.math


class PlantBuildResult:
    @property
    def wood_mesh(self) -> scratchbox_native.geometry.Mesh: ...

    @wood_mesh.setter
    def wood_mesh(self, arg: scratchbox_native.geometry.Mesh, /) -> None: ...

    @property
    def foliage_mesh(self) -> scratchbox_native.geometry.Mesh: ...

    @foliage_mesh.setter
    def foliage_mesh(self, arg: scratchbox_native.geometry.Mesh, /) -> None: ...

    @property
    def ground_clutter_mesh(self) -> scratchbox_native.geometry.Mesh: ...

    @ground_clutter_mesh.setter
    def ground_clutter_mesh(self, arg: scratchbox_native.geometry.Mesh, /) -> None: ...

    @property
    def total_vertices(self) -> int: ...

    @total_vertices.setter
    def total_vertices(self, arg: int, /) -> None: ...

    @property
    def total_triangles(self) -> int: ...

    @total_triangles.setter
    def total_triangles(self, arg: int, /) -> None: ...

    def get_combined(self, name: str = 'CombinedPlant') -> scratchbox_native.geometry.Mesh: ...

def create_hero_redwood(pos: scratchbox_native.math.Vec3 = ..., height: float = 28.0) -> PlantBuildResult:
    """
    Create hero ancient redwood with 8 buttress flutes and multi-tier conifer boughs
    """

def create_understory_dogwood(pos: scratchbox_native.math.Vec3 = ..., height: float = 5.5) -> PlantBuildResult:
    """Create subcanopy understory dogwood tree"""

def create_sword_fern_colony(pos: scratchbox_native.math.Vec3 = ..., radius: float = 1.600000023841858, fronds: int = 26) -> PlantBuildResult:
    """Create arching sword fern colony"""

def create_wood_sorrel_cushion(pos: scratchbox_native.math.Vec3 = ..., radius: float = 0.949999988079071) -> PlantBuildResult:
    """Create trifoliate wood sorrel ground cushion"""

def create_decaying_nurse_log(start: scratchbox_native.math.Vec3 = ..., end: scratchbox_native.math.Vec3 = ..., radius: float = 0.5) -> PlantBuildResult:
    """Create decaying nurse log with polypore shelves"""
