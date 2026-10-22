"""
SB-Veggie trees: the one vegetation generator for every scene a script builds.

A tree is described by continuous measurements (where its trunk stands, its height, its crown's radii, where the
crown begins and where it is widest, the shape of its top, its trunk radius and its leaf colour) and grown natively by
the same SB-Veggie pipeline a staged location's trees are: space-colonisation branching inside the described crown,
SB-Veggie leaf clusters, the tree species library chosen by the crown's measurements, the tree texture library chosen
by appearance, and the viewport's levels of detail. Nothing is keyed on a species name: a label is free text.

Trees are not meshes. sb.create_tree returns an SbVeggieTree; add it to a scene with scene.merge(tree) /
scene.append(tree) / world.add(tree) (or pass it in the list given to sb.io.write_glb), and the GLB writer grows every
tree of the written scene in one native run and writes them into the same GLB, each tree a node with its levels of
detail and its SB-Veggie extras. translate / rotate_y / scale move a tree; a scene mesh the tree was merged into
carries it along when that mesh is moved.
"""

import hashlib
import json
import math
import os
import struct
from typing import Any, Iterable, List, Optional, Sequence, Tuple, Union

try:
    import scratchbox_native as _native
except ImportError:  # the package __init__ puts build_py on sys.path first
    _native = None

TREES_SCHEMA = "scratchbox.sb-veggie-trees/1"
SPECIES_INDEX = os.path.join("assets", "vegetation", "species", "index.json")
TEXTURE_INDEX = os.path.join("assets", "textures", "trees", "index.json")

# The bare growth knobs of the retired generators: they are not measurements of a tree, so they are refused with a pointer
# to the SB-Veggie description instead of being silently ignored.
_RETIRED_GROWTH_KNOBS = (
    "attractor_count", "perception_radius", "kill_radius", "branch_step_length", "base_radius", "tip_radius",
    "generate_leaves", "use_detailed_leaves", "leaf_density", "volumetric_density", "season", "material",
)


def _srgb_to_linear(c: float) -> float:
    c = min(1.0, max(0.0, float(c)))
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _leaf_linear_rgb(color: Any) -> Optional[List[float]]:
    """A leaf colour as sRGB (r, g, b[, a]) in 0..1, 0..255 ints, a '#rrggbb' string or an sb.math Vec3/Vec4 -> linear RGB."""
    if color is None:
        return None
    if isinstance(color, str):
        h = color.strip().lstrip("#")
        if len(h) != 6 or any(ch not in "0123456789abcdefABCDEF" for ch in h):
            raise ValueError(f"leaf_color {color!r} is not a '#rrggbb' colour")
        rgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    elif hasattr(color, "x") and hasattr(color, "y") and hasattr(color, "z"):
        rgb = [float(color.x), float(color.y), float(color.z)]
    else:
        vals = [float(v) for v in list(color)[:3]]
        if len(vals) != 3:
            raise ValueError("leaf_color needs three channels (r, g, b)")
        rgb = [v / 255.0 for v in vals] if max(vals) > 1.0 else vals
    return [round(_srgb_to_linear(v), 6) for v in rgb]


def _point3(p: Any) -> Tuple[float, float, float]:
    if hasattr(p, "x") and hasattr(p, "y") and hasattr(p, "z"):
        return float(p.x), float(p.y), float(p.z)
    vals = [float(v) for v in list(p)]
    if len(vals) == 2:
        return vals[0], 0.0, vals[1]
    if len(vals) < 3:
        raise ValueError("a position is (x, y, z) in metres")
    return vals[0], vals[1], vals[2]


