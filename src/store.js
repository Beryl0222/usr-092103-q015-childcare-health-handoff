/**
 * 追加型事件存储与访问审计日志。
 * 事件只追加、不可修改；迟到事件（如晚到的回访）按 occurred_at 挂载，
 * 不覆盖任何现场记录。dir 为空时使用纯内存存储，便于测试。
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export class ValidationRejected extends Error {
  constructor(errors) {
    super(`事件被拒绝：${errors.join("；")}`);
    this.name = "ValidationRejected";
    this.errors = errors;
  }
}

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
  }
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export class EventStore {
  constructor({ dir = null } = {}) {
    this.dir = dir;
    if (dir) mkdirSync(dir, { recursive: true });
    this.eventsPath = dir ? join(dir, "events.jsonl") : null;
    this.auditPath = dir ? join(dir, "audit.jsonl") : null;
    /** @type {any[]} */
    this.events = this.eventsPath ? readJsonl(this.eventsPath) : [];
    /** @type {any[]} */
    this.audit = this.auditPath ? readJsonl(this.auditPath) : [];
  }

  #appendLine(file, record) {
    if (file) appendFileSync(file, `${JSON.stringify(record)}\n`);
  }

  hasEvent(eventId) {
    return this.events.some((e) => e.event_id === eventId);
  }

  getEvent(eventId) {
    return this.events.find((e) => e.event_id === eventId) ?? null;
  }

  eventsForChild(childId) {
    return this.events.filter((e) => e.child_id === childId);
  }

  allEvents() {
    return [...this.events];
  }

  /**
   * 追加事件。唯一性、聚合版本号单调、关联事件存在性在此强校验。
   */
  append(event) {
    if (this.hasEvent(event.event_id)) {
      throw new ConflictError(`event_id 已存在：${event.event_id}`);
    }
    const sameAggregate = this.events
      .filter((e) => e.aggregate_type === event.aggregate_type && e.aggregate_id === event.aggregate_id)
      .map((e) => e.version);
    const expected = sameAggregate.length === 0 ? 1 : Math.max(...sameAggregate) + 1;
    if (event.version !== expected) {
      throw new ConflictError(
        `聚合 ${event.aggregate_type}/${event.aggregate_id} 的 version 必须连续递增：期望 ${expected}，收到 ${event.version}`,
      );
    }
    if (event.linked_event_id) {
      const linked = this.getEvent(event.linked_event_id);
      if (!linked) {
        throw new ConflictError(`linked_event_id 指向不存在的事件：${event.linked_event_id}`);
      }
      if (linked.child_id !== event.child_id) {
        throw new ConflictError("linked_event_id 必须指向同一儿童的事件");
      }
    }
    this.events.push(event);
    this.#appendLine(this.eventsPath, event);
    return event;
  }

  addAudit(entry) {
    this.audit.push(entry);
    this.#appendLine(this.auditPath, entry);
    return entry;
  }

  auditForChild(childId) {
    return this.audit
      .filter((a) => a.child_id === childId)
      .sort((a, b) => a.at.localeCompare(b.at));
  }
}
