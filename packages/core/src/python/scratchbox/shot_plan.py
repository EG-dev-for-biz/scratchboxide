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

from typing import Any, Dict, List, Optional, Sequence, Tuple
import json
import math
import os

Point = Sequence[float]

_SHOTS: List["Shot"] = []


def _vec(value: Any, what: str) -> Tuple[float, float, float]:
    if hasattr(value, "x") and hasattr(value, "y") and hasattr(value, "z"):
        return (float(value.x), float(value.y), float(value.z))
    try:
        x, y, z = value
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a point (x, y, z) in metres, got {value!r}") from None
    return (float(x), float(y), float(z))


class Shot:
    """One camera: position and target in metres (y up), a lens in millimetres and a frame in pixels."""

    def __init__(
        self,
        position: Point,
        target: Point,
        focal_mm: float = 35.0,
        sensor_width_mm: float = 36.0,
        aspect: float = 16.0 / 9.0,
        width_px: int = 1920,
        detail_px: float = 2.0,
        name: str = "",
    ):
        self.position = _vec(position, "position")
        self.target = _vec(target, "target")
        if self.position == self.target:
            raise ValueError("a shot's position and target must differ")
        for label, v in (("focal_mm", focal_mm), ("sensor_width_mm", sensor_width_mm), ("aspect", aspect), ("width_px", width_px), ("detail_px", detail_px)):
            if not (isinstance(v, (int, float)) and math.isfinite(v) and v > 0):
                raise ValueError(f"{label} must be a positive number, got {v!r}")
        self.focal_mm = float(focal_mm)
        self.sensor_width_mm = float(sensor_width_mm)
        self.aspect = float(aspect)
        self.width_px = int(width_px)
        self.detail_px = float(detail_px)
        self.name = str(name)

        fx, fy, fz = (self.target[i] - self.position[i] for i in range(3))
        n = math.sqrt(fx * fx + fy * fy + fz * fz)
        self._forward = (fx / n, fy / n, fz / n)
        # right = forward x world up; looking straight down or up has no horizon, so the frame's top points along +z
        rx, ry, rz = (-self._forward[2], 0.0, self._forward[0])
        rn = math.sqrt(rx * rx + rz * rz)
        self._right = (rx / rn, 0.0, rz / rn) if rn > 1e-6 else (1.0, 0.0, 0.0)
        r, f = self._right, self._forward
        self._up = (r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0])

    @property
    def height_px(self) -> int:
        return max(1, int(round(self.width_px / self.aspect)))

    @property
    def focal_px(self) -> float:
        """The focal length in pixels: a 1 m object 1 m in front of the lens covers this many pixels."""
        return self.focal_mm / self.sensor_width_mm * self.width_px

    @property
    def horizontal_fov_deg(self) -> float:
        return math.degrees(2.0 * math.atan(self.sensor_width_mm / (2.0 * self.focal_mm)))

    @property
    def vertical_fov_deg(self) -> float:
        return math.degrees(2.0 * math.atan(self.sensor_width_mm / self.aspect / (2.0 * self.focal_mm)))

    def _camera_space(self, at: Point) -> Tuple[float, float, float]:
        p = _vec(at, "at")
        d = (p[0] - self.position[0], p[1] - self.position[1], p[2] - self.position[2])
        dot = lambda a: a[0] * d[0] + a[1] * d[1] + a[2] * d[2]
        return (dot(self._right), dot(self._up), dot(self._forward))

    def depth(self, at: Point) -> float:
        """Distance of a point in front of the lens, along the view axis, in metres (negative: behind the camera)."""
        return self._camera_space(at)[2]

    def pixels(self, size_m: float, at: Point) -> float:
        """How many pixels something `size_m` across covers at that point, facing the camera (0 behind the camera)."""
        z = self.depth(at)
        return float(size_m) * self.focal_px / z if z > 1e-6 else 0.0

    def min_feature_m(self, at: Point, pixels: Optional[float] = None) -> float:
        """The smallest size worth modelling at that point: what covers `pixels` (the shot's detail_px by default)."""
        z = self.depth(at)
        if z <= 1e-6:
            return math.inf
        return (self.detail_px if pixels is None else float(pixels)) * z / self.focal_px

    def resolves(self, size_m: float, at: Point, pixels: Optional[float] = None) -> bool:
        """True when something `size_m` across is at least the detail budget wide in the frame at that point."""
        return self.pixels(size_m, at) >= (self.detail_px if pixels is None else float(pixels))

    def member_m(self, nominal_m: float, at: Point, pixels: Optional[float] = None) -> float:
        """
        The size to build a thin member at so it still shows: its real size, or the smallest the shot resolves there
        when that is larger. Use it for a railing, a mullion or a bar of a feature whose overall size resolves: a fire
        escape 1.4 m deep is seen from 300 m even though its 4 cm bars are not, so build the bars at member_m(0.04, at)
        rather than leaving the fire escape out. Never more than eight times the real size: past that the feature
        itself is what does not resolve, and resolves() on its overall size says so.
        """
        return max(float(nominal_m), min(self.min_feature_m(at, pixels), float(nominal_m) * 8.0))

    @property
    def right(self) -> Tuple[float, float, float]:
        """The frame's right in world space (unit vector): frame left is the opposite. Looking down -z, right is +x."""
        return self._right

    @property
    def up(self) -> Tuple[float, float, float]:
        """The frame's up in world space (unit vector)."""
        return self._up

    @property
    def forward(self) -> Tuple[float, float, float]:
        """The view direction in world space (unit vector)."""
        return self._forward

    def frame_point(self, x: float, y: float, depth: float) -> Tuple[float, float, float]:
        """
        The world point seen at frame position (x, y) at `depth` metres in front of the lens: x from -1 (left edge) to
        1 (right edge), y from -1 (bottom) to 1 (top). Place what the request puts on the left of the frame at x < 0
        and on the right at x > 0, and read its world coordinates from here instead of guessing which axis is left.
        """
        hw = self.width_px * 0.5 / self.focal_px * float(depth)
        hh = self.height_px * 0.5 / self.focal_px * float(depth)
        return tuple(self.position[i] + self._forward[i] * depth + self._right[i] * x * hw + self._up[i] * y * hh for i in range(3))  # type: ignore[return-value]

    def sun_azimuth_deg(self, frame_x: float) -> float:
        """
        The azimuth of a sun standing ahead of the camera toward frame position `frame_x` (-1 the left edge, 0 the
        centre, 1 the right edge; beyond 1 outside the frame, 3 well to the side), in the convention
        atmosphere_configure_scene and path_trace_render take: degrees clockwise from -z (north), 90 toward +x.
        "Ahead and to the left" is sun_azimuth_deg(-1.5), "behind the camera" is that azimuth plus 180.
        """
        hw = self.width_px * 0.5 / self.focal_px
        dx = self._forward[0] + self._right[0] * frame_x * hw
        dz = self._forward[2] + self._right[2] * frame_x * hw
        if abs(dx) < 1e-12 and abs(dz) < 1e-12:
            dx, dz = self._up[0], self._up[2]  # looking straight down: ahead is the frame's top
        return math.degrees(math.atan2(dx, -dz)) % 360.0

    def sees(self, at: Point, margin: float = 0.0) -> bool:
        """True when the point is in front of the lens and inside the frame (`margin`: extra frame, 0.1 = 10 %)."""
        x, y, z = self._camera_space(at)
        if z <= 1e-6:
            return False
        half_w = self.width_px * 0.5 * (1.0 + margin)
        half_h = self.height_px * 0.5 * (1.0 + margin)
        return abs(x * self.focal_px / z) <= half_w and abs(y * self.focal_px / z) <= half_h

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "position": list(self.position),
            "target": list(self.target),
            "focalMm": self.focal_mm,
            "sensorWidthMm": self.sensor_width_mm,
            "aspect": self.aspect,
            "widthPx": self.width_px,
            "detailPx": self.detail_px,
        }

    def __repr__(self) -> str:
        return (f"Shot({self.name or 'unnamed'}: {self.focal_mm:g} mm, {self.width_px}x{self.height_px}, "
                f"from {self.position} to {self.target})")


