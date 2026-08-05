import React, { useState, useEffect, useRef } from 'react';
import { 
  AlertTriangle, 
  Activity, 
  Map as MapIcon, 
  Wrench, 
  CheckCircle, 
  Terminal, 
  MessageSquare, 
  Send, 
  RefreshCw, 
  Clock, 
  ShieldAlert, 
  Zap, 
  HelpCircle,
  Play,
  Check,
  Sun,
  Moon
} from 'lucide-react';

interface Feeder {
  id: string;
  name: string;
}

interface Transformer {
  id: string;
  feeder_id: string;
  lat: number;
  lon: number;
  capacity_kva: number;
  households_served: number;
}

interface Pole {
  id: string;
  lat: number;
  lon: number;
  feeder_id: string;
  dt_id: string;
  seq_on_line: number | null;
  parent_pole_id: string | null;
  pole_type: string;
  ward: string;
  pincode: string;
  device_id: string | null;
}

interface Device {
  id: string;
  pole_id: string;
  energized: number;
  last_seen: string;
  battery_mv: number;
  rssi: number;
  fw: string;
}

interface Ticket {
  id: string;
  fault_type: 'span' | 'dt' | 'feeder';
  target_id: string;
  coordinates: string;
  pincode: string;
  status: 'detected' | 'acknowledged' | 'crew_assigned' | 'resolved' | 'verified' | 'closed';
  confidence: number;
  confidence_reason: string;
  affected_poles_count: number;
  created_at: string;
  updated_at: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'console' | 'simulator'>('console');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    document.body.className = theme === 'light' ? 'light-theme' : 'dark-theme';
  }, [theme]);
  
  // Core State
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  
  // Network Data
  const [feeders, setFeeders] = useState<Feeder[]>([]);
  const [transformers, setTransformers] = useState<Transformer[]>([]);
  const [poles, setPoles] = useState<Pole[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [topologies, setTopologies] = useState<any>({});
  
  // UI States
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pushbackError, setPushbackError] = useState<string | null>(null);
  
  // Telemetry Monitor Logging
  const [telemetryLogs, setTelemetryLogs] = useState<any[]>([]);
  
  // AI Chat State
  const [chatHistory, setChatHistory] = useState<Array<{ sender: 'user' | 'ai'; text: string }>>([
    { sender: 'ai', text: "Hello! I am your KSPDB Operator Co-Pilot. How can I help you analyze the grid outages today?" }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  
  // Simulator State
  const [simType, setSimType] = useState<'span' | 'dt' | 'feeder' | 'noise'>('span');
  const [selectedSimFeeder, setSelectedSimFeeder] = useState('');
  const [selectedSimDt, setSelectedSimDt] = useState('');
  const [selectedSimSpan, setSelectedSimSpan] = useState('');
  const [noiseMinutes, setNoiseMinutes] = useState(18);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationLogs, setSimulationLogs] = useState<string[]>([]);
  const [maintenanceTarget, setMaintenanceTarget] = useState('');
  const [maintenanceScope, setMaintenanceScope] = useState<'feeder' | 'dt'>('dt');
  const [maintenanceReason, setMaintenanceReason] = useState('Load shedding');

  // SVG Pan/Zoom state
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const telemetryEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll telemetry log window
  useEffect(() => {
    telemetryEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [telemetryLogs]);

  // Connect WebSockets and Load initial data
  useEffect(() => {
    fetchNetwork();
    fetchTickets();
    
    // Connect Live WebSocket Stream
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    let ws = new WebSocket(wsUrl);
    
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'tickets') {
          setTickets(msg.data);
        } else if (msg.type === 'telemetry') {
          // Append to telemetry monitor log
          setTelemetryLogs(prev => [...prev.slice(-49), { ...msg.data, received_at: new Date().toISOString() }]);
          // Refresh network states
          refreshDeviceState(msg.data);
        }
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      console.log('WS Connection closed. Reconnecting in 3s...');
      setTimeout(() => {
        // Simple reconnect logic
      }, 3000);
    };

    return () => ws.close();
  }, []);

  const fetchNetwork = async () => {
    try {
      const res = await fetch('/api/network');
      const data = await res.json();
      setFeeders(data.feeders);
      setTransformers(data.transformers);
      setPoles(data.poles);
      setDevices(data.devices);
      setTopologies(data.topologies);
      
      // Seed default selections for simulator dropdowns
      if (data.feeders.length > 0) setSelectedSimFeeder(data.feeders[0].id);
      if (data.transformers.length > 0) setSelectedSimDt(data.transformers[0].id);
      
      setLoading(false);
    } catch (err) {
      console.error('Failed to load network data:', err);
      setErrorMsg('Failed to load grid database from API.');
      setLoading(false);
    }
  };

  const fetchTickets = async () => {
    try {
      const res = await fetch('/api/tickets');
      const data = await res.json();
      setTickets(data);
    } catch (err) {
      console.error('Failed to load tickets:', err);
    }
  };

  const refreshDeviceState = (payload: any) => {
    setDevices(prev => {
      const idx = prev.findIndex(d => d.id === payload.device_id);
      if (idx !== -1) {
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          energized: payload.energized ? 1 : 0,
          last_seen: new Date().toISOString(),
          battery_mv: payload.battery_mv || updated[idx].battery_mv,
          rssi: payload.rssi || updated[idx].rssi,
        };
        return updated;
      }
      return prev;
    });
  };

  // Ticket Workflow Controls
  const handleAcknowledge = async (id: string) => {
    try {
      const res = await fetch(`/api/tickets/${id}/acknowledge`, { method: 'POST' });
      if (res.ok) {
        fetchTickets();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleAssign = async (id: string) => {
    try {
      const res = await fetch(`/api/tickets/${id}/assign`, { method: 'POST' });
      if (res.ok) {
        fetchTickets();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleResolve = async (id: string) => {
    setPushbackError(null);
    try {
      const res = await fetch(`/api/tickets/${id}/resolve`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setPushbackError(data.message || data.error || 'Resolution rejected.');
      } else {
        fetchTickets();
        fetchNetwork();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // AI Chat Submission
  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading) return;

    const userMsg = chatInput;
    setChatHistory(prev => [...prev, { sender: 'user', text: userMsg }]);
    setChatInput('');
    setChatLoading(true);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg, currentTicketId: selectedTicketId }),
      });
      const data = await res.json();
      setChatHistory(prev => [...prev, { sender: 'ai', text: data.response }]);
    } catch (err) {
      setChatHistory(prev => [...prev, { sender: 'ai', text: "Sorry, I lost connection to the server's AI agent." }]);
    } finally {
      setChatLoading(false);
    }
  };

  // Reset database utility
  const handleResetDb = async () => {
    if (!window.confirm('Reset database to default seeded network state? This will clear all current faults.')) return;
    try {
      const res = await fetch('/api/simulator/reset', { method: 'POST' });
      if (res.ok) {
        setTelemetryLogs([]);
        setSimulationLogs(['Database reset completed. Fresh network loaded.']);
        fetchNetwork();
        fetchTickets();
        setSelectedTicketId(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Inject Scheduled Maintenance
  const handleInjectMaintenance = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const now = new Date();
      const start = now.toISOString();
      const end = new Date(now.getTime() + 60 * 60 * 1000).toISOString(); // 1 hour duration
      
      const res = await fetch('/api/scheduled-outages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: maintenanceScope,
          target_id: maintenanceTarget || (maintenanceScope === 'feeder' ? selectedSimFeeder : selectedSimDt),
          start,
          end,
          reason: maintenanceReason,
        }),
      });

      if (res.ok) {
        setSimulationLogs(prev => [...prev, `Injected scheduled outage on ${maintenanceScope}: ${maintenanceTarget || (maintenanceScope === 'feeder' ? selectedSimFeeder : selectedSimDt)}`]);
        fetchNetwork();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Realist Telemetry Simulation Engine (Physics-based)
  const runOutageSimulation = async (isRepair: boolean) => {
    setIsSimulating(true);
    setSimulationLogs([]);

    // 1. Determine affected devices
    let affectedPoles: Pole[] = [];
    
    if (simType === 'feeder') {
      affectedPoles = poles.filter(p => p.feeder_id === selectedSimFeeder);
    } else if (simType === 'dt') {
      affectedPoles = poles.filter(p => p.dt_id === selectedSimDt);
    } else if (simType === 'span') {
      // Find downstream node of span
      if (!selectedSimSpan) {
        alert('Please select a span first.');
        setIsSimulating(false);
        return;
      }
      const [uId, vId] = selectedSimSpan.split('-'); // child node is vId
      const poleDetails = poles.find(p => p.id === vId);
      if (poleDetails) {
        const topo = topologies[poleDetails.dt_id];
        if (topo) {
          const collectDownstream = (nodeId: string, acc: string[]) => {
            acc.push(nodeId);
            const node = topo.nodes[nodeId];
            node?.children.forEach((c: string) => collectDownstream(c, acc));
          };
          const downstreamIds: string[] = [];
          collectDownstream(vId, downstreamIds);
          affectedPoles = poles.filter(p => downstreamIds.includes(p.id));
        }
      }
    } else if (simType === 'noise') {
      // Select one single device-fitted pole
      const fitted = poles.filter(p => p.device_id !== null);
      if (fitted.length > 0) {
        affectedPoles = [fitted[Math.floor(Math.random() * fitted.length)]];
      }
    }

    const deviceFittedPoles = affectedPoles.filter(p => p.device_id !== null);
    
    if (deviceFittedPoles.length === 0) {
      setSimulationLogs(['No device-fitted poles are affected by this selection.']);
      setIsSimulating(false);
      return;
    }

    setSimulationLogs(prev => [...prev, `Starting simulation: ${isRepair ? 'REPAIR' : 'FAULT INJECTION'} on ${simType}.`]);
    setSimulationLogs(prev => [...prev, `Affected device-fitted poles: ${deviceFittedPoles.length}`]);

    let seqCounter = 10000;
    
    // Simulate physics rules of network devices
    for (const p of deviceFittedPoles) {
      const dev = devices.find(d => d.pole_id === p.id);
      if (!dev) continue;

      const deviceId = p.device_id!;
      const isOldFirmware = dev.fw.startsWith('1.2');

      if (!isRepair) {
        // INJECTION SCENARIO:
        if (simType === 'noise') {
          // Watchdog noise: device goes silent
          setSimulationLogs(prev => [...prev, `[Watchdog Noise] Device ${deviceId} stops reporting heartbeats.`]);
          // To simulate watchdog: we trigger the timeout endpoint directly in the backend
          const db = await fetch('/api/telemetry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              device_id: deviceId,
              pole_id: p.id,
              event: 'heartbeat',
              energized: true,
              ts: new Date(Date.now() - (noiseMinutes * 60 * 1000)).toISOString(), // Older timestamp forces watchdog timeout
              seq: seqCounter++,
              fw: dev.fw,
            }),
          });
          continue;
        }

        // Standard line break physics:
        // Capacitor-driven delivery failure check (30% loss)
        const succeedsInSending = Math.random() < 0.70;
        
        if (isOldFirmware) {
          setSimulationLogs(prev => [...prev, `[FW LIMIT] Device ${deviceId} (FW ${dev.fw}) cannot send 'power_lost'. Silence expected.`]);
        } else if (!succeedsInSending) {
          setSimulationLogs(prev => [...prev, `[PACKET LOSS] Device ${deviceId} capacitor drained before transmitting 'power_lost'.`]);
        } else {
          setSimulationLogs(prev => [...prev, `[TRANSMIT] Device ${deviceId} sending 'power_lost' event...`]);
          // Call ingestion API
          await fetch('/api/telemetry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              device_id: deviceId,
              pole_id: p.id,
              event: 'power_lost',
              energized: false,
              ts: new Date().toISOString(),
              seq: seqCounter++,
              battery_mv: 3100, // Capacitor level dropping
              rssi: -87,
              fw: dev.fw,
            }),
          });
        }
      } else {
        // REPAIR SCENARIO:
        // Devices boot and restore power
        setSimulationLogs(prev => [...prev, `[RESTORE] Device ${deviceId} booted. Sending 'power_restored' event.`]);
        await fetch('/api/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: deviceId,
            pole_id: p.id,
            event: 'boot',
            energized: true,
            ts: new Date().toISOString(),
            seq: seqCounter++,
            battery_mv: 3600,
            rssi: -84,
            fw: dev.fw,
          }),
        });

        await fetch('/api/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: deviceId,
            pole_id: p.id,
            event: 'power_restored',
            energized: true,
            ts: new Date().toISOString(),
            seq: seqCounter++,
            battery_mv: 3600,
            rssi: -84,
            fw: dev.fw,
          }),
        });
      }
      
      // Micro sleep to simulate real telemetry timing burst
      await new Promise(r => setTimeout(r, 80));
    }

    setSimulationLogs(prev => [...prev, `Simulation complete.`]);
    setIsSimulating(false);
    fetchNetwork();
    fetchTickets();
  };

  // Find spans for selected DT in simulator
  const activeDtSpans: string[] = [];
  if (selectedSimDt && topologies[selectedSimDt]) {
    const nodes = topologies[selectedSimDt].nodes;
    Object.keys(nodes).forEach(k => {
      const node = nodes[k];
      node.children.forEach((c: string) => {
        activeDtSpans.push(`${node.id}-${c}`);
      });
    });
  }

  // --- SVG Map Coordinates Math & Handlers ---
  const handleMouseDown = (e: React.MouseEvent) => {
    isDragging.current = true;
    dragStart.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current) return;
    setPanOffset({
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y,
    });
  };

  const handleMouseUp = () => {
    isDragging.current = false;
  };

  const handleZoom = (factor: number) => {
    setZoomLevel(prev => Math.max(0.5, Math.min(4, prev * factor)));
  };

  // Map latitude/longitude to SVG coordinate plane (width 800, height 500)
  const mapCoordsToSvg = (lat: number, lon: number) => {
    // Determine bounds from all poles
    if (poles.length === 0) return { x: 400, y: 250 };
    
    // Find min/max boundaries
    const lats = poles.map(p => p.lat);
    const lons = poles.map(p => p.lon);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);

    const latRange = maxLat - minLat || 1;
    const lonRange = maxLon - minLon || 1;

    // Standard margins inside SVG space
    const x = 50 + ((lon - minLon) / lonRange) * 700;
    // SVG 0,0 is top-left, so we invert Y axis
    const y = 450 - ((lat - minLat) / latRange) * 400;

    return { x, y };
  };

  // Render SVG Elements (Poles, Spans, DTs)
  const renderSvgNetwork = () => {
    if (poles.length === 0) return null;

    const drawnEdges: string[] = [];
    const elements: React.ReactNode[] = [];

    // Map active tickets target_ids for quick highlights
    const activeSpans = tickets.filter(t => t.status !== 'closed').map(t => t.target_id);
    const activeDts = tickets.filter(t => t.status !== 'closed' && t.fault_type === 'dt').map(t => t.target_id);

    // 1. Draw Spans (Lines)
    transformers.forEach(dt => {
      const topo = topologies[dt.id];
      if (!topo) return;

      const nodes = topo.nodes;
      const dtCoord = mapCoordsToSvg(dt.lat, dt.lon);

      // Connect roots to DT
      Object.keys(nodes).forEach(k => {
        const node = nodes[k];
        const nodeCoord = mapCoordsToSvg(node.lat, node.lon);

        if (node.parent_id === null) {
          // Connect to DT
          const edgeId = `${dt.id}-${node.id}`;
          const isFaulty = activeSpans.some(s => s.includes(node.id));
          elements.push(
            <line
              key={edgeId}
              x1={dtCoord.x}
              y1={dtCoord.y}
              x2={nodeCoord.x}
              y2={nodeCoord.y}
              stroke={isFaulty ? 'var(--status-dark)' : 'var(--status-live)'}
              strokeWidth={isFaulty ? 3 : 1.5}
              strokeDasharray={topo.is_verified ? undefined : '4 4'}
              className={isFaulty ? 'pulse-red' : undefined}
            />
          );
        }

        // Connect node to children
        node.children.forEach((childId: string) => {
          const child = nodes[childId];
          if (!child) return;
          const childCoord = mapCoordsToSvg(child.lat, child.lon);
          
          const edgeId = `${node.id}-${child.id}`;
          const isFaulty = activeSpans.some(s => s === `${node.id}-${child.id}`);

          // Determine line color from telemetry liveness
          let strokeColor = 'var(--status-live)'; // default energized
          let strokeWidth = 1.5;

          if (isFaulty) {
            strokeColor = 'var(--status-dark)'; // Faulty span
            strokeWidth = 3.5;
          } else {
            // Check if downstream pole is dark
            const childDev = devices.find(d => d.pole_id === child.id);
            if (childDev && childDev.energized === 0) {
              strokeColor = 'var(--text-muted)'; // De-energized but not the break point itself
            }
          }

          elements.push(
            <line
              key={edgeId}
              x1={nodeCoord.x}
              y1={nodeCoord.y}
              x2={childCoord.x}
              y2={childCoord.y}
              stroke={strokeColor}
              strokeWidth={strokeWidth}
              strokeDasharray={node.inferred ? '4 4' : undefined}
              className={isFaulty ? 'pulse-red' : undefined}
            />
          );
        });
      });
    });

    // 2. Draw DTs (Transformers)
    transformers.forEach(dt => {
      const coord = mapCoordsToSvg(dt.lat, dt.lon);
      const isFaulty = activeDts.includes(dt.id);

      elements.push(
        <g key={dt.id} transform={`translate(${coord.x}, ${coord.y})`}>
          <polygon
            points="-8,8 8,8 0,-10"
            fill={isFaulty ? 'var(--status-dark)' : 'var(--accent-color)'}
            stroke="var(--bg-main)"
            strokeWidth="1.5"
            className={isFaulty ? 'pulse-red' : undefined}
            style={{ cursor: 'pointer' }}
            onClick={() => setSimulationLogs(prev => [...prev, `Selected DT: ${dt.id}`])}
          />
          <text y="-14" textAnchor="middle" fill="var(--text-muted)" fontSize="8" fontWeight="600">{dt.id}</text>
        </g>
      );
    });

    // 3. Draw Poles (Nodes)
    poles.forEach(p => {
      const coord = mapCoordsToSvg(p.lat, p.lon);
      const dev = devices.find(d => d.pole_id === p.id);
      
      let color = 'var(--text-muted)'; // Grey if unmetered
      
      if (p.device_id !== null) {
         if (dev) {
          const now = Date.now();
          const lastSeenTime = new Date(dev.last_seen).getTime();
          const isOnline = now - lastSeenTime <= 16.5 * 60 * 1000;
          
          if (!isOnline) {
            color = 'var(--status-warn)'; // Timed out watchdog - Warning orange
          } else {
            color = dev.energized === 1 ? 'var(--status-live)' : 'var(--status-dark)'; // Green if live, Red if dark
          }
        }
      }

      elements.push(
        <circle
          key={p.id}
          cx={coord.x}
          cy={coord.y}
          r={p.device_id ? 4 : 2.5}
          fill={color}
          stroke="var(--bg-main)"
          strokeWidth="1"
          style={{ cursor: 'pointer' }}
          onClick={() => {
            setSimulationLogs(prev => [...prev, `Pole: ${p.id} (${p.device_id ? 'Device fitted' : 'Unmetered'})`]);
            if (p.device_id) {
              const devInfo = devices.find(d => d.pole_id === p.id);
              if (devInfo) {
                setSimulationLogs(prev => [...prev, `↳ Status: ${devInfo.energized ? 'Energized' : 'Dark'}, battery: ${devInfo.battery_mv}mV, RSSI: ${devInfo.rssi}dBm`]);
              }
            }
          }}
        />
      );
    });

    return elements;
  };

  const selectedTicket = tickets.find(t => t.id === selectedTicketId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: 'var(--bg-main)' }}>
      {/* HEADER */}
      <header className="console-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Zap size={28} color="var(--accent-color)" strokeWidth={3} />
          <div>
            <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, letterSpacing: '-0.025em' }}>
              KSPDB OUTAGE LOCATOR
            </h1>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Karnataka State Power Distribution Board • Central Division
            </p>
          </div>
        </div>

        {/* Tab Controls */}
        <div style={{ display: 'flex', gap: 12 }}>
          <button 
            className={`btn-secondary ${activeTab === 'console' ? 'active-tab' : ''}`}
            onClick={() => setActiveTab('console')}
            style={activeTab === 'console' ? { borderColor: 'var(--accent-color)', color: 'var(--accent-color)' } : {}}
          >
            <MapIcon size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Operator Console
          </button>
          <button 
            className={`btn-secondary ${activeTab === 'simulator' ? 'active-tab' : ''}`}
            onClick={() => setActiveTab('simulator')}
            style={activeTab === 'simulator' ? { borderColor: 'var(--accent-color)', color: 'var(--accent-color)' } : {}}
          >
            <Wrench size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Outage Simulator
          </button>
          <button className="btn-secondary" onClick={fetchNetwork} title="Refresh Network">
            <RefreshCw size={16} />
          </button>
          <button 
            className="btn-secondary" 
            onClick={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
            title="Toggle Theme"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </header>

      {/* DASHBOARD SPLIT GRID */}
      <main className="dashboard-grid" style={{ marginTop: 16 }}>
        
        {/* LEFT PANEL: Tickets List */}
        <section className="glass-panel" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={18} color="#ef4444" />
              Active Outage Tickets ({tickets.filter(t => t.status !== 'closed').length})
            </h2>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {tickets.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--text-muted)' }}>
                <CheckCircle size={32} color="var(--status-live)" style={{ marginBottom: 10 }} />
                <p style={{ margin: 0, fontSize: '0.875rem' }}>All lines fully energized.</p>
                <p style={{ margin: 0, fontSize: '0.75rem' }}>No faults detected.</p>
              </div>
            ) : (
              tickets.map(t => (
                <div 
                  key={t.id} 
                  className={`glass-panel ${selectedTicketId === t.id ? 'active-ticket-card' : ''}`}
                  onClick={() => setSelectedTicketId(t.id)}
                  style={{
                    padding: 12,
                    cursor: 'pointer',
                    borderColor: selectedTicketId === t.id ? 'var(--accent-color)' : 'var(--border-color)',
                    background: selectedTicketId === t.id ? 'var(--accent-dim)' : 'var(--bg-card)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                    <span style={{ fontSize: '0.875rem', fontWeight: 700 }}>{t.id}</span>
                    <span className={`badge badge-${t.status}`}>{t.status}</span>
                  </div>
                  
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                    <strong>Type:</strong> {t.fault_type.toUpperCase()} Outage<br/>
                    <strong>Target:</strong> {t.target_id}<br/>
                    <strong>Affected:</strong> {t.affected_poles_count} poles downstream
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      <Clock size={10} style={{ marginRight: 3, verticalAlign: 'middle' }} />
                      {new Date(t.created_at).toLocaleTimeString()}
                    </span>
                    <span style={{ 
                      fontSize: '0.75rem', 
                      fontWeight: 600, 
                      color: t.confidence >= 0.8 ? 'var(--status-live)' : t.confidence >= 0.6 ? 'var(--status-warn)' : 'var(--status-dark)'
                    }}>
                      Confidence: {(t.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* MIDDLE PANEL: Schematic SCADA Grid Map */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Map Viewer */}
          <div 
            className="glass-panel" 
            style={{ 
              flex: 1, 
              position: 'relative', 
              overflow: 'hidden', 
              cursor: isDragging.current ? 'grabbing' : 'grab' 
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {/* Map Controls Overlay */}
            <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button className="btn-secondary" onClick={() => handleZoom(1.2)} style={{ padding: '6px 12px' }}>+</button>
              <button className="btn-secondary" onClick={() => handleZoom(0.8)} style={{ padding: '6px 12px' }}>-</button>
              <button className="btn-secondary" onClick={() => { setZoomLevel(1); setPanOffset({ x: 0, y: 0 }); }} style={{ fontSize: '0.7rem' }}>Reset</button>
            </div>

            <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, pointerEvents: 'none' }}>
              <span className="badge badge-detected" style={{ background: 'var(--bg-card)' }}>
                <MapIcon size={14} /> Grid Schematic (Interactive Canvas)
              </span>
            </div>

            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                <RefreshCw className="animate-spin" size={32} />
              </div>
            ) : (
              <svg 
                width="100%" 
                height="100%" 
                viewBox="0 0 800 500"
                style={{
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
                  transformOrigin: 'center',
                  transition: isDragging.current ? 'none' : 'transform 0.15s ease-out'
                }}
              >
                {renderSvgNetwork()}
              </svg>
            )}

            {/* Map Legend Footer overlay */}
            <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 10, display: 'flex', gap: 12, fontSize: '0.75rem', background: 'var(--bg-card)', padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-color)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--status-live)' }}></span> Live Device</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--status-dark)' }}></span> Dark Device</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--status-warn)' }}></span> Silent/Watchdog</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--text-muted)' }}></span> Unmetered</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>|</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 12, height: 2, borderBottom: '2px dashed var(--status-live)' }}></span> Inferred Span</span>
            </div>
          </div>

          {/* Ticket Workflow detail panel (Bottom) */}
          <div className="glass-panel" style={{ height: 200, padding: 16, display: 'flex', flexDirection: 'column' }}>
            {selectedTicket ? (
              <div style={{ display: 'flex', gap: 20, height: '100%' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <ShieldAlert size={20} color="var(--status-dark)" />
                    <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>Ticket Details: {selectedTicket.id}</h3>
                  </div>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    <div><strong>Fault Component:</strong> {selectedTicket.fault_type.toUpperCase()} ({selectedTicket.target_id})</div>
                    <div><strong>GPS Midpoint:</strong> {selectedTicket.coordinates}</div>
                    <div><strong>PIN Code Boundary:</strong> {selectedTicket.pincode || 'Not Found'}</div>
                    <div><strong>Downstream Impact:</strong> {selectedTicket.affected_poles_count} poles affected</div>
                  </div>
                  
                  <div style={{ marginTop: 10, padding: 8, background: 'var(--bg-main)', borderRadius: 6, fontSize: '0.7rem', border: '1px dashed var(--border-color)' }}>
                    <strong>Confidence Report:</strong> {selectedTicket.confidence_reason}
                  </div>
                </div>

                <div style={{ width: 220, borderLeft: '1px solid var(--border-color)', paddingLeft: 20, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>Workflow Lifecycle Actions:</div>
                  
                  {selectedTicket.status === 'detected' && (
                    <button className="btn-primary" onClick={() => handleAcknowledge(selectedTicket.id)}>
                      Acknowledge Ticket
                    </button>
                  )}
                  
                  {(selectedTicket.status === 'detected' || selectedTicket.status === 'acknowledged') && (
                    <button className="btn-primary" onClick={() => handleAssign(selectedTicket.id)}>
                      Dispatch Repair Crew
                    </button>
                  )}

                  {selectedTicket.status === 'crew_assigned' && (
                    <button className="btn-primary" onClick={() => handleResolve(selectedTicket.id)} style={{ backgroundColor: 'var(--status-live)' }}>
                      Verify & Resolve Ticket
                    </button>
                  )}

                  {selectedTicket.status === 'resolved' && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--status-live)', fontWeight: 500, textAlign: 'center' }}>
                      <RefreshCw size={14} className="animate-spin" style={{ marginRight: 6, display: 'inline-block', verticalAlign: 'middle' }} />
                      Running telemetry verification...
                    </div>
                  )}

                  {selectedTicket.status === 'closed' && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500, textAlign: 'center' }}>
                      <CheckCircle size={16} color="var(--status-live)" style={{ marginRight: 6, display: 'inline-block', verticalAlign: 'middle' }} />
                      Verified & Closed by Telemetry
                    </div>
                  )}

                  {pushbackError && (
                    <div style={{ fontSize: '0.65rem', color: 'var(--status-dark)', marginTop: 4, padding: 6, background: 'rgba(239, 68, 68, 0.1)', borderRadius: 4, border: '1px solid rgba(239,68,68,0.2)' }}>
                      <strong>Verification Refused:</strong> {pushbackError}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                Select a ticket from the left panel to inspect details and initiate workflow resolution.
              </div>
            )}
          </div>
        </section>

        {/* RIGHT PANEL: AI Co-Pilot Chat & Live Telemetry Stream / Simulator */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 16, overflow: 'hidden' }}>
          
          {/* TAB CONTENT: CONSOLE (AI Co-pilot Chat + Live Telemetry) */}
          {activeTab === 'console' && (
            <>
              {/* AI Co-Pilot Panel */}
              <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 12 }}>
                <h2 style={{ fontSize: '0.9rem', fontWeight: 600, margin: '0 0 10px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <MessageSquare size={16} color="var(--accent-color)" />
                  AI Operator Co-Pilot
                </h2>
                
                {/* Chat Message Window */}
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: 6, marginBottom: 10, background: 'var(--bg-main)', borderRadius: 8 }}>
                  {chatHistory.map((msg, idx) => (
                    <div 
                      key={idx} 
                      style={{
                        alignSelf: msg.sender === 'user' ? 'flex-end' : 'flex-start',
                        backgroundColor: msg.sender === 'user' ? 'var(--accent-color)' : 'var(--bg-card-hover)',
                        color: msg.sender === 'user' ? 'var(--accent-text)' : 'var(--text-main)',
                        padding: '8px 12px',
                        borderRadius: 12,
                        maxWidth: '85%',
                        fontSize: '0.75rem',
                        lineHeight: 1.4
                      }}
                    >
                      {msg.text}
                    </div>
                  ))}
                  {chatLoading && (
                    <div style={{ alignSelf: 'flex-start', padding: 8, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      Co-pilot is analyzing grid context...
                    </div>
                  )}
                </div>

                <form onSubmit={handleSendChat} style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Ask about active outages..."
                    style={{
                      flex: 1,
                      backgroundColor: 'var(--bg-card-hover)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 6,
                      padding: '8px 12px',
                      color: 'var(--text-main)',
                      fontSize: '0.75rem'
                    }}
                  />
                  <button type="submit" className="btn-primary" style={{ padding: '8px 12px' }}>
                    <Send size={14} />
                  </button>
                </form>
              </div>

              {/* Live Telemetry Packet Stream */}
              <div className="glass-panel" style={{ height: 180, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 12 }}>
                <h2 style={{ fontSize: '0.9rem', fontWeight: 600, margin: '0 0 8px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Terminal size={16} color="var(--status-live)" />
                  Live Telemetry Packet Monitor
                </h2>
                <div style={{ flex: 1, overflowY: 'auto', background: 'var(--terminal-bg)', borderRadius: 6, padding: 8, fontFamily: 'monospace', fontSize: '0.65rem', color: 'var(--status-live)' }}>
                  {telemetryLogs.length === 0 ? (
                    <span style={{ color: 'var(--text-muted)' }}>Waiting for telemetry streams...</span>
                  ) : (
                    telemetryLogs.map((log, idx) => (
                      <div key={idx} style={{ marginBottom: 4 }}>
                        <span style={{ color: 'var(--text-muted)' }}>[{new Date(log.received_at).toLocaleTimeString()}]</span>{' '}
                        {log.device_id} : {log.event.toUpperCase()} (Live: {log.energized ? 'YES' : 'NO'}, Seq: {log.seq})
                      </div>
                    ))
                  )}
                  <div ref={telemetryEndRef} />
                </div>
              </div>
            </>
          )}

          {/* TAB CONTENT: SIMULATOR PANEL */}
          {activeTab === 'simulator' && (
            <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: 12, gap: 16 }}>
              <div>
                <h2 style={{ fontSize: '0.95rem', fontWeight: 700, margin: '0 0 6px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Wrench size={18} color="var(--accent-color)" />
                  Grid Outage Simulator
                </h2>
                <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  Inject fault conditions and test state changes.
                </p>
              </div>

              {/* Outage Type Selector */}
              <div className="glass-panel" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>Select Fault Scope:</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <button 
                    className="btn-secondary" 
                    onClick={() => setSimType('span')}
                    style={simType === 'span' ? { borderColor: 'var(--accent-color)', color: 'var(--accent-color)' } : {}}
                  >
                    Span Break
                  </button>
                  <button 
                    className="btn-secondary" 
                    onClick={() => setSimType('dt')}
                    style={simType === 'dt' ? { borderColor: 'var(--accent-color)', color: 'var(--accent-color)' } : {}}
                  >
                    DT Fuse
                  </button>
                  <button 
                    className="btn-secondary" 
                    onClick={() => setSimType('feeder')}
                    style={simType === 'feeder' ? { borderColor: 'var(--accent-color)', color: 'var(--accent-color)' } : {}}
                  >
                    Feeder
                  </button>
                  <button 
                    className="btn-secondary" 
                    onClick={() => setSimType('noise')}
                    style={simType === 'noise' ? { borderColor: 'var(--accent-color)', color: 'var(--accent-color)' } : {}}
                  >
                    Sensor Noise
                  </button>
                </div>

                {/* Scope Target Selectors */}
                {simType === 'feeder' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                    <label style={{ fontSize: '0.7rem' }}>Select Feeder:</label>
                    <select 
                      value={selectedSimFeeder} 
                      onChange={(e) => setSelectedSimFeeder(e.target.value)}
                      style={{ padding: 6, fontSize: '0.75rem', backgroundColor: 'var(--bg-main)', border: '1px solid var(--border-color)', color: 'var(--text-main)' }}
                    >
                      {feeders.map(f => <option key={f.id} value={f.id}>{f.id} - {f.name}</option>)}
                    </select>
                  </div>
                )}

                {simType === 'dt' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                    <label style={{ fontSize: '0.7rem' }}>Select Distribution Transformer:</label>
                    <select 
                      value={selectedSimDt} 
                      onChange={(e) => setSelectedSimDt(e.target.value)}
                      style={{ padding: 6, fontSize: '0.75rem', backgroundColor: 'var(--bg-main)', border: '1px solid var(--border-color)', color: 'var(--text-main)' }}
                    >
                      {transformers.map(dt => <option key={dt.id} value={dt.id}>{dt.id} (Feeder {dt.feeder_id})</option>)}
                    </select>
                  </div>
                )}

                {simType === 'span' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                    <div>
                      <label style={{ fontSize: '0.7rem' }}>1. Select Transformer Line:</label>
                      <select 
                        value={selectedSimDt} 
                        onChange={(e) => {
                          setSelectedSimDt(e.target.value);
                          setSelectedSimSpan('');
                        }}
                        style={{ width: '100%', padding: 6, fontSize: '0.75rem', backgroundColor: 'var(--bg-main)', border: '1px solid var(--border-color)', color: 'var(--text-main)' }}
                      >
                        {transformers.map(dt => <option key={dt.id} value={dt.id}>{dt.id}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: '0.7rem' }}>2. Select Span Wire:</label>
                      <select 
                        value={selectedSimSpan} 
                        onChange={(e) => setSelectedSimSpan(e.target.value)}
                        style={{ width: '100%', padding: 6, fontSize: '0.75rem', backgroundColor: 'var(--bg-main)', border: '1px solid var(--border-color)', color: 'var(--text-main)' }}
                      >
                        <option value="">-- Choose Span --</option>
                        {activeDtSpans.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  </div>
                )}

                {simType === 'noise' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                    <label style={{ fontSize: '0.7rem' }}>Silence Duration (Minutes):</label>
                    <input 
                      type="number" 
                      value={noiseMinutes} 
                      onChange={(e) => setNoiseMinutes(parseInt(e.target.value))}
                      style={{ padding: 6, fontSize: '0.75rem', backgroundColor: 'var(--bg-main)', border: '1px solid var(--border-color)', color: 'var(--text-main)' }}
                    />
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Values &gt; 16 mins trigger the watchdog silent telemetry alert.</span>
                  </div>
                )}

                {/* Simulation Action Buttons */}
                <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                  <button 
                    className="btn-primary" 
                    onClick={() => runOutageSimulation(false)}
                    disabled={isSimulating}
                    style={{ flex: 1, backgroundColor: 'var(--status-dark)', color: '#fff' }}
                  >
                    Inject Fault
                  </button>
                  <button 
                    className="btn-primary" 
                    onClick={() => runOutageSimulation(true)}
                    disabled={isSimulating}
                    style={{ flex: 1, backgroundColor: 'var(--status-live)', color: 'var(--accent-text)' }}
                  >
                    Trigger Repair
                  </button>
                </div>
              </div>

              {/* Scheduled Outages Form (Noise test) */}
              <div className="glass-panel" style={{ padding: 10 }}>
                <h3 style={{ fontSize: '0.8rem', fontWeight: 600, margin: '0 0 8px 0' }}>Inject Scheduled Maintenance Outage</h3>
                <form onSubmit={handleInjectMaintenance} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 6, alignItems: 'center' }}>
                    <label style={{ fontSize: '0.7rem' }}>Scope:</label>
                    <select 
                      value={maintenanceScope} 
                      onChange={(e) => setMaintenanceScope(e.target.value as any)}
                      style={{ padding: 4, fontSize: '0.75rem', backgroundColor: 'var(--bg-main)', border: '1px solid var(--border-color)', color: 'var(--text-main)' }}
                    >
                      <option value="dt">Transformer</option>
                      <option value="feeder">Feeder</option>
                    </select>

                    <label style={{ fontSize: '0.7rem' }}>Target ID:</label>
                    <input 
                      type="text" 
                      value={maintenanceTarget} 
                      onChange={(e) => setMaintenanceTarget(e.target.value)}
                      placeholder={maintenanceScope === 'feeder' ? 'e.g., F-01-01' : 'e.g., D-0101'}
                      style={{ padding: 4, fontSize: '0.75rem', backgroundColor: 'var(--bg-main)', border: '1px solid var(--border-color)', color: 'var(--text-main)' }}
                    />

                    <label style={{ fontSize: '0.7rem' }}>Reason:</label>
                    <input 
                      type="text" 
                      value={maintenanceReason} 
                      onChange={(e) => setMaintenanceReason(e.target.value)}
                      style={{ padding: 4, fontSize: '0.75rem', backgroundColor: 'var(--bg-main)', border: '1px solid var(--border-color)', color: 'var(--text-main)' }}
                    />
                  </div>
                  <button type="submit" className="btn-secondary" style={{ marginTop: 6, fontSize: '0.75rem', padding: '6px 12px' }}>
                    Schedule Shutdown
                  </button>
                </form>
              </div>

              {/* Simulation Logs & Console Output */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: 4 }}>Simulator Console Output:</label>
                <div style={{ flex: 1, minHeight: 100, overflowY: 'auto', background: 'var(--terminal-bg)', padding: 8, borderRadius: 6, fontFamily: 'monospace', fontSize: '0.65rem', color: 'var(--accent-color)' }}>
                  {simulationLogs.map((l, idx) => <div key={idx} style={{ marginBottom: 2 }}>{l}</div>)}
                </div>
              </div>

              {/* Database reset */}
              <button className="btn-secondary" onClick={handleResetDb} style={{ borderColor: 'rgba(239, 68, 68, 0.4)', color: 'var(--status-dark)' }}>
                Reset Database state
              </button>
            </div>
          )}

        </section>

      </main>
    </div>
  );
}
