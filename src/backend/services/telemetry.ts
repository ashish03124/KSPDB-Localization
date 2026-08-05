import { getDb, sessionStore } from '../db';
import { EventEmitter } from 'events';

export const telemetryEvents = new EventEmitter();

export interface TelemetryPayload {
  device_id: string;
  pole_id: string;
  event: 'heartbeat' | 'power_lost' | 'power_restored' | 'boot';
  energized: boolean;
  ts: string;
  seq: number;
  battery_mv?: number;
  rssi?: number;
  fw: string;
}

class TelemetryService {
  // Map of "sessionId:device_id" -> last seq processed
  private lastSeqMap: Map<string, number> = new Map();
  // Map of "sessionId:device_id" -> timer for heartbeat monitoring
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor() {}

  public cleanup() {
    for (const timer of this.heartbeatTimers.values()) {
      clearTimeout(timer);
    }
  }

  /**
   * Main ingest entry point
   * Returns true if successfully processed, false if duplicate
   */
  public async ingest(payload: TelemetryPayload): Promise<boolean> {
    const { device_id, seq, pole_id } = payload;
    const sessionId = sessionStore.getStore() || 'default';
    const sessionKey = `${sessionId}:${device_id}`;

    // 1. Deduplication per session
    const lastSeq = this.lastSeqMap.get(sessionKey);
    if (lastSeq !== undefined && seq <= lastSeq) {
      return false;
    }
    
    // Update sequence cache
    this.lastSeqMap.set(sessionKey, seq);

    const received_at = new Date().toISOString();

    // 2. Insert Log Immediately (direct write for correct session context)
    await this.insertLogImmediate(payload, received_at);

    // 3. Update Device State in Database
    await this.updateDeviceInDb(payload, received_at);

    // 4. Manage Heartbeat Watchdog Timers
    this.resetHeartbeatTimer(sessionId, device_id, pole_id);

    // 5. Emit event for WebSocket and Localization updates (include sessionId)
    telemetryEvents.emit('telemetry', { payload, sessionId });

    return true;
  }

  private async insertLogImmediate(log: TelemetryPayload, receivedAt: string) {
    try {
      const db = await getDb();
      const logId = `TL-${log.device_id}-${log.seq}-${Date.now()}`;
      await db.run(
        `INSERT INTO telemetry_logs (id, device_id, pole_id, event, energized, ts, seq, battery_mv, rssi, fw, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          logId,
          log.device_id,
          log.pole_id,
          log.event,
          log.energized ? 1 : 0,
          log.ts,
          log.seq,
          log.battery_mv || null,
          log.rssi || null,
          log.fw,
          receivedAt
        ]
      );
    } catch (err) {
      console.error('Failed to insert telemetry log to DB:', err);
    }
  }

  private async updateDeviceInDb(payload: TelemetryPayload, lastSeen: string) {
    const db = await getDb();
    await db.run(
      `INSERT OR REPLACE INTO devices (id, pole_id, energized, last_seen, battery_mv, rssi, fw)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.device_id,
        payload.pole_id,
        payload.energized ? 1 : 0,
        lastSeen,
        payload.battery_mv || null,
        payload.rssi || null,
        payload.fw
      ]
    );
  }

  private resetHeartbeatTimer(sessionId: string, deviceId: string, poleId: string) {
    const sessionKey = `${sessionId}:${deviceId}`;
    const existing = this.heartbeatTimers.get(sessionKey);
    if (existing) {
      clearTimeout(existing);
    }

    const timeoutMs = 16.5 * 60 * 1000;

    const timer = setTimeout(() => {
      this.handleHeartbeatTimeout(sessionId, deviceId, poleId);
    }, timeoutMs);

    this.heartbeatTimers.set(sessionKey, timer);
  }

  private async handleHeartbeatTimeout(sessionId: string, deviceId: string, poleId: string) {
    console.log(`[Session: ${sessionId}] Watchdog: Device ${deviceId} (Pole ${poleId}) missed heartbeat. Flagging offline.`);
    // Run the DB updates under the correct session context
    await sessionStore.run(sessionId, async () => {
      try {
        const db = await getDb();
        const pastTime = new Date(Date.now() - 17 * 60 * 1000).toISOString();
        await db.run(
          `UPDATE devices SET last_seen = ? WHERE id = ?`,
          [pastTime, deviceId]
        );
        
        telemetryEvents.emit('sensor_offline', { device_id: deviceId, pole_id: poleId, sessionId });
      } catch (err) {
        console.error(`Failed to handle heartbeat timeout for ${deviceId}:`, err);
      }
    });
  }
}

export const telemetryService = new TelemetryService();
export { TelemetryService };
