/**
 * Solar Exposure Map Application
 * Calculates and visualizes sun exposure on terrain considering slope aspect,
 * terrain occlusion and the clicked location's own time zone.
 *
 * Terrain data: Mapzen/AWS Terrain Tiles via js/terrain-client.js.
 * Solar/terrain math: js/solar-core.js (shared with the Sun Tracker app).
 */

const { TerrainClient, POINT_ZOOM, groundResolution } = window.TerrainTiles;

class SolarExposureMap {
    constructor() {
        this.map = null;
        this.exposureLayer = null;
        this.animationInterval = null;
        this.terrain = new TerrainClient();
        this.terrainCache = new Map();
        this.showShadows = true;
        this.showAspect = true;
        this.clickMarker = null;
        this.analysis = null;       // cached per-click horizon/slope state
        this.overlayToken = 0;

        // Default location - Bridger Bowl, Montana (great skiing and terrain analysis!)
        this.defaultCenter = [45.8165, -110.9045];
        this.defaultZoom = 13;

        // Time model: a calendar date string plus minutes-since-midnight,
        // both interpreted in the analyzed location's time zone.
        this.timeZone = tzlookup(this.defaultCenter[0], this.defaultCenter[1]);
        this.dateStr = new Date().toISOString().split('T')[0];
        this.sliderMinutes = 720;

        this.init();
    }

    init() {
        this.initMap();
        this.initControls();
        this.updateSunPosition();
        this.createExposureLayer();
        this.setupEventListeners();
    }

    // The instant currently selected by the date + time controls,
    // anchored to local midnight in the analyzed location's zone.
    currentTime() {
        const dayStart = SolarCore.zonedMidnightUTC(this.dateStr, this.timeZone);
        return new Date(dayStart.getTime() + this.sliderMinutes * 60000);
    }

