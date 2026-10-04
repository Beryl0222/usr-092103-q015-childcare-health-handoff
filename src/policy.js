/**
 * 访问策略：角色最小可见 + 监护人共享偏好 + 过敏/急症告警例外（break-glass）。
 *
 * 角色边界：
 * - teacher 当班老师：只看当班照护所需（身份卡、过敏、日常观察、有效用药委托、急症事件）
 * - health_administrator 健康管理员：本机构内照护协同信息，偏好仍生效
 * - doctor 妇幼医生：只看诊疗范围（筛查、转诊、急症、回访、过敏），不看日常观察
 * - operations 运营：不允许读取任何儿童级数据，只能看去标识化质量指标
 * - guardian 监护人：本人孩子的全部信息与访问记录
 * - temporary_caregiver 临时照护人：仅在授权有效期与授权范围内可见
 */

/** 各事件类型允许的写入角色；运营人员只读质量指标，不录入业务事件。 */
export const WRITER_ROLES = {
  CHILD_CARE_RECORD_RECORDED: ["health_administrator"],
  AUTHORIZATION_GRANTED: ["guardian", "health_administrator"],
  AUTHORIZATION_UPDATED: ["guardian", "health_administrator"],
  AUTHORIZATION_REVOKED: ["guardian", "health_administrator"],
  OBSERVATION_RECORDED: ["teacher", "health_administrator"],
  HEALTH_SCREENING_RECORDED: ["doctor", "health_administrator"],
  REFERRAL_RECOMMENDED: ["doctor", "health_administrator"],
  REFERRAL_SENT: ["doctor", "health_administrator"],
  REFERRAL_DELIVERED: ["doctor", "health_administrator"],
  REFERRAL_ACCEPTED: ["doctor"],
  MEDICATION_DELEGATION_RECORDED: ["guardian", "health_administrator"],
  INCIDENT_RAISED: ["teacher", "health_administrator", "doctor"],
  INCIDENT_DISPOSITION_RECORDED: ["teacher", "health_administrator", "doctor"],
  ALERT_RAISED: ["teacher", "health_administrator", "doctor"],
  ALERT_ACKNOWLEDGED: ["teacher", "health_administrator", "doctor"],
  FOLLOWUP_RECORDED: ["doctor", "health_administrator"],
  FOLLOWUP_COMPLETED: ["doctor", "health_administrator"],
};

/** 事件 -> 信息分类（与契约中的共享偏好分类一致）。 */
export function categoryOf(event) {
  switch (event.event_type) {
    case "CHILD_CARE_RECORD_RECORDED":
    case "AUTHORIZATION_GRANTED":
    case "AUTHORIZATION_UPDATED":
    case "AUTHORIZATION_REVOKED":
      return "identity";
    case "OBSERVATION_RECORDED":
      return "daily_care";
    case "HEALTH_SCREENING_RECORDED":
      return "health_screening";
    case "REFERRAL_RECOMMENDED":
    case "REFERRAL_SENT":
    case "REFERRAL_DELIVERED":
    case "REFERRAL_ACCEPTED":
      return "medical_plan";
    case "MEDICATION_DELEGATION_RECORDED":
      return "medical_plan";
    case "INCIDENT_RAISED":
    case "INCIDENT_DISPOSITION_RECORDED":
      return "incident_emergency";
    case "ALERT_RAISED":
    case "ALERT_ACKNOWLEDGED":
      return "incident_emergency";
    case "FOLLOWUP_RECORDED":
    case "FOLLOWUP_COMPLETED":
      return "followup";
    default:
      return "daily_care";
  }
}

/** 过敏/急症告警事件：可以越过普通共享偏好，但必须留下访问理由。 */
export function isOverrideAlert(event) {
  if (event.event_type === "ALERT_RAISED") return true;
  if (event.event_type === "INCIDENT_RAISED") {
    return event.payload?.incident_type === "allergy" || event.payload?.severity === "high";
  }
  return false;
}

function roleAllowsCategory(role, category, event) {
  // 用药委托是经监护人同意的照护执行任务，当班老师需要据此给药。
  if (event.event_type === "MEDICATION_DELEGATION_RECORDED" && role === "teacher") return true;
  // 授权变更本身只对监护人/健康管理员可见，老师只能看到当班接送名单投影。
  if (
    event.event_type === "AUTHORIZATION_GRANTED" ||
    event.event_type === "AUTHORIZATION_UPDATED" ||
    event.event_type === "AUTHORIZATION_REVOKED"
  ) {
    return role === "health_administrator" || role === "guardian";
  }
  if (category === "identity") {
    if (
      (role === "teacher" || role === "temporary_caregiver") &&
      event.event_type !== "CHILD_CARE_RECORD_RECORDED"
    ) {
      return false;
    }
    return (
      role === "teacher" ||
      role === "health_administrator" ||
      role === "doctor" ||
      role === "guardian" ||
      role === "temporary_caregiver"
    );
  }
  switch (role) {
    case "teacher":
      return ["daily_care", "allergy", "incident_emergency"].includes(category);
    case "health_administrator":
      return true; // 本机构协同所需全分类，偏好限制在外层统一处理
    case "doctor":
      return ["allergy", "health_screening", "medical_plan", "incident_emergency", "followup"].includes(category);
    case "operations":
      return false; // 儿童级数据一律不可见
    case "guardian":
      return true;
    case "temporary_caregiver":
      return ["identity", "daily_care", "allergy", "incident_emergency", "medical_plan"].includes(category);
    default:
      return false;
  }
}

