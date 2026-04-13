import "../src/config/load-env.js";
import { extractTextFromImage } from "../src/llm/qwen.js";

function parseArgs(argv) {
  const imageInput = argv.find((arg) => !arg.startsWith("--"));

  if (!imageInput) {
    throw new Error("Usage: npm run llm:test:ocr -- <image-url-or-path>");
  }

  return { imageInput };
}

async function main() {
  const { imageInput } = parseArgs(process.argv.slice(2));

  const result = await extractTextFromImage({
    imageInput
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
