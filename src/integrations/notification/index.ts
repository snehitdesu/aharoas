/**
 * Notification provider abstraction. In-app notifications are stored in the DB;
 * external channels (email/WhatsApp/push) go through a provider. The dev/mock
 * provider logs instead of sending. No external credentials are hardcoded —
 * real providers read them from env only.
 */
import { assertMockAllowed, unknownProvider } from "@/integrations/policy";

export type NotificationChannel = "IN_APP" | "EMAIL" | "WHATSAPP" | "PUSH";

export type OutboundNotification = {
  channel: NotificationChannel;
  to: string; // email / phone / device token
  title: string;
  body?: string;
};

export type SendResult = { delivered: boolean; providerRef?: string; reason?: string };

export interface NotificationProvider {
  readonly name: string;
  supports(channel: NotificationChannel): boolean;
  send(msg: OutboundNotification): Promise<SendResult>;
}

/** Development provider: records intent to the console; never fails. */
export class MockNotificationProvider implements NotificationProvider {
  readonly name = "mock";
  supports(): boolean {
    return true;
  }
  async send(msg: OutboundNotification): Promise<SendResult> {
    if (process.env.NODE_ENV !== "test") {
      console.log(`[notify:mock] ${msg.channel} -> ${msg.to}: ${msg.title}`);
    }
    return { delivered: true, providerRef: `mock_${Date.now()}` };
  }
}

/** Skeleton for a real email provider (SMTP/SES/etc). */
export class EmailNotificationProvider implements NotificationProvider {
  readonly name = "email";
  supports(channel: NotificationChannel): boolean {
    return channel === "EMAIL";
  }
  async send(): Promise<SendResult> {
    if (!process.env.EMAIL_API_KEY) return { delivered: false, reason: "EMAIL provider not configured (set EMAIL_API_KEY)" };
    throw new Error("EmailNotificationProvider not implemented; configure a real provider.");
  }
}

export function getNotificationProvider(): NotificationProvider {
  const name = (process.env.EMAIL_PROVIDER ?? process.env.WHATSAPP_PROVIDER ?? "mock").toLowerCase();
  switch (name) {
    case "email":
      return new EmailNotificationProvider();
    case "mock":
      // The mock provider pretends every send succeeds; it must never ship
      // notifications silently in production. Fail loudly unless explicitly opted in.
      assertMockAllowed("notification");
      return new MockNotificationProvider();
    default:
      return unknownProvider("notification", name);
  }
}
