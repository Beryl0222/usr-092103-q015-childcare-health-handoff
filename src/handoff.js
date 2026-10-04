/**
 * 医育联动健康接力领域服务：
 * 在追加事件之上构建当班照护提示、医疗视图、转诊跟踪、
 * 去标识化质量指标与家长可核对的访问记录。
 */
import { randomUUID } from "node:crypto";
import { validateEvent } from "./validator.js";
import { EventStore, ValidationRejected, ConflictError } from "./store.js";
import { categoryOf, decideEventAccess, isOverrideAlert, redactForRole, WRITER_ROLES } from "./policy.js";

/** 回访时效：超过该天数记为迟到回访（仍附着原事件，不覆盖现场记录）。 */
export const FOLLOWUP_SLA_DAYS = 7;

export class AccessDenied extends Error {
  constructor(message) {
    super(message);
    this.name = "AccessDenied";
  }
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  return Math.round((b - a) / 86_400_000);
}

function minutesBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
}

export class HandoffService {
  /**
   * @param {{store?: EventStore, dir?: string}} options
   */
  constructor({ store, dir } = {}) {
    this.store = store ?? new EventStore({ dir });
  }

  /* ------------------------------------------------------------------ */
  /* 写入                                                                */
  /* ------------------------------------------------------------------ */

  /** 校验并追加一条事件；写入本身作为 handle 留痕，转诊外发记为 share。 */
  ingest(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) throw new ValidationRejected(errors);
    const allowedWriters = WRITER_ROLES[event.event_type] ?? [];
    if (!allowedWriters.includes(event.actor.role)) {
      throw new AccessDenied(`${event.actor.role} 不允许写入 ${event.event_type}`);
    }
    const stored = this.store.append(event);

