import OpenAI from "openai";

const baseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

if (!baseURL || !apiKey) {
  throw new Error(
    "AI_INTEGRATIONS_OPENAI_BASE_URL and AI_INTEGRATIONS_OPENAI_API_KEY must be set",
  );
}

const openai = new OpenAI({ baseURL, apiKey });

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const SYSTEM_PROMPT = `You are a friendly, helpful AI assistant chatting inside a Discord server.
Keep responses conversational and concise — Discord messages are best when short and readable.
Use simple Markdown when it helps (bold, lists, code blocks). Avoid extremely long replies.
If you're unsure, say so honestly. Do not invent facts.`;

export async function chat(history: ChatMessage[]): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-5.4",
    max_completion_tokens: 1024,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
  });

  const reply = response.choices[0]?.message?.content?.trim();
  return reply && reply.length > 0
    ? reply
    : "Sorry, I couldn't think of a reply for that.";
}

export type VoiceReply = {
  transcript: string;
  replyText: string;
  audioWav: Buffer;
};

const VOICE_SYSTEM_PROMPT = `You are a friendly AI participant in a Discord voice call.
Reply naturally and briefly — like you're chatting with friends. Keep responses short (1-3 sentences).
Match the language the speaker is using.`;

export async function voiceChat(
  wavInput: Buffer,
  speakerName: string,
): Promise<VoiceReply> {
  const response = (await openai.chat.completions.create({
    model: "gpt-audio",
    modalities: ["text", "audio"],
    audio: { voice: "alloy", format: "wav" },
    messages: [
      { role: "system", content: VOICE_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${speakerName} just spoke. Listen and reply.`,
          },
          {
            type: "input_audio",
            input_audio: {
              data: wavInput.toString("base64"),
              format: "wav",
            },
          },
        ],
      },
    ],
  } as Parameters<typeof openai.chat.completions.create>[0])) as unknown as {
    choices: { message: { audio?: { data?: string; transcript?: string } } }[];
  };

  const choice = response.choices[0];
  const audio = choice?.message?.audio;

  const transcript = audio?.transcript?.trim() ?? "";
  const replyText = transcript;
  const audioWav = audio?.data ? Buffer.from(audio.data, "base64") : Buffer.alloc(0);

  return { transcript, replyText, audioWav };
}
