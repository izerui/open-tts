import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createAppServer } from "../server.mjs";
import realApp from "../index.js";

const API_KEY = "test-key-owner";
const API_KEY_PUBLIC = "test-key-public";
const MAX_BODY = 1024;

let server;
let baseUrl;
let originalFetch;

before(async () => {
  originalFetch = globalThis.fetch;
  server = createAppServer({
    apiKeys: [API_KEY, API_KEY_PUBLIC],
    corsOrigin: "*",
    maxBodyBytes: MAX_BODY,
    siliconflowApiKey: "",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => { globalThis.fetch = originalFetch; });
after(() => new Promise((r) => server.close(r)));

// --- helpers ---

function httpReq(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, { method, headers: { host: url.host, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let json; try { json = JSON.parse(raw); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw, socket: res.socket });
      });
    });
    req.on("error", reject);
    if (body !== undefined) {
      if (typeof body === "string" || Buffer.isBuffer(body)) req.end(body);
      else req.end();
    } else {
      req.end();
    }
  });
}

function authH() { return { Authorization: `Bearer ${API_KEY}` }; }

function postSpeech(obj, key) {
  const payload = JSON.stringify(obj);
  const h = key ? { Authorization: `Bearer ${key}` } : authH();
  return httpReq("POST", "/v1/audio/speech", {
    ...h, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)),
  }, payload);
}

function buildMultipart(fields) {
  const boundary = "----TB" + Date.now();
  const parts = [];
  for (const [name, value, filename, ct] of fields) {
    let h = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
    if (filename) h += `; filename="${filename}"`;
    h += "\r\n";
    if (ct) h += `Content-Type: ${ct}\r\n`;
    h += "\r\n";
    parts.push(Buffer.from(h));
    parts.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value)));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function multipartPost(path, fields) {
  const { body, contentType } = buildMultipart(fields);
  return httpReq("POST", path, { ...authH(), "Content-Type": contentType, "Content-Length": String(body.length) }, body);
}

const FAKE_JWT = Buffer.from(JSON.stringify({ exp: 9999999999, r: "test" })).toString("base64url");
const TOKEN_RESP = JSON.stringify({ t: `h.${FAKE_JWT}.s`, r: "test" });
const AUDIO = Buffer.alloc(64, 0x41);

function mockTts() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("microsofttranslator.com"))
      return new Response(TOKEN_RESP, { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("tts.speech.microsoft.com"))
      return new Response(new Blob([AUDIO]), { status: 200 });
    return originalFetch(url);
  };
}

function mockTtsBlocking() {
  const blocked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("microsofttranslator.com"))
      return new Response(TOKEN_RESP, { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("tts.speech.microsoft.com"))
      return new Promise((resolve) => {
        blocked.push(() => resolve(new Response(new Blob([AUDIO]), { status: 200 })));
      });
    return originalFetch(url);
  };
  return blocked;
}

function waitSocketClosed(socket, timeoutMs = 2000) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket did not close within timeout")), timeoutMs);
    socket.on("close", () => { clearTimeout(timer); resolve(); });
  });
}

function makeStreamReq(method, path, headers) {
  const url = new URL(path, baseUrl);
  let resolveFn, rejectFn;
  const responsePromise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  const req = http.request(url, { method, headers: { host: url.host, ...headers } }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      let json; try { json = JSON.parse(raw); } catch { json = null; }
      resolveFn({ status: res.statusCode, headers: res.headers, body: json, raw, socket: res.socket });
    });
  });
  req.on("error", rejectFn);
  return { req, response: responsePromise };
}

// Creates a server with a spy app to verify app.fetch is NOT called on 413
function createSpyServer() {
  let fetchCallCount = 0;
  const spyApp = {
    fetch(...args) {
      fetchCallCount++;
      return realApp.fetch(...args);
    },
  };
  const s = createAppServer({
    apiKeys: [API_KEY, API_KEY_PUBLIC],
    corsOrigin: "*",
    maxBodyBytes: MAX_BODY,
    siliconflowApiKey: "",
    app: spyApp,
  });
  return { server: s, getCallCount: () => fetchCallCount };
}

// =========== healthz ===========

describe("healthz", () => {
  it("返回 200", async () => { assert.equal((await httpReq("GET", "/healthz")).status, 200); });
});

