export function extractJsonObject(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Expected text response when extracting JSON");
  }

  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in LLM response");
  }

  return text.slice(start, end + 1);
}
