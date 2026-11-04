/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Walk mode for the Scene3D viewport: a first-person walker who keeps to the ground of whatever the scene holds (a
 * staged district, a scan, a sculpt) and cannot pass through its surfaces, with the free-flying camera as its other half
 * (F switches).
 *
 * The walker is a kinematic body. Its feet stand on the highest walkable surface under it (a normal within maxSlopeDeg
 * of up), its eye eyeHeight above them. WASD or the arrows move it on the horizontal plane at walkSpeed, runSpeed with
 * Shift. It steps up anything up to stepUp high and keeps to the ground down to stepDown as it walks (kerbs, stairs,
 * slopes); past that it falls under gravity, and over nothing at all it holds its height. Its body is a capsule of
 * `radius` from stepUp above the feet to the top of the head, pushed out of every surface it touches along the
 * horizontal only, so it slides along a wall instead of stopping at it or passing through. A slope too steep to stand on
 * cannot be climbed and slides the walker down it. Motion is per second, split into substeps no longer than half the
 * radius, so a run at any frame rate cannot tunnel through a wall.
 *
 * Everything is decided by geometry (walkCollision.ts): rays, heights and normals, never what a surface belongs to.
 */

import * as THREE from 'three';
import { WalkCollisionWorld } from './walkCollision';
import type { WalkCollisionStats, WalkSurfaceHit } from './walkCollision';

export interface WalkParams {
    /** Eye above the feet (m). */
    eyeHeight: number;
    /** Top of the head above the eye (m): the body reaches eyeHeight + headroom. */
    headroom: number;
    /** Body (capsule) radius (m). */
    radius: number;
    /** Highest rise the walker steps up onto as it walks (m): kerbs, stair risers. */
    stepUp: number;
    /** Lowest drop the walker keeps to the ground over as it walks (m); further down it falls. */
    stepDown: number;
    /** Steepest surface (degrees from level) the walker stands on. */
    maxSlopeDeg: number;
    walkSpeed: number;
    runSpeed: number;
    flySpeed: number;
    flyFastSpeed: number;
    gravity: number;
    terminalSpeed: number;
    /** Speed down a surface too steep to stand on (m/s). */
    slideSpeed: number;
}

export const WALK_DEFAULTS: Readonly<WalkParams> = {
    eyeHeight: 1.7,
    headroom: 0.15,
    radius: 0.3,
    stepUp: 0.4,
    stepDown: 0.4,
    maxSlopeDeg: 45,
    walkSpeed: 1.4,
    runSpeed: 5,
    flySpeed: 10,
    flyFastSpeed: 40,
    gravity: 9.81,
    terminalSpeed: 50,
    slideSpeed: 3
};

/** Movement asked for this frame: forward / right / up in [-1, 1] (up only flies), run held. */
export interface WalkInput { forward: number; right: number; up: number; run: boolean }

export type WalkSubMode = 'walk' | 'fly';

/** Longest frame stepped at once (s): a stalled tab resumes where it was instead of leaping. */
const MAX_DT = 0.1;
const MAX_SUBSTEPS = 16;
/** Wall push-outs per substep (a corner takes two). */
const MAX_PUSHES = 4;
const SKIN = 1e-3;
/** Contacts whose push is mostly vertical (|horizontal| below this) are floors or ceilings, not walls. */
const MIN_WALL_HORIZONTAL = 0.3;
/** A steep surface higher than the feet by more than this stops the walker (m). */
const STEEP_RISE = 0.02;
/** Nothing within this far below is a void: the walker holds its height there (m). */
const VOID_DEPTH = 1000;
const VOID_RECHECK_S = 0.5;
/** The eye eases onto a step at this rate (1/s). */
const EYE_CATCH_UP = 12;
const MAX_EYE_LAG = 0.5;
const LOOK_RADIANS_PER_PX = 0.0025;
const PITCH_LIMIT = Math.PI / 2 - 0.05;
/** Ground probes: the centre and four around it at half the radius, so a crack between triangles is no hole. */
const PROBES: ReadonlyArray<readonly [number, number]> = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
const DOWN = new THREE.Vector3(0, -1, 0);

