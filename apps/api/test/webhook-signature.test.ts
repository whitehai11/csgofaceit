import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyInternalRequest } from "../src/security";

function makeReq(path: string, body: unknown, secret: string, nonce = "abcd1234efab5678") {
  const timestamp = String(Date.now());
  const bodyHash = crypto.createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
  const payload = `${timestamp}.${nonce}.POST.${path}.${bodyHash}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return {
    method: "POST",
    url: path,
    body,
    headers: {
      "x-internal-timestamp": timestamp,
      "x-internal-nonce": nonce,
      "x-internal-signature": signature
    }
  };
}

function makeReply() {
  return {
    status: 200,
    payload: null as any,
    code(v: number) {
      this.status = v;
      return this;
    },
    send(v: any) {
      this.payload = v;
      return this;
    }
  };
}

test("verifyInternalRequest accepts valid HMAC signature", async () => {
  const secret = "super-secret-signing-key";
  const req = makeReq("/internal/test", { hello: "world" }, secret);
  const reply = makeReply();
  const redis = {
    async set() {
      return "OK";
    }
  } as any;

  const ok = await verifyInternalRequest(req as any, reply as any, { secret, redis });
  assert.equal(ok, true);
  assert.equal(reply.status, 200);
});

test("verifyInternalRequest rejects replay nonce", async () => {
  const secret = "super-secret-signing-key";
  const req = makeReq("/internal/test", { hello: "world" }, secret);
  const reply = makeReply();
  const redis = {
    async set() {
      return null;
    }
  } as any;

  const ok = await verifyInternalRequest(req as any, reply as any, { secret, redis });
  assert.equal(ok, false);
  assert.equal(reply.status, 409);
});
