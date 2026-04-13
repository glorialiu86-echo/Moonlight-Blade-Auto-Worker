import { generateText } from "../src/llm/deepseek.js";

function parseArgs(argv) {
  const useReasoningModel = argv.includes("--reasoner");
  const prompt = argv.filter((arg) => !arg.startsWith("--")).join(" ").trim();

  return {
    useReasoningModel,
    prompt: prompt || "Reply with a one-line acknowledgement that the DeepSeek connection works."
  };
}

async function main() {
  const { useReasoningModel, prompt } = parseArgs(process.argv.slice(2));

  const result = await generateText({
    systemPrompt: "You are a concise assistant used for integration smoke tests.",
    userPrompt: prompt,
    useReasoningModel,
    maxTokens: 120,
    temperature: 0.2
  });

  console.log(JSON.stringify({
    model: result.model,
    finishReason: result.finishReason,
    usage: result.usage,
    text: result.text
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
