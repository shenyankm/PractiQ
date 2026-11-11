// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Client } from "../../shared/cloud/api";
import { storageKey } from "../../shared/cloud/serviceStorage";
import { setNativeBridge, type NativeBridge } from "../../shared/cloud/transport";
afterEach(() => { setNativeBridge(null); localStorage.clear(); });
it("preserves retired storage and isolates personal recovery records by service", () => {
  const legacy = "practiq-import-intents-v1.user.retained-user";
  localStorage.setItem(legacy, "retained unknown receipt");
  setNativeBridge({ origin: "https://first.test" } as NativeBridge);
  const first = new Client();
  const firstKey = storageKey("practiq-import-intents-v1");
  expect(first.pendingImports()).toEqual([]);
  setNativeBridge({ origin: "https://second.test" } as NativeBridge);
  expect(first.active).toBe(false);
  expect(storageKey("practiq-import-intents-v1")).not.toBe(firstKey);
  expect(new Client().pendingImports()).toEqual([]);
  expect(localStorage.getItem(legacy)).toBe("retained unknown receipt");
});
