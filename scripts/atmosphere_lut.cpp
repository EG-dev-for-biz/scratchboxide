/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * atmosphere_lut: the precomputed atmospheric scattering tables (scratchbox_atmosphere_lut.hpp) as a small CLI driver.
 * Reads an atmosphere (a text file of `key value...` lines, written by AtmosphereLutService,
 * packages/core/src/node/3d-engine/atmosphere-lut-service.ts), precomputes its tables, or loads tables already written
 * (ours, or any in the same layout), and evaluates sky radiance and irradiance from them for a list of queries.
 *
 * Outputs in --out: transmittance.bin, scattering.bin, single_mie_scattering.bin, higher_order_scattering.bin,
 * irradiance.bin (RGBA texels, float32 or binary16) and atmosphere.json (the medium, the layout, the timings).
 *
 * usage: atmosphere_lut --params <atmosphere.txt> [--out <dir>] [--load <dir>] [--load-format float32|float16]
 *                       [--format float32|float16] [--queries <queries.txt> --results <results.json>]
 *
 * Params keys: wavelengths, solar_irradiance, rayleigh_scattering, mie_scattering, mie_extinction, absorption_extinction,
 * ground_albedo (one value per wavelength); sun_angular_radius, bottom_radius, top_radius, mie_phase_function_g, mu_s_min,
 * scattering_orders, threads (one value); rayleigh_density, mie_density, absorption_density (two layers of width, exp_term,
 * exp_scale, linear_term, constant_term); transmittance_lambdas (three); batch (three wavelengths, then the 3 x 3
 * row-major matrix to the output channels; one line per batch).
 *
 * Query lines: altitude_m view_x view_y view_z sun_x sun_y sun_z (z up at the camera). Each result: sky radiance,
 * transmittance to the top of the atmosphere, direct sun and sky irradiance on a level surface at the camera.
 */

#include "scratchbox_atmosphere_lut.hpp"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

using namespace scratchbox::atmosphere_lut;

namespace {

[[noreturn]] void fail(const std::string& message) {
    std::fprintf(stderr, "atmosphere_lut: %s\n", message.c_str());
    std::exit(1);
}

std::map<std::string, std::vector<std::vector<double>>> readKeyValues(const std::string& file) {
    std::ifstream in(file);
    if (!in) fail("cannot read " + file);
    std::map<std::string, std::vector<std::vector<double>>> out;
    std::string line;
    while (std::getline(in, line)) {
        if (line.empty() || line[0] == '#') continue;
        std::istringstream words(line);
        std::string key;
        words >> key;
        std::vector<double> values;
        double v;
        while (words >> v) values.push_back(v);
        if (!words.eof()) fail("bad number on line: " + line);
        out[key].push_back(values);
    }
    return out;
}

const std::vector<double>& one(const std::map<std::string, std::vector<std::vector<double>>>& kv, const std::string& key, size_t count = 0) {
    auto it = kv.find(key);
    if (it == kv.end()) fail("params lack " + key);
    const auto& v = it->second.back();
    if (count && v.size() != count) fail(key + " needs " + std::to_string(count) + " values");
    return v;
}

DensityProfile profile(const std::vector<double>& v) {
    DensityProfile p;
    for (int l = 0; l < 2; ++l) p.layers[l] = {v[5 * l], v[5 * l + 1], v[5 * l + 2], v[5 * l + 3], v[5 * l + 4]};
    return p;
}

void writeFile(const std::string& path, const std::vector<uint8_t>& bytes) {
    std::ofstream out(path, std::ios::binary);
    if (!out) fail("cannot write " + path);
    out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
}

std::vector<float> readRgba(const std::string& path, size_t texels, bool half) {
    std::ifstream in(path, std::ios::binary);
    if (!in) fail("cannot read " + path);
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    size_t want = texels * 4 * (half ? 2 : 4);
    if (bytes.size() != want) fail(path + " holds " + std::to_string(bytes.size()) + " bytes, not " + std::to_string(want));
    std::vector<float> out(texels * 4);
    for (size_t i = 0; i < texels * 4; ++i) {
        if (half) {
            uint16_t h;
            std::memcpy(&h, &bytes[i * 2], 2);
            out[i] = halfToFloat(h);
        } else {
            std::memcpy(&out[i], &bytes[i * 4], 4);
        }
    }
    return out;
}

template <typename Tex>
void fillRgb(Tex& tex, const std::vector<float>& rgba) {
    for (size_t i = 0; i < tex.data.size(); ++i) tex.data[i] = Spec(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]);
}

