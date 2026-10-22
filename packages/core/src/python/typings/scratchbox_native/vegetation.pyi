"""SB-Veggie trees (the one vegetation generator): space colonisation inside described crowns, SB-Veggie leaf clusters, species and texture libraries, viewport levels of detail"""


__all__ = ['grow_described_trees']


def grow_described_trees(trees_json: str, options_json: str = '{}') -> tuple:
    """Grow described trees (scratchbox.sb-veggie-trees/1 JSON) as SB-Veggie trees; returns (trees GLB bytes, stats JSON, crowns JSON)"""
