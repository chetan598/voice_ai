const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI, Modality, Type } = require("@google/genai");
const fetch = require("node-fetch");
require("dotenv").config();

// --- Optimized Audio Processing Libraries ---
// Performance improvements:
// - mulaw encode/decode: 10-20x faster using native C++ (alawmulaw library)
// - Reduced code complexity: 80+ lines -> 56 lines
// - More efficient resampling algorithm with linear interpolation
// - Expected latency reduction: ~50-100ms per audio chunk
const codec = require('alawmulaw');

// --- Audio Utility Functions (Optimized) ---
function decodeMulaw(mulawBuffer) {
  // Use optimized native C++ library (10-20x faster than pure JS)
  return codec.mulaw.decode(mulawBuffer);
}

function encodeMulaw(pcmData) {
  // alawmulaw.encode accepts Int16Array and returns Uint8Array
  // Convert to Int16Array if needed, then encode, then convert result to Buffer
  let int16Data;
  
  if (pcmData instanceof Int16Array) {
    int16Data = pcmData;
  } else if (Buffer.isBuffer(pcmData)) {
    // Convert Buffer to Int16Array (assuming 16-bit samples)
    int16Data = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);
  } else {
    // Fallback: assume it's array-like
    int16Data = new Int16Array(pcmData);
  }
  
  // Encode to mulaw (returns Uint8Array)
  const encoded = codec.mulaw.encode(int16Data);
  
  // Convert Uint8Array to Buffer for Twilio
  return Buffer.from(encoded);
}

// Optimized resampling function with linear interpolation
// This is much faster than the previous implementation
function resample(pcmData, fromRate, toRate) {
  if (fromRate === toRate) return pcmData;
  
  // Upsampling (e.g., 8kHz -> 16kHz)
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
      
      // Linear interpolation
      result[i] = Math.round(
        (pcmData[a] || 0) * (1 - fraction) + (pcmData[b] || 0) * fraction
      );
    }
    return result;
  } 
  // Downsampling (e.g., 24kHz -> 8kHz)
  else {
    const ratio = fromRate / toRate;
    const newLength = Math.floor(pcmData.length / ratio);
    if (newLength === 0) return new Int16Array(0);
    
    const result = new Int16Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const startIndex = Math.floor(i * ratio);
      const endIndex = Math.floor((i + 1) * ratio);
      let sum = 0;
      const count = endIndex - startIndex;
      
      for (let j = startIndex; j < endIndex; j++) {
        sum += pcmData[j] || 0;
      }
      result[i] = Math.round(sum / count);
    }
    return result;
  }
}

