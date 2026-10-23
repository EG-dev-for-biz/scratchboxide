"""
sb.object_spec: deterministic interpreter for an ObjectBuildSpec
(contract and JSON schema: packages/core/src/common/spatial/object-build-spec.ts).

    scene = sb.object_spec.build(spec)      # sb.Scene, one mesh per part, each with its material
    scene = sb.object_spec.build(spec, clay=True)   # the same geometry, every part studio clay
    sb.io.write_glb(OUTPUT_GLB_PATH, scene)

Units are metres, +Y up, +X right, +Z toward the front. Each part uses one of four geometry kernels:

  sweep      a superellipse section swept along a carrier through control points (centripetal Catmull-Rom
             blended with the polyline by `smoothing`), framed by rotation-minimising frames
  revolve    a meridian of [axial, radius] points revolved about an axis, with K radial harmonic lobes that a
             helix pitch twists along the axis
  replicate  copies of a seed part and everything attached to it, rotated around a ring or spaced along a path
  relief     grooves or beads applied as an offset field in the target's (u, v) parametrisation while its
             surface is generated
  crown      a branching crown grown, not modelled: an SB-Veggie tree (sb.create_tree, vegetation.py) from the
             crown's envelope (trunk base, height, crown radii, crown base, where it is widest, the top's profile,
             trunk radius); its material's baseColor is the foliage colour. A root part; it is never mirrored or copied

A child part attaches by parameter (u along, angle around, offset along the normal) on its parent's evaluated
surface, and its own coordinates are offsets in object axes from that point, so parts join by construction.
Sample density follows one target edge length derived from the object's surface area, so resolution, not padding,
carries the detail budget. A part's `material` (linear RGB baseColor, roughness, metalness, transmission, ior,
clearcoat, emissive, emissiveStrength) becomes its glTF material factors; a part without one, and every part of a
clay build, gets sb.PbrMaterial.clay(). Invalid input raises SpecError (a ValueError); nothing else is defaulted
or substituted. Labels and material descriptions are never read.
"""

import math

__all__ = ["SpecError", "validate", "build", "build_meshes", "part_material", "TARGET_VERTICES"]

TARGET_VERTICES = 40000
MAX_TRIANGLES = 450000
PART_VERTEX_CAP = 160000
CREASE_DEGREES = 30.0
# Fillets on sharp revolve corners: a razor edge catches no highlight and reads as CG. Each corner sharper than
# CREASE_DEGREES is replaced by a curve this share of the part's own extent, never more than EDGE_ROUND_MAX_SHARE of
# either edge it joins (so neighbouring fillets never overlap).
EDGE_ROUND_FRACTION = 0.02
EDGE_ROUND_MAX_SHARE = 0.3
_DENSE_PER_SEGMENT = 48
_EPS = 1e-9
_OPERATORS = ("sweep", "revolve", "replicate", "relief", "crown")


class SpecError(ValueError):
    """
    The spec cannot be built as written. `problems` lists every problem found, one line each, naming the part and
    field, so whoever wrote the spec can correct them all at once. The message is those lines under one heading;
    the builder reads them back from the traceback (scratchbox.object_spec.SpecError: ...).
    """

    def __init__(self, problems):
        if isinstance(problems, str):
            problems = [problems]
        self.problems = [" ".join(str(p).split()) for p in problems]
        ValueError.__init__(self, "The spec cannot be built as written:\n" + "\n".join("- " + p for p in self.problems))


# ---------------------------------------------------------------------------
# Small vector helpers on tuples
# ---------------------------------------------------------------------------

