// GENERATED from Sun_Tracker_Leaflet/solar-core.js — keep logic in sync.
(function (global) {
'use strict';
// solar-core — terrain-aware solar geometry shared by the Sun Tracker apps.
//
// All angles at the API boundary are degrees; azimuths are compass bearings
// (0 = north, 90 = east). Sun positions come from SunCalc via a sampler
// function so the pure math stays testable without the library.

const R_EARTH = 6371000;          // meters
const REFRACTION_K = 0.13;        // terrestrial refraction coefficient
const OBSERVER_HEIGHT = 2;        // meters above the DEM surface
const AZIMUTH_COUNT = 72;         // horizon rays every 5 degrees
const HORIZON_D0 = 30;            // first horizon sample distance (m)
const HORIZON_GROWTH = 1.05;      // geometric step growth per sample
const HORIZON_MAX_DIST = 40000;   // meters
const SUN_SAMPLE_MINUTES = 5;
const SUN_SEMIDIAMETER = 0.267;   // degrees
const SUN_UP_ALTITUDE = -0.8333;         // standard sunrise definition (deg)

const DEG = Math.PI / 180;

// Combined earth-curvature + refraction drop of a target at distance d (m).
function curvatureDrop(d) {
    return (1 - REFRACTION_K) * d * d / (2 * R_EARTH);
}

// Bennett atmospheric refraction (degrees) for a true altitude in degrees.
function bennettRefraction(altDeg) {
    const h = Math.max(-2, altDeg);
    return 1.02 / (60 * Math.tan((h + 10.3 / (h + 5.11)) * DEG));
}

// Great-circle destination point.
function destinationPoint(lat, lng, bearingDeg, distanceM) {
    const delta = distanceM / R_EARTH;
    const theta = bearingDeg * DEG;
    const phi1 = lat * DEG;
    const lambda1 = lng * DEG;
    const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
    const phi2 = Math.asin(sinPhi2);
    const lambda2 = lambda1 + Math.atan2(
        Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
        Math.cos(delta) - Math.sin(phi1) * sinPhi2
    );
    return { lat: phi2 / DEG, lng: (((lambda2 / DEG) + 540) % 360) - 180 };
}

// Zoom used for a horizon sample at distance d — fine nearby, coarser far out.
function horizonZoomForDistance(d) {
    if (d <= 2000) return 13;
    if (d <= 8000) return 12;
    return 11;
}

function horizonSampleDistances() {
    const distances = [];
    for (let d = HORIZON_D0; d <= HORIZON_MAX_DIST; d *= HORIZON_GROWTH) distances.push(d);
    return distances;
}

// 360-degree horizon profile: [{azimuth, angle}], angle in degrees relative
// to the observer's horizontal (negative = horizon below level, e.g. valleys).
async function computeHorizonProfile(client, lat, lng, observerElev) {
    const distances = horizonSampleDistances();
    const azimuths = Array.from({ length: AZIMUTH_COUNT }, (_, i) => i * (360 / AZIMUTH_COUNT));
    const points = [];
    for (const azimuth of azimuths) {
        for (const d of distances) {
            const dest = destinationPoint(lat, lng, azimuth, d);
            points.push({ lat: dest.lat, lng: dest.lng, zoom: horizonZoomForDistance(d) });
        }
    }
    const elevations = await client.getElevations(points);
    const eyeHeight = observerElev + OBSERVER_HEIGHT;
    const clampSea = observerElev >= 0; // terrarium includes bathymetry; sea surface forms the horizon
    return azimuths.map((azimuth, a) => {
        let angle = -90;
        for (let i = 0; i < distances.length; i++) {
            let e = elevations[a * distances.length + i];
            if (e === null) continue; // missing tile: skip sample, keep scanning
            if (clampSea && e < 0) e = 0;
            const d = distances[i];
            const alpha = Math.atan2(e - eyeHeight - curvatureDrop(d), d) / DEG;
            if (alpha > angle) angle = alpha;
        }
        return { azimuth, angle };
    });
}

// Wraparound-safe linear interpolation of the horizon angle at any azimuth.
function horizonAt(profile, azimuth) {
    const n = profile.length;
    const step = 360 / n;
    const az = ((azimuth % 360) + 360) % 360;
    const idx = az / step;
    const i0 = Math.floor(idx) % n;
    const i1 = (i0 + 1) % n;
    const frac = idx - Math.floor(idx);
    return profile[i0].angle * (1 - frac) + profile[i1].angle * frac;
}

// Sun direction unit vector in (east, north, up) from altitude/azimuth degrees.
function sunVector(altDeg, azDeg) {
    return {
        x: Math.cos(altDeg * DEG) * Math.sin(azDeg * DEG),
        y: Math.cos(altDeg * DEG) * Math.cos(azDeg * DEG),
        z: Math.sin(altDeg * DEG),
    };
}

// Outward unit normal of a slope in (east, north, up).
// aspectDeg is the downslope (facing) compass direction.
function slopeNormal(slopeDeg, aspectDeg) {
    return {
        x: Math.sin(slopeDeg * DEG) * Math.sin(aspectDeg * DEG),
        y: Math.sin(slopeDeg * DEG) * Math.cos(aspectDeg * DEG),
        z: Math.cos(slopeDeg * DEG),
    };
}

// Cosine of the sun's incidence angle on the slope (<= 0 means self-shaded).
function slopeIncidence(altDeg, azDeg, slopeDeg, aspectDeg) {
    const s = sunVector(altDeg, azDeg);
    const m = slopeNormal(slopeDeg, aspectDeg);
    return s.x * m.x + s.y * m.y + s.z * m.z;
}

// Slope angle and facing direction from central differences on the DEM.
// Sample spacing is tied to the DEM's actual ground resolution so neighbor
// probes never collapse into the same pixel.
async function computeSlopeAspect(client, lat, lng, zoom, groundResolutionM) {
    const deltaM = 1.5 * groundResolutionM;
    const dLat = deltaM / 111320;
    const dLng = deltaM / (111320 * Math.cos(lat * DEG));
    const [center, north, south, east, west] = await client.getElevations([
        { lat, lng, zoom },
        { lat: lat + dLat, lng, zoom },
        { lat: lat - dLat, lng, zoom },
        { lat, lng: lng + dLng, zoom },
        { lat, lng: lng - dLng, zoom },
    ]);
    if ([center, north, south, east, west].some((e) => e === null)) return null;
    const dzdx = (east - west) / (2 * deltaM);   // gradient toward east
    const dzdy = (north - south) / (2 * deltaM); // gradient toward north
    const slope = Math.atan(Math.hypot(dzdx, dzdy)) / DEG;
    const aspect = ((Math.atan2(-dzdx, -dzdy) / DEG) + 360) % 360; // downhill bearing
    return { elevation: center, slope, aspect };
}

// --- Sun visibility intervals over one local day ---------------------------
//
// sampler(date) must return {altitude, azimuth} in degrees (compass azimuth).
// horizonFn(azimuthDeg) returns the terrain horizon angle in degrees.
// Returns intervals as arrays of {start, end} Dates, with edges refined by
// bisection to ~10 s.

function makeSunSampler(SunCalcLib, lat, lng) {
    return (date) => {
        const pos = SunCalcLib.getPosition(date, lat, lng);
        return {
            altitude: pos.altitude / DEG,
            azimuth: pos.azimuth / DEG + 180, // SunCalc measures from south
        };
    };
}

function computeSunDay(sampler, horizonFn, dayStart, slope = null) {
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayStartMs + 24 * 3600 * 1000;
    const stepMs = SUN_SAMPLE_MINUTES * 60 * 1000;

    const sunUpAt = (t) => sampler(new Date(t)).altitude > SUN_UP_ALTITUDE;
    const visibleAt = (t) => {
        const pos = sampler(new Date(t));
        return pos.altitude + SUN_SEMIDIAMETER + bennettRefraction(pos.altitude) > horizonFn(pos.azimuth);
    };
    const litAt = slope
        ? (t) => {
            const pos = sampler(new Date(t));
            return pos.altitude + SUN_SEMIDIAMETER + bennettRefraction(pos.altitude) > horizonFn(pos.azimuth)
                && slopeIncidence(pos.altitude, pos.azimuth, slope.slope, slope.aspect) > 0;
        }
        : null;

    const times = [];
    for (let t = dayStartMs; t <= dayEndMs; t += stepMs) times.push(t);

    const extract = (predicate) => {
        const intervals = [];
        let start = null;
        for (let i = 0; i < times.length; i++) {
            const on = predicate(times[i]);
            if (on && start === null) {
                start = i === 0 ? times[0] : bisect(predicate, times[i - 1], times[i], true);
            } else if (!on && start !== null) {
                intervals.push({ start: new Date(start), end: new Date(bisect(predicate, times[i - 1], times[i], false)) });
                start = null;
            }
        }
        if (start !== null) intervals.push({ start: new Date(start), end: new Date(dayEndMs) });
        return intervals;
    };

    const bisect = (predicate, tOff, tOn, rising) => {
        // rising: predicate false at tOff, true at tOn (or vice versa) — find the edge.
        let lo = tOff;
        let hi = tOn;
        for (let i = 0; i < 6; i++) {
            const mid = (lo + hi) / 2;
            if (predicate(mid) === rising) hi = mid; else lo = mid;
        }
        return (lo + hi) / 2;
    };

    const sunUpIntervals = extract(sunUpAt);
    const visibleIntervals = extract(visibleAt);
    const litIntervals = litAt ? extract(litAt) : null;

    // Occlusion windows: sun above the astronomical horizon but behind terrain.
    // Windows shorter than 5 minutes are DEM noise and suppressed.
    const MIN_OCCLUSION_MS = 5 * 60 * 1000;
    const occlusions = [];
    for (const up of sunUpIntervals) {
        let cursor = up.start.getTime();
        for (const vis of visibleIntervals) {
            const s = Math.max(vis.start.getTime(), up.start.getTime());
            const e = Math.min(vis.end.getTime(), up.end.getTime());
            if (e <= s) continue;
            if (s - cursor > MIN_OCCLUSION_MS) occlusions.push({ start: new Date(cursor), end: new Date(s) });
            cursor = Math.max(cursor, e);
        }
        if (up.end.getTime() - cursor > MIN_OCCLUSION_MS) occlusions.push({ start: new Date(cursor), end: new Date(up.end.getTime()) });
    }

    const hours = (intervals) => intervals.reduce((sum, i) => sum + (i.end - i.start), 0) / 3600000;

    return {
        sunUpIntervals,
        visibleIntervals,
        litIntervals,
        occlusions,
        terrainSunrise: visibleIntervals.length ? visibleIntervals[0].start : null,
        terrainSunset: visibleIntervals.length ? visibleIntervals[visibleIntervals.length - 1].end : null,
        firstLightOnSlope: litIntervals && litIntervals.length ? litIntervals[0].start : null,
        lastLightOnSlope: litIntervals && litIntervals.length ? litIntervals[litIntervals.length - 1].end : null,
        visibleSunHours: hours(visibleIntervals),
        litSunHours: litIntervals ? hours(litIntervals) : null,
    };
}

// --- Timezone helpers -------------------------------------------------------

function wallClockParts(ms, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

// UTC instant of local midnight for a "YYYY-MM-DD" calendar date in an IANA zone.
function zonedMidnightUTC(dateStr, timeZone) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const target = Date.UTC(y, m - 1, d);
    let t = target;
    for (let i = 0; i < 3; i++) {
        const diff = wallClockParts(t, timeZone) - target;
        if (diff === 0) break;
        t -= diff;
    }
    return new Date(t);
}

function formatTimeInZone(date, timeZone, { hour12 = true } = {}) {
    if (!date) return '--:--';
    const options = hour12
        ? { hour: '2-digit', minute: '2-digit', hour12: true, timeZone }
        : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone };
    return date.toLocaleTimeString('en-US', options);
}

function zoneAbbreviation(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(date);
    const name = parts.find((p) => p.type === 'timeZoneName');
    return name ? name.value : timeZone;
}

const api = { R_EARTH, REFRACTION_K, OBSERVER_HEIGHT, AZIMUTH_COUNT, HORIZON_D0, HORIZON_GROWTH, HORIZON_MAX_DIST, SUN_SAMPLE_MINUTES, SUN_SEMIDIAMETER, curvatureDrop, bennettRefraction, destinationPoint, horizonZoomForDistance, horizonSampleDistances, computeHorizonProfile, horizonAt, sunVector, slopeNormal, slopeIncidence, computeSlopeAspect, makeSunSampler, computeSunDay, zonedMidnightUTC, formatTimeInZone, zoneAbbreviation };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
global.SolarCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