interface Ground { y: number; walkable: boolean; nx: number; nz: number }

const _origin = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _move = new THREE.Vector3();
const _gatherBox = new THREE.Box3();

/** The walking (or flying) body. Step it once a frame, then put the camera at its eye. */
export class Walker {
    readonly params: WalkParams;
    readonly feet = new THREE.Vector3();
    yaw = 0;
    pitch = 0;
    mode: WalkSubMode = 'walk';
    /** Vertical speed while falling (m/s, up positive). */
    vy = 0;
    grounded = false;
    /** The surface under the walker is too steep to stand on: it slides down it. */
    sliding = false;
    /** Nothing below to fall to: the walker holds its height until something is. */
    overVoid = false;
    /** The eye's lag behind a step up or down (m), eased away. */
    private eyeLag = 0;
    private voidTimer = 0;
    private readonly slide = new THREE.Vector3();
    private readonly cosMaxSlope: number;

    constructor(private readonly world: WalkCollisionWorld, params: Partial<WalkParams> = {}) {
        this.params = { ...WALK_DEFAULTS, ...params };
        this.cosMaxSlope = Math.cos(THREE.MathUtils.degToRad(this.params.maxSlopeDeg));
    }

    /** Stands the walker on the first surface at or below `point` (within 1 km), facing yaw, pitch. */
    placeAt(point: THREE.Vector3, yaw: number, pitch: number, mode: WalkSubMode = 'walk'): void {
        this.feet.copy(point);
        this.yaw = yaw;
        this.pitch = THREE.MathUtils.clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
        this.mode = mode;
        this.vy = 0;
        this.eyeLag = 0;
        this.sliding = false;
        this.grounded = false;
        this.overVoid = false;
        if (mode === 'fly') return;
        _origin.set(point.x, point.y + this.params.stepUp, point.z);
        const hit = this.world.raycast(_origin, DOWN, VOID_DEPTH, true);
        if (hit) {
            this.feet.y = hit.point.y;
            this.grounded = true;
            this.setSlide(hit.normal);
        } else {
            this.overVoid = true;
            this.voidTimer = VOID_RECHECK_S;
        }
        this.gatherAround(0, this.params.stepDown);
        this.pushOutOfWalls();
    }

    /** Switches between walking and flying; a walker let go in the air falls to what is below. */
    setMode(mode: WalkSubMode): void {
        if (mode === this.mode) return;
        this.mode = mode;
        this.vy = 0;
        this.grounded = false;
        this.sliding = false;
        this.eyeLag = 0;
        if (mode === 'walk') this.checkVoid();
    }

