// ==UserScript==
// @name         WME Need a Road, Dude!
// @namespace    https://github.com/McLarenMCL38/wme-need-a-road-dude
// @version      1.5.0
// @description  Spots unmapped roads in Waze Map Editor (WME) at Zoom 18+, compiles a persistent work queue across sessions, scans 4 km² and 20 km² or Editable Areas, auto-snaps minimal-node roads with inherited City/State & One-Way detection, and exports Zoom 18 permalinks.
// @author       McLaren (Original Idea, Updates & Improvements) & Antigravity AI (Coding, Tech Skills & Improvements)
// @homepageURL  https://github.com/McLarenMCL38/wme-need-a-road-dude
// @supportURL   https://github.com/McLarenMCL38/wme-need-a-road-dude/issues
// @downloadURL  https://github.com/McLarenMCL38/wme-need-a-road-dude/raw/refs/heads/main/wme-need-a-road.user.js
// @updateURL    https://github.com/McLarenMCL38/wme-need-a-road-dude/raw/refs/heads/main/wme-need-a-road.user.js
// @match        https://*.waze.com/*editor*
// @match        https://www.waze.com/editor*
// @match        https://beta.waze.com/*editor*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      waze.com
// @connect      *.waze.com
// @icon         https://www.google.com/s2/favicons?sz=64&domain=waze.com
// ==/UserScript==

/* ============================================================================
   🎉 UPDATE NOTES — v1.5.0 ("The 'Snap Decisions, Spiderweb Buster & Waze-Blue Makeover' Update")
   ============================================================================
   🔌 Look Ma, Real Junctions! (Smart Road Creation):
      - "Draw" stopped leaving an awkward 18-meter social-distancing gap before
        existing roads! It now rank-safely extends, splits, and snaps a real junction
        (or politely stops 4m short if the road outranks you or is a Freeway).
      - Automatically inherits City & State from the neighbor road, ticks Street Name
        to "None" so WME stops screaming in red, matches the parent Lock Rank (capped
        at yours), reads Waze's rainbow GPS arrow colors to spot One-Way traffic,
        reminds you to double-check Road Type, and auto-checks off the stretch when
        you hit Save in WME!

   🕸️ Evicted Couch-Potato GPS Spiderwebs & Border Hoppers:
      - Someone leaving Waze open on their living-room sofa no longer convinces us
        there's a 6-lane cul-de-sac in their kitchen (indoor spiderweb drift rejected!).
      - 4 km² and 20 km² scans now stay strictly inside your Editable Area by default
        (toggleable in Settings if you like window-shopping across the border).

   🩵 Dressed in Iconic Waze Blue + Actually Glides + Readable Without Squinting:
      - Fresh #33CCFF Waze-logo header, rock-solid document-capture dragging, Settings
        moved right to the top, and bigger Zoom & UI text so your eyes can relax!
   ============================================================================ */

