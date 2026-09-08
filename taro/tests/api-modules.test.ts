import assert from "node:assert/strict";
import test from "node:test";
import type { ApiClient, ApiRequestOptions } from "../src/api/client";
import { createApi } from "../src/api/modules";

test("feature API modules use the documented routes and mutating methods", async () => {
  const calls: Array<{ path: string; options?: ApiRequestOptions }> = [];
  const client = {
    request: async (path: string, options?: ApiRequestOptions) => { calls.push({ path, options }); return {}; },
    requestEnvelope: async () => ({ data: [], meta: { pagination: { cursor: "", limit: 30, hasMore: false } } }),
  } as unknown as ApiClient;
  const api = createApi(client);
  await api.capabilities();
  await api.questions.answerKey(9, { answerMode: "short_answer", answerPayload: { value: "x" } });
  await api.banks.resetPractice(3);
  await api.groups.respond("invite-token", "accept");
  assert.deepEqual(calls.map((call) => [call.path, call.options?.method]), [
    ["/api/v1/capabilities", undefined],
    ["/api/v1/questions/9/answer-key", "PUT"],
    ["/api/v1/banks/3/practice-data", "DELETE"],
    ["/api/v1/study-group-invitations/invite-token/accept", "POST"],
  ]);
});
