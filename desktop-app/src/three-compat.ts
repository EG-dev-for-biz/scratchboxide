/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from '../../node_modules/three/build/three.module.js';

// Re-export all Three.js r150 symbols directly from three.module.js
export * from '../../node_modules/three/build/three.module.js';
export default THREE;

// Polyfill symbols expected by 3d-tiles-renderer for Three.js r150
export class Matrix2 {
  public elements: number[];

  constructor() {
    this.elements = [1, 0, 0, 1];
  }

  public set(n11: number, n12: number, n21: number, n22: number): this {
    this.elements[0] = n11;
    this.elements[1] = n21;
    this.elements[2] = n12;
    this.elements[3] = n22;
    return this;
  }

  public identity(): this {
    return this.set(1, 0, 0, 1);
  }

  public clone(): Matrix2 {
    return new Matrix2().fromArray(this.elements);
  }

  public copy(m: any): this {
    const me = m.elements;
    return this.set(me[0], me[2], me[1], me[3]);
  }

  public fromArray(array: number[], offset: number = 0): this {
    for (let i = 0; i < 4; i++) {
      this.elements[i] = array[i + offset];
    }
    return this;
  }
}

export class BatchedMesh extends THREE.Mesh {
  constructor(maxGeometryCount: number, maxVertexCount: number, maxIndexCount: number, material?: any) {
    super(new THREE.BufferGeometry(), material);
  }
}

export const TextureUtils = {
  sRGBToLinear: (c: any) => c,
  linearTosRGB: (c: any) => c
};
