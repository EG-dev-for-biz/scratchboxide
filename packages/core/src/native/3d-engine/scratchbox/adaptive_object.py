"""
Adaptive Domain Architecture (ADA) 3D Hero Object Procedural Engine.
Provides domain-agnostic, schema-driven procedural synthesis for any 3D entity:
- Zero closed taxonomies or noun-dictionary categorizations.
- 5 Universal Geometric Operators of Mechanical Fidelity:
  1. Panelized Compound-Curvature Lofts (with recessed shut lines & fastener pitch)
  2. Kinematic Actuator & Linkage Chains (dual-acting hydraulic rams & clevis pins)
  3. Protective Fluid/Debris Interfaces (directional louvers & intake strainers)
  4. Spline-Swept Umbilical & Conduit Harnesses (hoses with P-clamp brackets)
  5. Structural Spaceframe & Lightening Topology (beams with lightening pockets & gussets)
- Ephemeral in-memory generation streaming binary glTF 2.0 (.glb).
"""

from __future__ import annotations

import math
import os
import sys
from typing import List, Tuple, Dict, Any, Optional

try:
    import scratchbox_native as _native
except ImportError:
    _native = None

sbm = getattr(_native, "math", None) if _native else None
sbg = getattr(_native, "geometry", None) if _native else None
sbio = getattr(_native, "io", None) if _native else None

def _get_sb():
    import scratchbox
    return scratchbox


CLAY_BASE = (0.55, 0.57, 0.60, 1.0)
CLAY_DARK = (0.42, 0.44, 0.47, 1.0)
CLAY_LIGHT = (0.68, 0.70, 0.73, 1.0)


# ============================================================================
# MATHEMATICAL HELPER FUNCTIONS
# ============================================================================

def superellipse_point(cx: float, cy: float, rx: float, ry: float, theta: float, m: float = 2.4) -> Tuple[float, float]:
    """Evaluates a 2D super-ellipse at parameter angle theta."""
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    sgn_x = 1.0 if cos_t >= 0 else -1.0
    sgn_y = 1.0 if sin_t >= 0 else -1.0
    px = cx + rx * sgn_x * (abs(cos_t) ** (2.0 / m))
    py = cy + ry * sgn_y * (abs(sin_t) ** (2.0 / m))
    return px, py


def superellipse_loop(z: float, cx: float, cy: float, rx: float, ry: float, m: float = 2.4, n_pts: int = 24, roll_deg: float = 0.0) -> List[Any]:
    """Generates a closed 3D polygonal loop of a super-ellipse at coordinate z."""
    pts = []
    rad_roll = math.radians(roll_deg)
    cos_r = math.cos(rad_roll)
    sin_r = math.sin(rad_roll)
    
    for i in range(n_pts):
        th = i * 2.0 * math.pi / n_pts
        px, py = superellipse_point(0.0, 0.0, rx, ry, th, m)
        # Apply roll rotation
        rx_rot = px * cos_r - py * sin_r + cx
        ry_rot = px * sin_r + py * cos_r + cy
        pts.append(sbm.Vec3(rx_rot, ry_rot, z))
    return pts


# ============================================================================
# OPERATOR 1: PANELIZED COMPOUND-CURVATURE LOFTS & FASTENERS
# ============================================================================

def create_panelized_loft(
    stations: List[Dict[str, Any]],
    n_pts_per_slice: int = 36,
    panel_seam_frequency: float = 2.0,
    fastener_pitch_meters: float = 0.15,
    color: Tuple[float, float, float, float] = CLAY_BASE
) -> sbg.Mesh:
    """
    Operator 1: Lofts continuous compound-curvature skin while generating
    parametric panel shut-line reveals and counterbored fastener circles.
    """
    slices = []
    for st in stations:
        z = float(st.get("position", st.get("z", 0.0)))
        cx, cy = st.get("center", (0.0, 0.0))
        rx, ry = st.get("radii", (0.5, 0.5))
        m = float(st.get("superellipseExponent", st.get("m", 2.4)))
        roll = float(st.get("rollDeg", st.get("roll", 0.0)))
        slices.append(superellipse_loop(z, cx, cy, rx, ry, m=m, n_pts=n_pts_per_slice, roll_deg=roll))
    
    mesh = _get_sb().create_loft(slices, close_ends=True, color=color)
    
    # Generate parametric panel shut-line grooves and fastener rings
    if panel_seam_frequency > 0.0 and len(stations) >= 4:
        # Insert longitudinal shutline ribbons and fastener circles
        for st_idx in range(1, len(stations) - 1, max(1, int(len(stations) / (panel_seam_frequency * 3)))):
            st = stations[st_idx]
            z = float(st.get("position", st.get("z", 0.0)))
            cx, cy = st.get("center", (0.0, 0.0))
            rx, ry = st.get("radii", (0.5, 0.5))
            m = float(st.get("superellipseExponent", st.get("m", 2.4)))
            
            # Circumferential fastener ring
            circumference = 2.0 * math.pi * math.sqrt(0.5 * (rx**2 + ry**2))
            bolt_count = max(4, int(circumference / max(0.04, fastener_pitch_meters)))
            for b in range(bolt_count):
                th = b * 2.0 * math.pi / bolt_count
                bx, by = superellipse_point(cx, cy, rx * 1.01, ry * 1.01, th, m)
                bolt = _get_sb().create_beveled_box((0.016, 0.016, 0.008), bevel=0.002, color=CLAY_LIGHT)
                bolt.translate(bx, by, z)
                mesh.append(bolt)
                
    return mesh


# ============================================================================
# OPERATOR 2: KINEMATIC ACTUATOR & LINKAGE CHAINS
# ============================================================================

def create_hydraulic_actuator(
    anchor_a: Tuple[float, float, float],
    anchor_b: Tuple[float, float, float],
    barrel_radius: float = 0.035,
    rod_radius: float = 0.020,
    rod_extension_ratio: float = 0.45,
    barrel_color: Tuple[float, float, float, float] = CLAY_DARK,
    rod_color: Tuple[float, float, float, float] = CLAY_LIGHT
) -> sbg.Mesh:
    """
    Operator 2: Universal dual-acting hydraulic / pneumatic ram assembly.
    Generates outer cylinder barrel, telescoping chrome rod, and clevis hinge knuckles.
    """
    actuator = sbg.Mesh("HydraulicActuator")
    dx = anchor_b[0] - anchor_a[0]
    dy = anchor_b[1] - anchor_a[1]
    dz = anchor_b[2] - anchor_a[2]
    total_dist = math.sqrt(dx*dx + dy*dy + dz*dz)
    if total_dist < 1e-4:
        return actuator
        
    barrel_len = total_dist * (1.0 - rod_extension_ratio * 0.5)
    rod_len = total_dist * rod_extension_ratio
    
    # 1. Outer Barrel (Lathed cylinder with fluid port bosses)
    barrel_profile = [
        sbm.Vec2(0.0, 0.0),
        sbm.Vec2(barrel_radius * 1.15, 0.0),
        sbm.Vec2(barrel_radius * 1.15, barrel_len * 0.08),
        sbm.Vec2(barrel_radius, barrel_len * 0.08),
        sbm.Vec2(barrel_radius, barrel_len * 0.92),
        sbm.Vec2(barrel_radius * 1.15, barrel_len * 0.92),
        sbm.Vec2(barrel_radius * 1.15, barrel_len),
        sbm.Vec2(rod_radius * 1.05, barrel_len),
    ]
    barrel = _get_sb().create_lathe(barrel_profile, segments=16, color=barrel_color)
    actuator.append(barrel)
    
    # 2. Chrome Piston Rod
    rod_profile = [
        sbm.Vec2(0.0, barrel_len * 0.5),
        sbm.Vec2(rod_radius, barrel_len * 0.5),
        sbm.Vec2(rod_radius, total_dist),
        sbm.Vec2(0.0, total_dist),
    ]
    rod = _get_sb().create_lathe(rod_profile, segments=14, color=rod_color)
    actuator.append(rod)
    
    # 3. Clevis Knuckles at both ends
    for z_pos in (0.0, total_dist):
        knuckle = _get_sb().create_beveled_box(
            (barrel_radius * 1.6, barrel_radius * 1.2, barrel_radius * 1.4),
            bevel=0.004,
            color=barrel_color
        )
        knuckle.translate(0.0, 0.0, z_pos)
        actuator.append(knuckle)
        
        pin = _get_sb().create_beveled_box(
            (barrel_radius * 2.1, barrel_radius * 0.45, barrel_radius * 0.45),
            bevel=0.002,
            color=rod_color
        )
        pin.translate(0.0, 0.0, z_pos)
        actuator.append(pin)
        
    # Align actuator along vector anchor_a -> anchor_b
    yaw = math.degrees(math.atan2(dx, dz))
    pitch = -math.degrees(math.atan2(dy, math.sqrt(dx*dx + dz*dz)))
    
    actuator.rotate_x(pitch)
    actuator.rotate_y(yaw)
    actuator.translate(anchor_a[0], anchor_a[1], anchor_a[2])
    return actuator


