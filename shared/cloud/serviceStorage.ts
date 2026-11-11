import { nativeBridge } from "./transport";

export function storageScope() { return `.personal-v1.service.${encodeURIComponent(nativeBridge()?.origin ?? location.origin)}`; }
export function storageKey(key: string, scope = storageScope()) { return key + scope; }
