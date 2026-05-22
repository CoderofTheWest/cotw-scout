/**
 * openclaw-plugin-embodiment
 *
 * Gives Clint a physical body via TonyPi Pro humanoid robot on the LAN.
 * Connects to a Flask REST API running on the Pi (server.py on port 8420).
 *
 * Provides:
 * - Body state polling (IMU, battery, orientation) injected into context
 * - Intentional action tools (walk, wave, bow, turn, etc.)
 * - Head control (pan/tilt in degrees)
 * - Scene detection (MediaPipe face + YOLOv5n object detection on Pi)
 * - Native multimodal visual understanding via image tool results
 * - Emergency stop
 *
 * Body state is injected via prependContext as [BODY STATE] block.
 * When the Pi is unreachable, body state gracefully shows "disconnected".
 *
 * Multi-agent: State scoped per agent via agentId.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const dgram = require('dgram');
const { instrumentApiHooks } = require('../lib/runtime-metrics');

// Optional fallback VLM path. The primary embodiment vision path is native
// multimodal tool output to the active runtime (GPT-5.5/omni in COTW).
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'qwen3-vl:235b-cloud';

// Optional unified vision service for depth/service-based scans.
const VISION_SERVICE_URL = process.env.VISION_SERVICE_URL || 'http://localhost:8421';
// Legacy aliases — both point to unified service
const DEPTH_SERVICE_URL = process.env.DEPTH_SERVICE_URL || VISION_SERVICE_URL;
const VLM_SERVICE_URL = process.env.VLM_SERVICE_URL || VISION_SERVICE_URL;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig(userConfig = {}) {
    const defaultConfig = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')
    );
    // Omit keys that should pass through without merging
    const passthrough = { agents: true };
    const merged = { ...defaultConfig };
    for (const key of Object.keys(userConfig)) {
        if (passthrough[key]) {
            merged[key] = userConfig[key]; // Use user value directly
        } else {
            merged[key] = userConfig[key]; // Also use user value for other keys
        }
    }
    return merged;
}

// ---------------------------------------------------------------------------
// Response size cap — circuit breaker for context bloat
// ---------------------------------------------------------------------------

function capResponse(text, maxBytes = 2048) {
    if (text.length <= maxBytes) return text;
    return text.slice(0, maxBytes) + '\n[TRUNCATED — ' + text.length + ' bytes]';
}

function normalizeFrameImage(frameData) {
    const raw = frameData?.image || frameData?.data || '';
    const dataUrlMatch = typeof raw === 'string' ? raw.match(/^data:([^;]+);base64,(.+)$/) : null;
    const mimeType = frameData?.mimeType || frameData?.mime_type || dataUrlMatch?.[1] || 'image/jpeg';
    const data = dataUrlMatch ? dataUrlMatch[2] : raw;
    if (!data) return null;
    return { data, mimeType };
}

async function captureNativeVisionFrame(config) {
    const frameResult = await piRequest(config, 'GET', '/camera/frame');
    return normalizeFrameImage(frameResult.data);
}

function buildNativeVisionContent(image, question) {
    const prompt = String(question || 'Describe what you see.').trim();
    return [
        {
            type: 'text',
            text: `Use your native multimodal vision model to inspect this TonyPi camera frame and answer: ${prompt}`,
        },
        {
            type: 'image',
            data: image.data,
            mimeType: image.mimeType,
        },
    ];
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function summarizeSensors(data) {
    if (!data || typeof data !== 'object') return 'sensor read unavailable';
    const parts = [];
    if (data.orientation) {
        parts.push(data.orientation.upright ? 'upright' : 'not upright');
        if (data.orientation.pitch != null || data.orientation.roll != null) {
            parts.push(`pitch=${data.orientation.pitch ?? '?'} roll=${data.orientation.roll ?? '?'}`);
        }
    } else if (data.imu?.error) {
        parts.push(`imu=${data.imu.error}`);
    }
    if (data.battery) {
        parts.push(`battery=${data.battery.level || data.battery.voltage_v || 'unknown'}`);
    }
    if (data.distance) {
        parts.push(`front_ultrasonic=${data.distance.zone || data.distance.cm || 'unknown'}`);
    }
    return parts.join(', ') || 'sensor read ok';
}

function frontUltrasonicZone(snapshot) {
    if (!snapshot?.sensors?.ok) return null;
    return snapshot.sensors.data?.distance?.zone || null;
}

function isFrontUltrasonicClear(snapshot) {
    const zone = frontUltrasonicZone(snapshot);
    return zone !== 'contact' && zone !== 'close';
}

function summarizeObjects(data) {
    const objects = Array.isArray(data?.objects) ? data.objects : [];
    if (objects.length === 0) return 'objects=none';
    return 'objects=' + objects.slice(0, 8).map(o => {
        const cls = o.class || o.label || 'object';
        const region = o.region ? `@${o.region}` : '';
        const conf = Number.isFinite(o.confidence) ? `:${Math.round(o.confidence * 100)}%` : '';
        return `${cls}${region}${conf}`;
    }).join(', ');
}

function objectSignature(data) {
    const objects = Array.isArray(data?.objects) ? data.objects : [];
    return objects
        .map(o => `${o.class || o.label || 'object'}:${o.region || 'unknown'}`)
        .sort()
        .join('|');
}

const PILOT_FRAME_WIDTH = 640;
const PILOT_FRAME_HEIGHT = 480;

function normalizeDetectionName(object) {
    return String(object?.class || object?.label || object?.name || 'object').trim().toLowerCase();
}

function normalizeDetectionConfidence(object) {
    const raw = object?.confidence ?? object?.conf ?? object?.score;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    if (n > 1 && n <= 100) return n / 100;
    return clampNumber(n, 0, 1, null);
}

function classifyAxis(value, lowLabel, midLabel, highLabel) {
    if (value == null) return null;
    if (value < 0.34) return lowLabel;
    if (value > 0.66) return highLabel;
    return midLabel;
}

function regionParts(region) {
    const r = String(region || '').toLowerCase();
    return {
        horizontal: r.includes('left') ? 'left' : r.includes('right') ? 'right' : r.includes('center') ? 'center' : null,
        vertical: r.includes('floor') || r.includes('bottom') || r.includes('low') ? 'floor' : r.includes('top') || r.includes('high') ? 'top' : r.includes('mid') ? 'mid' : null,
    };
}

function normalizeAxisCoord(value, size) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n >= 0 && n <= 1) return { value: n, frame: 'normalized' };
    if (n >= 0 && n <= size * 2) return { value: clampNumber(n / size, 0, 1, null), frame: 'assumed_640x480' };
    return null;
}

function firstFinite(...values) {
    for (const value of values) {
        if (value == null || value === '') continue;
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

function normalizeBox(rawBox) {
    let x1 = null;
    let y1 = null;
    let x2 = null;
    let y2 = null;

    if (Array.isArray(rawBox) && rawBox.length >= 4) {
        const [a, b, c, d] = rawBox.map(Number);
        if ([a, b, c, d].every(Number.isFinite)) {
            x1 = a;
            y1 = b;
            if (c > a && d > b) {
                x2 = c;
                y2 = d;
            } else {
                x2 = a + Math.abs(c);
                y2 = b + Math.abs(d);
            }
        }
    } else if (rawBox && typeof rawBox === 'object') {
        x1 = firstFinite(rawBox.x1, rawBox.left, rawBox.x, rawBox.cx != null && rawBox.width != null ? rawBox.cx - rawBox.width / 2 : null);
        y1 = firstFinite(rawBox.y1, rawBox.top, rawBox.y, rawBox.cy != null && rawBox.height != null ? rawBox.cy - rawBox.height / 2 : null);
        x2 = firstFinite(rawBox.x2, rawBox.right, rawBox.width != null && x1 != null ? x1 + Number(rawBox.width) : null);
        y2 = firstFinite(rawBox.y2, rawBox.bottom, rawBox.height != null && y1 != null ? y1 + Number(rawBox.height) : null);
    }

    if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return null;
    const nx1 = normalizeAxisCoord(x1, PILOT_FRAME_WIDTH);
    const nx2 = normalizeAxisCoord(x2, PILOT_FRAME_WIDTH);
    const ny1 = normalizeAxisCoord(y1, PILOT_FRAME_HEIGHT);
    const ny2 = normalizeAxisCoord(y2, PILOT_FRAME_HEIGHT);
    if (!nx1 || !nx2 || !ny1 || !ny2) return null;

    const left = Math.min(nx1.value, nx2.value);
    const right = Math.max(nx1.value, nx2.value);
    const top = Math.min(ny1.value, ny2.value);
    const bottom = Math.max(ny1.value, ny2.value);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    return {
        centerX: left + width / 2,
        centerY: top + height / 2,
        areaRatio: width * height,
        coordinateFrame: [nx1, nx2, ny1, ny2].some(v => v.frame === 'assumed_640x480') ? 'assumed_640x480' : 'normalized',
    };
}

function visualObjectMetrics(object) {
    if (!object || typeof object !== 'object') return null;
    const name = normalizeDetectionName(object);
    const confidence = normalizeDetectionConfidence(object);
    const region = object.region ? String(object.region).toLowerCase() : null;
    const box = normalizeBox(object.bbox || object.box || object.bounding_box || object.xyxy || object.bounds || object);
    const rawX = firstFinite(object.center_x, object.centerX, object.cx, object.x);
    const rawY = firstFinite(object.center_y, object.centerY, object.cy, object.y);
    const nx = box?.centerX != null ? { value: box.centerX, frame: box.coordinateFrame } : normalizeAxisCoord(rawX, PILOT_FRAME_WIDTH);
    const ny = box?.centerY != null ? { value: box.centerY, frame: box.coordinateFrame } : normalizeAxisCoord(rawY, PILOT_FRAME_HEIGHT);
    const parts = regionParts(region);
    const horizontal = nx?.value != null ? classifyAxis(nx.value, 'left', 'center', 'right') : parts.horizontal;
    const vertical = ny?.value != null ? classifyAxis(ny.value, 'top', 'mid', 'floor') : parts.vertical;
    const interactionCue = vertical === 'floor' && ((box?.areaRatio ?? 0) >= 0.12 || (ny?.value ?? 0) >= 0.78)
        ? 'interaction_assessment_ready'
        : vertical === 'floor'
            ? 'low_in_frame_not_aligned_range'
            : 'approach_visual_only';

    return {
        name,
        confidence,
        region,
        horizontal,
        vertical,
        centerX: nx?.value ?? null,
        centerY: ny?.value ?? null,
        areaRatio: box?.areaRatio ?? null,
        coordinateFrame: box?.coordinateFrame || nx?.frame || ny?.frame || (region ? 'region_only' : 'unknown'),
        interactionCue,
    };
}

function inferPilotTarget(args = {}) {
    const explicit = String(args.target || '').trim().toLowerCase();
    if (explicit) return explicit;
    const text = [args.intent, args.question, args.hypothesis].filter(Boolean).join(' ').toLowerCase();
    const candidates = ['bowl', 'cup', 'ball', 'bottle', 'box', 'mat', 'chair', 'person', 'door', 'stairs', 'cabinet', 'table'];
    return candidates.find(candidate => text.includes(candidate)) || null;
}

function pickVisualTarget(snapshot, targetHint) {
    const objects = Array.isArray(snapshot?.objects?.data?.objects)
        ? snapshot.objects.data.objects
        : Array.isArray(snapshot?.objects)
            ? snapshot.objects
            : [];
    const metrics = objects.map(visualObjectMetrics).filter(Boolean);
    if (metrics.length === 0) return null;
    const hint = String(targetHint || '').toLowerCase();
    const candidates = hint ? metrics.filter(metric => metric.name.includes(hint)) : metrics;
    if (candidates.length === 0) return null;
    return candidates
        .map(metric => {
            let score = metric.confidence ?? 0;
            if (hint && metric.name.includes(hint)) score += metric.name === hint ? 6 : 5;
            if (!hint && ['bowl', 'cup', 'ball', 'bottle', 'box'].includes(metric.name)) score += 1.5;
            if (metric.vertical === 'floor') score += 0.8;
            if (metric.horizontal === 'center') score += 0.2;
            if (metric.areaRatio != null) score += Math.min(metric.areaRatio, 0.4);
            return { metric, score };
        })
        .sort((a, b) => b.score - a.score)[0].metric;
}

function compactVisualMetrics(metric) {
    if (!metric) return null;
    return {
        name: metric.name,
        confidence: metric.confidence == null ? null : Number(metric.confidence.toFixed(3)),
        region: metric.region,
        horizontal: metric.horizontal,
        vertical: metric.vertical,
        centerX: metric.centerX == null ? null : Number(metric.centerX.toFixed(3)),
        centerY: metric.centerY == null ? null : Number(metric.centerY.toFixed(3)),
        areaRatio: metric.areaRatio == null ? null : Number(metric.areaRatio.toFixed(4)),
        coordinateFrame: metric.coordinateFrame,
        interactionCue: metric.interactionCue,
    };
}

function compareRegions(pre, post) {
    const verticalRank = { top: 0, mid: 1, floor: 2 };
    const horizontalRank = { left: -1, center: 0, right: 1 };
    return {
        verticalDelta: pre?.vertical && post?.vertical ? (verticalRank[post.vertical] ?? 0) - (verticalRank[pre.vertical] ?? 0) : null,
        horizontalDelta: pre?.horizontal && post?.horizontal ? (horizontalRank[post.horizontal] ?? 0) - (horizontalRank[pre.horizontal] ?? 0) : null,
    };
}

function percent(value) {
    if (value == null) return null;
    return `${Math.round(value * 100)}%`;
}

function describeTarget(metric) {
    if (!metric) return 'target not detected';
    const parts = [metric.name];
    if (metric.vertical || metric.horizontal) parts.push(`${metric.vertical || '?'}-${metric.horizontal || '?'}`);
    if (metric.areaRatio != null) parts.push(`footprint=${percent(metric.areaRatio)}`);
    if (metric.confidence != null) parts.push(`conf=${percent(metric.confidence)}`);
    return parts.join(' ');
}

function buildVisualCalibration(pre, post, args, previousCalibration = null) {
    const targetHint = inferPilotTarget(args);
    const preTarget = pickVisualTarget(pre, targetHint);
    const postTarget = pickVisualTarget(post, targetHint);
    const regionDelta = compareRegions(preTarget, postTarget);
    const centerDelta = preTarget && postTarget && preTarget.centerX != null && postTarget.centerX != null && preTarget.centerY != null && postTarget.centerY != null
        ? {
            x: Number((postTarget.centerX - preTarget.centerX).toFixed(3)),
            y: Number((postTarget.centerY - preTarget.centerY).toFixed(3)),
        }
        : null;
    const areaRatioDelta = preTarget?.areaRatio != null && postTarget?.areaRatio != null
        ? Number((postTarget.areaRatio - preTarget.areaRatio).toFixed(4))
        : null;
    const confidenceDelta = preTarget?.confidence != null && postTarget?.confidence != null
        ? Number((postTarget.confidence - preTarget.confidence).toFixed(3))
        : null;

    const progress = [];
    if (!preTarget && !postTarget) {
        progress.push(targetHint ? `${targetHint} was not detected in cheap vision; use the returned native frame before estimating range.` : 'No stable target selected in cheap vision; use the returned native frame before estimating range.');
    } else if (!preTarget && postTarget) {
        progress.push(`${describeTarget(postTarget)} appeared after the tick.`);
    } else if (preTarget && !postTarget) {
        progress.push(`${describeTarget(preTarget)} disappeared after the tick; do not infer approach progress from motion alone.`);
    } else {
        if (areaRatioDelta != null && Math.abs(areaRatioDelta) >= 0.015) {
            progress.push(areaRatioDelta > 0 ? 'target footprint grew in frame, likely approach progress.' : 'target footprint shrank in frame, likely backing away or head/body angle changed.');
        }
        if (centerDelta?.y != null && Math.abs(centerDelta.y) >= 0.05) {
            progress.push(centerDelta.y > 0 ? 'target moved lower in frame.' : 'target moved higher in frame.');
        } else if (regionDelta.verticalDelta != null && regionDelta.verticalDelta !== 0) {
            progress.push(regionDelta.verticalDelta > 0 ? 'target moved to a lower frame band.' : 'target moved to a higher frame band.');
        }
        if (centerDelta?.x != null && Math.abs(centerDelta.x) >= 0.05) {
            progress.push(centerDelta.x > 0 ? 'target shifted right in frame.' : 'target shifted left in frame.');
        }
        if (progress.length === 0) {
            progress.push('target visual footprint changed little; one TonyPi gait step may be small relative to target distance.');
        }
        if (postTarget.horizontal === 'right') progress.push('target remains right/off-axis; avoid right drift.');
        if (postTarget.interactionCue === 'interaction_assessment_ready') {
            progress.push('target is low/large enough for interaction assessment; prefer look-down or arm-action planning over more forward approach.');
        } else if (postTarget.vertical === 'floor') {
            progress.push('target is low in frame but not clearly interaction-ready.');
        }
    }

    const prior = previousCalibration?.post?.name ? `previous target was ${previousCalibration.post.name}` : null;
    return {
        targetHint,
        pre: compactVisualMetrics(preTarget),
        post: compactVisualMetrics(postTarget),
        delta: {
            center: centerDelta,
            areaRatio: areaRatioDelta,
            confidence: confidenceDelta,
            verticalBand: regionDelta.verticalDelta,
            horizontalBand: regionDelta.horizontalDelta,
        },
        progressLanguage: progress.join(' '),
        targetSummary: `pre=${describeTarget(preTarget)}; post=${describeTarget(postTarget)}`,
        scaleReminder: 'Use TonyPi gait steps, body lengths, frame bands, and interaction range. Do not translate image distance into human walking steps.',
        prior,
    };
}

async function optionalPiRequest(config, method, endpoint, body = null, timeoutMs = 10000) {
    try {
        const result = await piRequest(config, method, endpoint, body, timeoutMs);
        return { ok: true, data: result.data };
    } catch (e) {
        const message = e.message || String(e);
        return { ok: false, error: message, timeout: /timeout/i.test(message) };
    }
}

async function readPilotSnapshot(config) {
    const [sensors, objects] = await Promise.all([
        optionalPiRequest(config, 'GET', '/sensors', null, 5000),
        optionalPiRequest(config, 'GET', '/camera/detect_objects', null, 5000),
    ]);
    return {
        at: new Date().toISOString(),
        sensors,
        objects,
    };
}

function summarizePilotSnapshot(snapshot) {
    const sensorText = snapshot.sensors.ok ? summarizeSensors(snapshot.sensors.data) : `sensors failed=${snapshot.sensors.error}`;
    const objectText = snapshot.objects.ok ? summarizeObjects(snapshot.objects.data) : `objects failed=${snapshot.objects.error}`;
    return `${sensorText}; ${objectText}`;
}

function summarizePilotAction(action, result) {
    if (!action || action.kind === 'none') return 'no physical action';
    if (!result.ok) return `${action.kind} failed=${result.error}`;
    const d = result.data || {};
    if (action.kind === 'body_action') {
        const fb = d.feedback || {};
        const prop = d.proprioception || {};
        const parts = [`action=${action.name}`];
        if (fb.contact?.length) parts.push(`contact=${fb.contact.map(c => c.joint || c).join(',')}`);
        if (fb.scene_change?.detected) parts.push('scene_changed=true');
        if (prop.confidence != null) parts.push(`confidence=${prop.confidence}`);
        if (prop.servo_error?.max_error != null) parts.push(`servo_error=${prop.servo_error.max_error}`);
        return parts.join(', ');
    }
    if (action.kind === 'navigate') {
        return `navigate=${action.direction}, steps=${d.steps_taken ?? 0}/${d.steps_requested ?? action.steps}, stopped=${d.stopped_reason || 'unknown'}, zone=${d.final_zone || 'unknown'}`;
    }
    if (action.kind === 'look') {
        return `look pan=${action.pan} tilt=${action.tilt}`;
    }
    if (action.kind === 'stop') return 'stop issued';
    return `${action.kind} complete`;
}

function requestedPilotSteps(action) {
    if (action?.kind !== 'navigate') return 0;
    return clampNumber(action.steps, 1, 1, 1);
}

function confirmedPilotSteps(action, result) {
    if (action?.kind !== 'navigate' || !result?.ok) return 0;
    const d = result.data || {};
    const taken = Number(d.steps_taken);
    if (Number.isFinite(taken)) return clampNumber(taken, 0, requestedPilotSteps(action), 0);
    return ['complete', 'completed', 'target_reached'].includes(String(d.stopped_reason || '').toLowerCase())
        ? requestedPilotSteps(action)
        : 0;
}

function buildMovementAccounting(action, actionResult) {
    const requested = requestedPilotSteps(action);
    if (requested === 0) {
        return {
            last: { requestedSteps: 0, confirmedSteps: 0, ambiguousSteps: 0, failedSteps: 0, state: 'no_locomotion' },
            recoveryStop: null,
        };
    }

    const confirmed = confirmedPilotSteps(action, actionResult);
    const timeout = Boolean(actionResult?.timeout);
    const failed = !actionResult?.ok && !timeout ? requested : 0;
    const ambiguous = timeout ? Math.max(0, requested - confirmed) : 0;
    const state = timeout
        ? 'timeout_ambiguous_recovered'
        : !actionResult?.ok
            ? 'failed'
            : confirmed >= requested
                ? 'confirmed_complete'
                : 'partial_or_stopped';

    return {
        last: {
            requestedSteps: requested,
            confirmedSteps: confirmed,
            ambiguousSteps: ambiguous,
            failedSteps: failed,
            state,
        },
        recoveryStop: actionResult?.recoveryStop
            ? {
                attempted: true,
                ok: actionResult.recoveryStop.ok,
                error: actionResult.recoveryStop.ok ? null : actionResult.recoveryStop.error,
            }
            : null,
    };
}

function updatePilotMovementStats(state, movementAccounting) {
    if (!state?.pilotMovementStats || !movementAccounting?.last) return null;
    const last = movementAccounting.last;
    state.pilotMovementStats.attemptedSteps += last.requestedSteps || 0;
    state.pilotMovementStats.confirmedSteps += last.confirmedSteps || 0;
    state.pilotMovementStats.ambiguousSteps += last.ambiguousSteps || 0;
    state.pilotMovementStats.failedSteps += last.failedSteps || 0;
    state.pilotMovementStats.lastUpdatedAt = new Date().toISOString();
    return { ...state.pilotMovementStats };
}

function summarizeMovementAccounting(movementAccounting, movementTotals, movementGoalSteps = null) {
    const last = movementAccounting?.last || {};
    const totals = movementTotals || {};
    const parts = [
        `last requested=${last.requestedSteps ?? 0}`,
        `confirmed=${last.confirmedSteps ?? 0}`,
        `ambiguous=${last.ambiguousSteps ?? 0}`,
        `state=${last.state || 'unknown'}`,
        `session confirmed=${totals.confirmedSteps ?? 0}`,
        `ambiguous=${totals.ambiguousSteps ?? 0}`,
    ];
    const goal = Number(movementGoalSteps);
    if (Number.isFinite(goal) && goal > 0) parts.push(`goal=${totals.confirmedSteps ?? 0}/${goal}`);
    if (movementAccounting?.recoveryStop?.attempted) {
        parts.push(`timeout_stop=${movementAccounting.recoveryStop.ok ? 'ok' : `failed:${movementAccounting.recoveryStop.error}`}`);
    }
    return parts.join(', ');
}

function normalizePilotAction(argsAction = {}) {
    const kind = argsAction.kind || 'none';
    if (kind === 'body_action') {
        return {
            kind,
            name: String(argsAction.name || '').trim(),
            repeat: 1,
        };
    }
    if (kind === 'navigate') {
        return {
            kind,
            direction: ['forward', 'backward', 'left', 'right'].includes(argsAction.direction) ? argsAction.direction : 'forward',
            steps: clampNumber(argsAction.steps, 1, 1, 1),
            stop_zone: ['contact', 'close', 'near'].includes(argsAction.stop_zone) ? argsAction.stop_zone : 'close',
        };
    }
    if (kind === 'look') {
        return {
            kind,
            pan: clampNumber(argsAction.pan, -90, 90, 0),
            tilt: clampNumber(argsAction.tilt, -30, 30, 0),
            duration: clampNumber(argsAction.duration, 100, 1000, 300),
        };
    }
    if (kind === 'stop') return { kind };
    return { kind: 'none' };
}

async function runPilotAction(config, action) {
    if (!action || action.kind === 'none') return { ok: true, data: null };
    if (action.kind === 'body_action') {
        if (!action.name) return { ok: false, error: 'missing action name' };
        return optionalPiRequest(config, 'POST', '/action', { name: action.name, repeat: 1 }, 15000);
    }
    if (action.kind === 'navigate') {
        const result = await optionalPiRequest(config, 'POST', '/navigate', {
            direction: action.direction,
            steps: 1,
            stop_zone: action.stop_zone,
        }, 20000);
        if (!result.ok && result.timeout) {
            result.recoveryStop = await optionalPiRequest(config, 'POST', '/stop', {}, 3000);
        }
        return result;
    }
    if (action.kind === 'look') {
        return optionalPiRequest(config, 'POST', '/servos/head', {
            pan: action.pan,
            tilt: action.tilt,
            duration: action.duration,
        }, 5000);
    }
    if (action.kind === 'stop') {
        return optionalPiRequest(config, 'POST', '/stop', {}, 5000);
    }
    return { ok: false, error: `unsupported pilot action kind: ${action.kind}` };
}

function buildPilotLearning(pre, post, action, actionResult, movementAccounting = null) {
    const hardStopCodes = [];
    const cautionCodes = [];

    if (actionResult && !actionResult.ok) {
        if (actionResult.timeout && action?.kind === 'navigate') {
            cautionCodes.push('movement_timeout_ambiguous');
        } else {
            hardStopCodes.push('action_error');
        }
    }

    const d = actionResult?.data || {};
    const fb = d.feedback || {};
    const prop = d.proprioception || d.proprioception_summary || {};
    const postOrientation = post.sensors.ok ? post.sensors.data?.orientation : null;

    if (postOrientation && postOrientation.upright === false) {
        hardStopCodes.push('not_upright_after_action');
    }
    if (fb.contact?.length) {
        hardStopCodes.push('contact_detected');
    }
    if (prop.confidence != null && prop.confidence < 0.7) {
        if (prop.confidence < 0.3) hardStopCodes.push('critical_proprioceptive_confidence');
        else if (prop.confidence < 0.5) cautionCodes.push('very_low_proprioceptive_confidence');
        else cautionCodes.push('low_proprioceptive_confidence');
    }
    if (prop.servo_error?.max_error != null && prop.servo_error.max_error > 30) {
        if (prop.servo_error.max_error > 80) hardStopCodes.push('high_servo_resistance');
        else cautionCodes.push('servo_resistance');
    }
    if (d.stalled) {
        hardStopCodes.push('navigation_stalled');
    }
    if (d.stopped_reason && !['complete', 'completed', 'target_reached'].includes(String(d.stopped_reason))) {
        const stopped = String(d.stopped_reason);
        if (/contact|collision|fall|stall|error/i.test(stopped)) {
            hardStopCodes.push(`stopped_${stopped}`);
        } else {
            cautionCodes.push(`stopped_${stopped}`);
        }
    }

    const preSig = pre.objects.ok ? objectSignature(pre.objects.data) : '';
    const postSig = post.objects.ok ? objectSignature(post.objects.data) : '';
    const sceneChanged = preSig !== postSig || Boolean(fb.scene_change?.detected);

    if (action?.kind === 'body_action' && !sceneChanged && hardStopCodes.length === 0) {
        cautionCodes.push('no_detected_scene_change');
    }

    const success = hardStopCodes.length === 0;
    const reasonCodes = [...hardStopCodes, ...cautionCodes];
    const frontClear = isFrontUltrasonicClear(post);
    const movementAmbiguous = (movementAccounting?.last?.ambiguousSteps || 0) > 0 || cautionCodes.includes('movement_timeout_ambiguous');
    const nextSuggestion = hardStopCodes.length > 0
        ? 'Stop physical progression and inspect: use a look/observe or reflect tick before any more movement.'
        : movementAmbiguous
            ? 'Movement outcome is ambiguous: count no confirmed step for the timeout, use one observe/recovery tick, then continue only if upright, visually clear, and the target remains safely framed.'
        : cautionCodes.length > 0
            ? `Continue cautiously: prefer one look/observe tick, or one smaller corrective tick if upright, front ultrasonic is ${frontClear ? 'clear' : 'not clear'}, and the action reduces risk. Do not treat front ultrasonic as target distance for low/off-axis objects.`
            : 'Use the current frame and post-action snapshot to choose the next small tick.';

    return {
        success,
        sceneChanged,
        reasonCodes,
        hardStopCodes,
        cautionCodes,
        nextSuggestion,
    };
}

function resolvePilotJournalPath() {
    const root = process.env.OPENCLAW_WORKSPACE || process.cwd();
    return path.join(root, 'projects', 'embodiment', 'pilot-ticks.jsonl');
}

function appendPilotReceipt(receipt) {
    const journalPath = resolvePilotJournalPath();
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.appendFileSync(journalPath, JSON.stringify(receipt) + '\n');
    return journalPath;
}

// ---------------------------------------------------------------------------
// HTTP Client — lightweight, no dependencies
// ---------------------------------------------------------------------------

function piRequest(config, method, endpoint, body = null, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: config.piHost,
            port: config.piPort,
            path: endpoint,
            method: method,
            headers: { 'Content-Type': 'application/json' },
            timeout: timeoutMs,
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Ollama HTTP Client — for VLM image understanding
// ---------------------------------------------------------------------------

function ollamaRequest(body, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const url = new URL(OLLAMA_URL);
        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: '/api/generate',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed.response || '');
                } catch (e) {
                    resolve(data);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`Ollama timeout (${timeoutMs / 1000}s)`)); });
        req.write(JSON.stringify(body));
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Vision Service HTTP Client — for Depth Pro + FastVLM (port 8421)
// ---------------------------------------------------------------------------

function visionServiceRequest(baseUrl, endpoint, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(baseUrl);
        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: endpoint,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Vision service response parse error: ${data.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Vision service timeout (30s)')); });
        req.write(JSON.stringify(body));
        req.end();
    });
}

// ---------------------------------------------------------------------------
// WorldModel — fused perception state from streaming UDP data
// ---------------------------------------------------------------------------

class WorldModel {
    constructor() {
        // Object tracking with temporal smoothing
        this.objects = new Map(); // cls → {confidence, region, lastSeen, streak}
        this._yoloHistory = new Map(); // cls → bool[3] ring buffer

        // Spatial awareness
        this.obstacles = { frontCm: null, zone: null, leftClear: true, rightClear: true };
        this.orientation = { pitch: 0, roll: 0, upright: true, headingDelta: 0 };
        this.motion = { moving: false, gait: null, stepsTaken: 0 };

        // Servo proprioception
        this.servos = {}; // {id: position} — latest known positions
        this._servoBaseline = {
            1: 500, 2: 390, 3: 500, 4: 600, 5: 500, 6: 575,
            7: 800, 8: 725, 9: 500, 10: 610, 11: 500, 12: 400,
            13: 500, 14: 425, 15: 200, 16: 275, 17: 500, 18: 500,
        };
        this._servoRegions = {
            'arms': [6, 7, 8, 14, 15, 16],
            'hands': [17, 18],
            'legs': [1, 2, 3, 4, 5, 9, 10, 11, 12, 13],
        };

        // Confidence degrades with staleness
        this.confidence = 0;
        this.lastUpdate = 0;

        // Surprise events — consumed on each summary() call
        this.events = [];
        this._lastSummaryText = '';
        this._lastZone = null;
    }

    ingest(data) {
        if (!data || !data.t) return;
        const now = Date.now();
        this.lastUpdate = now;

        switch (data.t) {
            case 'yolo': this._ingestYOLO(data.v || [], data.ts || now); break;
            case 'ultra': this._ingestUltrasonic(data.v, data.ts || now); break;
            case 'imu': this._ingestIMU(data.v || [], data.ts || now); break;
            case 'servo': this._ingestServo(data.v || {}, data.ts || now); break;
        }
        this._updateConfidence(now);
    }

    // Per-class minimum confidence for temporal smoothing.
    // "person" is YOLO's most overfit class — requires higher confidence.
    static _classConfThresholds = { person: 0.50 };
    static _defaultConfThreshold = 0.30;

    _ingestYOLO(detections, ts) {
        // Build map of currently detected classes with confidence
        const seenMap = new Map();
        for (const d of detections) {
            const thresh = WorldModel._classConfThresholds[d.cls] ?? WorldModel._defaultConfThreshold;
            if ((d.conf || 0) >= thresh) {
                seenMap.set(d.cls, d);
            }
        }

        // Update ring buffers for temporal smoothing (2/3 agreement)
        const allClasses = new Set([...this._yoloHistory.keys(), ...seenMap.keys()]);
        for (const cls of allClasses) {
            if (!this._yoloHistory.has(cls)) {
                this._yoloHistory.set(cls, [false, false, false]);
            }
            const buf = this._yoloHistory.get(cls);
            buf.push(seenMap.has(cls));
            if (buf.length > 3) buf.shift();

            const agreeing = buf.filter(Boolean).length;
            const wasPresent = this.objects.has(cls);

            if (agreeing >= 2 && !wasPresent) {
                // Object appeared
                const det = seenMap.get(cls);
                this.objects.set(cls, {
                    confidence: det?.conf || 0.5,
                    region: det?.region || 'center',
                    lastSeen: ts,
                    streak: agreeing,
                });
                this.events.push(`appeared: ${cls}`);
            } else if (agreeing < 2 && wasPresent) {
                // Object gone
                this.objects.delete(cls);
                this.events.push(`gone: ${cls}`);
            } else if (agreeing >= 2 && wasPresent) {
                // Update existing
                const det = seenMap.get(cls);
                const obj = this.objects.get(cls);
                obj.confidence = det?.conf || obj.confidence;
                obj.region = det?.region || obj.region;
                obj.lastSeen = ts;
                obj.streak = agreeing;
            }
        }
    }

    _ingestUltrasonic(cm, ts) {
        if (cm == null || cm < 0) return;
        this.obstacles.frontCm = Math.round(cm);

        // Zone classification
        let zone;
        if (cm < 10) zone = 'contact';
        else if (cm < 25) zone = 'close';
        else if (cm < 60) zone = 'near';
        else if (cm < 150) zone = 'medium';
        else zone = 'far';

        // Event on zone transition
        if (this._lastZone && zone !== this._lastZone) {
            if (zone === 'contact' || zone === 'close') {
                this.events.push(`obstacle ${zone} (${this.obstacles.frontCm}cm)`);
            } else if (this._lastZone === 'contact' || this._lastZone === 'close') {
                this.events.push(`obstacle cleared (${this.obstacles.frontCm}cm)`);
            }
        }
        this._lastZone = zone;
        this.obstacles.zone = zone;
    }

    _ingestIMU(values, ts) {
        if (!values || values.length < 6) return;
        const [ax, ay, az, gx, gy, gz] = values;

        const prevUpright = this.orientation.upright;
        this.orientation.pitch = Math.round(ay * 100) / 100;
        this.orientation.roll = Math.round(ax * 100) / 100;
        // Upright if accelerometer Z is dominant and pitch/roll are small
        this.orientation.upright = Math.abs(az) > 0.7 && Math.abs(ay) < 0.5 && Math.abs(ax) < 0.5;

        if (prevUpright && !this.orientation.upright) {
            this.events.push('NOT UPRIGHT');
        } else if (!prevUpright && this.orientation.upright) {
            this.events.push('recovered upright');
        }
    }

    _ingestServo(positions, ts) {
        // positions is {id_string: value} — store as numbers
        for (const [id, pos] of Object.entries(positions)) {
            this.servos[parseInt(id)] = pos;
        }
    }

    /**
     * Summarize servo deviation from baseline.
     * Only reports regions where servos have moved significantly.
     */
    _servoDeviation() {
        const THRESHOLD = 30; // Only report deviations > this many units
        const regionDeviations = {};

        for (const [region, ids] of Object.entries(this._servoRegions)) {
            let maxDev = 0;
            for (const id of ids) {
                if (this.servos[id] != null && this._servoBaseline[id] != null) {
                    const dev = Math.abs(this.servos[id] - this._servoBaseline[id]);
                    maxDev = Math.max(maxDev, dev);
                }
            }
            if (maxDev > THRESHOLD) {
                regionDeviations[region] = maxDev;
            }
        }
        return regionDeviations;
    }

    _updateConfidence(now) {
        const ageMs = now - this.lastUpdate;
        if (ageMs < 1000) this.confidence = 1.0;
        else if (ageMs < 3000) this.confidence = 0.8;
        else if (ageMs < 5000) this.confidence = 0.5;
        else this.confidence = 0.2;
    }

    /**
     * Surprise-over-state summary.
     * Reports changes/unexpected signals prominently. Steady state = minimal heartbeat.
     * Events are NOT consumed here — call consumeEvents() after successful injection.
     */
    summary(mode = 'navigate') {
        const parts = ['[BODY]'];
        const now = Date.now();

        // Staleness check
        if (this.lastUpdate === 0 || (now - this.lastUpdate) > 5000) {
            return null; // No data or stale — let fallback handle it
        }

        // Always: events first (surprises)
        if (this.events.length > 0) {
            parts.push(this.events.join(', '));
        }

        // Obstacle — only if close/contact
        if (this.obstacles.zone === 'contact' || this.obstacles.zone === 'close') {
            parts.push(`obstacle ${this.obstacles.zone} ${this.obstacles.frontCm}cm`);
        }

        // Orientation — only if not upright
        if (!this.orientation.upright) {
            parts.push('NOT UPRIGHT');
        }

        // Objects — only new appearances (handled in events), but list current if in experiment mode
        if (mode === 'experiment' && this.objects.size > 0) {
            const objs = [...this.objects.entries()].map(([cls, o]) => `${cls}(${o.region})`).join(' ');
            parts.push(`see: ${objs}`);
        }

        // Experiment mode: raw values
        if (mode === 'experiment') {
            if (this.obstacles.frontCm != null) {
                parts.push(`dist:${this.obstacles.frontCm}cm`);
            }
            parts.push(`pitch:${this.orientation.pitch} roll:${this.orientation.roll}`);
        }

        // Motion state
        if (this.motion.moving) {
            parts.push(`moving:${this.motion.gait || 'unknown'}`);
        }

        // Servo proprioception — report regions with significant deviation
        const devs = this._servoDeviation();
        if (Object.keys(devs).length > 0) {
            const devStr = Object.entries(devs).map(([r, d]) => `${r}:${d}`).join(' ');
            parts.push(`pose(${devStr})`);
        }

        // Steady state: minimal heartbeat so Clint knows he has a body
        if (parts.length === 1) {
            parts.push('steady');
        }

        const text = parts.join(', ');
        return text;
    }

    /** Consume pending events — call after summary is successfully injected */
    consumeEvents() {
        this.events = [];
    }

    hasChanged() {
        const current = this.summary() || '';
        const changed = current !== this._lastSummaryText;
        this._lastSummaryText = current;
        return changed;
    }

    /** Check if WorldModel has fresh data (for fallback decisions) */
    isFresh() {
        return this.lastUpdate > 0 && (Date.now() - this.lastUpdate) < 5000;
    }
}