// =========== 鉴权 ===========

describe("鉴权", () => {
  it("无 Key → 401", async () => { assert.equal((await httpReq("GET", "/v1/models")).status, 401); });
  it("错 Key → 401", async () => { assert.equal((await httpReq("GET", "/v1/models", { Authorization: "Bearer x" })).status, 401); });
  it("owner Key → 200", async () => { assert.equal((await httpReq("GET", "/v1/models", authH())).status, 200); });
  it("public Key → 200", async () => { assert.equal((await httpReq("GET", "/v1/models", { Authorization: `Bearer ${API_KEY_PUBLIC}` })).status, 200); });
});

// =========== OPTIONS ===========

describe("OPTIONS", () => {
  it("返回 204", async () => { assert.equal((await httpReq("OPTIONS", "/v1/audio/speech")).status, 204); });
});

// =========== 方法校验 ===========

describe("方法校验", () => {
  it("POST /v1/models → 405", async () => { assert.equal((await httpReq("POST", "/v1/models", authH(), "")).status, 405); });
  it("POST /v1/audio/voices → 405", async () => { assert.equal((await httpReq("POST", "/v1/audio/voices", authH(), "")).status, 405); });
  it("GET /v1/audio/speech → 405", async () => { assert.equal((await httpReq("GET", "/v1/audio/speech", authH())).status, 405); });
  it("GET /v1/audio/transcriptions → 405", async () => { assert.equal((await httpReq("GET", "/v1/audio/transcriptions", authH())).status, 405); });
});

// =========== Content-Length 超限 ===========

describe("Content-Length 超限", () => {
  it("声明超限只发首批 → 完整 413 JSON + Connection: close + socket 关闭", async () => {
    const { req, response } = makeStreamReq("POST", "/v1/audio/speech", {
      ...authH(), "Content-Type": "application/json", "Content-Length": String(MAX_BODY + 500),
    });
    req.write(Buffer.alloc(64, 0x42));
    const result = await response;
    assert.equal(result.status, 413);
    assert.equal(result.body?.error?.code, "body_too_large");
    assert.equal(result.headers.connection, "close");
    await waitSocketClosed(result.socket);
  });
});

// =========== chunked 分批超限 ===========

describe("chunked 分批超限", () => {
  it("分批写入超限 → 完整 413 JSON + Connection: close + socket 关闭", async () => {
    const { req, response } = makeStreamReq("POST", "/v1/audio/speech", {
      ...authH(), "Content-Type": "application/json", "Transfer-Encoding": "chunked",
    });
    let written = 0;
    const piece = Buffer.alloc(64, 0x43);
    const iv = setInterval(() => {
      if (req.destroyed || written > MAX_BODY + 512) { clearInterval(iv); if (!req.destroyed) req.end(); return; }
      req.write(piece);
      written += piece.length;
    }, 5);
    const result = await response;
    clearInterval(iv);
    assert.equal(result.status, 413);
    assert.equal(result.body?.error?.code, "body_too_large");
    assert.equal(result.headers.connection, "close");
    await waitSocketClosed(result.socket);
  });
});

// =========== 超大 OPTIONS ===========

describe("超大 OPTIONS 请求体", () => {
  it("OPTIONS + Content-Length 超限 → 413 + Connection: close + socket 关闭", async () => {
    const { req, response } = makeStreamReq("OPTIONS", "/v1/audio/speech", {
      "Content-Length": String(MAX_BODY + 100),
    });
    req.write(Buffer.alloc(64, 0x44));
    const result = await response;
    assert.equal(result.status, 413);
    assert.equal(result.body?.error?.code, "body_too_large");
    assert.equal(result.headers.connection, "close");
    await waitSocketClosed(result.socket);
  });

  it("OPTIONS + chunked 超限 → 413 + Connection: close + socket 关闭", async () => {
    const { req, response } = makeStreamReq("OPTIONS", "/v1/audio/speech", {
      "Transfer-Encoding": "chunked",
    });
    let written = 0;
    const piece = Buffer.alloc(64, 0x45);
    const iv = setInterval(() => {
      if (req.destroyed || written > MAX_BODY + 256) { clearInterval(iv); if (!req.destroyed) req.end(); return; }
      req.write(piece);
      written += piece.length;
    }, 5);
    const result = await response;
    clearInterval(iv);
    assert.equal(result.status, 413);
    assert.equal(result.body?.error?.code, "body_too_large");
    assert.equal(result.headers.connection, "close");
    await waitSocketClosed(result.socket);
  });
});

