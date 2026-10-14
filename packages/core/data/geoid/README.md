# EGM96 geoid grid

`egm96-15.pgm`: EGM96 geoid heights on a 15-minute grid, from GeographicLib's geoid distribution
(https://sourceforge.net/projects/geographiclib/files/geoids-distrib/egm96-15.tar.bz2, dated 2009-08-29).
EGM96 is NGA public-domain data. Heights are `Offset + Scale * value` (Offset -108, Scale 0.003, meters),
1440 x 721 points, row 0 at 90N, column 0 at 0E. Bilinear interpolation error: 0.040 m RMS, 1.152 m max.

Used by `packages/core/src/node/spatial/egm96-geoid.ts` to convert heights above mean sea level (Elevation API,
Solar DSM) to heights above the WGS84 ellipsoid (Photorealistic 3D Tiles): h_ellipsoid = h_msl + N.
