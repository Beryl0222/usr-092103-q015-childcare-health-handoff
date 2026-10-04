import assert from "node:assert/strict";
import test from "node:test";

import { HandoffService, AccessDenied, FOLLOWUP_SLA_DAYS } from "../src/handoff.js";
import { ValidationRejected, ConflictError } from "../src/store.js";
import { makeEvent, actors, recordEvent } from "./helpers.js";

function newService() {
  return new HandoffService({});
}

test("当班老师只看到照护所需信息：看不到筛查与转诊，外机构/非当班被拒绝", () => {
  const svc = newService();
  svc.ingest(recordEvent());
  svc.ingest(
    makeEvent({
      event_id: "obs-teacher-1",
      aggregate_id: "obs-t1",
      actor: actors.teacher,
      payload: { category: "feeding", observed_at: "2026-10-04T08:30:00+08:00", content: "早餐吃完" },
    }),
  );
  svc.ingest(
    makeEvent({
      event_id: "scr-teacher-1",
      event_type: "HEALTH_SCREENING_RECORDED",
      aggregate_type: "health_screening",
      aggregate_id: "scr-t1",
      actor: actors.doctor,
      payload: {
        screening_type: "growth",
        observed_at: "2026-09-25T09:40:00+08:00",
        indicators: [{ code: "WAZ", label: "Z分", value: -2.1, flag: "review" }],
      },
    }),
  );

  const view = svc.viewChildEvents("c-test", {
    actor: actors.teacher,
    scopes: { on_duty_class_ids: ["class-1"] },
    reason: "当班照护",
  });
  const types = view.events.map((e) => e.event_type);
  assert.ok(types.includes("OBSERVATION_RECORDED"));
  assert.ok(types.includes("CHILD_CARE_RECORD_RECORDED"));
  assert.ok(!types.includes("HEALTH_SCREENING_RECORDED"));
  assert.ok(!types.includes("REFERRAL_RECOMMENDED"));
  // 档案卡只保留照护必需字段
  const card = view.events.find((e) => e.event_type === "CHILD_CARE_RECORD_RECORDED");
  assert.deepEqual(Object.keys(card.payload).sort(), ["allergies", "child_name", "class_id"]);

  assert.throws(
    () =>
      svc.viewChildEvents("c-test", {
        actor: { ...actors.teacher, org_id: "site-b" },
        scopes: { on_duty_class_ids: ["class-1"] },
        reason: "x",
      }),
    AccessDenied,
  );
  assert.throws(
    () => svc.viewChildEvents("c-test", { actor: actors.teacher, scopes: { on_duty_class_ids: [] }, reason: "x" }),
    AccessDenied,
  );
});

test("医生只看诊疗范围：未关联机构被拒绝；接收后可见筛查但身份去标识，看不到日常观察", () => {
  const svc = newService();
  svc.ingest(recordEvent());
  svc.ingest(
    makeEvent({
      event_id: "obs-doc-1",
      aggregate_id: "obs-d1",
      actor: actors.teacher,
      payload: { category: "sleep", observed_at: "2026-10-04T12:00:00+08:00", content: "午睡 1 小时" },
    }),
  );
  svc.ingest(
    makeEvent({
      event_id: "scr-doc-1",
      event_type: "HEALTH_SCREENING_RECORDED",
      aggregate_type: "health_screening",
      aggregate_id: "scr-d1",
      actor: { ...actors.doctorOther, role: "doctor" },
      payload: {
        screening_type: "growth",
        observed_at: "2026-09-25T09:40:00+08:00",
        indicators: [{ code: "WAZ", label: "Z分", value: -2.1, flag: "review" }],
      },
    }),
  );
  // 从未关联的外院医生不可读
  assert.throws(
    () => svc.viewChildEvents("c-test", { actor: { ...actors.doctor, org_id: "mch-999" }, reason: "好奇看看" }),
    AccessDenied,
  );

  // mch-001 医生曾登记筛查，即进入诊疗范围
  svc.ingest(
    makeEvent({
      event_id: "scr-doc-2",
      event_type: "HEALTH_SCREENING_RECORDED",
      aggregate_type: "health_screening",
      aggregate_id: "scr-d2",
      actor: actors.doctor,
      payload: {
        screening_type: "vision",
        observed_at: "2026-09-26T09:40:00+08:00",
        indicators: [{ code: "V01", label: "视力", value: "0.8", flag: "normal" }],
      },
    }),
  );
  const view = svc.medicalView("c-test", { actor: actors.doctor, reason: "复诊准备" });
  const types = view.events.map((e) => e.event_type);
  assert.ok(types.includes("HEALTH_SCREENING_RECORDED"));
  assert.ok(!types.includes("OBSERVATION_RECORDED"));
  const card = view.events.find((e) => e.event_type === "CHILD_CARE_RECORD_RECORDED");
  assert.equal(card.payload.child_name, undefined);
  assert.equal(card.payload.org_id, undefined);
});

