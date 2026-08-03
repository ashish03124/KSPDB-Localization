import { getDb, initDb } from '../db';
import { topologyService } from '../services/topology';
import { localizationEngine } from '../services/localization';

// Run tests in an in-memory SQLite database
process.env.DB_PATH = ':memory:';

describe('Fault Localization Logic Tests', () => {
  beforeEach(async () => {
    // Initialize database in-memory
    const db = await initDb();
    
    // Clear all tables to be safe
    await db.run('DELETE FROM telemetry_logs');
    await db.run('DELETE FROM tickets');
    await db.run('DELETE FROM devices');
    await db.run('DELETE FROM poles');
    await db.run('DELETE FROM transformers');
    await db.run('DELETE FROM feeders');
    await db.run('DELETE FROM scheduled_outages');

    // Seed a mock feeder and transformer
    await db.run("INSERT INTO feeders (id, name) VALUES ('F-01', 'Test Feeder')");
    await db.run("INSERT INTO transformers (id, feeder_id, lat, lon, capacity_kva, households_served) VALUES ('D-01', 'F-01', 12.9, 77.5, 250, 100)");

    // Seed a simple linear verified topology: D-01 -> P-01 -> P-02 -> P-03 -> P-04
    const polesData = [
      { id: 'P-01', lat: 12.91, lon: 77.51, parent: null, seq: 1, dev: 'DEV-01' },
      { id: 'P-02', lat: 12.92, lon: 77.52, parent: 'P-01', seq: 2, dev: 'DEV-02' },
      { id: 'P-03', lat: 12.93, lon: 77.53, parent: 'P-02', seq: 3, dev: 'DEV-03' },
      { id: 'P-04', lat: 12.94, lon: 77.54, parent: 'P-03', seq: 4, dev: 'DEV-04' },
    ];

    for (const p of polesData) {
      await db.run(
        `INSERT INTO poles (id, lat, lon, feeder_id, dt_id, seq_on_line, parent_pole_id, pole_type, ward, pincode, device_id)
         VALUES (?, ?, ?, 'F-01', 'D-01', ?, ?, 'LT-9m', 'Ward 1', '560001', ?)`,
        [p.id, p.lat, p.lon, p.seq, p.parent, p.dev]
      );

      await db.run(
        `INSERT INTO devices (id, pole_id, energized, last_seen, battery_mv, rssi, fw)
         VALUES (?, ?, 1, ?, 3600, -80, '1.4.2')`,
        [p.dev, p.id, new Date().toISOString()]
      );
    }

    // Load topologies in the cache
    await topologyService.loadAllTopologies();
  });

  afterAll(async () => {
    const db = await getDb();
    await db.close();
  });

  test('Normal State: All devices energized should produce zero tickets', async () => {
    const db = await getDb();
    
    // Run analysis
    await localizationEngine.runAnalysis();

    // Verify tickets count
    const tickets = await db.all('SELECT * FROM tickets');
    expect(tickets.length).toBe(0);
  });

  test('Span Fault: When line snaps at span P-02 -> P-03 (P-03 and P-04 go dark), exactly one localized ticket is created', async () => {
    const db = await getDb();
    
    // Simulate telemetry power loss for P-03 and P-04
    await db.run("UPDATE devices SET energized = 0 WHERE id IN ('DEV-03', 'DEV-04')");

    // Run analysis
    await localizationEngine.runAnalysis();

    // Verify exactly one ticket is generated
    const tickets = await db.all("SELECT * FROM tickets WHERE status != 'closed'");
    expect(tickets.length).toBe(1);

    const ticket = tickets[0];
    expect(ticket.fault_type).toBe('span');
    expect(ticket.target_id).toBe('P-02-P-03'); // Outage boundary is P-02 (last live) to P-03 (first dark)
    expect(ticket.affected_poles_count).toBe(2); // P-03 & P-04
    expect(ticket.confidence).toBeCloseTo(0.9, 1); // Verified topology base confidence
  });

  test('Sensor Malfunction: If P-02 goes dark but its downstream child P-03 is live, no outage ticket is generated', async () => {
    const db = await getDb();
    
    // Simulate isolated telemetry failure at P-02
    await db.run("UPDATE devices SET energized = 0 WHERE id = 'DEV-02'");

    // Run analysis
    await localizationEngine.runAnalysis();

    // Verify no ticket is created (since child P-03 is live, it represents a sensor error)
    const tickets = await db.all("SELECT * FROM tickets WHERE status != 'closed'");
    expect(tickets.length).toBe(0);
  });

  test('Scheduled Outage Suppression: Active maintenance suppresses ticket generation', async () => {
    const db = await getDb();
    
    // Simulate whole DT outage (all poles dark)
    await db.run("UPDATE devices SET energized = 0");

    // Insert active scheduled outage for D-01 starting 10 mins ago, ending in 1 hour
    const now = new Date();
    const start = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const end = new Date(now.getTime() + 50 * 60 * 1000).toISOString();
    await db.run(
      `INSERT INTO scheduled_outages (id, scope, target_id, start, end, reason)
       VALUES ('SO-TEST-001', 'dt', 'D-01', ?, ?, 'Scheduled repairs')`,
      [start, end]
    );

    // Run analysis
    await localizationEngine.runAnalysis();

    // Verify no tickets are generated (suppressed)
    const tickets = await db.all("SELECT * FROM tickets WHERE status != 'closed'");
    expect(tickets.length).toBe(0);
  });
});
