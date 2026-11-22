# WME Need a Road, Dude! 🛣️

**Author**: McLaren with assistive AI

A userscript for the **Waze Map Editor (WME)** that scans for driver GPS traces, cross-checks them against existing road segments, highlights missing roads, alerts editors, and generates direct permalinks at **zoom level 18**.

Now featuring a **Permission-Bounded Grid Crawler**, **Drivable Road Type Filtering**, **Semi-Automated Road Creation**, and **Bulk Permalinks Export**.

---

## 🚀 Key Features

* **Automatic Layer Management**:
  * Automatically turns on both **ROADS** and **GPS points** layers in WME upon startup and during scans.
  * Supports modern **WME JavaScript SDK** (`wmeSDK.LayerSwitcher`) and legacy OpenLayers / DOM toggles.

* **GPS vs. Segment Cross-Checking Logic**:
  * **`GPS + Segment` ➔ Ignore**: If GPS traces fall within proximity of an existing segment polyline (default: 6 meters), the script considers the road mapped and ignores them.
  * **Drivable Road Types Only**: Only drivable roads (Streets, Primary Streets, Highways, Freeways, Ramps, Parking Lots, Private Roads, Dirt Roads) count as existing roads. Non-drivable paths (Walking Trails, Pedestrian Boardwalks, Stairways, Railroads) **do not count**, so driver traces over a pedestrian trail are correctly flagged as needing a road!
  * **`GPS + No Segment` ➔ Highlight & Alert**: If GPS traces have **no drivable segment underneath**, the script clusters the stretch, highlights it with high-visibility glowing markers, and raises an alert.

* **🌐 Permission-Bounded Grid Crawler (Zoom 18+)**:
  * Automatically detects your WME **Editable Areas** and **Managed Areas** across WME SDK (`State.getUserInfo`, `DataModel.ManagedAreas`), `W.loginManager`, `W.model`, and map layers — whether or not the "Editable areas" map layer is toggled on.
  * Features an **Area Picker** dropdown (plus a **`🔄` Refresh** button) to crawl your full editable area, individual zones, current viewport, or surrounding region.
  * Strictly navigates and scans at **Zoom 18+** (configurable `18–22`), where WME loads and displays GPS traces.
  * Full state-preserving controls: **`[ 🚀 Start Area Crawl ]`**, **`[ ⏸️ Pause ]`**, **`[ ⏹️ Stop ]`**, **`[ ▶️ Resume ]`** (shown after both Pause and Stop!), and **`[ 🔄 Restart ]`**.

* **🛣️ Semi-Automated "Draw Road" Action**:
  * Each missing road alert card features a **`[ 🛣️ Draw Road ]`** button.
  * Automatically centers at **Zoom 18**, simplifies the GPS cluster into a center polyline, and inserts a draft two-way standard **Street (roadType 1)** on the map.
  * Connect the junction nodes, name the street, and save!

* **Direct Zoom 18 Permalinks & Bulk Export**:
  * Generates exact WME permalinks targeted at **`zoomLevel=18`** centered on the missing road stretch.
  * **`[ 🎯 Go to ]`**: Immediately centers and zooms the active map view to the stretch at zoom 18.
  * **`[ 🔗 Copy PL ]`**: Copies an individual zoom 18 permalink to your clipboard.
  * **`[ 📋 Copy All PLs ]`**: Copies a formatted report of all discovered missing road permalinks to share in Discord, Slack, or forum channels.

* **✖️ Dismiss & Persistent Storage**:
  * Found a false-positive (e.g., someone driving across an open farm)? Click **`[ ✖️ ]`** on the card.
  * Dismissed stretches are stored in your browser's `localStorage` and will not be flagged on future scans or crawler runs.
  * Click **`[ 🔄 Reset Dismissed ]`** in Settings anytime to restore them.

---

## 📥 Installation

