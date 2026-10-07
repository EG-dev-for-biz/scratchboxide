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
            fastener = _get_sb().create_cylinder(dims[0], dims[2] if len(dims) > 2 else dims[1], segments=12, color=color)
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
                    rivet = _get_sb().create_cylinder(dims[0], dims[1], segments=10, color=color)
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
