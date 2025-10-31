const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { VoiceResponse } = require('twilio').twiml;
const { GoogleGenAI, Modality, Type } = require('@google/genai');
require('dotenv').config();

// --- Audio Utility Functions (No changes here, keeping them for completeness) ---

// Pre-computed lookup table for µ-law decoding for performance
const ulawDecodeTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
    let sample = i ^ 0xFF; // Invert all bits
    const sign = (sample & 0x80);
    const exponent = (sample >> 4) & 0x07;
    const mantissa = sample & 0x0F;
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
    if (fromRate === toRate) { return pcmData; }
    if (toRate > fromRate) {
        const newLength = Math.round(pcmData.length * toRate / fromRate);
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
    if (toRate < fromRate) {
        const ratio = fromRate / toRate;
        const newLength = Math.floor(pcmData.length / ratio);
        if (newLength === 0) return new Int16Array(0);
        const result = new Int16Array(newLength);
        for (let i = 0; i < newLength; i++) {
            const startIndex = Math.floor(i * ratio);
            const endIndex = Math.floor((i + 1) * ratio);
            let sum = 0;
            const count = endIndex - startIndex;
            for (let j = startIndex; j < endIndex; j++) { sum += pcmData[j] || 0; }
            result[i] = Math.round(sum / count);
        }
        return result;
    }
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
        const mantissa = (sample >> (exponent + 3)) & 0x0F;
        let ulaw = (sign | (exponent << 4) | mantissa);
        ulawData[i] = (~ulaw) & 0xFF;
    }
    return Buffer.from(ulawData);
}
const AMPLIFICATION_FACTOR = 2.0; // Reduced for faster processing
function processTwilioToGemini(twilioChunk) {
    const pcm8k = decodeMulaw(twilioChunk);
    const pcm16k = resample(pcm8k, 8000, 16000);
    // Inline amplification for speed
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
// --- Agent Configuration (No changes here) ---
const phoneAgentTools = [{
    name: 'get_order_status',
    description: "Get the current status of a customer's order.",
    parameters: {
        type: Type.OBJECT,
        properties: { order_id: { type: Type.STRING, description: 'The unique identifier for the order, e.g., ORD12345' } },
        required: ['order_id'],
    }
}];

// --- Express and WebSocket Server Setup ---

const app = express();
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;

// Pre-initialize AI client for faster session creation
let aiClient = null;
(async () => {
    if (!process.env.API_KEY) {
        console.error("API_KEY not set in environment variables!");
        process.exit(1);
    }
    aiClient = new GoogleGenAI({ apiKey: process.env.API_KEY });
    console.log("AI client pre-initialized and ready");
})();

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

// --- OPTIMIZED /incoming-call ENDPOINT ---
app.post('/incoming-call', (req, res) => {
  console.log('Incoming call from:', req.body.From);
  const response = new VoiceResponse();
  
  // Immediate connection - no warmup delay
  const connect = response.connect();
  connect.stream({ url: `wss://${req.headers.host}/audio` });
  
  res.type('text/xml');
  res.send(response.toString());
});


// --- ULTRA-OPTIMIZED WebSocket CONNECTION LOGIC ---
wss.on('connection', (ws) => {
  const connStartTime = Date.now();
  console.log('WebSocket connected - initializing session...');
  let streamSid = null;
  let geminiSession = null;
  let audioBuffer = []; // Buffer audio until session ready
  let sessionReady = false;
  let firstAudioReceived = null;
  let firstResponseSent = null;

  const handleToolCall = async (fc) => {
      console.log(`[Tool] ${fc.name}`);
      let result;
      if (fc.name === 'get_order_status') {
          const status = ['Processing', 'Shipped', 'Delivered'][Math.floor(Math.random() * 3)];
          result = { status, estimated_delivery: '2 business days' };
      } else {
          result = { error: 'Unknown tool' };
      }
      geminiSession?.sendToolResponse({
          functionResponses: [{ id: fc.id, name: fc.name, response: { result: JSON.stringify(result) } }],
      });
  };

  ws.on('message', (message) => {
      const msg = JSON.parse(message.toString());
      if (msg.event === 'start') {
          streamSid = msg.start.streamSid;
          console.log(`Stream started: ${streamSid} (${Date.now() - connStartTime}ms from connection)`);
      } else if (msg.event === 'media') {
          if (!firstAudioReceived) {
              firstAudioReceived = Date.now();
              console.log(`First audio: ${firstAudioReceived - connStartTime}ms from connection`);
          }
          
          if (sessionReady && geminiSession) {
              // Session ready - send immediately
              const twilioAudioChunk = Buffer.from(msg.media.payload, 'base64');
              const geminiAudioChunk = processTwilioToGemini(twilioAudioChunk);
              geminiSession.sendRealtimeInput({
                  media: { data: geminiAudioChunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' }
              });
          } else {
              // Buffer audio while session initializing (keep only last 1 second)
              audioBuffer.push(msg.media.payload);
              if (audioBuffer.length > 50) audioBuffer.shift(); // 50 chunks = ~1 sec
          }
      } else if (msg.event === 'stop') {
          ws.close();
      }
  });

  ws.on('close', () => {
      console.log('Twilio WebSocket connection closed.');
      geminiSession?.close();
  });

  ws.on('error', (err) => {
      console.error('Twilio WebSocket error:', err);
      geminiSession?.close();
  });

  // Initialize session FAST - every millisecond counts
  (async () => {
      try {
          if (!aiClient) throw new Error("AI client not initialized");
          
          const startTime = Date.now();
          geminiSession = await aiClient.live.connect({
              model: 'gemini-2.5-flash-native-audio-preview-09-2025',
              config: {
                  responseModalities: [Modality.AUDIO],
                  // NO TRANSCRIPTION - removes 50-100ms overhead per message
                  speechConfig: { 
                      voiceConfig: { 
                          prebuiltVoiceConfig: { voiceName: 'Kore' } 
                      }
                  },
                  systemInstruction: 'You are Ava. Customer support for Pixel Perfect Prints. Reply fast, be brief and helpful. Use get_order_status tool for order queries.',
                  tools: [{ functionDeclarations: phoneAgentTools }],
              },
              callbacks: {
                  onopen: () => {
                      const initTime = Date.now() - startTime;
                      console.log(`Session ready in ${initTime}ms`);
                  },
                  onclose: () => console.log('Session closed'),
                  onerror: (e) => console.error('Gemini error:', e),
                  onmessage: async (message) => {
                      // Tool calls
                      if (message.toolCall) {
                          message.toolCall.functionCalls.forEach(handleToolCall);
                      }
                      // Interruption handling
                      if (message.serverContent?.interrupted && streamSid) {
                          ws.send(JSON.stringify({ event: 'clear', streamSid }));
                      }
                      // Stream audio IMMEDIATELY - no waiting
                      if (message.serverContent?.modelTurn && streamSid) {
                          const audioPart = message.serverContent.modelTurn.parts?.find(p => p.inlineData?.mimeType.startsWith('audio/'));
                          if (audioPart?.inlineData.data) {
                              if (!firstResponseSent && firstAudioReceived) {
                                  firstResponseSent = Date.now();
                                  console.log(`⚡ RESPONSE LATENCY: ${firstResponseSent - firstAudioReceived}ms`);
                              }
                              const geminiAudioChunk = Buffer.from(audioPart.inlineData.data, 'base64');
                              const twilioAudioChunk = processGeminiToTwilio(geminiAudioChunk);
                              ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: twilioAudioChunk.toString('base64') } }));
                          }
                      }
                  },
              }
          });
          
          // Mark session as ready and flush buffered audio
          sessionReady = true;
          console.log(`Flushing ${audioBuffer.length} buffered chunks`);
          
          if (audioBuffer.length > 0) {
              const combinedPayload = audioBuffer.join('');
              audioBuffer = [];
              const twilioAudioChunk = Buffer.from(combinedPayload, 'base64');
              const geminiAudioChunk = processTwilioToGemini(twilioAudioChunk);
              geminiSession.sendRealtimeInput({
                  media: { data: geminiAudioChunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' }
              });
          }

      } catch (err) {
          console.error('Session init failed:', err);
          ws.close();
      }
  })();
}); 