    /** Turns the view by a pointer movement (px). */
    look(dxPx: number, dyPx: number): void {
        this.yaw -= dxPx * LOOK_RADIANS_PER_PX;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dyPx * LOOK_RADIANS_PER_PX, -PITCH_LIMIT, PITCH_LIMIT);
    }

    /** Where the eye is. */
    eye(out: THREE.Vector3): THREE.Vector3 {
        return out.set(this.feet.x, this.feet.y + this.params.eyeHeight + this.eyeLag, this.feet.z);
    }

    /** Puts the camera at the eye, looking along yaw and pitch. */
    applyTo(camera: THREE.Camera): void {
        this.eye(camera.position);
        camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
        camera.updateMatrixWorld();
    }

    /** Advances the walker by dt seconds of `input`. */
    step(dt: number, input: WalkInput): void {
        dt = Math.min(Math.max(dt, 0), MAX_DT);
        if (dt === 0) return;
        const p = this.params;
        this.eyeLag *= Math.exp(-dt * EYE_CATCH_UP);
        if (this.mode === 'fly') { this.fly(dt, input); return; }
        // forward is -Z at yaw 0 (the camera's view), right is +X
        const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
        let wx = -sin * input.forward + cos * input.right;
        let wz = -cos * input.forward - sin * input.right;
        const len = Math.hypot(wx, wz);
        const speed = (input.run ? p.runSpeed : p.walkSpeed) * Math.min(1, len);
        if (len > 1e-9) { wx *= speed / len; wz *= speed / len; } else { wx = 0; wz = 0; }
        const reach = (speed + (this.sliding ? p.slideSpeed : 0)) * dt;
        const drop = this.grounded ? 0 : (Math.abs(this.vy) + p.gravity * dt) * dt;
        this.gatherAround(reach, p.stepDown + drop);
        const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(reach / (p.radius * 0.5)), Math.ceil(drop / p.radius)));
        const h = dt / steps;
        for (let i = 0; i < steps; i++) this.substep(wx * h, wz * h, h);
        if (this.overVoid && (this.voidTimer -= dt) <= 0) this.checkVoid();
    }

    private substep(dx: number, dz: number, h: number): void {
        const p = this.params, f = this.feet;
        if (this.sliding) { dx += this.slide.x * p.slideSpeed * h; dz += this.slide.z * p.slideSpeed * h; }
        const fromX = f.x, fromZ = f.z;
        f.x += dx;
        f.z += dz;
        this.pushOutOfWalls();
        if (this.grounded) {
            const g = this.probeGround(p.stepUp, p.stepDown);
            if (!g) this.leaveGround();
            else if (g.walkable) { this.settle(g.y); this.sliding = false; }
            else if (g.y > f.y + STEEP_RISE) { f.x = fromX; f.z = fromZ; }
            else { this.settle(g.y); this.sliding = true; this.slide.set(g.nx, 0, g.nz).normalize(); }
        }
        if (!this.grounded) this.fall(h);
    }

    /** Feet onto a surface met walking: the eye keeps its height for a moment and eases onto it. */
    private settle(y: number): void {
        this.eyeLag = THREE.MathUtils.clamp(this.eyeLag + this.feet.y - y, -MAX_EYE_LAG, MAX_EYE_LAG);
        this.feet.y = y;
    }

    private setSlide(normal: THREE.Vector3): void {
        this.sliding = normal.y < this.cosMaxSlope;
        if (this.sliding) this.slide.set(normal.x, 0, normal.z).normalize();
    }

    private leaveGround(): void {
        this.grounded = false;
        this.sliding = false;
        this.vy = 0;
        this.checkVoid();
    }

    private fall(h: number): void {
        if (this.overVoid) return;
        const p = this.params;
        this.vy = Math.max(this.vy - p.gravity * h, -p.terminalSpeed);
        const dy = this.vy * h;
        const g = this.probeGround(p.stepUp, -dy);
        if (g) {
            this.feet.y = g.y;
            this.vy = 0;
            this.grounded = true;
            this.sliding = !g.walkable;
            if (this.sliding) this.slide.set(g.nx, 0, g.nz).normalize();
        } else {
            this.feet.y += dy;
        }
    }

    private checkVoid(): void {
        _origin.set(this.feet.x, this.feet.y + SKIN, this.feet.z);
        this.overVoid = !this.world.raycast(_origin, DOWN, VOID_DEPTH, true);
        this.voidTimer = VOID_RECHECK_S;
        if (this.overVoid) this.vy = 0;
    }

    /**
     * The surface the feet stand on, from `up` above them down to `down` below: the walkable one under the centre; else
     * the highest walkable one the probes around it meet (a crack between triangles, the walker's edge still on a ledge);
     * else the steep one under the centre; else none.
     */
    private probeGround(up: number, down: number): Ground | null {
        const f = this.feet, off = this.params.radius * 0.5, top = f.y + up, len = up + down;
        let best: Ground | null = null;
        let centre: WalkSurfaceHit | null = null;
        for (let k = 0; k < PROBES.length; k++) {
            _origin.set(f.x + PROBES[k][0] * off, top, f.z + PROBES[k][1] * off);
            const hit = this.world.raycast(_origin, DOWN, len);
            if (!hit) continue;
            const walkable = hit.normal.y >= this.cosMaxSlope;
            if (k === 0) {
                if (walkable) return { y: hit.point.y, walkable, nx: hit.normal.x, nz: hit.normal.z };
                centre = hit;
            } else if (walkable && (!best || hit.point.y > best.y)) {
                best = { y: hit.point.y, walkable, nx: hit.normal.x, nz: hit.normal.z };
            }
        }
        if (best) return best;
        return centre ? { y: centre.point.y, walkable: false, nx: centre.normal.x, nz: centre.normal.z } : null;
    }

    /** Pushes the body out of every wall it touches, deepest first, along the horizontal only. */
    private pushOutOfWalls(): void {
        const p = this.params, f = this.feet;
        const low = p.stepUp + p.radius, high = Math.max(low, p.eyeHeight + p.headroom - p.radius);
        for (let i = 0; i < MAX_PUSHES; i++) {
            _a.set(f.x, f.y + low, f.z);
            _b.set(f.x, f.y + high, f.z);
            let travel = 0, px = 0, pz = 0;
            this.world.capsuleContacts(_a, _b, p.radius, (push, depth) => {
                const hl = Math.hypot(push.x, push.z);
                if (hl < MIN_WALL_HORIZONTAL) return;
                // moving sideways by t raises the separation along a sloped push by t * |horizontal|
                const t = depth / hl;
                if (t > travel) { travel = t; px = push.x / hl; pz = push.z / hl; }
            });
            if (travel <= 0) return;
            const move = Math.min(travel + SKIN, p.radius);
            f.x += px * move;
            f.z += pz * move;
        }
    }

    private fly(dt: number, input: WalkInput): void {
        const p = this.params;
        const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
        _move.set(-sy * cp * input.forward + cy * input.right, sp * input.forward + input.up, -cy * cp * input.forward - sy * input.right);
        const len = _move.length();
        if (len > 1) _move.divideScalar(len);
        this.feet.addScaledVector(_move, (input.run ? p.flyFastSpeed : p.flySpeed) * dt);
    }

    /** Gathers the surfaces within this frame's reach of the body. */
    private gatherAround(reach: number, below: number): void {
        const p = this.params, f = this.feet, r = p.radius + reach + 0.5;
        _gatherBox.min.set(f.x - r, f.y - below - 0.5, f.z - r);
        _gatherBox.max.set(f.x + r, f.y + p.eyeHeight + p.headroom + p.stepUp + reach + 0.5, f.z + r);
        this.world.gather(_gatherBox);
    }
}