1. Install a userscript manager browser extension:
   * **[Tampermonkey](https://www.tampermonkey.net/)** (Recommended) or **[Violentmonkey](https://violentmonkey.github.io/)**
2. **One-Click Install from GitHub**:
   * Open `wme-need-a-road.user.js` in this repository and click the **Raw** button in the top-right corner—Tampermonkey/Violentmonkey will automatically prompt you to click **Install**.
   * *(Manual alternative)*: In Tampermonkey, click **Dashboard** ➔ **Utilities** ➔ **Import from file** ➔ choose `wme-need-a-road.user.js` (or paste its contents into a new script and press `Ctrl+S`).
3. Navigate to or refresh [Waze Map Editor](https://www.waze.com/editor).

---

## 🕹️ How to Use

### Mode A: Interactive Viewport Editing
1. Pan and zoom around your editing area.
2. At **Zoom Level 18+** (where WME loads GPS traces), the script auto-scans for unmapped GPS traces. If you are below Zoom 18, click **`[ 🔍 Zoom to 18 & Scan ]`**.
3. If missing stretches are detected:
   * Click **`[ 🎯 Go to ]`** to jump to the location at zoom 18.
   * Click **`[ 🛣️ Draw Road ]`** to place a draft road along the trace.
   * Click **`[ 🔗 Copy PL ]`** to copy the permalink.

### Mode B: Regional Permission Grid Crawler
1. Open the script panel.
2. Under **Editable Area Crawler (Zoom 18+)**, select your editable/managed area from the dropdown (click **`🔄`** anytime to refresh areas).
3. Click **`[ 🚀 Start Area Crawl ]`**.
4. The script moves tile-by-tile at **Zoom 18+**, cross-referencing visible GPS traces against drivable road segments.
5. Press **`[ ⏸️ Pause ]`** or **`[ ⏹️ Stop ]`** anytime to edit roads — the primary button immediately changes to **`[ ▶️ Resume ]`** so you can pick up right where you left off!
6. When complete, click **`[ 📋 Copy All PLs ]`** to copy the complete list of zoom 18 permalinks!

---

## ⚙️ Configuration & Settings

Click **`⚙️ Settings & Filter Tuning ▼`** inside the panel:

| Setting | Default | Description |
| :--- | :---: | :--- |
| **Crawl Zoom Level (18–22)** | `18` | Zoom level used during area crawling (minimum `18` so GPS traces load). |
| **Road Tolerance (Meters)** | `6m` | Proximity threshold to an existing drivable road segment to consider GPS covered. |
| **Min GPS Points/Stretch** | `3` | Minimum off-road GPS points required to create an alert (filters single-point drift). |
| **Cluster Radius (Meters)** | `60m` | Proximity threshold to group neighboring unmapped points into one contiguous stretch. |
| **Crawler Tile Delay (ms)** | `1800ms` | Wait time per tile during crawling to allow WME to fetch & render GPS tiles. |
| **Auto-scan on map pan** | `Enabled` | Automatically runs cross-check when panning or zooming at Zoom 18+. |
| **Audio Chime on Alert** | `Disabled` | Plays a subtle chime whenever new missing road stretches are detected. |

---

## 📋 Cross-Check Logic & Road Types

```
Map Viewport / Crawler Tile Loaded
                │
                ▼
      Ensure ROADS & GPS Layers ON
                │
                ▼
Extract GPS Points & Loaded Drivable Segments
(Streets, Freeways, Ramps, Parking Lots, Private & Dirt Roads)
                │
                ▼
For Each GPS Point (px, py):
 ├─ Calculate perpendicular distance to drivable segment polylines
 ├─ Distance <= 6m?
 │       ├─ YES ➔ [GPS + Segment] ➔ IGNORE (Existing Road)
 │       └─ NO  ➔ [GPS + No Segment] ➔ UNMAPPED CANDIDATE
                │
                ▼
Cluster Unmapped Points into Stretches (>= Min Points)
Filter Out Previously Dismissed Coordinates
                │
                ▼
Visual Glowing Highlight + Zoom 18 Permalinks + "Draw Road" Action
```
