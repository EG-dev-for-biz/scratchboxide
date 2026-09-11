/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { injectable } from '@theia/core/shared/inversify';
import { PlatformDomain } from '../../common/deep-write/deep-write-protocol';

@injectable()
export class MultiPlatformScaffolder {
    /**
     * Generate standard file structure and contents for a specific platform and tech stack.
     * @returns A map of relative file path to file contents.
     */
    public generateScaffold(
        platform: PlatformDomain,
        projectName: string = 'scratchbox_project',
        languages: string[] = []
    ): Record<string, string> {
        const files: Record<string, string> = {};
        const safeName = (projectName || 'scratchbox_project').toLowerCase().replace(/[^a-z0-9_-]/g, '_');

        switch (platform) {
            case 'native_systems':
                if (languages.includes('rust')) {
                    this.scaffoldRustLibrary(files, safeName);
                } else {
                    this.scaffoldCppNativeEngine(files, safeName);
                }
                break;

            case 'spatial_3d':
                this.scaffoldSpatial3DGraphics(files, safeName);
                break;

            case 'mobile':
                this.scaffoldMobileBridge(files, safeName, languages);
                break;

            case 'desktop':
                this.scaffoldDesktopTauri(files, safeName);
                break;

            case 'cloud_backend':
                if (languages.includes('go')) {
                    this.scaffoldGoCloudBackend(files, safeName);
                } else {
                    this.scaffoldPythonCloudBackend(files, safeName);
                }
                break;

            case 'web':
            default:
                this.scaffoldNextjsWeb(files, safeName);
                break;
        }

        return files;
    }

    private scaffoldRustLibrary(files: Record<string, string>, name: string): void {
        files['Cargo.toml'] = `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
serde = { version = "1.0", features = ["derive"] }
serde-wasm-bindgen = "0.6"
`;

        files['src/lib.rs'] = `use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
pub struct PhysicsState {
    pub x: f32,
    pub y: f32,
    pub vx: f32,
    pub vy: f32,
}

#[wasm_bindgen]
pub fn compute_step(x: f32, y: f32, vx: f32, vy: f32, dt: f32) -> JsValue {
    let mut state = PhysicsState { x, y, vx, vy };
    
    // Euler integration step with simple gravity & wind resistance
    let gravity = -9.81;
    let drag_coeff = 0.05;
    
    let ax = -state.vx * drag_coeff;
    let ay = gravity - state.vy * drag_coeff;
    
    state.vx += ax * dt;
    state.vy += ay * dt;
    state.x += state.vx * dt;
    state.y += state.vy * dt;
    
    serde_wasm_bindgen::to_value(&state).unwrap()
}
`;

        files['tests/physics.rs'] = `use ${name}::compute_step;

#[test]
fn test_integration() {
    // Basic test checking state integration steps
}
`;
    }

    private scaffoldCppCppWasmBridge(files: Record<string, string>, name: string): void {
        // C++ WASM Emscripten FFI / JS Bridge code
        files['src/bridge.cpp'] = `#include <emscripten/bind.h>
#include "engine.hpp"

using namespace emscripten;

EMSCRIPTEN_BINDINGS(physics_engine) {
    class_<Engine>("Engine")
        .constructor<float, float>()
        .function("step", &Engine::step)
        .function("getStateX", &Engine::getX)
        .function("getStateY", &Engine::getY);
}
`;
    }

    private scaffoldCppNativeEngine(files: Record<string, string>, name: string): void {
        files['CMakeLists.txt'] = `cmake_minimum_required(VERSION 3.15)
project(${name} LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(${name} SHARED 
    src/engine.cpp 
    src/main.cpp
)

target_include_directories(${name} PUBLIC include)
`;

        files['include/engine.hpp'] = `#pragma once

class Engine {
private:
    float m_x, m_y;
    float m_vx, m_vy;
public:
    Engine(float x, float y);
    void step(float dt);
    float getX() const { return m_x; }
    float getY() const { return m_y; }
};
`;

        files['src/engine.cpp'] = `#include "engine.hpp"

Engine::Engine(float x, float y) : m_x(x), m_y(y), m_vx(0.0f), m_vy(0.0f) {}

void Engine::step(float dt) {
    const float gravity = -9.81f;
    m_vy += gravity * dt;
    m_x += m_vx * dt;
    m_y += m_vy * dt;
}
`;

        files['src/main.cpp'] = `#include <iostream>
#include "engine.hpp"

int main() {
    Engine sim(0.0f, 100.0f);
    std::cout << "Starting native physics simulation..." << std::endl;
    for(int i=0; i<10; ++i) {
        sim.step(0.1f);
        std::cout << "Step " << i << ": Y = " << sim.getY() << std::endl;
    }
    return 0;
}
`;

        this.scaffoldCppCppWasmBridge(files, name);
    }