std::string jsonArray(const std::vector<double>& v) {
    std::ostringstream s;
    s.precision(10);
    s << '[';
    for (size_t i = 0; i < v.size(); ++i) s << (i ? "," : "") << v[i];
    s << ']';
    return s.str();
}
std::string jsonSpec(const Spec& c) { return jsonArray({c[0], c[1], c[2]}); }
std::string jsonProfile(const DensityProfile& p) {
    std::ostringstream s;
    s << '[';
    for (int l = 0; l < 2; ++l) {
        const auto& L = p.layers[l];
        s << (l ? "," : "") << "{\"width\":" << L.width << ",\"expTerm\":" << L.exp_term << ",\"expScale\":" << L.exp_scale << ",\"linearTerm\":" << L.linear_term
          << ",\"constantTerm\":" << L.constant_term << '}';
    }
    s << ']';
    return s.str();
}

} // namespace

int main(int argc, char** argv) {
    std::string paramsFile, outDir, loadDir, queriesFile, resultsFile;
    bool half = false, loadHalf = true;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> std::string { if (i + 1 >= argc) fail("missing value after " + a); return argv[++i]; };
        if (a == "--params") paramsFile = next();
        else if (a == "--out") outDir = next();
        else if (a == "--load") loadDir = next();
        else if (a == "--load-format") { std::string f = next(); if (f != "float16" && f != "float32") fail("--load-format is float32 or float16"); loadHalf = f == "float16"; }
        else if (a == "--format") { std::string f = next(); if (f != "float16" && f != "float32") fail("--format is float32 or float16"); half = f == "float16"; }
        else if (a == "--queries") queriesFile = next();
        else if (a == "--results") resultsFile = next();
        else fail("unknown argument " + a);
    }
    if (paramsFile.empty()) fail("usage: atmosphere_lut --params <atmosphere.txt> [--out <dir>] [--load <dir>] [--format float32|float16] [--queries <q> --results <r>]");
    if (outDir.empty() == loadDir.empty()) fail("give exactly one of --out (precompute) and --load (read tables)");
    if (queriesFile.empty() != resultsFile.empty()) fail("--queries and --results go together");

    const auto kv = readKeyValues(paramsFile);
    SpectralAtmosphere atm;
    atm.wavelengths = one(kv, "wavelengths");
    const size_t n = atm.wavelengths.size();
    atm.solar_irradiance = one(kv, "solar_irradiance", n);
    atm.rayleigh_scattering = one(kv, "rayleigh_scattering", n);
    atm.mie_scattering = one(kv, "mie_scattering", n);
    atm.mie_extinction = one(kv, "mie_extinction", n);
    atm.absorption_extinction = one(kv, "absorption_extinction", n);
    atm.ground_albedo = one(kv, "ground_albedo", n);
    atm.sun_angular_radius = one(kv, "sun_angular_radius", 1)[0];
    atm.bottom_radius = one(kv, "bottom_radius", 1)[0];
    atm.top_radius = one(kv, "top_radius", 1)[0];
    atm.mie_phase_function_g = one(kv, "mie_phase_function_g", 1)[0];
    atm.mu_s_min = one(kv, "mu_s_min", 1)[0];
    atm.rayleigh_density = profile(one(kv, "rayleigh_density", 10));
    atm.mie_density = profile(one(kv, "mie_density", 10));
    atm.absorption_density = profile(one(kv, "absorption_density", 10));

    PrecomputeOptions opts;
    const auto& tl = one(kv, "transmittance_lambdas", 3);
    for (int c = 0; c < 3; ++c) opts.transmittance_lambdas[c] = tl[c];
    opts.scattering_orders = static_cast<int>(one(kv, "scattering_orders", 1)[0]);
    if (kv.count("threads")) opts.threads = static_cast<int>(one(kv, "threads", 1)[0]);
    auto batches = kv.find("batch");
    if (batches == kv.end()) fail("params lack batch");
    for (const auto& b : batches->second) {
        if (b.size() != 12) fail("batch needs 12 values (3 wavelengths, then a 3 x 3 matrix)");
        WavelengthBatch wb;
        for (int c = 0; c < 3; ++c) wb.lambdas[c] = b[c];
        for (int k = 0; k < 9; ++k) wb.to_output.m[k] = b[3 + k];
        opts.batches.push_back(wb);
    }

    PrecomputedTables tables;
    PrecomputeTimings timings;
    AtmosphereParameters out;
    try {
        Model model(atm, opts);
        out = model.outputParameters();
        if (!outDir.empty()) {
            model.precompute();
            tables = model.tables();
            timings = model.timings();
        }
    } catch (const std::exception& e) {
        fail(e.what());
    }

    if (!outDir.empty()) {
        const auto& T = tables;
        writeFile(outDir + "/transmittance.bin", encodeRgba(T.transmittance.data.size(), half, [&](size_t i) { return T.transmittance.data[i]; }, [](size_t) { return 1.0; }));
        writeFile(outDir + "/scattering.bin", encodeRgba(T.scattering.data.size(), half, [&](size_t i) { return T.scattering.data[i].rgb(); }, [&](size_t i) { return T.scattering.data[i].v[3]; }));
        writeFile(outDir + "/single_mie_scattering.bin", encodeRgba(T.single_mie_scattering.data.size(), half, [&](size_t i) { return T.single_mie_scattering.data[i]; }, [](size_t) { return 1.0; }));
        writeFile(outDir + "/higher_order_scattering.bin", encodeRgba(T.higher_order_scattering.data.size(), half, [&](size_t i) { return T.higher_order_scattering.data[i]; }, [](size_t) { return 0.0; }));
        writeFile(outDir + "/irradiance.bin", encodeRgba(T.irradiance.data.size(), half, [&](size_t i) { return T.irradiance.data[i]; }, [](size_t) { return 1.0; }));

        std::ostringstream j;
        j.precision(10);
        j << "{\n  \"ok\": true,\n  \"format\": \"" << (half ? "float16" : "float32") << "\",\n  \"channels\": \"rgba\",\n"
          << "  \"lengthUnit\": \"m\",\n"
          << "  \"layout\": {\"transmittance\": [" << TRANSMITTANCE_TEXTURE_WIDTH << "," << TRANSMITTANCE_TEXTURE_HEIGHT << "], \"scattering\": [" << SCATTERING_TEXTURE_WIDTH << ","
          << SCATTERING_TEXTURE_HEIGHT << "," << SCATTERING_TEXTURE_DEPTH << "], \"scatteringNuMuSMuR\": [" << SCATTERING_TEXTURE_NU_SIZE << "," << SCATTERING_TEXTURE_MU_S_SIZE << ","
          << SCATTERING_TEXTURE_MU_SIZE << "," << SCATTERING_TEXTURE_R_SIZE << "], \"irradiance\": [" << IRRADIANCE_TEXTURE_WIDTH << "," << IRRADIANCE_TEXTURE_HEIGHT << "]},\n"
          << "  \"atmosphere\": {\"wavelengths\": " << jsonArray(atm.wavelengths) << ", \"solarIrradiance\": " << jsonArray(atm.solar_irradiance)
          << ", \"rayleighScattering\": " << jsonArray(atm.rayleigh_scattering) << ", \"mieScattering\": " << jsonArray(atm.mie_scattering)
          << ", \"mieExtinction\": " << jsonArray(atm.mie_extinction) << ", \"absorptionExtinction\": " << jsonArray(atm.absorption_extinction)
          << ", \"groundAlbedo\": " << jsonArray(atm.ground_albedo) << ", \"sunAngularRadius\": " << atm.sun_angular_radius << ", \"bottomRadius\": " << atm.bottom_radius
          << ", \"topRadius\": " << atm.top_radius << ", \"miePhaseFunctionG\": " << atm.mie_phase_function_g << ", \"muSMin\": " << atm.mu_s_min
          << ", \"rayleighDensity\": " << jsonProfile(atm.rayleigh_density) << ", \"mieDensity\": " << jsonProfile(atm.mie_density)
          << ", \"absorptionDensity\": " << jsonProfile(atm.absorption_density) << "},\n"
          << "  \"output\": {\"transmittanceLambdas\": " << jsonArray({tl[0], tl[1], tl[2]}) << ", \"solarIrradiance\": " << jsonSpec(out.solar_irradiance)
          << ", \"rayleighScattering\": " << jsonSpec(out.rayleigh_scattering) << ", \"mieScattering\": " << jsonSpec(out.mie_scattering) << "},\n"
          << "  \"batches\": " << opts.batches.size() << ",\n  \"scatteringOrders\": " << opts.scattering_orders << ",\n"
          << "  \"threads\": " << (opts.threads > 0 ? opts.threads : static_cast<int>(std::thread::hardware_concurrency())) << ",\n"
          << "  \"ms\": {\"transmittance\": " << timings.transmittance_ms << ", \"directIrradiance\": " << timings.direct_irradiance_ms << ", \"singleScattering\": "
          << timings.single_scattering_ms << ", \"scatteringDensity\": " << timings.scattering_density_ms << ", \"indirectIrradiance\": " << timings.indirect_irradiance_ms
          << ", \"multipleScattering\": " << timings.multiple_scattering_ms << ", \"total\": " << timings.total_ms << "}\n}\n";
        std::string text = j.str();
        writeFile(outDir + "/atmosphere.json", std::vector<uint8_t>(text.begin(), text.end()));
    } else {
        auto load = [&](const std::string& name, size_t texels) { return readRgba(loadDir + "/" + name, texels, loadHalf); };
        tables.transmittance = makeTransmittanceTexture();
        tables.irradiance = makeIrradianceTexture();
        tables.single_mie_scattering = makeScatteringTexture();
        tables.scattering = Texture3D<Spec4>(SCATTERING_TEXTURE_WIDTH, SCATTERING_TEXTURE_HEIGHT, SCATTERING_TEXTURE_DEPTH);
        fillRgb(tables.transmittance, load("transmittance.bin", tables.transmittance.data.size()));
        fillRgb(tables.irradiance, load("irradiance.bin", tables.irradiance.data.size()));
        fillRgb(tables.single_mie_scattering, load("single_mie_scattering.bin", tables.single_mie_scattering.data.size()));
        auto s = load("scattering.bin", tables.scattering.data.size());
        for (size_t i = 0; i < tables.scattering.data.size(); ++i) tables.scattering.data[i] = Spec4(Spec(s[4 * i], s[4 * i + 1], s[4 * i + 2]), s[4 * i + 3]);
    }

    if (!queriesFile.empty()) {
        std::ifstream in(queriesFile);
        if (!in) fail("cannot read " + queriesFile);
        std::ostringstream j;
        j.precision(10);
        j << "{\"ok\":true,\"results\":[";
        std::string line;
        bool first = true;
        while (std::getline(in, line)) {
            if (line.empty() || line[0] == '#') continue;
            std::istringstream w(line);
            double alt, vx, vy, vz, sx, sy, sz;
            if (!(w >> alt >> vx >> vy >> vz >> sx >> sy >> sz)) fail("bad query line: " + line);
            Vec3d camera{0, 0, out.bottom_radius + alt};
            Vec3d view = normalize({vx, vy, vz}), sun = normalize({sx, sy, sz});
            Spec transmittance, skyIrradiance;
            Spec radiance = GetSkyRadiance(out, tables, camera, view, 0.0, sun, transmittance);
            Spec sunIrradiance = GetSunAndSkyIrradiance(out, tables, camera, {0, 0, 1}, sun, skyIrradiance);
            j << (first ? "" : ",") << "{\"radiance\":" << jsonSpec(radiance) << ",\"transmittance\":" << jsonSpec(transmittance) << ",\"sunIrradiance\":" << jsonSpec(sunIrradiance)
              << ",\"skyIrradiance\":" << jsonSpec(skyIrradiance) << "}";
            first = false;
        }
        j << "]}\n";
        std::string text = j.str();
        writeFile(resultsFile, std::vector<uint8_t>(text.begin(), text.end()));
    }
    return 0;
}
