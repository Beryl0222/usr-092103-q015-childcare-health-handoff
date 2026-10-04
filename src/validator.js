/**
 * 领域事件校验：公共信封 + 按事件类型的业务规则。
 * 纯函数、无外部依赖，供写入接口和测试共用。
 */

const REQUIRED = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
  "child_id",
  "actor",
  "payload",
];

export const EVENT_TYPES = [
  "CHILD_CARE_RECORD_RECORDED",
  "AUTHORIZATION_GRANTED",
  "AUTHORIZATION_UPDATED",
  "AUTHORIZATION_REVOKED",
  "OBSERVATION_RECORDED",
  "HEALTH_SCREENING_RECORDED",
  "REFERRAL_RECOMMENDED",
  "REFERRAL_SENT",
  "REFERRAL_DELIVERED",
  "REFERRAL_ACCEPTED",
  "MEDICATION_DELEGATION_RECORDED",
  "INCIDENT_RAISED",
  "INCIDENT_DISPOSITION_RECORDED",
  "ALERT_RAISED",
  "ALERT_ACKNOWLEDGED",
  "FOLLOWUP_RECORDED",
  "FOLLOWUP_COMPLETED",
];

export const AGGREGATE_TYPES = [
  "child_care_record",
  "guardian_authorization",
  "daily_observation",
  "health_screening",
  "referral_handoff",
  "medication_delegation",
  "incident",
  "alert",
  "followup",
];

export const ROLES = [
  "teacher",
  "health_administrator",
  "doctor",
  "operations",
  "guardian",
  "temporary_caregiver",
];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** 筛查事件禁止出现结论性字段：指标不能自动变成诊断。 */
const FORBIDDEN_SCREENING_FIELDS = ["diagnosis", "diagnostic_result", "confirmed_condition"];

/** 转诊最小资料包允许字段白名单；禁止姓名、证件、联系方式等标识外发。 */
export const REFERRAL_PACKET_FIELDS = [
  "child_id",
  "month_age",
  "sex",
  "urgency",
  "reason",
  "indicator_summary",
  "allergies",
];

/** 需要附着原事件的事件类型。 */
const LINK_REQUIRED_TYPES = new Set([
  "REFERRAL_SENT",
  "REFERRAL_DELIVERED",
  "INCIDENT_DISPOSITION_RECORDED",
  "ALERT_ACKNOWLEDGED",
  "FOLLOWUP_RECORDED",
  "FOLLOWUP_COMPLETED",
]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFields(payload, fields, label) {
  const errors = [];
  for (const field of fields) {
    if (!(field in payload) || payload[field] === undefined || payload[field] === "") {
      errors.push(`${label}缺少字段：${field}`);
    }
  }
  return errors;
}

function rejectExtraFields(payload, allowed, label) {
  return Object.keys(payload)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${label}含未允许字段：${key}`);
}

function checkDate(value, label, errors) {
  if (typeof value !== "string" || !DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    errors.push(`${label}必须是 YYYY-MM-DD 日期`);
  }
}

function checkTimestamp(value, label, errors) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${label}必须是 ISO 8601 时间`);
  }
}

function checkEnum(value, allowed, label, errors) {
  if (!allowed.includes(value)) errors.push(`${label}取值非法：${String(value)}`);
}

function validateActor(actor) {
  const errors = [];
  if (!isObject(actor)) return ["actor 必须是对象"];
  if (!actor.actor_id) errors.push("actor.actor_id 不能为空");
  if (!ROLES.includes(actor.role)) errors.push(`actor.role 取值非法：${String(actor.role)}`);
  for (const key of Object.keys(actor)) {
    if (!["actor_id", "role", "org_id", "name"].includes(key)) {
      errors.push(`actor 含未允许字段：${key}`);
    }
  }
  return errors;
}

function validateAllergy(item, errors, path) {
  if (!isObject(item)) {
    errors.push(`${path} 必须是对象`);
    return;
  }
  if (!item.allergen) errors.push(`${path}.allergen 不能为空`);
  if (item.severity) checkEnum(item.severity, ["mild", "moderate", "severe"], `${path}.severity`, errors);
  for (const key of Object.keys(item)) {
    if (!["allergen", "severity", "reaction", "source"].includes(key)) {
      errors.push(`${path} 含未允许字段：${key}`);
    }
  }
}

