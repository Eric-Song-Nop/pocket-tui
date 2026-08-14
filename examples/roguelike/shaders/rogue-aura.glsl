// Echo Aperture — PocketTUI's Ghostty 1.3+ flagship effect.
//
// Ghostty supplies the Shadertoy-compatible uniforms and main() wrapper. Keep
// this file to helpers plus mainImage(); declaring either again will fail.
//
// The optional ghostty-palette-v1 bus is deliberately tiny and reversible:
//   iPalette[240] = #505458 ("PTX" signature)
//   iPalette[241] = event kind, power, flags (flag bit 0 = vitality valid)
//   iPalette[242] = HP ratio, energy ratio, combo ratio
//   iPalette[243] = signed X/Y bearing (128 = zero), aperture radius
// Event kinds: 0 idle, 1 move, 2 pulse, 3 damage, 4 heal, 5 beam, 6 win.
// PocketTUI owns publication/reset of those slots and toggles a near-identical
// cursor shade for each trigger, giving the shader a reliable event clock.

const float TAU = 6.28318530718;

float paletteInk(vec3 sampleColor, vec3 keyColor) {
    // Antialiased glyph pixels are blends of the palette key and background.
    float notBackground = smoothstep(
        0.025,
        0.120,
        length(sampleColor - iBackgroundColor)
    );
    float matchesKey = 1.0 - smoothstep(
        0.085,
        0.310,
        length(sampleColor - keyColor)
    );
    return notBackground * matchesKey;
}

void gatherPaletteBloom(vec2 uv, out vec3 spectral, out vec2 vitality) {
    vec2 pixel = 1.0 / iResolution.xy;
    spectral = vec3(0.0); // arcane, hydrophone, fire
    vitality = vec2(0.0); // healing, damage

    // Three sparse rings create a much wider bloom than a glyph blur while the
    // original framebuffer remains sampled at its exact pixel coordinate.
    for (int index = 0; index < 8; ++index) {
        float angle = TAU * float(index) / 8.0;
        vec2 direction = vec2(cos(angle), sin(angle));
        vec2 nearUv = clamp(uv + direction * pixel * 2.5, vec2(0.0), vec2(1.0));
        vec2 midUv = clamp(uv + direction * pixel * 6.0, vec2(0.0), vec2(1.0));
        vec2 farUv = clamp(uv + direction * pixel * 12.0, vec2(0.0), vec2(1.0));
        vec3 nearColor = texture(iChannel0, nearUv).rgb;
        vec3 midColor = texture(iChannel0, midUv).rgb;
        vec3 farColor = texture(iChannel0, farUv).rgb;

        spectral += 0.070 * vec3(
            paletteInk(nearColor, iPalette[13]),
            paletteInk(nearColor, iPalette[14]),
            paletteInk(nearColor, iPalette[11])
        );
        vitality += 0.060 * vec2(
            paletteInk(nearColor, iPalette[10]),
            paletteInk(nearColor, iPalette[9])
        );
        spectral += 0.037 * vec3(
            paletteInk(midColor, iPalette[13]),
            paletteInk(midColor, iPalette[14]),
            paletteInk(midColor, iPalette[11])
        );
        vitality += 0.030 * vec2(
            paletteInk(midColor, iPalette[10]),
            paletteInk(midColor, iPalette[9])
        );
        spectral += 0.017 * vec3(
            paletteInk(farColor, iPalette[13]),
            paletteInk(farColor, iPalette[14]),
            paletteInk(farColor, iPalette[11])
        );
        vitality += 0.013 * vec2(
            paletteInk(farColor, iPalette[10]),
            paletteInk(farColor, iPalette[9])
        );
    }

    spectral = clamp(spectral, vec3(0.0), vec3(1.0));
    vitality = clamp(vitality, vec2(0.0), vec2(1.0));
}

vec2 cursorCenter(vec4 cursorRect) {
    // xy is Ghostty's -X,+Y corner. The center is right and down by half-size.
    return cursorRect.xy + vec2(0.5 * cursorRect.z, -0.5 * cursorRect.w);
}

