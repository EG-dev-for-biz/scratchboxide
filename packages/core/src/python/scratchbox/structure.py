"""
Structure representation in Scratchbox Procedural Engine.
Supports terrain alignment, spatial transforms, and collision footprint extraction.
"""

from typing import Any, Optional, Tuple
import math

class Structure:
    """Procedural architectural structure adhering to Vitruvian tectonic grammar."""

    def __init__(
        self,
        mesh: Any,
        archetype: str,
        footprint_length: float,
        footprint_width: float,
        order: Any = None,
        position: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    ):
        self.mesh = mesh
        self.archetype = archetype
        self.footprint_length = footprint_length
        self.footprint_width = footprint_width
        self.order = order
        self.position = list(position)

    def align_to_terrain(self, terrain: Any, offset_z: float = 0.2) -> "Structure":
        """
        Aligns the structure vertically to the terrain surface.
        Samples terrain elevation beneath the structure foundation to ensure 
        firm grounding without subterranean burial or floating artifacts.
        """
        cx = self.position[0]
        cz = self.position[2]
        half_l = self.footprint_length * 0.5
        half_w = self.footprint_width * 0.5

        # Sample foundation contact points (center + 4 corners + 4 edge midpoints)
        sample_pts = [
            (cx, cz),
            (cx - half_w, cz - half_l),
            (cx + half_w, cz - half_l),
            (cx - half_w, cz + half_l),
            (cx + half_w, cz + half_l),
            (cx, cz - half_l),
            (cx, cz + half_l),
            (cx - half_w, cz),
            (cx + half_w, cz)
        ]

        ground_elevations = [terrain.sample_height(x, z) for x, z in sample_pts]
        target_ground_y = max(ground_elevations)

        # Find current lowest vertex in structure mesh
        min_y = 1e9
        if hasattr(self.mesh, "vertices"):
            for v in self.mesh.vertices:
                vy = v.position.y if hasattr(v.position, "y") else v.position[1]
                if vy < min_y:
                    min_y = vy
        elif hasattr(self.mesh, "bounds"):
            min_y = self.mesh.bounds.min.y if hasattr(self.mesh.bounds.min, "y") else self.mesh.bounds.min[1]
        else:
            min_y = 0.0

        if min_y > 1e8:
            min_y = 0.0

        # Translate mesh vertically so base sits firmly on terrain
        delta_y = (target_ground_y + offset_z) - min_y
        self.translate(0.0, delta_y, 0.0)
        return self

    def translate(self, dx: Any, dy: Optional[float] = None, dz: Optional[float] = None) -> "Structure":
        """Translate the structure by (dx, dy, dz) meters or by a Vec3 / tuple."""
        if dy is None and dz is None:
            if hasattr(dx, "x") and hasattr(dx, "y") and hasattr(dx, "z"):
                offset_x, offset_y, offset_z = float(dx.x), float(dx.y), float(dx.z)
            elif isinstance(dx, (tuple, list)) and len(dx) >= 3:
                offset_x, offset_y, offset_z = float(dx[0]), float(dx[1]), float(dx[2])
            else:
                offset_x, offset_y, offset_z = float(dx), 0.0, 0.0
        else:
            offset_x, offset_y, offset_z = float(dx), float(dy or 0.0), float(dz or 0.0)

        self.position[0] += offset_x
        self.position[1] += offset_y
        self.position[2] += offset_z

        if hasattr(self.mesh, "translate"):
            try:
                import scratchbox_native as _sn
                self.mesh.translate(_sn.math.Vec3(offset_x, offset_y, offset_z))
            except Exception:
                if hasattr(self.mesh, "vertices"):
                    for v in self.mesh.vertices:
                        if hasattr(v.position, "x"):
                            v.position.x += offset_x
                            v.position.y += offset_y
                            v.position.z += offset_z
                        else:
                            v.position[0] += offset_x
                            v.position[1] += offset_y
                            v.position[2] += offset_z
        elif hasattr(self.mesh, "vertices"):
            for v in self.mesh.vertices:
                if hasattr(v.position, "x"):
                    v.position.x += offset_x
                    v.position.y += offset_y
                    v.position.z += offset_z
                else:
                    v.position[0] += offset_x
                    v.position[1] += offset_y
                    v.position[2] += offset_z

        if hasattr(self.mesh, "recomputeBounds"):
            self.mesh.recomputeBounds()
        elif hasattr(self.mesh, "recompute_bounds"):
            self.mesh.recompute_bounds()

        return self

    def apply_material(self, mat: Any) -> "Structure":
        """Applies a PBR material to the underlying structure mesh."""
        if hasattr(self.mesh, "apply_material"):
            self.mesh.apply_material(mat)
        elif hasattr(self.mesh, "material"):
            self.mesh.material = mat
        return self

    def set_material(self, mat: Any) -> "Structure":
        """Sets the PBR material on the underlying structure mesh."""
        return self.apply_material(mat)

    def set_color(self, color: Any) -> "Structure":
        """Sets vertex color or base tint on the underlying structure mesh."""
        if hasattr(self.mesh, "set_color"):
            self.mesh.set_color(color)
        return self

    @property
    def material(self) -> Any:
        return getattr(self.mesh, "material", None)

    @material.setter
    def material(self, mat: Any) -> None:
        self.apply_material(mat)

    def get_mesh(self) -> Any:
        return self.mesh

    def get_bounding_box(self) -> Tuple[Tuple[float, float, float], Tuple[float, float, float]]:
        """Returns ((min_x, min_y, min_z), (max_x, max_y, max_z)) of structure."""
        if hasattr(self.mesh, "bounds"):
            b = self.mesh.bounds
            min_pt = (
                float(b.min.x if hasattr(b.min, "x") else b.min[0]),
                float(b.min.y if hasattr(b.min, "y") else b.min[1]),
                float(b.min.z if hasattr(b.min, "z") else b.min[2])
            )
            max_pt = (
                float(b.max.x if hasattr(b.max, "x") else b.max[0]),
                float(b.max.y if hasattr(b.max, "y") else b.max[1]),
                float(b.max.z if hasattr(b.max, "z") else b.max[2])
            )
            return (min_pt, max_pt)
        elif hasattr(self.mesh, "vertices") and len(self.mesh.vertices) > 0:
            xs = [v.position.x if hasattr(v.position, "x") else v.position[0] for v in self.mesh.vertices]
            ys = [v.position.y if hasattr(v.position, "y") else v.position[1] for v in self.mesh.vertices]
            zs = [v.position.z if hasattr(v.position, "z") else v.position[2] for v in self.mesh.vertices]
            return ((min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs)))
        else:
            hw = self.footprint_width * 0.5
            hl = self.footprint_length * 0.5
            return (
                (self.position[0] - hw, self.position[1], self.position[2] - hl),
                (self.position[0] + hw, self.position[1] + 20.0, self.position[2] + hl)
            )

    def find_mount_plane(self, face: str = "front") -> dict:
        """
        Calculates the 3D origin, normal, tangent basis vectors (u, v), and dimensions
        for an exterior façade mount plane (e.g. for fire escapes, signs, awnings).
        """
        (min_x, min_y, min_z), (max_x, max_y, max_z) = self.get_bounding_box()
        cx = (min_x + max_x) * 0.5
        cy = (min_y + max_y) * 0.5
        cz = (min_z + max_z) * 0.5
        w = max_x - min_x
        h = max_y - min_y
        d = max_z - min_z

        face_lower = face.lower()
        if face_lower in ("front", "south", "+z"):
            return {
                "face": "front",
                "center": (cx, cy, max_z),
                "normal": (0.0, 0.0, 1.0),
                "u_dir": (1.0, 0.0, 0.0),
                "v_dir": (0.0, 1.0, 0.0),
                "width": w,
                "height": h
            }
        elif face_lower in ("back", "rear", "north", "-z"):
            return {
                "face": "back",
                "center": (cx, cy, min_z),
                "normal": (0.0, 0.0, -1.0),
                "u_dir": (-1.0, 0.0, 0.0),
                "v_dir": (0.0, 1.0, 0.0),
                "width": w,
                "height": h
            }
        elif face_lower in ("right", "east", "+x"):
            return {
                "face": "right",
                "center": (max_x, cy, cz),
                "normal": (1.0, 0.0, 0.0),
                "u_dir": (0.0, 0.0, -1.0),
                "v_dir": (0.0, 1.0, 0.0),
                "width": d,
                "height": h
            }
        elif face_lower in ("left", "west", "-x"):
            return {
                "face": "left",
                "center": (min_x, cy, cz),
                "normal": (-1.0, 0.0, 0.0),
                "u_dir": (0.0, 0.0, 1.0),
                "v_dir": (0.0, 1.0, 0.0),
                "width": d,
                "height": h
            }
        else:
            return {
                "face": "front",
                "center": (cx, cy, max_z),
                "normal": (0.0, 0.0, 1.0),
                "u_dir": (1.0, 0.0, 0.0),
                "v_dir": (0.0, 1.0, 0.0),
                "width": w,
                "height": h
            }

    def solve_mount_clearance(
        self,
        target_width: float,
        target_height: float,
        face: str = "front",
        obstacles: Optional[list] = None,
        safety_margin: float = 0.25
    ) -> dict:
        """
        Analytical 2D clearance interval solver.
        Finds a collision-free mounting interval on the building façade avoiding apertures.
        """
        plane = self.find_mount_plane(face)
        wall_w = plane["width"]
        wall_h = plane["height"]

        obs_list = obstacles or []
        half_w = wall_w * 0.5
        half_h = wall_h * 0.5

        # Check candidate U positions across façade
        step_u = 0.25
        best_u = 0.0
        best_margin = -1.0
        found = False

        min_u_search = -half_w + target_width * 0.5 + safety_margin
        max_u_search = half_w - target_width * 0.5 - safety_margin

        u = min_u_search
        while u <= max_u_search:
            collides = False
            min_dist = 1e6
            cand_left = u - target_width * 0.5
            cand_right = u + target_width * 0.5

            for obs in obs_list:
                obs_u = obs.get("u", 0.0)
                obs_w = obs.get("width", 1.2)
                obs_l = obs_u - obs_w * 0.5 - safety_margin
                obs_r = obs_u + obs_w * 0.5 + safety_margin

                if cand_right > obs_l and cand_left < obs_r:
                    collides = True
                    break
                dist = max(0.0, max(obs_l - cand_right, cand_left - obs_r))
                if dist < min_dist:
                    min_dist = dist

            if not collides:
                if min_dist > best_margin:
                    best_margin = min_dist
                    best_u = u
                    found = True
            u += step_u

        if not found:
            best_u = 0.0
            best_margin = 0.0

        center = plane["center"]
        u_dir = plane["u_dir"]
        norm = plane["normal"]

        mount_x = center[0] + u_dir[0] * best_u
        mount_y = center[1]
        mount_z = center[2] + u_dir[2] * best_u

        return {
            "found": found,
            "face": face,
            "center": (mount_x, mount_y, mount_z),
            "normal": norm,
            "u_offset": best_u,
            "clearance_margin_meters": max(0.0, best_margin)
        }

    def attach_to_mount(
        self,
        attachment: Any,
        face: str = "front",
        u_offset: float = 0.0,
        v_offset: float = 0.0,
        standoff_meters: float = 0.05
    ) -> "Structure":
        """
        Mounts an external accessory (e.g. fire escape, sign, awning) flush against
        the structure façade with zero air gap and exact normal orientation.
        """
        plane = self.find_mount_plane(face)
        cx, cy, cz = plane["center"]
        ux, uy, uz = plane["u_dir"]
        vx, vy, vz = plane["v_dir"]
        nx, ny, nz = plane["normal"]

        target_x = cx + ux * u_offset + vx * v_offset + nx * standoff_meters
        target_y = cy + uy * u_offset + vy * v_offset + ny * standoff_meters
        target_z = cz + uz * u_offset + vz * v_offset + nz * standoff_meters

        if hasattr(attachment, "translate"):
            attachment.translate(target_x, target_y, target_z)
        elif hasattr(attachment, "position"):
            attachment.position[0] += target_x
            attachment.position[1] += target_y
            attachment.position[2] += target_z

        return self

    def __getattr__(self, name: str) -> Any:
        """Transparently delegate any mesh methods to self.mesh."""
        if hasattr(self.mesh, name):
            return getattr(self.mesh, name)
        raise AttributeError(f"'Structure' object has no attribute '{name}'")

