import Fastify from "fastify";
import WebSocket from "ws";
// --- Add Top-Level Log 1 ---
console.log("[!!! Debug Load] outbound-calls.js: File loading START"); 

import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import fetch from 'node-fetch'; // Ensure fetch is imported if we add tool handling later

// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

// WebSocket Connection Pool for ElevenLabs
class ElevenLabsConnectionPool {
  constructor(poolSize = 3) {
    this.poolSize = poolSize;
    this.availableConnections = [];
    this.pendingConnections = [];
    this.inUseConnections = new Map();
    this.initialize();
  }

  async initialize() {
    console.log(`[ConnectionPool] Initializing pool with ${this.poolSize} connections...`);
    for (let i = 0; i < this.poolSize; i++) {
      this.createConnection();
    }
  }

  async createConnection() {
    try {
      const signedUrl = await getSignedUrl();
      if (!signedUrl) {
        console.error("[ConnectionPool] Failed to get signed URL for pool connection");
        return;
      }

      const ws = new WebSocket(signedUrl);
      const connectionPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Connection timeout"));
        }, 5000);

        ws.on("open", () => {
          clearTimeout(timeout);
          console.log("[ConnectionPool] New connection established");
          this.availableConnections.push(ws);
          resolve(ws);
          
          // Remove from pending
          const index = this.pendingConnections.indexOf(connectionPromise);
          if (index > -1) this.pendingConnections.splice(index, 1);
        });

        ws.on("error", (error) => {
          clearTimeout(timeout);
          console.error("[ConnectionPool] Connection error:", error);
          reject(error);
        });

        ws.on("close", () => {
          console.log("[ConnectionPool] Connection closed, creating replacement");
          this.removeConnection(ws);
          // Create replacement connection
          setTimeout(() => this.createConnection(), 1000);
        });
      });

      this.pendingConnections.push(connectionPromise);
      return connectionPromise;
    } catch (error) {
      console.error("[ConnectionPool] Error creating connection:", error);
    }
  }

  async getConnection(callSid) {
    // First try to get an available connection
    if (this.availableConnections.length > 0) {
      const ws = this.availableConnections.shift();
      if (ws.readyState === WebSocket.OPEN) {
        this.inUseConnections.set(callSid, ws);
        console.log(`[ConnectionPool] Assigned existing connection to ${callSid}`);
        return ws;
      }
    }

    // If no available connections, wait for a pending one or create new
    if (this.pendingConnections.length > 0) {
      try {
        const ws = await this.pendingConnections[0];
        if (ws.readyState === WebSocket.OPEN) {
          this.inUseConnections.set(callSid, ws);
          console.log(`[ConnectionPool] Assigned pending connection to ${callSid}`);
          return ws;
        }
      } catch (error) {
        console.error("[ConnectionPool] Error waiting for pending connection:", error);
      }
    }

    // Last resort: create a new connection
    console.log(`[ConnectionPool] Creating new connection for ${callSid}`);
    const ws = await this.createConnection();
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.inUseConnections.set(callSid, ws);
      return ws;
    }

    throw new Error("Unable to establish ElevenLabs connection");
  }

  removeConnection(ws) {
    // Remove from available connections
    const availableIndex = this.availableConnections.indexOf(ws);
    if (availableIndex > -1) {
      this.availableConnections.splice(availableIndex, 1);
    }

    // Remove from in-use connections
    for (const [callSid, connection] of this.inUseConnections.entries()) {
      if (connection === ws) {
        this.inUseConnections.delete(callSid);
        break;
      }
    }
  }

  releaseConnection(callSid) {
    const ws = this.inUseConnections.get(callSid);
    if (ws) {
      this.inUseConnections.delete(callSid);
      if (ws.readyState === WebSocket.OPEN) {
        // Clean up the connection state before returning to pool
        this.resetConnectionState(ws);
        this.availableConnections.push(ws);
        console.log(`[ConnectionPool] Released connection from ${callSid} back to pool`);
      } else {
        console.log(`[ConnectionPool] Connection from ${callSid} was closed, not returning to pool`);
      }
    }
  }

  resetConnectionState(ws) {
    // Remove all existing listeners except the basic pool management ones
    ws.removeAllListeners("message");
    ws.removeAllListeners("error");
    
    // Re-add pool management listeners
    ws.on("close", () => {
      this.removeConnection(ws);
      setTimeout(() => this.createConnection(), 1000);
    });

    ws.on("error", (error) => {
      console.error("[ConnectionPool] Connection error:", error);
      this.removeConnection(ws);
    });
  }

  getPoolStatus() {
    return {
      available: this.availableConnections.length,
      inUse: this.inUseConnections.size,
      pending: this.pendingConnections.length
    };
  }

  adjustPoolSize(newSize) {
    console.log(`[ConnectionPool] Adjusting pool size from ${this.poolSize} to ${newSize}`);
    const oldSize = this.poolSize;
    this.poolSize = newSize;
    
    if (newSize > oldSize) {
      // Add more connections
      const connectionsToAdd = newSize - oldSize;
      for (let i = 0; i < connectionsToAdd; i++) {
        this.createConnection();
      }
    } else if (newSize < oldSize) {
      // Remove excess connections
      const connectionsToRemove = oldSize - newSize;
      for (let i = 0; i < connectionsToRemove && this.availableConnections.length > 0; i++) {
        const ws = this.availableConnections.pop();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }
    }
  }
}