class SbVeggieTree:
    """One SB-Veggie tree, described by measurements (metres, y up). Grown when the scene that holds it is written."""

    _next_id = 0

    def __init__(
        self,
        position: Any = (0.0, 0.0, 0.0),
        height: float = 10.0,
        crown_radius: Union[float, Sequence[float]] = 3.5,
        crown_base_height: Optional[float] = None,
        crown_widest_at: float = 0.5,
        crown_top_exponent: float = 2.0,
        trunk_radius: Optional[float] = None,
        leaf_color: Any = None,
        label: Optional[str] = None,
        name: Optional[str] = None,
    ):
        self.position = list(_point3(position))
        self.height = float(height)
        if isinstance(crown_radius, (int, float)):
            self.crown_radii = [float(crown_radius), float(crown_radius)]
        else:
            r = [float(v) for v in crown_radius]
            if len(r) != 2:
                raise ValueError("crown_radius is one radius or (along x, along z) in metres")
            self.crown_radii = r
        self.crown_base_height = None if crown_base_height is None else float(crown_base_height)
        self.crown_widest_at = float(crown_widest_at)
        self.crown_top_exponent = float(crown_top_exponent)
        self.trunk_radius = None if trunk_radius is None else float(trunk_radius)
        self.leaf_linear_rgb = _leaf_linear_rgb(leaf_color)
        self.label = None if label is None else str(label)[:200]
        self.name = name or (self.label or "SbVeggieTree")
        SbVeggieTree._next_id += 1
        self._uid = SbVeggieTree._next_id
        self._check()

    def _check(self) -> None:
        if not (self.height > 0.3):
            raise ValueError("an SB-Veggie tree's height must be more than 0.3 m")
        if not all(r > 0.1 for r in self.crown_radii):
            raise ValueError("an SB-Veggie tree's crown radii must be more than 0.1 m")
        if self.crown_base_height is not None and not (0 <= self.crown_base_height < 0.95 * self.height):
            raise ValueError("crown_base_height must be at least 0 and below 0.95 of the height")
        if not (0.0 <= self.crown_widest_at <= 0.9):
            raise ValueError("crown_widest_at is a share of the crown's depth in [0, 0.9] (0: widest at its base, a cone)")
        if not (0.5 <= self.crown_top_exponent <= 8.0):
            raise ValueError("crown_top_exponent is in [0.5, 8] (1: a cone, 2: a dome, more: a flatter top)")
        if self.trunk_radius is not None and not (0 < self.trunk_radius < 0.2 * self.height):
            raise ValueError("trunk_radius must be more than 0 and under 0.2 of the height")

    # -- moving a tree ------------------------------------------------------------------------------------------------
    def translate(self, *args) -> "SbVeggieTree":
        dx, dy, dz = _point3(args[0]) if len(args) == 1 else (float(args[0]), float(args[1]), float(args[2]))
        self.position = [self.position[0] + dx, self.position[1] + dy, self.position[2] + dz]
        return self

    def rotate_y(self, angle_deg: float) -> "SbVeggieTree":
        """Rotates the tree's position about the y axis through the origin (a crown is grown round, so it has no heading)."""
        a = math.radians(float(angle_deg))
        x, z = self.position[0], self.position[2]
        self.position[0] = x * math.cos(a) + z * math.sin(a)
        self.position[2] = -x * math.sin(a) + z * math.cos(a)
        if abs(self.crown_radii[0] - self.crown_radii[1]) > 1e-9 and abs(math.sin(a)) > 0.5:
            self.crown_radii = [self.crown_radii[1], self.crown_radii[0]]
        return self

    def scale(self, *args) -> "SbVeggieTree":
        """Scales position and size about the origin: one factor, or (sx, sy, sz) (sizes take sy for height, sx/sz for radii)."""
        if len(args) == 1 and isinstance(args[0], (int, float)):
            sx = sy = sz = float(args[0])
        else:
            sx, sy, sz = _point3(args[0]) if len(args) == 1 else (float(args[0]), float(args[1]), float(args[2]))
        self.position = [self.position[0] * sx, self.position[1] * sy, self.position[2] * sz]
        self.height *= sy
        self.crown_radii = [self.crown_radii[0] * abs(sx), self.crown_radii[1] * abs(sz)]
        if self.crown_base_height is not None:
            self.crown_base_height *= sy
        if self.trunk_radius is not None:
            self.trunk_radius *= (abs(sx) + abs(sz)) / 2.0
        self._check()
        return self

    def copy(self) -> "SbVeggieTree":
        t = SbVeggieTree.__new__(SbVeggieTree)
        t.__dict__.update({k: (list(v) if isinstance(v, list) else v) for k, v in self.__dict__.items()})
        SbVeggieTree._next_id += 1
        t._uid = SbVeggieTree._next_id
        return t

    @property
    def bounds_min(self) -> Tuple[float, float, float]:
        return (self.position[0] - self.crown_radii[0], self.position[1], self.position[2] - self.crown_radii[1])

    @property
    def bounds_max(self) -> Tuple[float, float, float]:
        return (self.position[0] + self.crown_radii[0], self.position[1] + self.height, self.position[2] + self.crown_radii[1])

    def to_spec(self) -> dict:
        spec = {
            "position": [round(v, 6) for v in self.position],
            "heightM": self.height,
            "crownRadiiM": list(self.crown_radii),
            "crownWidestAt": self.crown_widest_at,
            "crownTopExponent": self.crown_top_exponent,
        }
        if self.crown_base_height is not None:
            spec["crownBaseHeightM"] = self.crown_base_height
        if self.trunk_radius is not None:
            spec["trunkRadiusM"] = self.trunk_radius
        if self.leaf_linear_rgb is not None:
            spec["leafLinearRgb"] = list(self.leaf_linear_rgb)
        if self.label:
            spec["label"] = self.label
        return spec

    def __getattr__(self, name: str):
        # Mesh operations do not apply: a tree is grown natively with its levels of detail when the scene is written.
        if name.startswith("__") or name in ("mesh", "_sub_parts", "_sb_veggie_trees", "compile_to_glb", "get_combined"):
            raise AttributeError(name)
        raise AttributeError(
            f"SbVeggieTree has no '{name}': an SB-Veggie tree is not a mesh. Move it with translate / rotate_y / scale, "
            "and add it to the scene with scene.merge(tree) or world.add(tree); it is grown when the scene is written."
        )

    def __repr__(self) -> str:
        return (f"SbVeggieTree(position={tuple(round(v, 3) for v in self.position)}, height={self.height:.2f}, "
                f"crown_radius={tuple(round(v, 3) for v in self.crown_radii)}, label={self.label!r})")


