import assert from "node:assert/strict";
import test from "node:test";

import { HandoffService } from "../src/handoff.js";
import { makeEvent, actors, recordEvent } from "./helpers.js";

function setupReferral({ followupDays = 7, followupType = "FOLLOWUP_COMPLETED" } = {}) {
  const svc = new HandoffService({});
  svc.ingest(recordEvent());

  const screening = makeEvent({
    event_id: "scr-ref-1",
    event_type: "HEALTH_SCREENING_RECORDED",
    aggregate_type: "health_screening",
    aggregate_id: "scr-ref1",
    actor: actors.doctor,
    payload: {
      screening_type: "growth",
      observed_at: "2026-09-25T09:40:00+08:00",
      indicators: [{ code: "WAZ", label: "年龄别体重Z分", value: -2.1, flag: "review" }],
    },
  });
  svc.ingest(screening);

  const recommend = makeEvent({
    event_id: "ref-rec-1",
    event_type: "REFERRAL_RECOMMENDED",
    aggregate_type: "referral_handoff",
    aggregate_id: "ref-1",
    occurred_at: "2026-09-25T15:20:00+08:00",
    actor: actors.doctor,
    payload: {
      to_org_id: "mch-001",
      reason: "WAZ=-2.1 待复核",
      urgency: "routine",
      linked_screening_event_id: "scr-ref-1",
    },
  });
  svc.ingest(recommend);

  svc.ingest(
    makeEvent({
      event_id: "ref-sent-1",
      event_type: "REFERRAL_SENT",
      aggregate_type: "referral_handoff",
      aggregate_id: "ref-1",
      occurred_at: "2026-09-26T09:30:00+08:00",
      version: 2,
      linked_event_id: "ref-rec-1",
      actor: actors.doctor,
      payload: {
        to_org_id: "mch-001",
        packet: {
          child_id: "c-test",
          month_age: 30,
          sex: "female",
          urgency: "routine",
          reason: "WAZ=-2.1 待复核",
          indicator_summary: [{ code: "WAZ", flag: "review" }],
          allergies: [{ allergen: "花生", severity: "severe" }],
        },
      },
    }),
  );
  svc.ingest(
    makeEvent({
      event_id: "ref-del-1",
      event_type: "REFERRAL_DELIVERED",
      aggregate_type: "referral_handoff",
      aggregate_id: "ref-1",
      occurred_at: "2026-09-26T10:05:00+08:00",
      version: 3,
      linked_event_id: "ref-sent-1",
      actor: { ...actors.healthAdmin, org_id: "mch-001" },
      payload: { receiver_org_id: "mch-001", receiver_actor_id: "ha-mch-1", received_at: "2026-09-26T10:02:00+08:00" },
    }),
  );
  svc.ingest(
    makeEvent({
      event_id: "ref-acc-1",
      event_type: "REFERRAL_ACCEPTED",
      aggregate_type: "referral_handoff",
      aggregate_id: "ref-1",
      occurred_at: "2026-09-26T10:20:00+08:00",
      version: 4,
      linked_event_id: "ref-del-1",
      actor: actors.doctor,
      payload: { accepted_by: "dr-1", appointment_at: "2026-09-29T09:00:00+08:00" },
    }),
  );

  // 回访挂在建议事件上；late 与否取决于距建议发生的天数
  const fuDate = new Date(Date.parse("2026-09-25T15:20:00+08:00") + followupDays * 86_400_000);
  svc.ingest(
    makeEvent({
      event_id: "fu-1",
      event_type: followupType,
      aggregate_type: "followup",
      aggregate_id: "fu-ref1",
      linked_event_id: "ref-rec-1",
      actor: actors.doctor,
      payload: {
        result: "已到院评估，给予喂养指导",
        outcome: followupType === "FOLLOWUP_COMPLETED" ? "completed" : "ongoing",
        recorded_by_role: "doctor",
        followed_up_at: fuDate.toISOString(),
      },
    }),
  );
  return svc;
}

test("转诊状态机：recommended → sent → delivered → accepted，并确认最小资料内容", () => {
  const svc = setupReferral();
  const tracking = svc.referralTracking({ actor: actors.doctor, reason: "追踪转诊闭环" });
  const ref = tracking.referrals.find((r) => r.recommendation_event_id === "ref-rec-1");
  assert.equal(ref.status, "accepted");
  assert.ok(ref.delivered_at);
  assert.ok(ref.accepted_at);
  assert.equal(ref.recommendation_completed, true);
  assert.equal(ref.followups.length, 1);
  assert.equal(ref.followups[0].late, false);
  assert.equal(ref.followups[0].attached_to, "ref-rec-1");
});

test("未送达的转诊停留在 sent_awaiting_receipt，外发审计记为 share", () => {
  const svc = new HandoffService({});
  svc.ingest(recordEvent());
  svc.ingest(
    makeEvent({
      event_id: "r-rec",
      event_type: "REFERRAL_RECOMMENDED",
      aggregate_type: "referral_handoff",
      aggregate_id: "ref-2",
      actor: actors.doctor,
      payload: { to_org_id: "mch-001", reason: "视力待复查", urgency: "urgent" },
    }),
  );
  svc.ingest(
    makeEvent({
      event_id: "r-sent",
      event_type: "REFERRAL_SENT",
      aggregate_type: "referral_handoff",
      aggregate_id: "ref-2",
      version: 2,
      linked_event_id: "r-rec",
      actor: actors.doctor,
      payload: { to_org_id: "mch-001", packet: { child_id: "c-test", reason: "视力待复查", urgency: "urgent" } },
    }),
  );
  const ref = svc.referralTracking({ actor: actors.doctor, reason: "追踪" }).referrals[0];
  assert.equal(ref.status, "sent_awaiting_receipt");

  const audit = svc.parentAudit("c-test", { actor: actors.guardian, reason: "核对外发记录" });
  const share = audit.entries.find((a) => a.action === "share");
  assert.ok(share);
  assert.match(share.reason, /最小资料包/);
});

