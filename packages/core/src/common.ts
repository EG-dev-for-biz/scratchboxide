/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Geodetic and Local Tangent Plane Coordinate Systems
export { GeoFrame } from './common/coordinate/GeoFrame';
export { LocalTangentPlane } from './common/coordinate/LocalTangentPlane';
export type { LatLngAlt } from './common/coordinate/LocalTangentPlane';

// Common Gemini Protocols & RPC Message Contracts
export * from './common/gemini-protocol';

// API client auth configuration (per-launch token plumbing)
export * from './common/api-client-config';

// Project Artifact Graph Protocol
export * from './common/project-artifact-graph-protocol';

// Media Generation Protocol (Nano Banana, Omni 1.1, Imagen, Veo)
export * from './common/media-generation-protocol';
