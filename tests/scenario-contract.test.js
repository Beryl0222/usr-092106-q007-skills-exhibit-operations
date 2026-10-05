import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { validateAgainstSchema } from "../src/schema-validator.js";

const load = async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));

const events = await load("../data/scenario-events.json");
const schema = await load("../contracts/domain.schema.json");

test("场景中的每条事件都通过完整 JSON Schema 契约", () => {
  for (const event of events) {
    const errors = validateAgainstSchema(event, schema);
    assert.deepEqual(errors, [], `${event.event_id} 契约错误：\n${errors.join("\n")}`);
  }
});

test("场景中的每条事件都满足基础信封约定", () => {
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], `${event.event_id} 信封错误`);
  }
});

test("event_id 全局唯一，且事件按 occurred_at 非降序排列", () => {
  const ids = new Set();
  for (const event of events) {
    assert.ok(!ids.has(event.event_id), `重复 event_id：${event.event_id}`);
    ids.add(event.event_id);
  }
  for (let i = 1; i < events.length; i++) {
    assert.ok(
      Date.parse(events[i - 1].occurred_at) <= Date.parse(events[i].occurred_at),
      `${events[i].event_id} 早于前一事件的发生时间`
    );
  }
});

test("同一聚合内 version 严格递增", () => {
  const seen = new Map();
  for (const event of events) {
    const last = seen.get(event.aggregate_id);
    if (last !== undefined) {
      assert.ok(event.version > last, `${event.aggregate_id} 版本未递增（${last} → ${event.version}）`);
    }
    seen.set(event.aggregate_id, event.version);
  }
});

test("事件类型与聚合类型配对合法", () => {
  const pairs = {
    COMPETITION_RULES_PUBLISHED: "competition",
    EXHIBIT_REGISTERED: "exhibit",
    EXHIBIT_VERSION_PUBLISHED: "exhibit_version",
    CONTENT_APPROVED: "exhibit_version",
    CONTENT_EXPIRY_ACKNOWLEDGED: "exhibit_version",
    CAPACITY_PLAN_SET: "exhibit",
    WAIT_TIME_PUBLISHED: "exhibit",
    RESERVATION_REQUESTED: "reservation",
    SLOT_ASSIGNED: "queue_slot",
    RESERVATION_CANCELLED: "reservation",
    STANDBY_LIST_JOINED: "standby_entry",
    STANDBY_PROMOTED: "standby_entry",
    STANDBY_EXPIRED: "standby_entry",
    SLOT_CHECKED_IN: "queue_slot",
    SLOT_NO_SHOW: "queue_slot",
    FAULT_REPORTED: "fault",
    MAINTENANCE_ORDER_OPENED: "maintenance_order",
    MAINTENANCE_PROGRESS_LOGGED: "maintenance_order",
    MAINTENANCE_ORDER_RESOLVED: "maintenance_order",
    SAFETY_CHECK_PASSED: "maintenance_order",
    EXHIBIT_RELEASED: "exhibit",
    SESSION_STARTED: "visit_session",
    SESSION_PAUSED: "visit_session",
    SESSION_RESUMED: "visit_session",
    SESSION_COMPLETED: "visit_session",
    SESSION_RECORDED: "visit_session",
    LEARNING_FEEDBACK_SUBMITTED: "learning_feedback"
  };
  for (const event of events) {
    assert.equal(event.aggregate_type, pairs[event.event_type], `${event.event_id} 聚合配对错误`);
  }
});