def create_tree(
    position: Any = None,
    height: Optional[float] = None,
    crown_radius: Union[float, Sequence[float], None] = None,
    crown_base_height: Optional[float] = None,
    crown_widest_at: float = 0.5,
    crown_top_exponent: float = 2.0,
    trunk_radius: Optional[float] = None,
    leaf_color: Any = None,
    label: Optional[str] = None,
    name: Optional[str] = None,
    **kwargs,
) -> SbVeggieTree:
    """
    One SB-Veggie tree described by measurements (metres): position = trunk base (x, y, z); height = base to crown top;
    crown_radius = crown half-spread (or (along x, along z)); crown_base_height = lowest crown above the base (None: from
    the species library by the crown's shape); crown_widest_at = share of the crown's depth where it is widest (0: a cone
    widest at its base, 0.5: a round crown, 0.8: an umbrella); crown_top_exponent = top profile (1 cone, 2 dome, 4 flat);
    trunk_radius (None: from the species); leaf_color = sRGB (r, g, b) / '#rrggbb' (chooses species and leaf textures);
    label = free text. Grown natively (space colonisation + SB-Veggie leaf clusters + levels of detail) when written.
    """
    # Measurements given in the retired generators' terms are read as measurements; their growth knobs are refused.
    pos = kwargs.pop("pos", None) or kwargs.pop("root_anchor", None) or kwargs.pop("root_position", None)
    crown_center = kwargs.pop("crown_center", None)
    crown_extents = kwargs.pop("crown_extents", None)
    clear_trunk = kwargs.pop("clear_trunk_height", None)
    retired = [k for k in kwargs if k in _RETIRED_GROWTH_KNOBS]
    if retired:
        raise TypeError(
            f"sb.create_tree() does not take {', '.join(retired)}: trees are SB-Veggie trees grown from measurements "
            "(position, height, crown_radius, crown_base_height, crown_widest_at, crown_top_exponent, trunk_radius, "
            "leaf_color, label); the branching, leaves and levels of detail come from the SB-Veggie grower."
        )
    if kwargs:
        raise TypeError(f"sb.create_tree() got unexpected arguments: {', '.join(sorted(kwargs))}")
    if position is None:
        if pos is not None:
            position = pos
        elif crown_center is not None:
            cc0 = _point3(crown_center)
            position = (cc0[0], 0.0, cc0[2])
        else:
            position = (0.0, 0.0, 0.0)
    base = _point3(position)
    if crown_center is not None and crown_extents is not None and (height is None or crown_radius is None):
        cc, ce = _point3(crown_center), _point3(crown_extents)
        if height is None:
            height = cc[1] + ce[1] - base[1]
        if crown_radius is None:
            crown_radius = (ce[0], ce[2])
        if crown_base_height is None and clear_trunk is None:
            crown_base_height = max(0.0, cc[1] - ce[1] - base[1])
    if crown_base_height is None and clear_trunk is not None:
        crown_base_height = float(clear_trunk)
    if height is None or crown_radius is None:
        raise TypeError("sb.create_tree() needs height and crown_radius (metres): nothing is assumed")
    return SbVeggieTree(base, height, crown_radius, crown_base_height, crown_widest_at, crown_top_exponent,
                        trunk_radius, leaf_color, label, name)


