function requireEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalEnv(name, fallback) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

export function getLlmConfig() {
  const provider = requireEnv("LLM_PROVIDER");

  if (provider !== "qwen") {
    throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  }

  return {
    provider,
    baseUrl: requireEnv("LLM_BASE_URL").replace(/\/+$/, ""),
    model: requireEnv("LLM_MODEL"),
    reasoningModel: requireEnv("LLM_REASONING_MODEL"),
    visionModel: requireEnv("LLM_VISION_MODEL"),
    ocrModel: requireEnv("LLM_OCR_MODEL"),
    speechModel: optionalEnv("LLM_SPEECH_MODEL", "qwen3.5-omni-plus"),
    apiKey: requireEnv("LLM_API_KEY")
  };
}
