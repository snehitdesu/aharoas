/**
 * Razorpay TEST-MODE connectivity check against the real Razorpay API, through
 * RESTORA's own adapter (src/integrations/payment). Read-only for your books:
 * it creates one ₹1.00 test-mode order at Razorpay and touches no database.
 *
 *   RAZORPAY_KEY_ID=rzp_test_… RAZORPAY_KEY_SECRET=… RAZORPAY_WEBHOOK_SECRET=… npx tsx scripts/razorpay/sandbox-check.ts
 *
 * Checks: test keys only (refuses rzp_live_), credentials accepted (health),
 * a gateway order for a server amount is created with the exact paise amount,
 * an unpaid order verifies as PENDING (never as failed or paid), a forged
 * checkout signature is refused, and webhook signatures are computed with the
 * configured secret. Completing a payment needs a person (or a browser) on
 * Razorpay's hosted test checkout: see docs/payments-razorpay.md §Test-mode run.
 */
import { createHmac } from "node:crypto";
import { RazorpayPaymentProvider } from "@/integrations/payment";

async function main() {
  const keyId = process.env.RAZORPAY_KEY_ID ?? "";
  if (!keyId.startsWith("rzp_test_")) throw new Error("Set RAZORPAY_KEY_ID to a TEST key (rzp_test_…). This check never runs against live keys.");
  if (!process.env.RAZORPAY_KEY_SECRET) throw new Error("Set RAZORPAY_KEY_SECRET");
  if (process.env.RAZORPAY_API_BASE) throw new Error("Unset RAZORPAY_API_BASE: this check must talk to Razorpay itself");
  const rzp = new RazorpayPaymentProvider();
  const results: Array<[string, boolean, string?]> = [];
  const check = (name: string, ok: boolean, detail?: string) => results.push([name, ok, detail]);

  check("mode is SANDBOX", rzp.mode === "SANDBOX", rzp.mode);
  check("credentials accepted (GET /payments)", await rzp.healthCheck());
  const local = `sandbox-check-${Date.now().toString(36)}`;
  const session = await rzp.createCheckout({ paymentId: local, orderId: local, amount: 1, currency: "INR" });
  check("order created for exactly 100 paise", session.checkout.amount === 100, String(session.providerRef));
  const unpaid = await rzp.verify({ orderId: local, amount: 1, providerRef: session.providerRef });
  check("unpaid order is PENDING (not failed, not paid)", unpaid.verified === false && unpaid.pending === true, unpaid.reason);
  const forged = await rzp.verify({ orderId: local, amount: 1, providerRef: session.providerRef, payload: { razorpay_order_id: session.providerRef, razorpay_payment_id: "pay_forged", razorpay_signature: "0".repeat(64) } });
  check("forged checkout signature refused", forged.verified === false && forged.reason === "Invalid checkout signature", forged.reason);
  const wh = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (wh) {
    const body = JSON.stringify({ account_id: "acc_check", event: "payment.captured", payload: {} });
    check("webhook signature verified with RAZORPAY_WEBHOOK_SECRET", rzp.verifyWebhook(body, createHmac("sha256", wh).update(body).digest("hex")) && !rzp.verifyWebhook(body, "f".repeat(64)));
  } else check("RAZORPAY_WEBHOOK_SECRET set", false);

  for (const [name, ok, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  const failed = results.filter((r) => !r[1]).length;
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll Razorpay test-mode checks passed.");
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
