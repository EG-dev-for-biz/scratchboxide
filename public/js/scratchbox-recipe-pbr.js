/**
 * Scratchbox Recipe PBR runtime (Three.js r128+, global build).
 *
 * Evaluates the material recipe written by scripts/apply_colosseum_recipe_pbr_suite.ts per fragment:
 * de-lighting + weathering from the original albedo, exact sharp-edge specular bevel from
 * _SBEDGEH/_SBNBRA/_SBNBRB + mask flags, vertex AO from _SBMASK, and triplanar metric detail maps
 * with Toksvig roughness.
 *
 * Usage:
 *   const ctl = ScratchboxRecipePBR.apply(gltf.scene, { glbUrl, renderer });
 *   ctl.setDebugView('bevel'); ctl.setBevelRadius(0.05);
 */
(function (global) {
  const DEBUG_VIEWS = { final: 0, bevel: 1, ao: 2, classes: 3, normals: 4 };

  const VERTEX_PARS = /* glsl */ `
attribute float sbEdgeH;
attribute vec4 sbNbrA;
attribute vec4 sbNbrB;
attribute vec4 sbMask;
varying vec3 vSbWorldPos;
varying vec3 vSbWorldNormal;
varying vec3 vSbEdge;
varying vec4 vSbNbr0;
varying vec4 vSbNbr1;
varying vec4 vSbNbr2;
varying vec4 vSbMask;

vec3 sbOctDecode(vec2 e) {
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
`;

  // Mask alpha packs the corner slot (bits 0-1) and sharp flags per edge (bits 2-4);
  // per-corner distance to edge c is h for the opposite corner, 0 otherwise, sentinel if not sharp.
  const VERTEX_MAIN = /* glsl */ `
vSbWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vSbWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
float sbFlags = floor(sbMask.a * 255.0 + 0.5);
float sbCorner = mod(sbFlags, 4.0);
float sbBits = floor(sbFlags / 4.0);
vec3 sbSharp = vec3(mod(sbBits, 2.0), mod(floor(sbBits / 2.0), 2.0), floor(sbBits / 4.0));
vec3 sbOwn = vec3(sbCorner == 0.0 ? sbEdgeH : 0.0, sbCorner == 1.0 ? sbEdgeH : 0.0, sbCorner == 2.0 ? sbEdgeH : 0.0);
vSbEdge = mix(vec3(1000.0), sbOwn, sbSharp);
vSbNbr0 = vec4(sbOctDecode(sbNbrA.xy), sbSharp.x);
vSbNbr1 = vec4(sbOctDecode(sbNbrA.zw), sbSharp.y);
vSbNbr2 = vec4(sbOctDecode(sbNbrB.xy), sbSharp.z);
vSbMask = sbMask;
`;

  const FRAGMENT_PARS = /* glsl */ `
uniform sampler2D sbStoneDetail;
uniform sampler2D sbAsphaltDetail;
uniform sampler2D sbFoliageDetail;
uniform vec3 sbTile;
uniform float sbBevelRadius;
uniform float sbBevelMinPx;
uniform float sbDetailStrength;
uniform float sbDelight;
uniform int sbDebugView;
varying vec3 vSbWorldPos;
varying vec3 vSbWorldNormal;
varying vec3 vSbEdge;
varying vec4 vSbNbr0;
varying vec4 vSbNbr1;
varying vec4 vSbNbr2;
varying vec4 vSbMask;

float sbLuma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Whiteout-blended triplanar detail normal (world space). avgLen = mip-filtered normal length for Toksvig.
vec4 sbTriplanar(sampler2D tex, vec3 p, vec3 n, float scale, float strength, out float avgLen) {
  vec3 bw = pow(abs(n), vec3(4.0));
  bw /= (bw.x + bw.y + bw.z);
  vec4 sx = texture2D(tex, p.zy * scale);
  vec4 sy = texture2D(tex, p.xz * scale);
  vec4 sz = texture2D(tex, p.xy * scale);
  vec3 tx = sx.xyz * 2.0 - 1.0;
  vec3 ty = sy.xyz * 2.0 - 1.0;
  vec3 tz = sz.xyz * 2.0 - 1.0;
  avgLen = length(tx) * bw.x + length(ty) * bw.y + length(tz) * bw.z;
  vec3 axisSign = vec3(n.x < 0.0 ? -1.0 : 1.0, n.y < 0.0 ? -1.0 : 1.0, n.z < 0.0 ? -1.0 : 1.0);
  tx.x *= axisSign.x;
  ty.x *= axisSign.y;
  tz.x *= -axisSign.z;
  tx.xy *= strength; ty.xy *= strength; tz.xy *= strength;
  tx = vec3(tx.xy + n.zy, abs(tx.z) * n.x);
  ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y);
  tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);
  vec3 nw = normalize(tx.zyx * bw.x + ty.xzy * bw.y + tz.xyz * bw.z);
  return vec4(nw, sx.w * bw.x + sy.w * bw.y + sz.w * bw.z);
}
`;

  // Runs right after <map_fragment>: diffuseColor holds the original photogrammetry albedo (linear).
  const FRAGMENT_RECIPE = /* glsl */ `
float sbFacing = gl_FrontFacing ? 1.0 : -1.0;
vec3 sbNFront = normalize(vSbWorldNormal);
vec3 sbN = sbNFront * sbFacing;

// --- Material classes from albedo + geometry (per fragment, no baked masks) ---
vec3 sbSrgb = sqrt(max(diffuseColor.rgb, vec3(0.0)));
float sbL = sbLuma(sbSrgb);
float sbExg = 2.0 * sbSrgb.g - sbSrgb.r - sbSrgb.b;
float sbVeg = smoothstep(0.02, 0.07, sbExg) * step(0.012, sbSrgb.g - sbSrgb.r) * step(0.17, sbSrgb.g);
float sbHag = vSbMask.g * 8.0;
float sbLow = 1.0 - smoothstep(0.3, 0.5, sbHag);
float sbFlatLow = step(0.75, abs(sbN.y)) * (1.0 - smoothstep(1.1, 1.3, sbHag));
float sbRoad = (1.0 - sbVeg) * max(sbLow, sbFlatLow);
float sbStone = max(0.0, 1.0 - sbVeg - sbRoad);

// --- De-lighting + weathering (same curves as the baked 1K suite, evaluated live) ---
float sbShadowT = clamp((0.34 - sbL) / 0.26, 0.0, 1.0);
float sbShadowF = sbShadowT * sbShadowT * (3.0 - 2.0 * sbShadowT);
float sbLift = 1.0 + sbShadowF * 1.65;
vec3 sbTrav = vec3(192.0, 180.0, 162.0) / 255.0;
vec3 sbTravT = sbTrav * (min(0.70, sbL * sbLift) / sbLuma(sbTrav));
vec3 sbLit = mix(sbSrgb * sbLift, sbTravT, min(1.0, sbShadowF * 0.9));
float sbSpill = max(0.0, sbLit.b - sbLit.r) * sbShadowF;
sbLit.b -= sbSpill * 0.95;
sbLit.r += sbSpill * 0.85;
float sbHighT = clamp((sbL - 0.80) / 0.18, 0.0, 1.0);
float sbComp = sbHighT * sbHighT * 0.14;
sbLit *= vec3(1.0 - sbComp, 1.0 - sbComp * 0.95, 1.0 - sbComp * 0.85);
sbLit -= clamp((-sbN.y - 0.32) / 0.55, 0.0, 1.0) * (13.0 / 255.0) * vec3(0.95, 1.0, 1.05);
sbLit += clamp((sbN.y - 0.60) / 0.35, 0.0, 1.0) * vec3(7.0, 6.0, 4.0) / 255.0;
float sbStoneW = sbStone * sbDelight;
vec3 sbAlbedo = mix(sbSrgb, clamp(sbLit, 0.0, 1.0), sbStoneW);
float sbShadowAo = 1.0 - sbShadowF * 0.28 * sbStoneW;

// --- Exact sharp-edge specular bevel ---
vec3 sbFaceN = normalize(cross(dFdx(vSbWorldPos), dFdy(vSbWorldPos)));
if (dot(sbFaceN, sbNFront) < 0.0) sbFaceN = -sbFaceN;
float sbD = min(min(vSbEdge.x, vSbEdge.y), vSbEdge.z);
vec4 sbNbr = (vSbEdge.x <= vSbEdge.y && vSbEdge.x <= vSbEdge.z) ? vSbNbr0 : ((vSbEdge.y <= vSbEdge.z) ? vSbNbr1 : vSbNbr2);
vec3 sbChamfer = normalize(sbFaceN + normalize(sbNbr.xyz)) * sbFacing;
float sbFootprint = max(sbBevelMinPx * fwidth(sbD), 1e-6);
float sbR = max(sbBevelRadius, sbFootprint);
float sbProfile = 0.5 * (1.0 + cos(3.14159265 * clamp(sbD / sbR, 0.0, 1.0)));
// Sub-pixel bevels contribute by coverage instead of turning into 1px wire lines.
float sbCoverage = clamp(sbBevelRadius / sbFootprint, 0.0, 1.0);
float sbW = sbBevelRadius > 0.0 ? sbProfile * sbCoverage * step(0.5, sbNbr.w) : 0.0;
vec3 sbNB = normalize(mix(sbN, sbChamfer, sbW));

// --- Metric triplanar detail (shared maps, mipmapped) ---
float sbLenS; float sbLenA; float sbLenF;
vec4 sbDS = sbTriplanar(sbStoneDetail, vSbWorldPos, sbNB, sbTile.x, sbDetailStrength, sbLenS);
vec4 sbDA = sbTriplanar(sbAsphaltDetail, vSbWorldPos, sbNB, sbTile.y, sbDetailStrength, sbLenA);
vec4 sbDF = sbTriplanar(sbFoliageDetail, vSbWorldPos, sbNB, sbTile.z, sbDetailStrength, sbLenF);
vec3 sbFinalN = normalize(sbDS.xyz * sbStone + sbDA.xyz * sbRoad + sbDF.xyz * sbVeg);
float sbCavity = (sbDS.w - 0.5) * 0.22 * sbStone + (sbDA.w - 0.5) * 0.30 * sbRoad + (sbDF.w - 0.5) * 0.35 * sbVeg;
sbAlbedo = clamp(sbAlbedo * (1.0 + sbCavity * sbDetailStrength), 0.0, 1.0);
diffuseColor.rgb = sbAlbedo * sbAlbedo;
`;

  const FRAGMENT_ROUGHNESS = /* glsl */ `
float sbRough = sbStone * (0.82 + (0.5 - sbDS.w) * 0.12) + sbRoad * (0.55 + (0.5 - sbDA.w) * 0.15) + sbVeg * 0.80;
sbRough = mix(sbRough, max(0.48, sbRough - 0.08), sbW);
float sbLen = clamp(sbLenS * sbStone + sbLenA * sbRoad + sbLenF * sbVeg, 0.05, 1.0);
roughnessFactor = clamp(sqrt(sbRough * sbRough + 0.4 * sbDetailStrength * (1.0 - sbLen) / sbLen), 0.04, 1.0);
`;

  const FRAGMENT_NORMAL = /* glsl */ `
normal = normalize((viewMatrix * vec4(sbFinalN, 0.0)).xyz);
`;

  const FRAGMENT_AO = /* glsl */ `
float sbAO = vSbMask.r * sbShadowAo;
reflectedLight.indirectDiffuse *= sbAO;
reflectedLight.indirectSpecular *= sbAO;
`;

  const FRAGMENT_DEBUG = /* glsl */ `
if (sbDebugView == 1) gl_FragColor = vec4(mix(vec3(0.05), vec3(1.0, 0.85, 0.3), sbW), 1.0);
else if (sbDebugView == 2) gl_FragColor = vec4(vec3(sbAO), 1.0);
else if (sbDebugView == 3) gl_FragColor = vec4(vec3(0.85, 0.62, 0.42) * sbStone + vec3(0.2, 0.7, 0.25) * sbVeg + vec3(0.3, 0.4, 0.8) * sbRoad, 1.0);
else if (sbDebugView == 4) gl_FragColor = vec4(sbFinalN * 0.5 + 0.5, 1.0);
`;

  function renameAttribute(geometry, from, to) {
    const attr = geometry.getAttribute(from);
    if (!attr) return false;
    geometry.setAttribute(to, attr);
    geometry.deleteAttribute(from);
    return true;
  }

  function loadDetail(url, renderer) {
    const tex = new THREE.TextureLoader().load(url);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    if (renderer) tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  function patchMaterial(material, uniforms) {
    material.roughness = 1.0;
    material.metalness = 0.0;
    material.extensions = Object.assign({}, material.extensions, { derivatives: true });
    material.customProgramCacheKey = () => 'scratchbox-recipe-pbr-v2';
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERTEX_PARS)
        .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERTEX_MAIN);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FRAGMENT_PARS)
        .replace('#include <map_fragment>', '#include <map_fragment>\n' + FRAGMENT_RECIPE)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + FRAGMENT_ROUGHNESS)
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAGMENT_NORMAL)
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + FRAGMENT_AO)
        .replace('#include <tonemapping_fragment>', FRAGMENT_DEBUG + '\n#include <tonemapping_fragment>');
    };
    material.needsUpdate = true;
  }

  function apply(root, options = {}) {
    const recipe = root.userData && root.userData.scratchboxRecipe;
    if (!recipe) throw new Error('GLB has no scratchboxRecipe extras; run scripts/run_colosseum_recipe_pbr_cli.ts');
    const base = new URL(options.glbUrl || '/', window.location.href);
    const maps = recipe.detailMaps;
    const uniforms = {
      sbStoneDetail: { value: loadDetail(new URL(maps.stone.uri, base).href, options.renderer) },
      sbAsphaltDetail: { value: loadDetail(new URL(maps.asphalt.uri, base).href, options.renderer) },
      sbFoliageDetail: { value: loadDetail(new URL(maps.foliage.uri, base).href, options.renderer) },
      sbTile: { value: new THREE.Vector3(1 / maps.stone.tileMeters, 1 / maps.asphalt.tileMeters, 1 / maps.foliage.tileMeters) },
      sbBevelRadius: { value: recipe.bevel.radiusMeters },
      sbBevelMinPx: { value: recipe.bevel.minPixels },
      sbDetailStrength: { value: 1.0 },
      sbDelight: { value: 1.0 },
      sbDebugView: { value: 0 }
    };

    let patched = 0;
    root.traverse(node => {
      if (!node.isMesh || !node.geometry.getAttribute('_sbedgeh')) return;
      const g = node.geometry;
      renameAttribute(g, '_sbedgeh', 'sbEdgeH');
      renameAttribute(g, '_sbnbra', 'sbNbrA');
      renameAttribute(g, '_sbnbrb', 'sbNbrB');
      renameAttribute(g, '_sbmask', 'sbMask');
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      mats.forEach(m => patchMaterial(m, uniforms));
      patched++;
    });

    return {
      recipe,
      patchedMeshes: patched,
      uniforms,
      setDebugView(view) { uniforms.sbDebugView.value = DEBUG_VIEWS[view] ?? 0; },
      setBevelRadius(meters) { uniforms.sbBevelRadius.value = meters; },
      setDetailStrength(s) { uniforms.sbDetailStrength.value = s; },
      setDelight(s) { uniforms.sbDelight.value = s; }
    };
  }

  global.ScratchboxRecipePBR = { apply, DEBUG_VIEWS };
})(window);
