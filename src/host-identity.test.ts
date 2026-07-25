import assert from "node:assert/strict";
import test from "node:test";
import { hashOpenAiHostIdentity, hostIdentityDigest } from "./host-identity.js";

test("OpenAI host hints are HMAC-hashed and domain separated", () => {
  const identity = hashOpenAiHostIdentity({
    "openai/subject": "user-123",
    "openai/session": "conversation-456",
    "openai/organization": "org-789",
  }, "server-identity-key");

  assert.match(identity.subjectHash ?? "", /^sub_[A-Za-z0-9_-]{43}$/u);
  assert.match(identity.sessionHash ?? "", /^ses_[A-Za-z0-9_-]{43}$/u);
  assert.match(identity.organizationHash ?? "", /^org_[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(identity.subjectHash, identity.sessionHash);
  assert.equal(
    identity.subjectHash,
    hostIdentityDigest("subject", "user-123", "server-identity-key"),
  );
  assert.notEqual(
    identity.subjectHash,
    hostIdentityDigest("subject", "user-123", "different-key"),
  );
  assert.equal(JSON.stringify(identity).includes("user-123"), false);
});

test("invalid or oversized host hints are ignored", () => {
  assert.deepEqual(hashOpenAiHostIdentity({
    "openai/subject": "",
    "openai/session": "x".repeat(5_000),
    "openai/organization": 42,
  }, "key"), {});
});
