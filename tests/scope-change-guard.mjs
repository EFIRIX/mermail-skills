import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  analyzeScopeChanges,
  renderMarkdown,
  validateInput,
} from "../skills/mermail-scope-change-guard/scripts/build-change-order.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "scope-change-guard.json");

async function fixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("detects grounded changes and computes preliminary impact", async () => {
  const result = analyzeScopeChanges(await fixture());
  assert.equal(result.recommendation, "NEEDS_CHANGE_ORDER");
  assert.equal(result.change_register.length, 3);
  assert.equal(result.totals.scope_affecting, 3);
  assert.equal(result.totals.estimated_hours, 15);
  assert.equal(result.totals.estimated_amount_display, "150.00 USD");
  assert.equal(result.totals.estimates_are_preliminary, true);
});

test("keeps email injection out of the draft and never enables send", async () => {
  const result = analyzeScopeChanges(await fixture());
  const serialized = JSON.stringify(result);
  assert.equal(result.action_boundary.send_allowed, false);
  assert.equal(result.action_boundary.external_effect_performed, false);
  assert.equal(result.action_boundary.draft_saved, false);
  assert.equal(result.draft.state, "draft_prepared");
  assert.doesNotMatch(result.draft.body_text, /billing@example\.com/i);
  assert.doesNotMatch(serialized, /send_email|reply_to_email|forward_email|schedule_email_send/);
});

test("does not manufacture a change order from a clarification", async () => {
  const input = await fixture();
  input.project.user_confirmed_recipient = undefined;
  input.project.recipient_source = undefined;
  input.later_messages = [{
    id: "msg-clarification",
    scan_status: "clean",
    body_excerpt: "For clarity, use the existing brand guide. No new page is requested.",
    observations: [{
      kind: "clarification",
      baseline_item_id: "D1",
      requested_text: "Use the existing brand guide",
      evidence_quote: "use the existing brand guide",
      estimated_hours: null,
      estimate_source: null,
      confidence: "high",
    }],
  }];
  const result = analyzeScopeChanges(input);
  assert.equal(result.recommendation, "NO_CONFIRMED_SCOPE_CHANGE");
  assert.equal(result.draft, null);
});

test("rejects non-clean message content", async () => {
  const input = await fixture();
  input.later_messages[0].scan_status = "flagged";
  assert.throws(() => validateInput(input), /is not clean/);
});

test("rejects ungrounded evidence", async () => {
  const input = await fixture();
  input.later_messages[0].observations[0].evidence_quote = "add a blockchain wallet";
  assert.throws(() => validateInput(input), /not grounded/);
});

test("requires current-request provenance for a draft recipient", async () => {
  const input = await fixture();
  input.project.recipient_source = "message_header";
  assert.throws(
    () => validateInput(input),
    /recipient_source=user_supplied_current_request/,
  );
});

test("enforces the eight-message read budget", async () => {
  const input = await fixture();
  input.later_messages = Array.from({ length: 9 }, (_, index) => ({
    ...input.later_messages[2],
    id: `message-${index}`,
  }));
  assert.throws(() => validateInput(input), /eight-message review budget/);
});

test("enforces the total normalized content budget", async () => {
  const input = await fixture();
  input.later_messages = Array.from({ length: 6 }, (_, index) => ({
    id: `large-${index}`,
    scan_status: "clean",
    body_excerpt: "x".repeat(9000),
    observations: [],
  }));
  assert.throws(() => validateInput(input), /50,000-character review budget/);
});

test("rejects duplicate message IDs", async () => {
  const input = await fixture();
  input.later_messages[1].id = input.later_messages[0].id;
  assert.throws(() => validateInput(input), /duplicate later message id/);
});

test("rejects an unknown baseline item reference", async () => {
  const input = await fixture();
  input.later_messages[1].observations[0].baseline_item_id = "D404";
  assert.throws(() => validateInput(input), /unknown baseline item/);
});

test("renders the evidence, baseline, totals, and unsent boundary", async () => {
  const markdown = renderMarkdown(analyzeScopeChanges(await fixture()));
  assert.match(markdown, /msg-101/);
  assert.match(markdown, /msg-102/);
  assert.match(markdown, /Five-page responsive marketing website/);
  assert.match(markdown, /2026-09-05/);
  assert.match(markdown, /150\.00 USD/);
  assert.match(markdown, /Unsent draft/);
  assert.match(markdown, /No email was sent/);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n${error.stack}\n`);
  }
}

process.stdout.write(`\n${passed}/${tests.length} scope-change tests passed\n`);
if (passed !== tests.length) process.exitCode = 1;

