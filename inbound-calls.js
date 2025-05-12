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

      try {
        // Get authenticated WebSocket URL
        const signedUrl = await getSignedUrl();

        // Connect to ElevenLabs using the signed URL
        elevenLabsWs = new WebSocket(signedUrl);

        // Handle open event for ElevenLabs WebSocket
        elevenLabsWs.on("open", () => {
          console.log("[II] Connected to Conversational AI.");
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
          try {
            const message = JSON.parse(data);
            handleElevenLabsMessage(message, connection);
          } catch (error) {
            console.error("[II] Error parsing message:", error);
          }
        });

        // Handle errors from ElevenLabs WebSocket
        elevenLabsWs.on("error", (error) => {
          console.error("[II] WebSocket error:", error);
        });

        // Handle close event for ElevenLabs WebSocket
        elevenLabsWs.on("close", (code, reason) => {
          const reasonStr = reason ? reason.toString() : 'N/A';
          console.log(`[II] Disconnected from ElevenLabs. Code: ${code}, Reason: ${reasonStr}`);
        });

        // Function to handle messages from ElevenLabs
        const handleElevenLabsMessage = (message, connection) => {
          switch (message.type) {
            case "conversation_initiation_metadata":
              console.info("[II] Received conversation initiation metadata.");
              break;
            case "audio":
              console.log("[II -> Server] Received audio from ElevenLabs.");
              if (!streamSid) {
                console.warn("[II] Received audio from ElevenLabs, but streamSid from Twilio is not yet available. Discarding audio chunk.");
                return; // Do not send if streamSid is not set
              }
              if (message.audio_event?.audio_base_64) {
                const audioData = {
                  event: "media",
                  streamSid, // Now we are sure streamSid is available
                  media: {
                    payload: message.audio_event.audio_base_64,
                  },
                };
                connection.send(JSON.stringify(audioData));
                console.log("[Server -> Twilio] Sent audio payload to Twilio.");
              }
              break;
            case "interruption":
              if (!streamSid) {
                console.warn("[II] Received interruption from ElevenLabs, but streamSid from Twilio is not yet available. Discarding interruption.");
                return; // Do not send if streamSid is not set
              }
              connection.send(JSON.stringify({ event: "clear", streamSid }));
              break;
            case "ping":
              if (message.ping_event?.event_id) {
                const pongResponse = {
                  type: "pong",
                  event_id: message.ping_event.event_id,
                };
                elevenLabsWs.send(JSON.stringify(pongResponse));
              }
              break;
          }
        };

        // Handle messages from Twilio
        connection.on("message", async (message) => {
          // Log the raw message buffer/string first
          console.log("[Twilio Raw Message]:", message.toString()); 

          try {
            const data = JSON.parse(message);
            // Add this log to see if Twilio sends the 'start' event.
            if (data.event === "start") {
                streamSid = data.start.streamSid;
                console.log(`[Twilio] Stream started with ID: ${streamSid}. Call SID: ${data.start.callSid}`);
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