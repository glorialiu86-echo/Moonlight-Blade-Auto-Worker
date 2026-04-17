import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getAliyunAsrConfig } from "../config/env.js";

export async function transcribeWithAliyunAsr({ audioPath }) {
  const config = getAliyunAsrConfig();

  if (!config.apiKey) {
    throw new Error("缺少阿里云 ASR API Key");
  }

  const fileBuffer = await readFile(audioPath);
  const formData = new FormData();
  formData.append("model", config.model);
  formData.append("language", config.language);
  formData.append("file", new Blob([fileBuffer], { type: "audio/wav" }), basename(audioPath));

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    },
    body: formData
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.message || "阿里云 ASR 请求失败");
  }

  const text = String(
    payload.text
      || payload.transcript
      || payload.result?.text
      || payload.data?.text
      || ""
  ).trim();

  return text;
}
