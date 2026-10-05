# 技能展项运行台

本仓库保存互动展项服务的领域资料与最小事件约定，供业务、教育、设备维护与数据团队在统一语义上继续建设。

## 内容索引

- `docs/domain.md`：领域说明——聚合与事件目录、关键策略不变量、读模型推导、场景走读与边界。
- `contracts/domain.schema.json`：事件信封、27 种事件与 10 类聚合的负载契约（JSON Schema 2020-12）。
- `src/domain.ts`：与契约对应的判别联合 TypeScript 类型。
- `src/validator.js`：基础信封校验。
- `src/schema-validator.js`：无依赖的 JSON Schema 子集校验器，供测试做完整契约校验。
- `data/sample.json`：单条中文样例记录。
- `data/scenario-events.json`：68 条端到端场景事件（公平排队、离线归并、规则钉选、组件级故障与安检放行、儿童隐私）。
- `tests/`：
  - `contract.test.js`：信封校验与样例契约；
  - `scenario-contract.test.js`：全量场景事件的契约、版本递增与配对合法性；
  - `scenario-policy.test.js`：以事件重放固化公平容量、可信等待、无障碍、离线归并、规则钉选、故障粒度/安全门禁、儿童隐私七项策略。

## 领域边界

事件一旦被接收，其标识、发生时间和版本不应被原地改写；业务更正应产生后继记录。终端离线消息以事实时间（`occurred_at`）重放，以 `client_event_id` 幂等、`client_seq` 定序。涉及个人、机构或商业敏感信息时，调用方只读取完成职责所必需的字段；联系方式只存令牌引用，学习分析只使用去标识轨迹。

## 本地检查

```bash
npm test          # node --test，运行全部契约与策略断言
```