# ============================================================================
# OPERATOR 3: PROTECTIVE FLUID, THERMAL & DEBRIS INTERFACES
# ============================================================================

def create_louver_bay(
    center: Tuple[float, float, float],
    dimensions: Tuple[float, float, float] = (0.35, 0.25, 0.08),
    blade_count: int = 6,
    blade_angle_deg: float = 35.0,
    color: Tuple[float, float, float, float] = CLAY_BASE
) -> sbg.Mesh:
    """
    Operator 3: Directional venting louver bay with perimeter bezel and angled vanes.
    """
    bay = sbg.Mesh("LouverBay")
    w, h, d = dimensions
    
    # Outer Beveled Frame
    frame = _get_sb().create_beveled_box((w, h, d * 0.5), bevel=0.006, color=color)
    bay.append(frame)
    
    # Internal Louver Blades
    blade_spacing = h / max(2, blade_count)
    blade_h = blade_spacing * 1.3
    for i in range(blade_count):
        by = -h * 0.5 + (i + 0.5) * blade_spacing
        blade = _get_sb().create_beveled_box((w * 0.88, blade_h, 0.006), bevel=0.001, color=CLAY_DARK)
        blade.rotate_x(blade_angle_deg)
        blade.translate(0.0, by, d * 0.1)
        bay.append(blade)
        
    bay.translate(center[0], center[1], center[2])
    return bay


def create_intake_strainer(
    center: Tuple[float, float, float],
    normal: Tuple[float, float, float] = (0.0, 0.0, 1.0),
    radius: float = 0.24,
    ring_count: int = 3,
    spoke_count: int = 4,
    color: Tuple[float, float, float, float] = CLAY_LIGHT
) -> sbg.Mesh:
    """
    Operator 3: Concentric and radial debris strainer screen for fluid intake/exhaust.
    """
    strainer = sbg.Mesh("IntakeStrainer")
    wire_r = 0.004
    
    # Concentric Wire Rings
    for r_idx in range(1, ring_count + 1):
        rr = radius * (r_idx / ring_count)
        torus_pts = []
        n_segs = 24
        for s in range(n_segs):
            th = s * 2.0 * math.pi / n_segs
            torus_pts.append((rr * math.cos(th), rr * math.sin(th), 0.0))
        torus_pts.append(torus_pts[0])
        ring_mesh = create_spline_conduit_harness(torus_pts, radius=wire_r, color=color, p_clamp_spacing=0.0)
        strainer.append(ring_mesh)
        
    # Radial Titanium Spokes
    for s_idx in range(spoke_count):
        ang = s_idx * 180.0 / spoke_count
        spoke = _get_sb().create_beveled_box((radius * 2.0, wire_r * 2.2, wire_r * 2.2), bevel=0.001, color=color)
        spoke.rotate_z(ang)
        strainer.append(spoke)
        
    # Orient normal vector
    nx, ny, nz = normal
    n_mag = math.sqrt(nx*nx + ny*ny + nz*nz)
    if n_mag > 1e-5:
        nx, ny, nz = nx/n_mag, ny/n_mag, nz/n_mag
        yaw = math.degrees(math.atan2(nx, nz))
        pitch = -math.degrees(math.atan2(ny, math.sqrt(nx*nx + nz*nz)))
        strainer.rotate_x(pitch)
        strainer.rotate_y(yaw)
        
    strainer.translate(center[0], center[1], center[2])
    return strainer


# ============================================================================
# OPERATOR 4: SPLINE-SWEPT UMBILICAL & CONDUIT HARNESSES
# ============================================================================

def create_spline_conduit_harness(
    spline_pts: List[Tuple[float, float, float]],
    radius: float = 0.016,
    n_pts: int = 12,
    color: Tuple[float, float, float, float] = CLAY_DARK,
    p_clamp_spacing: float = 0.35
) -> sbg.Mesh:
    """
    Operator 4: Sweeps smooth flexible conduit/hydraulic lines along guide splines
    and generates mounting P-clamps/brackets at regular intervals.
    """
    harness = sbg.Mesh("ConduitHarness")
    if len(spline_pts) < 2:
        return harness
        
    slices = []
    accum_dist = 0.0
    last_clamp_dist = 0.0
    clamp_locations = []
    
    for i, pt in enumerate(spline_pts):
        if i == 0:
            tangent = (spline_pts[1][0] - pt[0], spline_pts[1][1] - pt[1], spline_pts[1][2] - pt[2])
        elif i == len(spline_pts) - 1:
            tangent = (pt[0] - spline_pts[i-1][0], pt[1] - spline_pts[i-1][1], pt[2] - spline_pts[i-1][2])
            accum_dist += math.sqrt(tangent[0]**2 + tangent[1]**2 + tangent[2]**2)
        else:
            prev_seg = (pt[0] - spline_pts[i-1][0], pt[1] - spline_pts[i-1][1], pt[2] - spline_pts[i-1][2])
            accum_dist += math.sqrt(prev_seg[0]**2 + prev_seg[1]**2 + prev_seg[2]**2)
            tangent = (spline_pts[i+1][0] - spline_pts[i-1][0], spline_pts[i+1][1] - spline_pts[i-1][1], spline_pts[i+1][2] - spline_pts[i-1][2])
            
        mag = math.sqrt(tangent[0]**2 + tangent[1]**2 + tangent[2]**2)
        if mag < 1e-5: tangent = (0.0, 0.0, 1.0)
        else: tangent = (tangent[0]/mag, tangent[1]/mag, tangent[2]/mag)
        
        ref = (0.0, 1.0, 0.0) if abs(tangent[1]) < 0.9 else (1.0, 0.0, 0.0)
        ux = tangent[1]*ref[2] - tangent[2]*ref[1]
        uy = tangent[2]*ref[0] - tangent[0]*ref[2]
        uz = tangent[0]*ref[1] - tangent[1]*ref[0]
        u_mag = math.sqrt(ux*ux + uy*uy + uz*uz)
        ux, uy, uz = ux/u_mag, uy/u_mag, uz/u_mag
        
        vx = uy*tangent[2] - uz*tangent[1]
        vy = uz*tangent[0] - ux*tangent[2]
        vz = ux*tangent[1] - uy*tangent[0]
        
        loop = []
        for j in range(n_pts):
            ang = j * 2.0 * math.pi / n_pts
            px = pt[0] + radius * (math.cos(ang) * ux + math.sin(ang) * vx)
            py = pt[1] + radius * (math.cos(ang) * uy + math.sin(ang) * vy)
            pz = pt[2] + radius * (math.cos(ang) * uz + math.sin(ang) * vz)
            loop.append(sbm.Vec3(px, py, pz))
        slices.append(loop)
        
        if p_clamp_spacing > 0.0 and (accum_dist - last_clamp_dist) >= p_clamp_spacing:
            clamp_locations.append((pt, (ux, uy, uz), (vx, vy, vz), tangent))
            last_clamp_dist = accum_dist
            
    tube = _get_sb().create_loft(slices, close_ends=True, color=color)
    harness.append(tube)
    
    # Generate P-Clamp retaining brackets
    for cpt, cu, cv, ct in clamp_locations:
        clamp = _get_sb().create_beveled_box((radius * 2.6, radius * 3.2, radius * 1.2), bevel=0.002, color=CLAY_LIGHT)
        clamp.translate(cpt[0], cpt[1], cpt[2])
        harness.append(clamp)
        
    return harness


