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
        this.defaultZoom = 12; // Good balance for Mapterhorn tiles

        // Mapterhorn terrain tiles - Modern, reliable, Cloudflare-backed
        // Global coverage at z0-12 (z13-17 regional only, incomplete)
        // Format: Terrarium RGB encoding in WebP format (512x512)
        // Terrain queries automatically capped at z12 for global coverage
        this.terrainTileUrl = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';

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
        });

        this.map.on('zoomend', () => {
            // Aspect overlay updates handled by toggle only
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

        // Setup drawer toggle
        const drawer = document.getElementById('drawer');
        const drawerHandle = document.getElementById('drawer-handle');
        drawerHandle.addEventListener('click', () => {
            drawer.classList.toggle('minimized');
        });

        // Setup info button toggle
        const infoBtn = document.getElementById('info-btn');
        const infoPopup = document.getElementById('info-popup');
        infoBtn.addEventListener('click', () => {
            infoPopup.classList.toggle('active');
        });

        // Close info popup when clicking outside
        document.addEventListener('click', (e) => {
            if (!infoBtn.contains(e.target) && !infoPopup.contains(e.target)) {
                infoPopup.classList.remove('active');
            }
        });
    }

    setupEventListeners() {
        // Date change
        document.getElementById('date-input').addEventListener('change', (e) => {
            const [year, month, day] = e.target.value.split('-');
            this.currentDate.setFullYear(year, month - 1, day);
            this.updateSunPosition();
        });

        // Time slider
        document.getElementById('time-slider').addEventListener('input', (e) => {
            const minutes = parseInt(e.target.value);
            this.updateTimeDisplay(minutes);

            const hours = Math.floor(minutes / 60);
            const mins = minutes % 60;
            this.currentDate.setHours(hours, mins);

            this.updateSunPosition();
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
        });

        // Animate button
        document.getElementById('animate-button').addEventListener('click', () => {
            this.toggleAnimation();
        });

        // Shadow toggle - affects click calculations only
        document.getElementById('shadow-toggle').addEventListener('change', (e) => {
            this.showShadows = e.target.checked;
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
        document.getElementById('drawer-time').textContent = timeStr;
    }

    updateSunPosition() {
        const center = this.map.getCenter();
        const sunPos = SunCalc.getPosition(this.currentDate, center.lat, center.lng);

        // Convert to degrees
        const azimuth = ((sunPos.azimuth * 180 / Math.PI) + 180) % 360; // 0 = North
        const altitude = sunPos.altitude * 180 / Math.PI;

        this.sunAzimuth = azimuth;
        this.sunAltitude = altitude;

        // Update sun badge
        const sunBadge = document.getElementById('sun-badge');
        if (altitude < 0) {
            sunBadge.textContent = '🌙 Night';
        } else if (altitude < 10) {
            sunBadge.textContent = '🌅 ' + azimuth.toFixed(0) + '°';
        } else {
            sunBadge.textContent = '☀ ' + azimuth.toFixed(0) + '° / ' + altitude.toFixed(0) + '°';
        }
    }

    updateLocationDisplay() {
        const center = this.map.getCenter();
        document.getElementById('location').textContent =
            `${center.lat.toFixed(4)}°, ${center.lng.toFixed(4)}°`;
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

        // Only update on toggle, not automatically
    }

    async updateExposureLayer() {
        if (!this.exposureLayer || !this.showAspect) {
            // Clear canvas if aspect is hidden
            if (this.exposureLayer) {
                const canvas = this.exposureLayer.getCanvas();
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                }
            }
            return;
        }

        const canvas = this.exposureLayer.getCanvas();
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;

        // Clear canvas
        ctx.clearRect(0, 0, width, height);

        // Simple aspect rendering (NO shadows, NO ray-casting)
        await this.renderSimpleAspect(ctx, width, height);
    }

    async renderSimpleAspect(ctx, width, height) {
        const imageData = ctx.createImageData(width, height);
        const data = imageData.data;
        const zoom = this.map.getZoom();

        // Coarse sampling for aspect overlay
        const sampleRate = Math.max(4, Math.floor(16 - zoom));

        for (let y = 0; y < height; y += sampleRate) {
            for (let x = 0; x < width; x += sampleRate) {
                const point = this.map.containerPointToLatLng([x, y]);
                const terrainData = await this.getTerrainData(point.lat, point.lng, zoom);

                if (!terrainData) continue;

                // Simple aspect color (no shadow calculation)
                const color = this.getAspectColor(terrainData.aspect);

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

    async getTerrainData(lat, lng, zoom) {
        const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;

        if (this.terrainCache.has(key)) {
            return this.terrainCache.get(key);
        }

        // Cap zoom at 12 for global Mapterhorn coverage (z0-12 is global, z13-17 is regional only)
        const terrainZoom = Math.min(zoom, 12);

        // Get real elevation from terrain tiles
        const elevation = await this.getRealElevation(lat, lng, terrainZoom);

        if (elevation === null) {
            return null;
        }

        // Calculate slope and aspect from real terrain
        const { aspect, slope } = await this.calculateRealSlopeAspect(lat, lng, terrainZoom);

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

            console.log('Loading terrain tile from:', url);

            const img = await this.loadImage(url);

            console.log('Image loaded:', img.width, 'x', img.height);

            // Draw to canvas to get pixel data
            const canvas = document.createElement('canvas');
            canvas.width = this.tileSize;
            canvas.height = this.tileSize;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            const imageData = ctx.getImageData(0, 0, this.tileSize, this.tileSize);

            // Check if we got valid data (not all zeros)
            let hasData = false;
            for (let i = 0; i < imageData.data.length; i += 4) {
                if (imageData.data[i] !== 0 || imageData.data[i+1] !== 0 || imageData.data[i+2] !== 0) {
                    hasData = true;
                    break;
                }
            }

            if (!hasData) {
                console.warn('Terrain tile appears to be all black - no valid elevation data');
            }

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
        console.log('Tile coords:', tile);

        const tileData = await this.loadTerrainTile(tile.x, tile.y, zoom);

        if (!tileData) {
            console.warn('Failed to load terrain tile at zoom', zoom);
            return null;
        }

        // Convert lat/lng to pixel position within tile
        const scale = Math.pow(2, zoom);
        const worldX = (lng + 180) / 360 * scale;
        const worldY = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * scale;

        const pixelX = Math.floor((worldX - tile.x) * this.tileSize);
        const pixelY = Math.floor((worldY - tile.y) * this.tileSize);

        console.log('Pixel coords:', pixelX, pixelY);

        if (pixelX < 0 || pixelX >= this.tileSize || pixelY < 0 || pixelY >= this.tileSize) {
            console.warn('Pixel coords out of bounds');
            return null;
        }

        const idx = (pixelY * this.tileSize + pixelX) * 4;
        const r = tileData.data[idx];
        const g = tileData.data[idx + 1];
        const b = tileData.data[idx + 2];

        console.log('RGB values:', r, g, b);

        // Check if pixel is blank (no data)
        if (r === 0 && g === 0 && b === 0) {
            console.warn('No elevation data at this pixel - tile may be empty');
            return null;
        }

        const elevation = this.decodeTerrainRGB(r, g, b);
        console.log('Decoded elevation:', elevation, 'm');

        return elevation;
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

    async calculateExposure(aspect, slope, elevation, lat, lng) {
        // Calculate how much sun exposure this slope receives

        if (this.sunAltitude < 0) {
            // Sun is below horizon
            return 0;
        }

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

        // Apply terrain shadow ray-casting if enabled
        if (this.showShadows && exposure > 0) {
            const shadowFactor = await this.calculateShadow(lat, lng, elevation);
            exposure *= shadowFactor;
        }

        return exposure;
    }

    async calculateShadow(lat, lng, elevation) {
        // TRUE terrain ray-casting for accurate shadow detection

        if (this.sunAltitude < 0) {
            return 0; // Sun below horizon
        }

        // Cast ray from point toward sun
        const maxDistance = 5000; // 5km max shadow distance (meters)
        const stepSize = 100; // Sample every 100 meters
        const zoom = this.map.getZoom();

        // Convert sun angles to direction vector
        const sunAzRad = this.sunAzimuth * Math.PI / 180;
        const sunAltRad = this.sunAltitude * Math.PI / 180;

        // Calculate lat/lng step per meter in sun direction
        const metersPerDegreeLat = 111320;
        const metersPerDegreeLng = 111320 * Math.cos(lat * Math.PI / 180);

        const latStep = (Math.cos(sunAzRad) * stepSize) / metersPerDegreeLat;
        const lngStep = (Math.sin(sunAzRad) * stepSize) / metersPerDegreeLng;

        // Ray-cast toward sun
        let currentLat = lat;
        let currentLng = lng;
        let distance = 0;

        while (distance < maxDistance) {
            distance += stepSize;
            currentLat += latStep;
            currentLng += lngStep;

            // Expected height of ray at this distance (accounting for sun angle)
            const rayHeight = elevation + distance * Math.tan(sunAltRad);

            // Get actual terrain height at this point
            const terrainHeight = await this.getRealElevation(currentLat, currentLng, zoom);

            if (terrainHeight === null) {
                // Out of terrain data bounds, assume no shadow
                break;
            }

            // If terrain is higher than ray, we're in shadow
            if (terrainHeight > rayHeight) {
                return 0; // In shadow
            }

            // Early exit optimization: if we're well above terrain, stop checking
            if (rayHeight - terrainHeight > 500) {
                break; // Ray is far above terrain, no shadow possible
            }
        }

        return 1; // Not in shadow
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
        // Show loading while calculating
        document.getElementById('loading').classList.add('active');

        // Store clicked location
        this.clickedLocation = latlng;

        try {
            const zoom = this.map.getZoom();

            console.log('Clicked:', latlng.lat, latlng.lng, 'Zoom:', zoom);

            const terrainData = await this.getTerrainData(latlng.lat, latlng.lng, zoom);

            if (!terrainData) {
                console.error('No terrain data available for this location');
                document.getElementById('loading').classList.remove('active');
                alert('No terrain data available for this location. Try a different area or check your connection.');
                return;
            }

            console.log('Terrain data:', terrainData);

            // Hide empty state, show solar data
            document.getElementById('empty-state').style.display = 'none';
            document.getElementById('solar-data').style.display = 'block';

            // Update location coordinates
            document.getElementById('location-coords').textContent =
                `${latlng.lat.toFixed(6)}°, ${latlng.lng.toFixed(6)}°`;

            // Update terrain stats
            document.getElementById('elevation-value').textContent = Math.round(terrainData.elevation);
            document.getElementById('slope-value').textContent = terrainData.slope.toFixed(1);
            document.getElementById('aspect-value').textContent =
                `${this.getAspectDirection(terrainData.aspect)} (${terrainData.aspect.toFixed(0)}°)`;

            // Calculate current exposure
            const exposure = await this.calculateExposure(
                terrainData.aspect,
                terrainData.slope,
                terrainData.elevation,
                latlng.lat,
                latlng.lng
            );

            // Calculate terrain-aware sun times
            console.log('Calculating terrain-aware sun times...');
            const terrainSunTimes = await this.calculateTerrainAwareSunTimes(
                latlng.lat, latlng.lng, terrainData.elevation, terrainData
            );

            // Calculate slope sun times
            console.log('Calculating slope sun times...');
            const slopeTimes = await this.calculateSlopeSunTimes(latlng.lat, latlng.lng, terrainData);

            // Update sun timeline
            const formatTime = (date) => date ? date.toTimeString().slice(0, 5) : '--:--';
            document.getElementById('sunrise-time').textContent = formatTime(terrainSunTimes.sunrise);
            document.getElementById('sunset-time').textContent = formatTime(terrainSunTimes.sunset);
            document.getElementById('slope-sun-start').textContent = formatTime(slopeTimes.slopeStart);
            document.getElementById('slope-sun-end').textContent = formatTime(slopeTimes.slopeEnd);

            // Update current exposure
            document.getElementById('current-exposure').textContent = Math.round(exposure * 100);

            const inShadow = exposure === 0 && this.sunAltitude > 0;
            const status = this.sunAltitude < 0 ? '🌙 Night' :
                          inShadow ? '🌑 Shadow' :
                          exposure > 0.7 ? '☀️ Full Sun' :
                          exposure > 0.3 ? '⛅ Partial' : '🌤️ Low';
            document.getElementById('sun-status').textContent = status;

            // Calculate hourly exposure
            console.log('Calculating hourly exposure...');
            const hourlyData = await this.calculateHourlyExposure(latlng.lat, latlng.lng, terrainData);

            // Generate hourly exposure chart
            this.updateHourlyChart(hourlyData);

            // Calculate total sun hours
            const totalSunHours = hourlyData.filter(h => h.exposure > 0).length;
            document.getElementById('total-sun-hours').textContent = `${totalSunHours}h`;

            console.log('Solar analysis complete');

        } catch (error) {
            console.error('Error calculating sun data:', error);
            alert('Error calculating solar data: ' + error.message);
        }

        document.getElementById('loading').classList.remove('active');
    }

    updateHourlyChart(hourlyData) {
        // Generate 24-hour exposure chart
        const chartBars = document.getElementById('exposure-bars');
        chartBars.innerHTML = '';

        const currentHour = this.currentDate.getHours();

        hourlyData.forEach(data => {
            const bar = document.createElement('div');
            bar.className = 'chart-bar';

            // Set height based on exposure (0-100%)
            const height = data.exposure * 100;
            bar.style.height = `${height}%`;

            // Set class based on exposure
            if (data.exposure > 0) {
                bar.classList.add('exposed');
            } else if (data.altitude > 0) {
                bar.classList.add('shadow');
            }

            // Highlight current hour
            if (data.hour === currentHour) {
                bar.classList.add('current');
            }

            chartBars.appendChild(bar);
        });
    }

    calculateComprehensiveSunData(lat, lng, terrainData) {
        // Calculate sunrise, sunset, and sun hours for this location

        const sunTimes = SunCalc.getTimes(this.currentDate, lat, lng);

        // Get sunrise and sunset times
        const sunrise = sunTimes.sunrise;
        const sunset = sunTimes.sunset;

        // Calculate total sun hours
        let sunHours = 0;
        if (sunrise && sunset && !isNaN(sunrise) && !isNaN(sunset)) {
            sunHours = (sunset - sunrise) / (1000 * 60 * 60); // Convert ms to hours
        }

        // Adjust for slope aspect - south-facing slopes get more sun
        const aspectFactor = this.getAspectSunFactor(terrainData.aspect);
        const effectiveSunHours = sunHours * aspectFactor;

        return {
            sunrise: sunrise && !isNaN(sunrise) ? sunrise.toTimeString().slice(0, 5) : null,
            sunset: sunset && !isNaN(sunset) ? sunset.toTimeString().slice(0, 5) : null,
            sunHours: effectiveSunHours,
            totalDaylightHours: sunHours
        };
    }

    getAspectSunFactor(aspect) {
        // Calculate sun factor based on aspect
        // South (180°) = 1.0 (maximum sun)
        // North (0°) = 0.5 (minimum sun)
        // East/West (90°/270°) = 0.75 (moderate)

        const southDiff = Math.abs(aspect - 180);
        const normalizedDiff = Math.min(southDiff, 360 - southDiff);

        // Map 0° (south) to 1.0, 180° (north) to 0.5
        return 0.5 + 0.5 * (1 - normalizedDiff / 180);
    }

    async calculateTerrainAwareSunTimes(lat, lng, elevation, terrainData) {
        // Calculate when sun actually appears/disappears considering terrain occlusions
        const date = this.currentDate;
        const sunTimes = SunCalc.getTimes(date, lat, lng);

        let terrainSunrise = sunTimes.sunrise;
        let terrainSunset = sunTimes.sunset;

        // Check if terrain blocks sunrise
        if (sunTimes.sunrise && !isNaN(sunTimes.sunrise)) {
            const sunrisePos = SunCalc.getPosition(sunTimes.sunrise, lat, lng);
            const sunriseAlt = sunrisePos.altitude * 180 / Math.PI;

            // If sun altitude is low, check for terrain occlusion
            if (sunriseAlt < 20) {
                const testDate = new Date(sunTimes.sunrise);
                // Check every 5 minutes after sunrise for terrain clearance
                for (let i = 0; i < 60; i += 5) {
                    testDate.setMinutes(testDate.getMinutes() + 5);
                    const testPos = SunCalc.getPosition(testDate, lat, lng);
                    const testAlt = testPos.altitude * 180 / Math.PI;

                    if (testAlt > 0) {
                        const shadow = await this.calculateShadow(lat, lng, elevation);
                        if (shadow > 0) {
                            terrainSunrise = testDate;
                            break;
                        }
                    }
                }
            }
        }

        return {
            sunrise: terrainSunrise,
            sunset: terrainSunset
        };
    }

    async calculateSlopeSunTimes(lat, lng, terrainData) {
        // Calculate when sun actually hits and leaves this specific slope
        const date = this.currentDate;
        const sunTimes = SunCalc.getTimes(date, lat, lng);

        let slopeStartTime = null;
        let slopeEndTime = null;

        // Sample throughout the day to find when slope gets sun
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);

        let wasExposed = false;

        for (let hour = 0; hour < 24; hour++) {
            const testTime = new Date(startOfDay);
            testTime.setHours(hour);

            const sunPos = SunCalc.getPosition(testTime, lat, lng);
            const altitude = sunPos.altitude * 180 / Math.PI;

            if (altitude > 0) {
                // Calculate if slope is exposed at this time
                const azimuth = ((sunPos.azimuth * 180 / Math.PI) + 180) % 360;

                // Update temporary sun position for exposure calculation
                const oldAlt = this.sunAltitude;
                const oldAz = this.sunAzimuth;
                this.sunAltitude = altitude;
                this.sunAzimuth = azimuth;

                const exposure = await this.calculateExposure(
                    terrainData.aspect,
                    terrainData.slope,
                    terrainData.elevation,
                    lat,
                    lng
                );

                // Restore original sun position
                this.sunAltitude = oldAlt;
                this.sunAzimuth = oldAz;

                if (exposure > 0 && !wasExposed) {
                    slopeStartTime = testTime;
                    wasExposed = true;
                } else if (exposure === 0 && wasExposed) {
                    slopeEndTime = testTime;
                    wasExposed = false;
                }
            }
        }

        // If still exposed at end of day, use sunset
        if (wasExposed && !slopeEndTime) {
            slopeEndTime = sunTimes.sunset;
        }

        return {
            slopeStart: slopeStartTime,
            slopeEnd: slopeEndTime
        };
    }

    async calculateHourlyExposure(lat, lng, terrainData) {
        // Calculate sun exposure for each hour of the day (0-23)
        const hourlyData = [];
        const date = this.currentDate;
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);

        for (let hour = 0; hour < 24; hour++) {
            const testTime = new Date(startOfDay);
            testTime.setHours(hour);

            const sunPos = SunCalc.getPosition(testTime, lat, lng);
            const altitude = sunPos.altitude * 180 / Math.PI;
            const azimuth = ((sunPos.azimuth * 180 / Math.PI) + 180) % 360;

            let exposure = 0;

            if (altitude > 0) {
                // Update temporary sun position
                const oldAlt = this.sunAltitude;
                const oldAz = this.sunAzimuth;
                this.sunAltitude = altitude;
                this.sunAzimuth = azimuth;

                exposure = await this.calculateExposure(
                    terrainData.aspect,
                    terrainData.slope,
                    terrainData.elevation,
                    lat,
                    lng
                );

                // Restore original sun position
                this.sunAltitude = oldAlt;
                this.sunAzimuth = oldAz;
            }

            hourlyData.push({
                hour,
                exposure,
                altitude,
                azimuth
            });
        }

        return hourlyData;
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
            button.textContent = 'Animate';
            button.classList.add('btn-secondary');
            button.classList.remove('btn-primary');
        } else {
            // Start animation
            button.textContent = 'Stop';
            button.classList.add('btn-primary');
            button.classList.remove('btn-secondary');

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
            }, 200); // Update every 200ms for smooth animation
        }
    }
}

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.solarMap = new SolarExposureMap();
});
