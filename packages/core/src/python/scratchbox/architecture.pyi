"""Procedural architecture grammar and roofs"""

import enum

import scratchbox_native
from scratchbox_native import RomanOrder as RomanOrder
import scratchbox_native.geometry


class RoofType(enum.Enum):
    FlatParapet = 0

    Gable = 1

    Hip = 2

    Mansard = 3

    Dome = 4

    BarrelVault = 5

class BuildingConfig:
    def __init__(self) -> None: ...

    @property
    def width(self) -> float: ...

    @width.setter
    def width(self, arg: float, /) -> None: ...

    @property
    def depth(self) -> float: ...

    @depth.setter
    def depth(self, arg: float, /) -> None: ...

    @property
    def floor_count(self) -> int: ...

    @floor_count.setter
    def floor_count(self, arg: int, /) -> None: ...

    @property
    def floor_height(self) -> float: ...

    @floor_height.setter
    def floor_height(self, arg: float, /) -> None: ...

    @property
    def ground_floor_height(self) -> float: ...

    @ground_floor_height.setter
    def ground_floor_height(self, arg: float, /) -> None: ...

    @property
    def plinth_height(self) -> float: ...

    @plinth_height.setter
    def plinth_height(self, arg: float, /) -> None: ...

    @property
    def bay_width(self) -> float: ...

    @bay_width.setter
    def bay_width(self, arg: float, /) -> None: ...

    @property
    def window_width(self) -> float: ...

    @window_width.setter
    def window_width(self, arg: float, /) -> None: ...

    @property
    def window_height(self) -> float: ...

    @window_height.setter
    def window_height(self, arg: float, /) -> None: ...

    @property
    def window_recess_depth(self) -> float: ...

    @window_recess_depth.setter
    def window_recess_depth(self, arg: float, /) -> None: ...

    @property
    def roof_type(self) -> RoofType: ...

    @roof_type.setter
    def roof_type(self, arg: RoofType, /) -> None: ...

    @property
    def roof_pitch_degrees(self) -> float: ...

    @roof_pitch_degrees.setter
    def roof_pitch_degrees(self, arg: float, /) -> None: ...

    @property
    def roof_height(self) -> float: ...

    @roof_height.setter
    def roof_height(self, arg: float, /) -> None: ...

    @property
    def roof_overhang(self) -> float: ...

    @roof_overhang.setter
    def roof_overhang(self, arg: float, /) -> None: ...

    @property
    def parapet_height(self) -> float: ...

    @parapet_height.setter
    def parapet_height(self, arg: float, /) -> None: ...

    @property
    def curvature(self) -> float: ...

    @curvature.setter
    def curvature(self, arg: float, /) -> None: ...

    @property
    def superellipse_exponent(self) -> float: ...

    @superellipse_exponent.setter
    def superellipse_exponent(self, arg: float, /) -> None: ...

    @property
    def twist_degrees(self) -> float: ...

    @twist_degrees.setter
    def twist_degrees(self, arg: float, /) -> None: ...

    @property
    def taper(self) -> float: ...

    @taper.setter
    def taper(self, arg: float, /) -> None: ...

    @property
    def bulge(self) -> float: ...

    @bulge.setter
    def bulge(self, arg: float, /) -> None: ...

    @property
    def bay_count(self) -> int: ...

    @bay_count.setter
    def bay_count(self, arg: int, /) -> None: ...

    @property
    def bake_curvature_ao(self) -> bool: ...

    @bake_curvature_ao.setter
    def bake_curvature_ao(self, arg: bool, /) -> None: ...

def generate_building(config: BuildingConfig, name: str = 'ProceduralBuilding') -> scratchbox_native.geometry.Mesh: ...

def generate_curved_building(config: BuildingConfig, name: str = 'CurvedBuilding') -> scratchbox_native.geometry.Mesh: ...

def generate_peripteral_temple(archetype: str = 'roman_peripteral', order: scratchbox_native.RomanOrder = scratchbox_native.RomanOrder.Corinthian, footprint_length: float = 42.0, footprint_width: float = 24.0, column_count_x: int = 8, column_count_y: int = 14, column_height: float = 7.5, plinth_height: float = 1.399999976158142, seed: int = 1337) -> scratchbox_native.geometry.Mesh:
    """
    Construct an authentic Vitruvian classical temple with peripteral colonnade and gable roof
    """
