# 医育联动健康接力后端

托育综合服务中心医育联动后端：老师、家长、健康管理员与妇幼医生在统一的领域事件之上
交接儿童照护与健康信息。系统**只辅助整理和提醒**——筛查指标永远不会自动变成诊断。

## 领域边界（系统守则）

1. **只记指标，不出诊断**：`HEALTH_SCREENING_RECORDED` 只能携带指标与 `normal/review/risk` 标记，
   `diagnosis`、`diagnostic_result`、`confirmed_condition` 等结论字段在写入时直接拒绝。
   转诊建议是医生的人工判断，不是指标推导结果。
2. **角色最小可见**：
   - 当班老师只看当班班级儿童的照护所需信息（档案卡、过敏安全提示、日常观察、有效用药委托、
     急症事件、当天接送名单），看不到筛查指标与转诊详情；
   - 妇幼医生只看已进入本机构诊疗范围的儿童，档案身份字段去标识，看不到日常照护观察；
   - 运营人员读不到任何儿童级数据，只能查看按站点聚合的去标识化质量指标；
   - 监护人看本人孩子的全部信息与访问记录；临时照护人只在授权有效期与授权范围内可见。
3. **过敏/急症告警可以越过普通共享偏好**（break-glass），但每次越权读取都必须填写访问理由，
   审计中标记为 `break_glass`，家长可见。
4. **授权有明确有效期**：临时照护人和监护人变更通过 `AUTHORIZATION_GRANTED/UPDATED/REVOKED`
   表达 `effective_from`/`effective_until`，过期或撤销即失效。
5. **跨机构转诊发送最小资料并确认接收**：`REFERRAL_SENT` 的资料包走字段白名单
   （见 `REFERRAL_PACKET_FIELDS`），姓名、证件、联系方式等标识深度检查拒绝外发；
   状态机为 `recommended → sent_awaiting_receipt → delivered → accepted`，
   接收方必须回 `REFERRAL_DELIVERED` 确认。
6. **迟到回访附着原事件、不覆盖现场记录**：回访与处置均通过 `linked_event_id` 挂到
   原建议/突发事件；事件只追加，聚合 `version` 连续递增。超过 7 天的回访标记为迟到并计入质量指标。
7. **全程留痕、家长可核对**：任何读取都必须带访问理由；写入记 `handle`、转诊外发记 `share`、
   越权看告警记 `break_glass`。监护人通过审计接口可核对谁、何时、因何查看或处理了孩子的信息。

## 事件目录

| event_type | aggregate_type | 记录人角色 |
| --- | --- | --- |
| `CHILD_CARE_RECORD_RECORDED` | child_care_record | 健康管理员 |
| `AUTHORIZATION_GRANTED / UPDATED / REVOKED` | guardian_authorization | 监护人、健康管理员 |
| `OBSERVATION_RECORDED`（进食/发育/睡眠等） | daily_observation | 老师、健康管理员 |
| `HEALTH_SCREENING_RECORDED`（仅指标） | health_screening | 医生、健康管理员 |
| `REFERRAL_RECOMMENDED / SENT / DELIVERED / ACCEPTED` | referral_handoff | 医生、健康管理员 |
| `MEDICATION_DELEGATION_RECORDED`（须监护人同意） | medication_delegation | 监护人、健康管理员 |
| `INCIDENT_RAISED / INCIDENT_DISPOSITION_RECORDED` | incident | 老师、健康管理员、医生 |
| `ALERT_RAISED / ALERT_ACKNOWLEDGED` | alert | 老师、健康管理员、医生 |
| `FOLLOWUP_RECORDED / FOLLOWUP_COMPLETED` | followup | 医生、健康管理员 |

完整信封、枚举与按类型的 payload 约束见 `contracts/domain.schema.json`；
TypeScript 类型见 `src/domain.ts`。

## 资料结构

- `contracts/domain.schema.json`：领域事件公共信封、稳定枚举与按类型约束。
- `data/sample.json`：一条最小业务事件样例。
- `data/sample-events.json`：完整中文联调链路（建档与花生过敏史 → 临时照护授权 →
  进食/发育观察 → 生长筛查（无诊断）→ 转诊最小资料发送与接收确认 → 回访闭环 →
  用药委托 → 过敏突发事件与告警 → 迟到回访）。
- `src/validator.js`：信封与按类型业务规则校验（无第三方依赖）。
- `src/store.js`：追加型 JSONL 事件存储与审计日志（唯一 event_id、版本连续、链接同儿童校验）。
- `src/policy.js`：角色最小可见、共享偏好与 break-glass 规则、写入角色矩阵、字段级脱敏。
- `src/handoff.js`：照护提示投影、医生诊疗视图、转诊跟踪、去标识化质量指标、家长审计。
- `src/server.js` / `src/index.js`：HTTP 接口与启动入口。
- `tests/`：校验规则、访问控制、转诊/回访流程、质量指标与 HTTP 冒烟测试。

## HTTP 接口

身份与访问理由通过请求头传递（生产部署应替换为网关注入的已认证身份）：

| 头 | 说明 |
| --- | --- |
| `x-actor-id` / `x-actor-role` / `x-actor-org` / `x-actor-name` | 访问者身份与机构 |
| `x-access-reason` | **必填**访问理由；中文请百分号编码，服务端自动解码 |
| `x-on-duty-class-ids` | 老师当班班级（逗号分隔） |
| `x-as-subject-id` | 以临时照护人主体身份访问 |
| `x-care-scope-date` 或 `?date=` | 照护范围日期（授权有效期判定） |

| 接口 | 说明 |
| --- | --- |
| `POST /v1/events` | 校验并追加一条领域事件 |
| `GET /v1/care-hints` | 托育点当班照护提示（过敏警戒、当日用药、未解除告警、当日观察、接送名单） |
| `GET /v1/children/:id/events` | 按角色最小化后的儿童事件流 |
| `GET /v1/children/:id/medical` | 医生诊疗视图（无日常观察、身份去标识） |
| `GET /v1/children/:id/audit` | 监护人核对访问与处理记录 |
| `GET /v1/referrals` | 医疗团队追踪转诊建议的接收与完成情况 |
| `GET /v1/quality-metrics` | 运营去标识化质量指标（按站点聚合，无任何儿童标识） |

## 本地运行

```bash
npm test        # 37 个规则与接口测试
npm start       # 启动服务（默认 http://localhost:3000，首次自动载入联调样例）
```

调用示例：

```bash
curl "http://localhost:3000/v1/care-hints?date=2026-10-04" \
  -H "x-actor-id: t-wang" -H "x-actor-role: teacher" -H "x-actor-org: site-a" \
  -H "x-on-duty-class-ids: xiaoban-1" \
  -H "x-access-reason: $(python3 -c 'import urllib.parse;print(urllib.parse.quote("当班照护"))')"
```

运行时数据写入 `data/runtime/`（已在 `.gitignore` 中忽略）；设置 `SEED_SAMPLE=0` 可跳过样例载入。
