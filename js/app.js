/**
 * Solar Exposure Map Application
 * Calculates and visualizes sun exposure on terrain considering slope aspect and shadows
 */

class SolarExposureMap {
    constructor() {
        this.map = null;
        this.exposureLayer = null;
        this.currentDate = new Date();
        this.animationInterval = null;
        this.terrainCache = new Map();
        this.tileCache = new Map();
        this.tileSize = 512;
        this.showShadows = true;
        this.showAspect = true;

        // Default location (Rocky Mountains - great for skiing!)
        this.defaultCenter = [39.7392, -104.9903]; // Denver area
        this.defaultZoom = 12;

        // Terrain-RGB tile source (free, no API key needed)
        this.terrainTileUrl = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

        this.init();
    }

    init() {
        this.initMap();
        this.initControls();
        this.updateSunPosition();
        this.createExposureLayer();
        this.setupEventListeners();
    }

    initMap() {
        // Initialize Leaflet map
        this.map = L.map('map', {
            center: this.defaultCenter,
            zoom: this.defaultZoom,
            zoomControl: true
        });

        // Add base map layer (terrain style)
        L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap',
            maxZoom: 17
        }).addTo(this.map);

        // Add scale control
        L.control.scale().addTo(this.map);

        // Update location display
        this.updateLocationDisplay();

        // Listen to map movements
        this.map.on('moveend', () => {
            this.updateLocationDisplay();
            this.updateExposureLayer();
        });

        this.map.on('zoomend', () => {
            this.updateExposureLayer();
        });

        // Click handler for detailed info
        this.map.on('click', (e) => {
            this.showPointInfo(e.latlng);
        });

        // Mouse move for hover info
        this.map.on('mousemove', (e) => {
            this.updateHoverInfo(e);
        });
    }

    initControls() {
        // Date input
        const dateInput = document.getElementById('date-input');
        const today = new Date();
        dateInput.value = today.toISOString().split('T')[0];
        this.currentDate = today;

        // Time slider
        const timeSlider = document.getElementById('time-slider');
        const currentMinutes = today.getHours() * 60 + today.getMinutes();
        timeSlider.value = currentMinutes;
        this.updateTimeDisplay(currentMinutes);

        // Shadow toggle
        document.getElementById('shadow-toggle').checked = this.showShadows;

        // Aspect toggle
        document.getElementById('aspect-toggle').checked = this.showAspect;
    }

    setupEventListeners() {
        // Date change
        document.getElementById('date-input').addEventListener('change', (e) => {
            const [year, month, day] = e.target.value.split('-');
            this.currentDate.setFullYear(year, month - 1, day);
            this.updateSunPosition();
            this.updateExposureLayer();
        });

        // Time slider
        document.getElementById('time-slider').addEventListener('input', (e) => {
            const minutes = parseInt(e.target.value);
            this.updateTimeDisplay(minutes);

            const hours = Math.floor(minutes / 60);
            const mins = minutes % 60;
            this.currentDate.setHours(hours, mins);

            this.updateSunPosition();
            this.updateExposureLayer();
        });

        // Now button
        document.getElementById('now-button').addEventListener('click', () => {
            const now = new Date();
            this.currentDate = now;

            document.getElementById('date-input').value = now.toISOString().split('T')[0];
            const minutes = now.getHours() * 60 + now.getMinutes();
            document.getElementById('time-slider').value = minutes;
            this.updateTimeDisplay(minutes);

            this.updateSunPosition();
            this.updateExposureLayer();
        });

        // Animate button
        document.getElementById('animate-button').addEventListener('click', () => {
            this.toggleAnimation();
        });

        // Shadow toggle
        document.getElementById('shadow-toggle').addEventListener('change', (e) => {
            this.showShadows = e.target.checked;
            this.updateExposureLayer();
        });

        // Aspect toggle
        document.getElementById('aspect-toggle').addEventListener('change', (e) => {
            this.showAspect = e.target.checked;
            this.updateExposureLayer();
        });
    }

    updateTimeDisplay(minutes) {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        const timeStr = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
        document.getElementById('time-display').textContent = timeStr;
    }

    updateSunPosition() {
        const center = this.map.getCenter();
        const sunPos = SunCalc.getPosition(this.currentDate, center.lat, center.lng);

        // Convert to degrees
        const azimuth = ((sunPos.azimuth * 180 / Math.PI) + 180) % 360; // 0 = North
        const altitude = sunPos.altitude * 180 / Math.PI;

        this.sunAzimuth = azimuth;
        this.sunAltitude = altitude;

        document.getElementById('sun-azimuth').textContent = azimuth.toFixed(1) + '°';
        document.getElementById('sun-altitude').textContent = altitude.toFixed(1) + '°';
    }

    updateLocationDisplay() {
        const center = this.map.getCenter();
        document.getElementById('location').textContent =
            `${center.lat.toFixed(4)}°, ${center.lng.toFixed(4)}°`;
    }

    createExposureLayer() {
        // Create a canvas overlay for the exposure layer
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

        this.updateExposureLayer();
    }

    async updateExposureLayer() {
        if (!this.exposureLayer) return;

        const canvas = this.exposureLayer.getCanvas();
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;

        // Clear canvas
        ctx.clearRect(0, 0, width, height);

        // Show loading
        document.getElementById('loading').classList.add('active');

        // Small delay to allow UI to update
        await new Promise(resolve => setTimeout(resolve, 10));

        try {
            await this.renderExposure(ctx, width, height);
        } catch (error) {
            console.error('Error rendering exposure:', error);
        }

        // Hide loading
        document.getElementById('loading').classList.remove('active');
    }

    async renderExposure(ctx, width, height) {
        const imageData = ctx.createImageData(width, height);
        const data = imageData.data;

        const bounds = this.map.getBounds();
        const zoom = this.map.getZoom();

        // Sample at lower resolution for performance
        const sampleRate = Math.max(1, Math.floor(4 / Math.min(zoom / 10, 1)));

        for (let y = 0; y < height; y += sampleRate) {
            for (let x = 0; x < width; x += sampleRate) {
                const point = this.map.containerPointToLatLng([x, y]);

                // Get terrain data for this point
                const terrainData = await this.getTerrainData(point.lat, point.lng, zoom);

                if (!terrainData) continue;

                // Calculate sun exposure
                const exposure = this.calculateExposure(
                    terrainData.aspect,
                    terrainData.slope,
                    terrainData.elevation,
                    point.lat,
                    point.lng
                );

                // Get color based on exposure
                const color = this.getExposureColor(terrainData.aspect, exposure);

                // Fill the sampled area
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

        ctx.putImageData(imageData, 0, 0);
    }

    async getTerrainData(lat, lng, zoom) {
        const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;

        if (this.terrainCache.has(key)) {
            return this.terrainCache.get(key);
        }

        // Get real elevation from terrain tiles
        const elevation = await this.getRealElevation(lat, lng, zoom);

        if (elevation === null) {
            return null;
        }

        // Calculate slope and aspect from real terrain
        const { aspect, slope } = await this.calculateRealSlopeAspect(lat, lng, zoom);

        const data = { elevation, aspect, slope };
        this.terrainCache.set(key, data);

        // Limit cache size
        if (this.terrainCache.size > 10000) {
            const firstKey = this.terrainCache.keys().next().value;
            this.terrainCache.delete(firstKey);
        }

        return data;
    }

    latLngToTile(lat, lng, zoom) {
        // Convert lat/lng to tile coordinates
        const x = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
        const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
        return { x, y, z: zoom };
    }

    async loadTerrainTile(tileX, tileY, zoom) {
        const tileKey = `${zoom}/${tileX}/${tileY}`;

        if (this.tileCache.has(tileKey)) {
            return this.tileCache.get(tileKey);
        }

        try {
            const url = this.terrainTileUrl
                .replace('{z}', zoom)
                .replace('{x}', tileX)
                .replace('{y}', tileY);

            const img = await this.loadImage(url);

            // Draw to canvas to get pixel data
            const canvas = document.createElement('canvas');
            canvas.width = this.tileSize;
            canvas.height = this.tileSize;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            const imageData = ctx.getImageData(0, 0, this.tileSize, this.tileSize);

            this.tileCache.set(tileKey, imageData);

            // Limit tile cache size
            if (this.tileCache.size > 50) {
                const firstKey = this.tileCache.keys().next().value;
                this.tileCache.delete(firstKey);
            }

            return imageData;
        } catch (error) {
            console.error('Error loading terrain tile:', error);
            return null;
        }
    }

    loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = url;
        });
    }

    decodeTerrainRGB(r, g, b) {
        // Terrarium format: elevation = (R * 256 + G + B / 256) - 32768
        return (r * 256 + g + b / 256) - 32768;
    }

    async getRealElevation(lat, lng, zoom) {
        const tile = this.latLngToTile(lat, lng, zoom);
        const tileData = await this.loadTerrainTile(tile.x, tile.y, zoom);

        if (!tileData) return null;

        // Convert lat/lng to pixel position within tile
        const scale = Math.pow(2, zoom);
        const worldX = (lng + 180) / 360 * scale;
        const worldY = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * scale;

        const pixelX = Math.floor((worldX - tile.x) * this.tileSize);
        const pixelY = Math.floor((worldY - tile.y) * this.tileSize);

        if (pixelX < 0 || pixelX >= this.tileSize || pixelY < 0 || pixelY >= this.tileSize) {
            return null;
        }

        const idx = (pixelY * this.tileSize + pixelX) * 4;
        const r = tileData.data[idx];
        const g = tileData.data[idx + 1];
        const b = tileData.data[idx + 2];

        return this.decodeTerrainRGB(r, g, b);
    }

    async calculateRealSlopeAspect(lat, lng, zoom) {
        // Get elevations at neighboring points
        const delta = 0.0001; // ~11 meters

        const elevCenter = await this.getRealElevation(lat, lng, zoom);
        const elevNorth = await this.getRealElevation(lat + delta, lng, zoom);
        const elevSouth = await this.getRealElevation(lat - delta, lng, zoom);
        const elevEast = await this.getRealElevation(lat, lng + delta, zoom);
        const elevWest = await this.getRealElevation(lat, lng - delta, zoom);

        // If any elevation is null, return flat terrain
        if (elevCenter === null || elevNorth === null || elevSouth === null ||
            elevEast === null || elevWest === null) {
            return { aspect: 0, slope: 0 };
        }

        // Calculate gradients in meters
        const metersPerDegree = 111320 * Math.cos(lat * Math.PI / 180);
        const dzdx = (elevEast - elevWest) / (2 * delta * metersPerDegree);
        const dzdy = (elevNorth - elevSouth) / (2 * delta * 111320);

        // Calculate slope (in degrees)
        const slopeRad = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
        const slope = slopeRad * 180 / Math.PI;

        // Calculate aspect (in degrees, 0 = North, 90 = East, 180 = South, 270 = West)
        let aspect = Math.atan2(dzdx, dzdy) * 180 / Math.PI;
        if (aspect < 0) aspect += 360;

        return { aspect, slope };
    }

    calculateExposure(aspect, slope, elevation, lat, lng) {
        // Calculate how much sun exposure this slope receives

        if (this.sunAltitude < 0) {
            // Sun is below horizon
            return 0;
        }

        // Calculate the angle between slope aspect and sun azimuth
        let aspectDiff = Math.abs(aspect - this.sunAzimuth);
        if (aspectDiff > 180) aspectDiff = 360 - aspectDiff;

        // Calculate dot product between slope normal and sun direction
        const slopeRad = slope * Math.PI / 180;
        const aspectRad = aspect * Math.PI / 180;
        const sunAltRad = this.sunAltitude * Math.PI / 180;
        const sunAzRad = this.sunAzimuth * Math.PI / 180;

        // Slope normal vector
        const slopeNx = Math.sin(slopeRad) * Math.sin(aspectRad);
        const slopeNy = Math.sin(slopeRad) * Math.cos(aspectRad);
        const slopeNz = Math.cos(slopeRad);

        // Sun direction vector
        const sunDx = Math.cos(sunAltRad) * Math.sin(sunAzRad);
        const sunDy = Math.cos(sunAltRad) * Math.cos(sunAzRad);
        const sunDz = Math.sin(sunAltRad);

        // Dot product (cosine of angle between vectors)
        let exposure = slopeNx * sunDx + slopeNy * sunDy + slopeNz * sunDz;

        // Clamp to 0-1 range
        exposure = Math.max(0, Math.min(1, exposure));

        // Apply shadow calculation if enabled
        if (this.showShadows) {
            const shadowFactor = this.calculateShadow(lat, lng, elevation);
            exposure *= shadowFactor;
        }

        return exposure;
    }

    calculateShadow(lat, lng, elevation) {
        // Simplified shadow calculation
        // In production, implement proper ray-casting through terrain

        if (this.sunAltitude < 5) {
            // Low sun angle - more likely to be in shadow
            return 0.3;
        }

        // For now, return based on sun altitude
        // Lower sun = more shadows
        return Math.min(1, this.sunAltitude / 45);
    }

    getExposureColor(aspect, exposure) {
        if (!this.showAspect) {
            // Simple exposure gradient
            const intensity = Math.floor(exposure * 255);
            return {
                r: intensity,
                g: intensity,
                b: 0,
                a: 180
            };
        }

        // Color based on aspect and exposure
        let baseColor;

        // North (0/360) - Blue (cold, shaded)
        // East (90) - Yellow (morning sun)
        // South (180) - Red (hot, maximum sun)
        // West (270) - Orange (afternoon sun)

        if (aspect >= 315 || aspect < 45) {
            // North - Blue
            baseColor = { r: 77, g: 77, b: 255 };
        } else if (aspect >= 45 && aspect < 135) {
            // East - Yellow
            baseColor = { r: 255, g: 255, b: 0 };
        } else if (aspect >= 135 && aspect < 225) {
            // South - Red
            baseColor = { r: 255, g: 0, b: 0 };
        } else {
            // West - Orange
            baseColor = { r: 255, g: 128, b: 0 };
        }

        // Modulate by exposure (shadows darken the color)
        const shadowFactor = 0.2 + (exposure * 0.8); // Keep some base visibility

        return {
            r: Math.floor(baseColor.r * shadowFactor),
            g: Math.floor(baseColor.g * shadowFactor),
            b: Math.floor(baseColor.b * shadowFactor),
            a: 160 // Semi-transparent
        };
    }

    async showPointInfo(latlng) {
        const zoom = this.map.getZoom();
        const terrainData = await this.getTerrainData(latlng.lat, latlng.lng, zoom);

        if (!terrainData) return;

        const exposure = this.calculateExposure(
            terrainData.aspect,
            terrainData.slope,
            terrainData.elevation,
            latlng.lat,
            latlng.lng
        );

        // Update info panel
        document.getElementById('elevation').textContent =
            Math.round(terrainData.elevation) + ' m';
        document.getElementById('aspect').textContent =
            this.getAspectDirection(terrainData.aspect) + ' (' + terrainData.aspect.toFixed(0) + '°)';
        document.getElementById('slope').textContent =
            terrainData.slope.toFixed(1) + '°';
        document.getElementById('exposure-value').textContent =
            (exposure * 100).toFixed(0) + '%';
    }

    updateHoverInfo(e) {
        const popup = document.getElementById('info-popup');

        // Position popup near cursor
        popup.style.left = (e.originalEvent.clientX + 15) + 'px';
        popup.style.top = (e.originalEvent.clientY + 15) + 'px';
    }

    getAspectDirection(aspect) {
        const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const index = Math.round(aspect / 45) % 8;
        return directions[index];
    }

    toggleAnimation() {
        const button = document.getElementById('animate-button');

        if (this.animationInterval) {
            // Stop animation
            clearInterval(this.animationInterval);
            this.animationInterval = null;
            button.textContent = 'Animate Day';
            button.classList.add('secondary');
        } else {
            // Start animation
            button.textContent = 'Stop Animation';
            button.classList.remove('secondary');

            const slider = document.getElementById('time-slider');
            const startMinutes = parseInt(slider.value);
            let currentMinutes = startMinutes;

            this.animationInterval = setInterval(() => {
                currentMinutes += 15; // 15 minute steps

                if (currentMinutes > 1440) {
                    currentMinutes = 0;
                }

                slider.value = currentMinutes;
                this.updateTimeDisplay(currentMinutes);

                const hours = Math.floor(currentMinutes / 60);
                const mins = currentMinutes % 60;
                this.currentDate.setHours(hours, mins);

                this.updateSunPosition();
                this.updateExposureLayer();
            }, 200); // Update every 200ms for smooth animation
        }
    }
}

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.solarMap = new SolarExposureMap();
});
