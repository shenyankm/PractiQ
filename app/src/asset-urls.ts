import { api } from "./api";

// Share only mounted consumers; no idle cache survives a preview/session change.
const active = new Map<string, { users: number; url: Promise<string> }>();
export function acquireAsset(hash: string, mediaType?: string) {
  const key = `${hash}:${mediaType || ""}`;
  let entry = active.get(key);
  if (!entry) {
    entry = {users:0, url:api({type:"asset",hash}).then(bytes => URL.createObjectURL(new Blob([bytes], {type:mediaType})))};
    active.set(key, entry);
    const current = entry;
    void entry.url.catch(() => { if (active.get(key) === current) active.delete(key); });
  }
  entry.users++;
  let released = false;
  return {url:entry.url, release:() => {
    if (released) return;
    released = true;
    if (--entry.users === 0) {
      if (active.get(key) === entry) active.delete(key);
      void entry.url.then(url => URL.revokeObjectURL(url)).catch(() => {});
    }
  }};
}
