import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { webcrypto, randomUUID } from "node:crypto";

Object.defineProperty(crypto, "subtle", { value: webcrypto.subtle });
Object.defineProperty(crypto, "randomUUID", { value: randomUUID });
if (!File.prototype.arrayBuffer) File.prototype.arrayBuffer = function () { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(this); }); };
if (!URL.createObjectURL) URL.createObjectURL = () => "blob:test-image";
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
