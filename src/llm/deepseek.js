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

export async function createChatCompletion({
  messages,
  model,
  maxTokens = 512,
  temperature = 0.7
}) {
  const config = getLlmConfig();
  const resolvedModel = model || config.model;
  const body = {
    model: resolvedModel,
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
  let payload;

  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`DeepSeek returned non-JSON response: ${raw}`);
  }

  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`DeepSeek API error: ${message}`);
  }

  return payload;
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

  return {
    id: completion.id,
    model: completion.model,
    text: completion.choices?.[0]?.message?.content || "",
    finishReason: completion.choices?.[0]?.finish_reason || null,
    usage: completion.usage || null,
    raw: completion
  };
}
