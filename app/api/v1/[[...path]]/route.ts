import { requireUser } from '@/lib/openwook/auth';
import { ApiError, handleApiError, ok } from '@/lib/openwook/api';
import { withApiObservability } from '@/lib/openwook/observability';
import { exportUserSummaryPdf, search } from '@/lib/openwook/services';

type RouteContext = { params: Promise<{ path?: string[] }> };

export async function GET(request: Request, ctx: RouteContext) {
  return withApiObservability(request, '/api/v1/[[...path]]', async () => {
    try {
      const { path = [] } = await ctx.params;
      const user = await requireUser();

      if (path[0] === 'search' && path[1]) {
        return ok(await search(user, path[1], new URL(request.url).searchParams));
      }

      if (path.join('/') === 'exports/me/summary.pdf') {
        const pdfBytes = await exportUserSummaryPdf(user);
        return new Response(new Uint8Array(pdfBytes), {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="openwook-summary.pdf"',
            'Cache-Control': 'no-store'
          }
        });
      }

      throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
    } catch (error) {
      return handleApiError(error);
    }
  });
}