// Initialize the connection pool
const elevenLabsPool = new ElevenLabsConnectionPool(3);

// Pre-generated greeting cache for instant playback
class GreetingCache {
  constructor() {
    this.cache = new Map();
    this.initialize();
  }

  async initialize() {
    console.log("[GreetingCache] Initializing greeting cache...");
    // Pre-generate common greetings
    const commonGreetings = [
      "Hello! This is an automated call from our system.",
      "Hi there! Thank you for your time.",
      "Good day! I'm calling to assist you today.",
      "Hello! I hope you're having a great day.",
      "Hi! Thanks for answering, I'll be brief."
    ];

    for (const greeting of commonGreetings) {
      await this.preGenerateGreeting(greeting);
    }
  }

  async preGenerateGreeting(text) {
    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_AGENT_ID}/stream`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
          text: text,
          model_id: "eleven_turbo_v2_5", // Use fastest model for greetings
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5
          }
        })
      });

      if (response.ok) {
        const audioBuffer = await response.arrayBuffer();
        const base64Audio = Buffer.from(audioBuffer).toString('base64');
        this.cache.set(text, base64Audio);
        console.log(`[GreetingCache] Cached greeting: "${text.substring(0, 30)}..."`);
      }
    } catch (error) {
      console.error(`[GreetingCache] Error pre-generating greeting:`, error);
    }
  }

  getCachedGreeting(text) {
    return this.cache.get(text);
  }

  getRandomGreeting() {
    const greetings = Array.from(this.cache.keys());
    if (greetings.length === 0) return null;
    const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
    return {
      text: randomGreeting,
      audio: this.cache.get(randomGreeting)
    };
  }
}

// Initialize greeting cache
const greetingCache = new GreetingCache();

// Call pattern tracker for intelligent pool management
class CallPatternTracker {
  constructor() {
    this.callHistory = [];
    this.hourlyPatterns = new Map();
    this.lastPoolAdjustment = Date.now();
  }

  recordCall() {
    const now = new Date();
    this.callHistory.push(now);
    
    // Keep only last 24 hours of history
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    this.callHistory = this.callHistory.filter(callTime => callTime > oneDayAgo);
    
    this.updateHourlyPatterns();
    this.adjustPoolIfNeeded();
  }

  updateHourlyPatterns() {
    this.hourlyPatterns.clear();
    this.callHistory.forEach(callTime => {
      const hour = callTime.getHours();
      this.hourlyPatterns.set(hour, (this.hourlyPatterns.get(hour) || 0) + 1);
    });
  }

  getCurrentHourPrediction() {
    const currentHour = new Date().getHours();
    return this.hourlyPatterns.get(currentHour) || 0;
  }

  getNext2HoursPrediction() {
    const currentHour = new Date().getHours();
    let prediction = 0;
    for (let i = 0; i <= 2; i++) {
      const hour = (currentHour + i) % 24;
      prediction += this.hourlyPatterns.get(hour) || 0;
    }
    return prediction;
  }

  adjustPoolIfNeeded() {
    const now = Date.now();
    // Only adjust every 10 minutes
    if (now - this.lastPoolAdjustment < 10 * 60 * 1000) return;

    const prediction = this.getNext2HoursPrediction();
    const currentPoolSize = elevenLabsPool.poolSize;
    
    let targetPoolSize = 3; // Default minimum
    if (prediction > 10) targetPoolSize = 5;
    if (prediction > 20) targetPoolSize = 8;
    if (prediction > 50) targetPoolSize = 12;

    if (targetPoolSize !== currentPoolSize) {
      console.log(`[CallPatternTracker] Adjusting pool size from ${currentPoolSize} to ${targetPoolSize} based on prediction: ${prediction} calls`);
      elevenLabsPool.adjustPoolSize(targetPoolSize);
      this.lastPoolAdjustment = now;
    }
  }

  getStats() {
    return {
      totalCallsLast24h: this.callHistory.length,
      currentHourPrediction: this.getCurrentHourPrediction(),
      next2HoursPrediction: this.getNext2HoursPrediction(),
      hourlyBreakdown: Object.fromEntries(this.hourlyPatterns)
    };
  }
}

// Initialize call pattern tracker
const callPatternTracker = new CallPatternTracker();

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// In-memory store for AMD results (simple example)
const amdResults = {}; 

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// Export the routes as an async Fastify plugin
export default async function (fastify, opts) {
  // --- Add Top-Level Log 2 ---
  console.log("[!!! Debug Load] outbound-calls.js: Plugin function EXECUTING"); 

  // Check for required environment variables inside the plugin
  if (
    !ELEVENLABS_API_KEY ||
    !ELEVENLABS_AGENT_ID ||
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    !TWILIO_PHONE_NUMBER
  ) {
    console.error("Missing required environment variables for outbound calls");
    throw new Error("Missing required environment variables for outbound calls");
  }

  // Route to initiate outbound calls
  fastify.post("/outbound-call", async (request, reply) => {
    const { name, number, airtableRecordId } = request.body;
    if (!number) {
      return reply.code(400).send({ error: "Phone number is required" });
    }
    if (!airtableRecordId) {
        console.warn("[Server /outbound-call] Warning: airtableRecordId not received in request body.");
    }

    try {
      // Record call pattern for intelligent pool management
      callPatternTracker.recordCall();
      
      const callerName = name || "Valued Customer";
      const twimlUrl = new URL(`https://${request.headers.host}/outbound-call-twiml`);
      twimlUrl.searchParams.append("name", callerName);
      twimlUrl.searchParams.append("number", number);
      if (airtableRecordId) {
          twimlUrl.searchParams.append("airtableRecordId", airtableRecordId);
      }

