export type AccessEvent =
  | "permission"
  | "offline"
  | "revalidate"
  | "suspend"
  | "session";

// No content cache: this bus only invalidates visibility and outstanding reads.
export class ViewAccess {
  private epoch = 0;
  private readonly listeners = new Set<(event: AccessEvent) => void>();
  readonly readEpoch = (): number => this.epoch;
  subscribe(listener: (event: AccessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  invalidate(event: AccessEvent): void {
    this.epoch += 1;
    for (const listener of this.listeners) listener(event);
  }
}
export const viewAccess = new ViewAccess();

// Hiding retains same-account form input, but never grants visibility on its own.
export class PageValidation {
  private ticket = 0;
  private allowed = false;
  hide(): void {
    this.ticket += 1;
    this.allowed = false;
  }
  get visible(): boolean {
    return this.allowed;
  }
  async validate(
    load: () => Promise<void>,
    stillCurrent: () => boolean,
  ): Promise<boolean> {
    const ticket = ++this.ticket;
    this.allowed = false;
    try {
      await load();
    } catch {
      return false;
    }
    if (ticket === this.ticket && stillCurrent()) this.allowed = true;
    return this.allowed;
  }
}