# ============================================================================
# OPERATOR 5: STRUCTURAL SPACEFRAME & LIGHTENING TOPOLOGY
# ============================================================================

def create_structural_truss_member(
    pt_a: Tuple[float, float, float],
    pt_b: Tuple[float, float, float],
    thickness: Tuple[float, float] = (0.05, 0.05),
    lightening_pocket_ratio: float = 0.35,
    has_gusset_plates: bool = True,
    color: Tuple[float, float, float, float] = CLAY_BASE
) -> sbg.Mesh:
    """
    Operator 5: Structural chassis beam with machined lightening pockets
    and reinforced triangular gusset plates.
    """
    truss = sbg.Mesh("TrussMember")
    dx = pt_b[0] - pt_a[0]
    dy = pt_b[1] - pt_a[1]
    dz = pt_b[2] - pt_a[2]
    dist = math.sqrt(dx*dx + dy*dy + dz*dz)
    if dist < 1e-4:
        return truss
        
    mid_x = (pt_a[0] + pt_b[0]) * 0.5
    mid_y = (pt_a[1] + pt_b[1]) * 0.5
    mid_z = (pt_a[2] + pt_b[2]) * 0.5
    
    yaw = math.degrees(math.atan2(dx, dz))
    pitch = -math.degrees(math.atan2(dy, math.sqrt(dx*dx + dz*dz)))
    
    # Main Extruded Member
    beam = _get_sb().create_beveled_box(
        (thickness[0], thickness[1], dist),
        bevel=min(thickness[0], thickness[1]) * 0.15,
        color=color
    )
    truss.append(beam)
    
    # Machined Lightening Pockets
    if lightening_pocket_ratio > 0.0 and dist > thickness[0] * 3.0:
        pocket_count = max(1, int(dist / (thickness[0] * 2.5)))
        p_len = (dist * 0.7) / pocket_count
        for p in range(pocket_count):
            pz = -dist * 0.35 + (p + 0.5) * p_len
            pocket_insert = _get_sb().create_beveled_box(
                (thickness[0] * 1.05, thickness[1] * lightening_pocket_ratio, p_len * 0.7),
                bevel=0.002,
                color=CLAY_DARK
            )
            pocket_insert.translate(0.0, 0.0, pz)
            truss.append(pocket_insert)
            
    # Triangular Gusset Plates at ends
    if has_gusset_plates:
        for gz in (-dist * 0.45, dist * 0.45):
            gusset = _get_sb().create_beveled_box(
                (thickness[0] * 1.8, thickness[1] * 0.25, thickness[0] * 1.4),
                bevel=0.003,
                color=CLAY_LIGHT
            )
            gusset.translate(0.0, 0.0, gz)
            truss.append(gusset)
            
    truss.rotate_x(pitch)
    truss.rotate_y(yaw)
    truss.translate(mid_x, mid_y, mid_z)
    return truss


# ============================================================================
# PILLAR 11: THE 4 PURE DIFFERENTIAL GEOMETRIC OPERATORS
# ============================================================================

def sweep_curve_profile(
    path: List[Tuple[float, float, float]],
    profile: str = "CIRCULAR",
    profile_dimensions: Tuple[float, float] = (0.04, 0.04),
    scale_taper: Tuple[float, float] = (1.0, 1.0),
    twist_deg: float = 0.0,
    radial_modulation: Optional[Dict[str, float]] = None,
    color: Tuple[float, float, float, float] = CLAY_BASE
) -> Any:
    """
    Operator 1: SE(3) Lie Group Curve Sweep (Pillar 11).
    Sweeps a 2D cross-section P(u, v) along 3D carrier curve C(t) using Rotation-Minimizing Frames (RMF).
    Applies continuous scale taper, axial twist, and optional radial sinusoidal modulation.
    Generates limbs, claw prongs, hoses, struts, coils, tentacles, and truss members.
    """
    if len(path) < 2:
        return sbg.Mesh("empty_sweep")
    
    n_pts = len(path)
    points = [sbm.Vec3(p[0], p[1], p[2]) for p in path]
    
    # 1. Compute Tangents
    tangents = []
    for i in range(n_pts):
        if i == 0:
            d = points[1] - points[0]
        elif i == n_pts - 1:
            d = points[-1] - points[-2]
        else:
            d = points[i + 1] - points[i - 1]
        l = d.length()
        tangents.append(d * (1.0 / l) if l > 1e-6 else sbm.Vec3(0.0, 0.0, 1.0))
        
    # 2. Compute Rotation-Minimizing Frames (Bishop Frame)
    normals = [None] * n_pts
    binormals = [None] * n_pts
    
    t0 = tangents[0]
    up = sbm.Vec3(0.0, 1.0, 0.0) if abs(t0.y) < 0.9 else sbm.Vec3(1.0, 0.0, 0.0)
    n0 = t0.cross(up).normalized()
    normals[0] = n0
    binormals[0] = t0.cross(n0).normalized()
    
    for i in range(1, n_pts):
        t_prev = tangents[i - 1]
        t_curr = tangents[i]
        axis = t_prev.cross(t_curr)
        axis_len = axis.length()
        if axis_len > 1e-6:
            axis_n = axis * (1.0 / axis_len)
            cos_phi = max(-1.0, min(1.0, t_prev.dot(t_curr)))
            phi = math.acos(cos_phi)
            n_prev = normals[i - 1]
            cos_p = math.cos(phi)
            sin_p = math.sin(phi)
            k_cross_v = axis_n.cross(n_prev)
            k_dot_v = axis_n.dot(n_prev)
            n_curr = (n_prev * cos_p) + (k_cross_v * sin_p) + (axis_n * (k_dot_v * (1.0 - cos_p)))
            normals[i] = n_curr.normalized()
        else:
            normals[i] = normals[i - 1]
        binormals[i] = t_curr.cross(normals[i]).normalized()
        
    # 3. Generate 2D Profile Vertices along curve
    n_profile_pts = 24
    slices = []
    
    for i in range(n_pts):
        t_ratio = i / (n_pts - 1) if n_pts > 1 else 0.0
        scale = scale_taper[0] + t_ratio * (scale_taper[1] - scale_taper[0])
        twist_rad = math.radians(twist_deg * t_ratio)
        cos_tw = math.cos(twist_rad)
        sin_tw = math.sin(twist_rad)
        
        rad_mod = 1.0
        if radial_modulation:
            amp = radial_modulation.get("amplitude", 0.0)
            freq = radial_modulation.get("frequency", 1.0)
            rad_mod = 1.0 + amp * math.sin(freq * 2.0 * math.pi * t_ratio)
            
        w = profile_dimensions[0] * 0.5 * scale * rad_mod
        h = profile_dimensions[1] * 0.5 * scale * rad_mod
        
        slice_pts = []
        p_center = points[i]
        n_vec = normals[i]
        b_vec = binormals[i]
        
        for k in range(n_profile_pts):
            th = k * 2.0 * math.pi / n_profile_pts
            if profile == "BEVELED_RECT" or profile == "I_BEAM":
                pu, pv = superellipse_point(0.0, 0.0, w, h, th, m=3.6)
            else: # CIRCULAR / default
                pu = w * math.cos(th)
                pv = h * math.sin(th)
                
            pu_rot = pu * cos_tw - pv * sin_tw
            pv_rot = pu * sin_tw + pv * cos_tw
            pt_3d = p_center + (n_vec * pu_rot) + (b_vec * pv_rot)
            slice_pts.append(pt_3d)
            
        slices.append(slice_pts)
        
    return _get_sb().create_loft(slices, close_ends=True, color=color)


