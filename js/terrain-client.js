// GENERATED from Sun_Tracker_Leaflet/terrain-client.js — keep logic in sync.
(function (global) {
'use strict';
// TerrainClient — real elevation data from AWS Terrain Tiles (terrarium encoding).
//
// Data: Mapzen/AWS Terrain Tiles, https://registry.opendata.aws/terrain-tiles/
// (SRTM, 3DEP, GEBCO and other sources). No API key, CORS-enabled, zoom 0-15.
// Encoding: elevation_m = (R * 256 + G + B / 256) - 32768
//
// One client instance serves point elevation, slope/aspect sampling and
// horizon rays so every part of the analysis sees the same terrain.

const AWS_TERRARIUM_URL =
    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

// Fallback source (also terrarium-encoded, but capped at zoom 12 globally):
// 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'  (512px tiles — set tileSize: 512)

const POINT_ZOOM = 14; // used for point elevation and slope/aspect

const TILE_CACHE_MAX = 150;   // ~40 MB of Float32Array elevation data
const FETCH_CONCURRENCY = 8;

// Terrarium RGB -> meters.
function decodeTerrarium(r, g, b) {
    return (r * 256 + g + b / 256) - 32768;
}

// Ground resolution of one tile pixel in meters at a given latitude/zoom.
function groundResolution(lat, zoom, tileSize = 256) {
    return (Math.cos(lat * Math.PI / 180) * 2 * Math.PI * 6378137) / (tileSize * Math.pow(2, zoom));
}

class TerrainClient {
    constructor(options = {}) {
        this.baseUrl = options.baseUrl
            || (typeof window !== 'undefined' && window.__TILE_BASE__)
            || AWS_TERRARIUM_URL;
        this.tileSize = options.tileSize || 256;
        this.maxTiles = options.maxTiles || TILE_CACHE_MAX;
        this.tiles = new Map();     // "z/x/y" -> Float32Array | null (null = failed)
        this.inflight = new Map();  // "z/x/y" -> Promise
    }

    tileUrl(z, x, y) {
        if (this.baseUrl.includes('{z}')) {
            return this.baseUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        }
        return `${this.baseUrl}/${z}/${x}/${y}.png`;
    }

    // Continuous global pixel coordinates (Web Mercator) at a zoom level.
    project(lat, lng, zoom) {
        const n = Math.pow(2, zoom) * this.tileSize;
        const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
        const sinLat = Math.sin(clamped * Math.PI / 180);
        return {
            px: ((lng + 180) / 360) * n,
            py: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n,
            n,
        };
    }

    async loadTile(z, x, y) {
        const worldTiles = Math.pow(2, z);
        x = ((x % worldTiles) + worldTiles) % worldTiles; // wrap longitude
        if (y < 0 || y >= worldTiles) return null;
        const key = `${z}/${x}/${y}`;
        if (this.tiles.has(key)) {
            const data = this.tiles.get(key);
            this.tiles.delete(key); // LRU refresh
            this.tiles.set(key, data);
            return data;
        }
        if (this.inflight.has(key)) return this.inflight.get(key);
        const promise = this.fetchAndDecode(z, x, y)
            .catch(() => null)
            .then((data) => {
                this.inflight.delete(key);
                this.tiles.set(key, data);
                while (this.tiles.size > this.maxTiles) {
                    this.tiles.delete(this.tiles.keys().next().value);
                }
                return data;
            });
        this.inflight.set(key, promise);
        return promise;
    }

    async fetchAndDecode(z, x, y) {
        const response = await fetch(this.tileUrl(z, x, y), { mode: 'cors' });
        if (!response.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${response.status}`);
        const bitmap = await createImageBitmap(await response.blob());
        const size = this.tileSize;
        const canvas = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(size, size)
            : Object.assign(document.createElement('canvas'), { width: size, height: size });
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        const elev = new Float32Array(size * size);
        for (let i = 0; i < elev.length; i++) {
            const j = i * 4;
            elev[i] = decodeTerrarium(data[j], data[j + 1], data[j + 2]);
        }
        return elev;
    }

    // The four pixel-center neighbors used for bilinear sampling, with weights.
    bilinearTaps(lat, lng, zoom) {
        const { px, py, n } = this.project(lat, lng, zoom);
        const fx = px - 0.5;
        const fy = Math.max(0, Math.min(n - 1.001, py - 0.5));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const taps = [];
        for (const [dx, dy, w] of [
            [0, 0, (1 - tx) * (1 - ty)],
            [1, 0, tx * (1 - ty)],
            [0, 1, (1 - tx) * ty],
            [1, 1, tx * ty],
        ]) {
            const gx = x0 + dx;
            const gy = Math.max(0, Math.min(n - 1, y0 + dy));
            taps.push({
                tileX: Math.floor(gx / this.tileSize),
                tileY: Math.floor(gy / this.tileSize),
                pixelX: ((gx % this.tileSize) + this.tileSize) % this.tileSize,
                pixelY: gy % this.tileSize,
                weight: w,
            });
        }
        return taps;
    }

    tileKeysFor(lat, lng, zoom) {
        const worldTiles = Math.pow(2, zoom);
        const keys = new Set();
        for (const tap of this.bilinearTaps(lat, lng, zoom)) {
            const tx = ((tap.tileX % worldTiles) + worldTiles) % worldTiles;
            if (tap.tileY >= 0 && tap.tileY < worldTiles) keys.add(`${zoom}/${tx}/${tap.tileY}`);
        }
        return keys;
    }

    // Bilinear read using only already-loaded tiles. Returns null if any
    // needed tile is missing or failed — never a silent 0.
    getElevationSync(lat, lng, zoom) {
        const worldTiles = Math.pow(2, zoom);
        let sum = 0;
        for (const tap of this.bilinearTaps(lat, lng, zoom)) {
            const tx = ((tap.tileX % worldTiles) + worldTiles) % worldTiles;
            const tile = this.tiles.get(`${zoom}/${tx}/${tap.tileY}`);
            if (!tile) return null;
            sum += tile[tap.pixelY * this.tileSize + tap.pixelX] * tap.weight;
        }
        return sum;
    }

    async getElevation(lat, lng, zoom = POINT_ZOOM) {
        await this.ensureTiles(this.tileKeysFor(lat, lng, zoom));
        return this.getElevationSync(lat, lng, zoom);
    }

    // points: Array<{lat, lng, zoom?}>. Prefetches all needed tiles with a
    // small concurrency pool, then samples synchronously from cache.
    async getElevations(points, defaultZoom = POINT_ZOOM) {
        const keys = new Set();
        for (const p of points) {
            for (const key of this.tileKeysFor(p.lat, p.lng, p.zoom || defaultZoom)) keys.add(key);
        }
        await this.ensureTiles(keys);
        return points.map((p) => this.getElevationSync(p.lat, p.lng, p.zoom || defaultZoom));
    }

    async prefetchBounds(bounds, zoom) {
        // bounds: {north, south, east, west}
        const nw = this.project(bounds.north, bounds.west, zoom);
        const se = this.project(bounds.south, bounds.east, zoom);
        const keys = new Set();
        const x0 = Math.floor(nw.px / this.tileSize);
        const x1 = Math.floor(se.px / this.tileSize);
        const y0 = Math.floor(nw.py / this.tileSize);
        const y1 = Math.floor(se.py / this.tileSize);
        const worldTiles = Math.pow(2, zoom);
        for (let x = x0; x <= x1; x++) {
            for (let y = Math.max(0, y0); y <= Math.min(worldTiles - 1, y1); y++) {
                keys.add(`${zoom}/${((x % worldTiles) + worldTiles) % worldTiles}/${y}`);
            }
        }
        await this.ensureTiles(keys);
    }

    async ensureTiles(keys) {
        const missing = [...keys].filter((key) => !this.tiles.has(key));
        let next = 0;
        const worker = async () => {
            while (next < missing.length) {
                const [z, x, y] = missing[next++].split('/').map(Number);
                await this.loadTile(z, x, y);
            }
        };
        await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, missing.length) }, worker));
    }

    clearCache() {
        this.tiles.clear();
    }
}

const api = { AWS_TERRARIUM_URL, POINT_ZOOM, decodeTerrarium, groundResolution, TerrainClient };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
global.TerrainTiles = api;
})(typeof window !== 'undefined' ? window : globalThis);
