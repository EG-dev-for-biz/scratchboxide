/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Generic CLI for the scan rectifier kernel (scratchbox_scan_rectifier.hpp).
// Works on any GLB tile scan in a y-up metric frame; nothing here is specific to one scene.
//
// Build:
//   clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include \
//       scripts/run_scan_rectifier.cpp -o build/3d-native/run_scan_rectifier -lz
// Run:
//   build/3d-native/run_scan_rectifier --input <tile.glb> --out <stage2.rectify.bin> [options]
//
// Output: the SBRX sidecar (magic 'SBRX', uint32 version 1, uint32 V, uint32 T,
// float32[3V] positions in GlbSceneReader order, uint8[T] flags: 1 keep, 0 hidden, 2 degenerate)
// plus a JSON file of parameters and operational counters (default: <out>.json, or --stats).

#include "scratchbox_scan_rectifier.hpp"

#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

using scratchbox::scan_rectifier::ScanRectifier;
using scratchbox::scan_rectifier::ScanRectifierParams;
using scratchbox::scan_rectifier::ScanRectifierResult;

static void usage() {
    std::cerr <<
        "usage: run_scan_rectifier --input <scan.glb> --out <sidecar.bin> [options]\n"
        "  --stats <file.json>        stats path (default: <out minus .bin>.json)\n"
        "  --threads N                worker threads (default: all cores)\n"
        "  --anchor X,Z               hero anchor in the tile frame (default 0,0 = ENU origin)\n"
        "  visibility:   --rays N (192)  --rig-cams N (48)  --no-cull  --no-street-reach  --escape-distance M (3000)\n"
        "                --fixed-origins (3 interior ray origins instead of spread ones)  --origin-margin F (0.05)\n"
        "                --rig-aerial-res N (768)  --rig-street-width N (1024)\n"
        "                --no-outdoor-reach  --outdoor-top-tol M (0.3)  --outdoor-flat-tol M (0.6)\n"
        "                --two-sided-only (back faces occlude; default: a face also counts as visible to a back-face-culling viewer)\n"
        "                --site-spacing M (6; 0 = no sight-line guard)  --site-range M (200)  --sites-per-ring N (12)  --site-exhaustive-radius M (50)\n"
        "  regions:      --offset-tol M (0.3)  --family-snap-deg D (1.5)  --plumb-snap-deg D (1.5)\n"
        "                --min-wall-area M2 (15)  --min-roof-area M2 (10)  --max-rms M (0.35)\n"
        "                --normal-agree-deg D (15)  --aabb-grow M (1.0)  --max-snap-induced M (0.25)\n"
        "                --split-min-step M (0.15)  --split-min-separation F (0.75)  --no-level-split\n"
        "                --local-orient-radius M (45)  --local-orient-sigma M (15)  --family-lock-deg D (0.3)\n"
        "  snapping:     --tau-wall M (0.5)  --tau-roof M (0.4)  --tau-corner M (0.7)  --support-grow M (0.7)\n"
        "                --full-strength F (0.6)  --max-disp M (0.75)  --dead-band M (0.05)  --foreign-snap  --no-snap\n"
        "  tiers:        --tier-roof-tol M (0.4)  --tier-parapet-tol M (0.3)  --tier-min-area M2 (20)  --no-tiers\n"
        "                --tier-bandwidth M (0.06)  --tier-merge M (0.12)\n"
        "  seams:        --tjunction-tol M (0.03)  --no-tjunction  --seam-contact-tol M (0.05)  --seam-stiffness K (1000)  --seam-free-weight W (1)\n"
        "                --seam-stitch-tol M (0.015): after the guards, chunk borders that lay on another piece's face are put back on it\n"
        "                --seam-stitch-samples N (5 per boundary edge)  --no-seam-stitch\n"
        "                --footprints FILE (building footprints, one ring per line: x z x z ...; unsnapped vertices\n"
        "                outside them are ground and the stitch never moves them)  --footprint-ground-margin F (0.5)\n"
        "                --seam-face-tol M (0 = off: tie chunk borders to other pieces' faces inside the seam solve instead)\n"
        "                --seam-face-max-deg D (90: faces whose normal is within D of the border edge's face)  --seam-face-samples N (5 per edge)\n"
        "                --seam-full-contacts (tie all three axes instead of only the directions that open a gap)\n"
        "                --seam-symmetric-faces (a face contact pulls the face toward the border too, instead of the border following the face)\n"
        "                --seam-guard-through-faces (guards also hold back the faces a damaged border vertex follows)\n"
        "                --seam-interior-partners  --seam-within-piece  --no-seam-second-pass\n"
        "                --no-seam-coherence (vertices on either side of a chunk seam move independently)\n"
        "  guards:       --guard-iters N (6)  --no-guard-restore  --collapse-from M2 (1e-3)  --collapse-to M2 (1e-4)\n"
        "                --max-turn-deg D (0 = off)  --max-stretch S (2.0; 0 = off)  --crease-keep-deg D (45; 0 = off)  --crease-soften-deg D (10)\n"
        "                --crease-sharpen-deg D (-1 = off)  --crease-shrink-exempt F (0.5)  --no-seam-partner-snap\n"
        "                --crease-guard-line-snaps (also hold back corner-line snaps that soften a crease)\n"
        "  relief:       --relief-min-step M (0.05)  --relief-panel-max-width M (6)  --relief-panel-min-height M (2)  --relief-crisp-deg D (3.5)\n"
        "                --no-relief-protection (framed panels are snapped at their own level unless this is set)\n"
        "                --no-sheets  --sheet-min-relief M (0.08)  --sheet-max-angle D (4)  --sheet-flat-spread M (0.08)  --sheet-min-area M2 (3)\n"
        "                --sheet-max-width M (3)  --sheet-ring-width M (3)  --sheet-ring-all-samples  --sheet-min-main-relief M (0.1)  --sheet-min-aspect F (3)\n"
        "  facing:       --foreign-facing-dot F (-0.5)  --keep-unlevelable-roofs  --tier-local-radius M (6)  --tier-local-min-area M2 (8)\n"
        "  opposed:      --no-opposed  --opposed-zero-passes N (1)  --opposed-escalate  --opposed-max-gap M (1.5)  --opposed-keep-fraction F (0.5)  --opposed-keep-min M (0.05)  --fold-deg D (165; 0 = off)\n"
        "  slivers:      --drop-collapsed (flag collapsing bevels 2 instead of keeping a sliver)  --collapse-keep-width M (0.002)  --collapse-max-nudge M (0.02)\n"
        "  denoise:      --denoise (off by default)  --denoise-max-ny F (0.5)  --denoise-max-move M (0.15)\n"
        "  iteration:    --visibility-from <sidecar.bin> (reuse an earlier run's flags: non-zero = visible; skips D2)  --no-nadir\n"
        "  diagnostics:  --dump-regions <file.bin> (per-triangle plane region ids + plane table)\n"
        "                --dump-groups <file.bin> (per weld group: snap target, final displacement, seam/guard/snap flags)\n"
        "                --dump-sites <file.bin> (float64 xyz of every sight-line viewer eye)\n"
        "                --dump-opposed <file.bin> (float32 t, u, input gap, violated-before-guards per opposed pair)\n"
        "                --dump-contacts <file.bin> (float32[16] per seam contact: nv, ns, v0..v4, w0..w4, kind 0 vertex-on-edge/1 edge-on-face, follow, mode, input gap)\n";
}

