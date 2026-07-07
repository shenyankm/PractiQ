import { z } from 'zod';

const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().optional(),
  OBJECT_STORAGE_PUBLIC_BASE_URL: z.string().optional(),
  OSS_PUBLIC_BASE_URL: z.string().optional()
}).passthrough();

type PublicEnv = z.infer<typeof publicEnvSchema>;

export const publicEnv = new Proxy({} as PublicEnv, {
  get(_target, property) {
    return publicEnvSchema.parse(process.env)[property as keyof PublicEnv];
  }
});
