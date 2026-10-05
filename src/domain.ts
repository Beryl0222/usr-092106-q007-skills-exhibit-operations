/**
 * 技能展项运行台 · 互动展项服务领域类型。
 *
 * 事件一经接收，event_id / occurred_at / version 不得原地改写；
 * 业务更正只能追加后继事件。负载字段只承载完成职责所必需的信息，
 * 联系方式以令牌引用保存，学习反馈只允许去标识轨迹。
 */

// ---------- 基础信封 ----------

export interface DomainEventBase {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  /** 事件实际发生时间（事实时间），离线补传时早于 server_received_at。 */
  occurred_at: string;
  /** 同一聚合内严格递增的事件序号。 */
  version: number;
  summary: string;
}

export type DomainEventType =
  | "COMPETITION_RULES_PUBLISHED"
  | "EXHIBIT_REGISTERED"
  | "EXHIBIT_VERSION_PUBLISHED"
  | "CONTENT_APPROVED"
  | "CONTENT_EXPIRY_ACKNOWLEDGED"
  | "CAPACITY_PLAN_SET"
  | "WAIT_TIME_PUBLISHED"
  | "RESERVATION_REQUESTED"
  | "SLOT_ASSIGNED"
  | "RESERVATION_CANCELLED"
  | "STANDBY_LIST_JOINED"
  | "STANDBY_PROMOTED"
  | "STANDBY_EXPIRED"
  | "SLOT_CHECKED_IN"
  | "SLOT_NO_SHOW"
  | "FAULT_REPORTED"
  | "MAINTENANCE_ORDER_OPENED"
  | "MAINTENANCE_PROGRESS_LOGGED"
  | "MAINTENANCE_ORDER_RESOLVED"
  | "SAFETY_CHECK_PASSED"
  | "EXHIBIT_RELEASED"
  | "SESSION_STARTED"
  | "SESSION_PAUSED"
  | "SESSION_RESUMED"
  | "SESSION_COMPLETED"
  | "SESSION_RECORDED"
  | "LEARNING_FEEDBACK_SUBMITTED";

export type AggregateType =
  | "competition"
  | "exhibit"
  | "exhibit_version"
  | "fault"
  | "maintenance_order"
  | "reservation"
  | "queue_slot"
  | "standby_entry"
  | "visit_session"
  | "learning_feedback";

// ---------- 共享值对象 ----------

/** 钉选到会话/版本的赛项规则引用：规则更新不改写历史解释。 */
export interface RulesRef {
  competition_id: string;
  rules_version: number;
}

export interface Suitability {
  min_age_years: number;
  max_age_years?: number | null;
  /** 低于该年龄须监护人陪同。 */
  supervision_required_under: number;
}

export interface Accessibility {
  wheelchair_accessible?: boolean;
  assisted_device_supported?: boolean;
  companion_seat?: boolean;
  sensory_low_stimulus_mode?: boolean;
}

export type AccessibilityNeed =
  | "wheelchair_space"
  | "assisted_device"
  | "companion_seat"
  | "low_stimulus"
  | "extra_time";

export type Category = "welding" | "robotics" | "traditional_craft";

export type ContentKind = "guide_script" | "experience_script" | "label" | "media";

export type ReviewStatus =
  | "current"
  | "outdated_pending_update"
  | "outdated_confirmed"
  | "revalidated";

/** 终端生命周期事件的离线归并字段。 */
export interface ClientEnvelope {
  /** 终端生成的幂等键，重连重传去重靠它。 */
  client_event_id: string;
  /** 同一终端会话内单调递增，决定归并顺序。 */
  client_seq: number;
  client_recorded_at: string;
  server_received_at: string;
  offline_batched: boolean;
}

// ---------- 事件负载 ----------

export interface CompetitionRulesPublished extends DomainEventBase {
  event_type: "COMPETITION_RULES_PUBLISHED";
  aggregate_type: "competition";
  competition_id: string;
  rules_version: number;
  title?: string;
  effective_at: string;
  change_summary?: string[];
}

