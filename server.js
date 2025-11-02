const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI, Modality, Type } = require("@google/genai");
const fetch = require("node-fetch");
require("dotenv").config();

// --- Audio Utility Functions ---
const ulawDecodeTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let sample = i ^ 0xff;
  const sign = sample & 0x80;
  const exponent = (sample >> 4) & 0x07;
  const mantissa = sample & 0x0f;
  let pcm = (mantissa << (exponent + 3)) + (132 << exponent) - 132;
  if (sign !== 0) pcm = -pcm;
  ulawDecodeTable[i] = pcm;
}

function decodeMulaw(mulawBuffer) {
  const pcm = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm[i] = ulawDecodeTable[mulawBuffer[i]];
  }
  return pcm;
}

function resample(pcmData, fromRate, toRate) {
  if (fromRate === toRate) return pcmData;
  if (toRate > fromRate) {
    const newLength = Math.round((pcmData.length * toRate) / fromRate);
    if (newLength === 0) return new Int16Array(0);
    const result = new Int16Array(newLength);
    const springFactor = (pcmData.length - 1) / (newLength > 1 ? newLength - 1 : 1);
    result[0] = pcmData[0] || 0;
    for (let i = 1; i < newLength; i++) {
      const index = i * springFactor;
      const a = Math.floor(index);
      const b = Math.min(a + 1, pcmData.length - 1);
      const fraction = index - a;
      result[i] = Math.round((pcmData[a] || 0) * (1 - fraction) + (pcmData[b] || 0) * fraction);
    }
    return result;
  }
  const ratio = fromRate / toRate;
  const newLength = Math.floor(pcmData.length / ratio);
  if (newLength === 0) return new Int16Array(0);
  const result = new Int16Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const startIndex = Math.floor(i * ratio);
    const endIndex = Math.floor((i + 1) * ratio);
    let sum = 0;
    const count = endIndex - startIndex;
    for (let j = startIndex; j < endIndex; j++) sum += pcmData[j] || 0;
    result[i] = Math.round(sum / count);
  }
  return result;
}

function encodeMulaw(pcmData) {
  const BIAS = 0x84;
  const MAX_SAMPLE = 32635;
  const ulawData = new Uint8Array(pcmData.length);
  for (let i = 0; i < pcmData.length; i++) {
    let sample = pcmData[i];
    const sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    if (sample > MAX_SAMPLE) sample = MAX_SAMPLE;
    sample += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    let ulaw = sign | (exponent << 4) | mantissa;
    ulawData[i] = ~ulaw & 0xff;
  }
  return Buffer.from(ulawData);
}

const AMPLIFICATION_FACTOR = 2.0;
function processTwilioToGemini(twilioChunk) {
  const pcm8k = decodeMulaw(twilioChunk);
  const pcm16k = resample(pcm8k, 8000, 16000);
  for (let i = 0; i < pcm16k.length; i++) {
    pcm16k[i] = Math.max(-32768, Math.min(32767, pcm16k[i] * AMPLIFICATION_FACTOR));
  }
  return Buffer.from(pcm16k.buffer);
}

function processGeminiToTwilio(geminiChunk) {
  const pcm24k = new Int16Array(geminiChunk.buffer, geminiChunk.byteOffset, geminiChunk.byteLength / 2);
  const pcm8k = resample(pcm24k, 24000, 8000);
  return encodeMulaw(pcm8k);
}

// --- Initialize Supabase Client ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  console.error("SUPABASE_URL:", supabaseUrl ? "✓ Set" : "✗ Missing");
  console.error("SUPABASE_SERVICE_ROLE_KEY:", supabaseKey ? "✓ Set" : "✗ Missing");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
console.log("✅ Supabase client initialized with service role key");

// --- Express and WebSocket Server Setup ---
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;
let activeConnections = 0;

// Pre-initialize AI client
let aiClient = null;
(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY not set in environment variables!");
    process.exit(1);
  }
  aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  console.log("✅ AI client pre-initialized");
})();

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    activeConnections,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// Incoming call endpoint
app.post("/incoming-call", (req, res) => {
  console.log("📞 Incoming call from:", req.body.From);
  const VoiceResponse = require("twilio").twiml.VoiceResponse;
  const response = new VoiceResponse();
  const connect = response.connect();
  connect.stream({ url: `wss://${req.headers.host}/audio-stream` });
  res.type("text/xml");
  res.send(response.toString());
});

