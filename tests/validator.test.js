import assert from "node:assert/strict";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { makeEvent, recordEvent } from "./helpers.js";

test("合法的建档与观察事件通过校验", () => {
  assert.deepEqual(validateEvent(recordEvent()), []);
  assert.deepEqual(validateEvent(makeEvent()), []);
});

test("缺少公共信封字段时逐条报错", () => {
  const errors = validateEvent({ event_id: "x" });
  assert.ok(errors.includes("缺少字段：event_type"));
  assert.ok(errors.includes("缺少字段：payload"));
  assert.ok(errors.includes("actor 必须是对象") || errors.includes("缺少字段：actor"));
});

test("version 必须是正整数且按聚合连续递增的规则在存储层生效", () => {
  assert.ok(validateEvent(makeEvent({ version: 0 })).some((m) => m.includes("version")));
  assert.ok(validateEvent(makeEvent({ version: 1.5 })).some((m) => m.includes("version")));
});

test("筛查记录携带 diagnosis 等结论字段一律拒绝：指标不能自动变成诊断", () => {
  const validPayload = {
    screening_type: "growth",
    observed_at: "2026-09-25T09:40:00+08:00",
    indicators: [{ code: "WAZ", label: "年龄别体重Z分", value: -2.1, flag: "review" }],
  };
  const base = {
    event_type: "HEALTH_SCREENING_RECORDED",
    aggregate_type: "health_screening",
    aggregate_id: "scr-1",
    actor: { actor_id: "dr-1", role: "doctor", org_id: "mch-001" },
  };
  for (const forbidden of ["diagnosis", "diagnostic_result", "confirmed_condition"]) {
    const errors = validateEvent(makeEvent({ ...base, payload: { ...validPayload, [forbidden]: "营养不良" } }));
    assert.ok(errors.some((m) => m.includes("诊断字段")), `${forbidden} 应被拒绝：${errors.join("；")}`);
  }
});

test("合法筛查事件（仅指标与 flag）通过，flag 取值受限", () => {
  const event = makeEvent({
    event_type: "HEALTH_SCREENING_RECORDED",
    aggregate_type: "health_screening",
    aggregate_id: "scr-2",
    actor: { actor_id: "dr-1", role: "doctor", org_id: "mch-001" },
    payload: {
      screening_type: "vision",
      observed_at: "2026-09-25T09:40:00+08:00",
      indicators: [{ code: "V001", label: "视力", value: "0.8", flag: "review" }],
      note: "建议复查",
    },
  });
  assert.deepEqual(validateEvent(event), []);
  const bad = validateEvent({
    ...event,
    payload: { ...event.payload, indicators: [{ code: "V001", label: "视力", value: "0.8", flag: "definitely_sick" }] },
  });
  assert.ok(bad.some((m) => m.includes("flag")));
});

test("授权必须有明确有效期，截止早于生效时拒绝", () => {
  const base = {
    event_type: "AUTHORIZATION_GRANTED",
    aggregate_type: "guardian_authorization",
    aggregate_id: "auth-1",
    actor: { actor_id: "g-1", role: "guardian" },
    payload: {
      subject_id: "tc-1",
      subject_role: "temporary_caregiver",
      scope: ["pickup"],
      effective_from: "2026-10-01",
      effective_until: "2026-10-10",
      granted_by: "g-1",
    },
  };
  assert.deepEqual(validateEvent(makeEvent(base)), []);
  const bad = validateEvent(
    makeEvent({ ...base, payload: { ...base.payload, effective_from: "2026-10-11", effective_until: "2026-10-10" } }),
  );
  assert.ok(bad.some((m) => m.includes("有效期")));
});

test("转诊外发只允许白名单最小资料，姓名/联系方式等标识被拒绝", () => {
  const sent = {
    event_type: "REFERRAL_SENT",
    aggregate_type: "referral_handoff",
    aggregate_id: "ref-1",
    linked_event_id: "rec-c-test",
    version: 2,
    actor: { actor_id: "dr-1", role: "doctor", org_id: "mch-001" },
    payload: {
      to_org_id: "mch-001",
      packet: {
        child_id: "c-test",
        month_age: 30,
        reason: "WAZ 待复核",
        indicator_summary: [{ code: "WAZ", flag: "review" }],
      },
    },
  };
  // linked 事件尚不存在属于存储层规则，校验器只验结构，故先构造建档事件占位 id
  assert.deepEqual(validateEvent(makeEvent({ ...sent, linked_event_id: "rec-c-test" })), []);

  const leak = validateEvent(
    makeEvent({
      ...sent,
      payload: {
        to_org_id: "mch-001",
        packet: { ...sent.payload.packet, child_name: "朵朵", phone: "13800000000" },
      },
    }),
  );
  assert.ok(leak.some((m) => m.includes("最小资料之外")), leak.join("；"));
  assert.ok(leak.some((m) => m.includes("禁止外发标识字段")), leak.join("；"));
});

test("转诊发送、处置、告警确认、回访必须通过 linked_event_id 附着原事件", () => {
  for (const type of [
    "REFERRAL_SENT",
    "REFERRAL_DELIVERED",
    "INCIDENT_DISPOSITION_RECORDED",
    "ALERT_ACKNOWLEDGED",
    "FOLLOWUP_RECORDED",
  ]) {
    const event = makeEvent({
      event_type: type,
      aggregate_type: type === "REFERRAL_SENT" ? "referral_handoff" : "x",
      payload: {},
    });
    assert.ok(validateEvent(event).some((m) => m.includes("linked_event_id")), type);
  }
});

test("用药委托必须有监护人明确同意", () => {
  const base = {
    event_type: "MEDICATION_DELEGATION_RECORDED",
    aggregate_type: "medication_delegation",
    aggregate_id: "med-1",
    actor: { actor_id: "g-1", role: "guardian" },
    payload: {
      medication_name: "西替利嗪",
      dose: "5 滴",
      schedule: ["12:30"],
      start_date: "2026-10-04",
      end_date: "2026-10-11",
      instructions: "午餐后服用",
      guardian_consent: false,
    },
  };
  assert.ok(validateEvent(makeEvent(base)).some((m) => m.includes("监护人明确同意")));
  assert.deepEqual(validateEvent(makeEvent({ ...base, payload: { ...base.payload, guardian_consent: true } })), []);
});

test("信封不允许未登记字段与未登记角色", () => {
  assert.ok(validateEvent(makeEvent({ unexpected: "x" })).some((m) => m.includes("信封含未允许字段")));
  assert.ok(
    validateEvent(makeEvent({ actor: { actor_id: "a", role: "janitor" } })).some((m) => m.includes("actor.role")),
  );
});
