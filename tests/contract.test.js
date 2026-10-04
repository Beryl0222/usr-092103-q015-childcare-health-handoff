import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

test("最小样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("全流程联调样例中的每一条事件都通过校验", async () => {
  const events = JSON.parse(await readFile(new URL("../data/sample-events.json", import.meta.url), "utf8"));
  assert.ok(events.length >= 10, "样例应覆盖完整业务链路");
  for (const [index, event] of events.entries()) {
    const errors = validateEvent(event);
    assert.deepEqual(errors, [], `第 ${index + 1} 条样例 ${event.event_id} 校验失败：${errors.join("；")}`);
  }
});

test("联调样例中不存在任何诊断结论字段", async () => {
  const events = JSON.parse(await readFile(new URL("../data/sample-events.json", import.meta.url), "utf8"));
  const text = JSON.stringify(events);
  for (const forbidden of ["diagnosis", "diagnostic_result", "confirmed_condition"]) {
    assert.ok(!text.includes(forbidden), `样例中出现诊断字段：${forbidden}`);
  }
});
