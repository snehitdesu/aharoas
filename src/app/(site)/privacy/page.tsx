import type { Metadata } from "next";
import Link from "next/link";
import { ProsePage } from "@/site/components/Prose";

export const metadata: Metadata = { title: "Privacy Policy (draft)", description: "Draft RESTORA privacy policy, for review.", alternates: { canonical: "/privacy" }, robots: { index: false, follow: true } };

export default function PrivacyPage() {
  return (
    <ProsePage eyebrow="Legal" title="Privacy Policy" draft intro="How the RESTORA website and the RESTORA software handle personal data, as implemented in version 1.0.">
      <h2>Who this covers</h2>
      <p>
        <strong>[To be completed: legal name, registered address and contact of the business that operates RESTORA.]</strong>
      </p>
      <p>
        RESTORA is software that a restaurant runs for itself, on its own server or on its own Windows computer. The restaurant decides what data it records about its staff and guests and is responsible for it. This policy will describe both the website and the software once it is completed.
      </p>

      <h2>This website</h2>
      <ul>
        <li>The public pages set no cookies and use no analytics, advertising or third-party scripts. Fonts and images are served from this site.</li>
        <li>The interactive demonstration runs in your browser. Nothing you do in it is sent anywhere.</li>
        <li>Signing in to RESTORA Web sets a session cookie that is needed to keep you signed in.</li>
        <li>The web server may keep standard request logs. <strong>[To be completed: hosting provider and log retention.]</strong></li>
      </ul>

      <h2>Data the software stores</h2>
      <p>Depending on how a restaurant uses it, RESTORA stores:</p>
      <ul>
        <li>Staff accounts: name, email, role and sign-in history. Passwords are stored only as salted hashes.</li>
        <li>Guests and customers: name, phone, email, orders, loyalty, feedback and reservations, when the restaurant records them.</li>
        <li>Orders, payments, invoices and the records that tax and accounting rules require.</li>
        <li>Integration credentials (payment gateway, messaging), stored encrypted.</li>
      </ul>
      <p>Card details are not stored by RESTORA. Online payments are handled by the restaurant&apos;s payment gateway.</p>

      <h2>Sharing</h2>
      <p>
        RESTORA sends data to third parties only when the restaurant turns on an integration: the payment gateway for online payments, and the messaging provider for order and payment messages to guests. See <Link href="/product/integrations">Integrations</Link>.
      </p>

      <h2>Retention</h2>
      <p>
        The software does not delete business records by itself. Exported files are removed after a configurable period (seven days by default). How long the restaurant keeps its own records is its decision. <strong>[To be completed: retention commitments, if any, for a hosted service.]</strong>
      </p>

      <h2>Your requests</h2>
      <p>
        Guests should contact the restaurant they ordered from. RESTORA 1.0 has no in-app erasure workflow yet; restaurants handle access, correction and erasure requests through a documented manual procedure. <strong>[To be completed: contact for privacy requests about this website.]</strong>
      </p>

      <h2>Security</h2>
      <p>
        See <Link href="/security">Security</Link> for how accounts, sessions, payments and data are protected.
      </p>
    </ProsePage>
  );
}
