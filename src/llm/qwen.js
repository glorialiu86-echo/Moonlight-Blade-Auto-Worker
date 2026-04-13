import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getLlmConfig } from "../config/env.js";

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }

  return messages.map((message) => {
    if (!message?.role || !message?.content) {
      throw new Error("each message must include role and content");
    }

    return {
      role: message.role,
      content: message.content
    };
  });
}

function parseJsonResponse(raw, providerName) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${providerName} returned non-JSON response: ${raw}`);
  }
}

function parseSseEventData(rawChunk) {
  return rawChunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item?.type === "text") {
          return item.text || "";
        }

        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

function contentTypeByExtension(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp"
  };

  return contentTypes[extension] || "application/octet-stream";
}

function toImageUrl(imageInput) {
  if (!imageInput) {
    throw new Error("imageInput is required");
  }

  if (/^data:/.test(imageInput) || /^https?:\/\//.test(imageInput)) {
    return imageInput;
  }

  if (!existsSync(imageInput)) {
    throw new Error(`Image input not found: ${imageInput}`);
  }

  const contentType = contentTypeByExtension(imageInput);
  const buffer = readFileSync(imageInput);
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function inferAudioFormat(audioInput, formatHint) {
  if (formatHint) {
    return formatHint.toLowerCase();
  }

  const mimeMatch = typeof audioInput === "string"
    ? audioInput.match(/^data:audio\/([a-z0-9.+-]+);base64,/i)
    : null;
  const mimeSubtype = mimeMatch?.[1]?.toLowerCase();
  const formatMap = {
    "mpeg": "mp3",
    "mpga": "mp3",
    "x-wav": "wav",
    "wav": "wav",
    "mp4": "mp4",
    "aac": "aac",
    "ogg": "ogg",
    "flac": "flac"
  };

  return formatMap[mimeSubtype] || "wav";
}

function normalizeAudioInput(audioInput) {
  if (typeof audioInput !== "string" || !audioInput.trim()) {
    throw new Error("audioInput is required");
  }

  if (/^data:audio\/[a-z0-9.+-]+;base64,/i.test(audioInput)) {
    const base64 = audioInput.slice(audioInput.indexOf(",") + 1);
    return `data:;base64,${base64}`;
  }

  if (/^data:;base64,/i.test(audioInput) || /^https?:\/\//i.test(audioInput)) {
    return audioInput;
  }

  throw new Error("audioInput must be a valid audio data URL or public URL");
}

async function requestQwen({ messages, model, maxTokens = 512, temperature = 0.7 }) {
  const config = getLlmConfig();
  const body = {
    model,
    messages: normalizeMessages(messages),
    max_tokens: maxTokens,
    temperature,
    stream: false
  };

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  const payload = parseJsonResponse(raw, "Qwen");

  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Qwen API error: ${message}`);
  }

  return payload;
}

async function requestQwenStream({ body }) {
  const config = getLlmConfig();
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const raw = await response.text();
    const payload = parseJsonResponse(raw, "Qwen");
    const message = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Qwen API error: ${message}`);
  }

  if (!response.body) {
    throw new Error("Qwen stream response body is empty");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;
  let finishReason = null;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const dataLines = parseSseEventData(event);

      for (const dataLine of dataLines) {
        if (dataLine === "[DONE]") {
          continue;
        }

        const payload = parseJsonResponse(dataLine, "Qwen SSE");
        const choice = payload.choices?.[0];
        text += extractTextContent(choice?.delta?.content);
        finishReason = choice?.finish_reason || finishReason;
        usage = payload.usage || usage;
      }
    }
  }

  return {
    text: text.trim(),
    usage,
    finishReason
  };
}

function completionToResult(completion) {
  return {
    id: completion.id,
    model: completion.model,
    text: extractTextContent(completion.choices?.[0]?.message?.content),
    finishReason: completion.choices?.[0]?.finish_reason || null,
    usage: completion.usage || null,
    raw: completion
  };
}

export async function createChatCompletion({ messages, model, maxTokens, temperature }) {
  const config = getLlmConfig();
  return requestQwen({
    messages,
    model: model || config.model,
    maxTokens,
    temperature
  });
}

export async function generateText({
  systemPrompt,
  userPrompt,
  useReasoningModel = false,
  maxTokens,
  temperature
}) {
  const config = getLlmConfig();
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({ role: "user", content: userPrompt });

  const completion = await createChatCompletion({
    messages,
    model: useReasoningModel ? config.reasoningModel : config.model,
    maxTokens,
    temperature
  });

  return completionToResult(completion);
}

export async function analyzeImage({
  prompt,
  imageInput,
  systemPrompt = "你是一个严谨的图像场景分析助手。",
  maxTokens = 500,
  temperature = 0.2,
  model
}) {
  const config = getLlmConfig();
  const completion = await createChatCompletion({
    model: model || config.visionModel,
    maxTokens,
    temperature,
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: toImageUrl(imageInput) } }
        ]
      }
    ]
  });

  return completionToResult(completion);
}

export async function extractTextFromImage({
  imageInput,
  prompt = "请提取图片中的所有可见文字，并尽量保持原始顺序。若存在表格或列表，请用易读格式输出。",
  maxTokens = 800,
  temperature = 0.1,
  model
}) {
  const config = getLlmConfig();
  const completion = await createChatCompletion({
    model: model || config.ocrModel,
    maxTokens,
    temperature,
    messages: [
      {
        role: "system",
        content: "你是一个 OCR 助手，目标是准确提取图像文字，不补写不存在的内容。"
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: toImageUrl(imageInput) } }
        ]
      }
    ]
  });

  return completionToResult(completion);
}

export async function transcribeAudio({
  audioInput,
  format,
  prompt = "请将这段语音准确转写为简体中文文本，只输出转写结果，不要添加解释或标点修正说明。"
}) {
  const config = getLlmConfig();
  const normalizedAudioInput = normalizeAudioInput(audioInput);
  const audioFormat = inferAudioFormat(audioInput, format);
  const result = await requestQwenStream({
    body: {
      model: config.speechModel,
      stream: true,
      modalities: ["text"],
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "你是一个中文语音转写助手，目标是准确转写音频内容，不补写不存在的信息。"
        },
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: normalizedAudioInput,
                format: audioFormat
              }
            },
            {
              type: "text",
              text: prompt
            }
          ]
        }
      ]
    }
  });

  if (!result.text) {
    throw new Error("语音转写结果为空");
  }

  return result;
}
