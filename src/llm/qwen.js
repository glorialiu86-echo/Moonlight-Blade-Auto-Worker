import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getLlmConfig, getTextLlmConfig } from "../config/env.js";

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

function providerLabel(provider) {
  return provider === "qwen" ? "Qwen" : "OpenAI-compatible provider";
}

async function requestChatCompletion({
  messages,
  model,
  maxTokens = 512,
  temperature = 0.7,
  config = getTextLlmConfig()
}) {
  const body = {
    model,
    messages: normalizeMessages(messages),
    max_tokens: maxTokens,
    temperature,
    stream: false
  };

  const headers = {
    "Content-Type": "application/json"
  };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  const payload = parseJsonResponse(raw, providerLabel(config.provider));

  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`${providerLabel(config.provider)} API error: ${message}`);
  }

  return payload;
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
  const config = getTextLlmConfig();
  return requestChatCompletion({
    messages,
    config,
    model: model || config.model,
    maxTokens,
    temperature
  });
}

export async function generateText({
  systemPrompt,
  historyMessages = [],
  userPrompt,
  useReasoningModel = false,
  maxTokens,
  temperature
}) {
  const config = getTextLlmConfig();
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  if (historyMessages.length > 0) {
    messages.push(...historyMessages);
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
  const completion = await requestChatCompletion({
    config,
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
  const completion = await requestChatCompletion({
    config,
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
