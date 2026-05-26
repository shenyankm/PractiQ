import { registerOTel } from '@vercel/otel';
import { type Instrumentation } from 'next';
import { errorToLog, logger } from '@/lib/openwook/logger';

export function register() {
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME || 'openwook'
  });
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  logger.error(
    {
      ...errorToLog(error),
      path: request.path,
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      routerKind: context.routerKind
    },
    'next request error'
  );
};
