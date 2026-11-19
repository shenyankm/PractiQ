export interface WindowBounds { x: number; y: number; width: number; height: number }
export interface WorkArea { x: number; y: number; width: number; height: number }
export interface WindowState { width: number; height: number; x?: number; y?: number; maximized: boolean }

export const WINDOW_MINIMUM = { width: 1024, height: 700 } as const;
const MAXIMUM = 16384, REACHABLE = 96;

const reachable = (frame: WindowBounds, area: WorkArea): boolean =>
  Math.min(frame.x + frame.width, area.x + area.width) - Math.max(frame.x, area.x) >= REACHABLE &&
  Math.min(frame.y + frame.height, area.y + area.height) - Math.max(frame.y, area.y) >= REACHABLE;

/** Reads a saved window state only while its size is supported and its frame is still reachable on a display. */
export function parseWindowState(raw: unknown, areas: WorkArea[]): WindowState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>, candidate = value.bounds;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const frame = candidate as Record<string, unknown>, fields = [frame.x, frame.y, frame.width, frame.height];
  if (!fields.every(field => Number.isSafeInteger(field))) return null;
  const [x, y, width, height] = fields as number[];
  if (width < WINDOW_MINIMUM.width || height < WINDOW_MINIMUM.height || width > MAXIMUM || height > MAXIMUM) return null;
  const maximized = value.maximized === true, bounds = { x, y, width, height };
  // A vanished or rearranged display must not leave an off-screen window; the supported size is retained.
  return areas.some(area => reachable(bounds, area)) ? { ...bounds, maximized } : { width, height, maximized };
}

export function serializeWindowState(bounds: WindowBounds, maximized: boolean): { bounds: WindowBounds; maximized: boolean } {
  return { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, maximized: maximized === true };
}