export interface ExhibitRegistered extends DomainEventBase {
  event_type: "EXHIBIT_REGISTERED";
  aggregate_type: "exhibit";
  exhibit_id: string;
  competition_id: string;
  category: Category;
  components: Array<{
    component_id: string;
    name: string;
    safety_relevant: boolean;
  }>;
  experience_modes: string[];
  suitability: Suitability;
  accessibility: Accessibility;
  base_duration_seconds: number;
}

export interface ExhibitVersionPublished extends DomainEventBase {
  event_type: "EXHIBIT_VERSION_PUBLISHED";
  aggregate_type: "exhibit_version";
  exhibit_id: string;
  exhibit_version: number;
  based_on_rules: RulesRef;
  replaces_version: number | null;
  published_at: string;
  contents: Array<{
    content_id: string;
    kind: ContentKind;
    title: string;
  }>;
  /** 各体验模式的计划时长；辅助加时在 SLOT_ASSIGNED 上体现，不写死为“平均时长”。 */
  mode_durations_seconds: Record<string, number>;
  suitability?: Suitability;
  accessibility?: Accessibility;
}

export interface ContentApproved extends DomainEventBase {
  event_type: "CONTENT_APPROVED";
  aggregate_type: "exhibit_version";
  exhibit_id: string;
  exhibit_version: number;
  content_id: string | null;
  scope_all?: boolean;
  decision: "approved" | "rejected" | "changes_requested";
  reviewer_id: string;
  reviewed_at: string;
  based_on_rules: RulesRef;
}

export interface ContentExpiryAcknowledged extends DomainEventBase {
  event_type: "CONTENT_EXPIRY_ACKNOWLEDGED";
  aggregate_type: "exhibit_version";
  exhibit_id: string;
  exhibit_version: number;
  review_status: ReviewStatus;
  current_rules_version: number;
  acknowledged_by: string;
  acknowledged_at: string;
}

export interface CapacityPlanSet extends DomainEventBase {
  event_type: "CAPACITY_PLAN_SET";
  aggregate_type: "exhibit";
  exhibit_id: string;
  mode_capacities: Record<
    string,
    {
      seats: number;
      /** 辅助设备专用槽位，独立于普客座席计数，防止被平均算法挤占。 */
      assisted_device_slots: number;
      minimum_gap_seconds?: number;
    }
  >;
  group_policy: {
    max_party_size: number;
    /** 团体在单时段可占用容量的上限比例。 */
    max_share_of_capacity: number;
    min_lead_hours: number;
  };
  standby_policy: {
    promotion_window_seconds: number;
    expiry_after_seconds: number;
  };
  wait_time_policy: {
    /** 等待时间基于实测吞吐，而非静态平均时长。 */
    use_observed_throughput: boolean;
    horizon_seconds: number;
    accommodation_extra_seconds: number;
  };
}

export interface WaitTimePublished extends DomainEventBase {
  event_type: "WAIT_TIME_PUBLISHED";
  aggregate_type: "exhibit";
  exhibit_id: string;
  mode_id: string;
  expected_wait_seconds: number;
  accessible_lane_wait_seconds?: number;
  basis: "observed_throughput" | "queue_position" | "manual_override";
  observed_sessions?: number;
  valid_for_seconds: number;
}

export interface ReservationRequested extends DomainEventBase {
  event_type: "RESERVATION_REQUESTED";
  aggregate_type: "reservation";
  reservation_id: string;
  exhibit_id: string;
  mode_id: string;
  party_type: "group" | "individual";
  party_size: number;
  children_count: number;
  accessibility_needs: AccessibilityNeed[];
  contact_ref: string;
  requested_slot_at: string;
  joined_queue_at: string;
}

