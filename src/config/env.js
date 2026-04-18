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

function parseProvider(name, fallback) {
  const provider = optionalEnv(name, fallback);

  if (!["qwen", "openai_compatible"].includes(provider)) {
    throw new Error(`Unsupported ${name}: ${provider}`);
  }

  return provider;
}

export function getLlmConfig() {
  const provider = parseProvider("LLM_PROVIDER", requireEnv("LLM_PROVIDER"));
  const baseUrl = requireEnv("LLM_BASE_URL").replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY?.trim() || "";

  return {
    provider,
    baseUrl,
    model: requireEnv("LLM_MODEL"),
    reasoningModel: requireEnv("LLM_REASONING_MODEL"),
    visionModel: requireEnv("LLM_VISION_MODEL"),
    ocrModel: requireEnv("LLM_OCR_MODEL"),
    apiKey
  };
}

export function getTextLlmConfig() {
  const fallback = getLlmConfig();
  const provider = parseProvider("TEXT_LLM_PROVIDER", fallback.provider);

  return {
    provider,
    baseUrl: optionalEnv("TEXT_LLM_BASE_URL", fallback.baseUrl).replace(/\/+$/, ""),
    model: optionalEnv("TEXT_LLM_MODEL", fallback.model),
    reasoningModel: optionalEnv("TEXT_LLM_REASONING_MODEL", fallback.reasoningModel),
    apiKey: optionalEnv("TEXT_LLM_API_KEY", fallback.apiKey)
  };
}

export function getAliyunAsrConfig() {
  return {
    apiKey: optionalEnv("ALIYUN_ASR_API_KEY", process.env.LLM_API_KEY?.trim() || ""),
    model: optionalEnv("ALIYUN_ASR_MODEL", "qwen3-asr-flash"),
    url: optionalEnv("ALIYUN_ASR_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"),
    language: optionalEnv("ALIYUN_ASR_LANGUAGE", "zh")
  };
}

export function getLocalPerceptionConfig() {
  return {
    pythonPath: optionalEnv("LOCAL_OCR_PYTHON", ""),
    maxImageSide: Number(optionalEnv("LOCAL_OCR_MAX_IMAGE_SIDE", "1600"))
  };
}
