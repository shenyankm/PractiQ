import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { acquireAsset } from "./asset-urls";
vi.mock("./api", () => ({api:vi.fn()}));
afterEach(() => {vi.restoreAllMocks();vi.clearAllMocks();});

it("shares concurrent consumers and revokes only after the final release, including pending reads", async () => {
  let resolve!: (bytes: ArrayBuffer) => void;
  vi.mocked(api).mockReturnValue(new Promise<ArrayBuffer>(done => {resolve=done;}) as ReturnType<typeof api>);
  vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:shared");
  const revoke=vi.spyOn(URL,"revokeObjectURL").mockImplementation(() => {});
  const first=acquireAsset("hash","image/png"), second=acquireAsset("hash","image/png");
  expect(api).toHaveBeenCalledTimes(1);
  first.release();
  resolve(new ArrayBuffer(4));
  expect(await second.url).toBe("blob:shared");
  expect(revoke).not.toHaveBeenCalled();
  second.release();
  await Promise.resolve();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:shared");
  const next=acquireAsset("hash","image/png");
  next.release();
  await next.url;
  await Promise.resolve();
  expect(api).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenCalledTimes(2);
});

it("does not cache failed reads", async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error("missing"));
  const failed=acquireAsset("missing");
  await expect(failed.url).rejects.toThrow("missing");
  failed.release();
  vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:repaired");
  vi.spyOn(URL,"revokeObjectURL").mockImplementation(() => {});
  vi.mocked(api).mockResolvedValueOnce(new ArrayBuffer(4));
  const repaired=acquireAsset("missing");
  expect(await repaired.url).toBe("blob:repaired");
  repaired.release();
});
