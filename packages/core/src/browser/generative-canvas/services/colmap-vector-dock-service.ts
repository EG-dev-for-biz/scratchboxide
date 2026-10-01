/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
  ColmapCameraPose,
  GeodeticAnchor,
  VectorDockMountOptions,
  VectorDockSyncEvent,
  ColmapVectorPipelineResult
} from '../../../common/spatial/colmap-vector-reference-types';
import { LocalTangentPlane } from '../../../common/coordinate/LocalTangentPlane';

declare const google: any;

/**
 * Controller service for mounting and operating the interactive
 * Live Google Maps Vector Reference Dock (Path B) for COLMAP / GLOMAP.
 *
 * Provides real-time bidirectional synchronization between Three.js / WebGL viewports
 * and Google Maps Vector 3D WebGL rendering with AdvancedMarkerElement camera pins.
 */
export class ColmapVectorDockService {
  private container: HTMLElement | null = null;
  private mapInstance: any = null;
  private stationMarkers: Array<{ pose: ColmapCameraPose; marker: any; element: HTMLElement }> = [];
  private activePose: ColmapCameraPose | null = null;
  private ltp: LocalTangentPlane | null = null;
  private anchor: GeodeticAnchor | null = null;
  private options: VectorDockMountOptions | null = null;
  private frustumPolygons: any[] = [];
  private flightPathPolyline: any = null;

  /**
   * Mounts the Google Maps Vector Reference Dock into the specified DOM container.
   */
  public async mount(
    options: VectorDockMountOptions,
    dataset: ColmapVectorPipelineResult | { anchor: GeodeticAnchor; poses: ColmapCameraPose[] }
  ): Promise<boolean> {
    this.options = options;
    this.anchor = dataset.anchor;
    this.ltp = new LocalTangentPlane({
      lat: this.anchor.lat,
      lng: this.anchor.lng,
      alt: this.anchor.elevationMeters
    });

    const el = document.getElementById(options.containerId);
    if (!el) {
      console.error(`[ColmapVectorDockService] Container element #${options.containerId} not found.`);
      return false;
    }
    this.container = el;

    if (typeof google === 'undefined' || !google.maps) {
      console.warn('[ColmapVectorDockService] Google Maps JavaScript API is not loaded yet.');
      return false;
    }

    try {
      const mapId = options.mapId || 'ad80a8568eeae7445909ba9f';
      const mapDiv = this.getOrCreateMapCanvas(el);

      this.mapInstance = new google.maps.Map(mapDiv, {
        center: { lat: this.anchor.lat, lng: this.anchor.lng },
        zoom: options.initialZoom || 17,
        heading: options.initialHeading ?? (this.anchor.headingDeg || 0),
        tilt: options.initialTilt || 45,
        mapId,
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        cameraControl: true
      });

      // Render camera survey station markers
      this.renderStationMarkers(dataset.poses);

      // Render frustum polygons if requested
      if (options.showFrustums) {
        this.renderFrustumPolygons(dataset.poses);
      }

      // Render trajectory polyline if requested
      if (options.showTrajectoryLine) {
        this.renderTrajectoryPolyline(dataset.poses);
      }

      return true;
    } catch (err) {
      console.error('[ColmapVectorDockService] Failed to initialize Vector Map:', err);
      return false;
    }
  }

  /**
   * Renders AdvancedMarkerElement pins for all survey stations.
   */
  public renderStationMarkers(poses: ColmapCameraPose[]): void {
    if (!this.mapInstance) return;

    // Clear existing markers
    this.stationMarkers.forEach(item => {
      if (item.marker && item.marker.map) item.marker.map = null;
    });
    this.stationMarkers = [];

    const hasAdvancedMarkers = !!google.maps.marker?.AdvancedMarkerElement;

    poses.forEach((pose, idx) => {
      const pin = document.createElement('div');
      pin.id = `colmap-dock-pin-${pose.id || idx + 1}`;
      pin.className = 'colmap-dock-station-pin cursor-pointer transition-all duration-200 hover:scale-125';
      pin.style.display = 'flex';
      pin.style.flexDirection = 'column';
      pin.style.alignItems = 'center';
      pin.style.cursor = 'pointer';

      const tierColor = pose.pitchDegrees < -45.0 ? '#d97706' : '#0284c7';
      const borderColor = pose.pitchDegrees < -45.0 ? '#fbbf24' : '#38bdf8';

      pin.innerHTML = `
        <div style="background: ${tierColor}; color: white; padding: 2px 6px; border-radius: 6px; font-size: 10px; font-weight: bold; font-family: monospace; border: 1.5px solid ${borderColor}; box-shadow: 0 2px 8px rgba(0,0,0,0.6); display: flex; align-items: center; gap: 4px; white-space: nowrap;">
          <span>📷</span>
          <span>#${String(pose.id || idx + 1).padStart(2, '0')}</span>
        </div>
        <div style="width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid ${borderColor};"></div>
      `;

      let marker: any = null;
      if (hasAdvancedMarkers) {
        marker = new google.maps.marker.AdvancedMarkerElement({
          map: this.mapInstance,
          position: { lat: pose.coordinatesWGS84.lat, lng: pose.coordinatesWGS84.lng },
          title: `${pose.name} (Alt: ${pose.coordinatesWGS84.elevation}m, Lens: ${pose.focalLengthMm}mm)`,
          content: pin
        });
      } else {
        // Fallback for standard markers
        marker = new google.maps.Marker({
          map: this.mapInstance,
          position: { lat: pose.coordinatesWGS84.lat, lng: pose.coordinatesWGS84.lng },
          title: pose.name
        });
      }

      marker.addListener('click', () => {
        this.selectStation(pose, true);
      });

      this.stationMarkers.push({ pose, marker, element: pin });
    });
  }