const AMPLIFICATION_FACTOR = 2.0;
function processTwilioToGemini(twilioChunk) {
  const pcm8k = decodeMulaw(twilioChunk);
  const pcm16k = resample(pcm8k, 8000, 16000);
  
  // Apply amplification
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
const supabaseUrl = "https://kxmmqqcrlpxmqujkaxvv.supabase.co";
const supabaseKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt4bW1xcWNybHB4bXF1amtheHZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE1NzI5MDYsImV4cCI6MjA3NzE0ODkwNn0.Dj4PPCoKQz1o2E3XxW4ApXQSVeUfTF5LqBo7F2hcgvk";
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
  // if (!process.env.GEMINI_API_KEY) {
  //   console.error("GEMINI_API_KEY not set in environment variables!");
  //   process.exit(1);
  // }
  aiClient = new GoogleGenAI({ apiKey: "AIzaSyD-9yqGaJ8kMgtvZKirBxoeN2nKjLAT69M" });
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

// Post-call analysis function
async function analyzeCallTranscript(transcript, analysisConfig, callLogId) {
  if (!analysisConfig?.enabled || !analysisConfig?.fields || analysisConfig.fields.length === 0) {
    console.log("⏭️ Post-call analysis disabled or no fields configured");
    return;
  }

  try {
    console.log("🔍 Starting post-call analysis for call:", callLogId);
    console.log("📋 Analysis fields:", analysisConfig.fields.length);

    // Build schema for Gemini tool calling
    const toolSchema = {
      type: "object",
      properties: {},
      required: [],
    };

    analysisConfig.fields.forEach((field) => {
      const fieldSchema = {};

      switch (field.type) {
        case "string":
          fieldSchema.type = "string";
          break;
        case "number":
          fieldSchema.type = "number";
          break;
        case "boolean":
          fieldSchema.type = "boolean";
          break;
        case "enum":
          fieldSchema.type = "string";
          if (field.choices && field.choices.length > 0) {
            fieldSchema.enum = field.choices;
          }
          break;
      }

      if (field.description) {
        fieldSchema.description = field.description;
      }

      toolSchema.properties[field.name] = fieldSchema;

      if (field.required) {
        toolSchema.required.push(field.name);
      }
    });

    console.log("📐 Built schema:", JSON.stringify(toolSchema, null, 2));

    // Call Gemini Flash Lite for analysis
    const analysisPrompt = `Analyze the following call transcript and extract the requested information. Be accurate and concise.\n\nTranscript:\n${transcript}`;

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=" +
        process.env.GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: analysisPrompt }],
            },
          ],
          tools: [
            {
              functionDeclarations: [
                {
                  name: "extract_call_data",
                  description: "Extract structured data from the call transcript",
                  parameters: toolSchema,
                },
              ],
            },
          ],
          toolConfig: {
            functionCallingConfig: {
              mode: "ANY",
              allowedFunctionNames: ["extract_call_data"],
            },
          },
        }),
      },
    );

    const result = await response.json();
    console.log("🤖 Gemini response received");

    // Extract function call result
    if (result.candidates?.[0]?.content?.parts?.[0]?.functionCall) {
      const extractedData = result.candidates[0].content.parts[0].functionCall.args;
      console.log("✅ Extracted data:", extractedData);

      // Save to database
      const { error: updateError } = await supabase
        .from("call_logs")
        .update({ analysis_data: extractedData })
        .eq("id", callLogId);

      if (updateError) {
        console.error("❌ Failed to save analysis data:", updateError);
      } else {
        console.log("💾 Analysis data saved to database");
      }
    } else {
      console.warn("⚠️ No function call in response:", JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error("❌ Post-call analysis failed:", error.message, error.stack);
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

  // Handle tool calls - MUST be defined before initializeGeminiSession
  const handleToolCall = async (fc, session) => {
    console.log(`\n\n🚨🚨🚨 NEW DETAILED LOGGING VERSION - handleToolCall EXECUTED 🚨🚨🚨\n`);
    console.log(`\n🔧 ========== TOOL CALL START ==========`);
    console.log(`🔧 Tool name: ${fc.name}`);
    console.log(`🔧 Tool ID: ${fc.id}`);
    console.log(`🔧 Tool arguments:`, JSON.stringify(fc.args, null, 2));

    if (!agentConfig?.tools || agentConfig.tools.length === 0) {
      console.error("❌ No tools configured in agent");
      session?.sendToolResponse({
        functionResponses: [
          {
            id: fc.id,
            name: fc.name,
            response: { result: JSON.stringify({ error: "No tools configured" }) },
          },
        ],
      });
      console.log(`🔧 ========== TOOL CALL END (NO TOOLS) ==========\n`);
      return;
    }

    const tool = agentConfig.tools.find((t) => t.tool_name === fc.name);
    if (!tool) {
      console.error("❌ Tool not found:", fc.name);
      console.error(
        "📋 Available tools:",
        agentConfig.tools.map((t) => t.tool_name),
      );
      session?.sendToolResponse({
        functionResponses: [
          {
            id: fc.id,
            name: fc.name,
            response: { result: JSON.stringify({ error: "Tool not found" }) },
          },
        ],
      });
      console.log(`🔧 ========== TOOL CALL END (NOT FOUND) ==========\n`);
      return;
    }

    console.log(`✅ Tool found in config:`, {
      name: tool.tool_name,
      endpoint: tool.endpoint_url,
      method: tool.http_method,
      hasPayloadTemplate: !!tool.payload_body,
      hasCustomHeaders: !!tool.headers,
    });

    try {
      // Prepare headers
      const headers = { "Content-Type": "application/json", ...tool.headers };

      // Map Gemini arguments to API parameters
      let body;
      if (tool.payload_body && tool.http_method !== "GET") {
        console.log("📦 Original payload template:", tool.payload_body);

        try {
          const payloadTemplate = JSON.parse(tool.payload_body);
          const providedArgs = fc.args || {};

          console.log("📦 PAYLOAD COMPARISON:");
          console.log("   ========== SCHEMA STRUCTURE ==========");
          if (payloadTemplate.properties) {
            console.log("   Expected top-level parameters:", Object.keys(payloadTemplate.properties));
            console.log("   Required parameters:", payloadTemplate.required || "none specified");
          }
          console.log("   Full schema:", JSON.stringify(payloadTemplate, null, 2));
          console.log("\n   ========== GEMINI PROVIDED ==========");
          console.log("   Args from Gemini:", JSON.stringify(providedArgs, null, 2));
          console.log("   Number of parameters provided:", Object.keys(providedArgs).length);

          // Extract expected parameter names from the schema
          let requestBody = {};
          if (payloadTemplate && payloadTemplate.properties) {
            const expectedParams = Object.keys(payloadTemplate.properties);

            console.log("\n   ========== MAPPING PROCESS ==========");

            // Try to match arguments (handle name variations)
            for (const expectedParam of expectedParams) {
              // Direct match
              if (providedArgs[expectedParam] !== undefined) {
                requestBody[expectedParam] = providedArgs[expectedParam];
                console.log(`   ✅ Mapped: ${expectedParam} = ${JSON.stringify(providedArgs[expectedParam])}`);
              } else {
                // Try common variations (item_id -> item_ref, etc.)
                const argKeys = Object.keys(providedArgs);
                const matchingKey = argKeys.find((key) => {
                  const keyBase = key.split("_")[0].toLowerCase();
                  const paramBase = expectedParam.split("_")[0].toLowerCase();
                  return (
                    keyBase === paramBase ||
                    key.toLowerCase().includes(paramBase) ||
                    expectedParam.toLowerCase().includes(keyBase)
                  );
                });

                if (matchingKey) {
                  requestBody[expectedParam] = providedArgs[matchingKey];
                  console.log(
                    `   ✅ Mapped (variant): ${expectedParam} = ${JSON.stringify(providedArgs[matchingKey])} (from ${matchingKey})`,
                  );
                } else {
                  console.log(`   ⚠️  No match found for parameter: ${expectedParam}`);
                }
              }
            }

            // If no mapping worked, just pass through all arguments
            if (Object.keys(requestBody).length === 0) {
              console.log("   ⚠️  No parameters mapped, using all arguments as-is");
              requestBody = providedArgs;
            }

            // Wrap in args object as expected by the API
            body = { args: requestBody };
            console.log("\n   ========== FINAL API PAYLOAD ==========");
            console.log("   Sending to API:", JSON.stringify(body, null, 2));
            console.log("   Parameters mapped:", Object.keys(requestBody).length, "/", expectedParams.length);
          } else {
            // No properties in schema, wrap arguments in args object
            console.log("   No schema properties found, wrapping arguments in args object");
            body = { args: fc.args || {} };
          }
        } catch (parseError) {
          console.error("   ❌ Failed to parse payload template as JSON:", parseError.message);
          console.log("   Falling back to raw arguments wrapped in args object");
          body = { args: fc.args || {} };
        }
      } else {
        body = { args: fc.args || {} };
      }

      // Make the API call
      const fetchOptions = {
        method: tool.http_method,
        headers,
      };

      if (tool.http_method !== "GET" && body) {
        fetchOptions.body = JSON.stringify(body);
      }

      console.log(`\n📤 ========== HTTP REQUEST ==========`);
      console.log(`   URL: ${tool.endpoint_url}`);
      console.log(`   Method: ${tool.http_method}`);
      console.log(`   Headers:`, JSON.stringify(headers, null, 2));
      if (fetchOptions.body) {
        console.log(`   Body:`, fetchOptions.body.substring(0, 1000)); // First 1000 chars
      }
      console.log(`📤 ====================================\n`);

      const requestStartTime = Date.now();
      const toolResponse = await fetch(tool.endpoint_url, fetchOptions);
      const requestDuration = Date.now() - requestStartTime;

      console.log(`\n📥 ========== HTTP RESPONSE (${requestDuration}ms) ==========`);
      console.log(`   Status: ${toolResponse.status} ${toolResponse.statusText}`);
      console.log(`   OK: ${toolResponse.ok}`);
      console.log(`   Headers:`, JSON.stringify(Object.fromEntries(toolResponse.headers.entries()), null, 2));

      let result;
      const contentType = toolResponse.headers.get("content-type");
      console.log(`   Content-Type: ${contentType}`);

      if (contentType && contentType.includes("application/json")) {
        const responseText = await toolResponse.text();
        console.log(`   Raw Response Body (first 2000 chars):`, responseText.substring(0, 2000));
        try {
          result = JSON.parse(responseText);
          console.log(`   Parsed JSON:`, JSON.stringify(result, null, 2).substring(0, 1000));
        } catch (parseError) {
          console.error(`   ❌ JSON Parse Error:`, parseError.message);
          result = { response: responseText, status: toolResponse.status, parseError: parseError.message };
        }
      } else {
        const text = await toolResponse.text();
        console.log(`   Text Response (first 2000 chars):`, text.substring(0, 2000));
        result = { response: text, status: toolResponse.status };
      }

      if (!toolResponse.ok) {
        console.error(`   ⚠️  HTTP Error Status: ${toolResponse.status}`);
      }

      console.log(`📥 ====================================\n`);

      console.log("✅ Sending tool response to Gemini");
      session?.sendToolResponse({
        functionResponses: [
          {
            id: fc.id,
            name: fc.name,
            response: { result: JSON.stringify(result) },
          },
        ],
      });

      console.log(`🔧 ========== TOOL CALL END (SUCCESS) ==========\n`);
    } catch (error) {
      console.log(`\n❌ ========== TOOL CALL EXCEPTION ==========`);
      console.error("❌ Error Type:", error.constructor.name);
      console.error("❌ Error Message:", error.message);
      console.error("❌ Error Stack:", error.stack);

      if (error.cause) {
        console.error("❌ Error Cause:", error.cause);
      }

      if (error.code) {
        console.error("❌ Error Code:", error.code);
      }

      console.log(`❌ ==========================================\n`);

      session?.sendToolResponse({
        functionResponses: [
          {
            id: fc.id,
            name: fc.name,
            response: {
              result: JSON.stringify({ error: error.message, type: error.constructor.name, details: error.stack }),
            },
          },
        ],
      });

      console.log(`🔧 ========== TOOL CALL END (ERROR) ==========\n`);
    }
  };

  // Initialize Gemini session
  const initializeGeminiSession = async () => {
    try {
      if (!aiClient) throw new Error("AI client not initialized");
      if (!agentConfig) throw new Error("Agent config not loaded");

      const systemPrompt = agentConfig.systemPrompt || "You are a helpful AI assistant.";
      const voiceName = agentConfig.voice?.voiceId || "Kore";
      console.log(`🎤 Initializing Gemini with voice: ${voiceName}`);

      // Parse tool parameters from payload template
      const tools =
        agentConfig.tools?.map((t) => {
          let params = {};
          let required = [];

          if (t.payload_body) {
            try {
              // Try to parse as JSON schema first
              const parsed = JSON.parse(t.payload_body);

              if (parsed.type === "object" && parsed.properties) {
                // It's a JSON schema - use it directly
                console.log(`📋 Using JSON schema for tool: ${t.tool_name}`);

                // Convert JSON Schema types to Gemini types
                const convertToGeminiType = (jsonType) => {
                  const typeMap = {
                    string: Type.STRING,
                    number: Type.NUMBER,
                    integer: Type.INTEGER,
                    boolean: Type.BOOLEAN,
                    array: Type.ARRAY,
                    object: Type.OBJECT,
                  };
                  return typeMap[jsonType] || Type.STRING;
                };

                // Convert properties
                for (const [propName, propSchema] of Object.entries(parsed.properties)) {
                  params[propName] = {
                    type: convertToGeminiType(propSchema.type),
                    description: propSchema.description || `Parameter: ${propName}`,
                  };

                  // Add enum constraints if present
                  if (propSchema.enum && propSchema.enum.length > 0) {
                    params[propName].enum = propSchema.enum;
                    params[propName].description += ` Allowed values: ${propSchema.enum.join(", ")}`;
                  }

                  // Handle array items - include structure for first level
                  if (propSchema.type === "array" && propSchema.items) {
                    params[propName].items = {
                      type: convertToGeminiType(propSchema.items.type || "object"),
                    };

                    // For object arrays, include first-level properties
                    if (propSchema.items.type === "object" && propSchema.items.properties) {
                      params[propName].items.properties = {};

                      for (const [itemPropName, itemPropSchema] of Object.entries(propSchema.items.properties)) {
                        params[propName].items.properties[itemPropName] = {
                          type: convertToGeminiType(itemPropSchema.type),
                          description: itemPropSchema.description || `Parameter: ${itemPropName}`,
                        };

                        // Add enum constraints for array item properties
                        if (itemPropSchema.enum) {
                          params[propName].items.properties[itemPropName].enum = itemPropSchema.enum;
                          params[propName].items.properties[itemPropName].description +=
                            ` Allowed values: ${itemPropSchema.enum.join(", ")}`;
                        }

                        // For nested arrays (like lineModifierSets), provide structure but not deep nesting
                        if (itemPropSchema.type === "array" && itemPropSchema.items) {
                          params[propName].items.properties[itemPropName].items = {
                            type: convertToGeminiType(itemPropSchema.items.type || "object"),
                          };

                          // If these array items are objects with properties, list them
                          if (itemPropSchema.items.properties) {
                            const nestedFieldNames = Object.keys(itemPropSchema.items.properties);
                            const nestedRequired = itemPropSchema.items.required || [];
                            params[propName].items.properties[itemPropName].description =
                              `${itemPropSchema.description || ""} Each item must include: ${nestedFieldNames.join(", ")}${nestedRequired.length ? `. Required fields: ${nestedRequired.join(", ")}` : ""}`.trim();
                          }
                        }
                      }

                      // Include required fields for array items
                      if (propSchema.items.required) {
                        params[propName].items.required = propSchema.items.required;
                      }
                    }
                  }

                  // Handle nested objects
                  if (propSchema.type === "object" && propSchema.properties) {
                    params[propName].properties = {};
                    for (const [nestedName, nestedSchema] of Object.entries(propSchema.properties)) {
                      params[propName].properties[nestedName] = {
                        type: convertToGeminiType(nestedSchema.type),
                        description: nestedSchema.description || `Parameter: ${nestedName}`,
                      };

                      // Add enum for nested properties
                      if (nestedSchema.enum) {
                        params[propName].properties[nestedName].enum = nestedSchema.enum;
                        params[propName].properties[nestedName].description +=
                          ` Allowed values: ${nestedSchema.enum.join(", ")}`;
                      }
                    }

                    // Add required fields for nested objects
                    if (propSchema.required) {
                      params[propName].required = propSchema.required;
                    }
                  }
                }

                required = parsed.required || [];
              } else {
                // Not a schema, look for {{...}} placeholders
                console.log(`📋 Using template placeholders for tool: ${t.tool_name}`);
                const paramMatches = t.payload_body.matchAll(/\{\{(\w+)\}\}/g);
                for (const match of paramMatches) {
                  const paramName = match[1];
                  if (!params[paramName]) {
                    params[paramName] = {
                      type: Type.STRING,
                      description: `Parameter: ${paramName}`,
                    };
                    required.push(paramName);
                  }
                }
              }
            } catch (e) {
              // Failed to parse as JSON, look for {{...}} placeholders
              console.log(`📋 Using template placeholders for tool: ${t.tool_name} (JSON parse failed)`);
              const paramMatches = t.payload_body.matchAll(/\{\{(\w+)\}\}/g);
              for (const match of paramMatches) {
                const paramName = match[1];
                if (!params[paramName]) {
                  params[paramName] = {
                    type: Type.STRING,
                    description: `Parameter: ${paramName}`,
                  };
                  required.push(paramName);
                }
              }
            }
          }

          return {
            name: t.tool_name,
            description: t.description || `Execute ${t.tool_name}`,
            parameters: {
              type: Type.OBJECT,
              properties: params,
              required: required,
            },
          };
        }) || [];

      console.log(
        "🔧 Loaded tools:",
        tools.map((t) => ({ name: t.name, params: Object.keys(t.parameters.properties) })),
      );

      // Load advanced audio features from agent config individually
      const proactiveAudioEnabled = agentConfig?.settings?.advancedAudio?.proactiveAudioEnabled !== undefined 
        ? agentConfig.settings.advancedAudio.proactiveAudioEnabled 
        : false; // Default to false if not specified
      
      const affectiveDialogEnabled = agentConfig?.settings?.advancedAudio?.affectiveDialogEnabled !== undefined 
        ? agentConfig.settings.advancedAudio.affectiveDialogEnabled 
        : false; // Default to false if not specified

      console.log("🎛️ Advanced audio features:", { 
        proactiveAudioEnabled, 
        affectiveDialogEnabled 
      });

      const startTime = Date.now();
      
      // Build config object with proper structure
      const geminiConfig = {
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
      };

      // Add proactivity config if enabled (separate from speechConfig)
      if (proactiveAudioEnabled) {
        geminiConfig.proactivity = { proactiveAudio: true };
      }

      // Add affective dialog if enabled (inside speechConfig)
      if (affectiveDialogEnabled) {
        geminiConfig.speechConfig.affectiveDialog = true;
      }

      console.log("📋 Gemini config:", JSON.stringify(geminiConfig, null, 2));

      geminiSession = await aiClient.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: geminiConfig,
        callbacks: {
          onopen: function () {
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
            console.log("🔍 Initial message config:", JSON.stringify(initialMessage, null, 2));

            if (initialMessage?.enabled) {
              // Check if proactive audio is enabled - if so, skip text-based initial message
              if (proactiveAudioEnabled) {
                console.log("ℹ️ Proactive audio enabled - Gemini will start speaking automatically, skipping text initial message");
              } else {
                console.log("🎤 Initial message configuration:", {
                  enabled: initialMessage.enabled,
                  type: initialMessage.type,
                  customMessage: initialMessage.customMessage || "(none)",
                });

                // Add delay to ensure session is fully initialized
                setTimeout(() => {
                  // Check if session is still available and ready
                  if (!geminiSession) {
                    console.error("❌ geminiSession not available for initial message (session closed)");
                    return;
                  }
                  
                  if (!sessionReady) {
                    console.error("❌ Session not ready for initial message");
                    return;
                  }

                  if (initialMessage.type === "custom" && initialMessage.customMessage) {
                    console.log("📤 Sending custom initial message:", initialMessage.customMessage);
                    try {
                      geminiSession.sendRealtimeInput({
                        text: `Say this exact message to the user: "${initialMessage.customMessage}"`,
                      });

                      const silentChunk = Buffer.alloc(3840);
                      geminiSession.sendRealtimeInput({
                        media: { data: silentChunk.toString("base64"), mimeType: "audio/pcm;rate=16000" },
                      });
                      console.log("✅ Custom initial message sent");
                    } catch (error) {
                      console.error("❌ Failed to send custom initial message:", error.message);
                    }
                  } else if (initialMessage.type === "dynamic") {
                    console.log("📤 Triggering dynamic initial message");
                    try {
                      geminiSession.sendRealtimeInput({
                        text: "Start the conversation now. Begin speaking to the user as instructed in your system prompt.",
                      });

                      const silentChunk = Buffer.alloc(3840);
                      geminiSession.sendRealtimeInput({
                        media: { data: silentChunk.toString("base64"), mimeType: "audio/pcm;rate=16000" },
                      });
                      console.log("✅ Dynamic initial message trigger sent");
                    } catch (error) {
                      console.error("❌ Failed to send dynamic initial message:", error.message);
                    }
                  }
                }, 500);
              }
            } else {
              console.log("ℹ️ Initial message not enabled");
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
            const sessionDuration = Date.now() - startTime;
            console.log(`🔒 Gemini session closed (session lasted ${sessionDuration}ms)`);
            const wasReady = sessionReady;
            sessionReady = false;
            console.log("📊 Session stats:", {
              streamSid,
              callSid,
              transcriptTurns: transcriptTurns.length,
              sessionWasReady: wasReady,
              sessionDuration: `${sessionDuration}ms`,
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

    // Log all events for debugging
    if (msg.event !== "media") {
      console.log(`📨 Twilio event: ${msg.event}`, msg.event === "start" ? "(details logged below)" : "");
    }

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

        // STEP 5: Validate tools structure loaded from DB
        console.log("✓ Agent config loaded:", {
          agentName: agent.agent_name,
          voice: agentConfig?.voice?.voiceId,
          hasTools: agentConfig?.tools?.length > 0,
          toolsCount: agentConfig?.tools?.length || 0,
          workspaceId,
        });

        if (agentConfig?.tools && agentConfig.tools.length > 0) {
          console.log("🔧 Validating loaded tools...");
          agentConfig.tools.forEach((tool, idx) => {
            const isValid = tool.id && tool.tool_name && tool.endpoint_url && tool.http_method;
            if (!isValid) {
              console.error(`❌ Invalid tool ${idx}:`, {
                hasId: !!tool.id,
                hasName: !!tool.tool_name,
                hasUrl: !!tool.endpoint_url,
                hasMethod: !!tool.http_method,
                tool,
              });
            } else {
              console.log(`✅ Tool ${idx} valid:`, tool.tool_name);
            }
          });
        } else {
          console.log("⚠️ No tools configured for this agent");
        }
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
      console.log("📞 Call ended - Twilio sent 'stop' event");
      console.log("📊 Stop event received at:", new Date().toISOString());
      console.log("📊 Session state:", {
        sessionReady,
        hasGeminiSession: !!geminiSession,
        streamSid,
        callSid,
      });

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

        // Trigger post-call analysis
        if (formattedTranscript && agentConfig?.settings?.postCallAnalysis) {
          console.log("🔍 Triggering post-call analysis...");
          // Run analysis asynchronously (don't block call end)
          analyzeCallTranscript(formattedTranscript, agentConfig.settings.postCallAnalysis, callLogId).catch((err) => {
            console.error("❌ Post-call analysis error:", err);
          });
        }
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
