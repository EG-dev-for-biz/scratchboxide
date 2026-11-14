"""
The shot a scene is built for: a camera described by measurements (where it stands, what it looks at, its lens and
frame), and the screen-space detail budget that follows from it.

A script declares its shot once, before it builds anything, and sizes every detail from it:

    hero = sb.shot(position=(0, 160, -120), target=(0, 20, 180), focal_mm=31.5, aspect=2.39)
    if hero.resolves(1.4, at=(x, y, z)):    # ask about the whole feature: is a 1.4 m fire escape at least 2 px?
        bar = hero.member_m(0.04, at=(x, y, z))  # then build its 4 cm bars as thick as the shot needs to show them
    edge = hero.min_feature_m(at=(x, y, z)) # the smallest size worth modelling there

Detail smaller than the budget (2 pixels by default) cannot be seen in the shot and only costs triangles; the same
triangles spent near the lens are what the picture is made of. Every shot a script declares is written beside the
GLB, so the scene opens on the first one and the result reports how many triangles fell under the budget.
"""

import typing

__all__ = ['Any', 'Dict', 'List', 'Optional', 'Point', 'Sequence', 'Shot', 'Tuple', 'camera_move', 'declared_shots', 'json', 'math', 'member_m', 'min_feature_m', 'os', 'resolves', 'shot', 'shots_path']

Any = typing.Any
Dict = typing.Dict
List = typing.List
Optional = typing.Optional
Point = typing.Any
Sequence = typing.Sequence

class Shot:
    """One camera: position and target in metres (y up), a lens in millimetres and a frame in pixels."""
    def __init__(self, position: typing.Sequence[float], target: typing.Sequence[float], focal_mm: float = 35.0, sensor_width_mm: float = 36.0, aspect: float = 1.777778, width_px: int = 1920, detail_px: float = 2.0, name: str = '') -> None: ...

    @property
    def height_px(self) -> int: ...

    @property
    def focal_px(self) -> float:
        """The focal length in pixels: a 1 m object 1 m in front of the lens covers this many pixels."""

    @property
    def horizontal_fov_deg(self) -> float: ...

    @property
    def vertical_fov_deg(self) -> float: ...

    def depth(self, at: typing.Sequence[float]) -> float:
        """Distance of a point in front of the lens, along the view axis, in metres (negative: behind the camera)."""

    def pixels(self, size_m: float, at: typing.Sequence[float]) -> float:
        """How many pixels something `size_m` across covers at that point, facing the camera (0 behind the camera)."""

    def min_feature_m(self, at: typing.Sequence[float], pixels: float | None = None) -> float:
        """The smallest size worth modelling at that point: what covers `pixels` (the shot's detail_px by default)."""

    def resolves(self, size_m: float, at: typing.Sequence[float], pixels: float | None = None) -> bool:
        """True when something `size_m` across is at least the detail budget wide in the frame at that point."""

    def member_m(self, nominal_m: float, at: typing.Sequence[float], pixels: float | None = None) -> float:
        """
        The size to build a thin member at so it still shows: its real size, or the smallest the shot resolves there
        when that is larger. Use it for a railing, a mullion or a bar of a feature whose overall size resolves: a fire
        escape 1.4 m deep is seen from 300 m even though its 4 cm bars are not, so build the bars at member_m(0.04, at)
        rather than leaving the fire escape out. Never more than eight times the real size: past that the feature
        itself is what does not resolve, and resolves() on its overall size says so.
        """

    @property
    def right(self) -> typing.Tuple[float, float, float]:
        """The frame's right in world space (unit vector): frame left is the opposite. Looking down -z, right is +x."""

    @property
    def up(self) -> typing.Tuple[float, float, float]:
        """The frame's up in world space (unit vector)."""

    @property
    def forward(self) -> typing.Tuple[float, float, float]:
        """The view direction in world space (unit vector)."""

    def frame_point(self, x: float, y: float, depth: float) -> typing.Tuple[float, float, float]:
        """
        The world point seen at frame position (x, y) at `depth` metres in front of the lens: x from -1 (left edge) to
        1 (right edge), y from -1 (bottom) to 1 (top). Place what the request puts on the left of the frame at x < 0
        and on the right at x > 0, and read its world coordinates from here instead of guessing which axis is left.
        """

    def sun_azimuth_deg(self, frame_x: float) -> float:
        """
        The azimuth of a sun standing ahead of the camera toward frame position `frame_x` (-1 the left edge, 0 the
        centre, 1 the right edge; beyond 1 outside the frame, 3 well to the side), in the convention
        atmosphere_configure_scene and path_trace_render take: degrees clockwise from -z (north), 90 toward +x.
        "Ahead and to the left" is sun_azimuth_deg(-1.5), "behind the camera" is that azimuth plus 180.
        """

    def sees(self, at: typing.Sequence[float], margin: float = 0.0) -> bool:
        """True when the point is in front of the lens and inside the frame (`margin`: extra frame, 0.1 = 10 %)."""

    def to_dict(self) -> typing.Dict[str, typing.Any]: ...

    def __repr__(self) -> str: ...

    def __setattr__(self, name: str, value: typing.Any, /) -> None: ...

    position: typing.Any
    target: typing.Any
    focal_mm: typing.Any
    sensor_width_mm: typing.Any
    aspect: typing.Any
    width_px: typing.Any
    detail_px: typing.Any
    name: typing.Any

Tuple = typing.Tuple

def camera_move(keys: typing.Sequence[typing.Tuple[float, ForwardRef('Shot')]], name: str = 'move') -> typing.Dict[str, typing.Any]:
    """
    Animate the camera through declared shots.

    `keys` are (time in seconds, shot) pairs, the shots already declared with sb.shot, in increasing time. The scene's
    timeline plays the move: the camera passes through each shot at its time on a smooth path (cubic, Catmull-Rom
    tangents over the key times, easing in at the first key and out at the last; the focal length tweened in log space),
    and path_trace_render renders any moment of it (timeSeconds). A slow push-in is two shots forty seconds apart.
    """


def declared_shots() -> typing.List[Shot]:
    """The shots this run has declared, in order."""

import json
import math

def member_m(nominal_m: float, at: typing.Sequence[float]) -> float:
    """The size to build a thin member at so some declared shot shows it: the least any shot needs; its real size with no shot."""


def min_feature_m(at: typing.Sequence[float]) -> float:
    """The smallest size any declared shot resolves at that point, in metres; 0 when no shot is declared."""

import os

def resolves(size_m: float, at: typing.Sequence[float]) -> bool:
    """True when any declared shot resolves something `size_m` across at that point; True when no shot is declared."""


def shot(position: typing.Sequence[float], target: typing.Sequence[float], focal_mm: float = 35.0, sensor_width_mm: float = 36.0, aspect: float = 1.777778, width_px: int = 1920, detail_px: float = 2.0, name: str = '') -> Shot:
    """
    Declare a camera the scene is built for.

    The first shot declared is the one the scene opens on and is reviewed from; declare further shots for other
    angles, and detail counts as seen when any shot resolves it.
    """


def shots_path() -> str | None:
    """Where a run's declared shots are written: beside the GLB the run is expected to write."""
