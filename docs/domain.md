# 互动展项服务 · 领域说明

本服务支撑世界技能大赛主题博物馆互动展项（焊接、工业机器人、传统工艺）的前台体验与后台协同。
本文档配合 `contracts/domain.schema.json`、`src/domain.ts`、`data/scenario-events.json` 与 `tests/` 中的
可执行断言，作为业务、教育、设备维护与数据团队共享的语义基线。

## 1. 前台要解决的三个问题

1. **等待时间可信**：展示基于近期实测吞吐的等待时间，并标注口径与有效期；样本不足时改用队列位置估算；
   故障恢复初期不允许用少量样本冒充"实测"。
2. **故障有合适替代**：维护员看到的不再只是故障码——故障携带受影响组件与体验模式、严重度、是否须安全检查；
   前台据此推荐同类、同无障碍条件的替代展项（如焊接辅助实操关闭时推荐低刺激观摩与机器人展项）。
3. **儿童与辅助设备访客不被挤出**：辅助设备槽位独立计数，加时计入派位计划时长，陪同位随需求兑现；
   排队先到先得的序号空间对团体预约与现场候补是同一个。

## 2. 聚合与事件目录

| 聚合 | 职责 | 事件 |
| --- | --- | --- |
| `competition` | 赛项规则版本与生效时间 | `COMPETITION_RULES_PUBLISHED` |
| `exhibit` | 展项本体：组件清单、体验模式、适龄与无障碍条件、容量与排队策略、组件/模式级开放状态 | `EXHIBIT_REGISTERED`、`CAPACITY_PLAN_SET`、`WAIT_TIME_PUBLISHED`、`EXHIBIT_RELEASED` |
| `exhibit_version` | 展项内容版本（讲解词、体验脚本、说明牌、媒体）及其规则依据、审核与过期状态 | `EXHIBIT_VERSION_PUBLISHED`、`CONTENT_APPROVED`、`CONTENT_EXPIRY_ACKNOWLEDGED` |
| `fault` | 一次故障：原始故障码、受影响组件/模式、严重度、检测来源、是否须安全检查 | `FAULT_REPORTED` |
| `maintenance_order` | 维护工单及其修复、安检过程 | `MAINTENANCE_ORDER_OPENED`、`MAINTENANCE_PROGRESS_LOGGED`、`MAINTENANCE_ORDER_RESOLVED`、`SAFETY_CHECK_PASSED` |
| `reservation` | 团体/散客预约诉求（联系方式只存令牌引用） | `RESERVATION_REQUESTED`、`RESERVATION_CANCELLED` |
| `standby_entry` | 现场候补 | `STANDBY_LIST_JOINED`、`STANDBY_PROMOTED`、`STANDBY_EXPIRED` |
| `queue_slot` | 一场具体派位：占用座席、辅助槽位、计划时长、等待承诺 | `SLOT_ASSIGNED`、`SLOT_CHECKED_IN`、`SLOT_NO_SHOW` |
| `visit_session` | 一次现场体验：钉选的规则与内容版本、终端生命周期消息、归并后的落定记录 | `SESSION_STARTED`、`SESSION_PAUSED`、`SESSION_RESUMED`、`SESSION_COMPLETED`、`SESSION_RECORDED` |
| `learning_feedback` | 去标识的学习反馈 | `LEARNING_FEEDBACK_SUBMITTED` |

### 实体关系要点

- 展项 1—N 个**组件**（含是否安全相关标记），1—N 个**体验模式**（讲解、辅助实操、VR 训练、低刺激观摩）。
- 展项 1—N 个**内容版本**；每个版本基于且仅基于一个**赛项规则版本**（`based_on_rules`）。
- 故障范围 = 组件集合 × 模式集合；工单范围必须与故障一致。
- 预约与候补都汇入同一排队序号空间，派位生成 `queue_slot`；会话引用槽位，并钉选内容与规则版本。
- 学习反馈只通过去标识假名与展项/模式/规则版本关联，**不回链**预约、槽位或会话。

## 3. 关键策略（业务不变量）

以下规则同时由 `tests/scenario-policy.test.js` 重放断言守护，实现变更不得破坏。

### 3.1 公平占用容量

- 同一展项/模式/开场时段，`seats_taken` 之和 ≤ 容量座席，辅助设备槽位单独计数、单独上限。
- 团体单时段占用 ≤ 容量 × `max_share_of_capacity`（示例 50%）。超出部分顺延到后续场次，
  不为团体把整场锁死；团体仍须满足提前量（`min_lead_hours`）。
- 团体预约与散客候补使用**同一 `queue_sequence` 序号空间**，按入列时刻先到先得。
- 候补只能占用取消（`RESERVATION_CANCELLED`）或爽约（`SLOT_NO_SHOW`）释放出的容量；
  递补严格按入列先后，不允许跳过更早仍在等待的人。候补递补后不再过期，终态唯一。