    const action = event.event_type === "REFERRAL_SENT" ? "share" : "handle";
    this.#audit({
      child_id: event.child_id,
      actor: event.actor,
      action,
      categories: [categoryOf(event)],
      reason:
        event.event_type === "REFERRAL_SENT"
          ? "跨机构转诊：发送最小资料包"
          : `记录事件 ${event.event_type}`,
      eventType: event.event_type,
      linkedEventId: event.linked_event_id,
    });
    return stored;
  }

  /* ------------------------------------------------------------------ */
  /* 儿童画像（由事件流归约得到）                                         */
  /* ------------------------------------------------------------------ */

  #profile(childId) {
    const events = this.store
      .eventsForChild(childId)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    const record = events.find((e) => e.event_type === "CHILD_CARE_RECORD_RECORDED");
    if (!record) return null;

    // 授权按 subject_id 归约：最新授予/更新 + 是否被撤销。
    const authorizations = new Map();
    for (const e of events) {
      if (e.event_type === "AUTHORIZATION_GRANTED" || e.event_type === "AUTHORIZATION_UPDATED") {
        authorizations.set(e.payload.subject_id, { ...e.payload, revoked: false });
      } else if (e.event_type === "AUTHORIZATION_REVOKED") {
        const current = authorizations.get(e.payload.subject_id);
        if (current) current.revoked = true;
      }
    }

    // 过敏史以档案登记为准（医疗侧的更正通过新档案版本事件表达）。
    const allergies = record.payload.allergies ?? [];
    return { record, events, allergies, authorizations: [...authorizations.values()] };
  }

  /** 某主体在指定日期是否持有有效授权（未撤销且在有效期内）。 */
  #activeAuthorization(profile, subjectId, date) {
    const auth = profile.authorizations.find((a) => a.subject_id === subjectId);
    if (!auth || auth.revoked) return null;
    if (date < auth.effective_from || date > auth.effective_until) return null;
    return auth;
  }

  #restrictedCategories(profile) {
    return profile.record.payload.sharing_preferences?.restricted_categories ?? [];
  }

  /** 医生诊疗范围：本机构曾接收转诊、或本机构医生已对该儿童留下诊疗事件。 */
  #inTreatmentScope(events, actor) {
    if (!actor.org_id) return false;
    return events.some((e) => {
      if (e.actor?.role === "doctor" && e.actor?.org_id === actor.org_id) return true;
      if (
        (e.event_type === "REFERRAL_DELIVERED" || e.event_type === "REFERRAL_ACCEPTED") &&
        e.linked_event_id
      ) {
        const sent = this.store.getEvent(e.linked_event_id);
        return sent?.payload?.to_org_id === actor.org_id;
      }
      return false;
    });
  }

  /* ------------------------------------------------------------------ */
  /* 读取：角色视图                                                      */
  /* ------------------------------------------------------------------ */

  #requireReason(reason) {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new AccessDenied("读取儿童信息必须填写访问理由");
    }
  }

  #viewerContext(profile, actor, scopes = {}) {
    const date = scopes.care_scope_date ?? new Date().toISOString().slice(0, 10);
    const record = profile.record;
    const onDuty =
      actor.role === "teacher" &&
      actor.org_id === record.payload.org_id &&
      (scopes.on_duty_class_ids ?? []).includes(record.payload.class_id);
    return {
      date,
      onDuty,
      inTreatmentScope: actor.role === "doctor" ? this.#inTreatmentScope(profile.events, actor) : undefined,
      activeAuthorization:
        actor.role === "temporary_caregiver"
          ? this.#activeAuthorization(profile, scopes.as_subject_id ?? actor.actor_id, date)
          : undefined,
      restrictedCategories: this.#restrictedCategories(profile),
    };
  }

  #checkBaseEntitlement(profile, actor, scopes = {}) {
    const record = profile.record;
    switch (actor.role) {
      case "guardian":
        if (!record.payload.guardian_ids.includes(actor.actor_id)) {
          throw new AccessDenied("监护人只能查看本人孩子的信息");
        }
        return;
      case "health_administrator":
        if (actor.org_id !== record.payload.org_id) {
          throw new AccessDenied("健康管理员只能查看本机构儿童的信息");
        }
        return;
      case "teacher":
        if (!this.#viewerContext(profile, actor, scopes).onDuty) {
          throw new AccessDenied("老师只能查看当班班级儿童的照护信息");
        }
        return;
      case "doctor":
        if (!this.#viewerContext(profile, actor, scopes).inTreatmentScope) {
          throw new AccessDenied("该儿童不在医生当前诊疗范围内");
        }
        return;
      case "temporary_caregiver":
        if (!this.#viewerContext(profile, actor, scopes).activeAuthorization) {
          throw new AccessDenied("临时照护授权不存在、已撤销或已过有效期");
        }
        return;
      case "operations":
        throw new AccessDenied("运营人员不可读取儿童级信息，只能查看去标识化质量指标");
      default:
        throw new AccessDenied("未知角色");
    }
  }

  /** 按角色读取儿童事件流；每次读取写审计，越权看过敏/急症记 break_glass。 */
  viewChildEvents(childId, request) {
    const { actor, scopes, reason } = request;
    this.#requireReason(reason);
    const profile = this.#profile(childId);
    if (!profile) throw new AccessDenied("儿童档案不存在");
    this.#checkBaseEntitlement(profile, actor, scopes);

    const ctx = this.#viewerContext(profile, actor, scopes);
    // 诊疗范围内的医生可按诊疗需要读取临床分类（含档案内嵌过敏史），偏好不做字段剔除。
    const effectiveRestricted =
      actor.role === "doctor" && ctx.inTreatmentScope
        ? (ctx.restrictedCategories ?? []).filter(
            (c) => !["health_screening", "medical_plan", "followup", "allergy", "incident_emergency"].includes(c),
          )
        : (ctx.restrictedCategories ?? []);
    const visible = [];
    let brokeGlass = false;
    for (const event of profile.events) {
      const decision = decideEventAccess(event, actor, ctx);
      if (!decision.allowed) continue;
      if (decision.overriddenPreference) brokeGlass = true;
      visible.push(redactForRole(event, actor.role, effectiveRestricted));
    }

    const categories = [...new Set(visible.map(categoryOf))];
    this.#audit({
      child_id: childId,
      actor,
      action: brokeGlass ? "break_glass" : "view",
      categories,
      reason: brokeGlass ? `${reason}（越过共享偏好查看过敏/急症告警）` : reason,
    });
    return { child_id: childId, events: visible, broke_glass: brokeGlass };
  }

  /**
   * 当班照护提示：托育点当天可直接照做的清单。
   * 只面向当班老师与本机构健康管理员。
   */
  careHints(request) {
    const { actor, scopes, reason } = request;
    this.#requireReason(reason);
    if (actor.role !== "teacher" && actor.role !== "health_administrator") {
      throw new AccessDenied("照护提示仅向当班老师与健康管理员开放");
    }
    const date = scopes?.care_scope_date ?? new Date().toISOString().slice(0, 10);
    const onDutyClassIds = scopes?.on_duty_class_ids ?? [];

    const childIds = [
      ...new Set(
        this.store
          .allEvents()
          .filter((e) => e.event_type === "CHILD_CARE_RECORD_RECORDED")
          .filter((e) => e.payload.org_id === actor.org_id)
          .filter((e) => actor.role === "health_administrator" || onDutyClassIds.includes(e.payload.class_id))
          .map((e) => e.child_id),
      ),
    ];

    const hints = childIds.map((childId) => this.#buildCareHint(childId, date)).filter(Boolean);
    // 批量查看也要按儿童逐条留痕，家长才能核对当班查看；
    // 若提示中包含越过偏好的过敏/急症告警，记 break_glass。
    for (const hint of hints) {
      this.#audit({
        child_id: hint.child_id,
        actor,
        action: hint.overrode_preference ? "break_glass" : "view",
        categories: ["daily_care", "allergy", "medical_plan", "incident_emergency", "identity"],
        reason: hint.overrode_preference ? `${reason}（越过共享偏好查看过敏/急症告警）` : reason,
      });
    }
    return { date, org_id: actor.org_id ?? null, hints };
  }

  #buildCareHint(childId, date) {
    const profile = this.#profile(childId);
    if (!profile) return null;
    const p = profile.record.payload;
    const restricted = new Set(this.#restrictedCategories(profile));
    let overrodePreference = false;

    const severeAllergies = profile.allergies.filter((a) => a.severity === "severe");
    const otherAllergies = profile.allergies.filter((a) => a.severity !== "severe");

    // 当天有效用药委托（监护人已通过委托明确同意照护方执行，偏好不遮挡）。
    const medications = profile.events
      .filter((e) => e.event_type === "MEDICATION_DELEGATION_RECORDED")
      .filter((e) => date >= e.payload.start_date && date <= e.payload.end_date)
      .map((e) => ({
        medication_name: e.payload.medication_name,
        dose: e.payload.dose,
        schedule: e.payload.schedule,
        instructions: e.payload.instructions,
      }));

    // 未解除的过敏/急症告警与未处置的高等级突发事件。
    // 过敏/急症告警可越过共享偏好，但必须留下访问理由（由调用方记 break_glass）。
    const ackedAlertIds = new Set(
      profile.events.filter((e) => e.event_type === "ALERT_ACKNOWLEDGED").map((e) => e.linked_event_id),
    );
    const disposedIncidentIds = new Set(
      profile.events
        .filter((e) => e.event_type === "INCIDENT_DISPOSITION_RECORDED")
        .map((e) => e.linked_event_id),
    );
    const emergencyRestricted = restricted.has("incident_emergency");
    const activeAlerts = profile.events
      .filter((e) => e.event_type === "ALERT_RAISED" && !ackedAlertIds.has(e.event_id))
      .map((e) => ({ kind: e.payload.alert_kind, severity: e.payload.severity, message: e.payload.message }));
    if (emergencyRestricted && activeAlerts.length > 0) overrodePreference = true;
    const openIncidents = profile.events
      .filter(
        (e) =>
          e.event_type === "INCIDENT_RAISED" &&
          !disposedIncidentIds.has(e.event_id) &&
          (isOverrideAlert(e) || e.payload.severity === "medium"),
      )
      .map((e) => ({
        type: e.payload.incident_type,
        severity: e.payload.severity,
        description: e.payload.description,
        on_site_handling: e.payload.on_site_handling,
      }));
    if (emergencyRestricted && openIncidents.some((i) => i.severity === "high" || i.type === "allergy")) {
      overrodePreference = true;
    }
    // 当天已处置的突发事件仍需当班持续观察（偏好限制时仅保留安全相关）。
    const handledToday = profile.events
      .filter((e) => e.event_type === "INCIDENT_DISPOSITION_RECORDED")
      .map((disp) => {
        const incident = this.store.getEvent(disp.linked_event_id);
        if (!incident || incident.payload.occurred_at.slice(0, 10) !== date) return null;
        if (
          restricted.has("incident_emergency") &&
          !(isOverrideAlert(incident))
        ) {
          return null;
        }
        if (restricted.has("incident_emergency") && isOverrideAlert(incident)) overrodePreference = true;
        return {
          type: incident.payload.incident_type,
          severity: incident.payload.severity,
          actions: disp.payload.actions,
          disposition_at: disp.payload.disposition_at,
          continue_observation: "处置后当班期间继续观察",
        };
      })
      .filter(Boolean);

    // 当天喂养/情绪观察提要（老师自己记录的当班上下文）。
    const todaysObservations = restricted.has("daily_care")
      ? []
      : profile.events
          .filter((e) => e.event_type === "OBSERVATION_RECORDED")
          .filter((e) => e.payload.observed_at.slice(0, 10) === date)
          .map((e) => ({ category: e.payload.category, content: e.payload.content }));

    // 当天有效接送授权（临时照护人）。
    const pickupRoster = profile.authorizations
      .filter((a) => !a.revoked && date >= a.effective_from && date <= a.effective_until)
      .filter((a) => a.scope.includes("pickup"))
      .map((a) => ({
        subject_name: a.subject_name ?? a.subject_id,
        relation: a.relation ?? null,
        effective_from: a.effective_from,
        effective_until: a.effective_until,
        expires: a.effective_until === date,
      }));

    // 过敏史受偏好保护；但严重过敏属于安全告警，仍需提示并记 break_glass。
    const allergyRestricted = restricted.has("allergy");
    if (allergyRestricted) {
      if (severeAllergies.length > 0) overrodePreference = true;
    }
    const allergyGuard = allergyRestricted
      ? {
          has_allergy: severeAllergies.length > 0,
          severe: severeAllergies,
          others: [],
          preference_note: severeAllergies.length > 0 ? "监护人限制过敏史共享：仅展示严重过敏安全告警" : "监护人限制过敏史共享",
        }
      : {
          has_allergy: profile.allergies.length > 0,
          severe: severeAllergies,
          others: otherAllergies,
        };

    return {
      child_id: childId,
      child_name: p.child_name,
      class_id: p.class_id ?? null,
      allergy_guard: allergyGuard,
      medications_today: medications,
      active_alerts: activeAlerts,
      open_incidents: emergencyRestricted ? openIncidents.filter((i) => i.severity === "high" || i.type === "allergy") : openIncidents,
      handled_today: handledToday,
      todays_observations: todaysObservations,
      pickup_roster: pickupRoster,
      overrode_preference: overrodePreference,
    };
  }

  /** 医生诊疗视图：筛查指标（无诊断）、转诊、急症、回访，不含日常照护观察。 */
  medicalView(childId, request) {
    const view = this.viewChildEvents(childId, request);
    const medicalOnly = view.events.filter((e) =>
      ["health_screening", "medical_plan", "incident_emergency", "followup", "identity"].includes(
        categoryOf(e),
      ),
    );
    return {
      child_id: childId,
      events: medicalOnly,
      referrals: this.#referralsForChild(childId),
      broke_glass: view.broke_glass,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 转诊：最小资料 + 接收确认 + 建议闭环跟踪                             */
  /* ------------------------------------------------------------------ */

  #rootEvent(eventId) {
    let current = this.store.getEvent(eventId);
    const guard = new Set();
    while (current?.linked_event_id && !guard.has(current.event_id)) {
      guard.add(current.event_id);
      current = this.store.getEvent(current.linked_event_id);
    }
    return current;
  }

  #referralsForChild(childId) {
    const events = this.store.eventsForChild(childId);
    return events
      .filter((e) => e.event_type === "REFERRAL_RECOMMENDED")
      .map((rec) => {
        const chain = events.filter((e) => e.linked_event_id && this.#rootEvent(e.linked_event_id)?.event_id === rec.event_id);
        const sent = chain.find((e) => e.event_type === "REFERRAL_SENT");
        const delivered = chain.find((e) => e.event_type === "REFERRAL_DELIVERED");
        const accepted = chain.find((e) => e.event_type === "REFERRAL_ACCEPTED");
        const followups = chain.filter((e) =>
          ["FOLLOWUP_RECORDED", "FOLLOWUP_COMPLETED"].includes(e.event_type),
        );
        const completed =
          followups.some((f) => f.event_type === "FOLLOWUP_COMPLETED" || f.payload.outcome === "completed");
        return {
          recommendation_event_id: rec.event_id,
          child_id: childId,
          to_org_id: rec.payload.to_org_id,
          urgency: rec.payload.urgency,
          reason: rec.payload.reason,
          status: accepted
            ? "accepted"
            : delivered
              ? "delivered"
              : sent
                ? "sent_awaiting_receipt"
                : "recommended",
          sent_at: sent?.occurred_at ?? null,
          delivered_at: delivered?.payload.received_at ?? delivered?.occurred_at ?? null,
          accepted_at: accepted?.occurred_at ?? null,
          followups: followups.map((f) => ({
            event_id: f.event_id,
            result: f.payload.result,
            outcome: f.payload.outcome ?? null,
            followed_up_at: f.payload.followed_up_at,
            late: daysBetween(rec.occurred_at, f.payload.followed_up_at) > FOLLOWUP_SLA_DAYS,
            attached_to: f.linked_event_id,
          })),
          recommendation_completed: completed,
        };
      });
  }

  /** 医疗团队（妇幼机构）追踪转诊建议是否被接收与完成。 */
  referralTracking(request) {
    const { actor, reason } = request;
    this.#requireReason(reason);
    if (actor.role !== "doctor" && actor.role !== "health_administrator") {
      throw new AccessDenied("转诊跟踪仅向医疗团队与健康管理员开放");
    }
    const recommendationIds = new Set();
    for (const event of this.store.allEvents()) {
      if (event.event_type !== "REFERRAL_RECOMMENDED") continue;
      if (actor.role === "health_administrator" && event.actor.org_id !== actor.org_id) continue;
      if (actor.role === "doctor") {
        // 医生可看本机构作为发起方或接收方的转诊。
        const sentToMe = this.store
          .eventsForChild(event.child_id)
          .some((e) => e.event_type === "REFERRAL_SENT" && e.payload.to_org_id === actor.org_id);
        const initiatedByMe = event.actor.org_id === actor.org_id;
        if (!sentToMe && !initiatedByMe) continue;
      }
      recommendationIds.add(`${event.child_id}:${event.event_id}`);
    }
    const referrals = [...recommendationIds].map((key) => {
      const [childId, recId] = key.split(/:(.*)/s);
      return this.#referralsForChild(childId).find((r) => r.recommendation_event_id === recId);
    });
    for (const { child_id } of referrals) {
      this.#audit({
        child_id: child_id,
        actor,
        action: "view",
        categories: ["medical_plan", "followup"],
        reason,
      });
    }
    return { referrals };
  }

  /* ------------------------------------------------------------------ */
  /* 运营：去标识化质量指标（无 child_id、姓名等任何儿童标识）             */
  /* ------------------------------------------------------------------ */

  qualityMetrics(request) {
    const { actor, reason } = request;
    this.#requireReason(reason);
    if (actor.role !== "operations" && actor.role !== "health_administrator") {
      throw new AccessDenied("质量指标仅向运营人员开放");
    }
    const events = this.store.allEvents();
    const records = events.filter((e) => e.event_type === "CHILD_CARE_RECORD_RECORDED");
    const bySite = new Map();

    const bucket = (orgId) => {
      const key = orgId ?? "UNASSIGNED_SITE";
      if (!bySite.has(key)) {
        bySite.set(key, {
          site_code: key,
          children_count: 0,
          events_by_type: {},
          screening: { screenings: 0, indicators: 0, review: 0, risk: 0, children_with_risk: 0 },
          referrals: { recommended: 0, sent: 0, delivered: 0, accepted: 0 },
          followups: { recorded: 0, completed: 0, late: 0 },
          alerts: { raised: 0, acknowledged: 0, ack_minutes_p50: null },
          incidents: { total: 0, allergy: 0, high: 0 },
        });
      }
      return bySite.get(key);
    };

    const siteOfChild = new Map(records.map((e) => [e.child_id, e.payload.org_id]));
    for (const r of records) bucket(r.payload.org_id).children_count += 1;

    // 告警确认时长按"发起站点"归并：raised 事件决定归属，ack 挂到同一告警。
    const ackMinutesBySite = new Map();
    const siteOfAlert = new Map();
    const ackMinutesFor = (site) => {
      if (!ackMinutesBySite.has(site)) ackMinutesBySite.set(site, []);
      return ackMinutesBySite.get(site);
    };
    for (const event of events) {
      const m = bucket(siteOfChild.get(event.child_id));
      m.events_by_type[event.event_type] = (m.events_by_type[event.event_type] ?? 0) + 1;
      switch (event.event_type) {
        case "HEALTH_SCREENING_RECORDED": {
          m.screening.screenings += 1;
          let hasRisk = false;
          for (const ind of event.payload.indicators) {
            m.screening.indicators += 1;
            if (ind.flag === "review") m.screening.review += 1;
            if (ind.flag === "risk") {
              m.screening.risk += 1;
              hasRisk = true;
            }
          }
          if (hasRisk) m.screening.children_with_risk += 1;
          break;
        }
        case "REFERRAL_RECOMMENDED":
          m.referrals.recommended += 1;
          break;
        case "REFERRAL_SENT":
          m.referrals.sent += 1;
          break;
        case "REFERRAL_DELIVERED":
          m.referrals.delivered += 1;
          break;
        case "REFERRAL_ACCEPTED":
          m.referrals.accepted += 1;
          break;
        case "FOLLOWUP_RECORDED":
        case "FOLLOWUP_COMPLETED": {
          m.followups.recorded += 1;
          if (event.event_type === "FOLLOWUP_COMPLETED" || event.payload.outcome === "completed") {
            m.followups.completed += 1;
          }
          const root = this.#rootEvent(event.linked_event_id);
          if (root && daysBetween(root.occurred_at, event.payload.followed_up_at) > FOLLOWUP_SLA_DAYS) {
            m.followups.late += 1;
          }
          break;
        }
        case "ALERT_RAISED":
          siteOfAlert.set(event.event_id, siteOfChild.get(event.child_id));
          m.alerts.raised += 1;
          break;
        case "ALERT_ACKNOWLEDGED": {
          m.alerts.acknowledged += 1;
          const raised = this.store.getEvent(event.linked_event_id);
          if (raised) {
            ackMinutesFor(siteOfAlert.get(raised.event_id)).push(
              minutesBetween(raised.occurred_at, event.occurred_at),
            );
          }
          break;
        }
        case "INCIDENT_RAISED":
          m.incidents.total += 1;
          if (event.payload.incident_type === "allergy") m.incidents.allergy += 1;
          if (event.payload.severity === "high") m.incidents.high += 1;
          break;
        default:
          break;
      }
    }

    const sites = [...bySite.values()];
    for (const site of sites) {
      const minutes = (ackMinutesBySite.get(site.site_code) ?? []).slice().sort((a, b) => a - b);
      if (minutes.length > 0) {
        site.alerts.ack_minutes_p50 = minutes[Math.floor(minutes.length / 2)];
      }
      site.screening.risk_rate = site.screening.indicators
        ? Number((site.screening.risk / site.screening.indicators).toFixed(4))
        : null;
      site.referrals.receipt_rate = site.referrals.sent
        ? Number((site.referrals.delivered / site.referrals.sent).toFixed(4))
        : null;
      site.referrals.acceptance_rate = site.referrals.delivered
        ? Number((site.referrals.accepted / site.referrals.delivered).toFixed(4))
        : null;
      site.followups.late_rate = site.followups.recorded
        ? Number((site.followups.late / site.followups.recorded).toFixed(4))
        : null;
    }

    this.#audit({
      child_id: "*",
      actor,
      action: "view",
      categories: [],
      reason: `去标识化质量指标：${reason}`,
    });
    return { scope: "de_identified", generated_at: new Date().toISOString(), sites };
  }

  /* ------------------------------------------------------------------ */
  /* 家长：谁在何时查看/处理/外发                                         */
  /* ------------------------------------------------------------------ */

  parentAudit(childId, request) {
    const { actor, reason } = request;
    this.#requireReason(reason);
    const profile = this.#profile(childId);
    if (!profile) throw new AccessDenied("儿童档案不存在");
    if (actor.role !== "guardian" || !profile.record.payload.guardian_ids.includes(actor.actor_id)) {
      throw new AccessDenied("只有监护人可以核对孩子的访问记录");
    }
    const entries = this.store.auditForChild(childId);
    this.#audit({ child_id: childId, actor, action: "view", categories: ["identity"], reason });
    return { child_id: childId, entries };
  }

  /* ------------------------------------------------------------------ */

  #audit({ child_id, actor, action, categories, reason, eventType, linkedEventId }) {
    return this.store.addAudit({
      audit_id: randomUUID(),
      child_id,
      actor_id: actor.actor_id,
      actor_role: actor.role,
      org_id: actor.org_id ?? null,
      action,
      categories,
      reason,
      at: new Date().toISOString(),
      event_type: eventType ?? null,
      linked_event_id: linkedEventId ?? null,
    });
  }
}
