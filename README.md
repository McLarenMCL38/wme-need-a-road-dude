# WME Need a Road, Dude! 🛣️

**Author**: McLaren with assistive AI

A userscript for the **Waze Map Editor (WME)** that spots unmapped roads, compiles a persistent work queue of stretches to fix at your own pace, scans **4 km²** and **20 km²** window areas (or your Editable Areas) at **Zoom 18+**, draws clean minimal-node draft roads, and exports Zoom 18 permalinks.

---

## 🚀 Key Features

* **📋 Persistent Compiled Work Queue (Saved Across Sessions)**:
  * Discovered missing-road stretches are compiled into a persistent queue (`localStorage`) so you can fix a few today and continue tomorrow without losing your list.
  * Clicking **`[ 🎯 Go ]`** or **`[ 🛣️ Draw ]`** keeps your entire compiled list intact while centering on that stretch.
  * Export your queue anytime with **`[ 💾 CSV ]`** (spreadsheet download) or **`[ 📋 Copy PLs ]`** (formatted Zoom 18 permalinks), mark fixed stretches with **`[ ✅ Done ]`**, or clear with **`[ 🗑️ Clear ]`**.

* **⠿ Draggable Panel & Compact Fixer Mini-Window**:
  * Grab the blue header bar to **drag the window anywhere** on screen (position is remembered across reloads).
  * Automatically shrinks into a sleek **Compact Fixer Bar** once a scan finishes (`◀ Prev` / `Next ▶` stepper, `🎯 Go`, `🛣️ Draw`, `✅ Done`, `🔗`, `✖️`) so it stays out of your way while editing roads.
  * Click **`⤡` / `⤢`** in the header anytime to switch between **Compact Fixer Mode** and **Full Panel Mode**.

* **🌐 4 km², 20 km² & Editable Area Scanner (Zoom 18+)**:
  * Built-in window-centered scan presets:
    * **`🗺️ Surrounding Window (4 km²)`** — quick `2 × 2 km` sweep around your current WME view.
    * **`🌐 Wide Surrounding Window (20 km²)`** — broader `4.5 × 4.5 km` regional sweep around your current WME view.
    * **`🛡️ My Editable / Managed Areas`** — automatically loaded from your WME permissions.
    * **`📍 Current Viewport (Screen)`** — scans just the current screen bounds.
  * Strictly navigates and scans at **Zoom 18+** with **`[ ⏸️ Pause ]`**, **`[ ⏹️ Stop ]`**, **`[ ▶️ Resume ]`**, and **`[ 🔄 Restart ]`**.

* **🛣️ Straight, Minimal-Node "Draw Road" Action**:
  * Filters out GPS trace scatter and lane-to-lane jumping using **PCA orthogonal regression**, **cross-track centerline averaging**, and **Ramer–Douglas–Peucker (RDP)** simplification.
  * Straight roads are drawn as a **pure 2-point segment (zero intermediate geometry nodes)**, and curved or bent roads use the **minimum possible bend nodes** so editors only need to connect junctions, name, and save.

* **Drivable Road Filtering & Dismiss Memory**:
  * Only drivable roads (Streets, Primary Streets, Highways, Freeways, Ramps, Parking Lots, Private & Dirt Roads) count as mapped—driver traces over walking trails or railroads are still flagged.
  * Click **`[ ✖️ ]`** to permanently dismiss false positives (resettable anytime in Settings).

---

## 📥 Installation

1. Install **[Tampermonkey](https://www.tampermonkey.net/)** (Recommended) or **[Violentmonkey](https://violentmonkey.github.io/)**.
2. **One-Click Install from GitHub**:
   * Open `wme-need-a-road.user.js` in this repository and click the **Raw** button—your userscript manager will prompt you to click **Install**.
   * *(Manual alternative)*: In Tampermonkey, click **Dashboard** ➔ **Utilities** ➔ **Import from file** ➔ choose `wme-need-a-road.user.js`.
3. Refresh [Waze Map Editor](https://www.waze.com/editor).

---

## ⚙️ Configuration & Settings

Click **`⚙️ Settings & Filter Tuning ▼`** inside the full panel:

| Setting | Default | Description |
| :--- | :---: | :--- |
| **Crawl Zoom Level (18–22)** | `18` | Zoom level used during area crawling (`18+` required for GPS traces). |
| **Road Tolerance (Meters)** | `6m` | Max distance to an existing drivable segment to consider GPS covered. |
| **Draw Straightening (Meters)** | `8m` | Simplification tolerance when drawing roads (higher = straighter, fewer nodes). |
| **Min GPS Points/Stretch** | `3` | Minimum unmapped GPS samples required to queue a stretch. |
| **Cluster Radius (Meters)** | `60m` | Grouping radius for neighboring unmapped GPS points. |
| **Crawler Tile Delay (ms)** | `1800ms` | Wait time per tile during crawling to fetch & render GPS tiles. |
| **Shrink to Mini Window after scan** | `Enabled` | Automatically switches to the compact draggable Fixer Bar when a scan finishes. |
| **Auto-scan on map pan (Z18+)** | `Enabled` | Passively appends newly spotted stretches to your queue when panning at Zoom 18+. |
| **Audio Chime on Alert** | `Disabled` | Plays a subtle chime whenever new stretches are added to the queue. |

---

## 🗞️ Update Notes / Changelog

### v1.4.0 — *"The 'Stop Touching My List & Sober Up the Road' Update"*
* 🧠 **Amnesia Cured (Persistent Compiled Queue)**: Clicking **Go** or **Draw** used to make the rest of your scanned list pull a Houdini and vanish. Fixed! Discovered stretches now stay in a persistent queue saved in `localStorage`—fix three roads today, close WME, and pick right back up tomorrow (or export to **CSV**).
* 📐 **Sober Road Drawing (Minimal Geometry Nodes)**: Raw GPS traces bounce around like a shopping cart with a wobbly wheel. **Draw** now runs orthogonal centerline regression + Ramer–Douglas–Peucker simplification so straight roads draw as a **clean 2-point line with zero extra nodes**, and real curves use the bare minimum nodes needed.
* 🪶 **Draggable Panel + Auto-Shrinking Mini Fixer**: The script bar no longer camps on top of your map like an uninvited backseat driver. Drag it anywhere by the `⠿` header, and enjoy automatic **Compact Fixer Mode** after a scan finishes (`◀` / `▶` stepper, `🎯 Go`, `🛣️ Draw`, `✅ Done`).
* 🗺️ **4 km² & 20 km² Window Sweeps**: Added a **4 km²** quick-scan preset (coffee-break size) and a **20 km²** wide-scan preset (weekend-warrior size) centered right on your current WME window.
* ✂️ **Cleaner Name & Description**: Trimmed the clunky technical subtitle off the script header and repo description.

### v1.3.0 — *"Zoom 18 or Bust"*
* 🔭 Fixed the OpenLayers zoom-offset quirk that was scanning at Zoom 16 (where GPS points hide) instead of **Zoom 18+**.
* 🛡️ Added multi-source Editable & Managed Area loading (`MultiPolygon` support) whether or not the Editable Areas layer is switched on.
* ▶️ Made **both Pause and Stop** turn the next primary button into **Resume**.