def revolve_harmonic_solid(
    anchor_point: Tuple[float, float, float] = (0.0, 0.0, 0.0),
    axis: Tuple[float, float, float] = (0.0, 1.0, 0.0),
    profile_curve: Optional[List[Tuple[float, float]]] = None,
    harmonic_lobe_count: int = 0,
    harmonic_depth_ratio: float = 0.2,
    helix_pitch_meters: float = 0.0,
    color: Tuple[float, float, float, float] = CLAY_BASE
) -> Any:
    """
    Operator 2: Harmonic Solid of Revolution (Pillar 11).
    Revolves a 2D meridian curve r(z) around a 3D axis with continuous radial harmonic lobes
    and helical twist.
    Generates smooth flanges, nozzles, lenses, fluted drills, spiral augers, cooling fins, and cogwheels.
    """
    if not profile_curve or len(profile_curve) < 2:
        profile_curve = [(0.0, 0.1), (0.2, 0.1), (0.35, 0.06), (0.4, 0.0)]
        
    axis_v = sbm.Vec3(axis[0], axis[1], axis[2])
    axis_len = axis_v.length()
    if axis_len < 1e-6:
        axis_v = sbm.Vec3(0.0, 1.0, 0.0)
    else:
        axis_v = axis_v * (1.0 / axis_len)
        
    anchor_v = sbm.Vec3(anchor_point[0], anchor_point[1], anchor_point[2])
    
    up = sbm.Vec3(0.0, 1.0, 0.0) if abs(axis_v.y) < 0.9 else sbm.Vec3(1.0, 0.0, 0.0)
    vec_u = axis_v.cross(up).normalized()
    vec_v = axis_v.cross(vec_u).normalized()
    
    n_theta = max(32, harmonic_lobe_count * 4) if harmonic_lobe_count > 0 else 32
    slices = []
    
    for (z, r_base) in profile_curve:
        slice_pts = []
        center_z = anchor_v + (axis_v * z)
        
        phase_shift = 0.0
        if helix_pitch_meters > 1e-4:
            phase_shift = (2.0 * math.pi * z) / helix_pitch_meters
            
        for k in range(n_theta):
            th = k * 2.0 * math.pi / n_theta
            if harmonic_lobe_count > 0:
                lobe_val = abs(math.sin(harmonic_lobe_count * 0.5 * th + phase_shift))
                r = r_base * (1.0 - harmonic_depth_ratio * (lobe_val ** 1.5))
            else:
                r = r_base
                
            local_u = r * math.cos(th)
            local_v = r * math.sin(th)
            pt = center_z + (vec_u * local_u) + (vec_v * local_v)
            slice_pts.append(pt)
            
        slices.append(slice_pts)
        
    return _get_sb().create_loft(slices, close_ends=True, color=color)


def replicate_metric_array(
    distribution_mode: str = "CURVE_1D",
    guide_points: Optional[List[Tuple[float, float, float]]] = None,
    pitch_meters: float = 0.1,
    seed_geometry: Optional[Dict[str, Any]] = None,
    color: Tuple[float, float, float, float] = CLAY_BASE
) -> Any:
    """
    Operator 3: Affine Metric Replicator (Pillar 11).
    Replicates micro-geometry seed instances along a 1D curve, polar ring, or 2D grid
    at continuous metric pitch p.
    Generates fastener circles, louver bays, debris grilles, gripper teeth, and treads.
    """
    mesh = sbg.Mesh("metric_replicator")
    if not guide_points or len(guide_points) < 1:
        return mesh
        
    seed = seed_geometry or {}
    shape = seed.get("shape", "CYLINDRICAL_FASTENER")
    dims = seed.get("dimensions", (0.01, 0.01, 0.005))
    tilt_deg = float(seed.get("tiltAngleDeg", 0.0))
    
    if distribution_mode == "POLAR_RING":
        center = guide_points[0]
        normal = guide_points[1] if len(guide_points) > 1 else (0.0, 0.0, 1.0)
        radius = float(dims[0]) if len(guide_points) <= 2 else math.dist(center, guide_points[2])
        if radius < 1e-4:
            radius = 0.1
        circumference = 2.0 * math.pi * radius
        count = max(3, int(round(circumference / max(0.01, pitch_meters))))
        
        n_v = sbm.Vec3(normal[0], normal[1], normal[2]).normalized()
        up = sbm.Vec3(0.0, 1.0, 0.0) if abs(n_v.y) < 0.9 else sbm.Vec3(1.0, 0.0, 0.0)
        u_v = n_v.cross(up).normalized()
        v_v = n_v.cross(u_v).normalized()
        c_v = sbm.Vec3(center[0], center[1], center[2])
        
        for i in range(count):
            th = i * 2.0 * math.pi / count
            pos = c_v + (u_v * (radius * math.cos(th))) + (v_v * (radius * math.sin(th)))
            fastener = _get_sb().create_cylinder(radius=dims[0], height=dims[2] if len(dims) > 2 else dims[1], segments=12, color=color)
            fastener.translate(pos.x, pos.y, pos.z)
            mesh.append(fastener)
            
    elif distribution_mode == "CURVE_1D":
        points = [sbm.Vec3(p[0], p[1], p[2]) for p in guide_points]
        for i in range(len(points) - 1):
            seg_vec = points[i + 1] - points[i]
            seg_len = seg_vec.length()
            if seg_len < 1e-4:
                continue
            seg_dir = seg_vec * (1.0 / seg_len)
            count = max(1, int(round(seg_len / max(0.01, pitch_meters))))
            step = seg_len / count
            for j in range(count):
                pos = points[i] + (seg_dir * (j * step))
                if shape == "ANGLED_LOUVER_VANE":
                    vane = _get_sb().create_beveled_box(dims, bevel=0.002, color=color)
                    vane.rotate_x(tilt_deg)
                    vane.translate(pos.x, pos.y, pos.z)
                    mesh.append(vane)
                elif shape == "TRIANGULAR_TOOTH":
                    tooth = _get_sb().create_cone(dims[0], dims[1], segments=8, color=color)
                    tooth.translate(pos.x, pos.y, pos.z)
                    mesh.append(tooth)
                else:
                    rivet = _get_sb().create_cylinder(radius=dims[0], height=dims[1], segments=10, color=color)
                    rivet.translate(pos.x, pos.y, pos.z)
                    mesh.append(rivet)
                    
    return mesh


# ============================================================================
# UNIVERSAL ADAPTIVE HERO OBJECT SYNTHESIZER
# ============================================================================