function validatePayloadByType(event) {
  const { event_type: type, payload } = event;
  const errors = [];
  if (!isObject(payload)) return ["payload 必须是对象"];
  const label = "payload";

  switch (type) {
    case "CHILD_CARE_RECORD_RECORDED": {
      errors.push(...requireFields(payload, ["child_name", "birth_date", "org_id", "guardian_ids"], label));
      if (payload.birth_date) checkDate(payload.birth_date, "payload.birth_date", errors);
      if (payload.sex) checkEnum(payload.sex, ["male", "female", "unknown"], "payload.sex", errors);
      if (!Array.isArray(payload.guardian_ids) || payload.guardian_ids.length === 0) {
        errors.push("payload.guardian_ids 必须是非空数组");
      }
      if (payload.allergies) {
        if (!Array.isArray(payload.allergies)) errors.push("payload.allergies 必须是数组");
        else payload.allergies.forEach((a, i) => validateAllergy(a, errors, `payload.allergies[${i}]`));
      }
      const restricted = payload.sharing_preferences?.restricted_categories;
      if (restricted !== undefined) {
        const allowed = ["identity", "daily_care", "allergy", "health_screening", "medical_plan", "incident_emergency", "followup"];
        if (!Array.isArray(restricted)) errors.push("sharing_preferences.restricted_categories 必须是数组");
        else restricted.forEach((c) => checkEnum(c, allowed, "sharing_preferences.restricted_categories[]", errors));
      }
      errors.push(...rejectExtraFields(payload, ["child_name", "birth_date", "sex", "org_id", "class_id", "guardian_ids", "allergies", "sharing_preferences"], label));
      break;
    }
    case "AUTHORIZATION_GRANTED":
    case "AUTHORIZATION_UPDATED": {
      const fields = ["subject_id", "subject_role", "scope", "effective_from", "effective_until", "granted_by"];
      errors.push(...requireFields(payload, fields, label));
      checkEnum(payload.subject_role, ["guardian", "temporary_caregiver"], "payload.subject_role", errors);
      const scopes = ["pickup", "daily_care_view", "emergency_contact", "medical_decision"];
      if (!Array.isArray(payload.scope) || payload.scope.length === 0) errors.push("payload.scope 必须是非空数组");
      else payload.scope.forEach((s) => checkEnum(s, scopes, "payload.scope[]", errors));
      checkDate(payload.effective_from, "payload.effective_from", errors);
      checkDate(payload.effective_until, "payload.effective_until", errors);
      if (
        DAY.test(payload.effective_from ?? "") &&
        DAY.test(payload.effective_until ?? "") &&
        payload.effective_until < payload.effective_from
      ) {
        errors.push("授权有效期无效：effective_until 早于 effective_from");
      }
      errors.push(...rejectExtraFields(payload, [...fields, "subject_name", "relation", "reason"], label));
      break;
    }
    case "AUTHORIZATION_REVOKED": {
      errors.push(...requireFields(payload, ["subject_id", "revoked_by"], label));
      errors.push(...rejectExtraFields(payload, ["subject_id", "revoked_by", "reason"], label));
      break;
    }
    case "OBSERVATION_RECORDED": {
      errors.push(...requireFields(payload, ["category", "observed_at", "content"], label));
      checkEnum(payload.category, ["feeding", "development", "sleep", "stool", "mood", "other"], "payload.category", errors);
      if (payload.observed_at) checkTimestamp(payload.observed_at, "payload.observed_at", errors);
      if (payload.measures !== undefined && !isObject(payload.measures)) errors.push("payload.measures 必须是对象");
      errors.push(...rejectExtraFields(payload, ["category", "observed_at", "content", "measures"], label));
      break;
    }
    case "HEALTH_SCREENING_RECORDED": {
      errors.push(...requireFields(payload, ["screening_type", "observed_at", "indicators"], label));
      checkEnum(payload.screening_type, ["growth", "vision", "hearing", "development", "nutrition", "other"], "payload.screening_type", errors);
      if (payload.observed_at) checkTimestamp(payload.observed_at, "payload.observed_at", errors);
      // 红线：筛查记录里禁止任何诊断结论字段。
      for (const forbidden of FORBIDDEN_SCREENING_FIELDS) {
        if (forbidden in payload) errors.push(`筛查事件禁止携带诊断字段：${forbidden}（指标不能自动变成诊断）`);
      }
      if (!Array.isArray(payload.indicators) || payload.indicators.length === 0) {
        errors.push("payload.indicators 必须是非空数组");
      } else {
        payload.indicators.forEach((ind, i) => {
          const p = `payload.indicators[${i}]`;
          if (!isObject(ind)) {
            errors.push(`${p} 必须是对象`);
            return;
          }
          if (!ind.code) errors.push(`${p}.code 不能为空`);
          if (!ind.label) errors.push(`${p}.label 不能为空`);
          if (ind.value === undefined || ind.value === "") errors.push(`${p}.value 不能为空`);
          if (ind.flag) checkEnum(ind.flag, ["normal", "review", "risk"], `${p}.flag`, errors);
          for (const key of Object.keys(ind)) {
            if (!["code", "label", "value", "unit", "reference", "flag"].includes(key)) {
              errors.push(`${p} 含未允许字段：${key}`);
            }
          }
        });
      }
      errors.push(...rejectExtraFields(payload, ["screening_type", "observed_at", "indicators", "note"], label));
      break;
    }
    case "REFERRAL_RECOMMENDED": {
      errors.push(...requireFields(payload, ["to_org_id", "reason", "urgency"], label));
      checkEnum(payload.urgency, ["routine", "urgent"], "payload.urgency", errors);
      errors.push(...rejectExtraFields(payload, ["to_org_id", "to_org_name", "suggested_department", "reason", "urgency", "linked_screening_event_id", "note"], label));
      break;
    }
    case "REFERRAL_SENT": {
      errors.push(...requireFields(payload, ["to_org_id", "packet"], label));
      const packet = payload.packet;
      if (!isObject(packet)) {
        errors.push("payload.packet 必须是对象");
      } else {
        errors.push(...requireFields(packet, ["child_id", "reason"], "payload.packet"));
        for (const key of Object.keys(packet)) {
          if (!REFERRAL_PACKET_FIELDS.includes(key)) {
            errors.push(`转诊包含最小资料之外的字段：${key}`);
          }
        }
        // 深度检查常见标识泄漏：嵌套对象里也不允许姓名/联系方式。
        const forbiddenLeakKeys = ["child_name", "name", "id_card", "phone", "contact", "address", "guardian_name"];
        const walk = (node, path) => {
          if (isObject(node)) {
            for (const [k, v] of Object.entries(node)) {
              if (forbiddenLeakKeys.includes(k)) errors.push(`转诊包禁止外发标识字段：${path}${k}`);
              else walk(v, `${path}${k}.`);
            }
          } else if (Array.isArray(node)) {
            node.forEach((v, i) => walk(v, `${path}[${i}].`));
          }
        };
        walk(packet, "packet.");
        if (packet.sex) checkEnum(packet.sex, ["male", "female", "unknown"], "packet.sex", errors);
        if (packet.urgency) checkEnum(packet.urgency, ["routine", "urgent"], "packet.urgency", errors);
        if (packet.indicator_summary) {
          packet.indicator_summary.forEach((item, i) => {
            if (!isObject(item) || !item.code || !item.flag) {
              errors.push(`packet.indicator_summary[${i}] 必须包含 code 与 flag`);
            } else {
              checkEnum(item.flag, ["normal", "review", "risk"], `packet.indicator_summary[${i}].flag`, errors);
            }
          });
        }
      }
      errors.push(...rejectExtraFields(payload, ["to_org_id", "packet"], label));
      break;
    }
    case "REFERRAL_DELIVERED": {
      errors.push(...requireFields(payload, ["receiver_org_id", "receiver_actor_id"], label));
      if (payload.received_at) checkTimestamp(payload.received_at, "payload.received_at", errors);
      errors.push(...rejectExtraFields(payload, ["receiver_org_id", "receiver_actor_id", "received_at"], label));
      break;
    }
    case "REFERRAL_ACCEPTED": {
      errors.push(...requireFields(payload, ["accepted_by"], label));
      if (payload.appointment_at) checkTimestamp(payload.appointment_at, "payload.appointment_at", errors);
      errors.push(...rejectExtraFields(payload, ["accepted_by", "appointment_at"], label));
      break;
    }
    case "MEDICATION_DELEGATION_RECORDED": {
      const fields = ["medication_name", "dose", "schedule", "start_date", "end_date", "instructions", "guardian_consent"];
      errors.push(...requireFields(payload, fields, label));
      if (!Array.isArray(payload.schedule) || payload.schedule.length === 0) errors.push("payload.schedule 必须是非空数组");
      checkDate(payload.start_date, "payload.start_date", errors);
      checkDate(payload.end_date, "payload.end_date", errors);
      if (payload.guardian_consent !== true) errors.push("用药委托必须有监护人明确同意（guardian_consent=true）");
      errors.push(...rejectExtraFields(payload, [...fields, "route", "prescriber"], label));
      break;
    }
    case "INCIDENT_RAISED": {
      const fields = ["incident_type", "severity", "occurred_at", "description", "on_site_handling"];
      errors.push(...requireFields(payload, fields, label));
      checkEnum(payload.incident_type, ["allergy", "fever", "injury", "other"], "payload.incident_type", errors);
      checkEnum(payload.severity, ["low", "medium", "high"], "payload.severity", errors);
      checkTimestamp(payload.occurred_at, "payload.occurred_at", errors);
      errors.push(...rejectExtraFields(payload, [...fields, "location", "notified_guardian"], label));
      break;
    }
    case "INCIDENT_DISPOSITION_RECORDED": {
      errors.push(...requireFields(payload, ["actions", "handled_by", "disposition_at"], label));
      checkTimestamp(payload.disposition_at, "payload.disposition_at", errors);
      errors.push(...rejectExtraFields(payload, ["actions", "handled_by", "disposition_at"], label));
      break;
    }
    case "ALERT_RAISED": {
      errors.push(...requireFields(payload, ["alert_kind", "severity", "message"], label));
      checkEnum(payload.alert_kind, ["allergy", "emergency"], "payload.alert_kind", errors);
      checkEnum(payload.severity, ["medium", "high"], "payload.severity", errors);
      errors.push(...rejectExtraFields(payload, ["alert_kind", "severity", "message"], label));
      break;
    }
    case "ALERT_ACKNOWLEDGED": {
      errors.push(...requireFields(payload, ["acknowledged_by"], label));
      if (payload.acknowledged_at) checkTimestamp(payload.acknowledged_at, "payload.acknowledged_at", errors);
      errors.push(...rejectExtraFields(payload, ["acknowledged_by", "acknowledged_at"], label));
      break;
    }
    case "FOLLOWUP_RECORDED":
    case "FOLLOWUP_COMPLETED": {
      errors.push(...requireFields(payload, ["result", "recorded_by_role", "followed_up_at"], label));
      checkEnum(payload.recorded_by_role, ["doctor", "health_administrator"], "payload.recorded_by_role", errors);
      checkTimestamp(payload.followed_up_at, "payload.followed_up_at", errors);
      if (payload.outcome) checkEnum(payload.outcome, ["completed", "ongoing", "needs_followup"], "payload.outcome", errors);
      errors.push(...rejectExtraFields(payload, ["result", "outcome", "recorded_by_role", "followed_up_at"], label));
      break;
    }
    default:
      errors.push(`未知事件类型：${type}`);
  }
  return errors;
}

