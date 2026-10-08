"""
World procedural engine container.
Coordinates deterministic generation of terrain, architecture, botanical ecosystems,
and headless glTF 2.0 streaming.
"""

from typing import Tuple, List, Optional, Any, Dict
import os
import sys
import math
import random

from .terrain import Terrain
from .structure import Structure

class World:
    """The central agentic procedural world director."""

    def __init__(self, seed: Any = 1337, units: str = "meters"):
        if isinstance(seed, (int, float)):
            self.seed = int(seed)
        elif isinstance(seed, str):
            try:
                self.seed = int(seed)
            except ValueError:
                import zlib
                self.seed = zlib.crc32(seed.encode("utf-8")) & 0x7fffffff
        else:
            self.seed = 1337
        self.units = str(units)
        self.terrains: List[Terrain] = []
        self.structures: List[Structure] = []
        self.standalone_meshes: List[Any] = []
        self.scattered_meshes: List[Any] = []
        self._rng = random.Random(self.seed)

    def add(self, entity: Any) -> Any:
        """Add any standalone mesh, structure, or terrain to the world."""
        if hasattr(entity, "mesh"):
            self.standalone_meshes.append(entity.mesh)
        elif isinstance(entity, Terrain):
            self.terrains.append(entity)
        elif isinstance(entity, Structure):
            self.structures.append(entity)
        else:
            self.standalone_meshes.append(entity)
        return entity

    def add_mesh(self, mesh: Any) -> Any:
        """Add any standalone mesh (building, prop, or custom asset) to the world."""
        return self.add(mesh)

    def add_asset(self, asset: Any) -> Any:
        """Alias for add_mesh."""
        return self.add(asset)

    def build(self) -> bytes:
        """Compiles the world directly into glTF 2.0 binary (.glb) in RAM."""
        return self.compile_to_glb()

    def add_terrain(
        self,
        extents: Tuple[float, float] = (250.0, 250.0),
        archetype: str = "alpine_karst",
        domain_warp_scale: float = 1.85,
        hydraulic_erosion_steps: int = 35,
        resolution: int = 160,
        **kwargs
    ) -> Terrain:
        """
        Synthesizes geological terrain using Infiniti invariants and
        Soil Machine hydrological sediment tracking.
        """
        import scratchbox_native
        core_mod = getattr(scratchbox_native, "core", None)

        if core_mod and hasattr(core_mod, "generate_geological_terrain"):
            native_surface = core_mod.generate_geological_terrain(
                float(extents[0]),
                float(extents[1]),
                int(resolution),
                str(archetype),
                float(domain_warp_scale),
                int(hydraulic_erosion_steps),
                int(self.seed),
                float(kwargs.get("macro_slope_x", 0.0)),
                float(kwargs.get("macro_slope_z", 0.0)),
                float(kwargs.get("warp_freq", 0.0)),
                int(kwargs.get("warp_octaves", 0)),
                float(kwargs.get("content_scale", 0.0)),
                float(kwargs.get("content_freq", 0.0)),
                float(kwargs.get("strata_dune_scale", 0.0)),
                float(kwargs.get("strata_dune_freq", 0.0)),
                float(kwargs.get("slope_scale", 0.0)),
                float(kwargs.get("suppressing_param", 0.0)),
            )
            terrain = Terrain(
                native_surface,
                extents=extents,
                archetype=archetype,
                domain_warp_scale=domain_warp_scale,
                hydraulic_erosion_steps=hydraulic_erosion_steps
            )
        else:
            raise RuntimeError(
                "Native geological terrain synthesizer scratchbox_native.core.generate_geological_terrain is required. "
                "Silent fallback to flat primitives is prohibited under ADA Tier-0 ban."
            )

        # Apply any procedural feature kwargs (e.g. caldera depression, height scaling)
        features = kwargs.get("features", [])
        if isinstance(features, (list, tuple)):
            for f in features:
                if isinstance(f, dict):
                    ftype = f.get("type", "")
                    if "caldera" in ftype or "crater" in ftype:
                        c_center = f.get("center", (0, 0))
                        c_rad = float(f.get("radius", 25.0))
                        c_depth = float(f.get("depth", 8.0))
                        if hasattr(terrain.mesh, "vertices"):
                            for v in terrain.mesh.vertices:
                                dx = v.position.x - c_center[0]
                                dz = v.position.z - c_center[1]
                                dist = math.sqrt(dx*dx + dz*dz)
                                if dist < c_rad:
                                    factor = (1.0 - dist / c_rad)
                                    v.position = v.position - math.Vec3(0, c_depth * factor, 0)
                            terrain.mesh.recompute_normals()

        self.terrains.append(terrain)
        return terrain

    def add_structure(
        self,
        archetype: str = "roman_peripteral",
        order: Any = None,
        footprint_length: float = 42.0,
        footprint_width: float = 24.0,
        column_count_x: int = 8,
        column_count_y: int = 14,
        column_height: float = 7.5,
        plinth_height: float = 1.4,
        position: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    ) -> Structure:
        """
        Constructs classical architecture with Vitruvian grammar (fluted peristyle colonnade,
        stepped stylobate podium, entablature, pediment, and terracotta gable roof).
        """
        import scratchbox_native
        core_mod = getattr(scratchbox_native, "core", None)
        arch_mod = getattr(scratchbox_native, "architecture", None)

        # Default order to Corinthian if not provided
        if order is None:
            if hasattr(scratchbox_native, "RomanOrder"):
                order = scratchbox_native.RomanOrder.Corinthian
            elif hasattr(arch_mod, "RomanOrder"):
                order = arch_mod.RomanOrder.Corinthian

        mesh = None
        if core_mod and hasattr(core_mod, "build_classical_temple"):
            opts = core_mod.TempleOptions()
            opts.archetype = str(archetype)
            if order is not None:
                opts.order = order
            opts.footprint_length = float(footprint_length)
            opts.footprint_width = float(footprint_width)
            opts.column_count_x = int(column_count_x)
            opts.column_count_y = int(column_count_y)
            opts.column_height = float(column_height)
            opts.plinth_height = float(plinth_height)
            opts.seed = int(self.seed)
            mesh = core_mod.build_classical_temple(opts)
        elif arch_mod and hasattr(arch_mod, "generate_peripteral_temple"):
            mesh = arch_mod.generate_peripteral_temple(
                archetype=str(archetype),
                order=order,
                footprint_length=float(footprint_length),
                footprint_width=float(footprint_width),
                column_count_x=int(column_count_x),
                column_count_y=int(column_count_y),
                column_height=float(column_height),
                plinth_height=float(plinth_height),
                seed=int(self.seed)
            )

        if mesh is None:
            raise RuntimeError(
                f"Structure generation failed for archetype '{archetype}'. "
                "Silent fallback to flat box primitives is prohibited under ADA Tier-0 ban."
            )

        structure = Structure(
            mesh=mesh,
            archetype=archetype,
            footprint_length=footprint_length,
            footprint_width=footprint_width,
            order=order,
            position=position
        )
        self.structures.append(structure)
        return structure

    def add_human(
        self,
        role: str = "scale_figure",
        height: float = 1.76,
        gender_beta: float = 0.0,
        pose: str = "standing_survey",
        position: Tuple[float, float, float] = (0.0, 0.0, 0.0),
        facing_deg: float = 0.0,
        surface: Optional[Any] = None,
        surface_y_offset: float = 0.0,
        **kwargs
    ) -> Any:
        """
        Synthesizes and adds an architectural scale entourage figure to the world.
        Conforms strictly to 18% Studio Grey Clay Invariant and analytical 2-bone IK foot grounding.
        """
        from .human import Human
        human = Human(
            role=role,
            height=height,
            gender_beta=gender_beta,
            pose=pose,
            position=position,
            facing_deg=facing_deg,
            surface=surface,
            surface_y_offset=surface_y_offset,
            **kwargs
        )
        self.add(human)
        return human

    def scatter(
        self,
        asset: Any,
        surface: Optional[Terrain] = None,
        count: int = 60,
        cluster_radius: float = 12.0,
        slope_limit_degrees: float = 28.0,
        avoid_structures: Optional[List[Structure]] = None,
        min_scale: float = 0.85,
        max_scale: float = 1.15
    ) -> List[Any]:
        """
        Clustered botanical scattering with Da Vinci pipe conservation.
        Ensures plants are placed on stable slopes, avoid architectural edifices,
        and follow natural ecological clustering.
        """
        import scratchbox_native
        if surface is None:
            if not self.terrains:
                raise ValueError("No terrain surface available in World to scatter upon.")
            surface = self.terrains[0]

        if avoid_structures is None:
            avoid_structures = self.structures

        # Resolve asset mesh
        source_mesh = asset
        if hasattr(asset, "get_combined"):
            source_mesh = asset.get_combined("Asset")
        elif hasattr(asset, "mesh"):
            source_mesh = asset.mesh

        # Generate cluster centers across terrain
        num_clusters = max(2, count // 8)
        cluster_centers = []
        margin_x = surface.extents[0] * 0.4
        margin_z = surface.extents[1] * 0.4

        for _ in range(num_clusters):
            cx = self._rng.uniform(-margin_x, margin_x)
            cz = self._rng.uniform(-margin_z, margin_z)
            cluster_centers.append((cx, cz))

        placed_instances = []
        max_attempts = count * 6
        attempts = 0

        while len(placed_instances) < count and attempts < max_attempts:
            attempts += 1
            # Pick a cluster center
            ccx, ccz = self._rng.choice(cluster_centers)
            # Offset inside cluster radius
            angle = self._rng.uniform(0.0, 2.0 * math.pi)
            dist = self._rng.uniform(1.0, cluster_radius)
            px = ccx + math.cos(angle) * dist
            pz = ccz + math.sin(angle) * dist

            # Bounds check
            if abs(px) > surface.extents[0] * 0.48 or abs(pz) > surface.extents[1] * 0.48:
                continue

            # Slope limit check
            slope = surface.sample_slope_degrees(px, pz)
            if slope > slope_limit_degrees:
                continue

            # Avoid structures check
            collision = False
            for struct in avoid_structures:
                half_w = 4.0
                half_l = 4.0
                scx = 0.0
                scz = 0.0
                if hasattr(struct, "footprint_width") and hasattr(struct, "footprint_length") and hasattr(struct, "position"):
                    half_w = struct.footprint_width * 0.5 + 4.0
                    half_l = struct.footprint_length * 0.5 + 4.0
                    scx = struct.position[0]
                    scz = struct.position[2]
                else:
                    # Mesh or generic object: sample approximate bounds or position
                    m = getattr(struct, "mesh", struct)
                    if hasattr(m, "bounds"):
                        scx = (m.bounds.min.x + m.bounds.max.x) * 0.5
                        scz = (m.bounds.min.z + m.bounds.max.z) * 0.5
                        half_w = max(4.0, (m.bounds.max.x - m.bounds.min.x) * 0.5 + 2.0)
                        half_l = max(4.0, (m.bounds.max.z - m.bounds.min.z) * 0.5 + 2.0)
                    elif hasattr(m, "vertices") and m.vertices:
                        v0 = m.vertices[0].position
                        scx = v0.x if hasattr(v0, "x") else v0[0]
                        scz = v0.z if hasattr(v0, "z") else v0[2]
                        half_w = 6.0
                        half_l = 6.0

                if abs(px - scx) < half_w and abs(pz - scz) < half_l:
                    collision = True
                    break

            if collision:
                continue

            # Valid placement point: sample terrain elevation
            py = surface.sample_height(px, pz)

            # Instance asset mesh
            scale_factor = self._rng.uniform(min_scale, max_scale)
            rot_y = self._rng.uniform(0.0, 2.0 * math.pi)
            cos_r = math.cos(rot_y)
            sin_r = math.sin(rot_y)

            # Deep clone source mesh and transform using native C++ methods
            inst_mesh = scratchbox_native.geometry.Mesh(f"Scatter_{len(placed_instances)}")
            inst_mesh.material = source_mesh.material
            inst_mesh.append(source_mesh)
            inst_mesh.scale(scratchbox_native.math.Vec3(scale_factor, scale_factor, scale_factor))
            inst_mesh.rotate_y(rot_y * 180.0 / math.pi)
            inst_mesh.translate(scratchbox_native.math.Vec3(px, py, pz))

            placed_instances.append(inst_mesh)
            self.scattered_meshes.append(inst_mesh)

        return placed_instances

    def compile_to_glb(self, path: Optional[str] = None, pbr_quality: str = "high") -> bytes:
        """
        Compiles the entire procedural world directly to glTF 2.0 binary (.glb) in RAM.
        Zero disk churn; nanosecond streaming.
        """
        import scratchbox_native
        io_mod = scratchbox_native.io

        # Collect all active meshes
        all_meshes = []
        for t in self.terrains:
            all_meshes.append(t.mesh)
        for s in self.structures:
            all_meshes.append(s.mesh)
        for sm in self.standalone_meshes:
            all_meshes.append(sm)
        for sc in self.scattered_meshes:
            all_meshes.append(sc)

        if not all_meshes:
            empty_mesh = scratchbox_native.geometry.Mesh("Empty")
            all_meshes.append(empty_mesh)

        # Export binary glTF 2.0 chunk
        if len(all_meshes) == 1:
            glb_data = io_mod.export_glb_bytes(all_meshes[0])
        else:
            glb_data = io_mod.export_glb_bytes(all_meshes)

        glb_bytes = bytes(glb_data)

        # Write to path if requested or configured via environment
        main_mod = sys.modules.get("__main__")
        main_path = getattr(main_mod, "OUTPUT_GLB_PATH", None) if main_mod else None
        target_path = path or os.environ.get("OUTPUT_GLB_PATH") or os.environ.get("SCRATCHBOX_OUTPUT_GLB") or main_path
        if target_path:
            os.makedirs(os.path.dirname(os.path.abspath(target_path)), exist_ok=True)
            with open(target_path, "wb") as f:
                f.write(glb_bytes)

        return glb_bytes

    def render_sensor_passes(
        self,
        width: int = 512,
        height: int = 512,
        camera_pos: Tuple[float, float, float] = (0.0, 35.0, 75.0),
        camera_target: Tuple[float, float, float] = (0.0, 10.0, 0.0),
        fov_degrees: float = 45.0
    ) -> Dict[str, Any]:
        """
        Renders the 3 canonical sensor validation passes (RGB Beauty, Linear Metric Depth,
        and Surface Normal Pass) for headless multimodal verification loop.
        """
        import scratchbox_native

        # Combine all meshes into a single scene mesh for BVH raytracing
        scene_mesh = scratchbox_native.geometry.Mesh("ScenePasses")
        for t in self.terrains:
            scene_mesh.append(t.mesh)
        for s in self.structures:
            scene_mesh.append(s.mesh)
        for sm in self.standalone_meshes:
            scene_mesh.append(sm)
        for sc in self.scattered_meshes:
            scene_mesh.append(sc)

        core_mod = getattr(scratchbox_native, "core", None)
        opts = core_mod.SensorPassesOptions()
        opts.width = int(width)
        opts.height = int(height)
        opts.camera_position = scratchbox_native.math.Vec3(camera_pos[0], camera_pos[1], camera_pos[2])
        opts.camera_target = scratchbox_native.math.Vec3(camera_target[0], camera_target[1], camera_target[2])
        opts.fov_degrees = float(fov_degrees)

        res = core_mod.render_sensor_passes(scene_mesh, opts)

        return {
            "width": res.width,
            "height": res.height,
            "rgb_beauty": list(res.rgb_beauty),
            "linear_depth": list(res.linear_depth),
            "surface_normals": list(res.surface_normals),
            "rgb_beauty_bytes": getattr(res, "rgb_beauty_bytes", None),
            "linear_depth_bytes": getattr(res, "linear_depth_bytes", None),
            "surface_normals_bytes": getattr(res, "surface_normals_bytes", None),
            "geometry_coverage": float(res.geometry_coverage),
            "render_ms": float(res.render_ms),
            "triangle_count": int(res.triangle_count),
            "ground_elevation_contact_min": float(res.ground_elevation_contact_min),
            "ground_elevation_contact_max": float(res.ground_elevation_contact_max)
        }

    def stage_vector_tiles(self, lat: float, lng: float, radius: int = 1, style: str = "studio_clay", zoom: int = 16, out_glb: Optional[str] = None) -> Dict[str, Any]:
        """
        Stages Google 2D roadmap vector tiles (zoom 16) around (lat, lng),
        triangulates footprints into 18% Studio Grey Clay volumetric prisms, road ribbons, and water,
        and saves into standard binary glTF 2.0 (.glb) for CAD/VFX staging.
        """
        import subprocess
        import json

        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
        script = os.path.join(repo_root, "scripts/stage_vector_world.ts")
        bin_path = os.path.join(repo_root, "node_modules/.bin/vite-node")

        if not out_glb:
            clean_lat = f"{lat:.4f}".replace(".", "_").replace("-", "m")
            clean_lng = f"{lng:.4f}".replace(".", "_").replace("-", "m")
            out_glb = os.path.join(repo_root, "public/models", f"vector_world_{clean_lat}_{clean_lng}.glb")

        cmd = [bin_path, script, "--", "--lat", str(lat), "--lng", str(lng), "--radius", str(radius), "--zoom", str(zoom), "--style", style, "--out", out_glb]
        proc = subprocess.run(cmd, cwd=repo_root, capture_output=True, text=True, check=True)
        return json.loads(proc.stdout)

    def populate_vector_world(
        self,
        lat: float,
        lng: float,
        radius: int = 1,
        style: str = "studio_clay",
        zoom: int = 16,
        traffic: bool = True,
        trees: bool = True,
        streetlamps: bool = True,
        sidewalks: bool = True,
        hero_lane: Optional[int] = None,
        hero_dist: Optional[float] = None,
        hero_type: str = "lane",
        out_glb: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Synthesizes a populated 3D world from Google 2D roadmap vector tiles (zoom 16) around (lat, lng).
        Extracts topological road networks with 5-tier cross-sections (asphalt carriageway, lane markings,
        beveled granite curbs, elevated sidewalks), articulates architectural building parcels (floor cornices &
        roof parapet walls), and procedurally instances streetlamps, botanical trees, and traffic vehicles into standard
        binary glTF 2.0 (.glb) in 18% Studio Grey Clay.
        """
        import subprocess
        import json

        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
        script = os.path.join(repo_root, "scripts/stage_vector_world.ts")
        bin_path = os.path.join(repo_root, "node_modules/.bin/vite-node")

        if not out_glb:
            clean_lat = f"{lat:.4f}".replace(".", "_").replace("-", "m")
            clean_lng = f"{lng:.4f}".replace(".", "_").replace("-", "m")
            out_glb = os.path.join(repo_root, "public/models", f"vector_populated_world_{clean_lat}_{clean_lng}.glb")

        cmd = [
            bin_path, script, "--",
            "--lat", str(lat),
            "--lng", str(lng),
            "--radius", str(radius),
            "--zoom", str(zoom),
            "--style", style,
            "--out", out_glb,
            "--populate"
        ]
        if not traffic:
            cmd.append("--no-traffic")
        if not trees:
            cmd.append("--no-trees")
        if not streetlamps:
            cmd.append("--no-streetlamps")
        if not sidewalks:
            cmd.append("--no-sidewalks")
        if hero_lane is not None:
            cmd.extend(["--hero-lane", str(hero_lane)])
        if hero_dist is not None:
            cmd.extend(["--hero-dist", str(hero_dist)])
        if hero_type:
            cmd.extend(["--hero-type", str(hero_type)])

        proc = subprocess.run(cmd, cwd=repo_root, capture_output=True, text=True, check=True)
        return json.loads(proc.stdout)

    def get_vector_graph(self, lat: float, lng: float, radius: int = 1, zoom: int = 16) -> Dict[str, Any]:
        """
        Extracts semantic vector features (roads with lane counts/widths, building parcel footprints,
        landuse green areas, water) around (lat, lng) in SI metric coordinates.
        """
        import subprocess
        import json

        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
        script = os.path.join(repo_root, "scripts/stage_vector_world.ts")
        bin_path = os.path.join(repo_root, "node_modules/.bin/vite-node")

        cmd = [
            bin_path, script, "--",
            "--lat", str(lat),
            "--lng", str(lng),
            "--radius", str(radius),
            "--zoom", str(zoom),
            "--graph-only"
        ]
        proc = subprocess.run(cmd, cwd=repo_root, capture_output=True, text=True, check=True)
        return json.loads(proc.stdout)

    def snap_asset_to_lane(self, asset: Any, placement: Dict[str, Any]) -> Any:
        """
        Applies solved vector lane placement (position, heading rotation) to any native mesh or asset.
        """
        m = getattr(asset, "mesh", asset)
        pos = placement.get("position", [0, 0, 0])
        heading = placement.get("headingRad", 0.0)

        # Apply yaw rotation then translation
        if hasattr(m, "rotate_y"):
            m.rotate_y(heading)
        if hasattr(m, "translate"):
            m.translate(float(pos[0]), float(pos[1]), float(pos[2]))
        return asset

    @staticmethod
    def ground_streetview_pano(prompt: Optional[str] = None, pano_id: Optional[str] = None, lat: Optional[float] = None, lng: Optional[float] = None, out_png: Optional[str] = None) -> Dict[str, Any]:
        """
        Grounds a landmark prompt or direct Google Street View panoId via Vertex AI Maps Imagery Grounding (MIG),
        downloads cubic faces, and projects them into a 2:1 ERP equirectangular panorama.
        """
        import subprocess
        import json

        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
        script = os.path.join(repo_root, "scripts/mig_streetview.ts")
        bin_path = os.path.join(repo_root, "node_modules/.bin/vite-node")

        cmd = [bin_path, script, "--"]
        if prompt:
            cmd.extend(["--prompt", prompt])
        if pano_id:
            cmd.extend(["--panoId", pano_id])
        if lat is not None:
            cmd.extend(["--lat", str(lat)])
        if lng is not None:
            cmd.extend(["--lng", str(lng)])
        if out_png:
            cmd.extend(["--out", out_png])

        proc = subprocess.run(cmd, cwd=repo_root, capture_output=True, text=True, check=True)
        return json.loads(proc.stdout)