// ---------------------------------------------------------------------------
// Per-agent state
// ---------------------------------------------------------------------------

class AgentBodyState {
    constructor(agentId) {
        this.agentId = agentId;
        this.connected = false;
        this.lastPoll = null;
        this.lastSensors = null;
        this.lastScene = null;
        this.lastSceneTime = 0;
        this.eventLog = [];
        this.lastInjectedHash = null;
        this.movementInProgress = false;  // Movement Lock flag
        this.lastActionResult = null;     // Last action result for confidence scoring
        this.lastVisualCalibration = null; // Last pilot tick target/frame progress estimate
        this.pilotMovementStats = {
            attemptedSteps: 0,
            confirmedSteps: 0,
            ambiguousSteps: 0,
            failedSteps: 0,
            lastUpdatedAt: null,
        };
        this.worldModel = new WorldModel();
        this.embodimentMode = 'navigate'; // 'navigate' or 'experiment'
    }

    logEvent(type, detail) {
        this.eventLog.push({
            time: new Date().toISOString(),
            type,
            detail,
        });
        // Keep last 50 events
        if (this.eventLog.length > 50) {
            this.eventLog = this.eventLog.slice(-50);
        }
    }

    // Compact summary for context injection (~15-30 tokens)
    formatSummary() {
        if (!this.connected) return null; // Don't inject when disconnected

        const parts = ['[BODY]'];

        // Movement Lock — suppress sensor confusion during actions
        if (this.movementInProgress) {
            parts.push('MOVING — sensors blinding. Trust: scene_changed > IMU > stalled. Do not reason about ultrasonic during leg-lift.');
        }

        if (this.lastSensors?.orientation) {
            parts.push(this.lastSensors.orientation.upright ? 'upright' : 'not upright');
        }
        if (this.lastSensors?.battery) {
            parts.push(`battery ${this.lastSensors.battery.level}`);
        }

        // Distance — only surface when actionable (close/contact) AND not moving
        if (!this.movementInProgress && this.lastSensors?.distance) {
            const d = this.lastSensors.distance;
            if (d.zone === 'contact' || d.zone === 'close') {
                parts.push(`obstacle ${d.zone}`);
            }
        }

        // Voice — surface pending commands (high priority)
        if (this.lastSensors?.voice?.commands?.length) {
            const names = this.lastSensors.voice.commands.map(c => c.name);
            parts.push(`HEARD: ${names.join(', ')}`);
        }

        // Only include scene if fresh (within 30s)
        if (this.lastScene && (Date.now() - this.lastSceneTime) < 30000) {
            if (this.lastScene.face_count > 0) {
                parts.push(`${this.lastScene.face_count} face(s) visible`);
            }
        }

        return parts.join(', ');
    }