float segmentDistance(vec2 point, vec2 start, vec2 end) {
    vec2 segment = end - start;
    float amount = clamp(
        dot(point - start, segment) / max(dot(segment, segment), 0.0001),
        0.0,
        1.0
    );
    return length(point - (start + amount * segment));
}

float ring(float distanceFromCenter, float radius, float width) {
    return 1.0 - smoothstep(
        width,
        width + 2.5,
        abs(distanceFromCenter - radius)
    );
}

float eventIs(float eventKind, float expected) {
    return 1.0 - step(0.5, abs(eventKind - expected));
}

float decodedByte(float channel) {
    return floor(channel * 255.0 + 0.5);
}

float effectBusActive() {
    vec3 signature = vec3(80.0, 84.0, 88.0) / 255.0;
    return 1.0 - smoothstep(
        0.001,
        0.006,
        length(iPalette[240] - signature)
    );
}

vec2 safeDirection(vec2 candidate, vec2 fallback) {
    float candidateLength = length(candidate);
    if (candidateLength > 0.001) {
        return candidate / candidateLength;
    }
    float fallbackLength = length(fallback);
    if (fallbackLength > 0.001) {
        return fallback / fallbackLength;
    }
    return vec2(1.0, 0.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 base = texture(iChannel0, uv);
    vec3 light = vec3(0.0);
    float shortestSide = min(iResolution.x, iResolution.y);

    // Theme-aware, multi-scale emissions. These remain useful in Ghostty even
    // when the optional effect bus has not been selected.
    vec3 spectralBloom;
    vec2 vitalityBloom;
    gatherPaletteBloom(uv, spectralBloom, vitalityBloom);
    float breathe = 0.90 + 0.10 * sin(iTime * 4.4);
    light += breathe * (
        iPalette[13] * spectralBloom.x * 0.31 +
        iPalette[14] * spectralBloom.y * 0.34 +
        iPalette[11] * spectralBloom.z * 0.27 +
        iPalette[10] * vitalityBloom.x * 0.28 +
        iPalette[9] * vitalityBloom.y * 0.24
    );

    float cursorActive = (iFocus > 0 && iCursorVisible > 0) ? 1.0 : 0.0;
    float cursorAge = max(0.0, iTime - iTimeCursorChange);
    vec2 previousCenter = cursorCenter(iPreviousCursor);
    vec2 currentCenter = cursorCenter(iCurrentCursor);
    vec2 cursorDelta = currentCenter - previousCenter;
    float validPrevious = (
        iPreviousCursor.z > 0.0 &&
        iPreviousCursor.w > 0.0 &&
        length(cursorDelta) < 0.35 * length(iResolution.xy)
    ) ? 1.0 : 0.0;

    // A continuous wake plus discrete phosphor echoes makes one cursor update
    // feel like several hydrophone samples without needing a history texture.
    float trailLife = 1.0 - smoothstep(0.025, 0.34, cursorAge);
    float trailWidth = max(1.6, 0.15 * min(iCurrentCursor.z, iCurrentCursor.w));
    float wake = 1.0 - smoothstep(
        trailWidth,
        trailWidth + 5.5,
        segmentDistance(fragCoord, previousCenter, currentCenter)
    );
    float afterimages = 0.0;
    for (int echoIndex = 0; echoIndex < 5; ++echoIndex) {
        float amount = float(echoIndex + 1) / 6.0;
        vec2 echoCenter = mix(currentCenter, previousCenter, amount);
        float echoRadius = max(2.0, 0.30 * max(iCurrentCursor.z, iCurrentCursor.w));
        float echo = 1.0 - smoothstep(
            echoRadius,
            echoRadius + 4.0,
            length(fragCoord - echoCenter)
        );
        afterimages += echo * (1.0 - amount) * 0.20;
    }
    light += iPalette[14] * cursorActive * validPrevious * trailLife * (
        wake * 0.27 + afterimages * 0.34
    );

    // Decode the demo's vocabulary only after the signature proves that the
    // reserved palette slots are currently owned by PocketTUI.
    float bus = effectBusActive();
    float eventKind = decodedByte(iPalette[241].r);
    float eventPower = max(0.16, iPalette[241].g);
    float flags = decodedByte(iPalette[241].b);
    float vitalityValid = step(0.5, mod(flags, 2.0));
    float hp = iPalette[242].r;
    float energy = iPalette[242].g;
    float combo = iPalette[242].b;
    vec2 bearing = (vec2(
        decodedByte(iPalette[243].r),
        decodedByte(iPalette[243].g)
    ) - vec2(128.0)) / 127.0;
    // Game-space Y points down; fragment-space Y points up.
    bearing.y = -bearing.y;
    float aperture = mix(0.08, 0.40, iPalette[243].b);
    vec2 bearingDirection = safeDirection(bearing, cursorDelta);
    vec2 eventCenter = currentCenter + bearing * shortestSide * 0.13;
    vec2 relative = fragCoord - eventCenter;
    float eventDistance = length(relative);
    vec2 radialDirection = safeDirection(relative, bearingDirection);
    float eventAge = cursorAge;

    // The visual signature: a directional hydrophone aperture over expanding
    // sonar rings. Event power, energy, and combo widen its listening cone.
    float apertureLobe = pow(abs(dot(radialDirection, bearingDirection)), 8.0);
    float sideLobe = pow(
        abs(dot(radialDirection, vec2(-bearingDirection.y, bearingDirection.x))),
        18.0
    );
    float apertureFalloff = 1.0 - smoothstep(
        shortestSide * aperture * 0.18,
        shortestSide * aperture,
        eventDistance
    );
    float hydrophoneGrain = 0.70 + 0.30 * sin(eventDistance * 0.075 - iTime * 11.0);
    float apertureField = apertureFalloff * hydrophoneGrain * (
        apertureLobe + sideLobe * (0.18 + combo * 0.28)
    );

    float moveGate = bus * eventIs(eventKind, 1.0) *
        (1.0 - smoothstep(0.02, 0.34, eventAge));
    float pulseGate = bus * eventIs(eventKind, 2.0) *
        (1.0 - smoothstep(0.03, 1.25, eventAge));
    float damageGate = bus * eventIs(eventKind, 3.0) *
        (1.0 - smoothstep(0.02, 0.72, eventAge));
    float healGate = bus * eventIs(eventKind, 4.0) *
        (1.0 - smoothstep(0.03, 1.30, eventAge));
    float beamGate = bus * eventIs(eventKind, 5.0) *
        (1.0 - smoothstep(0.015, 0.48, eventAge));
    float winGate = bus * eventIs(eventKind, 6.0) *
        (1.0 - smoothstep(0.04, 2.80, eventAge));

    float pulseRadius = shortestSide * (0.025 + eventAge * (0.34 + 0.18 * energy));
    float pulseRings = ring(eventDistance, pulseRadius, 3.2) +
        ring(eventDistance, pulseRadius * 0.72, 2.1) * 0.48 +
        ring(eventDistance, pulseRadius * 0.43, 1.6) * 0.26;
    light += iPalette[14] * pulseGate * eventPower * (
        pulseRings * (0.62 + apertureField * 0.42) + apertureField * 0.16
    );

    // Movement compresses the same sonar geometry into a fast forward wake.
    float directionalWake = apertureField *
        (1.0 - smoothstep(0.0, shortestSide * 0.20, eventDistance));
    light += mix(iPalette[14], iPalette[13], 0.28) * moveGate * eventPower *
        directionalWake * 0.46;

    // Damage gets a hard shock front and a brief red edge flash. The apparent
    // shake/color split is applied to background only below, preserving ink.
    float damageRadius = shortestSide * (0.035 + eventAge * 0.72);
    float damageShock = ring(eventDistance, damageRadius, 4.0 + eventAge * 5.0);
    vec2 fromScreenCenter = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    float screenEdge = smoothstep(0.34, 0.72, length(fromScreenCenter));
    light += iPalette[9] * damageGate * eventPower * (
        damageShock * 0.88 + screenEdge * 0.18
    );

    // Healing collapses several green rings inward toward the cursor.
    float healRadius = shortestSide * (0.30 - min(eventAge, 1.0) * 0.24);
    float healRings = ring(eventDistance, healRadius, 3.1) +
        ring(eventDistance, healRadius * 0.64, 2.0) * 0.55;
    light += mix(iPalette[10], iForegroundColor, 0.12) * healGate * eventPower *
        (healRings * 0.52 + apertureField * 0.20);

    // A bearing turns the aperture into a readable beam. At neutral bearing,
    // previous-to-current motion determines its direction.
    vec2 beamEnd = currentCenter + bearingDirection * shortestSide * aperture;
    float beamDistance = segmentDistance(fragCoord, currentCenter, beamEnd);
    float beam = 1.0 - smoothstep(1.4, 6.5 + 5.0 * eventPower, beamDistance);
    float beamCap = 1.0 - smoothstep(
        shortestSide * aperture * 0.78,
        shortestSide * aperture * 1.05,
        length(fragCoord - currentCenter)
    );
    light += mix(iPalette[14], iPalette[13], 0.45) * beamGate * eventPower *
        beam * beamCap * (0.48 + 0.24 * sin(iTime * 28.0));

    // Victory opens the aperture to the whole surface in gold/cyan harmonics.
    float winRadius = shortestSide * (0.04 + eventAge * 0.43);
    float winRings = ring(length(fragCoord - currentCenter), winRadius, 5.0) +
        ring(length(fragCoord - currentCenter), winRadius * 0.64, 3.0) * 0.55 +
        ring(length(fragCoord - currentCenter), winRadius * 0.33, 2.0) * 0.34;
    light += mix(iPalette[11], iPalette[14], 0.24) * winGate * eventPower *
        (winRings * 0.82 + apertureField * 0.22);

    // Low HP is persistent but restrained to the border. Bit 0 prevents zeroed
    // or unrelated channel data from accidentally entering danger mode.
    float lowHp = bus * vitalityValid * (1.0 - smoothstep(0.08, 0.43, hp));
    float heartbeat = pow(0.5 + 0.5 * sin(iTime * 5.6), 8.0);
    vec2 edgeDistance = min(uv, vec2(1.0) - uv);
    float dangerEdge = 1.0 - smoothstep(0.015, 0.15, min(edgeDistance.x, edgeDistance.y));
    light += iPalette[9] * lowHp * dangerEdge * (0.045 + heartbeat * 0.12);

    // Backward-compatible damage detection for demos that only signal through
    // OSC 12; ghostty-palette-v1 uses the explicit event byte above.
    float redDominance = iCurrentCursorColor.r - max(
        iCurrentCursorColor.g,
        iCurrentCursorColor.b
    );
    float legacyDamage = (1.0 - bus) * smoothstep(0.08, 0.30, redDominance) *
        cursorActive * trailLife;
    light += iPalette[9] * legacyDamage * screenEdge * 0.10;

    // Ink protection is the hard readability boundary. Damage creates a brief
    // two-pixel negative-space shake/chromatic split, but glyphs, borders, and
    // their alpha remain copied from the exact original pixel.
    float existingInk = smoothstep(
        0.055,
        0.245,
        length(base.rgb - iBackgroundColor)
    );
    float damageRefraction = clamp(damageGate + legacyDamage, 0.0, 1.0) *
        (1.0 - existingInk);
    vec2 pixel = 1.0 / iResolution.xy;
    vec2 shakeOffset = pixel * vec2(
        sin(iTime * 73.0),
        cos(iTime * 61.0)
    ) * 2.1 * damageRefraction;
    vec3 shifted = texture(iChannel0, clamp(uv + shakeOffset, vec2(0.0), vec2(1.0))).rgb;
    vec3 split = vec3(
        texture(iChannel0, clamp(uv + shakeOffset + vec2(pixel.x * 1.8, 0.0), vec2(0.0), vec2(1.0))).r,
        shifted.g,
        texture(iChannel0, clamp(uv + shakeOffset - vec2(pixel.x * 1.8, 0.0), vec2(0.0), vec2(1.0))).b
    );
    vec3 composed = mix(base.rgb, split, damageRefraction * 0.105);

    light *= mix(1.0, 0.14, existingInk);
    fragColor = vec4(min(composed + light, vec3(1.0)), base.a);
}
