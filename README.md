# Voice AI Agent

A voice AI agent built with Twilio and Google Gemini that enables real-time voice conversations.

## Features

- Real-time voice conversation using Twilio WebSocket streaming
- Google Gemini AI integration for natural language processing
- WebSocket-based audio streaming
- Express.js server for handling Twilio webhooks

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   - Copy `env.example` to `.env`
   - Add your Google Gemini API key to the `.env` file

3. **Get your Google Gemini API key:**
   - Visit [Google AI Studio](https://aistudio.google.com/)
   - Create a new API key
   - Add it to your `.env` file

4. **Start the server:**
   ```bash
   npm start
   ```
   
   For development with auto-restart:
   ```bash
   npm run dev
   ```

## Twilio Configuration

1. **Set up a Twilio phone number:**
   - Go to [Twilio Console](https://console.twilio.com/)
   - Purchase a phone number
   - Configure the webhook URL to point to your server: `https://your-domain.com/incoming-call`

2. **Deploy your server:**
   - Use a service like Heroku, Railway, or ngrok for local development
   - Make sure your server is accessible via HTTPS (required for Twilio)

## Usage

1. Call your Twilio phone number
2. The call will be connected to the AI agent
3. Have a conversation with the AI agent in real-time

## Project Structure

- `server.js` - Main server file with Twilio and Gemini integration
- `package.json` - Project dependencies and scripts
- `env.example` - Environment variables template

## Notes

- The audio conversion functions (`mulawToLinear16` and `linear16ToMulaw`) are placeholders and need to be implemented for proper audio format conversion between Twilio (μ-law) and Gemini (LPCM16)
- The current implementation uses base64 encoding for demo purposes
- Make sure to implement proper error handling and logging for production use
