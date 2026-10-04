/**
 * 医育联动健康接力 HTTP 接口（无第三方依赖）。
 * 所有读取接口都要求 x-access-reason；身份通过请求头传递，
 * 生产部署应替换为网关注入的已认证身份。
 */
import { createServer } from "node:http";
import { ValidationRejected, ConflictError } from "./store.js";
import { AccessDenied } from "./handoff.js";

const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function actorFromHeaders(headers) {
  return {
    actor_id: headers["x-actor-id"],
    role: headers["x-actor-role"],
    org_id: headers["x-actor-org"] || undefined,
    name: headers["x-actor-name"] || undefined,
  };
}

function decodeHeader(value) {
  if (!value) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function requestFromUrl(req, url) {
  const headers = req.headers;
  const actor = actorFromHeaders(headers);
  const scopes = {
    on_duty_class_ids: headers["x-on-duty-class-ids"]
      ? String(headers["x-on-duty-class-ids"]).split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    as_subject_id: headers["x-as-subject-id"] || undefined,
    care_scope_date: url.searchParams.get("date") || headers["x-care-scope-date"] || undefined,
  };
  return {
    actor,
    scopes,
    reason: headers["x-access-reason"] ? decodeHeader(String(headers["x-access-reason"])) : "",
  };
}

export function createApp(service) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // 写入领域事件
      if (req.method === "POST" && path === "/v1/events") {
        const raw = await readBody(req);
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "请求体不是合法 JSON" });
          return;
        }
        const stored = service.ingest(event);
        sendJson(res, 201, { ok: true, event: stored });
        return;
      }

      const childMatch = path.match(/^\/v1\/children\/([^/]+)\/(events|medical|audit)$/);
      if (req.method === "GET" && childMatch) {
        const [, childId, view] = childMatch;
        const request = requestFromUrl(req, url);
        if (view === "events") sendJson(res, 200, service.viewChildEvents(childId, request));
        if (view === "medical") sendJson(res, 200, service.medicalView(childId, request));
        if (view === "audit") sendJson(res, 200, service.parentAudit(childId, request));
        return;
      }

      if (req.method === "GET" && path === "/v1/care-hints") {
        sendJson(res, 200, service.careHints(requestFromUrl(req, url)));
        return;
      }

      if (req.method === "GET" && path === "/v1/referrals") {
        sendJson(res, 200, service.referralTracking(requestFromUrl(req, url)));
        return;
      }

      if (req.method === "GET" && path === "/v1/quality-metrics") {
        sendJson(res, 200, service.qualityMetrics(requestFromUrl(req, url)));
        return;
      }

      sendJson(res, 404, { error: "未找到接口" });
    } catch (error) {
      if (error instanceof ValidationRejected) {
        sendJson(res, 400, { error: "事件校验未通过", details: error.errors });
      } else if (error instanceof ConflictError) {
        sendJson(res, 409, { error: error.message });
      } else if (error instanceof AccessDenied) {
        sendJson(res, 403, { error: error.message });
      } else if (error.statusCode) {
        sendJson(res, error.statusCode, { error: error.message });
      } else {
        sendJson(res, 500, { error: "服务内部错误" });
        // eslint-disable-next-line no-console
        console.error(error);
      }
    }
  });
}
