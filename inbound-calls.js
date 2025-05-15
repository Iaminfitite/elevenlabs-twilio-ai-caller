import WebSocket from "ws";

export function registerInboundRoutes(fastify) {
  console.log("[Server] Attempting to register inbound routes...");

  // Check for the required environment variables
  const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    console.error("Missing required environment variables");
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
  }

  // Helper function to get signed URL for authenticated conversations
  async function getSignedUrl() {
    console.log("[getSignedUrl] Attempting to fetch signed URL.");
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
        {
          method: 'GET',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY
          }
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `Failed to get signed URL: ${response.status} ${response.statusText}. Response: ${errorBody}`;
        if (response.status === 401) {
          errorMessage += "\nPlease check your ELEVENLABS_API_KEY.";
        } else if (response.status === 400 || response.status === 404 || response.status === 422) {
          errorMessage += `\nPlease ensure ELEVENLABS_AGENT_ID (${ELEVENLABS_AGENT_ID}) is a valid Agent ID, not a Voice ID or other type of ID.`;
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();
      console.log("[getSignedUrl] Successfully fetched and parsed signed URL:", data.signed_url);
      return data.signed_url;
    } catch (error) {
      console.error("[getSignedUrl] CRITICAL ERROR fetching or parsing signed URL:", error.message, error.stack);
      throw error;
    }
  }

  // Route to handle incoming calls from Twilio
  fastify.all("/incoming-call-eleven", async (request, reply) => {
    console.log(`[Server] Received request on /incoming-call-eleven from: ${request.ip}`);
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  // WebSocket route for handling media streams from Twilio
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/media-stream", { websocket: true }, async (connection, req) => {
      console.info("[Server /media-stream] Entered WebSocket handler. Twilio attempting to connect.");

      let streamSid = null;
      let elevenLabsWs = null;
      let elevenLabsAudioBuffer = []; // Buffer for early audio from ElevenLabs
      let firstTwilioMessageProcessed = false; // <<< ADD THIS FLAG

      try {
        // Get authenticated WebSocket URL
        console.log("[Server /media-stream] Attempting to call getSignedUrl()..."); 
        const signedUrl = await getSignedUrl(); // This line should now be robustly logged by getSignedUrl itself
        
        // Check if signedUrl was actually obtained
        if (!signedUrl) {
          console.error("[Server /media-stream] CRITICAL: getSignedUrl() did not return a URL. Aborting ElevenLabs connection.");
          throw new Error("Failed to obtain signed URL for ElevenLabs.");
        }
        
        console.log(`[Server /media-stream] getSignedUrl() returned: ${signedUrl}. Proceeding to new WebSocket().`); 

        // Connect to ElevenLabs using the signed URL
        console.log("[Server /media-stream] PRE: Calling new WebSocket(signedUrl)");
        elevenLabsWs = new WebSocket(signedUrl);
        console.log("[Server /media-stream] POST: new WebSocket(signedUrl) called. Assigning event handlers NOW."); 

        // Handle open event for ElevenLabs WebSocket
        elevenLabsWs.on("open", () => {
          console.log("[II Inbound] ElevenLabs WebSocket OPEN event triggered!");
          console.log("[II] Connected to Conversational AI.");
          elevenLabsAudioBuffer = []; // Clear buffer on new connection
          // Send initial configuration data to ElevenLabs
          const today = new Date();
          const year = today.getFullYear();
          const month = String(today.getMonth() + 1).padStart(2, '0');
          const day = String(today.getDate()).padStart(2, '0');
          const currentDateYYYYMMDD = `${year}-${month}-${day}`;

          const initialConfig = {
            type: "conversation_initiation_client_data",
            dynamic_variables: {
              // You can customize or add more dynamic variables here if needed
              "CURRENT_DATE_YYYYMMDD": currentDateYYYYMMDD
            }
          };
          try {
            elevenLabsWs.send(JSON.stringify(initialConfig));
            console.log("[II] Sent conversation_initiation_client_data to ElevenLabs:", JSON.stringify(initialConfig));
          } catch (sendError) {
            console.error("[II] FAILED to send conversation_initiation_client_data:", sendError);
          }
        });

        // Handle messages from ElevenLabs
        elevenLabsWs.on("message", (data) => {
          // Log the raw message first, as its type might vary
          console.log("[II Raw Message]:", data.toString()); 
          try {
            const message = JSON.parse(data.toString()); // Ensure data is string before parsing
            
            if (message.type === "audio" || message.type === "audio_event") { // Covers both cases
              const audioPayload = message.audio_event?.audio_base_64 || message.audio?.chunk;
              if (audioPayload) {
                const audioDataForTwilio = {
                  audio_payload: audioPayload, 
                  is_interruption: false 
                };
                if (streamSid) {
                  // If streamSid is known, send this audio and any buffered audio
                  sendAudioToTwilio(audioDataForTwilio.audio_payload, connection, streamSid);
                  elevenLabsAudioBuffer.forEach(bufferedMsg => {
                    if (bufferedMsg.is_interruption) {
                        sendClearToTwilio(connection, streamSid);
                    } else if (bufferedMsg.audio_payload) {
                        sendAudioToTwilio(bufferedMsg.audio_payload, connection, streamSid);
                    }
                  });
                  elevenLabsAudioBuffer = [];
                } else {
                  console.warn("[II] Received audio from ElevenLabs, but streamSid from Twilio is not yet available. Buffering audio chunk.");
                  elevenLabsAudioBuffer.push(audioDataForTwilio);
                }
              } else {
                // This case is for type "audio" or "audio_event" but no audio payload.
                console.log("[II] Received message of type 'audio' or 'audio_event' but without an audio payload:", message);
              }
            } else if (message.type === "conversation_initiation_metadata") {
                console.info("[II] Received conversation initiation metadata.");
            } else if (message.type === "ping" && message.ping_event?.event_id) {
                const pongResponse = { type: "pong", event_id: message.ping_event.event_id };
                elevenLabsWs.send(JSON.stringify(pongResponse));
                console.log("[II] Sent pong to ElevenLabs.");
            } else if (message.type === "interruption") {
                if (streamSid) {
                    sendClearToTwilio(connection, streamSid);
                    // console.log("[Server -> Twilio] Sent clear event to Twilio due to II interruption."); // Covered by sendClearToTwilio
                } else {
                    console.warn("[II] Received interruption from ElevenLabs, but streamSid from Twilio is not available. Buffering interruption marker.");
                    elevenLabsAudioBuffer.push({ is_interruption: true }); 
                }
            } else {
                console.log("[II] Received other/unhandled message type from ElevenLabs:", message);
            }
          } catch (error) {
            console.error("[II] Error parsing message from ElevenLabs:", error, "Raw data:", data.toString()); // Log raw data on error
          }
        });

        // Function to send audio to Twilio
        const sendAudioToTwilio = (audioBase64, twilioConnection, currentStreamSid) => {
          if (!currentStreamSid) {
            console.error("[Server -> Twilio] Attempted to send audio but streamSid is still null!");
            return;
          }
          const audioData = {
            event: "media",
            streamSid: currentStreamSid,
            media: { payload: audioBase64 },
          };
          twilioConnection.send(JSON.stringify(audioData));
          console.log("[Server -> Twilio] Sent audio payload to Twilio.");
        };
        
        // Function to send clear (interruption) to Twilio
        const sendClearToTwilio = (twilioConnection, currentStreamSid) => {
            if (!currentStreamSid) {
                console.error("[Server -> Twilio] Attempted to send clear but streamSid is still null!");
                return;
            }
            twilioConnection.send(JSON.stringify({ event: "clear", streamSid: currentStreamSid }));
            console.log("[Server -> Twilio] Sent clear event to Twilio.");
        };

        // Handle messages from Twilio
        connection.on("message", async (message) => {
          // NEW LOG: Log message type and if it's a buffer, before anything else
          console.log(`[Twilio Message Intercept] Received a message. Type: ${typeof message}, Is Buffer: ${Buffer.isBuffer(message)}`);
          
          let rawMessageStr;
          try {
            rawMessageStr = message.toString(); 
          } catch (toStringError) {
            console.error("[Twilio Message Intercept] CRITICAL: message.toString() failed!", toStringError);
            // It might be helpful to see what 'message' was if it's not too large or complex
            // console.error("[Twilio Message Intercept] Message object that failed (details might be limited):", message);
            return; // Can't proceed if toString fails
          }

          if (!firstTwilioMessageProcessed) {
            console.log("[Twilio First Message Raw]:", rawMessageStr); // Log the very first raw message string
            firstTwilioMessageProcessed = true;
          }
          // Keep the existing raw message log for all messages as well
          console.log("[Twilio Raw Message]:", rawMessageStr);

          let data;
          try {
            data = JSON.parse(rawMessageStr); 
          } catch (parseError) {
            console.warn("[Twilio] Received non-JSON message or parse error. Raw:", rawMessageStr, "Error:", parseError);
            return; 
          }

          // Log the event type BEFORE the conditional checks
          if (data && data.event) {
            console.log(`[Twilio Event Logger] Received event type: ${data.event}`);
          } else {
            console.log("[Twilio Event Logger] Received message without a data.event field.");
          }

          if (data.event === "start") {
              // Log first, then assign
              console.log(`[Twilio] Attempting to process START event. Payload: ${JSON.stringify(data.start)}`); 
              streamSid = data.start.streamSid;
              if (streamSid) {
                console.log(`[Twilio] SUCCESS: Stream started with ID: ${streamSid}. Call SID: ${data.start.callSid}. Account SID: ${data.start.accountSid}. Tracks: ${data.start.tracks}. Media Format: ${JSON.stringify(data.start.mediaFormat)}. Custom Parameters:`, data.start.customParameters);
              } else {
                console.error("[Twilio] ERROR: START event received, but data.start.streamSid is null or undefined. Full start data:", data.start);
              }
              
              console.log(`[Server] Processing ${elevenLabsAudioBuffer.length} buffered messages from ElevenLabs for stream: ${streamSid}.`);
              elevenLabsAudioBuffer.forEach(bufferedMsg => {
                if (bufferedMsg.is_interruption) {
                  sendClearToTwilio(connection, streamSid);
                } else if (bufferedMsg.audio_payload) {
                  sendAudioToTwilio(bufferedMsg.audio_payload, connection, streamSid);
                }
              });
              elevenLabsAudioBuffer = []; // Clear buffer
          } else if (data.event === "media") {
              // Add a log to confirm media event is recognized by the conditional
              // console.log("[Twilio Event Logger] Processing MEDIA event."); 
              if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(
                    data.media.payload,
                    "base64"
                  ).toString("base64"),
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
                // console.log("[Twilio -> II] Sent user_audio_chunk to ElevenLabs."); // This log is frequent, can be noisy
              }
          } else if (data.event === "stop") {
              // Add a log to confirm stop event is recognized by the conditional
              console.log("[Twilio Event Logger] Processing STOP event."); 
              console.log(`[Twilio] Received stop event. Local streamSid: ${streamSid}. Event streamSid: ${data.streamSid}. Call SID: ${data.stop.callSid}. Account SID: ${data.stop.accountSid}.`);
              if (elevenLabsWs) {
                elevenLabsWs.close();
              }
          } else {
              console.log(`[Twilio] Received unhandled event: ${data.event}`, data); // Log the full data for unhandled events
          }
        });

        // Handle close event from Twilio
        connection.on("close", (code, reason) => { // fastify-websocket might not provide code/reason here directly
          if (elevenLabsWs && elevenLabsWs.readyState !== WebSocket.CLOSED) {
            elevenLabsWs.close();
          }
          const reasonStr = reason ? reason.toString() : 'N/A'; // For consistency, though likely N/A
          console.log(`[Twilio] Client disconnected. Code: ${code}, Reason: ${reasonStr}`);
        });

        // Handle errors from Twilio WebSocket
        connection.on("error", (error) => {
          console.error("[Twilio] WebSocket error:", error);
          if (elevenLabsWs) {
            elevenLabsWs.close();
          }
        });

        // Handle errors from ElevenLabs WebSocket
        elevenLabsWs.on("error", (error) => {
          console.error("[II] ElevenLabs WebSocket error:", error);
          // Attempt to close Twilio connection if ElevenLabs errors out
          if (connection && connection.socket && connection.socket.readyState === WebSocket.OPEN) {
            connection.socket.close(1011, "ElevenLabs WebSocket error");
          }
        });

        // Handle close event for ElevenLabs WebSocket
        elevenLabsWs.on("close", (code, reason) => {
          const reasonStr = reason ? reason.toString() : 'N/A';
          console.log(`[II] ElevenLabs WebSocket disconnected. Code: ${code}, Reason: ${reasonStr}`);
          // Attempt to close Twilio connection if ElevenLabs closes
          if (connection && connection.socket && connection.socket.readyState === WebSocket.OPEN) {
            connection.socket.close(1000, "ElevenLabs WebSocket closed");
          }
        });

      } catch (error) {
        console.error("[Server /media-stream] CRITICAL ERROR in media-stream handler (before or during ElevenLabs WS setup):", error.message, error.stack);
        if (elevenLabsWs) {
          elevenLabsWs.close();
        }
        // Ensure Twilio connection is closed if we critical error before II WS setup
        if (connection && connection.socket && connection.socket.readyState !== WebSocket.CLOSED) {
            connection.socket.close(1011, "Server error during setup");
            console.log("[Server /media-stream] Closed Twilio WebSocket due to critical setup error.");
        }
      }
    });
  });
}