// =========== 超限请求不进入 app.fetch ===========

describe("超限请求不进入 app.fetch", () => {
  it("Content-Length 超限 → app.fetch 调用次数为 0", async () => {
    const { server: spyServer, getCallCount } = createSpyServer();
    await new Promise((r) => spyServer.listen(0, "127.0.0.1", r));
    const spyBase = `http://127.0.0.1:${spyServer.address().port}`;
    try {
      const big = Buffer.alloc(MAX_BODY + 100, 0x46);
      await new Promise((resolve, reject) => {
        const req = http.request(new URL("/v1/audio/speech", spyBase), {
          method: "POST",
          headers: { ...authH(), "Content-Type": "application/json", "Content-Length": String(big.length) },
        }, (res) => {
          res.resume();
          res.on("end", resolve);
        });
        req.on("error", reject);
        req.end(big);
      });
      assert.equal(getCallCount(), 0, "app.fetch should not be called on CL-exceeded request");
    } finally {
      await new Promise((r) => spyServer.close(r));
    }
  });

  it("chunked 超限 → app.fetch 调用次数为 0", async () => {
    const { server: spyServer, getCallCount } = createSpyServer();
    await new Promise((r) => spyServer.listen(0, "127.0.0.1", r));
    const spyBase = `http://127.0.0.1:${spyServer.address().port}`;
    try {
      await new Promise((resolve, reject) => {
        const req = http.request(new URL("/v1/audio/speech", spyBase), {
          method: "POST",
          headers: { ...authH(), "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
        }, (res) => {
          res.resume();
          res.on("end", resolve);
        });
        req.on("error", resolve);
        let written = 0;
        const piece = Buffer.alloc(128, 0x47);
        const iv = setInterval(() => {
          if (req.destroyed || written > MAX_BODY + 512) { clearInterval(iv); if (!req.destroyed) req.end(); return; }
          req.write(piece);
          written += piece.length;
        }, 5);
      });
      assert.equal(getCallCount(), 0, "app.fetch should not be called on chunked-exceeded request");
    } finally {
      await new Promise((r) => spyServer.close(r));
    }
  });
});

// =========== 413 原始协议验证 (net.Socket) ===========

const CHUNK_SIZE_RE = /^[0-9a-fA-F]+$/;
const CRLF_BUF = Buffer.from("\r\n");

function bufEq(buf, pos, expected) {
  if (pos + expected.length > buf.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (buf[pos + i] !== expected[i]) return false;
  }
  return true;
}

function parseExactBody(rawBuf) {
  const headerEndIdx = rawBuf.indexOf("\r\n\r\n");
  assert.ok(headerEndIdx >= 0, "Response must contain header/body separator");
  const headers = rawBuf.subarray(0, headerEndIdx).toString().toLowerCase();
  const afterHeaders = rawBuf.subarray(headerEndIdx + 4);

  if (headers.includes("transfer-encoding: chunked")) {
    const parts = [];
    let pos = 0;
    let sawTerminator = false;
    while (pos < afterHeaders.length) {
      const lineEnd = afterHeaders.indexOf(CRLF_BUF, pos);
      assert.ok(lineEnd >= pos, `Chunked: expected CRLF after chunk size at pos ${pos}`);
      const sizeStr = afterHeaders.subarray(pos, lineEnd).toString();
      assert.ok(CHUNK_SIZE_RE.test(sizeStr), `Chunked: invalid chunk size "${sizeStr}"`);
      const size = parseInt(sizeStr, 16);
      pos = lineEnd + 2;
      if (size === 0) {
        assert.ok(bufEq(afterHeaders, pos, CRLF_BUF), "Chunked: terminator 0 chunk must be followed by CRLF");
        pos += 2;
        sawTerminator = true;
        break;
      }
      assert.ok(pos + size <= afterHeaders.length, `Chunked: insufficient data for chunk of size ${size}`);
      parts.push(afterHeaders.subarray(pos, pos + size));
      pos += size;
      assert.ok(bufEq(afterHeaders, pos, CRLF_BUF), `Chunked: expected CRLF after chunk data at pos ${pos}`);
      pos += 2;
    }
    assert.ok(sawTerminator, "Chunked: must encounter terminator chunk (0\\r\\n\\r\\n)");
    assert.equal(pos, afterHeaders.length, `Chunked: no trailing bytes after terminator (consumed ${pos} of ${afterHeaders.length})`);
    return { body: Buffer.concat(parts).toString("utf-8") };
  }

  const clMatch = headers.match(/content-length:\s*(\d+)/);
  if (clMatch) {
    const cl = parseInt(clMatch[1], 10);
    assert.equal(afterHeaders.length, cl, `Content-Length declares ${cl} bytes but body is ${afterHeaders.length} bytes`);
    return { body: afterHeaders.toString("utf-8") };
  }

  return { body: afterHeaders.toString("utf-8") };
}

function rawSocketTest(port, writeFn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let intervalHandle = null;
    let timer = null;

    function cleanup(sock) {
      if (intervalHandle != null) { clearInterval(intervalHandle); intervalHandle = null; }
      if (timer != null) { clearTimeout(timer); timer = null; }
      if (sock && !sock.destroyed) sock.destroy();
    }

    function finish(sock, resultOrError, isError) {
      if (settled) return;
      settled = true;
      cleanup(sock);
      if (isError) reject(resultOrError);
      else resolve(resultOrError);
    }

    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      const h = writeFn(sock);
      if (h != null) intervalHandle = h;
    });
    const chunks = [];
    sock.on("data", (c) => chunks.push(c));

    timer = setTimeout(() => {
      const buf = Buffer.concat(chunks);
      finish(sock, { rawBuf: buf, rawStr: buf.toString(), closed: false }, false);
    }, 3000);

    sock.on("close", () => {
      const buf = Buffer.concat(chunks);
      finish(sock, { rawBuf: buf, rawStr: buf.toString(), closed: true }, false);
    });

    sock.on("error", (err) => finish(sock, err, true));
  });
}

