import { ApiClientError } from "./client";

export function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.message;
  }
  return "发生了意外错误，请稍后重试";
}
