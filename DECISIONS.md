# Architectural Decision Log (ADR)

This document logs the design decisions made during the development of the KSPDB Outage Localization System, including options rejected and assumptions made.

---

## 1. Tech Stack Selection

### Node.js (TypeScript) + Express
* **Chosen:** Extremely fast to write, highly scalable, and native asynchronous support fits the event-driven telemetry stream.
* **Rejected:** Python (Flask/FastAPI) - Node's event loop handles WebSockets and concurrent client pushes with less overhead.

### SQLite Database
* **Chosen:** Fits the "clean clone with one command" requirement perfectly. No database cluster to configure, no connection credential issues, and zero migration setup. SQLite easily handles $500+$ writes/sec when buffered in memory.
* **Rejected:** PostgreSQL or MongoDB - Required extra services in `docker-compose` which introduces potential startup race-conditions and increases memory overhead on free tiers.

### Interactive SVG SCADA Canvas
* **Chosen:** Self-contained, lightweight, and 100% immune to Leaflet CSS issues, missing map tile servers, or API key errors. It allows drawing beautiful glowing lines, zoom/pan controls, and visual dashed/solid line representations directly in the DOM.
* **Rejected:** Leaflet / Mapbox - React Leaflet is highly prone to marker asset load errors, and tile rendering requires internet access during evaluation.

---

## 2. Grid Topology & Reconstruction Decisions

### Prim's Minimum Spanning Tree (MST) for the 60% Missing Data
* **Chosen:** For transformers with missing pole order registry, we calculate the MST rooted at the DT. Electrical low-tension layout is optimized to minimize cable routes. By connecting poles using the minimum distance graph, we approximate the physical network layout.
* **Rejected:** DT-level fallback only - The brief requested a specific localized span. Falling back to DT-level is less precise. MST gives operators an approximate span range to investigate.

---

## 3. Assumptions Made

1. **Euclidean Coordinates:** For distances under 2 km (the max range of an LT line), Euclidean coordinate math is highly accurate and far faster than geodesic (Haversine) computations.
2. **Scheduled Outage Grace Windows:** Scheduled outages might start late or run over. We assume a 30-minute grace window before the start and a 60-minute window after the end, during which automatic ticketing is suppressed.
3. **Telemetry Watchdog Window:** Devices emit heartbeats every 15 minutes $\pm 45$ seconds. We assume a watchdog window of 16.5 minutes before marking a silent device as `offline`.

---

## 4. Future Roadmap & Technical Debt

With more time, we would implement:
* **Survey Upload API:** Allow operators to upload corrected topology files as they are digitized in the field, overriding the MST approximations.
* **Historical Outage Patterns:** Detect if a specific span has failed multiple times in a month, suggesting a replacement of physical cabling is needed.
* **Crew Routing Integration:** Integrate GPS trackers from crew vehicles to suggest the closest crew for dispatch.
