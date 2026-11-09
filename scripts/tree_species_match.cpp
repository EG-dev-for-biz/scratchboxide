/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * tree_species_match: the species library's loader and matcher (scratchbox_tree_species.hpp) on their own, without a
 * build. Reads the index, then matches crowns at a place and prints every choice and the histogram as JSON.
 *
 *   tree_species_match --species-index index.json
 *       [--crowns crowns.json]          the measured descriptors a strip recorded (each tree crown's species.measured)
 *       [--descriptors file.json]       or a list: [{id?, heightM, aspect, topShare, hueDeg?, saturation?}]
 *       [--lat-deg D --lon-deg D] [--elevation-m M] [--min-winter-temp-c C] [--aridity-index A] [--lat-abs-deg D]
 *       [--seed HEX] [--costs 1]        --costs 1 lists every entry's cost per crown, nearest first
 *       [--repeat N]                    match the whole list N times and report the time per crown
 *       [--month M]                     also list each entry's leafPresence at the place's latitude in month M (1 = January)
 *
 * With neither --crowns nor --descriptors it only loads the index (exit 1 naming what is wrong with it).
 * The seed per crown is a hash of --seed and the crown's id: the same crown picks the same entry on every run, but not
 * necessarily the entry the build that measured it picked among near-equal ones.
 */

#include "scratchbox_tree_species.hpp"

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>

using namespace scratchbox;

static std::string readText(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot read " + path);
    std::ostringstream s;
    s << f.rdbuf();
    return s.str();
}

static std::string num(double v) {
    char b[40];
    std::snprintf(b, sizeof b, "%.6g", v);
    return b;
}

static std::string quoted(const std::string& s) {
    std::string o = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\') o += '\\';
        o += c;
    }
    return o + "\"";
}

static uint64_t mix(uint64_t x) {
    x += 0x9E3779B97F4A7C15ull;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ull;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBull;
    return x ^ (x >> 31);
}

struct Crown {
    long long id{0};
    tree_species::CrownDescriptors d;
};

static bool readDescriptors(const io::GlbJsonValue& m, tree_species::CrownDescriptors& d) {
    if (m.type != io::GlbJsonValue::Object || m["heightM"].type != io::GlbJsonValue::Number || m["topShare"].type != io::GlbJsonValue::Number) return false;
    d.heightM = m["heightM"].num;
    d.aspect = m["aspect"].type == io::GlbJsonValue::Number ? m["aspect"].num : (m["meanRadiusM"].num / std::max(0.1, d.heightM));
    d.meanRadiusM = m["meanRadiusM"].type == io::GlbJsonValue::Number ? m["meanRadiusM"].num : d.aspect * d.heightM;
    d.topShare = m["topShare"].num;
    if (m["hueDeg"].type == io::GlbJsonValue::Number) {
        d.colourKnown = true;
        d.hueDeg = m["hueDeg"].num;
        d.saturation = m["saturation"].type == io::GlbJsonValue::Number ? m["saturation"].num : 1.0;
    }
    return d.heightM > 0 && d.aspect > 0;
}

