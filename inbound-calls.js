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
      return data.signed_url;
    } catch (error) {
      console.error("Error getting signed URL:", error.message);
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
      console.info("[Server] Twilio connected to media stream.");

      let streamSid = null;
      let elevenLabsWs = null;
      let elevenLabsAudioBuffer = []; // Buffer for early audio from ElevenLabs

      try {
        // Get authenticated WebSocket URL
        const signedUrl = await getSignedUrl();

        // Connect to ElevenLabs using the signed URL
        elevenLabsWs = new WebSocket(signedUrl);

        // Handle open event for ElevenLabs WebSocket
        elevenLabsWs.on("open", () => {
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
          console.log("[II Raw Message]:", data.toString());
          try {
            const message = JSON.parse(data);
            // No direct call to handleElevenLabsMessage here, logic moved into specific handlers
            
            if (message.type === "audio" || message.type === "audio_event") { // Assuming audio_event also contains audio to send
              const audioPayload = message.audio_event?.audio_base_64 || message.audio?.chunk; // Adapt based on actual structure
              if (audioPayload) {
                const audioDataForTwilio = {
                  audio_payload: audioPayload, // Store the actual payload
                  is_interruption: false // Mark if it's an interruption clear event
                };
                if (streamSid) {
                  // If streamSid is known, send this audio and any buffered audio
                  sendAudioToTwilio(audioDataForTwilio.audio_payload, connection, streamSid);
                  elevenLabsAudioBuffer.forEach(bufferedAudio => {
                    sendAudioToTwilio(bufferedAudio.audio_payload, connection, streamSid);
                  });
                  elevenLabsAudioBuffer = [];
                } else {
                  console.warn("[II] Received audio from ElevenLabs, but streamSid from Twilio is not yet available. Buffering audio chunk.");
                  elevenLabsAudioBuffer.push(audioDataForTwilio);
                }
              } else {
                console.log("[II] Received non-audio message or audio message without payload:", message);
                // Handle other message types like pings, metadata directly if necessary
                 if (message.type === "conversation_initiation_metadata") {
                    console.info("[II] Received conversation initiation metadata.");
                } else if (message.type === "ping" && message.ping_event?.event_id) {
                    const pongResponse = { type: "pong", event_id: message.ping_event.event_id };
                    elevenLabsWs.send(JSON.stringify(pongResponse));
                    console.log("[II] Sent pong to ElevenLabs.");
                } else if (message.type === "interruption") {
                    // Handle interruption similarly to audio if it needs to be synced with streamSid
                    if (streamSid) {
                        connection.send(JSON.stringify({ event: "clear", streamSid }));
                        console.log("[Server -> Twilio] Sent clear event to Twilio due to II interruption.");
                    } else {
                        console.warn("[II] Received interruption from ElevenLabs, but streamSid from Twilio is not available. Buffering interruption.");
                        elevenLabsAudioBuffer.push({ is_interruption: true }); // Buffer a marker for interruption
                    }
                }

              }
            } else {
                 // Directly handle non-audio messages that don't depend on streamSid for Twilio
                if (message.type === "conversation_initiation_metadata") {
                    console.info("[II] Received conversation initiation metadata.");
                } else if (message.type === "ping" && message.ping_event?.event_id) {
                    const pongResponse = { type: "pong", event_id: message.ping_event.event_id };
                    elevenLabsWs.send(JSON.stringify(pongResponse));
                    console.log("[II] Sent pong to ElevenLabs.");
                } else {
                    console.log("[II] Received other message type from ElevenLabs:", message);
                }
            }
          } catch (error) {
            console.error("[II] Error parsing message from ElevenLabs:", error);
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
          console.log("[Twilio Raw Message]:", message.toString()); 
          try {
            const data = JSON.parse(message);
            if (data.event === "start") {
                streamSid = data.start.streamSid;
                console.log(`[Twilio] Stream started with ID: ${streamSid}. Call SID: ${data.start.callSid}. Custom Parameters:`, data.start.customParameters);
                // Process buffered audio/events from ElevenLabs now that we have streamSid
                console.log(`[Server] Processing ${elevenLabsAudioBuffer.length} buffered messages from ElevenLabs.`);
                elevenLabsAudioBuffer.forEach(bufferedMsg => {
                  if (bufferedMsg.is_interruption) {
                    sendClearToTwilio(connection, streamSid);
                  } else if (bufferedMsg.audio_payload) {
                    sendAudioToTwilio(bufferedMsg.audio_payload, connection, streamSid);
                  }
                });
                elevenLabsAudioBuffer = []; // Clear buffer
            } else if (data.event === "media") {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                  const audioMessage = {
                    user_audio_chunk: Buffer.from(
                      data.media.payload,
                      "base64"
                    ).toString("base64"),
                  };
                  elevenLabsWs.send(JSON.stringify(audioMessage));
                  console.log("[Twilio -> II] Sent user_audio_chunk to ElevenLabs.");
                }
            } else if (data.event === "stop") {
                 console.log(`[Twilio] Received stop event for stream: ${streamSid}`);
                if (elevenLabsWs) {
                  elevenLabsWs.close();
                }
            } else {
                console.log(`[Twilio] Received unhandled event: ${data.event}`);
            }
          } catch (error) {
            console.error("[Twilio] Error processing message:", error);
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

      } catch (error) {
        console.error("[Server] Error initializing conversation:", error);
        if (elevenLabsWs) {
          elevenLabsWs.close();
        }
        connection.socket.close();
      }
    });
  });
}