- 候补递补有响应窗口（`promotion_window_seconds`），模式持续不可用等情况下超时失效
  （`expiry_after_seconds`），失效原因与替代建议一并记录。

### 3.2 可信等待时间

- 每次发布必须带 `basis`：`observed_throughput`（近窗口实测吞吐）、`queue_position`（按队列位置）、
  `manual_override`（人工），以及 `valid_for_seconds` 有效期。
- 实测口径要求足够样本（测试基线：窗口内 ≥ 8 场完成会话）。故障重开后样本不足，必须切换为队列位置口径，
  避免"刚重开就显示几乎不用等"的误导。
- 派位时给访客的承诺（`wait_estimate_seconds` + `estimate_basis`）落事件，事后可核对偏差，
  用于校准吞吐模型与前台措辞。
- 等待模型不得用"平均时长"给所有人排队；辅助加时、儿童监护换场等在派位时长中单独体现。

### 3.3 无障碍与适龄

- 预约/候补申报的每项 `accessibility_needs`（轮椅位、辅助设备、陪同位、低刺激、加时）都必须在
  `SLOT_ASSIGNED.accessibility_allocations` 中兑现；加时使 `duration_planned_seconds` 大于模式基准时长。
- 开放辅助实操的模式必须配置独立的 `assisted_device_slots`，不与普客座席混占。
- 适龄条件（`suitability`：最低年龄、监护阈值）与无障碍条件挂在展项与内容版本上，
  版本更新可收紧或放宽；低刺激模式作为标准模式之一参与排队与替代推荐。

### 3.4 离线会话归并

终端在断网时本地缓存开始/暂停/继续/完成消息，重连后批量补传。归并规则：

- **幂等**：`client_event_id` 终端全局唯一，重传不产生重复生命周期节点。
- **排序**：同一 `session_id` 内 `client_seq` 从 1 连续无缺；时间线按序号归并。
- **事实时间不被改写**：事件 `occurred_at` = `client_recorded_at`；`server_received_at` 只表示到达时刻，
  离线消息可晚到数十分钟。
- **暂停配对**：暂停与继续必须成对；`paused_seconds` 为暂停区间合计；
  `effective_duration_seconds = completed_at − started_at − paused_seconds`。
- 归并落定只产生一条 `SESSION_RECORDED`，其 `merged_client_event_ids` 列出并入的全部终端消息。

### 3.5 规则切换与历史解释

- 规则以 `COMPETITION_RULES_PUBLISHED` 发布，带 `effective_at`；同一赛项版本号单调递增。
- 会话在开始时**钉选**当时已生效的最新规则（`pinned_rules`）及对应内容版本；之后规则再更新，
  该场讲解、体验、评分解释与学习反馈口径都不变。
- 规则切换后：新版本内容经 `CONTENT_APPROVED` 才用于新会话；教育专员通过
  `CONTENT_EXPIRY_ACKNOWLEDGED`（`outdated_pending_update` → `outdated_confirmed` / `revalidated`）
  明确处置旧版本。被确认过期的版本不得用于确认之后开始的会话；规则差异由 `change_summary` 暴露，
  教育专员据此判断"哪些讲解与脚本过期"，而不是靠人工记忆。

### 3.6 故障粒度与安全放行

- 故障只关闭 `affected_components` 与 `affected_modes`；其余组件/模式继续接待（示例：烟尘净化单元过流
  只关闭辅助实操，讲解、VR 训练、低刺激观摩照常；副面板按键失灵只关闭低刺激观摩）。
- 工单范围（组件/模式、是否须安检）必须与故障一致；`MAINTENANCE_ORDER_RESOLVED` 区分
  `repaired_components` 与 `unresolved_components`，未修复组件保持关闭。
- **安全门禁**：`requires_safety_check` 的工单，必须先有 `SAFETY_CHECK_PASSED`（记录检查表版本、
  检查人、受检组件与解封模式）才能 `EXHIBIT_RELEASED`；放行范围不得超出检查结论与修复范围。
  非安全相关的低风险故障修复后可直接放行。
- 派位器在模式关闭窗口内不得为该模式或使用受影响组件的新会话放行；已有在场会话可按安全规程继续或中止，
  其处理通过会话生命周期事件体现。

### 3.7 儿童隐私与学习分析

- 进入分析（`analytics_eligible`）的 `SESSION_RECORDED` 必须先经字段清洗，
  `identifier_scrubbing.fields_removed` 至少包含姓名、联系方式引用、人脸采集、会员标识；
  儿童团体轨迹额外移除学校等机构信息与监护人联系方式。
