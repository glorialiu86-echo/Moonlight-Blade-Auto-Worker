function requireEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getLlmConfig() {
  const provider = requireEnv("LLM_PROVIDER");

  if (provider !== "deepseek") {
    throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  }

  return {
    provider,
    baseUrl: requireEnv("LLM_BASE_URL").replace(/\/+$/, ""),
    model: requireEnv("LLM_MODEL"),
    reasoningModel: requireEnv("LLM_REASONING_MODEL"),
    apiKey: requireEnv("LLM_API_KEY")
  };
}
