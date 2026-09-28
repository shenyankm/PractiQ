import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api, type Session } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("reads images through the binary Tauri command", async () => {
  const bytes = new ArrayBuffer(4);
  vi.mocked(invoke).mockResolvedValue(bytes);
  expect(await api({ type: "asset", hash: "digest" })).toBe(bytes);
  expect(invoke).toHaveBeenCalledWith("read_asset", { hash: "digest" });
});

it("reuses matching immutable snapshots and invalidates them after restore or changed visibility", async () => {
  const snapshot = {question:{id:"q"}};
  const session = {id:"compact",snapshotKey:"hidden",attempts:[{ordinal:0,snapshot}]} as Session;
  vi.mocked(invoke).mockResolvedValueOnce(session);
  await api({type:"session",id:session.id});
  vi.mocked(invoke).mockResolvedValueOnce({...session,attempts:[{ordinal:0,answer:{value:true}}]});
  const updated = await api({type:"position",id:session.id,position:0});
  expect(updated.attempts[0].snapshot).toBe(snapshot);
  expect(updated.attempts[0].answer).toEqual({value:true});
  expect(invoke).toHaveBeenLastCalledWith("request",expect.objectContaining({request:{type:"position",id:session.id,position:0,snapshot_key:"hidden"}}));
  vi.mocked(invoke).mockResolvedValueOnce({...session,snapshotKey:"revealed",attempts:[{ordinal:0}]})
    .mockResolvedValueOnce({...session,snapshotKey:"revealed",attempts:[{ordinal:0,snapshot:{question:{id:"q",analysis:"visible"}}}]});
  expect((await api({type:"position",id:session.id,position:0})).attempts[0].snapshot.question.analysis).toBe("visible");
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await api({type:"restore"});
  vi.mocked(invoke).mockResolvedValueOnce(session);
  await api({type:"position",id:session.id,position:0});
  expect(invoke).toHaveBeenLastCalledWith("request",expect.objectContaining({request:{type:"position",id:session.id,position:0}}));
});

it("does not retain an old session response that arrives after restoration starts", async () => {
  const session = {id:"late",snapshotKey:"old",attempts:[]} as unknown as Session;
  let resolve!: (session: Session) => void;
  vi.mocked(invoke).mockReturnValueOnce(new Promise<Session>(done => {resolve=done;}));
  const pending = api({type:"session",id:"late"});
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await api({type:"restore"});
  resolve(session);
  await pending;
  vi.mocked(invoke).mockResolvedValueOnce(session);
  await api({type:"position",id:"late",position:0});
  expect(invoke).toHaveBeenLastCalledWith("request",expect.objectContaining({request:{type:"position",id:"late",position:0}}));
});

it("polls the session clock without retransmitting immutable snapshots", async () => {
  const snapshot = {question:{id:"clock-question"}};
  const session = {id:"clock-poll",clockNow:1000,snapshotKey:"clock-hidden",attempts:[{ordinal:0,snapshot}]} as Session;
  vi.mocked(invoke).mockResolvedValueOnce(session);
  await api({type:"session",id:session.id});
  vi.mocked(invoke).mockResolvedValueOnce({...session,clockNow:4000,attempts:[{ordinal:0,answer:{value:true}}]});
  const polled = await api({type:"session",id:session.id});
  expect(polled.clockNow).toBe(4000);
  expect(polled.attempts[0].snapshot).toBe(snapshot);
  expect(invoke).toHaveBeenLastCalledWith("request",expect.objectContaining({request:{type:"session",id:session.id,snapshot_key:"clock-hidden"}}));
});