function assert413Protocol(result) {
  const statusMatches = result.rawStr.match(/HTTP\/1\.1 413/g);
  assert.equal(statusMatches?.length, 1, "Exactly one HTTP/1.1 413 status line");
  assert.ok(/connection: close/i.test(result.rawStr), "Must include Connection: close");

  const { body } = parseExactBody(result.rawBuf);
  assert.ok(body, "Must have response body");
  const json = JSON.parse(body);
  assert.equal(json.error.code, "body_too_large");
  assert.ok(result.closed, "Server must close the connection (socket close event)");
}

describe("413 原始协议验证 (net.Socket)", () => {
  it("Content-Length 超限：单次 413 + 精确 body + Connection: close + socket close", async () => {
    const port = server.address().port;
    const result = await rawSocketTest(port, (sock) => {
      sock.write(
        `POST /v1/audio/speech HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Authorization: Bearer ${API_KEY}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${MAX_BODY + 500}\r\n` +
        `\r\n` +
        "x".repeat(64)
      );
    });
    assert413Protocol(result);
  });

  it("chunked 超限：单次 413 + 精确 chunked body + Connection: close + socket close", async () => {
    const port = server.address().port;
    const result = await rawSocketTest(port, (sock) => {
      sock.write(
        `POST /v1/audio/speech HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Authorization: Bearer ${API_KEY}\r\n` +
        `Content-Type: application/json\r\n` +
        `Transfer-Encoding: chunked\r\n` +
        `\r\n`
      );
      let written = 0;
      const iv = setInterval(() => {
        if (sock.destroyed || written > MAX_BODY + 512) { clearInterval(iv); return; }
        const chunk = Buffer.alloc(128, 0x50);
        sock.write(`${chunk.length.toString(16)}\r\n`);
        sock.write(chunk);
        sock.write("\r\n");
        written += chunk.length;
      }, 10);
      return iv;
    });
    assert413Protocol(result);
  });
});

// =========== 提前返回路径超限 ===========