def create_vegetation(
    pos: Any = (0.0, 0.0, 0.0),
    height: float = 12.0,
    crown_radius: Union[float, Sequence[float]] = 3.0,
    clear_trunk_height: Optional[float] = None,
    **kwargs,
) -> SbVeggieTree:
    """Alias of create_tree with the older positional names (pos, height, crown_radius, clear_trunk_height = crown base)."""
    return create_tree(position=pos, height=height, crown_radius=crown_radius,
                       crown_base_height=kwargs.pop("crown_base_height", clear_trunk_height), **kwargs)


# ---------------------------------------------------------------------------------------------------------------------
# Trees held by a scene, and the GLB they are written into
# ---------------------------------------------------------------------------------------------------------------------

def is_tree(obj: Any) -> bool:
    return isinstance(obj, SbVeggieTree)


def trees_of(target: Any) -> List[SbVeggieTree]:
    """Every SB-Veggie tree a write target holds: itself, list members, a mesh's merged trees, a World's trees."""
    out: List[SbVeggieTree] = []
    seen = set()

    def add(t: SbVeggieTree) -> None:
        if t._uid not in seen:
            seen.add(t._uid)
            out.append(t)

    def visit(obj: Any, depth: int = 0) -> None:
        if obj is None or depth > 8:
            return
        if isinstance(obj, SbVeggieTree):
            add(obj)
            return
        if isinstance(obj, (list, tuple)):
            for o in obj:
                visit(o, depth + 1)
            return
        for t in (getattr(obj, "_sb_veggie_trees", None) or []):
            add(t)
        for t in (getattr(obj, "trees", None) or []) if isinstance(getattr(obj, "trees", None), list) else []:
            if isinstance(t, SbVeggieTree):
                add(t)
        mesh = obj.__dict__.get("mesh") if hasattr(obj, "__dict__") else None
        if mesh is not None and mesh is not obj:
            visit(mesh, depth + 1)
        for sub in (getattr(obj, "_sub_parts", None) or []):
            if sub is not obj:
                for t in (getattr(sub, "_sb_veggie_trees", None) or []):
                    add(t)

    visit(target)
    return out


def _repo_root() -> Optional[str]:
    env = os.environ.get("SCRATCHBOX_REPO_ROOT")
    if env and os.path.exists(os.path.join(env, SPECIES_INDEX)):
        return env
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(8):
        if os.path.exists(os.path.join(d, SPECIES_INDEX)) or os.path.exists(os.path.join(d, TEXTURE_INDEX)):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


