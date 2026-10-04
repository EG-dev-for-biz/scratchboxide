"""
Botanical Plant Presets and Heroic Biome Assets adhering to Da Vinci pipe conservation.
"""

from typing import Any, Tuple, Optional

class PlantPreset:
    """Pre-compiled botanical asset presets (hero ancient redwoods, understory, ground clutter)."""

    @staticmethod
    def _get_plant_module():
        try:
            import scratchbox_native
            return getattr(scratchbox_native, "plant", None)
        except ImportError:
            return None

    @classmethod
    def create_hero_redwood(cls, height: float = 28.0, pos: Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> Any:
        """Create hero ancient redwood with 8 buttress flutes and multi-tier conifer boughs."""
        mod = cls._get_plant_module()
        if mod and hasattr(mod, "create_hero_redwood"):
            import scratchbox_native
            p = scratchbox_native.math.Vec3(pos[0], pos[1], pos[2])
            res = mod.create_hero_redwood(p, float(height))
            return res.get_combined("HeroAncientRedwood")
        # Fallback if native module not yet loaded
        raise RuntimeError("Native plant module scratchbox_native.plant is required")

    @classmethod
    def create_understory_dogwood(cls, height: float = 5.5, pos: Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> Any:
        """Create subcanopy understory dogwood tree."""
        mod = cls._get_plant_module()
        if mod and hasattr(mod, "create_understory_dogwood"):
            import scratchbox_native
            p = scratchbox_native.math.Vec3(pos[0], pos[1], pos[2])
            res = mod.create_understory_dogwood(p, float(height))
            return res.get_combined("UnderstoryDogwood")
        raise RuntimeError("Native plant module scratchbox_native.plant is required")

    @classmethod
    def create_sword_fern_colony(cls, radius: float = 1.6, fronds: int = 26, pos: Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> Any:
        """Create arching sword fern colony."""
        mod = cls._get_plant_module()
        if mod and hasattr(mod, "create_sword_fern_colony"):
            import scratchbox_native
            p = scratchbox_native.math.Vec3(pos[0], pos[1], pos[2])
            res = mod.create_sword_fern_colony(p, float(radius), int(fronds))
            return res.get_combined("SwordFernColony")
        raise RuntimeError("Native plant module scratchbox_native.plant is required")

    @classmethod
    def create_wood_sorrel_cushion(cls, radius: float = 0.95, pos: Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> Any:
        """Create trifoliate wood sorrel ground cushion."""
        mod = cls._get_plant_module()
        if mod and hasattr(mod, "create_wood_sorrel_cushion"):
            import scratchbox_native
            p = scratchbox_native.math.Vec3(pos[0], pos[1], pos[2])
            res = mod.create_wood_sorrel_cushion(p, float(radius))
            return res.get_combined("WoodSorrelCushion")
        raise RuntimeError("Native plant module scratchbox_native.plant is required")

    @classmethod
    def create_decaying_nurse_log(cls, start: Tuple[float, float, float] = (-2.0, 0.0, 0.0), end: Tuple[float, float, float] = (2.0, 0.0, 0.0), radius: float = 0.5) -> Any:
        """Create decaying nurse log with polypore shelves."""
        mod = cls._get_plant_module()
        if mod and hasattr(mod, "create_decaying_nurse_log"):
            import scratchbox_native
            p0 = scratchbox_native.math.Vec3(start[0], start[1], start[2])
            p1 = scratchbox_native.math.Vec3(end[0], end[1], end[2])
            res = mod.create_decaying_nurse_log(p0, p1, float(radius))
            return res.get_combined("DecayingNurseLog")
        raise RuntimeError("Native plant module scratchbox_native.plant is required")

# Alias Flora
Flora = PlantPreset