(function () {
    'use strict';

    const SCRIPT_NAME = 'Need a Road, Dude!';
    const SCRIPT_SHORT = 'NeedARoad';
    const SCRIPT_VERSION = '1.5.0';
    const SETTINGS_SCHEMA_VERSION = 3;

    // Global reference to page window / unsafeWindow
    const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // Drivable road types in WME that count as "Existing Road"
    // Non-drivable types (5 = Walking Trail, 10 = Pedestrian Boardwalk, 16 = Stairway, 18 = Railroad, 19 = Runway) DO NOT count!
    const DRIVABLE_ROAD_TYPES = new Set([
        1,  // Street
        2,  // Primary Street
        3,  // Freeway
        4,  // Ramp
        6,  // Major Highway
        7,  // Minor Highway
        8,  // Dirt Road / 4WD
        14, // Ferry
        17, // Private Road
        20  // Parking Lot Road
    ]);

    // Default Configuration & Settings State
    const settings = {
        settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
        proximityThresholdMeters: 18,    // Optimal street half-corridor (18m streets, auto-scales up to 28m on freeways)
        minPointsPerStretch: 4,          // Minimum unmapped GPS samples to trigger a stretch alert
        clusterDistanceMeters: 55,       // Grouping distance for neighboring unmapped GPS samples
        drawSimplifyToleranceMeters: 8,  // Straightness / RDP tolerance (meters) for minimal-node road drawing
        crawlerStepDelayMs: 1800,        // Delay per tile during crawl to allow WME to download & render Zoom 18+ GPS tiles
        crawlerZoomLevel: 18,            // Crawler zoom level (strictly >= 18 so GPS traces load)
        onlyInsideEditableArea: true,    // Skip stretches & crawl tiles outside editor's WME Editable Area by default
        autoScanOnMove: true,            // Automatically scan & append new stretches when map stops moving at Zoom 18+
        autoCompactAfterScan: true,      // Shrink into compact draggable fixer bar once a scan/crawl finishes with results
        showRawGpsDots: false,           // Keep map clean with smooth centerline highlights (no red dot clutter!)
        soundAlerts: false,              // Play a subtle chime when missing roads are found
        highlightColor: '#ff2d55',       // Outer corridor glow color
        highlightGlow: '#ff9f1c',        // Inner smoothed centerline color
        panelCollapsed: false,
        uiMode: 'full',                  // 'full' | 'compact'
        panelLeft: null,                 // Persisted draggable X coordinate (px)
        panelTop: null,                  // Persisted draggable Y coordinate (px)
        zoomMinRequired: 18              // WME requires Zoom 18+ to load and display GPS traces
    };

    // Load persisted settings & auto-migrate old schemas
    try {
        const saved = localStorage.getItem('WME_NeedARoad_Settings');
        if (saved) {
            const parsed = JSON.parse(saved);
            const oldSchema = parsed.settingsSchemaVersion || 1;
            Object.assign(settings, parsed);

            if (oldSchema < 2) {
                if (!parsed.proximityThresholdMeters || parsed.proximityThresholdMeters < 15) {
                    settings.proximityThresholdMeters = 18;
                }
                if (!parsed.minPointsPerStretch || parsed.minPointsPerStretch < 4) {
                    settings.minPointsPerStretch = 4;
                }
                settings.showRawGpsDots = false;
                localStorage.removeItem('WME_NeedARoad_CompiledQueue');
            }
            if (oldSchema < SETTINGS_SCHEMA_VERSION) {
                if (typeof parsed.onlyInsideEditableArea !== 'boolean') {
                    settings.onlyInsideEditableArea = true;
                }
                settings.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;
                localStorage.setItem('WME_NeedARoad_Settings', JSON.stringify(settings));
            }
        }
    } catch (e) {
        console.warn(`[${SCRIPT_SHORT}] Could not load settings:`, e);
    }
    if (!Number.isFinite(settings.zoomMinRequired) || settings.zoomMinRequired < 18) {
        settings.zoomMinRequired = 18;
    }
    if (!Number.isFinite(settings.crawlerZoomLevel) || settings.crawlerZoomLevel < 18) {
        settings.crawlerZoomLevel = 18;
    }
    if (!Number.isFinite(settings.proximityThresholdMeters) || settings.proximityThresholdMeters < 6) {
        settings.proximityThresholdMeters = 18;
    }
    if (!Number.isFinite(settings.drawSimplifyToleranceMeters) || settings.drawSimplifyToleranceMeters < 2) {
        settings.drawSimplifyToleranceMeters = 8;
    }
    if (settings.uiMode !== 'compact' && settings.uiMode !== 'full') {
        settings.uiMode = 'full';
    }

    function saveSettings() {
        try {
            localStorage.setItem('WME_NeedARoad_Settings', JSON.stringify(settings));
        } catch (e) {}
    }

    // Persisted Dismissed / False-Positive Stretches
    const dismissedStretches = new Set();
    try {
        const savedDismissed = localStorage.getItem('WME_NeedARoad_Dismissed');
        if (savedDismissed) {
            const arr = JSON.parse(savedDismissed);
            if (Array.isArray(arr)) arr.forEach(k => dismissedStretches.add(k));
        }
    } catch (e) {}

    function saveDismissed() {
        try {
            localStorage.setItem('WME_NeedARoad_Dismissed', JSON.stringify([...dismissedStretches]));
        } catch (e) {}
    }

    // Runtime State Variables
    let wmeSDK = null;
    let isInitialized = false;
    let isScanning = false;
    let scanTimeout = null;
    let networkHookInstalled = false;
    let suppressAutoScanUntil = 0;       // Prevents Go To / Draw jumps from triggering unnecessary re-scans
    let activeStretchIndex = 0;          // Currently focused stretch in Compact Fixer & Queue list
    let lastDrawnStretchId = null;       // Tracks active stretch awaiting WME Save to auto-complete
    let lastDrawReminderMsg = '';        // Post-Draw verification checklist message

    // GPS Data & Raster Tile Cache
    const capturedGpsPoints = new Map(); // key -> { lon, lat, x, y, timestamp }
    const rasterTileCache = new Map();   // tileUrl -> Array<{ u: number, v: number, hue: number|null }> | 'non_gps' | 'failed'
    const cachedNetworkAreas = [];       // Editable / Managed area objects captured from WME responses
    let cachedResolvedAreas = [];        // Latest list used in the Area Picker dropdown

    // Analysis Results & Persistent Compiled Queue
    let currentResults = {
        totalGpsInView: 0,
        unmappedGpsCount: 0,
        coveredGpsCount: 0,
        stretches: [] // Array of { id, centerLat, centerLon, pointCount, points: [...], permalink, approxLengthMeters, sourceArea }
    };

    function saveCompiledQueue() {
        try {
            const serialized = currentResults.stretches.slice(0, 500).map((s, idx) => ({
                id: idx + 1,
                centerLat: Number(s.centerLat.toFixed(6)),
                centerLon: Number(s.centerLon.toFixed(6)),
                pointCount: s.pointCount,
                approxLengthMeters: s.approxLengthMeters,
                permalink: s.permalink,
                sourceArea: s.sourceArea || '',
                pts: (s.points || []).slice(0, 60).map(p => (typeof p.hue === 'number')
                    ? [Number(p.lon.toFixed(6)), Number(p.lat.toFixed(6)), Math.round(p.hue)]
                    : [Number(p.lon.toFixed(6)), Number(p.lat.toFixed(6))])
            }));
            localStorage.setItem('WME_NeedARoad_CompiledQueue', JSON.stringify({
                savedAt: Date.now(),
                activeStretchIndex,
                stretches: serialized
            }));
        } catch (e) {
            console.warn(`[${SCRIPT_SHORT}] Could not persist compiled queue:`, e);
        }
    }

    function loadCompiledQueue() {
        try {
            const raw = localStorage.getItem('WME_NeedARoad_CompiledQueue');
            if (!raw) return 0;
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.stretches)) return 0;

            const restored = [];
            for (const item of parsed.stretches) {
                if (!Number.isFinite(item.centerLat) || !Number.isFinite(item.centerLon)) continue;
                if (isStretchDismissed(item.centerLat, item.centerLon)) continue;
                const pts = Array.isArray(item.pts)
                    ? item.pts.map(pair => ({
                        lon: pair[0],
                        lat: pair[1],
                        hue: (typeof pair[2] === 'number') ? pair[2] : null
                    })).filter(p => Number.isFinite(p.lon) && Number.isFinite(p.lat))
                    : [{ lon: item.centerLon, lat: item.centerLat, hue: null }];
                restored.push({
                    id: restored.length + 1,
                    centerLat: item.centerLat,
                    centerLon: item.centerLon,
                    pointCount: item.pointCount || pts.length,
                    approxLengthMeters: item.approxLengthMeters || 25,
                    points: pts,
                    permalink: item.permalink || generatePermalink(item.centerLat, item.centerLon, 18),
                    sourceArea: item.sourceArea || ''
                });
            }
            currentResults.stretches = restored;
            activeStretchIndex = Math.max(0, Math.min(parsed.activeStretchIndex || 0, Math.max(0, restored.length - 1)));
            return restored.length;
        } catch (e) {
            return 0;
        }
    }

    function reindexStretches() {
        currentResults.stretches.forEach((s, i) => { s.id = i + 1; });
        if (activeStretchIndex >= currentResults.stretches.length) {
            activeStretchIndex = Math.max(0, currentResults.stretches.length - 1);
        }
    }

    // Crawler State Machine: status in 'idle' | 'running' | 'paused' | 'stopped'
    let crawlerState = {
        status: 'idle',
        isActive: false,
        isPaused: false,
        tiles: [],
        currentTileIndex: 0,
        selectedAreaId: null,
        selectedAreaName: '',
        timeoutId: null,
        stepRunId: 0,
        totalStretchesFound: 0
    };

    /* ==========================================================================
       1. NETWORK INTERCEPTOR (GPS trace sniffer + Editable/Managed Area catcher)
       ========================================================================== */
    function installNetworkInterceptor() {
        if (networkHookInstalled) return;
        networkHookInstalled = true;

        try {
            const origOpen = win.XMLHttpRequest && win.XMLHttpRequest.prototype.open;
            const origSend = win.XMLHttpRequest && win.XMLHttpRequest.prototype.send;

            if (origOpen && origSend) {
                win.XMLHttpRequest.prototype.open = function (method, url) {
                    this._narUrl = typeof url === 'string' ? url : String(url || '');
                    return origOpen.apply(this, arguments);
                };

                win.XMLHttpRequest.prototype.send = function () {
                    this.addEventListener('load', function () {
                        try {
                            const url = this._narUrl || '';
                            if (!url) return;
                            if (isGpsUrl(url) || isAreaMetadataUrl(url)) {
                                let respData = null;
                                if (this.responseType === 'json') {
                                    respData = this.response;
                                } else if (!this.responseType || this.responseType === 'text') {
                                    respData = this.responseText;
                                }
                                if (respData) {
                                    if (isAreaMetadataUrl(url)) extractAreasFromPayload(respData);
                                    if (isGpsUrl(url)) parseGpsResponse(respData);
                                }
                            }
                        } catch (err) {}
                    });
                    return origSend.apply(this, arguments);
                };
            }

            if (typeof win.fetch === 'function') {
                const origFetch = win.fetch;
                win.fetch = async function (...args) {
                    const response = await origFetch.apply(this, args);
                    try {
                        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
                        if (url && (isGpsUrl(url) || isAreaMetadataUrl(url))) {
                            const clone = response.clone();
                            clone.text().then(text => {
                                if (isAreaMetadataUrl(url)) extractAreasFromPayload(text);
                                if (isGpsUrl(url)) parseGpsResponse(text);
                            }).catch(() => {});
                        }
                    } catch (e) {}
                    return response;
                };
            }
        } catch (e) {
            console.warn(`[${SCRIPT_SHORT}] Failed to hook network:`, e);
        }
    }

    // Install network hook early to catch login/session/area payloads during WME boot
    installNetworkInterceptor();

    function isGpsUrl(url) {
        if (!url || /\/Features\b/i.test(url)) return false;
        return /(gpstrace|gps_points|gpspoints|tracetile|usergps|archive.*gps)/i.test(url);
    }

    function isAreaMetadataUrl(url) {
        return /(\/Features\b|login|session|currentUser|profile|editable|managedArea)/i.test(url);
    }

    function extractAreasFromPayload(rawData) {
        if (!rawData) return;
        try {
            const data = (typeof rawData === 'string') ? JSON.parse(rawData) : rawData;
            if (!data || typeof data !== 'object') return;

            let added = false;
            const candidates = [
                { raw: data.editableAreas, label: 'My Editable Area' },
                { raw: data.editableArea, label: 'My Editable Area' },
                { raw: data.driveAreas, label: 'My Drive Area' },
                { raw: data.managedAreas && (data.managedAreas.objects || data.managedAreas), label: 'Managed Area' },
                { raw: data.areas && (data.areas.objects || data.areas), label: 'Editable Area' },
                { raw: data.user && data.user.editableAreas, label: 'My Editable Area' },
                { raw: data.user && data.user.editableArea, label: 'My Editable Area' },
                { raw: data.user && data.user.areas, label: 'Editable Area' },
                { raw: data.user && data.user.managedAreas, label: 'Managed Area' }
            ];

            for (const item of candidates) {
                if (!item.raw) continue;
                const parsedList = normalizeRawAreas(item.raw, item.label);
                for (const pa of parsedList) {
                    if (!cachedNetworkAreas.some(existing => existing.id === pa.id)) {
                        cachedNetworkAreas.push(pa);
                        added = true;
                    }
                }
            }

            if (added && isInitialized) {
                populateAreaPicker();
            }
        } catch (e) {}
    }

    function parseGpsResponse(rawData) {
        if (!rawData) return;
        try {
            let data = rawData;
            if (typeof rawData === 'string') {
                if (rawData.length < 5) return;
                const trimmed = rawData.trim();
                if (trimmed[0] !== '{' && trimmed[0] !== '[') return;
                data = JSON.parse(trimmed);
            }
            let count = 0;

            function recurseExtract(obj) {
                if (!obj) return;
                if (Array.isArray(obj)) {
                    if (obj.length >= 2 && typeof obj[0] === 'number' && typeof obj[1] === 'number') {
                        if (registerPoint(obj[0], obj[1])) count++;
                        return;
                    }
                    for (let i = 0; i < obj.length; i++) recurseExtract(obj[i]);
                } else if (typeof obj === 'object') {
                    if (typeof obj.x === 'number' && typeof obj.y === 'number') {
                        if (registerPoint(obj.x, obj.y)) count++;
                    } else if (typeof obj.lat === 'number' && typeof obj.lon === 'number') {
                        if (registerPoint(obj.lon, obj.lat)) count++;
                    } else if (typeof obj.latitude === 'number' && typeof obj.longitude === 'number') {
                        if (registerPoint(obj.longitude, obj.latitude)) count++;
                    }

                    for (const key of Object.keys(obj)) {
                        const val = obj[key];
                        if (val && typeof val === 'object') recurseExtract(val);
                    }
                }
            }

            recurseExtract(data);

            if (count > 0 && settings.autoScanOnMove && crawlerState.status !== 'running') {
                debounceScan(400);
            }
        } catch (e) {}
    }

    function registerPoint(a, b) {
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        let lon, lat, x, y;
        if (Math.abs(a) > 180 || Math.abs(b) > 90) {
            if (Math.abs(a) > 20050000 || Math.abs(b) > 20050000) return false;
            x = a;
            y = b;
            const wgs = mercatorToLatLon(x, y);
            lon = wgs.lon;
            lat = wgs.lat;
        } else {
            if (a === 0 && b === 0) return false;
            lon = a;
            lat = b;
            const merc = latLonToMercator(lat, lon);
            x = merc.x;
            y = merc.y;
        }

        if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 85.1 || Math.abs(lon) > 180) {
            return false;
        }

        const key = `${lon.toFixed(6)}_${lat.toFixed(6)}`;
        if (!capturedGpsPoints.has(key)) {
            capturedGpsPoints.set(key, { lon, lat, x, y, timestamp: Date.now() });
        }
        return true;
    }

    /* ==========================================================================
       2. GEODETIC & GEOMETRY UTILITIES
       ========================================================================== */
    const MERCATOR_ORIGIN_SHIFT = 20037508.342789244;

    function mercatorToLatLon(x, y) {
        const lon = (x / MERCATOR_ORIGIN_SHIFT) * 180;
        let lat = (y / MERCATOR_ORIGIN_SHIFT) * 180;
        lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
        return { lon, lat };
    }

    function latLonToMercator(lat, lon) {
        const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
        const x = (lon * MERCATOR_ORIGIN_SHIFT) / 180;
        let y = Math.log(Math.tan(((90 + clampedLat) * Math.PI) / 360)) / (Math.PI / 180);
        y = (y * MERCATOR_ORIGIN_SHIFT) / 180;
        return { x, y };
    }

    function toWgsPoint(xOrLon, yOrLat) {
        if (!Number.isFinite(xOrLon) || !Number.isFinite(yOrLat)) return null;
        if (Math.abs(xOrLon) > 180 || Math.abs(yOrLat) > 90) {
            const p = mercatorToLatLon(xOrLon, yOrLat);
            return (Number.isFinite(p.lon) && Number.isFinite(p.lat)) ? p : null;
        }
        return { lon: xOrLon, lat: yOrLat };
    }

    function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function distanceToLineSegmentMeters(px, py, ax, ay, bx, by) {
        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;

        if (lenSq === 0) {
            const rx = px - ax;
            const ry = py - ay;
            return Math.sqrt(rx * rx + ry * ry);
        }

        let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));

        const projX = ax + t * dx;
        const projY = ay + t * dy;
        const distX = px - projX;
        const distY = py - projY;

        return Math.sqrt(distX * distX + distY * distY);
    }

    function isPointInRing(pt, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i].lon, yi = ring[i].lat;
            const xj = ring[j].lon, yj = ring[j].lat;
            const intersect = ((yi > pt.lat) !== (yj > pt.lat)) &&
                (pt.lon < (xj - xi) * (pt.lat - yi) / ((yj - yi) || 1e-12) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function isPointInSinglePolygon(pt, poly) {
        if (pt.lon < poly.bbox.minLon || pt.lon > poly.bbox.maxLon ||
            pt.lat < poly.bbox.minLat || pt.lat > poly.bbox.maxLat) {
            return false;
        }
        if (!isPointInRing(pt, poly.outer)) return false;
        if (poly.holes && poly.holes.length > 0) {
            for (const hole of poly.holes) {
                if (isPointInRing(pt, hole)) return false;
            }
        }
        return true;
    }

    function doesTileIntersectPolygon(centerLon, centerLat, halfLon, halfLat, poly) {
        if (centerLon + halfLon < poly.bbox.minLon || centerLon - halfLon > poly.bbox.maxLon ||
            centerLat + halfLat < poly.bbox.minLat || centerLat - halfLat > poly.bbox.maxLat) {
            return false;
        }
        // Check tile center and 4 corners
        const testPts = [
            { lon: centerLon, lat: centerLat },
            { lon: centerLon - halfLon, lat: centerLat - halfLat },
            { lon: centerLon + halfLon, lat: centerLat - halfLat },
            { lon: centerLon + halfLon, lat: centerLat + halfLat },
            { lon: centerLon - halfLon, lat: centerLat + halfLat }
        ];
        for (const tp of testPts) {
            if (isPointInSinglePolygon(tp, poly)) return true;
        }
        // Also check if any polygon outer vertex falls inside this tile (catches narrow drive corridors!)
        for (const v of poly.outer) {
            if (v.lon >= centerLon - halfLon && v.lon <= centerLon + halfLon &&
                v.lat >= centerLat - halfLat && v.lat <= centerLat + halfLat) {
                return true;
            }
        }
        return false;
    }

    function isStretchDismissed(lat, lon) {
        const key = `${lat.toFixed(4)}_${lon.toFixed(4)}`;
        return dismissedStretches.has(key);
    }

    /* ==========================================================================
       3. OPENLAYERS LAYER, RASTER TILE & FEATURE EXTRACTION
       ========================================================================== */
    function getAllMapLayers() {
        const map = win.W && win.W.map;
        if (!map) return [];
        const layers = [];
        const seen = new Set();

        function pushLayer(l) {
            if (!l || seen.has(l)) return;
            seen.add(l);
            layers.push(l);
            // Flatten OL3+ LayerGroup if present
            if (typeof l.getLayers === 'function') {
                try {
                    const sub = l.getLayers();
                    const arr = (sub && typeof sub.getArray === 'function') ? sub.getArray() : sub;
                    if (Array.isArray(arr)) arr.forEach(pushLayer);
                } catch (e) {}
            }
        }

        const olMap = map.olMap || (typeof map.getLayers === 'function' ? map : null);
        if (olMap && typeof olMap.getLayers === 'function') {
            try {
                const col = olMap.getLayers();
                const arr = (col && typeof col.getArray === 'function') ? col.getArray() : col;
                if (Array.isArray(arr)) arr.forEach(pushLayer);
            } catch (e) {}
        }

        if (Array.isArray(map.layers)) {
            map.layers.forEach(pushLayer);
        }

        return layers;
    }

    function getLayerLabel(l) {
        if (!l) return '';
        let n = '';
        try {
            if (typeof l.get === 'function') {
                n = l.get('uniqueName') || l.get('name') || l.get('title') || '';
            }
        } catch (e) {}
        return String(n || l.uniqueName || l.name || l.id || '');
    }

    function findLayersByRegex(regex) {
        return getAllMapLayers().filter(l => regex.test(getLayerLabel(l)));
    }

    function getNativeGpsLayer() {
        try {
            if (win.W && win.W.map && typeof win.W.map.getLayerByUniqueName === 'function') {
                const l = win.W.map.getLayerByUniqueName('gps_points') || win.W.map.getLayerByUniqueName('GPSTraces');
                if (l) return l;
            }
        } catch (e) {}
        const matches = findLayersByRegex(/gps_points|gpstrace|^gps/i);
        return matches[0] || null;
    }

    function getFeaturesFromLayer(layer) {
        if (!layer) return [];
        try {
            if (typeof layer.getSource === 'function') {
                const src = layer.getSource();
                if (src && typeof src.getFeatures === 'function') {
                    return src.getFeatures() || [];
                }
            }
        } catch (e) {}
        if (Array.isArray(layer.features)) {
            return layer.features;
        }
        return [];
    }

    function extractCoordsFromFeature(feat) {
        if (!feat) return;
        if (typeof feat.getGeometry === 'function') {
            try {
                const geom = feat.getGeometry();
                if (geom && typeof geom.getCoordinates === 'function') {
                    traverseCoordinates(geom.getCoordinates());
                    return;
                }
            } catch (e) {}
        }
        if (feat.geometry) {
            if (typeof feat.geometry.x === 'number' && typeof feat.geometry.y === 'number') {
                registerPoint(feat.geometry.x, feat.geometry.y);
            } else if (Array.isArray(feat.geometry.components)) {
                traverseOlComponents(feat.geometry.components);
            }
        }
    }

    function traverseOlComponents(comps) {
        if (!Array.isArray(comps)) return;
        for (const c of comps) {
            if (!c) continue;
            if (typeof c.x === 'number' && typeof c.y === 'number') {
                registerPoint(c.x, c.y);
            } else if (Array.isArray(c.components)) {
                traverseOlComponents(c.components);
            }
        }
    }

    function traverseCoordinates(coords) {
        if (!Array.isArray(coords) || coords.length === 0) return;
        if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            registerPoint(coords[0], coords[1]);
            return;
        }
        for (const c of coords) {
            traverseCoordinates(c);
        }
    }

    function isLayerVisible(layer) {
        if (!layer) return false;
        try {
            if (typeof layer.getVisible === 'function') return Boolean(layer.getVisible());
            if (typeof layer.getVisibility === 'function') return Boolean(layer.getVisibility());
            if (typeof layer.visibility === 'boolean') return layer.visibility;
        } catch (e) {}
        return true;
    }

    function setLayerVisible(layer, visible = true) {
        if (!layer) return;
        try {
            if (typeof layer.setVisible === 'function' && layer.getVisible?.() !== visible) {
                layer.setVisible(visible);
            }
        } catch (e) {}
        try {
            if (typeof layer.setVisibility === 'function' && layer.getVisibility?.() !== visible) {
                layer.setVisibility(visible);
            }
        } catch (e) {}
    }

    /* ==========================================================================
       3B. RASTER GPS TILE / CANVAS PIXEL SCANNER (Reads WME's colored GPS arrows)
       ========================================================================== */
    let sharedSampleCanvas = null;
    let sharedSampleCtx = null;

    function getSampleCanvas(w, h) {
        if (!sharedSampleCanvas) {
            sharedSampleCanvas = document.createElement('canvas');
            sharedSampleCtx = sharedSampleCanvas.getContext('2d', { willReadFrequently: true });
        }
        if (sharedSampleCanvas.width !== w || sharedSampleCanvas.height !== h) {
            sharedSampleCanvas.width = w;
            sharedSampleCanvas.height = h;
        }
        return { canvas: sharedSampleCanvas, ctx: sharedSampleCtx };
    }

    function rgbToHueDeg(r, g, b) {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const delta = max - min;
        if (delta < 32) return null; // Not saturated enough to carry reliable Waze azimuth hue
        let h = 0;
        if (max === r) h = ((g - b) / delta) % 6;
        else if (max === g) h = (b - r) / delta + 2;
        else h = (r - g) / delta + 4;
        h = h * 60;
        if (h < 0) h += 360;
        return h;
    }

    function analyzeImageDataForGpsTraces(imageData, w, h, cellPx = 8) {
        const data = imageData.data;
        const totalPixels = w * h;
        if (totalPixels === 0) return 'non_gps';

        // Quick transparency check: GPS trace overlays have transparent background (>40% transparent),
        // whereas satellite/basemap tiles are 100% opaque. Never scan an opaque basemap tile!
        let transparentSamples = 0;
        let checkedSamples = 0;
        const stride = Math.max(4, Math.floor(totalPixels / 400)) * 4;
        for (let idx = 3; idx < data.length; idx += stride) {
            checkedSamples++;
            if (data[idx] < 25) transparentSamples++;
        }
        if (checkedSamples > 0 && (transparentSamples / checkedSamples) < 0.35) {
            return 'non_gps';
        }

        const step = Math.max(4, Math.min(16, cellPx));
        const uvPoints = [];

        for (let cy = 0; cy < h; cy += step) {
            const yMax = Math.min(h, cy + step);
            for (let cx = 0; cx < w; cx += step) {
                const xMax = Math.min(w, cx + step);
                let sumX = 0, sumY = 0, hitCount = 0;
                let hueSinSum = 0, hueCosSum = 0, hueCount = 0;

                for (let py = cy; py < yMax; py += 2) {
                    const rowOffset = py * w * 4;
                    for (let px = cx; px < xMax; px += 2) {
                        const i = rowOffset + px * 4;
                        const a = data[i + 3];
                        if (a < 85) continue;

                        const r = data[i];
                        const g = data[i + 1];
                        const b = data[i + 2];
                        const maxC = Math.max(r, g, b);
                        const minC = Math.min(r, g, b);
                        const saturation = maxC - minC;

                        // WME GPS arrows/dots are vivid directional colors or bright breadcrumbs on transparent bg
                        if (saturation >= 22 || (a >= 150 && maxC >= 80)) {
                            sumX += px;
                            sumY += py;
                            hitCount++;
                            const hue = rgbToHueDeg(r, g, b);
                            if (hue !== null) {
                                const rad = hue * Math.PI / 180;
                                hueCosSum += Math.cos(rad);
                                hueSinSum += Math.sin(rad);
                                hueCount++;
                            }
                        }
                    }
                }

                if (hitCount > 0) {
                    let cellHue = null;
                    if (hueCount > 0) {
                        cellHue = Math.atan2(hueSinSum / hueCount, hueCosSum / hueCount) * 180 / Math.PI;
                        if (cellHue < 0) cellHue += 360;
                    }
                    uvPoints.push({
                        u: (sumX / hitCount) / w,
                        v: (sumY / hitCount) / h,
                        hue: cellHue
                    });
                }
            }
        }

        return uvPoints;
    }

    function fetchTileBitmapViaGM(url) {
        return new Promise((resolve) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                resolve(null);
                return;
            }
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) { settled = true; resolve(null); }
            }, 2200);

            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    responseType: 'blob',
                    anonymous: false,
                    onload: (resp) => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        if (resp.status >= 200 && resp.status < 300 && resp.response && typeof createImageBitmap === 'function') {
                            createImageBitmap(resp.response).then(resolve).catch(() => resolve(null));
                        } else {
                            resolve(null);
                        }
                    },
                    onerror: () => {
                        if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
                    },
                    ontimeout: () => {
                        if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
                    }
                });
            } catch (e) {
                if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
            }
        });
    }

    function fetchTileViaCorsImage(url) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            const timer = setTimeout(() => resolve(null), 1500);
            img.onload = () => { clearTimeout(timer); resolve(img); };
            img.onerror = () => { clearTimeout(timer); resolve(null); };
            img.src = url;
        });
    }

    async function extractUvFromTileImage(imgEl, cellPx) {
        const src = imgEl.currentSrc || imgEl.src;
        if (!src) return [];

        if (rasterTileCache.has(src)) {
            const cached = rasterTileCache.get(src);
            return Array.isArray(cached) ? cached : [];
        }

        const w = imgEl.naturalWidth || 256;
        const h = imgEl.naturalHeight || 256;

        // Tier 1: Direct draw from existing DOM <img>
        try {
            const { ctx } = getSampleCanvas(w, h);
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(imgEl, 0, 0, w, h);
            const imgData = ctx.getImageData(0, 0, w, h);
            const res = analyzeImageDataForGpsTraces(imgData, w, h, cellPx);
            rasterTileCache.set(src, res);
            return Array.isArray(res) ? res : [];
        } catch (corsErr) {
            // Canvas was tainted due to cross-subdomain tile host; try CORS Image, then GM_xmlhttpRequest
        }

        // Tier 2: Reload with crossOrigin="anonymous"
        try {
            const corsImg = await fetchTileViaCorsImage(src);
            if (corsImg) {
                const { ctx } = getSampleCanvas(w, h);
                ctx.clearRect(0, 0, w, h);
                ctx.drawImage(corsImg, 0, 0, w, h);
                const imgData = ctx.getImageData(0, 0, w, h);
                const res = analyzeImageDataForGpsTraces(imgData, w, h, cellPx);
                rasterTileCache.set(src, res);
                return Array.isArray(res) ? res : [];
            }
        } catch (e) {}

        // Tier 3: GM_xmlhttpRequest blob -> ImageBitmap (bypasses subdomain CORS taint cleanly)
        try {
            const bmp = await fetchTileBitmapViaGM(src);
            if (bmp) {
                const bw = bmp.width || w;
                const bh = bmp.height || h;
                const { ctx } = getSampleCanvas(bw, bh);
                ctx.clearRect(0, 0, bw, bh);
                ctx.drawImage(bmp, 0, 0, bw, bh);
                if (typeof bmp.close === 'function') bmp.close();
                const imgData = ctx.getImageData(0, 0, bw, bh);
                const res = analyzeImageDataForGpsTraces(imgData, bw, bh, cellPx);
                rasterTileCache.set(src, res);
                return Array.isArray(res) ? res : [];
            }
        } catch (e) {}

        rasterTileCache.set(src, 'failed');
        return [];
    }

    function getMapViewportElement() {
        if (win.W && win.W.map) {
            if (win.W.map.olMap && typeof win.W.map.olMap.getViewport === 'function') {
                const vp = win.W.map.olMap.getViewport();
                if (vp) return vp;
            }
            if (win.W.map.viewPortDiv) return win.W.map.viewPortDiv;
        }
        return document.querySelector('#WazeMap .ol-viewport, #WazeMap .olMapViewport, #WazeMap, #map') || document.body;
    }

    function getGpsLayerDomContainers() {
        const containers = [];
        const seen = new Set();

        function addEl(el) {
            if (el && el.nodeType === 1 && !seen.has(el)) {
                seen.add(el);
                containers.push(el);
            }
        }

        const gpsLayer = getNativeGpsLayer();
        if (gpsLayer) {
            if (gpsLayer.div) addEl(gpsLayer.div);
            if (gpsLayer.id) addEl(document.getElementById(gpsLayer.id));
            try {
                const renderer = typeof gpsLayer.getRenderer === 'function' ? gpsLayer.getRenderer() : gpsLayer.renderer_;
                if (renderer && renderer.container) addEl(renderer.container);
            } catch (e) {}
        }

        // Also locate any DOM layer container explicitly named/id'd for gps_points
        document.querySelectorAll('[id*="gps_points" i], [id*="GPSTraces" i], [class*="gps_points" i], [class*="gps-points" i]').forEach(el => {
            if (!el.closest('#wme-need-a-road-panel') && !el.closest('wz-menu-item') && !el.closest('wz-checkbox')) {
                addEl(el);
            }
        });

        // Also look for <img> tiles whose URL matches Waze GPS / trace tile patterns
        const mapEl = getMapViewportElement();
        const candidateImgs = [];
        if (mapEl) {
            mapEl.querySelectorAll('img').forEach(img => {
                const src = img.currentSrc || img.src || '';
                if (/(gps|trace|track|archive)/i.test(src)) {
                    candidateImgs.push(img);
                }
            });
        }

        return { containers, candidateImgs };
    }

    async function extractRasterGpsPointsInView(extent) {
        const extracted = [];
        const viewportEl = getMapViewportElement();
        if (!viewportEl || !extent) return extracted;

        const mapRect = viewportEl.getBoundingClientRect();
        if (mapRect.width <= 0 || mapRect.height <= 0) return extracted;

        // Calculate ~5-meter ground sampling interval in pixels so density is zoom-independent
        const midLat = (extent.minLat + extent.maxLat) / 2;
        const viewWidthMeters = haversineDistanceMeters(midLat, extent.minLon, midLat, extent.maxLon);
        const metersPerPx = viewWidthMeters / mapRect.width;
        const targetSamplePx = (metersPerPx > 0) ? Math.max(5, Math.min(14, Math.round(5.0 / metersPerPx))) : 8;

        const { containers, candidateImgs } = getGpsLayerDomContainers();
        const imgElements = new Set(candidateImgs);
        const canvasElements = new Set();

        for (const container of containers) {
            if (container.tagName === 'IMG') imgElements.add(container);
            if (container.tagName === 'CANVAS') canvasElements.add(container);
            container.querySelectorAll('img').forEach(img => imgElements.add(img));
            container.querySelectorAll('canvas').forEach(cv => canvasElements.add(cv));
        }

        // 1. Wait briefly if GPS <img> tiles are currently mid-download
        const pendingImgs = [...imgElements].filter(img => !img.complete && (img.currentSrc || img.src));
        if (pendingImgs.length > 0) {
            await Promise.race([
                Promise.all(pendingImgs.map(img => new Promise(res => {
                    img.addEventListener('load', res, { once: true });
                    img.addEventListener('error', res, { once: true });
                }))),
                new Promise(res => setTimeout(res, 1200))
            ]);
        }

        // 2. Process loaded <img> tiles
        const visibleImgs = [...imgElements].filter(img => {
            if (!img.complete || img.naturalWidth === 0) return false;
            const r = img.getBoundingClientRect();
            return r.width > 0 && r.height > 0 &&
                   r.right > mapRect.left && r.left < mapRect.right &&
                   r.bottom > mapRect.top && r.top < mapRect.bottom;
        });

        if (visibleImgs.length > 0) {
            const tileResults = await Promise.all(visibleImgs.map(async (img) => {
                const r = img.getBoundingClientRect();
                const tileCellPx = Math.max(4, Math.round(targetSamplePx * (img.naturalWidth / r.width)));
                const uvList = await extractUvFromTileImage(img, tileCellPx);
                return { rect: r, uvList };
            }));

            for (const { rect, uvList } of tileResults) {
                for (const { u, v, hue } of uvList) {
                    const vx = (rect.left - mapRect.left) + u * rect.width;
                    const vy = (rect.top - mapRect.top) + v * rect.height;
                    if (vx < 0 || vy < 0 || vx > mapRect.width || vy > mapRect.height) continue;

                    const ll = pixelToLonLat(vx, vy, extent, mapRect.width, mapRect.height);
                    if (ll && Number.isFinite(ll.lon) && Number.isFinite(ll.lat)) {
                        const merc = latLonToMercator(ll.lat, ll.lon);
                        extracted.push({ lon: ll.lon, lat: ll.lat, x: merc.x, y: merc.y, hue: hue ?? null });
                    }
                }
            }
        }

        // 3. Process dedicated GPS overlay <canvas> elements (transparent-background check protects against basemap canvases)
        for (const cv of canvasElements) {
            try {
                if (cv.width === 0 || cv.height === 0) continue;
                const r = cv.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                const ctx = cv.getContext('2d');
                if (!ctx) continue;
                const imgData = ctx.getImageData(0, 0, cv.width, cv.height);
                const cvCellPx = Math.max(4, Math.round(targetSamplePx * (cv.width / r.width)));
                const uvList = analyzeImageDataForGpsTraces(imgData, cv.width, cv.height, cvCellPx);
                if (Array.isArray(uvList)) {
                    for (const { u, v, hue } of uvList) {
                        const vx = (r.left - mapRect.left) + u * r.width;
                        const vy = (r.top - mapRect.top) + v * r.height;
                        if (vx < 0 || vy < 0 || vx > mapRect.width || vy > mapRect.height) continue;

                        const ll = pixelToLonLat(vx, vy, extent, mapRect.width, mapRect.height);
                        if (ll && Number.isFinite(ll.lon) && Number.isFinite(ll.lat)) {
                            const merc = latLonToMercator(ll.lat, ll.lon);
                            extracted.push({ lon: ll.lon, lat: ll.lat, x: merc.x, y: merc.y, hue: hue ?? null });
                        }
                    }
                }
            } catch (e) {}
        }

        // Keep cache bounded
        if (rasterTileCache.size > 600) {
            const keys = [...rasterTileCache.keys()].slice(0, 200);
            keys.forEach(k => rasterTileCache.delete(k));
        }

        return extracted;
    }

    /* ==========================================================================
       4. WME LAYER MANAGEMENT (Safely ensures ROADS and GPS layers are ON)
       ========================================================================== */
    function ensureRequiredLayers() {
        let changed = false;

        // 1. Official WME SDK LayerSwitcher (safe, idempotent)
        if (wmeSDK && wmeSDK.LayerSwitcher) {
            try {
                if (typeof wmeSDK.LayerSwitcher.setRoadsLayerCheckboxChecked === 'function') {
                    wmeSDK.LayerSwitcher.setRoadsLayerCheckboxChecked({ isChecked: true });
                }
            } catch (e) {
                try { wmeSDK.LayerSwitcher.setRoadsLayerCheckboxChecked(true); } catch (e2) {}
            }

            try {
                if (typeof wmeSDK.LayerSwitcher.setLayerCheckboxChecked === 'function') {
                    wmeSDK.LayerSwitcher.setLayerCheckboxChecked({ name: 'layer-switcher-item_gps_points', isChecked: true });
                    wmeSDK.LayerSwitcher.setLayerCheckboxChecked({ name: 'layer-switcher-item_road', isChecked: true });
                }
            } catch (e) {}

            try {
                if (typeof wmeSDK.LayerSwitcher.setWMELayerVisibility === 'function') {
                    const L = wmeSDK.WME_LAYER_NAMES || {};
                    if (L.SEGMENTS) wmeSDK.LayerSwitcher.setWMELayerVisibility(L.SEGMENTS, true);
                    if (L.GPS_POINTS) wmeSDK.LayerSwitcher.setWMELayerVisibility(L.GPS_POINTS, true);
                }
            } catch (e) {
                try {
                    wmeSDK.LayerSwitcher.setWMELayerVisibility({ layerName: 'roads', isVisible: true });
                    wmeSDK.LayerSwitcher.setWMELayerVisibility({ layerName: 'gps_points', isVisible: true });
                } catch (e2) {}
            }
        }

        // 2. OpenLayers Layer Visibility (checks visibility before setting)
        const gpsLayer = getNativeGpsLayer();
        if (gpsLayer && !isLayerVisible(gpsLayer)) {
            setLayerVisible(gpsLayer, true);
            changed = true;
        }
        findLayersByRegex(/gps_points|gpstrace/i).forEach(l => setLayerVisible(l, true));
        findLayersByRegex(/^roads?$|^segments?$/i).forEach(l => setLayerVisible(l, true));

        // 3. Targeted DOM fallback ONLY if GPS layer is still hidden (never toggles an already-checked item!)
        const gpsStillOff = gpsLayer ? !isLayerVisible(gpsLayer) : false;
        if (gpsStillOff) {
            const gpsMenuItem = document.getElementById('layer-switcher-item_gps_points');
            if (gpsMenuItem && !isWmeToggleChecked(gpsMenuItem)) {
                gpsMenuItem.click();
                changed = true;
            }
        }

        return changed;
    }

    function isWmeToggleChecked(el) {
        if (!el) return false;
        if (el.checked === true) return true;
        if (el.hasAttribute('checked') && el.getAttribute('checked') !== 'false') return true;
        if (el.hasAttribute('selected') && el.getAttribute('selected') !== 'false') return true;
        if (el.getAttribute('aria-checked') === 'true') return true;
        if (el.classList.contains('checked') || el.classList.contains('selected') || el.classList.contains('is-checked')) return true;
        const inner = el.querySelector && el.querySelector('input[type="checkbox"], wz-checkbox');
        if (inner && (inner.checked === true || (inner.hasAttribute('checked') && inner.getAttribute('checked') !== 'false'))) {
            return true;
        }
        return false;
    }

    /* ==========================================================================
       5. EXTENT, ZOOM, SEGMENTS, GPS POINTS & EDITABLE AREAS
       ========================================================================== */
    function parseNumericBounds(b) {
        if (!b) return null;
        let x1, y1, x2, y2;

        if (Array.isArray(b) && b.length >= 4) {
            [x1, y1, x2, y2] = b;
        } else if (typeof b === 'object') {
            x1 = b.left ?? b.minX ?? b.minLon ?? b.west;
            y1 = b.bottom ?? b.minY ?? b.minLat ?? b.south;
            x2 = b.right ?? b.maxX ?? b.maxLon ?? b.east;
            y2 = b.top ?? b.maxY ?? b.maxLat ?? b.north;
        }

        if (![x1, y1, x2, y2].every(v => typeof v === 'number' && Number.isFinite(v))) {
            return null;
        }

        let bl, tr, left, bottom, right, top;
        if (Math.abs(x1) > 180 || Math.abs(x2) > 180 || Math.abs(y1) > 90 || Math.abs(y2) > 90) {
            left = Math.min(x1, x2);
            right = Math.max(x1, x2);
            bottom = Math.min(y1, y2);
            top = Math.max(y1, y2);
            bl = mercatorToLatLon(left, bottom);
            tr = mercatorToLatLon(right, top);
        } else {
            const minLon = Math.min(x1, x2);
            const maxLon = Math.max(x1, x2);
            const minLat = Math.min(y1, y2);
            const maxLat = Math.max(y1, y2);
            bl = { lon: minLon, lat: minLat };
            tr = { lon: maxLon, lat: maxLat };
            const mBl = latLonToMercator(minLat, minLon);
            const mTr = latLonToMercator(maxLat, maxLon);
            left = mBl.x;
            bottom = mBl.y;
            right = mTr.x;
            top = mTr.y;
        }

        if (![bl.lon, bl.lat, tr.lon, tr.lat].every(Number.isFinite)) return null;

        return {
            left,
            bottom,
            right,
            top,
            minLon: Math.min(bl.lon, tr.lon),
            maxLon: Math.max(bl.lon, tr.lon),
            minLat: Math.min(bl.lat, tr.lat),
            maxLat: Math.max(bl.lat, tr.lat)
        };
    }

    function getMapExtent() {
        // 1. Official WME SDK Map Extent
        if (wmeSDK && wmeSDK.Map) {
            try {
                const fn = wmeSDK.Map.getMapExtent || wmeSDK.Map.getExtent;
                if (typeof fn === 'function') {
                    const sdkExt = fn.call(wmeSDK.Map);
                    if (sdkExt && typeof sdkExt.then !== 'function') {
                        const parsed = parseNumericBounds(sdkExt);
                        if (parsed) return parsed;
                    }
                }
            } catch (e) {}
        }

        // 2. W.map.getExtent() / getOLExtent() (handles both Array [x1,y1,x2,y2] and OL2 Bounds object)
        if (win.W && win.W.map) {
            for (const mName of ['getExtent', 'getOLExtent']) {
                try {
                    if (typeof win.W.map[mName] === 'function') {
                        const parsed = parseNumericBounds(win.W.map[mName]());
                        if (parsed) return parsed;
                    }
                } catch (e) {}
            }

            // 3. OL3+ View calculateExtent
            if (win.W.map.olMap && typeof win.W.map.olMap.getView === 'function') {
                try {
                    const size = win.W.map.olMap.getSize();
                    const extArr = win.W.map.olMap.getView().calculateExtent(size);
                    const parsed = parseNumericBounds(extArr);
                    if (parsed) return parsed;
                } catch (e) {}
            }
        }

        return null;
    }

    function getCurrentZoom() {
        // 1. Official WME SDK (returns WME zoom 12..22 directly)
        if (wmeSDK && wmeSDK.Map && typeof wmeSDK.Map.getZoomLevel === 'function') {
            try {
                const z = wmeSDK.Map.getZoomLevel();
                if (typeof z === 'number' && Number.isFinite(z)) {
                    return Math.round(z);
                }
            } catch (e) {}
        }

        // 2. W.map.getZoom() (handles legacy 0..10 scale by adding +12, or modern 12..22 scale)
        if (win.W && win.W.map && typeof win.W.map.getZoom === 'function') {
            try {
                const z = win.W.map.getZoom();
                if (typeof z === 'number' && Number.isFinite(z)) {
                    return z <= 10 ? Math.round(z + 12) : Math.round(z);
                }
            } catch (e) {}
        }

        // 3. Permalink / URL fallback if present
        const m = win.location.search.match(/zoomLevel=(\d+)/);
        if (m) return parseInt(m[1], 10);

        return 16;
    }

    // Retrieve Drivable road segments loaded in WME data model
    function getLoadedSegments() {
        let rawSegments = [];

        if (wmeSDK && wmeSDK.DataModel && wmeSDK.DataModel.Segments && typeof wmeSDK.DataModel.Segments.getAll === 'function') {
            try {
                const segs = wmeSDK.DataModel.Segments.getAll();
                if (Array.isArray(segs) && segs.length > 0) rawSegments = segs;
            } catch (e) {}
        }

        if (rawSegments.length === 0 && win.W && win.W.model && win.W.model.segments) {
            if (typeof win.W.model.segments.getObjectArray === 'function') {
                rawSegments = win.W.model.segments.getObjectArray();
            } else if (win.W.model.segments.objects) {
                rawSegments = Object.values(win.W.model.segments.objects);
            }
        }

        const parsedSegments = [];

        for (const seg of rawSegments) {
            if (!seg) continue;

            const rType = seg.roadType ?? (seg.attributes && seg.attributes.roadType);
            if (rType !== undefined && !DRIVABLE_ROAD_TYPES.has(rType)) {
                continue; // Non-drivable paths (trails, stairs, railroads) do not count as roads
            }

            let wgsCoords = [];
            const geom = seg.geometry || (seg.attributes && seg.attributes.geometry) || (typeof seg.getGeometry === 'function' ? seg.getGeometry() : null);

            if (geom) {
                if (Array.isArray(geom.coordinates)) {
                    wgsCoords = geom.coordinates.map(c => toWgsPoint(c[0], c[1])).filter(Boolean);
                } else if (Array.isArray(geom.components)) {
                    wgsCoords = geom.components.map(pt => toWgsPoint(pt.x, pt.y)).filter(Boolean);
                } else if (typeof geom.getCoordinates === 'function') {
                    const cArr = geom.getCoordinates();
                    if (Array.isArray(cArr)) {
                        wgsCoords = cArr.map(c => toWgsPoint(c[0], c[1])).filter(Boolean);
                    }
                }
            }

            if (wgsCoords.length >= 2) {
                const attrs = seg.attributes || {};
                const lockRank = seg.lockRank ?? attrs.lockRank ?? 0;
                const primaryStreetId = seg.primaryStreetId ?? attrs.primaryStreetID ?? attrs.primaryStreetId ?? null;
                const fromNodeId = seg.fromNodeId ?? attrs.fromNodeID ?? attrs.fromNodeId ?? null;
                const toNodeId = seg.toNodeId ?? attrs.toNodeID ?? attrs.toNodeId ?? null;

                parsedSegments.push({
                    id: seg.id ?? attrs.id,
                    roadType: rType,
                    lockRank: typeof lockRank === 'number' ? lockRank : 0,
                    primaryStreetId,
                    fromNodeId,
                    toNodeId,
                    wgsPoints: wgsCoords,
                    rawSeg: seg
                });
            }
        }

        return parsedSegments;
    }

    // Extract all GPS points currently in viewport (Vector + Model + Network + Raster GPS Layer)
    async function getGpsPointsInViewport(extent) {
        const pointsInView = [];
        const seenGrid = new Map(); // gridKey -> index in pointsInView

        function addCandidate(lon, lat, hue = null) {
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            if (extent) {
                if (lon < extent.minLon || lon > extent.maxLon || lat < extent.minLat || lat > extent.maxLat) {
                    return;
                }
            }
            const gridKey = `${Math.round(lat * 45000)}_${Math.round(lon * 45000)}`;
            if (!seenGrid.has(gridKey)) {
                seenGrid.set(gridKey, pointsInView.length);
                const merc = latLonToMercator(lat, lon);
                pointsInView.push({ lon, lat, x: merc.x, y: merc.y, hue: typeof hue === 'number' ? hue : null });
            } else if (typeof hue === 'number') {
                const existingPt = pointsInView[seenGrid.get(gridKey)];
                if (existingPt && existingPt.hue === null) existingPt.hue = hue;
            }
        }

        // 1. Vector features on any GPS / trace layer
        const gpsLayers = findLayersByRegex(/gps|archive|trace/i);
        for (const layer of gpsLayers) {
            const feats = getFeaturesFromLayer(layer);
            for (const feat of feats) {
                extractCoordsFromFeature(feat);
            }
        }

        // 2. W.model.gpsPoints if exposed
        if (win.W && win.W.model && win.W.model.gpsPoints) {
            let pts = [];
            if (typeof win.W.model.gpsPoints.getObjectArray === 'function') {
                pts = win.W.model.gpsPoints.getObjectArray();
            } else if (win.W.model.gpsPoints.objects) {
                pts = Object.values(win.W.model.gpsPoints.objects);
            }
            for (const p of pts) {
                if (!p) continue;
                if (typeof p.x === 'number' && typeof p.y === 'number') registerPoint(p.x, p.y);
                else if (typeof p.lat === 'number' && typeof p.lon === 'number') registerPoint(p.lon, p.lat);
            }
        }

        // 3. Previously captured vector / network GPS points in view
        for (const pt of capturedGpsPoints.values()) {
            addCandidate(pt.lon, pt.lat, null);
        }

        // 4. Raster GPS Tile / Canvas Pixel Scanner (reads WME's gps_points tile layer + azimuth hues directly!)
        const rasterPts = await extractRasterGpsPointsInView(extent);
        for (const rp of rasterPts) {
            addCandidate(rp.lon, rp.lat, rp.hue);
        }

        return pointsInView;
    }

    /* ==========================================================================
       5B. UNIVERSAL EDITABLE AREA & MANAGED AREA LOADER
           (Supports Polygon, MultiPolygon, FeatureCollection, OL2, OL6+, WKT, SDK & Legacy)
       ========================================================================== */
    function parseWktGeometry(wkt) {
        if (typeof wkt !== 'string') return null;
        const trimmed = wkt.trim();
        if (!/^(MULTI)?POLYGON/i.test(trimmed)) return null;

        const polygons = [];
        const ringRegex = /\(([^()]+)\)/g;
        let match;
        while ((match = ringRegex.exec(trimmed)) !== null) {
            const pairs = match[1].split(',').map(s => s.trim().split(/\s+/).map(Number));
            const ring = pairs.map(p => toWgsPoint(p[0], p[1])).filter(Boolean);
            if (ring.length >= 3) {
                polygons.push({ outer: ring, holes: [] });
            }
        }
        return polygons.length > 0 ? polygons : null;
    }

    function extractPolygonsFromAnyGeometry(geom) {
        if (!geom) return [];
        const polygons = [];

        function computeRingBbox(ring) {
            let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
            for (const pt of ring) {
                if (pt.lon < minLon) minLon = pt.lon;
                if (pt.lon > maxLon) maxLon = pt.lon;
                if (pt.lat < minLat) minLat = pt.lat;
                if (pt.lat > maxLat) maxLat = pt.lat;
            }
            return { minLon, maxLon, minLat, maxLat };
        }

        function pushPolygonRings(rawRings) {
            if (!Array.isArray(rawRings) || rawRings.length === 0) return;
            const convertedRings = rawRings
                .map(r => Array.isArray(r) ? r.map(c => Array.isArray(c) ? toWgsPoint(c[0], c[1]) : (c && toWgsPoint(c.lon ?? c.x, c.lat ?? c.y))).filter(Boolean) : [])
                .filter(r => r.length >= 3);
            if (convertedRings.length > 0) {
                polygons.push({
                    outer: convertedRings[0],
                    holes: convertedRings.slice(1),
                    bbox: computeRingBbox(convertedRings[0])
                });
            }
        }

        function inspectCoordTree(coords) {
            if (!Array.isArray(coords) || coords.length === 0) return;
            // Depth check:
            // [number, number] -> point
            // [[num, num], ...] -> single ring
            // [[[num, num], ...], ...] -> Polygon (array of rings)
            // [[[[num, num], ...]], ...] -> MultiPolygon (array of Polygons)
            const first = coords[0];
            if (!Array.isArray(first)) return;
            if (typeof first[0] === 'number') {
                // Single ring passed directly
                pushPolygonRings([coords]);
            } else if (Array.isArray(first[0]) && typeof first[0][0] === 'number') {
                // Polygon: coords is Array<Ring>
                pushPolygonRings(coords);
            } else if (Array.isArray(first[0])) {
                // MultiPolygon or deeper collection: recurse into each Polygon
                for (const sub of coords) inspectCoordTree(sub);
            }
        }

        function inspectOlComponents(compObj) {
            if (!compObj || !Array.isArray(compObj.components) || compObj.components.length === 0) return;
            const first = compObj.components[0];
            if (!first) return;
            if (typeof first.x === 'number' && typeof first.y === 'number') {
                // LinearRing
                pushPolygonRings([compObj.components]);
            } else if (Array.isArray(first.components) && first.components[0] && typeof first.components[0].x === 'number') {
                // Polygon containing LinearRings
                pushPolygonRings(compObj.components.map(lr => lr.components));
            } else {
                // MultiPolygon or GeometryCollection
                for (const sub of compObj.components) inspectOlComponents(sub);
            }
        }

        // Unwrap WKT string
        if (typeof geom === 'string') {
            const wktPolys = parseWktGeometry(geom);
            if (wktPolys) {
                for (const wp of wktPolys) {
                    polygons.push({ outer: wp.outer, holes: wp.holes, bbox: computeRingBbox(wp.outer) });
                }
            }
            return polygons;
        }

        // Unwrap GeoJSON Feature / FeatureCollection / wrapper objects
        if (geom.type === 'FeatureCollection' && Array.isArray(geom.features)) {
            for (const f of geom.features) {
                polygons.push(...extractPolygonsFromAnyGeometry(f));
            }
            return polygons;
        }
        if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
            for (const g of geom.geometries) {
                polygons.push(...extractPolygonsFromAnyGeometry(g));
            }
            return polygons;
        }
        if (geom.geometry) {
            return extractPolygonsFromAnyGeometry(geom.geometry);
        }
        if (typeof geom.getGeometry === 'function') {
            try {
                return extractPolygonsFromAnyGeometry(geom.getGeometry());
            } catch (e) {}
        }

        // OL3+ Geometry with getCoordinates()
        if (typeof geom.getCoordinates === 'function') {
            try {
                inspectCoordTree(geom.getCoordinates());
                if (polygons.length > 0) return polygons;
            } catch (e) {}
        }

        // Standard GeoJSON coordinates (Polygon or MultiPolygon)
        if (Array.isArray(geom.coordinates)) {
            inspectCoordTree(geom.coordinates);
            if (polygons.length > 0) return polygons;
        }

        // OpenLayers 2 Geometry components
        if (Array.isArray(geom.components)) {
            inspectOlComponents(geom);
            if (polygons.length > 0) return polygons;
        }

        // Direct coordinate array
        if (Array.isArray(geom)) {
            inspectCoordTree(geom);
        }

        return polygons;
    }

    function buildAreaEntry(polygons, label, idHint) {
        if (!Array.isArray(polygons) || polygons.length === 0) return null;

        let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
        let approxSqKm = 0;

        for (const poly of polygons) {
            if (poly.bbox.minLon < minLon) minLon = poly.bbox.minLon;
            if (poly.bbox.maxLon > maxLon) maxLon = poly.bbox.maxLon;
            if (poly.bbox.minLat < minLat) minLat = poly.bbox.minLat;
            if (poly.bbox.maxLat > maxLat) maxLat = poly.bbox.maxLat;

            // Shoelace area in km² on outer ring
            const ring = poly.outer;
            const midLatRad = ((poly.bbox.minLat + poly.bbox.maxLat) / 2) * Math.PI / 180;
            const kmPerDegLon = 111.32 * Math.cos(midLatRad);
            const kmPerDegLat = 110.57;
            let twoArea = 0;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const x1 = ring[j].lon * kmPerDegLon, y1 = ring[j].lat * kmPerDegLat;
                const x2 = ring[i].lon * kmPerDegLon, y2 = ring[i].lat * kmPerDegLat;
                twoArea += (x1 * y2 - x2 * y1);
            }
            approxSqKm += Math.abs(twoArea) / 2;
        }

        if (![minLon, maxLon, minLat, maxLat].every(Number.isFinite)) return null;

        const areaLabel = approxSqKm >= 10
            ? `${Math.round(approxSqKm)} km²`
            : `${Math.max(0.1, Number(approxSqKm.toFixed(1)))} km²`;
        const zoneSuffix = polygons.length > 1 ? `, ${polygons.length} zones` : '';
        const cleanId = String(idHint || `${label}_${minLon.toFixed(3)}_${minLat.toFixed(3)}`)
            .toLowerCase()
            .replace(/[^a-z0-9_]+/g, '_');

        return {
            id: cleanId,
            name: `${label} (~${areaLabel}${zoneSuffix})`,
            polygons,
            rings: polygons.map(p => p.outer),
            bbox: { minLon, maxLon, minLat, maxLat }
        };
    }

    function normalizeRawAreas(rawInput, defaultPrefix = 'Editable Area') {
        if (!rawInput) return [];
        const results = [];

        try {
            // Case 1: Single Geometry / Feature / WKT string (e.g. GeoJSON MultiPolygon directly on userInfo.editableAreas)
            if (typeof rawInput === 'string' ||
                rawInput.type === 'Polygon' ||
                rawInput.type === 'MultiPolygon' ||
                rawInput.type === 'Feature' ||
                rawInput.type === 'FeatureCollection' ||
                rawInput.type === 'GeometryCollection' ||
                Array.isArray(rawInput.coordinates) ||
                Array.isArray(rawInput.components) ||
                typeof rawInput.getCoordinates === 'function') {
                const polys = extractPolygonsFromAnyGeometry(rawInput);
                const entry = buildAreaEntry(polys, `🛡️ ${defaultPrefix}`, defaultPrefix);
                if (entry) results.push(entry);
                return results;
            }

            // Case 2: Collection wrapper (.objects, .models, getObjectArray(), Map, Set, Array)
            let list = [];
            if (Array.isArray(rawInput)) {
                list = rawInput;
            } else if (typeof rawInput.getObjectArray === 'function') {
                list = rawInput.getObjectArray() || [];
            } else if (Array.isArray(rawInput.models)) {
                list = rawInput.models;
            } else if (rawInput instanceof Map || rawInput instanceof Set) {
                list = [...rawInput.values()];
            } else if (rawInput.objects && typeof rawInput.objects === 'object') {
                list = Object.values(rawInput.objects);
            } else if (rawInput.geometry || (rawInput.attributes && rawInput.attributes.geometry)) {
                list = [rawInput];
            } else if (typeof rawInput === 'object') {
                list = Object.values(rawInput);
            }

            const combinedUnnamedPolys = [];

            list.forEach((item, idx) => {
                if (!item) return;
                const attrs = item.attributes || item.properties || {};
                const explicitName = item.name || attrs.name || item.title || attrs.title;
                const geomCandidate = item.geometry || attrs.geometry || item;
                const polys = extractPolygonsFromAnyGeometry(geomCandidate);
                if (polys.length === 0) return;

                if (explicitName) {
                    const entry = buildAreaEntry(polys, `🛡️ ${explicitName}`, `${defaultPrefix}_${explicitName}_${item.id ?? idx}`);
                    if (entry) results.push(entry);
                } else {
                    combinedUnnamedPolys.push(...polys);
                }
            });

            if (combinedUnnamedPolys.length > 0) {
                const combinedEntry = buildAreaEntry(combinedUnnamedPolys, `🛡️ ${defaultPrefix}`, `${defaultPrefix}_combined`);
                if (combinedEntry) results.unshift(combinedEntry);

                // If the user has multiple disjoint unnamed zones (e.g. separate drive areas), also list each zone individually!
                if (combinedUnnamedPolys.length > 1 && combinedUnnamedPolys.length <= 15) {
                    combinedUnnamedPolys.forEach((poly, idx) => {
                        const sub = buildAreaEntry([poly], `🔹 ${defaultPrefix} Zone #${idx + 1}`, `${defaultPrefix}_zone_${idx + 1}`);
                        if (sub) results.push(sub);
                    });
                }
            }
        } catch (err) {
            console.warn(`[${SCRIPT_SHORT}] Area parse warning for ${defaultPrefix}:`, err);
        }

        return results;
    }

    // Retrieve Editor Area Permissions from all SDK, W.loginManager, W.model, Layer & Network sources
    function getEditorPermissions() {
        const areas = [];
        const seenSignatures = new Set();

        function addUniqueArea(area) {
            if (!area || !area.bbox) return;
            const sig = `${area.bbox.minLon.toFixed(3)}_${area.bbox.minLat.toFixed(3)}_${area.bbox.maxLon.toFixed(3)}_${area.bbox.maxLat.toFixed(3)}_${area.polygons.length}`;
            if (!seenSignatures.has(sig)) {
                seenSignatures.add(sig);
                areas.push(area);
            }
        }

        // 1. Official WME SDK: wmeSDK.State.getUserInfo() / wmeSDK.Users.getUserInfo()
        if (wmeSDK) {
            try {
                const stateMod = wmeSDK.State || wmeSDK.Users;
                let userInfo = null;
                if (stateMod) {
                    if (typeof stateMod.getUserInfo === 'function') {
                        const res = stateMod.getUserInfo();
                        if (res && typeof res.then !== 'function') userInfo = res;
                    } else if (stateMod.userInfo) {
                        userInfo = stateMod.userInfo;
                    }
                }
                if (userInfo) {
                    normalizeRawAreas(userInfo.editableAreas || userInfo.editableArea, 'My Editable Area').forEach(addUniqueArea);
                    normalizeRawAreas(userInfo.managedAreas, 'Managed Area').forEach(addUniqueArea);
                    normalizeRawAreas(userInfo.areas, 'Permitted Area').forEach(addUniqueArea);
                }
            } catch (e) {}

            // 2. Official WME SDK: wmeSDK.DataModel.ManagedAreas.getAll()
            try {
                if (wmeSDK.DataModel && wmeSDK.DataModel.ManagedAreas && typeof wmeSDK.DataModel.ManagedAreas.getAll === 'function') {
                    const ma = wmeSDK.DataModel.ManagedAreas.getAll();
                    if (ma && typeof ma.then !== 'function') {
                        normalizeRawAreas(ma, 'Managed Area').forEach(addUniqueArea);
                    }
                }
            } catch (e) {}
        }

        // 3. W.loginManager.user (works regardless of whether the Editable Area map layer is toggled on or off)
        try {
            const lm = win.W && win.W.loginManager;
            const user = lm && (lm.user || (typeof lm.getUser === 'function' ? lm.getUser() : null));
            if (user) {
                const uAttrs = user.attributes || {};
                const editableCandidates = [
                    typeof user.getEditableAreas === 'function' ? user.getEditableAreas() : null,
                    typeof user.get === 'function' ? user.get('editableAreas') : null,
                    typeof user.get === 'function' ? user.get('editableArea') : null,
                    typeof user.get === 'function' ? user.get('areas') : null,
                    user.editableAreas,
                    user.editableArea,
                    user.driveAreas,
                    user.areas,
                    uAttrs.editableAreas,
                    uAttrs.editableArea,
                    uAttrs.driveAreas,
                    uAttrs.areas,
                    user.managedAreas,
                    uAttrs.managedAreas
                ];
                for (const cand of editableCandidates) {
                    if (cand) normalizeRawAreas(cand, 'My Editable Area').forEach(addUniqueArea);
                }
            }
        } catch (e) {}

        // 4. W.model collections (managedAreas, editableAreas, areas)
        try {
            const model = win.W && win.W.model;
            if (model) {
                if (model.editableAreas) normalizeRawAreas(model.editableAreas, 'My Editable Area').forEach(addUniqueArea);
                if (model.managedAreas) normalizeRawAreas(model.managedAreas, 'Managed Area').forEach(addUniqueArea);
                if (model.areas) normalizeRawAreas(model.areas, 'Editable Area').forEach(addUniqueArea);
            }
        } catch (e) {}

        // 5. OpenLayers Map Layers (editable_areas / Editable areas / managed_areas)
        try {
            const areaLayers = findLayersByRegex(/editable.*area|managed.*area|^areas$/i);
            if (win.W && win.W.map && typeof win.W.map.getLayerByUniqueName === 'function') {
                for (const uName of ['editable_areas', 'Editable areas', 'Editable area', 'managed_areas']) {
                    const l = win.W.map.getLayerByUniqueName(uName);
                    if (l && !areaLayers.includes(l)) areaLayers.push(l);
                }
            }
            for (const layer of areaLayers) {
                const feats = getFeaturesFromLayer(layer);
                if (feats && feats.length > 0) {
                    normalizeRawAreas(feats, 'My Editable Area').forEach(addUniqueArea);
                }
            }
        } catch (e) {}

        // 6. Cached Network Areas (from WME initialization / Features payloads)
        for (const na of cachedNetworkAreas) {
            addUniqueArea(na);
        }

        // 7. Guaranteed Window-Centered Scan Areas (Current Viewport, 4 km² Area, and 20 km² Area)
        const extent = getMapExtent();
        if (extent) {
            const cLon = (extent.minLon + extent.maxLon) / 2;
            const cLat = (extent.minLat + extent.maxLat) / 2;
            const kmPerDegLat = 110.574;
            const kmPerDegLon = Math.max(20, 111.320 * Math.cos(cLat * Math.PI / 180));

            function makeCenteredSquareArea(areaSqKm, label, fixedId) {
                const halfSideKm = Math.sqrt(areaSqKm) / 2;
                const dLat = halfSideKm / kmPerDegLat;
                const dLon = halfSideKm / kmPerDegLon;
                const polys = extractPolygonsFromAnyGeometry({
                    type: 'Polygon',
                    coordinates: [[
                        [cLon - dLon, cLat - dLat],
                        [cLon + dLon, cLat - dLat],
                        [cLon + dLon, cLat + dLat],
                        [cLon - dLon, cLat + dLat],
                        [cLon - dLon, cLat - dLat]
                    ]]
                });
                const entry = buildAreaEntry(polys, label, fixedId);
                if (entry) {
                    entry.id = fixedId;
                    entry.name = `${label} (${areaSqKm} km²)`;
                }
                return entry;
            }

            const area4 = makeCenteredSquareArea(4, '🗺️ Surrounding Window', 'scan_area_4km2');
            const area20 = makeCenteredSquareArea(20, '🌐 Wide Surrounding Window', 'scan_area_20km2');

            const vpPolys = extractPolygonsFromAnyGeometry({
                type: 'Polygon',
                coordinates: [[
                    [extent.minLon, extent.minLat],
                    [extent.maxLon, extent.minLat],
                    [extent.maxLon, extent.maxLat],
                    [extent.minLon, extent.maxLat],
                    [extent.minLon, extent.minLat]
                ]]
            });
            const vpEntry = buildAreaEntry(vpPolys, '📍 Current Viewport (Screen)', 'current_viewport');
            if (vpEntry) vpEntry.id = 'current_viewport';

            if (area4) areas.push(area4);
            if (area20) areas.push(area20);
            if (vpEntry) areas.push(vpEntry);
        }

        cachedResolvedAreas = areas;
        return areas;
    }

    /* ==========================================================================
       6. CORE SCANNING & COMPILED QUEUE MERGING (Zoom 18+)
       ========================================================================== */
    // Road-type-aware corridor radius: accounts for multi-lane carriageways + consumer phone GPS scatter
    function getRoadCoverageRadiusMeters(roadType, baseTolerance = 18) {
        const base = Math.max(8, baseTolerance);
        const scale = base / 18;
        switch (roadType) {
            case 3:  return Math.max(base, Math.round(28 * scale)); // Freeway (wide lanes + shoulders + high-speed GPS lag)
            case 6:  return Math.max(base, Math.round(24 * scale)); // Major Highway
            case 7:                                                 // Minor Highway
            case 2:                                                 // Primary Street
            case 4:  return Math.max(base, Math.round(21 * scale)); // Ramp
            case 8:                                                 // Dirt / 4WD
            case 17:                                                // Private Road
            case 20: return Math.max(14, Math.round(16 * scale));   // Parking Lot Road
            default: return base;                                   // Standard Street (default 18m)
        }
    }

    function computeMinDistanceToSegments(lat, lon, segments) {
        const R = 6371000;
        const cosLat = Math.cos(lat * Math.PI / 180);
        const px = lon * (Math.PI / 180) * R * cosLat;
        const py = lat * (Math.PI / 180) * R;

        let nearestDist = Infinity;
        let nearestAngleRad = null;
        let isCovered = false;

        for (const seg of segments) {
            const segRadius = getRoadCoverageRadiusMeters(seg.roadType, settings.proximityThresholdMeters);
            const pts = seg.wgsPoints;
            for (let i = 0; i < pts.length - 1; i++) {
                const v1 = pts[i];
                const v2 = pts[i + 1];

                // Fast ~120m degree bounding-box skip
                if ((lon < v1.lon - 0.0015 && lon < v2.lon - 0.0015) ||
                    (lon > v1.lon + 0.0015 && lon > v2.lon + 0.0015) ||
                    (lat < v1.lat - 0.0012 && lat < v2.lat - 0.0012) ||
                    (lat > v1.lat + 0.0012 && lat > v2.lat + 0.0012)) {
                    continue;
                }

                const ax = v1.lon * (Math.PI / 180) * R * cosLat;
                const ay = v1.lat * (Math.PI / 180) * R;
                const bx = v2.lon * (Math.PI / 180) * R * cosLat;
                const by = v2.lat * (Math.PI / 180) * R;

                const dist = distanceToLineSegmentMeters(px, py, ax, ay, bx, by);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    let ang = Math.atan2(by - ay, bx - ax);
                    if (ang < 0) ang += Math.PI;
                    nearestAngleRad = ang;
                }
                if (dist <= segRadius) {
                    isCovered = true;
                    break;
                }
            }
            if (isCovered) break;
        }

        return { isCovered, nearestDist, nearestAngleRad };
    }

    async function runScanner(options = {}) {
        if (isScanning) return;
        isScanning = true;
        updateScanButtonState(true);

        try {
            ensureRequiredLayers();
            updateZoomPill();

            const zoom = getCurrentZoom();
            const minZoom = Math.max(18, settings.zoomMinRequired || 18);
            if (zoom < minZoom) {
                updateStatusText(`⚠️ Map is at Zoom ${zoom}. GPS traces require Zoom ${minZoom}+. Click 'Zoom 18 & Scan'!`);
                if (!options.isCrawlerStep) {
                    showToast(`Zoom is ${zoom}. GPS traces only load at Zoom 18+.`, 'warning');
                }
                return;
            }

            const extent = getMapExtent();
            if (!extent) {
                updateStatusText('⚠️ Waiting for WME map bounds to initialize...');
                return;
            }

            const gpsPoints = await getGpsPointsInViewport(extent);
            const segments = getLoadedSegments();

            // Auto-prune any queued stretch in the current view that is now covered by loaded/newly-drawn roads!
            if (segments.length > 0 && currentResults.stretches.length > 0) {
                const beforeLen = currentResults.stretches.length;
                currentResults.stretches = currentResults.stretches.filter(st => {
                    if (st.centerLon < extent.minLon || st.centerLon > extent.maxLon ||
                        st.centerLat < extent.minLat || st.centerLat > extent.maxLat) {
                        return true;
                    }
                    const pts = st.points || [];
                    if (pts.length === 0) return false;
                    let coveredPts = 0;
                    for (const p of pts) {
                        if (computeMinDistanceToSegments(p.lat, p.lon, segments).isCovered) coveredPts++;
                    }
                    return (coveredPts / pts.length) < 0.65;
                });
                if (currentResults.stretches.length !== beforeLen) {
                    reindexStretches();
                    saveCompiledQueue();
                }
            }

            if (gpsPoints.length === 0) {
                if (!options.isCrawlerStep) {
                    const qLen = currentResults.stretches.length;
                    if (qLen > 0) {
                        updateStatusText(`No extra GPS traces in this view. (${qLen} stretch(es) kept in your compiled queue).`);
                        renderHighlights(currentResults.stretches);
                    } else {
                        updateStatusText(`No GPS traces visible at Zoom ${zoom} here. (None recorded or still loading).`);
                        clearHighlights();
                    }
                    renderAlertList();
                }
                return;
            }

            // Cross-check GPS points against road-type-aware drivable corridors
            const unmappedPoints = [];
            let coveredCount = 0;

            for (const pt of gpsPoints) {
                const check = computeMinDistanceToSegments(pt.lat, pt.lon, segments);
                if (check.isCovered) {
                    coveredCount++;
                } else {
                    unmappedPoints.push({
                        ...pt,
                        nearestRoadDist: check.nearestDist,
                        nearestAngleRad: check.nearestAngleRad
                    });
                }
            }

            const newStretches = clusterUnmappedPoints(unmappedPoints);
            const permAreas = settings.onlyInsideEditableArea ? getUserPermittedAreasOnly() : [];
            const activeStretches = newStretches.filter(s => {
                if (isStretchDismissed(s.centerLat, s.centerLon)) return false;
                if (permAreas.length > 0 && !isPointInsideAnyArea({ lon: s.centerLon, lat: s.centerLat }, permAreas)) {
                    return false;
                }
                return true;
            });

            if (options.isCrawlerStep) {
                currentResults.totalGpsInView += gpsPoints.length;
                currentResults.coveredGpsCount += coveredCount;
                currentResults.unmappedGpsCount += unmappedPoints.length;
                mergeStretchesIntoQueue(activeStretches, crawlerState.selectedAreaName || 'Area Crawl');
            } else {
                // Additive merge: NEVER erase previously compiled stretches outside the current viewport!
                currentResults.totalGpsInView = gpsPoints.length;
                currentResults.coveredGpsCount = coveredCount;
                currentResults.unmappedGpsCount = unmappedPoints.length;
                const addedCount = mergeStretchesIntoQueue(activeStretches, 'Viewport Scan');

                if (options.isManualScan && settings.autoCompactAfterScan && currentResults.stretches.length > 0) {
                    setUiMode('compact');
                }

                if (activeStretches.length > 0) {
                    updateStatusText(`🚨 ${activeStretches.length} in view (${addedCount} new) | 📋 ${currentResults.stretches.length} total in compiled queue.`);
                } else if (currentResults.stretches.length > 0) {
                    updateStatusText(`✅ View clear (${gpsPoints.length} pts on road) | 📋 ${currentResults.stretches.length} stretch(es) in compiled queue.`);
                } else {
                    updateStatusText(`✅ All ${gpsPoints.length} GPS trace samples in view are covered by existing roads.`);
                }
            }

            renderHighlights(currentResults.stretches);
            renderAlertList();
        } catch (err) {
            console.error(`[${SCRIPT_SHORT}] Error during scan:`, err);
            updateStatusText(`❌ Scan error: ${err.message}`);
        } finally {
            isScanning = false;
            updateScanButtonState(false);
        }
    }

    function mergeStretchesIntoQueue(newStretches, sourceArea = '') {
        let addedCount = 0;
        for (const ns of newStretches) {
            const existing = currentResults.stretches.find(ex => {
                const d = haversineDistanceMeters(ex.centerLat, ex.centerLon, ns.centerLat, ns.centerLon);
                return d < 75;
            });
            if (!existing) {
                ns.id = currentResults.stretches.length + 1;
                ns.sourceArea = sourceArea;
                currentResults.stretches.push(ns);
                if (crawlerState.status === 'running') crawlerState.totalStretchesFound++;
                addedCount++;
            } else if (ns.points && ns.points.length > (existing.points ? existing.points.length : 0)) {
                // Enrich existing stretch if fuller GPS trace view was captured
                existing.points = ns.points;
                existing.pointCount = ns.pointCount;
                existing.approxLengthMeters = Math.max(existing.approxLengthMeters || 0, ns.approxLengthMeters || 0);
            }
        }
        if (addedCount > 0) {
            saveCompiledQueue();
            if (settings.soundAlerts) playChime();
        }
        return addedCount;
    }

    function debounceScan(delayMs = 500) {
        if (scanTimeout) clearTimeout(scanTimeout);
        scanTimeout = setTimeout(() => {
            if (crawlerState.status !== 'running' && Date.now() >= suppressAutoScanUntil) {
                const z = getCurrentZoom();
                if (z >= 18) runScanner();
                else updateZoomPill();
            }
        }, delayMs);
    }

    function computePolylineLengthMeters(wgsPts) {
        if (!wgsPts || wgsPts.length < 2) return 0;
        let total = 0;
        for (let i = 0; i < wgsPts.length - 1; i++) {
            total += haversineDistanceMeters(wgsPts[i].lat, wgsPts[i].lon, wgsPts[i + 1].lat, wgsPts[i + 1].lon);
        }
        return total;
    }

    function clusterUnmappedPoints(points) {
        if (points.length === 0) return [];

        const clusters = [];
        const visited = new Set();
        const clusterDist = settings.clusterDistanceMeters;
        const baseTol = Math.max(8, settings.proximityThresholdMeters || 18);

        for (let i = 0; i < points.length; i++) {
            if (visited.has(i)) continue;

            const cluster = [points[i]];
            visited.add(i);

            for (let j = 0; j < cluster.length; j++) {
                const current = cluster[j];
                for (let k = 0; k < points.length; k++) {
                    if (visited.has(k)) continue;
                    const neighbor = points[k];
                    const d = haversineDistanceMeters(current.lat, current.lon, neighbor.lat, neighbor.lon);
                    if (d <= clusterDist) {
                        visited.add(k);
                        cluster.push(neighbor);
                    }
                }
            }

            if (cluster.length < settings.minPointsPerStretch) continue;

            // Smart False-Positive Rejection:
            // 1) Excursion check: reject clusters that merely hug the outer GPS scatter edge of an existing road
            let maxRoadDist = 0;
            let deepPointsCount = 0;
            const minExcursionPeak = Math.max(25, baseTol + 7);
            const deepThreshold = baseTol + 5;

            for (const p of cluster) {
                const d = (typeof p.nearestRoadDist === 'number') ? p.nearestRoadDist : 999;
                if (d > maxRoadDist) maxRoadDist = d;
                if (d >= deepThreshold) deepPointsCount++;
            }
            if (maxRoadDist < minExcursionPeak || deepPointsCount < 2) {
                continue;
            }

            // 2) Smoothed road span check: reject corner-overshoot blobs & parked-car drift shorter than 25m
            const cleanLine = buildMinimalNodeRoadPoints(cluster, settings.drawSimplifyToleranceMeters || 8);
            const roadLengthMeters = Math.round(computePolylineLengthMeters(cleanLine));
            if (roadLengthMeters < 25) {
                continue;
            }

            // 3) Parallel multipath / wide-boulevard shadow filter:
            // Reject short (<80m) strips running parallel (<22 deg) within 36m alongside an existing mapped road
            if (maxRoadDist < 36 && roadLengthMeters < 80 && cleanLine.length >= 2) {
                const a = cleanLine[0], b = cleanLine[cleanLine.length - 1];
                const cosLat = Math.cos(a.lat * Math.PI / 180);
                let stretchAng = Math.atan2(b.lat - a.lat, (b.lon - a.lon) * cosLat);
                if (stretchAng < 0) stretchAng += Math.PI;

                const validRoadAngles = cluster.map(p => p.nearestAngleRad).filter(v => typeof v === 'number');
                if (validRoadAngles.length > 0) {
                    let parallelMatches = 0;
                    for (const ra of validRoadAngles) {
                        let diff = Math.abs(stretchAng - ra);
                        if (diff > Math.PI / 2) diff = Math.PI - diff;
                        if (diff <= (22 * Math.PI / 180)) parallelMatches++;
                    }
                    if ((parallelMatches / validRoadAngles.length) >= 0.7) {
                        continue;
                    }
                }
            }

            // 4) Indoor "Spiderweb" GPS Drift Rejection:
            // Stationary indoor GPS drift forms a boxy/round cloud (low aspect ratio) with chaotic rainbow hues
            // pointing randomly in every direction, whereas real One-Way or Two-Way roads are linear or axially aligned!
            if (roadLengthMeters < 60 && cleanLine.length >= 2) {
                const R = 6371000;
                const lat0 = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
                const lon0 = cluster.reduce((s, p) => s + p.lon, 0) / cluster.length;
                const cosLat = Math.max(0.1, Math.cos(lat0 * Math.PI / 180));
                const mLon = (Math.PI / 180) * R * cosLat;
                const mLat = (Math.PI / 180) * R;

                let cxx = 0, cxy = 0, cyy = 0;
                for (const p of cluster) {
                    const dx = (p.lon - lon0) * mLon;
                    const dy = (p.lat - lat0) * mLat;
                    cxx += dx * dx;
                    cxy += dx * dy;
                    cyy += dy * dy;
                }
                const trace = cxx + cyy;
                const det = cxx * cyy - cxy * cxy;
                const disc = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
                const lambda1 = Math.max(1, trace / 2 + disc);
                const lambda2 = Math.max(0.5, trace / 2 - disc);
                const aspectRatio = Math.sqrt(lambda1 / lambda2);

                const hues = cluster.map(p => p.hue).filter(h => typeof h === 'number');
                if (aspectRatio < 1.8 && hues.length >= 6) {
                    // Doubled-angle axial resultant R_axial: 1.0 for pure 1-way OR pure 2-way, ~0 for random spiderweb!
                    let sumCos2 = 0, sumSin2 = 0;
                    for (const h of hues) {
                        const rad2 = (2 * h) * Math.PI / 180;
                        sumCos2 += Math.cos(rad2);
                        sumSin2 += Math.sin(rad2);
                    }
                    const axialCoherence = Math.hypot(sumCos2, sumSin2) / hues.length;
                    if (axialCoherence < 0.30) {
                        continue; // Chaotic indoor spiderweb GPS drift blob — skip!
                    }
                }
            }

            let sumLat = 0, sumLon = 0;
            for (const p of cluster) {
                sumLat += p.lat;
                sumLon += p.lon;
            }

            const centerLat = sumLat / cluster.length;
            const centerLon = sumLon / cluster.length;

            clusters.push({
                id: clusters.length + 1,
                centerLat,
                centerLon,
                pointCount: cluster.length,
                approxLengthMeters: roadLengthMeters,
                points: cluster,
                permalink: generatePermalink(centerLat, centerLon, Math.max(18, settings.crawlerZoomLevel || 18))
            });
        }

        return clusters;
    }

    function getUserPermittedAreasOnly() {
        const builtInIds = new Set(['current_viewport', 'scan_area_4km2', 'scan_area_20km2']);
        const all = cachedResolvedAreas.length > 0 ? cachedResolvedAreas : getEditorPermissions();
        return (all || []).filter(a => a && !builtInIds.has(a.id));
    }

    function isPointInsideAnyArea(pt, areaList) {
        if (!areaList || areaList.length === 0) return true;
        for (const area of areaList) {
            if (!area.bbox) continue;
            if (pt.lon < area.bbox.minLon || pt.lon > area.bbox.maxLon ||
                pt.lat < area.bbox.minLat || pt.lat > area.bbox.maxLat) {
                continue;
            }
            const polys = area.polygons || [];
            for (const poly of polys) {
                if (isPointInSinglePolygon(pt, poly)) return true;
            }
        }
        return false;
    }

    function doesTileTouchPermittedAreas(lon, lat, halfLon, halfLat, permAreas) {
        if (!permAreas || permAreas.length === 0) return true;
        for (const area of permAreas) {
            for (const poly of (area.polygons || [])) {
                if (doesTileIntersectPolygon(lon, lat, halfLon, halfLat, poly)) return true;
            }
        }
        return false;
    }

    /* ==========================================================================
       7. PERMISSION GRID CRAWLER (Zoom 18+ Guaranteed, Pause / Stop / Resume)
       ========================================================================== */
    function populateAreaPicker(showFeedback = false) {
        const select = document.getElementById('nar-crawler-area-select');
        if (!select) return;

        const previousId = select.options[select.selectedIndex]?.dataset?.areaId || crawlerState.selectedAreaId || null;

        let areas = [];
        try {
            areas = getEditorPermissions();
        } catch (err) {
            console.error(`[${SCRIPT_SHORT}] getEditorPermissions failed:`, err);
        }

        if (!areas || areas.length === 0) {
            // Never allow the dropdown to become empty/blank!
            select.innerHTML = '<option value="0" data-area-id="current_viewport">📍 Current Viewport (Waiting for map...)</option>';
            return;
        }

        select.innerHTML = '';
        let restoredIndex = 0;

        areas.forEach((area, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.dataset.areaId = area.id;
            opt.textContent = area.name;
            if (previousId && area.id === previousId) {
                restoredIndex = i;
            }
            select.appendChild(opt);
        });

        select.selectedIndex = restoredIndex;

        const builtInIds = new Set(['current_viewport', 'scan_area_4km2', 'scan_area_20km2']);
        const permissionCount = areas.filter(a => !builtInIds.has(a.id)).length;
        if (showFeedback) {
            if (permissionCount > 0) {
                showToast(`Loaded ${permissionCount} Editable / Managed Area(s) + 4 km² & 20 km² window scans!`, 'success');
            } else {
                showToast('4 km², 20 km², and Current Viewport scan areas ready!', 'info');
            }
        }
    }

    function generateTilesForArea(targetArea, stepLon, stepLat) {
        const tiles = [];
        const seenTiles = new Set();
        const halfLon = stepLon / 2;
        const halfLat = stepLat / 2;
        const MAX_TILES = 8000;

        // When scanning 4 km² / 20 km² / Viewport and Editable Area filter is ON, skip tiles outside permitted areas!
        const builtInIds = new Set(['current_viewport', 'scan_area_4km2', 'scan_area_20km2']);
        const permAreas = (settings.onlyInsideEditableArea && builtInIds.has(targetArea.id))
            ? getUserPermittedAreasOnly()
            : [];

        const polygons = (targetArea.polygons && targetArea.polygons.length > 0)
            ? targetArea.polygons
            : (targetArea.rings || []).map(r => ({ outer: r, holes: [], bbox: targetArea.bbox }));

        for (const poly of polygons) {
            const pb = poly.bbox || targetArea.bbox;
            if (!pb) continue;

            let addedForThisPoly = 0;
            for (let lat = pb.minLat + halfLat; lat <= pb.maxLat + halfLat * 0.5; lat += stepLat) {
                for (let lon = pb.minLon + halfLon; lon <= pb.maxLon + halfLon * 0.5; lon += stepLon) {
                    if (doesTileIntersectPolygon(lon, lat, halfLon, halfLat, poly)) {
                        if (permAreas.length > 0 && !doesTileTouchPermittedAreas(lon, lat, halfLon, halfLat, permAreas)) {
                            continue;
                        }
                        const key = `${Math.round(lat / stepLat)}_${Math.round(lon / stepLon)}`;
                        if (!seenTiles.has(key)) {
                            seenTiles.add(key);
                            tiles.push({ lon, lat });
                            addedForThisPoly++;
                            if (tiles.length >= MAX_TILES) break;
                        }
                    }
                }
                if (tiles.length >= MAX_TILES) break;
            }

            // Guarantee at least 1 tile for small polygons smaller than a single Zoom 18 viewport
            if (addedForThisPoly === 0 && poly.outer && poly.outer.length > 0 && tiles.length < MAX_TILES) {
                const cLon = poly.outer.reduce((s, p) => s + p.lon, 0) / poly.outer.length;
                const cLat = poly.outer.reduce((s, p) => s + p.lat, 0) / poly.outer.length;
                if (permAreas.length === 0 || isPointInsideAnyArea({ lon: cLon, lat: cLat }, permAreas)) {
                    tiles.push({ lon: cLon, lat: cLat });
                }
            }
        }

        return tiles;
    }

    async function startGridCrawler() {
        // Always refresh window-relative areas (4 km², 20 km², Current Viewport) from the LIVE WME window!
        const select = document.getElementById('nar-crawler-area-select');
        const selectedId = select?.options[select.selectedIndex]?.dataset?.areaId || null;
        const freshAreas = getEditorPermissions();
        if (!freshAreas || freshAreas.length === 0) {
            showToast('No areas available to crawl yet.', 'warning');
            return;
        }

        let activeArea = freshAreas.find(a => a.id === selectedId);
        if (!activeArea) {
            const areaIndex = Math.max(0, parseInt(select ? select.value : '0', 10) || 0);
            activeArea = freshAreas[areaIndex] || freshAreas[0];
        }

        const crawlZoom = Math.max(18, settings.crawlerZoomLevel || 18);

        // Ensure map is at Zoom 18+ FIRST so we can measure exact Zoom-18 viewport tile dimensions!
        ensureRequiredLayers();
        const startCenterLat = (activeArea.bbox.minLat + activeArea.bbox.maxLat) / 2;
        const startCenterLon = (activeArea.bbox.minLon + activeArea.bbox.maxLon) / 2;
        suppressAutoScanUntil = Date.now() + 3000;
        await goToLocationAndVerifyZoom(startCenterLat, startCenterLon, crawlZoom);

        // Compute Zoom-18+ tile step with 20% overlap so zero GPS traces are missed between tiles
        let stepLon = 0.0022;
        let stepLat = 0.0015;
        const z18Extent = getMapExtent();
        if (z18Extent && getCurrentZoom() >= 18) {
            const liveSpanLon = z18Extent.maxLon - z18Extent.minLon;
            const liveSpanLat = z18Extent.maxLat - z18Extent.minLat;
            if (liveSpanLon > 0.0004 && liveSpanLon < 0.02 && liveSpanLat > 0.0003 && liveSpanLat < 0.02) {
                stepLon = liveSpanLon * 0.8;
                stepLat = liveSpanLat * 0.8;
            }
        }

        const tiles = generateTilesForArea(activeArea, stepLon, stepLat);
        if (tiles.length === 0) {
            showToast('Selected area produced 0 tiles. Try refreshing Editable Areas.', 'warning');
            return;
        }

        if (crawlerState.timeoutId) clearTimeout(crawlerState.timeoutId);
        const runId = crawlerState.stepRunId + 1;

        crawlerState = {
            status: 'running',
            isActive: true,
            isPaused: false,
            tiles,
            currentTileIndex: 0,
            selectedAreaId: activeArea.id,
            selectedAreaName: activeArea.name,
            timeoutId: null,
            stepRunId: runId,
            totalStretchesFound: 0
        };

        // Keep existing compiled queue stretches and append newly discovered ones!
        currentResults.totalGpsInView = 0;
        currentResults.unmappedGpsCount = 0;
        currentResults.coveredGpsCount = 0;
        renderAlertList();
        updateCrawlerUI();
        showToast(`🚀 Crawling at Zoom ${crawlZoom}: ${tiles.length} tile(s) in ${activeArea.name}`, 'info');

        stepCrawler(runId);
    }

    async function stepCrawler(runId) {
        if (crawlerState.status !== 'running' || runId !== crawlerState.stepRunId) return;

        if (crawlerState.currentTileIndex >= crawlerState.tiles.length) {
            finishGridCrawler();
            return;
        }

        const idx = crawlerState.currentTileIndex;
        const total = crawlerState.tiles.length;
        const tile = crawlerState.tiles[idx];
        const crawlZoom = Math.max(18, settings.crawlerZoomLevel || 18);
        const progressPct = Math.round(((idx + 1) / total) * 100);

        updateCrawlerProgress(`Tile ${idx + 1}/${total} (${progressPct}%)`);
        updateStatusText(`🔍 Crawling Tile ${idx + 1}/${total} at Zoom ${crawlZoom}... (${currentResults.stretches.length} in queue)`);

        // Move to tile strictly at Zoom 18+ and verify WME zoom >= 18
        suppressAutoScanUntil = Date.now() + settings.crawlerStepDelayMs + 1500;
        await goToLocationAndVerifyZoom(tile.lat, tile.lon, crawlZoom);

        if (crawlerState.status !== 'running' || runId !== crawlerState.stepRunId) return;

        crawlerState.timeoutId = setTimeout(async () => {
            if (crawlerState.status !== 'running' || runId !== crawlerState.stepRunId) return;

            // Guarantee zoom is still >= 18 right before scanning
            if (getCurrentZoom() < crawlZoom) {
                await goToLocationAndVerifyZoom(tile.lat, tile.lon, crawlZoom);
            }
            if (crawlerState.status !== 'running' || runId !== crawlerState.stepRunId) return;

            await runScanner({ isCrawlerStep: true });

            if (crawlerState.status !== 'running' || runId !== crawlerState.stepRunId) return;

            crawlerState.currentTileIndex++;
            if (crawlerState.currentTileIndex >= crawlerState.tiles.length) {
                finishGridCrawler();
            } else {
                crawlerState.timeoutId = setTimeout(() => stepCrawler(runId), 250);
            }
        }, settings.crawlerStepDelayMs);
    }

    function pauseGridCrawler() {
        if (crawlerState.status !== 'running') return;
        if (crawlerState.timeoutId) {
            clearTimeout(crawlerState.timeoutId);
            crawlerState.timeoutId = null;
        }
        crawlerState.stepRunId++;
        crawlerState.status = 'paused';
        crawlerState.isActive = true;
        crawlerState.isPaused = true;

        saveCompiledQueue();
        const idx = Math.min(crawlerState.currentTileIndex + 1, crawlerState.tiles.length);
        const total = crawlerState.tiles.length;
        const pct = total > 0 ? Math.round((crawlerState.currentTileIndex / total) * 100) : 0;

        updateCrawlerUI();
        updateCrawlerProgress(`⏸️ Paused ${idx}/${total} (${pct}%)`);
        updateStatusText(`⏸️ Paused at Tile ${idx}/${total} (${currentResults.stretches.length} queued). Click '▶️ Resume' to continue.`);
        showToast(`Crawler paused at Tile ${idx}/${total}. Queue saved!`, 'info');
    }

    function stopGridCrawler() {
        if (crawlerState.status !== 'running' && crawlerState.status !== 'paused') return;
        if (crawlerState.timeoutId) {
            clearTimeout(crawlerState.timeoutId);
            crawlerState.timeoutId = null;
        }
        crawlerState.stepRunId++;
        saveCompiledQueue();

        const hasRemainingTiles = crawlerState.tiles.length > 0 && crawlerState.currentTileIndex < crawlerState.tiles.length;
        if (hasRemainingTiles) {
            crawlerState.status = 'stopped';
            crawlerState.isActive = false;
            crawlerState.isPaused = false;

            const idx = crawlerState.currentTileIndex + 1;
            const total = crawlerState.tiles.length;
            const pct = Math.round((crawlerState.currentTileIndex / total) * 100);

            updateCrawlerUI();
            updateCrawlerProgress(`⏹️ Stopped ${idx}/${total} (${pct}%)`);
            updateStatusText(`⏹️ Stopped at Tile ${idx}/${total} (${currentResults.stretches.length} saved in queue). Click '▶️ Resume' anytime!`);
            showToast(`Crawler stopped (${currentResults.stretches.length} saved in queue). Click '▶️ Resume' anytime!`, 'info');
            if (settings.autoCompactAfterScan && currentResults.stretches.length > 0) {
                setUiMode('compact');
            }
        } else {
            finishGridCrawler();
        }
    }

    function resumeGridCrawler() {
        if ((crawlerState.status !== 'paused' && crawlerState.status !== 'stopped') ||
            crawlerState.currentTileIndex >= crawlerState.tiles.length) {
            startGridCrawler();
            return;
        }

        if (crawlerState.timeoutId) {
            clearTimeout(crawlerState.timeoutId);
            crawlerState.timeoutId = null;
        }

        const runId = ++crawlerState.stepRunId;
        crawlerState.status = 'running';
        crawlerState.isActive = true;
        crawlerState.isPaused = false;

        const idx = crawlerState.currentTileIndex + 1;
        const total = crawlerState.tiles.length;

        updateCrawlerUI();
        showToast(`▶️ Resuming crawl at Tile ${idx}/${total} (Zoom ${Math.max(18, settings.crawlerZoomLevel)})...`, 'info');
        stepCrawler(runId);
    }

    function finishGridCrawler() {
        if (crawlerState.timeoutId) {
            clearTimeout(crawlerState.timeoutId);
            crawlerState.timeoutId = null;
        }
        crawlerState.stepRunId++;
        crawlerState.status = 'idle';
        crawlerState.isActive = false;
        crawlerState.isPaused = false;

        saveCompiledQueue();
        updateCrawlerUI();
        updateCrawlerProgress(`✅ Done (${crawlerState.tiles.length}/${crawlerState.tiles.length})`);
        showToast(`🎉 Crawl complete! ${currentResults.stretches.length} stretch(es) saved in queue.`, 'success');
        updateStatusText(`🎉 Crawl complete! ${currentResults.stretches.length} stretch(es) compiled & saved for editing.`);

        if (settings.autoCompactAfterScan && currentResults.stretches.length > 0) {
            activeStretchIndex = 0;
            setUiMode('compact');
            renderAlertList();
        }
    }

    /* ==========================================================================
       8. SMART ROAD CREATION ENGINE
          (Rank-Safe Junction Snap + Auto City/State & 'None' Street + Lock Match +
           GPS Color-Azimuth One-Way Detection + Auto-Select + Road Type Reminder)
       ========================================================================== */
    function getEditorLockRank() {
        try {
            if (wmeSDK && (wmeSDK.State || wmeSDK.Users)) {
                const mod = wmeSDK.State || wmeSDK.Users;
                const info = typeof mod.getUserInfo === 'function' ? mod.getUserInfo() : mod.userInfo;
                if (info && typeof info.rank === 'number') return info.rank; // 0-based (0 = L1, 4 = L5)
            }
        } catch (e) {}
        try {
            const u = win.W && win.W.loginManager && win.W.loginManager.user;
            const r = u && (u.rank ?? (u.attributes && u.attributes.rank));
            if (typeof r === 'number') return r;
        } catch (e) {}
        return 0;
    }

    function isInsideParkingLotOrGasVenue(lon, lat) {
        try {
            let rawVenues = [];
            if (wmeSDK && wmeSDK.DataModel && wmeSDK.DataModel.Venues && typeof wmeSDK.DataModel.Venues.getAll === 'function') {
                const v = wmeSDK.DataModel.Venues.getAll();
                if (Array.isArray(v)) rawVenues = v;
            }
            if (rawVenues.length === 0 && win.W && win.W.model && win.W.model.venues) {
                if (typeof win.W.model.venues.getObjectArray === 'function') rawVenues = win.W.model.venues.getObjectArray();
                else if (win.W.model.venues.objects) rawVenues = Object.values(win.W.model.venues.objects);
            }
            for (const venue of rawVenues) {
                if (!venue) continue;
                const cats = venue.categories || (venue.attributes && venue.attributes.categories) || [];
                const catStr = Array.isArray(cats) ? cats.join(',') : String(cats);
                if (!/(PARKING_LOT|GAS_STATION)/i.test(catStr)) continue;
                const polys = extractPolygonsFromAnyGeometry(venue.geometry || (venue.attributes && venue.attributes.geometry));
                for (const poly of polys) {
                    if (isPointInSinglePolygon({ lon, lat }, poly)) {
                        return /PARKING_LOT/i.test(catStr) ? 'Parking Lot' : 'Gas Station';
                    }
                }
            }
        } catch (e) {}
        return null;
    }

    // Detects high-confidence One-Way flow from Waze's azimuth-colored GPS arrows; safely defaults to TWO_WAY
    function detectRoadDirectionFromGpsHues(points, startPt, endPt) {
        const hues = (points || []).map(p => p.hue).filter(h => typeof h === 'number');
        if (hues.length < 8) return { direction: 'TWO_WAY', label: 'Two-Way' };

        let cosSum = 0, sinSum = 0;
        for (const h of hues) {
            const rad = h * Math.PI / 180;
            cosSum += Math.cos(rad);
            sinSum += Math.sin(rad);
        }
        const meanR = Math.hypot(cosSum, sinSum) / hues.length;
        if (meanR < 0.78) return { direction: 'TWO_WAY', label: 'Two-Way' };

        let domHue = Math.atan2(sinSum / hues.length, cosSum / hues.length) * 180 / Math.PI;
        if (domHue < 0) domHue += 360;

        // Verify opposing 180° flow is genuinely absent (< 10% opposing samples)
        let alignedCount = 0;
        let opposingCount = 0;
        for (const h of hues) {
            let diff = Math.abs(h - domHue);
            if (diff > 180) diff = 360 - diff;
            if (diff <= 55) alignedCount++;
            else if (diff >= 125) opposingCount++;
        }
        if ((alignedCount / hues.length) < 0.85 || (opposingCount / hues.length) >= 0.10) {
            return { direction: 'TWO_WAY', label: 'Two-Way' };
        }

        // Compute segment compass bearing A -> B (0° = North, 90° = East, 180° = South, 270° = West)
        const dLon = (endPt.lon - startPt.lon) * Math.cos(((startPt.lat + endPt.lat) / 2) * Math.PI / 180);
        const dLat = endPt.lat - startPt.lat;
        let bearingAB = Math.atan2(dLon, dLat) * 180 / Math.PI; // atan2(East, North)
        if (bearingAB < 0) bearingAB += 360;

        // Waze Color-by-Azimuth maps North ~ 0° (Red), East ~ 90° (Yellow-Green), South ~ 180° (Cyan), West ~ 270° (Blue-Purple)
        let diffAB = Math.abs(domHue - bearingAB);
        if (diffAB > 180) diffAB = 360 - diffAB;
        const diffBA = 180 - diffAB;

        if (diffAB <= 68) {
            return { direction: 'A_TO_B', label: 'One-Way (A➔B)' };
        }
        if (diffBA <= 68) {
            return { direction: 'B_TO_A', label: 'One-Way (B➔A)' };
        }
        return { direction: 'TWO_WAY', label: 'Two-Way' };
    }

    // Finds closest point on nearby drivable road within 34m to snap/extend an endpoint
    function findEndpointSnapCandidate(endPt, neighborPt, segments, editorRank) {
        const MAX_SNAP_METERS = 34;
        const NODE_SNAP_METERS = 12;
        const R = 6371000;
        const cosLat = Math.max(0.1, Math.cos(endPt.lat * Math.PI / 180));
        const mLon = (Math.PI / 180) * R * cosLat;
        const mLat = (Math.PI / 180) * R;

        let best = null;

        for (const seg of segments) {
            const pts = seg.wgsPoints;
            if (!pts || pts.length < 2) continue;

            // Check existing start/end nodes first (cleanest junction snap — no segment split needed!)
            const endpoints = [
                { pt: pts[0], nodeId: seg.fromNodeId },
                { pt: pts[pts.length - 1], nodeId: seg.toNodeId }
            ];
            for (const ep of endpoints) {
                const dNode = haversineDistanceMeters(endPt.lat, endPt.lon, ep.pt.lat, ep.pt.lon);
                if (dNode <= MAX_SNAP_METERS && (!best || dNode < best.dist - 3 || (dNode <= NODE_SNAP_METERS && best.kind !== 'node'))) {
                    const canConnect = (seg.roadType !== 3 && seg.lockRank <= editorRank);
                    best = {
                        kind: canConnect ? 'node' : 'short_locked',
                        dist: dNode,
                        seg,
                        nodeId: ep.nodeId,
                        snapLon: ep.pt.lon,
                        snapLat: ep.pt.lat
                    };
                }
            }

            // Check perpendicular projection onto each segment leg
            const px = (endPt.lon - pts[0].lon) * mLon;
            const py = (endPt.lat - pts[0].lat) * mLat;

            for (let i = 0; i < pts.length - 1; i++) {
                const ax = (pts[i].lon - pts[0].lon) * mLon;
                const ay = (pts[i].lat - pts[0].lat) * mLat;
                const bx = (pts[i + 1].lon - pts[0].lon) * mLon;
                const by = (pts[i + 1].lat - pts[0].lat) * mLat;

                const dx = bx - ax, dy = by - ay;
                const lenSq = dx * dx + dy * dy;
                if (lenSq === 0) continue;
                const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
                const projX = ax + t * dx;
                const projY = ay + t * dy;
                const dist = Math.hypot(px - projX, py - projY);

                if (dist <= MAX_SNAP_METERS && (!best || dist < best.dist - 2)) {
                    const projLon = pts[0].lon + projX / mLon;
                    const projLat = pts[0].lat + projY / mLat;

                    // If projection is within 12m of seg's own start/end vertex, snap directly to that vertex node!
                    const dStart = haversineDistanceMeters(projLat, projLon, pts[0].lat, pts[0].lon);
                    const dEnd = haversineDistanceMeters(projLat, projLon, pts[pts.length - 1].lat, pts[pts.length - 1].lon);
                    const canConnect = (seg.roadType !== 3 && seg.lockRank <= editorRank);

                    if (dStart <= NODE_SNAP_METERS) {
                        best = {
                            kind: canConnect ? 'node' : 'short_locked',
                            dist,
                            seg,
                            nodeId: seg.fromNodeId,
                            snapLon: pts[0].lon,
                            snapLat: pts[0].lat
                        };
                    } else if (dEnd <= NODE_SNAP_METERS) {
                        best = {
                            kind: canConnect ? 'node' : 'short_locked',
                            dist,
                            seg,
                            nodeId: seg.toNodeId,
                            snapLon: pts[pts.length - 1].lon,
                            snapLat: pts[pts.length - 1].lat
                        };
                    } else {
                        best = {
                            kind: canConnect ? 'split' : 'short_locked',
                            dist,
                            seg,
                            nodeId: null,
                            snapLon: projLon,
                            snapLat: projLat
                        };
                    }
                }
            }
        }

        if (!best) return null;

        // If target road is locked above editor rank or is a Freeway, stop 4.0m short of the road!
        if (best.kind === 'short_locked') {
            const totalD = haversineDistanceMeters(neighborPt.lat, neighborPt.lon, best.snapLat, best.snapLon);
            if (totalD > 6) {
                const ratio = (totalD - 4.0) / totalD;
                best.stopLon = neighborPt.lon + (best.snapLon - neighborPt.lon) * ratio;
                best.stopLat = neighborPt.lat + (best.snapLat - neighborPt.lat) * ratio;
            } else {
                best.stopLon = endPt.lon;
                best.stopLat = endPt.lat;
            }
        }

        return best;
    }

    async function splitTargetSegmentAtPoint(segId, lon, lat) {
        // 1. Official WME SDK splitSegment
        if (wmeSDK && wmeSDK.DataModel && wmeSDK.DataModel.Segments && typeof wmeSDK.DataModel.Segments.splitSegment === 'function') {
            try {
                await Promise.resolve(wmeSDK.DataModel.Segments.splitSegment({
                    segmentId: segId,
                    lonLat: { lon, lat },
                    point: { x: lon, y: lat, lon, lat }
                }));
                return true;
            } catch (e) {
                try {
                    await Promise.resolve(wmeSDK.DataModel.Segments.splitSegment({
                        segmentId: segId,
                        point: { type: 'Point', coordinates: [lon, lat] }
                    }));
                    return true;
                } catch (e2) {}
            }
        }

        // 2. Legacy WME SplitSegments action
        if (win.W && win.W.model && win.W.model.segments && win.OpenLayers) {
            try {
                const SplitAction = win.require ? win.require('Waze/Action/SplitSegments') : (win.W.Action && win.W.Action.SplitSegments);
                const segModel = win.W.model.segments.getObjectById(segId);
                const am = (win.W.model && win.W.model.actionManager) || (win.W.controller && win.W.controller.actionManager);
                if (SplitAction && segModel && am) {
                    const m = latLonToMercator(lat, lon);
                    const ptGeom = new win.OpenLayers.Geometry.Point(m.x, m.y);
                    am.add(new SplitAction(segModel, { splitAtPoint: ptGeom }));
                    return true;
                }
            } catch (e) {}
        }
        return false;
    }

    function connectLegacySegmentToNearbyNode(newSegModel, snapLon, snapLat) {
        if (!newSegModel || !win.W || !win.W.model || !win.W.model.nodes) return false;
        try {
            const ConnectSegment = win.require ? win.require('Waze/Action/ConnectSegment') : (win.W.Action && win.W.Action.ConnectSegment);
            const ModifyAllConnections = win.require ? win.require('Waze/Action/ModifyAllConnections') : null;
            const am = (win.W.model && win.W.model.actionManager) || (win.W.controller && win.W.controller.actionManager);
            if (!ConnectSegment || !am) return false;

            const nodes = typeof win.W.model.nodes.getObjectArray === 'function'
                ? win.W.model.nodes.getObjectArray()
                : Object.values(win.W.model.nodes.objects || {});

            let nearestNode = null;
            let bestD = 8.0; // Within 8 meters of snap coordinate
            for (const n of nodes) {
                if (!n || !n.geometry) continue;
                const wgs = toWgsPoint(n.geometry.x, n.geometry.y);
                if (!wgs) continue;
                const d = haversineDistanceMeters(snapLat, snapLon, wgs.lat, wgs.lon);
                if (d < bestD) {
                    bestD = d;
                    nearestNode = n;
                }
            }
            if (nearestNode) {
                am.add(new ConnectSegment(nearestNode, newSegModel));
                if (ModifyAllConnections) {
                    try { am.add(new ModifyAllConnections(nearestNode, true)); } catch (e) {}
                }
                return true;
            }
        } catch (e) {}
        return false;
    }

    async function enableSdkTurnsForSegment(newSegId) {
        if (!newSegId || !wmeSDK || !wmeSDK.DataModel || !wmeSDK.DataModel.Turns) return;
        try {
            const Turns = wmeSDK.DataModel.Turns;
            if (typeof Turns.getTurnsFromSegment === 'function' && typeof Turns.updateTurn === 'function') {
                const fromTurns = await Promise.resolve(Turns.getTurnsFromSegment({ segmentId: newSegId })) || [];
                const toTurns = typeof Turns.getTurnsToSegment === 'function'
                    ? (await Promise.resolve(Turns.getTurnsToSegment({ segmentId: newSegId })) || [])
                    : [];
                for (const t of [...fromTurns, ...toTurns]) {
                    if (t && t.isAllowed === false) {
                        try {
                            await Promise.resolve(Turns.updateTurn({
                                turnId: t.id,
                                fromSegmentId: t.fromSegmentId,
                                toSegmentId: t.toSegmentId,
                                isAllowed: true
                            }));
                        } catch (e) {}
                    }
                }
            }
        } catch (e) {}
    }

    async function applyAddressLockAndDirection(newSegId, newSegModel, refSeg, targetLockRank, directionCode) {
        // 1. Update Lock Rank & Direction via WME SDK
        if (newSegId && wmeSDK && wmeSDK.DataModel && wmeSDK.DataModel.Segments && typeof wmeSDK.DataModel.Segments.updateSegment === 'function') {
            try {
                const upd = { segmentId: newSegId };
                if (typeof targetLockRank === 'number' && targetLockRank >= 0) upd.lockRank = targetLockRank;
                if (directionCode) upd.direction = directionCode; // 'TWO_WAY' | 'A_TO_B' | 'B_TO_A'
                await Promise.resolve(wmeSDK.DataModel.Segments.updateSegment(upd));
            } catch (e) {
                // Try lockRank and direction individually if combined call differs by SDK build
                try {
                    if (typeof targetLockRank === 'number' && targetLockRank > 0) {
                        await Promise.resolve(wmeSDK.DataModel.Segments.updateSegment({ segmentId: newSegId, lockRank: targetLockRank }));
                    }
                } catch (e2) {}
                try {
                    if (directionCode && directionCode !== 'TWO_WAY') {
                        await Promise.resolve(wmeSDK.DataModel.Segments.updateSegment({ segmentId: newSegId, direction: directionCode }));
                    }
                } catch (e3) {}
            }
        }

        // Legacy WME fallback for Lock Rank & Direction
        if (win.W && win.W.model) {
            try {
                const segObj = newSegModel || (newSegId && win.W.model.segments && win.W.model.segments.getObjectById(newSegId));
                const UpdateObject = win.require ? win.require('Waze/Action/UpdateObject') : (win.W.Action && win.W.Action.UpdateObject);
                const am = (win.W.model && win.W.model.actionManager) || (win.W.controller && win.W.controller.actionManager);
                if (segObj && UpdateObject && am) {
                    const changes = {};
                    if (typeof targetLockRank === 'number' && targetLockRank >= 0) changes.lockRank = targetLockRank;
                    if (directionCode === 'A_TO_B') { changes.fwdDirection = true; changes.revDirection = false; }
                    else if (directionCode === 'B_TO_A') { changes.fwdDirection = false; changes.revDirection = true; }
                    else { changes.fwdDirection = true; changes.revDirection = true; }
                    am.add(new UpdateObject(segObj, changes));
                }
            } catch (e) {}
        }

        // 2. Auto-inherit City & State from neighbor road AND set Street Name to 'None' (empty street)
        if (!refSeg || !refSeg.primaryStreetId) return false;
        let addressSet = false;

        // SDK Street / City lookup
        if (newSegId && wmeSDK && wmeSDK.DataModel && wmeSDK.DataModel.Streets) {
            try {
                const Streets = wmeSDK.DataModel.Streets;
                const parentStreet = typeof Streets.getById === 'function'
                    ? await Promise.resolve(Streets.getById({ streetId: refSeg.primaryStreetId }))
                    : null;
                const cityId = parentStreet && (parentStreet.cityId ?? parentStreet.cityID);

                if (cityId !== undefined && cityId !== null) {
                    let emptyStreet = null;
                    if (typeof Streets.getStreet === 'function') {
                        try { emptyStreet = await Promise.resolve(Streets.getStreet({ cityId, streetName: '' })); } catch (e) {}
                    }
                    if (!emptyStreet && typeof Streets.getAll === 'function') {
                        const allSt = await Promise.resolve(Streets.getAll()) || [];
                        emptyStreet = allSt.find(s => s && (s.cityId === cityId) && (s.isEmpty || !s.name || s.name === ''));
                    }
                    if (!emptyStreet && typeof Streets.addStreet === 'function') {
                        try { emptyStreet = await Promise.resolve(Streets.addStreet({ streetName: '', cityId })); } catch (e) {}
                    }
                    if (emptyStreet && emptyStreet.id && typeof wmeSDK.DataModel.Segments.updateAddress === 'function') {
                        await Promise.resolve(wmeSDK.DataModel.Segments.updateAddress({
                            segmentId: newSegId,
                            primaryStreetId: emptyStreet.id
                        }));
                        addressSet = true;
                    } else if (typeof wmeSDK.DataModel.Segments.updateAddress === 'function') {
                        const Cities = wmeSDK.DataModel.Cities;
                        const cityObj = (Cities && typeof Cities.getById === 'function')
                            ? await Promise.resolve(Cities.getById({ cityId }))
                            : null;
                        await Promise.resolve(wmeSDK.DataModel.Segments.updateAddress({
                            segmentId: newSegId,
                            addressData: {
                                streetName: '',
                                emptyStreet: true,
                                cityName: cityObj ? (cityObj.name || '') : ''
                            }
                        }));
                        addressSet = true;
                    }
                }
            } catch (e) {}
        }

        // Legacy W.model UpdateFeatureAddress fallback (rock-solid across WME versions!)
        if (!addressSet && win.W && win.W.model && win.W.model.streets && win.W.model.cities) {
            try {
                const segObj = newSegModel || (newSegId && win.W.model.segments && win.W.model.segments.getObjectById(newSegId));
                const parentStreet = win.W.model.streets.getObjectById(refSeg.primaryStreetId);
                const cityID = parentStreet && (parentStreet.attributes ? parentStreet.attributes.cityID : parentStreet.cityID);
                const cityObj = (cityID !== undefined && cityID !== null) ? win.W.model.cities.getObjectById(cityID) : null;
                const UpdateFeatureAddress = win.require ? win.require('Waze/Action/UpdateFeatureAddress') : (win.W.Action && win.W.Action.UpdateFeatureAddress);
                const am = (win.W.model && win.W.model.actionManager) || (win.W.controller && win.W.controller.actionManager);

                if (segObj && cityObj && UpdateFeatureAddress && am) {
                    const cAttrs = cityObj.attributes || cityObj;
                    am.add(new UpdateFeatureAddress(segObj, {
                        countryID: cAttrs.countryID,
                        stateID: cAttrs.stateID,
                        cityName: cAttrs.isEmpty ? '' : (cAttrs.name || ''),
                        emptyCity: Boolean(cAttrs.isEmpty),
                        streetName: '',
                        emptyStreet: true
                    }));
                    addressSet = true;
                }
            } catch (e) {}
        }

        return addressSet;
    }

    function selectSegmentInWme(newSegId, newSegModel) {
        if (newSegId && wmeSDK && wmeSDK.Editing && typeof wmeSDK.Editing.setSelection === 'function') {
            try {
                wmeSDK.Editing.setSelection({
                    selection: { ids: [newSegId], objectType: 'segment' }
                });
                return;
            } catch (e) {}
        }
        if (win.W && win.W.selectionManager && typeof win.W.selectionManager.setSelectedModels === 'function') {
            try {
                const segObj = newSegModel || (newSegId && win.W.model?.segments?.getObjectById?.(newSegId));
                if (segObj) win.W.selectionManager.setSelectedModels([segObj]);
            } catch (e) {}
        }
    }

    async function drawDraftRoad(stretchId) {
        const stretchIdx = currentResults.stretches.findIndex(s => s.id === stretchId);
        const stretch = stretchIdx >= 0 ? currentResults.stretches[stretchIdx] : null;
        if (!stretch || !stretch.points || stretch.points.length < 2) {
            showToast('Need at least 2 GPS points to draw a road.', 'warning');
            return;
        }

        activeStretchIndex = stretchIdx;
        suppressAutoScanUntil = Date.now() + 3500;
        await goToLocationAndVerifyZoom(stretch.centerLat, stretch.centerLon, 18);
        await new Promise(res => setTimeout(res, 250)); // Let WME hydrate nearby segments at Zoom 18

        const cleanRoadNodes = buildMinimalNodeRoadPoints(stretch.points, settings.drawSimplifyToleranceMeters || 8);
        if (cleanRoadNodes.length < 2) return;

        const segments = getLoadedSegments();
        const editorRank = getEditorLockRank();

        // 1. Rank-Safe Endpoint Extension & Junction Snapping
        const startSnap = findEndpointSnapCandidate(cleanRoadNodes[0], cleanRoadNodes[1], segments, editorRank);
        const endSnap = findEndpointSnapCandidate(
            cleanRoadNodes[cleanRoadNodes.length - 1],
            cleanRoadNodes[cleanRoadNodes.length - 2],
            segments,
            editorRank
        );

        let snappedCount = 0;
        let stoppedShortCount = 0;
        const connectedParentSegs = [];

        if (startSnap) {
            if (startSnap.kind === 'split') {
                await splitTargetSegmentAtPoint(startSnap.seg.id, startSnap.snapLon, startSnap.snapLat);
                cleanRoadNodes[0] = { lon: startSnap.snapLon, lat: startSnap.snapLat };
                connectedParentSegs.push(startSnap.seg);
                snappedCount++;
            } else if (startSnap.kind === 'node') {
                cleanRoadNodes[0] = { lon: startSnap.snapLon, lat: startSnap.snapLat };
                connectedParentSegs.push(startSnap.seg);
                snappedCount++;
            } else if (startSnap.kind === 'short_locked') {
                cleanRoadNodes[0] = { lon: startSnap.stopLon, lat: startSnap.stopLat };
                stoppedShortCount++;
            }
        }

        if (endSnap && (!startSnap || endSnap.seg.id !== startSnap.seg.id || haversineDistanceMeters(cleanRoadNodes[0].lat, cleanRoadNodes[0].lon, endSnap.snapLat, endSnap.snapLon) > 12)) {
            const lastI = cleanRoadNodes.length - 1;
            if (endSnap.kind === 'split') {
                await splitTargetSegmentAtPoint(endSnap.seg.id, endSnap.snapLon, endSnap.snapLat);
                cleanRoadNodes[lastI] = { lon: endSnap.snapLon, lat: endSnap.snapLat };
                connectedParentSegs.push(endSnap.seg);
                snappedCount++;
            } else if (endSnap.kind === 'node') {
                cleanRoadNodes[lastI] = { lon: endSnap.snapLon, lat: endSnap.snapLat };
                connectedParentSegs.push(endSnap.seg);
                snappedCount++;
            } else if (endSnap.kind === 'short_locked') {
                cleanRoadNodes[lastI] = { lon: endSnap.stopLon, lat: endSnap.stopLat };
                stoppedShortCount++;
            }
        }

        // Determine reference neighbor segment (for City/State & Lock Rank)
        let refSeg = connectedParentSegs[0] || (startSnap && startSnap.seg) || (endSnap && endSnap.seg) || null;
        if (!refSeg && segments.length > 0) {
            let bestD = Infinity;
            for (const s of segments) {
                const d = haversineDistanceMeters(stretch.centerLat, stretch.centerLon, s.wgsPoints[0].lat, s.wgsPoints[0].lon);
                if (d < bestD) { bestD = d; refSeg = s; }
            }
        }

        // Match connected road's lock rank, capped at editor's own rank
        let targetLockRank = 0;
        if (connectedParentSegs.length > 0) {
            const minParentLock = Math.min(...connectedParentSegs.map(s => s.lockRank || 0));
            targetLockRank = Math.min(editorRank, Math.max(0, minParentLock));
        } else if (refSeg) {
            targetLockRank = Math.min(editorRank, Math.max(0, refSeg.lockRank || 0));
        }

        // Detect One-Way vs Two-Way from GPS arrow colors
        const dirInfo = detectRoadDirectionFromGpsHues(stretch.points, cleanRoadNodes[0], cleanRoadNodes[cleanRoadNodes.length - 1]);

        let createdViaSdk = false;
        let newSegId = null;
        let newSegModel = null;

        // 2. Create standard Street (roadType: 1) via WME SDK
        if (wmeSDK && wmeSDK.DataModel && wmeSDK.DataModel.Segments && typeof wmeSDK.DataModel.Segments.addSegment === 'function') {
            try {
                const geoJsonCoords = cleanRoadNodes.map(p => [p.lon, p.lat]);
                const res = await Promise.resolve(wmeSDK.DataModel.Segments.addSegment({
                    geometry: {
                        type: 'LineString',
                        coordinates: geoJsonCoords
                    },
                    roadType: 1
                }));
                newSegId = (typeof res === 'number' || typeof res === 'string') ? res : (res && res.id) || null;
                createdViaSdk = true;
            } catch (e) {}
        }

        // 3. Fallback: Legacy W.Action.AddSegment
        if (!createdViaSdk && win.W && win.W.model && win.OpenLayers) {
            try {
                const AddSegmentAction = win.require ? win.require('Waze/Action/AddSegment') : (win.W.Action && win.W.Action.AddSegment);
                const SegmentFeature = win.require ? win.require('Waze/Feature/Vector/Segment') : (win.W.Feature && win.W.Feature.Vector && win.W.Feature.Vector.Segment);
                const am = (win.W.model && win.W.model.actionManager) || (win.W.controller && win.W.controller.actionManager);

                if (AddSegmentAction && SegmentFeature && am) {
                    const olComponents = cleanRoadNodes.map(p => {
                        const m = latLonToMercator(p.lat, p.lon);
                        return new win.OpenLayers.Geometry.Point(m.x, m.y);
                    });
                    const lineGeom = new win.OpenLayers.Geometry.LineString(olComponents);
                    newSegModel = new SegmentFeature(lineGeom, { roadType: 1, lockRank: targetLockRank });
                    am.add(new AddSegmentAction(newSegModel));
                    newSegId = newSegModel.attributes ? newSegModel.attributes.id : newSegModel.id;
                    createdViaSdk = true;
                }
            } catch (e) {}
        }

        if (!createdViaSdk) {
            showToast("Centered at Zoom 18. Press 'I' or click Road tool to trace the highlighted centerline!", 'info');
            const roadToolBtn = document.querySelector('#toolbar .toolbar-button-road, .wz-header-item-road');
            if (roadToolBtn) roadToolBtn.click();
            return;
        }

        // 4. Ensure junction node connections & enable turns
        if (snappedCount > 0) {
            const segObj = newSegModel || (newSegId && win.W?.model?.segments?.getObjectById?.(newSegId));
            if (segObj) {
                if (startSnap && (startSnap.kind === 'node' || startSnap.kind === 'split')) {
                    connectLegacySegmentToNearbyNode(segObj, startSnap.snapLon, startSnap.snapLat);
                }
                if (endSnap && (endSnap.kind === 'node' || endSnap.kind === 'split')) {
                    connectLegacySegmentToNearbyNode(segObj, endSnap.snapLon, endSnap.snapLat);
                }
            }
            if (newSegId) {
                await enableSdkTurnsForSegment(newSegId);
            }
        }

        // 5. Apply City/State + Street Name='None', Lock Rank (L1..Ln), & One-Way/Two-Way direction
        await applyAddressLockAndDirection(newSegId, newSegModel, refSeg, targetLockRank, dirInfo.direction);

        // 6. Select the newly drawn road so WME's left attribute panel opens immediately!
        selectSegmentInWme(newSegId, newSegModel);

        // 7. Track stretch for auto-Done on WME Save & display Road Type / Direction reminder!
        lastDrawnStretchId = stretch.id;
        const venueCtx = isInsideParkingLotOrGasVenue(stretch.centerLon, stretch.centerLat);
        const venueHint = venueCtx ? ` (🅿️ inside ${venueCtx} — check if Parking Lot/Private Road!)` : ' (Street vs PLR / Private / Dirt)';
        const snapSummary = stoppedShortCount > 0
            ? `Stopped 4m short of locked/Freeway road`
            : (snappedCount > 0 ? `Snapped ${snappedCount} junction(s)` : 'Placed segment');

        lastDrawReminderMsg = `⚠️ CHECK ROAD TYPE${venueHint} • ${dirInfo.label} • L${targetLockRank + 1} Lock • Street='None' (${snapSummary}). Save in WME to auto-advance!`;
        updateStatusText(lastDrawReminderMsg);
        showToast(`🛣️ Road drawn (${dirInfo.label}, L${targetLockRank + 1})! ⚠️ Check Road Type${venueCtx ? ' (' + venueCtx + ')' : ''} & Turns before saving!`, 'warning');

        renderAlertList();
    }

    function rdpSimplifyMeters(pts, epsilon) {
        if (pts.length <= 2) return pts;
        const first = pts[0];
        const last = pts[pts.length - 1];
        let maxDist = -1;
        let splitIdx = -1;

        for (let i = 1; i < pts.length - 1; i++) {
            const d = distanceToLineSegmentMeters(pts[i].x, pts[i].y, first.x, first.y, last.x, last.y);
            if (d > maxDist) {
                maxDist = d;
                splitIdx = i;
            }
        }

        if (maxDist > epsilon && splitIdx !== -1) {
            const left = rdpSimplifyMeters(pts.slice(0, splitIdx + 1), epsilon);
            const right = rdpSimplifyMeters(pts.slice(splitIdx), epsilon);
            return left.slice(0, -1).concat(right);
        }
        return [first, last];
    }

    // Converts noisy/jumping GPS trace clouds into a clean, straight WME centerline with minimum geometry nodes
    function buildMinimalNodeRoadPoints(points, toleranceMeters = 8) {
        if (!points || points.length === 0) return [];
        if (points.length === 1) return [{ lon: points[0].lon, lat: points[0].lat }];

        const R = 6371000;
        let lat0 = 0, lon0 = 0;
        for (const p of points) {
            lat0 += p.lat;
            lon0 += p.lon;
        }
        lat0 /= points.length;
        lon0 /= points.length;
        const cosLat = Math.max(0.1, Math.cos(lat0 * Math.PI / 180));
        const mPerDegLon = (Math.PI / 180) * R * cosLat;
        const mPerDegLat = (Math.PI / 180) * R;

        function toXY(p) {
            return { x: (p.lon - lon0) * mPerDegLon, y: (p.lat - lat0) * mPerDegLat };
        }
        function toLonLat(xy) {
            return { lon: lon0 + xy.x / mPerDegLon, lat: lat0 + xy.y / mPerDegLat };
        }

        const xyPts = points.map(toXY);

        // Compute 2D PCA principal axis (orthogonal least-squares best-fit line direction)
        let cxx = 0, cxy = 0, cyy = 0;
        for (const p of xyPts) {
            cxx += p.x * p.x;
            cxy += p.x * p.y;
            cyy += p.y * p.y;
        }
        const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
        const ux = Math.cos(theta);
        const uy = Math.sin(theta);

        let sMin = Infinity, sMax = -Infinity, maxCrossAbs = 0;
        const projected = xyPts.map(p => {
            const s = p.x * ux + p.y * uy;
            const d = -p.x * uy + p.y * ux;
            if (s < sMin) sMin = s;
            if (s > sMax) sMax = s;
            if (Math.abs(d) > maxCrossAbs) maxCrossAbs = Math.abs(d);
            return { ...p, s, d };
        });

        const totalSpan = sMax - sMin;
        if (totalSpan < 4) {
            return [points[0], points[points.length - 1]];
        }

        const tol = Math.max(3, toleranceMeters);

        // FAST PATH 1: If all GPS scatter stays within cross-track band (<= max(9m, tol * 1.25)),
        // the road is STRAIGHT! Return a pure 2-point orthogonal-regression segment (0 intermediate nodes!).
        if (maxCrossAbs <= Math.max(9, tol * 1.25)) {
            return [
                toLonLat({ x: sMin * ux, y: sMin * uy }),
                toLonLat({ x: sMax * ux, y: sMax * uy })
            ];
        }

        // PATH 2: Curved or bent road — smooth out GPS jumps first, then RDP-simplify with minimal nodes!
        let spine = [];
        if (maxCrossAbs <= 22) {
            // Gently curving road: bin along principal axis every ~16m to cancel lane offset & GPS scatter
            const binCount = Math.max(2, Math.min(20, Math.round(totalSpan / 16)));
            const binWidth = totalSpan / binCount;
            for (let b = 0; b < binCount; b++) {
                const lo = sMin + b * binWidth;
                const hi = (b === binCount - 1) ? (sMax + 0.01) : (lo + binWidth);
                const inBin = projected.filter(p => p.s >= lo && p.s <= hi);
                if (inBin.length > 0) {
                    const mx = inBin.reduce((acc, p) => acc + p.x, 0) / inBin.length;
                    const my = inBin.reduce((acc, p) => acc + p.y, 0) / inBin.length;
                    spine.push({ x: mx, y: my });
                }
            }
        } else {
            // L-turn / S-bend / loop: cluster raw jitter into 15m spatial medoids, chain from extremity, & smooth
            const cellRadius = 15;
            const remaining = [...xyPts];
            const centroids = [];
            while (remaining.length > 0) {
                const seed = remaining.shift();
                const group = [seed];
                for (let i = remaining.length - 1; i >= 0; i--) {
                    const dx = remaining[i].x - seed.x;
                    const dy = remaining[i].y - seed.y;
                    if (Math.sqrt(dx * dx + dy * dy) <= cellRadius) {
                        group.push(remaining.splice(i, 1)[0]);
                    }
                }
                centroids.push({
                    x: group.reduce((a, p) => a + p.x, 0) / group.length,
                    y: group.reduce((a, p) => a + p.y, 0) / group.length
                });
            }

            // Find the two furthest centroids to start chain at a true road end
            let startIdx = 0, bestD = -1;
            for (let i = 0; i < centroids.length; i++) {
                for (let j = i + 1; j < centroids.length; j++) {
                    const d = Math.hypot(centroids[i].x - centroids[j].x, centroids[i].y - centroids[j].y);
                    if (d > bestD) { bestD = d; startIdx = i; }
                }
            }
            const ordered = [centroids[startIdx]];
            const pool = centroids.filter((_, idx) => idx !== startIdx);
            while (pool.length > 0) {
                const cur = ordered[ordered.length - 1];
                let nearestI = 0, nearestDist = Infinity;
                for (let i = 0; i < pool.length; i++) {
                    const d = Math.hypot(pool[i].x - cur.x, pool[i].y - cur.y);
                    if (d < nearestDist) { nearestDist = d; nearestI = i; }
                }
                // Stop chaining if jump is implausibly huge compared to cluster radius
                if (nearestDist > Math.max(85, settings.clusterDistanceMeters * 1.5)) break;
                ordered.push(pool.splice(nearestI, 1)[0]);
            }
            spine = ordered;
        }

        if (spine.length <= 2) {
            return spine.length === 2
                ? [toLonLat(spine[0]), toLonLat(spine[1])]
                : [toLonLat({ x: sMin * ux, y: sMin * uy }), toLonLat({ x: sMax * ux, y: sMax * uy })];
        }

        // Laplacian smoothing pass on interior spine vertices to iron out residual GPS jumps
        if (spine.length >= 3) {
            const smoothed = [spine[0]];
            for (let i = 1; i < spine.length - 1; i++) {
                smoothed.push({
                    x: 0.25 * spine[i - 1].x + 0.5 * spine[i].x + 0.25 * spine[i + 1].x,
                    y: 0.25 * spine[i - 1].y + 0.5 * spine[i].y + 0.25 * spine[i + 1].y
                });
            }
            smoothed.push(spine[spine.length - 1]);
            spine = smoothed;
        }

        // Ramer-Douglas-Peucker simplification for minimum geometric nodes
        let simplified = rdpSimplifyMeters(spine, tol);

        // Prune near-collinear bends (< 12 degrees) and micro-legs (< 16m)
        if (simplified.length > 2) {
            const pruned = [simplified[0]];
            for (let i = 1; i < simplified.length - 1; i++) {
                const prev = pruned[pruned.length - 1];
                const curr = simplified[i];
                const next = simplified[i + 1];
                const v1x = curr.x - prev.x, v1y = curr.y - prev.y;
                const v2x = next.x - curr.x, v2y = next.y - curr.y;
                const len1 = Math.hypot(v1x, v1y);
                const len2 = Math.hypot(v2x, v2y);
                if (len1 < 16 || len2 < 16) continue;
                const cosAngle = (v1x * v2x + v1y * v2y) / (len1 * len2);
                const angleDeg = Math.acos(Math.max(-1, Math.min(1, cosAngle))) * (180 / Math.PI);
                if (angleDeg >= 12) {
                    pruned.push(curr);
                }
            }
            pruned.push(simplified[simplified.length - 1]);
            simplified = pruned;
        }

        return simplified.map(toLonLat);
    }

    /* ==========================================================================
       9. PERMALINK & ACCURATE ZOOM 18+ NAVIGATION
       ========================================================================== */
    function getWmeEnvironment() {
        if (win.W && win.W.app && typeof win.W.app.getAppRegionCode === 'function') {
            const reg = win.W.app.getAppRegionCode();
            if (reg) return reg;
        }
        const m = win.location.search.match(/env=([a-zA-Z0-9_-]+)/);
        if (m) return m[1];
        if (win.location.pathname.includes('/il-editor')) return 'il';
        if (win.location.pathname.includes('/usa-editor')) return 'usa';
        return 'row';
    }

    function generatePermalink(lat, lon, zoom = 18) {
        const z = Math.max(18, zoom);
        const env = getWmeEnvironment();
        const base = `${win.location.origin}${win.location.pathname}`;
        return `${base}?env=${env}&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&zoomLevel=${z}`;
    }

    async function goToLocation(lat, lon, zoom = 18) {
        const targetZoom = Math.max(12, Math.min(22, Math.round(zoom)));
        const hasCoords = (typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon));
        let handledBySdk = false;

        // 1. Official WME SDK: setMapCenter + setZoomLevel (exact WME zoom scale 12..22!)
        if (wmeSDK && wmeSDK.Map) {
            try {
                if (hasCoords && typeof wmeSDK.Map.setMapCenter === 'function') {
                    await Promise.resolve(wmeSDK.Map.setMapCenter({
                        lonLat: { lon, lat },
                        zoomLevel: targetZoom
                    }));
                    handledBySdk = true;
                } else if (hasCoords && typeof wmeSDK.Map.setCenter === 'function') {
                    await Promise.resolve(wmeSDK.Map.setCenter({
                        lonLat: { lon, lat },
                        zoomLevel: targetZoom,
                        zoom: targetZoom
                    }));
                    handledBySdk = true;
                }

                // Explicitly set zoomLevel via setZoomLevel as well in case setMapCenter ignored zoomLevel
                if (typeof wmeSDK.Map.setZoomLevel === 'function' && getCurrentZoom() !== targetZoom) {
                    await Promise.resolve(wmeSDK.Map.setZoomLevel({ zoomLevel: targetZoom }));
                    handledBySdk = true;
                }
            } catch (e) {
                try {
                    if (typeof wmeSDK.Map.setZoomLevel === 'function') {
                        await Promise.resolve(wmeSDK.Map.setZoomLevel(targetZoom));
                        handledBySdk = true;
                    }
                } catch (e2) {}
            }
        }

        if (handledBySdk && getCurrentZoom() === targetZoom) {
            updateZoomPill();
            return;
        }

        // 2. Fallback: OpenLayers / W.map with live OL-to-WME zoom offset calibration!
        // (Fixes the bug where raw olView.setZoom(18) landed on WME Zoom 16!)
        if (win.W && win.W.map) {
            try {
                const beforeWmeZoom = getCurrentZoom();
                const olMap = win.W.map.olMap || win.W.map;

                if (olMap && typeof olMap.getView === 'function') {
                    const view = olMap.getView();
                    if (view) {
                        const rawOlZoom = typeof view.getZoom === 'function' ? view.getZoom() : beforeWmeZoom;
                        const olOffset = (typeof rawOlZoom === 'number' && Number.isFinite(rawOlZoom) && Number.isFinite(beforeWmeZoom))
                            ? (rawOlZoom - beforeWmeZoom)
                            : 0;

                        if (hasCoords && typeof view.setCenter === 'function') {
                            const m = latLonToMercator(lat, lon);
                            view.setCenter([m.x, m.y]);
                        }
                        if (typeof view.setZoom === 'function') {
                            view.setZoom(targetZoom + olOffset);
                        }
                        updateZoomPill();
                        return;
                    }
                }

                if (typeof win.OpenLayers !== 'undefined') {
                    const rawMapZoom = typeof win.W.map.getZoom === 'function' ? win.W.map.getZoom() : targetZoom;
                    const ol2Zoom = (typeof rawMapZoom === 'number' && rawMapZoom <= 10) ? (targetZoom - 12) : targetZoom;
                    const proj = win.W.map.getProjectionObject ? win.W.map.getProjectionObject() : 'EPSG:900913';
                    if (hasCoords) {
                        const olLonLat = new win.OpenLayers.LonLat(lon, lat).transform(new win.OpenLayers.Projection('EPSG:4326'), proj);
                        win.W.map.setCenter(olLonLat, ol2Zoom);
                    } else if (typeof win.W.map.zoomTo === 'function') {
                        win.W.map.zoomTo(ol2Zoom);
                    }
                } else if (typeof win.W.map.setCenter === 'function' && hasCoords) {
                    win.W.map.setCenter({ lon, lat }, targetZoom);
                }
            } catch (e) {
                console.warn(`[${SCRIPT_SHORT}] Center/zoom fallback error:`, e);
            }
        }
        updateZoomPill();
    }

    async function goToLocationAndVerifyZoom(lat, lon, minTargetZoom = 18) {
        const desiredZoom = Math.max(18, minTargetZoom);
        await goToLocation(lat, lon, desiredZoom);

        // Wait briefly for map view update, then verify WME zoom actually reached >= 18
        await new Promise(res => setTimeout(res, 180));
        const actualZoom = getCurrentZoom();
        if (actualZoom < desiredZoom) {
            const diff = desiredZoom - actualZoom;
            // Apply corrective delta if underlying view had an uncalibrated zoom offset
            if (wmeSDK && wmeSDK.Map && typeof wmeSDK.Map.setZoomLevel === 'function') {
                try { await Promise.resolve(wmeSDK.Map.setZoomLevel({ zoomLevel: desiredZoom })); } catch (e) {}
            }
            if (getCurrentZoom() < desiredZoom && win.W?.map?.olMap?.getView) {
                try {
                    const v = win.W.map.olMap.getView();
                    v.setZoom((v.getZoom() || desiredZoom) + diff);
                } catch (e) {}
            }
            await new Promise(res => setTimeout(res, 150));
        }
        updateZoomPill();
    }

    async function zoomTo18AndScan() {
        const targetZoom = Math.max(18, getCurrentZoom(), settings.zoomMinRequired || 18);
        suppressAutoScanUntil = Date.now() + 2500;
        const extent = getMapExtent();
        if (extent) {
            const cLat = (extent.minLat + extent.maxLat) / 2;
            const cLon = (extent.minLon + extent.maxLon) / 2;
            await goToLocationAndVerifyZoom(cLat, cLon, targetZoom);
        } else {
            await goToLocationAndVerifyZoom(null, null, targetZoom);
        }

        ensureRequiredLayers();
        updateStatusText(`Zoomed to level ${getCurrentZoom()}... waiting for GPS traces to load...`);
        setTimeout(() => {
            updateZoomPill();
            runScanner({ isManualScan: true });
        }, 1400);
    }

    function copyToClipboard(text) {
        if (typeof GM_setClipboard === 'function') {
            GM_setClipboard(text);
            return true;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text);
            return true;
        }
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
    }

    function copyAllPermalinks() {
        if (currentResults.stretches.length === 0) {
            showToast('No missing road stretches in queue to copy.', 'warning');
            return;
        }

        let output = `=== WME Need a Road! Compiled Queue (${currentResults.stretches.length} Stretches) ===\n\n`;
        currentResults.stretches.forEach((s) => {
            output += `Stretch #${s.id} (~${s.approxLengthMeters}m, ${s.pointCount} pts):\n${s.permalink}\n\n`;
        });

        copyToClipboard(output);
        showToast(`Copied ${currentResults.stretches.length} Zoom 18 permalinks to clipboard!`, 'success');
    }

    function exportQueueToCsv() {
        if (currentResults.stretches.length === 0) {
            showToast('Queue is empty — nothing to export.', 'warning');
            return;
        }

        const rows = ['Stretch_ID,Approx_Length_m,GPS_Points,Latitude,Longitude,Source_Area,Permalink'];
        currentResults.stretches.forEach((s) => {
            const safeArea = String(s.sourceArea || '').replace(/"/g, '""');
            rows.push(`${s.id},${s.approxLengthMeters},${s.pointCount},${s.centerLat.toFixed(6)},${s.centerLon.toFixed(6)},"${safeArea}","${s.permalink}"`);
        });

        const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const dateTag = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `wme-need-a-road-queue-${dateTag}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        showToast(`💾 Exported ${currentResults.stretches.length} stretch(es) to CSV!`, 'success');
    }

    function clearCompiledQueue() {
        if (currentResults.stretches.length === 0) {
            showToast('Compiled queue is already empty.', 'info');
            return;
        }
        currentResults.stretches = [];
        activeStretchIndex = 0;
        saveCompiledQueue();
        clearHighlights();
        renderAlertList();
        updateStatusText('🗑️ Compiled queue cleared. Ready for a new scan.');
        showToast('Compiled queue cleared.', 'info');
    }

    function resolveStretchById(stretchId, markDismissed = false) {
        const idx = currentResults.stretches.findIndex(s => s.id === stretchId);
        if (idx === -1) return;
        const stretch = currentResults.stretches[idx];

        if (markDismissed) {
            const key = `${stretch.centerLat.toFixed(4)}_${stretch.centerLon.toFixed(4)}`;
            dismissedStretches.add(key);
            saveDismissed();
            const resetBtn = document.getElementById('nar-btn-reset-dismissed');
            if (resetBtn) resetBtn.textContent = `🔄 Reset Dismissed (${dismissedStretches.size})`;
        }

        currentResults.stretches.splice(idx, 1);
        reindexStretches();
        saveCompiledQueue();
        renderAlertList();
        renderHighlights(currentResults.stretches, currentResults.stretches.flatMap(s => s.points));

        if (markDismissed) {
            showToast(`✖️ Stretch dismissed (${currentResults.stretches.length} left in queue).`, 'info');
        } else {
            showToast(`✅ Marked done! (${currentResults.stretches.length} left in queue).`, 'success');
        }
    }

    async function jumpToStretchByIndex(idx) {
        if (currentResults.stretches.length === 0) return;
        activeStretchIndex = ((idx % currentResults.stretches.length) + currentResults.stretches.length) % currentResults.stretches.length;
        const stretch = currentResults.stretches[activeStretchIndex];
        saveCompiledQueue();
        renderAlertList();
        suppressAutoScanUntil = Date.now() + 2600;
        if (crawlerState.status === 'running') pauseGridCrawler();
        await goToLocationAndVerifyZoom(stretch.centerLat, stretch.centerLon, 18);
        renderHighlights(currentResults.stretches, currentResults.stretches.flatMap(s => s.points));
    }

    /* ==========================================================================
       10. PIXEL <-> COORDINATE PROJECTION & VISUAL MAP OVERLAY
       ========================================================================== */
    let overlaySvg = null;

    function getOrCreateOverlaySvg() {
        if (overlaySvg && document.body.contains(overlaySvg)) return overlaySvg;

        const mapContainer = getMapViewportElement();

        overlaySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        overlaySvg.id = 'wme-need-a-road-overlay';
        overlaySvg.setAttribute('style', 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:9999;');

        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.innerHTML = `
            <filter id="roadGlow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                </feMerge>
            </filter>
        `;
        overlaySvg.appendChild(defs);

        if (mapContainer) {
            const pos = win.getComputedStyle(mapContainer).position;
            if (pos === 'static') {
                mapContainer.style.position = 'relative';
            }
            mapContainer.appendChild(overlaySvg);
        }

        return overlaySvg;
    }

    function clearHighlights() {
        if (overlaySvg) {
            const defs = overlaySvg.querySelector('defs');
            overlaySvg.innerHTML = '';
            if (defs) overlaySvg.appendChild(defs);
        }
    }

    function coordsToPixel(lon, lat) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

        // 1. Official WME SDK
        if (wmeSDK && wmeSDK.Map && typeof wmeSDK.Map.getMapPixelFromLonLat === 'function') {
            try {
                const px = wmeSDK.Map.getMapPixelFromLonLat({ lonLat: { lon, lat } });
                if (px && typeof px.x === 'number' && Number.isFinite(px.x) && Number.isFinite(px.y)) {
                    return { x: px.x, y: px.y };
                }
            } catch (e) {}
        }

        // 2. OpenLayers 6+ olMap.getPixelFromCoordinate
        if (win.W && win.W.map && win.W.map.olMap && typeof win.W.map.olMap.getPixelFromCoordinate === 'function') {
            try {
                const m = latLonToMercator(lat, lon);
                const pxArr = win.W.map.olMap.getPixelFromCoordinate([m.x, m.y]);
                if (Array.isArray(pxArr) && Number.isFinite(pxArr[0]) && Number.isFinite(pxArr[1])) {
                    return { x: pxArr[0], y: pxArr[1] };
                }
            } catch (e) {}
        }

        // 3. OpenLayers 2 getViewPortPxFromLonLat
        if (win.W && win.W.map && typeof win.OpenLayers !== 'undefined' && typeof win.W.map.getViewPortPxFromLonLat === 'function') {
            try {
                const proj = win.W.map.getProjectionObject ? win.W.map.getProjectionObject() : 'EPSG:900913';
                const olLonLat = new win.OpenLayers.LonLat(lon, lat).transform(new win.OpenLayers.Projection('EPSG:4326'), proj);
                const px = win.W.map.getViewPortPxFromLonLat(olLonLat);
                if (px && Number.isFinite(px.x) && Number.isFinite(px.y)) return { x: px.x, y: px.y };
            } catch (e) {}
        }

        // 4. Web Mercator linear viewport interpolation
        const extent = getMapExtent();
        const mapDiv = getMapViewportElement();
        const width = mapDiv ? mapDiv.clientWidth : win.innerWidth;
        const height = mapDiv ? mapDiv.clientHeight : win.innerHeight;

        if (extent && extent.right > extent.left && extent.top > extent.bottom && width > 0 && height > 0) {
            const m = latLonToMercator(lat, lon);
            const px = ((m.x - extent.left) / (extent.right - extent.left)) * width;
            const py = ((extent.top - m.y) / (extent.top - extent.bottom)) * height;
            if (Number.isFinite(px) && Number.isFinite(py)) return { x: px, y: py };
        }

        return null;
    }

    function pixelToLonLat(px, py, cachedExtent = null, width = 0, height = 0) {
        // 1. Official WME SDK
        if (wmeSDK && wmeSDK.Map && typeof wmeSDK.Map.getLonLatFromMapPixel === 'function') {
            try {
                const ll = wmeSDK.Map.getLonLatFromMapPixel({ pixel: { x: px, y: py } });
                if (ll && typeof ll.lon === 'number' && Number.isFinite(ll.lon) && Number.isFinite(ll.lat)) {
                    return { lon: ll.lon, lat: ll.lat };
                }
            } catch (e) {}
        }

        // 2. OpenLayers 6+ getCoordinateFromPixel
        if (win.W && win.W.map && win.W.map.olMap && typeof win.W.map.olMap.getCoordinateFromPixel === 'function') {
            try {
                const coord = win.W.map.olMap.getCoordinateFromPixel([px, py]);
                if (Array.isArray(coord) && Number.isFinite(coord[0]) && Number.isFinite(coord[1])) {
                    return toWgsPoint(coord[0], coord[1]);
                }
            } catch (e) {}
        }

        // 3. Web Mercator viewport interpolation
        const extent = cachedExtent || getMapExtent();
        if (!extent) return null;
        const mapDiv = getMapViewportElement();
        const w = width || (mapDiv ? mapDiv.clientWidth : win.innerWidth);
        const h = height || (mapDiv ? mapDiv.clientHeight : win.innerHeight);
        if (w <= 0 || h <= 0) return null;

        const mx = extent.left + (px / w) * (extent.right - extent.left);
        const my = extent.top - (py / h) * (extent.top - extent.bottom);
        return mercatorToLatLon(mx, my);
    }

    function renderHighlights(stretches) {
        const svg = getOrCreateOverlaySvg();
        clearHighlights();

        if (!stretches || stretches.length === 0) return;

        const mapDiv = getMapViewportElement();
        const w = mapDiv ? mapDiv.clientWidth : win.innerWidth;
        const h = mapDiv ? mapDiv.clientHeight : win.innerHeight;

        // Optional debug dots ONLY if explicitly enabled in Settings (OFF by default so map stays clean!)
        if (settings.showRawGpsDots) {
            const rawPts = stretches.flatMap(s => s.points || []);
            for (const pt of rawPts) {
                const pixel = coordsToPixel(pt.lon, pt.lat);
                if (!pixel || pixel.x < -20 || pixel.y < -20 || pixel.x > w + 20 || pixel.y > h + 20) continue;
                const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                dot.setAttribute('cx', pixel.x.toFixed(1));
                dot.setAttribute('cy', pixel.y.toFixed(1));
                dot.setAttribute('r', '2.5');
                dot.setAttribute('fill', settings.highlightColor);
                dot.setAttribute('opacity', '0.5');
                svg.appendChild(dot);
            }
        }

        // Render clean, smoothed road-centerline highlights + endpoint anchor rings
        stretches.forEach((stretch, idx) => {
            const cleanLine = buildMinimalNodeRoadPoints(stretch.points, settings.drawSimplifyToleranceMeters || 8);
            const screenPts = cleanLine.map(p => coordsToPixel(p.lon, p.lat)).filter(Boolean);

            const centerPixel = coordsToPixel(stretch.centerLon, stretch.centerLat);
            const anchorPixel = screenPts.length >= 2
                ? {
                    x: (screenPts[Math.floor((screenPts.length - 1) / 2)].x + screenPts[Math.ceil((screenPts.length - 1) / 2)].x) / 2,
                    y: (screenPts[Math.floor((screenPts.length - 1) / 2)].y + screenPts[Math.ceil((screenPts.length - 1) / 2)].y) / 2
                }
                : centerPixel;

            if (!anchorPixel || anchorPixel.x < -200 || anchorPixel.y < -200 || anchorPixel.x > w + 200 || anchorPixel.y > h + 200) {
                return;
            }

            const isFocused = (idx === activeStretchIndex);

            if (screenPts.length >= 2) {
                let pathData = '';
                for (let i = 0; i < screenPts.length; i++) {
                    pathData += (i === 0 ? `M ${screenPts[i].x.toFixed(1)} ${screenPts[i].y.toFixed(1)}` : ` L ${screenPts[i].x.toFixed(1)} ${screenPts[i].y.toFixed(1)}`);
                }

                // Soft outer road-corridor halo
                const halo = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                halo.setAttribute('d', pathData);
                halo.setAttribute('stroke', isFocused ? '#38bdf8' : settings.highlightColor);
                halo.setAttribute('stroke-width', isFocused ? '11' : '9');
                halo.setAttribute('stroke-linecap', 'round');
                halo.setAttribute('stroke-linejoin', 'round');
                halo.setAttribute('fill', 'none');
                halo.setAttribute('opacity', isFocused ? '0.38' : '0.28');
                svg.appendChild(halo);

                // Smooth solid centerline (no jagged dashes)
                const centerStroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                centerStroke.setAttribute('d', pathData);
                centerStroke.setAttribute('stroke', settings.highlightGlow);
                centerStroke.setAttribute('stroke-width', '3.5');
                centerStroke.setAttribute('stroke-linecap', 'round');
                centerStroke.setAttribute('stroke-linejoin', 'round');
                centerStroke.setAttribute('fill', 'none');
                centerStroke.setAttribute('opacity', '0.95');
                svg.appendChild(centerStroke);

                // Clean start & end node rings only (shows exact minimal geometry vertices!)
                for (let i = 0; i < screenPts.length; i++) {
                    const isEnd = (i === 0 || i === screenPts.length - 1);
                    const nodeRing = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    nodeRing.setAttribute('cx', screenPts[i].x.toFixed(1));
                    nodeRing.setAttribute('cy', screenPts[i].y.toFixed(1));
                    nodeRing.setAttribute('r', isEnd ? '4.2' : '3.2');
                    nodeRing.setAttribute('fill', '#ffffff');
                    nodeRing.setAttribute('stroke', isFocused ? '#0284c7' : settings.highlightColor);
                    nodeRing.setAttribute('stroke-width', '2');
                    svg.appendChild(nodeRing);
                }
            }

            // Compact clickable badge
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('transform', `translate(${anchorPixel.x.toFixed(1)}, ${(anchorPixel.y - 16).toFixed(1)})`);
            g.setAttribute('style', 'pointer-events: auto; cursor: pointer;');
            g.onclick = () => {
                const sIdx = currentResults.stretches.findIndex(item => item.id === stretch.id);
                if (sIdx >= 0) jumpToStretchByIndex(sIdx);
                focusAlertCard(stretch.id);
            };

            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', '-38');
            rect.setAttribute('y', '-12');
            rect.setAttribute('width', '76');
            rect.setAttribute('height', '22');
            rect.setAttribute('rx', '11');
            rect.setAttribute('fill', '#0f172a');
            rect.setAttribute('stroke', isFocused ? '#38bdf8' : settings.highlightColor);
            rect.setAttribute('stroke-width', '1.8');

            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', '0');
            text.setAttribute('y', '3');
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('fill', '#ffffff');
            text.setAttribute('font-size', '10.5px');
            text.setAttribute('font-weight', 'bold');
            text.setAttribute('font-family', 'sans-serif');
            text.textContent = `🛣️ #${stretch.id}`;

            g.appendChild(rect);
            g.appendChild(text);
            svg.appendChild(g);
        });
    }

    /* ==========================================================================
       11. DRAGGABLE WAZE-BLUE UI, COMPACT FIXER MINI-WINDOW & COMPILED QUEUE
       ========================================================================== */
    function applySavedPanelPosition(panel) {
        if (!panel) return;
        const docEl = (panel.ownerDocument || document).documentElement;
        const vw = (docEl && docEl.clientWidth) || win.innerWidth || 1280;
        const vh = (docEl && docEl.clientHeight) || win.innerHeight || 800;
        const pw = panel.offsetWidth || (settings.uiMode === 'compact' ? 318 : 392);

        if (Number.isFinite(settings.panelLeft) && Number.isFinite(settings.panelTop)) {
            const clampedLeft = Math.max(6, Math.min(vw - Math.min(pw, 280) - 6, settings.panelLeft));
            const clampedTop = Math.max(6, Math.min(vh - 48, settings.panelTop));
            panel.style.setProperty('left', `${Math.round(clampedLeft)}px`, 'important');
            panel.style.setProperty('top', `${Math.round(clampedTop)}px`, 'important');
            panel.style.setProperty('right', 'auto', 'important');
            panel.style.setProperty('bottom', 'auto', 'important');
        } else {
            panel.style.setProperty('top', '80px', 'important');
            panel.style.setProperty('right', '18px', 'important');
            panel.style.setProperty('left', 'auto', 'important');
            panel.style.setProperty('bottom', 'auto', 'important');
        }
    }

    // Bulletproof cross-realm dragging: binds capture-phase mouse + pointer + touch directly on
    // BOTH ownerDocument AND page document (fixes Tampermonkey synthetic window proxy eating moves!)
    function makePanelDraggable(panel, header) {
        let dragging = false;
        let hasMoved = false;
        let startX = 0, startY = 0;
        let origLeft = 0, origTop = 0;

        const ownerDoc = panel.ownerDocument || document;
        const pageDoc = (win && win.document && win.document !== ownerDoc) ? win.document : null;

        function isNonDragControl(target) {
            if (!target || !target.closest) return false;
            // Allow dragging even if grabbing the Zoom pill; only block <button>, <select>, <input>
            return Boolean(target.closest('button, select, input, textarea, a'));
        }

        function onMove(clientX, clientY, rawEvent) {
            if (!dragging) return;
            if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;

            const dx = clientX - startX;
            const dy = clientY - startY;
            if (!hasMoved && Math.hypot(dx, dy) > 4) {
                hasMoved = true;
            }
            if (!hasMoved) return;

            if (rawEvent && rawEvent.cancelable) rawEvent.preventDefault();

            const docEl = ownerDoc.documentElement;
            const vw = (docEl && docEl.clientWidth) || win.innerWidth || 1280;
            const vh = (docEl && docEl.clientHeight) || win.innerHeight || 800;
            const pw = panel.offsetWidth || 318;
            const newLeft = Math.max(4, Math.min(vw - pw - 4, origLeft + dx));
            const newTop = Math.max(4, Math.min(vh - 46, origTop + dy));

            panel.style.setProperty('left', `${Math.round(newLeft)}px`, 'important');
            panel.style.setProperty('top', `${Math.round(newTop)}px`, 'important');
            panel.style.setProperty('right', 'auto', 'important');
            panel.style.setProperty('bottom', 'auto', 'important');
        }

        function onMouseOrPointerMove(e) {
            onMove(e.clientX, e.clientY, e);
        }

        function onTouchMove(e) {
            if (e.touches && e.touches.length > 0) {
                onMove(e.touches[0].clientX, e.touches[0].clientY, e);
            }
        }

        function removeAllMoveListeners() {
            const targets = [ownerDoc, pageDoc, window, (win !== window ? win : null)].filter(Boolean);
            for (const t of targets) {
                try {
                    t.removeEventListener('mousemove', onMouseOrPointerMove, true);
                    t.removeEventListener('pointermove', onMouseOrPointerMove, true);
                    t.removeEventListener('mouseup', onEnd, true);
                    t.removeEventListener('pointerup', onEnd, true);
                    t.removeEventListener('touchmove', onTouchMove, true);
                    t.removeEventListener('touchend', onEnd, true);
                } catch (e) {}
            }
        }

        function onEnd() {
            if (!dragging) return;
            dragging = false;
            header.style.setProperty('cursor', 'grab', 'important');
            removeAllMoveListeners();

            if (hasMoved) {
                const rect = panel.getBoundingClientRect();
                settings.panelLeft = Math.round(rect.left);
                settings.panelTop = Math.round(rect.top);
                saveSettings();
                panel._justDraggedAt = Date.now();
            }
        }

        function startDrag(clientX, clientY, e) {
            if (dragging) return;
            if (isNonDragControl(e.target)) return;

            if (e.cancelable) e.preventDefault();
            e.stopPropagation();

            const rect = panel.getBoundingClientRect();
            dragging = true;
            hasMoved = false;
            startX = clientX;
            startY = clientY;
            origLeft = rect.left;
            origTop = rect.top;

            panel.style.setProperty('left', `${Math.round(origLeft)}px`, 'important');
            panel.style.setProperty('top', `${Math.round(origTop)}px`, 'important');
            panel.style.setProperty('right', 'auto', 'important');
            panel.style.setProperty('bottom', 'auto', 'important');
            header.style.setProperty('cursor', 'grabbing', 'important');

            const targets = [ownerDoc, pageDoc, window].filter(Boolean);
            for (const t of targets) {
                try {
                    t.addEventListener('mousemove', onMouseOrPointerMove, true);
                    t.addEventListener('pointermove', onMouseOrPointerMove, true);
                    t.addEventListener('mouseup', onEnd, true);
                    t.addEventListener('pointerup', onEnd, true);
                    t.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
                    t.addEventListener('touchend', onEnd, true);
                } catch (err) {}
            }
        }

        // Bind on header AND compact body background in capture phase so WME never steals the drag
        const dragZones = [header, panel.querySelector('#wme-need-a-road-compact')].filter(Boolean);
        for (const zone of dragZones) {
            zone.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                startDrag(e.clientX, e.clientY, e);
            }, true);

            zone.addEventListener('pointerdown', (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                startDrag(e.clientX, e.clientY, e);
            }, true);

            zone.addEventListener('touchstart', (e) => {
                if (e.touches && e.touches.length === 1) {
                    startDrag(e.touches[0].clientX, e.touches[0].clientY, e);
                }
            }, { capture: true, passive: false });
        }

        ownerDoc.defaultView?.addEventListener('resize', () => applySavedPanelPosition(panel));
    }

    function setUiMode(mode) {
        const panel = document.getElementById('wme-need-a-road-panel');
        const fullBody = document.getElementById('wme-need-a-road-body');
        const compactBody = document.getElementById('wme-need-a-road-compact');
        const modeBtn = document.getElementById('nar-mode-btn');
        const toggleIcon = document.getElementById('nar-toggle-btn');

        settings.uiMode = (mode === 'compact') ? 'compact' : 'full';
        settings.panelCollapsed = false;
        saveSettings();

        if (!panel) return;

        if (settings.uiMode === 'compact') {
            panel.classList.add('nar-compact-mode');
            if (fullBody) fullBody.style.display = 'none';
            if (compactBody) compactBody.style.display = 'block';
            if (modeBtn) {
                modeBtn.textContent = '⤢';
                modeBtn.title = 'Expand to Full Panel & Queue List';
            }
        } else {
            panel.classList.remove('nar-compact-mode');
            if (compactBody) compactBody.style.display = 'none';
            if (fullBody) fullBody.style.display = 'block';
            if (modeBtn) {
                modeBtn.textContent = '⤡';
                modeBtn.title = 'Shrink to Compact Fixer Bar';
            }
        }
        if (toggleIcon) toggleIcon.textContent = '▼';
        applySavedPanelPosition(panel);
        renderCompactFixer();
    }

    function injectUI() {
        if (document.getElementById('wme-need-a-road-panel')) return;

        const style = document.createElement('style');
        style.textContent = `
            #wme-need-a-road-panel {
                position: fixed !important;
                top: 80px;
                right: 18px;
                width: 392px;
                margin: 0 !important;
                transform: none !important;
                pointer-events: auto !important;
                background: #1b2230;
                color: #f8fafc;
                border-radius: 13px;
                box-shadow: 0 12px 30px rgba(0, 0, 0, 0.52);
                font-family: "Rubik", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                z-index: 999999 !important;
                font-size: 13.5px;
                overflow: hidden;
                border: 2px solid #33ccff;
            }
            #wme-need-a-road-panel.nar-compact-mode {
                width: 320px;
            }
            /* Iconic Waze Logo Cyan-Blue (#33CCFF) Header with Waze Charcoal Ink (#181d24) */
            #wme-need-a-road-header {
                background: linear-gradient(135deg, #33ccff 0%, #15b2f7 100%) !important;
                border-bottom: 2px solid #0b8fd8;
                padding: 10px 12px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 6px;
                cursor: grab !important;
                user-select: none !important;
                -webkit-user-select: none !important;
                touch-action: none !important;
            }
            #wme-need-a-road-header h4 {
                margin: 0;
                font-size: 15px;
                font-weight: 800;
                letter-spacing: -0.2px;
                display: flex;
                align-items: center;
                gap: 6px;
                color: #141923;
                white-space: nowrap;
                pointer-events: none;
            }
            .nar-drag-grip {
                font-size: 16px;
                color: #141923;
                opacity: 0.78;
                margin-right: 1px;
            }
            .nar-hdr-btn {
                background: #141923;
                color: #ffffff;
                border: 1px solid rgba(255,255,255,0.22);
                border-radius: 7px;
                padding: 3px 8px;
                font-size: 13.5px;
                line-height: 18px;
                cursor: pointer;
                font-weight: 800;
            }
            .nar-hdr-btn:hover { background: #263042; }
            .nar-badge {
                background: #ff2d55;
                color: #ffffff;
                border: 1.5px solid #141923;
                border-radius: 12px;
                padding: 2px 8px;
                font-size: 12.5px;
                font-weight: 800;
                pointer-events: none;
            }
            /* Larger, high-visibility Zoom Pill */
            .nar-zoom-pill {
                background: #141923;
                color: #4ade80;
                border: 1.5px solid #141923;
                border-radius: 12px;
                padding: 3px 9px;
                font-size: 13px;
                font-weight: 800;
                cursor: pointer;
                white-space: nowrap;
                box-shadow: 0 2px 5px rgba(0,0,0,0.25);
            }
            .nar-zoom-pill.nar-zoom-warning {
                background: #141923;
                color: #fbbf24;
                border-color: #f59e0b;
            }
            #wme-need-a-road-body {
                padding: 12px;
                max-height: 560px;
                overflow-y: auto;
            }
            #wme-need-a-road-compact {
                padding: 10px 11px;
                background: #151c28;
                cursor: grab;
            }
            .nar-compact-nav {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 6px;
                margin-bottom: 8px;
            }
            .nar-compact-info {
                flex: 1;
                text-align: center;
                font-size: 13px;
                font-weight: 700;
                color: #f8fafc;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .nar-compact-sub {
                font-size: 11.5px;
                color: #cbd5e1;
                font-weight: 500;
                margin-top: 2px;
                white-space: normal;
                line-height: 1.3;
            }
            .nar-settings-top-bar {
                background: #111827;
                border: 1px solid #334155;
                border-radius: 8px;
                padding: 7px 10px;
                margin-bottom: 10px;
            }
            .nar-settings-toggle {
                font-size: 12.5px;
                font-weight: 700;
                color: #33ccff;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: space-between;
                user-select: none;
            }
            .nar-settings-drawer {
                display: none;
                border-top: 1px solid #1e293b;
                padding-top: 8px;
                margin-top: 8px;
                font-size: 12.5px;
            }
            .nar-setting-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 7px;
                gap: 8px;
            }
            .nar-setting-row input[type="number"] {
                width: 70px;
                background: #1e293b;
                border: 1px solid #475569;
                color: #fff;
                border-radius: 5px;
                padding: 3px 6px;
                font-size: 12.5px;
                font-weight: 600;
            }
            .nar-setting-row input[type="checkbox"] {
                width: 16px;
                height: 16px;
                cursor: pointer;
            }
            .nar-btn-row {
                display: flex;
                gap: 6px;
                margin-bottom: 10px;
            }
            .nar-btn {
                flex: 1;
                background: #0284c7;
                color: #fff;
                border: none;
                border-radius: 7px;
                padding: 8px 8px;
                font-size: 12.5px;
                font-weight: 700;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                transition: background 0.15s, opacity 0.15s;
            }
            .nar-btn:disabled { opacity: 0.55; cursor: not-allowed; }
            .nar-btn:hover:not(:disabled) { background: #0369a1; }
            .nar-btn-secondary { background: #334155; color: #e2e8f0; }
            .nar-btn-secondary:hover:not(:disabled) { background: #475569; }
            .nar-btn-crawler { background: #7c3aed; color: #fff; }
            .nar-btn-crawler:hover:not(:disabled) { background: #6d28d9; }
            .nar-btn-resume { background: #10b981; color: #fff; }
            .nar-btn-resume:hover:not(:disabled) { background: #059669; }
            .nar-btn-warning { background: #d97706; color: #fff; }
            .nar-btn-warning:hover:not(:disabled) { background: #b45309; }
            .nar-btn-danger { background: #dc2626; color: #fff; }
            .nar-btn-danger:hover:not(:disabled) { background: #b91c1c; }
            .nar-btn-copyall { background: #059669; color: #fff; }
            .nar-btn-copyall:hover:not(:disabled) { background: #047857; }
            .nar-btn-zoom18 { background: #ea580c; color: #fff; }
            .nar-btn-zoom18:hover:not(:disabled) { background: #c2410c; }
            .nar-icon-btn {
                background: #334155;
                color: #f1f5f9;
                border: 1px solid #475569;
                border-radius: 5px;
                padding: 4px 8px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                flex-shrink: 0;
            }
            .nar-icon-btn:hover { background: #475569; }
            .nar-stats {
                background: #0f172a;
                border-radius: 8px;
                padding: 8px 10px;
                margin-bottom: 10px;
                font-size: 12px;
                display: flex;
                justify-content: space-around;
                border: 1px solid #1e293b;
            }
            .nar-stat-item { text-align: center; }
            .nar-stat-num { font-size: 15px; font-weight: 800; color: #33ccff; }
            .nar-stat-label { color: #cbd5e1; font-size: 11px; }
            .nar-status-box {
                font-size: 12.5px;
                line-height: 1.38;
                color: #e2e8f0;
                background: #0f172a;
                border-left: 4px solid #33ccff;
                padding: 7px 9px;
                border-radius: 5px;
                margin-bottom: 9px;
                min-height: 28px;
                display: flex;
                align-items: center;
            }
            .nar-queue-bar {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 5px;
                margin-bottom: 9px;
                padding: 6px 8px;
                background: #0f172a;
                border: 1px solid #1e293b;
                border-radius: 6px;
                font-size: 12.5px;
            }
            .nar-crawler-box {
                background: #131b2e;
                border: 1px solid #33ccff;
                border-radius: 8px;
                padding: 10px;
                margin-bottom: 10px;
            }
            .nar-alert-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
                max-height: 240px;
                overflow-y: auto;
                padding-right: 2px;
            }
            .nar-alert-card {
                background: #182234;
                border: 1px solid #334155;
                border-left: 4px solid #ff2d55;
                border-radius: 7px;
                padding: 8px 9px;
                transition: transform 0.1s, border-color 0.1s;
            }
            .nar-alert-card.nar-card-active {
                border-color: #33ccff;
                background: #1d2a40;
            }
            .nar-alert-card:hover { border-color: #ff2d55; }
            .nar-alert-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 4px;
            }
            .nar-alert-title { font-weight: 700; color: #f8fafc; font-size: 13px; }
            .nar-alert-meta { font-size: 11.5px; color: #cbd5e1; margin-bottom: 7px; }
            .nar-card-actions { display: flex; gap: 5px; }
            .nar-action-btn {
                background: #334155;
                color: #f8fafc;
                border: none;
                border-radius: 5px;
                padding: 5px 6px;
                font-size: 11.5px;
                cursor: pointer;
                flex: 1;
                font-weight: 700;
                text-align: center;
            }
            .nar-action-btn:hover { background: #475569; }
            .nar-action-btn-draw { background: #10b981; color: #fff; flex: 1.25; }
            .nar-action-btn-draw:hover { background: #059669; }
            .nar-action-btn-done { background: #0284c7; color: #fff; flex: 0.95; }
            .nar-action-btn-done:hover { background: #0369a1; }
            .nar-action-btn-dismiss { background: #475569; color: #cbd5e1; flex: 0.5; }
            .nar-action-btn-dismiss:hover { background: #dc2626; color: #fff; }
            .nar-toast {
                position: fixed;
                bottom: 24px;
                right: 24px;
                max-width: 420px;
                background: #0f172a;
                color: #fff;
                padding: 11px 16px;
                border-radius: 8px;
                border-left: 4px solid #33ccff;
                box-shadow: 0 6px 18px rgba(0,0,0,0.45);
                font-size: 13px;
                line-height: 1.35;
                z-index: 1000000;
                transition: opacity 0.3s;
            }
        `;
        document.head.appendChild(style);

        const isCompactInit = settings.uiMode === 'compact' && !settings.panelCollapsed;
        const panel = document.createElement('div');
        panel.id = 'wme-need-a-road-panel';
        if (isCompactInit) panel.classList.add('nar-compact-mode');

        panel.innerHTML = `
            <div id="wme-need-a-road-header" title="Drag anywhere on this Waze-blue bar to move window">
                <h4><span class="nar-drag-grip">⠿</span> 🛣️ ${SCRIPT_NAME}</h4>
                <div style="display:flex; align-items:center; gap:5px;">
                    <span id="nar-zoom-pill" class="nar-zoom-pill" title="Click to jump to Zoom 18 (or drag bar)">Zoom 18</span>
                    <span id="nar-stretch-count" class="nar-badge" style="display:none;">0</span>
                    <button id="nar-mode-btn" class="nar-hdr-btn" title="${isCompactInit ? 'Expand to Full Panel' : 'Shrink to Compact Fixer Bar'}">${isCompactInit ? '⤢' : '⤡'}</button>
                    <button id="nar-toggle-btn" class="nar-hdr-btn" title="Minimize / Restore">${settings.panelCollapsed ? '▲' : '▼'}</button>
                </div>
            </div>

            <!-- COMPACT DRAGGABLE FIXER WINDOW (Minimal footprint while editing roads!) -->
            <div id="wme-need-a-road-compact" style="display:${(!settings.panelCollapsed && isCompactInit) ? 'block' : 'none'};">
                <div class="nar-compact-nav">
                    <button id="nar-cmp-prev" class="nar-icon-btn" title="Previous Stretch in Queue">◀</button>
                    <div class="nar-compact-info">
                        <div id="nar-cmp-title">Queue Empty</div>
                        <div id="nar-cmp-sub" class="nar-compact-sub">Click ⤢ to scan an area</div>
                    </div>
                    <button id="nar-cmp-next" class="nar-icon-btn" title="Next Stretch in Queue">▶</button>
                </div>
                <div class="nar-card-actions">
                    <button id="nar-cmp-goto" class="nar-action-btn" title="Center map on this stretch at Zoom 18">🎯 Go</button>
                    <button id="nar-cmp-draw" class="nar-action-btn nar-action-btn-draw" title="Draw & auto-snap road">🛣️ Draw</button>
                    <button id="nar-cmp-done" class="nar-action-btn nar-action-btn-done" title="Mark resolved & advance to next">✅ Done</button>
                    <button id="nar-cmp-copy" class="nar-action-btn" style="flex:0.55;" title="Copy Permalink">🔗</button>
                    <button id="nar-cmp-dismiss" class="nar-action-btn nar-action-btn-dismiss" title="Dismiss as false positive">✖️</button>
                </div>
            </div>

            <!-- FULL CONTROL & COMPILED QUEUE PANEL -->
            <div id="wme-need-a-road-body" style="display:${(!settings.panelCollapsed && !isCompactInit) ? 'block' : 'none'};">
                <!-- SETTINGS & FILTER TUNING MOVED RIGHT TO THE TOP! -->
                <div class="nar-settings-top-bar">
                    <div id="nar-settings-link" class="nar-settings-toggle">
                        <span>⚙️ Settings &amp; Filter Tuning</span>
                        <span id="nar-settings-chevron">▼</span>
                    </div>
                    <div id="nar-settings-drawer" class="nar-settings-drawer">
                        <div class="nar-setting-row">
                            <span>Crawl Zoom Level (18–22):</span>
                            <input type="number" id="nar-cfg-crawlzoom" value="${settings.crawlerZoomLevel}" min="18" max="22" step="1" />
                        </div>
                        <div class="nar-setting-row">
                            <span>Road Corridor (Meters):</span>
                            <input type="number" id="nar-cfg-thresh" value="${settings.proximityThresholdMeters}" min="8" max="60" step="1" />
                        </div>
                        <div class="nar-setting-row">
                            <span>Draw Straightening (Meters):</span>
                            <input type="number" id="nar-cfg-straighten" value="${settings.drawSimplifyToleranceMeters}" min="3" max="25" step="1" />
                        </div>
                        <div class="nar-setting-row">
                            <span>Min GPS Points/Stretch:</span>
                            <input type="number" id="nar-cfg-minpts" value="${settings.minPointsPerStretch}" min="2" max="20" step="1" />
                        </div>
                        <div class="nar-setting-row">
                            <span>Cluster Radius (Meters):</span>
                            <input type="number" id="nar-cfg-cluster" value="${settings.clusterDistanceMeters}" min="20" max="150" step="5" />
                        </div>
                        <div class="nar-setting-row">
                            <span>Crawler Tile Delay (ms):</span>
                            <input type="number" id="nar-cfg-delay" value="${settings.crawlerStepDelayMs}" min="1000" max="5000" step="100" />
                        </div>
                        <div class="nar-setting-row">
                            <span>Only inside my Editable Area:</span>
                            <input type="checkbox" id="nar-cfg-editableonly" ${settings.onlyInsideEditableArea ? 'checked' : ''} />
                        </div>
                        <div class="nar-setting-row">
                            <span>Shrink to Mini Window after scan:</span>
                            <input type="checkbox" id="nar-cfg-autocompact" ${settings.autoCompactAfterScan ? 'checked' : ''} />
                        </div>
                        <div class="nar-setting-row">
                            <span>Auto-scan on map pan (Z18+):</span>
                            <input type="checkbox" id="nar-cfg-autoscan" ${settings.autoScanOnMove ? 'checked' : ''} />
                        </div>
                        <div class="nar-setting-row">
                            <span>Audio Chime on Alert:</span>
                            <input type="checkbox" id="nar-cfg-sound" ${settings.soundAlerts ? 'checked' : ''} />
                        </div>
                        <div style="display:flex; justify-content:space-between; gap:6px; margin-top:8px;">
                            <button id="nar-btn-reset-dismissed" class="nar-action-btn" style="padding:5px 7px;">🔄 Reset Dismissed (${dismissedStretches.size})</button>
                            <button id="nar-btn-clear" class="nar-action-btn" style="padding:5px 7px;">🧹 Hide Overlays</button>
                        </div>
                    </div>
                </div>

                <div class="nar-btn-row">
                    <button id="nar-btn-scan" class="nar-btn">
                        <span>🔍</span> Scan View
                    </button>
                    <button id="nar-btn-layers" class="nar-btn nar-btn-secondary" title="Turn on ROADS and GPS layers (Shift+G)">
                        <span>👁️</span> Layers ON
                    </button>
                    <button id="nar-btn-copyall" class="nar-btn nar-btn-copyall" title="Copy all compiled Zoom 18 permalinks">
                        <span>📋</span> Copy PLs
                    </button>
                </div>

                <!-- Area Crawler Section (4 km², 20 km², Editable Areas, Viewport) -->
                <div class="nar-crawler-box">
                    <div style="font-weight:700; font-size:12.5px; margin-bottom:6px; color:#33ccff; display:flex; justify-content:space-between; align-items:center;">
                        <span id="nar-crawler-title">🌐 Area Scanner (Zoom ${settings.crawlerZoomLevel}+)</span>
                        <span id="nar-crawler-progress-label" style="color:#cbd5e1; font-weight:600;"></span>
                    </div>
                    <div style="display:flex; gap:5px; margin-bottom:8px;">
                        <select id="nar-crawler-area-select" style="flex:1; min-width:0; background:#1e293b; color:#fff; border:1px solid #475569; border-radius:5px; padding:5px 6px; font-size:12.5px;">
                            <option value="0" data-area-id="scan_area_4km2">🗺️ Surrounding Window (4 km²)</option>
                        </select>
                        <button id="nar-btn-refresh-areas" class="nar-icon-btn" title="Reload Editable & Window Scan Areas">🔄</button>
                    </div>
                    <div class="nar-btn-row" style="margin-bottom:0;">
                        <button id="nar-btn-crawler-start" class="nar-btn nar-btn-crawler">
                            <span>🚀</span> Start Area Crawl
                        </button>
                        <button id="nar-btn-crawler-resume" class="nar-btn nar-btn-resume" style="display:none;">
                            <span>▶️</span> Resume
                        </button>
                        <button id="nar-btn-crawler-pause" class="nar-btn nar-btn-warning" style="display:none;">
                            <span>⏸️</span> Pause
                        </button>
                        <button id="nar-btn-crawler-stop" class="nar-btn nar-btn-danger" style="display:none;">
                            <span>⏹️</span> Stop
                        </button>
                        <button id="nar-btn-crawler-restart" class="nar-btn nar-btn-secondary" style="display:none;" title="Start over from Tile 1">
                            <span>🔄</span> Restart
                        </button>
                    </div>
                </div>

                <div class="nar-stats">
                    <div class="nar-stat-item">
                        <div id="nar-stat-gps" class="nar-stat-num">0</div>
                        <div class="nar-stat-label">View GPS</div>
                    </div>
                    <div class="nar-stat-item">
                        <div id="nar-stat-covered" class="nar-stat-num" style="color:#4ade80;">0</div>
                        <div class="nar-stat-label">On Road</div>
                    </div>
                    <div class="nar-stat-item">
                        <div id="nar-stat-unmapped" class="nar-stat-num" style="color:#ff2d55;">0</div>
                        <div class="nar-stat-label">Saved Queue</div>
                    </div>
                </div>

                <div id="nar-status" class="nar-status-box">
                    Ready. Pick 4 km², 20 km², or Editable Area to scan!
                </div>

                <!-- Persistent Compiled Queue Toolbar -->
                <div id="nar-queue-toolbar" class="nar-queue-bar" style="display:none;">
                    <span id="nar-queue-summary" style="color:#f8fafc; font-weight:700;">📋 0 Queued</span>
                    <div style="display:flex; gap:5px;">
                        <button id="nar-btn-export-csv" class="nar-icon-btn" title="Download compiled queue as CSV spreadsheet">💾 CSV</button>
                        <button id="nar-btn-mini-work" class="nar-icon-btn" style="background:#0284c7; border-color:#33ccff;" title="Switch to small draggable Fixer Bar">⤡ Work Mode</button>
                        <button id="nar-btn-clear-queue" class="nar-icon-btn" title="Clear all stretches from saved queue">🗑️ Clear</button>
                    </div>
                </div>

                <div id="nar-alerts-container" class="nar-alert-list"></div>
            </div>
        `;

        document.body.appendChild(panel);
        const headerEl = document.getElementById('wme-need-a-road-header');
        makePanelDraggable(panel, headerEl);
        applySavedPanelPosition(panel);

        // Header Controls (respects _justDraggedAt so dragging never misfires click actions!)
        headerEl.onclick = (e) => {
            if (panel._justDraggedAt && Date.now() - panel._justDraggedAt < 280) return;
            if (e.target.closest('button, #nar-zoom-pill')) return;
            togglePanel();
        };
        document.getElementById('nar-toggle-btn').onclick = (e) => {
            e.stopPropagation();
            if (panel._justDraggedAt && Date.now() - panel._justDraggedAt < 280) return;
            togglePanel();
        };
        document.getElementById('nar-mode-btn').onclick = (e) => {
            e.stopPropagation();
            if (panel._justDraggedAt && Date.now() - panel._justDraggedAt < 280) return;
            setUiMode(settings.uiMode === 'compact' ? 'full' : 'compact');
        };
        document.getElementById('nar-zoom-pill').onclick = (e) => {
            e.stopPropagation();
            if (panel._justDraggedAt && Date.now() - panel._justDraggedAt < 280) return;
            zoomTo18AndScan();
        };

        // Compact Fixer Window Bindings
        document.getElementById('nar-cmp-prev').onclick = () => {
            lastDrawnStretchId = null;
            lastDrawReminderMsg = '';
            jumpToStretchByIndex(activeStretchIndex - 1);
        };
        document.getElementById('nar-cmp-next').onclick = () => {
            lastDrawnStretchId = null;
            lastDrawReminderMsg = '';
            jumpToStretchByIndex(activeStretchIndex + 1);
        };
        document.getElementById('nar-cmp-goto').onclick = () => jumpToStretchByIndex(activeStretchIndex);
        document.getElementById('nar-cmp-draw').onclick = () => {
            const s = currentResults.stretches[activeStretchIndex];
            if (s) drawDraftRoad(s.id);
        };
        document.getElementById('nar-cmp-done').onclick = () => {
            const s = currentResults.stretches[activeStretchIndex];
            if (s) {
                if (lastDrawnStretchId === s.id) { lastDrawnStretchId = null; lastDrawReminderMsg = ''; }
                resolveStretchById(s.id, false);
            }
        };
        document.getElementById('nar-cmp-copy').onclick = () => {
            const s = currentResults.stretches[activeStretchIndex];
            if (s) {
                copyToClipboard(s.permalink);
                showToast(`Copied Stretch #${s.id} permalink!`, 'success');
            }
        };
        document.getElementById('nar-cmp-dismiss').onclick = () => {
            const s = currentResults.stretches[activeStretchIndex];
            if (s) {
                if (lastDrawnStretchId === s.id) { lastDrawnStretchId = null; lastDrawReminderMsg = ''; }
                resolveStretchById(s.id, true);
            }
        };

        // Main Panel Bindings
        document.getElementById('nar-btn-scan').onclick = () => {
            if (getCurrentZoom() < 18) {
                zoomTo18AndScan();
            } else {
                runScanner({ isManualScan: true });
            }
        };
        document.getElementById('nar-btn-layers').onclick = () => {
            ensureRequiredLayers();
            showToast('ROADS and GPS points layers enabled!', 'info');
            if (getCurrentZoom() >= 18) debounceScan(500);
        };
        document.getElementById('nar-btn-copyall').onclick = copyAllPermalinks;
        document.getElementById('nar-btn-export-csv').onclick = exportQueueToCsv;
        document.getElementById('nar-btn-mini-work').onclick = () => setUiMode('compact');
        document.getElementById('nar-btn-clear-queue').onclick = clearCompiledQueue;

        document.getElementById('nar-btn-refresh-areas').onclick = () => {
            populateAreaPicker(true);
        };
        document.getElementById('nar-crawler-area-select').onchange = (e) => {
            const chosenId = e.target.options[e.target.selectedIndex]?.dataset?.areaId || null;
            if (crawlerState.status === 'stopped' && chosenId !== crawlerState.selectedAreaId) {
                crawlerState.status = 'idle';
                updateCrawlerProgress('');
                updateCrawlerUI();
            }
        };

        document.getElementById('nar-btn-crawler-start').onclick = startGridCrawler;
        document.getElementById('nar-btn-crawler-resume').onclick = resumeGridCrawler;
        document.getElementById('nar-btn-crawler-pause').onclick = pauseGridCrawler;
        document.getElementById('nar-btn-crawler-stop').onclick = stopGridCrawler;
        document.getElementById('nar-btn-crawler-restart').onclick = startGridCrawler;

        document.getElementById('nar-btn-clear').onclick = () => {
            clearHighlights();
            showToast('Map highlights hidden (queue preserved).', 'info');
        };
        document.getElementById('nar-btn-reset-dismissed').onclick = () => {
            dismissedStretches.clear();
            saveDismissed();
            document.getElementById('nar-btn-reset-dismissed').textContent = '🔄 Reset Dismissed (0)';
            showToast('Dismissed stretches reset.', 'info');
            if (getCurrentZoom() >= 18) runScanner();
        };

        const settingsLink = document.getElementById('nar-settings-link');
        const settingsDrawer = document.getElementById('nar-settings-drawer');
        const settingsChevron = document.getElementById('nar-settings-chevron');
        settingsLink.onclick = () => {
            const isVisible = settingsDrawer.style.display === 'block';
            settingsDrawer.style.display = isVisible ? 'none' : 'block';
            if (settingsChevron) settingsChevron.textContent = isVisible ? '▼' : '▲';
        };

        document.getElementById('nar-cfg-crawlzoom').onchange = (e) => {
            const val = Math.max(18, Math.min(22, parseInt(e.target.value, 10) || 18));
            e.target.value = val;
            settings.crawlerZoomLevel = val;
            saveSettings();
            const titleEl = document.getElementById('nar-crawler-title');
            if (titleEl) titleEl.textContent = `🌐 Area Scanner (Zoom ${val}+)`;
        };
        document.getElementById('nar-cfg-thresh').onchange = (e) => {
            settings.proximityThresholdMeters = Math.max(8, parseFloat(e.target.value) || 18);
            saveSettings();
            if (getCurrentZoom() >= 18) debounceScan(250);
        };
        document.getElementById('nar-cfg-straighten').onchange = (e) => {
            settings.drawSimplifyToleranceMeters = Math.max(3, Math.min(25, parseFloat(e.target.value) || 8));
            saveSettings();
            renderHighlights(currentResults.stretches);
        };
        document.getElementById('nar-cfg-minpts').onchange = (e) => {
            settings.minPointsPerStretch = Math.max(2, parseInt(e.target.value, 10) || 4);
            saveSettings();
            if (getCurrentZoom() >= 18) debounceScan(250);
        };
        document.getElementById('nar-cfg-cluster').onchange = (e) => {
            settings.clusterDistanceMeters = Math.max(15, parseFloat(e.target.value) || 55);
            saveSettings();
            if (getCurrentZoom() >= 18) debounceScan(250);
        };
        document.getElementById('nar-cfg-delay').onchange = (e) => {
            settings.crawlerStepDelayMs = Math.max(800, parseInt(e.target.value, 10) || 1800);
            saveSettings();
        };
        document.getElementById('nar-cfg-editableonly').onchange = (e) => {
            settings.onlyInsideEditableArea = e.target.checked;
            saveSettings();
            if (getCurrentZoom() >= 18) debounceScan(250);
        };
        document.getElementById('nar-cfg-autocompact').onchange = (e) => {
            settings.autoCompactAfterScan = e.target.checked;
            saveSettings();
        };
        document.getElementById('nar-cfg-autoscan').onchange = (e) => {
            settings.autoScanOnMove = e.target.checked;
            saveSettings();
        };
        document.getElementById('nar-cfg-sound').onchange = (e) => {
            settings.soundAlerts = e.target.checked;
            saveSettings();
        };

        populateAreaPicker();
        updateZoomPill();
        updateCrawlerUI();
        renderAlertList();
    }

    function updateZoomPill() {
        const pill = document.getElementById('nar-zoom-pill');
        const btn = document.getElementById('nar-btn-scan');
        if (!pill) return;

        const z = getCurrentZoom();
        if (z < 18) {
            pill.className = 'nar-zoom-pill nar-zoom-warning';
            pill.textContent = `Zoom ${z} ⚠️`;
            pill.title = `Current zoom is ${z}. GPS traces require Zoom 18+. Click to zoom to 18!`;
            if (btn && !isScanning) {
                btn.className = 'nar-btn nar-btn-zoom18';
                btn.innerHTML = '<span>🔍</span> Zoom 18 &amp; Scan';
            }
        } else {
            pill.className = 'nar-zoom-pill';
            pill.textContent = `Zoom ${z} ✅`;
            pill.title = `Zoom ${z} active — GPS traces load at Zoom 18+.`;
            if (btn && !isScanning) {
                btn.className = 'nar-btn';
                btn.innerHTML = '<span>🔍</span> Scan View';
            }
        }
    }

    function togglePanel() {
        const fullBody = document.getElementById('wme-need-a-road-body');
        const compactBody = document.getElementById('wme-need-a-road-compact');
        const toggleIcon = document.getElementById('nar-toggle-btn');

        settings.panelCollapsed = !settings.panelCollapsed;
        if (settings.panelCollapsed) {
            if (fullBody) fullBody.style.display = 'none';
            if (compactBody) compactBody.style.display = 'none';
            if (toggleIcon) toggleIcon.textContent = '▲';
        } else {
            if (settings.uiMode === 'compact') {
                if (compactBody) compactBody.style.display = 'block';
                if (fullBody) fullBody.style.display = 'none';
            } else {
                if (fullBody) fullBody.style.display = 'block';
                if (compactBody) compactBody.style.display = 'none';
            }
            if (toggleIcon) toggleIcon.textContent = '▼';
        }
        saveSettings();
    }

    function updateScanButtonState(loading) {
        const btn = document.getElementById('nar-btn-scan');
        if (!btn) return;
        btn.disabled = loading || crawlerState.status === 'running';
        const z = getCurrentZoom();
        if (loading) {
            btn.innerHTML = '<span>⏳</span> Scanning...';
        } else if (z < 18) {
            btn.className = 'nar-btn nar-btn-zoom18';
            btn.innerHTML = '<span>🔍</span> Zoom 18 &amp; Scan';
        } else {
            btn.className = 'nar-btn';
            btn.innerHTML = '<span>🔍</span> Scan View';
        }
    }

    function updateCrawlerUI() {
        const startBtn = document.getElementById('nar-btn-crawler-start');
        const resumeBtn = document.getElementById('nar-btn-crawler-resume');
        const pauseBtn = document.getElementById('nar-btn-crawler-pause');
        const stopBtn = document.getElementById('nar-btn-crawler-stop');
        const restartBtn = document.getElementById('nar-btn-crawler-restart');
        const select = document.getElementById('nar-crawler-area-select');
        const refreshBtn = document.getElementById('nar-btn-refresh-areas');
        const scanBtn = document.getElementById('nar-btn-scan');

        const st = crawlerState.status; // 'idle' | 'running' | 'paused' | 'stopped'

        if (startBtn) startBtn.style.display = (st === 'idle') ? 'flex' : 'none';
        if (pauseBtn) pauseBtn.style.display = (st === 'running') ? 'flex' : 'none';

        // Whenever Pause OR Stop is used, Resume is clearly shown as the primary next action!
        if (resumeBtn) {
            const showResume = (st === 'paused' || st === 'stopped');
            resumeBtn.style.display = showResume ? 'flex' : 'none';
            if (showResume && crawlerState.tiles.length > 0) {
                const nextTile = Math.min(crawlerState.currentTileIndex + 1, crawlerState.tiles.length);
                resumeBtn.innerHTML = `<span>▶️</span> Resume (${nextTile}/${crawlerState.tiles.length})`;
            } else {
                resumeBtn.innerHTML = '<span>▶️</span> Resume';
            }
        }

        if (stopBtn) stopBtn.style.display = (st === 'running' || st === 'paused') ? 'flex' : 'none';
        if (restartBtn) restartBtn.style.display = (st === 'paused' || st === 'stopped') ? 'flex' : 'none';

        if (select) select.disabled = (st === 'running' || st === 'paused');
        if (refreshBtn) refreshBtn.disabled = (st === 'running');
        if (scanBtn) scanBtn.disabled = (st === 'running' || isScanning);
    }

    function updateCrawlerProgress(text) {
        const label = document.getElementById('nar-crawler-progress-label');
        if (label) label.textContent = text;
    }

    function updateStatusText(msg) {
        const box = document.getElementById('nar-status');
        if (box) box.textContent = msg;
    }

    function focusAlertCard(stretchId) {
        const card = document.getElementById(`nar-card-${stretchId}`);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            card.style.borderColor = '#33ccff';
            setTimeout(() => { card.style.borderColor = ''; }, 1500);
        }
    }

    function renderCompactFixer() {
        const titleEl = document.getElementById('nar-cmp-title');
        const subEl = document.getElementById('nar-cmp-sub');
        const prevBtn = document.getElementById('nar-cmp-prev');
        const nextBtn = document.getElementById('nar-cmp-next');
        const gotoBtn = document.getElementById('nar-cmp-goto');
        const drawBtn = document.getElementById('nar-cmp-draw');
        const doneBtn = document.getElementById('nar-cmp-done');
        const copyBtn = document.getElementById('nar-cmp-copy');
        const dismissBtn = document.getElementById('nar-cmp-dismiss');

        if (!titleEl || !subEl) return;

        const total = currentResults.stretches.length;
        const hasItems = total > 0;
        [prevBtn, nextBtn, gotoBtn, drawBtn, doneBtn, copyBtn, dismissBtn].forEach(b => {
            if (b) b.disabled = !hasItems;
        });

        if (!hasItems) {
            titleEl.textContent = '🎉 Queue All Clear!';
            subEl.textContent = 'Click ⤢ to expand & scan an area';
            subEl.style.color = '#cbd5e1';
            return;
        }

        if (activeStretchIndex >= total) activeStretchIndex = 0;
        const cur = currentResults.stretches[activeStretchIndex];
        const cleanNodes = buildMinimalNodeRoadPoints(cur.points, settings.drawSimplifyToleranceMeters || 8);
        const internalNodes = Math.max(0, cleanNodes.length - 2);

        titleEl.textContent = `🚨 Stretch ${activeStretchIndex + 1} of ${total} (~${cur.approxLengthMeters}m)`;
        if (lastDrawnStretchId === cur.id && lastDrawReminderMsg) {
            subEl.textContent = '⚠️ Check Road Type & Turns • Save in WME to auto-advance!';
            subEl.style.color = '#fbbf24';
        } else {
            subEl.textContent = `${cur.pointCount} GPS pts • ${internalNodes === 0 ? 'Straight line' : `${internalNodes} bend node(s)`}`;
            subEl.style.color = '#cbd5e1';
        }
    }

    function renderAlertList() {
        const container = document.getElementById('nar-alerts-container');
        const badge = document.getElementById('nar-stretch-count');
        const statGps = document.getElementById('nar-stat-gps');
        const statCovered = document.getElementById('nar-stat-covered');
        const statUnmapped = document.getElementById('nar-stat-unmapped');
        const qToolbar = document.getElementById('nar-queue-toolbar');
        const qSummary = document.getElementById('nar-queue-summary');

        const totalQueued = currentResults.stretches.length;

        if (statGps) statGps.textContent = currentResults.totalGpsInView;
        if (statCovered) statCovered.textContent = currentResults.coveredGpsCount;
        if (statUnmapped) statUnmapped.textContent = totalQueued;

        if (badge) {
            if (totalQueued > 0) {
                badge.textContent = totalQueued;
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        }

        if (qToolbar) {
            qToolbar.style.display = totalQueued > 0 ? 'flex' : 'none';
            if (qSummary) qSummary.textContent = `📋 ${totalQueued} Saved in Queue`;
        }

        renderCompactFixer();

        if (!container) return;
        container.innerHTML = '';

        if (totalQueued === 0) {
            if (currentResults.totalGpsInView > 0 && crawlerState.status !== 'running') {
                container.innerHTML = `
                    <div style="text-align:center; color:#94a3b8; padding:12px; font-size:12px;">
                        🎉 Queue empty — all scanned GPS traces have drivable roads underneath!
                    </div>
                `;
            }
            return;
        }

        currentResults.stretches.forEach((stretch, idx) => {
            const card = document.createElement('div');
            card.id = `nar-card-${stretch.id}`;
            card.className = 'nar-alert-card' + (idx === activeStretchIndex ? ' nar-card-active' : '');
            card.innerHTML = `
                <div class="nar-alert-header">
                    <span class="nar-alert-title">🚨 Stretch #${stretch.id}</span>
                    <span style="font-size:10px; color:#ff2d55; font-weight:bold;">~${stretch.approxLengthMeters}m • ${stretch.pointCount} pts</span>
                </div>
                <div class="nar-alert-meta">
                    ${stretch.centerLat.toFixed(5)}, ${stretch.centerLon.toFixed(5)}${stretch.sourceArea ? ` • <i>${stretch.sourceArea}</i>` : ''}
                </div>
                <div class="nar-card-actions">
                    <button class="nar-action-btn nar-action-btn-draw" id="nar-draw-${stretch.id}" title="Center at Zoom 18 and draw straight minimal-node Street">
                        🛣️ Draw
                    </button>
                    <button class="nar-action-btn" id="nar-goto-${stretch.id}" title="Center on stretch at Zoom 18 (keeps full queue!)">
                        🎯 Go
                    </button>
                    <button class="nar-action-btn nar-action-btn-done" id="nar-done-${stretch.id}" title="Mark fixed & remove from queue">
                        ✅ Done
                    </button>
                    <button class="nar-action-btn" style="flex:0.6;" id="nar-copy-${stretch.id}" title="Copy Zoom 18 permalink">
                        🔗 PL
                    </button>
                    <button class="nar-action-btn nar-action-btn-dismiss" id="nar-dismiss-${stretch.id}" title="Dismiss as false positive">
                        ✖️
                    </button>
                </div>
            `;

            container.appendChild(card);

            card.querySelector(`#nar-draw-${stretch.id}`).onclick = () => {
                if (crawlerState.status === 'running') pauseGridCrawler();
                drawDraftRoad(stretch.id);
            };

            card.querySelector(`#nar-goto-${stretch.id}`).onclick = async () => {
                await jumpToStretchByIndex(idx);
                showToast(`Centered on Stretch #${stretch.id} (${totalQueued} kept in queue)`, 'info');
            };

            card.querySelector(`#nar-done-${stretch.id}`).onclick = () => {
                resolveStretchById(stretch.id, false);
            };

            card.querySelector(`#nar-copy-${stretch.id}`).onclick = (e) => {
                copyToClipboard(stretch.permalink);
                const btn = e.currentTarget;
                btn.textContent = '✅';
                setTimeout(() => { btn.textContent = '🔗 PL'; }, 1400);
                showToast('Zoom 18 Permalink copied to clipboard!', 'success');
            };

            card.querySelector(`#nar-dismiss-${stretch.id}`).onclick = () => {
                resolveStretchById(stretch.id, true);
            };
        });
    }

    function showToast(message, type = 'info') {
        const existing = document.querySelector('.nar-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'nar-toast';
        if (type === 'warning') toast.style.borderLeftColor = '#f59e0b';
        if (type === 'success') toast.style.borderLeftColor = '#10b981';
        if (type === 'error') toast.style.borderLeftColor = '#ef4444';
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3200);
    }

    function playChime() {
        try {
            const ctx = new (win.AudioContext || win.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(587.33, ctx.currentTime);
            osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.35);
        } catch (e) {}
    }

    /* ==========================================================================
       12. MAP & USER SESSION EVENT LISTENERS
       ========================================================================== */
    function onViewportChanged() {
        updateZoomPill();
        if (currentResults.stretches.length > 0) {
            renderHighlights(currentResults.stretches, currentResults.stretches.flatMap(s => s.points));
        }
        if (settings.autoScanOnMove &&
            crawlerState.status !== 'running' &&
            Date.now() >= suppressAutoScanUntil &&
            getCurrentZoom() >= 18) {
            debounceScan(700);
        }
    }

    function onWmeSaveFinished() {
        if (!lastDrawnStretchId) return;
        const drawnId = lastDrawnStretchId;
        lastDrawnStretchId = null;
        lastDrawReminderMsg = '';

        const exists = currentResults.stretches.some(s => s.id === drawnId);
        if (exists) {
            resolveStretchById(drawnId, false);
            updateStatusText(`✅ Saved! Auto-completed Stretch & queued next (${currentResults.stretches.length} remaining).`);
            if (currentResults.stretches.length > 0 && settings.uiMode === 'compact') {
                // Smoothly center on the new active stretch in Compact Mode!
                setTimeout(() => jumpToStretchByIndex(activeStretchIndex), 350);
            }
        }
    }

    function setupMapListeners() {
        let sdkBound = false;
        if (wmeSDK && wmeSDK.Events && typeof wmeSDK.Events.on === 'function') {
            try {
                wmeSDK.Events.on({ eventName: 'wme-map-move-end', eventHandler: onViewportChanged });
                wmeSDK.Events.on({ eventName: 'wme-map-zoom-changed', eventHandler: onViewportChanged });
                wmeSDK.Events.on({ eventName: 'wme-user-areas-loaded', eventHandler: () => populateAreaPicker() });
                wmeSDK.Events.on({ eventName: 'wme-logged-in', eventHandler: () => populateAreaPicker() });
                wmeSDK.Events.on({ eventName: 'wme-save-finished', eventHandler: onWmeSaveFinished });
                sdkBound = true;
            } catch (e) {}
        }

        if (!sdkBound && win.W && win.W.map && win.W.map.events && typeof win.W.map.events.register === 'function') {
            win.W.map.events.register('moveend', null, onViewportChanged);
            win.W.map.events.register('zoomend', null, onViewportChanged);
        }

        if (win.W && win.W.model && win.W.model.actionManager && win.W.model.actionManager.events &&
            typeof win.W.model.actionManager.events.register === 'function') {
            try {
                // Fires right after WME commits a Save and clears pending edit actions
                win.W.model.actionManager.events.register('afterclearactions', null, () => {
                    if (lastDrawnStretchId) setTimeout(onWmeSaveFinished, 150);
                });
            } catch (e) {}
        }

        if (win.W && win.W.loginManager && win.W.loginManager.events && typeof win.W.loginManager.events.register === 'function') {
            try {
                win.W.loginManager.events.register('login', null, () => populateAreaPicker());
                win.W.loginManager.events.register('loginStatus', null, () => populateAreaPicker());
            } catch (e) {}
        }
    }

    /* ==========================================================================
       13. BOOTSTRAPPER & INITIALIZATION
       ========================================================================== */
    function init() {
        if (isInitialized) return;

        const wmeReady = Boolean(win.W && win.W.map && win.W.model && win.W.model.segments);
        const sdkReady = Boolean(typeof win.getWmeSdk === 'function' || typeof win.wmeSDK !== 'undefined');

        if (!wmeReady && !sdkReady) {
            setTimeout(init, 500);
            return;
        }

        if (typeof win.getWmeSdk === 'function') {
            try {
                wmeSDK = win.getWmeSdk({
                    scriptId: 'wme-need-a-road',
                    scriptName: SCRIPT_NAME
                });
            } catch (e) {
                console.warn(`[${SCRIPT_SHORT}] SDK init note:`, e);
            }
        }

        isInitialized = true;
        console.log(`[${SCRIPT_SHORT}] Initialized v${SCRIPT_VERSION}`);

        // Restore previously compiled queue before injecting UI so editors can pick up across sessions!
        const restoredCount = loadCompiledQueue();

        injectUI();
        ensureRequiredLayers();
        setupMapListeners();

        if (restoredCount > 0) {
            renderAlertList();
            renderHighlights(currentResults.stretches, currentResults.stretches.flatMap(s => s.points));
            updateStatusText(`📋 Restored ${restoredCount} saved stretch(es) in your queue!`);
        }

        // Refresh Editable Areas as user profile & map models finish hydrating
        setTimeout(() => populateAreaPicker(), 1200);
        setTimeout(() => populateAreaPicker(), 3500);
        setTimeout(() => populateAreaPicker(), 7000);

        setTimeout(() => {
            updateZoomPill();
            const z = getCurrentZoom();
            if (z >= 18) {
                runScanner();
            } else if (restoredCount === 0) {
                updateStatusText(`Map is at Zoom ${z}. Click 'Zoom 18 & Scan' or run a 4 km² / 20 km² Area Crawl!`);
            }
        }, 1400);
    }

    if (win.SDK_INITIALIZED && typeof win.SDK_INITIALIZED.then === 'function') {
        win.SDK_INITIALIZED.then(() => setTimeout(init, 300)).catch(() => setTimeout(init, 800));
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(init, 900);
    } else {
        window.addEventListener('DOMContentLoaded', () => setTimeout(init, 900));
    }

})();
