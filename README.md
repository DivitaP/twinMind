# TwinMind Live Suggestions Assignment

## Stack
React + Vite + TypeScript

## Models
- Transcription: Groq Whisper Large V3
- Suggestions and chat: Groq GPT-OSS 120B

## Features
- Mic recording with ~30 second audio chunks
- Live transcript
- Exactly 3 suggestions per refresh
- Suggestion batches with newest on top
- Click suggestion to open detailed chat answer
- Manual chat
- Settings screen for Groq API key and editable prompts
- Export session as JSON

## Setup
npm install
npm run dev

## Build
npm run build

## Usage
Open Settings, paste Groq API key, save, then start the mic.

## Tradeoffs
The app calls Groq directly from the browser because the assignment requires users to paste their own Groq API key. No login or persistence is implemented. Session data stays in browser memory except settings saved in localStorage.