/**
 * 校验一条领域事件，返回中文错误信息数组；空数组表示通过。
 */
export function validateEvent(record) {
  if (!isObject(record)) return ["事件必须是对象"];
  const errors = [];

  for (const name of REQUIRED) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }

  if (typeof record.event_id !== "string" || record.event_id === "") errors.push("event_id 不能为空");
  if (record.event_type !== undefined && !EVENT_TYPES.includes(record.event_type)) {
    errors.push(`event_type 未登记：${String(record.event_type)}`);
  }
  if (record.aggregate_type !== undefined && !AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`aggregate_type 未登记：${String(record.aggregate_type)}`);
  }
  if (typeof record.aggregate_id !== "string" || record.aggregate_id === "") errors.push("aggregate_id 不能为空");
  if (typeof record.child_id !== "string" || record.child_id === "") errors.push("child_id 不能为空");
  if (record.occurred_at !== undefined) checkTimestamp(record.occurred_at, "occurred_at", errors);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if (typeof record.summary !== "string" || record.summary === "") errors.push("summary 不能为空");
  if (record.actor !== undefined) errors.push(...validateActor(record.actor));
  for (const key of Object.keys(record)) {
    if (![...REQUIRED, "linked_event_id"].includes(key)) {
      errors.push(`信封含未允许字段：${key}`);
    }
  }

  if (record.event_type !== undefined && LINK_REQUIRED_TYPES.has(record.event_type) && !record.linked_event_id) {
    errors.push(`${record.event_type} 必须通过 linked_event_id 附着原事件`);
  }

  if (isObject(record.payload) && EVENT_TYPES.includes(record.event_type)) {
    errors.push(...validatePayloadByType(record));
  }
  return errors;
}