def _add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _mul(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _length(a):
    return math.sqrt(_dot(a, a))


def _unit(a, what="vector"):
    n = _length(a)
    if n < _EPS:
        raise SpecError("%s has zero length" % what)
    return (a[0] / n, a[1] / n, a[2] / n)


def _lerp(a, b, t):
    return tuple(a[k] + (b[k] - a[k]) * t for k in range(len(a)))


def _rotate(p, axis, angle):
    """Rodrigues rotation of p about the unit axis through the origin."""
    c, s = math.cos(angle), math.sin(angle)
    kxp = _cross(axis, p)
    kdp = _dot(axis, p)
    return (p[0] * c + kxp[0] * s + axis[0] * kdp * (1 - c),
            p[1] * c + kxp[1] * s + axis[1] * kdp * (1 - c),
            p[2] * c + kxp[2] * s + axis[2] * kdp * (1 - c))


def _perpendicular_reference(axis):
    """Angle-0 direction around an axis: +Z (front) projected off the axis, or +X when the axis is along Z."""
    ref = (0.0, 0.0, 1.0) if abs(axis[2]) < 0.999 else (1.0, 0.0, 0.0)
    return _unit(_sub(ref, _mul(axis, _dot(ref, axis))))


# ---------------------------------------------------------------------------
# Validation (mirrors validateObjectBuildSpec in object-build-spec.ts)
# ---------------------------------------------------------------------------

def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _is_vec(v, n):
    return isinstance(v, (list, tuple)) and len(v) == n and all(_is_num(x) for x in v)


def _given(part, key):
    return part.get(key) is not None


def _validate_material(material, where, errors):
    """Mirrors validatePartMaterial in object-build-spec.ts."""
    if not isinstance(material, dict):
        errors.append("%s: material must be an object" % where)
        return

    def in_unit(v):
        return _is_num(v) and 0 <= v <= 1

    def rgb(v):
        return isinstance(v, (list, tuple)) and len(v) == 3 and all(in_unit(x) for x in v)

    if not rgb(material.get("baseColor")):
        errors.append("%s: material.baseColor must be [r, g, b] linear RGB, each between 0 and 1" % where)
    for key in ("roughness", "metalness", "transmission"):
        if not in_unit(material.get(key)):
            errors.append("%s: material.%s must be between 0 and 1" % (where, key))
    if _given(material, "ior") and not (_is_num(material["ior"]) and 1 <= material["ior"] <= 3):
        errors.append("%s: material.ior must be between 1 and 3" % where)
    if _given(material, "clearcoat") and not in_unit(material["clearcoat"]):
        errors.append("%s: material.clearcoat must be between 0 and 1" % where)
    if _given(material, "emissive") and not rgb(material["emissive"]):
        errors.append("%s: material.emissive must be [r, g, b] linear RGB, each between 0 and 1" % where)
    if _given(material, "emissiveStrength"):
        if not (_is_num(material["emissiveStrength"]) and 0 <= material["emissiveStrength"] <= 100):
            errors.append("%s: material.emissiveStrength must be between 0 and 100" % where)
        elif not _given(material, "emissive"):
            errors.append("%s: material.emissiveStrength needs material.emissive (the colour it multiplies)" % where)


def validate(spec):
    """Returns the list of problems with the spec (empty when it can be built)."""
    errors = []
    if not isinstance(spec, dict):
        return ["spec must be an object"]
    if not isinstance(spec.get("subject"), str) or not spec["subject"].strip():
        errors.append("subject must be a non-empty string")
    bounding = spec.get("boundingMeters")
    reach = float("inf")
    if not _is_vec(bounding, 3) or any(b <= 0 or b > 1000 for b in bounding):
        errors.append("boundingMeters must be three sizes in metres, each greater than 0 and at most 1000")
    else:
        reach = max(bounding) * 5.0
    if not _is_int(spec.get("expectedBodies")) or spec["expectedBodies"] < 1:
        errors.append("expectedBodies must be an integer of at least 1")
    parts = spec.get("parts")
    if not isinstance(parts, list) or not parts:
        errors.append("parts must be a non-empty list")
        return errors
    if len(parts) > 48:
        errors.append("parts has %d entries; at most 48 are allowed" % len(parts))

    by_id = {}
    op_of = {}
    for index, part in enumerate(parts):
        if not isinstance(part, dict):
            errors.append("parts[%d] must be an object" % index)
            continue
        pid = part.get("id")
        where = 'part "%s"' % pid if isinstance(pid, str) and pid else "parts[%d]" % index
        if not isinstance(pid, str) or not pid or len(pid) > 64 or not all(c.isalnum() or c in "_.-" for c in pid) or not pid.isascii():
            errors.append("%s: id must be 1-64 letters, digits, '_', '.' or '-'" % where)
            continue
        if pid in by_id:
            errors.append("%s: id is used by more than one part" % where)
            continue
        by_id[pid] = part
        present = [k for k in _OPERATORS if _given(part, k)]
        if len(present) != 1:
            errors.append("%s: must have exactly one of sweep, revolve, replicate, relief, crown" % where)
        else:
            op_of[pid] = present[0]
        if _given(part, "mirrorPlaneNormal") and (not _is_vec(part["mirrorPlaneNormal"], 3) or _length(part["mirrorPlaneNormal"]) < _EPS):
            errors.append("%s: mirrorPlaneNormal must be a non-zero [x, y, z] vector" % where)
        if _given(part, "material"):
            if len(present) == 1 and present[0] in ("replicate", "relief"):
                errors.append("%s: a %s part has no surface of its own, so it cannot have a material" % (where, present[0]))
            else:
                _validate_material(part["material"], where, errors)

    def in_reach(point, where, field):
        if any(abs(x) > reach for x in point):
            errors.append("%s: %s lies far outside boundingMeters; coordinates are metres" % (where, field))

    for pid, part in by_id.items():
        where = 'part "%s"' % pid
        op = op_of.get(pid)
        is_child = _given(part, "parentId")
        if op == "crown":
            if is_child or _given(part, "attach"):
                errors.append("%s: a crown part is a root part; give its trunkBaseMeters instead of parentId and attach" % where)
            if _given(part, "mirrorPlaneNormal"):
                errors.append("%s: a crown part cannot be mirrored; give each crown its own part" % where)
            _validate_crown(part["crown"], where, errors, in_reach)
            continue
        if is_child:
            parent = part.get("parentId")
            if op in ("replicate", "relief"):
                errors.append("%s: a %s part cannot attach to a parent" % (where, op))
            elif not isinstance(parent, str) or parent not in by_id or parent == pid:
                errors.append("%s: parentId does not name another part" % where)
            elif op_of.get(parent) not in ("sweep", "revolve"):
                errors.append("%s: parent must be a sweep or revolve part" % where)
            attach = part.get("attach")
            if not isinstance(attach, dict):
                errors.append("%s: attach is required with parentId" % where)
            else:
                if not _is_num(attach.get("u")) or not 0 <= attach["u"] <= 1:
                    errors.append("%s: attach.u must be between 0 and 1" % where)
                if not _is_num(attach.get("angleDeg")):
                    errors.append("%s: attach.angleDeg must be a number" % where)
                if not _is_num(attach.get("normalOffsetMeters")) or abs(attach["normalOffsetMeters"]) > reach:
                    errors.append("%s: attach.normalOffsetMeters must be a number within the object's size" % where)
        elif _given(part, "attach"):
            errors.append("%s: attach is given without parentId" % where)

        if op == "sweep":
            _validate_sweep(part["sweep"], where, is_child, errors, in_reach)
        elif op == "revolve":
            _validate_revolve(part["revolve"], where, is_child, errors, in_reach)
        elif op == "replicate":
            _validate_replicate(part["replicate"], pid, where, by_id, op_of, errors, in_reach)
        elif op == "relief":
            _validate_relief(part["relief"], where, by_id, op_of, errors, reach)

    for pid in by_id:
        seen = []
        cur = pid
        while cur is not None:
            if cur in seen:
                errors.append('part "%s": parentId chain forms a cycle' % pid)
                break
            seen.append(cur)
            parent = by_id[cur].get("parentId")
            cur = parent if isinstance(parent, str) and parent in by_id else None

    seed_use = {}
    for pid, part in by_id.items():
        if op_of.get(pid) != "replicate" or not isinstance(part.get("replicate"), dict):
            continue
        seed = part["replicate"].get("seedPartId")
        if seed in seed_use:
            errors.append('part "%s": seed "%s" is already copied by "%s"' % (pid, seed, seed_use[seed]))
        elif isinstance(seed, str):
            seed_use[seed] = pid
    for start in seed_use.values():
        seen = []
        cur = start
        while cur is not None and op_of.get(cur) == "replicate":
            if cur in seen:
                errors.append('part "%s": replicate seeds form a cycle' % start)
                break
            seen.append(cur)
            cur = by_id[cur]["replicate"].get("seedPartId")
    return errors


def _validate_crown(crown, where, errors, in_reach):
    if not isinstance(crown, dict):
        errors.append("%s: crown must be an object" % where)
        return
    if not _is_vec(crown.get("trunkBaseMeters"), 3):
        errors.append("%s: crown.trunkBaseMeters must be [x, y, z] in metres" % where)
    else:
        in_reach(crown["trunkBaseMeters"], where, "crown.trunkBaseMeters")
    height = crown.get("heightMeters")
    if not _is_num(height) or height <= 0.3:
        errors.append("%s: crown.heightMeters must be more than 0.3 m" % where)
        height = None
    radii = crown.get("crownRadiiMeters")
    if not _is_vec(radii, 2) or any(r <= 0.1 for r in radii):
        errors.append("%s: crown.crownRadiiMeters must be [along X, along Z], each more than 0.1 m" % where)
    if _given(crown, "crownBaseHeightMeters"):
        b = crown["crownBaseHeightMeters"]
        if not _is_num(b) or b < 0 or (height is not None and b >= 0.95 * height):
            errors.append("%s: crown.crownBaseHeightMeters must be at least 0 and below 0.95 of heightMeters" % where)
    if _given(crown, "crownWidestAt") and (not _is_num(crown["crownWidestAt"]) or not 0 <= crown["crownWidestAt"] <= 0.9):
        errors.append("%s: crown.crownWidestAt must be between 0 and 0.9" % where)
    if _given(crown, "crownTopExponent") and (not _is_num(crown["crownTopExponent"]) or not 0.5 <= crown["crownTopExponent"] <= 8):
        errors.append("%s: crown.crownTopExponent must be between 0.5 and 8" % where)
    if _given(crown, "trunkRadiusMeters"):
        t = crown["trunkRadiusMeters"]
        if not _is_num(t) or t <= 0 or (height is not None and t >= 0.2 * height):
            errors.append("%s: crown.trunkRadiusMeters must be more than 0 and under 0.2 of heightMeters" % where)


def _validate_sweep(sweep, where, is_child, errors, in_reach):
    if not isinstance(sweep, dict):
        errors.append("%s: sweep must be an object" % where)
        return
    pts = sweep.get("controlPoints")
    if not isinstance(pts, list) or not 2 <= len(pts) <= 64 or not all(_is_vec(p, 3) for p in pts):
        errors.append("%s: sweep.controlPoints must be 2-64 [x, y, z] points" % where)
    else:
        for i in range(1, len(pts)):
            if _length(_sub(pts[i], pts[i - 1])) < 1e-6:
                errors.append("%s: sweep.controlPoints %d and %d coincide" % (where, i - 1, i))
        for i, p in enumerate(pts):
            in_reach(p, where, "sweep.controlPoints[%d]" % i)
        if sweep.get("closedLoop") is True and len(pts) < 3:
            errors.append("%s: a closed sweep needs at least 3 control points" % where)
        if is_child and _length(pts[0]) > 1e-6:
            errors.append("%s: a child sweep starts at its attach point, so controlPoints[0] must be [0, 0, 0]" % where)
    if not isinstance(sweep.get("closedLoop"), bool):
        errors.append("%s: sweep.closedLoop must be true or false" % where)
    if not _is_num(sweep.get("smoothing")) or not 0 <= sweep["smoothing"] <= 1:
        errors.append("%s: sweep.smoothing must be between 0 and 1" % where)
    profile = sweep.get("profile")
    if not isinstance(profile, list) or not 1 <= len(profile) <= 16:
        errors.append("%s: sweep.profile must have 1-16 keys" % where)
    else:
        ts = []
        for i, key in enumerate(profile):
            if not isinstance(key, dict):
                errors.append("%s: sweep.profile[%d] must be an object" % (where, i))
                continue
            if not _is_num(key.get("t")) or not 0 <= key["t"] <= 1:
                errors.append("%s: sweep.profile[%d].t must be between 0 and 1" % (where, i))
            else:
                ts.append(key["t"])
            for field in ("widthMeters", "heightMeters"):
                if not _is_num(key.get(field)) or key[field] <= 0:
                    errors.append("%s: sweep.profile[%d].%s must be greater than 0" % (where, i, field))
            if not _is_num(key.get("exponent")) or not 0.5 <= key["exponent"] <= 12:
                errors.append("%s: sweep.profile[%d].exponent must be between 0.5 and 12" % (where, i))
        if len(set(ts)) != len(ts):
            errors.append("%s: sweep.profile keys must have distinct t values" % where)
    twist = sweep.get("twistDegAlong")
    if twist is not None:
        if not isinstance(twist, list) or len(twist) > 16 or not all(_is_vec(p, 2) and 0 <= p[0] <= 1 for p in twist):
            errors.append("%s: sweep.twistDegAlong must be [t, degrees] pairs with t between 0 and 1" % where)
        elif len(set(p[0] for p in twist)) != len(twist):
            errors.append("%s: sweep.twistDegAlong must have distinct t values" % where)
    mod = sweep.get("modulation")
    if mod is not None:
        if (not isinstance(mod, dict) or not _is_num(mod.get("amplitudeMeters")) or not _is_num(mod.get("cyclesPerMeter"))
                or mod["cyclesPerMeter"] < 0 or not _is_int(mod.get("cyclesAround")) or mod["cyclesAround"] < 0):
            errors.append("%s: sweep.modulation needs amplitudeMeters, cyclesPerMeter >= 0 and an integer cyclesAround >= 0" % where)
        elif isinstance(profile, list) and profile and all(isinstance(k, dict) and _is_num(k.get("widthMeters")) and _is_num(k.get("heightMeters")) for k in profile):
            thinnest = min(min(k["widthMeters"], k["heightMeters"]) for k in profile)
            if abs(mod["amplitudeMeters"]) >= thinnest / 2:
                errors.append("%s: sweep.modulation.amplitudeMeters must be smaller than half the thinnest section" % where)


def _validate_revolve(rev, where, is_child, errors, in_reach):
    if not isinstance(rev, dict):
        errors.append("%s: revolve must be an object" % where)
        return
    origin = rev.get("axisOrigin")
    if not _is_vec(origin, 3):
        errors.append("%s: revolve.axisOrigin must be [x, y, z]" % where)
    elif is_child and _length(origin) > 1e-6:
        errors.append("%s: a child revolve's axis passes through its attach point, so axisOrigin must be [0, 0, 0]" % where)
    else:
        in_reach(origin, where, "revolve.axisOrigin")
    if not _is_vec(rev.get("axisDirection"), 3) or _length(rev["axisDirection"]) < _EPS:
        errors.append("%s: revolve.axisDirection must be a non-zero [x, y, z] vector" % where)
    mer = rev.get("meridian")
    if not isinstance(mer, list) or not 2 <= len(mer) <= 64 or not all(_is_vec(p, 2) for p in mer):
        errors.append("%s: revolve.meridian must be 2-64 [axial, radius] points" % where)
    else:
        if any(p[1] < 0 for p in mer):
            errors.append("%s: revolve.meridian radii must be 0 or more" % where)
        if all(p[1] <= 1e-9 for p in mer):
            errors.append("%s: revolve.meridian needs at least one radius greater than 0" % where)
        for i in range(1, len(mer)):
            if math.hypot(mer[i][0] - mer[i - 1][0], mer[i][1] - mer[i - 1][1]) < 1e-6:
                errors.append("%s: revolve.meridian points %d and %d coincide" % (where, i - 1, i))
        for i, p in enumerate(mer):
            in_reach(p, where, "revolve.meridian[%d]" % i)
        axial = [p[0] for p in mer]
        if is_child and (min(axial) > 1e-6 or max(axial) < -1e-6):
            errors.append("%s: a child revolve must reach its attach point: its meridian's axial distances must span 0" % where)
    if not _is_num(rev.get("smoothing")) or not 0 <= rev["smoothing"] <= 1:
        errors.append("%s: revolve.smoothing must be between 0 and 1" % where)
    if not _is_int(rev.get("lobeCount")) or not 0 <= rev["lobeCount"] <= 64:
        errors.append("%s: revolve.lobeCount must be an integer from 0 to 64" % where)
    if not _is_num(rev.get("lobeDepthRatio")) or not 0 <= rev["lobeDepthRatio"] <= 0.9:
        errors.append("%s: revolve.lobeDepthRatio must be between 0 and 0.9" % where)
    if not _is_num(rev.get("helixPitchMeters")):
        errors.append("%s: revolve.helixPitchMeters must be a number (0 for no helix)" % where)


def _validate_replicate(rep, pid, where, by_id, op_of, errors, in_reach):
    if not isinstance(rep, dict):
        errors.append("%s: replicate must be an object" % where)
        return
    seed = rep.get("seedPartId")
    if not isinstance(seed, str) or seed not in by_id:
        errors.append("%s: replicate.seedPartId does not name a part" % where)
    elif seed == pid:
        errors.append("%s: a replicate cannot copy itself" % where)
    elif op_of.get(seed) == "relief":
        errors.append("%s: replicate.seedPartId names a relief part, which has no geometry to copy" % where)
    elif op_of.get(seed) == "crown":
        errors.append("%s: replicate.seedPartId names a crown part; give every crown its own part" % where)
    has_ring = rep.get("ring") is not None
    has_path = rep.get("path") is not None
    if has_ring == has_path:
        errors.append("%s: replicate needs exactly one of ring or path" % where)
        return
    if has_ring:
        ring = rep["ring"]
        if not isinstance(ring, dict):
            errors.append("%s: replicate.ring must be an object" % where)
            return
        if not _is_vec(ring.get("centerMeters"), 3):
            errors.append("%s: replicate.ring.centerMeters must be [x, y, z]" % where)
        else:
            in_reach(ring["centerMeters"], where, "replicate.ring.centerMeters")
        if not _is_vec(ring.get("axisDirection"), 3) or _length(ring["axisDirection"]) < _EPS:
            errors.append("%s: replicate.ring.axisDirection must be a non-zero vector" % where)
        if not _is_int(ring.get("count")) or not 2 <= ring["count"] <= 256:
            errors.append("%s: replicate.ring.count must be an integer from 2 to 256" % where)
        if not _is_num(ring.get("spanDeg")) or not 0 < ring["spanDeg"] <= 3600:
            errors.append("%s: replicate.ring.spanDeg must be greater than 0 and at most 3600" % where)
        if not _is_num(ring.get("risePerCopyMeters")):
            errors.append("%s: replicate.ring.risePerCopyMeters must be a number" % where)
    else:
        path = rep["path"]
        if not isinstance(path, dict):
            errors.append("%s: replicate.path must be an object" % where)
            return
        pts = path.get("points")
        if not isinstance(pts, list) or not 2 <= len(pts) <= 64 or not all(_is_vec(p, 3) for p in pts):
            errors.append("%s: replicate.path.points must be 2-64 [x, y, z] points" % where)
        else:
            for i in range(1, len(pts)):
                if _length(_sub(pts[i], pts[i - 1])) < 1e-6:
                    errors.append("%s: replicate.path.points %d and %d coincide" % (where, i - 1, i))
            for i, p in enumerate(pts):
                in_reach(p, where, "replicate.path.points[%d]" % i)
        if not _is_int(path.get("count")) or not 2 <= path["count"] <= 256:
            errors.append("%s: replicate.path.count must be an integer from 2 to 256" % where)
        if not isinstance(path.get("orientToPath"), bool):
            errors.append("%s: replicate.path.orientToPath must be true or false" % where)


def _validate_relief(rel, where, by_id, op_of, errors, reach):
    if not isinstance(rel, dict):
        errors.append("%s: relief must be an object" % where)
        return
    target = rel.get("targetPartId")
    if not isinstance(target, str) or target not in by_id:
        errors.append("%s: relief.targetPartId does not name a part" % where)
    elif op_of.get(target) not in ("sweep", "revolve"):
        errors.append("%s: relief.targetPartId must be a sweep or revolve part" % where)
    curves = rel.get("curves")
    if not isinstance(curves, list) or not 1 <= len(curves) <= 16:
        errors.append("%s: relief.curves must hold 1-16 polylines" % where)
    else:
        for i, curve in enumerate(curves):
            if not isinstance(curve, list) or not 2 <= len(curve) <= 64 or not all(_is_vec(p, 2) for p in curve):
                errors.append("%s: relief.curves[%d] must be 2-64 [u, v] points" % (where, i))
            elif any(p[0] < 0 or p[0] > 1 or abs(p[1]) > 64 for p in curve):
                errors.append("%s: relief.curves[%d] u values must be between 0 and 1" % (where, i))
    width = rel.get("widthMeters")
    if not _is_num(width) or width <= 0 or width > reach:
        errors.append("%s: relief.widthMeters must be greater than 0 and within the object's size" % where)
    depth = rel.get("depthMeters")
    if not _is_num(depth) or depth == 0:
        errors.append("%s: relief.depthMeters must be a non-zero number" % where)
    elif _is_num(width) and abs(depth) > width * 4:
        errors.append("%s: relief.depthMeters must be at most four times widthMeters" % where)
    if not _is_num(rel.get("sharpness")) or not 0 <= rel["sharpness"] <= 0.95:
        errors.append("%s: relief.sharpness must be between 0 and 0.95" % where)


# ---------------------------------------------------------------------------
# Curves
# ---------------------------------------------------------------------------

def _centripetal(p0, p1, p2, p3, t):
    """Centripetal (alpha 0.5) Catmull-Rom between p1 and p2 at t in [0, 1] (Barry-Goldman pyramid), any dimension."""
    def knot(ti, a, b):
        d = math.sqrt(sum((b[k] - a[k]) ** 2 for k in range(len(a))))
        return ti + max(d, 1e-12) ** 0.5
    t0 = 0.0
    t1 = knot(t0, p0, p1)
    t2 = knot(t1, p1, p2)
    t3 = knot(t2, p2, p3)
    tt = t1 + (t2 - t1) * t

    def mix(a, b, ta, tb):
        w = (tt - ta) / (tb - ta)
        return tuple(a[k] + (b[k] - a[k]) * w for k in range(len(a)))
    a1 = mix(p0, p1, t0, t1)
    a2 = mix(p1, p2, t1, t2)
    a3 = mix(p2, p3, t2, t3)
    b1 = mix(a1, a2, t0, t2)
    b2 = mix(a2, a3, t1, t3)
    return mix(b1, b2, t1, t2)


def _dense_curve(points, closed, smoothing):
    """
    Densely samples the carrier through `points` (blend of polyline and centripetal Catmull-Rom by `smoothing`).
    Returns (samples, knot_indices): knot_indices[i] is the sample index of control point i, so control points
    stay exact.
    """
    pts = [tuple(float(x) for x in p) for p in points]
    n = len(pts)
    segments = n if closed else n - 1
    samples, knots = [], []
    for s in range(segments):
        p1, p2 = pts[s], pts[(s + 1) % n]
        if closed:
            p0, p3 = pts[(s - 1) % n], pts[(s + 2) % n]
        else:
            p0 = pts[s - 1] if s > 0 else tuple(2 * p1[k] - p2[k] for k in range(len(p1)))
            p3 = pts[s + 2] if s + 2 < n else tuple(2 * p2[k] - p1[k] for k in range(len(p1)))
        knots.append(len(samples))
        for k in range(_DENSE_PER_SEGMENT):
            t = k / _DENSE_PER_SEGMENT
            linear = _lerp(p1, p2, t)
            if smoothing > 0:
                curved = _centripetal(p0, p1, p2, p3, t)
                samples.append(_lerp(linear, curved, smoothing))
            else:
                samples.append(linear)
    if closed:
        samples.append(pts[0])
        knots.append(len(samples) - 1)
    else:
        samples.append(pts[-1])
        knots.append(len(samples) - 1)
    return samples, knots


def _arc_lengths(samples):
    acc = [0.0]
    for i in range(1, len(samples)):
        acc.append(acc[-1] + math.sqrt(sum((samples[i][k] - samples[i - 1][k]) ** 2 for k in range(len(samples[i])))))
    return acc


def _eval_at(samples, acc, s):
    """Point at arc length s along the dense polyline (binary search)."""
    if s <= 0:
        return samples[0]
    if s >= acc[-1]:
        return samples[-1]
    lo, hi = 0, len(acc) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if acc[mid] <= s:
            lo = mid
        else:
            hi = mid
    span = acc[hi] - acc[lo]
    w = (s - acc[lo]) / span if span > 0 else 0.0
    return _lerp(samples[lo], samples[hi], w)


def _u_samples(acc, knots, edge, extra=()):
    """u values (arc fraction) that include every control point, spaced at most `edge` metres apart."""
    total = acc[-1]
    us = set()
    for i in range(len(knots) - 1):
        a, b = acc[knots[i]], acc[knots[i + 1]]
        steps = max(1, int(math.ceil((b - a) / edge)))
        for k in range(steps + 1):
            us.add(round((a + (b - a) * k / steps) / total, 12))
    for u in extra:
        if 0.0 <= u <= 1.0:
            us.add(round(u, 12))
    return sorted(us)


def _interp_keys(keys, t, fields):
    """Linear interpolation of dict keys sorted by "t"; clamps outside the first and last key."""
    if t <= keys[0]["t"]:
        return [keys[0][f] for f in fields]
    if t >= keys[-1]["t"]:
        return [keys[-1][f] for f in fields]
    for a, b in zip(keys, keys[1:]):
        if a["t"] <= t <= b["t"]:
            w = (t - a["t"]) / (b["t"] - a["t"])
            return [a[f] + (b[f] - a[f]) * w for f in fields]
    return [keys[-1][f] for f in fields]


def _interp_pairs(pairs, t):
    keys = [{"t": p[0], "v": p[1]} for p in sorted(pairs, key=lambda p: p[0])]
    return _interp_keys(keys, t, ["v"])[0]


# ---------------------------------------------------------------------------
# Surfaces: every sweep and revolve is a (u, v) grid with an evaluator for attachment
# ---------------------------------------------------------------------------

class _Surface(object):
    """
    One sweep or revolve part as a grid: rows[i][j] is the position at us[i] (along) and vs[j] (around, in turns),
    normals_out[i][j] its outward normal. pole[i] marks rings collapsed onto the axis; caps holds flat end discs as
    (row index, centre, outward normal); crease_rows are rows that keep separate shading on each side.
    """

    def __init__(self, kind, part_id):
        self.kind = kind
        self.part_id = part_id
        self.us = []
        self.vs = []
        self.rows = []
        self.normals_out = []
        self.pole = []
        self.closed_u = False
        self.caps = []
        self.length = 0.0
        self.circumference = []
        self.crease_rows = set()


def _superellipse(theta, half_h, half_w, exponent):
    c, s = math.cos(theta), math.sin(theta)
    e = 2.0 / exponent
    a = half_h * math.copysign(abs(c) ** e, c)
    b = half_w * math.copysign(abs(s) ** e, s)
    return a, b


def _section_normal(theta, half_h, half_w, exponent):
    """Outward 2D normal (along N, along B) of the superellipse section at parameter theta."""
    d = 1e-4
    a0, b0 = _superellipse(theta - d, half_h, half_w, exponent)
    a1, b1 = _superellipse(theta + d, half_h, half_w, exponent)
    ta, tb = a1 - a0, b1 - b0
    na, nb = tb, -ta
    a, b = _superellipse(theta, half_h, half_w, exponent)
    if na * a + nb * b < 0:
        na, nb = -na, -nb
    n = math.hypot(na, nb)
    if n < 1e-15:
        n = math.hypot(a, b) or 1.0
        return a / n, b / n
    return na / n, nb / n


def _ellipse_perimeter(a, b):
    h = ((a - b) / (a + b)) ** 2 if a + b > 0 else 0.0
    return math.pi * (a + b) * (1 + 3 * h / (10 + math.sqrt(4 - 3 * h)))


def _rmf_frames(points, closed, up_hint, field="sweep.controlPoints"):
    """
    Tangents and rotation-minimising normals (double reflection, Wang et al. 2008) along sampled points. `field` names
    the spec field the points come from, for the error when the curve reverses on itself and has no direction.
    """
    n = len(points)
    tangents = []
    for i in range(n):
        if closed:
            prev, nxt = points[(i - 1) % n], points[(i + 1) % n]
        else:
            prev = points[i - 1] if i > 0 else points[i]
            nxt = points[i + 1] if i + 1 < n else points[i]
        if _length(_sub(nxt, prev)) < _EPS:
            raise SpecError("%s: the curve turns straight back on itself near [%s], so it has no direction there; "
                            "move the points so the curve does not reverse" % (field, ", ".join("%.3g" % x for x in points[i])))
        tangents.append(_unit(_sub(nxt, prev)))
    t0 = tangents[0]
    ref = up_hint if abs(_dot(up_hint, t0)) < 0.999 else (0.0, 0.0, 1.0)
    normals = [_unit(_sub(ref, _mul(t0, _dot(ref, t0))))]
    steps = n if closed else n - 1
    for i in range(steps):
        j = (i + 1) % n
        v1 = _sub(points[j], points[i])
        c1 = _dot(v1, v1)
        r = normals[i]
        t = tangents[i]
        if c1 < 1e-24:
            nxt_r = r
        else:
            r_l = _sub(r, _mul(v1, 2.0 / c1 * _dot(v1, r)))
            t_l = _sub(t, _mul(v1, 2.0 / c1 * _dot(v1, t)))
            v2 = _sub(tangents[j], t_l)
            c2 = _dot(v2, v2)
            nxt_r = r_l if c2 < 1e-24 else _sub(r_l, _mul(v2, 2.0 / c2 * _dot(v2, r_l)))
        tj = tangents[j]
        nxt_r = _unit(_sub(nxt_r, _mul(tj, _dot(nxt_r, tj))), "sweep frame")
        if j == 0 and closed:
            # Holonomy: spread the angle between the propagated and the starting normal evenly along the loop.
            mismatch = math.atan2(_dot(_cross(nxt_r, normals[0]), tangents[0]), _dot(nxt_r, normals[0]))
            for k in range(1, n):
                normals[k] = _rotate(normals[k], tangents[k], mismatch * k / n)
        else:
            normals.append(nxt_r)
    return tangents, normals


def _build_sweep(part, origin, edge, relief_ops):
    sw = part["sweep"]
    closed = bool(sw["closedLoop"])
    smoothing = float(sw["smoothing"])
    ctrl = [_add(origin, tuple(float(x) for x in p)) for p in sw["controlPoints"]]
    dense, knots = _dense_curve(ctrl, closed, smoothing)
    acc = _arc_lengths(dense)
    total = acc[-1]
    if total < 1e-6:
        raise SpecError('part "%s" sweep.controlPoints: the carrier has no length; spread the control points apart' % part["id"])
    keys = sorted(sw["profile"], key=lambda k: k["t"])
    max_perimeter = max(_ellipse_perimeter(k["widthMeters"] / 2, k["heightMeters"] / 2) for k in keys)

    around = min(512, max(8, int(math.ceil(max_perimeter / edge))))
    around += (-around) % 4
    extra_u, extra_v = _relief_refinement(relief_ops, total, max_perimeter)
    us = _u_samples(acc, knots, edge, extra_u)
    if closed and us[-1] >= 1.0 - 1e-12:
        us = us[:-1]
    vs = sorted(set([j / float(around) for j in range(around)] + list(extra_v)))
    _check_grid_budget(part["id"], len(us), len(vs))

    centres = [_eval_at(dense, acc, u * total) for u in us]
    tangents, normals = _rmf_frames(centres, closed, (0.0, 1.0, 0.0))
    twist = sw.get("twistDegAlong") or []
    surface = _Surface("sweep", part["id"])
    surface.us, surface.vs, surface.closed_u, surface.length = us, vs, closed, total
    surface._centres, surface._tangents, surface._normals, surface._keys, surface._twist = centres, tangents, normals, keys, twist
    for i, u in enumerate(us):
        width, height, exponent = _interp_keys(keys, u, ["widthMeters", "heightMeters", "exponent"])
        tau = math.radians(_interp_pairs(twist, u)) if twist else 0.0
        t, nrm = tangents[i], normals[i]
        b = _cross(t, nrm)
        n_tw = _add(_mul(nrm, math.cos(tau)), _mul(b, math.sin(tau)))
        b_tw = _sub(_mul(b, math.cos(tau)), _mul(nrm, math.sin(tau)))
        row, out = [], []
        for v in vs:
            theta = 2 * math.pi * v
            a, bb = _superellipse(theta, height / 2, width / 2, exponent)
            row.append(_add(centres[i], _add(_mul(n_tw, a), _mul(b_tw, bb))))
            na, nb = _section_normal(theta, height / 2, width / 2, exponent)
            out.append(_unit(_add(_mul(n_tw, na), _mul(b_tw, nb)), "sweep section normal"))
        surface.rows.append(row)
        surface.normals_out.append(out)
        surface.pole.append(False)
        surface.circumference.append(_ellipse_perimeter(width / 2, height / 2))
    if not closed:
        surface.caps = [(0, centres[0], _mul(tangents[0], -1.0)), (len(us) - 1, centres[-1], tangents[-1])]
    return surface


def _sweep_point(surface, u, angle_deg):
    """Attach point and outward normal on a sweep: the section at u, or an end face centre at u = 0 or 1."""
    if not surface.closed_u and u <= 1e-9:
        return surface._centres[0], _mul(surface._tangents[0], -1.0)
    if not surface.closed_u and u >= 1 - 1e-9:
        return surface._centres[-1], surface._tangents[-1]
    us = surface.us
    if surface.closed_u and u > us[-1]:
        # Between the last sample and the start of a closed loop.
        i, j = len(us) - 1, 0
        w = (u - us[-1]) / (1.0 - us[-1])
    else:
        i = max(0, min(len(us) - 2, _bisect(us, u)))
        j = i + 1
        w = (u - us[i]) / (us[j] - us[i]) if us[j] > us[i] else 0.0
    centre = _lerp(surface._centres[i], surface._centres[j], w)
    t = _unit(_lerp(surface._tangents[i], surface._tangents[j], w), "sweep tangent")
    nrm = _lerp(surface._normals[i], surface._normals[j], w)
    nrm = _unit(_sub(nrm, _mul(t, _dot(nrm, t))), "sweep frame")
    width, height, exponent = _interp_keys(surface._keys, u, ["widthMeters", "heightMeters", "exponent"])
    tau = math.radians(_interp_pairs(surface._twist, u)) if surface._twist else 0.0
    b = _cross(t, nrm)
    n_tw = _add(_mul(nrm, math.cos(tau)), _mul(b, math.sin(tau)))
    b_tw = _sub(_mul(b, math.cos(tau)), _mul(nrm, math.sin(tau)))
    theta = math.radians(angle_deg)
    a, bb = _superellipse(theta, height / 2, width / 2, exponent)
    na, nb = _section_normal(theta, height / 2, width / 2, exponent)
    point = _add(centre, _add(_mul(n_tw, a), _mul(b_tw, bb)))
    return point, _unit(_add(_mul(n_tw, na), _mul(b_tw, nb)))


def _bisect(values, x):
    lo, hi = 0, len(values) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if values[mid] <= x:
            lo = mid
        else:
            hi = mid
    return lo


def _meridian_orientation(meridian):
    """+1 or -1: sign that turns a meridian tangent (dz, dr) into the outward normal (dr, -dz) * sign."""
    poly = list(meridian) + [(meridian[-1][0], 0.0), (meridian[0][0], 0.0)]
    area = 0.0
    for (z0, r0), (z1, r1) in zip(poly, poly[1:] + poly[:1]):
        area += z0 * r1 - z1 * r0
    if abs(area) < 1e-12:
        return 0
    return 1 if area > 0 else -1



def _round_meridian(meridian):
    """
    The meridian with every corner sharper than CREASE_DEGREES replaced by a quadratic fillet, and an end that stops
    off the axis first closed to it (so the cap's rim is a corner that is rounded too). Radii stay 0 or more: a fillet
    is a convex blend of points that are.
    """
    pts = list(meridian)
    if pts[0][1] > 1e-7:
        pts.insert(0, (pts[0][0], 0.0))
    if pts[-1][1] > 1e-7:
        pts.append((pts[-1][0], 0.0))
    zs = [z for z, _ in pts]
    scale = max(max(zs) - min(zs), max(r for _, r in pts))
    out = [pts[0]]
    for k in range(1, len(pts) - 1):
        a, b, c = pts[k - 1], pts[k], pts[k + 1]
        d1 = (b[0] - a[0], b[1] - a[1])
        d2 = (c[0] - b[0], c[1] - b[1])
        l1, l2 = math.hypot(*d1), math.hypot(*d2)
        if l1 < 1e-9 or l2 < 1e-9:
            out.append(b)
            continue
        turn = math.degrees(math.acos(max(-1.0, min(1.0, (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2)))))
        size = min(EDGE_ROUND_MAX_SHARE * min(l1, l2), EDGE_ROUND_FRACTION * scale)
        if turn <= CREASE_DEGREES or size < 1e-5:
            out.append(b)
            continue
        p0 = (b[0] - d1[0] / l1 * size, b[1] - d1[1] / l1 * size)
        p2 = (b[0] + d2[0] / l2 * size, b[1] + d2[1] / l2 * size)
        segs = max(2, int(math.ceil(turn / 15.0)))
        for i in range(segs + 1):
            t = i / float(segs)
            w0, w1, w2 = (1 - t) ** 2, 2 * t * (1 - t), t * t
            out.append((w0 * p0[0] + w1 * b[0] + w2 * p2[0], max(0.0, w0 * p0[1] + w1 * b[1] + w2 * p2[1])))
    out.append(pts[-1])
    return out

def _build_revolve(part, origin, edge, relief_ops):
    rv = part["revolve"]
    pid = part["id"]
    axis = _unit(tuple(float(x) for x in rv["axisDirection"]), 'part "%s": revolve.axisDirection' % pid)
    base = _add(origin, tuple(float(x) for x in rv["axisOrigin"]))
    e1 = _perpendicular_reference(axis)
    e2 = _cross(axis, e1)
    meridian = [(float(p[0]), float(p[1])) for p in rv["meridian"]]
    sign = _meridian_orientation(meridian)
    if sign == 0:
        raise SpecError('part "%s" revolve.meridian: the outline encloses no area with the axis, so it revolves into nothing; '
                        'trace the full outline from the axis and back, e.g. [[0, 0], [0, r], [h, r], [h, 0]] for a disc of radius r '
                        'and thickness h' % pid)
    lobes = int(rv["lobeCount"])
    depth = float(rv["lobeDepthRatio"])
    pitch = float(rv["helixPitchMeters"])

    def sample(mer):
        dense, knots = _dense_curve(mer, False, float(rv["smoothing"]))
        dense = [(z, max(0.0, r)) for z, r in dense]
        acc = _arc_lengths(dense)
        r_max = max(r for _, r in dense)
        max_perimeter = 2 * math.pi * r_max
        around = min(512, max(12, int(math.ceil(max_perimeter / edge)), 8 * lobes))
        around += (-around) % 4
        extra_u, extra_v = _relief_refinement(relief_ops, acc[-1], max_perimeter)
        us = _u_samples(acc, knots, edge, extra_u)
        vs = sorted(set([j / float(around) for j in range(around)] + list(extra_v)))
        return dense, knots, acc, us, vs

    # rounded corners unless the extra rows would put the part over its sample budget (then it keeps its sharp edges)
    rounded = _round_meridian(meridian)
    dense, knots, acc, us, vs = sample(rounded)
    if len(us) * len(vs) > PART_VERTEX_CAP:
        dense, knots, acc, us, vs = sample(meridian)
    else:
        meridian = rounded
    total = acc[-1]
    _check_grid_budget(pid, len(us), len(vs))

    surface = _Surface("revolve", pid)
    surface.us, surface.vs, surface.length = us, vs, total
    surface._axis, surface._base, surface._e1, surface._e2 = axis, base, e1, e2
    surface._dense, surface._acc, surface._sign = dense, acc, sign
    surface._lobes, surface._depth, surface._pitch = lobes, depth, pitch
    knot_u = [acc[k] / total for k in knots]
    for i, u in enumerate(us):
        z, r = _eval_at(dense, acc, u * total)
        nz, nr = _meridian_normal(surface, u)
        is_pole = r < 1e-7
        row, out = [], []
        for v in vs:
            phi = 2 * math.pi * v
            radial = _add(_mul(e1, math.cos(phi)), _mul(e2, math.sin(phi)))
            reff = _lobed_radius(surface, r, z, phi)
            row.append(_add(_add(base, _mul(axis, z)), _mul(radial, reff)))
            out.append(_unit(_add(_mul(axis, nz), _mul(radial, nr)), "revolve normal"))
        surface.rows.append(row)
        surface.normals_out.append(out)
        surface.pole.append(is_pole)
        surface.circumference.append(2 * math.pi * r)
    # Sharp meridian corners keep separate shading rings.
    for k in range(1, len(knot_u) - 1):
        if float(rv["smoothing"]) >= 1.0:
            break
        a, b, c = meridian[k - 1], meridian[k], meridian[k + 1]
        d1 = (b[0] - a[0], b[1] - a[1])
        d2 = (c[0] - b[0], c[1] - b[1])
        cosang = (d1[0] * d2[0] + d1[1] * d2[1]) / (math.hypot(*d1) * math.hypot(*d2))
        if math.degrees(math.acos(max(-1.0, min(1.0, cosang)))) > CREASE_DEGREES:
            idx = _bisect(us, knot_u[k] + 1e-13)
            if abs(us[idx] - knot_u[k]) < 1e-9:
                surface.crease_rows.add(idx)
    for end_index, row_index in ((0, 0), (-1, len(us) - 1)):
        z, r = dense[end_index]
        if r >= 1e-7:
            neighbour_z = next((p[0] for p in (dense[1:] if end_index == 0 else reversed(dense[:-1])) if abs(p[0] - z) > 1e-9), None)
            if neighbour_z is None:
                raise SpecError('part "%s" revolve.meridian: the %s end has radius %.4g m but every point shares its axial distance, '
                                'so the end cannot be capped; close it at the axis (radius 0) or give the points different axial distances'
                                % (pid, "first" if end_index == 0 else "last", r))
            outward = _mul(axis, 1.0 if z > neighbour_z else -1.0)
            surface.caps.append((row_index, _add(base, _mul(axis, z)), outward))
    return surface


def _lobed_radius(surface, r, z, phi):
    if surface._lobes <= 0 or surface._depth <= 0:
        return r
    shift = (2 * math.pi * z / surface._pitch) if abs(surface._pitch) > 1e-9 else 0.0
    return r * (1.0 - surface._depth * 0.5 * (1.0 - math.cos(surface._lobes * (phi - shift))))


def _meridian_normal(surface, u):
    total = surface._acc[-1]
    d = max(1e-5, 1e-4 * total)
    z0, r0 = _eval_at(surface._dense, surface._acc, max(0.0, u * total - d))
    z1, r1 = _eval_at(surface._dense, surface._acc, min(total, u * total + d))
    dz, dr = z1 - z0, r1 - r0
    n = math.hypot(dz, dr) or 1.0
    return surface._sign * dr / n, -surface._sign * dz / n


def _revolve_point(surface, u, angle_deg):
    """Attach point and outward normal on a revolve; u = 0 or 1 is the centre of that end (cap or pole)."""
    total = surface._acc[-1]
    axis, base = surface._axis, surface._base
    if u <= 1e-9 or u >= 1 - 1e-9:
        end = 0 if u <= 1e-9 else -1
        z, r = surface._dense[end]
        centre = _add(base, _mul(axis, z))
        cap = [c for c in surface.caps if (c[0] == 0) == (end == 0)]
        if cap:
            return centre, cap[0][2]
        nz, nr = _meridian_normal(surface, 0.0 if end == 0 else 1.0)
        return centre, _mul(axis, 1.0 if nz >= 0 else -1.0)
    z, r = _eval_at(surface._dense, surface._acc, u * total)
    phi = math.radians(angle_deg)
    radial = _add(_mul(surface._e1, math.cos(phi)), _mul(surface._e2, math.sin(phi)))
    nz, nr = _meridian_normal(surface, u)
    point = _add(_add(base, _mul(axis, z)), _mul(radial, _lobed_radius(surface, r, z, phi)))
    return point, _unit(_add(_mul(axis, nz), _mul(radial, nr)), "revolve normal")


def _surface_point(surface, u, angle_deg):
    if surface.kind == "sweep":
        return _sweep_point(surface, u, angle_deg)
    return _revolve_point(surface, u, angle_deg)


def _check_grid_budget(pid, rows, cols):
    if rows * cols > PART_VERTEX_CAP:
        raise SpecError('part "%s": needs %d x %d surface samples, over the %d-vertex budget for one part; '
                        'widen its relief (narrow grooves force dense sampling) or split it into shorter parts'
                        % (pid, rows, cols, PART_VERTEX_CAP))


# ---------------------------------------------------------------------------
# Relief and modulation: offsets applied along the outward normal in (u, v)
# ---------------------------------------------------------------------------

def _relief_refinement(relief_ops, length, perimeter):
    """
    Extra u or v samples near relief curves so each groove or bead gets about three samples across. Each segment
    is refined only in the direction that crosses it most directly: rows for curves that run around the part,
    columns for curves that run along it (a 45 degree spiral still gets four samples across its width).
    """
    extra_u, extra_v = [], []
    for rel in relief_ops:
        w = float(rel["widthMeters"])
        du = w / (3.0 * length)
        dv = w / (3.0 * max(perimeter, 1e-9))
        for curve in rel["curves"]:
            for (ua, va), (ub, vb) in zip(curve, curve[1:]):
                s_span = abs(ub - ua) * length
                v_span = abs(vb - va) * perimeter
                if v_span >= s_span:
                    lo, hi = min(ua, ub) - w / length, max(ua, ub) + w / length
                    steps = int(math.ceil((hi - lo) / du))
                    extra_u.extend(lo + (hi - lo) * k / steps for k in range(steps + 1))
                else:
                    lo, hi = min(va, vb) - w / perimeter, max(va, vb) + w / perimeter
                    steps = int(math.ceil((hi - lo) / dv))
                    extra_v.extend((lo + (hi - lo) * k / steps) % 1.0 for k in range(steps + 1))
    return [u for u in extra_u if 0.0 <= u <= 1.0], [round(v, 12) % 1.0 for v in extra_v]


def _relief_offsets(surface, relief_ops):
    """Offset field (metres along the outward normal) from every relief on this surface."""
    offsets = [[0.0] * len(surface.vs) for _ in surface.us]
    for rel in relief_ops:
        half = float(rel["widthMeters"]) / 2.0
        depth = float(rel["depthMeters"])
        sharp = float(rel["sharpness"])
        segments = []
        for curve in rel["curves"]:
            for (ua, va), (ub, vb) in zip(curve, curve[1:]):
                # Pieces of at most a quarter turn: the same straight line in (s, v), but each sample then measures
                # only the few pieces near it, instead of every wrap of a long spiral.
                pieces = max(1, int(math.ceil(abs(vb - va) / 0.25)))
                for k in range(pieces):
                    a, b = k / float(pieces), (k + 1) / float(pieces)
                    segments.append(((ua + (ub - ua) * a) * surface.length, va + (vb - va) * a,
                                     (ua + (ub - ua) * b) * surface.length, va + (vb - va) * b))
        for i, u in enumerate(surface.us):
            if surface.pole[i]:
                continue
            s = u * surface.length
            circ = max(surface.circumference[i], 1e-9)
            near = [g for g in segments if min(g[0], g[2]) - half <= s <= max(g[0], g[2]) + half]
            if not near:
                continue
            for j, v in enumerate(surface.vs):
                y = v * circ
                best = None
                for sa, va, sb, vb in near:
                    ya, yb = va * circ, vb * circ
                    lo = min(ya, yb) - half
                    hi = max(ya, yb) + half
                    # Only wraps that put the sample within half a width of the segment's v span can be near it.
                    k_lo = int(math.ceil((lo - y) / circ))
                    k_hi = int(math.floor((hi - y) / circ))
                    for k in range(k_lo, k_hi + 1):
                        d = _segment_distance(s, y + k * circ, sa, ya, sb, yb)
                        if best is None or d < best:
                            best = d
                if best is None or best >= half:
                    continue
                x = best / half
                f = 1.0 if x <= sharp else 0.5 * (1.0 + math.cos(math.pi * (x - sharp) / (1.0 - sharp)))
                # Nearest curve only, so crossing curves do not cut twice as deep; separate reliefs add up.
                offsets[i][j] += depth * f
    return offsets


def _segment_distance(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 < 1e-24 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _modulation_offsets(surface, mod):
    amp = float(mod["amplitudeMeters"])
    cpm = float(mod["cyclesPerMeter"])
    around = int(mod["cyclesAround"])
    offsets = []
    for i, u in enumerate(surface.us):
        along = math.cos(2 * math.pi * cpm * u * surface.length) if cpm > 0 else 1.0
        offsets.append([amp * along * (math.cos(2 * math.pi * around * v) if around > 0 else 1.0) for v in surface.vs])
    return offsets


# ---------------------------------------------------------------------------
# Meshing
# ---------------------------------------------------------------------------

class _MeshData(object):
    """Triangle mesh on plain lists, so transforms stay in Python until the final native mesh."""

    def __init__(self, positions, triangles):
        self.positions = positions
        self.triangles = triangles

    def transformed(self, fn):
        return _MeshData([fn(p) for p in self.positions], list(self.triangles))

    def reflected(self, normal):
        n = normal
        pos = [_sub(p, _mul(n, 2.0 * _dot(p, n))) for p in self.positions]
        return _MeshData(pos, [(a, c, b) for a, b, c in self.triangles])


def _mesh_surface(surface, offsets):
    """Grid (with offsets along the outward normal), shared seam, poles, crease rows and flat end caps."""
    rows, cols = len(surface.us), len(surface.vs)
    positions = []
    ring_index = []   # for each row: (indices used by the band before, indices used by the band after)
    for i in range(rows):
        if surface.pole[i]:
            p = surface.rows[i][0]
            positions.append(p)
            idx = [len(positions) - 1] * cols
            ring_index.append((idx, idx))
            continue
        ring = []
        for j in range(cols):
            off = offsets[i][j] if offsets is not None else 0.0
            positions.append(_add(surface.rows[i][j], _mul(surface.normals_out[i][j], off)))
            ring.append(len(positions) - 1)
        if i in surface.crease_rows:
            dup = []
            for j in range(cols):
                positions.append(positions[ring[j]])
                dup.append(len(positions) - 1)
            ring_index.append((ring, dup))
        else:
            ring_index.append((ring, ring))
    triangles = []
    samples = []
    bands = rows if surface.closed_u else rows - 1
    sample_step = max(1, (bands * cols) // 256)
    for i in range(bands):
        a_ring = ring_index[i][1]
        b_ring = ring_index[(i + 1) % rows][0]
        a_pole, b_pole = surface.pole[i], surface.pole[(i + 1) % rows]
        if a_pole and b_pole:
            continue
        for j in range(cols):
            j2 = (j + 1) % cols
            a0, a1, b0, b1 = a_ring[j], a_ring[j2], b_ring[j], b_ring[j2]
            if a_pole:
                triangles.append((a0, b0, b1))
            elif b_pole:
                triangles.append((a0, b0, a1))
            else:
                triangles.append((a0, b0, b1))
                triangles.append((a0, b1, a1))
            if (i * cols + j) % sample_step == 0:
                row = (i + 1) % rows if a_pole else i
                samples.append((triangles[-1], surface.normals_out[row][j]))
    body_count = len(triangles)
    for row_index, centre, _outward in surface.caps:
        if surface.pole[row_index]:
            continue
        ring = []
        for j in range(cols):
            positions.append(positions[ring_index[row_index][0][j]])
            ring.append(len(positions) - 1)
        positions.append(centre)
        c = len(positions) - 1
        for j in range(cols):
            triangles.append((c, ring[j], ring[(j + 1) % cols]))
    mesh = _MeshData(positions, triangles)
    _orient(mesh, surface, body_count, samples)
    return mesh


def _orient(mesh, surface, body_count, samples):
    """
    Makes every triangle face outward: the body by agreement with the analytic outward normals at sampled grid
    quads, each cap by its outward normal.
    """
    pos = mesh.positions
    body = mesh.triangles[:body_count]
    caps = mesh.triangles[body_count:]
    agree = 0.0
    for tri, outward in samples:
        a, b, c = tri
        agree += _dot(_cross(_sub(pos[b], pos[a]), _sub(pos[c], pos[a])), outward)
    if agree < 0:
        body = [(a, c, b) for a, b, c in body]
    fixed_caps = []
    per_cap = len(surface.vs)
    live_caps = [cap for cap in surface.caps if not surface.pole[cap[0]]]
    for k, (_, _, outward) in enumerate(live_caps):
        tris = caps[k * per_cap:(k + 1) * per_cap]
        total = (0.0, 0.0, 0.0)
        for a, b, c in tris:
            total = _add(total, _cross(_sub(pos[b], pos[a]), _sub(pos[c], pos[a])))
        if _dot(total, outward) < 0:
            tris = [(a, c, b) for a, b, c in tris]
        fixed_caps.extend(tris)
    mesh.triangles = body + fixed_caps


def _vertex_normals(mesh):
    normals = [(0.0, 0.0, 0.0)] * len(mesh.positions)
    acc = [[0.0, 0.0, 0.0] for _ in mesh.positions]
    pos = mesh.positions
    for a, b, c in mesh.triangles:
        n = _cross(_sub(pos[b], pos[a]), _sub(pos[c], pos[a]))
        for idx in (a, b, c):
            acc[idx][0] += n[0]
            acc[idx][1] += n[1]
            acc[idx][2] += n[2]
    for i, n in enumerate(acc):
        length = math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2])
        normals[i] = (n[0] / length, n[1] / length, n[2] / length) if length > 1e-20 else (0.0, 1.0, 0.0)
    return normals


# ---------------------------------------------------------------------------
# Spec -> geometry
# ---------------------------------------------------------------------------

def _estimate_area(part):
    if part.get("sweep"):
        sw = part["sweep"]
        pts = sw["controlPoints"]
        length = sum(_length(_sub(pts[i], pts[i - 1])) for i in range(1, len(pts)))
        if sw["closedLoop"]:
            length += _length(_sub(pts[0], pts[-1]))
        perim = sum(_ellipse_perimeter(k["widthMeters"] / 2, k["heightMeters"] / 2) for k in sw["profile"]) / len(sw["profile"])
        return length * perim
    rv = part["revolve"]
    mer = rv["meridian"]
    area = 0.0
    for (z0, r0), (z1, r1) in zip(mer, mer[1:]):
        area += math.pi * (r0 + r1) * math.hypot(z1 - z0, r1 - r0)
    return area + math.pi * (mer[0][1] ** 2 + mer[-1][1] ** 2)


def _multiplicities(spec, by_id, children, seeds):
    """How many instances of each geometric part the spec emits."""
    counts = {}

    def walk(pid, factor):
        part = by_id[pid]
        f = factor * (2 if part.get("mirrorPlaneNormal") else 1)
        if part.get("relief") or part.get("crown"):
            return
        if part.get("replicate"):
            rep = part["replicate"]
            copies = (rep.get("ring") or rep.get("path"))["count"]
            walk(rep["seedPartId"], f * copies)
            return
        counts[pid] = counts.get(pid, 0) + f
        for child in children.get(pid, []):
            if child not in seeds:
                walk(child, f)

    for part in spec["parts"]:
        if not part.get("parentId") and part["id"] not in seeds:
            walk(part["id"], 1)
    return counts


def _naming_part(pid, err):
    """The same problems, each naming the part it belongs to."""
    return SpecError([p if p.startswith("part ") else 'part "%s": %s' % (pid, p) for p in err.problems])


def crown_trees(spec, shift_y=0.0):
    """The spec's crown parts as SB-Veggie trees (vegetation.SbVeggieTree), lifted by shift_y like the meshes."""
    from . import vegetation
    trees = []
    for p in spec["parts"]:
        c = p.get("crown")
        if not c:
            continue
        x, y, z = (float(v) for v in c["trunkBaseMeters"])
        tree = vegetation.SbVeggieTree(
            position=(x, y + shift_y, z), height=float(c["heightMeters"]),
            crown_radius=(float(c["crownRadiiMeters"][0]), float(c["crownRadiiMeters"][1])),
            crown_base_height=float(c["crownBaseHeightMeters"]) if _given(c, "crownBaseHeightMeters") else None,
            crown_widest_at=float(c["crownWidestAt"]) if _given(c, "crownWidestAt") else 0.5,
            crown_top_exponent=float(c["crownTopExponent"]) if _given(c, "crownTopExponent") else 2.0,
            trunk_radius=float(c["trunkRadiusMeters"]) if _given(c, "trunkRadiusMeters") else None,
            label=str(p.get("label") or p["id"]), name=p["id"])
        material = p.get("material")
        if isinstance(material, dict) and _is_vec(material.get("baseColor"), 3):
            # the part's material is linear RGB already: the foliage colour the species and leaf textures are chosen by
            tree.leaf_linear_rgb = [min(1.0, max(0.0, float(v))) for v in material["baseColor"]]
        trees.append(tree)
    return trees


def build_meshes(spec):
    """Validates and builds the spec; returns [(part id, positions, normals, triangles)] in spec order."""
    return _build_meshes(spec)[0]


def _build_meshes(spec):
    """build_meshes, and the lift every part (and every crown's trunk base) was given so the lowest point rests on y = 0."""
    problems = validate(spec)
    if problems:
        raise SpecError(problems)
    parts = spec["parts"]
    by_id = dict((p["id"], p) for p in parts)
    children = {}
    for p in parts:
        if p.get("parentId"):
            children.setdefault(p["parentId"], []).append(p["id"])
    seeds = set(p["replicate"]["seedPartId"] for p in parts if p.get("replicate"))
    reliefs = {}
    relief_owner = {}
    for p in parts:
        if p.get("relief"):
            reliefs.setdefault(p["relief"]["targetPartId"], []).append(p["relief"])
            relief_owner[id(p["relief"])] = p["id"]

    # One edge length for the whole object, from its estimated surface area and instance counts.
    counts = _multiplicities(spec, by_id, children, seeds)
    total_area = sum(_estimate_area(by_id[pid]) * n for pid, n in counts.items())
    diag = _length(tuple(float(b) for b in spec["boundingMeters"]))
    edge = math.sqrt(max(total_area, 1e-12) / TARGET_VERTICES)
    edge = min(max(edge, diag / 3000.0), diag / 30.0)

    # Surfaces, parents before children; a child's coordinates are offsets from its attach point.
    surfaces = {}

    def build_surface(pid):
        if pid in surfaces:
            return surfaces[pid]
        part = by_id[pid]
        origin = (0.0, 0.0, 0.0)
        parent = build_surface(part["parentId"]) if part.get("parentId") else None
        try:
            if parent is not None:
                att = part["attach"]
                point, normal = _surface_point(parent, float(att["u"]), float(att["angleDeg"]))
                origin = _add(point, _mul(normal, float(att["normalOffsetMeters"])))
            ops = reliefs.get(pid, [])
            if part.get("sweep"):
                surface = _build_sweep(part, origin, edge, ops)
            else:
                surface = _build_revolve(part, origin, edge, ops)
        except SpecError as err:
            raise _naming_part(pid, err)
        surfaces[pid] = surface
        return surface

    meshes = {}

    def part_mesh(pid):
        if pid not in meshes:
            surface = build_surface(pid)
            offsets = None
            ops = reliefs.get(pid, [])
            mod = by_id[pid].get("sweep", {}).get("modulation") if by_id[pid].get("sweep") else None
            fields = []
            missed = []
            for op in ops:
                # Each relief must actually cut or raise the surface it names; one that lands on no sample was not built.
                field = _relief_offsets(surface, [op])
                reached = max(abs(x) for row in field for x in row)
                if reached < 0.5 * abs(float(op["depthMeters"])):
                    missed.append('part "%s" relief.curves: displaced "%s" by at most %.3g m of the %.3g m asked for, so the relief '
                                  'is not built; put its curves on that part\'s surface (u along it, v around it) and make widthMeters '
                                  'wider than its sample spacing' % (relief_owner[id(op)], pid, reached, abs(float(op["depthMeters"]))))
                fields.append(field)
            if missed:
                raise SpecError(missed)
            if mod:
                fields.append(_modulation_offsets(surface, mod))
            if fields:
                offsets = [[0.0] * len(surface.vs) for _ in surface.us]
                for field in fields:
                    for i in range(len(offsets)):
                        row, add = offsets[i], field[i]
                        for j in range(len(row)):
                            row[j] += add[j]
            try:
                meshes[pid] = _mesh_surface(surface, offsets)
            except SpecError as err:
                raise _naming_part(pid, err)
        return meshes[pid]

    # Build every surface and mesh up front so the error lists every problem at once, not the first one found.
    # A part whose parent failed fails with its parent's problem; each problem is listed once.
    build_problems = []
    for part in parts:
        if not (part.get("sweep") or part.get("revolve")):
            continue
        try:
            part_mesh(part["id"])
        except SpecError as err:
            build_problems.extend(p for p in err.problems if p not in build_problems)
    if build_problems:
        raise SpecError(build_problems)

    # Every copy repeats its part's mesh, so the triangle total is known before any copy is made.
    predicted_tris = sum(len(meshes[pid].triangles) * n for pid, n in counts.items() if pid in meshes)
    if predicted_tris > MAX_TRIANGLES:
        raise SpecError("the spec builds %d triangles (limit %d); use fewer copies or fewer parts" % (predicted_tris, MAX_TRIANGLES))

    def emit(pid):
        """[(owner id, _MeshData)] for a part and everything attached to it, after replicate and mirror."""
        part = by_id[pid]
        if part.get("relief") or part.get("crown"):
            return []
        if part.get("replicate"):
            rep = part["replicate"]
            base = emit(rep["seedPartId"])
            pieces = []
            if rep.get("ring"):
                ring = rep["ring"]
                axis = _unit(tuple(float(x) for x in ring["axisDirection"]))
                centre = tuple(float(x) for x in ring["centerMeters"])
                step = math.radians(float(ring["spanDeg"])) / int(ring["count"])
                rise = float(ring["risePerCopyMeters"])
                for k in range(int(ring["count"])):
                    angle, lift = step * k, _mul(axis, rise * k)
                    fn = (lambda a, l: lambda p: _add(_add(centre, _rotate(_sub(p, centre), axis, a)), l))(angle, lift)
                    pieces.extend((owner, mesh.transformed(fn)) for owner, mesh in base)
            else:
                try:
                    pieces.extend(_path_copies(rep["path"], base))
                except SpecError as err:
                    raise _naming_part(pid, err)
        else:
            pieces = [(pid, part_mesh(pid))]
            for child in children.get(pid, []):
                if child not in seeds:
                    pieces.extend(emit(child))
        if part.get("mirrorPlaneNormal"):
            n = _unit(tuple(float(x) for x in part["mirrorPlaneNormal"]))
            pieces = pieces + [(owner, mesh.reflected(n)) for owner, mesh in pieces]
        return pieces

    pieces = []
    for part in parts:
        if not part.get("parentId") and part["id"] not in seeds:
            pieces.extend(emit(part["id"]))

    # the lowest point rests on y = 0; a crown's trunk base counts (crown parts are grown, not meshed here)
    lows = [p[1] for _, mesh in pieces for p in mesh.positions]
    lows.extend(float(p["crown"]["trunkBaseMeters"][1]) for p in parts if p.get("crown"))
    min_y = min(lows)
    merged = []
    order = [p["id"] for p in parts]
    by_owner = {}
    for owner, mesh in pieces:
        by_owner.setdefault(owner, []).append(mesh)
    total_tris = sum(len(m.triangles) for ms in by_owner.values() for m in ms)
    if total_tris > MAX_TRIANGLES:
        raise SpecError("the spec builds %d triangles (limit %d); use fewer copies or fewer parts" % (total_tris, MAX_TRIANGLES))
    for owner in order:
        if owner not in by_owner:
            continue
        positions, triangles = [], []
        for mesh in by_owner[owner]:
            base = len(positions)
            positions.extend((p[0], p[1] - min_y, p[2]) for p in mesh.positions)
            triangles.extend((a + base, b + base, c + base) for a, b, c in mesh.triangles)
        combined = _MeshData(positions, triangles)
        merged.append((owner, positions, _vertex_normals(combined), triangles))
    return merged, -min_y


def _path_copies(path, base):
    pts = [tuple(float(x) for x in p) for p in path["points"]]
    dense, _ = _dense_curve(pts, False, 1.0 if len(pts) > 2 else 0.0)
    acc = _arc_lengths(dense)
    count = int(path["count"])
    samples = [_eval_at(dense, acc, acc[-1] * k / (count - 1)) for k in range(count)]
    p0 = samples[0]
    pieces = []
    if path["orientToPath"]:
        # Frames along the dense path, then copy k turns the first frame onto frame k.
        tangents, normals = _rmf_frames(dense, False, (0.0, 1.0, 0.0), "replicate.path.points")
        frames = []
        for k in range(count):
            s = acc[-1] * k / (count - 1)
            i = max(0, min(len(acc) - 1, _bisect(acc, s)))
            t, n = tangents[i], normals[i]
            frames.append((t, n, _cross(t, n)))
        t0, n0, b0 = frames[0]
        for k in range(count):
            tk, nk, bk = frames[k]
            pk = samples[k]

            def fn(p, t0=t0, n0=n0, b0=b0, tk=tk, nk=nk, bk=bk, pk=pk):
                d = _sub(p, p0)
                ct, cn, cb = _dot(d, t0), _dot(d, n0), _dot(d, b0)
                return _add(pk, _add(_add(_mul(tk, ct), _mul(nk, cn)), _mul(bk, cb)))
            pieces.extend((owner, mesh.transformed(fn)) for owner, mesh in base)
    else:
        for k in range(count):
            shift = _sub(samples[k], p0)
            pieces.extend((owner, mesh.transformed(lambda p, s=shift: _add(p, s))) for owner, mesh in base)
    return pieces


def part_material(sb, pid, material):
    """A native PbrMaterial holding a part's material factors exactly (studio clay when it has none)."""
    if not material:
        return sb.PbrMaterial.clay()
    mat = sb.geometry.PbrMaterial(str(pid))
    r, g, b = (float(x) for x in material["baseColor"])
    mat.base_color = sb.math.Vec4(r, g, b, 1.0)
    mat.roughness = float(material["roughness"])
    mat.metallic = float(material["metalness"])
    mat.transmission = float(material["transmission"])
    mat.ior = float(material["ior"]) if _given(material, "ior") else 1.5
    mat.clearcoat = float(material["clearcoat"]) if _given(material, "clearcoat") else 0.0
    if _given(material, "emissive"):
        er, eg, eb = (float(x) for x in material["emissive"])
        mat.emissive = sb.math.Vec3(er, eg, eb)
        mat.emissive_intensity = float(material["emissiveStrength"]) if _given(material, "emissiveStrength") else 1.0
    else:
        mat.emissive = sb.math.Vec3(0.0, 0.0, 0.0)
        mat.emissive_intensity = 1.0
    # A see-through surface is seen from inside too (the far wall of a bottle).
    mat.double_sided = mat.transmission > 0.0
    return mat



# Ambient occlusion baked into vertex colour: rays per vertex, and how far a ray looks as a share of the object's diagonal
AO_SAMPLES = 32
AO_REACH_SHARE = 0.12
AO_INTENSITY = 0.85


def _occlusion(sb, built):
    """
    Per part, per vertex, the grey multiplier lerp(1, ao, AO_INTENSITY), with ao ray-traced over every part at once (a
    bonnet shades the body under it, a chain the boss it hangs from), not part by part.
    """
    combined = sb.geometry.Mesh("occlusion")
    lo, hi = [float("inf")] * 3, [float("-inf")] * 3
    start = 0
    for _owner, positions, normals, triangles in built:
        for p, n in zip(positions, normals):
            combined.add_vertex(sb.math.Vec3(p[0], p[1], p[2]), sb.math.Vec3(n[0], n[1], n[2]))
            for k in range(3):
                lo[k] = min(lo[k], p[k])
                hi[k] = max(hi[k], p[k])
        for a, b, c in triangles:
            combined.add_triangle(a + start, b + start, c + start)
        start += len(positions)
    if start == 0:
        return [[] for _ in built]
    diagonal = math.sqrt(sum((hi[k] - lo[k]) ** 2 for k in range(3)))
    ao = list(combined.compute_rtao(AO_SAMPLES, max(0.01, AO_REACH_SHARE * diagonal), 42))
    out, i = [], 0
    for _owner, positions, _n, _t in built:
        out.append([1.0 + (ao[i + j] - 1.0) * AO_INTENSITY for j in range(len(positions))])
        i += len(positions)
    return out

def build(spec, clay=False):
    """
    Builds the spec into an sb.Scene: one mesh per part, the lowest point resting on y = 0. Each part's mesh (with
    its replicated and mirrored copies) carries the part's material factors; with clay=True, or for a part without a
    material, it is studio clay.
    """
    import scratchbox as sb
    vec3 = sb.math.Vec3
    scene = sb.Scene()
    built, shift_y = _build_meshes(spec)   # validates first
    # crown parts are SB-Veggie trees, grown natively when the scene is written (studio clay or not: a tree's
    # leaves and bark come from the tree texture library by its foliage colour)
    for tree in crown_trees(spec, shift_y):
        scene.add(tree)
    materials = {} if clay else dict((p["id"], p.get("material")) for p in spec["parts"])
    occlusion = _occlusion(sb, built)
    for (owner, positions, normals, triangles), occ in zip(built, occlusion):
        mesh = sb.geometry.Mesh(owner)
        uv0 = sb.math.Vec2(0.0, 0.0)
        for p, n, o in zip(positions, normals, occ):
            mesh.add_vertex(vec3(p[0], p[1], p[2]), vec3(n[0], n[1], n[2]), uv0, sb.math.Vec4(o, o, o, 1.0))
        for a, b, c in triangles:
            mesh.add_triangle(a, b, c)
        mesh.recompute_bounds()
        # Assigned directly, not through apply_material, which also paints the base colour into the vertex colours:
        # glTF viewers multiply COLOR_0 by baseColorFactor, which would square every colour. The vertex colour carries
        # only the grey ambient occlusion, which darkens creases without changing the part's colour.
        mesh.material = part_material(sb, owner, materials.get(owner))
        scene.add_mesh(mesh)
    return scene