// Start recording helper
async function startRecording(callSid, accountSid, authToken) {
  try {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const recordingResponse = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}/Recordings.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          RecordingStatusCallback: `${supabaseUrl}/functions/v1/twilio-call-status`,
          RecordingStatusCallbackEvent: "completed",
        }),
      },
    );

    if (recordingResponse.ok) {
      const recordingData = await recordingResponse.json();
      console.log("✅ Recording started:", recordingData.sid);
      return recordingData.sid;
    } else {
      console.error("❌ Recording start failed:", await recordingResponse.text());
    }
  } catch (error) {
    console.error("❌ Recording error:", error.message);
  }
}

// WebSocket connection handler
wss.on("connection", (ws, req) => {
  activeConnections++;
  const connStartTime = Date.now();
  console.log(`📊 WebSocket connected (${activeConnections} active)`);

  let streamSid = null;
  let callSid = null;
  let agentId = null;
  let callLogId = null;
  let workspaceId = null;
  let geminiSession = null;
  let audioBuffer = [];
  let sessionReady = false;
  let firstAudioReceived = null;
  let firstResponseSent = null;
  let agentConfig = null;
  let transcriptTurns = [];
  let keepAliveInterval = null;
  let geminiKeepAliveInterval = null;

  // Initialize Gemini session
  const initializeGeminiSession = async () => {
    try {
      if (!aiClient) throw new Error("AI client not initialized");
      if (!agentConfig) throw new Error("Agent config not loaded");

      const systemPrompt = agentConfig.systemPrompt || "You are a helpful AI assistant.";
      const voiceName = agentConfig.voice?.voiceId || "Kore";
      console.log(`🎤 Initializing Gemini with voice: ${voiceName}`);

      const tools =
        agentConfig.tools?.map((t) => ({
          name: t.tool_name,
          description: t.description || "",
          parameters: {
            type: Type.OBJECT,
            properties: {},
            required: [],
          },
        })) || [];

      const startTime = Date.now();
      geminiSession = await aiClient.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
          systemInstruction: systemPrompt,
          tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log(`✅ Gemini session ready (${Date.now() - startTime}ms)`);
            sessionReady = true;

            // Flush buffered audio
            if (audioBuffer.length > 0 && geminiSession) {
              console.log(`📦 Flushing ${audioBuffer.length} buffered chunks`);
              const combinedPayload = audioBuffer.join("");
              audioBuffer = [];
              const twilioAudioChunk = Buffer.from(combinedPayload, "base64");
              const geminiAudioChunk = processTwilioToGemini(twilioAudioChunk);
              geminiSession.sendRealtimeInput({
                media: { data: geminiAudioChunk.toString("base64"), mimeType: "audio/pcm;rate=16000" },
              });
            }

            // Handle initial message if configured
            const initialMessage = agentConfig.settings?.initialMessage;
            if (initialMessage?.enabled && geminiSession) {
              console.log("🎤 Initial message enabled, type:", initialMessage.type);

              setTimeout(() => {
                if (!geminiSession || !sessionReady) return;

                if (initialMessage.type === "custom" && initialMessage.customMessage) {
                  console.log("📤 Sending custom initial message:", initialMessage.customMessage);
                  geminiSession.sendRealtimeInput({
                    text: initialMessage.customMessage,
                  });
                  // Send silent audio to trigger response
                  const silentChunk = Buffer.alloc(480);
                  geminiSession.sendRealtimeInput({
                    media: { data: silentChunk.toString("base64"), mimeType: "audio/pcm;rate=16000" },
                  });
                } else if (initialMessage.type === "dynamic") {
                  console.log("📤 Triggering dynamic initial message");
                  geminiSession.sendRealtimeInput({
                    text: "Please greet the user and introduce yourself based on your role.",
                  });
                  // Send silent audio to trigger response
                  const silentChunk = Buffer.alloc(480);
                  geminiSession.sendRealtimeInput({
                    media: { data: silentChunk.toString("base64"), mimeType: "audio/pcm;rate=16000" },
                  });
                }
              }, 500);
            }

            // Start Gemini keep-alive
            geminiKeepAliveInterval = setInterval(() => {
              if (geminiSession && sessionReady) {
                const silentChunk = Buffer.alloc(480);
                geminiSession.sendRealtimeInput({
                  media: { data: silentChunk.toString("base64"), mimeType: "audio/pcm;rate=16000" },
                });
              }
            }, 30000);
          },
          onclose: () => {
            console.log("🔒 Gemini session closed");
            console.log("📊 Session stats:", {
              streamSid,
              callSid,
              transcriptTurns: transcriptTurns.length,
              sessionReadyWas: sessionReady,
              callLogId,
            });
          },
          onerror: (e) => {
            console.error("❌ Gemini error:", e);
            console.error("❌ Error details:", {
              message: e?.message,
              type: e?.type,
              code: e?.code,
            });
          },
          onmessage: async (message) => {
            // Tool calls
            if (message.toolCall && geminiSession) {
              message.toolCall.functionCalls.forEach((fc) => handleToolCall(fc, geminiSession));
            }

            // Capture user input transcription
            if (message.serverContent?.inputTranscription?.text) {
              const userText = message.serverContent.inputTranscription.text;
              const lastTurn = transcriptTurns[transcriptTurns.length - 1];

              if (lastTurn && lastTurn.role === "user" && !lastTurn.isFinal) {
                lastTurn.text += userText;
              } else {
                transcriptTurns.push({
                  role: "user",
                  text: userText,
                  timestamp: new Date().toISOString(),
                  isFinal: false,
                });
              }
              console.log("📝 User said:", userText);

              // Save transcript immediately after each user input
              await saveTranscript();
            }

            // Capture agent output transcription
            if (message.serverContent?.outputTranscription?.text) {
              const agentText = message.serverContent.outputTranscription.text;
              const lastTurn = transcriptTurns[transcriptTurns.length - 1];

              if (lastTurn && lastTurn.role === "agent" && !lastTurn.isFinal) {
                lastTurn.text += agentText;
              } else {
                transcriptTurns.push({
                  role: "agent",
                  text: agentText,
                  timestamp: new Date().toISOString(),
                  isFinal: false,
                });
              }
              console.log("🤖 Agent said:", agentText);

              // Save transcript immediately after each agent response
              await saveTranscript();
            }

            // Mark turn as complete
            if (message.serverContent?.turnComplete) {
              const lastTurn = transcriptTurns[transcriptTurns.length - 1];
              if (lastTurn) {
                lastTurn.isFinal = true;
                console.log("✓ Turn complete, transcript saved");
              }
            }

            // Interruption handling
            if (message.serverContent?.interrupted && streamSid) {
              ws.send(JSON.stringify({ event: "clear", streamSid }));
            }

            // Stream audio
            if (message.serverContent?.modelTurn && streamSid) {
              const audioPart = message.serverContent.modelTurn.parts?.find((p) =>
                p.inlineData?.mimeType.startsWith("audio/"),
              );
              if (audioPart?.inlineData.data) {
                if (!firstResponseSent && firstAudioReceived) {
                  firstResponseSent = Date.now();
                  console.log(`⚡ Response latency: ${firstResponseSent - firstAudioReceived}ms`);
                }
                const geminiAudioChunk = Buffer.from(audioPart.inlineData.data, "base64");
                const twilioAudioChunk = processGeminiToTwilio(geminiAudioChunk);
                ws.send(
                  JSON.stringify({
                    event: "media",
                    streamSid,
                    media: { payload: twilioAudioChunk.toString("base64") },
                  }),
                );
              }
            }
          },
        },
      });
    } catch (err) {
      console.error("❌ Gemini session init failed:", err);
      ws.close();
    }
  };

  // Tool call handler
  const handleToolCall = async (fc, session) => {
    console.log(`🔧 Tool called: ${fc.name}`);

    if (!agentConfig?.tools || agentConfig.tools.length === 0) {
      session?.sendToolResponse({
        functionResponses: [
          {
            id: fc.id,
            name: fc.name,
            response: { result: JSON.stringify({ error: "No tools configured" }) },
          },
        ],
      });
      return;
    }

    const tool = agentConfig.tools.find((t) => t.tool_name === fc.name);
    if (!tool) {
      session?.sendToolResponse({
        functionResponses: [
          {
            id: fc.id,
            name: fc.name,
            response: { result: JSON.stringify({ error: "Tool not found" }) },
          },
        ],
      });
      return;
    }

    try {
      const headers = { "Content-Type": "application/json", ...tool.headers };
      const body = tool.payload_body
        ? JSON.parse(tool.payload_body.replace(/\\{\\{(\w+)\\}\\}/g, (_, key) => fc.args[key] || ""))
        : fc.args;

      const toolResponse = await fetch(tool.endpoint_url, {
        method: tool.http_method,
        headers,
        body: tool.http_method !== "GET" ? JSON.stringify(body) : undefined,
      });

      const result = await toolResponse.json();
      session?.sendToolResponse({
        functionResponses: [
          {
            id: fc.id,
            name: fc.name,
            response: { result: JSON.stringify(result) },
          },
        ],
      });
    } catch (error) {
      console.error("❌ Tool execution error:", error.message);
      session?.sendToolResponse({
        functionResponses: [
          {
            id: fc.id,
            name: fc.name,
            response: { result: JSON.stringify({ error: error.message }) },
          },
        ],
      });
    }
  };

  // Save transcript to database
  const saveTranscript = async () => {
    if (!callLogId || transcriptTurns.length === 0) {
      console.log("⚠️ Cannot save transcript:", { hasCallLogId: !!callLogId, turnCount: transcriptTurns.length });
      return;
    }

    try {
      const formattedTranscript = transcriptTurns
        .filter((turn) => turn.text.trim().length > 0)
        .map((turn) => {
          const time = new Date(turn.timestamp).toLocaleTimeString();
          const speaker = turn.role === "user" ? "User" : "Agent";
          return `[${time}] ${speaker}: ${turn.text.trim()}`;
        })
        .join("\n\n");

      console.log("💾 Saving transcript:", {
        callLogId,
        length: formattedTranscript.length,
        turns: transcriptTurns.length,
      });

      const { error } = await supabase
        .from("call_logs")
        .update({ transcript: formattedTranscript })
        .eq("id", callLogId);

      if (error) {
        console.error("❌ Transcript save error:", error);
      } else {
        console.log("✅ Transcript saved successfully");
      }
    } catch (error) {
      console.error("❌ Transcript save exception:", error.message);
    }
  };

  ws.on("message", async (message) => {
    const msg = JSON.parse(message.toString());

    // Log all incoming messages for debugging
    console.log("📨 Received event:", msg.event, msg.event === "start" ? msg.start : "");

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;

      // Extract parameters from Twilio start event customParameters
      const customParameters = msg.start.customParameters || {};
      agentId = customParameters.agent_id || null;
      callLogId = customParameters.call_log_id || null;

      console.log(`📞 Stream started:`, {
        streamSid,
        callSid,
        agentId,
        callLogId,
        customParams: customParameters,
        timestamp: new Date().toISOString(),
      });

      if (!agentId) {
        console.error("❌ Agent ID missing in start event customParameters");
        ws.close(1008, "Agent ID required");
        return;
      }

      // Load agent configuration
      try {
        console.log("🔍 Querying agent with ID:", agentId);
        console.log("🔍 Supabase URL:", supabaseUrl);

        const { data: agent, error } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();

        console.log("📊 Query result:", { agent: !!agent, error: error?.message });

        if (error) {
          console.error("❌ Agent query error:", error);
          ws.close(1008, "Agent query failed: " + error.message);
          return;
        }

        if (!agent) {
          console.error("❌ Agent not found for ID:", agentId);
          // Try to list all agents to debug
          const { data: allAgents, error: listError } = await supabase.from("agents").select("id, agent_name").limit(5);
          console.log(
            "📋 Available agents:",
            allAgents?.map((a) => ({ id: a.id, name: a.agent_name })),
          );
          ws.close(1008, "Agent not found");
          return;
        }

        agentConfig = agent.config;
        workspaceId = agent.workspace_id;
        console.log("✓ Agent config loaded:", {
          agentName: agent.agent_name,
          voice: agentConfig?.voice?.voiceId,
          hasTools: agentConfig?.tools?.length > 0,
          workspaceId,
        });
      } catch (error) {
        console.error("❌ Agent load exception:", error.message, error.stack);
        ws.close(1008, "Failed to load agent");
        return;
      }

      // Update call log to in-progress
      if (callLogId) {
        console.log("📝 Updating call log:", callLogId);
        await supabase
          .from("call_logs")
          .update({
            status: "in-progress",
            started_at: new Date().toISOString(),
            call_sid: callSid,
          })
          .eq("id", callLogId);
      } else {
        console.warn("⚠️ No callLogId provided, transcript will not be saved");
      }

      // Start recording the call
      if (callSid && agentConfig && workspaceId) {
        try {
          console.log("🎙️ Attempting to start recording for call:", callSid);
          console.log("🔍 Looking for phone number in workspace:", workspaceId);

          const { data: phoneData, error: phoneError } = await supabase
            .from("phone_numbers")
            .select("twilio_sid, auth_token_encrypted")
            .eq("workspace_id", workspaceId)
            .maybeSingle();

          console.log("📞 Phone query result:", {
            found: !!phoneData,
            error: phoneError?.message,
            hasTwilioSid: !!phoneData?.twilio_sid,
            hasAuthToken: !!phoneData?.auth_token_encrypted,
          });

          if (phoneError) {
            console.error("❌ Phone number query error:", phoneError);
          } else if (!phoneData) {
            console.error("❌ No phone number found for workspace:", workspaceId);
            // List all phone numbers to debug
            const { data: allPhones } = await supabase
              .from("phone_numbers")
              .select("id, phone_number, workspace_id")
              .limit(5);
            console.log("📋 Available phone numbers:", allPhones);
          } else if (!phoneData.twilio_sid || !phoneData.auth_token_encrypted) {
            console.error("❌ Phone number missing credentials:", {
              hasSid: !!phoneData.twilio_sid,
              hasToken: !!phoneData.auth_token_encrypted,
            });
          } else {
            const accountSid = phoneData.twilio_sid;
            const authToken = phoneData.auth_token_encrypted;
            await startRecording(callSid, accountSid, authToken);
          }
        } catch (error) {
          console.error("❌ Exception starting recording:", error.message);
        }
      } else {
        console.warn("⚠️ Missing required data for recording:", {
          hasCallSid: !!callSid,
          hasAgentConfig: !!agentConfig,
          hasWorkspaceId: !!workspaceId,
        });
      }

      // Initialize Gemini session AFTER agent config is loaded
      await initializeGeminiSession();

      // Start keep-alive for Twilio
      keepAliveInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ event: "mark", streamSid }));
        }
      }, 30000);
    } else if (msg.event === "media") {
      if (!firstAudioReceived) {
        firstAudioReceived = Date.now();
        console.log(`🎤 First audio received`);
      }

      if (sessionReady && geminiSession) {
        const twilioAudioChunk = Buffer.from(msg.media.payload, "base64");
        const geminiAudioChunk = processTwilioToGemini(twilioAudioChunk);
        geminiSession.sendRealtimeInput({
          media: { data: geminiAudioChunk.toString("base64"), mimeType: "audio/pcm;rate=16000" },
        });
      } else {
        audioBuffer.push(msg.media.payload);
        if (audioBuffer.length > 50) audioBuffer.shift();
      }
    } else if (msg.event === "stop") {
      console.log("📞 Call ended");

      // Clean up keep-alive intervals
      if (keepAliveInterval) clearInterval(keepAliveInterval);
      if (geminiKeepAliveInterval) clearInterval(geminiKeepAliveInterval);

      // Close Gemini session
      if (geminiSession) {
        geminiSession.close();
        geminiSession = null;
      }

      // Format and save final transcript
      if (callLogId) {
        const formattedTranscript = transcriptTurns
          .filter((turn) => turn.text.trim().length > 0)
          .map((turn) => {
            const time = new Date(turn.timestamp).toLocaleTimeString();
            const speaker = turn.role === "user" ? "User" : "Agent";
            return `[${time}] ${speaker}: ${turn.text.trim()}`;
          })
          .join("\n\n");

        await supabase
          .from("call_logs")
          .update({
            status: "completed",
            ended_at: new Date().toISOString(),
            transcript: formattedTranscript || null,
          })
          .eq("id", callLogId);
      }

      ws.close();
    }
  });

  ws.on("close", () => {
    activeConnections--;
    console.log(`📊 Connection closed (${activeConnections} active)`);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (geminiKeepAliveInterval) clearInterval(geminiKeepAliveInterval);
    geminiSession?.close();
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err.message);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (geminiKeepAliveInterval) clearInterval(geminiKeepAliveInterval);
    geminiSession?.close();
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/audio-stream`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, shutting down gracefully...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});
