"""Procedural architecture grammar and roofs"""

import enum

import scratchbox_native.geometry


class RoofType(enum.Enum):
    FlatParapet = 0

    Gable = 1

    Hip = 2

    Mansard = 3

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
    def roof_overhang(self) -> float: ...

    @roof_overhang.setter
    def roof_overhang(self, arg: float, /) -> None: ...

def generate_building(config: BuildingConfig, name: str = 'ProceduralBuilding') -> scratchbox_native.geometry.Mesh: ...