describe("提前返回路径的请求体限制", () => {
  it("POST /healthz 超限 → 413", async () => {
    const big = Buffer.alloc(MAX_BODY + 100, 0x48);
    const { status, body } = await httpReq("POST", "/healthz", { "Content-Type": "application/octet-stream", "Content-Length": String(big.length) }, big);
    assert.equal(status, 413);
    assert.equal(body?.error?.code, "body_too_large");
  });
  it("POST /v1/models 无鉴权 + 超限 → 413", async () => {
    const big = Buffer.alloc(MAX_BODY + 100, 0x49);
    const { status, body } = await httpReq("POST", "/v1/models", { "Content-Type": "application/octet-stream", "Content-Length": String(big.length) }, big);
    assert.equal(status, 413);
    assert.equal(body?.error?.code, "body_too_large");
  });
});

// =========== TTS 参数校验 ===========

describe("TTS 参数校验", () => {
  it("缺少 input → 400", async () => { const r = await postSpeech({ voice: "alloy" }); assert.equal(r.status, 400); assert.equal(r.body.error.code, "invalid_input"); });
  it("input 非字符串 → 400", async () => { assert.equal((await postSpeech({ input: 123 })).status, 400); });
  it("input 空白 → 400", async () => { assert.equal((await postSpeech({ input: "   " })).status, 400); });
  it("input 超长 → 413", async () => { assert.equal((await postSpeech({ input: "a".repeat(10_001) })).status, 413); });
  it("非法 voice → 400", async () => { const r = await postSpeech({ input: "t", voice: "bad" }); assert.equal(r.status, 400); assert.equal(r.body.error.code, "invalid_voice"); });
  it("SSML 注入 style → 400", async () => { const r = await postSpeech({ input: "t", style: '"><x/>' }); assert.equal(r.status, 400); assert.equal(r.body.error.code, "invalid_style"); });
  it("speed > 2.0 → 400", async () => { assert.equal((await postSpeech({ input: "t", speed: "2.5" })).status, 400); });
  it("speed < 0.5 → 400", async () => { assert.equal((await postSpeech({ input: "t", speed: "0.3" })).status, 400); });
  it("pitch > 50 → 400", async () => { assert.equal((await postSpeech({ input: "t", pitch: "51" })).status, 400); });
  it("pitch < -50 → 400", async () => { assert.equal((await postSpeech({ input: "t", pitch: "-51" })).status, 400); });
});

// =========== 严格数值校验 ===========

