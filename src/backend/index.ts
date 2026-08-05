import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import { getDb, initDb, sessionStore } from './db';
import { seed } from './seed';
import { telemetryService, telemetryEvents, TelemetryPayload } from './services/telemetry';
import { topologyService } from './services/topology';
import { localizationEngine } from './services/localization';
import { askCopilot } from './services/ai';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json());

// Track all active session IDs in a Set
const activeSessions = new Set<string>();

// Middleware to extract session ID and execute request in sessionStore context
app.use((req, res, next) => {
  const sessionId = (req.headers['x-session-id'] as string) || 'default';
  activeSessions.add(sessionId);
  
  sessionStore.run(sessionId, async () => {
    try {
      const db = await initDb();
      const feederCount = await db.get<{ count: number }>("SELECT COUNT(*) as count FROM feeders");
      if (!feederCount || feederCount.count === 0) {
        console.log(`[Auto-Seed] Initializing seed data into database for session: ${sessionId}...`);
        await seed();
      }
      await topologyService.loadAllTopologies();
    } catch (err) {
      console.error(`[Session: ${sessionId}] Failed to auto-initialize:`, err);
    }
    next();
  });
});

// --- WebSocket Broadcast Helper ---
function broadcast(sessionId: string, type: string, data: any) {
  const message = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && (client as any).sessionId === sessionId) {
      client.send(message);
    }
  });
}

// Listen to telemetry and ticket changes to broadcast to UI
telemetryEvents.on('telemetry', ({ payload, sessionId }) => {
  broadcast(sessionId, 'telemetry', payload);
});

// Watch SQLite database for ticket updates via localization updates per session
const lastTicketsJsonMap = new Map<string, string>();
setInterval(async () => {
  for (const sessionId of activeSessions) {
    await sessionStore.run(sessionId, async () => {
      try {
        const db = await getDb();
        const tickets = await db.all("SELECT * FROM tickets ORDER BY datetime(created_at) DESC");
        const ticketsJson = JSON.stringify(tickets);
        const lastTicketsJson = lastTicketsJsonMap.get(sessionId) || '';
        if (ticketsJson !== lastTicketsJson) {
          lastTicketsJsonMap.set(sessionId, ticketsJson);
          broadcast(sessionId, 'tickets', tickets);
        }
      } catch (err) {
        // Suppress polling logging
      }
    });
  }
}, 1000);

// --- REST Endpoints ---

