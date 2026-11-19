export interface CloseRequestSource {
  /** The renderer confirmed the draft-save request through the `practiq:close` channel. */
  approved: boolean;
  /** The renderer process is gone and cannot answer. */
  crashed: boolean;
  /** A static failure page replaced the renderer, so no close listener exists. */
  fallback: boolean;
}

/**
 * Only a live renderer can confirm the draft-save request. A crashed process and the script-free
 * failure page have no listener at all, so requiring approval from them would make the window and a
 * normal quit impossible to complete.
 */
export function needsRendererApproval({ approved, crashed, fallback }: CloseRequestSource): boolean {
  return !approved && !crashed && !fallback;
}
