// Syntax Loom — an original Ghostty 1.3+ effect for RULE//SHIFT.
//
// Ghostty prepends uniforms and the main() wrapper; this file supplies only
// helpers and mainImage(). PocketTUI publishes a reversible semantic bus:
//   iPalette[240] = #505458 ownership signature
//   iPalette[241] = event kind, power, flags
//   iPalette[242] = stage progress, undo charge, active-rule density
//   iPalette[243] = signed event bearing (128 = zero), wave reach
// Event kinds: 0 idle, 1 move, 2 push, 3 blocked, 4 calibrate,
//              5 rule transform, 6 stage clear.

const float PI = 3.14159265359;
const vec3 TOKEN_INK = vec3(19.0, 22.0, 29.0) / 255.0;
const vec3 TOKEN_PAPER = vec3(238.0, 229.0, 201.0) / 255.0;
const vec3 TOKEN_VERMILION = vec3(235.0, 84.0, 67.0) / 255.0;
const vec3 TOKEN_CYAN = vec3(85.0, 191.0, 215.0) / 255.0;
const vec3 TOKEN_BRASS = vec3(232.0, 184.0, 79.0) / 255.0;

float byteValue(float encoded) {
    return floor(encoded * 255.0 + 0.5);
}

float eventEquals(float kind, float expected) {
    return 1.0 - step(0.5, abs(kind - expected));
}

float busIsOwned() {
    const vec3 signature = vec3(80.0, 84.0, 88.0) / 255.0;
    return 1.0 - smoothstep(0.001, 0.006, length(iPalette[240] - signature));
}

float inkAt(vec3 sampleColor, vec3 paletteColor, vec3 visualBackground) {
    float carriesInk = smoothstep(0.030, 0.135, length(sampleColor - visualBackground));
    float matchesToken = 1.0 - smoothstep(0.080, 0.290, length(sampleColor - paletteColor));
    return carriesInk * matchesToken;
}

vec2 cursorCenter(vec4 cursorRect) {
    return cursorRect.xy + vec2(cursorRect.z * 0.5, -cursorRect.w * 0.5);
}

float lineDistance(vec2 point, vec2 start, vec2 finish) {
    vec2 span = finish - start;
    float amount = clamp(dot(point - start, span) / max(dot(span, span), 0.0001), 0.0, 1.0);
    return length(point - mix(start, finish, amount));
}

float softBand(float value, float center, float width) {
    return 1.0 - smoothstep(width, width + 2.0, abs(value - center));
}

float rectangleEdge(vec2 point, vec2 halfSize) {
    vec2 edge = abs(point) - halfSize;
    return length(max(edge, vec2(0.0))) + min(max(edge.x, edge.y), 0.0);
}

