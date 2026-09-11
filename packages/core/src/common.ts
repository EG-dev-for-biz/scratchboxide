/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Geodetic and Local Tangent Plane Coordinate Systems
export { GeoFrame } from '../../../extensions/product/src/common/coordinate/GeoFrame';
export { LocalTangentPlane } from '../../../extensions/product/src/common/coordinate/LocalTangentPlane';
export type { LatLngAlt } from '../../../extensions/product/src/common/coordinate/LocalTangentPlane';

// Common Gemini Protocols & RPC Message Contracts
export * from '../../../extensions/product/src/common/gemini-protocol';

// Project Artifact Graph Protocol
export * from '../../../extensions/product/src/common/project-artifact-graph-protocol';

// Media Generation Protocol (Nano Banana, Omni 1.1, Imagen, Veo)
export * from '../../../extensions/product/src/common/media-generation-protocol';