/** Movement keys (KeyboardEvent.code) held: WASD or arrows, Shift to run, E / Q up and down in flight. */
export function walkInputOf(keys: Record<string, boolean>): WalkInput {
    const held = (...codes: string[]) => codes.some(c => keys[c]);
    return {
        forward: (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0),
        right: (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0),
        up: (held('KeyE', 'Space') ? 1 : 0) - (held('KeyQ') ? 1 : 0),
        run: held('ShiftLeft', 'ShiftRight')
    };
}

export interface WalkFrameStats extends WalkCollisionStats {
    mode: WalkSubMode;
    /** Ground speed this moment (m/s). */
    speed: number;
    running: boolean;
    grounded: boolean;
    falling: boolean;
    overVoid: boolean;
    /** Frame interval, smoothed, and its 95th percentile over the last 2 s (ms). */
    frameMs: number;
    frameP95Ms: number;
    /** The walker's own cost a frame (collision, ground, camera), smoothed, and its worst over the last 2 s (ms). */
    stepMs: number;
    stepMaxMs: number;
    feet: [number, number, number];
    pointerLocked: boolean;
}

export interface WalkSessionOptions {
    scene: THREE.Object3D;
    camera: THREE.PerspectiveCamera;
    /** The viewport element: pointer lock and mouse look are taken on it. */
    container: HTMLElement;
    /** Vetoes viewport plumbing (cursors, gizmos, helpers) from the surfaces the walker meets. */
    include?: (mesh: THREE.Mesh) => boolean;
    /** The pointer lock was released (Esc, focus lost): the viewport leaves walk mode. */
    onPointerLockLost?: () => void;
    params?: Partial<WalkParams>;
}

