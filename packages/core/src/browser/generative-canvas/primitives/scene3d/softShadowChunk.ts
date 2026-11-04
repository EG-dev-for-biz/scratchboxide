/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport's shadow filter, written into three's `shadowmap_pars_fragment` chunk (three r186 removed
 * PCFSoftShadowMap, and its PCF reads the shadow map through a comparison sampler, which cannot return the blocker
 * depths contact hardening needs). Under `BasicShadowMap` (the sky's sun, syncAtmosphere.ts) the map is raw depth, and:
 *  - the sun's cascades (sunShadowCascades.ts) are filtered PCSS-style: a Poisson-disc blocker search, then Poisson-disc
 *    PCF of bilinear taps whose radius is the sun's angular radius over the blocker-to-receiver distance, so a shadow is
 *    sharp where it touches its caster and softens away from it; each tap compares against the receiver's own plane
 *    (receiver plane depth bias), so a wide kernel on a sloped roof does not shadow the roof;
 *  - every other directional or spot light gets the same Poisson-disc PCF at its `shadow.radius` (in texels).
 * Under the other shadow types the stock filters are kept. The sun's cascade count in the shader is set to
 * SUN_SHADOW_CASCADES. The patch is applied once, before any program that reads it is compiled, and is idempotent.
 */

import * as THREE from 'three';

/** Cascades of the sun's shadow map: the shader's SUN_LIGHT_CASCADES and SunCascadeShadow's viewports. */
export const SUN_SHADOW_CASCADES = 4;
/** tan of the sun's angular radius (0.2666 degrees): the half-width of its penumbra per metre from the blocker. */
export const SUN_TAN_ANGULAR_RADIUS = 0.004653;
/** The widest the sun filter reaches, in shadow texels (each cascade's atlas tile is inset by more than this). */
export const SUN_SHADOW_MAX_KERNEL_TEXELS = 24;
/** The narrowest, in texels: no edge is ever a single texel's stair step. */
export const SUN_SHADOW_MIN_KERNEL_TEXELS = 1.5;
/** How far round a receiver blockers are looked for, metres (times the light's softness): penumbrae up to this half-width. */
export const SUN_SHADOW_SEARCH_M = 0.5;

const MARK = '/* sb-soft-shadows */';

const POISSON_16 = [
    [-0.94201624, -0.39906216], [0.94558609, -0.76890725], [-0.094184101, -0.92938870], [0.34495938, 0.29387760],
    [-0.91588581, 0.45771432], [-0.81544232, -0.87912464], [-0.38277543, 0.27676845], [0.97484398, 0.75648379],
    [0.44323325, -0.97511554], [0.53742981, -0.47373420], [-0.26496911, -0.41893023], [0.79197514, 0.19090188],
    [-0.24188840, 0.99706507], [-0.81409955, 0.91437590], [0.19984126, 0.78641367], [0.14383161, -0.14100790]
];

const glslFloat = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/** Shared by both filters: the Poisson disc, its per-pixel rotation and a bilinear comparison tap. */
const HELPERS = /* glsl */ `
${MARK}
#if defined( SHADOWMAP_TYPE_BASIC )
	#ifdef USE_REVERSED_DEPTH_BUFFER
		#define SB_SHADOW_LIT( d, z ) step( d, z )
	#else
		#define SB_SHADOW_LIT( d, z ) step( z, d )
	#endif
	#define SB_POISSON_TAPS 16
	const vec2 sbPoisson[ SB_POISSON_TAPS ] = vec2[](
		${POISSON_16.map(([x, y]) => `vec2( ${glslFloat(x)}, ${glslFloat(y)} )`).join(',\n\t\t')}
	);
	// the disc turned per pixel (interleaved gradient noise), so its taps band nowhere
	mat2 sbShadowRotation( vec2 fragCoord ) {
		float a = fract( 52.9829189 * fract( dot( fragCoord, vec2( 0.06711056, 0.00583715 ) ) ) ) * PI2;
		float c = cos( a ), s = sin( a );
		return mat2( c, s, - s, c );
	}
	// one tap: the four nearest texels compared and blended bilinearly (a raw-depth map is sampled nearest)
	float sbShadowBilinear( sampler2D map, vec2 size, vec2 uv, float z ) {
		vec2 st = uv * size - 0.5;
		vec2 f = fract( st );
		vec2 base = ( floor( st ) + 0.5 ) / size;
		vec2 dx = vec2( 1.0 / size.x, 0.0 ), dy = vec2( 0.0, 1.0 / size.y );
		float a = SB_SHADOW_LIT( texture2D( map, base ).r, z );
		float b = SB_SHADOW_LIT( texture2D( map, base + dx ).r, z );
		float c = SB_SHADOW_LIT( texture2D( map, base + dy ).r, z );
		float d = SB_SHADOW_LIT( texture2D( map, base + dx + dy ).r, z );
		return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
	}
	float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
		float shadow = 1.0;
		shadowCoord.xyz /= shadowCoord.w;
		#ifdef USE_REVERSED_DEPTH_BUFFER
			shadowCoord.z -= shadowBias;
		#else
			shadowCoord.z += shadowBias;
		#endif
		bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
		if ( inFrustum && shadowCoord.z <= 1.0 ) {
			vec2 radius = max( shadowRadius, 1.0 ) / shadowMapSize;
			mat2 rot = sbShadowRotation( gl_FragCoord.xy );
			float lit = 0.0;
			for ( int i = 0; i < SB_POISSON_TAPS; i ++ ) {
				lit += sbShadowBilinear( shadowMap, shadowMapSize, shadowCoord.xy + rot * sbPoisson[ i ] * radius, shadowCoord.z );
			}
			shadow = lit / float( SB_POISSON_TAPS );
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
#endif
`;

/**
 * The sun: cascade chosen and blended by view depth as three does, each cascade filtered PCSS-style. Every distance is
 * read from the cascade's own shadow matrix (its x row: atlas UV per metre; its z row: depth per metre, pointing away
 * from the sun), so the shader needs nothing three does not already upload. `shadowBias` and `shadowNormalBias` are in
 * shadow texels of each cascade (a world distance that follows the cascade's resolution), `shadowRadius` the softness.
 */
const SUN = /* glsl */ `
#if defined( SHADOWMAP_TYPE_BASIC ) && NUM_SUN_LIGHT_SHADOWS > 0 && !defined( USE_REVERSED_DEPTH_BUFFER )
	float sbSunCascadeShadow( sampler2D shadowMap, SunLightShadow sh, mat4 M, vec3 p, vec3 n, vec3 dpdx, vec3 dpdy ) {
		vec3 dzdp = vec3( M[ 0 ][ 2 ], M[ 1 ][ 2 ], M[ 2 ][ 2 ] );
		float zPerM = length( dzdp );
		float uvPerM = length( vec3( M[ 0 ][ 0 ], M[ 1 ][ 0 ], M[ 2 ][ 0 ] ) );
		vec3 toSun = - dzdp / zPerM;
		vec2 texel = 1.0 / sh.shadowMapSize;
		float texelM = texel.x / uvPerM;
		// off the surface on its sunward side, by the normal bias, so a lit face does not shadow itself
		vec3 q = p + ( dot( n, toSun ) < 0.0 ? - n : n ) * ( sh.shadowNormalBias * texelM );
		vec4 c4 = M * vec4( q, 1.0 );
		vec3 c = c4.xyz / c4.w;
		if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;
		// the receiver's depth slope across the map (receiver plane depth bias), at most a 10:1 grade
		vec3 sx = mat3( M ) * dpdx, sy = mat3( M ) * dpdy;
		float det = sx.x * sy.y - sy.x * sx.y;
		vec2 dzduv = abs( det ) > 1e-24 ? vec2( sx.z * sy.y - sy.z * sx.y, sy.z * sx.x - sx.z * sy.x ) / det : vec2( 0.0 );
		float maxGrade = 10.0 * zPerM / uvPerM;
		dzduv = clamp( dzduv, vec2( - maxGrade ), vec2( maxGrade ) );
		float zBias = sh.shadowBias * texelM * zPerM + ( abs( dzduv.x ) + abs( dzduv.y ) ) * texel.x;
		float softness = max( sh.shadowRadius, 0.0 );
		mat2 rot = sbShadowRotation( gl_FragCoord.xy );
		float minKernel = ${glslFloat(SUN_SHADOW_MIN_KERNEL_TEXELS)} * texel.x, maxKernel = ${glslFloat(SUN_SHADOW_MAX_KERNEL_TEXELS)} * texel.x;
		// 1. blockers: what lies between the receiver and the sun within the widest penumbra
		float searchUv = clamp( ${glslFloat(SUN_SHADOW_SEARCH_M)} * softness * uvPerM, minKernel, maxKernel );
		float blockerDepth = 0.0, blockers = 0.0;
		for ( int i = 0; i < SB_POISSON_TAPS; i ++ ) {
			vec2 o = rot * sbPoisson[ i ] * searchUv;
			float d = texture2D( shadowMap, c.xy + o ).r;
			if ( d < c.z + dot( dzduv, o ) - zBias ) { blockerDepth += d; blockers += 1.0; }
		}
		if ( blockers == 0.0 ) return 1.0;
		blockerDepth /= blockers;
		// 2. the penumbra the sun's disc makes over that distance: sharp at contact, softer further out
		float penumbraUv = max( c.z - blockerDepth, 0.0 ) / zPerM * ${glslFloat(SUN_TAN_ANGULAR_RADIUS)} * softness * uvPerM;
		float filterUv = clamp( penumbraUv, minKernel, maxKernel );
		float lit = 0.0;
		for ( int i = 0; i < SB_POISSON_TAPS; i ++ ) {
			vec2 o = rot * sbPoisson[ i ] * filterUv;
			lit += sbShadowBilinear( shadowMap, sh.shadowMapSize, c.xy + o, c.z + dot( dzduv, o ) - zBias );
		}
		return mix( 1.0, lit / float( SB_POISSON_TAPS ), sh.shadowIntensity );
	}
	float getSunShadow( sampler2D shadowMap, SunLightShadow sunLightShadow, int shadowIndex ) {
		vec3 p = vSunShadowWorldPosition.xyz;
		float viewDepth = vSunShadowWorldPosition.w;
		// derivatives before any branch; a mesh without normals (a flat-shaded scan) offsets along its face normal
		vec3 dpdx = dFdx( p ), dpdy = dFdy( p );
		vec3 face = cross( dpdx, dpdy );
		vec3 n = dot( vSunShadowWorldNormal, vSunShadowWorldNormal ) > 1e-8 ? normalize( vSunShadowWorldNormal )
			: ( dot( face, face ) > 0.0 ? normalize( face ) : vec3( 0.0, 1.0, 0.0 ) );
		int cascadeOffset = shadowIndex * SUN_LIGHT_CASCADES;
		float shadow = 1.0;
		// back to front, so each cascade's fade band blends into the one behind it (as three's own does)
		for ( int i = SUN_LIGHT_CASCADES - 1; i >= 0; i -- ) {
			vec4 cascade = sunShadowCascade[ cascadeOffset + i ];
			if ( viewDepth >= cascade.x && viewDepth < cascade.y ) {
				float s = sbSunCascadeShadow( shadowMap, sunLightShadow, sunShadowMatrix[ cascadeOffset + i ], p, n, dpdx, dpdy );
				shadow = mix( s, shadow, smoothstep( cascade.z, cascade.y, viewDepth ) );
			}
		}
		return shadow;
	}
#endif
`;

/**
 * The patched chunk, or null when three's chunk no longer has the places the patch goes (a three upgrade): the caller
 * reports it and the stock filters stay.
 */
export function patchShadowChunk(src: string): string | null {
    if (src.includes(MARK)) return src;
    // anchors without comments: three's build strips GLSL comments from its chunks
    const cascades = /#define SUN_LIGHT_CASCADES \d+/;
    const filters = /(#if defined\( SHADOWMAP_TYPE_PCF \)\s*float getShadow\()/;
    const sunStart = /(#if NUM_SUN_LIGHT_SHADOWS > 0)(\s*)(float getSunShadow\()/;
    const sunEnd = /(#if NUM_POINT_LIGHT_SHADOWS > 0\s*#if defined\( SHADOWMAP_TYPE_PCF \)\s*float getPointShadow\()/;
    if (![cascades, filters, sunStart, sunEnd].every(re => (src.match(new RegExp(re.source, 'g')) ?? []).length === 1)) return null;
    return src
        .replace(cascades, `#define SUN_LIGHT_CASCADES ${SUN_SHADOW_CASCADES}`)
        // under BasicShadowMap the stock filter (and below, the stock sun filter) is renamed out of the way of ours
        .replace(filters, `#if defined( SHADOWMAP_TYPE_BASIC )\n\t\t#define getShadow sbStockGetShadow\n\t#endif\n\t$1`)
        .replace(sunStart, `#undef getShadow\n${HELPERS}\n$1\n\t#if defined( SHADOWMAP_TYPE_BASIC ) && !defined( USE_REVERSED_DEPTH_BUFFER )\n\t\t#define getSunShadow sbStockGetSunShadow\n\t#endif$2$3`)
        .replace(sunEnd, `#undef getSunShadow\n${SUN}\n$1`);
}

let installed: boolean | undefined;

/**
 * Writes the filter into three's shader chunk (once; true when it is in). A three whose chunk no longer matches is
 * reported on the console and keeps its stock filters, with the sun drawn by three's two-cascade shader, which then
 * reads only the first two of SunCascadeShadow's cascades.
 */
export function installSoftShadowChunks(): boolean {
    if (installed !== undefined) return installed;
    const patched = patchShadowChunk(THREE.ShaderChunk.shadowmap_pars_fragment);
    installed = patched !== null;
    if (patched) (THREE.ShaderChunk as Record<string, string>).shadowmap_pars_fragment = patched;
    else console.error('[shadows] three.js shadowmap_pars_fragment changed: the soft sun shadow filter is not installed (stock filters draw the shadows)');
    return installed;
}