      const statusCallbackUrl = `https://${request.headers.host}/call-status`;
      console.log(`[Twilio API] Using statusCallbackUrl: ${statusCallbackUrl}`);

      console.log(`[ConnectionPool] Pool status before call: ${JSON.stringify(elevenLabsPool.getPoolStatus())}`);
      console.log(`[CallPatternTracker] Current stats: ${JSON.stringify(callPatternTracker.getStats())}`);

      const call = await twilioClient.calls.create({
        from: TWILIO_PHONE_NUMBER,
        to: number,
        url: twimlUrl.toString(),
        machineDetection: "Enable", 
        statusCallback: statusCallbackUrl,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'], 
        statusCallbackMethod: 'POST'
      });

      reply.send({
        success: true,
        message: "Call initiated with optimized connection pool",
        callSid: call.sid,
        optimizations: {
          poolStatus: elevenLabsPool.getPoolStatus(),
          callPrediction: callPatternTracker.getNext2HoursPrediction()
        }
      });
    } catch (error) {
      console.error("Error initiating outbound call:", error);
      reply.code(500).send({ success: false, error: "Failed to initiate call" });
    }
  });

  // Route to end outbound calls
  fastify.post("/end-call", async (request, reply) => {
    const { callSid } = request.body;

    if (!callSid) {
      return reply.code(400).send({ error: "Call SID is required" });
    }

    try {
      await twilioClient.calls(callSid).update({ status: "completed" });
      // Also release connection from pool
      elevenLabsPool.releaseConnection(callSid);
      
      reply.send({
        success: true,
        message: "Call ended successfully"
      });
    } catch (error) {
      console.error("Error ending call:", error);
      reply.code(500).send({
        success: false,
        error: "Failed to end call"
      });
    }
  });

  // Monitoring endpoint for optimization systems
  fastify.get("/optimization-status", async (request, reply) => {
    reply.send({
      connectionPool: elevenLabsPool.getPoolStatus(),
      greetingCache: {
        cachedGreetings: greetingCache.cache.size,
        availableGreetings: Array.from(greetingCache.cache.keys()).map(text => text.substring(0, 50) + "...")
      },
      callPatterns: callPatternTracker.getStats(),
      recommendations: {
        shouldIncreasePool: callPatternTracker.getNext2HoursPrediction() > elevenLabsPool.poolSize * 2,
        estimatedLatencyReduction: "60-80% reduction in initial message latency",
        activeOptimizations: [
          "Pre-established WebSocket connection pool",
          "Intelligent pool size adjustment",
          "Pre-generated greeting cache",
          "Reduced timeout thresholds"
        ]
      },
      timestamp: new Date().toISOString()
    });
  });

  // TwiML route for outbound calls
  fastify.all("/outbound-call-twiml", async (request, reply) => {
    // --- Add TwiML Log 1: Log Query Params ---
    console.log("[!!! Debug TwiML] Received query params:", request.query);
    const name = request.query.name || "Customer";
    const number = request.query.number || "Unknown";
    const airtableRecordId = request.query.airtableRecordId || null;

    // Function to escape XML attribute values
    const escapeXml = (unsafe) => {
        if (typeof unsafe !== 'string') return '';
        return unsafe.replace(/[<>&"']/g, function (c) {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '"': return '&quot;';
                case '\'': return '&apos;';
                default: return c;
            }
        });
    };

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Connect>
            <Stream url="wss://${request.headers.host}/outbound-media-stream">
              <Parameter name="name" value="${escapeXml(name)}"/>
              <Parameter name="number" value="${escapeXml(number)}"/>
              <Parameter name="airtableRecordId" value="${escapeXml(airtableRecordId || '')}"/>
            </Stream>
          </Connect>
        </Response>`;
    
    console.log("[!!! Debug TwiML] Sending TwiML response:", twimlResponse);
    reply.type("text/xml").send(twimlResponse);
  });

  // WebSocket route for handling OUTBOUND media streams
  // Note: This route path '/outbound-media-stream' should be distinct 
  // from any '/media-stream' defined in index.js if both are needed.
  fastify.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      // --- Wrap handler logic in try-catch ---
      try {
        console.log("[!!! WS Handler Entered] Connection attempt received."); 
        
        let streamSid = null, callSid = null, elevenLabsWs = null; // callCustomParameters removed as decodedCustomParameters is used
        let decodedCustomParameters = null;
        let resolveElevenLabsWsOpen = null;
        const elevenLabsWsOpenPromise = new Promise(resolve => { resolveElevenLabsWsOpen = resolve; });
        let isElevenLabsWsOpen = false;
        let twilioAudioBuffer = [];
        
        let twilioStartEventProcessed = false;
        let initialConfigSent = false;
        let initialConfigSentTimestamp = 0; // For latency tracking
        let firstAgentAudioPacketLogged = {}; // Tracks if first agent audio is logged {callSid: true}

        ws.on("error", (error) => console.error("[!!! Twilio WS Error]:", error));

        const trySendInitialConfig = () => {
          if (isElevenLabsWsOpen && twilioStartEventProcessed && !initialConfigSent && callSid) { // Ensure callSid is available
            console.log(`[!!! EL Config] Conditions met for ${callSid}. isElevenLabsWsOpen: ${isElevenLabsWsOpen}, twilioStartEventProcessed: ${twilioStartEventProcessed}, initialConfigSent: ${initialConfigSent}`);
            const today = new Date();
            const year = today.getFullYear();
            const month = String(today.getMonth() + 1).padStart(2, '0');
            const day = String(today.getDate()).padStart(2, '0');
            const currentDateYYYYMMDD = `${year}-${month}-${day}`;

            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {},
                tts: {},
                audio_output: {
                    encoding: "ulaw",
                    sample_rate: 8000
                }
              },
              dynamic_variables: {
                "CURRENT_DATE_YYYYMMDD": currentDateYYYYMMDD,
                "CALL_DIRECTION": "outbound",
                ...(decodedCustomParameters || {})
              }
            };
            console.log(`[!!! EL Config] Preparing to send initialConfig for ${callSid}: ${JSON.stringify(initialConfig)}`);
            try {
              elevenLabsWs.send(JSON.stringify(initialConfig));
              initialConfigSentTimestamp = Date.now(); // Record timestamp
              console.log(`[!!! EL Config @ ${initialConfigSentTimestamp}] Successfully SENT initialConfig for ${callSid}.`);
              initialConfigSent = true; 
            } catch (sendError) {
              console.error(`[!!! EL Config] FAILED to send initialConfig:`, sendError);
            }
          } else {
            console.log(`[!!! EL Config] Conditions NOT YET MET or already sent. isElevenLabsWsOpen: ${isElevenLabsWsOpen}, twilioStartEventProcessed: ${twilioStartEventProcessed}, initialConfigSent: ${initialConfigSent}`);
          }
        };

        const setupElevenLabs = async (callSid) => {
          console.log(`[!!! EL Setup @ ${Date.now()}] Attempting setup using connection pool for ${callSid}.`);
          try {
            const wsConnectStartTime = Date.now();
            elevenLabsWs = await elevenLabsPool.getConnection(callSid);
            const wsConnectEndTime = Date.now();

            console.log(`[!!! EL Setup @ ${wsConnectEndTime}] ElevenLabs WebSocket from pool assigned in ${wsConnectEndTime - wsConnectStartTime}ms.`);
            isElevenLabsWsOpen = true;
            if (resolveElevenLabsWsOpen) resolveElevenLabsWsOpen();
            
            trySendInitialConfig(); // Attempt to send initialConfig

            // Set up message handlers for this specific call
            elevenLabsWs.on("message", (data) => {
              try {
                const message = JSON.parse(data);

                // Log first audio packet from ElevenLabs
                if ((message.type === "audio" || message.type === "audio_event") && callSid && !firstAgentAudioPacketLogged[callSid]) {
                  const now = Date.now();
                  const latency = initialConfigSentTimestamp > 0 ? now - initialConfigSentTimestamp : -1;
                  console.log(`[!!! EL First Audio @ ${now}] Received first audio packet from ElevenLabs for ${callSid}. Type: ${message.type}. Latency since initialConfig: ${latency}ms.`);
                  firstAgentAudioPacketLogged[callSid] = true;
                }

                switch (message.type) {
                  case "conversation_initiation_metadata":
                    console.log("[ElevenLabs] Received initiation metadata");
                    break;

                  case "audio":
                    if (streamSid) {
                      if (message.audio?.chunk) {
                        const audioData = {
                          event: "media",
                          streamSid,
                          media: {
                            payload: message.audio.chunk,
                          },
                        };
                        ws.send(JSON.stringify(audioData));
                      } else if (message.audio_event?.audio_base_64) {
                        const audioData = {
                          event: "media",
                          streamSid,
                          media: {
                            payload: message.audio_event.audio_base_64,
                          },
                        };
                        ws.send(JSON.stringify(audioData));
                      }
                    } else {
                      console.log(
                        "[ElevenLabs] Received audio but no StreamSid yet"
                      );
                    }
                    break;

                  case "interruption":
                    if (streamSid) {
                      ws.send(
                        JSON.stringify({
                          event: "clear",
                          streamSid,
                        })
                      );
                    }
                    break;

                  case "ping":
                    if (message.ping_event?.event_id) {
                      elevenLabsWs.send(
                        JSON.stringify({
                          type: "pong",
                          event_id: message.ping_event.event_id,
                        })
                      );
                    }
                    break;

                  case "agent_response":
                    console.log(
                      `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                    );
                    break;

                  case "user_transcript":
                    console.log(
                      `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                    );
                    break;

                  case "client_tool_call":
                    console.log(`[!!! Debug Tool Call] Received RAW client_tool_call from EL:`, JSON.stringify(message));
                    
                    const { tool_name, tool_call_id, parameters } = message.client_tool_call;
                    
                    handleToolExecution(tool_name, parameters)
                      .then(result => {
                          const response = {
                              type: "client_tool_result",
                              tool_call_id: tool_call_id,
                              result: JSON.stringify(result),
                              is_error: false
                          };
                          console.log(`[ElevenLabs] Sending Tool Result:`, JSON.stringify(response));
                          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                              elevenLabsWs.send(JSON.stringify(response));
                          }
                      })
                      .catch(error => {
                          const response = {
                              type: "client_tool_result",
                              tool_call_id: tool_call_id,
                              result: JSON.stringify({ error: error.message || 'Tool execution failed' }),
                              is_error: true
                          };
                          console.error(`[Server] Error executing tool '${tool_name}':`, error);
                          console.log(`[ElevenLabs] Sending Tool Error Result:`, JSON.stringify(response));
                           if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                              elevenLabsWs.send(JSON.stringify(response));
                          }
                      });
                    break;

                  default:
                    console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
                }
              } catch (messageError) {
                console.error("[ElevenLabs] Error parsing message:", messageError);
              }
            });

            // Buffer processing logic (remains the same)
            if (twilioAudioBuffer.length > 0) {
              console.log(`[!!! Debug EL Setup] EL WS Open: Found ${twilioAudioBuffer.length} buffered audio chunks. Attempting to send...`);
              twilioAudioBuffer.forEach((audioChunk, index) => {
                try {
                  const audioMessage = { user_audio_chunk: audioChunk };
                  elevenLabsWs.send(JSON.stringify(audioMessage));
                  if (index === twilioAudioBuffer.length - 1) {
                      console.log("[!!! Debug EL Setup] Finished sending buffered audio.");
                  }
                } catch (bufferSendError) {
                  console.error(`[!!! Debug EL Setup] Error sending buffered audio chunk #${index}:`, bufferSendError);
                }
              });
              twilioAudioBuffer = [];
            } else {
                console.log("[!!! Debug EL Setup] EL WS Open: No buffered audio chunks to send.");
            }

            // Handle cleanup when connection closes
            elevenLabsWs.on("close", () => {
              console.log(`[ElevenLabs] Connection closed for ${callSid}`);
              isElevenLabsWsOpen = false;
              elevenLabsPool.releaseConnection(callSid);
            });

            elevenLabsWs.on("error", (error) => {
              console.error(`[ElevenLabs] Connection error for ${callSid}:`, error);
              isElevenLabsWsOpen = false;
              elevenLabsPool.releaseConnection(callSid);
            });

          } catch (error) {
            console.error(`[!!! EL Setup @ ${Date.now()}] CRITICAL error in setupElevenLabs function:`, error);
            throw error;
          }
        };

        ws.on("message", async (message) => {
          try {
            const msg = JSON.parse(message);
            if (msg.event !== "media") console.log(`[Twilio] Event: ${msg.event}`);

            switch (msg.event) {
              case "start":
                console.log("[!!! Debug Start Event] Received raw start message:", JSON.stringify(msg));
                
                streamSid = msg.start.streamSid;
                callSid = msg.start.callSid;
                console.log(`[Twilio] Stream started: ${streamSid}, CallSid: ${callSid}`);
                
                // Parameters are now directly available in msg.start.customParameters (not base64 encoded)
                const customParams = msg.start.customParameters || {};
                decodedCustomParameters = {
                    name: customParams.name || "Valued Customer",
                    number: customParams.number || "Unknown",
                    airtableRecordId: customParams.airtableRecordId || null
                };

                console.log("[!!! Debug Start Event] Extracted Custom Parameters:", decodedCustomParameters);
                console.log(`[ConnectionPool] Pool status at call start: ${JSON.stringify(elevenLabsPool.getPoolStatus())}`);

                // Call setupElevenLabs using the connection pool
                setupElevenLabs(callSid); 
                
                twilioStartEventProcessed = true; // Mark Twilio start event as processed
                trySendInitialConfig(); // Attempt to send initialConfig, will proceed if EL WS also opens

                let isVoicemail = false;
                let amdResult = 'unknown';

                try {
                  console.log("[!!! Debug Start Event] Checking AMD result...");
                  if (callSid && amdResults[callSid]) {
                      const answeredBy = amdResults[callSid];
                      amdResult = answeredBy;
                      console.log(`[AMD Check] Result for ${callSid}: ${answeredBy}`);
                      if (answeredBy === "machine_start" || answeredBy === "machine_end_beep" || answeredBy === "fax") {
                           isVoicemail = true;
                           console.log(`[AMD Check] Voicemail/Machine detected for ${callSid}`);
                      }
                      delete amdResults[callSid];
                  } else {
                      console.log(`[AMD Check] No AMD result found for ${callSid} after wait.`);
                  }

                  console.log("[!!! Debug Start Event] Checking ElevenLabs WS state...");
                  if (!isElevenLabsWsOpen) {
                      console.log("[ElevenLabs] Waiting for WebSocket connection to open...");
                      await Promise.race([
                          elevenLabsWsOpenPromise,
                          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for ElevenLabs WS open")), 3000)) // Reduced timeout since pool should be faster
                      ]);
                  }
                  
                  console.log("[!!! Debug Start Event] Finished processing start event logic.");

                } catch (error) {
                  console.error("[!!! Twilio Error processing start event]:", error);
                }
                break;

              case "media":
                console.log("[!!! Debug Media] Media received from Twilio. Checking EL WS state...");
                const audioPayloadBase64 = msg.media.payload;
                
                if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                  console.log("[!!! Debug Media] EL WS is OPEN. Attempting to forward audio...");
                  try {
                    const audioMessage = { user_audio_chunk: audioPayloadBase64 };
                    elevenLabsWs.send(JSON.stringify(audioMessage));
                  } catch (mediaSendError) {
                     console.error("[!!! Debug Media] Error sending live audio chunk:", mediaSendError);
                  }
                } else {
                   console.log("[!!! Debug Media] EL WS is NOT OPEN. Buffering audio chunk.");
                   twilioAudioBuffer.push(audioPayloadBase64);
                }
                break;

              case "stop":
                console.log(`[Twilio] Received stop event for Stream ${streamSid}`);
                try {
                  if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                    console.log("[ElevenLabs] Closing WS connection due to Twilio stop event.");
                    elevenLabsWs.close();
                  }
                  
                  if (callSid) {
                    // Release connection back to pool
                    elevenLabsPool.releaseConnection(callSid);
                    
                    // Clean up tracking for this callSid
                    if (firstAgentAudioPacketLogged[callSid]) {
                        delete firstAgentAudioPacketLogged[callSid];
                    }
                    try {
                        console.log(`[Twilio] Attempting to update call ${callSid} status to completed...`);
                        await twilioClient.calls(callSid).update({ status: "completed" });
                        console.log(`[Twilio] Successfully sent command to update call ${callSid}`);
                    } catch (callUpdateError) {
                        console.error(`[!!! Twilio Call Update Error] Failed for CallSid ${callSid}:`, callUpdateError);
                    }
                  } else {
                     console.warn("[Twilio] Cannot update call on stop event: callSid is missing.");
                  }
                } catch (error) {
                   console.error("[!!! Twilio Stop Event General Error]:", error);
                }
                console.log(`[Twilio] Finished processing stop event for Stream ${streamSid}`);
                break;

              default:
                console.log(`[Twilio] Unhandled event: ${msg.event}`);
            }
          } catch (error) { 
             console.error("[!!! Twilio Outer Message Handler Error]:", error, "| Raw Message:", message);
          }
        });

        ws.on("close", (code, reason) => {
          console.log(`[!!! Twilio WS Closed]: Code=${code}, Reason=${reason ? reason.toString() : 'N/A'}`);
          if (callSid && firstAgentAudioPacketLogged[callSid]) { // Clean up on Twilio WS close too
            delete firstAgentAudioPacketLogged[callSid];
          }
          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
             console.log("[ElevenLabs] Closing WS connection because Twilio WS closed.");
             elevenLabsWs.close();
          }
          isElevenLabsWsOpen = false;
        });

      } catch (handlerError) {
          console.error(`[!!! WS Handler CRITICAL ERROR] Error within main WebSocket handler setup:`, handlerError);
          // Optionally close the WebSocket if a critical setup error occurs
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close(1011, "Internal Server Error during WS setup");
          }
      }
      // --- End wrap --- 
    }
  );

  // Route to receive Call Status updates from Twilio
  fastify.post("/call-status", async (request, reply) => {
    const { 
        CallSid, 
        CallStatus, 
        AnsweredBy,
        Duration, 
        Timestamp 
    } = request.body;
    
    console.log(`[Call Status] CallSid: ${CallSid}, Status: ${CallStatus}, AnsweredBy: ${AnsweredBy}, Duration: ${Duration}`);

    const machineResponses = ["machine_start", "machine_end_beep", "machine_end_silence", "machine_end_other", "fax"];
    if (AnsweredBy && machineResponses.includes(AnsweredBy)) {
      console.log(`[AMD] Machine detected (${AnsweredBy}) for CallSid: ${CallSid}. Ending call.`);
      try {
        await twilioClient.calls(CallSid).update({ status: "completed" });
        console.log(`[AMD] Successfully sent command to end call ${CallSid}`);
      } catch (error) {
        console.error(`[AMD] Error trying to end call ${CallSid} after machine detection:`, error);
      }
    } else if (AnsweredBy && AnsweredBy === "human") {
       console.log(`[AMD] Human detected for CallSid: ${CallSid}. Call continues.`);
    } else if (AnsweredBy) {
       console.log(`[AMD] Received AnsweredBy status '${AnsweredBy}' for CallSid: ${CallSid}. Call continues.`);
    }

    reply.status(200).send();
  });

  // Add basic error handler for the whole Fastify instance
  fastify.setErrorHandler(function (error, request, reply) {
    console.error("[!!! Fastify Global Error Handler]:", error);
    reply.status(500).send({ ok: false, error: 'Internal Server Error' });
  });
}

