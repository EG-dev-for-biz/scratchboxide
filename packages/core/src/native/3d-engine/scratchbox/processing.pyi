"""
Scratchbox Native Geometric Processing Engine (Taubin, QEM Decimate, Remesh, Curvature, Poisson Sampling, Hole Filling, CSG Slice, Clean, Hausdorff)
"""

import scratchbox_native.geometry
import scratchbox_native.math


class CurvatureAnalysisResult:
    @property
    def mean_curvature(self) -> list[float]: ...

    @property
    def gaussian_curvature(self) -> list[float]: ...

    @property
    def principal_k1(self) -> list[float]: ...

    @property
    def principal_k2(self) -> list[float]: ...

    @property
    def shape_index(self) -> list[float]: ...

    @property
    def curvedness(self) -> list[float]: ...

    @property
    def cavity_occlusion(self) -> list[float]: ...

class SurfaceSamplePoint:
    @property
    def position(self) -> scratchbox_native.math.Vec3: ...

    @property
    def normal(self) -> scratchbox_native.math.Vec3: ...

    @property
    def uv(self) -> scratchbox_native.math.Vec2: ...

    @property
    def color(self) -> scratchbox_native.math.Vec4: ...

class HausdorffResult:
    @property
    def max_distance(self) -> float: ...

    @property
    def mean_distance(self) -> float: ...

    @property
    def rms_distance(self) -> float: ...

def taubin_smooth(mesh: scratchbox_native.geometry.Mesh, iterations: int = 10, lambda_val: float = 0.5, mu_val: float = -0.5299999713897705, preserve_boundaries: bool = True) -> None:
    """
    Apply volume-preserving, non-shrinking Taubin low-pass smoothing filter
    """

def decimate_qem(mesh: scratchbox_native.geometry.Mesh, target_triangles: int = 0, target_ratio: float = 0.5, max_error: float = 1000000000.0, preserve_boundary: bool = True) -> scratchbox_native.geometry.Mesh:
    """
    Garland-Heckbert Quadric Error Metrics (QEM) decimation preserving surface silhouettes and curvature
    """

def poisson_sample(mesh: scratchbox_native.geometry.Mesh, count: int = 100, min_distance: float = 0.0, seed: int = 42) -> list[SurfaceSamplePoint]:
    """Blue noise Poisson-disk surface point sampling on mesh triangles"""

def fill_holes(mesh: scratchbox_native.geometry.Mesh, max_hole_edges: int = 64) -> scratchbox_native.geometry.Mesh:
    """Identify open boundary half-edge loops and triangulate cleanly"""

def analyze_curvature(mesh: scratchbox_native.geometry.Mesh) -> CurvatureAnalysisResult:
    """
    Compute discrete Cotangent Laplace-Beltrami mean/Gaussian curvature and Koenderink Shape Index (-1 to +1)
    """

def bake_cavity_ao(mesh: scratchbox_native.geometry.Mesh, intensity: float = 0.6499999761581421) -> None:
    """Bake geometric cavity ambient occlusion into vertex colors"""

def clean_mesh(mesh: scratchbox_native.geometry.Mesh, weld_epsilon: float = 9.999999747378752e-06) -> scratchbox_native.geometry.Mesh:
    """
    Remove duplicate faces, unreferenced vertices, and zero-area sliver triangles
    """

def slice_mesh(mesh: scratchbox_native.geometry.Mesh, plane_point: scratchbox_native.math.Vec3 = ..., plane_normal: scratchbox_native.math.Vec3 = ..., keep_positive: bool = True, cap_cut: bool = True) -> scratchbox_native.geometry.Mesh:
    """Analytical Sutherland-Hodgman planar mesh slicing with hole capping"""

def isotropic_remesh(mesh: scratchbox_native.geometry.Mesh, target_edge_length: float = 0.25, iterations: int = 4, crease_angle_deg: float = 45.0) -> scratchbox_native.geometry.Mesh:
    """Botsch-Kobbelt isotropic remeshing with tangential edge relaxation"""

def hausdorff_distance(mesh_a: scratchbox_native.geometry.Mesh, mesh_b: scratchbox_native.geometry.Mesh, samples: int = 500) -> HausdorffResult:
    """
    Measure maximum and mean Hausdorff geometric distance between two meshes
    """
