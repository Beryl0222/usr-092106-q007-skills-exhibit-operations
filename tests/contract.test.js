import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { validateAgainstSchema } from "../src/schema-validator.js";

const load = async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));

test("基础信封校验：样例字段齐全且 version 为正整数", async () => {
  const sample = await load("../data/sample.json");
  assert.deepEqual(validateEvent(sample), []);
});

test("基础信封校验：缺字段与非法 version 被发现", () => {
  assert.match(validateEvent({ event_id: "x" }).join(","), /event_type/);
  assert.match(validateEvent({ version: 0 }).join(","), /正整数/);
});

test("样例符合完整 JSON Schema 契约", async () => {
  const [sample, schema] = await Promise.all([load("../data/sample.json"), load("../contracts/domain.schema.json")]);
  assert.deepEqual(validateAgainstSchema(sample, schema), []);
});
