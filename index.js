import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

// Import the outbound call routes using namespace import
import * as outboundCallPlugin from './outbound-calls.js';

// Load environment variables from .env file
dotenv.config();

const { ELEVENLABS_AGENT_ID, ELEVENLABS_API_KEY } = process.env;

// Check for the required ElevenLabs Agent ID
if (!ELEVENLABS_AGENT_ID || !ELEVENLABS_API_KEY) {
  console.error(
    "Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY in environment variables"
  );
  process.exit(1);
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Register the outbound call routes using the imported namespace
// Try accessing the default export explicitly if it exists within the namespace
fastify.register(outboundCallPlugin.default);

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Route to handle incoming calls from Twilio
fastify.all("/twilio/inbound_call", async (request, reply) => {
  // Generate TwiML response to connect the call to a WebSocket stream
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

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

// WebSocket route for handling media streams
fastify.register(async fastifyInstance => {
  fastifyInstance.get("/media-stream", { websocket: true }, (ws, req) => {
    console.info("[Server] Twilio connected to media stream");

    // Variables to track the call
    let streamSid = null;
    let callSid = null;
    let elevenLabsWs = null;
    let customParameters = null; // Add this to store parameters

    // Handle WebSocket errors
    ws.on("error", console.error);

    // Set up ElevenLabs connection
    const setupElevenLabs = async () => {
      console.log(`[!!! EL Setup @ ${Date.now()}] Attempting setup in index.js`); // Simplified log
      try {
        const signedUrlStartTime = Date.now();
        console.log(`[!!! EL Setup @ ${signedUrlStartTime}] Getting signed URL...`);
        const signedUrl = await getSignedUrl(); 
        const signedUrlEndTime = Date.now();
        if (!signedUrl) {
            console.error(`[!!! EL Setup @ ${signedUrlEndTime}] FAILED to get signed URL. Elapsed: ${signedUrlEndTime - signedUrlStartTime}ms.`);
            return; // Stop if no signed URL
        }
        console.log(`[!!! EL Setup @ ${signedUrlEndTime}] Got signed URL in ${signedUrlEndTime - signedUrlStartTime}ms. Attempting WebSocket connection to: ${signedUrl.split('?')[0]}...`); 

        const wsConnectStartTime = Date.now();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on("open", () => {
          const wsConnectEndTime = Date.now();
          console.log(`[!!! EL Setup @ ${wsConnectEndTime}] ElevenLabs WebSocket OPENED in ${wsConnectEndTime - wsConnectStartTime}ms.`);
          
          const today = new Date();
          const year = today.getFullYear();
          const month = String(today.getMonth() + 1).padStart(2, '0');
          const day = String(today.getDate()).padStart(2, '0');
          const currentDateYYYYMMDD = `${year}-${month}-${day}`;

          const initialConfig = {
            type: "conversation_initiation_client_data",
            dynamic_variables: {
              "CURRENT_DATE_YYYYMMDD": currentDateYYYYMMDD 
            }
          };
          console.log(`[!!! EL Setup @ ${Date.now()}] Preparing to send initialConfig with date: ${currentDateYYYYMMDD}`);
          try {
            elevenLabsWs.send(JSON.stringify(initialConfig));
            console.log(`[!!! EL Setup @ ${Date.now()}] Successfully SENT initialConfig.`);
          } catch (sendError) {
            console.error(`[!!! EL Setup @ ${Date.now()}] FAILED to send initialConfig:`, sendError);
          }
        });

        elevenLabsWs.on("message", data => {
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
          console.error(`[!!! EL Setup @ ${Date.now()}] ElevenLabs WebSocket ERROR:`, error);
        });

        elevenLabsWs.on("close", (code, reason) => {
          const reasonStr = reason ? reason.toString() : 'N/A';
          console.log(`[!!! EL Setup @ ${Date.now()}] ElevenLabs WebSocket CLOSED. Code: ${code}, Reason: ${reasonStr}`);
          // isElevenLabsWsOpen = false; // Define this if used elsewhere in index.js context
        });

      } catch (error) {
        console.error(`[!!! EL Setup @ ${Date.now()}] CRITICAL error in setupElevenLabs function:`, error);
      }
    };

    // Set up ElevenLabs connection
    setupElevenLabs();

    // Handle messages from Twilio
    ws.on("message", message => {
      try {
        const msg = JSON.parse(message);
        if (msg.event !== "media") {
          console.log(`[Twilio] Received event: ${msg.event}`);
        }

        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            console.log(
              `[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`
            );
            break;

          case "media":
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              const audioMessage = {
                user_audio_chunk: Buffer.from(
                  msg.media.payload,
                  "base64"
                ).toString("base64"),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;

          case "stop":
            console.log(`[Twilio] Stream ${streamSid} ended`);
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
            break;

          default:
            console.log(`[Twilio] Unhandled event: ${msg.event}`);
        }
      } catch (error) {
        console.error("[Twilio] Error processing message:", error);
      }
    });

    // Handle WebSocket closure
    ws.on("close", () => {
      console.log("[Twilio] Client disconnected");
      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });
  });
});

// *** Add Global Handlers ***
// ... (Global handlers remain the same) ...

// Start the Fastify server
fastify.listen(PORT, (err, address) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`Server is listening on ${address}`);
});