import 'server-only';

import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createOpenAI } from '@ai-sdk/openai';

type ProviderOptions = Record<string, Record<string, string | number | boolean | null | ProviderJsonObject>>;
type ProviderJsonObject = { [key: string]: string | number | boolean | null | ProviderJsonObject };

const kimiBaseURL = 'https://api.moonshot.cn/v1';
const apiKey = process.env.MOONSHOT_API_KEY || process.env.OPENAI_API_KEY;
const baseURL = process.env.MOONSHOT_BASE_URL || process.env.OPENAI_BASE_URL || kimiBaseURL;
const providerName = baseURL.includes('moonshot.cn') ? 'moonshot' : 'openai';
const modelName = process.env.MASTRA_MODEL || process.env.OPENAI_MODEL || (providerName === 'moonshot' ? 'kimi-k2.6' : 'gpt-4o-mini');
const temperature = Number(process.env.MASTRA_TEMPERATURE ?? (providerName === 'moonshot' ? '1.0' : '0.2'));
const maxTokens = Number(process.env.MASTRA_MAX_TOKENS ?? (providerName === 'moonshot' ? '16384' : '4096'));
const thinkingType = process.env.KIMI_THINKING_TYPE || (process.env.KIMI_THINKING_ENABLED === 'false' ? 'disabled' : 'enabled');
const thinkingKeep = process.env.KIMI_THINKING_KEEP;
const openaiCompatible = createOpenAI({
  name: providerName,
  apiKey,
  baseURL,
  headers: {
    'User-Agent': 'openwook-mastra/1.0'
  },
  fetch: providerName === 'moonshot' ? moonshotFetch : undefined
});
const model = openaiCompatible.chat(modelName);

export const kimiThinkingOptions = {
  type: thinkingType,
  ...(thinkingKeep ? { keep: thinkingKeep } : {})
};

export const mastraModelSettings = {
  temperature,
  maxTokens
};

export const mastraProviderOptions: ProviderOptions = {
  openai: {
    strictJsonSchema: false
  }
};

export const documentParserAgent = new Agent({
  id: 'openwook-document-parser',
  name: 'OpenWook Document Parser',
  instructions: [
    'You parse educational question source documents for OpenWook.',
    'Extract standalone and grouped questions from docx/txt-derived text.',
    'Preserve formulas, chemical equations, tables, charts, and image references as structured content blocks.',
    'Return only schema-valid structured output. Do not invent facts that are absent from the source.'
  ].join('\n'),
  model
});

export const answerGeneratorAgent = new Agent({
  id: 'openwook-answer-generator',
  name: 'OpenWook Answer Generator',
  instructions: [
    'You generate standard educational answers for OpenWook questions.',
    'Provide a concise canonical answer, detailed solving steps, and explanation.',
    'For uncertain or underspecified questions, mark confidence below 0.7 and explain the uncertainty.',
    'Return only schema-valid structured output.'
  ].join('\n'),
  model
});

export const learningReportAgent = new Agent({
  id: 'openwook-learning-report',
  name: 'OpenWook Learning Report Agent',
  instructions: [
    'You analyze OpenWook practice data for students and classes.',
    'Identify knowledge mastery, weak spots, patterns in mistakes, and actionable study recommendations.',
    'Keep reports factual and grounded in the provided answer statistics.',
    'Return only schema-valid structured output.'
  ].join('\n'),
  model
});

export const mastra = new Mastra({
  agents: {
    documentParserAgent,
    answerGeneratorAgent,
    learningReportAgent
  }
});

export function isMastraModelConfigured() {
  return Boolean(apiKey);
}

export function getMastraModelName() {
  return modelName;
}

export function getMastraProviderName() {
  return providerName;
}

export function getMastraBaseURL() {
  return baseURL;
}

async function moonshotFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (!init?.body) return fetch(input, init);
  const contentType = headerValue(init.headers, 'content-type');
  if (contentType && !contentType.includes('application/json')) return fetch(input, init);
  if (typeof init.body !== 'string') return fetch(input, init);

  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (!body.thinking) body.thinking = kimiThinkingOptions;
    return fetch(input, {
      ...init,
      body: JSON.stringify(body)
    });
  } catch {
    return fetch(input, init);
  }
}

function headerValue(headers: HeadersInit | undefined, name: string) {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name);
    return found?.[1] ?? null;
  }
  const foundKey = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return foundKey ? headers[foundKey] ?? null : null;
}