export interface SlotAssigned extends DomainEventBase {
  event_type: "SLOT_ASSIGNED";
  aggregate_type: "queue_slot";
  slot_id: string;
  reservation_id: string | null;
  standby_entry_id: string | null;
  exhibit_id: string;
  mode_id: string;
  assigned_from: "reservation" | "standby";
  party_size: number;
  seats_taken: number;
  /** 全局排队序号：团体与候补在同一序号空间先到先得。 */
  queue_sequence: number;
  starts_at: string;
  duration_planned_seconds: number;
  wait_estimate_seconds: number;
  estimate_basis: "observed_throughput" | "queue_position" | "manual_override";
  accessibility_allocations: {
    assisted_device_slot: boolean;
    wheelchair_space: boolean;
    companion_seat: boolean;
    extra_time_seconds: number;
  };
}

export interface ReservationCancelled extends DomainEventBase {
  event_type: "RESERVATION_CANCELLED";
  aggregate_type: "reservation";
  reservation_id: string;
  exhibit_id?: string;
  mode_id?: string;
  cancelled_at: string;
  reason: string;
  released_seats: number;
  released_assisted_device_slots?: number;
}

export interface StandbyListJoined extends DomainEventBase {
  event_type: "STANDBY_LIST_JOINED";
  aggregate_type: "standby_entry";
  standby_entry_id: string;
  exhibit_id: string;
  mode_id: string;
  party_size: number;
  children_count: number;
  accessibility_needs: AccessibilityNeed[];
  joined_at: string;
  queue_sequence: number;
}

export interface StandbyPromoted extends DomainEventBase {
  event_type: "STANDBY_PROMOTED";
  aggregate_type: "standby_entry";
  standby_entry_id: string;
  slot_id: string;
  promoted_at: string;
}

export interface StandbyExpired extends DomainEventBase {
  event_type: "STANDBY_EXPIRED";
  aggregate_type: "standby_entry";
  standby_entry_id: string;
  expired_at: string;
  reason: string;
}

export interface SlotCheckedIn extends DomainEventBase {
  event_type: "SLOT_CHECKED_IN";
  aggregate_type: "queue_slot";
  slot_id: string;
  checked_in_at: string;
}

export interface SlotNoShow extends DomainEventBase {
  event_type: "SLOT_NO_SHOW";
  aggregate_type: "queue_slot";
  slot_id: string;
  declared_at: string;
}

export interface FaultReported extends DomainEventBase {
  event_type: "FAULT_REPORTED";
  aggregate_type: "fault";
  fault_id: string;
  exhibit_id: string;
  fault_code: string;
  severity: "low" | "medium" | "high" | "safety";
  /** 关闭范围只限受影响组件与模式，其余继续开放。 */
  affected_components: string[];
  affected_modes: string[];
  detected_by: "terminal" | "manual" | "monitoring";
  detected_at: string;
  description: string;
  requires_safety_check: boolean;
}

export interface MaintenanceOrderOpened extends DomainEventBase {
  event_type: "MAINTENANCE_ORDER_OPENED";
  aggregate_type: "maintenance_order";
  order_id: string;
  fault_id: string;
  exhibit_id: string;
  scope_components: string[];
  scope_modes: string[];
  opened_at: string;
  assigned_team?: string;
  safety_check_required: boolean;
  required_actions: string[];
}

export interface MaintenanceProgressLogged extends DomainEventBase {
  event_type: "MAINTENANCE_PROGRESS_LOGGED";
  aggregate_type: "maintenance_order";
  order_id: string;
  status: "diagnosing" | "parts_waiting" | "repairing" | "resolved" | "cancelled";
  note?: string;
  logged_at: string;
}

export interface MaintenanceOrderResolved extends DomainEventBase {
  event_type: "MAINTENANCE_ORDER_RESOLVED";
  aggregate_type: "maintenance_order";
  order_id: string;
  repaired_components: string[];
  /** 未修复组件保持关闭，放行只覆盖 repaired_components。 */
  unresolved_components: string[];
  resolved_at: string;
  technician_id: string;
  safety_check_required: boolean;
}

