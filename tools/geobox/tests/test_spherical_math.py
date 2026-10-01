# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.


"""
Unit tests for GeoBox spherical mathematics, coordinate projections,
and Haversine distance computations.
"""

import math
import unittest

EARTH_RADIUS_KM = 6371.0088

def geodetic_to_cartesian(lat_deg: float, lng_deg: float):
    lat_rad = math.radians(lat_deg)
    lng_rad = math.radians(lng_deg)
    x = math.cos(lat_rad) * math.cos(lng_rad)
    y = math.cos(lat_rad) * math.sin(lng_rad)
    z = math.sin(lat_rad)
    return x, y, z

def haversine_distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    lam1, lam2 = math.radians(lng1), math.radians(lng2)
    dphi = phi2 - phi1
    dlam = lam2 - lam1

    a = math.sin(dphi * 0.5) ** 2 + math.cos(phi1) * math.cos(phi2) * (math.sin(dlam * 0.5) ** 2)
    c = 2.0 * math.asin(min(1.0, math.sqrt(max(0.0, a))))
    return c * EARTH_RADIUS_KM

def soft_haversine_weight(d_km: float, sigma_km: float = 25.0) -> float:
    return math.exp(- (d_km ** 2) / (2.0 * (sigma_km ** 2)))


class TestSphericalMath(unittest.TestCase):

    def test_cardinal_cartesian_points(self):
        # North Pole
        x, y, z = geodetic_to_cartesian(90.0, 0.0)
        self.assertAlmostEqual(x, 0.0, places=5)
        self.assertAlmostEqual(y, 0.0, places=5)
        self.assertAlmostEqual(z, 1.0, places=5)

        # South Pole
        x, y, z = geodetic_to_cartesian(-90.0, 0.0)
        self.assertAlmostEqual(x, 0.0, places=5)
        self.assertAlmostEqual(y, 0.0, places=5)
        self.assertAlmostEqual(z, -1.0, places=5)

        # Equator at Greenwich Meridian
        x, y, z = geodetic_to_cartesian(0.0, 0.0)
        self.assertAlmostEqual(x, 1.0, places=5)
        self.assertAlmostEqual(y, 0.0, places=5)
        self.assertAlmostEqual(z, 0.0, places=5)

        # Equator 90 deg East
        x, y, z = geodetic_to_cartesian(0.0, 90.0)
        self.assertAlmostEqual(x, 0.0, places=5)
        self.assertAlmostEqual(y, 1.0, places=5)
        self.assertAlmostEqual(z, 0.0, places=5)

    def test_unit_sphere_norm(self):
        test_coords = [
            (37.7749, -122.4194), # San Francisco
            (40.7128, -74.0060),   # New York
            (51.5074, -0.1278),    # London
            (35.6762, 139.6503),   # Tokyo
            (-33.8688, 151.2093),  # Sydney
            (-22.9068, -43.1729)   # Rio de Janeiro
        ]
        for lat, lng in test_coords:
            x, y, z = geodetic_to_cartesian(lat, lng)
            norm = math.sqrt(x*x + y*y + z*z)
            self.assertAlmostEqual(norm, 1.0, places=5, msg=f"Norm failure at {lat}, {lng}")

    def test_haversine_distances(self):
        # Distance to self must be 0
        self.assertAlmostEqual(haversine_distance_km(40.0, -74.0, 40.0, -74.0), 0.0, places=3)

        # NYC to London (~5,570 km)
        d_nyc_lon = haversine_distance_km(40.7128, -74.0060, 51.5074, -0.1278)
        self.assertTrue(5500.0 < d_nyc_lon < 5650.0, f"Expected ~5570km, got {d_nyc_lon}")

        # Antipodal points: Equator (0, 0) to (0, 180) -> half earth circumference (~20,015 km)
        d_antipode = haversine_distance_km(0.0, 0.0, 0.0, 180.0)
        self.assertTrue(20000.0 < d_antipode < 20030.0, f"Expected ~20015km, got {d_antipode}")

    def test_soft_haversine_decay(self):
        sigma = 25.0

        # Exact location -> weight = 1.0
        w_zero = soft_haversine_weight(0.0, sigma)
        self.assertAlmostEqual(w_zero, 1.0, places=5)

        # 1 sigma away (25 km) -> exp(-0.5) ~ 0.6065
        w_1sigma = soft_haversine_weight(25.0, sigma)
        self.assertAlmostEqual(w_1sigma, math.exp(-0.5), places=4)

        # 100 km away -> exp(-8) ~ 0.00033
        w_100km = soft_haversine_weight(100.0, sigma)
        self.assertTrue(w_100km < 0.001)

        # Across the globe (5,000 km) -> 0.0
        w_global = soft_haversine_weight(5000.0, sigma)
        self.assertEqual(w_global, 0.0)


if __name__ == "__main__":
    unittest.main()
