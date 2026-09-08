import type {
  AnalyticsSnapshot,
  ApiEnvelope,
  ApiErrorEnvelope,
  AuthPayload,
  Bank,
  BankPage,
  BankScope,
} from "./contracts";
import { MemorySessionStore } from "../auth/session";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface TransportRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: unknown;
}

export interface TransportResponse {
  status: number;
  data?: unknown;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface ApiRequestOptions {
  method?: HttpMethod;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ApiClientOptions {
  baseUrl: string;
  transport: Transport;
  session: MemorySessionStore;
  now?: () => number;
  onUnauthenticated?: () => void | Promise<void>;
  refreshLeewayMs?: number;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string | null,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly session: MemorySessionStore;
  private readonly now: () => number;
  private readonly onUnauthenticated: () => void | Promise<void>;
  private readonly refreshLeewayMs: number;
  private refreshPromise: Promise<string> | null = null;

  constructor(options: ApiClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/$/, "");
    if (!baseUrl) {
      throw new Error("TARO_APP_API_URL is required");
    }
    this.baseUrl = baseUrl;
    this.transport = options.transport;
    this.session = options.session;
    this.now = options.now ?? Date.now;
    this.onUnauthenticated = options.onUnauthenticated ?? (() => undefined);
    this.refreshLeewayMs = options.refreshLeewayMs ?? 30_000;
  }

  async loginWithCode(code: string): Promise<AuthPayload> {
    const payload = await this.send<AuthPayload>("/api/v1/auth/wechat-login", {
      method: "POST",
      body: { code },
    });
    this.session.replace(payload);
    return payload;
  }

  async getCurrentUser(): Promise<AuthPayload["user"]> {
    return this.request<AuthPayload["user"]>("/api/v1/auth/me");
  }

  async getAnalyticsSnapshot(): Promise<AnalyticsSnapshot> {
    return this.request<AnalyticsSnapshot>("/api/v1/analytics/me/snapshot");
  }

  async getBanks(scope: BankScope, cursor = "", limit = 30): Promise<BankPage> {
    const params = [`scope=${encodeURIComponent(scope)}`, `limit=${limit}`];
    if (cursor) {
      params.push(`cursor=${encodeURIComponent(cursor)}`);
    }
    const envelope = await this.requestEnvelope<Bank[]>(`/api/v1/banks?${params.join("&")}`);
    const pagination = envelope.meta?.pagination;
    if (!pagination) {
      throw new ApiClientError(0, "INVALID_RESPONSE", "题库分页响应缺少 pagination");
    }
    return { items: envelope.data, pagination };
  }

  async logout(): Promise<void> {
    const current = this.session.getSnapshot();
    try {
      if (current) {
        await this.send<void>(
          "/api/v1/auth/logout",
          { method: "POST" },
          current.tokens.accessToken,
        );
      }
    } catch {
      // Logout is intentionally best effort; local state is always authoritative here.
    } finally {
      await this.invalidateSession();
    }
  }

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const envelope = await this.requestEnvelope<T>(path, options);
    return envelope.data;
  }

  async requestEnvelope<T>(
    path: string,
    options: ApiRequestOptions = {},
  ): Promise<ApiEnvelope<T>> {
    let accessToken = await this.freshAccessToken();
    let response = await this.perform(path, options, accessToken);

    if (response.status === 401) {
      accessToken = await this.refreshAccessToken();
      response = await this.perform(path, options, accessToken);
      if (response.status === 401) {
        await this.invalidateSession();
      }
    }

    const error = this.errorFrom(response);
    if (error) {
      if (response.status === 403 && error.code === "USER_INACTIVE") {
        await this.invalidateSession();
      }
      throw error;
    }

    return this.envelope<T>(response);
  }

  async accessToken(): Promise<string> {
    return this.freshAccessToken();
  }

  private async freshAccessToken(): Promise<string> {
    const current = this.session.getSnapshot();
    if (!current) {
      throw new ApiClientError(401, "UNAUTHENTICATED", "请先登录");
    }
    const expiresAt = Date.parse(current.tokens.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt - this.now() <= this.refreshLeewayMs) {
      return this.refreshAccessToken();
    }
    return current.tokens.accessToken;
  }

  private async refreshAccessToken(): Promise<string> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    const pending = (async () => {
      const current = this.session.getSnapshot();
      const refreshExpiresAt = current ? Date.parse(current.tokens.refreshExpiresAt) : Number.NaN;
      if (!current || !Number.isFinite(refreshExpiresAt) || refreshExpiresAt <= this.now()) {
        await this.invalidateSession();
        throw new ApiClientError(401, "INVALID_REFRESH_TOKEN", "登录已过期，请重新登录");
      }
      try {
        const payload = await this.send<AuthPayload>("/api/v1/auth/refresh", {
          method: "POST",
          body: { refreshToken: current.tokens.refreshToken },
        });
        return this.session.replace(payload).tokens.accessToken;
      } catch (error) {
        await this.invalidateSession();
        throw error;
      }
    })();

    this.refreshPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshPromise === pending) {
        this.refreshPromise = null;
      }
    }
  }

  private async invalidateSession(): Promise<void> {
    const hadSession = this.session.getSnapshot() !== null;
    this.session.clear();
    if (hadSession) {
      await this.onUnauthenticated();
    }
  }

  private async send<T>(
    path: string,
    options: ApiRequestOptions,
    accessToken?: string,
  ): Promise<T> {
    const response = await this.perform(path, options, accessToken);
    const error = this.errorFrom(response);
    if (error) {
      throw error;
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return this.envelope<T>(response).data;
  }

  private async perform(
    path: string,
    options: ApiRequestOptions,
    accessToken?: string,
  ): Promise<TransportResponse> {
    const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    try {
      return await this.transport({
        url: `${this.baseUrl}${path}`,
        method: options.method ?? "GET",
        headers,
        body: options.body,
      });
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError(0, "NETWORK_ERROR", "网络连接失败，请稍后重试", error);
    }
  }

  private envelope<T>(response: TransportResponse): ApiEnvelope<T> {
    const value = response.data;
    if (!value || typeof value !== "object" || !("data" in value)) {
      throw new ApiClientError(response.status, "INVALID_RESPONSE", "服务响应格式不正确");
    }
    return value as ApiEnvelope<T>;
  }

  private errorFrom(response: TransportResponse): ApiClientError | null {
    if (response.status >= 200 && response.status < 300) {
      return null;
    }
    const value = response.data as Partial<ApiErrorEnvelope> | undefined;
    const error = value?.error;
    return new ApiClientError(
      response.status,
      error?.code ?? "HTTP_ERROR",
      error?.message ?? "请求失败，请稍后重试",
      error?.details,
      error?.requestId,
    );
  }
}
