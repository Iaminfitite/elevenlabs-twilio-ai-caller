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
    const callerName = name || "Valued Customer";
    try {
      const twimlUrl = new URL(`https://${request.headers.host}/outbound-call-twiml`);
      twimlUrl.searchParams.append("name", callerName);
      twimlUrl.searchParams.append("number", number);
      if (airtableRecordId) {
          twimlUrl.searchParams.append("airtableRecordId", airtableRecordId);
      }

      const statusCallbackUrl = `https://${request.headers.host}/call-status`;
      console.log(`[Twilio API] Using statusCallbackUrl: ${statusCallbackUrl}`);

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
        message: "Call initiated with Status Callback",
        callSid: call.sid,
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

  // TwiML route for outbound calls
  fastify.all("/outbound-call-twiml", async (request, reply) => {
    // --- Add TwiML Log 1: Log Query Params ---
    console.log("[!!! Debug TwiML] Received query params:", request.query);
    const name = request.query.name || "Customer";
    const number = request.query.number || "Unknown";
    const airtableRecordId = request.query.airtableRecordId || null;

    const customParametersForStream = { 
        name: name, 
        number: number, 
        airtableRecordId: airtableRecordId
    };

    // --- Add TwiML Log 2: Log Params Before Encoding ---
    console.log("[!!! Debug TwiML] Parameters object to encode:", customParametersForStream);
    const encodedParameters = Buffer.from(JSON.stringify(customParametersForStream)).toString('base64');
    // --- Add TwiML Log 3: Log Encoded Params ---
    console.log("[!!! Debug TwiML] Encoded parameters (Base64):", encodedParameters);

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response><Connect><Stream url="wss://${request.headers.host}/outbound-media-stream"><Parameter name="customParameters" value='${encodedParameters}' /></Stream></Connect></Response>`;
    
    // --- Add TwiML Log 4: Log Final TwiML ---
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
      console.log("[!!! WS Handler Entered] Connection attempt received."); 
      
      let streamSid = null, callSid = null, elevenLabsWs = null, callCustomParameters = null;
      let resolveElevenLabsWsOpen = null;
      const elevenLabsWsOpenPromise = new Promise(resolve => { resolveElevenLabsWsOpen = resolve; });
      let isElevenLabsWsOpen = false;
      let twilioAudioBuffer = []; // <-- Add buffer array
      let setupStartTime = null; // <--- Add timing variable

      ws.on("error", (error) => console.error("[!!! Twilio WS Error]:", error));

      const setupElevenLabs = async () => {
        // --- Add Log A: Before getting signed URL ---
        setupStartTime = Date.now(); // <--- Start timing
        console.log(`[!!! Debug EL Setup @ ${setupStartTime}] Attempting to get signed URL...`);
        try { // <--- Wrap the whole setup in a try-catch
          const signedUrlStartTime = Date.now();
          const signedUrl = await getSignedUrl();
          const signedUrlEndTime = Date.now();
          console.log(`[!!! Debug EL Setup] Got signed URL in ${signedUrlEndTime - signedUrlStartTime}ms. Attempting WebSocket connection...`);

          const wsConnectStartTime = Date.now();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            const wsConnectEndTime = Date.now();
            // --- Add Log C: ElevenLabs WS Open ---
            console.log(`[!!! Debug EL Setup] ElevenLabs WebSocket OPENED in ${wsConnectEndTime - wsConnectStartTime}ms (Total setup time: ${wsConnectEndTime - setupStartTime}ms).`);
            console.log("[ElevenLabs] Connected to Conversational AI"); // Keep original log too
            isElevenLabsWsOpen = true;
            if (resolveElevenLabsWsOpen) resolveElevenLabsWsOpen(); // Signal that WS is open

            // --- Send Buffered Audio --- 
            if (twilioAudioBuffer.length > 0) {
              console.log(`[!!! Debug EL Setup] EL WS Open: Found ${twilioAudioBuffer.length} buffered audio chunks. Attempting to send...`); // <--- Log before loop
              twilioAudioBuffer.forEach((audioChunk, index) => {
                try {
                  const audioMessage = { user_audio_chunk: audioChunk };
                  elevenLabsWs.send(JSON.stringify(audioMessage));
                  if (index === twilioAudioBuffer.length - 1) { // Log after last chunk sent
                      console.log("[!!! Debug EL Setup] Finished sending buffered audio.");
                  }
                } catch (bufferSendError) {
                  console.error(`[!!! Debug EL Setup] Error sending buffered audio chunk #${index}:`, bufferSendError);
                }
              });
              twilioAudioBuffer = []; // Clear buffer
            } else {
                console.log("[!!! Debug EL Setup] EL WS Open: No buffered audio chunks to send."); // <--- Log if buffer is empty
            }
            // ---------------------------

            // --- Add current date calculation ---
            const today = new Date();
            const year = today.getFullYear();
            const month = String(today.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
            const day = String(today.getDate()).padStart(2, '0');
            const currentDateYYYYMMDD = `${year}-${month}-${day}`;
            // ------------------------------------

            const explicitInitialConfig = {
                type: "conversation_initiation_client_data",
                conversation_config_override: {
                    // ... existing agent, tts, audio_output config ...
                    agent: {
                        prompt: { prompt: agentPrompt }
                    },
                    tts: {
                        voice_id: voiceId
                    },
                    audio_output: { 
                        encoding: "ulaw",
                        sample_rate: 8000
                    }
                },
                // --- Pass current date as a dynamic variable ---
                dynamic_variables: { 
                    "current_date_yyyymmdd": currentDateYYYYMMDD 
                }      
            };
            console.log(`[!!! Debug EL Setup] Sending explicit init message with current date: ${currentDateYYYYMMDD}`);
            elevenLabsWs.send(JSON.stringify(explicitInitialConfig));
            // console.log("[!!! Debug EL Setup] Explicit init message sent."); // Old log

          });

          elevenLabsWs.on("message", (data) => {
            // --- Add Log D: Message received from ElevenLabs ---
            console.log("[!!! Debug EL Setup] Message RECEIVED from ElevenLabs.");
            try {
              const message = JSON.parse(data);

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

                // --- START: Add Tool Call Handling ---
                case "client_tool_call":
                  // --- Log the raw incoming tool call request --- 
                  console.log(`[!!! Debug Tool Call] Received RAW client_tool_call from EL:`, JSON.stringify(message));
                  
                  const { tool_name, tool_call_id, parameters } = message.client_tool_call;
                  
                  // Asynchronously handle the tool execution
                  handleToolExecution(tool_name, parameters)
                    .then(result => {
                        const response = {
                            type: "client_tool_result",
                            tool_call_id: tool_call_id,
                            result: JSON.stringify(result), // Ensure result is stringified
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
                            result: JSON.stringify({ error: error.message || 'Tool execution failed' }), // Stringify error
                            is_error: true
                        };
                        console.error(`[Server] Error executing tool '${tool_name}':`, error);
                        console.log(`[ElevenLabs] Sending Tool Error Result:`, JSON.stringify(response));
                         if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                            elevenLabsWs.send(JSON.stringify(response));
                        }
                    });
                  break;
                // --- END: Add Tool Call Handling ---

                default:
                  console.log(
                    `[ElevenLabs] Unhandled message type: ${message.type}`
                  );
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
             // --- Add Log E: ElevenLabs WS Error ---
             console.error("[!!! Debug EL Setup] ElevenLabs WebSocket ERROR:", error);
          });
          elevenLabsWs.on("close", (code, reason) => {
            // --- Add Log F: ElevenLabs WS Closed ---
            console.log(`[!!! Debug EL Setup] ElevenLabs WebSocket CLOSED. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}`);
            isElevenLabsWsOpen = false;
          });
        } catch (error) { // <--- Catch errors during setup
          const setupEndTime = Date.now();
          // --- Add Log G: Error during setupElevenLabs ---
          console.error(`[!!! Debug EL Setup] Error in setupElevenLabs function after ${setupEndTime - setupStartTime}ms:`, error);
          // Optionally close the Twilio WS connection if EL setup fails critically
          // ws.close(1011, "ElevenLabs setup failed"); 
        }
      };

      setupElevenLabs(); // Call setup immediately when Twilio connects

      ws.on("message", async (message) => {
        try {
          const msg = JSON.parse(message);
          if (msg.event !== "media") console.log(`[Twilio] Event: ${msg.event}`);

          switch (msg.event) {
            case "start":
              // --- Add Log 1: Log the raw start message --- 
              console.log("[!!! Debug Start Event] Received raw start message:", JSON.stringify(msg));
              
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              console.log(`[Twilio] Stream started: ${streamSid}, CallSid: ${callSid}`);
              
              callCustomParameters = {}; 
              let isVoicemail = false;
              let amdResult = 'unknown';

              try {
                // --- Add Log 2: Before parameter extraction --- 
                console.log("[!!! Debug Start Event] Attempting parameter extraction...");
                const paramsObjectFromTwilio = msg.start.customParameters;
                let base64ParamString = '';
                if (typeof paramsObjectFromTwilio === 'object' && paramsObjectFromTwilio !== null && typeof paramsObjectFromTwilio.customParameters === 'string') {
                    base64ParamString = paramsObjectFromTwilio.customParameters;
                } else if (typeof paramsObjectFromTwilio === 'string') {
                    base64ParamString = paramsObjectFromTwilio;
                }
                
                if (base64ParamString) { 
                    try {
                        const decodedParametersString = Buffer.from(base64ParamString, 'base64').toString('utf-8');
                         if (decodedParametersString) { 
                           try {
                                // --- Add Log 3: Before JSON parsing --- 
                                console.log("[!!! Debug Start Event] Attempting JSON parse of decoded params...");
                                callCustomParameters = JSON.parse(decodedParametersString);
                                console.log("[Twilio] Successfully parsed custom parameters:", callCustomParameters);
                           } catch (parseError) {
                               console.error("[Twilio] JSON Parse Error:", parseError, "| String:", JSON.stringify(decodedParametersString));
                           }
                         }
                    } catch (bufferError) {
                        console.error("[Twilio] Buffer.from or toString Error:", bufferError);
                    }
                } else {
                  console.warn("[Twilio] base64ParamString is empty, skipping decode/parse.");
                }
                 // --- Add Log 4: Before AMD check --- 
                 console.log("[!!! Debug Start Event] Checking AMD result...");
                // Check AMD Result 
                if (callSid && amdResults[callSid]) {
                    const answeredBy = amdResults[callSid];
                    amdResult = answeredBy;
                    console.log(`[AMD Check] Result for ${callSid}: ${answeredBy}`);
                    if (answeredBy === "machine_start" || answeredBy === "machine_end_beep" || answeredBy === "fax") {
                         isVoicemail = true;
                         console.log(`[AMD Check] Voicemail/Machine detected for ${callSid}`);
                    }
                    delete amdResults[callSid]; // Clean up checked result
                } else {
                    console.log(`[AMD Check] No AMD result found for ${callSid} after wait.`);
                }

                // --- Add Log 5: Before waiting for ElevenLabs WS --- 
                console.log("[!!! Debug Start Event] Checking ElevenLabs WS state...");
                // Wait for ElevenLabs WS to be open
                if (!isElevenLabsWsOpen) {
                    console.log("[ElevenLabs] Waiting for WebSocket connection to open...");
                    await Promise.race([
                        elevenLabsWsOpenPromise,
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for ElevenLabs WS open")), 5000))
                    ]);
                }
                
                // --- Add Log 6: Before defining sendInitialConfig --- 
                // console.log("[!!! Debug Start Event] Defining sendInitialConfig...");
                // // Define and call sendInitialConfig (amdResult is now in scope)
                // --- WE ARE NO LONGER CALLING sendInitialConfig from here ---

                // // --- Add Log 9: After calling sendInitialConfig --- 
                console.log("[!!! Debug Start Event] Finished processing start event logic (sendInitialConfig SKIPPED)."); // Modified Log 9

              } catch (error) {
                console.error("[!!! Twilio Error processing start event]:", error);
              }
              break;

            case "media":
              // --- Add Log H: Media event received, before check --- 
              console.log("[!!! Debug Media] Media received from Twilio. Checking EL WS state...");
              const audioPayloadBase64 = msg.media.payload; // Directly use the payload
              
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                // --- Add Log I: Attempting to send audio to EL --- 
                console.log("[!!! Debug Media] EL WS is OPEN. Attempting to forward audio...");
                try {
                  // Use the direct payload here
                  const audioMessage = { user_audio_chunk: audioPayloadBase64 };
                  elevenLabsWs.send(JSON.stringify(audioMessage));
                } catch (mediaSendError) {
                   console.error("[!!! Debug Media] Error sending live audio chunk:", mediaSendError);
                }
              } else {
                 // --- Buffer the audio if WS not open yet ---
                 console.log("[!!! Debug Media] EL WS is NOT OPEN. Buffering audio chunk.");
                 // Use the direct payload here too
                 twilioAudioBuffer.push(audioPayloadBase64);
              }
              break;

            case "stop":
              console.log(`[Twilio] Received stop event for Stream ${streamSid}`);
              try { // Outer try for the whole stop handler logic
                if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                  console.log("[ElevenLabs] Closing WS connection due to Twilio stop event.");
                  elevenLabsWs.close(); // Close EL WS first
                }
                
                // Now handle the Twilio call ending
                if (callSid) {
                  // Inner try specifically for the Twilio API call
                  try {
                      console.log(`[Twilio] Attempting to update call ${callSid} status to completed...`);
                      await twilioClient.calls(callSid).update({ status: "completed" });
                      console.log(`[Twilio] Successfully sent command to update call ${callSid}`);
                  } catch (callUpdateError) {
                      // Log the specific error from the call update attempt
                      console.error(`[!!! Twilio Call Update Error] Failed for CallSid ${callSid}:`, callUpdateError);
                  }
                } else {
                   console.warn("[Twilio] Cannot update call on stop event: callSid is missing.");
                }
              } catch (error) {
                 // Catch errors from ElevenLabs close or general logic within the outer try
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

      // Handle WebSocket closure
      ws.on("close", (code, reason) => {
        console.log(`[!!! Twilio WS Closed]: Code=${code}, Reason=${reason ? reason.toString() : 'N/A'}`);
        // Attempt to close ElevenLabs WS if Twilio closes unexpectedly
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
           console.log("[ElevenLabs] Closing WS connection because Twilio WS closed.");
           elevenLabsWs.close();
        }
        isElevenLabsWsOpen = false;
      });
    }
  );

  // Route to receive Call Status updates from Twilio
  fastify.post("/call-status", async (request, reply) => {
    const { 
        CallSid, 
        CallStatus, 
        AnsweredBy, // Values can include: machine_start, human, fax, unknown etc.
        Duration, 
        Timestamp 
    } = request.body;
    
    // Log the received status
    console.log(`[Call Status] CallSid: ${CallSid}, Status: ${CallStatus}, AnsweredBy: ${AnsweredBy}, Duration: ${Duration}`);

    // --- Voicemail/Machine Detection Hangup Logic --- 
    // Check if AnsweredBy indicates a machine
    const machineResponses = ["machine_start", "fax"]; // Add others like machine_end_beep if needed
    if (AnsweredBy && machineResponses.includes(AnsweredBy)) {
      console.log(`[AMD] Machine detected (${AnsweredBy}) for CallSid: ${CallSid}. Ending call.`);
      try {
        // Use the Twilio client to end the call
        await twilioClient.calls(CallSid).update({ status: "completed" });
        console.log(`[AMD] Successfully sent command to end call ${CallSid}`);
      } catch (error) {
        console.error(`[AMD] Error trying to end call ${CallSid} after machine detection:`, error);
      }
      // No need to store in amdResults if we hang up immediately
    } else if (AnsweredBy && AnsweredBy === "human") {
       console.log(`[AMD] Human detected for CallSid: ${CallSid}. Call continues.`);
       // Optionally store this confirmation if needed elsewhere, but amdResults isn't used now
       // amdResults[CallSid] = AnsweredBy; 
    } else if (AnsweredBy) {
       console.log(`[AMD] Received AnsweredBy status '${AnsweredBy}' for CallSid: ${CallSid}. Call continues.`);
    }
    // -----------------------------------------------

    reply.status(200).send(); // Respond OK to Twilio
  });

  // Add basic error handler for the whole Fastify instance
  fastify.setErrorHandler(function (error, request, reply) {
    console.error("[!!! Fastify Global Error Handler]:", error);
    reply.status(500).send({ ok: false, error: 'Internal Server Error' });
  });
}