describe("严格数值校验", () => {
  it("speed '1abc' → 400", async () => { const r = await postSpeech({ input: "t", speed: "1abc" }); assert.equal(r.status, 400); assert.equal(r.body.error.code, "invalid_speed"); });
  it("speed '0x1' → 400", async () => { assert.equal((await postSpeech({ input: "t", speed: "0x1" })).status, 400); });
  it("pitch '10xyz' → 400", async () => { assert.equal((await postSpeech({ input: "t", pitch: "10xyz" })).status, 400); });
  it("volume '5abc' → 400", async () => { assert.equal((await postSpeech({ input: "t", volume: "5abc" })).status, 400); });
  it("speed [1] → 400", async () => { assert.equal((await postSpeech({ input: "t", speed: [1] })).status, 400); });
  it("pitch 小数 '10.5' → 400（只接受整数）", async () => {
    const r = await postSpeech({ input: "t", pitch: "10.5" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "invalid_pitch");
  });
  it("volume 小数 '3.5' → 400（只接受整数）", async () => {
    const r = await postSpeech({ input: "t", volume: "3.5" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "invalid_volume");
  });
});

// =========== multipart 空字符串 ===========

describe("multipart 空字符串参数", () => {
  it("speed='' → 400", async () => { const r = await multipartPost("/v1/audio/speech", [["file", Buffer.from("hi"), "t.txt", "text/plain"], ["speed", ""]]); assert.equal(r.status, 400); assert.equal(r.body.error.code, "invalid_speed"); });
  it("voice='' → 400", async () => { const r = await multipartPost("/v1/audio/speech", [["file", Buffer.from("hi"), "t.txt", "text/plain"], ["voice", ""]]); assert.equal(r.status, 400); assert.equal(r.body.error.code, "invalid_voice"); });
  it("style='' → 400", async () => { const r = await multipartPost("/v1/audio/speech", [["file", Buffer.from("hi"), "t.txt", "text/plain"], ["style", ""]]); assert.equal(r.status, 400); assert.equal(r.body.error.code, "invalid_style"); });
});

// =========== JSON body 边界 ===========

describe("JSON body 边界", () => {
  function rawJsonPost(raw) {
    return httpReq("POST", "/v1/audio/speech", { ...authH(), "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) }, raw);
  }
  it("非法 JSON → 400", async () => { const r = await rawJsonPost("{{{"); assert.equal(r.status, 400); assert.equal(r.body.error.code, "invalid_json"); });
  it("null → 400", async () => { const r = await rawJsonPost("null"); assert.equal(r.status, 400); assert.equal(r.body.error.code, "invalid_json"); });
  it("数组 → 400", async () => { assert.equal((await rawJsonPost("[1]")).status, 400); });
});

// =========== FormData 非文件字段 ===========

describe("FormData 非文件字段", () => {
  it("TTS file=字符串 → 400", async () => { const r = await multipartPost("/v1/audio/speech", [["file", "nope"]]); assert.equal(r.status, 400); assert.equal(r.body.error.code, "missing_file"); });
  it("STT file=字符串 → 400", async () => { const r = await multipartPost("/v1/audio/transcriptions", [["file", "nope"]]); assert.equal(r.status, 400); assert.equal(r.body.error.code, "missing_file"); });
});

// =========== GET 端点 ===========

describe("GET 端点", () => {
  it("/v1/models → list", async () => { const r = await httpReq("GET", "/v1/models", authH()); assert.equal(r.status, 200); assert.equal(r.body.object, "list"); });
  it("/v1/audio/voices → list", async () => { const r = await httpReq("GET", "/v1/audio/voices", authH()); assert.equal(r.status, 200); assert.ok(r.body.data.length >= 21); });
});

// =========== 404 ===========

describe("404", () => {
  it("未知路径 → 404", async () => { assert.equal((await httpReq("GET", "/v1/x", authH())).status, 404); });
});

// =========== Web 页面 ===========

describe("Web 页面", () => {
  it("GET / → HTML", async () => { const r = await httpReq("GET", "/"); assert.equal(r.status, 200); assert.ok(r.headers["content-type"]?.includes("text/html")); });
});

// =========== 合法 TTS (mock) ===========

describe("合法 TTS 请求 (mock)", () => {
  it("JSON → 200 + audio/mpeg + 非空 body", async () => {
    mockTts();
    const r = await postSpeech({ input: "你好", voice: "alloy", speed: 1.0 });
    assert.equal(r.status, 200);
    assert.ok(r.headers["content-type"]?.includes("audio/mpeg"));
    assert.ok(r.raw.length > 0);
  });
  it("FormData 文件 → 200 + audio/mpeg", async () => {
    mockTts();
    const r = await multipartPost("/v1/audio/speech", [["file", Buffer.from("你好"), "t.txt", "text/plain"], ["voice", "zh-CN-XiaoxiaoNeural"]]);
    assert.equal(r.status, 200);
    assert.ok(r.headers["content-type"]?.includes("audio/mpeg"));
    assert.ok(r.raw.length > 0);
  });
});

// =========== SSML 音量值验证 ===========

describe("SSML 音量值", () => {
  it("volume=50 → SSML 包含 volume=\"+50%\"（不乘 100）", async () => {
    let capturedBody = null;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("microsofttranslator.com"))
        return new Response(TOKEN_RESP, { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("tts.speech.microsoft.com")) {
        capturedBody = typeof opts?.body === "string" ? opts.body : await new Response(opts?.body).text();
        return new Response(new Blob([AUDIO]), { status: 200 });
      }
      return originalFetch(url);
    };
    await postSpeech({ input: "test", voice: "alloy", volume: "50" });
    assert.ok(capturedBody, "Should have captured SSML body");
    assert.ok(capturedBody.includes('volume="+50%"'), `Expected volume="+50%" in SSML, got: ${capturedBody.match(/volume="[^"]*"/)?.[0]}`);
  });

  it("volume=-30 → SSML 包含 volume=\"-30%\"", async () => {
    let capturedBody = null;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("microsofttranslator.com"))
        return new Response(TOKEN_RESP, { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("tts.speech.microsoft.com")) {
        capturedBody = typeof opts?.body === "string" ? opts.body : await new Response(opts?.body).text();
        return new Response(new Blob([AUDIO]), { status: 200 });
      }
      return originalFetch(url);
    };
    await postSpeech({ input: "test", voice: "alloy", volume: "-30" });
    assert.ok(capturedBody);
    assert.ok(capturedBody.includes('volume="-30%"'), `Expected volume="-30%" in SSML, got: ${capturedBody.match(/volume="[^"]*"/)?.[0]}`);
  });

  it("volume=0 → SSML 包含 volume=\"+0%\"", async () => {
    let capturedBody = null;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("microsofttranslator.com"))
        return new Response(TOKEN_RESP, { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("tts.speech.microsoft.com")) {
        capturedBody = typeof opts?.body === "string" ? opts.body : await new Response(opts?.body).text();
        return new Response(new Blob([AUDIO]), { status: 200 });
      }
      return originalFetch(url);
    };
    await postSpeech({ input: "test", voice: "alloy", volume: "0" });
    assert.ok(capturedBody);
    assert.ok(capturedBody.includes('volume="+0%"'), `Expected volume="+0%" in SSML, got: ${capturedBody.match(/volume="[^"]*"/)?.[0]}`);
  });

  it("volume=100（边界最大值）→ SSML 包含 volume=\"+100%\"", async () => {
    let capturedBody = null;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("microsofttranslator.com"))
        return new Response(TOKEN_RESP, { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("tts.speech.microsoft.com")) {
        capturedBody = typeof opts?.body === "string" ? opts.body : await new Response(opts?.body).text();
        return new Response(new Blob([AUDIO]), { status: 200 });
      }
      return originalFetch(url);
    };
    await postSpeech({ input: "test", voice: "alloy", volume: "100" });
    assert.ok(capturedBody);
    assert.ok(capturedBody.includes('volume="+100%"'), `Expected volume="+100%" in SSML, got: ${capturedBody.match(/volume="[^"]*"/)?.[0]}`);
  });
});

