import { initializePaddle, type Paddle } from '@paddle/paddle-js';

export type PaddleEnvironment = 'sandbox' | 'production';

export type PaddleCheckoutSession = {
  transactionId: string;
  clientToken: string;
  environment: PaddleEnvironment;
};

const paddlePromiseBySessionKey = new Map<string, Promise<Paddle | undefined>>();

async function getPaddleInstance({ clientToken, environment }: Pick<PaddleCheckoutSession, 'clientToken' | 'environment'>) {
  const sessionKey = `${environment}:${clientToken}`;
  const existing = paddlePromiseBySessionKey.get(sessionKey);
  if (existing) return existing;

  const next = initializePaddle({
    token: clientToken,
    environment
  });
  paddlePromiseBySessionKey.set(sessionKey, next);
  return next;
}

export async function openPaddleCheckout(session: PaddleCheckoutSession) {
  const paddle = await getPaddleInstance(session);
  if (!paddle) {
    throw new Error('Paddle Checkout 初始化失败，请刷新后重试。');
  }

  paddle.Checkout.open({
    transactionId: session.transactionId
  });
}
