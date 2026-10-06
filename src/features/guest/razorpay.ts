/**
 * Razorpay Checkout in the guest's browser.
 *
 * The browser only opens the payment window and hands Razorpay's response to
 * the server (POST …/payments/confirm), which checks the signature with the key
 * secret and asks Razorpay whether the payment was captured. Nothing here marks
 * anything paid. The order id, amount and public key come from the server's
 * checkout session (the Payment row's amount), never from page state.
 */

export const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

/** The fields of Razorpay's success response the server verifies. */
export type RazorpaySuccess = { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string };
type FailedAttempt = { error?: { description?: string; reason?: string } };

type RazorpayInstance = { open(): void; on(event: "payment.failed", cb: (r: FailedAttempt) => void): void; close?(): void };
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayCtor;
  }
}

let loading: Promise<RazorpayCtor> | null = null;

/** Load checkout.js once. Rejects (and allows a later retry) when it cannot be loaded. */
export function loadRazorpay(timeoutMs = 15000): Promise<RazorpayCtor> {
  if (typeof window === "undefined") return Promise.reject(new Error("Razorpay Checkout needs a browser"));
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  loading ??= new Promise<RazorpayCtor>((resolve, reject) => {
    const fail = (msg: string) => {
      loading = null;
      reject(new Error(msg));
    };
    const timer = window.setTimeout(() => fail("The payment window took too long to load. Check your connection and try again."), timeoutMs);
    const s = document.createElement("script");
    s.src = RAZORPAY_CHECKOUT_SRC;
    s.async = true;
    s.onload = () => {
      window.clearTimeout(timer);
      if (window.Razorpay) resolve(window.Razorpay);
      else fail("The payment window could not start.");
    };
    s.onerror = () => {
      window.clearTimeout(timer);
      s.remove();
      fail("The payment window could not be loaded. Check your connection and try again.");
    };
    document.head.appendChild(s);
  });
  return loading;
}

export type CheckoutOutcome = { kind: "success"; response: RazorpaySuccess } | { kind: "dismissed" };

/**
 * Open Razorpay Checkout for the server's gateway order. Resolves once: with
 * Razorpay's signed response, or when the guest closes the window. A declined
 * attempt is reported through `onAttemptFailed` while the window stays open
 * (Razorpay lets the guest retry inside the same checkout).
 */
export async function openRazorpayCheckout(args: {
  keyId: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  restaurantName: string;
  description: string;
  onAttemptFailed?: (message: string) => void;
}): Promise<CheckoutOutcome> {
  const Razorpay = await loadRazorpay();
  return new Promise<CheckoutOutcome>((resolve) => {
    let settled = false;
    const done = (o: CheckoutOutcome) => {
      if (settled) return;
      settled = true;
      resolve(o);
    };
    const rzp = new Razorpay({
      key: args.keyId,
      order_id: args.orderId,
      amount: args.amountPaise,
      currency: args.currency,
      name: args.restaurantName,
      description: args.description,
      handler: (response: RazorpaySuccess) => done({ kind: "success", response }),
      modal: { ondismiss: () => done({ kind: "dismissed" }), confirm_close: true },
      theme: { color: "#B5482A" },
    });
    rzp.on("payment.failed", (r) => args.onAttemptFailed?.(r.error?.description || "The payment was declined."));
    rzp.open();
  });
}
