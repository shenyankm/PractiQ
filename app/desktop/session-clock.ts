/** libuv 1.51 uses mach_continuous_time on macOS, including system sleep. */
export class SessionClock {
  private anchor?: { wall: number; tick: bigint };
  constructor(private readonly reading = () => ({ wall: Date.now(), tick: process.hrtime.bigint() / 1_000_000n })) {}
  get started(): boolean { return this.anchor !== undefined; }
  now(): number { return this.atLeast(0); }
  atLeast(saved: number): number {
    const current = this.reading();
    this.anchor ??= { wall: Math.max(current.wall, saved), tick: current.tick };
    const elapsed = current.tick > this.anchor.tick ? current.tick - this.anchor.tick : 0n;
    return Math.min(Number.MAX_SAFE_INTEGER, this.anchor.wall + Number(elapsed));
  }
}
