import Ajv from "ajv/dist/2020.js";
import { AppError } from "./errors.js";
import { schemaFor } from "./contract-source.js";
export { contractSource, schemaFor } from "./contract-source.js";
export type { Schema } from "./contract-source.js";

const ajv = new Ajv({ strict: true, formats: { uuid: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i } });
// Match Pydantic's absolute float tolerance; exact division rejects ordinary decimal scores.
ajv.removeKeyword("multipleOf").addKeyword({
  keyword: "multipleOf", type: "number", schemaType: "number",
  validate: (multiple: number, value: number) => multiple > 0 && Math.abs(value - Math.round(value / multiple) * multiple) <= 1e-9,
});
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
export function validateContract(name: string, value: unknown): void {
  let validate = validators.get(name);
  if (!validate) { validate = ajv.compile(schemaFor(name)); validators.set(name, validate); }
  if (!validate(value)) {
    const error = validate.errors?.[0];
    // Schema values may contain provider input; only paths and validation keywords leave this boundary.
    throw new AppError("LOCAL_SCHEMA_INVALID", "Content does not satisfy its contract", { path: `${name}${error?.instancePath ?? ""}`, detail: error?.keyword ?? "invalid" });
  }
}