    initMap() {
        this.map = L.map('map', {
            center: this.defaultCenter,
            zoom: this.defaultZoom,
            zoomControl: true
        });

        L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap' +
                ' | Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen/AWS Terrain Tiles</a>',
            maxZoom: 17
        }).addTo(this.map);

        L.control.scale().addTo(this.map);

        this.map.on('moveend', () => {
            if (this.showAspect) this.updateExposureLayer();
        });

        this.map.on('click', (e) => {
            this.showPointInfo(e.latlng);
        });
    }

    // Wall-clock "now" in the active time zone -> {dateStr, minutes}
    wallClockNow() {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: this.timeZone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(new Date());
        const get = (t) => parts.find((p) => p.type === t).value;
        return {
            dateStr: `${get('year')}-${get('month')}-${get('day')}`,
            minutes: Number(get('hour')) * 60 + Number(get('minute')),
        };
    }

    // Return every control element matching the desktop and mobile ids.
    controlEls(id) {
        return [id, `${id}-mobile`]
            .map((elId) => document.getElementById(elId))
            .filter(Boolean);
    }

    initControls() {
        const now = this.wallClockNow();
        this.dateStr = now.dateStr;
        this.sliderMinutes = Math.min(1425, Math.round(now.minutes / 15) * 15);

        this.controlEls('date-input').forEach((el) => { el.value = this.dateStr; });
        this.controlEls('time-slider').forEach((el) => { el.value = this.sliderMinutes; });
        this.controlEls('shadow-toggle').forEach((el) => { el.checked = this.showShadows; });
        this.controlEls('aspect-toggle').forEach((el) => { el.checked = this.showAspect; });
        this.updateTimeDisplay();
    }

    setupEventListeners() {
        // Each control exists twice (desktop + mobile); bind both and mirror values.
        this.controlEls('date-input').forEach((el) => el.addEventListener('change', (e) => {
            this.dateStr = e.target.value;
            this.controlEls('date-input').forEach((other) => { other.value = this.dateStr; });
            this.updateSunPosition();
            this.renderAnalysis();
        }));

        this.controlEls('time-slider').forEach((el) => el.addEventListener('input', (e) => {
            this.sliderMinutes = parseInt(e.target.value, 10);
            this.controlEls('time-slider').forEach((other) => { other.value = this.sliderMinutes; });
            this.updateTimeDisplay();
            this.updateSunPosition();
            this.renderCurrentExposure();
        }));

        this.controlEls('now-button').forEach((el) => el.addEventListener('click', () => {
            const now = this.wallClockNow();
            this.dateStr = now.dateStr;
            this.sliderMinutes = Math.min(1425, Math.round(now.minutes / 15) * 15);
            this.controlEls('date-input').forEach((other) => { other.value = this.dateStr; });
            this.controlEls('time-slider').forEach((other) => { other.value = this.sliderMinutes; });
            this.updateTimeDisplay();
            this.updateSunPosition();
            this.renderAnalysis();
        }));

        this.controlEls('animate-button').forEach((el) => el.addEventListener('click', () => {
            this.toggleAnimation();
        }));

        this.controlEls('shadow-toggle').forEach((el) => el.addEventListener('change', (e) => {
            this.showShadows = e.target.checked;
            this.controlEls('shadow-toggle').forEach((other) => { other.checked = this.showShadows; });
            this.renderCurrentExposure();
        }));

        this.controlEls('aspect-toggle').forEach((el) => el.addEventListener('change', (e) => {
            this.showAspect = e.target.checked;
            this.controlEls('aspect-toggle').forEach((other) => { other.checked = this.showAspect; });
            this.updateExposureLayer();
        }));
    }

    updateTimeDisplay() {
        const hours = Math.floor(this.sliderMinutes / 60);
        const mins = this.sliderMinutes % 60;
        const timeStr = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
        this.controlEls('time-display').forEach((el) => { el.textContent = timeStr; });
    }

    updateSunPosition() {
        // Map-center sun position for the header badge only; per-point analysis
        // always computes the sun at the clicked location.
        const center = this.map.getCenter();
        const sunPos = SunCalc.getPosition(this.currentTime(), center.lat, center.lng);

        const azimuth = ((sunPos.azimuth * 180 / Math.PI) + 180) % 360;
        const altitude = sunPos.altitude * 180 / Math.PI;

        const sunBadge = document.getElementById('sun-badge');
        if (altitude < 0) {
            sunBadge.textContent = '🌙 Night';
        } else if (altitude < 10) {
            sunBadge.textContent = '🌅 ' + azimuth.toFixed(0) + '°';
        } else {
            sunBadge.textContent = '☀ ' + azimuth.toFixed(0) + '° / ' + altitude.toFixed(0) + '°';
        }
    }

    createExposureLayer() {
        // Simple aspect overlay (optional) - no ray-casting
        const ExposureOverlay = L.Layer.extend({
            onAdd: function(map) {
                this._map = map;

                if (!this._canvas) {
                    this._canvas = L.DomUtil.create('canvas', 'aspect-overlay');
                    this._canvas.style.position = 'absolute';
                    this._canvas.style.top = '0';
                    this._canvas.style.left = '0';
                    this._canvas.style.zIndex = '400';
                }

                map.getPanes().overlayPane.appendChild(this._canvas);
                map.on('moveend', this._reset, this);
                map.on('zoom', this._reset, this);

                this._reset();
            },

            onRemove: function(map) {
                L.DomUtil.remove(this._canvas);
                map.off('moveend', this._reset, this);
                map.off('zoom', this._reset, this);
            },

            _reset: function() {
                const size = this._map.getSize();
                this._canvas.width = size.x;
                this._canvas.height = size.y;

                const topLeft = this._map.containerPointToLayerPoint([0, 0]);
                L.DomUtil.setPosition(this._canvas, topLeft);
            },

            getCanvas: function() {
                return this._canvas;
            }
        });

        this.exposureLayer = new ExposureOverlay();
        this.exposureLayer.addTo(this.map);
    }

    async updateExposureLayer() {
        if (!this.exposureLayer) return;
        const canvas = this.exposureLayer.getCanvas();
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        if (!this.showAspect) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }

        const token = ++this.overlayToken;
        await this.renderSimpleAspect(ctx, canvas.width, canvas.height, token);
    }

    async renderSimpleAspect(ctx, width, height, token) {
        const zoom = Math.min(this.map.getZoom(), 12);
        const bounds = this.map.getBounds().pad(0.05);

        // Prefetch every tile the viewport needs, then sample synchronously —
        // no per-pixel awaits.
        await this.terrain.prefetchBounds({
            north: bounds.getNorth(), south: bounds.getSouth(),
            east: bounds.getEast(), west: bounds.getWest(),
        }, zoom);
        if (token !== this.overlayToken) return; // superseded by a newer render

        const imageData = ctx.createImageData(width, height);
        const data = imageData.data;
        const sampleRate = Math.max(4, Math.floor(16 - this.map.getZoom()));

        const deltaM = 1.5 * groundResolution(this.map.getCenter().lat, zoom);
        const dLat = deltaM / 111320;

        for (let y = 0; y < height; y += sampleRate) {
            for (let x = 0; x < width; x += sampleRate) {
                const point = this.map.containerPointToLatLng([x, y]);
                const dLng = deltaM / (111320 * Math.cos(point.lat * Math.PI / 180));
                const north = this.terrain.getElevationSync(point.lat + dLat, point.lng, zoom);
                const south = this.terrain.getElevationSync(point.lat - dLat, point.lng, zoom);
                const east = this.terrain.getElevationSync(point.lat, point.lng + dLng, zoom);
                const west = this.terrain.getElevationSync(point.lat, point.lng - dLng, zoom);
                if (north === null || south === null || east === null || west === null) continue;

                const dzdx = (east - west) / (2 * deltaM);
                const dzdy = (north - south) / (2 * deltaM);
                const aspect = ((Math.atan2(-dzdx, -dzdy) * 180 / Math.PI) + 360) % 360;
                const color = this.getAspectColor(aspect);

                for (let dy = 0; dy < sampleRate && (y + dy) < height; dy++) {
                    for (let dx = 0; dx < sampleRate && (x + dx) < width; dx++) {
                        const idx = ((y + dy) * width + (x + dx)) * 4;
                        data[idx] = color.r;
                        data[idx + 1] = color.g;
                        data[idx + 2] = color.b;
                        data[idx + 3] = color.a;
                    }
                }
            }
        }

        if (token !== this.overlayToken) return;
        ctx.clearRect(0, 0, width, height);
        ctx.putImageData(imageData, 0, 0);
    }

    getAspectColor(aspect) {
        // Simple color based on aspect only
        let baseColor;

        if (aspect >= 315 || aspect < 45) {
            baseColor = { r: 77, g: 77, b: 255 }; // North - Blue
        } else if (aspect >= 45 && aspect < 135) {
            baseColor = { r: 255, g: 255, b: 0 }; // East - Yellow
        } else if (aspect >= 135 && aspect < 225) {
            baseColor = { r: 255, g: 0, b: 0 }; // South - Red
        } else {
            baseColor = { r: 255, g: 128, b: 0 }; // West - Orange
        }

        return {
            r: baseColor.r,
            g: baseColor.g,
            b: baseColor.b,
            a: 100 // Light transparent
        };
    }

    // Elevation + slope/aspect at a point, cached by DEM pixel.
    async getTerrainData(lat, lng) {
        const { px, py } = this.terrain.project(lat, lng, POINT_ZOOM);
        const key = `${Math.round(px)}/${Math.round(py)}`;

        if (this.terrainCache.has(key)) {
            return this.terrainCache.get(key);
        }

        const result = await SolarCore.computeSlopeAspect(
            this.terrain, lat, lng, POINT_ZOOM, groundResolution(lat, POINT_ZOOM)
        );
        if (!result) return null;

        this.terrainCache.set(key, result);
        if (this.terrainCache.size > 10000) {
            this.terrainCache.delete(this.terrainCache.keys().next().value);
        }
        return result;
    }

    // Instantaneous exposure (0..1) of the analyzed slope at a given time.
    exposureAt(time) {
        const { terrainData, horizonProfile, sampler } = this.analysis;
        const pos = sampler(time);
        if (pos.altitude <= -0.8333) return { exposure: 0, altitude: pos.altitude };

        const clearsTerrain = !this.showShadows
            || pos.altitude + SolarCore.SUN_SEMIDIAMETER + SolarCore.bennettRefraction(pos.altitude)
                > SolarCore.horizonAt(horizonProfile, pos.azimuth);
        const incidence = SolarCore.slopeIncidence(
            pos.altitude, pos.azimuth, terrainData.slope, terrainData.aspect
        );
        return {
            exposure: clearsTerrain && pos.altitude > 0 ? Math.max(0, Math.min(1, incidence)) : 0,
            altitude: pos.altitude,
        };
    }

    async showPointInfo(latlng) {
        document.getElementById('loading').classList.add('active');

        // Add or update marker at clicked location
        if (this.clickMarker) {
            this.clickMarker.setLatLng(latlng);
        } else {
            const markerIcon = L.divIcon({
                className: 'custom-marker',
                html: `
                    <div style="
                        width: 20px;
                        height: 20px;
                        background: #ff6b00;
                        border: 3px solid white;
                        border-radius: 50%;
                        box-shadow: 0 0 12px rgba(255,107,0,0.8);
                    "></div>
                `,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });

            this.clickMarker = L.marker(latlng, { icon: markerIcon }).addTo(this.map);
        }

        try {
            this.timeZone = tzlookup(latlng.lat, latlng.lng);

            const terrainData = await this.getTerrainData(latlng.lat, latlng.lng);
            if (!terrainData) {
                document.getElementById('loading').classList.remove('active');
                alert('No terrain data available for this location. Try a different area or check your connection.');
                return;
            }

            const horizonProfile = await SolarCore.computeHorizonProfile(
                this.terrain, latlng.lat, latlng.lng, terrainData.elevation
            );

            this.analysis = {
                latlng,
                terrainData,
                horizonProfile,
                sampler: SolarCore.makeSunSampler(SunCalc, latlng.lat, latlng.lng),
            };

            this.renderAnalysis();
        } catch (error) {
            console.error('Error calculating sun data:', error);
            alert('Error calculating solar data: ' + error.message);
        }

        document.getElementById('loading').classList.remove('active');
    }

    // Re-render the whole sidebar from cached per-click state. Pure math —
    // safe to call on every date change.
    renderAnalysis() {
        if (!this.analysis) return;
        const { latlng, terrainData, horizonProfile, sampler } = this.analysis;
        const tz = this.timeZone;
        const fmt = (d) => SolarCore.formatTimeInZone(d, tz, { hour12: false });

        document.getElementById('empty-state').style.display = 'none';
        document.getElementById('solar-data').style.display = 'block';

        document.getElementById('location-coords').textContent =
            `${latlng.lat.toFixed(6)}°, ${latlng.lng.toFixed(6)}°`;

        const dayStart = SolarCore.zonedMidnightUTC(this.dateStr, tz);
        const localNoon = new Date(dayStart.getTime() + 12 * 3600 * 1000);
        document.getElementById('tz-label').textContent =
            `All times in ${SolarCore.zoneAbbreviation(localNoon, tz)} (${tz})`;

        document.getElementById('elevation-value').textContent = Math.round(terrainData.elevation);
        document.getElementById('slope-value').textContent = terrainData.slope.toFixed(1);
        document.getElementById('aspect-value').textContent =
            `${this.getAspectDirection(terrainData.aspect)} (${terrainData.aspect.toFixed(0)}°) - ` +
            `${this.getSlopeFacing(terrainData.aspect)} facing`;

        // One visibility-interval computation drives every terrain-aware time.
        const horizonFn = (az) => SolarCore.horizonAt(horizonProfile, az);
        const day = SolarCore.computeSunDay(sampler, horizonFn, dayStart, {
            slope: terrainData.slope,
            aspect: terrainData.aspect,
        });
        const astronomical = SunCalc.getTimes(localNoon, latlng.lat, latlng.lng);

        document.getElementById('astronomical-sunrise').textContent = fmt(astronomical.sunrise);
        document.getElementById('astronomical-sunset').textContent = fmt(astronomical.sunset);
        document.getElementById('sunrise-time').textContent = fmt(day.terrainSunrise);
        document.getElementById('sunset-time').textContent = fmt(day.terrainSunset);
        document.getElementById('slope-sun-start').textContent = fmt(day.firstLightOnSlope);
        document.getElementById('slope-sun-end').textContent = fmt(day.lastLightOnSlope);

        document.getElementById('total-sun-hours').textContent =
            `${(day.litSunHours ?? day.visibleSunHours).toFixed(1)}h`;

        this.renderCurrentExposure();
    }

    // Current exposure % + hourly chart; cheap enough to run on slider input.
    renderCurrentExposure() {
        if (!this.analysis) return;

        const now = this.exposureAt(this.currentTime());
        document.getElementById('current-exposure').textContent = Math.round(now.exposure * 100);

        const inShadow = now.exposure === 0 && now.altitude > 0;
        const status = now.altitude < 0 ? '🌙 Night' :
                      inShadow ? '🌑 Shadow' :
                      now.exposure > 0.7 ? '☀️ Full Sun' :
                      now.exposure > 0.3 ? '⛅ Partial' : '🌤️ Low';
        document.getElementById('sun-status').textContent = status;

        const dayStart = SolarCore.zonedMidnightUTC(this.dateStr, this.timeZone);
        const hourlyData = [];
        for (let hour = 0; hour < 24; hour++) {
            const sample = this.exposureAt(new Date(dayStart.getTime() + (hour + 0.5) * 3600 * 1000));
            hourlyData.push({ hour, exposure: sample.exposure, altitude: sample.altitude });
        }
        this.updateHourlyChart(hourlyData);
    }

    updateHourlyChart(hourlyData) {
        const chartBars = document.getElementById('exposure-bars');
        chartBars.innerHTML = '';

        const currentHour = Math.floor(this.sliderMinutes / 60);

        hourlyData.forEach(data => {
            const bar = document.createElement('div');
            bar.className = 'chart-bar';

            const height = data.exposure * 100;
            bar.style.height = `${height}%`;

            if (data.exposure > 0) {
                bar.classList.add('exposed');
            } else if (data.altitude > 0) {
                bar.classList.add('shadow');
            }

            if (data.hour === currentHour) {
                bar.classList.add('current');
            }

            chartBars.appendChild(bar);
        });
    }

    getAspectDirection(aspect) {
        const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const index = Math.round(aspect / 45) % 8;
        return directions[index];
    }

    getSlopeFacing(aspect) {
        if (aspect >= 315 || aspect < 45) {
            return '❄️ North'; // Cold, shaded
        } else if (aspect >= 45 && aspect < 135) {
            return '🌅 East'; // Morning sun
        } else if (aspect >= 135 && aspect < 225) {
            return '☀️ South'; // Maximum sun
        } else {
            return '🌇 West'; // Afternoon sun
        }
    }

    toggleAnimation() {
        const buttons = this.controlEls('animate-button');

        if (this.animationInterval) {
            clearInterval(this.animationInterval);
            this.animationInterval = null;
            buttons.forEach((b) => {
                b.textContent = 'Animate';
                b.classList.add('btn-secondary');
                b.classList.remove('btn-primary');
            });
        } else {
            buttons.forEach((b) => {
                b.textContent = 'Stop';
                b.classList.add('btn-primary');
                b.classList.remove('btn-secondary');
            });

            this.animationInterval = setInterval(() => {
                this.sliderMinutes = (this.sliderMinutes + 15) % 1440;
                if (this.sliderMinutes > 1425) this.sliderMinutes = 0;

                this.controlEls('time-slider').forEach((el) => { el.value = this.sliderMinutes; });
                this.updateTimeDisplay();
                this.updateSunPosition();
                this.renderCurrentExposure();
            }, 200);
        }
    }
}

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.solarMap = new SolarExposureMap();
});
