/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of a carrier program: elements of the universal operators placed directly in the tile frame (x east, y up, z south),
 * built with the ornament builder's operators (scratchbox_ornament.hpp: buildSweep, buildRevolve) on a world host instead
 * of a fitted surface. Used where the program comes from a measurement rather than a StructureFit (procedural-bridges.ts:
 * a measured side elevation swept across a measured width, piers, rings, rails and posts).
 *
 *   carrier_program <spec.json> <outDir>
 *
 * spec.json: { "elements": [ element, ... ], "maxTriangles": n }
 *   sweep      { "id", "op": "sweep", "carrier": [[x,y,z], ...], "ref": [x,y,z], "profile": { "outer": [[u,v]...], "holes": [...] },
 *                "caps": bool, "scale": [[t,s]...], "twistDeg": [[t,deg]...] }
 *              The section frame at each carrier point: v is `ref` made square to the travel t, u = v x t (so u, v, t is
 *              right-handed). A carrier along the across-direction of a chord with ref = up puts u along the chord.
 *   revolve    { "id", "op": "revolve", "profile": [[r,z]...], "axis": [x,y,z], "lobes", "amplitude", "helixTurns", "segments",
 *                "startDeg", "sweepDeg", "at": [[x,y,z], ...] }   one solid per `at` point, its axis through it (default up)
 *   replicate  { "id", "op": "replicate", "carrier": [[x,y,z]...], "pitch": m, "start": m, "end": m, "seed": revolve | sweep }
 *              the seed at start + k pitch (arc length) up to `end` (default the carrier's length). A revolve seed stands at
 *              each place; a sweep seed's carrier is given in the place's local frame (along t, across u = up x t, up) and
 *              its `ref` in that frame too.
 *
 * Writes mesh.bin (per element: positions f32 x3, then indices u32) and report.json (per element: id, op, instances,
 * vertices, triangles, byte offsets; or why it was dropped). Prints {"ok":true,...} or {"ok":false,"error":...}.
 * Nothing here branches on what an element is called.
 *
 * Build:
 *   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/carrier_program.cpp -o build/3d-native/carrier_program -lz
 */

#include "scratchbox_ornament.hpp"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>

using namespace scratchbox::ornament;
namespace sg = scratchbox::scan_geom;
namespace staged_glb = scratchbox::staged_glb;

namespace {

/** The world host: chart (a, b, c) = (x, -z, y), a right-handed plane chart whose normal is up. */
struct World {
    Fit fit;
    Slot slot;
    std::unique_ptr<Host> host;
    World() {
        Surface s;
        s.id = "world"; s.origin = D3(0, 0, 0); s.u = D3(1, 0, 0); s.v = D3(0, 0, -1); s.n = D3(0, 1, 0);
        fit.surfaces["world"] = s;
        slot.id = "world"; slot.surfaceId = "world";
        fit.slots["world"] = slot;
        host = std::make_unique<Host>(fit, fit.slots["world"]);
    }
    static D3 toHost(const D3& w) { return D3(w.x, -w.z, w.y); }
    static D3 dirToHost(const D3& w) { return D3(w.x, -w.z, w.y); }
};

std::vector<D3> points(const Json& j) {
    std::vector<D3> o;
    if (isArr(j)) for (const auto& q : j.arr) o.push_back(d3(q));
    return o;
}

std::vector<Station> stations(const std::vector<D3>& c, const D3& ref) {
    if (c.size() < 2) throw OrnamentError("invalid_spec", "a sweep's carrier needs two points");
    std::vector<Station> st;
    double s = 0;
    for (size_t i = 0; i < c.size(); ++i) {
        if (i) s += (c[i] - c[i - 1]).len();
        const D3 t = (c[std::min(i + 1, c.size() - 1)] - c[i > 0 ? i - 1 : 0]).unit();
        D3 v = ref - t * ref.dot(t);
        if (v.len() < 1e-9) throw OrnamentError("invalid_spec", "a sweep's reference direction runs along its carrier");
        v = v.unit();
        const D3 u = v.cross(t).unit();
        Station x;
        x.s = s; x.c = c[i];
        x.tIn = x.tOut = t; x.uIn = x.uOut = u; x.vIn = x.vOut = v;
        st.push_back(x);
    }
    return st;
}

SweepSpec sweepSpec(const Json& j) {
    SweepSpec sp;
    sp.profile = readProfile(j["profile"]);
    sp.scale = poly(j["scale"]);
    sp.twistDeg = poly(j["twistDeg"]);
    sp.caps = !(j["caps"].type == Json::Bool && !j["caps"].b);
    return sp;
}

RevolveSpec revolveSpec(const Json& j) {
    RevolveSpec rs;
    rs.profile = poly(j["profile"]);
    const D3 axis = isArr(j["axis"]) ? d3(j["axis"]) : D3(0, 1, 0);
    rs.axisO = D3(0, 0, 0);
    rs.axisD = World::dirToHost(axis);
    rs.lobes = num(j["lobes"]); rs.amplitude = num(j["amplitude"]); rs.helixTurns = num(j["helixTurns"]);
    rs.startDeg = num(j["startDeg"]); rs.sweepDeg = num(j["sweepDeg"], 360);
    rs.segments = static_cast<int>(num(j["segments"], 24));
    return rs;
}

/** The carrier's point and unit tangent at arc length s. */
void along(const std::vector<D3>& c, double s, D3& p, D3& t) {
    double acc = 0;
    for (size_t i = 1; i < c.size(); ++i) {
        const double L = (c[i] - c[i - 1]).len();
        if (acc + L >= s || i + 1 == c.size()) {
            const double f = L > 1e-12 ? std::clamp((s - acc) / L, 0.0, 1.0) : 0.0;
            p = c[i - 1] + (c[i] - c[i - 1]) * f;
            t = (c[i] - c[i - 1]).unit();
            return;
        }
        acc += L;
    }
    p = c.front(); t = D3(1, 0, 0);
}

double length(const std::vector<D3>& c) { double L = 0; for (size_t i = 1; i < c.size(); ++i) L += (c[i] - c[i - 1]).len(); return L; }

void buildOne(const World& W, const Json& e, Gen& out, size_t& instances) {
    const std::string op = str(e["op"]);
    if (op == "sweep") {
        Gen g;
        buildSweep(stations(points(e["carrier"]), isArr(e["ref"]) ? d3(e["ref"]) : D3(0, 1, 0)), sweepSpec(e), 0, 0, g, 0);
        out.append(g); instances++;
        return;
    }
    if (op == "revolve") {
        const RevolveSpec rs = revolveSpec(e);
        for (const D3& at : points(e["at"])) { Gen g; buildRevolve(*W.host, rs, World::toHost(at), 0, g, static_cast<float>(instances)); out.append(g); instances++; }
        return;
    }
    if (op == "replicate") {
        const auto c = points(e["carrier"]);
        if (c.size() < 2) throw OrnamentError("invalid_spec", "a replicator's carrier needs two points");
        const double pitch = num(e["pitch"]);
        if (!(pitch > 0.01)) throw OrnamentError("invalid_spec", "a replicator's pitch must exceed 1 cm");
        const double L = length(c), s0 = num(e["start"]), s1 = e["end"].type == Json::Number ? std::min(L, num(e["end"])) : L;
        if ((s1 - s0) / pitch > 20000) throw OrnamentError("invalid_spec", "a replicator would place more than 20000 instances");
        const Json& seed = e["seed"];
        const std::string sop = str(seed["op"]);
        for (double s = s0; s <= s1 + 1e-9; s += pitch) {
            D3 p, t;
            along(c, s, p, t);
            Gen g;
            if (sop == "revolve") buildRevolve(*W.host, revolveSpec(seed), World::toHost(p), 0, g, static_cast<float>(instances));
            else if (sop == "sweep") {
                const D3 up(0, 1, 0);
                D3 th = t - up * t.dot(up);
                th = th.len() > 1e-9 ? th.unit() : D3(1, 0, 0);
                const D3 side = up.cross(th).unit();
                auto local = [&](const D3& q) { return p + th * q.x + side * q.y + up * q.z; };
                auto localDir = [&](const D3& q) { return th * q.x + side * q.y + up * q.z; };
                std::vector<D3> carrier;
                for (const D3& q : points(seed["carrier"])) carrier.push_back(local(q));
                buildSweep(stations(carrier, localDir(isArr(seed["ref"]) ? d3(seed["ref"]) : D3(0, 0, 1))), sweepSpec(seed), 0, 0, g, static_cast<float>(instances));
            } else throw OrnamentError("invalid_spec", "a replicator's seed must be a revolve or a sweep");
            out.append(g); instances++;
        }
        return;
    }
    throw OrnamentError("invalid_spec", "unknown operator '" + op + "'");
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) { std::cerr << "usage: carrier_program <spec.json> <outDir>\n"; return 2; }
    try {
        std::ifstream in(argv[1], std::ios::binary);
        if (!in) throw std::runtime_error(std::string("cannot read ") + argv[1]);
        std::stringstream ss; ss << in.rdbuf();
        const std::string text = ss.str();
        scratchbox::io::GlbJsonParser parser(text.data(), text.size());
        const Json doc = parser.parse();
        const size_t cap = static_cast<size_t>(num(doc["maxTriangles"], 2'000'000));
        const std::filesystem::path dir(argv[2]);
        std::filesystem::create_directories(dir);
        std::ofstream bin(dir / "mesh.bin", std::ios::binary);
        World W;
        std::string rep = "{\"schema\":\"scratchbox.carrier-program/1\",\"elements\":[";
        size_t offset = 0, built = 0, dropped = 0, total = 0;
        bool first = true;
        for (const auto& e : doc["elements"].arr) {
            const std::string id = str(e["id"]);
            Gen g;
            size_t instances = 0;
            std::string why;
            try { buildOne(W, e, g, instances); } catch (const std::exception& ex) { why = ex.what(); }
            if (why.empty()) for (const auto& p : g.pos) if (!std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(p.z)) { why = "a vertex is not finite"; break; }
            if (why.empty() && g.triangles() == 0) why = "it generated no triangles";
            if (why.empty() && total + g.triangles() > cap) why = "the program's triangle cap (" + std::to_string(cap) + ") would be passed";
            rep += first ? "" : ",";
            first = false;
            rep += "{\"id\":" + staged_glb::json::str(id) + ",\"op\":" + staged_glb::json::str(str(e["op"]));
            if (!why.empty()) { rep += ",\"dropped\":" + staged_glb::json::str(why) + "}"; dropped++; continue; }
            std::vector<float> pos; pos.reserve(g.pos.size() * 3);
            for (const auto& p : g.pos) { pos.push_back(static_cast<float>(p.x)); pos.push_back(static_cast<float>(p.y)); pos.push_back(static_cast<float>(p.z)); }
            bin.write(reinterpret_cast<const char*>(pos.data()), static_cast<std::streamsize>(pos.size() * 4));
            bin.write(reinterpret_cast<const char*>(g.idx.data()), static_cast<std::streamsize>(g.idx.size() * 4));
            rep += ",\"instances\":" + std::to_string(instances) + ",\"vertices\":" + std::to_string(g.pos.size()) + ",\"triangles\":" + std::to_string(g.triangles())
                + ",\"positionsOffset\":" + std::to_string(offset) + ",\"indicesOffset\":" + std::to_string(offset + pos.size() * 4) + "}";
            offset += pos.size() * 4 + g.idx.size() * 4;
            total += g.triangles();
            built++;
        }
        rep += "],\"built\":" + std::to_string(built) + ",\"dropped\":" + std::to_string(dropped) + ",\"triangles\":" + std::to_string(total) + "}";
        std::ofstream(dir / "report.json") << rep;
        std::cout << "{\"ok\":true,\"built\":" << built << ",\"dropped\":" << dropped << ",\"triangles\":" << total << "}\n";
        return 0;
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"error\":" << staged_glb::json::str(e.what()) << "}\n";
        return 1;
    }
}
