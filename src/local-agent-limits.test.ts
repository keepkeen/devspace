import assert from "node:assert/strict";
import {
  BoundedAgentTextCollector,
  boundedLocalAgentText,
} from "./local-agent-limits.js";

const exact = new BoundedAgentTextCollector(512);
exact.append("hello ");
exact.append("世界");
assert.equal(exact.result("response"), "hello 世界");

const large = `${"前".repeat(400)}${"后".repeat(400)}`;
const bounded = boundedLocalAgentText(large, 512, "response");
assert.equal(Buffer.byteLength(bounded, "utf8") <= 512, true);
assert.match(bounded, /originalBytes=/u);
assert.match(bounded, /sha256=[a-f0-9]{64}/u);
assert.match(bounded, /^前/u);
assert.match(bounded, /后$/u);
