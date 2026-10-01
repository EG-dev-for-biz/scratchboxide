/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { WeatherConditions } from '../../common/geospatial-4d-protocol';
import { getSolarPosition } from '../../common/coordinate/solarPosition';

export class WeatherApiService {
  /**
   * Fetches/resolves a highly nuanced atmospheric weather profile for any geographic coordinate
   * and specific temporal instant using public meteorological data APIs or simulated physics models.
   */
  public static async fetchNuancedWeather(
    lat: number,
    lng: number,
    date: Date = new Date()
  ): Promise<WeatherConditions> {
    try {
      // Direct call to an open-source high-nuance met-office API (e.g. Open-Meteo)
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m`;
      
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        const current = data.current;
        if (current) {
          const temp = current.temperature_2m ?? 15.0;
          const hum = current.relative_humidity_2m ?? 60.0;
          const precip = current.precipitation ?? 0.0;
          const clouds = current.cloud_cover ?? 10.0;
          const press = current.pressure_msl ?? 1013.25;
          const windKmh = current.wind_speed_10m ?? 12.0;
          const windDir = current.wind_direction_10m ?? 240.0;

          // Deduce weather category conditions
          let conditions: WeatherConditions['conditions'] = 'sunny';
          if (precip > 5.0) conditions = 'stormy';
          else if (precip > 0.0) {
            conditions = current.snowfall > 0.0 ? 'snowy' : 'rainy';
          } else if (clouds > 60.0) {
            conditions = 'cloudy';
          }

          // Calculate fog density derived from high relative humidity and low temperature spread
          const dewPoint = temp - ((100.0 - hum) / 5.0);
          const spread = temp - dewPoint;
          const fogDensity = spread < 1.5 ? Math.max(0.1, 1.0 - spread / 1.5) : 0.0;

          // Calculate wind vector in local Cartesian East-North-Up coordinate system
          const windDirRad = (windDir * Math.PI) / 180.0;
          const windMps = windKmh / 3.6;
          // Wind vector pointing TO where the wind is going:
          // angle represents source compass, so direction is opposite
          const windX = -windMps * Math.sin(windDirRad);
          const windZ = windMps * Math.cos(windDirRad);

          return {
            conditions,
            fogDensity: parseFloat(fogDensity.toFixed(2)),
            ambientTemperatureC: parseFloat(temp.toFixed(1)),
            windVector: [parseFloat(windX.toFixed(2)), 0.0, parseFloat(windZ.toFixed(2))],
            precipitationMmHr: parseFloat(precip.toFixed(2)),
            humidityPercent: Math.round(hum),
            cloudCoverPercent: Math.round(clouds),
            visibilityMeters: clouds > 80.0 ? 2000 : 10000,
            uvIndex: clouds > 80.0 ? 1 : 6,
            windSpeedKmh: parseFloat(windKmh.toFixed(1)),
            windDirectionDeg: Math.round(windDir),
            airPressureHpa: parseFloat(press.toFixed(1)),
            dewPointC: parseFloat(dewPoint.toFixed(1))
          };
        }
      }
    } catch (e) {
      // Graceful fallback to physical simulation if offline or API rate-limited
    }

    return this.simulateAtmosphericPhysics(lat, lng, date);
  }

  /**
   * Simulates micro-climatic environment parameters based on latitude, coastal proximity,
   * solar elevation, and season.
   */
  private static simulateAtmosphericPhysics(lat: number, lng: number, date: Date): WeatherConditions {
    const month = date.getMonth(); // 0 - 11
    const solar = getSolarPosition(date, lat, lng);
    const sunElevDeg = solar.altitude * (180.0 / Math.PI);

    // Is location near San Francisco / California coast? (Lat 37-38, Lng -123 to -122)
    const isSFBay = lat >= 37.0 && lat <= 38.5 && lng >= -123.0 && lng <= -121.5;

    // 1. Calculate temperature based on latitude, season, and sun elevation
    const baseTemp = 15.0 - Math.abs(lat) * 0.15; // colder at high latitudes
    const seasonalShift = Math.sin(((month - 5) / 12) * 2 * Math.PI) * 8.0; // warmer in summer (June-August)
    const diurnalShift = Math.max(-5.0, Math.sin(solar.altitude) * 6.0); // warmer during day
    const temp = baseTemp + seasonalShift + diurnalShift;

    // 2. Coastal fog simulation
    let fogDensity = 0.0;
    let humidity = 62.0;
    let cloudCover = 15.0;

    if (isSFBay) {
      // SF summer fog (Advection fog in June-August during morning/evening)
      const isSummer = month >= 5 && month <= 8;
      const hours = date.getHours();
      const isFogHour = hours < 9 || hours > 18;
      if (isSummer && isFogHour) {
        fogDensity = 0.75;
        humidity = 95.0;
        cloudCover = 80.0;
      }
    }

    // 3. Ambient wind velocities (sea breezes, etc.)
    const windSpeedKmh = 14.0 + Math.sin(sunElevDeg / 20.0) * 8.0; // windier during day
    const windDir = isSFBay ? 245.0 : 180.0; // SF standard westerly sea breeze
    const windDirRad = (windDir * Math.PI) / 180.0;
    const windMps = windSpeedKmh / 3.6;
    const windX = -windMps * Math.sin(windDirRad);
    const windZ = windMps * Math.cos(windDirRad);

    let conditions: WeatherConditions['conditions'] = 'sunny';
    if (cloudCover > 70.0) conditions = 'cloudy';

    const dewPoint = temp - ((100.0 - humidity) / 5.0);

    return {
      conditions,
      fogDensity: parseFloat(fogDensity.toFixed(2)),
      ambientTemperatureC: parseFloat(temp.toFixed(1)),
      windVector: [parseFloat(windX.toFixed(2)), 0.0, parseFloat(windZ.toFixed(2))],
      precipitationMmHr: 0.0,
      humidityPercent: Math.round(humidity),
      cloudCoverPercent: Math.round(cloudCover),
      visibilityMeters: fogDensity > 0.5 ? 500 : 10000,
      uvIndex: sunElevDeg > 0 ? Math.max(1, Math.round(sunElevDeg / 10.0)) : 0,
      windSpeedKmh: parseFloat(windSpeedKmh.toFixed(1)),
      windDirectionDeg: Math.round(windDir),
      airPressureHpa: 1013.2,
      dewPointC: parseFloat(dewPoint.toFixed(1))
    };
  }
}
