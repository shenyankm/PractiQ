export const REQUEST_BYTE_LIMIT = 16 * 1024 * 1024;

const SCALAR = 8;

/**
 * Bounds a renderer request without serializing it: strings count three bytes per UTF-16 unit
 * (the UTF-8 maximum), buffers count their real size and cycles count once. The walk stops as
 * soon as the limit is exceeded, so an oversized request is refused before anything is copied.
 */
export function requestBytes(value: unknown, limit = REQUEST_BYTE_LIMIT): number {
  const pending: unknown[] = [value], seen = new WeakSet<object>();
  let total = 0;
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string") total += current.length * 3;
    else if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) total += current.byteLength;
    else if (Array.isArray(current)) { if (seen.has(current)) continue; seen.add(current); total += SCALAR; for (const item of current) pending.push(item); }
    else if (current !== null && typeof current === "object") {
      if (seen.has(current)) continue;
      seen.add(current);
      // A structured clone may contain cycles; each object contributes its own fields once.
      for (const [key, item] of Object.entries(current)) { total += key.length * 3 + SCALAR; pending.push(item); }
    } else total += SCALAR;
    if (total > limit) return total;
  }
  return total;
}

export function withinRequestLimit(value: unknown, limit = REQUEST_BYTE_LIMIT): boolean {
  return requestBytes(value, limit) <= limit;
}
