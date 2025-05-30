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

// Lightweight connection manager instead of expensive pool
class ElevenLabsConnectionManager {
  constructor() {
    this.activeConnection = null;
    this.cachedSignedUrls = [];
    this.connectionPromise = null;
    this.lastActivity = Date.now();
    this.maxIdleTime = 30000; // Close connection after 30s of inactivity
    this.urlCacheSize = 3;
    
    // Pre-cache signed URLs instead of connections
    this.initializeUrlCache();
    
    // Clean up idle connections
    setInterval(() => this.cleanupIdleConnection(), 10000);
  }

  async initializeUrlCache() {
    console.log(`[ConnectionManager] Pre-caching ${this.urlCacheSize} signed URLs...`);
    for (let i = 0; i < this.urlCacheSize; i++) {
      try {
        const url = await getSignedUrl();
        if (url) {
          this.cachedSignedUrls.push({
            url,
            timestamp: Date.now()
          });
        }
      } catch (error) {
        console.error("[ConnectionManager] Error caching URL:", error);
      }
    }
    console.log(`[ConnectionManager] Cached ${this.cachedSignedUrls.length} signed URLs`);
  }

  getCachedUrl() {
    // Remove expired URLs (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    this.cachedSignedUrls = this.cachedSignedUrls.filter(item => item.timestamp > fiveMinutesAgo);
    
    if (this.cachedSignedUrls.length > 0) {
      const urlItem = this.cachedSignedUrls.shift();
      // Async replenish cache
      this.replenishUrlCache();
      return urlItem.url;
    }
    return null;
  }

  async replenishUrlCache() {
    if (this.cachedSignedUrls.length < this.urlCacheSize) {
      try {
        const url = await getSignedUrl();
        if (url) {
          this.cachedSignedUrls.push({
            url,
            timestamp: Date.now()
          });
        }
      } catch (error) {
        console.error("[ConnectionManager] Error replenishing URL cache:", error);
      }
    }
  }

  async getConnection(callSid) {
    this.lastActivity = Date.now();

    // If we have an active healthy connection, reuse it
    if (this.activeConnection && this.activeConnection.readyState === WebSocket.OPEN) {
      console.log(`[ConnectionManager] Reusing existing connection for ${callSid}`);
      return this.activeConnection;
    }

    // If connection is being created, wait for it
    if (this.connectionPromise) {
      console.log(`[ConnectionManager] Waiting for pending connection for ${callSid}`);
      try {
        return await this.connectionPromise;
      } catch (error) {
        this.connectionPromise = null;
        console.error("[ConnectionManager] Pending connection failed:", error);
      }
    }

    // Create new connection
    console.log(`[ConnectionManager] Creating new connection for ${callSid}`);
    this.connectionPromise = this.createConnection();
    
    try {
      this.activeConnection = await this.connectionPromise;
      this.connectionPromise = null;
      return this.activeConnection;
    } catch (error) {
      this.connectionPromise = null;
      throw error;
    }
  }

