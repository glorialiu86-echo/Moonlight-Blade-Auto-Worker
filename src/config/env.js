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
    apiKey: requireEnv("LLM_API_KEY")
  };
}

export function getLocalAsrConfig() {
  return {
    model: optionalEnv("LOCAL_ASR_MODEL", "medium"),
    language: optionalEnv("LOCAL_ASR_LANGUAGE", "zh"),
    device: optionalEnv("LOCAL_ASR_DEVICE", "cpu"),
    computeType: optionalEnv("LOCAL_ASR_COMPUTE_TYPE", "int8"),
    cpuThreads: Number(optionalEnv("LOCAL_ASR_CPU_THREADS", "4")),
    initialPrompt: optionalEnv(
      "LOCAL_ASR_INITIAL_PROMPT",
      "以下内容是简体中文普通话口语转写，可能涉及《天涯明月刀》的任务名、NPC 名称、地名和玩家口语，请尽量按发音准确转写。"
    ),
    pythonPath: optionalEnv("LOCAL_ASR_PYTHON", ""),
    modelCacheDir: optionalEnv("LOCAL_ASR_MODEL_CACHE_DIR", "")
  };
}
