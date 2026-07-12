# ☀️ Solar Exposure Map - Terrain Sun & Shadow Analysis

[![Deploy to GitHub Pages](https://github.com/andrewnakas/Sun_exposure_map_layer/actions/workflows/deploy.yml/badge.svg)](https://github.com/andrewnakas/Sun_exposure_map_layer/actions/workflows/deploy.yml)

An interactive web application that calculates and visualizes real-time sun exposure on terrain, considering slope aspect, terrain shadows, and the precise position of the sun based on date, time, and location.

---

## 🌐 **LIVE DEMO**

### **🔗 [https://andrewnakas.github.io/Sun_exposure_map_layer/](https://andrewnakas.github.io/Sun_exposure_map_layer/)**

**Try it now!** Pan to mountainous terrain, adjust the time slider, and watch sun exposure change in real-time.

---

## 🎯 Features

### Core Functionality
- **Real-time Solar Position Calculation**: Uses astronomical algorithms (SunCalc) to compute accurate sun azimuth and altitude for any date, time, and location
- **Terrain Slope Analysis**: Calculates slope angle and aspect (direction the slope faces) from elevation data
- **Sun Exposure Modeling**: Computes how much solar radiation each slope receives based on:
  - Slope orientation relative to sun position
  - Terrain shadows from surrounding features
  - Time of day and season
- **Interactive Time Controls**: Animate through a full day or select specific times to see changing sun exposure patterns

### Visual Features
- **Color-coded Exposure Mapping**:
  - 🔵 Blue: North-facing slopes (cold, shaded)
  - 🟡 Yellow: East-facing slopes (morning sun)
  - 🔴 Red: South-facing slopes (maximum sun exposure)
  - 🟠 Orange: West-facing slopes (afternoon sun)
  - ⚫ Dark: Areas in shadow

- **Interactive Map**: Click anywhere to see detailed information about:
  - Elevation
  - Slope angle
  - Slope aspect (compass direction)
  - Current sun exposure percentage

### Controls
- **Date Picker**: Select any date to see seasonal sun exposure differences
- **Time Slider**: Scrub through the day to see how sun exposure changes
- **Animation Mode**: Watch a full day's sun movement in time-lapse
- **Toggle Options**:
  - Show/hide terrain shadows
  - Show/hide slope aspect coloring
- **"Now" Button**: Jump to current date and time instantly

## 🏔️ Use Cases

### Backcountry Skiing & Avalanche Safety
- **Route Planning**: Identify sun-exposed vs. shaded slopes for optimal snow conditions
- **Avalanche Risk Assessment**:
  - Sunny aspects (S, SE, SW): Prone to wet loose avalanches from solar warming
  - Shaded aspects (N, NE, NW): May have persistent weak layers, prone to slab avalanches
  - Morning sun (E): Good for corn snow harvesting
  - Afternoon sun (W): Avoid late-day when warming is maximum
- **Timing Decisions**: See exactly when a specific slope will receive direct sunlight

### Mountaineering & Climbing
- **Route Selection**: Choose shaded routes for hot summer days, sunny routes for cold conditions
- **Timing**: Plan to climb ice routes before they get sun exposure
- **Camp Placement**: Find locations that get morning sun but afternoon shade

### Trail Running & Hiking
- **Heat Management**: Identify shaded trails for summer hikes
- **Photography**: Plan for optimal lighting conditions
- **Snow Conditions**: Find which trails will be snow-free earliest in spring

## 🛠️ Technical Implementation

### Technologies Used
- **Leaflet.js**: Interactive mapping framework
- **SunCalc**: Astronomical calculations for sun position
- **OpenTopoMap**: Terrain base layer
- **Canvas API**: High-performance exposure layer rendering
- **Mapzen/AWS Terrain Tiles**: Global Terrarium-RGB elevation tiles
- **tz-lookup** (vendored): the clicked location's IANA time zone

### Terrain Data Source

This app uses **[Mapzen/AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)**
(SRTM, 3DEP, GEBCO and other open sources) for global elevation coverage:

- Terrarium-RGB PNG tiles, decoded as `(R·256 + G + B/256) − 32768` meters
- Global coverage at zoom 0–15; the app samples zoom 14 (~10 m/px) for
  point/slope reads and coarser zooms for long horizon rays
- Bilinear interpolation across tile boundaries, LRU tile cache, no API key
- `js/terrain-client.js` and `js/solar-core.js` are shared with the sibling
  [Sun Tracker](https://github.com/andrewnakas/Sun_Tracker_Leaflet) project

### Calculation Methods

#### 1. Sun Position
Uses the SunCalc library to calculate:
- **Azimuth**: Compass direction of the sun (0° = North)
- **Altitude**: Angle of sun above horizon

All displayed times are in the **clicked location's own time zone** (shown in
the sidebar), and the analyzed day is anchored to local midnight there.

#### 2. Slope Aspect & Angle
Computed from central-difference elevation gradients with sample spacing tied
to the DEM's actual ground resolution:
```javascript
slope  = atan(√((dz/dx)² + (dz/dy)²))       // Steepness
aspect = atan2(-dz/dx, -dz/dy)              // Downhill (facing) direction
```

#### 3. Sun Exposure
Calculated using dot product of slope normal vector and sun direction:
```javascript
exposure = max(0, slopeNormal · sunDirection)
```

This gives a value from 0 (no exposure) to 1 (perpendicular to sun).

#### 4. Terrain Occlusion (Horizon Profile)
- A 360° horizon profile is built once per clicked point: 72 azimuths,
  geometric sample spacing from 30 m out to 40 km per ray
- Each sample subtracts the earth-curvature + refraction drop
  `(1 − k)·d²/(2R)` (k = 0.13); valleys can have *negative* horizon angles
- The sun is visible when
  `altitude + 0.267° + refraction(altitude) > horizon(azimuth)` — at a flat
  horizon this reproduces standard almanac sunrise/sunset times
- Terrain sunrise/sunset, sun-on/off-slope times and total sun hours all come
  from full-day visibility intervals with edges refined by bisection (~10 s),
  so notched horizons and multiple sun windows are handled correctly

### Tests

```bash
node test/core-tests.mjs   # pure-math unit tests (no network)
node test/e2e.mjs          # Playwright end-to-end checks (serves the app)
```

### Performance Optimizations
- **Spatial Sampling**: Renders at lower resolution based on zoom level
- **Terrain Caching**: Caches calculated elevation and slope data
- **Incremental Updates**: Only recalculates visible area
- **Canvas Rendering**: Uses hardware-accelerated canvas for overlay

## 🚀 Getting Started

### Running Locally
1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd Sun_exposure_map_layer
   ```

2. Serve the files with any HTTP server:
   ```bash
   python -m http.server 8000
   # or
   npx serve
   ```

3. Open `http://localhost:8000` in your browser

### GitHub Pages Deployment
This project is configured to deploy automatically via GitHub Pages. The page will be available at:
```
https://<username>.github.io/Sun_exposure_map_layer/
```

## 📖 How to Use

1. **Pan & Zoom**: Navigate to your area of interest (mountains work best!)
2. **Select Date**: Choose the date you're interested in
3. **Adjust Time**: Use the slider to see sun exposure at different times
4. **Click Map**: Click anywhere to see detailed slope and exposure information
5. **Animate**: Click "Animate Day" to watch the sun's movement
6. **Toggle Layers**: Turn shadows and aspect coloring on/off

## 🎨 Color Legend

| Color | Aspect | Meaning |
|-------|--------|---------|
| 🔵 Blue | North (0°) | Cold, shaded slopes - best for preserving snow |
| 🟡 Yellow | East (90°) | Morning sun - good for corn snow |
| 🔴 Red | South (180°) | Maximum sun exposure - prone to warming |
| 🟠 Orange | West (270°) | Afternoon sun - warmest part of day |
| ⚫ Black | Any | Currently in shadow |

## 🔬 Future Enhancements

### Completed ✅
- [x] **Real DEM Data Integration**: Using Mapterhorn Terrarium tiles globally
- [x] **True Shadow Ray-Casting**: Implemented 3D ray-casting through DEM
- [x] **Cumulative Exposure**: Shows total sun hours per day for clicked points
- [x] **Mobile Optimization**: Bottom drawer UI pattern (CalTopo-style)
- [x] **Global Coverage**: Works anywhere on Earth (85°N to 85°S)

### Planned Features
- [ ] **Daily Sun Path Visualization**: Show the arc of the sun across the sky
- [ ] **Snow Melt Prediction**: Model snow melt rate based on exposure
- [ ] **Aspect Rose Diagram**: Show distribution of slope aspects in view
- [ ] **Export & Share**: Generate shareable links with specific locations/times
- [ ] **Offline Mode**: Cache tiles for offline use in backcountry
- [ ] **Weather Integration**: Combine with cloud cover data

### Technical Improvements
- [ ] Web Workers for terrain calculations
- [ ] Progressive rendering for large areas
- [ ] WebGL for 3D terrain visualization
- [ ] Higher resolution regional tiles (Mapterhorn z13-17) for select areas

## 📚 Resources & References

### Avalanche Safety
- [Avalanche.org](https://avalanche.org/) - Avalanche forecasts and education
- AIARE (American Avalanche Institute for Research and Education)

### Similar Tools
- **CalTopo**: Professional mapping for backcountry users
- **onX Backcountry**: Slope aspect and avalanche terrain mapping
- **ShadeMap**: Detailed shadow calculations for urban and mountain environments

### Technical References
- [SunCalc Documentation](https://github.com/mourner/suncalc)
- [Leaflet Documentation](https://leafletjs.com/)
- NOAA Solar Position Calculator

## ⚠️ Disclaimer

This tool is for educational and planning purposes only. **Do not use this as your sole source for avalanche or backcountry safety decisions.** Always:
- Check official avalanche forecasts
- Carry proper safety equipment
- Travel with experienced partners
- Take avalanche safety courses
- Make conservative decisions in the backcountry

## 📄 License

MIT License - feel free to use and modify for your projects

## 🤝 Contributing

Contributions welcome! Areas of particular interest:
- Real terrain data integration
- Shadow calculation improvements
- Mobile optimization
- Additional visualization modes

## 👨‍💻 Author

Created with Claude Code for backcountry enthusiasts and anyone interested in solar exposure analysis.

---

**Happy (safe) skiing!** 🎿⛷️
