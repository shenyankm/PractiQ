import { expect, it } from "vitest";
import { errorMessage } from "./api";
import { locale, t } from "./i18n";
import native from "./locales/native.json";

it("renders local schema/reference diagnostics with their actual interpolation parameters", () => {
  expect(errorMessage({ code: "LOCAL_SCHEMA_INVALID", params: { path: "$", detail: "Unsafe JSON number" } }, false)).toContain("$: Unsafe JSON number");
  const params = { key: "questions", i: "missing-question" }, expected = native.LOCAL_QUESTION_INDEX_INVALID[locale()].replace("{key}", params.key).replace("{i}", params.i);
  expect(errorMessage({ code: "LOCAL_QUESTION_INDEX_INVALID", params }, false)).toBe(expected);
});

it("keeps generic operation diagnostics available while summary-only views hide them", () => {
  const error = { code: "OPERATION_FAILED", message: "TEST_ONLY_LOCAL_DIAGNOSTIC", requestId: "request-fixture" };
  expect(errorMessage(error)).toContain("TEST_ONLY_LOCAL_DIAGNOSTIC"); expect(errorMessage(error)).toContain("request-fixture");
  expect(errorMessage(error, false)).toBe(t("操作失败，请查看诊断详情。")); expect(errorMessage(error, false)).not.toContain("TEST_ONLY_LOCAL_DIAGNOSTIC");
});

it("gives uncertain recognition submissions a localized non-replay summary", () => {
  expect(errorMessage({ code: "TENCENT_SUBMISSION_UNKNOWN", message: "Raw provider detail" }, false)).toBe(native.TENCENT_SUBMISSION_UNKNOWN[locale()]);
  expect(errorMessage({ code: "TENCENT_SUBMISSION_UNKNOWN", message: "Raw provider detail" }, false)).not.toContain("Raw provider detail");
});
