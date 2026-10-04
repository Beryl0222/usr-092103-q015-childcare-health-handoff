/**
 * 服务启动入口：默认使用 data/runtime 下的 JSONL 持久化，
 * 首次启动且库为空时载入 data/sample-events.json 联调样例。
 */
import { readFileSync } from "node:fs";
import { HandoffService } from "./handoff.js";
import { EventStore } from "./store.js";
import { createApp } from "./server.js";

const dir = process.env.DATA_DIR ?? "data/runtime";
const service = new HandoffService({ store: new EventStore({ dir }) });

if (process.env.SEED_SAMPLE !== "0" && service.store.allEvents().length === 0) {
  const samplePath = new URL("../data/sample-events.json", import.meta.url);
  const events = JSON.parse(readFileSync(samplePath, "utf8"));
  for (const event of events) {
    service.ingest(event);
  }
  console.log(`已载入医育联动联调样例：${events.length} 条事件`);
}

const port = Number(process.env.PORT ?? 3000);
createApp(service).listen(port, () => {
  console.log(`医育联动健康接力后端监听 http://localhost:${port}`);
});
