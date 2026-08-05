import { getDb } from '../db';
import { topologyService } from './topology';
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * AI Operator Co-Pilot Service
 * Parses grid state context and queries Gemini API (or returns an intelligent mock if no API key is set)
 */
export async function askCopilot(message: string, currentTicketId?: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  // 1. Gather context from database to pass to the model
  const db = await getDb();
  const openTickets = await db.all("SELECT * FROM tickets WHERE status != 'closed'");
  const activeOutages = await db.all("SELECT * FROM scheduled_outages");
  const deviceStats = await db.get(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN energized = 1 THEN 1 ELSE 0 END) as energized_count
    FROM devices
  `);

  // Build context string
  let context = `System State:
Total devices fitted: ${deviceStats?.total || 0}
Energized devices: ${deviceStats?.energized_count || 0}
De-energized/Offline devices: ${(deviceStats?.total || 0) - (deviceStats?.energized_count || 0)}

Active Open Incident Tickets:
${openTickets.map(t => `- ID: ${t.id}, Type: ${t.fault_type}, Target: ${t.target_id}, Status: ${t.status}, Confidence: ${(t.confidence * 100).toFixed(0)}%, Affected Poles: ${t.affected_poles_count}, Coordinates: ${t.coordinates}`).join('\n')}

Active/Planned Scheduled Maintenance:
${activeOutages.map(so => `- ID: ${so.id}, Scope: ${so.scope}, Target: ${so.target_id}, Time: ${so.start} to ${so.end}, Reason: ${so.reason}`).join('\n')}
`;

  if (currentTicketId) {
    const tDetails = openTickets.find(t => t.id === currentTicketId);
    if (tDetails) {
      context += `\nCurrently Selected Ticket for Detail Analysis:\n${JSON.stringify(tDetails, null, 2)}`;
    }
  }

  // 2. If API Key is missing, run the Intelligent Mock responder
  if (!apiKey) {
    return generateMockResponse(message, openTickets, activeOutages, context);
  }

  // 3. Make official Gemini API request using Google Generative AI SDK
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel(
      { model: 'gemini-3.6-flash' },
      { apiVersion: 'v1' }
    );
    
    const prompt = `You are the AI Operator Co-Pilot for the Karnataka State Power Distribution Board (KSPDB) control room.
Your job is to assist operators at 2 a.m. who are managing power line outages. Explain things in plain, professional English.

Context about the current grid state:
${context}

User question: "${message}"

Respond concisely in 2-3 paragraphs. If suggesting actions, list them clearly.`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    if (responseText) {
      return responseText.trim();
    } else {
      console.error('[Gemini SDK Error]: Empty response text');
      return "Error: Gemini returned an empty response. Here is the mock analysis instead:\n\n" + generateMockResponse(message, openTickets, activeOutages, context);
    }
  } catch (err: any) {
    console.error('[Gemini SDK Error Detail]:', err);
    return `Error: Gemini SDK returned an error: "${err.message || err}". Here is the mock analysis instead:\n\n` + generateMockResponse(message, openTickets, activeOutages, context);
  }
}

function generateMockResponse(
  message: string,
  openTickets: any[],
  activeOutages: any[],
  context: string
): string {
  const lowercaseMsg = message.toLowerCase();

  // Keyword check 1: Active outages / Maintenance
  if (lowercaseMsg.includes('outage') || lowercaseMsg.includes('maintenance') || lowercaseMsg.includes('scheduled')) {
    if (activeOutages.length === 0) {
      return `Currently, there are no active scheduled outages in the system database. All outages detected are treated as unscheduled faults.`;
    }
    const current = activeOutages[0];
    return `**Scheduled Outage Analysis:**
There is a scheduled maintenance shutdown active for **DT ${current.target_id}** due to **"${current.reason}"**. It started at ${new Date(current.start).toLocaleTimeString()} and is scheduled to end at ${new Date(current.end).toLocaleTimeString()}.
Any outages detected on this transformer are currently suppressed from creating alert tickets to avoid crying wolf.`;
  }

  // Keyword check 2: Ticket analysis
  if (lowercaseMsg.includes('ticket') || lowercaseMsg.includes('status')) {
    if (openTickets.length === 0) {
      return `All quiet on the grid! There are currently no active open tickets in the system. The network is running normally with all reporting devices energized.`;
    }
    const mainTicket = openTickets[0];
    return `**Incident Ticket Situational Report:**
I see ${openTickets.length} active tickets. The highest priority is **Ticket ${mainTicket.id}** (${mainTicket.fault_type} fault at ${mainTicket.target_id}).
* **Status:** ${mainTicket.status}
* **Downstream impact:** ${mainTicket.affected_poles_count} poles are currently dark.
* **Localization confidence:** ${(mainTicket.confidence * 100).toFixed(0)}% (${mainTicket.confidence_reason})
* **Next action:** If the crew is already deployed, wait for them to report completion. Once the telemetry recovers, the system will auto-verify the repair and close the ticket.`;
  }

  // Keyword check 3: General greeting
  if (lowercaseMsg.includes('hello') || lowercaseMsg.includes('hi') || lowercaseMsg.includes('help')) {
    return `Hello! I am your KSPDB Operator Co-Pilot. I can help you analyze active faults, explain confidence ratings, check scheduled load shedding maintenance, or inspect specific tickets.

**Try asking me:**
- *"What is the status of active tickets?"*
- *"Are there any scheduled outages?"*
- *"Can you explain the fault on span P-0101-002-P-0101-003?"*`;
  }

  // Fallback default response
  return `I've analyzed your query regarding: "${message}".

**Current System Summary:**
- There are ${openTickets.length} active open tickets.
- ${activeOutages.length} scheduled outages are in the maintenance feed.
- The localization engine is running in real-time, verifying ticket resolutions against live telemetry.

If you have a question about a specific ticket or feeder, please specify its name or ID so I can give you a detailed report.`;
}
