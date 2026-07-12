// End-to-end checks for the Solar Exposure Map: serves the app, drives real
// map analyses in Chromium and asserts the rendered sidebar against
// independent references. CDN/tile requests are intercepted and served from
// curl-downloaded fixtures (shared with the analysis in test/fixtures/).
//
// Run: node test/e2e.mjs

import { createRequire } from 'module';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire('/opt/node22/lib/node_modules/x.js');
const { chromium } = require('playwright');
const execFileP = promisify(execFile);

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDir = join(repoRoot, 'test', 'fixtures');
const PORT = 8124;
const DATE = '2026-06-21';

// Independent references (api.sunrise-sunset.org, standard -0.833 deg definition)
const REF = {
    denver: { lat: 39.7392, lng: -104.9903, sunriseUTC: '2026-06-21T11:30:39Z', sunsetUTC: '2026-06-22T02:33:02Z' },
    kansas: { lat: 38.5, lng: -98.0, sunriseUTC: '2026-06-21T11:06:40Z', sunsetUTC: '2026-06-22T02:01:06Z' },
    chamonix: { lat: 45.9237, lng: 6.8694, sunriseUTC: '2026-06-21T03:40:13Z' },
    rainierSouth: { lat: 46.82, lng: -121.77 },
};

let failures = 0;
function check(name, condition, detail = '') {
    if (condition) console.log(`  ok   ${name}`);
    else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}

const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const downloads = new Map();
function fetchFixture(url, sub) {
    if (!downloads.has(url)) {
        const file = join(fixtureDir, sub, url.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_'));
        downloads.set(url, (async () => {
            if (existsSync(file) && statSync(file).size > 0) return file;
            mkdirSync(dirname(file), { recursive: true });
            try {
                await execFileP('curl', ['-sSfL', '--retry', '3', url, '-o', file], { timeout: 60000 });
                return file;
            } catch {
                return null;
            }
        })());
    }
    return downloads.get(url);
}

let tileRequests = 0;
async function routeAll(route) {
    const url = route.request().url();
    if (url.startsWith(`http://localhost:${PORT}`)) return route.continue();
    if (url.includes('tile.opentopomap.org') || url.includes('tile.openstreetmap.org')) {
        return route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_PNG });
    }
    if (url.startsWith('https://unpkg.com/') || url.startsWith('https://cdn.jsdelivr.net/')) {
        const file = await fetchFixture(url, 'cdn');
        if (!file) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ path: file, contentType: url.endsWith('.css') ? 'text/css' : 'application/javascript' });
    }
    if (url.startsWith('https://s3.amazonaws.com/elevation-tiles-prod/')) {
        tileRequests++;
        const file = await fetchFixture(url, 'tiles');
        if (!file) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ path: file, contentType: 'image/png' });
    }
    return route.abort();
}

async function analyze(page, lat, lng) {
    await page.evaluate(async ({ lat, lng, date }) => {
        window.solarMap.dateStr = date;
        document.getElementById('date-input').value = date;
        await window.solarMap.showPointInfo({ lat, lng });
    }, { lat, lng, date: DATE });
}

async function readSidebar(page) {
    const id = (elId) => page.evaluate((x) => document.getElementById(x)?.textContent ?? '', elId);
    return {
        astroSunrise: await id('astronomical-sunrise'),
        astroSunset: await id('astronomical-sunset'),
        terrainSunrise: await id('sunrise-time'),
        terrainSunset: await id('sunset-time'),
        slopeStart: await id('slope-sun-start'),
        slopeEnd: await id('slope-sun-end'),
        elevation: Number(await id('elevation-value')),
        slope: Number(await id('slope-value')),
        aspectText: await id('aspect-value'),
        tzLabel: await id('tz-label'),
        totalSunHours: await id('total-sun-hours'),
        exposure: await id('current-exposure'),
    };
}

