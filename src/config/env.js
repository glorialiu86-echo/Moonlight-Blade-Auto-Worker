function requireEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
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
    apiKey: requireEnv("LLM_API_KEY")
  };
}
