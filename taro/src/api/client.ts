import type {
  AnalyticsSnapshot,
  ApiEnvelope,
  ApiErrorEnvelope,
  AuthPayload,
  Bank,
  BankPage,
  BankScope,
  Pagination,
} from "./contracts";
import type { ImageDownload } from "../media/download";
import { WriteAttempts } from "./write-attempts";
import { MemorySessionStore } from "../auth/session";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface TransportRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: unknown;
  uploadFilePath?: string;
  download?: ImageDownload;
}

export interface TransportResponse {
  status: number;
  data?: unknown;
}

export type Transport = (
  request: TransportRequest,
) => Promise<TransportResponse>;

export interface ApiRequestOptions {
  method?: HttpMethod;
  body?: unknown;
  uploadFilePath?: string;
  download?: ImageDownload;
  headers?: Record<string, string>;
}

export interface ApiClientOptions {
  baseUrl: string;
  transport: Transport;
  session: MemorySessionStore;
  now?: () => number;
  onUnauthenticated?: () => void | Promise<void>;
  refreshLeewayMs?: number;
  readEpoch?: () => number;
  onAccessFailure?: (kind: "permission" | "offline" | "revalidate") => void;
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

export function isRetryableWriteError(error: unknown): boolean {
  return (
    !(error instanceof ApiClientError) ||
    error.status === 0 ||
    error.status >= 500 ||
    error.code === "REQUEST_IN_PROGRESS" ||
    error.code === "INVALID_RESPONSE"
  );
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly session: MemorySessionStore;
  private readonly now: () => number;
  private readonly onUnauthenticated: () => void | Promise<void>;
  private readonly refreshLeewayMs: number;
  private readonly attempts: WriteAttempts;
  private readonly readEpoch: () => number;
  private readonly onAccessFailure: NonNullable<
    ApiClientOptions["onAccessFailure"]
  >;
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
    this.attempts = new WriteAttempts(this.now);
    this.readEpoch = options.readEpoch ?? (() => 0);
    this.onAccessFailure = options.onAccessFailure ?? (() => undefined);
    this.session.onReset(() => {
      this.attempts.clear();
      this.refreshPromise = null;
    });
    this.refreshLeewayMs = options.refreshLeewayMs ?? 30_000;
  }

  scoped(generation: number): ApiClient {
    return new Proxy(this, {
      get: (target, property) => {
        const member: unknown = Reflect.get(target, property);
        if (typeof member !== "function") return member;
        return async (...args: unknown[]) => {
          this.assertGeneration(generation);
          const result: unknown = await member.apply(target, args);
          if (property !== "logout") this.assertGeneration(generation);
          return result;
        };
      },
    });
  }

  async loginWithCode(code: string): Promise<AuthPayload> {
    this.session.clear();
    const generation = this.session.getGeneration();
    const payload = await this.send<AuthPayload>("/api/v1/auth/wechat-login", {
      method: "POST",
      body: { code },
    });
    this.assertGeneration(generation);
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
    return this.requestPage<Bank>(`/api/v1/banks?${params.join("&")}`);
  }

  async requestPage<T>(
    path: string,
  ): Promise<{ items: T[]; pagination: Pagination }> {
    const generation = this.session.getGeneration();
    const epoch = this.readEpoch();
    const envelope = await this.requestEnvelope<T[]>(path);
    this.assertGeneration(generation);
    if (epoch !== this.readEpoch())
      throw new ApiClientError(0, "STALE_RESPONSE", "页面已失效，请重新加载");
    const pagination = envelope.meta?.pagination;
    if (!pagination || !Array.isArray(envelope.data)) {
      this.onAccessFailure("offline");
      throw new ApiClientError(0, "INVALID_RESPONSE", "分页响应格式不正确");
    }
    return { items: envelope.data, pagination };
  }

  async logout(): Promise<void> {
    const current = this.session.getSnapshot();
    await this.invalidateSession();
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
    // Snapshot the body before the first await: internal refresh and user retries send identical bytes.
    const snapshot = {
      ...options,
      headers: { ...options.headers },
      body:
        options.body === undefined
          ? undefined
          : (JSON.parse(JSON.stringify(options.body)) as unknown),
    };
    const method = snapshot.method ?? "GET";
    const generation = this.session.getGeneration();
    const epoch = this.readEpoch();
    const execute = (key?: string) =>
      this.authenticated<T>(
        path,
        key
          ? {
              ...snapshot,
              headers: { ...snapshot.headers, "Idempotency-Key": key },
            }
          : snapshot,
        generation,
        epoch,
      );
    const replayable =
      method !== "GET" &&
      !path.startsWith("/api/v1/auth/") &&
      !/\/payment-orders\/[^/]+\/refund$/.test(path);
    if (!replayable) return execute();
    const identity = JSON.stringify([
      generation,
      this.session.getSnapshot()?.user.id,
      method,
      path,
      snapshot.body,
      snapshot.uploadFilePath,
      snapshot.headers,
    ]);
    return this.attempts.run(
      identity,
      path === "/api/v1/payment-orders" ? 30 * 60_000 : 24 * 60 * 60_000,
      execute,
      isRetryableWriteError,
      snapshot.headers["Idempotency-Key"],
    );
  }