def grow_trees(trees: Iterable[SbVeggieTree], seed: Optional[str] = None, triangle_budget: Optional[float] = None,
               label: Optional[str] = None) -> Tuple[bytes, dict]:
    """Grows the trees natively (scratchbox_native.vegetation) and returns (trees GLB bytes, stats)."""
    trees = list(trees)
    if not trees:
        raise ValueError("no trees to grow")
    veg = getattr(_native, "vegetation", None) if _native is not None else None
    if veg is None or not hasattr(veg, "grow_described_trees"):
        raise RuntimeError("the native SB-Veggie grower (scratchbox_native.vegetation) is not built into this module")
    doc = {"schema": TREES_SCHEMA, "trees": [t.to_spec() for t in trees]}
    if label:
        doc["label"] = str(label)[:200]
    text = json.dumps(doc, sort_keys=True)
    if seed is None:
        seed = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    options = {"seed": str(seed)}
    if triangle_budget:
        options["triangleBudget"] = float(triangle_budget)
    root = _repo_root()
    if root:
        if os.path.exists(os.path.join(root, SPECIES_INDEX)):
            options["speciesIndexPath"] = os.path.join(root, SPECIES_INDEX)
            options["speciesIndexLabel"] = SPECIES_INDEX.replace(os.sep, "/")
        if os.path.exists(os.path.join(root, TEXTURE_INDEX)):
            options["textureIndexPath"] = os.path.join(root, TEXTURE_INDEX)
            options["textureIndexLabel"] = TEXTURE_INDEX.replace(os.sep, "/")
    glb, stats, _crowns = veg.grow_described_trees(text, json.dumps(options))
    return bytes(glb), json.loads(stats)


# ---------------------------------------------------------------------------------------------------------------------
# GLB merge: the trees GLB appended to the scene GLB (a generic glTF 2.0 merge of one binary buffer each)
# ---------------------------------------------------------------------------------------------------------------------

def _read_glb(data: bytes) -> Tuple[dict, bytes]:
    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError("not a GLB")
    _magic, version, length = struct.unpack_from("<III", data, 0)
    if version != 2:
        raise ValueError("not a glTF 2.0 GLB")
    off = 12
    js, binary = None, b""
    while off + 8 <= min(length, len(data)):
        clen, ctype = struct.unpack_from("<II", data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode("utf-8"))
        elif ctype == 0x004E4942:
            binary = bytes(chunk)
        off += 8 + clen
    if js is None:
        raise ValueError("GLB has no JSON chunk")
    return js, binary


def _write_glb(js: dict, binary: bytes) -> bytes:
    jbytes = json.dumps(js, separators=(",", ":")).encode("utf-8")
    jbytes += b" " * ((4 - len(jbytes) % 4) % 4)
    binary += b"\0" * ((4 - len(binary) % 4) % 4)
    total = 12 + 8 + len(jbytes) + (8 + len(binary) if binary else 0)
    out = struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(jbytes), 0x4E4F534A) + jbytes
    if binary:
        out += struct.pack("<II", len(binary), 0x004E4942) + binary
    return out


