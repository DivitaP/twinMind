export type GroqSuggestion = {
  type: "question" | "talking_point" | "answer" | "fact_check" | "clarification";
  title: string;
  preview: string;
};

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TRANSCRIPTION_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";

const CHAT_MODEL = "openai/gpt-oss-120b";
const TRANSCRIPTION_MODEL = "whisper-large-v3";

async function callGroqChat(params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}) {
  const response = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      temperature: params.temperature ?? 0.4,
      messages: [
        {
          role: "system",
          content: params.systemPrompt,
        },
        {
          role: "user",
          content: params.userPrompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

function extractJsonObject(raw: string) {
  const cleaned = raw
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("Model response did not contain valid JSON.");
  }

  return cleaned.slice(firstBrace, lastBrace + 1);
}

export async function generateLiveSuggestions(params: {
  apiKey: string;
  suggestionPrompt: string;
  transcriptContext: string;
}) {
  const raw = await callGroqChat({
    apiKey: params.apiKey,
    systemPrompt: `${params.suggestionPrompt}

Return ONLY valid JSON. No markdown. No explanation.

The JSON format must be:
{
  "suggestions": [
    {
      "type": "question",
      "title": "short title",
      "preview": "useful one to two sentence preview"
    }
  ]
}

Rules:
- Return exactly 3 suggestions.
- Each preview must be immediately useful even if the user does not click it.
- Use only these type values: question, talking_point, answer, fact_check, clarification.
- Suggestions should be varied and based on the most recent meeting context.
- Do not repeat the same idea in multiple suggestions.
- Do not invent personal facts, company names, metrics, scores, or claims unless they appear in the transcript.`,
    userPrompt: `Recent transcript context:

${params.transcriptContext || "No transcript yet."}`,
    temperature: 0.45,
  });

  const jsonText = extractJsonObject(raw);
  const parsed = JSON.parse(jsonText) as { suggestions: GroqSuggestion[] };

  if (!Array.isArray(parsed.suggestions)) {
    throw new Error("Groq response did not include a suggestions array.");
  }

  if (parsed.suggestions.length !== 3) {
    throw new Error("Groq did not return exactly 3 suggestions.");
  }

  return parsed.suggestions.map((suggestion) => {
    const allowedTypes = [
      "question",
      "talking_point",
      "answer",
      "fact_check",
      "clarification",
    ];

    const safeType = allowedTypes.includes(suggestion.type)
      ? suggestion.type
      : "clarification";

    return {
      type: safeType as GroqSuggestion["type"],
      title: suggestion.title?.trim() || "Useful meeting suggestion",
      preview:
        suggestion.preview?.trim() ||
        "Ask a clarifying question based on the recent discussion.",
    };
  });
}

export async function generateDetailedAnswer(params: {
  apiKey: string;
  detailedAnswerPrompt: string;
  transcriptContext: string;
  suggestionText: string;
}) {
  return callGroqChat({
    apiKey: params.apiKey,
    systemPrompt: params.detailedAnswerPrompt,
    userPrompt: `The user clicked this live suggestion:

"${params.suggestionText}"

Transcript context:

${params.transcriptContext || "No transcript available."}

Write a short meeting-copilot answer.

Important:
- The answer should help the user respond in the meeting right now.
- Do not create a long article.
- Do not include unrelated examples.
- Do not invent facts not present in the transcript.
- Keep it under 180 words.`,
    temperature: 0.35,
  });
}

export async function generateChatAnswer(params: {
  apiKey: string;
  chatPrompt: string;
  transcriptContext: string;
  chatHistory: string;
  userQuestion: string;
}) {
  return callGroqChat({
    apiKey: params.apiKey,
    systemPrompt: params.chatPrompt,
    userPrompt: `Transcript context:

${params.transcriptContext || "No transcript available."}

Chat history:

${params.chatHistory || "No prior chat."}

User question:

"${params.userQuestion}"

Answer the user directly and briefly. Use transcript context when relevant. Do not invent details.`,
    temperature: 0.35,
  });
}

export async function transcribeAudioChunk(params: {
  apiKey: string;
  audioBlob: Blob;
}) {
  const formData = new FormData();

  formData.append("file", params.audioBlob, "audio.webm");
  formData.append("model", TRANSCRIPTION_MODEL);
  formData.append("response_format", "json");
  formData.append("language", "en");
  formData.append("temperature", "0");

  const response = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq transcription error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.text?.trim() ?? "";
}