def shots_path() -> Optional[str]:
    """Where a run's declared shots are written: beside the GLB the run is expected to write."""
    out = os.environ.get("OUTPUT_GLB_PATH")
    return f"{out}.shots.json" if out else None


def _write_shots() -> None:
    path = shots_path()
    if not path:
        return
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"shots": [s.to_dict() for s in _SHOTS]}, f)


def shot(
    position: Point,
    target: Point,
    focal_mm: float = 35.0,
    sensor_width_mm: float = 36.0,
    aspect: float = 16.0 / 9.0,
    width_px: int = 1920,
    detail_px: float = 2.0,
    name: str = "",
) -> Shot:
    """Declare a camera the scene is built for.

    The first shot declared is the one the scene opens on and is reviewed from; declare further shots for other
    angles, and detail counts as seen when any shot resolves it.
    """
    s = Shot(position, target, focal_mm, sensor_width_mm, aspect, width_px, detail_px, name or f"shot {len(_SHOTS) + 1}")
    _SHOTS.append(s)
    _write_shots()
    return s


def declared_shots() -> List[Shot]:
    """The shots this run has declared, in order."""
    return list(_SHOTS)


def resolves(size_m: float, at: Point) -> bool:
    """True when any declared shot resolves something `size_m` across at that point; True when no shot is declared."""
    return not _SHOTS or any(s.resolves(size_m, at) for s in _SHOTS)


def member_m(nominal_m: float, at: Point) -> float:
    """The size to build a thin member at so some declared shot shows it: the least any shot needs; its real size with no shot."""
    if not _SHOTS:
        return float(nominal_m)
    return min(s.member_m(nominal_m, at) for s in _SHOTS)


def min_feature_m(at: Point) -> float:
    """The smallest size any declared shot resolves at that point, in metres; 0 when no shot is declared."""
    return min((s.min_feature_m(at) for s in _SHOTS), default=0.0)