class AdaptiveHeroObjectSynthesizer:
    """
    Universal Synthesizer for 3D Hero Assets under ADA:
    - Ingests Adaptive3DObjectContract
    - Executes the 5 Universal Mechanical Operators
    - Assembles the 70-20-10 Form Hierarchy
    - Exports directly to glTF 2.0 (.glb) ephemerally in RAM or to disk.
    """

    def __init__(self):
        pass

    def synthesize(self, contract: Dict[str, Any]) -> sbg.Mesh:
        """Assembles a full 3D object from contract dictionary."""
        name = contract.get("name", "AdaptiveHeroObject")
        master_mesh = sbg.Mesh(name)
        
        # --------------------------------------------------------------------
        # 1. 70% PRIMARY EDIFICE (Lofted Compound-Curvature Hull)
        # --------------------------------------------------------------------
        primary_hull = contract.get("primaryHull", {})
        stations = primary_hull.get("stations", [])
        micro = contract.get("microDetail", {})
        
        if stations:
            seam_freq = micro.get("panelSeamFrequency", 2.0)
            bolt_pitch = micro.get("fastenerPitchMeters", 0.18)
            hull_mesh = create_panelized_loft(
                stations,
                panel_seam_frequency=seam_freq,
                fastener_pitch_meters=bolt_pitch,
                color=CLAY_BASE
            )
            master_mesh.append(hull_mesh)
            
        # Secondary Cowls / Sponsons
        for sec in contract.get("secondaryHulls", []):
            sec_stations = sec.get("stations", [])
            if sec_stations:
                sec_mesh = create_panelized_loft(
                    sec_stations,
                    panel_seam_frequency=1.0,
                    fastener_pitch_meters=0.25,
                    color=CLAY_BASE
                )
                master_mesh.append(sec_mesh)

        # --------------------------------------------------------------------
        # 2. 20% SECONDARY ARTICULATED ASSEMBLIES
        # --------------------------------------------------------------------
        # Kinematic Links & Hydraulic Actuators
        for link in contract.get("kinematics", []):
            pt_a = tuple(link.get("anchorPoint", (0.0, 0.0, 0.0)))
            pt_b = tuple(link.get("endPoint", (0.0, 1.0, 0.0)))
            thick = tuple(link.get("crossSectionThickness", (0.05, 0.05)))
            
            # Main structural link
            truss = create_structural_truss_member(
                pt_a, pt_b,
                thickness=thick,
                lightening_pocket_ratio=float(link.get("lighteningPocketRatio", 0.35)),
                has_gusset_plates=True,
                color=CLAY_BASE
            )
            master_mesh.append(truss)
            
            # Parallel hydraulic ram pair
            if link.get("hasHydraulicRamPair", True):
                offset_ram_a = (pt_a[0] + thick[0] * 0.8, pt_a[1] + thick[1] * 0.8, pt_a[2])
                offset_ram_b = (pt_b[0] + thick[0] * 0.8, pt_b[1] + thick[1] * 0.8, pt_b[2])
                ram = create_hydraulic_actuator(
                    offset_ram_a, offset_ram_b,
                    barrel_radius=thick[0] * 0.35,
                    rod_radius=thick[0] * 0.20
                )
                master_mesh.append(ram)

        # Grounding Interface (Skids / Runners)
        for ground in contract.get("grounding", []):
            width = float(ground.get("stanceWidthMeters", 1.4))
            clearance = float(ground.get("groundClearanceMeters", 0.15))
            wheelbase = float(ground.get("wheelbaseMeters", 2.2))
            skid_r = float(ground.get("tubularRadiusMeters", 0.035))
            
            for sign in (-1.0, 1.0):
                skid_pts = [
                    (sign * width * 0.5, clearance * 2.2, -wheelbase * 0.6),
                    (sign * width * 0.5, clearance,       -wheelbase * 0.5),
                    (sign * width * 0.5, clearance,        0.0),
                    (sign * width * 0.5, clearance,        wheelbase * 0.4),
                    (sign * width * 0.5, clearance * 2.5,  wheelbase * 0.6),
                ]
                skid = create_spline_conduit_harness(skid_pts, radius=skid_r, color=CLAY_BASE, p_clamp_spacing=0.0)
                master_mesh.append(skid)
                
                # Vertical Stanchions
                stanchion = create_structural_truss_member(
                    (sign * width * 0.5, clearance, 0.0),
                    (sign * width * 0.35, clearance * 4.0, 0.0),
                    thickness=(skid_r * 1.4, skid_r * 1.4),
                    lightening_pocket_ratio=0.0,
                    has_gusset_plates=True,
                    color=CLAY_BASE
                )
                master_mesh.append(stanchion)

        # --------------------------------------------------------------------
        # 3. 10% TERTIARY MICRO-DETAIL
        # --------------------------------------------------------------------
        # Louver Bays
        for louver in micro.get("louverBays", []):
            c = tuple(louver.get("center", (0.0, 0.0, 0.0)))
            dims = tuple(louver.get("dimensions", (0.35, 0.25, 0.08)))
            count = int(louver.get("bladeCount", 6))
            ang = float(louver.get("angleDeg", 35.0))
            lb = create_louver_bay(c, dimensions=dims, blade_count=count, blade_angle_deg=ang)
            master_mesh.append(lb)
            
        # Intake Debris Screens
        for scr in micro.get("intakeScreens", []):
            c = tuple(scr.get("center", (0.0, 0.0, 0.0)))
            norm = tuple(scr.get("normal", (0.0, 0.0, 1.0)))
            r = float(scr.get("outerRadiusMeters", 0.22))
            rings = int(scr.get("ringCount", 3))
            spokes = int(scr.get("spokeCount", 4))
            intake = create_intake_strainer(c, normal=norm, radius=r, ring_count=rings, spoke_count=spokes)
            master_mesh.append(intake)
            
        # Umbilical / Conduit Splines
        for cond in micro.get("conduitGuideSplines", []):
            pts = [tuple(p) for p in cond.get("path", [])]
            cr = float(cond.get("radiusMeters", 0.014))
            p_space = float(cond.get("pClampSpacingMeters", 0.35))
            if len(pts) >= 2:
                c_mesh = create_spline_conduit_harness(pts, radius=cr, color=CLAY_DARK, p_clamp_spacing=p_space)
                master_mesh.append(c_mesh)

        # --------------------------------------------------------------------
        # 4. PILLAR 11: PURE DIFFERENTIAL GEOMETRIC OPERATORS
        # --------------------------------------------------------------------
        # Operator 1: SE(3) Curve Sweeps
        for sweep in contract.get("curveSweeps", []):
            pts = [tuple(p) for p in sweep.get("path", [])]
            if len(pts) >= 2:
                prof = str(sweep.get("profile", "CIRCULAR"))
                dims = tuple(sweep.get("profileDimensions", (0.04, 0.04)))
                taper = tuple(sweep.get("scaleTaper", (1.0, 1.0)))
                twist = float(sweep.get("twistDeg", 0.0))
                rad_mod = sweep.get("radialModulation", None)
                col = tuple(sweep.get("colorRgba", CLAY_BASE))
                sw_mesh = sweep_curve_profile(
                    pts,
                    profile=prof,
                    profile_dimensions=dims,
                    scale_taper=taper,
                    twist_deg=twist,
                    radial_modulation=rad_mod,
                    color=col
                )
                master_mesh.append(sw_mesh)

        # Operator 2: Harmonic Solids of Revolution
        for rev in contract.get("revolvedHarmonics", []):
            anchor = tuple(rev.get("anchorPoint", (0.0, 0.0, 0.0)))
            axis = tuple(rev.get("axis", (0.0, 1.0, 0.0)))
            prof = [tuple(p) for p in rev.get("profileCurve", [])]
            lobes = int(rev.get("harmonicLobeCount", 0))
            depth = float(rev.get("harmonicDepthRatio", 0.2))
            helix = float(rev.get("helixPitchMeters", 0.0))
            col = tuple(rev.get("colorRgba", CLAY_BASE))
            rev_mesh = revolve_harmonic_solid(
                anchor_point=anchor,
                axis=axis,
                profile_curve=prof,
                harmonic_lobe_count=lobes,
                harmonic_depth_ratio=depth,
                helix_pitch_meters=helix,
                color=col
            )
            master_mesh.append(rev_mesh)

        # Operator 3: Affine Metric Replicators
        for rep in contract.get("metricReplications", []):
            mode = str(rep.get("distributionMode", "CURVE_1D"))
            pts = [tuple(p) for p in rep.get("guidePoints", [])]
            pitch = float(rep.get("pitchMeters", 0.1))
            seed = rep.get("seedGeometry", {})
            col = tuple(rep.get("colorRgba", CLAY_BASE))
            rep_mesh = replicate_metric_array(
                distribution_mode=mode,
                guide_points=pts,
                pitch_meters=pitch,
                seed_geometry=seed,
                color=col
            )
            master_mesh.append(rep_mesh)

        # Master Smooth Normals & Curvature Contact AO
        master_mesh.recompute_smooth_normals()
        master_mesh.compute_curvature_ao(0.55)
        
        return master_mesh

    def export_glb(self, contract: Dict[str, Any], output_glb_path: str) -> Dict[str, Any]:
        """Synthesizes and exports GLB to disk, returning mesh metrics."""
        mesh = self.synthesize(contract)
        os.makedirs(os.path.dirname(os.path.abspath(output_glb_path)), exist_ok=True)
        sbio.write_glb(output_glb_path, mesh)
        file_size_kb = os.path.getsize(output_glb_path) / 1024.0
        return {
            "success": True,
            "path": output_glb_path,
            "vertexCount": mesh.vertex_count,
            "triangleCount": mesh.triangle_count,
            "fileSizeKb": file_size_kb
        }