// =========== Markdown 清洗 ===========

function mockTtsCapture() {
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("microsofttranslator.com"))
      return new Response(TOKEN_RESP, { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("tts.speech.microsoft.com")) {
      captured = typeof opts?.body === "string" ? opts.body : await new Response(opts?.body).text();
      return new Response(new Blob([AUDIO]), { status: 200 });
    }
    return originalFetch(url);
  };
  return () => captured;
}

describe("Markdown 清洗", () => {
  it("标题和粗体标记被去除，正文保留", async () => {
    const getCaptured = mockTtsCapture();
    await postSpeech({ input: "### 标题内容\n**粗体文字**普通文字", voice: "alloy" });
    const ssml = getCaptured();
    assert.ok(ssml);
    assert.ok(ssml.includes("标题内容"), "标题正文应保留");
    assert.ok(ssml.includes("粗体文字"), "粗体正文应保留");
    assert.ok(ssml.includes("普通文字"), "普通文字应保留");
    assert.ok(!ssml.includes("###"), "### 标记应被去除");
    assert.ok(!ssml.includes("**"), "** 标记应被去除");
  });

  it("代码块围栏去除，内容保留", async () => {
    const getCaptured = mockTtsCapture();
    await postSpeech({ input: "前文\n```js\nconsole.log(1)\n```\n后文", voice: "alloy" });
    const ssml = getCaptured();
    assert.ok(ssml);
    assert.ok(ssml.includes("前文"));
    assert.ok(ssml.includes("后文"));
    assert.ok(!ssml.includes("```"));
  });

  it("LaTeX 行内公式去除定界符，内容保留", async () => {
    const getCaptured = mockTtsCapture();
    await postSpeech({ input: "当 $M>0$ 时成立", voice: "alloy" });
    const ssml = getCaptured();
    assert.ok(ssml);
    assert.ok(!ssml.includes("$"), "$ 定界符应被去除");
    assert.ok(ssml.includes("M"), "公式变量应保留");
    assert.ok(ssml.includes("成立"), "正文应保留");
  });

  it("LaTeX 命令转可读中文", async () => {
    const getCaptured = mockTtsCapture();
    await postSpeech({ input: "$\\frac{1}{2}$加$\\sqrt{x}$", voice: "alloy" });
    const ssml = getCaptured();
    assert.ok(ssml);
    assert.ok(ssml.includes("分之"), "\\frac 应转为分之");
    assert.ok(ssml.includes("平方根"), "\\sqrt 应转为平方根");
  });

  it("纯文本保持不变", async () => {
    const getCaptured = mockTtsCapture();
    await postSpeech({ input: "这是一段普通文本，没有任何格式。", voice: "alloy" });
    const ssml = getCaptured();
    assert.ok(ssml);
    assert.ok(ssml.includes("这是一段普通文本，没有任何格式。"));
  });

  it("FormData 路径也应用清洗", async () => {
    const getCaptured = mockTtsCapture();
    await multipartPost("/v1/audio/speech", [
      ["file", Buffer.from("### 标题\n**加粗**"), "t.txt", "text/plain"],
      ["voice", "zh-CN-XiaoxiaoNeural"],
    ]);
    const ssml = getCaptured();
    assert.ok(ssml);
    assert.ok(ssml.includes("标题"));
    assert.ok(ssml.includes("加粗"));
    assert.ok(!ssml.includes("###"));
    assert.ok(!ssml.includes("**"));
  });
});

