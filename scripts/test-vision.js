import "../src/config/load-env.js";
import { analyzeImage } from "../src/llm/qwen.js";

function parseArgs(argv) {
  const imageInput = argv.find((arg) => !arg.startsWith("--"));

  if (!imageInput) {
    throw new Error("Usage: npm run llm:test:vision -- <image-url-or-path>");
  }

  return { imageInput };
}

async function main() {
  const { imageInput } = parseArgs(process.argv.slice(2));

  const result = await analyzeImage({
    imageInput,
    prompt: "请用中文简洁描述这张图片中的主要场景、显眼文字和可交互元素。",
    maxTokens: 220
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
