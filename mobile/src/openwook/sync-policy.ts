export function shouldFailPermanently(status: number) {
  return status >= 400 && status < 500 && ![401, 408, 409, 425, 429].includes(status);
}

export function shouldQueueAfterFailure(status: number, code = '') {
  return status === 0 || status >= 500 || [408, 425, 429].includes(status) || code === 'REQUEST_IN_PROGRESS';
}
