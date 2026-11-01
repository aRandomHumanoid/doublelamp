// Writes golden effect frames (08 §1.2). The C++ effects are the reference; packages/effects
// must reproduce these arrays exactly.
//   gen_vectors <out.json>          write the file
//   gen_vectors --check <in.json>   exit 1 if the committed file is stale
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "effects/effects.hpp"

using namespace fx;

struct ParamSet {
    uint8_t speed, intensity;
    uint32_t seed, duration_ms;
    std::vector<const char*> colors;
};

static std::string render_all() {
    const std::vector<ParamSet> params = {
        {0, 0, 0u, 0u, {"#FF0000"}},
        {128, 128, 123456789u, 300000u, {"#FF8A3D", "#7A2BFF"}},
        {255, 255, 0xDEADBEEFu, 3600000u, {"#00FF00", "#0000FF", "#FFFFFF"}},
        {96, 64, 42u, 0u, {"#FFB46B", "#40C0FF", "#FF2060"}},
    };
    const std::vector<uint64_t> times = {0ull, 1ull, 999ull, 1000ull, 12345ull, 300000ull, 4294967373ull,
                                         1761650000123ull};
    const std::vector<uint16_t> counts = {1, 10, 17};

    std::string json = "{\n  \"version\": 1,\n  \"cases\": [\n";
    bool first = true;
    std::vector<RGB8> out(1024);
    char hex[8];
    auto emit = [&](const EffectDesc& d, const ParamSet& ps, uint64_t t, uint16_t n) {
        RGB8 cols[3];
        for (size_t i = 0; i < ps.colors.size(); i++) parse_hex(ps.colors[i], &cols[i]);
        EffectParams p{ps.speed, ps.intensity, cols, (uint8_t)ps.colors.size(), ps.seed, ps.duration_ms};
        d.render(p, t, n, out.data());
        char head[256];
        std::snprintf(head, sizeof head,
                      "    {\"effect\":\"%s\",\"speed\":%u,\"intensity\":%u,\"seed\":%u,\"duration_ms\":%u,\"t\":%llu,"
                      "\"n\":%u,\"colors\":[",
                      d.id, ps.speed, ps.intensity, ps.seed, ps.duration_ms, (unsigned long long)t, n);
        if (!first) json += ",\n";
        first = false;
        json += head;
        for (size_t i = 0; i < ps.colors.size(); i++) {
            json += (i ? ",\"" : "\"");
            json += ps.colors[i];
            json += "\"";
        }
        json += "],\"out\":[";
        for (uint16_t i = 0; i < n; i++) {
            format_hex(out[i], hex);
            json += (i ? ",\"" : "\"");
            json += hex;
            json += "\"";
        }
        json += "]}";
    };
    for (size_t e = 0; e < effect_count(); e++) {
        const EffectDesc& d = effect_at(e);
        for (const auto& ps : params)
            for (uint64_t t : times)
                for (uint16_t n : counts) emit(d, ps, t, n);
        emit(d, params[1], 77777ull, 1024);
    }
    json += "\n  ]\n}\n";
    return json;
}

int main(int argc, char** argv) {
    if (argc == 3 && std::strcmp(argv[1], "--check") == 0) {
        FILE* f = std::fopen(argv[2], "rb");
        if (!f) {
            std::fprintf(stderr, "cannot open %s\n", argv[2]);
            return 1;
        }
        std::string have;
        char buf[4096];
        size_t r;
        while ((r = std::fread(buf, 1, sizeof buf, f)) > 0) have.append(buf, r);
        std::fclose(f);
        if (have != render_all()) {
            std::fprintf(stderr, "%s is stale: run gen_vectors to regenerate\n", argv[2]);
            return 1;
        }
        std::printf("golden vectors up to date\n");
        return 0;
    }
    if (argc != 2) {
        std::fprintf(stderr, "usage: gen_vectors <out.json> | --check <in.json>\n");
        return 2;
    }
    FILE* f = std::fopen(argv[1], "wb");
    if (!f) {
        std::fprintf(stderr, "cannot write %s\n", argv[1]);
        return 1;
    }
    std::string json = render_all();
    std::fwrite(json.data(), 1, json.size(), f);
    std::fclose(f);
    std::printf("wrote %s\n", argv[1]);
    return 0;
}