    private scaffoldSpatial3DGraphics(files: Record<string, string>, name: string): void {
        files['shaders/custom_mesh.wgsl'] = `// WebGPU shader module
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec3<f32>,
}

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec3<f32>,
}

@vertex
fn vs_main(model: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = vec4<f32>(model.position, 1.0);
    out.color = model.color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(in.color, 1.0);
}
`;

        files['shaders/custom_mesh.glsl'] = `// Vertex Shader
#define VertexShader
#ifdef VertexShader
varying vec3 vNormal;
varying vec2 vUv;
void main() {
    vNormal = normalize(normalMatrix * normal);
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
#endif

// Fragment Shader
#define FragmentShader
#ifdef FragmentShader
uniform vec3 uColor;
uniform float uTime;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
    float pulse = sin(uTime * 2.0) * 0.5 + 0.5;
    vec3 lightDir = normalize(vec3(1.0, 1.0, 1.0));
    float diff = max(dot(vNormal, lightDir), 0.0);
    vec3 finalColor = mix(uColor, vec3(1.0, 1.0, 1.0), pulse * 0.2) * (diff + 0.1);
    gl_FragColor = vec4(finalColor, 1.0);
}
#endif
`;

        files['src/scene.ts'] = `import * as THREE from 'three';

export function createScene(container: HTMLElement) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0c);
    scene.fog = new THREE.FogExp2(0x0a0a0c, 0.015);

    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(0, 5, 10);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    // Dynamic Lights
    const ambientLight = new THREE.AmbientLight(0x11111a);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0x00ffcc, 1.5);
    dirLight.position.set(5, 10, 7);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // Grid Floor
    const grid = new THREE.GridHelper(100, 100, 0x00ffcc, 0x112233);
    scene.add(grid);

    return { scene, camera, renderer };
}
`;
    }

    private scaffoldMobileBridge(files: Record<string, string>, name: string, languages: string[]): void {
        if (languages.includes('swift')) {
            files['Package.swift'] = `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "${name}",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "${name}", targets: ["${name}"]),
    ],
    targets: [
        .target(name: "${name}", dependencies: []),
    ]
)
`;
            files[`Sources/${name}/Bridge.swift`] = `import Foundation

@objc public class PhysicsBridge: NSObject {
    @objc public static func performStep(x: Float, y: float, vx: Float, vy: Float) -> NSDictionary {
        let gravity: Float = -9.81
        let newVy = vy + gravity * 0.016
        let newX = x + vx * 0.016
        let newY = y + newVy * 0.016
        
        return [
            "x": newX,
            "y": newY,
            "vx": vx,
            "vy": newVy
        ] as NSDictionary
    }
}
`;
        } else {
            files['build.gradle'] = `plugins {
    id 'com.android.library'
    id 'kotlin-android'
}

android {
    compileSdk 34
    defaultConfig {
        minSdk 24
    }
}
`;
            files[`src/main/java/com/${name}/Bridge.kt`] = `package com.${name}

import android.os.Bundle

object PhysicsBridge {
    fun performStep(x: Float, y: Float, vx: Float, vy: Float): Bundle {
        val gravity = -9.81f
        val dt = 0.016f
        val newVy = vy + gravity * dt
        val newX = x + vx * dt
        val newY = y + newVy * dt
        
        return Bundle().apply {
            putFloat("x", newX)
            putFloat("y", newY)
            putFloat("vx", vx)
            putFloat("vy", newVy)
        }
    }
}
`;
        }
    }