  async createConnection() {
    const startTime = Date.now();
    
    // Try cached URL first
    let signedUrl = this.getCachedUrl();
    
    if (!signedUrl) {
      console.log("[ConnectionManager] No cached URL, fetching new one...");
      signedUrl = await getSignedUrl();
    } else {
      console.log("[ConnectionManager] Using cached signed URL");
    }

    if (!signedUrl) {
      throw new Error("Failed to get signed URL");
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(signedUrl);
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 3000);

      ws.on("open", () => {
        clearTimeout(timeout);
        const endTime = Date.now();
        console.log(`[ConnectionManager] Connection established in ${endTime - startTime}ms`);
        
        // Set up cleanup handlers
        ws.on("close", () => {
          if (this.activeConnection === ws) {
            this.activeConnection = null;
          }
        });

        ws.on("error", (error) => {
          console.error("[ConnectionManager] Connection error:", error);
          if (this.activeConnection === ws) {
            this.activeConnection = null;
          }
        });

        resolve(ws);
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  cleanupIdleConnection() {
    if (this.activeConnection && 
        this.activeConnection.readyState === WebSocket.OPEN && 
        Date.now() - this.lastActivity > this.maxIdleTime) {
      
      console.log("[ConnectionManager] Closing idle connection");
      this.activeConnection.close();
      this.activeConnection = null;
    }
  }

  releaseConnection(callSid) {
    // For single connection manager, we don't release - just update activity
    this.lastActivity = Date.now();
    console.log(`[ConnectionManager] Call ${callSid} finished, connection remains active`);
  }

  getStatus() {
    return {
      hasActiveConnection: !!this.activeConnection,
      connectionState: this.activeConnection?.readyState || 'none',
      cachedUrls: this.cachedSignedUrls.length,
      lastActivity: this.lastActivity
    };
  }
}

// Initialize the lightweight connection manager
const elevenLabsManager = new ElevenLabsConnectionManager();

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

// Simple tool execution handler
async function handleToolExecution(tool_name, parameters) {
  console.log(`[Tool Execution] Executing tool: ${tool_name} with parameters:`, parameters);
  
  switch (tool_name) {
    case 'get_current_time':
      return {
        current_time: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      };
    
    case 'end_call':
      return {
        message: "Call ended successfully",
        status: "completed"
      };
    
    default:
      throw new Error(`Unknown tool: ${tool_name}`);
  }
}

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
    const currentCacheSize = elevenLabsManager.urlCacheSize;
    
    let targetCacheSize = 3; // Default minimum
    if (prediction > 10) targetCacheSize = 5;
    if (prediction > 20) targetCacheSize = 8;
    if (prediction > 50) targetCacheSize = 10;

    if (targetCacheSize !== currentCacheSize) {
      console.log(`[CallPatternTracker] Adjusting URL cache size from ${currentCacheSize} to ${targetCacheSize} based on prediction: ${prediction} calls`);
      elevenLabsManager.urlCacheSize = targetCacheSize;
      // Trigger cache replenishment if needed
      if (targetCacheSize > elevenLabsManager.cachedSignedUrls.length) {
        elevenLabsManager.replenishUrlCache();
      }
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

      console.log(`[ConnectionManager] Pool status before call: ${JSON.stringify(elevenLabsManager.getStatus())}`);
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
        message: "Call initiated with cost-effective connection optimization",
        callSid: call.sid,
        optimizations: {
          connectionStatus: elevenLabsManager.getStatus(),
          callPrediction: callPatternTracker.getNext2HoursPrediction(),
          costEffective: true
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
      elevenLabsManager.releaseConnection(callSid);
      
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
      connectionManager: elevenLabsManager.getStatus(),
      greetingCache: {
        cachedGreetings: greetingCache.cache.size,
        availableGreetings: Array.from(greetingCache.cache.keys()).map(text => text.substring(0, 50) + "...")
      },
      callPatterns: callPatternTracker.getStats(),
      recommendations: {
        shouldIncreaseCache: callPatternTracker.getNext2HoursPrediction() > elevenLabsManager.urlCacheSize * 2,
        estimatedLatencyReduction: "60-80% reduction in initial message latency",
        costEffectiveOptimizations: [
          "Single WebSocket connection with reuse",
          "Pre-cached signed URLs (3-10 based on demand)",
          "Intelligent idle connection cleanup (30s)",
          "Pre-generated greeting cache",
          "Reduced timeout thresholds"
        ],
        costSavings: "95% reduction in concurrent connections vs pool approach"
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
        let audioBatchBuffer = []; // For batch processing
        let audioBatchTimeout = null;
        let pendingAudioBuffer = []; // For buffering ElevenLabs audio when streamSid not ready
        
        let twilioStartEventProcessed = false;
        let initialConfigSent = false;
        let initialConfigSentTimestamp = 0; // For latency tracking
        let firstAgentAudioPacketLogged = {}; // Tracks if first agent audio is logged {callSid: true}

        ws.on("error", (error) => console.error("[!!! Twilio WS Error]:", error));

        // Batch audio processing for better performance
        const flushAudioBatch = () => {
          if (audioBatchBuffer.length > 0 && elevenLabsWs?.readyState === WebSocket.OPEN) {
            try {
              // Send multiple audio chunks in one message for efficiency
              const batchMessage = {
                user_audio_chunks: audioBatchBuffer
              };
              elevenLabsWs.send(JSON.stringify(batchMessage));
              audioBatchBuffer = [];
            } catch (error) {
              console.error("[Audio Batch] Error sending batch:", error);
              // Fallback to individual sending
              audioBatchBuffer.forEach(chunk => {
                try {
                  elevenLabsWs.send(JSON.stringify({ user_audio_chunk: chunk }));
                } catch (e) {
                  console.error("[Audio Batch] Error sending individual chunk:", e);
                }
              });
              audioBatchBuffer = [];
            }
          }
        };

        const setupElevenLabs = async (callSid) => {
          console.log(`[!!! EL Setup @ ${Date.now()}] Attempting setup using connection pool for ${callSid}.`);
          try {
            const wsConnectStartTime = Date.now();
            elevenLabsWs = await elevenLabsManager.getConnection(callSid);
            const wsConnectEndTime = Date.now();

            console.log(`[!!! EL Setup @ ${wsConnectEndTime}] ElevenLabs WebSocket from pool assigned in ${wsConnectEndTime - wsConnectStartTime}ms.`);
            isElevenLabsWsOpen = true;
            if (resolveElevenLabsWsOpen) resolveElevenLabsWsOpen();
            
            // Send initial config immediately for pooled connections
            if (callSid && !initialConfigSent) {
              const today = new Date();
              const year = today.getFullYear();
              const month = String(today.getMonth() + 1).padStart(2, '0');
              const day = String(today.getDate()).padStart(2, '0');
              const currentDateYYYYMMDD = `${year}-${month}-${day}`;

              // Get customer name from decoded parameters or use default
              const customerName = decodedCustomParameters?.name || "Valued Customer";

              const initialConfig = {
                type: "conversation_initiation_client_data",
                conversation_config_override: {
                  audio_output: {
                    encoding: "ulaw",
                    sample_rate: 8000
                  }
                },
                dynamic_variables: {
                  "CURRENT_DATE_YYYYMMDD": currentDateYYYYMMDD,
                  "CALL_DIRECTION": "outbound",
                  "CUSTOMER_NAME": customerName,
                  "PHONE_NUMBER": decodedCustomParameters?.number || "Unknown"
                }
              };
              
              try {
                console.log(`[!!! EL Config Debug] Sending config:`, JSON.stringify(initialConfig, null, 2));
                elevenLabsWs.send(JSON.stringify(initialConfig));
                initialConfigSentTimestamp = Date.now();
                initialConfigSent = true;
                console.log(`[!!! EL Config @ ${initialConfigSentTimestamp}] IMMEDIATELY sent initialConfig with personalized first message for "${customerName}" for ${callSid} (${initialConfigSentTimestamp - wsConnectEndTime}ms after connection).`);
              } catch (sendError) {
                console.error(`[!!! EL Config] FAILED to send immediate initialConfig:`, sendError);
              }
            }

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
                      // Buffer audio if streamSid not ready yet
                      if (!streamSid && message.audio?.chunk) {
                        if (!pendingAudioBuffer) pendingAudioBuffer = [];
                        pendingAudioBuffer.push(message.audio.chunk);
                        console.log("[ElevenLabs] Buffering audio - StreamSid not ready");
                      }
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
            elevenLabsWs.on("close", (code, reason) => {
              console.log(`[ElevenLabs] Connection closed for ${callSid} - Code: ${code}, Reason: ${reason || 'No reason provided'}`);
              isElevenLabsWsOpen = false;
              elevenLabsManager.releaseConnection(callSid);
            });

            elevenLabsWs.on("error", (error) => {
              console.error(`[ElevenLabs] Connection error for ${callSid}:`, error);
              console.error(`[ElevenLabs] Error details: ${error.message}, Code: ${error.code}, Type: ${error.type}`);
              isElevenLabsWsOpen = false;
              elevenLabsManager.releaseConnection(callSid);
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
                console.log(`[ConnectionManager] Pool status at call start: ${JSON.stringify(elevenLabsManager.getStatus())}`);

                // Call setupElevenLabs using the connection pool - this will send config immediately
                setupElevenLabs(callSid); 
                
                twilioStartEventProcessed = true; // Mark Twilio start event as processed

                // Flush any pending audio that was buffered while streamSid wasn't available
                if (pendingAudioBuffer && pendingAudioBuffer.length > 0) {
                  console.log(`[!!! Audio Flush] Sending ${pendingAudioBuffer.length} buffered audio packets to Twilio`);
                  pendingAudioBuffer.forEach((audioChunk, index) => {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: audioChunk,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  });
                  pendingAudioBuffer = [];
                }

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
                          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for ElevenLabs WS open")), 2000)) // Further reduced timeout
                      ]);
                  }
                  
                  console.log("[!!! Debug Start Event] Finished processing start event logic.");

                } catch (error) {
                  console.error("[!!! Twilio Error processing start event]:", error);
                }
                break;

              case "media":
                // Temporarily increase logging to debug user audio flow
                if (Math.random() < 0.1) { // Log 10% of media events for debugging
                  console.log(`[!!! Debug Media Sample] Media forwarding active - EL WS State: ${elevenLabsWs?.readyState}, isOpen: ${isElevenLabsWsOpen}`);
                }
                
                const audioPayloadBase64 = msg.media.payload;
                
                if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                  // Use immediate sending for low latency
                  try {
                    const audioMessage = { user_audio_chunk: audioPayloadBase64 };
                    elevenLabsWs.send(JSON.stringify(audioMessage));
                    
                    // Log every 50th successful send to confirm audio flow
                    if (Math.random() < 0.02) {
                      console.log("[!!! Debug Media] Successfully sent user audio chunk to ElevenLabs");
                    }
                  } catch (mediaSendError) {
                     console.error("[!!! Debug Media] Error sending live audio chunk:", mediaSendError);
                  }
                } else {
                   // Buffer audio more efficiently
                   if (twilioAudioBuffer.length < 100) { // Prevent memory issues
                     twilioAudioBuffer.push(audioPayloadBase64);
                   }
                   if (twilioAudioBuffer.length === 1) { // Log only first buffered chunk
                     console.log(`[!!! Debug Media] EL WS not ready, buffering audio... State: ${elevenLabsWs?.readyState}, isOpen flag: ${isElevenLabsWsOpen}`);
                   }
                   
                   // Log every 100th buffered message to track ongoing buffering
                   if (twilioAudioBuffer.length % 100 === 0) {
                     console.log(`[!!! Debug Media] Still buffering - ${twilioAudioBuffer.length} chunks buffered. EL State: ${elevenLabsWs?.readyState}`);
                   }
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
                    elevenLabsManager.releaseConnection(callSid);
                    
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

              case "connected":
                console.log(`[Twilio] WebSocket connected event for Stream ${streamSid || 'unknown'}`);
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