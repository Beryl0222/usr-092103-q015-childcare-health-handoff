/** 医育联动健康接力领域类型定义。 */

/** 系统中的协作角色。 */
export type Role =
  | "teacher" // 带班/当班老师，只看当班照护所需
  | "health_administrator" // 托育点健康管理员
  | "doctor" // 妇幼医生，只看诊疗范围
  | "operations" // 运营人员，只看去标识化质量指标
  | "guardian" // 监护人
  | "temporary_caregiver"; // 临时照护人（有明确有效期）

/** 信息分类，用于共享偏好与按角色最小可见控制。 */
export type InfoCategory =
  | "identity"
  | "daily_care"
  | "allergy"
  | "health_screening"
  | "medical_plan"
  | "incident_emergency"
  | "followup";

export interface Actor {
  actor_id: string;
  role: Role;
  org_id?: string;
  name?: string;
}

/** 领域事件公共信封。事件只追加，不更新、不覆盖。 */
export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  child_id: string;
  actor: Actor;
  /** 回访挂原事件、转诊发送挂建议、处置挂突发事件。 */
  linked_event_id?: string;
  payload: EventPayload;
}

export type EventType =
  | "CHILD_CARE_RECORD_RECORDED"
  | "AUTHORIZATION_GRANTED"
  | "AUTHORIZATION_UPDATED"
  | "AUTHORIZATION_REVOKED"
  | "OBSERVATION_RECORDED"
  | "HEALTH_SCREENING_RECORDED"
  | "REFERRAL_RECOMMENDED"
  | "REFERRAL_SENT"
  | "REFERRAL_DELIVERED"
  | "REFERRAL_ACCEPTED"
  | "MEDICATION_DELEGATION_RECORDED"
  | "INCIDENT_RAISED"
  | "INCIDENT_DISPOSITION_RECORDED"
  | "ALERT_RAISED"
  | "ALERT_ACKNOWLEDGED"
  | "FOLLOWUP_RECORDED"
  | "FOLLOWUP_COMPLETED";

export type AggregateType =
  | "child_care_record"
  | "guardian_authorization"
  | "daily_observation"
  | "health_screening"
  | "referral_handoff"
  | "medication_delegation"
  | "incident"
  | "alert"
  | "followup";

export type Flag = "normal" | "review" | "risk";

export interface Allergy {
  allergen: string;
  severity?: "mild" | "moderate" | "severe";
  reaction?: string;
  source?: string;
}

export interface ChildCareRecordPayload {
  child_name: string;
  birth_date: string;
  sex?: "male" | "female" | "unknown";
  org_id: string;
  class_id?: string;
  guardian_ids: string[];
  allergies?: Allergy[];
  sharing_preferences?: { restricted_categories?: InfoCategory[] };
}

export interface AuthorizationPayload {
  subject_id: string;
  subject_name?: string;
  subject_role: "guardian" | "temporary_caregiver";
  relation?: string;
  scope: Array<"pickup" | "daily_care_view" | "emergency_contact" | "medical_decision">;
  effective_from: string;
  effective_until: string;
  granted_by: string;
  reason?: string;
}

export interface AuthorizationRevokedPayload {
  subject_id: string;
  revoked_by: string;
  reason?: string;
}

export interface ObservationPayload {
  category: "feeding" | "development" | "sleep" | "stool" | "mood" | "other";
  observed_at: string;
  content: string;
  measures?: Record<string, number | string>;
}

export interface ScreeningIndicator {
  code: string;
  label: string;
  value: number | string;
  unit?: string;
  reference?: string;
  flag?: Flag;
}

/**
 * 健康筛查：只记录指标与待复核标记。
 * 禁止 diagnosis / diagnostic_result / confirmed_condition ——
 * 系统只能辅助整理和提醒，不能把筛查指标自动变成诊断。
 */
export interface HealthScreeningPayload {
  screening_type: "growth" | "vision" | "hearing" | "development" | "nutrition" | "other";
  observed_at: string;
  indicators: ScreeningIndicator[];
  note?: string;
}

export interface ReferralRecommendedPayload {
  to_org_id: string;
  to_org_name?: string;
  suggested_department?: string;
  reason: string;
  urgency: "routine" | "urgent";
  linked_screening_event_id?: string;
  note?: string;
}

/** 跨机构转诊最小资料包：白名单字段，不含姓名、证件、联系方式。 */
export interface ReferralPacket {
  child_id: string;
  month_age?: number;
  sex?: "male" | "female" | "unknown";
  urgency?: "routine" | "urgent";
  reason: string;
  indicator_summary?: Array<{ code: string; flag: Flag }>;
  allergies?: Array<{ allergen: string; severity: "mild" | "moderate" | "severe" }>;
}

export interface ReferralSentPayload {
  to_org_id: string;
  packet: ReferralPacket;
}

export interface ReferralDeliveredPayload {
  receiver_org_id: string;
  receiver_actor_id: string;
  received_at?: string;
}

export interface ReferralAcceptedPayload {
  accepted_by: string;
  appointment_at?: string;
}

export interface MedicationDelegationPayload {
  medication_name: string;
  dose: string;
  route?: string;
  schedule: string[];
  start_date: string;
  end_date: string;
  prescriber?: string;
  instructions: string;
  /** 无监护人明确同意不得登记用药委托。 */
  guardian_consent: true;
}

export interface IncidentPayload {
  incident_type: "allergy" | "fever" | "injury" | "other";
  severity: "low" | "medium" | "high";
  occurred_at: string;
  location?: string;
  description: string;
  on_site_handling: string;
  notified_guardian?: boolean;
}

export interface IncidentDispositionPayload {
  actions: string;
  handled_by: string;
  disposition_at: string;
}

export interface AlertPayload {
  alert_kind: "allergy" | "emergency";
  severity: "medium" | "high";
  message: string;
}

export interface AlertAcknowledgedPayload {
  acknowledged_by: string;
  acknowledged_at?: string;
}

export interface FollowupPayload {
  result: string;
  outcome?: "completed" | "ongoing" | "needs_followup";
  recorded_by_role: "doctor" | "health_administrator";
  followed_up_at: string;
}

export type EventPayload =
  | ChildCareRecordPayload
  | AuthorizationPayload
  | AuthorizationRevokedPayload
  | ObservationPayload
  | HealthScreeningPayload
  | ReferralRecommendedPayload
  | ReferralSentPayload
  | ReferralDeliveredPayload
  | ReferralAcceptedPayload
  | MedicationDelegationPayload
  | IncidentPayload
  | IncidentDispositionPayload
  | AlertPayload
  | AlertAcknowledgedPayload
  | FollowupPayload;

/** 访问请求：每次读取都要带访问理由，越权读取过敏/急症告警也必须留痕。 */
export interface AccessRequest {
  actor: Actor;
  /** 读取所基于的当班/授权范围，如当班班级、授权 subject_id。 */
  scopes?: {
    on_duty_class_ids?: string[];
    as_subject_id?: string;
    care_scope_date?: string;
  };
  reason: string;
}

/** 家长可核对的一条访问记录。 */
export interface AccessAuditEntry {
  audit_id: string;
  child_id: string;
  actor_id: string;
  actor_role: Role;
  action: "view" | "handle" | "share" | "break_glass";
  categories: InfoCategory[];
  reason: string;
  at: string;
  linked_event_id?: string;
  event_type?: EventType;
}
