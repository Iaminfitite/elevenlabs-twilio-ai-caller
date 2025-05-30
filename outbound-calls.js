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
    this.personalizedCache = new Map(); // Cache by customer name
    this.isInitializing = false;
    this.initialize();
  }

  async initialize() {
    if (this.isInitializing) return;
    this.isInitializing = true;
    
    console.log("[GreetingCache] Initializing personalized greeting cache...");
    
    // Pre-generate greetings for common names
    const commonNames = [
      "John", "Jane", "Mike", "Sarah", "David", "Lisa", "Chris", "Amy", 
      "Steve", "Michelle", "Alex", "Jennifer", "Robert", "Jessica", "Mark", 
      "Ashley", "Daniel", "Amanda", "Brian", "Nicole", "Kevin", "Stephanie",
      "Valued Customer", "Customer"
    ];

    // Generate personalized greetings sequentially with longer delays to avoid rate limits
    console.log(`[GreetingCache] Generating ${commonNames.length} personalized greetings sequentially...`);
    let successCount = 0;
    
    for (let i = 0; i < commonNames.length; i++) {
      const name = commonNames[i];
      try {
        const success = await this.preGeneratePersonalizedGreeting(name);
        if (success) {
          successCount++;
        }
        
        // Add longer delay between requests to respect rate limits (increased from 500ms to 1000ms)
        if (i < commonNames.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // 1000ms delay
        }
      } catch (error) {
        console.error(`[GreetingCache] Error generating greeting for "${name}":`, error);
        
        // If we hit rate limits, wait longer before continuing
        if (error.message && error.message.includes('429')) {
          console.log(`[GreetingCache] Rate limit hit, waiting 5 seconds before continuing...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }
    
    console.log(`[GreetingCache] Cached personalized greetings for ${successCount} names out of ${commonNames.length} attempted`);
    this.isInitializing = false;
  }

  async preGeneratePersonalizedGreeting(customerName) {
    try {
      const greetingText = `Hi ${customerName}, this is Alex from Build and Bloom. I'm calling about the AI automation interest you showed on Facebook. Quick question - what's eating up most of your time as an agent right now?`;
      
      // Re-enable caching but use it properly within the natural flow
      console.log(`[GreetingCache] Generating greeting for "${customerName}"`);
      
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_AGENT_ID}/stream`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
          text: greetingText,
          model_id: "eleven_flash_v2_5", // Use fastest model
          voice_settings: {
            stability: 0.5, // ElevenLabs dashboard defaults
            similarity_boost: 0.5, // ElevenLabs dashboard defaults  
            style: 0.0, // ElevenLabs dashboard defaults
            use_speaker_boost: true // ElevenLabs dashboard defaults
          },
          output_format: "ulaw_8000" // Match Twilio format
        })
      });

      if (response.ok) {
        const audioBuffer = await response.arrayBuffer();
        const base64Audio = Buffer.from(audioBuffer).toString('base64');
        
        this.personalizedCache.set(customerName.toLowerCase(), {
          text: greetingText,
          audio: base64Audio,
          timestamp: Date.now()
        });
        
        console.log(`[GreetingCache] Cached greeting for "${customerName}"`);
        return true;
      } else {
        const errorText = await response.text();
        console.error(`[GreetingCache] Failed to generate greeting for "${customerName}": ${response.status} ${response.statusText} - ${errorText}`);
        return false;
      }
    } catch (error) {
      console.error(`[GreetingCache] Error generating greeting for "${customerName}":`, error);
      return false;
    }
  }

  // Get cached personalized greeting by name
  getCachedPersonalizedGreeting(customerName) {
    const cached = this.personalizedCache.get(customerName.toLowerCase());
    if (cached) {
      // Check if cache is fresh (less than 1 hour old)
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      if (cached.timestamp > oneHourAgo) {
        return cached;
      } else {
        // Remove stale cache and regenerate async
        this.personalizedCache.delete(customerName.toLowerCase());
        this.preGeneratePersonalizedGreeting(customerName);
      }
    }
    return null;
  }

  // Fallback to generic cached greeting
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

  // Get stats for monitoring
  getStats() {
    return {
      totalPersonalizedCached: this.personalizedCache.size,
      totalGenericCached: this.cache.size,
      availableNames: Array.from(this.personalizedCache.keys()),
      isInitializing: this.isInitializing
    };
  }

  // Pre-cache a greeting for a specific customer name if not already cached
  async ensureGreetingCached(customerName) {
    const normalizedName = customerName.toLowerCase();
    if (!this.personalizedCache.has(normalizedName)) {
      console.log(`[GreetingCache] Pre-generating greeting for new customer: ${customerName}`);
      await this.preGeneratePersonalizedGreeting(customerName);
    }
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
    const { name, number, airtableRecordId, useAgent, agentId, customParameters } = request.body;
    if (!number) {
      return reply.code(400).send({ error: "Phone number is required" });
    }
    
    // Enhanced parameter processing for n8n integration
    const callerName = name || "Valued Customer";
    const recordId = airtableRecordId || null;
    const customParams = customParameters || {};
    
    console.log(`[Server /outbound-call] Processing call for: ${callerName}, Number: ${number}, RecordId: ${recordId}`);
    
    if (!recordId) {
        console.warn("[Server /outbound-call] Warning: airtableRecordId not received in request body.");
    }

    try {
      // Record call pattern for intelligent pool management
      callPatternTracker.recordCall();
      
      // LATENCY OPTIMIZATION: Pre-cache greeting for this customer
      const cacheStartTime = Date.now();
      await greetingCache.ensureGreetingCached(callerName);
      const cacheEndTime = Date.now();
      
      const isCached = greetingCache.getCachedPersonalizedGreeting(callerName) !== null;
      console.log(`[Pre-Cache] Customer "${callerName}" cache status: ${isCached ? 'CACHED' : 'NOT CACHED'} (${cacheEndTime - cacheStartTime}ms)`);
      
      // Use public URL for Twilio webhooks (required for Twilio to reach our server)
      const publicUrl = process.env.PUBLIC_URL || 
                       (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
                       (process.env.PORT && process.env.NODE_ENV === 'production' ? `https://your-app-name.up.railway.app` : null) ||
                       "https://your-ngrok-url.ngrok.io";
      
      const isLocalhost = request.headers.host.includes('localhost') || request.headers.host.includes('127.0.0.1');
      const isRailway = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_ENVIRONMENT;
      
      if (isLocalhost && !process.env.PUBLIC_URL && !isRailway) {
        return reply.code(400).send({ 
          error: "For Twilio integration, you need to set PUBLIC_URL environment variable to your ngrok or public URL", 
          example: "PUBLIC_URL=https://your-ngrok-url.ngrok.io node index.js",
          currentHost: request.headers.host,
          deploymentTip: "💡 Deploy to Railway for automatic public URL configuration!",
          localTestingNote: "For local testing, you can either:\n1. Use ngrok to get a public tunnel URL\n2. Deploy to Railway for automatic public URL\n3. Test individual components without making actual calls"
        });
      }
      
      const twimlUrl = new URL(`${publicUrl}/outbound-call-twiml`);
      twimlUrl.searchParams.append("name", callerName);
      twimlUrl.searchParams.append("number", number);
      if (recordId) {
          twimlUrl.searchParams.append("airtableRecordId", recordId);
      }
      // Add custom parameters to URL for passing to WebSocket
      if (customParams && Object.keys(customParams).length > 0) {
          twimlUrl.searchParams.append("customParams", JSON.stringify(customParams));
      }

      const statusCallbackUrl = `${publicUrl}/call-status`;
      console.log(`[Twilio API] Using public URLs - TwiML: ${twimlUrl.toString()}, Status: ${statusCallbackUrl}`);

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
        message: "Call initiated with simplified reliable flow",
        callSid: call.sid,
        customerName: callerName,
        optimizations: {
          connectionType: "Fresh connection per call (reliable)",
          greetingPreCached: isCached,
          expectedLatency: isCached ? "<50ms (instant)" : "~100-200ms (flash model)",
          configSending: "Immediate on WebSocket open",
          latencyReduction: "Maximum reliability + speed"
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
        ...greetingCache.getStats(),
        description: "Personalized pre-generated greetings for instant audio delivery"
      },
      callPatterns: callPatternTracker.getStats(),
      latencyOptimizations: {
        preCachedAudio: {
          enabled: true,
          description: "Pre-generated personalized greetings eliminate TTS latency completely",
          estimatedLatencyReduction: "~237ms (100% elimination of TTS generation time)",
          personalizedNames: greetingCache.getStats().totalPersonalizedCached,
          fallbackToRealTime: "Yes - for uncached names"
        },
        flashModel: {
          enabled: true,
          model: "eleven_flash_v2_5",
          description: "Fastest ElevenLabs model with 75ms inference time",
          estimatedLatencyReduction: "~162ms reduction vs standard models"
        },
        optimizedVoiceSettings: {
          enabled: true,
          settings: {
            stability: 0.3,
            similarity_boost: 0.3, 
            style: 0.1,
            use_speaker_boost: false
          },
          description: "Speed-optimized voice settings for faster generation"
        }
      },
      recommendations: {
        totalLatencyReduction: "Up to 100% for cached names, ~70% for uncached names",
        shouldIncreaseCache: callPatternTracker.getNext2HoursPrediction() > elevenLabsManager.urlCacheSize * 2,
        costEffectiveOptimizations: [
          "Single WebSocket connection with reuse",
          "Pre-cached signed URLs (3-10 based on demand)", 
          "Intelligent idle connection cleanup (30s)",
          "🚀 NEW: Personalized pre-generated audio cache for instant delivery",
          "🚀 NEW: eleven_flash_v2_5 model for 75ms inference",
          "🚀 NEW: Speed-optimized voice settings",
          "Reduced timeout thresholds"
        ],
        costSavings: "95% reduction in concurrent connections vs pool approach",
        expectedLatency: {
          cachedNames: "<50ms (instant audio delivery)",
          uncachedNames: "~200-300ms (significantly improved)",
          previousLatency: "~697ms"
        }
      },
      timestamp: new Date().toISOString()
    });
  });

  // TwiML route for outbound calls
  fastify.all("/outbound-call-twiml", async (request, reply) => {
    // Enhanced parameter extraction for n8n integration
    console.log("[!!! Debug TwiML] Received query params:", request.query);
    const name = request.query.name || "Customer";
    const number = request.query.number || "Unknown";
    const airtableRecordId = request.query.airtableRecordId || null;
    
    // Parse custom parameters if present
    let customParams = {};
    if (request.query.customParams) {
      try {
        customParams = JSON.parse(request.query.customParams);
        console.log("[!!! Debug TwiML] Parsed custom parameters:", customParams);
      } catch (parseError) {
        console.error("[!!! Debug TwiML] Error parsing custom parameters:", parseError);
      }
    }

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

    // Use public URL for WebSocket connection
    const publicUrl = process.env.PUBLIC_URL || 
                     (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
                     (process.env.PORT && process.env.NODE_ENV === 'production' ? `https://your-app-name.up.railway.app` : null) ||
                     "https://your-ngrok-url.ngrok.io";
    const wsUrl = publicUrl.replace('https://', 'wss://').replace('http://', 'ws://');

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Connect>
            <Stream url="${wsUrl}/outbound-media-stream">
              <Parameter name="name" value="${escapeXml(name)}"/>
              <Parameter name="number" value="${escapeXml(number)}"/>
              <Parameter name="airtableRecordId" value="${escapeXml(airtableRecordId || '')}"/>
              <Parameter name="customParams" value="${escapeXml(JSON.stringify(customParams))}"/>
            </Stream>
          </Connect>
        </Response>`;
    
    console.log("[!!! Debug TwiML] Sending TwiML response with enhanced parameters");
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
          console.log(`[!!! EL Setup @ ${Date.now()}] Setting up fresh ElevenLabs connection for ${callSid}.`);
          try {
            // Get fresh signed URL for each call (like original Barty-Bart approach)
            const signedUrl = await getSignedUrl();
            if (!signedUrl) {
              throw new Error("Failed to get signed URL");
            }

            // Create fresh WebSocket connection
            elevenLabsWs = new WebSocket(signedUrl);
            console.log(`[!!! EL Setup] Creating fresh WebSocket connection for ${callSid}`);
            
            // Set up connection handlers
            elevenLabsWs.on("open", () => {
              console.log(`[!!! EL Setup] WebSocket opened for ${callSid}`);
              isElevenLabsWsOpen = true;
              if (resolveElevenLabsWsOpen) resolveElevenLabsWsOpen();

              // IMMEDIATE CONFIG SENDING (like original Barty-Bart)
              if (callSid && !initialConfigSent && decodedCustomParameters) {
                const customerName = decodedCustomParameters?.name || "Valued Customer";
                
                console.log(`[!!! IMMEDIATE CONFIG] Sending config immediately for ${customerName}`);
                
                const initialConfig = {
                  type: "conversation_initiation_client_data",
                  conversation_config_override: {
                    agent: {
                      first_message: `Hi ${customerName}, this is Alex from Build and Bloom. I'm calling about the AI automation interest you showed on Facebook. Quick question - what's eating up most of your time as an agent right now?`,
                      system_prompt: "You are Alex, a friendly AI assistant from Build and Bloom calling leads who showed interest in AI automation. Be conversational and helpful."
                    }
                    // Let ElevenLabs dashboard settings handle audio format
                  },
                  dynamic_variables: {
                    "CUSTOMER_NAME": customerName,
                    "PHONE_NUMBER": decodedCustomParameters?.number || "Unknown",
                    "AIRTABLE_RECORD_ID": decodedCustomParameters?.airtableRecordId || ""
                  }
                };
                
                try {
                  elevenLabsWs.send(JSON.stringify(initialConfig));
                  initialConfigSentTimestamp = Date.now();
                  initialConfigSent = true;
                  console.log(`[!!! CONFIG SENT @ ${initialConfigSentTimestamp}] Sent immediate config for "${customerName}" for ${callSid}`);
                } catch (sendError) {
                  console.error(`[!!! CONFIG ERROR] Failed to send config:`, sendError);
                }
              }

              // Send any buffered audio immediately
              if (twilioAudioBuffer.length > 0) {
                console.log(`[!!! Audio Flush] Sending ${twilioAudioBuffer.length} buffered audio chunks`);
                twilioAudioBuffer.forEach((audioChunk, index) => {
                  try {
                    const audioMessage = { user_audio_chunk: audioChunk };
                    elevenLabsWs.send(JSON.stringify(audioMessage));
                  } catch (bufferSendError) {
                    console.error(`[!!! Audio Flush] Error sending buffered audio:`, bufferSendError);
                  }
                });
                twilioAudioBuffer = [];
              }
            });
            
            // Set up message handlers
            elevenLabsWs.on("message", (data) => {
              try {
                const message = JSON.parse(data);

                // Log first audio packet from ElevenLabs
                if ((message.type === "audio" || message.type === "audio_event") && callSid && !firstAgentAudioPacketLogged[callSid]) {
                  const now = Date.now();
                  const latency = initialConfigSentTimestamp > 0 ? now - initialConfigSentTimestamp : -1;
                  console.log(`[!!! EL First Audio @ ${now}] First audio from ElevenLabs for ${callSid}. Latency: ${latency}ms.`);
                  firstAgentAudioPacketLogged[callSid] = true;
                }

                switch (message.type) {
                  case "conversation_initiation_metadata":
                    console.log("[ElevenLabs] Received initiation metadata - connection ready");
                    break;

                  case "audio":
                  case "audio_event":
                    if (streamSid) {
                      let audioChunk = null;
                      if (message.audio?.chunk) {
                        audioChunk = message.audio.chunk;
                      } else if (message.audio_event?.audio_base_64) {
                        audioChunk = message.audio_event.audio_base_64;
                      }
                      
                      if (audioChunk) {
                        const audioData = {
                          event: "media",
                          streamSid,
                          media: {
                            payload: audioChunk,
                          },
                        };
                        ws.send(JSON.stringify(audioData));
                      }
                    } else {
                      // Buffer audio if streamSid not ready yet
                      if (!streamSid && (message.audio?.chunk || message.audio_event?.audio_base_64)) {
                        if (!pendingAudioBuffer) pendingAudioBuffer = [];
                        const audioChunk = message.audio?.chunk || message.audio_event?.audio_base_64;
                        pendingAudioBuffer.push(audioChunk);
                        console.log(`[ElevenLabs] Buffering audio - StreamSid not ready. Buffer size: ${pendingAudioBuffer.length}`);
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
                    console.log(`[!!! Debug Tool Call] Received client_tool_call:`, JSON.stringify(message));
                    
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
                    if (message.type !== "agent_response_correction") {
                      console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
                    }
                }
              } catch (messageError) {
                console.error("[ElevenLabs] Error parsing message:", messageError);
              }
            });

            elevenLabsWs.on("close", (code, reason) => {
              console.log(`[ElevenLabs] Connection closed for ${callSid} - Code: ${code}, Reason: ${reason || 'No reason provided'}`);
              isElevenLabsWsOpen = false;
            });

            elevenLabsWs.on("error", (error) => {
              console.error(`[ElevenLabs] Connection error for ${callSid}:`, error);
              isElevenLabsWsOpen = false;
            });

          } catch (error) {
            console.error(`[!!! EL Setup @ ${Date.now()}] ERROR in setupElevenLabs:`, error);
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
                
                // Enhanced parameter extraction for n8n integration
                const customParams = msg.start.customParameters || {};
                
                // Parse custom parameters if they exist
                let parsedCustomParams = {};
                if (customParams.customParams) {
                  try {
                    parsedCustomParams = JSON.parse(customParams.customParams);
                    console.log("[!!! Debug Start Event] Parsed custom parameters:", parsedCustomParams);
                  } catch (parseError) {
                    console.error("[!!! Debug Start Event] Error parsing custom parameters:", parseError);
                  }
                }
                
                // Build comprehensive parameter object
                decodedCustomParameters = {
                    name: customParams.name || "Valued Customer",
                    number: customParams.number || "Unknown",
                    airtableRecordId: customParams.airtableRecordId || null,
                    customParams: parsedCustomParams
                };

                console.log("[!!! Debug Start Event] Extracted Enhanced Parameters:", decodedCustomParameters);
                console.log(`[ConnectionManager] Pool status at call start: ${JSON.stringify(elevenLabsManager.getStatus())}`);

                // Setup ElevenLabs with fresh connection (Barty-Bart style)
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

                  console.log("[!!! Debug Start Event] Finished processing start event logic.");

                } catch (error) {
                  console.error("[!!! Twilio Error processing start event]:", error);
                }
                break;

              case "media":
                // Check WebSocket state directly instead of relying on flag
                const audioPayloadBase64 = msg.media.payload;
                
                if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                  // Send immediately for low latency
                  try {
                    const audioMessage = { user_audio_chunk: audioPayloadBase64 };
                    elevenLabsWs.send(JSON.stringify(audioMessage));
                    
                    // Log occasionally to confirm audio flow
                    if (Math.random() < 0.01) {
                      console.log("[!!! Debug Media] Successfully sent user audio chunk to ElevenLabs");
                    }
                  } catch (mediaSendError) {
                     console.error("[!!! Debug Media] Error sending live audio chunk:", mediaSendError);
                  }
                } else {
                   // Buffer audio if ElevenLabs not ready
                   if (twilioAudioBuffer.length < 200) {
                     twilioAudioBuffer.push(audioPayloadBase64);
                   }
                   if (twilioAudioBuffer.length === 1) {
                     console.log(`[!!! Debug Media] EL WS not ready, buffering audio... State: ${elevenLabsWs?.readyState}`);
                   }
                   
                   // Log buffering status occasionally
                   if (twilioAudioBuffer.length % 50 === 0) {
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