# ============================================================================
# OPERATOR 6: UNIVERSAL KINEMATIC REVOLVING COMPONENTS & ROLLING STANCE
# ============================================================================

def create_revolving_component(
    radius: float = 0.5,
    length: float = 1.0,
    axis: Union[str, Tuple[float, float, float]] = "lateral",
    profile: str = "cylinder",
    crown: float = 0.0,
    recess: float = 0.0,
    segments: int = 32,
    color: Optional[Tuple[float, float, float, float]] = None,
    material: Any = None,
    **kwargs
) -> sbg.Mesh:
    """
    Universal Kinematic Revolving Component Operator (ADA Invariant 6).
    Synthesizes revolving solids (wheels, drums, rollers, pulleys, turbine rotors,
    actuator cylinders, gun barrels) aligned to their functional kinematic axis.

    axis:
      - 'x' / 'lateral' / 'transverse': Rotated into lateral axle orientation (wheels/rollers).
      - 'y' / 'vertical' / 'load': Vertical axis (columns, turntables).
      - 'z' / 'longitudinal' / 'thrust': Thrust/propulsion axis (turbines, jet engines, torpedoes).
      - tuple/list (dx, dy, dz): Arbitrary 3D orientation vector.
    """
    sb = _get_sb()
    r = float(radius)
    h = float(length)
    segs = int(segments)
    col = color if color is not None else CLAY_BASE

    if profile == "beveled":
        bevel_rad = float(kwargs.get("bevel", min(r * 0.15, h * 0.15)))
        prof = [
            sbm.Vec2(0.0, -h * 0.5),
            sbm.Vec2(max(1e-4, r - bevel_rad), -h * 0.5),
            sbm.Vec2(r, -h * 0.5 + bevel_rad),
            sbm.Vec2(r, h * 0.5 - bevel_rad),
            sbm.Vec2(max(1e-4, r - bevel_rad), h * 0.5),
            sbm.Vec2(0.0, h * 0.5)
        ]
        mesh = sb.create_lathe(prof, segments=segs, color=col)
    elif profile == "fluted":
        lobes = int(kwargs.get("lobes", 8))
        mesh = revolve_harmonic_solid(
            anchor_point=(0.0, -h * 0.5, 0.0),
            axis=(0.0, 1.0, 0.0),
            profile_curve=[(0.0, 0.0), (r, 0.0), (r, h), (0.0, h)],
            harmonic_lobe_count=lobes,
            harmonic_depth_ratio=float(kwargs.get("lobe_depth", 0.08)),
            color=col
        )
    else:
        mesh = sb.create_cylinder(radius=r, height=h, segments=segs, color=col)

    if material is not None and hasattr(mesh, "apply_material"):
        mesh.apply_material(material)

    # Orient into functional kinematic axis (Native mesh rotation takes DEGREES!)
    ax_str = str(axis).lower().strip()
    if ax_str in ("x", "lateral", "transverse", "pitch"):
        mesh.rotate_z(90.0)
    elif ax_str in ("z", "longitudinal", "thrust", "roll"):
        mesh.rotate_x(90.0)
    elif isinstance(axis, (tuple, list)) and len(axis) >= 3:
        dx, dy, dz = float(axis[0]), float(axis[1]), float(axis[2])
        mag = math.sqrt(dx * dx + dy * dy + dz * dz)
        if mag > 1e-4:
            dx, dy, dz = dx / mag, dy / mag, dz / mag
            pitch_deg = math.degrees(math.atan2(math.sqrt(dx * dx + dz * dz), dy))
            yaw_deg = math.degrees(math.atan2(dx, dz))
            mesh.rotate_x(pitch_deg)
            mesh.rotate_y(yaw_deg)

    if hasattr(mesh, "tag"):
        mesh.tag("revolving_component")
    return mesh


def create_wheel(
    radius: float = 0.35,
    width: float = 0.30,
    rim_radius: Optional[float] = None,
    rim_recess: float = 0.04,
    tread_bevel: float = 0.025,
    axis: str = "lateral",
    ground: bool = True,
    color: Optional[Tuple[float, float, float, float]] = None,
    material: Any = None,
    **kwargs
) -> sbg.Mesh:
    """
    Universal Rolling Wheel / Tire Operator.
    Synthesizes an authentic multi-element wheel:
      - Outer rubber tire with beveled shoulder crowns and contact patch
      - Inset recessed wheel rim with center hub cap
      - Brake rotor disc
    Pre-oriented with lateral rolling axis along X (R_z(90)) and seated on the ground (y_min = 0).
    """
    sb = _get_sb()
    r = float(radius)
    w = float(width)
    rim_r = float(rim_radius) if rim_radius is not None else (r * 0.65)
    recess = float(rim_recess)
    bev = float(tread_bevel)

    wheel_assembly = sbg.Mesh("WheelAssembly")

    # 1. Outer Rubber Tire (beveled crown)
    tire_prof = [
        sbm.Vec2(rim_r, -w * 0.5),
        sbm.Vec2(r - bev, -w * 0.5),
        sbm.Vec2(r, -w * 0.5 + bev),
        sbm.Vec2(r, w * 0.5 - bev),
        sbm.Vec2(r - bev, w * 0.5),
        sbm.Vec2(rim_r, w * 0.5)
    ]
    tire = sb.create_lathe(tire_prof, segments=int(kwargs.get("segments", 32)))
    if hasattr(sb.PbrMaterial, "rubber"):
        tire.apply_material(sb.PbrMaterial.rubber())
    else:
        tire.apply_material(sb.PbrMaterial(roughness=0.92, metalness=0.0, base_color=(0.12, 0.12, 0.14, 1.0)))
    wheel_assembly.append(tire)

    # 2. Recessed Alloy Wheel Rim (bilateral inset)
    rim_w = max(0.01, w - recess * 2.0)
    rim = sb.create_cylinder(radius=rim_r, height=rim_w, segments=int(kwargs.get("segments", 32)))
    if hasattr(sb.PbrMaterial, "metal"):
        rim.apply_material(sb.PbrMaterial.metal())
    else:
        rim.apply_material(sb.PbrMaterial(roughness=0.25, metalness=0.9, base_color=(0.7, 0.72, 0.75, 1.0)))
    wheel_assembly.append(rim)

    # 3. Brake Rotor Disc (thin metallic plate)
    disc_r = rim_r * 0.75
    disc = sb.create_cylinder(radius=disc_r, height=w * 0.12, segments=24)
    if hasattr(sb.PbrMaterial, "steel"):
        disc.apply_material(sb.PbrMaterial.steel())
    else:
        disc.apply_material(sb.PbrMaterial(roughness=0.35, metalness=0.85, base_color=(0.5, 0.5, 0.5, 1.0)))
    wheel_assembly.append(disc)

    # 4. Center Hub Nut
    hub = sb.create_cylinder(radius=rim_r * 0.22, height=w * 1.05, segments=16)
    hub.apply_material(sb.PbrMaterial(roughness=0.2, metalness=0.9, base_color=(0.85, 0.25, 0.2, 1.0)))
    wheel_assembly.append(hub)

    # Orient into functional kinematic axis (Default: lateral X axis so wheel rolls upright along Z)
    ax_str = str(axis).lower().strip()
    if ax_str in ("lateral", "x", "transverse"):
        wheel_assembly.rotate_z(90.0)
    elif ax_str in ("longitudinal", "z", "thrust"):
        wheel_assembly.rotate_x(90.0)

    # Grounding invariant: seat bottom tangent at y = 0
    if ground:
        wheel_assembly.translate(0.0, r, 0.0)

    if hasattr(wheel_assembly, "tag"):
        wheel_assembly.tag("wheel")
    return wheel_assembly