/**
 * 判定单个事件对查看者是否可见。
 * @returns {{allowed:boolean, overriddenPreference?:boolean, reason?:string}}
 */
export function decideEventAccess(event, viewer, ctx) {
  const category = categoryOf(event);
  const role = viewer.role;

  if (!roleAllowsCategory(role, category, event)) return { allowed: false };

  // 医生只能看进入自己诊疗范围（经转诊接收或本人/本机构已留诊疗记录）的儿童。
  if (role === "doctor" && !ctx.inTreatmentScope) return { allowed: false };

  // 当班老师只能看本班儿童（由调用方通过 onDuty 传入）。
  if (role === "teacher" && !ctx.onDuty) return { allowed: false };

  // 临时照护人：授权必须在有效期内、未被撤销，且分类在授权范围内。
  if (role === "temporary_caregiver") {
    const auth = ctx.activeAuthorization;
    if (!auth) return { allowed: false };
    const scopeCategories = new Set(
      auth.scope.flatMap((s) => {
        switch (s) {
          case "pickup":
            return ["identity"];
          case "daily_care_view":
            return ["daily_care", "allergy"];
          case "emergency_contact":
            return ["incident_emergency"];
          case "medical_decision":
            return ["medical_plan", "incident_emergency"];
          default:
            return [];
        }
      }),
    );
    if (!scopeCategories.has(category)) return { allowed: false };
  }

  // 监护人共享偏好：默认隐藏受限分类；过敏/急症告警可越过，但标记例外留痕。
  // 偏好约束的是照护侧（老师/健康管理员/临时照护人）的日常共享；
  // 已在诊疗范围内的医生按诊疗需要读取临床分类（仍全程审计，身份字段仍脱敏）。
  const restricted = new Set(ctx.restrictedCategories ?? []);
  if (restricted.has(category)) {
    if (role === "guardian") return { allowed: true }; // 本人偏好不限制本人
    if (role === "doctor" && ctx.inTreatmentScope) {
      if (["health_screening", "medical_plan", "followup", "allergy", "incident_emergency"].includes(category)) {
        return { allowed: true };
      }
    }
    // 监护人通过用药委托明确要求照护方执行的事项，不再受医疗计划共享偏好限制。
    if (
      event.event_type === "MEDICATION_DELEGATION_RECORDED" &&
      (role === "teacher" || role === "health_administrator" || role === "temporary_caregiver")
    ) {
      return { allowed: true };
    }
    if (isOverrideAlert(event)) {
      return { allowed: true, overriddenPreference: true };
    }
    return { allowed: false };
  }
  return { allowed: true };
}

/**
 * 对老师/临时照护人做字段级最小化：身份信息只保留照护必需字段。
 * restrictedCategories 非空时，档案卡里的过敏史也要按偏好剔除
 * （严重过敏的安全提示仍通过 ALERT_RAISED 越权通道单独触达）。
 */
export function redactForRole(event, role, restrictedCategories = []) {
  const restricted = new Set(restrictedCategories);
  if (role === "doctor" && event.event_type === "CHILD_CARE_RECORD_RECORDED") {
    const p = event.payload;
    return {
      ...event,
      payload: {
        sex: p.sex,
        birth_date: p.birth_date,
        allergies: restricted.has("allergy") ? [] : (p.allergies ?? []),
      },
      summary: "儿童基础诊疗信息（已去标识）",
    };
  }
  if ((role === "teacher" || role === "temporary_caregiver") && event.event_type === "CHILD_CARE_RECORD_RECORDED") {
    const p = event.payload;
    return {
      ...event,
      payload: {
        child_name: p.child_name,
        class_id: p.class_id,
        allergies: restricted.has("allergy") ? [] : (p.allergies ?? []),
      },
    };
  }
  // 健康管理员看完整档案卡，但内嵌过敏史同样受共享偏好约束。
  if (role === "health_administrator" && event.event_type === "CHILD_CARE_RECORD_RECORDED") {
    const p = event.payload;
    if (!restricted.has("allergy")) return event;
    return { ...event, payload: { ...p, allergies: [] } };
  }
  return event;
}
