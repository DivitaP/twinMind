import { useEffect, useRef, useState } from "react";
import {
  generateChatAnswer,
  generateDetailedAnswer,
  generateLiveSuggestions,
  transcribeAudioChunk,
} from "./lib/groq";
import "./App.css";

type AppSettings = {
  groqApiKey: string;
  suggestionPrompt: string;
  detailedAnswerPrompt: string;
  chatPrompt: string;
  suggestionContextWindow: number;
  detailedAnswerContextWindow: number;
};

type TranscriptChunk = {
  id: string;
  text: string;
  createdAt: string;
};

type SuggestionType =
  | "question"
  | "talking_point"
  | "answer"
  | "fact_check"
  | "clarification";

type Suggestion = {
  id: string;
  type: SuggestionType;
  title: string;
  preview: string;
};

type SuggestionBatch = {
  id: string;
  createdAt: string;
  suggestions: Suggestion[];
};

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
};

const defaultSettings: AppSettings = {
  groqApiKey: "",
  suggestionPrompt: `You are a real-time meeting copilot.

Based on the recent transcript, generate exactly 3 useful live suggestions.

The suggestions should help the user participate better in the meeting.

Choose the best mix from:
- a question the user should ask
- a talking point the user can raise
- a direct answer to something just asked
- a fact-check or uncertainty flag
- a clarification request

Rules:
- Make suggestions timely and specific to the transcript.
- Each preview must be useful even if the user does not click.
- Avoid generic summaries.
- Do not invent facts not in the transcript.`,
  detailedAnswerPrompt: `You are a real-time meeting copilot.

The user clicked a live suggestion during an active conversation.

Your job:
- Give a practical answer the user can use immediately in the meeting.
- Do NOT write a blog post, article, resume section, or generic guide.
- Do NOT use tables unless absolutely necessary.
- Keep the answer focused on the current transcript.
- Prefer short bullets or a short spoken script.
- If the transcript does not contain enough context, say what is missing and suggest a useful follow-up question.

Response format:
1. Start with a direct answer in 1-2 sentences.
2. Then give 2-4 useful bullets.
3. If helpful, include one short line the user can say out loud.

Keep the total answer under 180 words.`,
  chatPrompt: `You are a helpful real-time meeting assistant.

Answer the user's question using the transcript and chat history.

Rules:
- Be concise and practical.
- Do not invent personal facts, company names, scores, metrics, or achievements unless they appear in the transcript or user question.
- If the question is unrelated to the transcript, answer normally but briefly.
- Avoid long essays, tables, and resume-style responses.
- Prefer meeting-ready wording.

Keep the answer under 180 words unless the user explicitly asks for more detail.`,
  suggestionContextWindow: 3000,
  detailedAnswerContextWindow: 9000,
};

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);

  const [isRecording, setIsRecording] = useState(false);
  const [transcriptChunks, setTranscriptChunks] = useState<TranscriptChunk[]>([]);
  const [suggestionBatches, setSuggestionBatches] = useState<SuggestionBatch[]>(
    []
  );
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");

  const [isGeneratingSuggestions, setIsGeneratingSuggestions] = useState(false);
  const [isGeneratingChat, setIsGeneratingChat] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingIntervalRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("twinmind-settings");

    if (saved) {
      try {
        setSettings({ ...defaultSettings, ...JSON.parse(saved) });
      } catch {
        setSettings(defaultSettings);
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      stopRecording();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateSetting<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) {
    setSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  }

  function saveSettings() {
    localStorage.setItem("twinmind-settings", JSON.stringify(settings));
    setSettingsOpen(false);
  }

  function resetSettings() {
    localStorage.removeItem("twinmind-settings");
    setSettings(defaultSettings);
  }

  function getTranscriptContext(limit: number) {
    const fullTranscript = transcriptChunks.map((chunk) => chunk.text).join("\n");
    return fullTranscript.slice(-limit);
  }

  function getChatHistoryText() {
    return chatMessages
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");
  }

  async function toggleRecording() {
    if (isRecording) {
      stopRecording();
      return;
    }

    await startRecording();
  }

  function createRecorder(stream: MediaStream) {
    const recorder = new MediaRecorder(stream, {
      mimeType: "audio/webm",
    });

    audioChunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunksRef.current.push(event.data);
      }
    };

    recorder.onstop = async () => {
      const audioBlob = new Blob(audioChunksRef.current, {
        type: "audio/webm",
      });

      audioChunksRef.current = [];

      if (audioBlob.size > 0) {
        await transcribeAndAppend(audioBlob);
      }
    };

    return recorder;
  }

  async function startRecording() {
    if (!settings.groqApiKey.trim()) {
      setErrorMessage("Please add your Groq API key in Settings first.");
      setSettingsOpen(true);
      return;
    }

    try {
      setErrorMessage("");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = createRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.start();

      setIsRecording(true);

      recordingIntervalRef.current = window.setInterval(() => {
        const currentRecorder = mediaRecorderRef.current;
        const currentStream = streamRef.current;

        if (
          currentRecorder &&
          currentStream &&
          currentRecorder.state === "recording"
        ) {
          currentRecorder.stop();

          const newRecorder = createRecorder(currentStream);
          mediaRecorderRef.current = newRecorder;
          newRecorder.start();
        }
      }, 30000);
    } catch (error) {
      console.error(error);
      setErrorMessage(
        error instanceof Error ? error.message : "Could not access microphone."
      );
    }
  }

  function stopRecording() {
    if (recordingIntervalRef.current) {
      window.clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }

    const recorder = mediaRecorderRef.current;

    if (recorder && recorder.state === "recording") {
      recorder.stop();
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    setIsRecording(false);
  }

  async function transcribeAndAppend(audioBlob: Blob) {
    try {
      setIsTranscribing(true);

      const text = await transcribeAudioChunk({
        apiKey: settings.groqApiKey,
        audioBlob,
      });

      const cleanedText = text.trim();
      if (!cleanedText) return;

      const newChunk: TranscriptChunk = {
        id: crypto.randomUUID(),
        text: cleanedText,
        createdAt: new Date().toISOString(),
      };

      setTranscriptChunks((prev) => [...prev, newChunk]);

      setTimeout(() => {
        generateSuggestions(cleanedText);
      }, 300);
    } catch (error) {
      console.error(error);
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to transcribe audio."
      );
    } finally {
      setIsTranscribing(false);
    }
  }

  async function generateSuggestions(extraLatestText = "") {
    if (!settings.groqApiKey.trim()) {
      setErrorMessage("Please add your Groq API key in Settings first.");
      setSettingsOpen(true);
      return;
    }

    setErrorMessage("");
    setIsGeneratingSuggestions(true);

    try {
      const transcriptContext = `${getTranscriptContext(
        settings.suggestionContextWindow
      )}\n${extraLatestText}`.trim();

      const suggestionsFromGroq = await generateLiveSuggestions({
        apiKey: settings.groqApiKey,
        suggestionPrompt: settings.suggestionPrompt,
        transcriptContext,
      });

      const newBatch: SuggestionBatch = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        suggestions: suggestionsFromGroq.map((suggestion) => ({
          id: crypto.randomUUID(),
          type: suggestion.type,
          title: suggestion.title,
          preview: suggestion.preview,
        })),
      };

      setSuggestionBatches((prev) => [newBatch, ...prev]);
    } catch (error) {
      console.error(error);
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to generate suggestions."
      );
    } finally {
      setIsGeneratingSuggestions(false);
    }
  }

  async function addAssistantReply(userText: string, mode: "suggestion" | "chat") {
    if (!settings.groqApiKey.trim()) {
      setErrorMessage("Please add your Groq API key in Settings first.");
      setSettingsOpen(true);
      return;
    }

    setIsGeneratingChat(true);
    setErrorMessage("");

    try {
      const transcriptContext = getTranscriptContext(
        settings.detailedAnswerContextWindow
      );

      const answerText =
        mode === "suggestion"
          ? await generateDetailedAnswer({
              apiKey: settings.groqApiKey,
              detailedAnswerPrompt: settings.detailedAnswerPrompt,
              transcriptContext,
              suggestionText: userText,
            })
          : await generateChatAnswer({
              apiKey: settings.groqApiKey,
              chatPrompt: settings.chatPrompt,
              transcriptContext,
              chatHistory: getChatHistoryText(),
              userQuestion: userText,
            });

      const answer: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        createdAt: new Date().toISOString(),
        content: answerText,
      };

      setChatMessages((prev) => [...prev, answer]);
    } catch (error) {
      console.error(error);
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to generate chat answer."
      );
    } finally {
      setIsGeneratingChat(false);
    }
  }

  function handleSuggestionClick(suggestion: Suggestion) {
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      createdAt: new Date().toISOString(),
      content: suggestion.preview,
    };

    setChatMessages((prev) => [...prev, userMessage]);
    addAssistantReply(suggestion.preview, "suggestion");
  }

  function handleSendChat() {
    const trimmed = chatInput.trim();
    if (!trimmed) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      createdAt: new Date().toISOString(),
      content: trimmed,
    };

    setChatMessages((prev) => [...prev, userMessage]);
    setChatInput("");
    addAssistantReply(trimmed, "chat");
  }

  function exportSession() {
    const exportData = {
      exportedAt: new Date().toISOString(),
      transcript: transcriptChunks,
      suggestionBatches,
      chatHistory: chatMessages,
      settings: {
        suggestionPrompt: settings.suggestionPrompt,
        detailedAnswerPrompt: settings.detailedAnswerPrompt,
        chatPrompt: settings.chatPrompt,
        suggestionContextWindow: settings.suggestionContextWindow,
        detailedAnswerContextWindow: settings.detailedAnswerContextWindow,
        hasGroqApiKey: Boolean(settings.groqApiKey.trim()),
      },
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `twinmind-session-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  }

  return (
    <div className="app">
      <header className="top-bar">
        <div>
          <h1>TwinMind — Live Suggestions Web App</h1>
        </div>

        <div className="top-actions">
          <div className="top-meta">
            Transcript · Suggestions · Chat · Export
          </div>

          <button className="settings-button" onClick={exportSession}>
            Export
          </button>

          <button className="settings-button" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      <main className="layout">
        <section className="panel">
          <div className="panel-header">
            <span>1. MIC & TRANSCRIPT</span>
            <span>
              {isRecording ? "RECORDING" : isTranscribing ? "TRANSCRIBING" : "IDLE"}
            </span>
          </div>

          <div className="mic-row">
            <button
              className={`mic-button ${isRecording ? "recording" : ""}`}
              onClick={toggleRecording}
            >
              <span className="mic-dot" />
            </button>

            <p>
              {isRecording
                ? "Recording live audio. Transcript updates every ~30s."
                : "Click mic to start. Transcript appends every ~30s."}
            </p>
          </div>

          <div className="transcript-list">
            {transcriptChunks.length === 0 ? (
              <div className="info-card">
                Start the mic and speak. Every ~30 seconds, the app sends an
                audio chunk to Groq Whisper and appends the transcript here.
              </div>
            ) : (
              transcriptChunks.map((chunk) => (
                <div className="transcript-chunk" key={chunk.id}>
                  <div className="chunk-time">
                    {new Date(chunk.createdAt).toLocaleTimeString()}
                  </div>
                  <p>{chunk.text}</p>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <span>2. LIVE SUGGESTIONS</span>
            <span>{suggestionBatches.length} BATCHES</span>
          </div>

          <div className="suggestion-toolbar">
            <button
              className="secondary-button"
              onClick={() => generateSuggestions()}
              disabled={isGeneratingSuggestions}
            >
              {isGeneratingSuggestions ? "Generating..." : "↻ Reload suggestions"}
            </button>
            <span>auto-refresh after transcript chunk</span>
          </div>

          <div className="suggestion-list">
            {suggestionBatches.length === 0 ? (
              <div className="info-card">
                Suggestions appear here after transcription or when you click
                reload. Each batch contains exactly 3 suggestions.
              </div>
            ) : (
              suggestionBatches.map((batch) => (
                <div className="suggestion-batch" key={batch.id}>
                  <div className="batch-time">
                    {new Date(batch.createdAt).toLocaleTimeString()}
                  </div>

                  {batch.suggestions.map((suggestion) => (
                    <button
                      className="suggestion-card"
                      key={suggestion.id}
                      onClick={() => handleSuggestionClick(suggestion)}
                    >
                      <div className={`suggestion-type ${suggestion.type}`}>
                        {suggestion.type.replace("_", " ")}
                      </div>
                      <h3>{suggestion.title}</h3>
                      <p>{suggestion.preview}</p>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <span>3. CHAT</span>
            <span>{isGeneratingChat ? "THINKING" : "SESSION-ONLY"}</span>
          </div>

          <div className="chat-body">
            {chatMessages.length === 0 ? (
              <>
                <div className="info-card">
                  Click a suggestion to get a detailed answer, or type your own
                  question. Chat uses transcript context and stays in this
                  session only.
                </div>

                <div className="empty-state">
                  Click a suggestion or type a question below.
                </div>
              </>
            ) : (
              <div className="chat-message-list">
                {chatMessages.map((message) => (
                  <div className={`chat-message ${message.role}`} key={message.id}>
                    <div className="chat-message-meta">
                      {message.role === "user" ? "You" : "Assistant"} ·{" "}
                      {new Date(message.createdAt).toLocaleTimeString()}
                    </div>
                    <p>{message.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="chat-input-row">
            <input
              placeholder="Ask anything..."
              value={chatInput}
              disabled={isGeneratingChat}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSendChat();
                }
              }}
            />
            <button onClick={handleSendChat} disabled={isGeneratingChat}>
              Send
            </button>
          </div>
        </section>
      </main>

      {settingsOpen && (
        <div className="modal-backdrop">
          <div className="settings-modal">
            <div className="modal-header">
              <h2>Settings</h2>
              <button onClick={() => setSettingsOpen(false)}>×</button>
            </div>

            <label>
              Groq API Key
              <input
                type="password"
                value={settings.groqApiKey}
                onChange={(e) => updateSetting("groqApiKey", e.target.value)}
                placeholder="Paste your Groq API key"
              />
            </label>

            <label>
              Live Suggestion Prompt
              <textarea
                value={settings.suggestionPrompt}
                onChange={(e) =>
                  updateSetting("suggestionPrompt", e.target.value)
                }
              />
            </label>

            <label>
              Detailed Answer Prompt
              <textarea
                value={settings.detailedAnswerPrompt}
                onChange={(e) =>
                  updateSetting("detailedAnswerPrompt", e.target.value)
                }
              />
            </label>

            <label>
              Chat Prompt
              <textarea
                value={settings.chatPrompt}
                onChange={(e) => updateSetting("chatPrompt", e.target.value)}
              />
            </label>

            <div className="settings-grid">
              <label>
                Suggestion Context Window
                <input
                  type="number"
                  value={settings.suggestionContextWindow}
                  onChange={(e) =>
                    updateSetting(
                      "suggestionContextWindow",
                      Number(e.target.value)
                    )
                  }
                />
              </label>

              <label>
                Detailed Answer Context Window
                <input
                  type="number"
                  value={settings.detailedAnswerContextWindow}
                  onChange={(e) =>
                    updateSetting(
                      "detailedAnswerContextWindow",
                      Number(e.target.value)
                    )
                  }
                />
              </label>
            </div>

            <div className="modal-actions">
              <button className="secondary-button" onClick={resetSettings}>
                Reset Defaults
              </button>
              <button className="primary-button" onClick={saveSettings}>
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;