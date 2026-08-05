# KSPDB Grid Fault Ingestion & Localization System

An automated, real-time power grid outage detection and localization system built for the **Karnataka State Power Distribution Board (KSPDB)**.

This system consumes a high-speed telemetry stream from $\approx 34,900$ pole-mounted IoT sensors and identifies the exact boundary span of physical line breaks in minutes rather than hours, grouping downstream symptom alerts into single actionable tickets.

---

## Quick Start (One Command)

To run the entire system (backend server, WebSocket event bus, SQLite database, seeded grid data, and frontend operator console/simulator), execute this command from the repository root:

```bash
docker compose up --build
```

The system will:
1. Initialize the SQLite database.
2. Build the Vite + React frontend dashboard.
3. Seed the database with a synthetic power grid (Richmond Town, Bangalore) containing 3 feeders, 6 transformers, and 180 poles.
4. Start the Express server on port `3001`.

**Access the Operator Dashboard:** Go to `http://localhost:3001` in your browser.

---

## Submission Resources

* **GitHub Repository:** https://github.com/ashish03124/KSPDB-Localization.git
* **Live Deployed System:** `[Insert Public Deployment URL]`
* **5-Minute Demo Video:** `[Insert Loom/Drive/YouTube Link]`
  * *Watch a walk-through demonstrating: fault injection, automatic boundary localization, operator dispatch, and automated telemetry-driven closure.*

---

## Repository Documentation Map

The repository contains five core markdown documentation sheets at the root:

1. [README.md](README.md) - This file.
2. [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture diagram, data ingestion design, database schemas, our Prim-based Minimum Spanning Tree (MST) topology reconstruction algorithm, noise filtering, and AI integration.
3. [DEPLOYMENT.md](DEPLOYMENT.md) - Detailed deployment guide, configuration parameters, validation protocols, and an extensive troubleshooting section.
4. [DECISIONS.md](DECISIONS.md) - Architectural decision log (ADR) including rejected alternatives, documented assumptions, and future project roadmap.
5. [AI-WORKFLOW.md](AI-WORKFLOW.md) - Summary of AI tool usage, prompt templates, and examples of AI code generation failures that were manually corrected.