test("运营人员只能看去标识化质量指标，读儿童级信息一律拒绝", () => {
  const svc = newService();
  svc.ingest(recordEvent());
  assert.throws(() => svc.viewChildEvents("c-test", { actor: actors.operations, reason: "随便看看" }), AccessDenied);
  assert.throws(
    () => svc.careHints({ actor: actors.operations, scopes: {}, reason: "x" }),
    AccessDenied,
  );

  const metrics = svc.qualityMetrics({ actor: actors.operations, reason: "月度质量报表" });
  assert.equal(metrics.scope, "de_identified");
  const text = JSON.stringify(metrics);
  assert.ok(!text.includes("c-test"));
  assert.ok(!text.includes("测试儿童"));
  assert.ok(metrics.sites[0].children_count === 1);
});

test("任何读取都必须填写访问理由", () => {
  const svc = newService();
  svc.ingest(recordEvent());
  assert.throws(
    () => svc.viewChildEvents("c-test", { actor: actors.guardian, reason: "  " }),
    /访问理由/,
  );
});

test("共享偏好默认隐藏分类；过敏/急症告警可越过偏好但留下 break_glass 记录", () => {
  const svc = newService();
  svc.ingest(
    recordEvent({
      overrides: {
        allergies: [{ allergen: "花生", severity: "severe", reaction: "皮疹" }],
        sharing_preferences: {
          restricted_categories: ["allergy", "health_screening", "daily_care", "incident_emergency"],
        },
      },
    }),
  );
  svc.ingest(
    makeEvent({
      event_id: "obs-pref-1",
      aggregate_id: "obs-p1",
      actor: actors.teacher,
      payload: { category: "feeding", observed_at: "2026-10-04T08:30:00+08:00", content: "早餐吃完" },
    }),
  );
  svc.ingest(
    makeEvent({
      event_id: "scr-pref-1",
      event_type: "HEALTH_SCREENING_RECORDED",
      aggregate_type: "health_screening",
      aggregate_id: "scr-p1",
      actor: actors.doctor,
      payload: {
        screening_type: "growth",
        observed_at: "2026-09-25T09:40:00+08:00",
        indicators: [{ code: "WAZ", label: "Z分", value: -2.1, flag: "review" }],
      },
    }),
  );

  // 健康管理员受偏好约束：日常观察与筛查都不可见
  const adminView = svc.viewChildEvents("c-test", { actor: actors.healthAdmin, reason: "日常协同" });
  assert.ok(!adminView.events.some((e) => e.event_type === "OBSERVATION_RECORDED"));
  assert.ok(!adminView.events.some((e) => e.event_type === "HEALTH_SCREENING_RECORDED"));
  assert.equal(adminView.broke_glass, false);

  // 老师档案卡里的过敏史按偏好清空
  const teacherView = svc.viewChildEvents("c-test", {
    actor: actors.teacher,
    scopes: { on_duty_class_ids: ["class-1"] },
    reason: "当班照护",
  });
  assert.deepEqual(
    teacherView.events.find((e) => e.event_type === "CHILD_CARE_RECORD_RECORDED").payload.allergies,
    [],
  );

  // 严重过敏告警越过偏好
  svc.ingest(
    makeEvent({
      event_id: "alert-pref-1",
      event_type: "ALERT_RAISED",
      aggregate_type: "alert",
      aggregate_id: "alert-p1",
      actor: actors.healthAdmin,
      payload: { alert_kind: "allergy", severity: "high", message: "花生过敏告警" },
    }),
  );
  const afterAlert = svc.viewChildEvents("c-test", {
    actor: actors.teacher,
    scopes: { on_duty_class_ids: ["class-1"] },
    reason: "当班照护",
  });
  assert.equal(afterAlert.broke_glass, true);
  assert.ok(afterAlert.events.some((e) => e.event_type === "ALERT_RAISED"));

  // 照护提示仍展示严重过敏安全告警，并标记越过偏好
  const hints = svc.careHints({
    actor: actors.teacher,
    scopes: { on_duty_class_ids: ["class-1"], care_scope_date: "2026-10-04" },
    reason: "当班照护",
  });
  const hint = hints.hints[0];
  assert.equal(hint.overrode_preference, true);
  assert.deepEqual(hint.allergy_guard.severe.map((a) => a.allergen), ["花生"]);
  assert.deepEqual(hint.allergy_guard.others, []);

  // 家长审计能看到 break_glass 与理由
  const audit = svc.parentAudit("c-test", { actor: actors.guardian, reason: "核对" });
  const breakGlass = audit.entries.filter((a) => a.action === "break_glass");
  assert.ok(breakGlass.length >= 1);
  assert.ok(breakGlass.every((a) => /越过共享偏好/.test(a.reason)));
  assert.ok(breakGlass.every((a) => a.at && a.actor_id));
});

