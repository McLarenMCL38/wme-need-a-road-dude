# WME Need a Road, Dude! 🛣️

**Credits**:
* **Original Idea, Feature Direction, Updates & Improvements**: **McLaren**
* **Coding, Technical Architecture, Algorithms & Improvements**: **Antigravity AI**

A userscript for the **Waze Map Editor (WME)** that spots unmapped roads, compiles a persistent work queue of stretches to fix at your own pace, scans **4 km²** and **20 km²** window areas (or your Editable Areas) at **Zoom 18+**, draws straight minimal-node roads with **auto-snapped junctions, inherited City/State & One-Way detection**, and exports Zoom 18 permalinks.

---

## 🚀 Key Features

* **🔌 Smart Road Creation (`[ 🛣️ Draw ]`)**:
  * **Rank-Safe Junction Auto-Snap**: Automatically bridges the ~18m corridor gap to snap onto existing nodes or split & connect a real junction (with turns enabled!) when you have lock permission—or stops cleanly `4m` short if the road outranks you or is a Freeway.
  * **Save-Ready Address & Matched Lock Rank**: Inherits **City & State** from the connected neighbor road, sets **Street Name to `None`** so WME doesn't block saving on unnamed roads, and matches the connected road's **Lock Rank** (capped at your own editor rank).
  * **GPS Color-by-Azimuth One-Way Detection**: Analyzes Waze's rainbow directional GPS arrow hues (`0°–360°`)—setting high-confidence **One-Way** flow automatically and safely defaulting to **Two-Way** otherwise.
  * **Road-Type Reminder & Auto-Advance on WME Save**: Selects the new Street immediately in WME, reminds you to verify **Road Type** (flagging if inside a `🅿️ Parking Lot` or `Gas Station`), and **automatically marks the stretch Done & jumps to the next queued stretch** when you save in WME!

* **🩵 Draggable Waze-Blue UI & Auto-Shrinking Fixer Bar**:
  * Styled in iconic **Waze `#33CCFF` blue** with crisp high-visibility Zoom & UI typography and **Settings & Filter Tuning right at the top**.
  * Smoothly **draggable anywhere on screen** via `document`-capture mouse/pointer/touch listeners, and auto-folds into a compact **Fixer Bar** (`◀` / `▶`, `🎯 Go`, `🛣️ Draw`, `✅ Done`, `🔗`, `✖️`) after scanning.

* **🕸️ Precision Filtering (Zero Existing-Road Halos or Indoor Spiderwebs)**:
  * **Road-Type-Aware Corridors**: `18m` for Streets up to `28m` for Freeways, plus parallel GPS-shadow rejection.
  * **Spiderweb Indoor Drift Rejection**: Filters out boxy, chaotic multi-directional indoor GPS drift blobs while keeping real `25m+` roads, driveways, Parking Lots, and Gas Stations.
  * **Editable Area Guard**: `4 km²` and `20 km²` scans automatically skip stretches & tiles outside your WME Editable Area by default (toggleable in Settings).

* **📋 Persistent Compiled Work Queue**:
  * Saved in `localStorage` across sessions—never wiped when panning or clicking **Go** / **Draw**, with **`💾 CSV`** export and **`📋 Copy PLs`**.

---

## 📥 Installation

