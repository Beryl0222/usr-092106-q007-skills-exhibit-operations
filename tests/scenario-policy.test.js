/**
 * 以事件重放方式固化互动展项服务的七项关键策略不变量。
 * 这些断言既是场景验收，也是后续实现必须守住的回归基线。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const load = async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
const events = await load("../data/scenario-events.json");

const byType = (type) => events.filter((e) => e.event_type === type);
const t = (s) => Date.parse(s);

// ---------- 重放投影 ----------

const latestCapacity = new Map(); // exhibit -> CAPACITY_PLAN_SET
for (const e of byType("CAPACITY_PLAN_SET")) latestCapacity.set(e.exhibit_id, e);

const versionRules = new Map(); // exhibit:version -> RulesRef
const versionDurations = new Map(); // exhibit:version -> mode -> seconds
for (const e of byType("EXHIBIT_VERSION_PUBLISHED")) {
  versionRules.set(`${e.exhibit_id}@${e.exhibit_version}`, e.based_on_rules);
  versionDurations.set(`${e.exhibit_id}@${e.exhibit_version}`, e.mode_durations_seconds);
}

const rulesEffective = new Map(); // competition:version -> effective_at
for (const e of byType("COMPETITION_RULES_PUBLISHED")) {
  rulesEffective.set(`${e.competition_id}@${e.rules_version}`, e.effective_at);
}

// 预约/候补的诉求与到场信息
const requests = new Map(); // reservation_id -> RESERVATION_REQUESTED
for (const e of byType("RESERVATION_REQUESTED")) requests.set(e.reservation_id, e);
const standbys = new Map(); // standby_entry_id -> STANDBY_LIST_JOINED
for (const e of byType("STANDBY_LIST_JOINED")) standbys.set(e.standby_entry_id, e);

const slots = byType("SLOT_ASSIGNED");
const sessionStarts = byType("SESSION_STARTED");
const sessionRecords = byType("SESSION_RECORDED");

// 故障关闭窗口：组件/模式 -> [{from,to}]（to 为对应 EXHIBIT_RELEASED 时间）
const faultOrders = new Map(); // order -> opened order event
for (const e of byType("MAINTENANCE_ORDER_OPENED")) faultOrders.set(e.order_id, e);
const closures = [];
for (const f of byType("FAULT_REPORTED")) {
  const order = byType("MAINTENANCE_ORDER_OPENED").find((o) => o.fault_id === f.fault_id);
  const release = byType("EXHIBIT_RELEASED").find(
    (r) => r.order_id === order.order_id && f.affected_components.every((c) => r.released_components.includes(c))
  );
  closures.push({
    fault: f,
    order,
    from: f.detected_at,
    to: release ? release.released_at : null
  });
}
function isClosed(exhibitId, modeId, componentIds, at) {
  return closures.some((c) => {
    if (c.fault.exhibit_id !== exhibitId || t(at) < t(c.from)) return false;
    if (c.to !== null && t(at) >= t(c.to)) return false;
    const modeHit = c.fault.affected_modes.includes(modeId);
    const componentHit = componentIds.some((id) => c.fault.affected_components.includes(id));
    return modeHit || componentHit;
  });
}

// ---------- 1. 团体与候补公平占用容量 ----------

test("公平容量：同一展项/模式/开场时段占用不超过容量", () => {
  const buckets = new Map();
  for (const s of slots) {
    const key = `${s.exhibit_id}|${s.mode_id}|${s.starts_at}`;
    const b = buckets.get(key) ?? { seats: 0, assisted: 0, groupSeats: 0 };
    b.seats += s.seats_taken;
    if (s.accessibility_allocations.assisted_device_slot) b.assisted += 1;
    if (s.assigned_from === "reservation" && requests.get(s.reservation_id)?.party_type === "group") {
      b.groupSeats += s.seats_taken;
    }
    buckets.set(key, b);
  }
  for (const [key, b] of buckets) {
    const [exhibitId, modeId] = key.split("|");
    const cap = latestCapacity.get(exhibitId).mode_capacities[modeId];
    assert.ok(b.seats <= cap.seats, `${key} 普客座席超占：${b.seats}/${cap.seats}`);
    assert.ok(b.assisted <= cap.assisted_device_slots, `${key} 辅助设备槽位超占`);
  }
});

test("公平容量：团体在任一单时段不超过容量上限比例（12人团被拆为两场各6人）", () => {
  const groupBySlot = new Map();
  for (const s of slots) {
    const req = s.reservation_id ? requests.get(s.reservation_id) : null;
    if (req?.party_type !== "group") continue;
    const key = `${s.exhibit_id}|${s.mode_id}|${s.starts_at}`;
    groupBySlot.set(key, (groupBySlot.get(key) ?? 0) + s.seats_taken);
  }
  for (const [key, groupSeats] of groupBySlot) {
    const [exhibitId, modeId] = key.split("|");
    const cap = latestCapacity.get(exhibitId).mode_capacities[modeId];
    const policy = latestCapacity.get(exhibitId).group_policy;
    assert.ok(groupSeats <= cap.seats * policy.max_share_of_capacity, `${key} 团体占比超限`);
  }
});

test("公平容量：候补只占用取消/爽约释放出的容量，且按入列先后递补", () => {
  const releases = byType("RESERVATION_CANCELLED").map((e) => ({ at: e.cancelled_at, seats: e.released_seats }));
  for (const p of byType("STANDBY_PROMOTED")) {
    const joined = standbys.get(p.standby_entry_id).joined_at;
    assert.ok(releases.some((r) => t(r.at) >= t(joined) && t(r.at) <= t(p.promoted_at)),
      `${p.standby_entry_id} 递补前没有对应的容量释放`);
    // 同展项同模式：不存在更早入列、却在更晚仍未递补（被跳过）的候补
    for (const [id, other] of standbys) {
      if (id === p.standby_entry_id) continue;
      if (other.exhibit_id !== standbys.get(p.standby_entry_id).exhibit_id || other.mode_id !== standbys.get(p.standby_entry_id).mode_id) continue;
      const theirEnd = events.find((e) => e.event_type === "STANDBY_PROMOTED" && e.standby_entry_id === id)?.promoted_at
        ?? events.find((e) => e.event_type === "STANDBY_EXPIRED" && e.standby_entry_id === id)?.expired_at;
      if (t(other.joined_at) < t(joined) && theirEnd && t(theirEnd) > t(p.promoted_at)) {
        assert.fail(`${id} 早于 ${p.standby_entry_id} 入列却被跳过`);
      }
    }
  }
  // 每条候补至多被递补一次，递补后不再过期
  for (const [id] of standbys) {
    const promoted = events.filter((e) => e.event_type === "STANDBY_PROMOTED" && e.standby_entry_id === id);
    const expired = events.some((e) => e.event_type === "STANDBY_EXPIRED" && e.standby_entry_id === id);
    assert.ok(promoted.length <= 1 && !(promoted.length && expired), `${id} 候补终态不唯一`);
  }
});

// ---------- 2. 等待时间可信 ----------

test("等待时间：估算只允许实测吞吐/队列位置/人工口径，并标注有效期", () => {
  const MIN_SAMPLE = 8; // 实测吞吐的最小样本门槛
  for (const w of byType("WAIT_TIME_PUBLISHED")) {
    assert.ok(["observed_throughput", "queue_position", "manual_override"].includes(w.basis));
    assert.ok(w.valid_for_seconds >= 60, "等待时间有效期过短，前台无法据以展示");
    if (w.basis === "observed_throughput") {
      assert.ok(w.observed_sessions >= MIN_SAMPLE,
        `${w.mode_id} 实测样本不足却宣称实测口径（恢复开放初期应改用队列位置口径）`);
    }
  }
  for (const s of slots) {
    assert.ok(s.wait_estimate_seconds >= 0 && s.estimate_basis !== undefined);
  }
});

// ---------- 3. 儿童与辅助设备访客不被平均时长挤出 ----------

test("无障碍：申报的辅助需求都在派位中兑现，加时进入计划时长", () => {
  for (const s of slots) {
    const need = s.reservation_id ? requests.get(s.reservation_id)
      : s.standby_entry_id ? standbys.get(s.standby_entry_id) : null;
    assert.ok(need, `${s.slot_id} 找不到预约或候补来源`);
    const needs = new Set(need.accessibility_needs);
    const a = s.accessibility_allocations;
    if (needs.has("assisted_device")) assert.ok(a.assisted_device_slot, `${s.slot_id} 未兑现辅助设备槽位`);
    if (needs.has("wheelchair_space")) assert.ok(a.wheelchair_space, `${s.slot_id} 未兑现轮椅位`);
    if (needs.has("companion_seat")) assert.ok(a.companion_seat, `${s.slot_id} 未兑现陪同位`);
    if (needs.has("extra_time")) {
      const base = versionDurations.get(`exh-weld-vr@2`)[s.mode_id];
      assert.ok(s.duration_planned_seconds >= base + a.extra_time_seconds && a.extra_time_seconds > 0,
        `${s.slot_id} 加时未计入计划时长（被平均时长截断）`);
    }
  }
});

test("无障碍：辅助设备槽位独立计数，不与普客座席混占", () => {
  for (const s of slots) {
    const cap = latestCapacity.get(s.exhibit_id).mode_capacities[s.mode_id];
    assert.ok(cap.assisted_device_slots >= 1, "开放辅助实操的模式必须配置专用槽位");
  }
});

// ---------- 4. 终端离线消息重连后正确归并 ----------

test("离线归并：client_event_id 全局幂等、同会话序号连续", () => {
  const lifecycle = events.filter((e) => e.client_event_id);
  const ids = new Set();
  for (const e of lifecycle) {
    assert.ok(!ids.has(e.client_event_id), `重复终端消息：${e.client_event_id}`);
    ids.add(e.client_event_id);
  }
  const perSession = new Map();
  for (const e of lifecycle) {
    const list = perSession.get(e.session_id) ?? [];
    list.push(e);
    perSession.set(e.session_id, list);
  }
  for (const [, list] of perSession) {
    const seqs = list.map((e) => e.client_seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), "终端序号不连续，存在丢失或重复");
    for (const e of list) {
      assert.ok(t(e.server_received_at) >= t(e.client_recorded_at), "服务端接收时间早于终端记录时间");
      assert.equal(e.occurred_at, e.client_recorded_at, "归并不得改写事实发生时间");
    }
  }
});

test("离线归并：暂停/继续配对、时间线按序，有效时长扣除暂停", () => {
  for (const r of sessionRecords) {
    const phases = r.timeline.map((x) => x.phase);
    assert.equal(phases[0], "started", `${r.session_id} 时间线未以开始起头`);
    assert.equal(phases[phases.length - 1], "completed", `${r.session_id} 时间线未以完成收尾`);
    const pauses = phases.filter((p) => p === "paused").length;
    const resumes = phases.filter((p) => p === "resumed").length;
    assert.equal(pauses, resumes, `${r.session_id} 暂停与继续不配对`);
    for (let i = 1; i < r.timeline.length; i++) {
      assert.ok(r.timeline[i].client_seq > r.timeline[i - 1].client_seq, `${r.session_id} 时间线乱序`);
      assert.ok(t(r.timeline[i].at) >= t(r.timeline[i - 1].at), `${r.session_id} 时间倒流`);
    }
    // merged 列表与生命周期消息一致（离线四条全部并入同一条会话记录）
    const lifecycleIds = events
      .filter((e) => e.session_id === r.session_id && e.client_event_id)
      .map((e) => e.client_event_id)
      .sort();
    assert.deepEqual([...r.merged_client_event_ids].sort(), lifecycleIds);
    const elapsed = (t(r.completed_at) - t(r.started_at)) / 1000;
    assert.equal(r.effective_duration_seconds, elapsed - r.paused_seconds,
      `${r.session_id} 有效时长未正确扣减暂停`);
  }
});

test("离线归并：sess-7003 的四条离线消息在重连后归并为一条记录", () => {
  const r = sessionRecords.find((e) => e.session_id === "sess-7003");
  const offline = events.filter((e) => e.session_id === "sess-7003" && e.event_type !== "SESSION_RECORDED");
  assert.ok(offline.every((e) => e.offline_batched), "四条消息都应标记为离线批量");
  // 重连后作为同一批次一次性到达，而非各自发生时在线上报
  const receivedTimes = new Set(offline.map((e) => e.server_received_at));
  assert.equal(receivedTimes.size, 1, "离线消息应在重连后同一批次到达");
  const batchAt = [...receivedTimes][0];
  const firstRecorded = Math.min(...offline.map((e) => t(e.client_recorded_at)));
  assert.ok(t(batchAt) - firstRecorded >= 20 * 60 * 1000, "终端离线超过20分钟后才重连上传");
  assert.equal(r.merged_client_event_ids.length, 4);
  assert.equal(r.paused_seconds, 240);
  assert.equal(r.effective_duration_seconds, 840);
});

// ---------- 5. 规则切换保留历史解释，新会话跟随生效版本 ----------

test("规则钉选：会话实际采用的规则 = 开场时已生效的最新规则", () => {
  for (const s of sessionStarts) {
    const pinned = versionRules.get(`${s.exhibit_id}@${s.exhibit_version}`);
    assert.deepEqual(s.pinned_rules, pinned, `${s.session_id} 钉选规则与其内容版本不一致`);
    // 开场时刻：该规则已经生效
    assert.ok(t(s.occurred_at) >= t(rulesEffective.get(`${pinned.competition_id}@${pinned.rules_version}`)),
      `${s.session_id} 使用了尚未生效的规则`);
    // 开场时刻：不存在更新的已生效规则却被忽略
    for (const [key, eff] of rulesEffective) {
      const [comp, ver] = [pinned.competition_id, pinned.rules_version];
      if (key.startsWith(comp + "@") && Number(key.split("@")[1]) > ver) {
        assert.ok(t(s.occurred_at) < t(eff), `${s.session_id} 开场时规则 ${key} 已生效却未采用`);
      }
    }
  }
});

test("规则钉选：10月3日夜间会话在规则第4版生效后仍保留第3版解释与反馈口径", () => {
  const night = sessionStarts.find((e) => e.session_id === "sess-6998");
  assert.equal(night.pinned_rules.rules_version, 3);
  const record = sessionRecords.find((e) => e.session_id === "sess-6998");
  assert.equal(record.pinned_rules.rules_version, 3);
  const feedback = byType("LEARNING_FEEDBACK_SUBMITTED").find((e) => e.feedback_id === "fb-8799");
  assert.equal(feedback.based_on_rules.rules_version, 3);
});

test("内容时效：被确认过期的版本不再用于确认之后的新会话", () => {
  for (const ack of byType("CONTENT_EXPIRY_ACKNOWLEDGED")) {
    if (ack.review_status !== "outdated_confirmed") continue;
    for (const s of sessionStarts) {
      if (s.exhibit_id === ack.exhibit_id && s.exhibit_version === ack.exhibit_version) {
        assert.ok(t(s.occurred_at) < t(ack.acknowledged_at),
          `${s.session_id} 在 ${ack.exhibit_id}@${ack.exhibit_version} 被确认过期后仍使用它`);
      }
    }
  }
});

// ---------- 6. 故障只关闭受影响范围，安全检查通过才放行 ----------

test("故障粒度：工单范围与故障一致，关闭窗口内受影响模式/组件不接待新会话", () => {
  for (const c of closures) {
    assert.deepEqual([...c.order.scope_components].sort(), [...c.fault.affected_components].sort());
    assert.deepEqual([...c.order.scope_modes].sort(), [...c.fault.affected_modes].sort());
    assert.equal(c.order.safety_check_required, c.fault.requires_safety_check);
  }
  for (const s of sessionStarts) {
    assert.ok(!isClosed(s.exhibit_id, s.mode_id, s.component_assignments, s.occurred_at),
      `${s.session_id} 在故障关闭范围内启动`);
  }
});

test("故障粒度：未受影响的模式在故障窗口内继续开放（VR训练 10:50 照常）", () => {
  const open = sessionStarts.find((e) => e.session_id === "sess-7004");
  const faultAt = "2026-10-04T10:40:00+08:00";
  const releasedAt = "2026-10-04T11:45:00+08:00";
  assert.ok(t(open.occurred_at) > t(faultAt) && t(open.occurred_at) < t(releasedAt));
  assert.equal(open.mode_id, "vr_training");
  assert.ok(!open.component_assignments.includes("c-fume-extractor"));
});

test("安全门禁：须安检的工单必须先通过安全检查才能放行，放行范围不超出检查结论", () => {
  for (const c of closures) {
    const order = c.order;
    const release = byType("EXHIBIT_RELEASED").find((r) => r.order_id === order.order_id);
    if (!release) continue;
    const resolved = byType("MAINTENANCE_ORDER_RESOLVED").find((r) => r.order_id === order.order_id);
    assert.ok(resolved.unresolved_components.every((x) => !release.released_components.includes(x)),
      `${order.order_id} 放行了未修复组件`);
    assert.ok(release.released_components.every((x) => resolved.repaired_components.includes(x)));
    if (order.safety_check_required) {
      const check = byType("SAFETY_CHECK_PASSED").find((r) => r.order_id === order.order_id);
      assert.ok(check, `${order.order_id} 缺少安全检查记录`);
      assert.ok(t(check.passed_at) <= t(release.released_at), `${order.order_id} 先放行后安检`);
      assert.ok(release.released_components.every((x) => check.checked_components.includes(x)),
        `${order.order_id} 放行了未受检组件`);
      assert.ok(release.released_modes.every((x) => check.cleared_modes.includes(x)),
        `${order.order_id} 放行了未解封模式`);
    }
  }
});

test("安全门禁：低风险非安全工单可在修复后直接放行（副面板 E-208）", () => {
  const order = byType("MAINTENANCE_ORDER_OPENED").find((e) => e.order_id === "mo-9013");
  assert.equal(order.safety_check_required, false);
  const release = byType("EXHIBIT_RELEASED").find((e) => e.order_id === "mo-9013");
  assert.ok(release && !byType("SAFETY_CHECK_PASSED").some((e) => e.order_id === "mo-9013"));
});

// ---------- 7. 学习分析只使用无法识别儿童的轨迹 ----------

const FORBIDDEN_IDENTITY_FIELDS = ["visitor_name", "contact_ref", "member_id", "face_capture", "phone", "email", "id_number"];

test("儿童隐私：学习反馈一律去标识，儿童只保留年龄段与轮换假名", () => {
  const refs = new Set();
  for (const f of byType("LEARNING_FEEDBACK_SUBMITTED")) {
    assert.equal(f.deidentified, true, `${f.feedback_id} 未标记去标识`);
    assert.ok(f.pseudonymous_ref && !refs.has(f.pseudonymous_ref), "假名缺失或未轮换");
    refs.add(f.pseudonymous_ref);
    for (const key of FORBIDDEN_IDENTITY_FIELDS) {
      assert.ok(!(key in f), `${f.feedback_id} 含可识别字段 ${key}`);
    }
    assert.ok(!("session_id" in f || "reservation_id" in f), `${f.feedback_id} 反馈不得回链预约/会话`);
    if (f.visitor_band === "child") {
      assert.ok(typeof f.age_band === "string" && Number.isNaN(Number(f.age_band)),
        `${f.feedback_id} 儿童只能记录年龄段`);
      assert.ok(!("guardian_contact" in f));
    }
  }
});

test("儿童隐私：进入分析的会话记录必须先移除可识别字段，儿童团体还需移除机构/监护人信息", () => {
  const childSessions = new Set();
  for (const s of slots) {
    const source = s.reservation_id ? requests.get(s.reservation_id) : s.standby_entry_id ? standbys.get(s.standby_entry_id) : null;
    if (source && source.children_count > 0) {
      const started = sessionStarts.find((e) => e.slot_id === s.slot_id);
      if (started) childSessions.add(started.session_id);
    }
  }
  for (const r of sessionRecords) {
    if (!r.analytics_eligible) continue;
    const removed = new Set(r.identifier_scrubbing.fields_removed);
    for (const key of ["visitor_name", "contact_ref", "face_capture", "member_id"]) {
      assert.ok(removed.has(key), `${r.session_id} 进入分析但未移除 ${key}`);
    }
    if (childSessions.has(r.session_id)) {
      assert.ok(removed.has("school_name") || removed.has("guardian_contact"),
        `${r.session_id} 儿童轨迹未移除机构或监护人信息`);
    }
  }
});
