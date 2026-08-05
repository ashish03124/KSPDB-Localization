import { getDb, sessionStore } from '../db';

export interface TopologyNode {
  id: string;
  lat: number;
  lon: number;
  device_id: string | null;
  parent_id: string | null;
  children: string[];
  inferred: boolean;
  pincode: string | null;
}

export interface DTTopology {
  dt_id: string;
  dt_lat: number;
  dt_lon: number;
  is_verified: boolean;
  nodes: Map<string, TopologyNode>; // pole_id -> Node
}

class TopologyService {
  // Map of sessionId -> (dt_id -> DTTopology)
  private sessionTopologies: Map<string, Map<string, DTTopology>> = new Map();

  /**
   * Builds topologies for all DTs. Runs at startup.
   */
  public async loadAllTopologies() {
    const sessionId = sessionStore.getStore() || 'default';
    if (this.sessionTopologies.has(sessionId)) return;

    console.log(`[Session: ${sessionId}] Building network topologies (reconstructing missing 60%)...`);
    const db = await getDb();
    
    const dts = await db.all('SELECT * FROM transformers');
    const topologiesMap = new Map<string, DTTopology>();
    
    for (const dt of dts) {
      // Find all poles under this DT
      const poles = await db.all('SELECT * FROM poles WHERE dt_id = ?', [dt.id]);
      
      // Determine if this DT has verified topology (at least one pole has parent_pole_id)
      const hasVerified = poles.some(p => p.parent_pole_id !== null);
      
      const dtTopology: DTTopology = {
        dt_id: dt.id,
        dt_lat: dt.lat,
        dt_lon: dt.lon,
        is_verified: hasVerified,
        nodes: new Map(),
      };

      if (hasVerified) {
        this.buildVerifiedTopology(dtTopology, poles);
      } else {
        this.reconstructTopologyMST(dtTopology, poles);
      }

      topologiesMap.set(dt.id, dtTopology);
    }
    
    this.sessionTopologies.set(sessionId, topologiesMap);
    console.log(`[Session: ${sessionId}] Topology loading completed. Loaded ${topologiesMap.size} transformers.`);
  }

  public getTopology(dtId: string): DTTopology | undefined {
    const sessionId = sessionStore.getStore() || 'default';
    const topologies = this.sessionTopologies.get(sessionId);
    return topologies?.get(dtId);
  }

  public getAllTopologies(): Map<string, DTTopology> {
    const sessionId = sessionStore.getStore() || 'default';
    return this.sessionTopologies.get(sessionId) || new Map();
  }

  private buildVerifiedTopology(topology: DTTopology, poles: any[]) {
    // 1. Add poles to node map
    for (const p of poles) {
      topology.nodes.set(p.id, {
        id: p.id,
        lat: p.lat,
        lon: p.lon,
        device_id: p.device_id,
        parent_id: p.parent_pole_id,
        children: [],
        inferred: false,
        pincode: p.pincode,
      });
    }

    // 2. Build parent-child relationships
    for (const p of poles) {
      if (p.parent_pole_id) {
        const parentNode = topology.nodes.get(p.parent_pole_id);
        if (parentNode) {
          parentNode.children.push(p.id);
        }
      }
    }
  }

  /**
   * Reconstruct topology using Prim's algorithm for Minimum Spanning Tree
   */
  private reconstructTopologyMST(topology: DTTopology, poles: any[]) {
    if (poles.length === 0) return;

    // We will connect all poles and the DT (source) into a Minimum Spanning Tree.
    // Nodes list: index 0 is DT, indices 1..N are poles
    const nodes = [
      { id: topology.dt_id, lat: topology.dt_lat, lon: topology.dt_lon, is_dt: true },
      ...poles.map(p => ({ id: p.id, lat: p.lat, lon: p.lon, is_dt: false, raw: p })),
    ];

    const n = nodes.length;
    const inMST = new Array(n).fill(false);
    const minDist = new Array(n).fill(Infinity);
    const parent = new Array(n).fill(-1);

    // Root MST at the DT (index 0)
    minDist[0] = 0;

    for (let count = 0; count < n; count++) {
      // Find node with minimum distance that is not yet in MST
      let u = -1;
      let min = Infinity;
      for (let i = 0; i < n; i++) {
        if (!inMST[i] && minDist[i] < min) {
          min = minDist[i];
          u = i;
        }
      }

      if (u === -1) break; // Disconnected graph (shouldn't happen with coordinates)
      inMST[u] = true;

      // Update distances of adjacent vertices
      for (let v = 0; v < n; v++) {
        if (!inMST[v]) {
          const dist = this.getDistance(nodes[u].lat, nodes[u].lon, nodes[v].lat, nodes[v].lon);
          if (dist < minDist[v]) {
            minDist[v] = dist;
            parent[v] = u;
          }
        }
      }
    }

    // Initialize all pole nodes in the topology
    for (const p of poles) {
      topology.nodes.set(p.id, {
        id: p.id,
        lat: p.lat,
        lon: p.lon,
        device_id: p.device_id,
        parent_id: null, // to be populated
        children: [],
        inferred: true,
        pincode: p.pincode,
      });
    }

    // Populate parent-child relationships from MST parents array
    for (let i = 1; i < n; i++) {
      const node = nodes[i];
      const parentIdx = parent[i];
      if (parentIdx === -1) continue;

      const parentNode = nodes[parentIdx];
      const childNode = topology.nodes.get(node.id);

      if (childNode) {
        if (parentNode.is_dt) {
          // Parent is the DT itself
          childNode.parent_id = null; // null represents connection directly to DT
        } else {
          childNode.parent_id = parentNode.id;
          const pNode = topology.nodes.get(parentNode.id);
          if (pNode) {
            pNode.children.push(node.id);
          }
        }
      }
    }
  }

  // Calculate distance between two GPS coordinates (Euclidean distance approximation is fine for short ranges)
  private getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = lat1 - lat2;
    const dLon = lon1 - lon2;
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }
}

export const topologyService = new TopologyService();
export default topologyService;
