// ==UserScript==
// @name         WME Need a Road, Dude! (GPS Trace vs Road Checker)
// @namespace    https://github.com/Waze
// @version      1.3.0
// @description  Scans WME at Zoom 18+ for GPS traces with no drivable road segment underneath. Automatically enables ROADS and GPS layers, reads vector & raster GPS traces, loads editor Editable/Managed Areas, crawls at Zoom 18+ with Pause/Stop/Resume controls, provides semi-automated road drawing, and generates Zoom 18 permalinks.
// @author       McLaren with assistive AI
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

(function () {
    'use strict';

    const SCRIPT_NAME = 'Need a Road, Dude!';
    const SCRIPT_SHORT = 'NeedARoad';
    const SCRIPT_VERSION = '1.3.0';

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
        proximityThresholdMeters: 6,  // Max distance (meters) between GPS point and drivable segment to count as covered
        minPointsPerStretch: 3,       // Minimum unmapped GPS points to trigger a stretch alert (filters drift)
        clusterDistanceMeters: 60,    // Points within this distance are grouped into the same stretch
        crawlerStepDelayMs: 1800,     // Delay per tile during crawl to allow WME to download & render Zoom 18+ GPS tiles
        crawlerZoomLevel: 18,         // Crawler zoom level (strictly >= 18 so GPS traces load)
        autoScanOnMove: true,         // Automatically re-scan when map stops moving at Zoom 18+
        soundAlerts: false,           // Play a subtle chime when missing roads are found
        highlightColor: '#ff2d55',    // Glowing color for missing road GPS points
        highlightGlow: '#ff9500',     // Secondary halo glow
        panelCollapsed: false,
        zoomMinRequired: 18           // WME requires Zoom 18+ to load and display GPS traces
    };

    // Load persisted settings with strict Zoom 18+ floor migration
    try {
        const saved = localStorage.getItem('WME_NeedARoad_Settings');
        if (saved) {
            const parsed = JSON.parse(saved);
            Object.assign(settings, parsed);
        }
    } catch (e) {
        console.warn(`[${SCRIPT_SHORT}] Could not load settings:`, e);
    }
    // Enforce Zoom 18+ minimum even if older settings were cached in localStorage
    if (!Number.isFinite(settings.zoomMinRequired) || settings.zoomMinRequired < 18) {
        settings.zoomMinRequired = 18;
    }
    if (!Number.isFinite(settings.crawlerZoomLevel) || settings.crawlerZoomLevel < 18) {
        settings.crawlerZoomLevel = 18;
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

    // GPS Data & Raster Tile Cache
    const capturedGpsPoints = new Map(); // key -> { lon, lat, x, y, timestamp }
    const rasterTileCache = new Map();   // tileUrl -> Array<{ u: number, v: number }> | 'non_gps' | 'failed'
    const cachedNetworkAreas = [];       // Editable / Managed area objects captured from WME responses
    let cachedResolvedAreas = [];        // Latest list used in the Area Picker dropdown

    // Analysis Results
    let currentResults = {
        totalGpsInView: 0,
        unmappedGpsCount: 0,
        coveredGpsCount: 0,
        stretches: [] // Array of { id, centerLat, centerLon, pointCount, points: [...], permalink, approxLengthMeters }
    };

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
                        }
                    }
                }

                if (hitCount > 0) {
                    uvPoints.push({
                        u: (sumX / hitCount) / w,
                        v: (sumY / hitCount) / h
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
                for (const { u, v } of uvList) {
                    const vx = (rect.left - mapRect.left) + u * rect.width;
                    const vy = (rect.top - mapRect.top) + v * rect.height;
                    if (vx < 0 || vy < 0 || vx > mapRect.width || vy > mapRect.height) continue;

                    const ll = pixelToLonLat(vx, vy, extent, mapRect.width, mapRect.height);
                    if (ll && Number.isFinite(ll.lon) && Number.isFinite(ll.lat)) {
                        const merc = latLonToMercator(ll.lat, ll.lon);
                        extracted.push({ lon: ll.lon, lat: ll.lat, x: merc.x, y: merc.y });
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
                    for (const { u, v } of uvList) {
                        const vx = (r.left - mapRect.left) + u * r.width;
                        const vy = (r.top - mapRect.top) + v * r.height;
                        if (vx < 0 || vy < 0 || vx > mapRect.width || vy > mapRect.height) continue;

                        const ll = pixelToLonLat(vx, vy, extent, mapRect.width, mapRect.height);
                        if (ll && Number.isFinite(ll.lon) && Number.isFinite(ll.lat)) {
                            const merc = latLonToMercator(ll.lat, ll.lon);
                            extracted.push({ lon: ll.lon, lat: ll.lat, x: merc.x, y: merc.y });
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
                parsedSegments.push({
                    id: seg.id ?? (seg.attributes && seg.attributes.id),
                    roadType: rType,
                    wgsPoints: wgsCoords
                });
            }
        }

        return parsedSegments;
    }

    // Extract all GPS points currently in viewport (Vector + Model + Network + Raster GPS Layer)
    async function getGpsPointsInViewport(extent) {
        const pointsInView = [];
        const seenGrid = new Set(); // Deduplicate within ~2.5m cells

        function addCandidate(lon, lat) {
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            if (extent) {
                if (lon < extent.minLon || lon > extent.maxLon || lat < extent.minLat || lat > extent.maxLat) {
                    return;
                }
            }
            const gridKey = `${Math.round(lat * 45000)}_${Math.round(lon * 45000)}`;
            if (!seenGrid.has(gridKey)) {
                seenGrid.add(gridKey);
                const merc = latLonToMercator(lat, lon);
                pointsInView.push({ lon, lat, x: merc.x, y: merc.y });
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
            addCandidate(pt.lon, pt.lat);
        }

        // 4. Raster GPS Tile / Canvas Pixel Scanner (reads WME's gps_points tile layer directly!)
        const rasterPts = await extractRasterGpsPointsInView(extent);
        for (const rp of rasterPts) {
            addCandidate(rp.lon, rp.lat);
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

        // 7. Guaranteed Viewport & Neighborhood Options (placed after user's Editable Areas, or first if none loaded yet)
        const extent = getMapExtent();
        if (extent) {
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

            const cLon = (extent.minLon + extent.maxLon) / 2;
            const cLat = (extent.minLat + extent.maxLat) / 2;
            const span = 0.0135; // ~1.5 km radius (~3x3 km box)
            const nbPolys = extractPolygonsFromAnyGeometry({
                type: 'Polygon',
                coordinates: [[
                    [cLon - span, cLat - span],
                    [cLon + span, cLat - span],
                    [cLon + span, cLat + span],
                    [cLon - span, cLat + span],
                    [cLon - span, cLat - span]
                ]]
            });
            const nbEntry = buildAreaEntry(nbPolys, '🗺️ Surrounding Region (~3x3 km)', 'current_neighborhood');
            if (nbEntry) nbEntry.id = 'current_neighborhood';

            if (vpEntry) areas.push(vpEntry);
            if (nbEntry) areas.push(nbEntry);
        }

        cachedResolvedAreas = areas;
        return areas;
    }

    /* ==========================================================================
       6. CORE SCANNING & CROSS-CHECKING LOGIC (Zoom 18+)
       ========================================================================== */
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
                updateStatusText(`⚠️ Map is at Zoom ${zoom}. GPS traces require Zoom ${minZoom}+. Click 'Zoom to 18 & Scan'!`);
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

            if (gpsPoints.length === 0) {
                if (!options.isCrawlerStep) {
                    updateStatusText(`No GPS traces visible at Zoom ${zoom} here. (None recorded or still loading).`);
                    clearHighlights();
                    currentResults = { totalGpsInView: 0, unmappedGpsCount: 0, coveredGpsCount: 0, stretches: [] };
                    renderAlertList();
                }
                return;
            }

            // Cross-check: GPS + Drivable Segment (<= threshold) => Covered; GPS + No Segment => Flag
            const unmappedPoints = [];
            let coveredCount = 0;
            const threshold = settings.proximityThresholdMeters;
            const R = 6371000;

            for (const pt of gpsPoints) {
                let hasSegmentUnderneath = false;
                const cosLat = Math.cos(pt.lat * Math.PI / 180);
                const px = pt.lon * (Math.PI / 180) * R * cosLat;
                const py = pt.lat * (Math.PI / 180) * R;

                for (const seg of segments) {
                    const pts = seg.wgsPoints;
                    for (let i = 0; i < pts.length - 1; i++) {
                        const v1 = pts[i];
                        const v2 = pts[i + 1];

                        const ax = v1.lon * (Math.PI / 180) * R * cosLat;
                        const ay = v1.lat * (Math.PI / 180) * R;
                        const bx = v2.lon * (Math.PI / 180) * R * cosLat;
                        const by = v2.lat * (Math.PI / 180) * R;

                        const dist = distanceToLineSegmentMeters(px, py, ax, ay, bx, by);
                        if (dist <= threshold) {
                            hasSegmentUnderneath = true;
                            break;
                        }
                    }
                    if (hasSegmentUnderneath) break;
                }

                if (hasSegmentUnderneath) {
                    coveredCount++;
                } else {
                    unmappedPoints.push(pt);
                }
            }

            const newStretches = clusterUnmappedPoints(unmappedPoints);
            const activeStretches = newStretches.filter(s => !isStretchDismissed(s.centerLat, s.centerLon));

            if (options.isCrawlerStep) {
                currentResults.totalGpsInView += gpsPoints.length;
                currentResults.coveredGpsCount += coveredCount;
                currentResults.unmappedGpsCount += unmappedPoints.length;
                mergeCrawlerStretches(activeStretches);
            } else {
                currentResults = {
                    totalGpsInView: gpsPoints.length,
                    unmappedGpsCount: unmappedPoints.length,
                    coveredGpsCount: coveredCount,
                    stretches: activeStretches
                };
            }

            renderHighlights(currentResults.stretches, currentResults.stretches.flatMap(s => s.points));
            renderAlertList();

            if (!options.isCrawlerStep) {
                if (currentResults.stretches.length > 0) {
                    updateStatusText(`🚨 Found ${currentResults.stretches.length} stretch(es) needing a road at Zoom ${zoom}!`);
                    if (settings.soundAlerts) playChime();
                } else {
                    updateStatusText(`✅ All ${gpsPoints.length} GPS trace samples in view have drivable roads underneath.`);
                }
            }
        } catch (err) {
            console.error(`[${SCRIPT_SHORT}] Error during scan:`, err);
            updateStatusText(`❌ Scan error: ${err.message}`);
        } finally {
            isScanning = false;
            updateScanButtonState(false);
        }
    }

    function mergeCrawlerStretches(newStretches) {
        let foundNew = false;
        for (const ns of newStretches) {
            const alreadyExists = currentResults.stretches.some(existing => {
                const d = haversineDistanceMeters(existing.centerLat, existing.centerLon, ns.centerLat, ns.centerLon);
                return d < 75;
            });
            if (!alreadyExists) {
                ns.id = currentResults.stretches.length + 1;
                currentResults.stretches.push(ns);
                crawlerState.totalStretchesFound++;
                foundNew = true;
            }
        }
        if (foundNew && settings.soundAlerts) {
            playChime();
        }
    }

    function debounceScan(delayMs = 500) {
        if (scanTimeout) clearTimeout(scanTimeout);
        scanTimeout = setTimeout(() => {
            if (crawlerState.status !== 'running') {
                const z = getCurrentZoom();
                if (z >= 18) runScanner();
                else updateZoomPill();
            }
        }, delayMs);
    }

    function clusterUnmappedPoints(points) {
        if (points.length === 0) return [];

        const clusters = [];
        const visited = new Set();
        const clusterDist = settings.clusterDistanceMeters;

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

            if (cluster.length >= settings.minPointsPerStretch) {
                let sumLat = 0, sumLon = 0;
                let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;

                for (const p of cluster) {
                    sumLat += p.lat;
                    sumLon += p.lon;
                    if (p.lat < minLat) minLat = p.lat;
                    if (p.lat > maxLat) maxLat = p.lat;
                    if (p.lon < minLon) minLon = p.lon;
                    if (p.lon > maxLon) maxLon = p.lon;
                }

                const centerLat = sumLat / cluster.length;
                const centerLon = sumLon / cluster.length;
                const approxLengthMeters = Math.round(haversineDistanceMeters(minLat, minLon, maxLat, maxLon));

                clusters.push({
                    id: clusters.length + 1,
                    centerLat,
                    centerLon,
                    pointCount: cluster.length,
                    approxLengthMeters: Math.max(12, approxLengthMeters),
                    points: cluster,
                    permalink: generatePermalink(centerLat, centerLon, Math.max(18, settings.crawlerZoomLevel || 18))
                });
            }
        }

        return clusters;
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

        const permissionCount = areas.filter(a => a.id !== 'current_viewport' && a.id !== 'current_neighborhood').length;
        if (showFeedback) {
            if (permissionCount > 0) {
                showToast(`Loaded ${permissionCount} Editable / Managed Area(s)!`, 'success');
            } else {
                showToast('Editor permission polygons not yet sent by WME; Viewport & Surrounding Region ready.', 'info');
            }
        }
    }

    function generateTilesForArea(targetArea, stepLon, stepLat) {
        const tiles = [];
        const seenTiles = new Set();
        const halfLon = stepLon / 2;
        const halfLat = stepLat / 2;
        const MAX_TILES = 8000;

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
                tiles.push({ lon: cLon, lat: cLat });
            }
        }

        return tiles;
    }

    async function startGridCrawler() {
        const areas = cachedResolvedAreas.length > 0 ? cachedResolvedAreas : getEditorPermissions();
        if (!areas || areas.length === 0) {
            showToast('No areas available to crawl yet.', 'warning');
            return;
        }

        const select = document.getElementById('nar-crawler-area-select');
        const areaIndex = Math.max(0, parseInt(select ? select.value : '0', 10) || 0);
        const targetArea = areas[areaIndex] || areas[0];

        // Refresh Current Viewport dynamically if chosen
        let activeArea = targetArea;
        if (targetArea.id === 'current_viewport') {
            const freshAreas = getEditorPermissions();
            const freshVp = freshAreas.find(a => a.id === 'current_viewport');
            if (freshVp) activeArea = freshVp;
        }

        const crawlZoom = Math.max(18, settings.crawlerZoomLevel || 18);

        // Ensure map is at Zoom 18+ FIRST so we can measure exact Zoom-18 viewport tile dimensions!
        ensureRequiredLayers();
        const startCenterLat = (activeArea.bbox.minLat + activeArea.bbox.maxLat) / 2;
        const startCenterLon = (activeArea.bbox.minLon + activeArea.bbox.maxLon) / 2;
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

        currentResults = {
            totalGpsInView: 0,
            unmappedGpsCount: 0,
            coveredGpsCount: 0,
            stretches: []
        };
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
        updateStatusText(`🔍 Crawling Tile ${idx + 1}/${total} at Zoom ${crawlZoom}... (${currentResults.stretches.length} found)`);

        // Move to tile strictly at Zoom 18+ and verify WME zoom >= 18
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

        const idx = Math.min(crawlerState.currentTileIndex + 1, crawlerState.tiles.length);
        const total = crawlerState.tiles.length;
        const pct = total > 0 ? Math.round((crawlerState.currentTileIndex / total) * 100) : 0;

        updateCrawlerUI();
        updateCrawlerProgress(`⏸️ Paused ${idx}/${total} (${pct}%)`);
        updateStatusText(`⏸️ Paused at Tile ${idx}/${total}. Click '▶️ Resume' to continue.`);
        showToast(`Crawler paused at Tile ${idx}/${total}. Click Resume when ready!`, 'info');
    }

    function stopGridCrawler() {
        if (crawlerState.status !== 'running' && crawlerState.status !== 'paused') return;
        if (crawlerState.timeoutId) {
            clearTimeout(crawlerState.timeoutId);
            crawlerState.timeoutId = null;
        }
        crawlerState.stepRunId++;

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
            updateStatusText(`⏹️ Stopped at Tile ${idx}/${total} (${currentResults.stretches.length} found). Click '▶️ Resume' to continue!`);
            showToast(`Crawler stopped. Click '▶️ Resume' anytime to continue from Tile ${idx}/${total}!`, 'info');
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

        updateCrawlerUI();
        updateCrawlerProgress(`✅ Done (${crawlerState.tiles.length}/${crawlerState.tiles.length})`);
        showToast(`🎉 Crawler finished! Found ${currentResults.stretches.length} missing road stretch(es).`, 'success');
        updateStatusText(`🎉 Crawl complete! Discovered ${currentResults.stretches.length} missing road stretch(es).`);
    }

    /* ==========================================================================
       8. SEMI-AUTOMATED "DRAW ROAD" ACTION (Inserts Draft Street)
       ========================================================================== */
    async function drawDraftRoad(stretchId) {
        const stretch = currentResults.stretches.find(s => s.id === stretchId);
        if (!stretch || stretch.points.length < 2) {
            showToast('Need at least 2 GPS points to draw a road.', 'warning');
            return;
        }

        await goToLocationAndVerifyZoom(stretch.centerLat, stretch.centerLon, 18);
        const sortedPoints = sortGpsPointsAlongTrajectory(stretch.points);

        let createdViaSdk = false;

        // 1. Official WME SDK segment creation
        if (wmeSDK && wmeSDK.DataModel && wmeSDK.DataModel.Segments && typeof wmeSDK.DataModel.Segments.addSegment === 'function') {
            try {
                const geoJsonCoords = sortedPoints.map(p => [p.lon, p.lat]);
                await Promise.resolve(wmeSDK.DataModel.Segments.addSegment({
                    geometry: {
                        type: 'LineString',
                        coordinates: geoJsonCoords
                    },
                    roadType: 1
                }));
                createdViaSdk = true;
                showToast('🛣️ Draft Street created along GPS trace! Connect junctions and save.', 'success');
            } catch (e) {}
        }

        // 2. Legacy W.Action.AddSegment
        if (!createdViaSdk && win.W && win.W.model && win.W.controller && win.W.controller.actionManager) {
            try {
                const AddSegmentAction = win.require ? win.require('Waze/Action/AddSegment') : (win.W.Action && win.W.Action.AddSegment);
                const SegmentFeature = win.require ? win.require('Waze/Feature/Vector/Segment') : (win.W.Feature && win.W.Feature.Vector && win.W.Feature.Vector.Segment);

                if (AddSegmentAction && SegmentFeature && win.OpenLayers) {
                    const olComponents = sortedPoints.map(p => {
                        const m = latLonToMercator(p.lat, p.lon);
                        return new win.OpenLayers.Geometry.Point(m.x, m.y);
                    });
                    const lineGeom = new win.OpenLayers.Geometry.LineString(olComponents);
                    const seg = new SegmentFeature(lineGeom, {
                        roadType: 1,
                        flags: 0
                    });
                    win.W.controller.actionManager.add(new AddSegmentAction(seg));
                    createdViaSdk = true;
                    showToast('🛣️ Draft Street added! Fill in street name and connect junctions.', 'success');
                }
            } catch (e) {}
        }

        // 3. Fallback: activate WME road drawing tool
        if (!createdViaSdk) {
            showToast("Centered at Zoom 18. Press 'I' or click Road tool to trace the highlighted line!", 'info');
            const roadToolBtn = document.querySelector('#toolbar .toolbar-button-road, .wz-header-item-road');
            if (roadToolBtn) roadToolBtn.click();
        }
    }

    function sortGpsPointsAlongTrajectory(points) {
        if (points.length <= 2) return points;

        let maxDist = -1;
        let startIdx = 0;
        for (let i = 0; i < points.length; i++) {
            for (let j = i + 1; j < points.length; j++) {
                const d = haversineDistanceMeters(points[i].lat, points[i].lon, points[j].lat, points[j].lon);
                if (d > maxDist) {
                    maxDist = d;
                    startIdx = i;
                }
            }
        }

        const sorted = [points[startIdx]];
        const unvisited = new Set(points.map((_, i) => i));
        unvisited.delete(startIdx);

        while (unvisited.size > 0) {
            const current = sorted[sorted.length - 1];
            let nearestIdx = -1;
            let nearestDist = Infinity;

            for (const idx of unvisited) {
                const p = points[idx];
                const d = haversineDistanceMeters(current.lat, current.lon, p.lat, p.lon);
                if (d < nearestDist) {
                    nearestDist = d;
                    nearestIdx = idx;
                }
            }

            if (nearestIdx !== -1) {
                unvisited.delete(nearestIdx);
                sorted.push(points[nearestIdx]);
            } else {
                break;
            }
        }

        if (sorted.length > 8) {
            const step = Math.floor(sorted.length / 7);
            const simplified = [sorted[0]];
            for (let i = step; i < sorted.length - 1; i += step) simplified.push(sorted[i]);
            simplified.push(sorted[sorted.length - 1]);
            return simplified;
        }

        return sorted;
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
            runScanner();
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
            showToast('No missing road stretches to copy.', 'warning');
            return;
        }

        let output = `=== WME Need a Road! Missing Roads Report (${currentResults.stretches.length} Stretches) ===\n\n`;
        currentResults.stretches.forEach((s) => {
            output += `Stretch #${s.id} (${s.pointCount} GPS samples, ~${s.approxLengthMeters}m):\n${s.permalink}\n\n`;
        });

        copyToClipboard(output);
        showToast(`Copied ${currentResults.stretches.length} Zoom 18 permalinks to clipboard!`, 'success');
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

    function renderHighlights(stretches, unmappedPoints) {
        const svg = getOrCreateOverlaySvg();
        clearHighlights();

        if (stretches.length === 0 && unmappedPoints.length === 0) return;

        const mapDiv = getMapViewportElement();
        const w = mapDiv ? mapDiv.clientWidth : win.innerWidth;
        const h = mapDiv ? mapDiv.clientHeight : win.innerHeight;

        // Draw glowing circles on unmapped GPS points inside current screen bounds
        for (const pt of unmappedPoints) {
            const pixel = coordsToPixel(pt.lon, pt.lat);
            if (!pixel || pixel.x < -20 || pixel.y < -20 || pixel.x > w + 20 || pixel.y > h + 20) continue;

            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', pixel.x.toFixed(1));
            circle.setAttribute('cy', pixel.y.toFixed(1));
            circle.setAttribute('r', '5.5');
            circle.setAttribute('fill', settings.highlightColor);
            circle.setAttribute('stroke', '#ffffff');
            circle.setAttribute('stroke-width', '1.5');
            circle.setAttribute('filter', 'url(#roadGlow)');
            circle.setAttribute('opacity', '0.9');
            svg.appendChild(circle);
        }

        // Draw stretch trajectory paths and clickable badges
        for (const stretch of stretches) {
            const centerPixel = coordsToPixel(stretch.centerLon, stretch.centerLat);
            if (!centerPixel || centerPixel.x < -100 || centerPixel.y < -100 || centerPixel.x > w + 100 || centerPixel.y > h + 100) {
                continue;
            }

            const ordered = sortGpsPointsAlongTrajectory(stretch.points);
            if (ordered.length > 1) {
                let pathData = '';
                for (let i = 0; i < ordered.length; i++) {
                    const p = coordsToPixel(ordered[i].lon, ordered[i].lat);
                    if (!p) continue;
                    pathData += (pathData === '' ? `M ${p.x.toFixed(1)} ${p.y.toFixed(1)}` : ` L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
                }
                if (pathData) {
                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    path.setAttribute('d', pathData);
                    path.setAttribute('stroke', settings.highlightGlow);
                    path.setAttribute('stroke-width', '3.5');
                    path.setAttribute('stroke-dasharray', '6,4');
                    path.setAttribute('fill', 'none');
                    path.setAttribute('opacity', '0.9');
                    svg.appendChild(path);
                }
            }

            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('transform', `translate(${centerPixel.x.toFixed(1)}, ${(centerPixel.y - 18).toFixed(1)})`);
            g.setAttribute('style', 'pointer-events: auto; cursor: pointer;');
            g.onclick = () => {
                goToLocationAndVerifyZoom(stretch.centerLat, stretch.centerLon, 18);
                focusAlertCard(stretch.id);
            };

            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', '-52');
            rect.setAttribute('y', '-14');
            rect.setAttribute('width', '104');
            rect.setAttribute('height', '26');
            rect.setAttribute('rx', '13');
            rect.setAttribute('fill', '#1a1f2c');
            rect.setAttribute('stroke', settings.highlightColor);
            rect.setAttribute('stroke-width', '2');
            rect.setAttribute('filter', 'url(#roadGlow)');

            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', '0');
            text.setAttribute('y', '3');
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('fill', '#ffffff');
            text.setAttribute('font-size', '11px');
            text.setAttribute('font-weight', 'bold');
            text.setAttribute('font-family', 'sans-serif');
            text.textContent = `🛣️ Stretch #${stretch.id}`;

            g.appendChild(rect);
            g.appendChild(text);
            svg.appendChild(g);
        }
    }

    /* ==========================================================================
       11. USER INTERFACE & CRAWLER CONTROLS
       ========================================================================== */
    function injectUI() {
        if (document.getElementById('wme-need-a-road-panel')) return;

        const style = document.createElement('style');
        style.textContent = `
            #wme-need-a-road-panel {
                position: fixed;
                top: 85px;
                right: 20px;
                width: 356px;
                background: #1e2430;
                color: #f1f5f9;
                border-radius: 12px;
                box-shadow: 0 10px 25px rgba(0, 0, 0, 0.45);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                z-index: 999999;
                font-size: 13px;
                overflow: hidden;
                border: 1px solid #334155;
            }
            #wme-need-a-road-header {
                background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
                padding: 10px 14px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                cursor: pointer;
                user-select: none;
            }
            #wme-need-a-road-header h4 {
                margin: 0;
                font-size: 14px;
                font-weight: 700;
                display: flex;
                align-items: center;
                gap: 6px;
                color: #ffffff;
            }
            .nar-badge {
                background: #ff2d55;
                color: #fff;
                border-radius: 10px;
                padding: 1px 7px;
                font-size: 11px;
                font-weight: bold;
            }
            .nar-zoom-pill {
                background: rgba(0,0,0,0.3);
                color: #38bdf8;
                border: 1px solid #38bdf8;
                border-radius: 10px;
                padding: 2px 7px;
                font-size: 10.5px;
                font-weight: 600;
                cursor: pointer;
            }
            .nar-zoom-pill.nar-zoom-warning {
                color: #fbbf24;
                border-color: #fbbf24;
                background: rgba(245, 158, 11, 0.22);
            }
            #wme-need-a-road-body {
                padding: 12px;
                max-height: 550px;
                overflow-y: auto;
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
                border-radius: 6px;
                padding: 7px 8px;
                font-size: 11px;
                font-weight: 600;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                transition: background 0.15s, opacity 0.15s;
            }
            .nar-btn:disabled { opacity: 0.55; cursor: not-allowed; }
            .nar-btn:hover:not(:disabled) { background: #0369a1; }
            .nar-btn-secondary { background: #334155; color: #cbd5e1; }
            .nar-btn-secondary:hover:not(:disabled) { background: #475569; }
            .nar-btn-crawler { background: #8b5cf6; color: #fff; }
            .nar-btn-crawler:hover:not(:disabled) { background: #7c3aed; }
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
                color: #e2e8f0;
                border: 1px solid #475569;
                border-radius: 4px;
                padding: 3px 7px;
                font-size: 11px;
                cursor: pointer;
                flex-shrink: 0;
            }
            .nar-icon-btn:hover { background: #475569; }
            .nar-stats {
                background: #0f172a;
                border-radius: 8px;
                padding: 8px 10px;
                margin-bottom: 10px;
                font-size: 11px;
                display: flex;
                justify-content: space-around;
                border: 1px solid #1e293b;
            }
            .nar-stat-item { text-align: center; }
            .nar-stat-num { font-size: 14px; font-weight: bold; color: #38bdf8; }
            .nar-stat-label { color: #94a3b8; font-size: 10px; }
            .nar-status-box {
                font-size: 11px;
                color: #cbd5e1;
                background: #0f172a;
                border-left: 3px solid #0284c7;
                padding: 6px 8px;
                border-radius: 4px;
                margin-bottom: 10px;
                min-height: 26px;
                display: flex;
                align-items: center;
            }
            .nar-crawler-box {
                background: #131b2e;
                border: 1px solid #3b82f6;
                border-radius: 8px;
                padding: 9px;
                margin-bottom: 10px;
            }
            .nar-alert-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .nar-alert-card {
                background: #182234;
                border: 1px solid #334155;
                border-left: 4px solid #ff2d55;
                border-radius: 6px;
                padding: 8px;
                transition: transform 0.1s, border-color 0.1s;
            }
            .nar-alert-card:hover { border-color: #ff2d55; }
            .nar-alert-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 4px;
            }
            .nar-alert-title { font-weight: 700; color: #f8fafc; font-size: 12px; }
            .nar-alert-meta { font-size: 10.5px; color: #94a3b8; margin-bottom: 7px; }
            .nar-card-actions { display: flex; gap: 5px; }
            .nar-action-btn {
                background: #334155;
                color: #f1f5f9;
                border: none;
                border-radius: 4px;
                padding: 4px 6px;
                font-size: 10.5px;
                cursor: pointer;
                flex: 1;
                font-weight: 600;
                text-align: center;
            }
            .nar-action-btn:hover { background: #475569; }
            .nar-action-btn-draw { background: #10b981; color: #fff; }
            .nar-action-btn-draw:hover { background: #059669; }
            .nar-action-btn-dismiss { background: #475569; color: #94a3b8; flex: 0.5; }
            .nar-action-btn-dismiss:hover { background: #64748b; color: #fff; }
            .nar-settings-toggle {
                font-size: 11px;
                color: #38bdf8;
                cursor: pointer;
                text-align: right;
                margin-top: 10px;
                user-select: none;
            }
            .nar-settings-drawer {
                display: none;
                background: #0f172a;
                border-radius: 6px;
                padding: 8px;
                margin-top: 8px;
                font-size: 11px;
            }
            .nar-setting-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 6px;
            }
            .nar-setting-row input[type="number"] {
                width: 68px;
                background: #1e293b;
                border: 1px solid #475569;
                color: #fff;
                border-radius: 4px;
                padding: 2px 4px;
            }
            .nar-toast {
                position: fixed;
                bottom: 24px;
                right: 24px;
                background: #0f172a;
                color: #fff;
                padding: 10px 16px;
                border-radius: 8px;
                border-left: 4px solid #0284c7;
                box-shadow: 0 4px 15px rgba(0,0,0,0.4);
                font-size: 12px;
                z-index: 1000000;
                transition: opacity 0.3s;
            }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'wme-need-a-road-panel';
        panel.innerHTML = `
            <div id="wme-need-a-road-header">
                <h4>🛣️ ${SCRIPT_NAME}</h4>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span id="nar-zoom-pill" class="nar-zoom-pill" title="Click to zoom to level 18">Zoom 18</span>
                    <span id="nar-stretch-count" class="nar-badge" style="display:none;">0</span>
                    <span id="nar-toggle-btn" style="color:#fff; font-size:14px;">${settings.panelCollapsed ? '▲' : '▼'}</span>
                </div>
            </div>
            <div id="wme-need-a-road-body" style="display:${settings.panelCollapsed ? 'none' : 'block'};">
                <div class="nar-btn-row">
                    <button id="nar-btn-scan" class="nar-btn">
                        <span>🔍</span> Scan View
                    </button>
                    <button id="nar-btn-layers" class="nar-btn nar-btn-secondary" title="Turn on ROADS and GPS layers (Shift+G)">
                        <span>👁️</span> Layers ON
                    </button>
                    <button id="nar-btn-copyall" class="nar-btn nar-btn-copyall" title="Copy all Zoom 18 permalinks to clipboard">
                        <span>📋</span> Copy All PLs
                    </button>
                </div>

                <!-- Permission Bounded Crawler Section -->
                <div class="nar-crawler-box">
                    <div style="font-weight:bold; font-size:11px; margin-bottom:5px; color:#38bdf8; display:flex; justify-content:space-between; align-items:center;">
                        <span id="nar-crawler-title">🌐 Editable Area Crawler (Zoom ${settings.crawlerZoomLevel}+)</span>
                        <span id="nar-crawler-progress-label" style="color:#94a3b8; font-weight:normal;"></span>
                    </div>
                    <div style="display:flex; gap:5px; margin-bottom:7px;">
                        <select id="nar-crawler-area-select" style="flex:1; min-width:0; background:#1e293b; color:#fff; border:1px solid #475569; border-radius:4px; padding:4px; font-size:11px;">
                            <option value="0" data-area-id="current_viewport">📍 Current Viewport (Screen)</option>
                        </select>
                        <button id="nar-btn-refresh-areas" class="nar-icon-btn" title="Reload Editable & Managed Areas">🔄</button>
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
                        <div class="nar-stat-label">GPS Samples</div>
                    </div>
                    <div class="nar-stat-item">
                        <div id="nar-stat-covered" class="nar-stat-num" style="color:#10b981;">0</div>
                        <div class="nar-stat-label">On Road</div>
                    </div>
                    <div class="nar-stat-item">
                        <div id="nar-stat-unmapped" class="nar-stat-num" style="color:#ff2d55;">0</div>
                        <div class="nar-stat-label">No Road</div>
                    </div>
                </div>

                <div id="nar-status" class="nar-status-box">
                    Ready. Click 'Scan View' or 'Start Area Crawl'.
                </div>

                <div id="nar-alerts-container" class="nar-alert-list"></div>

                <div id="nar-settings-link" class="nar-settings-toggle">⚙️ Settings & Filter Tuning ▼</div>
                <div id="nar-settings-drawer" class="nar-settings-drawer">
                    <div class="nar-setting-row">
                        <span>Crawl Zoom Level (18–22):</span>
                        <input type="number" id="nar-cfg-crawlzoom" value="${settings.crawlerZoomLevel}" min="18" max="22" step="1" />
                    </div>
                    <div class="nar-setting-row">
                        <span>Road Tolerance (Meters):</span>
                        <input type="number" id="nar-cfg-thresh" value="${settings.proximityThresholdMeters}" min="2" max="60" step="1" />
                    </div>
                    <div class="nar-setting-row">
                        <span>Min GPS Points/Stretch:</span>
                        <input type="number" id="nar-cfg-minpts" value="${settings.minPointsPerStretch}" min="1" max="20" step="1" />
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
                        <span>Auto-scan on map pan (Z18+):</span>
                        <input type="checkbox" id="nar-cfg-autoscan" ${settings.autoScanOnMove ? 'checked' : ''} />
                    </div>
                    <div class="nar-setting-row">
                        <span>Audio Chime on Alert:</span>
                        <input type="checkbox" id="nar-cfg-sound" ${settings.soundAlerts ? 'checked' : ''} />
                    </div>
                    <div style="display:flex; justify-content:space-between; gap:6px; margin-top:8px;">
                        <button id="nar-btn-reset-dismissed" class="nar-action-btn" style="padding:4px 6px;">🔄 Reset Dismissed (${dismissedStretches.size})</button>
                        <button id="nar-btn-clear" class="nar-action-btn" style="padding:4px 6px;">🧹 Clear Overlays</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        // Bind Events
        document.getElementById('wme-need-a-road-header').onclick = (e) => {
            if (e.target.id === 'nar-zoom-pill') return;
            togglePanel();
        };
        document.getElementById('nar-zoom-pill').onclick = (e) => {
            e.stopPropagation();
            zoomTo18AndScan();
        };
        document.getElementById('nar-btn-scan').onclick = () => {
            if (getCurrentZoom() < 18) {
                zoomTo18AndScan();
            } else {
                runScanner();
            }
        };
        document.getElementById('nar-btn-layers').onclick = () => {
            ensureRequiredLayers();
            showToast('ROADS and GPS points layers enabled!', 'info');
            if (getCurrentZoom() >= 18) debounceScan(500);
        };
        document.getElementById('nar-btn-copyall').onclick = copyAllPermalinks;

        document.getElementById('nar-btn-refresh-areas').onclick = () => {
            populateAreaPicker(true);
        };
        document.getElementById('nar-crawler-area-select').onchange = (e) => {
            const chosenId = e.target.options[e.target.selectedIndex]?.dataset?.areaId || null;
            if (crawlerState.status === 'stopped' && chosenId !== crawlerState.selectedAreaId) {
                // Switching to a different area while stopped resets buttons to Start Area Crawl
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
            showToast('Highlights cleared.', 'info');
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
        settingsLink.onclick = () => {
            const isVisible = settingsDrawer.style.display === 'block';
            settingsDrawer.style.display = isVisible ? 'none' : 'block';
            settingsLink.textContent = isVisible ? '⚙️ Settings & Filter Tuning ▼' : '⚙️ Settings & Filter Tuning ▲';
        };

        document.getElementById('nar-cfg-crawlzoom').onchange = (e) => {
            const val = Math.max(18, Math.min(22, parseInt(e.target.value, 10) || 18));
            e.target.value = val;
            settings.crawlerZoomLevel = val;
            saveSettings();
            const titleEl = document.getElementById('nar-crawler-title');
            if (titleEl) titleEl.textContent = `🌐 Editable Area Crawler (Zoom ${val}+)`;
        };
        document.getElementById('nar-cfg-thresh').onchange = (e) => {
            settings.proximityThresholdMeters = Math.max(2, parseFloat(e.target.value) || 6);
            saveSettings();
            if (getCurrentZoom() >= 18) debounceScan(250);
        };
        document.getElementById('nar-cfg-minpts').onchange = (e) => {
            settings.minPointsPerStretch = Math.max(1, parseInt(e.target.value, 10) || 3);
            saveSettings();
            if (getCurrentZoom() >= 18) debounceScan(250);
        };
        document.getElementById('nar-cfg-cluster').onchange = (e) => {
            settings.clusterDistanceMeters = Math.max(15, parseFloat(e.target.value) || 60);
            saveSettings();
            if (getCurrentZoom() >= 18) debounceScan(250);
        };
        document.getElementById('nar-cfg-delay').onchange = (e) => {
            settings.crawlerStepDelayMs = Math.max(800, parseInt(e.target.value, 10) || 1800);
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
                btn.innerHTML = '<span>🔍</span> Zoom to 18 &amp; Scan';
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
        const body = document.getElementById('wme-need-a-road-body');
        const toggleIcon = document.getElementById('nar-toggle-btn');
        if (body.style.display === 'none') {
            body.style.display = 'block';
            toggleIcon.textContent = '▼';
            settings.panelCollapsed = false;
        } else {
            body.style.display = 'none';
            toggleIcon.textContent = '▲';
            settings.panelCollapsed = true;
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
            btn.innerHTML = '<span>🔍</span> Zoom to 18 &amp; Scan';
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
            card.style.borderColor = '#38bdf8';
            setTimeout(() => { card.style.borderColor = '#ff2d55'; }, 1500);
        }
    }

    function renderAlertList() {
        const container = document.getElementById('nar-alerts-container');
        const badge = document.getElementById('nar-stretch-count');
        const statGps = document.getElementById('nar-stat-gps');
        const statCovered = document.getElementById('nar-stat-covered');
        const statUnmapped = document.getElementById('nar-stat-unmapped');

        if (statGps) statGps.textContent = currentResults.totalGpsInView;
        if (statCovered) statCovered.textContent = currentResults.coveredGpsCount;
        if (statUnmapped) statUnmapped.textContent = currentResults.unmappedGpsCount;

        if (badge) {
            if (currentResults.stretches.length > 0) {
                badge.textContent = currentResults.stretches.length;
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        }

        if (!container) return;
        container.innerHTML = '';

        if (currentResults.stretches.length === 0) {
            if (currentResults.totalGpsInView > 0 && crawlerState.status !== 'running') {
                container.innerHTML = `
                    <div style="text-align:center; color:#94a3b8; padding:12px; font-size:12px;">
                        🎉 All detected GPS traces have drivable road segments underneath!
                    </div>
                `;
            }
            return;
        }

        currentResults.stretches.forEach((stretch) => {
            const card = document.createElement('div');
            card.id = `nar-card-${stretch.id}`;
            card.className = 'nar-alert-card';
            card.innerHTML = `
                <div class="nar-alert-header">
                    <span class="nar-alert-title">🚨 Stretch #${stretch.id}</span>
                    <span style="font-size:10px; color:#ff2d55; font-weight:bold;">${stretch.pointCount} GPS pts</span>
                </div>
                <div class="nar-alert-meta">
                    Approx length: <b>~${stretch.approxLengthMeters}m</b> | ${stretch.centerLat.toFixed(5)}, ${stretch.centerLon.toFixed(5)}
                </div>
                <div class="nar-card-actions">
                    <button class="nar-action-btn nar-action-btn-draw" id="nar-draw-${stretch.id}" title="Center at Zoom 18 and add draft Street">
                        🛣️ Draw Road
                    </button>
                    <button class="nar-action-btn" id="nar-goto-${stretch.id}" title="Center at Zoom 18">
                        🎯 Go to
                    </button>
                    <button class="nar-action-btn" id="nar-copy-${stretch.id}" title="Copy Zoom 18 permalink">
                        🔗 Copy PL
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

            card.querySelector(`#nar-goto-${stretch.id}`).onclick = () => {
                if (crawlerState.status === 'running') pauseGridCrawler();
                goToLocationAndVerifyZoom(stretch.centerLat, stretch.centerLon, 18);
                showToast(`Centered on Stretch #${stretch.id} at Zoom 18`, 'info');
            };

            card.querySelector(`#nar-copy-${stretch.id}`).onclick = (e) => {
                copyToClipboard(stretch.permalink);
                const btn = e.currentTarget;
                btn.textContent = '✅ Copied!';
                setTimeout(() => { btn.textContent = '🔗 Copy PL'; }, 1500);
                showToast('Zoom 18 Permalink copied to clipboard!', 'success');
            };

            card.querySelector(`#nar-dismiss-${stretch.id}`).onclick = () => {
                const key = `${stretch.centerLat.toFixed(4)}_${stretch.centerLon.toFixed(4)}`;
                dismissedStretches.add(key);
                saveDismissed();
                const resetBtn = document.getElementById('nar-btn-reset-dismissed');
                if (resetBtn) resetBtn.textContent = `🔄 Reset Dismissed (${dismissedStretches.size})`;
                showToast(`Stretch #${stretch.id} dismissed and remembered.`, 'info');
                currentResults.stretches = currentResults.stretches.filter(s => s.id !== stretch.id);
                renderAlertList();
                renderHighlights(currentResults.stretches, currentResults.stretches.flatMap(s => s.points));
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
        if (settings.autoScanOnMove && crawlerState.status !== 'running' && getCurrentZoom() >= 18) {
            debounceScan(650);
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
                sdkBound = true;
            } catch (e) {}
        }

        if (!sdkBound && win.W && win.W.map && win.W.map.events && typeof win.W.map.events.register === 'function') {
            win.W.map.events.register('moveend', null, onViewportChanged);
            win.W.map.events.register('zoomend', null, onViewportChanged);
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

        injectUI();
        ensureRequiredLayers();
        setupMapListeners();

        // Refresh Editable Areas as user profile & map models finish hydrating
        setTimeout(() => populateAreaPicker(), 1200);
        setTimeout(() => populateAreaPicker(), 3500);
        setTimeout(() => populateAreaPicker(), 7000);

        setTimeout(() => {
            updateZoomPill();
            const z = getCurrentZoom();
            if (z >= 18) {
                runScanner();
            } else {
                updateStatusText(`Map is at Zoom ${z}. GPS traces require Zoom 18+. Click 'Zoom to 18 & Scan' or 'Start Area Crawl'!`);
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