def merge_glb(base: bytes, add: bytes) -> bytes:
    """Appends every node, mesh and buffer of `add` to `base` (one scene); `add`'s scene extras sbTrees / sbVeggie are
    carried to the merged scene (the viewport's tree levels of detail read them there)."""
    a, abin = _read_glb(base)
    b, bbin = _read_glb(add)
    for key in ("skins", "animations", "cameras"):
        if b.get(key):
            raise ValueError(f"cannot merge a GLB with {key}")
    if len(a.get("buffers", [])) > 1 or len(b.get("buffers", [])) > 1:
        raise ValueError("cannot merge GLBs with more than one buffer")
    pad = (4 - len(abin) % 4) % 4
    abin = abin + b"\0" * pad
    bin_offset = len(abin)
    off = {k: len(a.get(k, [])) for k in ("nodes", "meshes", "accessors", "bufferViews", "materials", "textures", "images", "samplers")}

    def tex_ref(obj: Any) -> None:
        # every textureInfo ({"index": n, ...}) anywhere under a material
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k.endswith("Texture") and isinstance(v, dict) and isinstance(v.get("index"), int):
                    v["index"] += off["textures"]
                tex_ref(v)
        elif isinstance(obj, list):
            for v in obj:
                tex_ref(v)

    for bv in b.get("bufferViews", []):
        bv = dict(bv)
        bv["buffer"] = 0
        bv["byteOffset"] = bv.get("byteOffset", 0) + bin_offset
        a.setdefault("bufferViews", []).append(bv)
    for acc in b.get("accessors", []):
        acc = json.loads(json.dumps(acc))
        if "bufferView" in acc:
            acc["bufferView"] += off["bufferViews"]
        sparse = acc.get("sparse")
        if sparse:
            sparse["indices"]["bufferView"] += off["bufferViews"]
            sparse["values"]["bufferView"] += off["bufferViews"]
        a.setdefault("accessors", []).append(acc)
    for img in b.get("images", []):
        img = dict(img)
        if "bufferView" in img:
            img["bufferView"] += off["bufferViews"]
        a.setdefault("images", []).append(img)
    for smp in b.get("samplers", []):
        a.setdefault("samplers", []).append(dict(smp))
    for tex in b.get("textures", []):
        tex = json.loads(json.dumps(tex))
        if "source" in tex:
            tex["source"] += off["images"]
        if "sampler" in tex:
            tex["sampler"] += off["samplers"]
        a.setdefault("textures", []).append(tex)
    for mat in b.get("materials", []):
        mat = json.loads(json.dumps(mat))
        tex_ref(mat)
        a.setdefault("materials", []).append(mat)
    for mesh in b.get("meshes", []):
        mesh = json.loads(json.dumps(mesh))
        for prim in mesh.get("primitives", []):
            prim["attributes"] = {k: v + off["accessors"] for k, v in prim.get("attributes", {}).items()}
            if "indices" in prim:
                prim["indices"] += off["accessors"]
            if "material" in prim:
                prim["material"] += off["materials"]
            for target in prim.get("targets", []) or []:
                for k in list(target):
                    target[k] += off["accessors"]
        a.setdefault("meshes", []).append(mesh)
    for node in b.get("nodes", []):
        node = json.loads(json.dumps(node))
        if "children" in node:
            node["children"] = [c + off["nodes"] for c in node["children"]]
        if "mesh" in node:
            node["mesh"] += off["meshes"]
        inst = (node.get("extensions") or {}).get("EXT_mesh_gpu_instancing")
        if inst:
            inst["attributes"] = {k: v + off["accessors"] for k, v in inst.get("attributes", {}).items()}
        a.setdefault("nodes", []).append(node)

    scenes = a.setdefault("scenes", [{"nodes": []}])
    si = a.get("scene", 0)
    if not scenes:
        scenes.append({"nodes": []})
        si = 0
    a["scene"] = si
    bscene = (b.get("scenes") or [{}])[b.get("scene", 0)]
    scenes[si].setdefault("nodes", []).extend(n + off["nodes"] for n in bscene.get("nodes", []))
    bextras = bscene.get("extras") or {}
    carried = {k: v for k, v in bextras.items() if k in ("sbTrees", "sbVeggie")}
    if carried:
        scenes[si].setdefault("extras", {}).update(carried)
        a.setdefault("extras", {}).update(carried)
    for key in ("extensionsUsed", "extensionsRequired"):
        merged = list(dict.fromkeys(list(a.get(key, [])) + list(b.get(key, []))))
        if merged:
            a[key] = merged
    binary = abin + bbin
    a["buffers"] = [{"byteLength": len(binary) + ((4 - len(binary) % 4) % 4)}] if binary else []
    if not binary:
        a.pop("buffers", None)
    return _write_glb(a, binary)


def attach_trees(glb: bytes, trees: Sequence[SbVeggieTree], seed: Optional[str] = None) -> bytes:
    """The scene GLB with its SB-Veggie trees grown and written into it."""
    if not trees:
        return glb
    trees_glb, _stats = grow_trees(trees, seed=seed)
    return merge_glb(glb, trees_glb) if glb else trees_glb


__all__ = [
    "SbVeggieTree",
    "create_tree",
    "create_vegetation",
    "grow_trees",
    "trees_of",
    "merge_glb",
    "attach_trees",
    "is_tree",
]
