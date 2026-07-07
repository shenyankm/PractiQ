import { handleApiError } from '@/lib/openwook/api';
import { withApiObservability } from '@/lib/openwook/observability';

export function handleObservedRoute(
  request: Request,
  route: string,
  handler: () => Promise<Response> | Response
) {
  return withApiObservability(request, route, async () => {
    try {
      return await handler();
    } catch (error) {
      return handleApiError(error);
    }
  });
}

export function isMultipartFormRequest(request: Request) {
  return (request.headers.get('content-type') || '').includes('multipart/form-data');
}

export async function aiHandlers() {
  return import('@/lib/openwook/ai');
}

export async function objectStorageHandlers() {
  return import('@/lib/openwook/object-storage');
}

export type ImportChildKind = 'events' | 'pages' | 'blocks' | 'review-items' | 'outputs' | 'artifacts';

export function isImportChildKind(value: string | undefined): value is ImportChildKind {
  return value === 'events' || value === 'pages' || value === 'blocks' || value === 'review-items' || value === 'outputs' || value === 'artifacts';
}
