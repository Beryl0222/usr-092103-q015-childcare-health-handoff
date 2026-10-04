/** 测试用事件构造器：只覆盖必填项，其余按需覆盖。 */
let seq = 0;

export function makeEvent(overrides = {}) {
  seq += 1;
  const n = String(seq).padStart(3, "0");
  return {
    event_id: `test-evt-${n}`,
    event_type: "OBSERVATION_RECORDED",
    aggregate_type: "daily_observation",
    aggregate_id: `test-agg-${n}`,
    occurred_at: "2026-10-04T09:00:00+08:00",
    version: 1,
    summary: "测试事件",
    child_id: "c-test",
    actor: { actor_id: "t-1", role: "teacher", org_id: "site-a" },
    payload: {
      category: "feeding",
      observed_at: "2026-10-04T08:30:00+08:00",
      content: "测试观察内容",
    },
    ...overrides,
  };
}

export const actors = {
  teacher: { actor_id: "t-1", role: "teacher", org_id: "site-a", name: "王老师" },
  teacherOtherSite: { actor_id: "t-2", role: "teacher", org_id: "site-b", name: "赵老师" },
  healthAdmin: { actor_id: "ha-1", role: "health_administrator", org_id: "site-a", name: "李管理员" },
  doctor: { actor_id: "dr-1", role: "doctor", org_id: "mch-001", name: "陈医生" },
  doctorOther: { actor_id: "dr-9", role: "doctor", org_id: "mch-002", name: "钱医生" },
  operations: { actor_id: "ops-1", role: "operations", name: "运营" },
  guardian: { actor_id: "g-1", role: "guardian", name: "家长" },
  guardianOther: { actor_id: "g-2", role: "guardian", name: "其他家长" },
  tempCaregiver: { actor_id: "tc-1", role: "temporary_caregiver", name: "临时照护人" },
};

export function recordEvent({ childId = "c-test", orgId = "site-a", classId = "class-1", overrides = {} } = {}) {
  return makeEvent({
    event_id: `rec-${childId}`,
    event_type: "CHILD_CARE_RECORD_RECORDED",
    aggregate_type: "child_care_record",
    aggregate_id: childId,
    version: 1,
    summary: `档案 ${childId}`,
    child_id: childId,
    actor: actors.healthAdmin,
    payload: {
      child_name: "测试儿童",
      birth_date: "2024-01-01",
      sex: "female",
      org_id: orgId,
      class_id: classId,
      guardian_ids: ["g-1"],
      ...overrides,
    },
  });
}