- `LEARNING_FEEDBACK_SUBMITTED` 一律 `deidentified: true`，使用轮换假名 `pseudonymous_ref`；
  禁止携带姓名、联系方式、会员/证件号、人脸、会话/预约 ID 等任何可回链字段。
- 儿童（`visitor_band: "child"`）只允许记录**年龄段**（如 6–9），禁止精确年龄与生日。
- 反馈按访客实际体验到的规则版本（`based_on_rules`）计分，保证跨规则版本的分析口径可分辨、可过滤。

## 4. 事件溯源约定

- 信封字段：`event_id`（全局唯一）、`event_type`、`aggregate_type`、`aggregate_id`、
  `occurred_at`（带时区，事实时间）、`version`（同一聚合内严格递增）、`summary`（中文人读摘要）。
- 事件一经接收，标识、发生时间、版本**不得原地改写**；业务更正只能追加后继事件
  （例如 `MAINTENANCE_PROGRESS_LOGGED` 的状态推进、内容过期确认）。
- 终端事件携带双时间戳与幂等键（`client_event_id` / `client_seq` / `client_recorded_at` /
  `server_received_at` / `offline_batched`），服务端按"事实时间"重放。

## 5. 从前台看：读模型如何由事件得出

| 前台问题 | 读模型 | 来源事件 |
| --- | --- | --- |
| 某模式现在要等多久 | 最近一条未过期 `WAIT_TIME_PUBLISHED`（含口径、有效期、无障碍通道等待） | `WAIT_TIME_PUBLISHED` |
| 某模式能否体验 | 展项开放状态 = 初始开放，减去故障关闭的组件/模式，加回经放行的范围 | `FAULT_REPORTED`、`EXHIBIT_RELEASED`、`SAFETY_CHECK_PASSED` |
| 故障展项的替代项 | 同类别 + 同模式开放 + 同无障碍条件的其他展项 | `EXHIBIT_REGISTERED`、故障/放行事件 |
| 某脚本/讲解是否过期 | 版本审核状态 + 当前规则版本 + 教育专员确认 | 规则发布、版本发布、`CONTENT_APPROVED`、`CONTENT_EXPIRY_ACKNOWLEDGED` |
| 我的候补排第几位 | 同展项/模式下入列更早且未终态的候补数 + 未派位预约 | 排队事件 |
| 这场体验按哪版规则 | 会话记录上的 `pinned_rules` | `SESSION_STARTED`、`SESSION_RECORDED` |
| 维护员看到的故障上下文 | 故障码原文 + 受影响范围 + 工单状态与处理动作 + 安检要求 | 故障/工单全部事件 |

## 6. 场景走读（`data/scenario-events.json`）

68 条事件覆盖 2026-09-25 至 10-04 的完整故事线：

1. 规则 v3 发布 → 焊接展项登记、内容 v1 审核通过、容量策略设定；
2. 10-03 夜间散客按 v3 完成 VR 训练并提交反馈（规则 v4 次日生效，其历史解释保留）；
3. 规则 v4 发布 → 内容 v2 发布审核 → v1 被教育专员确认过期；
4. 10-04 开馆：团体 12 人被拆为两场各 6 人（50% 上限），轮椅访客获辅助槽位/轮椅位/陪同位/加时，
   散客取消后座席按序递给 09:10 入列的 7 岁候补儿童；
5. 离线终端的儿童会话：开始、设备暂停、继续、完成四条消息本地缓存，重连同批到达后按序号归并，
   扣暂停 4 分钟，有效时长 840 秒；
6. 两个故障：烟尘净化单元 E-417（安全相关，只关辅助实操，修复 → 安检通过 → 放行）与
   观摩区副面板 E-208（低风险，修复后直接放行）；故障窗口内 VR 训练 10:50 照常接待；
7. 候补因模式持续关闭而超时，前台改荐低刺激观摩与机器人展项；恢复开放后因样本不足改用队列位置口径发布等待；
8. 学习反馈：成人与儿童均去标识；儿童仅留年龄段与轮换假名。

## 7. 边界与待决问题

- **替代推荐排序**：契约只保证候选条件（类别、模式、无障碍），具体排序权重（距离、等待、适龄）留给读模型实现。
- **支付与票务**：本服务只持有预约容量关系，不承载支付；入场核验结果通过 `SLOT_CHECKED_IN` / `SLOT_NO_SHOW` 进入。
- **多人团体内部名册**：不采集，不进入事件；团体儿童数量只用于适龄/加时与容量策略。
- **安检检查表内容**：事件只钉选 `checklist_version` 与结论，检查表本体由安全管理系统维护。
- **反馈再识别风险**：假名轮换与年龄段仍可能在极小样本下被关联分析，分析侧应设最小分组阈值（k-匿名），
  该阈值属于分析治理策略，不在事件契约内。
