# Deployment & Troubleshooting Guide

This document describes how to deploy, configure, run, and troubleshoot the KSPDB Outage Ingestion and Localization system.

---

## 1. Prerequisites

Ensure you have the following software installed:
* **Docker** (v24.0.0 or higher)
* **Docker Compose** (v2.0.0 or higher)
* **Node.js** (v20.x.x - only required if running locally without Docker)
* **npm** (v10.x.x - only required if running locally without Docker)

---

## 2. Configuration (`.env`)

Create a `.env` file in the root of the project. The system exposes these variables:

```ini
PORT=3001
NODE_ENV=production
DB_PATH=./kspdb.db
GEMINI_API_KEY=your-gemini-api-key-optional
```

* **`GEMINI_API_KEY` (Optional):** If provided, the AI Co-Pilot will connect to the live Gemini 1.5 Flash model. If left empty, the system falls back to an intelligent mock responder.

---

## 3. Running the Stack

To build and launch the application in a single Docker container, execute:

```bash
# Clone the repository
git clone <repository-url>
cd KSPDB-Localization

# Start in Docker
docker compose up --build
```

On startup, Docker will:
1. Compile the React frontend assets.
2. Compile the Express TypeScript files.
3. Automatically run `dist/backend/seed.js` to create and seed the SQLite database.
4. Expose the server on port `3001` of your host machine.

---

## 4. Verification

1. Open your browser and navigate to `http://localhost:3001`.
2. You should see a dark-themed KSPDB Outage Locator Dashboard immediately.
3. The interactive SCADA map in the center should be populated with the synthetic Bangalore Richmond Road power grid.
4. Verify the database works by switching to the **Outage Simulator** tab, selecting a span, and clicking **Inject Fault**. You should see telemetry packets stream in the terminal window and a red pulsing line on the map.

---

## 5. Local Development (Alternative)

If you wish to run the backend and frontend separately for development without Docker:

```bash
# Install dependencies
npm install

# Run seeder to initialize SQLite
npm run init-db

# Run dev mode (concurrently starts React dev server on 3000 and Express on 3001)
npm run dev
```

Open `http://localhost:3000` to access the development client.

---

## 6. Troubleshooting Section

Here are the solutions to issues you might encounter:

### Port 3001 Already in Use
* **Symptom:** Docker container fails to start, throwing `bind: address already in use` or `port is already allocated`.
* **Fix:** Change the port binding in `docker-compose.yml`. E.g., change `"3001:3001"` to `"3002:3001"`. The host URL will then be `http://localhost:3002`.

### SQLite DB File Lock (Local Dev)
* **Symptom:** Error `SQLITE_BUSY: database is locked` on Windows when running seeder and server simultaneously.
* **Fix:** We implement an in-memory batch write log queue that flushes every 500ms which resolves write-concurrency locks. If the issue occurs, restart the server.

### WebSocket Upgrades Behind Proxies
* **Symptom:** Dashboard connects, but the scrolling Telemetry Packet Monitor remains empty and says "Disconnected" or console logs show `WebSocket connection to 'ws://...' failed`.
* **Fix:** Ensure your proxy (e.g. Nginx or Cloudflare) has WebSockets enabled with appropriate headers:
  ```nginx
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  ```

### Free Tier Hosting Cold Starts
* **Symptom:** Deployed public URL takes 30-50 seconds to respond on first visit.
* **Fix:** This is normal behavior for free hosting tiers (e.g. Render, Koyeb) which spin down containers during idle times. Wait 1 minute for the container to wake up.