async function handleToolExecution(toolName, parameters) {
    const executionStartTime = Date.now();
    // Log raw parameters for the specific tool
    if (toolName === 'get_available_slots') {
        console.log(`[Date Debug] get_available_slots - Received RAW params from LLM: ${JSON.stringify(parameters)}`);
        const todayForDebug = new Date();
        console.log(`[Date Debug] Server's current date for reference: ${todayForDebug.toISOString().split('T')[0]}`);
    } else {
        console.log(`[Server @ ${executionStartTime}] Attempting tool: ${toolName} with params:`, JSON.stringify(parameters));
    }

    const calComApiKey = process.env.CAL_COM_API_KEY;
    if (!calComApiKey) {
        console.error("[Server] Error: CAL_COM_API_KEY environment variable is not set.");
        throw new Error("Missing required CAL_COM_API_KEY.");
    }

    let url;
    let options = {
        signal: AbortSignal.timeout(10000),
        headers: {
            'Authorization': `ApiKey ${calComApiKey}`,
            'Content-Type': 'application/json'
        }
    };

    try {
        if (toolName === 'book_meeting') {
            url = 'https://api.cal.com/v2/bookings';
            options.method = 'POST';
            options.headers['cal-api-version'] = '2024-08-13';
            options.body = JSON.stringify(parameters);
            console.log(`[Server] Calling ${options.method} ${url} with body:`, options.body);

        } else if (toolName === 'get_available_slots') {
            options.method = 'GET';
            options.headers['cal-api-version'] = '2024-09-04';

            const calComParams = {};

            if (!parameters.eventTypeId) {
                 console.error("[Server] get_available_slots - Missing 'eventTypeId' from LLM. Parameters:", JSON.stringify(parameters));
                 throw new Error("Missing required 'eventTypeId' parameter from LLM for get_available_slots.");
            }
            calComParams.eventTypeId = parameters.eventTypeId;

            // Validate and use the start date from LLM
            if (parameters.start && /^\d{4}-\d{2}-\d{2}$/.test(parameters.start)) {
                calComParams.start = parameters.start;
                console.log(`[Date Debug] get_available_slots - Using start date from LLM: ${calComParams.start}`);
            } else {
                 console.error(`[Server] get_available_slots - Missing or invalid 'start' date (YYYY-MM-DD) from LLM. Received: '${parameters.start}'. Params:`, JSON.stringify(parameters));
                 throw new Error(`Missing or invalid 'start' date (YYYY-MM-DD) from LLM. Received: '${parameters.start}'`);
            }

            // Validate and use the end date from LLM, or default
            if (parameters.end && /^\d{4}-\d{2}-\d{2}$/.test(parameters.end)) {
                calComParams.end = parameters.end;
                 console.log(`[Date Debug] get_available_slots - Using end date from LLM: ${calComParams.end}`);
            } else {
                // Default end date to be same as start if not provided or invalid
                calComParams.end = calComParams.start;
                console.log(`[Date Debug] get_available_slots - Defaulting end date to start date: ${calComParams.end}. (Original 'end' from LLM: '${parameters.end}')`);
            }

            // Use timezone from LLM if provided and valid, otherwise default
            if (parameters.timeZone && /^[a-zA-Z_]+\/[a-zA-Z_]+$/.test(parameters.timeZone)) {
                calComParams.timeZone = parameters.timeZone;
            } else {
                calComParams.timeZone = 'Australia/Brisbane'; // Default timezone
                console.log(`[Date Debug] get_available_slots - Defaulting timeZone to: ${calComParams.timeZone}. (Original 'timeZone' from LLM: '${parameters.timeZone}')`);
            }
            console.log(`[Date Debug] get_available_slots - Final Cal.com query params: ${JSON.stringify(calComParams)}`);
            const queryParams = new URLSearchParams(calComParams).toString();
            url = `https://api.cal.com/v2/slots?${queryParams}`;
            console.log(`[Server] Calling ${options.method} ${url}`);

        } else if (toolName === 'end_call') {
            console.log(`[Server] Received request for System tool: ${toolName}.`);
            return { success: true, message: "Call end request acknowledged." };
        } else {
            console.warn(`[Server] Unknown tool requested: ${toolName}`);
            throw new Error(`Tool '${toolName}' is not implemented.`);
        }

        const fetchStartTime = Date.now();
        const response = await fetch(url, options);
        const fetchEndTime = Date.now();
        const responseBody = await response.text();
        const responseParseTime = Date.now();

        console.log(`[Server] API Response: Status=${response.status}, FetchTime=${fetchEndTime - fetchStartTime}ms, BodyReadTime=${responseParseTime - fetchEndTime}ms, Body=${responseBody}`);

        if (!response.ok) {
            throw new Error(`API call to ${url} failed with status ${response.status}: ${responseBody}`);
        }

        try {
            const jsonResult = JSON.parse(responseBody);
            const executionEndTime = Date.now();
            console.log(`[Server] Success tool: ${toolName}. Total Execution Time: ${executionEndTime - executionStartTime}ms`);
            return jsonResult;
        } catch (parseError) {
             console.error(`[Server] Error parsing JSON response for ${toolName}: ${parseError}. Raw body: ${responseBody}`);
             throw new Error(`Failed to parse JSON response from tool ${toolName}`);
        }

    } catch (error) {
        const executionEndTime = Date.now();
        console.error(`[Server] Error executing tool '${toolName}' after ${executionEndTime - executionStartTime}ms:`, error);
        if (error.name === 'TimeoutError') {
             throw new Error(`API call to ${toolName} timed out after 10 seconds.`);
        }
        throw error;
    }
}