  /**
   * Renders frustum ground footprints as polygon overlays.
   */
  public renderFrustumPolygons(poses: ColmapCameraPose[]): void {
    if (!this.mapInstance) return;

    this.frustumPolygons.forEach(p => p.setMap(null));
    this.frustumPolygons = [];

    poses.forEach(pose => {
      if (pose.frustumFootprintWGS84 && pose.frustumFootprintWGS84.length >= 3) {
        const path = pose.frustumFootprintWGS84.map(([lng, lat]) => ({ lat, lng }));
        const poly = new google.maps.Polygon({
          paths: path,
          strokeColor: '#38bdf8',
          strokeOpacity: 0.6,
          strokeWeight: 1,
          fillColor: '#0284c7',
          fillOpacity: 0.12,
          map: this.mapInstance
        });
        this.frustumPolygons.push(poly);
      }
    });
  }

  /**
   * Renders flight path trajectory as a polyline overlay.
   */
  public renderTrajectoryPolyline(poses: ColmapCameraPose[]): void {
    if (!this.mapInstance || poses.length < 2) return;

    if (this.flightPathPolyline) {
      this.flightPathPolyline.setMap(null);
    }

    const path = poses.map(p => ({
      lat: p.coordinatesWGS84.lat,
      lng: p.coordinatesWGS84.lng
    }));

    this.flightPathPolyline = new google.maps.Polyline({
      path,
      geodesic: true,
      strokeColor: '#fbbf24',
      strokeOpacity: 0.85,
      strokeWeight: 2.5,
      map: this.mapInstance
    });
  }

  /**
   * Selects an active survey station, highlighting its pin on Google Maps
   * and notifying listeners to animate the 3D camera.
   */
  public selectStation(pose: ColmapCameraPose, triggerListener: boolean = true): void {
    this.activePose = pose;

    // Highlight pin
    this.stationMarkers.forEach(item => {
      if (item.pose.id === pose.id) {
        item.element.style.transform = 'scale(1.4)';
        item.element.style.filter = 'drop-shadow(0 0 10px #38bdf8)';
        if (item.marker.zIndex !== undefined) item.marker.zIndex = 999;
      } else {
        item.element.style.transform = 'scale(1.0)';
        item.element.style.filter = 'none';
        if (item.marker.zIndex !== undefined) item.marker.zIndex = 10;
      }
    });

    // Center Google Map
    if (this.mapInstance && pose.coordinatesWGS84) {
      this.mapInstance.panTo({
        lat: pose.coordinatesWGS84.lat,
        lng: pose.coordinatesWGS84.lng
      });
      if (pose.yawDegrees !== undefined) {
        this.mapInstance.setHeading(pose.yawDegrees);
      }
    }

    if (triggerListener && this.options?.onStationSelect) {
      this.options.onStationSelect(pose);
    }
  }

  /**
   * Synchronizes the Google Maps view from the 3D viewport camera telemetry.
   */
  public syncFrom3DCamera(
    positionLocalENU: [number, number, number],
    forwardVectorENU: [number, number, number]
  ): void {
    if (!this.mapInstance || !this.ltp || !this.anchor) return;

    const wgs = this.ltp.toLatLng(positionLocalENU);
    const yaw = ((Math.atan2(forwardVectorENU[0], -forwardVectorENU[2]) * 180.0) / Math.PI + 360.0) % 360.0;
    const pitch = (Math.asin(Math.max(-1.0, Math.min(1.0, forwardVectorENU[1]))) * 180.0) / Math.PI;

    this.mapInstance.panTo({ lat: wgs.lat, lng: wgs.lng });
    this.mapInstance.setHeading(yaw);

    if (this.options?.onCameraSync) {
      const event: VectorDockSyncEvent = {
        source: 'viewport_3d_fly',
        activeStationId: this.activePose?.id,
        cameraPositionLocal: positionLocalENU,
        cameraPositionWgs84: {
          lat: wgs.lat,
          lng: wgs.lng,
          elevation: wgs.alt ?? this.anchor.elevationMeters
        },
        compassHeadingDeg: Number(yaw.toFixed(2)),
        pitchDeg: Number(pitch.toFixed(2))
      };
      this.options.onCameraSync(event);
    }
  }

  /**
   * Helper to find or create the canvas inside the container.
   */
  private getOrCreateMapCanvas(container: HTMLElement): HTMLElement {
    let canvas = container.querySelector('.colmap-vector-map-canvas') as HTMLElement;
    if (!canvas) {
      canvas = document.createElement('div');
      canvas.className = 'colmap-vector-map-canvas';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      container.appendChild(canvas);
    }
    return canvas;
  }

  /**
   * Destroys and cleans up the dock instance.
   */
  public destroy(): void {
    this.stationMarkers.forEach(item => {
      if (item.marker && item.marker.map) item.marker.map = null;
    });
    this.stationMarkers = [];
    this.frustumPolygons.forEach(p => p.setMap(null));
    this.frustumPolygons = [];
    if (this.flightPathPolyline) {
      this.flightPathPolyline.setMap(null);
      this.flightPathPolyline = null;
    }
    this.mapInstance = null;
    this.container = null;
    this.activePose = null;
  }
}