int main(int argc, char** argv) {
    try {
        std::map<std::string, std::string> a;
        for (int i = 1; i + 1 < argc; i += 2) {
            const std::string k = argv[i];
            if (k.rfind("--", 0) != 0) throw std::runtime_error("expected a --flag, got " + k);
            a[k.substr(2)] = argv[i + 1];
        }
        if ((argc - 1) % 2 != 0) throw std::runtime_error("every flag takes a value");
        if (!a.count("species-index")) throw std::runtime_error("needs --species-index");
        const auto real = [&](const char* k) { return a.count(k) ? std::strtod(a[k].c_str(), nullptr) : std::numeric_limits<double>::quiet_NaN(); };
        const tree_species::Library lib = tree_species::parseIndex(readText(a["species-index"]));
        tree_species::ChoiceParams C;
        C.place.latDeg = real("lat-deg");
        C.place.lonDeg = real("lon-deg");
        C.place.elevationM = real("elevation-m");
        C.place.minWinterTempC = real("min-winter-temp-c");
        C.place.aridityIndex = real("aridity-index");
        const double latAbs = real("lat-abs-deg");
        const uint64_t seed = a.count("seed") ? std::stoull(a["seed"], nullptr, 16) : 0x5EEDull;

        std::vector<Crown> crowns;
        if (a.count("crowns")) {
            const std::string text = readText(a["crowns"]);
            io::GlbJsonParser p(text.data(), text.size());
            const io::GlbJsonValue doc = p.parse();
            for (const auto& c : doc["crowns"].arr) {
                if (c["status"].type != io::GlbJsonValue::String || c["status"].str != "tree") continue;
                Crown k;
                k.id = static_cast<long long>(c["id"].num);
                if (readDescriptors(c["species"]["measured"], k.d)) crowns.push_back(k);
            }
        } else if (a.count("descriptors")) {
            const std::string text = readText(a["descriptors"]);
            io::GlbJsonParser p(text.data(), text.size());
            const io::GlbJsonValue doc = p.parse();
            long long next = 0;
            for (const auto& c : doc.arr) {
                Crown k;
                k.id = c["id"].type == io::GlbJsonValue::Number ? static_cast<long long>(c["id"].num) : next;
                ++next;
                if (!readDescriptors(c, k.d)) throw std::runtime_error("a descriptor needs heightM, topShare and aspect or meanRadiusM");
                crowns.push_back(k);
            }
        }
        for (auto& k : crowns) k.d.latAbsDeg = latAbs;

        std::vector<tree_species::Choice> chosen(crowns.size());
        const int repeat = a.count("repeat") ? std::max(1, std::atoi(a["repeat"].c_str())) : 1;
        const auto t0 = std::chrono::steady_clock::now();
        for (int r = 0; r < repeat; ++r) {
            for (size_t i = 0; i < crowns.size(); ++i) chosen[i] = tree_species::choose(lib, crowns[i].d, mix(seed ^ mix(static_cast<uint64_t>(crowns[i].id))), C);
        }
        const double ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - t0).count();

        const tree_species::PlaceClimate place = tree_species::resolvePlace(lib, C.place, latAbs, C);
        std::map<std::string, size_t> hist;
        std::string out = "{\"entries\":" + std::to_string(lib.entries.size()) + ",\"regions\":" + std::to_string(lib.regions.size()) + ",\"place\":" + tree_species::placeJson(lib, C, latAbs) +
                          ",\"crowns\":" + std::to_string(crowns.size());
        if (!crowns.empty()) out += ",\"nsPerCrown\":" + num(ns / (static_cast<double>(crowns.size()) * repeat));
        if (a.count("month") && place.latSigned) {
            out += ",\"leafPresence\":{";
            for (size_t k = 0; k < lib.entries.size(); ++k) out += std::string(k ? "," : "") + quoted(lib.entries[k].id) + ":" + num(tree_species::leafPresence(lib.entries[k], place.latDeg, real("month")));
            out += "}";
        }
        out += ",\"choices\":[";
        for (size_t i = 0; i < crowns.size(); ++i) {
            const auto& ch = chosen[i];
            const auto& e = lib.entries[ch.entry];
            ++hist[ch.matched ? e.id : std::string("(unmatched)")];
            out += std::string(i ? "," : "") + "{\"id\":" + std::to_string(crowns[i].id) + ",\"entry\":" + (ch.matched ? quoted(e.id) : std::string("null")) + ",\"nearest\":" + quoted(e.id) +
                   ",\"cost\":" + num(ch.cost) + ",\"placeCost\":" + num(tree_species::placeCost(e, place, C));
            if (a.count("costs") && a["costs"] == "1") {
                std::vector<std::pair<double, size_t>> all;
                for (size_t k = 0; k < lib.entries.size(); ++k) all.push_back({tree_species::entryCost(lib.entries[k], crowns[i].d, C, place), k});
                std::sort(all.begin(), all.end());
                out += ",\"costs\":[";
                for (size_t k = 0; k < all.size(); ++k) {
                    out += std::string(k ? "," : "") + "{\"entry\":" + quoted(lib.entries[all[k].second].id) + ",\"cost\":" + num(all[k].first) + ",\"placeCost\":" + num(tree_species::placeCost(lib.entries[all[k].second], place, C)) + "}";
                }
                out += "]";
            }
            out += "}";
        }
        out += "],\"histogram\":{";
        bool first = true;
        for (const auto& kv : hist) {
            out += std::string(first ? "" : ",") + quoted(kv.first) + ":" + std::to_string(kv.second);
            first = false;
        }
        std::cout << out << "}}\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "ERROR: " << e.what() << "\n";
        return 1;
    }
}
