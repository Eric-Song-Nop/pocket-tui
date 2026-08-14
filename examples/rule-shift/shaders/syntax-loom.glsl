// Syntax Loom — an original Ghostty 1.3+ effect for RULE//SHIFT.
//
// Ghostty prepends uniforms and the main() wrapper; this file supplies only
// helpers and mainImage(). PocketTUI publishes a reversible semantic bus:
//   iPalette[240] = #505458 ownership signature
//   iPalette[241] = event kind, power, transition flags
//   iPalette[242] = event phase, packed campaign/rules, viewport rows
//   iPalette[243] = signed event bearing, packed direction/reach
// Event kinds: 0 idle, 1 move, 2 push, 3 blocked, 4 calibrate,
//              5 rule transform, 6 stage clear.
// Flag bits: won, undo, stage-change, restart, initial-load, shader Y-down,
//            absolute anchor (used when Ghostty has no visible cursor glyph).
// Direction codes: 0 none, 1 up, 2 right, 3 down, 4 left; the low five
// bits of the packed byte carry normalized effect reach.
//
// The pass treats the terminal as a moving proof press. Portable CanvasFrame
// particles remain the source of truth; Ghostty adds sub-pixel registration,
// framebuffer refraction, chromatic ink separation, and surface-wide waves.

const float PI = 3.14159265359;
const float TAU = 6.28318530718;
const vec3 TOKEN_INK = vec3(19.0, 22.0, 29.0) / 255.0;
const vec3 TOKEN_PAPER = vec3(238.0, 229.0, 201.0) / 255.0;
const vec3 TOKEN_VERMILION = vec3(235.0, 84.0, 67.0) / 255.0;
const vec3 TOKEN_CYAN = vec3(85.0, 191.0, 215.0) / 255.0;
const vec3 TOKEN_BRASS = vec3(232.0, 184.0, 79.0) / 255.0;

float saturate(float value) {
    return clamp(value, 0.0, 1.0);
}

float byteValue(float encoded) {
    return floor(encoded * 255.0 + 0.5);
}

float eventEquals(float kind, float expected) {
    return 1.0 - step(0.5, abs(kind - expected));
}

float flagBit(float flags, float divisor) {
    return step(0.5, mod(floor(flags / divisor), 2.0));
}

float busIsOwned() {
    const vec3 signature = vec3(80.0, 84.0, 88.0) / 255.0;
    return 1.0 - smoothstep(0.001, 0.006, length(iPalette[240] - signature));
}

float hash11(float value) {
    return fract(sin(value * 127.1) * 43758.5453123);
}

float hash21(vec2 value) {
    return fract(sin(dot(value, vec2(127.1, 311.7))) * 43758.5453123);
}

