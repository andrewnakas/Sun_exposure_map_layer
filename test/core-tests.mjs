// Unit tests for the classic-script solar-core/terrain-client used by the app.
// Zero dependencies. Run: node test/core-tests.mjs

import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const {
    curvatureDrop, bennettRefraction, destinationPoint, horizonAt,
    computeSlopeAspect, computeSunDay, zonedMidnightUTC, formatTimeInZone,
    zoneAbbreviation, slopeIncidence, R_EARTH, REFRACTION_K,
} = require(join(repoRoot, 'js', 'solar-core.js'));
const { decodeTerrarium, groundResolution } = require(join(repoRoot, 'js', 'terrain-client.js'));

let failures = 0;
function check(name, condition, detail = '') {
    if (condition) {
        console.log(`  ok   ${name}`);
    } else {
        failures++;
        console.error(`  FAIL ${name} ${detail}`);
    }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log('curvature + refraction');
check('drop(40 km) ~ 109.2 m', approx(curvatureDrop(40000), 109.2, 0.5), `got ${curvatureDrop(40000)}`);
check('drop(50 km) ~ 170.7 m', approx(curvatureDrop(50000), 170.7, 0.5), `got ${curvatureDrop(50000)}`);
check('pure geometric drop(50 km) ~ 196 m', approx(50000 ** 2 / (2 * R_EARTH), 196.2, 0.5));
check('k = 0.13', REFRACTION_K === 0.13);
check('bennett(0) in [0.4, 0.6] deg', bennettRefraction(0) > 0.4 && bennettRefraction(0) < 0.6, `got ${bennettRefraction(0)}`);
check('bennett decreases with altitude', bennettRefraction(10) < bennettRefraction(0));

console.log('terrarium decode');
check('(128,0,0) -> 0 m', decodeTerrarium(128, 0, 0) === 0);
check('(131,232,0) -> 1000 m', decodeTerrarium(131, 232, 0) === 1000);
check('groundResolution(0, 14) ~ 9.55 m', approx(groundResolution(0, 14), 9.55, 0.05), `got ${groundResolution(0, 14)}`);

console.log('destinationPoint');
{
    const north = destinationPoint(0, 0, 0, 1000);
    check('1 km north from (0,0)', approx(north.lat, 0.008993, 0.0001) && approx(north.lng, 0, 1e-9),
        `got ${north.lat},${north.lng}`);
}

console.log('horizonAt wraparound');
{
    const profile = Array.from({ length: 72 }, (_, i) => ({ azimuth: i * 5, angle: 0 }));
    profile[71].angle = 10;
    profile[0].angle = 10;
    check('interpolates at 357.5', approx(horizonAt(profile, 357.5), 10, 1e-9), `got ${horizonAt(profile, 357.5)}`);
    check('no seam discontinuity', approx(horizonAt(profile, 359.999), horizonAt(profile, 0.001), 0.01));
    profile[10].angle = -8;
    check('negative angles pass through', approx(horizonAt(profile, 50), -8, 1e-9));
}

console.log('zonedMidnightUTC + formatting');
{
    const denverSummer = zonedMidnightUTC('2026-07-12', 'America/Denver');
    check('Denver 2026-07-12 -> 06:00Z', denverSummer.toISOString() === '2026-07-12T06:00:00.000Z', denverSummer.toISOString());
    const kathmandu = zonedMidnightUTC('2026-07-12', 'Asia/Kathmandu');
    check('Kathmandu -> previous day 18:15Z', kathmandu.toISOString() === '2026-07-11T18:15:00.000Z', kathmandu.toISOString());
    check('24h formatting', formatTimeInZone(denverSummer, 'America/Denver', { hour12: false }) === '00:00',
        formatTimeInZone(denverSummer, 'America/Denver', { hour12: false }));
    check('zoneAbbreviation MDT', zoneAbbreviation(denverSummer, 'America/Denver') === 'MDT');
}

console.log('slope/aspect on synthetic plane DEMs');
{
    const lat0 = 45, lng0 = 6;
    const planeClient = (a, b) => ({
        async getElevations(points) {
            return points.map((p) => {
                const x = (p.lng - lng0) * 111320 * Math.cos(lat0 * Math.PI / 180);
                const y = (p.lat - lat0) * 111320;
                return 1000 + a * x + b * y;
            });
        },
    });
    const northRising = await computeSlopeAspect(planeClient(0, Math.tan(20 * Math.PI / 180)), lat0, lng0, 14, 10);
    check('20 deg north-rising plane: slope ~20', approx(northRising.slope, 20, 1), `got ${northRising.slope}`);
    check('north-rising plane faces south (180)', approx(northRising.aspect, 180, 1), `got ${northRising.aspect}`);
    const eastRising = await computeSlopeAspect(planeClient(Math.tan(10 * Math.PI / 180), 0), lat0, lng0, 14, 10);
    check('east-rising plane faces west (270)', approx(eastRising.aspect, 270, 1), `got ${eastRising.aspect}`);
}

console.log('visibility intervals on a synthetic day');
{
    const dayStart = new Date('2026-06-21T00:00:00Z');
    const sampler = (date) => {
        const h = (date.getTime() - dayStart.getTime()) / 3600000;
        return { altitude: 50 * Math.sin(((h - 6) / 12) * Math.PI), azimuth: (15 * h) % 360 };
    };
    const minutes = (date) => (date.getTime() - dayStart.getTime()) / 60000;

    const flatDay = computeSunDay(sampler, () => 0, dayStart);
    check('flat horizon: sunrise within 6 min of 06:00', approx(minutes(flatDay.terrainSunrise), 360, 6),
        `got ${minutes(flatDay.terrainSunrise)}`);
    check('flat horizon: no occlusions', flatDay.occlusions.length === 0);

    const wallDay = computeSunDay(sampler, (az) => (az >= 60 && az <= 120 ? 10 : 0), dayStart);
    check('wall delays sunrise past 06:20', minutes(wallDay.terrainSunrise) > 380, `got ${minutes(wallDay.terrainSunrise)}`);
    check('one occlusion window', wallDay.occlusions.length === 1, `got ${wallDay.occlusions.length}`);

    const slopeDay = computeSunDay(sampler, () => 0, dayStart, { slope: 30, aspect: 270 });
    check('west slope first light after sunrise',
        slopeDay.firstLightOnSlope.getTime() > slopeDay.terrainSunrise.getTime() + 30 * 60000);
    check('incidence negative for sun behind slope', slopeIncidence(10, 90, 30, 270) < 0);
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