export interface SafetyCheckPassed extends DomainEventBase {
  event_type: "SAFETY_CHECK_PASSED";
  aggregate_type: "maintenance_order";
  order_id: string;
  checked_components: string[];
  cleared_modes: string[];
  checklist_version: string;
  checked_by: string;
  passed_at: string;
  findings?: string;
}

export interface ExhibitReleased extends DomainEventBase {
  event_type: "EXHIBIT_RELEASED";
  aggregate_type: "exhibit";
  exhibit_id: string;
  order_id: string | null;
  released_components: string[];
  released_modes: string[];
  released_at: string;
  released_by: string;
}

export interface SessionStarted extends DomainEventBase, ClientEnvelope {
  event_type: "SESSION_STARTED";
  aggregate_type: "visit_session";
  session_id: string;
  slot_id: string;
  exhibit_id: string;
  mode_id: string;
  exhibit_version: number;
  /** 开始时钉选的规则版本：整场讲解与体验按此解释，规则切换不影响它。 */
  pinned_rules: RulesRef;
  component_assignments: string[];
  accommodations: {
    assisted_device: boolean;
    wheelchair_space: boolean;
    companion_seat: boolean;
    extra_time_seconds: number;
  };
}

export interface SessionPaused extends DomainEventBase, ClientEnvelope {
  event_type: "SESSION_PAUSED";
  aggregate_type: "visit_session";
  session_id: string;
  reason: "visitor" | "equipment" | "changeover";
}

export interface SessionResumed extends DomainEventBase, ClientEnvelope {
  event_type: "SESSION_RESUMED";
  aggregate_type: "visit_session";
  session_id: string;
}

export interface SessionCompleted extends DomainEventBase, ClientEnvelope {
  event_type: "SESSION_COMPLETED";
  aggregate_type: "visit_session";
  session_id: string;
  completed_normally: boolean;
  abandonment_reason: string | null;
}

/** 离线终端补传的开始/暂停/继续/完成在服务端归并后落定的会话记录。 */
export interface SessionRecorded extends DomainEventBase {
  event_type: "SESSION_RECORDED";
  aggregate_type: "visit_session";
  session_id: string;
  exhibit_id: string;
  exhibit_version: number;
  pinned_rules: RulesRef;
  started_at: string;
  completed_at: string;
  merged_client_event_ids: string[];
  timeline: Array<{
    client_event_id: string;
    client_seq: number;
    phase: "started" | "paused" | "resumed" | "completed";
    at: string;
  }>;
  paused_seconds: number;
  effective_duration_seconds: number;
  analytics_eligible: boolean;
  identifier_scrubbing: {
    fields_removed: string[];
  };
  finalized_at: string;
}

export interface LearningFeedbackSubmitted extends DomainEventBase {
  event_type: "LEARNING_FEEDBACK_SUBMITTED";
  aggregate_type: "learning_feedback";
  feedback_id: string;
  pseudonymous_ref: string;
  visitor_band: "child" | "adult" | "unknown";
  age_band: string | null;
  exhibit_id: string;
  exhibit_version: number;
  mode_id: string;
  based_on_rules: RulesRef;
  responses: Array<{
    item_id: string;
    outcome: "completed" | "partial" | "failed" | "skipped";
    score?: number | null;
  }>;
  deidentified: boolean;
  submitted_at: string;
}

export type DomainEvent =
  | CompetitionRulesPublished
  | ExhibitRegistered
  | ExhibitVersionPublished
  | ContentApproved
  | ContentExpiryAcknowledged
  | CapacityPlanSet
  | WaitTimePublished
  | ReservationRequested
  | SlotAssigned
  | ReservationCancelled
  | StandbyListJoined
  | StandbyPromoted
  | StandbyExpired
  | SlotCheckedIn
  | SlotNoShow
  | FaultReported
  | MaintenanceOrderOpened
  | MaintenanceProgressLogged
  | MaintenanceOrderResolved
  | SafetyCheckPassed
  | ExhibitReleased
  | SessionStarted
  | SessionPaused
  | SessionResumed
  | SessionCompleted
  | SessionRecorded
  | LearningFeedbackSubmitted;