static bool parseXZ(const std::string& s, double& x, double& z) {
    size_t c = s.find(',');
    if (c == std::string::npos) return false;
    char* end = nullptr;
    x = std::strtod(s.c_str(), &end);
    if (end != s.c_str() + c) return false;
    z = std::strtod(s.c_str() + c + 1, &end);
    return end && *end == '\0';
}

int main(int argc, char** argv) {
    ScanRectifierParams p;
    std::string input, out, stats, dumpRegions, dumpGroups, dumpSites, dumpOpposed, dumpContacts;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&](const char* name) -> std::string {
            if (i + 1 >= argc) { std::cerr << "missing value for " << name << "\n"; std::exit(2); }
            return argv[++i];
        };
        auto num = [&](const char* name) -> double {
            std::string v = next(name);
            char* end = nullptr;
            double d = std::strtod(v.c_str(), &end);
            if (!end || *end != '\0') { std::cerr << "bad number for " << name << ": " << v << "\n"; std::exit(2); }
            return d;
        };
        if (a == "--help" || a == "-h") { usage(); return 0; }
        else if (a == "--input") input = next("--input");
        else if (a == "--out") out = next("--out");
        else if (a == "--stats") stats = next("--stats");
        else if (a == "--dump-regions") dumpRegions = next("--dump-regions");
        else if (a == "--dump-groups") dumpGroups = next("--dump-groups");
        else if (a == "--dump-sites") dumpSites = next("--dump-sites");
        else if (a == "--dump-opposed") dumpOpposed = next("--dump-opposed");
        else if (a == "--dump-contacts") dumpContacts = next("--dump-contacts");
        else if (a == "--threads") p.threads = static_cast<int>(num("--threads"));
        else if (a == "--seed") p.seed = static_cast<uint64_t>(num("--seed"));
        else if (a == "--anchor") {
            if (!parseXZ(next("--anchor"), p.anchorX, p.anchorZ)) { std::cerr << "--anchor expects X,Z\n"; return 2; }
        }
        else if (a == "--rays") p.visibilityRays = static_cast<int>(num("--rays"));
        else if (a == "--rig-cams") p.rigCameras = static_cast<int>(num("--rig-cams"));
        else if (a == "--rig-aerial-res") p.rigAerialResolution = static_cast<int>(num("--rig-aerial-res"));
        else if (a == "--rig-street-width") p.rigStreetWidth = static_cast<int>(num("--rig-street-width"));
        else if (a == "--escape-distance") p.escapeDistance = num("--escape-distance");
        else if (a == "--no-cull") p.cullHidden = false;
        else if (a == "--no-street-reach") p.streetReach = false;
        else if (a == "--no-outdoor-reach") p.outdoorReach = false;
        else if (a == "--two-sided-only") p.singleSidedVisibility = false;
        else if (a == "--outdoor-top-tol") p.outdoorTopTolerance = num("--outdoor-top-tol");
        else if (a == "--outdoor-flat-tol") p.outdoorFlatTolerance = num("--outdoor-flat-tol");
        else if (a == "--site-spacing") p.outdoorSiteSpacing = num("--site-spacing");
        else if (a == "--site-range") p.outdoorSiteRange = num("--site-range");
        else if (a == "--sites-per-ring") p.outdoorSitesPerRing = static_cast<int>(num("--sites-per-ring"));
        else if (a == "--site-exhaustive-radius") p.outdoorExhaustiveRadius = num("--site-exhaustive-radius");
        else if (a == "--split-min-step") p.splitMinStep = num("--split-min-step");
        else if (a == "--split-min-separation") p.splitMinSeparation = num("--split-min-separation");
        else if (a == "--no-level-split") p.splitMaxDepth = 0;
        else if (a == "--local-orient-radius") p.localOrientationRadius = num("--local-orient-radius");
        else if (a == "--local-orient-sigma") p.localOrientationSigma = num("--local-orient-sigma");
        else if (a == "--family-lock-deg") p.familyLockDeg = num("--family-lock-deg");
        else if (a == "--tier-bandwidth") p.tierModeBandwidth = num("--tier-bandwidth");
        else if (a == "--tier-merge") p.tierModeMerge = num("--tier-merge");
        else if (a == "--seam-contact-tol") p.seamContactTolerance = num("--seam-contact-tol");
        else if (a == "--seam-stiffness") p.seamStiffness = num("--seam-stiffness");
        else if (a == "--seam-follow-eps") p.seamFollowEpsilon = num("--seam-follow-eps");
        else if (a == "--seam-solver-iters") p.seamSolverIterations = static_cast<int>(num("--seam-solver-iters"));
        else if (a == "--no-seam-coherence") p.seamCoherence = false;
        else if (a == "--seam-free-weight") p.seamFreeWeight = num("--seam-free-weight");
        else if (a == "--seam-face-tol") p.seamFaceTolerance = num("--seam-face-tol");
        else if (a == "--seam-interior-partners") p.seamInteriorPartners = true;
        else if (a == "--seam-face-max-deg") p.seamFaceMaxAngleDeg = num("--seam-face-max-deg");
        else if (a == "--seam-face-samples") p.seamFaceSamples = static_cast<int>(num("--seam-face-samples"));
        else if (a == "--seam-stitch-tol") p.seamStitchTolerance = num("--seam-stitch-tol");
        else if (a == "--seam-stitch-samples") p.seamStitchSamples = static_cast<int>(num("--seam-stitch-samples"));
        else if (a == "--no-seam-stitch") p.seamStitchTolerance = 0;
        else if (a == "--footprints") {
            // One closed building footprint per line: x z x z ... in the mesh frame (e.g. Google Vector Tiles)
            const std::string file = next("--footprints");
            std::ifstream f(file);
            if (!f) { std::cerr << "cannot read footprints file " << file << "\n"; return 2; }
            std::string line;
            while (std::getline(f, line)) {
                std::vector<double> v;
                const char* c = line.c_str();
                char* end = nullptr;
                for (double d = std::strtod(c, &end); end != c; d = std::strtod(c, &end)) { v.push_back(d); c = end; }
                if (v.size() < 6 || v.size() % 2) continue;
                std::vector<std::pair<double, double>> ring;
                for (size_t k = 0; k + 1 < v.size(); k += 2) ring.emplace_back(v[k], v[k + 1]);
                p.buildingFootprintsXZ.push_back(std::move(ring));
            }
        }
        else if (a == "--footprint-ground-margin") p.footprintGroundMargin = num("--footprint-ground-margin");
        else if (a == "--seam-stitch-snapped-weight") p.seamStitchSnappedWeight = num("--seam-stitch-snapped-weight");
        else if (a == "--seam-full-contacts") p.seamProjectedContacts = false;
        else if (a == "--seam-symmetric-faces") p.seamFollowFaces = false;
        else if (a == "--seam-guard-through-faces") p.seamGuardThroughFaces = true;
        else if (a == "--seam-within-piece") p.seamWithinPiece = true;
        else if (a == "--no-seam-second-pass") p.seamSecondPass = false;
        else if (a == "--max-turn-deg") p.guardMaxTurnDeg = num("--max-turn-deg");
        else if (a == "--max-stretch") p.guardMaxStretch = num("--max-stretch");
        else if (a == "--crease-keep-deg") p.creaseKeepDeg = num("--crease-keep-deg");
        else if (a == "--crease-soften-deg") p.creaseMaxSoftenDeg = num("--crease-soften-deg");
        else if (a == "--crease-sharpen-deg") p.creaseMaxSharpenDeg = num("--crease-sharpen-deg");
        else if (a == "--crease-shrink-exempt") p.creaseShrinkExempt = num("--crease-shrink-exempt");
        else if (a == "--crease-guard-line-snaps") p.creaseExemptLineSnaps = false;
        else if (a == "--no-seam-partner-snap") p.seamPartnerSnap = false;
        else if (a == "--fixed-origins") p.visibilitySpreadOrigins = false;
        else if (a == "--origin-margin") p.visibilityOriginMargin = num("--origin-margin");
        else if (a == "--offset-tol") p.offsetTolerance = num("--offset-tol");
        else if (a == "--family-snap-deg") p.familySnapDeg = num("--family-snap-deg");
        else if (a == "--plumb-snap-deg") p.plumbSnapDeg = num("--plumb-snap-deg");
        else if (a == "--min-wall-area") p.minWallArea = num("--min-wall-area");
        else if (a == "--min-roof-area") p.minRoofArea = num("--min-roof-area");
        else if (a == "--max-rms") p.maxRegionRms = num("--max-rms");
        else if (a == "--normal-agree-deg") p.normalAgreementDeg = num("--normal-agree-deg");
        else if (a == "--aabb-grow") p.regionAabbGrow = num("--aabb-grow");
        else if (a == "--max-snap-induced") p.maxSnapInducedDisplacement = num("--max-snap-induced");
        else if (a == "--tau-wall") p.tauWall = num("--tau-wall");
        else if (a == "--tau-roof") p.tauRoof = num("--tau-roof");
        else if (a == "--tau-corner") p.tauCorner = num("--tau-corner");
        else if (a == "--support-grow") p.supportGrow = num("--support-grow");
        else if (a == "--full-strength") p.fullStrengthFraction = num("--full-strength");
        else if (a == "--max-disp") p.maxDisplacement = num("--max-disp");
        else if (a == "--dead-band") p.snapDeadBand = num("--dead-band");
        else if (a == "--foreign-snap") p.foreignPlaneSnap = true;
        else if (a == "--no-snap") p.snap = false;
        else if (a == "--tier-roof-tol") p.tierRoofTolerance = num("--tier-roof-tol");
        else if (a == "--tier-parapet-tol") p.tierParapetTolerance = num("--tier-parapet-tol");
        else if (a == "--tier-min-area") p.tierMinPeakArea = num("--tier-min-area");
        else if (a == "--no-tiers") p.alignTiers = false;
        else if (a == "--tjunction-tol") p.tJunctionTolerance = num("--tjunction-tol");
        else if (a == "--no-tjunction") p.closeTJunctions = false;
        else if (a == "--guard-iters") p.guardIterations = static_cast<int>(num("--guard-iters"));
        else if (a == "--no-guard-restore") p.guardRestore = false;
        else if (a == "--guard-restore-rounds") p.guardRestoreRounds = static_cast<int>(num("--guard-restore-rounds"));
        else if (a == "--collapse-from") p.collapseFromArea = num("--collapse-from");
        else if (a == "--collapse-to") p.collapseToArea = num("--collapse-to");
        else if (a == "--no-sheets") p.extractSheets = false;
        else if (a == "--relief-min-step") p.reliefMinStep = num("--relief-min-step");
        else if (a == "--relief-panel-max-width") p.reliefPanelMaxWidth = num("--relief-panel-max-width");
        else if (a == "--relief-panel-min-height") p.reliefPanelMinHeight = num("--relief-panel-min-height");
        else if (a == "--relief-crisp-deg") p.reliefCrispDeg = num("--relief-crisp-deg");
        else if (a == "--no-relief-protection") p.reliefMinStep = 0;
        else if (a == "--sheet-min-relief") p.sheetMinRelief = num("--sheet-min-relief");
        else if (a == "--sheet-max-angle") p.sheetMaxAngleDeg = num("--sheet-max-angle");
        else if (a == "--sheet-flat-spread") p.sheetFlatSpread = num("--sheet-flat-spread");
        else if (a == "--sheet-min-area") p.sheetMinArea = num("--sheet-min-area");
        else if (a == "--sheet-max-width") p.sheetMaxWidth = num("--sheet-max-width");
        else if (a == "--sheet-ring-width") p.sheetRingWidth = num("--sheet-ring-width");
        else if (a == "--sheet-ring-front-most") p.sheetRingFrontMost = true;
        else if (a == "--sheet-ring-all-samples") p.sheetRingFrontMost = false;
        else if (a == "--sheet-min-main-relief") p.sheetMinMainRelief = num("--sheet-min-main-relief");
        else if (a == "--sheet-min-aspect") p.sheetMinAspect = num("--sheet-min-aspect");
        else if (a == "--foreign-facing-dot") p.foreignMinFacingDot = num("--foreign-facing-dot");
        else if (a == "--keep-unlevelable-roofs") p.rejectUnlevelableRoofs = false;
        else if (a == "--tier-local-radius") p.tierLocalRadius = num("--tier-local-radius");
        else if (a == "--tier-local-min-area") p.tierLocalMinArea = num("--tier-local-min-area");
        else if (a == "--no-opposed") p.guardOpposed = false;
        else if (a == "--opposed-max-gap") p.opposedMaxGap = num("--opposed-max-gap");
        else if (a == "--opposed-escalate") p.opposedEscalate = true;
        else if (a == "--opposed-zero-passes") p.opposedZeroPasses = static_cast<int>(num("--opposed-zero-passes"));
        else if (a == "--opposed-keep-fraction") p.opposedKeepFraction = num("--opposed-keep-fraction");
        else if (a == "--opposed-keep-min") p.opposedKeepMin = num("--opposed-keep-min");
        else if (a == "--fold-deg") p.guardFoldDeg = num("--fold-deg");
        else if (a == "--drop-collapsed") p.keepCollapsedSlivers = false;
        else if (a == "--collapse-keep-width") p.collapseKeepWidth = num("--collapse-keep-width");
        else if (a == "--collapse-max-nudge") p.collapseMaxNudge = num("--collapse-max-nudge");
        else if (a == "--no-nadir") p.nadirGuard = false;
        else if (a == "--visibility-from") {
            const std::string vf = next("--visibility-from");
            std::ifstream f(vf, std::ios::binary);
            std::vector<char> b((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
            uint32_t ver = 0, V = 0, T = 0;
            if (b.size() < 16 || std::string(b.data(), 4) != "SBRX") { std::cerr << "--visibility-from: not an SBRX sidecar: " << vf << "\n"; return 2; }
            std::memcpy(&ver, b.data() + 4, 4); std::memcpy(&V, b.data() + 8, 4); std::memcpy(&T, b.data() + 12, 4);
            const size_t off = 16 + static_cast<size_t>(V) * 12;
            if (b.size() < off + T) { std::cerr << "--visibility-from: truncated sidecar\n"; return 2; }
            p.precomputedVisibility.assign(reinterpret_cast<const uint8_t*>(b.data()) + off, reinterpret_cast<const uint8_t*>(b.data()) + off + T);
        }
        else if (a == "--denoise") p.denoise = true;
        else if (a == "--no-denoise") p.denoise = false;
        else if (a == "--denoise-max-ny") p.denoiseMaxAbsNy = num("--denoise-max-ny");
        else if (a == "--denoise-max-move") p.denoiseMaxMove = num("--denoise-max-move");
        else { std::cerr << "unknown argument: " << a << "\n"; usage(); return 2; }
    }
    if (input.empty() || out.empty()) { usage(); return 2; }
    if (stats.empty()) {
        stats = out;
        if (stats.size() > 4 && stats.compare(stats.size() - 4, 4, ".bin") == 0) stats.resize(stats.size() - 4);
        stats += ".json";
    }

    auto t0 = std::chrono::steady_clock::now();
    ScanRectifierResult r = ScanRectifier::rectifyFile(input, p);
    if (!r.ok) { std::cerr << "rectify failed: " << r.error << "\n"; return 1; }
    std::string err;
    if (!ScanRectifier::writeSidecar(out, r, &err)) { std::cerr << err << "\n"; return 1; }
    {
        std::ofstream f(stats, std::ios::trunc);
        if (!f) { std::cerr << "cannot write " << stats << "\n"; return 1; }
        f << ScanRectifier::statsJson(r, p, input);
    }
    if (!dumpRegions.empty()) {
        // diagnostics: int32 T, int32[T] region ids, int32 R, float64[R][16] (cls, n, d, area, rms, level, tau, t1, lo1, hi1, lo2, hi2)
        std::ofstream f(dumpRegions, std::ios::binary | std::ios::trunc);
        int32_t T = static_cast<int32_t>(r.triangleRegion.size()), R = static_cast<int32_t>(r.regionPlanes.size());
        f.write(reinterpret_cast<const char*>(&T), 4);
        f.write(reinterpret_cast<const char*>(r.triangleRegion.data()), static_cast<std::streamsize>(T) * 4);
        f.write(reinterpret_cast<const char*>(&R), 4);
        for (const auto& row : r.regionPlanes) f.write(reinterpret_cast<const char*>(row.data()), 16 * sizeof(double));
    }
    if (!dumpGroups.empty()) {
        // diagnostics: uint32 V, uint32 G, uint32[V] group of vertex, float32[3G] snap target, float32[3G] final delta, uint8[G] info,
        // uint8[G] guard reasons (bit0 budget, 1 flip, 2 shrink, 3 stretch, 4 crease, 5 seam neighbour, 6 turn, 7 opposed sheets / fold)
        std::ofstream f(dumpGroups, std::ios::binary | std::ios::trunc);
        uint32_t V = static_cast<uint32_t>(r.groupOfVertex.size()), G = static_cast<uint32_t>(r.groupInfo.size());
        f.write(reinterpret_cast<const char*>(&V), 4);
        f.write(reinterpret_cast<const char*>(&G), 4);
        f.write(reinterpret_cast<const char*>(r.groupOfVertex.data()), static_cast<std::streamsize>(V) * 4);
        f.write(reinterpret_cast<const char*>(r.groupSnapTarget.data()), static_cast<std::streamsize>(G) * 12);
        f.write(reinterpret_cast<const char*>(r.groupDelta.data()), static_cast<std::streamsize>(G) * 12);
        f.write(reinterpret_cast<const char*>(r.groupInfo.data()), static_cast<std::streamsize>(G));
        f.write(reinterpret_cast<const char*>(r.groupGuardReasons.data()), static_cast<std::streamsize>(G));
    }
    if (!dumpSites.empty()) {
        // diagnostics: float64[N][3] sight-line viewer eyes
        std::ofstream f(dumpSites, std::ios::binary | std::ios::trunc);
        for (const auto& e : r.outdoorSites) f.write(reinterpret_cast<const char*>(e.data()), 24);
    }
    if (!dumpOpposed.empty()) {
        // diagnostics: float32[N][4] (t, u, input gap, violated by the unguarded solve)
        std::ofstream f(dumpOpposed, std::ios::binary | std::ios::trunc);
        for (const auto& q : r.opposedPairs) f.write(reinterpret_cast<const char*>(q.data()), 16);
    }
    if (!dumpContacts.empty()) {
        std::ofstream f(dumpContacts, std::ios::binary | std::ios::trunc);
        for (const auto& c : r.seamContacts) f.write(reinterpret_cast<const char*>(c.data()), 64);
    }
    double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    const auto& s = r.stats;
    std::cout << "run_scan_rectifier: V=" << s.vertexCount << " T=" << s.triangleCount << " weldGroups=" << s.weldGroups << "\n";
    std::cout << "  hidden=" << s.hiddenTriangles << " (escape-visible " << s.escapeVisible << " + single-sided " << s.singleSidedEscape
              << ", street-reach-rescued " << s.streetReachRescued << " + single-sided " << s.singleSidedReach
              << ", outdoor-reach-rescued " << s.outdoorReachRescued << ", rig-rescued " << s.rigRescued << ", nadir-rescued " << s.nadirRescued
              << (s.visibilityPrecomputed ? ", PRECOMPUTED" : "")
              << ", rig " << s.rigAerialCameras << " aerial + " << s.rigStreetCameras << " street, sight-line-rescued " << s.sightLineRescued
              << " from " << s.outdoorSites << " sites)\n";
    std::cout << "  families:";
    for (const auto& f : s.families) std::cout << " " << f.azimuthDeg << "deg(" << static_cast<long>(f.weight) << "m2)";
    std::cout << "\n  regions: walls=" << s.wallRegions << " roofs=" << s.roofRegions << " rejectedRms=" << s.rejectedRms
              << " familySnapped=" << s.familySnapped << " (local " << s.localOrientationSnapped << ", family-locked " << s.familyLocked << ")"
              << " plumb=" << s.plumbSnapped << " level=" << s.levelSnapped << " levelSplits=" << s.levelSplits
              << " reliefSheets=" << s.sheets << " (" << static_cast<long>(s.sheetArea) << " m2) unlevelableRoofs=" << s.rejectedUnlevelable
              << " offFamilyKept=" << s.orientationOffFamily << " reliefPanels=" << s.reliefPanelFaces << " (" << static_cast<long>(s.reliefPanelArea) << " m2, " << s.reliefProtectedVertices << " vertices)\n";
    std::cout << "  tiers: aligned roofs " << s.tierAlignedRoofs << ", rejected unsupported " << s.tierRejectedUnsupported << ", parapet groups " << s.parapetGroups
              << " | foreign planes facing away skipped " << s.foreignRejectedFacing << "\n";
    std::cout << "  snapped groups: plane=" << s.snappedGroups1 << " line=" << s.snappedGroups2 << " point=" << s.snappedGroups3
              << " | guard halvings=" << s.guardHalvings << " reverted=" << s.guardReverted
              << " (first pass: flip " << s.guardFlip << ", shrink " << s.guardShrink << ", turn " << s.guardTurn << ", stretch " << s.guardStretch
              << ", crease " << s.guardCrease << " of " << s.protectedCreases << " protected, fold " << s.guardFold
              << ", opposed " << s.guardOpposed << " of " << s.opposedPairs << " pairs, relieved " << s.opposedRelieved << ", left " << s.opposedResidual << ") restored " << s.guardRestored << " (seam " << s.guardSeamRestored << ", " << s.guardSeamRestoreFixes << " fix solves)"
              << " collapsing " << s.collapseCandidates << " (kept as slivers " << s.collapseKeptAsSlivers << ", flag2 " << s.collapsedTriangles << ")\n";
    std::cout << "  seams: contacts=" << s.seamContacts << " (on faces " << s.seamFaceContacts << ", closed " << s.tJunctionsClosed << ", dropped " << s.guardClosureDropped << ", followers " << s.seamFollowers << ") stitch: " << s.stitchSamples << " samples, " << s.stitchedGroups << " groups moved, " << s.stitchHeld << " held | components=" << s.seamComponents
              << " largest=" << s.seamLargestComponent << " solves=" << s.seamSolves << " (PCG iterations " << s.seamSolverIterationsUsed << ", max " << s.seamSolverIterationsMax << ")" << " maxResidual=" << s.seamMaxResidual << " m\n";
    std::cout << "  wrote " << out << " and " << stats << " in " << ms << " ms\n";
    return 0;
}
