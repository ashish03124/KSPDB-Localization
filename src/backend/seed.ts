import { initDb } from './db';
import { Database } from 'sqlite';

const BANGALORE_LAT = 12.9715987;
const BANGALORE_LON = 77.5945627;

// Utility to offset coordinates by meters (simple approximation)
function offsetCoords(lat: number, lon: number, dn: number, de: number) {
  const R = 6378137; // Earth radius in meters
  const dLat = dn / R;
  const dLon = de / (R * Math.cos((Math.PI * lat) / 180));
  return {
    lat: lat + (dLat * 180) / Math.PI,
    lon: lon + (dLon * 180) / Math.PI,
  };
}

export async function seed() {
  console.log('Initializing database tables...');
  const db: Database = await initDb();

  console.log('Clearing existing data...');
  await db.run('DELETE FROM telemetry_logs');
  await db.run('DELETE FROM tickets');
  await db.run('DELETE FROM devices');
  await db.run('DELETE FROM poles');
  await db.run('DELETE FROM transformers');
  await db.run('DELETE FROM feeders');
  await db.run('DELETE FROM scheduled_outages');

  console.log('Seeding feeders...');
  const feeders = [
    { id: 'F-01-01', name: 'Richmond Road Feeder' },
    { id: 'F-01-02', name: 'Lavelle Road Feeder' },
    { id: 'F-02-01', name: 'M G Road Feeder' },
  ];

  for (const f of feeders) {
    await db.run('INSERT INTO feeders (id, name) VALUES (?, ?)', [f.id, f.name]);
  }

  console.log('Seeding transformers...');
  const transformers = [
    // Feeder 1
    { id: 'D-0101', feeder_id: 'F-01-01', lat: BANGALORE_LAT + 0.002, lon: BANGALORE_LON + 0.002, capacity_kva: 250, households_served: 312, is_verified: true },
    { id: 'D-0102', feeder_id: 'F-01-01', lat: BANGALORE_LAT + 0.004, lon: BANGALORE_LON - 0.002, capacity_kva: 150, households_served: 185, is_verified: false },
    // Feeder 2
    { id: 'D-0201', feeder_id: 'F-01-02', lat: BANGALORE_LAT - 0.003, lon: BANGALORE_LON + 0.003, capacity_kva: 250, households_served: 290, is_verified: true },
    { id: 'D-0202', feeder_id: 'F-01-02', lat: BANGALORE_LAT - 0.001, lon: BANGALORE_LON - 0.004, capacity_kva: 500, households_served: 620, is_verified: false },
    // Feeder 3
    { id: 'D-0301', feeder_id: 'F-02-01', lat: BANGALORE_LAT + 0.005, lon: BANGALORE_LON + 0.005, capacity_kva: 250, households_served: 340, is_verified: false },
    { id: 'D-0302', feeder_id: 'F-02-01', lat: BANGALORE_LAT - 0.005, lon: BANGALORE_LON - 0.005, capacity_kva: 150, households_served: 140, is_verified: false },
  ];

  for (const dt of transformers) {
    await db.run(
      'INSERT INTO transformers (id, feeder_id, lat, lon, capacity_kva, households_served) VALUES (?, ?, ?, ?, ?, ?)',
      [dt.id, dt.feeder_id, dt.lat, dt.lon, dt.capacity_kva, dt.households_served]
    );
  }

  console.log('Seeding poles and devices...');
  let poleCounter = 1;
  let deviceCounter = 1;

  for (const dt of transformers) {
    // Generate a tree of poles for this DT
    // We'll create a main line of 15 poles stretching in a certain direction,
    // and 3 branch spurs off of it (each of 5 poles). Total 30 poles per DT.
    const mainPolesCount = 15;
    const angle = Math.random() * 2 * Math.PI; // direction of the line
    const poleSpacing = 45; // meters between poles
    
    // Store poles to assign parents
    const generatedPoles: Array<{
      id: string;
      lat: number;
      lon: number;
      parent_pole_id: string | null;
      seq_on_line: number | null;
    }> = [];

    // 1. Generate Main Line
    let currentLat = dt.lat;
    let currentLon = dt.lon;
    
    for (let i = 1; i <= mainPolesCount; i++) {
      const offset = offsetCoords(
        currentLat,
        currentLon,
        Math.sin(angle) * poleSpacing,
        Math.cos(angle) * poleSpacing
      );
      
      const parentId = i === 1 ? null : generatedPoles[generatedPoles.length - 1].id;
      
      generatedPoles.push({
        id: `P-${dt.id}-${String(poleCounter++).padStart(3, '0')}`,
        lat: offset.lat,
        lon: offset.lon,
        parent_pole_id: parentId,
        seq_on_line: i,
      });
      
      currentLat = offset.lat;
      currentLon = offset.lon;
    }

    // 2. Generate Spurs/Branches
    const spurPlacements = [3, 7, 11]; // Connect spurs to these indices along the main line
    const spurAngleOffset = [Math.PI / 2, -Math.PI / 2, Math.PI / 2];

    for (let s = 0; s < spurPlacements.length; s++) {
      const connectIndex = spurPlacements[s];
      if (connectIndex >= generatedPoles.length) continue;
      
      const connectorPole = generatedPoles[connectIndex];
      const spurAngle = angle + spurAngleOffset[s];
      let spurLat = connectorPole.lat;
      let spurLon = connectorPole.lon;

      let parentId = connectorPole.id;
      for (let j = 1; j <= 5; j++) {
        const offset = offsetCoords(
          spurLat,
          spurLon,
          Math.sin(spurAngle) * poleSpacing,
          Math.cos(spurAngle) * poleSpacing
        );

        generatedPoles.push({
          id: `P-${dt.id}-${String(poleCounter++).padStart(3, '0')}`,
          lat: offset.lat,
          lon: offset.lon,
          parent_pole_id: parentId,
          seq_on_line: (connectorPole.seq_on_line || 1) + j, // simple sequence estimate for branch
        });

        parentId = generatedPoles[generatedPoles.length - 1].id;
        spurLat = offset.lat;
        spurLon = offset.lon;
      }
    }

    // Write generated poles to database
    for (const p of generatedPoles) {
      // 91% chance of having a device
      const hasDevice = Math.random() < 0.91;
      const deviceId = hasDevice ? `KSPDB-DEV-${String(deviceCounter++).padStart(5, '0')}` : null;
      
      // Determine PIN code (seed realistic pin based on DT coordinates)
      const pincode = dt.id.endsWith('1') ? '560001' : '560025';
      const ward = 'Ward 84 - Central';

      // 60% of DTs have missing topology
      const dbParentId = dt.is_verified ? p.parent_pole_id : null;
      const dbSeqOnLine = dt.is_verified ? p.seq_on_line : null;

      await db.run(
        `INSERT INTO poles (id, lat, lon, feeder_id, dt_id, seq_on_line, parent_pole_id, pole_type, ward, pincode, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.lat, p.lon, dt.feeder_id, dt.id, dbSeqOnLine, dbParentId, 'LT-9m-PCC', ward, pincode, deviceId]
      );

      // If device is fitted, seed it in devices table
      if (deviceId) {
        // 8% chance of being an older 1.2.x firmware device
        const isOldFw = Math.random() < 0.08;
        const fw = isOldFw ? '1.2.4' : '1.4.2';
        
        await db.run(
          `INSERT INTO devices (id, pole_id, energized, last_seen, battery_mv, rssi, fw)
           VALUES (?, ?, 1, ?, 3600, -85, ?)`,
          [deviceId, p.id, new Date().toISOString(), fw]
        );
      }
    }
  }

  console.log('Seeding scheduled outages...');
  const now = new Date();
  
  // 1. A scheduled outage currently active (for testing suppression)
  const activeStart = new Date(now.getTime() - 30 * 60 * 1000); // 30 mins ago
  const activeEnd = new Date(now.getTime() + 90 * 60 * 1000);   // 90 mins from now
  await db.run(
    `INSERT INTO scheduled_outages (id, scope, target_id, start, end, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['SO-ACTIVE-001', 'dt', 'D-0202', activeStart.toISOString(), activeEnd.toISOString(), 'Load shedding']
  );

  // 2. A scheduled outage in the future
  const futureStart = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours from now
  const futureEnd = new Date(now.getTime() + 4 * 60 * 60 * 1000);   // 4 hours from now
  await db.run(
    `INSERT INTO scheduled_outages (id, scope, target_id, start, end, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['SO-FUTURE-002', 'feeder', 'F-01-01', futureStart.toISOString(), futureEnd.toISOString(), 'Substation busbar cleaning']
  );

  console.log(`Database seed completed successfully!`);
  console.log(`Feeders seeded: ${feeders.length}`);
  console.log(`Transformers seeded: ${transformers.length}`);
  console.log(`Poles seeded: ${poleCounter - 1}`);
  console.log(`Devices seeded: ${deviceCounter - 1}`);
}

// Run if called directly
if (require.main === module) {
  seed().catch((err) => {
    console.error('Seeding database failed:', err);
    process.exit(1);
  });
}