    // Hash for change detection — only inject when state meaningfully changes
    getStateHash() {
        return JSON.stringify({
            c: this.connected,
            u: this.lastSensors?.orientation?.upright,
            b: this.lastSensors?.battery?.level,
            v: this.lastSensors?.voice?.commands?.length || 0,
            f: this.lastScene?.face_count || 0,
            d: this.lastSensors?.distance?.zone || null,
        });
    }

    // Full block — kept for body_sense tool output, not for injection
    formatBodyState() {
        if (!this.connected) {
            return '[BODY STATE]\nStatus: disconnected — TonyPi not reachable on LAN\n[/BODY STATE]';
        }

        const lines = ['[BODY STATE]'];
        lines.push(`Status: connected (last poll: ${this.lastPoll || 'never'})`);

        if (this.lastSensors) {
            const s = this.lastSensors;
            if (s.orientation) {
                lines.push(`Orientation: pitch=${s.orientation.pitch}° roll=${s.orientation.roll}° upright=${s.orientation.upright}`);
            }
            if (s.battery) {
                lines.push(`Battery: ${s.battery.voltage_v}V (${s.battery.level})`);
            }
        }

        if (this.lastScene) {
            const sc = this.lastScene;
            if (sc.face_count > 0) {
                const faces = sc.faces.map(f => `face(${f.x},${f.y} conf=${f.confidence})`).join(', ');
                lines.push(`Scene: ${sc.face_count} face(s) detected — ${faces}`);
            } else {
                lines.push('Scene: no faces detected');
            }
        }

        lines.push('[/BODY STATE]');
        return lines.join('\n');
    }
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

const agentStates = new Map();

function getState(agentId) {
    const id = agentId || 'default';
    if (!agentStates.has(id)) {
        agentStates.set(id, new AgentBodyState(id));
    }
    return agentStates.get(id);
}

function register(api) {
    api = instrumentApiHooks(api, 'embodiment');
    const config = loadConfig(api.config || {});

    // Agent filter: only load for specified agents (if configured)
    const allowedAgents = config.agents || null;  // Only use config.agents (array of strings)
    const currentAgent = api.agentId || 'unknown';
    if (allowedAgents && Array.isArray(allowedAgents) && !allowedAgents.includes(currentAgent)) {
        console.log(`[Embodiment] Skipping load for agent '${currentAgent}' (not in allowed list)`);
        return;
    }
    let pollTimer = null;

    console.log(`[Embodiment] Connecting to TonyPi at ${config.piHost}:${config.piPort}`);

    // ─── Polling timer ──────────────────────────────────────────
    // Self-contained timer (same pattern as nightshift — NOT a heartbeat hook)

    async function pollBodyState() {
        for (const [agentId, state] of agentStates) {
            try {
                const result = await piRequest(config, 'GET', '/sensors');
                state.connected = true;
                state.lastSensors = result.data;
                state.lastPoll = new Date().toISOString();
            } catch (e) {
                state.connected = false;
            }
        }
    }

    if (config.polling?.enabled) {
        // Initial poll
        setTimeout(async () => {
            // Bootstrap: ensure at least one agent state exists
            if (agentStates.size === 0) {
                getState('clint');
            }
            await pollBodyState();
            const state = agentStates.values().next().value;
            console.log(`[Embodiment] Initial poll: ${state.connected ? 'CONNECTED' : 'DISCONNECTED'}`);
            if (state.connected && state.lastSensors?.battery) {
                console.log(`[Embodiment] Battery: ${state.lastSensors.battery.voltage_v}V`);
            }
        }, 2000);

        pollTimer = setInterval(pollBodyState, config.polling.intervalMs || 15000);
        pollTimer.unref();
    }

    // ─── UDP streaming receiver ──────────────────────────────────
    let udpServer = null;

    if (config.streaming?.enabled) {
        const udpPort = config.streaming.udpPort || 8424;
        udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        udpServer.on('message', (msg) => {
            try {
                const data = JSON.parse(msg.toString());
                // Feed all agent states (typically just 'clint')
                for (const [, state] of agentStates) {
                    state.worldModel.ingest(data);
                }
            } catch (e) {
                // Malformed packet — ignore silently
            }
        });

        udpServer.on('error', (err) => {
            console.error(`[Embodiment] UDP error: ${err.message}`);
            udpServer.close();
            udpServer = null;
        });

        udpServer.bind(udpPort, () => {
            console.log(`[Embodiment] UDP streaming receiver listening on port ${udpPort}`);
        });

        udpServer.unref(); // Don't block process shutdown
    }

    // ─── SSE walk stream consumer ──────────────────────────────

    function consumeWalkStream(config, body) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify(body);
            const req = http.request({
                hostname: config.piHost,
                port: config.piPort,
                path: '/walk_stream',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'Accept': 'text/event-stream',
                },
                timeout: 60000,
            }, (res) => {
                let buffer = '';
                let completeData = null;

                res.on('data', (chunk) => {
                    buffer += chunk.toString();
                    // Parse SSE events from buffer
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // Keep incomplete line

                    let eventType = null;
                    for (const line of lines) {
                        if (line.startsWith('event: ')) {
                            eventType = line.slice(7).trim();
                        } else if (line.startsWith('data: ') && eventType) {
                            try {
                                const data = JSON.parse(line.slice(6));
                                if (eventType === 'step') {
                                    // Update WorldModel with per-step data
                                    for (const [, state] of agentStates) {
                                        if (data.distance_cm != null) {
                                            state.worldModel._ingestUltrasonic(data.distance_cm, Date.now());
                                        }
                                        state.worldModel.motion.moving = true;
                                        state.worldModel.motion.stepsTaken = data.step;
                                    }
                                } else if (eventType === 'complete') {
                                    completeData = data;
                                    for (const [, state] of agentStates) {
                                        state.worldModel.motion.moving = false;
                                    }
                                }
                            } catch (e) { /* malformed event data */ }
                            eventType = null;
                        } else if (line === '') {
                            eventType = null;
                        }
                    }
                });

                res.on('end', () => {
                    if (completeData) {
                        resolve(completeData);
                    } else {
                        reject(new Error('Walk stream ended without complete event'));
                    }
                });

                res.on('error', reject);
            });

            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Walk stream timeout')); });
            req.write(postData);
            req.end();
        });
    }

    // ─── Context injection ──────────────────────────────────────

    api.on('before_agent_start', (event, ctx) => {
        try {
            const state = getState(ctx.agentId);

            if (!config.polling?.injectBodyState) return {};

            // Priority 1: WorldModel (streaming) — if fresh, use surprise-over-state
            if (config.streaming?.enabled && state.worldModel.isFresh()) {
                const wmSummary = state.worldModel.summary(state.embodimentMode);
                if (wmSummary) {
                    // Dedup: don't re-inject identical summary
                    if (wmSummary === state.lastInjectedHash) return {};
                    state.lastInjectedHash = wmSummary;
                    state.worldModel.consumeEvents();
                    return { prependSystemContext: wmSummary };
                }
                // WorldModel returned null = nothing interesting. No injection.
                return {};
            }

            // Priority 2: Fallback to HTTP polling path
            if (!state.connected) return {};

            const hash = state.getStateHash();
            if (hash === state.lastInjectedHash) return {};

            const summary = state.formatSummary();
            if (summary) {
                state.lastInjectedHash = hash;
                state.lastScene = null;
                return { prependSystemContext: summary };
            }

            return {};
        } catch (e) {
            console.error('[Embodiment] before_agent_start error:', e.message);
            return {};
        }
    });

    // ─── Tools ──────────────────────────────────────────────────

    // body_action — run any ActionGroup
    api.registerTool({
        name: 'body_action',
        description: 'Make your body perform a physical action. Available actions include: wave, bow, stand, squat, go_forward, back, turn_left, turn_right, left_kick, right_kick, chest, stepping, sit_ups, stand_slow, twist, wing_chun, and many more. Use body_list_actions to see all available actions.',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Action name (e.g., "wave", "bow", "go_forward", "turn_left")'
                },
                repeat: {
                    type: 'integer',
                    description: 'How many times to repeat (default 1)',
                    default: 1
                }
            },
            required: ['name']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            state.movementInProgress = true;  // Movement Lock: START
            try {
                const result = await piRequest(config, 'POST', '/action', {
                    name: args.name,
                    repeat: args.repeat || 1,
                });
                state.logEvent('action', args.name);
                const fb = result.data.feedback || {};
                const parts = [args.name];

                // Pose summary
                if (fb.pose) {
                    const poseStr = Object.entries(fb.pose).map(([k, v]) => `${k}=${v}`).join(' ');
                    parts.push(poseStr);
                }

                // Contact detection
                if (fb.contact && fb.contact.length > 0) {
                    const contacts = fb.contact.map(c => c.joint).join(', ');
                    parts.push(`CONTACT: ${contacts}`);
                }

                // Scene change
                if (fb.scene_change && fb.scene_change.detected) {
                    const regions = Object.keys(fb.scene_change.regions || {}).join(', ');
                    parts.push(`scene changed: ${regions}`);
                }

                // Proprioceptive feedback
                const prop = result.data.proprioception;
                if (prop) {
                    if (prop.confidence < 0.7) parts.push(`CONFIDENCE: ${prop.confidence}`);
                    if (prop.servo_error?.max_error > 30) parts.push(`RESISTANCE: ${prop.servo_error.max_joint}`);
                }

                // Store last action result for confidence scoring
                state.lastActionResult = {
                    success: true,
                    sceneChanged: fb.scene_change?.detected,
                    confidence: prop?.confidence,
                };

                return { content: [{ type: 'text', text: parts.join(' | ') }] };
            } catch (e) {
                state.lastActionResult = { success: false, error: e.message };
                return { content: [{ type: 'text', text: `Body action failed: ${e.message}` }] };
            } finally {
                state.movementInProgress = false;  // Movement Lock: END
            }
        }
    }, { name: 'body_action' });

    // body_state — proprioception on demand
    api.registerTool({
        name: 'body_state',
        description: 'Check your body pose — where are your arms, legs, and stance right now. Returns semantic summary of all joint positions. Use this to know your physical state without performing an action.',
        parameters: {
            type: 'object',
            properties: {}
        },
        execute: async (_id, _args) => {
            const state = getState('clint');
            try {
                const result = await piRequest(config, 'GET', '/body/state');
                const pose = result.data.pose || {};
                const parts = Object.entries(pose).map(([k, v]) => `${k}=${v}`);
                return { content: [{ type: 'text', text: parts.join(', ') }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Body state read failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_state' });

    // body_look — set head pan/tilt
    api.registerTool({
        name: 'body_look',
        description: 'Move your head to look in a direction. Pan: -90 (left) to +90 (right). Tilt: -30 (down) to +30 (up). 0,0 = looking straight ahead.',
        parameters: {
            type: 'object',
            properties: {
                pan: {
                    type: 'number',
                    description: 'Horizontal angle in degrees. Negative = left, positive = right.'
                },
                tilt: {
                    type: 'number',
                    description: 'Vertical angle in degrees. Negative = down, positive = up.'
                },
                duration: {
                    type: 'integer',
                    description: 'Movement duration in milliseconds (default 300)',
                    default: 300
                }
            },
            required: ['pan', 'tilt']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            try {
                const result = await piRequest(config, 'POST', '/servos/head', {
                    pan: args.pan,
                    tilt: args.tilt,
                    duration: args.duration || 300,
                });
                state.logEvent('look', `pan=${args.pan} tilt=${args.tilt}`);
                return { content: [{ type: 'text', text: `ok pan=${args.pan}° tilt=${args.tilt}°` }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Head movement failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_look' });

    // body_sense — read all sensors
    api.registerTool({
        name: 'body_sense',
        description: 'Read your body\'s sensors: IMU (orientation, pitch, roll, upright status), battery level, and more. Use this to check your physical state.',
        parameters: {
            type: 'object',
            properties: {}
        },
        execute: async (_id, _args) => {
            const state = getState('clint');
            try {
                const result = await piRequest(config, 'GET', '/sensors');
                state.connected = true;
                state.lastSensors = result.data;
                state.lastPoll = new Date().toISOString();
                // Compact summary instead of raw JSON (~60 bytes vs ~1200)
                const d = result.data;
                const parts = [];
                if (d.orientation) {
                    parts.push(d.orientation.upright ? 'upright' : 'NOT UPRIGHT');
                    parts.push(`pitch=${d.orientation.pitch}° roll=${d.orientation.roll}°`);
                } else if (d.imu?.error) {
                    parts.push(`IMU: ${d.imu.error}`);
                } else {
                    parts.push('IMU: no data');
                }
                if (d.battery) {
                    parts.push(`battery ${d.battery.voltage_v}V (${d.battery.level})`);
                } else {
                    parts.push('battery: no data');
                }
                if (d.distance) {
                    parts.push(`distance: ${d.distance.zone}`);
                }
                return { content: [{ type: 'text', text: parts.join(', ') }] };
            } catch (e) {
                state.connected = false;
                return { content: [{ type: 'text', text: `Sensor read failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_sense' });

    // body_detect_scene — face + object detection (Tier 1 reflex vision)
    api.registerTool({
        name: 'body_detect_scene',
        description: 'Use your eyes to detect faces and objects in your field of view. Returns face count and identified objects (80 common classes: person, bottle, cup, chair, phone, etc.). Fast reflex-level vision on the Pi (~250ms). Set force=true to bypass WorldModel cache and get a fresh frame. For deeper understanding of what you see, use body_look_closely instead.',
        parameters: {
            type: 'object',
            properties: {
                force: {
                    type: 'boolean',
                    description: 'Force fresh capture from Pi camera (default false — uses WorldModel cache if streaming is active and data is fresh)',
                    default: false
                }
            }
        },
        execute: async (_id, args) => {
            const state = getState('clint');

            // If not forced and WorldModel has fresh YOLO data, return from cache
            if (!args.force && config.streaming?.enabled && state.worldModel.isFresh() && state.worldModel.objects.size > 0) {
                const objs = [...state.worldModel.objects.entries()].map(([cls, o]) => `${cls}(${o.region})`).join(', ');
                const summary = `faces: ${state.worldModel.objects.has('person') ? 1 : 0}, objects: ${objs || 'none'} [from WorldModel]`;
                state.logEvent('detect', summary);
                return { content: [{ type: 'text', text: summary }] };
            }

            try {
                // Run face detection and object detection in parallel
                const [faceResult, objResult] = await Promise.all([
                    piRequest(config, 'GET', '/camera/detect'),
                    piRequest(config, 'GET', '/camera/detect_objects'),
                ]);
                state.lastScene = faceResult.data;
                state.lastSceneTime = Date.now();

                const faces = faceResult.data.face_count || 0;
                const detectedObjects = objResult.data.objects || [];
                const objects = detectedObjects.map(o => `${o.class}(${o.region})`).join(', ');

                const summary = `faces: ${faces}, objects: ${objects || 'none'}`;
                state.logEvent('detect', summary);
                return { content: [{ type: 'text', text: summary }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Scene detection failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_detect_scene' });

    // body_capture_frame — native multimodal frame handoff
    api.registerTool({
        name: 'body_capture_frame',
        description: 'Capture the current TonyPi camera frame and return it to your native multimodal model as an image. Primary path for GPT-5.5/omni embodiment: use this when you need to inspect the scene directly instead of routing through a secondary VLM service.',
        parameters: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description: 'Optional focus for visual inspection, such as "is the floor clear?" or "what objects are near my feet?"',
                }
            }
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            try {
                const image = await captureNativeVisionFrame(config);
                if (!image) {
                    return { content: [{ type: 'text', text: 'Camera unavailable — no frame captured' }] };
                }
                state.logEvent('capture_frame', args.question || 'native multimodal frame');
                return { content: buildNativeVisionContent(image, args.question) };
            } catch (e) {
                return { content: [{ type: 'text', text: `Frame capture failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_capture_frame' });

    // body_look_closely — native multimodal first, secondary services optional
    api.registerTool({
        name: 'body_look_closely',
        description: 'Use your visual cortex to understand what you see. Default/native mode captures a frame and returns it to your multimodal runtime (GPT-5.5/omni) for direct inspection. Use detail="fast" only for the optional local VLM service, or detail="detailed" for the legacy Ollama cloud VLM fallback.',
        parameters: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description: 'What to look for or ask about the scene (e.g., "what is on the floor?", "is there a wire near my feet?", "describe what you see")'
                },
                detail: {
                    type: 'string',
                    enum: ['native', 'fast', 'detailed'],
                    description: 'native (default, GPT-5.5/omni sees the frame directly), fast (optional local VLM service), or detailed (legacy Ollama cloud VLM fallback)',
                }
            },
            required: ['question']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            const detail = args.detail || 'native';
            try {
                // 1. Capture frame
                const image = await captureNativeVisionFrame(config);

                if (!image) {
                    return { content: [{ type: 'text', text: 'Camera unavailable — no frame captured' }] };
                }

                if (detail === 'native') {
                    state.logEvent('look_closely', `[native] ${args.question}`);
                    return { content: buildNativeVisionContent(image, args.question) };
                }

                let vlmResponse;

                if (detail === 'fast') {
                    // Tier 2: Try FastVLM via VLM service (port 8422)
                    try {
                        const result = await visionServiceRequest(VLM_SERVICE_URL, '/vlm', {
                            image: image.data,
                            question: args.question
                        });
                        vlmResponse = result.response || '';
                    } catch (fastErr) {
                        // Fallback to Ollama vision if the local service is unavailable.
                        vlmResponse = await ollamaRequest({
                            model: OLLAMA_VISION_MODEL,
                            prompt: args.question,
                            images: [image.data],
                            stream: false,
                            options: { num_predict: 100 }
                        });
                    }
                } else {
                    // Tier 3: Detailed — use cloud VLM via Ollama (qwen3-vl or configured model)
                    const detailModel = process.env.OLLAMA_DETAIL_VISION_MODEL || 'qwen3-vl:235b-cloud';
                    vlmResponse = await ollamaRequest({
                        model: detailModel,
                        prompt: args.question,
                        images: [image.data],
                        stream: false,
                        options: { num_predict: 200 }
                    }, 120000);  // 2 minutes for large cloud model
                }

                state.logEvent('look_closely', `[${detail}] ${args.question}`);

                // Return ONLY the text description (no base64 in context)
                return { content: [{ type: 'text', text: capResponse(vlmResponse, 1024) }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Visual analysis failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_look_closely' });

    // body_depth — Depth estimation (Tier 2, DepthAnything V2 on Mac)
    api.registerTool({
        name: 'body_depth',
        description: 'Get a depth map of what you see. Returns a 5x3 grid showing distance zones (contact/close/near/far) for each region of your visual field — top/mid/floor rows, left to right. Use for: obstacle awareness, finding gaps to walk through, understanding spatial layout before navigating. Fast (~200ms). Requires depth service running on Mac.',
        parameters: {
            type: 'object',
            properties: {}
        },
        execute: async (_id, _args) => {
            const state = getState('clint');
            try {
                // 1. Capture frame from Pi
                const frameResult = await piRequest(config, 'GET', '/camera/frame');
                const imageBase64 = frameResult.data.image;
                if (!imageBase64) {
                    return { content: [{ type: 'text', text: 'Camera unavailable — no frame captured' }] };
                }

                // 2. Send to Depth Pro service on Mac (port 8421)
                const d = await visionServiceRequest(DEPTH_SERVICE_URL, '/depth', { image: imageBase64 });

                if (d.error) {
                    return { content: [{ type: 'text', text: `Depth estimation failed: ${d.error}` }] };
                }

                // 3. Format as compact text grid — ZONES ONLY, no raw cm arrays
                const labels = ['top', 'mid', 'floor'];
                let text = 'depth:\n';
                for (let r = 0; r < 3; r++) {
                    text += `  ${labels[r]}: ${d.grid[r].join(' ')}\n`;
                }
                text += `nearest: ${d.nearest_zone}, floor: ${d.floor_clear ? 'clear' : 'blocked'}`;

                state.logEvent('depth', `nearest=${d.nearest_zone}`);
                return { content: [{ type: 'text', text: capResponse(text, 200) }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Depth estimation unavailable: ${e.message}` }] };
            }
        }
    }, { name: 'body_depth' });

    // body_scan — optional unified depth + scene service path
    api.registerTool({
        name: 'body_scan',
        description: 'Get a complete scan: depth grid + structured scene analysis in one call. Returns depth zones (3x5 grid), scene description, detected objects with positions/distances, hazards, path clearance, and best direction. More informative than body_depth alone. ~2-3s latency.',
        parameters: {
            type: 'object',
            properties: {}
        },
        execute: async (_id, _args) => {
            const state = getState('clint');
            try {
                const frameResult = await piRequest(config, 'GET', '/camera/frame');
                const imageBase64 = frameResult.data.image;
                if (!imageBase64) {
                    return { content: [{ type: 'text', text: 'Camera unavailable — no frame captured' }] };
                }

                const result = await visionServiceRequest(VISION_SERVICE_URL, '/scan', { image: imageBase64 });

                let text = '';

                // Depth grid
                if (result.depth && result.depth.grid) {
                    const labels = ['top', 'mid', 'floor'];
                    text += 'depth:\n';
                    for (let r = 0; r < 3; r++) {
                        text += `  ${labels[r]}: ${result.depth.grid[r].join(' ')}\n`;
                    }
                    text += `  nearest: ${result.depth.nearest_obstacle_zone || result.depth.nearest_zone}, floor: ${result.depth.floor_clear ? 'clear' : 'blocked'}\n`;
                }

                // Scene
                if (result.scene) {
                    text += `scene: ${result.scene.summary}\n`;
                    if (result.scene.objects && result.scene.objects.length > 0) {
                        text += 'objects:\n';
                        for (const obj of result.scene.objects) {
                            text += `  - ${obj.name} (${obj.position}, ${obj.distance})\n`;
                        }
                    }
                    if (result.scene.hazards && result.scene.hazards.length > 0) {
                        text += `hazards: ${result.scene.hazards.join(', ')}\n`;
                    }
                    text += `path: ${result.scene.path_clear ? 'clear' : 'blocked'}, best: ${result.scene.best_direction}\n`;
                }

                // Timing
                if (result.inference_ms) {
                    text += `timing: ${result.inference_ms.total}ms total`;
                }

                state.logEvent('scan', `depth=${result.depth?.nearest_obstacle_zone || 'N/A'} scene=${result.scene?.summary?.substring(0, 40) || 'N/A'}`);
                return { content: [{ type: 'text', text: capResponse(text, 800) }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Scan failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_scan' });

    // body_map — Occupancy grid state (persistent spatial memory)
    api.registerTool({
        name: 'body_map',
        description: 'Get your spatial memory map. Shows known free/occupied cells around you, your position and heading, and the best direction with most open space. Accumulates across scans — gives you memory of where you have been and what obstacles you know about.',
        parameters: {
            type: 'object',
            properties: {
                compact: {
                    type: 'boolean',
                    description: 'If true, returns a one-line compact summary instead of full grid data'
                }
            }
        },
        execute: async (_id, args) => {
            try {
                const endpoint = args.compact ? '/map/compact' : '/map';
                const result = await piRequest(config, 'GET', endpoint);

                if (args.compact) {
                    return { content: [{ type: 'text', text: result.data.map || 'Map unavailable' }] };
                }

                const d = result.data;
                let text = `map: pos=(${d.robot.x},${d.robot.y}) heading=${d.robot.heading}°\n`;
                text += `known: ${d.stats.known_cells}/${d.stats.total_cells} cells, ${d.stats.steps_taken} steps\n`;
                text += `local: ${d.local.free} free, ${d.local.occupied} blocked, ${d.local.unknown} unknown\n`;
                text += `best path: ${d.local.best_direction} (${d.local.best_distance_cm}cm clear)`;

                return { content: [{ type: 'text', text }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Map unavailable: ${e.message}` }] };
            }
        }
    }, { name: 'body_map' });

    // body_list_actions — cached + categorized summary
    let _actionCache = null;
    api.registerTool({
        name: 'body_list_actions',
        description: 'List all physical actions your body can perform. Returns categorized summary of ActionGroup names you can pass to body_action.',
        parameters: {
            type: 'object',
            properties: {}
        },
        execute: async (_id, _args) => {
            try {
                if (_actionCache) {
                    return { content: [{ type: 'text', text: _actionCache }] };
                }
                const result = await piRequest(config, 'GET', '/actions');
                const actions = result.data.actions || [];
                // Categorize by name patterns
                const cats = {
                    walk: [], turn: [], strafe: [], pose: [],
                    recovery: [], combat: [], athletics: [],
                    grab: [], carry: [], other: []
                };
                for (const a of actions) {
                    if (/go_forward|^back/.test(a)) cats.walk.push(a);
                    else if (/turn_/.test(a)) cats.turn.push(a);
                    else if (/left_move|right_move/.test(a)) cats.strafe.push(a);
                    else if (/stand|bow|wave|squat|sit|chest|twist|stepping|lie/.test(a)) cats.pose.push(a);
                    else if (/stand_up/.test(a)) cats.recovery.push(a);
                    else if (/kick|shot|uppercut|wing_chun|push_ups|sit_ups/.test(a)) cats.combat.push(a);
                    else if (/climb|hurdle|down_floor|creep/.test(a)) cats.athletics.push(a);
                    else if (/grab|seize|lift|put_|move_up/.test(a)) cats.grab.push(a);
                    else if (/catch_ball/.test(a)) cats.carry.push(a);
                    else cats.other.push(a);
                }
                const lines = [`Actions (${actions.length} total):`];
                for (const [cat, items] of Object.entries(cats)) {
                    if (items.length > 0) {
                        const show = items.slice(0, 4).join(', ');
                        const extra = items.length > 4 ? ` +${items.length - 4} more` : '';
                        lines.push(`  ${cat}: ${show}${extra}`);
                    }
                }
                lines.push('Use body_action with any name above.');
                _actionCache = lines.join('\n');
                return { content: [{ type: 'text', text: _actionCache }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Failed to list actions: ${e.message}` }] };
            }
        }
    }, { name: 'body_list_actions' });

    // body_stop — emergency stop
    api.registerTool({
        name: 'body_stop',
        description: 'Emergency stop. Immediately halts all physical actions and returns to standing pose. Use when something is wrong or you need to stop moving immediately.',
        parameters: {
            type: 'object',
            properties: {}
        },
        execute: async (_id, _args) => {
            const state = getState('clint');
            try {
                const result = await piRequest(config, 'POST', '/stop', {});
                state.logEvent('stop', 'emergency stop');
                return { content: [{ type: 'text', text: 'stopped' }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Emergency stop failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_stop' });

    // body_track_face — PID face tracking (reflex layer)
    api.registerTool({
        name: 'body_track_face',
        description: 'Start or stop automatic face tracking. When active, your head automatically follows the most prominent face using fast PID-controlled servo movements (~30ms reflex loop on the Pi). You do NOT need to manually adjust with body_look — the tracking runs autonomously. Use action "start" to begin, "stop" to end, "status" to check.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['start', 'stop', 'status'],
                    description: '"start" to begin tracking faces, "stop" to end, "status" to check current state'
                }
            },
            required: ['action']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            try {
                const result = await piRequest(config, 'POST', '/track/face', {
                    action: args.action,
                });
                if (args.action === 'start') {
                    state.logEvent('track', 'face tracking started');
                } else if (args.action === 'stop') {
                    state.logEvent('track', 'face tracking stopped');
                }
                const s = result.data;
                const msg = args.action === 'status'
                    ? `tracking: ${s.active ? 'ON' : 'OFF'}, faces: ${s.face_count || 0}, frames: ${s.frames_processed || 0}`
                    : `face tracking ${args.action === 'start' ? 'started' : 'stopped'}`;
                return { content: [{ type: 'text', text: msg }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Face tracking failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_track_face' });

    // body_walk — orchestrated walking (single LLM call = full gait cycle)
    api.registerTool({
        name: 'body_walk',
        description: 'Walk in a direction. The Pi handles the full gait cycle (start, stride, stop) — one call, no looping needed. Directions: forward, backward, left, right. Steps: 1-10.',
        parameters: {
            type: 'object',
            properties: {
                direction: {
                    type: 'string',
                    enum: ['forward', 'backward', 'left', 'right'],
                    description: 'Direction to walk'
                },
                steps: {
                    type: 'integer',
                    description: 'Number of steps (1-10, default 3)',
                    default: 3
                }
            },
            required: ['direction']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            state.movementInProgress = true;  // Movement Lock: START
            try {
                let d;
                const walkBody = { direction: args.direction || 'forward', steps: args.steps || 3 };

                if (config.streaming?.enabled) {
                    // Streaming path: SSE per-step telemetry with WorldModel updates
                    try {
                        const streamResult = await consumeWalkStream(config, walkBody);
                        d = streamResult;
                    } catch (streamErr) {
                        // Fallback to HTTP if SSE fails
                        const result = await piRequest(config, 'POST', '/walk', walkBody, 30000);
                        d = result.data;
                    }
                } else {
                    const result = await piRequest(config, 'POST', '/walk', walkBody, 30000);
                    d = result.data;
                }

                state.logEvent('walk', `${args.direction} ${d.steps_taken || args.steps || 3} steps`);
                const parts = [`walked ${args.direction} ${d.steps_taken}/${d.steps || args.steps || 3} steps`];
                if (d.stopped_reason && d.stopped_reason !== 'complete') parts.push(`stopped: ${d.stopped_reason}`);
                if (d.final_distance_cm != null) parts.push(`distance: ${d.final_distance_cm}cm`);
                // Proprioceptive feedback
                const prop = d.proprioception || d;
                const confidence = prop.confidence;
                if (confidence != null && confidence < 0.7) parts.push(`CONFIDENCE: ${confidence}`);
                if (confidence != null) {
                    state.lastActionResult = { success: true, confidence };
                }
                return { content: [{ type: 'text', text: parts.join(', ') }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Walk failed: ${e.message}` }] };
            } finally {
                state.movementInProgress = false;  // Movement Lock: END
            }
        }
    }, { name: 'body_walk' });

    // body_navigate — walk with ultrasonic obstacle avoidance (compound)
    api.registerTool({
        name: 'body_navigate',
        description: 'Walk in a direction with automatic obstacle detection. The Pi checks ultrasonic distance after each step and stops if an obstacle is detected. Much safer than body_walk for exploring unknown spaces. Returns steps taken, final distance, and why it stopped. Directions: forward, backward, left, right. Steps: 1-10.',
        parameters: {
            type: 'object',
            properties: {
                direction: {
                    type: 'string',
                    enum: ['forward', 'backward', 'left', 'right'],
                    description: 'Direction to walk'
                },
                steps: {
                    type: 'integer',
                    description: 'Maximum steps to take (1-10, default 5)',
                    default: 5
                },
                stop_zone: {
                    type: 'string',
                    enum: ['contact', 'close', 'near'],
                    description: 'Stop when distance zone reaches this level (default: close)',
                    default: 'close'
                }
            },
            required: ['direction']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            state.movementInProgress = true;  // Movement Lock: START
            try {
                const result = await piRequest(config, 'POST', '/navigate', {
                    direction: args.direction || 'forward',
                    steps: args.steps || 5,
                    stop_zone: args.stop_zone || 'close',
                }, 25000);  // 25s timeout — up to 10 steps × ~2s each
                const d = result.data;
                state.logEvent('navigate', `${args.direction} ${d.steps_taken}/${d.steps_requested}, ${d.stopped_reason}`);

                // Update cached distance
                if (d.final_distance_cm != null) {
                    if (!state.lastSensors) state.lastSensors = {};
                    state.lastSensors.distance = {
                        cm: d.final_distance_cm,
                        zone: d.final_zone,
                    };
                }

                // Store last action result with proprioception
                const prop = d.proprioception;
                state.lastActionResult = {
                    success: !d.stalled,
                    stepsTaken: d.steps_taken,
                    stalled: d.stalled,
                    deltaDistance: d.delta_distance,
                    confidence: prop?.confidence,
                };

                const parts = [
                    `${args.direction} ${d.steps_taken}/${d.steps_requested} steps`,
                    `stopped: ${d.stopped_reason}`,
                ];
                if (d.final_zone) {
                    parts.push(`distance: ${d.final_zone}`);
                }
                if (d.delta_distance != null && d.delta_distance !== 0) {
                    parts.push(`delta: ${d.delta_distance > 0 ? '+' : ''}${d.delta_distance}cm`);
                }
                if (d.stalled) {
                    parts.push('STALLED');
                }
                // Proprioceptive feedback
                if (prop && prop.confidence < 0.7) {
                    parts.push(`CONFIDENCE: ${prop.confidence}`);
                }
                return { content: [{ type: 'text', text: parts.join(', ') }] };
            } catch (e) {
                state.lastActionResult = { success: false, error: e.message };
                return { content: [{ type: 'text', text: `Navigate failed: ${e.message}` }] };
            } finally {
                state.movementInProgress = false;  // Movement Lock: END
            }
        }
    }, { name: 'body_navigate' });

    // body_mode — switch between navigate and experiment embodiment modes
    api.registerTool({
        name: 'body_mode',
        description: 'Switch embodiment mode. Navigate: terse WorldModel summaries, only surprises injected. Experiment: verbose proprioceptive data (raw IMU deltas, heading changes, all objects visible, per-step detail). Use experiment mode when exploring movement or learning new gaits.',
        parameters: {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    enum: ['navigate', 'experiment'],
                    description: 'Embodiment mode to switch to'
                }
            },
            required: ['mode']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            const prev = state.embodimentMode;
            state.embodimentMode = args.mode;
            state.logEvent('mode', `${prev} → ${args.mode}`);
            return { content: [{ type: 'text', text: `Embodiment mode: ${args.mode}` }] };
        }
    }, { name: 'body_mode' });

    // body_pilot_tick — model-in-the-loop curiosity/action/learning tick
    api.registerTool({
        name: 'body_pilot_tick',
        description: 'Run one bounded embodied pilot tick for curious learning. This senses before/after, optionally performs one small safe action, returns a camera frame to your native multimodal model, and writes a JSONL receipt. Use repeatedly for fluid exploration without starting a black-box autonomous loop.',
        parameters: {
            type: 'object',
            properties: {
                intent: {
                    type: 'string',
                    description: 'What you are trying to learn or do in this tick, e.g. "figure out whether I can pick up the cup".'
                },
                phase: {
                    type: 'string',
                    enum: ['observe', 'try_action', 'reflect'],
                    description: 'observe = sense/look only, try_action = perform exactly one bounded action, reflect = compare and log without moving.',
                    default: 'observe'
                },
                hypothesis: {
                    type: 'string',
                    description: 'Your current belief about what may happen or why the last action failed.'
                },
                target: {
                    type: 'string',
                    description: 'Optional visual target to track across the tick, e.g. "bowl", "cup", or "chair". Used to report frame-position and visual-progress calibration in TonyPi scale.'
                },
                question: {
                    type: 'string',
                    description: 'Visual focus for the returned frame.'
                },
                action: {
                    type: 'object',
                    description: 'One bounded action. Supported kinds: none, body_action, navigate, look, stop. body_action is repeat=1; navigate is max 1 step.',
                    properties: {
                        kind: { type: 'string', enum: ['none', 'body_action', 'navigate', 'look', 'stop'] },
                        name: { type: 'string', description: 'ActionGroup name for kind=body_action.' },
                        direction: { type: 'string', enum: ['forward', 'backward', 'left', 'right'] },
                        steps: { type: 'integer', description: 'For navigate. Clamped to 1 inside pilot ticks.' },
                        stop_zone: { type: 'string', enum: ['contact', 'close', 'near'] },
                        pan: { type: 'number' },
                        tilt: { type: 'number' },
                        duration: { type: 'integer' }
                    }
                },
                movement_goal_steps: {
                    type: 'integer',
                    description: 'Optional locomotion goal for accounting output, e.g. 15 when attempting a 15 TonyPi-step approach across repeated pilot ticks.'
                },
                reset_movement_accounting: {
                    type: 'boolean',
                    description: 'Reset the session pilot movement counters before this tick. Use at the start of a new multi-step attempt.',
                    default: false
                },
                record_learning: {
                    type: 'boolean',
                    description: 'Write pilot tick receipt to projects/embodiment/pilot-ticks.jsonl. Default true.',
                    default: true
                }
            },
            required: ['intent']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            const phase = args.phase || 'observe';
            const action = phase === 'try_action' ? normalizePilotAction(args.action) : { kind: 'none' };
            const startedAt = new Date().toISOString();
            const previousMode = state.embodimentMode;
            state.embodimentMode = 'experiment';
            if (args.reset_movement_accounting) {
                state.pilotMovementStats = {
                    attemptedSteps: 0,
                    confirmedSteps: 0,
                    ambiguousSteps: 0,
                    failedSteps: 0,
                    lastUpdatedAt: null,
                };
            }

            try {
                const pre = await readPilotSnapshot(config);
                if (pre.sensors.ok) {
                    state.connected = true;
                    state.lastSensors = pre.sensors.data;
                    state.lastPoll = pre.at;
                }

                let actionResult = { ok: true, data: null };
                if (action.kind !== 'none') {
                    state.movementInProgress = true;
                    actionResult = await runPilotAction(config, action);
                    state.movementInProgress = false;
                }

                const post = await readPilotSnapshot(config);
                if (post.sensors.ok) {
                    state.connected = true;
                    state.lastSensors = post.sensors.data;
                    state.lastPoll = post.at;
                }

                const movementAccounting = buildMovementAccounting(action, actionResult);
                const movementTotals = updatePilotMovementStats(state, movementAccounting);
                const learning = buildPilotLearning(pre, post, action, actionResult, movementAccounting);
                const visualCalibration = buildVisualCalibration(pre, post, args, state.lastVisualCalibration);
                state.lastVisualCalibration = visualCalibration;
                state.lastActionResult = {
                    success: learning.success,
                    sceneChanged: learning.sceneChanged,
                    reasonCodes: learning.reasonCodes,
                    hardStopCodes: learning.hardStopCodes,
                    cautionCodes: learning.cautionCodes,
                    visualCalibration,
                    movementAccounting,
                };

                let image = null;
                try {
                    image = await captureNativeVisionFrame(config);
                } catch { /* no frame; text receipt still useful */ }

                const receipt = {
                    type: 'body_pilot_tick',
                    startedAt,
                    completedAt: new Date().toISOString(),
                    agentId: state.agentId,
                    intent: String(args.intent || '').slice(0, 500),
                    phase,
                    target: visualCalibration.targetHint,
                    hypothesis: args.hypothesis ? String(args.hypothesis).slice(0, 500) : null,
                    action,
                    pre: {
                        summary: summarizePilotSnapshot(pre),
                        sensorsOk: pre.sensors.ok,
                        objectsOk: pre.objects.ok,
                    },
                    post: {
                        summary: summarizePilotSnapshot(post),
                        sensorsOk: post.sensors.ok,
                        objectsOk: post.objects.ok,
                    },
                    actionSummary: summarizePilotAction(action, actionResult),
                    learning,
                    movementAccounting: {
                        ...movementAccounting,
                        totals: movementTotals,
                        goalSteps: Number.isFinite(Number(args.movement_goal_steps)) ? Number(args.movement_goal_steps) : null,
                    },
                    visualCalibration,
                };

                let journalPath = null;
                if (args.record_learning !== false) {
                    try {
                        journalPath = appendPilotReceipt(receipt);
                    } catch (e) {
                        receipt.receiptWriteError = e.message;
                    }
                }

                state.logEvent('pilot_tick', `${phase}: ${args.intent}`);

                const lines = [
                    `[BODY PILOT TICK] ${phase}`,
                    `intent: ${args.intent}`,
                    args.hypothesis ? `hypothesis: ${args.hypothesis}` : null,
                    `before: ${receipt.pre.summary}`,
                    `action: ${receipt.actionSummary}`,
                    `after: ${receipt.post.summary}`,
                    visualCalibration.targetHint ? `target: ${visualCalibration.targetHint}` : null,
                    `target_progress: ${visualCalibration.targetSummary}`,
                    `visual_calibration: ${visualCalibration.progressLanguage}`,
                    `movement_accounting: ${summarizeMovementAccounting(movementAccounting, movementTotals, args.movement_goal_steps)}`,
                    `body_scale: ${visualCalibration.scaleReminder}`,
                    'sensor frame: front_ultrasonic is a narrow forward collision cone, not distance-to-target for low/off-axis visual objects.',
                    `learning: ${learning.hardStopCodes.length ? 'hard stop' : learning.cautionCodes.length ? 'caution - continue slowly' : 'clear'}${learning.reasonCodes.length ? ` (${learning.reasonCodes.join(', ')})` : ''}`,
                    `next: ${learning.nextSuggestion}`,
                    journalPath ? `receipt: ${journalPath}` : receipt.receiptWriteError ? `receipt write failed: ${receipt.receiptWriteError}` : null,
                ].filter(Boolean);

                const content = [{ type: 'text', text: lines.join('\n') }];
                if (image) {
                    content.push(...buildNativeVisionContent(image, args.question || `Inspect the scene after this pilot tick. Intent: ${args.intent}`));
                }
                return { content };
            } catch (e) {
                state.lastActionResult = { success: false, error: e.message };
                return { content: [{ type: 'text', text: `Body pilot tick failed: ${e.message}` }] };
            } finally {
                state.movementInProgress = false;
                state.embodimentMode = previousMode === 'navigate' ? 'navigate' : state.embodimentMode;
            }
        }
    }, { name: 'body_pilot_tick' });

    // body_record_movement — capture servo positions during free movement
    api.registerTool({
        name: 'body_record_movement',
        description: 'Record your body servo positions at 10Hz for a duration. Use this to capture a movement you want to remember and replay later. Returns frame count and duration. Max 10 seconds.',
        parameters: {
            type: 'object',
            properties: {
                duration: {
                    type: 'number',
                    description: 'Recording duration in seconds (0.5-10, default 3)',
                    default: 3
                },
                hz: {
                    type: 'integer',
                    description: 'Samples per second (1-20, default 10)',
                    default: 10
                }
            }
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            try {
                const result = await piRequest(config, 'POST', '/record_movement', {
                    duration: args.duration || 3,
                    hz: args.hz || 10,
                }, 15000);
                const d = result.data;
                state.logEvent('record', `${d.sample_count} frames over ${d.duration_actual}s`);
                // Return frames as JSON for Clint to save if desired
                return { content: [{ type: 'text', text: `Recorded ${d.sample_count} frames over ${d.duration_actual}s at ${args.hz || 10}Hz. Frame data: ${JSON.stringify(d.frames)}` }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Recording failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_record_movement' });

    // body_replay_movement — replay recorded servo frames
    api.registerTool({
        name: 'body_replay_movement',
        description: 'Replay a previously recorded movement. Pass the frames array from body_record_movement or body_learn_action. Speed multiplier: 0.5 = half speed, 2.0 = double. Safety: auto-aborts if obstacle within 10cm.',
        parameters: {
            type: 'object',
            properties: {
                frames: {
                    type: 'array',
                    items: { type: 'object' },
                    description: 'Array of frame objects from a previous recording: [{t: 0.0, servos: {1: 500, ...}}, ...]'
                },
                speed: {
                    type: 'number',
                    description: 'Playback speed multiplier (0.1-5.0, default 1.0)',
                    default: 1.0
                }
            },
            required: ['frames']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            state.movementInProgress = true;
            try {
                const result = await piRequest(config, 'POST', '/replay_movement', {
                    frames: args.frames,
                    speed: args.speed || 1.0,
                }, 30000);
                const d = result.data;
                state.logEvent('replay', `${d.frames_played}/${d.frames_total} frames, ${d.stopped_reason}`);
                const parts = [`replayed ${d.frames_played}/${d.frames_total} frames`];
                if (d.stopped_reason !== 'complete') parts.push(`stopped: ${d.stopped_reason}`);
                const prop = d.proprioception;
                if (prop && prop.confidence < 0.7) parts.push(`CONFIDENCE: ${prop.confidence}`);
                return { content: [{ type: 'text', text: parts.join(', ') }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Replay failed: ${e.message}` }] };
            } finally {
                state.movementInProgress = false;
            }
        }
    }, { name: 'body_replay_movement' });

    // body_learn_action — record servo trajectory during a named ActionGroup
    api.registerTool({
        name: 'body_learn_action',
        description: 'Learn what a named action looks like by recording servo positions while it executes. Returns the frame trajectory data so you can analyze, modify, or replay the movement. Use this to reverse-engineer stock movements into composable primitives.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    description: 'Name of the ActionGroup to learn (e.g., "wave", "bow")'
                },
                hz: {
                    type: 'integer',
                    description: 'Recording Hz (default 10)',
                    default: 10
                }
            },
            required: ['action']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            state.movementInProgress = true;
            try {
                const result = await piRequest(config, 'POST', '/action_record', {
                    action: args.action,
                    hz: args.hz || 10,
                }, 15000);
                const d = result.data;
                state.logEvent('learn', `${args.action} → ${d.sample_count} frames`);
                return { content: [{ type: 'text', text: `Learned "${args.action}" (resolved: ${d.resolved}): ${d.sample_count} frames. Frame data: ${JSON.stringify(d.frames)}` }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Learn failed: ${e.message}` }] };
            } finally {
                state.movementInProgress = false;
            }
        }
    }, { name: 'body_learn_action' });

    // body_sweep — atomic head-sweep + detect + distance at multiple positions (compound)
    // Renamed from body_scan 2026-04-23 to resolve duplicate registration with the
    // VLM-based body_scan at line ~1117. Tool B is the physical head-sweep variant
    // (active pan/tilt motion); Tool A is static single-frame depth+scene analysis.
    api.registerTool({
        name: 'body_sweep',
        description: 'Physically sweep your head across positions and sense at each. Moves head left, center, and right — detecting faces, objects (80 YOLO classes), and measuring ultrasonic distance at each position. Returns a compact spatial map. Use when you need coverage beyond the current view; for just the current view use body_scan instead. Takes ~3-4 seconds total.',
        parameters: {
            type: 'object',
            properties: {
                positions: {
                    type: 'array',
                    description: 'Custom head positions to sweep. Each: {pan, tilt}. Default: left(-45), center(0), right(45).',
                    items: {
                        type: 'object',
                        properties: {
                            pan: { type: 'number' },
                            tilt: { type: 'number' },
                        }
                    }
                }
            }
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            try {
                const body = {};
                if (args.positions) body.positions = args.positions;

                const result = await piRequest(config, 'POST', '/scan', body, 15000);  // 15s timeout
                const d = result.data;

                state.logEvent('sweep', d.summary || 'sweep complete');
                return { content: [{ type: 'text', text: d.summary || 'sweep complete, no detections' }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Sweep failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_sweep' });

    // body_reflex — manage autonomous reflexes (face tracking, fall detection)
    api.registerTool({
        name: 'body_reflex',
        description: 'Start, stop, or check autonomous reflexes running on the Pi. Reflexes handle fast responses without needing you in the loop. Available: face_track (PID head tracking), fall_detect (auto-recovery from falls), voice_listen (hear voice commands via WonderEcho).',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    enum: ['face_track', 'fall_detect', 'voice_listen'],
                    description: 'Which reflex to control'
                },
                action: {
                    type: 'string',
                    enum: ['start', 'stop', 'status'],
                    description: 'What to do'
                }
            },
            required: ['name', 'action']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            try {
                const endpoint = args.name === 'face_track' ? '/track/face'
                    : args.name === 'voice_listen' ? '/reflex/voice'
                    : '/reflex/fall';
                const result = await piRequest(config, 'POST', endpoint, {
                    action: args.action,
                });
                state.logEvent('reflex', `${args.name}: ${args.action}`);
                const s = result.data;
                if (args.action === 'status') {
                    return { content: [{ type: 'text', text: `${args.name}: ${s.active ? 'ON' : 'OFF'}` }] };
                }
                return { content: [{ type: 'text', text: `${args.name} ${args.action === 'start' ? 'started' : 'stopped'}` }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Reflex control failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_reflex' });

    // body_explore — autonomous behavior loops (sense→decide→act on Pi)
    api.registerTool({
        name: 'body_explore',
        description: 'Run an autonomous behavior loop on your body. The Pi handles the entire sense→decide→act cycle — no need for you to call individual tools. One tool call does the whole job. Modes: cross (walk across room, turn when blocked), explore (wander, prefer open paths, random turns for coverage), seek (find a specific object/person and report location), approach (move toward a detected target until close). The Pi checks distance, detects objects, and navigates automatically. Returns a summary of what happened.',
        parameters: {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    enum: ['cross', 'explore', 'seek', 'approach'],
                    description: 'Behavior mode'
                },
                target: {
                    type: 'string',
                    description: 'Object/person to find (for seek/approach). Use YOLO class names: person, bottle, cup, chair, etc.'
                },
                max_steps: {
                    type: 'integer',
                    description: 'Maximum steps before stopping (default 20)',
                    default: 20
                },
                stop_distance: {
                    type: 'integer',
                    description: 'Stop this many cm from obstacles/targets (default 30)',
                    default: 30
                },
                timeout: {
                    type: 'integer',
                    description: 'Maximum seconds to run (default 60)',
                    default: 60
                },
                stop_zone: {
                    type: 'string',
                    enum: ['contact', 'close', 'near'],
                    description: 'Stop when obstacle is this close. contact=10cm, close=30cm (default), near=100cm'
                },
                vlm_every: {
                    type: 'integer',
                    description: 'Run VLM scene understanding every N scans (default 5, 0=disabled). Adds ~6s per VLM call (Moondream 2B). Movement continues unblocked between VLM calls.'
                }
            },
            required: ['mode']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            state.movementInProgress = true;  // Movement Lock: START
            try {
                const body = {
                    mode: args.mode,
                    target: args.target || null,
                    max_steps: args.max_steps || 20,
                    stop_distance: args.stop_distance || 30,
                    timeout: args.timeout || 60,
                };
                if (args.stop_zone) body.stop_zone = args.stop_zone;
                if (args.vlm_every != null) body.vlm_every = args.vlm_every;
                const result = await piRequest(config, 'POST', '/behavior', body, 90000);
                const d = result.data;

                state.logEvent('explore', `${args.mode}: ${d.status}, ${d.steps_taken} steps`);

                // Update cached distance
                if (d.final_distance_cm != null) {
                    if (!state.lastSensors) state.lastSensors = {};
                    state.lastSensors.distance = {
                        cm: d.final_distance_cm,
                        zone: d.final_zone,
                    };
                }

                // Store last action result
                state.lastActionResult = {
                    success: d.status !== 'stuck',
                    stepsTaken: d.steps_taken,
                    stalls: d.stalls,
                    reason: d.reason,
                };

                // Compact result
                const parts = [`${args.mode}: ${d.status}`];
                parts.push(`${d.steps_taken} steps, ${d.scans} scans, ${d.turns} turns`);
                if (d.reason) parts.push(`reason: ${d.reason}`);
                if (d.objects_seen && d.objects_seen.length > 0) {
                    parts.push(`saw: ${d.objects_seen.join(', ')}`);
                }
                if (d.final_zone) {
                    parts.push(`final distance: ${d.final_zone}`);
                }
                if (d.stalls > 0) {
                    parts.push(`${d.stalls} stall(s)`);
                }
                if (d.status === 'stuck') {
                    parts.push('figure it out');
                }
                if (d.target_direction) {
                    parts.push(`target ${d.target}: ${d.target_direction}, ${d.target_distance}cm`);
                }
                if (d.scene_description) {
                    parts.push(`scene: ${d.scene_description}`);
                }
                if (d.scenes_seen && d.scenes_seen.length > 0) {
                    parts.push(`scenes(${d.scenes_seen.length}): ${d.scenes_seen.slice(-2).join(' | ')}`);
                }
                return { content: [{ type: 'text', text: parts.join(', ') }] };
            } catch (e) {
                state.lastActionResult = { success: false, error: e.message };
                return { content: [{ type: 'text', text: `Explore failed: ${e.message}` }] };
            } finally {
                state.movementInProgress = false;  // Movement Lock: END
            }
        }
    }, { name: 'body_explore' });

    // body_explore_stop — emergency stop for running behavior
    api.registerTool({
        name: 'body_explore_stop',
        description: 'Emergency stop for a running body_explore behavior loop. The robot will stop moving and stand.',
        parameters: {
            type: 'object',
            properties: {}
        },
        execute: async (_id, _args) => {
            try {
                await piRequest(config, 'POST', '/behavior/stop');
                return { content: [{ type: 'text', text: 'Behavior stop signal sent' }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Stop failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_explore_stop' });

    // body_voice — voice input/output via WonderEcho module
    api.registerTool({
        name: 'body_voice',
        description: 'Your ears and voice. Check for voice commands people have spoken to you (via WonderEcho module), speak pre-recorded responses, or check voice module status. Use "listen" to check for pending commands someone said after saying your wake word, "speak" to play a TTS response, "status" to check if your hearing is active.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['listen', 'speak', 'status'],
                    description: 'What to do: listen for commands, speak a response, or check status'
                },
                speak_type: {
                    type: 'string',
                    enum: ['command', 'announce'],
                    description: 'Type of TTS response (for speak action)'
                },
                speak_id: {
                    type: 'number',
                    description: 'ID of the phrase to speak (for speak action)'
                },
            },
            required: ['action']
        },
        execute: async (_id, args) => {
            const state = getState('clint');
            try {
                if (args.action === 'listen') {
                    const result = await piRequest(config, 'GET', '/voice/latest');
                    const cmds = result.data.commands || [];
                    if (cmds.length === 0) {
                        return { content: [{ type: 'text', text: 'No voice commands heard.' }] };
                    }
                    const names = cmds.map(c => c.name);
                    state.logEvent('voice_heard', names.join(', '));
                    return { content: [{ type: 'text', text: `Heard: ${names.join(', ')}` }] };
                } else if (args.action === 'speak') {
                    const result = await piRequest(config, 'POST', '/voice/speak', {
                        type: args.speak_type || 'command',
                        id: args.speak_id || 0,
                    });
                    state.logEvent('voice_speak', `type=${args.speak_type} id=${args.speak_id}`);
                    return { content: [{ type: 'text', text: result.data.success ? 'Speaking.' : 'Speak failed.' }] };
                } else if (args.action === 'status') {
                    const result = await piRequest(config, 'GET', '/voice/status');
                    const s = result.data;
                    return { content: [{ type: 'text', text: `Voice: ${s.active ? 'ON' : 'OFF'}, module: ${s.module_detected ? 'detected' : 'not found'}, heard ${s.commands_received} total` }] };
                }
                return { content: [{ type: 'text', text: 'Unknown action' }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Voice failed: ${e.message}` }] };
            }
        }
    }, { name: 'body_voice' });

    console.log('[Embodiment] Plugin loaded — 25 body tools registered');
}

module.exports = { register };