test("迟到回访附着原事件、不覆盖现场记录，并计入迟到指标", () => {
  const svc = new HandoffService({});
  svc.ingest(recordEvent());
  svc.ingest(
    makeEvent({
      event_id: "inc-1",
      event_type: "INCIDENT_RAISED",
      aggregate_type: "incident",
      aggregate_id: "inc-1",
      occurred_at: "2026-10-04T11:40:00+08:00",
      actor: actors.teacher,
      payload: {
        incident_type: "allergy",
        severity: "high",
        occurred_at: "2026-10-04T11:35:00+08:00",
        description: "疑似花生接触过敏",
        on_site_handling: "停止进食、清水冲洗、通知监护人",
      },
    }),
  );
  // 迟到 11 天的回访
  svc.ingest(
    makeEvent({
      event_id: "fu-late",
      event_type: "FOLLOWUP_RECORDED",
      aggregate_type: "followup",
      aggregate_id: "fu-late1",
      occurred_at: "2026-10-15T10:00:00+08:00",
      linked_event_id: "inc-1",
      actor: actors.healthAdmin,
      payload: {
        result: "电话回访未复发",
        outcome: "completed",
        recorded_by_role: "health_administrator",
        followed_up_at: "2026-10-15T09:50:00+08:00",
      },
    }),
  );

  // 原突发事件的现场记录原封不动
  const incident = svc.store.getEvent("inc-1");
  assert.equal(incident.payload.on_site_handling, "停止进食、清水冲洗、通知监护人");
  assert.equal(incident.payload.description, "疑似花生接触过敏");

  // 回访以追加事件存在，且 linked_event_id 指向现场事件
  const followup = svc.store.getEvent("fu-late");
  assert.equal(followup.linked_event_id, "inc-1");

  const metrics = svc.qualityMetrics({ actor: actors.operations, reason: "月度质量报表" }).sites[0];
  assert.equal(metrics.followups.late, 1);
  assert.equal(metrics.followups.recorded, 1);
});

test("质量指标全部去标识化：不出现儿童 ID、姓名，只含聚合计数", () => {
  const svc = setupReferral({ followupDays: 12 }); // 制造一条迟到回访
  svc.ingest(
    makeEvent({
      event_id: "alert-q-1",
      event_type: "ALERT_RAISED",
      aggregate_type: "alert",
      aggregate_id: "alert-q1",
      occurred_at: "2026-10-04T11:41:00+08:00",
      actor: actors.healthAdmin,
      payload: { alert_kind: "allergy", severity: "high", message: "花生过敏告警（质量指标里不应出现本句）" },
    }),
  );
  svc.ingest(
    makeEvent({
      event_id: "alert-q-ack",
      event_type: "ALERT_ACKNOWLEDGED",
      aggregate_type: "alert",
      aggregate_id: "alert-q1",
      version: 2,
      occurred_at: "2026-10-04T11:46:00+08:00",
      linked_event_id: "alert-q-1",
      actor: actors.teacher,
      payload: { acknowledged_by: "t-1", acknowledged_at: "2026-10-04T11:46:00+08:00" },
    }),
  );

  const result = svc.qualityMetrics({ actor: actors.operations, reason: "季度报表" });
  const text = JSON.stringify(result);
  for (const forbidden of ["c-test", "测试儿童", "花生过敏告警（质量指标里不应出现本句）", "g-1"]) {
    assert.ok(!text.includes(forbidden), `指标中泄漏了：${forbidden}`);
  }
  const site = result.sites[0];
  assert.equal(site.children_count, 1);
  assert.equal(site.referrals.recommended, 1);
  assert.equal(site.referrals.delivered, 1);
  assert.equal(site.referrals.accepted, 1);
  assert.equal(site.referrals.receipt_rate, 1);
  assert.equal(site.followups.late, 1);
  assert.equal(site.alerts.raised, 1);
  assert.equal(site.alerts.acknowledged, 1);
  assert.equal(site.alerts.ack_minutes_p50, 5);
  // 审计本身记录的是去标识化访问
  const audit = svc.parentAudit("c-test", { actor: actors.guardian, reason: "核对" });
  // 运营访问不出现儿童级审计（child_id 为 *），家长核对 c-test 时看不到运营行
  assert.ok(!audit.entries.some((a) => a.actor_role === "operations"));
});

test("家长审计可核对谁在何时查看和处理：写入、查看、越权、外发均可追溯", () => {
  const svc = setupReferral();
  svc.viewChildEvents("c-test", {
    actor: actors.teacher,
    scopes: { on_duty_class_ids: ["class-1"] },
    reason: "当班照护查看",
  });
  svc.referralTracking({ actor: actors.doctor, reason: "医疗团队追踪建议接收情况" });

  const audit = svc.parentAudit("c-test", { actor: actors.guardian, reason: "家长核对" });
  const entries = audit.entries;
  // 至少包含：建档 handle、转诊发送 share、老师 view、医生 view
  assert.ok(entries.some((e) => e.action === "handle" && e.event_type === "CHILD_CARE_RECORD_RECORDED"));
  assert.ok(entries.some((e) => e.action === "share" && e.event_type === "REFERRAL_SENT"));
  assert.ok(entries.some((e) => e.action === "view" && e.actor_id === "t-1" && e.reason === "当班照护查看"));
  assert.ok(entries.every((e) => e.at && e.reason));
  // 时间有序
  const times = entries.map((e) => e.at);
  assert.deepEqual(times, [...times].sort());
});
