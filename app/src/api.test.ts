import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api, runSessionRequest, sessionSnapshotKey, type Session } from "./api";

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

it("expands pooled materials and options once while keeping mutable attempt data separate", async () => {
  const material = {id:"material",passage:[{textValue:"shared"}]};
  const group = {id:"group",title:"Shared instructions"};
  const visual = {id:"visual",description:"Diagram"};
  const options = [{label:"A",content:"shared option"}];
  const warnings = ["Shared warning"];
  const wire = {id:"pooled",snapshotKey:"pool-key",snapshotDocument:[material,group,visual,options,warnings],
    attempts:[0,1].map(ordinal => ({ordinal,answer:null,snapshot:{id:`q${ordinal}`,question:{id:`q${ordinal}`,options:null},snapshotRefs:{materials:[0],groups:[1],visuals:[2],options:3,warnings:4}}}))};
  vi.mocked(invoke).mockResolvedValueOnce(wire);
  const session = await api({type:"session",id:wire.id});
  expect(session.attempts[0].snapshot.materials?.[0]).toBe(material);
  expect(session.attempts[1].snapshot.materials?.[0]).toBe(material);
  expect(session.attempts[0].snapshot.question.options).toBe(options);
  expect(session.attempts[1].snapshot.question.options).toBe(options);
  expect(session.attempts[0].snapshot.groups[0]).toBe(group);
  expect(session.attempts[0].snapshot.visuals[0]).toBe(visual);
  expect(session.attempts[0].snapshot.warnings).toBe(warnings);
  expect(session.attempts[1].snapshot.warnings).toBe(warnings);
  expect(session).not.toHaveProperty("snapshotDocument");
  expect(session.attempts[0].snapshot).not.toHaveProperty("snapshotRefs");
  vi.mocked(invoke).mockResolvedValueOnce({...wire,snapshotDocument:undefined,attempts:[{ordinal:0,flagged:true},{ordinal:1}]});
  const flagged = await api({type:"flag",id:wire.id,ordinal:0,value:true});
  expect(flagged.attempts[0].snapshot).toBe(session.attempts[0].snapshot);
  expect(flagged.attempts[0].flagged).toBe(true);
  expect(invoke).toHaveBeenLastCalledWith("request",expect.objectContaining({request:{type:"flag",id:wire.id,ordinal:0,value:true,snapshot_key:"pool-key"}}));
});

it("reloads a complete snapshot after a malformed shared reference", async () => {
  const snapshot = {question:{id:"q",analysis:"safe"},materials:[],groups:[],visuals:[]};
  const complete = {id:"invalid-pool",snapshotKey:"key",attempts:[{ordinal:0,snapshot}]} as unknown as Session;
  vi.mocked(invoke).mockResolvedValueOnce({...complete,snapshotDocument:[],attempts:[{ordinal:0,snapshot:{question:{id:"q"},snapshotRefs:{materials:[1],groups:[],visuals:[]}}}]})
    .mockResolvedValueOnce(complete);
  expect((await api({type:"session",id:complete.id})).attempts[0].snapshot).toBe(snapshot);
  expect(invoke).toHaveBeenLastCalledWith("request",expect.objectContaining({request:{type:"session",id:complete.id}}));
});

it("shares the immutable cache with grading transport and ignores grading that finishes after restore", async () => {
  const snapshot = {question:{id:"graded-question"},materials:[],groups:[],visuals:[]};
  const session = {id:"grading-cache",snapshotKey:"graded-key",attempts:[{ordinal:0,snapshot}]} as unknown as Session;
  vi.mocked(invoke).mockResolvedValueOnce(session);
  await api({type:"session",id:session.id});
  const send = vi.fn(async () => ({...session,attempts:[{ordinal:0,earnedCents:50}]}));
  const graded = await runSessionRequest(session.id, send);
  expect(send).toHaveBeenCalledWith("graded-key");
  expect((graded as unknown as Session).attempts[0].snapshot).toBe(snapshot);
  let resolve!: (value: Session) => void;
  const pending = runSessionRequest(session.id, () => new Promise<Session>(done => {resolve=done;}));
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await api({type:"restore"});
  resolve(session);
  await pending;
  expect(sessionSnapshotKey(session.id)).toBeUndefined();
});


it("applies only changed attempts and keeps the base snapshots and unchanged objects", async () => {
  const snapshot = {question:{id:"q"}};
  const initial = {id:"attempt-delta",snapshotKey:"same",attemptKey:"before",attempts:[{ordinal:0,answer:null,snapshot},{ordinal:1,answer:null,snapshot}]} as unknown as Session;
  vi.mocked(invoke).mockResolvedValueOnce(initial);
  const full = await api({type:"session",id:initial.id});
  vi.mocked(invoke).mockResolvedValueOnce({...initial,attemptKey:"after",attemptsBase:"before",attemptCount:2,attempts:[{ordinal:1,answer:{value:true}}]});
  const changed = await api({type:"position",id:initial.id,position:1});
  expect(changed.attempts[0]).toBe(full.attempts[0]);
  expect(changed.attempts[1].snapshot).toBe(snapshot);
  expect(changed.attempts[1].answer).toEqual({value:true});
  expect(invoke).toHaveBeenLastCalledWith("request",expect.objectContaining({request:{type:"position",id:initial.id,position:1,snapshot_key:"same:before"}}));
  expect(changed).not.toHaveProperty("attemptsBase");
});
it.each([{attemptsBase:"missing",attemptCount:1,attempts:[]},{attemptsBase:"base",attemptCount:2,attempts:[]},{attemptsBase:"base",attemptCount:1,attempts:[{ordinal:3}]},{attemptsBase:"base",attemptCount:1,attempts:[{ordinal:0},{ordinal:0}]}])("reloads a full session after a malformed mutable delta: %j", async invalid => {
  const initial = {id:"delta-recovery",snapshotKey:"same",attemptKey:"base",attempts:[{ordinal:0,snapshot:{question:{id:"q"}}}]} as unknown as Session;
  vi.mocked(invoke).mockResolvedValueOnce(initial); await api({type:"session",id:initial.id});
  vi.mocked(invoke).mockResolvedValueOnce({...initial,...invalid}).mockResolvedValueOnce(initial);
  expect((await api({type:"session",id:initial.id})).attempts).toEqual(initial.attempts);
  expect(invoke).toHaveBeenLastCalledWith("request",expect.objectContaining({request:{type:"session",id:initial.id}}));
});
