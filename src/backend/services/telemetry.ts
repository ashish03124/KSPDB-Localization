import { getDb } from '../db';
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

// In-memory cache to handle high-speed de-duplication and fast lookups
class TelemetryService {
  // Map of device_id -> last seq processed
  private lastSeqMap: Map<string, number> = new Map();
  // Map of device_id -> timer for heartbeat monitoring
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();
  
  // Batch queue for database logs to ensure high throughput
  private logQueue: Array<TelemetryPayload & { received_at: string }> = [];
  private batchTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Flush logs to DB every 500ms
    this.batchTimer = setInterval(() => this.flushLogs(), 500);
  }

  public cleanup() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }
    for (const timer of this.heartbeatTimers.values()) {
      clearTimeout(timer);
    }
  }

  /**
   * Main ingest entry point
   * Returns true if successfully processed, false if duplicate
   */
  public async ingest(payload: TelemetryPayload): Promise<boolean> {
    const { device_id, seq, event, energized, pole_id, battery_mv, rssi, fw, ts } = payload;

    // 1. Deduplication
    const lastSeq = this.lastSeqMap.get(device_id);
    if (lastSeq !== undefined && seq <= lastSeq) {
      // Duplicate or out-of-order old message: drop it
      return false;
    }
    
    // Update sequence cache
    this.lastSeqMap.set(device_id, seq);

    // 2. Queue the log insertion in memory
    const received_at = new Date().toISOString();
    this.logQueue.push({ ...payload, received_at });

    // 3. Update Device State in Database (async but non-blocking)
    this.updateDeviceInDb(payload, received_at).catch(err => {
      console.error(`Failed to update device state for ${device_id} in DB:`, err);
    });

    // 4. Manage Heartbeat Watchdog Timers
    this.resetHeartbeatTimer(device_id, pole_id);

    // 5. Emit event for WebSocket and Localization updates
    telemetryEvents.emit('telemetry', payload);

    return true;
  }

  private async updateDeviceInDb(payload: TelemetryPayload, lastSeen: string) {
    const db = await getDb();
    
    // Check if the device exists. If it doesn't, we might need to insert or link it.
    // In our seeded database, devices already exist.
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

  private resetHeartbeatTimer(deviceId: string, poleId: string) {
    // Clear existing timer if any
    const existing = this.heartbeatTimers.get(deviceId);
    if (existing) {
      clearTimeout(existing);
    }

    // Set a timeout for 16.5 minutes (15 minutes + 45s jitter + margin)
    // For testing and demo purposes, we will also listen to a custom environment setting
    // or keep it standard. Let's use 16.5 minutes (990,000 ms)
    const timeoutMs = 16.5 * 60 * 1000;

    const timer = setTimeout(() => {
      this.handleHeartbeatTimeout(deviceId, poleId);
    }, timeoutMs);

    this.heartbeatTimers.set(deviceId, timer);
  }

  private async handleHeartbeatTimeout(deviceId: string, poleId: string) {
    console.log(`Watchdog: Device ${deviceId} (Pole ${poleId}) missed heartbeat. Flagging offline.`);
    try {
      const db = await getDb();
      // Flag device as not reporting by making last_seen old or setting a flag.
      // We will set last_seen to 17 minutes ago to represent missing heartbeat.
      const pastTime = new Date(Date.now() - 17 * 60 * 1000).toISOString();
      await db.run(
        `UPDATE devices SET last_seen = ? WHERE id = ?`,
        [pastTime, deviceId]
      );
      
      // Emit sensor offline event so localization runs
      telemetryEvents.emit('sensor_offline', { device_id: deviceId, pole_id: poleId });
    } catch (err) {
      console.error(`Failed to handle heartbeat timeout for ${deviceId}:`, err);
    }
  }

  private async flushLogs() {
    if (this.logQueue.length === 0) return;

    const logsToFlush = [...this.logQueue];
    this.logQueue = [];

    try {
      const db = await getDb();
      // Use a transaction for fast bulk insert
      await db.run('BEGIN TRANSACTION');
      const stmt = await db.prepare(
        `INSERT INTO telemetry_logs (id, device_id, pole_id, event, energized, ts, seq, battery_mv, rssi, fw, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const log of logsToFlush) {
        const logId = `TL-${log.device_id}-${log.seq}-${Date.now()}`;
        await stmt.run([
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
          log.received_at
        ]);
      }

      await stmt.finalize();
      await db.run('COMMIT');
    } catch (err) {
      console.error('Failed to flush telemetry logs to DB:', err);
    }
  }
}

export const telemetryService = new TelemetryService();