// =========== 并发控制 ===========

describe("并发控制", () => {
  it("先 10 个阻塞后第 11 个 → 429", async () => {
    const blocked = mockTtsBlocking();
    const first10 = [];
    let eleventhRes;
    try {
      for (let i = 0; i < 10; i++) first10.push(postSpeech({ input: `t${i}`, voice: "alloy" }));
      for (let i = 0; i < 200; i++) { if (blocked.length >= 10) break; await new Promise((r) => setTimeout(r, 20)); }
      assert.equal(blocked.length, 10, `Expected 10 blocked, got ${blocked.length}`);
      eleventhRes = await postSpeech({ input: "t10", voice: "alloy" });
    } finally {
      for (const release of blocked) release();
      await Promise.allSettled(first10);
    }
    assert.equal(eleventhRes.status, 429);
    assert.equal(eleventhRes.body?.error?.code, "too_many_requests");
  });
});

// =========== 按 Key 独立并发 ===========

describe("按 Key 独立并发控制", () => {
  it("owner Key 占满 10 个后，public Key 仍可进入", async () => {
    const blocked = mockTtsBlocking();
    const ownerReqs = [];
    try {
      for (let i = 0; i < 10; i++) ownerReqs.push(postSpeech({ input: `o${i}`, voice: "alloy" }, API_KEY));
      for (let i = 0; i < 200; i++) { if (blocked.length >= 10) break; await new Promise((r) => setTimeout(r, 20)); }
      assert.equal(blocked.length, 10, `Expected 10 blocked owner calls, got ${blocked.length}`);

      const publicReq = postSpeech({ input: "pub", voice: "alloy" }, API_KEY_PUBLIC);
      for (let i = 0; i < 100; i++) { if (blocked.length >= 11) break; await new Promise((r) => setTimeout(r, 20)); }
      assert.equal(blocked.length, 11, "public key request should reach upstream (not blocked by 429)");

      for (const release of blocked) release();
      const publicRes = await publicReq;
      assert.notEqual(publicRes.status, 429);
    } finally {
      for (const release of blocked) release();
      await Promise.allSettled(ownerReqs);
    }
  });

  it("同一个 Key 第 11 个请求 → 429", async () => {
    const blocked = mockTtsBlocking();
    const reqs = [];
    let eleventhRes;
    try {
      for (let i = 0; i < 10; i++) reqs.push(postSpeech({ input: `p${i}`, voice: "alloy" }, API_KEY_PUBLIC));
      for (let i = 0; i < 200; i++) { if (blocked.length >= 10) break; await new Promise((r) => setTimeout(r, 20)); }
      assert.equal(blocked.length, 10, `Expected 10 blocked, got ${blocked.length}`);
      eleventhRes = await postSpeech({ input: "p10", voice: "alloy" }, API_KEY_PUBLIC);
    } finally {
      for (const release of blocked) release();
      await Promise.allSettled(reqs);
    }
    assert.equal(eleventhRes.status, 429);
    assert.equal(eleventhRes.body?.error?.code, "too_many_requests");
  });
});

// =========== 普通响应不含 Connection: close ===========

describe("普通响应不含 Connection: close", () => {
  it("GET /v1/models", async () => { assert.notEqual((await httpReq("GET", "/v1/models", authH())).headers.connection, "close"); });
  it("合法 POST TTS", async () => { mockTts(); assert.notEqual((await postSpeech({ input: "hi", voice: "alloy" })).headers.connection, "close"); });
});