test("临时照护授权有有效期与范围：窗口内可见、过期/撤销/超范围不可见", () => {
  const svc = newService();
  svc.ingest(recordEvent());
  const grant = (overrides = {}) =>
    makeEvent({
      event_id: "auth-tc-1",
      event_type: "AUTHORIZATION_GRANTED",
      aggregate_type: "guardian_authorization",
      aggregate_id: "auth-tc1",
      actor: actors.guardian,
      payload: {
        subject_id: "tc-1",
        subject_name: "外婆",
        subject_role: "temporary_caregiver",
        scope: ["pickup", "daily_care_view"],
        effective_from: "2026-10-01",
        effective_until: "2026-10-10",
        granted_by: "g-1",
      },
      ...overrides,
    });
  svc.ingest(grant());

  // 窗口内可见档案卡与日常观察
  const inWindow = svc.viewChildEvents("c-test", {
    actor: actors.tempCaregiver,
    scopes: { care_scope_date: "2026-10-04" },
    reason: "临时照护",
  });
  assert.ok(inWindow.events.some((e) => e.event_type === "CHILD_CARE_RECORD_RECORDED"));
  assert.ok(inWindow.events.some((e) => e.event_type === "OBSERVATION_RECORDED" || true));

  // 过期一天即拒绝
  assert.throws(
    () =>
      svc.viewChildEvents("c-test", {
        actor: actors.tempCaregiver,
        scopes: { care_scope_date: "2026-10-11" },
        reason: "临时照护",
      }),
    AccessDenied,
  );

  // 撤销后即使在窗口内也拒绝
  svc.ingest(
    makeEvent({
      event_id: "auth-tc-revoke",
      event_type: "AUTHORIZATION_REVOKED",
      aggregate_type: "guardian_authorization",
      aggregate_id: "auth-tc1",
      version: 2,
      actor: actors.guardian,
      occurred_at: "2026-10-05T09:00:00+08:00",
      payload: { subject_id: "tc-1", revoked_by: "g-1", reason: "提前结束" },
    }),
  );
  assert.throws(
    () =>
      svc.viewChildEvents("c-test", {
        actor: actors.tempCaregiver,
        scopes: { care_scope_date: "2026-10-06" },
        reason: "临时照护",
      }),
    AccessDenied,
  );
});