vec3 tokenHalo(vec2 uv, vec3 visualBackground) {
    vec2 pixel = 1.0 / iResolution.xy;
    vec3 light = vec3(0.0);

    // A sparse plus-shaped gather reads as offset letterpress registration,
    // not the circular neon bloom used by the roguelike demo.
    for (int stepIndex = 1; stepIndex <= 4; ++stepIndex) {
        float distancePx = float(stepIndex) * 2.0;
        float weight = 0.060 / float(stepIndex);
        vec3 north = texture(iChannel0, clamp(uv + vec2(0.0, pixel.y * distancePx), vec2(0.0), vec2(1.0))).rgb;
        vec3 south = texture(iChannel0, clamp(uv - vec2(0.0, pixel.y * distancePx), vec2(0.0), vec2(1.0))).rgb;
        vec3 east = texture(iChannel0, clamp(uv + vec2(pixel.x * distancePx, 0.0), vec2(0.0), vec2(1.0))).rgb;
        vec3 west = texture(iChannel0, clamp(uv - vec2(pixel.x * distancePx, 0.0), vec2(0.0), vec2(1.0))).rgb;
        float brassInk = inkAt(north, TOKEN_BRASS, visualBackground) +
            inkAt(south, TOKEN_BRASS, visualBackground) +
            inkAt(east, TOKEN_BRASS, visualBackground) +
            inkAt(west, TOKEN_BRASS, visualBackground);
        float vermilionInk = inkAt(north, TOKEN_VERMILION, visualBackground) +
            inkAt(south, TOKEN_VERMILION, visualBackground) +
            inkAt(east, TOKEN_VERMILION, visualBackground) +
            inkAt(west, TOKEN_VERMILION, visualBackground);
        float cyanInk = inkAt(north, TOKEN_CYAN, visualBackground) +
            inkAt(south, TOKEN_CYAN, visualBackground) +
            inkAt(east, TOKEN_CYAN, visualBackground) +
            inkAt(west, TOKEN_CYAN, visualBackground);
        light += TOKEN_BRASS * brassInk * weight;
        light += TOKEN_VERMILION * vermilionInk * weight * 0.88;
        light += TOKEN_CYAN * cyanInk * weight * 0.76;
    }
    return light;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 base = texture(iChannel0, uv);
    float shortestSide = min(iResolution.x, iResolution.y);

    float owned = busIsOwned();
    vec3 visualBackground = mix(iBackgroundColor, TOKEN_INK, owned);
    vec3 illumination = tokenHalo(uv, visualBackground);
    float kind = byteValue(iPalette[241].r);
    float power = max(0.10, iPalette[241].g);
    float stageProgress = iPalette[242].r;
    float undoCharge = iPalette[242].g;
    float ruleDensity = iPalette[242].b;
    vec2 bearingCells = vec2(byteValue(iPalette[243].r), byteValue(iPalette[243].g)) - 128.0;
    float waveReach = mix(0.12, 0.55, iPalette[243].b);

    vec2 current = cursorCenter(iCurrentCursor);
    vec2 previous = cursorCenter(iPreviousCursor);
    vec2 delta = current - previous;
    float cursorReady = (iFocus > 0 && iCursorVisible > 0) ? 1.0 : 0.0;
    float age = max(0.0, iTime - iTimeCursorChange);
    // The bus carries terminal-cell offsets, so Ghostty's cursor cell size can
    // reconstruct the semantic anchor rather than merely point toward it.
    vec2 eventCenter = current + vec2(
        bearingCells.x * max(iCurrentCursor.z, 1.0),
        -bearingCells.y * max(iCurrentCursor.w, 1.0)
    );
    vec2 local = fragCoord - eventCenter;

    // Movement lays down two dry-offset registration marks along the last
    // cursor segment. Their squared shape echoes the game's word tiles.
    // Each gate reaches zero just before the matching portable cue expires.
    // The app then returning the typed bus to idle cannot hard-cut a bright
    // shader tail.
    float moveLife = owned * cursorReady * eventEquals(kind, 1.0) * (1.0 - smoothstep(0.015, 0.115, age));
    float segment = 1.0 - smoothstep(1.2, 5.5, lineDistance(fragCoord, previous, current));
    float registration = softBand(rectangleEdge(fragCoord - mix(previous, current, 0.35), vec2(7.0, 4.0)), 0.0, 1.8);
    illumination += mix(TOKEN_CYAN, TOKEN_PAPER, 0.38) * moveLife * power * (segment * 0.18 + registration * 0.22);

    // Push is a compact stack of parallel pressure lines in the move direction.
    vec2 direction = length(delta) > 0.1 ? normalize(delta) : vec2(1.0, 0.0);
    vec2 normal = vec2(-direction.y, direction.x);
    float pushLife = owned * eventEquals(kind, 2.0) * (1.0 - smoothstep(0.02, 0.17, age));
    float along = dot(local, direction);
    float across = dot(local, normal);
    float pressure = (softBand(across, -7.0, 1.5) + softBand(across, 0.0, 1.5) + softBand(across, 7.0, 1.5)) *
        smoothstep(-10.0, 2.0, along) * (1.0 - smoothstep(shortestSide * 0.24, shortestSide * 0.34, along));
    illumination += TOKEN_BRASS * pushLife * power * pressure * 0.25;

    // A blocked move stamps a restrained red bracket around the attempted cell.
    float blockedLife = owned * eventEquals(kind, 3.0) * (1.0 - smoothstep(0.02, 0.23, age));
    float blockedBox = softBand(rectangleEdge(local, vec2(15.0, 9.0)), 0.0, 2.4);
    illumination += TOKEN_VERMILION * blockedLife * power * blockedBox * 0.52;

    // Calibration (undo, restart, level change) winds a rectangular spiral
    // back into the anchor. Undo capacity controls how many ghost rulings show.
    float calibrateLife = owned * eventEquals(kind, 4.0) * (1.0 - smoothstep(0.03, 0.52, age));
    float rewindSize = shortestSide * (0.25 - min(age * 1.6, 0.75) * 0.24);
    float rewind = softBand(rectangleEdge(local, vec2(rewindSize, rewindSize * 0.48)), 0.0, 2.4);
    float ledger = 0.5 + 0.5 * sin((local.x + local.y) * 0.045 + undoCharge * PI * 4.0);
    illumination += mix(TOKEN_PAPER, TOKEN_CYAN, 0.52) * calibrateLife * power * rewind * (0.25 + ledger * 0.28);

    // The signature effect: a syntax loom crosses the whole rule sentence.
    // A bright shuttle travels horizontally while vertical warp threads briefly
    // reveal a grammar grid. It begins exactly at the semantic effect anchor.
    float transformLife = owned * eventEquals(kind, 5.0) * (1.0 - smoothstep(0.02, 0.30, age));
    float shuttleX = eventCenter.x + (age * iResolution.x * (2.5 + 0.8 * power));
    float shuttle = 1.0 - smoothstep(1.5, 8.0, abs(fragCoord.x - shuttleX));
    float sentenceBand = 1.0 - smoothstep(10.0, 34.0 + 22.0 * ruleDensity, abs(local.y));
    float warp = pow(0.5 + 0.5 * cos((fragCoord.x - eventCenter.x) * 0.095), 12.0);
    float weft = pow(0.5 + 0.5 * cos(local.y * 0.22), 18.0);
    float woven = sentenceBand * (shuttle * 0.76 + warp * weft * 0.22);
    illumination += mix(TOKEN_BRASS, TOKEN_PAPER, 0.32) * transformLife * power * woven;

    // Completion expands nested rectangular proofs rather than circular rings.
    float winLife = owned * eventEquals(kind, 6.0) * (1.0 - smoothstep(0.03, 0.88, age));
    float proofSize = shortestSide * (0.04 + age * (0.60 + stageProgress * 0.28));
    float proof = softBand(rectangleEdge(local, vec2(proofSize, proofSize * 0.58)), 0.0, 3.4) +
        softBand(rectangleEdge(local, vec2(proofSize * 0.67, proofSize * 0.39)), 0.0, 2.2) * 0.58 +
        softBand(rectangleEdge(local, vec2(proofSize * 0.34, proofSize * 0.20)), 0.0, 1.6) * 0.34;
    vec3 proofColor = 0.36 * TOKEN_BRASS + 0.34 * TOKEN_CYAN + 0.30 * TOKEN_PAPER;
    illumination += proofColor * winLife * power * proof * 0.70;

    // A faint ruled-paper field appears only near active semantic events.
    float activeEvent = clamp(moveLife + pushLife + blockedLife + calibrateLife + transformLife + winLife, 0.0, 1.0);
    float ruleLine = pow(0.5 + 0.5 * cos(fragCoord.y * 0.105), 42.0);
    float field = 1.0 - smoothstep(shortestSide * waveReach * 0.35, shortestSide * waveReach, length(local));
    illumination += mix(iForegroundColor, TOKEN_CYAN, 0.55) * activeEvent * field * ruleLine * 0.025;

    // Preserve every glyph and border at its exact source coordinate. Only
    // negative space receives the optional paper registration/glow.
    float ink = smoothstep(0.050, 0.220, length(base.rgb - visualBackground));
    illumination *= mix(1.0, 0.10, ink);
    fragColor = vec4(min(base.rgb + illumination, vec3(1.0)), base.a);
}
