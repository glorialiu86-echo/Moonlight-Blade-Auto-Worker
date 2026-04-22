import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { getAliyunAsrConfig } from "../config/env.js";

function audioMimeType(audioPath) {
  const extension = extname(audioPath).toLowerCase();
  if (extension === ".mp3") {
    return "audio/mpeg";
  }
  if (extension === ".webm") {
    return "audio/webm";
  }
  if (extension === ".ogg") {
    return "audio/ogg";
  }
  return "audio/wav";
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (typeof item?.text === "string") {
          return item.text;
        }

        return "";
      })
      .join("")
      .trim();
  }

  return "";
}

export async function transcribeWithAliyunAsr({ audioPath }) {
  const config = getAliyunAsrConfig();

  if (!config.apiKey) {
    throw new Error("缺少阿里云 ASR API Key");
  }

  const fileBuffer = await readFile(audioPath);
  const base64 = fileBuffer.toString("base64");
  const dataUrl = `data:${audioMimeType(audioPath)};base64,${base64}`;

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: dataUrl,
                format: extname(audioPath).replace(".", "").toLowerCase() || "wav"
              }
            },
            {
              type: "text",
              text: "请把这段音频逐字转写成简体中文；如果听不清，就返回你能确认的内容，不要补充解释。"
            }
          ]
        }
      ],
      modalities: ["text"],
      stream: false,
      asr_options: {
        language: config.language,
        enable_itn: true
      }
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload.error?.message
      || payload.message
      || payload.code
      || "阿里云 ASR 请求失败"
    );
  }

  const text = extractTextContent(payload.choices?.[0]?.message?.content);
  return text;
}
