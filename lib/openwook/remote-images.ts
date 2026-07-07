import { env } from './env';

export function isConfiguredRemoteImageUrl(value: string | null) {
  if (!value) return false;

  try {
    const origin = new URL(value).origin;
    return [env.NEXT_PUBLIC_APP_URL, env.OSS_PUBLIC_BASE_URL, env.OBJECT_STORAGE_PUBLIC_BASE_URL]
      .filter((candidate): candidate is string => Boolean(candidate))
      .some((candidate) => new URL(candidate).origin === origin);
  } catch {
    return false;
  }
}
