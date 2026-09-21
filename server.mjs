import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";

import app from "./index.js";

const host = process.env.HOST || "0.0.0.0";
const port = Number.parseInt(process.env.PORT || "8787", 10);
const apiKey = process.env.API_KEY || "sk-tts-default-key";
const runtimeEnv = {
  SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY || "",
};

function keysEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isAuthorized(request) {
  const authorization = request.headers.authorization || "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const headerKey = request.headers["x-api-key"] || "";
  return keysEqual(bearer, apiKey) || keysEqual(String(headerKey), apiKey);
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const hostHeader = incoming.headers.host || `127.0.0.1:${port}`;
    const url = new URL(incoming.url || "/", `http://${hostHeader}`);

    if (url.pathname === "/healthz") {
      writeJson(outgoing, 200, { status: "ok" });
      return;
    }

    if (url.pathname.startsWith("/v1/") && !isAuthorized(incoming)) {
      writeJson(outgoing, 401, {
        error: {
          message: "Invalid API key",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      });
      return;
    }

    const method = incoming.method || "GET";
    const request = new Request(url, {
      method,
      headers: incoming.headers,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : Readable.toWeb(incoming),
      duplex: "half",
    });

    const pending = [];
    const response = await app.fetch(request, runtimeEnv, {
      waitUntil(promise) {
        pending.push(Promise.resolve(promise));
      },
    });

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
    if (!outgoing.headersSent) {
      writeJson(outgoing, 500, {
        error: {
          message: "Internal server error",
          type: "api_error",
          code: "internal_error",
        },
      });
    } else {
      outgoing.destroy(error);
    }
  }
});

server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

server.listen(port, host, () => {
  console.log(`TTS service listening on http://${host}:${port}`);
});