  downloadMedia(
    id: number,
    download: ImageDownload,
  ): Promise<{ tempFilePath: string }> {
    if (!Number.isSafeInteger(id) || id < 1)
      return Promise.reject(
        new ApiClientError(422, "INVALID_MEDIA", "媒体参数无效"),
      );
    return this.request(`/api/v1/media/${id}/content`, { download });
  }

  upload<T>(path: string, filePath: string, key?: string): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      uploadFilePath: filePath,
      headers: key ? { "Idempotency-Key": key } : undefined,
    });
  }

  async forgetWriteKeys(keys: string[]): Promise<void> {
    this.attempts.forget(keys);
  }

  private async authenticated<T>(
    path: string,
    options: ApiRequestOptions,
    generation: number,
    epoch: number,
  ): Promise<ApiEnvelope<T>> {
    const read = (options.method ?? "GET") === "GET";
    try {
      let accessToken = await this.freshAccessToken();
      this.assertGeneration(generation);
      let response = await this.perform(path, options, accessToken);
      this.assertGeneration(generation);
      if (read && epoch !== this.readEpoch())
        throw new ApiClientError(0, "STALE_RESPONSE", "页面已失效，请重新加载");
      if (response.status === 401) {
        accessToken = await this.refreshAccessToken();
        this.assertGeneration(generation);
        response = await this.perform(path, options, accessToken);
        this.assertGeneration(generation);
        if (response.status === 401) await this.invalidateSession();
      }
      const error = this.errorFrom(response);
      if (error) {
        if (response.status === 403 && error.code === "USER_INACTIVE")
          await this.invalidateSession();
        throw error;
      }
      if (read && epoch !== this.readEpoch())
        throw new ApiClientError(0, "STALE_RESPONSE", "页面已失效，请重新加载");
      if (
        !read &&
        (options.method === "DELETE" ||
          /\/study-groups\/\d+\/leave$/.test(path) ||
          /\/admin\/banks\/\d+\/ban$/.test(path))
      )
        this.onAccessFailure("revalidate");
      return response.status === 204
        ? { data: undefined as T }
        : this.envelope<T>(response);
    } catch (error) {
      if (
        generation === this.session.getGeneration() &&
        epoch === this.readEpoch() &&
        error instanceof ApiClientError &&
        error.code !== "STALE_RESPONSE"
      ) {
        if (
          error.status === 0 ||
          (read &&
            error.status !== 403 &&
            error.status !== 404 &&
            error.status !== 401)
        )
          this.onAccessFailure("offline");
        else if (error.status === 403 || error.status === 404)
          this.onAccessFailure(read ? "permission" : "revalidate");
      }
      throw error;
    }
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.session.getGeneration())
      throw new ApiClientError(0, "STALE_RESPONSE", "账号已变化，请重新操作");
  }

  async accessToken(): Promise<string> {
    return this.freshAccessToken();
  }

  private async freshAccessToken(): Promise<string> {
    const current = this.session.getSnapshot();
    if (!current) {
      await this.onUnauthenticated();
      throw new ApiClientError(401, "UNAUTHENTICATED", "请先登录");
    }
    const expiresAt = Date.parse(current.tokens.expiresAt);
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt - this.now() <= this.refreshLeewayMs
    ) {
      return this.refreshAccessToken();
    }
    return current.tokens.accessToken;
  }

  private async refreshAccessToken(): Promise<string> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    const generation = this.session.getGeneration();
    const pending = (async () => {
      const current = this.session.getSnapshot();
      const refreshExpiresAt = current
        ? Date.parse(current.tokens.refreshExpiresAt)
        : Number.NaN;
      if (
        !current ||
        !Number.isFinite(refreshExpiresAt) ||
        refreshExpiresAt <= this.now()
      ) {
        await this.invalidateSession();
        throw new ApiClientError(
          401,
          "INVALID_REFRESH_TOKEN",
          "登录已过期，请重新登录",
        );
      }
      try {
        const payload = await this.send<AuthPayload>("/api/v1/auth/refresh", {
          method: "POST",
          body: { refreshToken: current.tokens.refreshToken },
        });
        this.assertGeneration(generation);
        return this.session.rotate(payload).tokens.accessToken;
      } catch (error) {
        if (generation === this.session.getGeneration())
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
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
    };
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
        ...(options.download ? { download: options.download } : {}),
        ...(options.uploadFilePath
          ? { uploadFilePath: options.uploadFilePath }
          : {}),
      });
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError(
        0,
        "NETWORK_ERROR",
        "网络连接失败，请稍后重试",
        error,
      );
    }
  }

  private envelope<T>(response: TransportResponse): ApiEnvelope<T> {
    const value = response.data;
    if (!value || typeof value !== "object" || !("data" in value)) {
      throw new ApiClientError(
        response.status,
        "INVALID_RESPONSE",
        "服务响应格式不正确",
      );
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
