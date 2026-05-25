type MastraProviderName = 'moonshot' | 'deepseek' | 'openai';

type MastraEnv = Record<string, string | undefined>;

export type MastraProviderConfig = {
  providerName: MastraProviderName;
  apiKey: string | undefined;
  baseURL: string;
  modelName: string;
  temperature: number;
  maxTokens: number;
};

const kimiBaseURL = 'https://api.moonshot.cn/v1';
const deepseekBaseURL = 'https://api.deepseek.com';

export function resolveMastraProviderConfig(env: MastraEnv = process.env): MastraProviderConfig {
  const providerName = resolveProviderName(env);
  return buildProviderConfig(env, providerName);
}

export function resolveMastraProviderChain(env: MastraEnv = process.env): MastraProviderConfig[] {
  return (['moonshot', 'deepseek', 'openai'] as const)
    .filter((providerName) => Boolean(resolveApiKey(env, providerName)))
    .map((providerName) => buildProviderConfig(env, providerName));
}

function resolveProviderName(env: MastraEnv): MastraProviderName {
  if (env.MOONSHOT_API_KEY) return 'moonshot';
  if (env.DEEPSEEK_API_KEY) return 'deepseek';
  return 'openai';
}

function resolveApiKey(env: MastraEnv, providerName: MastraProviderName) {
  if (providerName === 'moonshot') return env.MOONSHOT_API_KEY;
  if (providerName === 'deepseek') return env.DEEPSEEK_API_KEY;
  return env.OPENAI_API_KEY;
}

function resolveBaseURL(env: MastraEnv, providerName: MastraProviderName) {
  if (providerName === 'moonshot') return env.MOONSHOT_BASE_URL || kimiBaseURL;
  if (providerName === 'deepseek') return env.DEEPSEEK_BASE_URL || deepseekBaseURL;
  return env.OPENAI_BASE_URL || kimiBaseURL;
}

function resolveModelName(env: MastraEnv, providerName: MastraProviderName) {
  if (providerName === 'moonshot') return env.OPENAI_MODEL || 'kimi-k2.6';
  if (providerName === 'deepseek') return env.DEEPSEEK_MODEL || env.OPENAI_MODEL || 'deepseek-v4-flash';
  return env.OPENAI_MODEL || 'gpt-4o-mini';
}

function defaultTemperature(providerName: MastraProviderName) {
  return providerName === 'moonshot' ? '1.0' : '0.2';
}

function defaultMaxTokens(providerName: MastraProviderName) {
  return providerName === 'moonshot' ? '16384' : '4096';
}

function buildProviderConfig(env: MastraEnv, providerName: MastraProviderName): MastraProviderConfig {
  return {
    providerName,
    apiKey: resolveApiKey(env, providerName),
    baseURL: resolveBaseURL(env, providerName),
    modelName: env.MASTRA_MODEL || resolveModelName(env, providerName),
    temperature: Number(env.MASTRA_TEMPERATURE ?? defaultTemperature(providerName)),
    maxTokens: Number(env.MASTRA_MAX_TOKENS ?? defaultMaxTokens(providerName))
  };
}
