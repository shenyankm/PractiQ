import { ApiClient, ApiClientError } from "../api/client";
import type { AuthPayload } from "../api/contracts";

export interface WeChatLoginProvider {
  login(): Promise<{ code?: string }>;
}

export async function loginWithWeChat(
  client: ApiClient,
  provider: WeChatLoginProvider,
): Promise<AuthPayload> {
  let result: { code?: string };
  try {
    result = await provider.login();
  } catch (error) {
    throw new ApiClientError(0, "WECHAT_LOGIN_FAILED", "未能获取微信登录凭证，请重试", error);
  }
  const code = result.code?.trim();
  if (!code) {
    throw new ApiClientError(0, "WECHAT_LOGIN_FAILED", "微信未返回有效登录凭证，请重试");
  }
  return client.loginWithCode(code);
}
