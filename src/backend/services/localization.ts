import { getDb, sessionStore } from '../db';
import { topologyService, DTTopology, TopologyNode } from './topology';
import { telemetryEvents } from './telemetry';

export interface ActiveFault {
  id: string; // Target identifier, e.g., 'span:P-0101-002-P-0101-003', 'dt:D-0101', 'feeder:F-01-01'
  fault_type: 'span' | 'dt' | 'feeder';
  target_id: string;
  lat: number;
  lon: number;
  pincode: string;
  affected_poles_count: number;
  confidence: number;
  confidence_reason: string;
}

class LocalizationEngine {
  private isRunningMap: Map<string, boolean> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    // Run localization when telemetry events arrive or sensor watchdog triggers
    telemetryEvents.on('telemetry', ({ sessionId }) => this.triggerAnalysis(sessionId));
    telemetryEvents.on('sensor_offline', ({ sessionId }) => this.triggerAnalysis(sessionId));
  }

  public triggerAnalysis(sessionId: string = 'default') {
    const existingTimer = this.debounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    // Debounce per session
    const timer = setTimeout(() => {
      sessionStore.run(sessionId, () => {
        this.runAnalysis().catch(err => {
          console.error(`[Session: ${sessionId}] Error running fault localization:`, err);
        });
      });
    }, 1000);

    this.debounceTimers.set(sessionId, timer);
  }

  public async runAnalysis() {
    const sessionId = sessionStore.getStore() || 'default';
    if (this.isRunningMap.get(sessionId)) return;
    this.isRunningMap.set(sessionId, true);

    try {
      const db = await getDb();
      
      // 1. Get latest device state map
      const devices = await db.all('SELECT * FROM devices');
      const deviceStateMap = new Map<string, { energized: boolean; is_online: boolean }>();
      
      const now = Date.now();
      for (const d of devices) {
        // Consider offline if last_seen is older than 16.5 minutes
        const lastSeenTime = d.last_seen ? new Date(d.last_seen).getTime() : 0;
        const isOnline = now - lastSeenTime <= 16.5 * 60 * 1000;
        
        deviceStateMap.set(d.id, {
          energized: d.energized === 1 && isOnline,
          is_online: isOnline,
        });
      }

      // 2. Load scheduled outages to filter alerts
      const activeOutages = await db.all(
        `SELECT * FROM scheduled_outages 
         WHERE datetime(start) <= datetime('now', '+30 minutes') 
           AND datetime(end) >= datetime('now', '-60 minutes')`
      );

      const isScheduledSuppressed = (feederId: string, dtId: string): boolean => {
        return activeOutages.some(so => {
          if (so.scope === 'feeder' && so.target_id === feederId) return true;
          if (so.scope === 'dt' && so.target_id === dtId) return true;
          return false;
        });
      };

      const detectedFaults: Map<string, ActiveFault> = new Map();
      const topologies = topologyService.getAllTopologies();

      // Analyze feeder by feeder, DT by DT
      for (const [dtId, topo] of topologies.entries()) {
        const poles = Array.from(topo.nodes.values());
        const devicePoles = poles.filter(p => p.device_id !== null);
        
        if (devicePoles.length === 0) continue;

        // Fetch feeder for this DT
        const firstPole = poles[0];
        const feederId = firstPole ? firstPole.id.split('-')[1] : ''; // quick hack since pole IDs are patterned, or query DB
        const isSuppressed = isScheduledSuppressed(feederId, dtId);

        // Check if DT is completely dark
        const allDevicesDark = devicePoles.every(p => {
          const state = deviceStateMap.get(p.device_id!);
          return !state || !state.energized;
        });

        if (allDevicesDark) {
          // DT-level outage
          const faultId = `dt:${dtId}`;
          if (!isSuppressed) {
            detectedFaults.set(faultId, {
              id: faultId,
              fault_type: 'dt',
              target_id: dtId,
              lat: topo.dt_lat,
              lon: topo.dt_lon,
              pincode: firstPole?.pincode || '560001',
              affected_poles_count: poles.length,
              confidence: topo.is_verified ? 0.95 : 0.70,
              confidence_reason: `All ${devicePoles.length} reporting devices under DT ${dtId} went offline simultaneously. ${topo.is_verified ? 'Verified' : 'Inferred'} network topology.`,
            });
          }
          continue;
        }

        // If DT is not completely dark, find span boundaries
        const rootNodes = poles.filter(p => p.parent_id === null);
        for (const root of rootNodes) {
          this.traverseNode(root, topo, deviceStateMap, detectedFaults, isSuppressed);
        }
      }

      // 3. Reconcile with Database Tickets
      await this.reconcileTickets(detectedFaults);

    } finally {
      this.isRunningMap.delete(sessionId);
    }
  }

  private traverseNode(
    node: TopologyNode,
    topo: DTTopology,
    deviceStateMap: Map<string, { energized: boolean; is_online: boolean }>,
    detectedFaults: Map<string, ActiveFault>,
    isSuppressed: boolean
  ) {
    const isNodeLive = this.isPoleEnergized(node, deviceStateMap);

    // For every child, look for a transition from live (or DT) to dark
    for (const childId of node.children) {
      const child = topo.nodes.get(childId);
      if (!child) continue;

      const isChildLive = this.isPoleEnergized(child, deviceStateMap);

      if (isNodeLive && !isChildLive) {
        // Potential fault. We must verify this isn't just a sensor malfunction.
        // If the child went dark, but its downstream children are live, it's a sensor issue!
        const isMalfunction = this.hasLiveDownstream(child, topo, deviceStateMap);

        if (!isMalfunction) {
          // Gaps/Unknown poles traversal:
          // Find the actual boundaries, tracing through any unmetered (device-less) poles
          const { darkNode, gapCount } = this.findFirstDarkDeviceNode(child, topo, deviceStateMap);

          if (darkNode && !isSuppressed) {
            const faultId = `span:${node.id}-${darkNode.id}`;
            const affectedCount = this.countDownstreamPoles(darkNode, topo);
            
            // Midpoint coordinates of the fault span
            const lat = (node.lat + darkNode.lat) / 2;
            const lon = (node.lon + darkNode.lon) / 2;

            // Calculate confidence
            let confidence = topo.is_verified ? 0.90 : 0.70;
            let reasons = [];
            
            if (topo.is_verified) {
              reasons.push('Verified network topology layout.');
            } else {
              reasons.push('Inferred topology based on geometric proximity (may contain errors).');
            }

            if (gapCount > 0) {
              confidence -= gapCount * 0.10; // lower confidence for unmetered gap poles
              reasons.push(`Traversed ${gapCount} unmetered pole gaps.`);
            }

            // Check if telemetry was an explicit power_lost signal or silent watchdog timeout
            const deviceState = darkNode.device_id ? deviceStateMap.get(darkNode.device_id) : null;
            if (deviceState && !deviceState.is_online) {
              confidence -= 0.15; // lower confidence if device is just silent rather than explicit power_lost
              reasons.push('Device reported offline via heartbeat timeout watchdogs.');
            } else {
              reasons.push('Explicit power lost telemetry received from downstream pole.');
            }

            confidence = Math.max(0.30, confidence); // Minimum confidence floor

            detectedFaults.set(faultId, {
              id: faultId,
              fault_type: 'span',
              target_id: `${node.id}-${darkNode.id}`,
              lat,
              lon,
              pincode: darkNode.pincode || '560001',
              affected_poles_count: affectedCount,
              confidence,
              confidence_reason: reasons.join(' '),
            });
          }
        }
      }

      // Recurse downstream
      this.traverseNode(child, topo, deviceStateMap, detectedFaults, isSuppressed);
    }
  }

  // Returns true if the pole is actively live (fitted with device, device is online and energized)
  // or if it is unmetered (we assume live to avoid false triggers, only detecting outages on boundary transitions).
  private isPoleEnergized(
    node: TopologyNode,
    deviceStateMap: Map<string, { energized: boolean; is_online: boolean }>
  ): boolean {
    if (node.device_id === null) {
      // Unmetered pole. Assume live for boundary detection.
      return true;
    }
    const state = deviceStateMap.get(node.device_id);
    return state ? state.energized : true;
  }

  // Check if a dark node has any live nodes downstream of it
  private hasLiveDownstream(
    node: TopologyNode,
    topo: DTTopology,
    deviceStateMap: Map<string, { energized: boolean; is_online: boolean }>
  ): boolean {
    for (const childId of node.children) {
      const child = topo.nodes.get(childId);
      if (!child) continue;

      if (child.device_id !== null) {
        const state = deviceStateMap.get(child.device_id);
        if (state && state.energized) {
          return true; // Child is live! Node went dark alone: sensor malfunction.
        }
      }
      // Check deeper
      if (this.hasLiveDownstream(child, topo, deviceStateMap)) {
        return true;
      }
    }
    return false;
  }

  // Traces down unmetered poles to find the first actual dark device-fitted pole
  private findFirstDarkDeviceNode(
    node: TopologyNode,
    topo: DTTopology,
    deviceStateMap: Map<string, { energized: boolean; is_online: boolean }>,
    gapCount = 0
  ): { darkNode: TopologyNode | null; gapCount: number } {
    if (node.device_id !== null) {
      const state = deviceStateMap.get(node.device_id);
      if (state && !state.energized) {
        return { darkNode: node, gapCount };
      }
      return { darkNode: null, gapCount };
    }

    // Unmetered node: search downstream children
    for (const childId of node.children) {
      const child = topo.nodes.get(childId);
      if (!child) continue;

      const result = this.findFirstDarkDeviceNode(child, topo, deviceStateMap, gapCount + 1);
      if (result.darkNode) {
        return result;
      }
    }

    return { darkNode: null, gapCount };
  }

  // Counts total poles downstream of a given node (inclusive)
  private countDownstreamPoles(node: TopologyNode, topo: DTTopology): number {
    let count = 1;
    for (const childId of node.children) {
      const child = topo.nodes.get(childId);
      if (child) {
        count += this.countDownstreamPoles(child, topo);
      }
    }
    return count;
  }

  private async reconcileTickets(detectedFaults: Map<string, ActiveFault>) {
    const db = await getDb();
    
    // Get all open tickets
    const openTickets = await db.all(
      "SELECT * FROM tickets WHERE status NOT IN ('closed', 'verified')"
    );

    const nowStr = new Date().toISOString();

    // 1. Create or update open tickets for detected faults
    for (const fault of detectedFaults.values()) {
      const existingTicket = openTickets.find(
        t => t.fault_type === fault.fault_type && t.target_id === fault.target_id
      );

      if (existingTicket) {
        // Update details (re-evaluate confidence and affected poles count)
        await db.run(
          `UPDATE tickets 
           SET confidence = ?, confidence_reason = ?, affected_poles_count = ?, updated_at = ?
           WHERE id = ?`,
          [
            fault.confidence,
            fault.confidence_reason,
            fault.affected_poles_count,
            nowStr,
            existingTicket.id
          ]
        );
      } else {
        // Create new ticket
        const ticketId = `T-${fault.fault_type.toUpperCase()}-${fault.target_id}-${Date.now().toString().slice(-4)}`;
        await db.run(
          `INSERT INTO tickets (id, fault_type, target_id, coordinates, pincode, status, confidence, confidence_reason, affected_poles_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ticketId,
            fault.fault_type,
            fault.target_id,
            `${fault.lat},${fault.lon}`,
            fault.pincode,
            'detected',
            fault.confidence,
            fault.confidence_reason,
            fault.affected_poles_count,
            nowStr,
            nowStr
          ]
        );
        console.log(`[FAULT ENGINE] Created ticket ${ticketId} for ${fault.fault_type} fault: ${fault.target_id}`);
      }
    }

    // 2. Auto-resolve tickets that are no longer active in telemetry
    for (const ticket of openTickets) {
      const faultId = `${ticket.fault_type}:${ticket.target_id}`;
      if (!detectedFaults.has(faultId)) {
        // Telemetry has recovered! Verify and auto-close.
        console.log(`[FAULT ENGINE] Telemetry recovered for ticket ${ticket.id}. Auto-verifying and closing.`);
        await db.run(
          `UPDATE tickets SET status = 'verified', updated_at = ? WHERE id = ?`,
          [nowStr, ticket.id]
        );
        
        // Wait a small buffer and close it
        await db.run(
          `UPDATE tickets SET status = 'closed', updated_at = ? WHERE id = ?`,
          [nowStr, ticket.id]
        );
      }
    }
  }
}

export const localizationEngine = new LocalizationEngine();
export default localizationEngine;