def create_wheel_assembly(
    track_width: float = 1.6,
    wheelbase: float = 3.2,
    wheel_radius: float = 0.35,
    tire_width: float = 0.30,
    ground_clearance: float = 0.05,
    axle_pairs: int = 2,
    camber_deg: float = 0.0,
    toe_deg: float = 0.0,
    suspension: str = "double_wishbone",
    color: Optional[Tuple[float, float, float, float]] = None,
    material: Any = None,
    **kwargs
) -> sbg.Mesh:
    """
    Universal Ground Vehicle Wheel & Suspension Assembly.
    Spawns N axle pairs of upright, grounded rolling wheels spaced at track_width and wheelbase,
    with double-wishbone suspension linkages connecting to inner chassis pick-up points.
    """
    sb = _get_sb()
    tw = float(track_width)
    wb = float(wheelbase)
    wr = float(wheel_radius)
    tire_w = float(tire_width)
    n_axles = max(1, int(axle_pairs))

    group = sbg.Mesh("SuspensionWheelAssembly")

    if n_axles == 1:
        z_positions = [0.0]
    else:
        z_step = wb / float(n_axles - 1)
        z_positions = [wb * 0.5 - i * z_step for i in range(n_axles)]

    for z_axle in z_positions:
        for side in [-1.0, 1.0]:
            # 1. Upright Rolling Wheel
            wheel = create_wheel(radius=wr, width=tire_w, ground=True, axis="lateral", **kwargs)
            if camber_deg != 0.0:
                wheel.rotate_z(camber_deg * side)
            if toe_deg != 0.0:
                wheel.rotate_y(toe_deg * side)

            wheel.translate(side * (tw * 0.5), 0.0, z_axle)
            group.append(wheel)

            # 2. Suspension Wishbones (Double-wishbone A-arms)
            if suspension == "double_wishbone":
                hub_x = side * (tw * 0.5 - tire_w * 0.5)
                chassis_x = side * (tw * 0.28)

                # Upper wishbone A-arm
                w_up_start = (chassis_x, wr * 0.95, z_axle - 0.18)
                w_up_apex = (hub_x, wr * 0.90, z_axle)
                w_up_end = (chassis_x, wr * 0.95, z_axle + 0.18)

                arm_a = sb.create_catenary_cable(start=w_up_start, end=w_up_apex, sag=0.0, radius=0.016, segments=4)
                arm_b = sb.create_catenary_cable(start=w_up_apex, end=w_up_end, sag=0.0, radius=0.016, segments=4)
                group.append(arm_a)
                group.append(arm_b)

                # Lower wishbone A-arm
                w_low_start = (chassis_x, wr * 0.35, z_axle - 0.22)
                w_low_apex = (hub_x, wr * 0.30, z_axle)
                w_low_end = (chassis_x, wr * 0.35, z_axle + 0.22)

                arm_c = sb.create_catenary_cable(start=w_low_start, end=w_low_apex, sag=0.0, radius=0.018, segments=4)
                arm_d = sb.create_catenary_cable(start=w_low_apex, end=w_low_end, sag=0.0, radius=0.018, segments=4)
                group.append(arm_c)
                group.append(arm_d)

    if hasattr(group, "tag"):
        group.tag("wheel_assembly")
    return group


# ============================================================================
# OPERATOR 7: CONTINUOUS COMPOUND-CURVATURE LOFTS & AERODYNAMIC FOILS
# ============================================================================

def create_lofted_hull(
    stations: List[Union[Dict[str, Any], Tuple, List]],
    profile: str = "superellipse",
    m: float = 2.8,
    close_ends: bool = True,
    n_pts: int = 32,
    color: Optional[Tuple[float, float, float, float]] = None,
    material: Any = None,
    **kwargs
) -> sbg.Mesh:
    """
    Continuous Compound-Curvature Hull Generator (ADA Invariant 1 & 6).
    Synthesizes continuous streamlined bodies (monocoques, fuselages, hulls, organ bodies)
    by lofting 2D stations along a carrier axis.

    stations: list of dicts or tuples:
      - dict: {"z": float, "width": float, "height": float, "y": float, "m": float, "roll": float}
      - tuple: (z, width, height) or (z, y, width, height)
    """
    sb = _get_sb()
    col = color if color is not None else CLAY_BASE
    n_slices = int(n_pts)
    slices = []

    for st in stations:
        if isinstance(st, dict):
            z = float(st.get("z", st.get("position", 0.0)))
            w = float(st.get("width", st.get("w", 1.0)))
            h = float(st.get("height", st.get("h", 1.0)))
            y_c = float(st.get("y", st.get("center_y", 0.0)))
            x_c = float(st.get("x", st.get("center_x", 0.0)))
            m_exp = float(st.get("m", st.get("superellipseExponent", m)))
            roll = float(st.get("roll", st.get("rollDeg", 0.0)))
        elif isinstance(st, (tuple, list)):
            if len(st) == 3:
                z, w, h = float(st[0]), float(st[1]), float(st[2])
                x_c, y_c, m_exp, roll = 0.0, 0.0, float(m), 0.0
            elif len(st) >= 4:
                z, y_c, w, h = float(st[0]), float(st[1]), float(st[2]), float(st[3])
                x_c = 0.0
                m_exp = float(st[4]) if len(st) > 4 else float(m)
                roll = float(st[5]) if len(st) > 5 else 0.0
            else:
                continue
        else:
            continue

        rx, ry = max(1e-4, w * 0.5), max(1e-4, h * 0.5)
        loop = superellipse_loop(z, x_c, y_c, rx, ry, m=m_exp, n_pts=n_slices, roll_deg=roll)
        slices.append(loop)

    if len(slices) < 2:
        raise ValueError("create_lofted_hull requires at least 2 stations")

    mesh = sb.create_loft(slices, close_ends=bool(close_ends), color=col)
    if material is not None and hasattr(mesh, "apply_material"):
        mesh.apply_material(material)
    if hasattr(mesh, "recompute_smooth_normals"):
        mesh.recompute_smooth_normals()
    if hasattr(mesh, "compute_curvature_ao"):
        mesh.compute_curvature_ao(0.65)
    if hasattr(mesh, "tag"):
        mesh.tag("primary_hull")
    return mesh