// --- START: Update Tool Execution Function ---
async function handleToolExecution(toolName, parameters) {
    const executionStartTime = Date.now();
    console.log(`[Server @ ${executionStartTime}] Attempting tool: ${toolName} with params:`, JSON.stringify(parameters));

    const calComApiKey = process.env.CAL_COM_API_KEY;
    if (!calComApiKey) {
        console.error("[Server] Error: CAL_COM_API_KEY environment variable is not set.");
        throw new Error("Missing required CAL_COM_API_KEY.");
    }

    let url;
    let options = {
        signal: AbortSignal.timeout(10000), // 10 second timeout
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

            // --- START: Parameter Transformation for Cal.com /v2/slots ---
            const calComParams = {};

            // Directly use parameters provided by LLM after validation
            // LLM is expected to calculate the date based on its prompt

            // *** YOU MUST VERIFY/ADJUST THESE PARAMETER NAMES based on LLM output ***
            if (parameters.eventTypeId) {
                calComParams.eventTypeId = parameters.eventTypeId;
            } else {
                 console.error("[Server] Missing required 'eventTypeId' from LLM. Parameters:", JSON.stringify(parameters));
                 throw new Error("Missing required 'eventTypeId' parameter from LLM for get_available_slots.");
            }

            // Validate and use the start date from LLM
            if (parameters.start && /^\d{4}-\d{2}-\d{2}$/.test(parameters.start)) {
                calComParams.start = parameters.start;
                console.log(`[Server] Using start date from LLM: ${calComParams.start}`);

                // Determine end date (e.g., same day or 7 days after based on prompt logic)
                // Assuming LLM sends both start and end, or we default end to start + duration
                if (parameters.end && /^\d{4}-\d{2}-\d{2}$/.test(parameters.end)) {
                    calComParams.end = parameters.end;
                     console.log(`[Server] Using end date from LLM: ${calComParams.end}`);
                } else {
                    // Default end date logic if LLM doesn't provide it (e.g., same day)
                    calComParams.end = calComParams.start; 
                    console.log(`[Server] Defaulting end date to start date: ${calComParams.end}`);
                    // Or calculate end = start + 7 days if that's the required logic
                    // const endDate = new Date(calComParams.start + 'T00:00:00Z');
                    // endDate.setUTCDate(endDate.getUTCDate() + 7);
                    // calComParams.end = endDate.toISOString().split('T')[0];
                    // console.log(`[Server] Calculating end date (+7 days): ${calComParams.end}`);
                }

            } else {
                 console.error("[Server] Missing or invalid 'start' date (YYYY-MM-DD) from LLM. Parameters:", JSON.stringify(parameters));
                 throw new Error("Missing or invalid 'start' date parameter (YYYY-MM-DD) from LLM.");
            }
            
            // Use timezone from LLM if provided and valid, otherwise default
            if (parameters.timeZone && /^[a-zA-Z_]+\/[a-zA-Z_]+$/.test(parameters.timeZone)) {
                calComParams.timeZone = parameters.timeZone;
                 console.log(`[Server] Using timeZone from LLM: ${calComParams.timeZone}`);
            } else {
                calComParams.timeZone = 'Australia/Brisbane'; // Default timezone
                console.log(`[Server] Defaulting timeZone to: ${calComParams.timeZone}`);
            }

            // Add other necessary parameters if needed
            // if (parameters.hostUserId) calComParams.hostUserId = parameters.hostUserId;

            const queryParams = new URLSearchParams(calComParams).toString();
            // --- END: Parameter Transformation ---

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
             // Ensure the specific error message is returned to EL
             throw new Error(`API call to ${toolName} timed out after 10 seconds.`);
        }
        // Re-throw the original or enhanced error (ensure message gets to EL)
        // Throwing error ensures is_error: true is set in the response to EL
        throw error;
    }
}
// --- END: Update Tool Execution Function ---