1. Install **[Tampermonkey](https://www.tampermonkey.net/)** (Recommended) or **[Violentmonkey](https://violentmonkey.github.io/)**.
2. **One-Click Install & Auto-Update**:
   * 👉 **[Click here to Install `wme-need-a-road.user.js`](https://github.com/McLarenMCL38/wme-need-a-road-dude/raw/refs/heads/main/wme-need-a-road.user.js)** — Tampermonkey/Violentmonkey will open the install prompt automatically and auto-check GitHub for future updates!
   * *(Manual alternative)*: In Tampermonkey, click **Dashboard** ➔ **Utilities** ➔ **Import from file** ➔ choose `wme-need-a-road.user.js`.
3. Refresh [Waze Map Editor](https://www.waze.com/editor).

---

## ⚙️ Configuration & Settings (Top of Panel)

| Setting | Default | Description |
| :--- | :---: | :--- |
| **Crawl Zoom Level (18–22)** | `18` | Zoom level used during area crawling (`18+` required for GPS traces). |
| **Road Corridor (Meters)** | `18m` | Street coverage corridor (`18m` streets, auto-scales up to `28m` on freeways). |
| **Draw Straightening (Meters)** | `8m` | Simplification tolerance when drawing roads (higher = straighter, fewer nodes). |
| **Min GPS Points/Stretch** | `4` | Minimum unmapped GPS samples required to queue a stretch. |
| **Cluster Radius (Meters)** | `55m` | Grouping radius for neighboring unmapped GPS points. |
| **Crawler Tile Delay (ms)** | `1800ms` | Wait time per tile during crawling to fetch & render GPS tiles. |
| **Only inside my Editable Area** | `Enabled` | Automatically skips stretches and crawl tiles outside your WME Editable Area. |
| **Shrink to Mini Window after scan** | `Enabled` | Switches to the compact draggable Fixer Bar when a scan finishes. |
| **Auto-scan on map pan (Z18+)** | `Enabled` | Passively appends newly spotted stretches to your queue when panning at Zoom 18+. |
| **Audio Chime on Alert** | `Disabled` | Plays a subtle chime whenever new stretches are added to the queue. |

---

## 🗞️ Update Notes / Changelog

### v1.5.0 — *"The 'Snap Decisions, Spiderweb Buster & Waze-Blue Makeover' Update"*
* 🔌 **Look Ma, Real Junctions! (Smart Road Creation)**: **Draw** stopped leaving an awkward 18-meter social-distancing gap before existing roads! It now rank-safely extends, splits, and snaps a real junction (or politely stops `4m` short if the road outranks you or is a Freeway), auto-inherits **City & State**, ticks **Street Name to `None`**, matches the connected **Lock Rank** (capped at yours), reads Waze's rainbow GPS arrow colors to spot **One-Way** traffic, reminds you to double-check **Road Type**, and auto-completes the stretch when you hit **Save** in WME!
* 🕸️ **Evicted Couch-Potato GPS Spiderwebs & Border Hoppers**: Someone leaving Waze open on their living-room sofa no longer convinces us there's a cul-de-sac in their kitchen (indoor spiderweb drift rejected!), and `4 km²` / `20 km²` scans now stay strictly inside your **Editable Area** by default.
* 🩵 **Waze-Blue Makeover + True Glide Dragging + Bigger Fonts**: Dressed the header in iconic **`#33CCFF` Waze logo blue**, moved **Settings & Filter Tuning** right to the top, bumped up Zoom & panel font sizes, and upgraded dragging to `document`-level capture so the window glides smoothly everywhere.

### v1.4.1 — *"The 'Un-Glued, De-Polka-Dotted & Less Paranoid' Patch"*
* 🧲 **WD-40 on the Title Bar**: Replaced sandbox-swallowed pointer capture with global mouse/touch listeners.
* 🎨 **No More Chickenpox on the Map**: Replaced glowing red GPS dot swarms with sleek, smoothed road-corridor highlights.
* 🎯 **Stopped Yelling at Existing Roads**: Upgraded from `6m` to road-type-aware corridors (`18m`–`28m`) + parallel GPS-shadow rejection.

### v1.4.0 — *"The 'Stop Touching My List & Sober Up the Road' Update"*
* 🧠 **Persistent Compiled Queue**: Queue survives `Go` / `Draw`, map pans, and browser restarts (+ CSV export).
* 📐 **Sober Road Drawing**: 2D PCA orthogonal regression + RDP minimal-node road straightening.
* 🪶 **Compact Fixer Mode & 4 km² / 20 km² Sweeps**: Auto-shrinking mini toolbar and window-centered area presets.
