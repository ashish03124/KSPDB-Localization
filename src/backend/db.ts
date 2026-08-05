import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';
import { AsyncLocalStorage } from 'async_hooks';

// AsyncLocalStorage to propagate sessionId through the request context
export const sessionStore = new AsyncLocalStorage<string>();

const sessionsDir = path.join(__dirname, '../../sessions');
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

const dbInstances: { [sessionId: string]: Database } = {};

export async function getDb(): Promise<Database> {
  const sessionId = sessionStore.getStore() || 'default';
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';

  if (dbInstances[safeSessionId]) {
    return dbInstances[safeSessionId];
  }

  const dbPath = safeSessionId === 'default'
    ? (process.env.DB_PATH || path.join(__dirname, '../../kspdb.db'))
    : path.join(sessionsDir, `kspdb_${safeSessionId}.db`);
  
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Enable foreign keys
  await db.run('PRAGMA foreign_keys = ON;');

  dbInstances[safeSessionId] = db;
  return db;
}

export async function initDb(): Promise<Database> {
  const db = await getDb();

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS feeders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transformers (
      id TEXT PRIMARY KEY,
      feeder_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      capacity_kva INTEGER NOT NULL,
      households_served INTEGER NOT NULL,
      FOREIGN KEY (feeder_id) REFERENCES feeders(id)
    );

    CREATE TABLE IF NOT EXISTS poles (
      id TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      feeder_id TEXT NOT NULL,
      dt_id TEXT NOT NULL,
      seq_on_line INTEGER,
      parent_pole_id TEXT,
      pole_type TEXT NOT NULL,
      ward TEXT NOT NULL,
      pincode TEXT,
      device_id TEXT,
      FOREIGN KEY (feeder_id) REFERENCES feeders(id),
      FOREIGN KEY (dt_id) REFERENCES transformers(id),
      FOREIGN KEY (parent_pole_id) REFERENCES poles(id)
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      pole_id TEXT NOT NULL UNIQUE,
      energized BOOLEAN NOT NULL DEFAULT 1,
      last_seen TEXT,
      battery_mv INTEGER,
      rssi INTEGER,
      fw TEXT NOT NULL,
      FOREIGN KEY (pole_id) REFERENCES poles(id)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      fault_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      coordinates TEXT NOT NULL,
      pincode TEXT,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      confidence_reason TEXT NOT NULL,
      affected_poles_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_outages (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      target_id TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telemetry_logs (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      pole_id TEXT NOT NULL,
      event TEXT NOT NULL,
      energized BOOLEAN NOT NULL,
      ts TEXT NOT NULL,
      seq INTEGER NOT NULL,
      battery_mv INTEGER,
      rssi INTEGER,
      fw TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  `);

  // Create indexes for performance
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_poles_dt ON poles(dt_id);
    CREATE INDEX IF NOT EXISTS idx_poles_device ON poles(device_id);
    CREATE INDEX IF NOT EXISTS idx_devices_pole ON devices(pole_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_logs_device_seq ON telemetry_logs(device_id, seq);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  `);

  return db;
}
