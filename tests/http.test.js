import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";

import { HandoffService } from "../src/handoff.js";
import { createApp } from "../src/server.js";

let server;
let base;
let svc;

before(async () => {
  svc = new HandoffService({});
  for (const event of JSON.parse(readFileSync(new URL("../data/sample-events.json", import.meta.url), "utf8"))) {
    svc.ingest(event);
  }
  server = createApp(svc);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(
  () =>
    new Promise((resolve) => {
      server.close(resolve);
    }),
);

const headers = (h) => ({ "content-type": "application/json", ...h });

async function get(path, h) {
  // HTTP 头只接受 Latin-1，中文访问理由需百分号编码（服务端会解码）。
  const safeHeaders = Object.fromEntries(
    Object.entries(h).map(([k, v]) => [k, /[^\x00-\xff]/.test(v) ? encodeURIComponent(v) : v]),
  );
  const res = await fetch(`${base}${path}`, { headers: safeHeaders });
  return { status: res.status, body: await res.json() };
}

test("GET /healthz", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("老师带访问理由获取当班照护提示", async () => {
  const res = await get("/v1/care-hints?date=2026-10-04", {
    "x-actor-id": "t-wang",
    "x-actor-role": "teacher",
    "x-actor-org": "site-a",
    "x-on-duty-class-ids": "xiaoban-1",
    "x-access-reason": "当班照护",
  });
  assert.equal(res.status, 200);
  const hint = res.body.hints[0];
  assert.equal(hint.child_name, "朵朵");
  assert.deepEqual(hint.medications_today.map((m) => m.medication_name), ["盐酸西替利嗪滴剂"]);
  assert.equal(hint.handled_today.length, 1);
});

test("缺少 x-access-reason 时读取被 403 拒绝", async () => {
  const res = await get("/v1/care-hints", {
    "x-actor-id": "t-wang",
    "x-actor-role": "teacher",
    "x-actor-org": "site-a",
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /访问理由/);
});

test("运营获取去标识化质量指标，响应中不含儿童标识", async () => {
  const res = await get("/v1/quality-metrics", {
    "x-actor-id": "ops-1",
    "x-actor-role": "operations",
    "x-access-reason": "月度质量报表",
  });
  assert.equal(res.status, 200);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes("朵朵"));
  assert.ok(!text.includes("c001"));
});

test("运营访问儿童事件被 403", async () => {
  const res = await get("/v1/children/c001/events", {
    "x-actor-id": "ops-1",
    "x-actor-role": "operations",
    "x-access-reason": "运营检查",
  });
  assert.equal(res.status, 403);
});

test("医生诊疗视图与转诊跟踪", async () => {
  const med = await get("/v1/children/c001/medical", {
    "x-actor-id": "dr-li",
    "x-actor-role": "doctor",
    "x-actor-org": "mch-001",
    "x-access-reason": "营养门诊复诊准备",
  });
  assert.equal(med.status, 200);
  assert.ok(med.body.events.some((e) => e.event_type === "HEALTH_SCREENING_RECORDED"));
  assert.ok(!med.body.events.some((e) => e.event_type === "OBSERVATION_RECORDED"));

  const refs = await get("/v1/referrals", {
    "x-actor-id": "dr-li",
    "x-actor-role": "doctor",
    "x-actor-org": "mch-001",
    "x-access-reason": "追踪建议闭环",
  });
  assert.equal(refs.status, 200);
  assert.equal(refs.body.referrals[0].status, "accepted");
  assert.equal(refs.body.referrals[0].recommendation_completed, true);
});

test("家长核对访问记录", async () => {
  const res = await get("/v1/children/c001/audit", {
    "x-actor-id": "g-mom",
    "x-actor-role": "guardian",
    "x-access-reason": "核对谁查看过孩子信息",
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.entries.length > 0);
  assert.ok(res.body.entries.every((e) => e.at && e.reason && e.actor_role));
});

test("POST /v1/events 接收合法事件；筛查带诊断返回 400", async () => {
  const valid = {
    event_id: "evt-http-test-obs",
    event_type: "OBSERVATION_RECORDED",
    aggregate_type: "daily_observation",
    aggregate_id: "obs-http-test",
    occurred_at: "2026-10-04T15:00:00+08:00",
    version: 1,
    summary: "HTTP 冒烟观察",
    child_id: "c001",
    actor: { actor_id: "t-wang", role: "teacher", org_id: "site-a" },
    payload: { category: "mood", observed_at: "2026-10-04T15:00:00+08:00", content: "情绪平稳" },
  };
  const ok = await fetch(`${base}/v1/events`, { method: "POST", headers: headers({}), body: JSON.stringify(valid) });
  assert.equal(ok.status, 201);

  const bad = await fetch(`${base}/v1/events`, {
    method: "POST",
    headers: headers({}),
    body: JSON.stringify({
      ...valid,
      event_id: "evt-http-test-bad",
      aggregate_id: "obs-http-bad",
      event_type: "HEALTH_SCREENING_RECORDED",
      aggregate_type: "health_screening",
      payload: {
        screening_type: "growth",
        observed_at: "2026-10-04T15:00:00+08:00",
        indicators: [{ code: "X", label: "x", value: 1 }],
        diagnosis: "自动诊断应被拒绝",
      },
    }),
  });
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.ok(body.details.some((m) => m.includes("诊断字段")));
});

test("非法 JSON 返回 400", async () => {
  const res = await fetch(`${base}/v1/events`, { method: "POST", headers: headers({}), body: "{不是json" });
  assert.equal(res.status, 400);
});