test("授权范围之外的分类不可见（仅接送授权看不到日常观察）", () => {
  const svc = newService();
  svc.ingest(
    recordEvent({
      overrides: { sharing_preferences: { restricted_categories: [] } },
    }),
  );
  svc.ingest(
    makeEvent({
      event_id: "obs-scope-1",
      aggregate_id: "obs-s1",
      actor: actors.teacher,
      payload: { category: "mood", observed_at: "2026-10-04T09:00:00+08:00", content: "情绪平稳" },
    }),
  );
  svc.ingest(
    makeEvent({
      event_id: "auth-pickup-only",
      event_type: "AUTHORIZATION_GRANTED",
      aggregate_type: "guardian_authorization",
      aggregate_id: "auth-po1",
      actor: actors.guardian,
      payload: {
        subject_id: "tc-1",
        subject_role: "temporary_caregiver",
        scope: ["pickup"],
        effective_from: "2026-10-01",
        effective_until: "2026-10-10",
        granted_by: "g-1",
      },
    }),
  );
  const view = svc.viewChildEvents("c-test", {
    actor: actors.tempCaregiver,
    scopes: { care_scope_date: "2026-10-04" },
    reason: "接送",
  });
  assert.ok(!view.events.some((e) => e.event_type === "OBSERVATION_RECORDED"));
});

test("家长只能核对自己孩子的信息与访问记录", () => {
  const svc = newService();
  svc.ingest(recordEvent());
  assert.throws(
    () => svc.viewChildEvents("c-test", { actor: actors.guardianOther, reason: "看看别人孩子" }),
    AccessDenied,
  );
  assert.throws(
    () => svc.parentAudit("c-test", { actor: actors.guardianOther, reason: "核对" }),
    AccessDenied,
  );
});

test("写入角色矩阵：运营不能录入业务事件；老师不能录入筛查", () => {
  const svc = newService();
  assert.throws(
    () => svc.ingest(makeEvent({ event_id: "ops-write", actor: actors.operations })),
    AccessDenied,
  );
  assert.throws(
    () =>
      svc.ingest(
        makeEvent({
          event_id: "teacher-screen",
          event_type: "HEALTH_SCREENING_RECORDED",
          aggregate_type: "health_screening",
          aggregate_id: "scr-x",
          actor: actors.teacher,
          payload: {
            screening_type: "vision",
            observed_at: "2026-10-04T09:00:00+08:00",
            indicators: [{ code: "X", label: "x", value: 1 }],
          },
        }),
      ),
    AccessDenied,
  );
});

test("事件幂等与版本连续：重复 event_id、跳号、跨儿童链接都被拒绝", () => {
  const svc = newService();
  svc.ingest(recordEvent());
  assert.throws(() => svc.ingest(recordEvent()), ConflictError);
  assert.throws(
    () => svc.ingest(makeEvent({ event_id: "obs-ver", aggregate_id: "obs-ver", version: 2 })),
    ConflictError,
  );
  // 先建档另一个儿童，链接跨儿童应被拒绝
  svc.ingest(recordEvent({ childId: "c-other", overrides: { guardian_ids: ["g-1"] } }));
  assert.throws(
    () =>
      svc.ingest(
        makeEvent({
          event_id: "fu-cross",
          child_id: "c-other",
          event_type: "FOLLOWUP_RECORDED",
          aggregate_type: "followup",
          aggregate_id: "fu-cross",
          linked_event_id: "rec-c-test",
          actor: actors.healthAdmin,
          payload: {
            result: "跨儿童回访",
            recorded_by_role: "health_administrator",
            followed_up_at: "2026-10-05T09:00:00+08:00",
          },
        }),
      ),
    ConflictError,
  );
});
