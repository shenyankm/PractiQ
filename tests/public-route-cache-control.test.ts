import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getSubjects } from '@/app/api/v1/subjects/route';
import { GET as getQuestionTypes } from '@/app/api/v1/question-types/route';
import { GET as getKnowledgePoints } from '@/app/api/v1/knowledge-points/route';
import { GET as getCurrentUserRoute } from '@/app/api/v1/auth/me/route';

const PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=60';

const services = vi.hoisted(() => ({
  listKnowledgePoints: vi.fn(),
  listQuestionTypes: vi.fn(),
  listSubjects: vi.fn(),
  createKnowledgePoint: vi.fn()
}));

const auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  requireUser: vi.fn()
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: async (_name: string, callback: (span: {
        setAttributes: (attributes: Record<string, unknown>) => void;
        setAttribute: (name: string, value: unknown) => void;
        recordException: (error: Error) => void;
        end: () => void;
      }) => Promise<Response> | Response) => callback({
        setAttributes: () => {},
        setAttribute: () => {},
        recordException: () => {},
        end: () => {}
      })
    })
  }
}));

vi.mock('@/lib/openwook/logger', () => ({
  childLogger: () => ({ info: vi.fn() })
}));

vi.mock('@/lib/openwook/metrics', () => ({
  recordHttpRequest: vi.fn()
}));

vi.mock('@/lib/openwook/services', () => ({
  createKnowledgePoint: services.createKnowledgePoint,
  listKnowledgePoints: services.listKnowledgePoints,
  listQuestionTypes: services.listQuestionTypes,
  listSubjects: services.listSubjects
}));

vi.mock('@/lib/openwook/auth', () => ({
  getCurrentUser: auth.getCurrentUser,
  requireUser: auth.requireUser
}));

describe('route cache-control headers', () => {
  beforeEach(() => {
    services.listSubjects.mockReset();
    services.listQuestionTypes.mockReset();
    services.listKnowledgePoints.mockReset();
    auth.getCurrentUser.mockReset();

    services.listSubjects.mockResolvedValue([{ subject_id: 'math', display_name: 'Math' }]);
    services.listQuestionTypes.mockResolvedValue([{ code: 'single_choice', label: 'Single choice' }]);
    services.listKnowledgePoints.mockResolvedValue([{ id: 1, display_name: 'Fractions' }]);
    auth.getCurrentUser.mockResolvedValue({ id: 7, username: 'tester' });
  });

  it.each([
    ['subjects', () => getSubjects(new Request('https://example.com/api/v1/subjects'))],
    ['question types', () => getQuestionTypes(new Request('https://example.com/api/v1/question-types?subject=math&scope=public'))],
    ['knowledge points', () => getKnowledgePoints(new Request('https://example.com/api/v1/knowledge-points?subject=math&parentId=9'))]
  ])('sets the public shared-cache policy for %s', async (_label, run) => {
    const response = await run();

    expect(response.headers.get('Cache-Control')).toBe(PUBLIC_CACHE_CONTROL);
  });

  it('keeps no-store on the authenticated current-user route', async () => {
    const response = await getCurrentUserRoute(new Request('https://example.com/api/v1/auth/me'));

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
