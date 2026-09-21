import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";

import defaultApp from "./index.js";

function keysEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function writeJson(outgoing, status, body, extraHeaders) {
  if (outgoing.headersSent || outgoing.destroyed) return;
  outgoing.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  outgoing.end(JSON.stringify(body));
}

function write413AndClose(outgoing, incoming, maxBytes) {
  if (outgoing.headersSent || outgoing.destroyed) {
    incoming.destroy();
    return;
  }
  incoming.pause();
  outgoing.writeHead(413, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  outgoing.end(
    JSON.stringify({
      error: {
        message: `请求体过大，最大允许 ${maxBytes} 字节`,
        type: "invalid_request_error",
        code: "body_too_large",
      },
    }),
  );
  outgoing.on("finish", () => incoming.destroy());
}

function hasRequestBody(incoming) {
  return (
    incoming.headers["transfer-encoding"] !== undefined ||
    (incoming.headers["content-length"] !== undefined &&
      incoming.headers["content-length"] !== "0")
  );
}

function readBody(incoming, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let rejected = false;
    incoming.on("data", (chunk) => {
      if (rejected) return;
      received += chunk.length;
      if (received > maxBytes) {
        rejected = true;
        incoming.removeAllListeners("data");
        incoming.removeAllListeners("end");
        incoming.pause();
        reject(Object.assign(new Error("body_too_large"), { code: "BODY_TOO_LARGE" }));
      } else {
        chunks.push(chunk);
      }
    });
    incoming.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    incoming.on("error", (err) => { if (!rejected) reject(err); });
  });
}

export function createAppServer(opts = {}) {
  const appHandler = opts.app ?? defaultApp;
  const apiKeysRaw = opts.apiKeys
    ?? (opts.apiKey ? [opts.apiKey] : null)
    ?? (process.env.API_KEYS ? process.env.API_KEYS.split(",").map((k) => k.trim()).filter(Boolean) : null)
    ?? [process.env.API_KEY || "sk-c96e08d2c3e20a3e244c51ee69888d0a96400b1a3883aa4e"];
  const apiKeys = new Set(apiKeysRaw);
  const corsOrigin = opts.corsOrigin ?? process.env.CORS_ORIGIN ?? "*";
  const maxBodyBytes = opts.maxBodyBytes ?? 11 * 1024 * 1024;
  const runtimeEnv = {
    SILICONFLOW_API_KEY: opts.siliconflowApiKey ?? process.env.SILICONFLOW_API_KEY ?? "",
    CORS_ORIGIN: corsOrigin,
  };

  function matchApiKey(request) {
    const authorization = request.headers.authorization || "";
    const bearer = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    const headerKey = request.headers["x-api-key"] || "";
    for (const key of apiKeys) {
      if (keysEqual(bearer, key) || keysEqual(String(headerKey), key)) return key;
    }
    return null;
  }

  const server = createServer(async (incoming, outgoing) => {
    try {
      const hostHeader = incoming.headers.host || "127.0.0.1";
      const url = new URL(incoming.url || "/", `http://${hostHeader}`);
      const method = incoming.method || "GET";

      let bodyBuffer = null;
      if (hasRequestBody(incoming)) {
        const contentLength = parseInt(incoming.headers["content-length"], 10);
        if (contentLength > maxBodyBytes) {
          write413AndClose(outgoing, incoming, maxBodyBytes);
          return;
        }
        try {
          bodyBuffer = await readBody(incoming, maxBodyBytes);
        } catch (err) {
          if (err.code === "BODY_TOO_LARGE") {
            write413AndClose(outgoing, incoming, maxBodyBytes);
            return;
          }
          throw err;
        }
      }

      if (url.pathname === "/healthz") {
        writeJson(outgoing, 200, { status: "ok" });
        return;
      }

      if (method === "OPTIONS") {
        outgoing.writeHead(204, {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
          "Access-Control-Allow-Headers":
            incoming.headers["access-control-request-headers"] ||
            "Authorization,Content-Type,x-api-key",
          "Access-Control-Max-Age": "86400",
        });
        outgoing.end();
        return;
      }

      let authenticatedKey = null;
      if (url.pathname.startsWith("/v1/")) {
        authenticatedKey = matchApiKey(incoming);
        if (!authenticatedKey) {
          writeJson(outgoing, 401, {
            error: {
              message: "Invalid API key",
              type: "authentication_error",
              code: "invalid_api_key",
            },
          });
          return;
        }
      }

      const reqHeaders = new Headers(incoming.headers);
      if (authenticatedKey) reqHeaders.set("x-authenticated-key", authenticatedKey);

      const request = new Request(url, {
        method,
        headers: reqHeaders,
        body: method !== "GET" && method !== "HEAD" ? bodyBuffer : undefined,
        duplex: "half",
      });

      const pending = [];
      const response = await appHandler.fetch(request, runtimeEnv, {
        waitUntil(promise) {
          pending.push(Promise.resolve(promise));
        },
      });

      if (outgoing.destroyed || outgoing.headersSent) return;

      outgoing.statusCode = response.status;
      outgoing.statusMessage = response.statusText;
      response.headers.forEach((value, name) => {
        outgoing.setHeader(name, value);
      });

      if (!response.body || method === "HEAD") {
        outgoing.end();
      } else {
        Readable.fromWeb(response.body).pipe(outgoing);
      }

      if (pending.length > 0) {
        Promise.allSettled(pending).catch(() => {});
      }
    } catch (error) {
      console.error(error);
      if (!outgoing.headersSent && !outgoing.destroyed) {
        writeJson(outgoing, 500, {
          error: {
            message: "Internal server error",
            type: "api_error",
            code: "internal_error",
          },
        });
      } else if (!outgoing.destroyed) {
        outgoing.destroy(error);
      }
    }
  });

  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return server;
}

const host = process.env.HOST || "0.0.0.0";
const port = Number.parseInt(process.env.PORT || "8787", 10);

if (process.env.NODE_ENV !== "test") {
  const server = createAppServer();
  server.listen(port, host, () => {
    console.log(`TTS service listening on http://${host}:${port}`);
  });
}
