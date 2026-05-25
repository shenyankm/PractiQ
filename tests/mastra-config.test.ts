import { describe, expect, test } from 'vitest';
import {
  resolveMastraProviderChain,
  resolveMastraProviderConfig
} from '@/lib/openwook/mastra-config';

describe('resolveMastraProviderConfig', () => {
  test('uses Kimi as the primary configured provider', () => {
    const config = resolveMastraProviderConfig({
      MOONSHOT_API_KEY: 'moonshot-key',
      DEEPSEEK_API_KEY: 'deepseek-key'
    });

    expect(config.providerName).toBe('moonshot');
    expect(config.apiKey).toBe('moonshot-key');
    expect(config.baseURL).toBe('https://api.moonshot.cn/v1');
    expect(config.modelName).toBe('kimi-k2.6');
    expect(config.temperature).toBe(1);
    expect(config.maxTokens).toBe(16384);
  });

  test('uses DeepSeek v4 flash as the fallback provider when Kimi is not configured', () => {
    const config = resolveMastraProviderConfig({
      DEEPSEEK_API_KEY: 'deepseek-key'
    });

    expect(config.providerName).toBe('deepseek');
    expect(config.apiKey).toBe('deepseek-key');
    expect(config.baseURL).toBe('https://api.deepseek.com');
    expect(config.modelName).toBe('deepseek-v4-flash');
    expect(config.temperature).toBe(0.2);
    expect(config.maxTokens).toBe(4096);
  });

  test('keeps explicit OpenAI-compatible configuration available after DeepSeek', () => {
    const config = resolveMastraProviderConfig({
      OPENAI_API_KEY: 'openai-key',
      OPENAI_BASE_URL: 'https://example.test/v1',
      OPENAI_MODEL: 'custom-model'
    });

    expect(config.providerName).toBe('openai');
    expect(config.apiKey).toBe('openai-key');
    expect(config.baseURL).toBe('https://example.test/v1');
    expect(config.modelName).toBe('custom-model');
  });

  test('builds a runtime fallback chain from Kimi to DeepSeek v4 flash', () => {
    const chain = resolveMastraProviderChain({
      MOONSHOT_API_KEY: 'moonshot-key',
      DEEPSEEK_API_KEY: 'deepseek-key'
    });

    expect(chain).toMatchObject([
      {
        providerName: 'moonshot',
        apiKey: 'moonshot-key',
        baseURL: 'https://api.moonshot.cn/v1',
        modelName: 'kimi-k2.6'
      },
      {
        providerName: 'deepseek',
        apiKey: 'deepseek-key',
        baseURL: 'https://api.deepseek.com',
        modelName: 'deepseek-v4-flash'
      }
    ]);
  });
});