vec3 sourceAt(vec2 uv) {
    return texture(iChannel0, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
}

float inkAt(vec3 sampleColor, vec3 paletteColor, vec3 visualBackground) {
    float carriesInk = smoothstep(0.030, 0.135, length(sampleColor - visualBackground));
    float matchesToken = 1.0 - smoothstep(0.080, 0.290, length(sampleColor - paletteColor));
    return carriesInk * matchesToken;
}

vec2 cursorCenter(vec4 cursorRect) {
    // Ghostty exposes the -X,+Y corner on both renderer backends.
    return cursorRect.xy + vec2(cursorRect.z * 0.5, -cursorRect.w * 0.5);
}

vec2 cursorCellCenter(vec4 cursorRect, float cellHeight, float screenDown) {
    vec2 glyphCenter = cursorCenter(cursorRect);
    float lift = max(0.0, cellHeight - cursorRect.w) * 0.5;
    return glyphCenter + vec2(0.0, -screenDown * lift);
}

vec2 safeDirection(vec2 candidate, vec2 fallback) {
    float candidateLength = length(candidate);
    if (candidateLength > 0.001) return candidate / candidateLength;
    float fallbackLength = length(fallback);
    if (fallbackLength > 0.001) return fallback / fallbackLength;
    return vec2(1.0, 0.0);
}

vec2 directionFromCode(float code, float screenDown) {
    float up = eventEquals(code, 1.0);
    float right = eventEquals(code, 2.0);
    float down = eventEquals(code, 3.0);
    float left = eventEquals(code, 4.0);
    return vec2(right - left, (down - up) * screenDown);
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

float eventLife(float age, float holdUntil, float goneAt) {
    return 1.0 - smoothstep(holdUntil, goneAt, age);
}

vec4 surfaceRegistration(vec2 uv, vec3 visualBackground) {
    vec2 pixel = 1.0 / iResolution.xy;
    vec3 light = vec3(0.0);

    // One cardinal gather keeps the focused idle pass to five total texture
    // reads (base + four neighbors). The same samples identify dark ink drawn
    // on a light type face, avoiding another full-surface neighborhood pass.
    float distancePx = 3.5;
    vec3 north = sourceAt(uv + vec2(0.0, pixel.y * distancePx));
    vec3 south = sourceAt(uv - vec2(0.0, pixel.y * distancePx));
    vec3 east = sourceAt(uv + vec2(pixel.x * distancePx, 0.0));
    vec3 west = sourceAt(uv - vec2(pixel.x * distancePx, 0.0));
    float brassInk = inkAt(north, TOKEN_BRASS, visualBackground) +
        inkAt(south, TOKEN_BRASS, visualBackground) +
        inkAt(east, TOKEN_BRASS, visualBackground) +
        inkAt(west, TOKEN_BRASS, visualBackground);
    float redInk = inkAt(north, TOKEN_VERMILION, visualBackground) +
        inkAt(south, TOKEN_VERMILION, visualBackground) +
        inkAt(east, TOKEN_VERMILION, visualBackground) +
        inkAt(west, TOKEN_VERMILION, visualBackground);
    float cyanInk = inkAt(north, TOKEN_CYAN, visualBackground) +
        inkAt(south, TOKEN_CYAN, visualBackground) +
        inkAt(east, TOKEN_CYAN, visualBackground) +
        inkAt(west, TOKEN_CYAN, visualBackground);
    light += TOKEN_BRASS * brassInk * 0.050;
    light += TOKEN_VERMILION * redInk * 0.041;
    light += TOKEN_CYAN * cyanInk * 0.036;
    float neighborFace = max(
        max(length(north - TOKEN_INK), length(south - TOKEN_INK)),
        max(length(east - TOKEN_INK), length(west - TOKEN_INK))
    );
    return vec4(light, neighborFace);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 pixel = 1.0 / iResolution.xy;
    vec4 base = texture(iChannel0, uv);
    float shortestSide = min(iResolution.x, iResolution.y);

    float owned = busIsOwned();
    vec3 visualBackground = mix(iBackgroundColor, TOKEN_INK, owned);
    vec4 registration = vec4(0.0);
    if (owned > 0.0) registration = surfaceRegistration(uv, visualBackground);
    float coloredInk = smoothstep(0.050, 0.220, length(base.rgb - TOKEN_INK));
    float darkInkMatch = 1.0 - smoothstep(0.025, 0.120, length(base.rgb - TOKEN_INK));
    float darkInkOnFace = darkInkMatch * smoothstep(0.100, 0.320, registration.a);
    float sourceInk = max(coloredInk, darkInkOnFace);
    float negativeSpace = 1.0 - sourceInk;
    vec3 composed = base.rgb;
    vec3 illumination = registration.rgb;

    float kind = byteValue(iPalette[241].r);
    float power = max(0.10, iPalette[241].g);
    float flags = byteValue(iPalette[241].b);
    float eventPhase = iPalette[242].r;
    float packedCampaignRules = byteValue(iPalette[242].g);
    float stageProgress = floor(packedCampaignRules / 16.0) / 15.0;
    float ruleDensity = mod(packedCampaignRules, 16.0) / 15.0;
    float viewportRows = max(1.0, byteValue(iPalette[242].b));
    vec2 anchorBytes = vec2(byteValue(iPalette[243].r), byteValue(iPalette[243].g));
    vec2 bearingCells = anchorBytes - 128.0;
    float packedDirectionReach = byteValue(iPalette[243].b);
    float directionCode = floor(packedDirectionReach / 32.0);
    float reachUnit = mod(packedDirectionReach, 32.0) / 31.0;
    float waveReach = mix(0.12, 0.55, reachUnit);
    float undoFlag = flagBit(flags, 2.0);
    float stageChangeFlag = flagBit(flags, 4.0);
    float restartFlag = flagBit(flags, 8.0);
    float initialLoadFlag = flagBit(flags, 16.0);
    float yDownFlag = flagBit(flags, 32.0);
    float absoluteAnchorFlag = flagBit(flags, 64.0);
    float screenDown = mix(-1.0, 1.0, yDownFlag);

    vec2 rawCurrent = cursorCenter(iCurrentCursor);
    vec2 rawPrevious = cursorCenter(iPreviousCursor);
    // Slot 242 carries terminal rows because Ghostty exposes the trimmed
    // underline sprite, not its cell. The launcher removes explicit padding;
    // any fractional remainder is sub-pixel noise rather than a row-scale bug.
    vec2 cellSize = vec2(
        max(iCurrentCursor.z, 6.0),
        max(max(iCurrentCursor.w, iResolution.y / viewportRows), 10.0)
    );
    vec2 current = cursorCellCenter(iCurrentCursor, cellSize.y, screenDown);
    vec2 previous = cursorCellCenter(iPreviousCursor, cellSize.y, screenDown);
    vec2 cursorDelta = current - previous;
    float focusGate = iFocus > 0 ? 1.0 : 0.0;
    float cursorVisibleGate = iCursorVisible > 0 ? 1.0 : 0.0;
    float cursorReady = focusGate * cursorVisibleGate;
    float age = max(0.0, iTime - iTimeCursorChange);
    vec2 relativeEventCenter = current + vec2(
        bearingCells.x * cellSize.x,
        bearingCells.y * cellSize.y * screenDown
    );
    vec2 absoluteEventCenter = vec2(
        (anchorBytes.x + 0.5) * cellSize.x,
        mix(
            iResolution.y - (anchorBytes.y + 0.5) * cellSize.y,
            (anchorBytes.y + 0.5) * cellSize.y,
            yDownFlag
        )
    );
    vec2 eventCenter = mix(relativeEventCenter, absoluteEventCenter, absoluteAnchorFlag);
    vec2 local = fragCoord - eventCenter;
    vec2 bearingScreen = mix(
        vec2(bearingCells.x, bearingCells.y * screenDown),
        vec2(1.0, 0.0),
        absoluteAnchorFlag
    );
    vec2 direction = safeDirection(
        directionFromCode(directionCode, screenDown),
        safeDirection(cursorDelta, bearingScreen)
    );
    vec2 normal = vec2(-direction.y, direction.x);
    float along = dot(local, direction);
    float across = dot(local, normal);
    float legibleSampleMix = 0.10 + negativeSpace * 0.90;

    float phaseLife = 1.0 - smoothstep(0.76, 0.995, eventPhase);
    float moveLife = owned * cursorReady * eventEquals(kind, 1.0) *
        min(eventLife(age, 0.015, 0.115), phaseLife);
    float pushClock = mix(phaseLife, min(eventLife(age, 0.020, 0.170), phaseLife), cursorVisibleGate);
    float blockedClock = mix(phaseLife, min(eventLife(age, 0.020, 0.230), phaseLife), cursorVisibleGate);
    float pushLife = owned * focusGate * eventEquals(kind, 2.0) * pushClock;
    float blockedLife = owned * focusGate * eventEquals(kind, 3.0) * blockedClock;
    float longCalibration = max(undoFlag, max(stageChangeFlag, max(restartFlag, initialLoadFlag)));
    // Lifecycle calibrations include a 140 ms seating tail beyond ordinary
    // rule changes. Let Ghostty's continuous clock finish both versions just
    // before PocketJS publishes the corresponding idle frame.
    float calibrationGoneAt = mix(0.520, 0.660, longCalibration);
    float calibrateClock = mix(
        phaseLife,
        min(eventLife(age, 0.030, calibrationGoneAt), phaseLife),
        cursorVisibleGate
    );
    float transformClock = mix(phaseLife, min(eventLife(age, 0.020, 0.300), phaseLife), cursorVisibleGate);
    float winClock = mix(phaseLife, min(eventLife(age, 0.030, 0.880), phaseLife), cursorVisibleGate);
    float calibrateLife = owned * focusGate * eventEquals(kind, 4.0) * calibrateClock;
    float transformLife = owned * focusGate * eventEquals(kind, 5.0) * transformClock;
    float winLife = owned * focusGate * eventEquals(kind, 6.0) * winClock;

    // MOVE — the cursor travels between terminal cells, but its wake is sampled
    // at fractional pixels. Cyan and vermilion registration plates lag by
    // different distances, producing detail a cell renderer cannot express.
    if (moveLife > 0.0) {
        float moveProgress = saturate(eventPhase);
        vec2 rawCursorDelta = rawCurrent - rawPrevious;
        float motionLength = length(rawCursorDelta);
        float validMotion = step(0.5, motionLength) * (1.0 - step(shortestSide * 0.42, motionLength));
        float fallbackSpan = cellSize.x * abs(direction.x) + cellSize.y * abs(direction.y);
        vec2 fallbackPrevious = rawCurrent - direction * max(fallbackSpan, 8.0);
        vec2 trailPrevious = mix(fallbackPrevious, rawPrevious, validMotion);
        float trailWidth = max(2.0, cellSize.y * 0.22);
        float moveTrail = 1.0 - smoothstep(
            trailWidth,
            trailWidth + 4.0,
            lineDistance(fragCoord, trailPrevious, rawCurrent)
        );
        vec2 subcellSlip = direction * (1.35 + 3.10 * (1.0 - moveProgress)) +
            normal * sin(moveProgress * PI) * 0.75;
        vec3 moveAhead = sourceAt(uv + subcellSlip * pixel);
        vec3 moveBehind = sourceAt(uv - subcellSlip * pixel * 0.72);
        vec3 moveRegistration = vec3(moveAhead.r, 0.52 * moveAhead.g + 0.48 * moveBehind.g, moveBehind.b);
        float moveRefract = moveLife * moveTrail * power;
        composed = mix(composed, moveRegistration, moveRefract * legibleSampleMix * 0.30);
        float echoFrames = 0.0;
        for (int echoIndex = 1; echoIndex <= 4; ++echoIndex) {
            float echoAmount = float(echoIndex) / 5.0;
            vec2 echoCenter = mix(rawCurrent, trailPrevious, echoAmount);
            vec2 echoHalf = cellSize * vec2(0.42, 0.32) * (1.0 - echoAmount * 0.28);
            echoFrames += softBand(rectangleEdge(fragCoord - echoCenter, echoHalf), 0.0, 1.2) *
                (1.0 - echoAmount) * 0.36;
        }
        illumination += mix(TOKEN_CYAN, TOKEN_PAPER, 0.24) * moveRefract * echoFrames * 0.42;
    }

    // PUSH — the framebuffer is locally squeezed into a traveling accordion.
    // Original ink remains underneath; refracted copies collect in the gaps as
    // if a platen physically compressed the proof in the move direction.
    if (pushLife > 0.0) {
        float pushProgress = saturate(eventPhase);
        float pushAhead = smoothstep(-cellSize.x * 0.90, cellSize.x * 0.10, along) *
            (1.0 - smoothstep(cellSize.x * 4.4, cellSize.x * 5.6, along));
        float pushSide = 1.0 - smoothstep(cellSize.y * 0.55, cellSize.y * 1.85, abs(across));
        float compressionEnvelope = pushAhead * pushSide;
        float compressionWave = sin(along / max(cellSize.x, 1.0) * PI * 1.35 - pushProgress * PI * 3.4);
        float compressionPx = compressionWave * (2.5 + power * 4.0) * compressionEnvelope * pushLife;
        vec3 compressed = sourceAt(uv - direction * compressionPx * pixel);
        composed = mix(composed, compressed, compressionEnvelope * pushLife * legibleSampleMix * 0.38);
        float pressureRibs = pow(
            0.5 + 0.5 * cos(along * 0.42 - pushProgress * TAU * 1.6),
            18.0
        ) * compressionEnvelope;
        float platenEdges = softBand(across, -cellSize.y * 0.70, 1.4) +
            softBand(across, cellSize.y * 0.70, 1.4);
        illumination += TOKEN_BRASS * pushLife * power *
            (pressureRibs * 0.44 + platenEdges * pushAhead * 0.20);
    }

    // BLOCKED — the attempted cell behaves like brittle type metal. A radial
    // refraction lands first, followed by asymmetric hairline cracks and a
    // short edge pulse around the entire Ghostty surface.
    if (blockedLife > 0.0) {
        float blockedProgress = saturate(eventPhase);
        float impactDistance = length(local);
        vec2 impactDirection = safeDirection(local, -direction);
        float impactDisk = 1.0 - smoothstep(cellSize.y * 0.35, cellSize.y * 2.85, impactDistance);
        float impactFront = softBand(impactDistance, cellSize.y * (0.48 + blockedProgress * 1.75), 2.5);
        vec3 fractured = sourceAt(uv + impactDirection * pixel * impactDisk * blockedLife * 4.2);
        composed = mix(composed, fractured, impactDisk * blockedLife * legibleSampleMix * 0.34);
        float crackAngle = atan(impactDirection.y, impactDirection.x);
        float crackWobble = crackAngle * 4.5 + 0.34 * sin(impactDistance * 0.115 + crackAngle * 3.0);
        float crackLine = 1.0 - smoothstep(0.025, 0.115, abs(sin(crackWobble)));
        float crackSector = floor((crackAngle + PI) / TAU * 9.0);
        float crackReach = cellSize.y * (1.20 + hash11(crackSector + 17.0) * 2.20);
        float cracks = crackLine * smoothstep(cellSize.y * 0.28, cellSize.y * 0.50, impactDistance) *
            (1.0 - smoothstep(crackReach * 0.72, crackReach, impactDistance));
        vec2 edgeDistance = min(fragCoord, iResolution.xy - fragCoord);
        float surfaceEdge = 1.0 - smoothstep(
            2.0,
            max(4.0, shortestSide * 0.10),
            min(edgeDistance.x, edgeDistance.y)
        );
        float edgeImpulse = (1.0 - smoothstep(0.0, 0.32, blockedProgress)) * surfaceEdge;
        illumination += TOKEN_VERMILION * blockedLife * power *
            (cracks * 0.76 + impactFront * 0.60 + edgeImpulse * 0.16);
    }

    // CALIBRATE — a proofing roller crosses the whole surface. Pixels under
    // the roller drag sideways, and separate red/cyan ink plates settle just
    // behind it over a very faint paper-fibre field.
    if (calibrateLife > 0.0) {
        float calibrateProgress = saturate(eventPhase);
        float rollerEase = calibrateProgress * calibrateProgress * (3.0 - 2.0 * calibrateProgress);
        float rollerStart = mix(-iResolution.x * 0.08, iResolution.x * 1.08, undoFlag);
        float rollerFinish = mix(iResolution.x * 1.08, -iResolution.x * 0.08, undoFlag);
        float rollerX = mix(rollerStart, rollerFinish, rollerEase);
        float rollerDistance = abs(fragCoord.x - rollerX);
        float roller = 1.0 - smoothstep(2.0, 26.0, rollerDistance);
        float rollerBearing = mix(1.0, -1.0, undoFlag);
        float rollerWakeDistance = (rollerX - fragCoord.x) * rollerBearing;
        float printedWake = smoothstep(-20.0, 26.0, rollerWakeDistance) *
            (1.0 - smoothstep(iResolution.x * 0.48, iResolution.x * 0.98, rollerWakeDistance));
        float transitionWeight = max(stageChangeFlag, max(restartFlag, initialLoadFlag));
        float rollerDragPx = roller * calibrateLife * rollerBearing *
            (3.0 + undoFlag * 3.0 + transitionWeight * 1.5);
        vec3 rollerSample = sourceAt(uv + vec2(rollerDragPx * pixel.x, 0.0));
        vec3 redPlate = sourceAt(uv + vec2(pixel.x * 1.70, pixel.y * 0.45));
        vec3 cyanPlate = sourceAt(uv - vec2(pixel.x * 1.25, pixel.y * 0.35));
        vec3 registered = vec3(redPlate.r, rollerSample.g, cyanPlate.b);
        float calibrationMix = calibrateLife * (roller * 0.48 + printedWake * 0.10);
        composed = mix(composed, registered, calibrationMix * legibleSampleMix);
        float paperFiber = hash21(floor(fragCoord / vec2(4.0, 3.0)));
        float cropRuling = pow(0.5 + 0.5 * cos(fragCoord.y * (0.10 + undoFlag * 0.035)), 48.0);
        illumination += mix(TOKEN_PAPER, TOKEN_CYAN, 0.26) * calibrateLife *
            (roller * 0.31 + printedWake * (0.018 + paperFiber * 0.016 + cropRuling * 0.030));
        float rewindSize = shortestSide * (0.27 - calibrateProgress * 0.23);
        float rewindProof = softBand(
            rectangleEdge(local, vec2(rewindSize, rewindSize * 0.48)),
            0.0,
            2.3
        );
        illumination += TOKEN_CYAN * calibrateLife * rewindProof *
            (0.12 + undoFlag * 0.14 + transitionWeight * 0.05);
    }

    // TRANSFORM — the signature Syntax Loom. A shuttle traverses the active
    // sentence while the terminal texture is woven through two sinusoidal
    // coordinate fields. RGB plates take different paths, creating chromatic
    // moire rather than a portable row animation.
    if (transformLife > 0.0) {
        float transformProgress = saturate(eventPhase);
        float shuttleEase = 1.0 - pow(1.0 - transformProgress, 3.0);
        float shuttleX = mix(-iResolution.x * 0.07, iResolution.x * 1.07, shuttleEase);
        float sentenceHalfHeight = max(cellSize.y * (1.45 + ruleDensity * 1.25), 24.0);
        float sentenceBand = 1.0 - smoothstep(
            sentenceHalfHeight,
            sentenceHalfHeight + cellSize.y * 0.70,
            abs(local.y)
        );
        float shuttle = 1.0 - smoothstep(2.0, 14.0, abs(fragCoord.x - shuttleX));
        float shuttleWake = smoothstep(-18.0, 42.0, shuttleX - fragCoord.x) * sentenceBand;
        vec2 weaveOffsetPx = vec2(
            sin(local.y * 0.235 + transformProgress * TAU * 2.0) * 2.8,
            sin((fragCoord.x - shuttleX) * 0.095 - transformProgress * TAU) * 3.6
        ) * transformLife * (0.42 + shuttleWake * 0.58);
        vec2 weaveUv = uv + weaveOffsetPx * pixel;
        vec3 wovenMiddle = sourceAt(weaveUv);
        vec3 wovenRed = sourceAt(weaveUv + vec2(pixel.x * 2.2, -pixel.y * 0.9));
        vec3 wovenCyan = sourceAt(weaveUv - vec2(pixel.x * 2.0, -pixel.y * 0.8));
        vec3 syntaxSplit = vec3(wovenRed.r, wovenMiddle.g, wovenCyan.b);
        float weaveMix = transformLife * sentenceBand * (0.15 + shuttleWake * 0.30);
        composed = mix(composed, syntaxSplit, weaveMix * legibleSampleMix);
        float warpThread = pow(0.5 + 0.5 * cos((fragCoord.x - eventCenter.x) * 0.105 + sin(local.y * 0.07)), 22.0);
        float weftThread = pow(0.5 + 0.5 * cos(local.y * 0.245 - sin(fragCoord.x * 0.045)), 26.0);
        float moire = abs(warpThread - weftThread) * sentenceBand;
        illumination += TOKEN_CYAN * transformLife * power * moire * 0.18;
        illumination += TOKEN_VERMILION * transformLife * power *
            warpThread * sentenceBand * (0.08 + shuttle * 0.20);
        illumination += mix(TOKEN_BRASS, TOKEN_PAPER, 0.35) * transformLife * power *
            shuttle * sentenceBand * 0.74;
    }

    // WIN — one rectangular proof wave reaches every corner regardless of
    // aspect ratio. The wave refracts the full framebuffer, splits its color
    // plates, and leaves a temporary paper/halftone wash inside the proof.
    if (winLife > 0.0) {
        float winProgress = saturate(eventPhase);
        float winEase = 1.0 - pow(1.0 - winProgress, 3.0);
        vec2 proofCoordinate = abs(local) / iResolution.xy;
        float proofMetric = max(proofCoordinate.x, proofCoordinate.y);
        float proofRadius = mix(0.012, 1.08, winEase);
        float proofFront = 1.0 - smoothstep(0.008, 0.026, abs(proofMetric - proofRadius));
        float proofEchoA = 1.0 - smoothstep(0.006, 0.018, abs(proofMetric - max(0.0, proofRadius - 0.055)));
        float proofEchoB = 1.0 - smoothstep(0.005, 0.015, abs(proofMetric - max(0.0, proofRadius - 0.105)));
        float proofInside = 1.0 - smoothstep(proofRadius - 0.075, proofRadius, proofMetric);
        vec2 proofDirection = safeDirection(local / iResolution.xy, vec2(1.0, 0.0));
        vec2 proofSlip = proofDirection * pixel * proofFront * winLife * (4.0 + power * 5.0);
        vec3 proofMiddle = sourceAt(uv - proofSlip);
        vec3 proofRed = sourceAt(uv - proofSlip + vec2(pixel.x * 2.4, 0.0));
        vec3 proofCyan = sourceAt(uv - proofSlip - vec2(pixel.x * 2.4, 0.0));
        vec3 proofRegistration = vec3(proofRed.r, proofMiddle.g, proofCyan.b);
        composed = mix(composed, proofRegistration, proofFront * winLife * legibleSampleMix * 0.46);
        float proofHatch = pow(0.5 + 0.5 * cos(dot(fragCoord, vec2(0.075, 0.075))), 36.0);
        float paperWash = proofInside * winLife * (0.030 + proofHatch * 0.028);
        composed = mix(composed, mix(composed, TOKEN_PAPER, 0.14), paperWash * (0.45 + negativeSpace * 0.55));
        vec3 proofColor = mix(TOKEN_BRASS, TOKEN_CYAN, 0.38 + stageProgress * 0.18);
        illumination += proofColor * winLife * power *
            (proofFront * 0.80 + proofEchoA * 0.40 + proofEchoB * 0.20);
        float cornerFlash = (1.0 - smoothstep(0.0, 0.12, winProgress)) *
            pow(max(abs((fragCoord.x / iResolution.x) * 2.0 - 1.0), abs((fragCoord.y / iResolution.y) * 2.0 - 1.0)), 10.0);
        illumination += TOKEN_PAPER * winLife * cornerFlash * 0.12;
    }

    // Event-local ruled paper is intentionally quiet. It binds effects to the
    // semantic anchor without competing with the loom and proof-wave moments.
    float activeEvent = saturate(moveLife + pushLife + blockedLife + calibrateLife + transformLife + winLife);
    float ruleLine = pow(0.5 + 0.5 * cos(fragCoord.y * 0.105), 42.0);
    float eventField = 1.0 - smoothstep(
        shortestSide * waveReach * 0.35,
        shortestSide * waveReach,
        length(local)
    );
    illumination += mix(iForegroundColor, TOKEN_CYAN, 0.55) * activeEvent * eventField * ruleLine * 0.020;

    // Readability is the non-negotiable boundary: original glyphs and borders
    // always remain in `composed`, additive effects fall to 11% over ink, and
    // the source alpha is copied exactly. Refracted copies live mostly in the
    // negative space around that intact source.
    illumination *= mix(1.0, 0.11, sourceInk);
    fragColor = vec4(clamp(composed + illumination, vec3(0.0), vec3(1.0)), base.a);
}