def create_cambered_foil(
    span: float = 1.8,
    chord: float = 0.45,
    camber: float = 0.04,
    thickness: float = 0.05,
    angle_of_attack_deg: float = -4.0,
    axis: str = "x",
    endplates: bool = True,
    endplate_height: float = 0.25,
    endplate_thickness: float = 0.015,
    color: Optional[Tuple[float, float, float, float]] = None,
    material: Any = None,
    **kwargs
) -> sbg.Mesh:
    """
    Cambered Aerodynamic Foil / Wing Generator.
    Synthesizes downforce wings, airplane wings, hydrofoil rudders, or turbine blades
    with smooth NACA camber profiles and optional vertical endplates.
    """
    sb = _get_sb()
    s = float(span)
    ch = float(chord)
    camb = float(camber)
    th = float(thickness)
    aoa_deg = float(angle_of_attack_deg)
    aoa_rad = math.radians(aoa_deg)
    cos_a = math.cos(aoa_rad)
    sin_a = math.sin(aoa_rad)
    col = color if color is not None else CLAY_BASE

    foil_assembly = sbg.Mesh("AerodynamicFoil")
    n_pts = int(kwargs.get("chord_pts", 24))
    n_span = int(kwargs.get("span_slices", 8))

    # Generate 2D NACA 4-digit style cambered airfoil coordinate slice
    profile_pts = []
    for i in range(n_pts):
        t = float(i) / float(n_pts - 1)
        x_c = (1.0 - math.cos(t * math.pi)) * 0.5
        y_camber = 4.0 * camb * x_c * (1.0 - x_c)
        y_t = 5.0 * th * (0.2969 * math.sqrt(max(0.0, x_c)) - 0.1260 * x_c - 0.3516 * (x_c**2) + 0.2843 * (x_c**3) - 0.1015 * (x_c**4))
        z_local = (x_c - 0.25) * ch
        y_local = (y_camber + y_t) * ch
        z_rot = z_local * cos_a - y_local * sin_a
        y_rot = z_local * sin_a + y_local * cos_a
        profile_pts.append((y_rot, z_rot))

    for i in range(n_pts - 1, -1, -1):
        t = float(i) / float(n_pts - 1)
        x_c = (1.0 - math.cos(t * math.pi)) * 0.5
        y_camber = 4.0 * camb * x_c * (1.0 - x_c)
        y_t = 5.0 * th * (0.2969 * math.sqrt(max(0.0, x_c)) - 0.1260 * x_c - 0.3516 * (x_c**2) + 0.2843 * (x_c**3) - 0.1015 * (x_c**4))
        z_local = (x_c - 0.25) * ch
        y_local = (y_camber - y_t) * ch
        z_rot = z_local * cos_a - y_local * sin_a
        y_rot = z_local * sin_a + y_local * cos_a
        profile_pts.append((y_rot, z_rot))

    slices = []
    for s_idx in range(n_span):
        t_span = float(s_idx) / float(n_span - 1)
        x_span = -s * 0.5 + t_span * s
        slice_loop = [sbm.Vec3(x_span, py, pz) for (py, pz) in profile_pts]
        slices.append(slice_loop)

    wing_mesh = sb.create_loft(slices, close_ends=True, color=col)
    if material is not None and hasattr(wing_mesh, "apply_material"):
        wing_mesh.apply_material(material)
    foil_assembly.append(wing_mesh)

    # Optional Vertical Endplates
    if endplates:
        e_h = float(endplate_height)
        e_th = float(endplate_thickness)
        for side in [-1.0, 1.0]:
            ep = sb.create_beveled_box((e_th, e_h, ch * 1.15), bevel=0.003, color=col)
            ep.translate(side * (s * 0.5 + e_th * 0.5), 0.0, 0.0)
            if material is not None and hasattr(ep, "apply_material"):
                ep.apply_material(material)
            foil_assembly.append(ep)

    if hasattr(foil_assembly, "tag"):
        foil_assembly.tag("aerodynamic_foil")
    return foil_assembly


# ============================================================================
# CLOSED-LOOP INVARIANT AUDIT & AUTO-HEALING
# ============================================================================

def validate_scene(scene_or_mesh: Any, auto_heal: bool = True) -> Dict[str, Any]:
    """
    In-Engine Kinematic & Geometric Invariant Validator.
    Audits:
      1. Wheel Orientation Invariant: Checks principal inertia axis of any ground-adjacent
         wheel/roller. If vertical (lying flat like a pancake), auto-rotates R_z(90) and grounds.
      2. Compound Curvature Invariant: Checks normal variance on primary hulls to flag
         primitive box stacking.
    """
    violations = []
    auto_healed = []

    # Collect submeshes
    submeshes = []
    if hasattr(scene_or_mesh, "_sub_parts") and scene_or_mesh._sub_parts:
        submeshes = list(scene_or_mesh._sub_parts)
    elif hasattr(scene_or_mesh, "vertices"):
        submeshes = [scene_or_mesh]

    total_scene_height = 1.0
    if hasattr(scene_or_mesh, "bounds"):
        total_scene_height = max(0.1, scene_or_mesh.bounds.size.y)

    # 1. Audit Wheels & Revolving Elements for Pancake Orientation
    for sub in submeshes:
        tag = getattr(sub, "_mesh_tag_name", getattr(sub, "name", "")).lower()
        verts = getattr(sub, "vertices", [])
        n_v = len(verts)
        if n_v < 12:
            continue

        # Compute centroid & coordinate variances
        cx = sum(v.position.x for v in verts) / n_v
        cy = sum(v.position.y for v in verts) / n_v
        cz = sum(v.position.z for v in verts) / n_v

        vx = sum((v.position.x - cx)**2 for v in verts) / n_v
        vy = sum((v.position.y - cy)**2 for v in verts) / n_v
        vz = sum((v.position.z - cz)**2 for v in verts) / n_v

        min_y = min(v.position.y for v in verts)

        # Only audit submeshes that are explicitly designated as wheels or rollers
        excluded_non_wheel = (
            "hull", "wing", "foil", "box", "chassis", "floor", "diffuser",
            "splitter", "canard", "cockpit", "monocoque", "strut", "stanchion",
            "intake", "endplate", "flap", "plank", "assembly", "mirror",
            "light", "exhaust", "body", "cowl", "panel", "hood", "spoiler"
        )
        if any(ex in tag for ex in excluded_non_wheel):
            continue

        is_explicit_wheel = any(k in tag for k in ("wheel", "tire", "roller", "rim"))
        if not is_explicit_wheel:
            continue

        # Check if already in an upright lateral or longitudinal rolling stance:
        # Lateral rolling wheel (axis X): vx is axial thickness, vy and vz form the circular profile.
        is_already_lateral = (vx < 0.70 * min(vy, vz)) and (abs(vy - vz) / max(1e-6, max(vy, vz)) < 0.35)
        # Longitudinal rolling wheel (axis Z): vz is axial thickness, vx and vy form the circular profile.
        is_already_longitudinal = (vz < 0.70 * min(vx, vy)) and (abs(vx - vy) / max(1e-6, max(vx, vy)) < 0.35)

        if is_already_lateral or is_already_longitudinal:
            continue

        # Detect if wheel is lying flat horizontally like a pancake (axial thickness along Y, radial in X-Z)
        is_circular_in_xz = (abs(vx - vz) / max(1e-6, max(vx, vz)) < 0.25) and (max(vx, vz) > 0.005)
        is_flat_pancake_wheel = (vy < 0.50 * min(vx, vz)) and is_circular_in_xz

        # Near ground level?
        is_ground_adjacent = min_y < (total_scene_height * 0.45)

        if is_flat_pancake_wheel and is_ground_adjacent:
            msg = f"Wheel/roller '{tag}' has vertical symmetry axis (lying flat horizontally on ground)."
            violations.append(msg)
            if auto_heal and hasattr(sub, "rotate_z") and hasattr(sub, "translate"):
                # Rotate strictly around the wheel's local centroid, NEVER world origin (0, 0, 0)
                sub.translate(-cx, -cy, -cz)
                sub.rotate_z(90.0)
                sub.translate(cx, cy, cz)
                # Re-compute min Y and seat bottom on ground if sunken
                new_min_y = min(v.position.y for v in sub.vertices)
                if new_min_y < 0.0:
                    sub.translate(0.0, -new_min_y, 0.0)
                auto_healed.append(f"Auto-rotated '{tag}' 90 degrees around local centroid to upright rolling stance.")

    # 2. Audit Primary Hull for Planar Box-Stacking Anti-Pattern
    largest_sub = None
    max_vol = -1.0
    for sub in submeshes:
        if hasattr(sub, "bounds"):
            sz = sub.bounds.size
            vol = sz.x * sz.y * sz.z
            if vol > max_vol:
                max_vol = vol
                largest_sub = sub

    if largest_sub is not None:
        verts = getattr(largest_sub, "vertices", [])
        if verts and len(verts) < 1200:
            cardinal_count = 0
            for v in verts:
                nx, ny, nz = abs(v.normal.x), abs(v.normal.y), abs(v.normal.z)
                if nx > 0.98 or ny > 0.98 or nz > 0.98:
                    cardinal_count += 1
            cardinal_ratio = cardinal_count / len(verts)
            sub_tag = getattr(largest_sub, "_mesh_tag_name", getattr(largest_sub, "name", "Hull"))
            if cardinal_ratio > 0.65 and len(verts) < 60:
                violations.append(
                    f"Primary hull '{sub_tag}' consists of stacked planar box primitives (cardinal normal ratio: {cardinal_ratio:.2f}). "
                    "Use create_lofted_hull() or apply non-linear deformers (taper, bulge, bend) for compound curvature."
                )

    passed = len(violations) == 0 or (len(auto_healed) == len(violations))
    return {
        "passed": passed,
        "violations": violations,
        "autoHealed": auto_healed
    }