// 1. Ingest Telemetry
app.post('/api/telemetry', async (req, res) => {
  try {
    const payload = req.body as TelemetryPayload;
    
    // Validate payload
    if (!payload.device_id || !payload.pole_id || !payload.event || payload.energized === undefined || !payload.ts || payload.seq === undefined) {
      return res.status(400).json({ error: 'Invalid telemetry payload' });
    }

    const processed = await telemetryService.ingest(payload);
    
    if (processed) {
      res.status(202).json({ status: 'queued' });
    } else {
      res.status(200).json({ status: 'skipped', reason: 'duplicate or out-of-order sequence' });
    }
  } catch (err: any) {
    console.error('Error in /api/telemetry:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Get Tickets
app.get('/api/tickets', async (req, res) => {
  try {
    const db = await getDb();
    const tickets = await db.all('SELECT * FROM tickets ORDER BY datetime(created_at) DESC');
    res.json(tickets);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Ticket Actions: Acknowledge
app.post('/api/tickets/:id/acknowledge', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.run(
      "UPDATE tickets SET status = 'acknowledged', updated_at = ? WHERE id = ? AND status = 'detected'",
      [new Date().toISOString(), req.params.id]
    );
    if (result.changes === 0) {
      return res.status(400).json({ error: 'Ticket not found or not in detected status' });
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Ticket Actions: Assign Crew
app.post('/api/tickets/:id/assign', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.run(
      "UPDATE tickets SET status = 'crew_assigned', updated_at = ? WHERE id = ? AND status IN ('detected', 'acknowledged')",
      [new Date().toISOString(), req.params.id]
    );
    if (result.changes === 0) {
      return res.status(400).json({ error: 'Ticket not found or not in valid status' });
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Ticket Actions: Resolve & Telemetry Verification
app.post('/api/tickets/:id/resolve', async (req, res) => {
  try {
    const db = await getDb();
    const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // TELEMETRY VERIFICATION:
    // Check if the affected area is actually energized.
    // Query all device-fitted poles in the affected scope.
    let darkPolesCount = 0;
    const now = Date.now();

    if (ticket.fault_type === 'feeder') {
      const devices = await db.all('SELECT * FROM devices WHERE pole_id IN (SELECT id FROM poles WHERE feeder_id = ?)', [ticket.target_id]);
      darkPolesCount = devices.filter(d => d.energized === 0 || (now - new Date(d.last_seen).getTime() > 16.5 * 60 * 1000)).length;
    } else if (ticket.fault_type === 'dt') {
      const devices = await db.all('SELECT * FROM devices WHERE pole_id IN (SELECT id FROM poles WHERE dt_id = ?)', [ticket.target_id]);
      darkPolesCount = devices.filter(d => d.energized === 0 || (now - new Date(d.last_seen).getTime() > 16.5 * 60 * 1000)).length;
    } else if (ticket.fault_type === 'span') {
      const lastDashP = ticket.target_id.indexOf('-P-');
      const childPoleId = lastDashP !== -1 ? ticket.target_id.substring(lastDashP + 1) : '';
      
      // Look up DT topology for this pole
      const poleDetails = await db.get('SELECT dt_id FROM poles WHERE id = ?', [childPoleId]);
      if (poleDetails) {
        const topo = topologyService.getTopology(poleDetails.dt_id);
        const childNode = topo?.nodes.get(childPoleId);
        
        if (childNode && topo) {
          // Find all downstream poles starting from childNode
          const collectDownstream = (nodeId: string, acc: string[]) => {
            acc.push(nodeId);
            const node = topo.nodes.get(nodeId);
            node?.children.forEach(c => collectDownstream(c, acc));
          };
          const downstreamIds: string[] = [];
          collectDownstream(childPoleId, downstreamIds);

          // Check if any of these are dark
          const placeholders = downstreamIds.map(() => '?').join(',');
          const devices = await db.all(`SELECT * FROM devices WHERE pole_id IN (${placeholders})`, downstreamIds);
          darkPolesCount = devices.filter(d => d.energized === 0 || (now - new Date(d.last_seen).getTime() > 16.5 * 60 * 1000)).length;
        }
      }
    }

    if (darkPolesCount > 0) {
      // Pushback resolution! Telemetry indicates line is still dark.
      return res.status(400).json({
        error: 'Telemetry verification failed',
        message: `Cannot resolve ticket. Telemetry indicates ${darkPolesCount} downstream poles are still dark. Let the field crew complete the repair, or wait for the system to receive boot-up signals.`,
      });
    }

    // Telemetry passes! Mark verified and closed.
    const nowStr = new Date().toISOString();
    await db.run(
      "UPDATE tickets SET status = 'verified', updated_at = ? WHERE id = ?",
      [nowStr, ticket.id]
    );

    // Wait a brief half-second to transition to closed to show transition in UI
    setTimeout(async () => {
      await db.run(
        "UPDATE tickets SET status = 'closed', updated_at = ? WHERE id = ?",
        [nowStr, ticket.id]
      );
    }, 500);

    res.json({ success: true, verified: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Get Full Network Topology and States (for Map & Graph view)
app.get('/api/network', async (req, res) => {
  try {
    const db = await getDb();
    const feeders = await db.all('SELECT * FROM feeders');
    const dts = await db.all('SELECT * FROM transformers');
    const poles = await db.all('SELECT * FROM poles');
    const devices = await db.all('SELECT * FROM devices');

    // Attach inferred topology status from cache
    const topologyCache: any = {};
    for (const [dtId, topo] of topologyService.getAllTopologies().entries()) {
      const nodesObj: any = {};
      topo.nodes.forEach((n, k) => {
        nodesObj[k] = n;
      });
      topologyCache[dtId] = {
        is_verified: topo.is_verified,
        nodes: nodesObj
      };
    }

    res.json({
      feeders,
      transformers: dts,
      poles,
      devices,
      topologies: topologyCache
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Get Scheduled Outages
app.get('/api/scheduled-outages', async (req, res) => {
  try {
    const db = await getDb();
    const outages = await db.all('SELECT * FROM scheduled_outages');
    res.json(outages);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Create Scheduled Outage (Simulator Utility)
app.post('/api/scheduled-outages', async (req, res) => {
  try {
    const { scope, target_id, start, end, reason } = req.body;
    if (!scope || !target_id || !start || !end || !reason) {
      return res.status(400).json({ error: 'Missing scheduled outage fields' });
    }

    const db = await getDb();
    const id = `SO-SIM-${Date.now()}`;
    await db.run(
      `INSERT INTO scheduled_outages (id, scope, target_id, start, end, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, scope, target_id, start, end, reason]
    );

    // Re-run localization to suppress any matching faults immediately
    localizationEngine.triggerAnalysis();

    res.status(201).json({ id, scope, target_id, start, end, reason });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Reset / Seed Database (Simulator Utility)
app.post('/api/simulator/reset', async (req, res) => {
  try {
    await seed();
    await topologyService.loadAllTopologies();
    await localizationEngine.runAnalysis();
    res.json({ success: true, message: 'Database reset to clean seeded state' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 10. AI Chat Endpoint
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, currentTicketId } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message field is required' });
    }
    const response = await askCopilot(message, currentTicketId);
    res.json({ response });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Static Frontend File Serving (Production) ---
const frontendDist = path.join(__dirname, '../frontend');
app.use(express.static(frontendDist));
app.get('*', (req, res, next) => {
  // If it's a request to an API endpoint, skip static serving so it falls through to a 404
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// --- HTTP and WebSocket Server Upgrade Binding ---
server.on('upgrade', (request, socket, head) => {
  const host = request.headers.host || 'localhost';
  const urlObj = request.url ? new URL(request.url, `http://${host}`) : null;
  const pathname = urlObj ? urlObj.pathname : '';
  const sessionId = urlObj ? urlObj.searchParams.get('sessionId') || 'default' : 'default';
  
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      (ws as any).sessionId = sessionId;
      activeSessions.add(sessionId);
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const sessionId = (ws as any).sessionId || 'default';
  console.log(`[WS] Client connected to live events (Session: ${sessionId})`);
  
  sessionStore.run(sessionId, async () => {
    try {
      const db = await getDb();
      const tickets = await db.all("SELECT * FROM tickets ORDER BY datetime(created_at) DESC");
      ws.send(JSON.stringify({ type: 'tickets', data: tickets }));
    } catch (err) {
      console.error(`[Session: ${sessionId}] Failed to send initial tickets:`, err);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected (Session: ${sessionId})`);
  });
});

// --- Server Startup ---
const PORT = 3001;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`==================================================`);
  console.log(`   KSPDB Power Localization Server Running       `);
  console.log(`   API & Websockets: http://0.0.0.0:${PORT}       `);
  console.log(`==================================================`);
  
  // Setup default session
  try {
    await sessionStore.run('default', async () => {
      const db = await initDb();
      const feederCount = await db.get<{ count: number }>("SELECT COUNT(*) as count FROM feeders");
      if (!feederCount || feederCount.count === 0) {
        console.log('[Auto-Seed] Initializing seed data into database for default session...');
        await seed();
      }
      await topologyService.loadAllTopologies();
      await localizationEngine.runAnalysis();
    });
  } catch (err) {
    console.error('Initialization failed during server startup:', err);
  }
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]:', reason);
});