    private scaffoldDesktopTauri(files: Record<string, string>, name: string): void {
        files['src-tauri/tauri.conf.json'] = `{
  "package": {
    "productName": "${name}",
    "version": "0.1.0"
  },
  "build": {
    "distDir": "../dist",
    "devPath": "http://localhost:1420"
  },
  "tauri": {
    "allowlist": {
      "all": true
    },
    "bundle": {
      "active": true,
      "targets": "all"
    },
    "security": {
      "csp": null
    },
    "windows": [
      {
        "title": "${name} Studio Container",
        "width": 1024,
        "height": 768
      }
    ]
  }
}
`;

        files['src-tauri/Cargo.toml'] = `[package]
name = "${name}-app"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "1.5", features = [] }

[dependencies]
tauri = { version = "1.5", features = ["api-all"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
`;

        files['src-tauri/src/main.rs'] = `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn perform_physics_step(x: f64, y: f64, vx: f64, vy: f64) -> (f64, f64, f64, f64) {
    let gravity = -9.81;
    let dt = 0.016;
    let new_vy = vy + gravity * dt;
    let new_x = x + vx * dt;
    let new_y = y + new_vy * dt;
    (new_x, new_y, vx, new_vy)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![perform_physics_step])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`;
    }

    private scaffoldGoCloudBackend(files: Record<string, string>, name: string): void {
        files['go.mod'] = `module ${name}

go 1.20

require (
    github.com/gin-gonic/gin v1.9.1
)
`;

        files['main.go'] = `package main

import (
    "net/http"
    "github.com/gin-gonic/gin"
)

type StepRequest struct {
    X  float64 \`json:"x"\`
    Y  float64 \`json:"y"\`
    Vx float64 \`json:"vx"\`
    Vy float64 \`json:"vy"\`
}

func main() {
    r := gin.Default()
    
    r.GET("/health", func(c *gin.Context) {
        c.JSON(http.StatusOK, gin.H{"status": "healthy"})
    })
    
    r.POST("/api/physics/step", func(c *gin.Context) {
        var req StepRequest
        if err := c.ShouldBindJSON(&req); err != nil {
            c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
            return
        }
        
        gravity := -9.81
        dt := 0.016
        newVy := req.Vy + gravity * dt
        newX := req.X + req.Vx * dt
        newY := req.Y + newVy * dt
        
        c.JSON(http.StatusOK, gin.H{
            "x":  newX,
            "y":  newY,
            "vx": req.Vx,
            "vy": newVy,
        })
    })
    
    r.Run(":8080")
}
`;

        files['Dockerfile'] = `FROM golang:1.20-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o main .

FROM alpine:latest
WORKDIR /root/
COPY --from=builder /app/main .
EXPOSE 8080
CMD ["./main"]
`;
    }

    private scaffoldPythonCloudBackend(files: Record<string, string>, name: string): void {
        files['pyproject.toml'] = `[tool.poetry]
name = "${name}"
version = "0.1.0"
description = "Cloud microservice with fast high-fidelity physics calculations"
authors = ["Eli Green <eligreen@example.com>"]

[tool.poetry.dependencies]
python = "^3.10"
fastapi = "^0.100.0"
uvicorn = "^0.22.0"
pydantic = "^2.0"
`;

        files['main.py'] = `from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="${name} Cloud Engine")

class StepRequest(BaseModel):
    x: float
    y: float
    vx: float
    vy: float

@app.get("/health")
def health():
    return {"status": "healthy"}

@app.post("/api/physics/step")
def physics_step(req: StepRequest):
    gravity = -9.81
    dt = 0.016
    new_vy = req.vy + gravity * dt
    new_x = req.x + req.vx * dt
    new_y = req.y + new_vy * dt
    
    return {
        "x": new_x,
        "y": new_y,
        "vx": req.vx,
        "vy": new_vy
    }
`;

        files['Dockerfile'] = `FROM python:3.10-slim
WORKDIR /app
COPY pyproject.toml poetry.lock* ./
RUN pip install poetry && poetry config virtualenvs.create false && poetry install --no-dev
COPY . .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
`;
    }

    private scaffoldNextjsWeb(files: Record<string, string>, name: string): void {
        files['package.json'] = `{
  "name": "${name}",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "14.0.0",
    "react": "^18",
    "react-dom": "^18"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/node": "^20",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "autoprefixer": "^10",
    "postcss": "^8",
    "tailwindcss": "^3"
  }
}
`;

        files['tailwind.config.js'] = `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          light: '#00ffcc',
          DEFAULT: '#00ccaa',
          dark: '#009988',
        }
      }
    },
  },
  plugins: [],
}
`;

        files['src/app/page.tsx'] = `import React from 'react';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-24 bg-slate-950 text-white">
      <div className="z-10 max-w-5xl w-full items-center justify-between font-mono text-sm lg:flex">
        <h1 className="text-4xl font-extrabold text-brand-light">
          Welcome to ${name} Modern Web Studio
        </h1>
      </div>
    </main>
  );
}
`;
    }
}