// "HH:MM" (24h) -> minutes since local midnight
function parseClock(text) {
    const m = text.match(/(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

function refMinutes(iso, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(iso));
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    return get('hour') * 60 + get('minute') + get('second') / 60;
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
const browser = await chromium.launch();

try {
    const context = await browser.newContext({ timezoneId: 'America/New_York' });
    const page = await context.newPage();
    const pageErrors = [];
    const dialogs = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    await page.route('**/*', routeAll);
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(() => window.solarMap && window.solarMap.map, null, { timeout: 30000 });

    console.log('scenario: Kansas plains (flat baseline, times in CDT)');
    await analyze(page, REF.kansas.lat, REF.kansas.lng);
    {
        const r = await readSidebar(page);
        const refRise = refMinutes(REF.kansas.sunriseUTC, 'America/Chicago');
        check('astronomical sunrise within 3 min of reference', Math.abs(parseClock(r.astroSunrise) - refRise) <= 3,
            `shown ${r.astroSunrise} vs ref ${refRise.toFixed(1)}`);
        check('terrain sunrise within 6 min of astronomical',
            Math.abs(parseClock(r.terrainSunrise) - parseClock(r.astroSunrise)) <= 6,
            `astro ${r.astroSunrise} terrain ${r.terrainSunrise}`);
        const refSet = refMinutes(REF.kansas.sunsetUTC, 'America/Chicago');
        check('astronomical sunset within 3 min of reference', Math.abs(parseClock(r.astroSunset) - refSet) <= 3,
            `shown ${r.astroSunset} vs ref ${refSet.toFixed(1)}`);
        check('slope reads nearly flat (< 3 deg)', r.slope < 3, `slope ${r.slope}`);
        check('tz label shows America/Chicago', r.tzLabel.includes('America/Chicago'), r.tzLabel);
    }

    console.log('scenario: Denver reference cross-check (MDT display)');
    await analyze(page, REF.denver.lat, REF.denver.lng);
    {
        const r = await readSidebar(page);
        check('tz label shows MDT', r.tzLabel.includes('MDT'), r.tzLabel);
        const refRise = refMinutes(REF.denver.sunriseUTC, 'America/Denver');
        check('astronomical sunrise within 3 min of reference', Math.abs(parseClock(r.astroSunrise) - refRise) <= 3,
            `shown ${r.astroSunrise} vs ref ${refRise.toFixed(1)}`);
        const refSet = refMinutes(REF.denver.sunsetUTC, 'America/Denver');
        check('astronomical sunset within 3 min of reference', Math.abs(parseClock(r.astroSunset) - refSet) <= 3,
            `shown ${r.astroSunset} vs ref ${refSet.toFixed(1)}`);
    }

    console.log('scenario: Chamonix valley (terrain delay, Paris local time)');
    await analyze(page, REF.chamonix.lat, REF.chamonix.lng);
    {
        const r = await readSidebar(page);
        const refRise = refMinutes(REF.chamonix.sunriseUTC, 'Europe/Paris');
        check('sunrise displayed in Europe/Paris local time (TZ regression)',
            Math.abs(parseClock(r.astroSunrise) - refRise) <= 3,
            `shown ${r.astroSunrise} vs Paris ref ${refRise.toFixed(1)}`);
        check('valley terrain sunrise >= 30 min after astronomical',
            parseClock(r.terrainSunrise) - parseClock(r.astroSunrise) >= 30,
            `astro ${r.astroSunrise} terrain ${r.terrainSunrise}`);
        check('valley floor elevation 950-1200 m', r.elevation > 950 && r.elevation < 1200, `got ${r.elevation}`);
        const hours = Number(r.totalSunHours.match(/([\d.]+)/)?.[1]);
        check('total sun hours < astronomical day length', hours < 15.8, `got ${hours}`);
        check('sun-on-slope time present', /\d{1,2}:\d{2}/.test(r.slopeStart), r.slopeStart);
    }

    console.log('scenario: Mt. Rainier south flank (slope/aspect sanity)');
    await analyze(page, REF.rainierSouth.lat, REF.rainierSouth.lng);
    {
        const r = await readSidebar(page);
        check('slope is significant (> 5 deg)', r.slope > 5, `slope ${r.slope}`);
        const aspectDeg = Number(r.aspectText.match(/\((\d+)°\)/)?.[1]);
        check('south flank faces south-ish (aspect 120-240)', aspectDeg >= 120 && aspectDeg <= 240, r.aspectText);
        check('aspect text says South facing', r.aspectText.includes('South'), r.aspectText);
    }

    check('no unexpected alert dialogs', dialogs.length === 0, dialogs.join(' | '));
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await page.close();

    console.log('scenario: mobile viewport controls');
    {
        const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York' });
        const mpage = await mobile.newPage();
        const mErrors = [];
        mpage.on('pageerror', (e) => mErrors.push(String(e)));
        mpage.on('dialog', (d) => d.dismiss().catch(() => {}));
        await mpage.route('**/*', routeAll);
        await mpage.goto(`http://localhost:${PORT}/`);
        await mpage.waitForFunction(() => window.solarMap && window.solarMap.map, null, { timeout: 30000 });

        const visible = await mpage.evaluate(() => document.getElementById('mobile-controls').style.display);
        check('mobile controls revealed on small screens', visible === 'block', `display=${visible}`);

        await analyze(mpage, REF.denver.lat, REF.denver.lng);
        const changed = await mpage.evaluate(() => {
            const slider = document.getElementById('time-slider-mobile');
            slider.value = 300; // 05:00, before sunrise
            slider.dispatchEvent(new Event('input'));
            return {
                display: document.getElementById('time-display-mobile').textContent,
                mirrored: document.getElementById('time-slider').value,
                exposure: document.getElementById('current-exposure').textContent,
            };
        });
        check('mobile slider drives the clock', changed.display === '05:00', `display ${changed.display}`);
        check('mobile slider mirrors to desktop control', changed.mirrored === '300', `desktop ${changed.mirrored}`);
        check('pre-dawn exposure is 0', changed.exposure === '0', `exposure ${changed.exposure}`);
        check('no page errors in mobile flow', mErrors.length === 0, mErrors.join(' | '));
        await mobile.close();
    }

    console.log(`  info tile requests total: ${tileRequests}`);
} finally {
    await browser.close();
    server.kill();
}

console.log(failures === 0 ? '\nAll e2e checks passed.' : `\n${failures} e2e check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