/** Where to start: the ground under `ndc` of the camera's view (the screen centre by default), else under `fallback`. */
export interface WalkStart { ndc?: THREE.Vector2; fallback?: THREE.Vector3; mode?: WalkSubMode }

const REFRESH_MS = 500;
const STATS_WINDOW = 120;

/** A walk through the viewport's scene: the walker, its surfaces, the pointer lock and the frame stats. */
export class WalkSession {
    readonly world: WalkCollisionWorld;
    readonly walker: Walker;
    private lastRefresh = 0;
    private locked = false;
    private readonly frames: number[] = [];
    private readonly steps: number[] = [];
    private frameMs = 0;
    private stepMs = 0;
    private speed = 0;
    private running = false;
    private readonly last = new THREE.Vector3();
    private readonly detach: () => void;

    constructor(private readonly opts: WalkSessionOptions, start: WalkStart = {}) {
        this.world = new WalkCollisionWorld(opts.scene, opts.include);
        this.walker = new Walker(this.world, opts.params);
        this.lastRefresh = now();
        const { camera } = opts;
        const view = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
        const mode = start.mode ?? 'walk';
        const p = this.walker.params;
        if (mode === 'fly') {
            this.walker.placeAt(camera.position.clone().setY(camera.position.y - p.eyeHeight), view.y, view.x, 'fly');
        } else {
            this.walker.placeAt(this.dropPoint(start), view.y, 0, 'walk');
        }
        this.last.copy(this.walker.feet);
        this.walker.applyTo(camera);
        this.detach = this.attachPointer();
    }

    /** The drop point: the surface under the start ray, stood in front of when it is a wall; else the fallback. */
    private dropPoint(start: WalkStart): THREE.Vector3 {
        const { camera, scene } = this.opts;
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(start.ndc ?? new THREE.Vector2(0, 0), camera);
        const hit = raycaster.intersectObjects(scene.children, true).find(h => this.world.meets(h.object));
        if (!hit) return (start.fallback ?? camera.position).clone();
        const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
        if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
        const cosMax = Math.cos(THREE.MathUtils.degToRad(this.walker.params.maxSlopeDeg));
        if (normal.y >= cosMax) return hit.point.clone();
        // a wall or a steep face: stand at its foot, a body's width in front of it
        const out = new THREE.Vector3(normal.x, 0, normal.z);
        if (out.lengthSq() < 1e-8) out.set(-raycaster.ray.direction.x, 0, -raycaster.ray.direction.z);
        return hit.point.clone().addScaledVector(out.normalize(), this.walker.params.radius + 0.1);
    }

    private attachPointer(): () => void {
        const el = this.opts.container;
        if (typeof document === 'undefined') return () => undefined;
        const onChange = () => {
            const isLocked = document.pointerLockElement === el;
            if (this.locked && !isLocked) { this.locked = false; this.opts.onPointerLockLost?.(); return; }
            this.locked = isLocked;
        };
        const onMove = (e: MouseEvent) => { if (this.locked) this.walker.look(e.movementX || 0, e.movementY || 0); };
        const onDown = (e: MouseEvent) => { if (!this.locked && e.button === 0) this.lockPointer(); };
        document.addEventListener('pointerlockchange', onChange);
        document.addEventListener('mousemove', onMove);
        el.addEventListener('mousedown', onDown);
        return () => {
            document.removeEventListener('pointerlockchange', onChange);
            document.removeEventListener('mousemove', onMove);
            el.removeEventListener('mousedown', onDown);
            if (document.pointerLockElement === el) document.exitPointerLock?.();
        };
    }

