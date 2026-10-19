"""Botanical Plant Presets and Heroic Biome Assets adhering to Da Vinci pipe conservation."""

import typing

__all__ = ['Any', 'Flora', 'Optional', 'PlantPreset', 'Tuple', 'create_vegetation']

Any = typing.Any
Flora = PlantPreset
Optional = typing.Optional

class PlantPreset:
    """Pre-compiled botanical asset presets (hero ancient redwoods, understory, ground clutter)."""
    @classmethod
    def create_hero_redwood(cls, height: float = 28.0, pos: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> typing.Any:
        """Create hero ancient redwood with 8 buttress flutes and multi-tier conifer boughs."""

    @classmethod
    def create_understory_dogwood(cls, height: float = 5.5, pos: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> typing.Any:
        """Create subcanopy understory dogwood tree."""

    @classmethod
    def create_sword_fern_colony(cls, radius: float = 1.6, fronds: int = 26, pos: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> typing.Any:
        """Create arching sword fern colony."""

    @classmethod
    def create_wood_sorrel_cushion(cls, radius: float = 0.95, pos: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> typing.Any:
        """Create trifoliate wood sorrel ground cushion."""

    @classmethod
    def create_decaying_nurse_log(cls, start: typing.Tuple[float, float, float] = (-2.0, 0.0, 0.0), end: typing.Tuple[float, float, float] = (2.0, 0.0, 0.0), radius: float = 0.5) -> typing.Any:
        """Create decaying nurse log with polypore shelves."""

    @classmethod
    def create_vegetation(cls, pos: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0), height: float = 12.0, attractor_count: int = 120, crown_radius: float = 3.0, branch_step_length: float = 0.25, clear_trunk_height: float = 2.0, base_radius: float = 0.25, tip_radius: float = 0.03, perception_radius: float = 2.0, kill_radius: float = 0.5, generate_leaves: bool = True, use_detailed_leaves: bool = True, leaf_density: typing.Optional[float] = None, name: str = 'AdaptiveVegetation', **kwargs) -> typing.Any:
        """
        Creates open-domain continuous botanical flora or extraterrestrial vegetation
        adhering to Runions space colonization and Da Vinci pipe conservation.
        Satisfies ADA Pillar 1 (The Alien Planet Test).
        """

Tuple = typing.Tuple

def create_vegetation(pos: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0), height: float = 12.0, attractor_count: int = 120, crown_radius: float = 3.0, branch_step_length: float = 0.25, clear_trunk_height: float = 2.0, base_radius: float = 0.25, tip_radius: float = 0.03, perception_radius: float = 2.0, kill_radius: float = 0.5, generate_leaves: bool = True, use_detailed_leaves: bool = True, leaf_density: typing.Optional[float] = None, name: str = 'AdaptiveVegetation', **kwargs) -> typing.Any:
    """
    Creates open-domain continuous botanical flora or extraterrestrial vegetation
    adhering to Runions space colonization and Da Vinci pipe conservation.
    Satisfies ADA Pillar 1 (The Alien Planet Test).
    """
