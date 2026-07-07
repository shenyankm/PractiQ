import 'server-only';

import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createOpenAI } from '@ai-sdk/openai';
import { env } from './env';
import {
  type MastraProviderConfig,
  resolveMastraProviderChain,
  resolveMastraProviderConfig
} from './mastra-config';

type ProviderOptions = Record<string, Record<string, string | number | boolean | null | ProviderJsonObject>>;
type ProviderJsonObject = { [key: string]: string | number | boolean | null | ProviderJsonObject };

const {
  providerName,
  apiKey,
  baseURL,
  modelName,
  temperature,
  maxTokens
} = resolveMastraProviderConfig();
const providerChain = resolveMastraProviderChain();
const thinkingType = env.KIMI_THINKING_TYPE || (env.KIMI_THINKING_ENABLED === 'false' ? 'disabled' : 'enabled');
const thinkingKeep = env.KIMI_THINKING_KEEP;

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

export type MastraAgentSet = ReturnType<typeof buildMastraAgents>;

export const mastraPrimaryAgents = buildMastraAgents({
  providerName,
  apiKey,
  baseURL,
  modelName,
  temperature,
  maxTokens
});

export const mastraAgentFallbacks = providerChain
  .filter((config) => config.providerName !== providerName)
  .map((config) => ({
    config,
    agents: buildMastraAgents(config)
  }));

export const documentParserAgent = mastraPrimaryAgents.documentParserAgent;
export const answerGeneratorAgent = mastraPrimaryAgents.answerGeneratorAgent;
export const learningReportAgent = mastraPrimaryAgents.learningReportAgent;

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

export function getMastraProviderChain() {
  return providerChain.map((config) => ({
    providerName: config.providerName,
    modelName: config.modelName,
    baseURL: config.baseURL
  }));
}

function buildMastraAgents(config: MastraProviderConfig) {
  const openaiCompatible = createOpenAI({
    name: config.providerName,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    headers: {
      'User-Agent': 'openwook-mastra/1.0'
    },
    fetch: config.providerName === 'moonshot' ? moonshotFetch : undefined
  });
  const model = openaiCompatible.chat(config.modelName);

  return {
    documentParserAgent: new Agent({
      id: `openwook-document-parser-${config.providerName}`,
      name: 'OpenWook Document Parser',
      instructions: [
        'You parse educational question source documents for OpenWook.',
        'Extract standalone and grouped questions from docx/txt-derived text.',
        'Preserve formulas, chemical equations, tables, charts, and image references as structured content blocks.',
        'Return only schema-valid structured output. Do not invent facts that are absent from the source.'
      ].join('\n'),
      model
    }),
    answerGeneratorAgent: new Agent({
      id: `openwook-answer-generator-${config.providerName}`,
      name: 'OpenWook Answer Generator',
      instructions: [
        'You generate standard educational answers for OpenWook questions.',
        'Provide a concise canonical answer, detailed solving steps, and explanation.',
        'For uncertain or underspecified questions, mark confidence below 0.7 and explain the uncertainty.',
        'Return only schema-valid structured output.'
      ].join('\n'),
      model
    }),
    learningReportAgent: new Agent({
      id: `openwook-learning-report-${config.providerName}`,
      name: 'OpenWook Learning Report Agent',
      instructions: [
        'You analyze OpenWook practice data for students and classes.',
        'Identify knowledge mastery, weak spots, patterns in mistakes, and actionable study recommendations.',
        'Keep reports factual and grounded in the provided answer statistics.',
        'Return only schema-valid structured output.'
      ].join('\n'),
      model
    })
  };
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