    /** Takes the pointer for mouse look (needs a user gesture; refused or unsupported, a drag still looks). */
    lockPointer(): void {
        const el = this.opts.container as HTMLElement & { requestPointerLock?: () => unknown };
        try {
            const pending = el.requestPointerLock?.();
            if (pending && typeof (pending as Promise<void>).catch === 'function') (pending as Promise<void>).catch(() => undefined);
        } catch { /* no pointer lock here: drag to look */ }
    }

    get pointerLocked(): boolean { return this.locked; }

    /** A drag of the pointer (px) while the pointer is not locked. */
    look(dxPx: number, dyPx: number): void { this.walker.look(dxPx, dyPx); }

    toggleFly(): WalkSubMode {
        this.walker.setMode(this.walker.mode === 'walk' ? 'fly' : 'walk');
        return this.walker.mode;
    }

    /** One frame: dt seconds with the keys held (KeyboardEvent.code). */
    step(dt: number, keys: Record<string, boolean>): void {
        const t0 = now();
        if (t0 - this.lastRefresh > REFRESH_MS) { this.world.refresh(); this.lastRefresh = t0; }
        const input = walkInputOf(keys);
        const f = this.walker.feet;
        this.last.copy(f);
        this.walker.step(dt, input);
        this.walker.applyTo(this.opts.camera);
        const ms = now() - t0;
        if (dt > 0) {
            const moved = Math.hypot(f.x - this.last.x, f.z - this.last.z) / Math.min(dt, MAX_DT);
            this.speed += (moved - this.speed) * 0.2;
            push(this.frames, dt * 1000);
            this.frameMs += (dt * 1000 - this.frameMs) * (this.frameMs ? 0.1 : 1);
        }
        this.running = input.run && (input.forward !== 0 || input.right !== 0);
        push(this.steps, ms);
        this.stepMs += (ms - this.stepMs) * (this.stepMs ? 0.1 : 1);
    }

    /** The orbit view that keeps this view: its pivot on the surface ahead (within 300 m), else 10 m ahead. */
    orbitView(): { target: THREE.Vector3; theta: number; phi: number; distance: number } {
        const { camera, scene } = this.opts;
        const dir = camera.getWorldDirection(new THREE.Vector3());
        const raycaster = new THREE.Raycaster(camera.position.clone(), dir, 0.5, 300);
        const hit = raycaster.intersectObjects(scene.children, true).find(h => this.world.meets(h.object));
        const distance = THREE.MathUtils.clamp(hit?.distance ?? 10, 2, 300);
        return {
            target: camera.position.clone().addScaledVector(dir, distance),
            theta: Math.atan2(-dir.x, -dir.z),
            phi: THREE.MathUtils.clamp(Math.acos(THREE.MathUtils.clamp(-dir.y, -1, 1)), 0.05, Math.PI - 0.05),
            distance
        };
    }

    stats(): WalkFrameStats {
        const w = this.walker, f = w.feet;
        return {
            ...this.world.stats,
            mode: w.mode,
            speed: this.speed,
            running: this.running,
            grounded: w.grounded,
            falling: w.mode === 'walk' && !w.grounded && !w.overVoid,
            overVoid: w.overVoid,
            frameMs: this.frameMs,
            frameP95Ms: percentile(this.frames, 0.95),
            stepMs: this.stepMs,
            stepMaxMs: this.steps.length ? Math.max(...this.steps) : 0,
            feet: [f.x, f.y, f.z],
            pointerLocked: this.locked
        };
    }

    dispose(): void { this.detach(); }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function push(window: number[], v: number): void {
    window.push(v);
    if (window.length > STATS_WINDOW) window.shift();
}

function percentile(values: number[], q: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
