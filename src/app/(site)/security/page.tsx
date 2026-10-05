import type { Metadata } from "next";
import { ProsePage } from "@/site/components/Prose";

export const metadata: Metadata = {
  title: "Security",
  description: "How RESTORA protects restaurant accounts, payments and data: sessions, roles, re-authentication, signed webhooks, encrypted secrets, audit log and the desktop app's hardening.",
  alternates: { canonical: "/security" },
};

export default function SecurityPage() {
  return (
    <ProsePage eyebrow="Security" title="How RESTORA protects your restaurant" intro="The controls that exist in RESTORA 1.0, and the gaps we know about. Each control is covered by automated tests or an executed check.">
      <h2>Accounts and sessions</h2>
      <ul>
        <li>Passwords hashed with bcrypt, with a minimum length and checks against common and personal passwords.</li>
        <li>Sessions in secure, HTTP-only cookies that expire after inactivity and are revoked on sign-out and password change.</li>
        <li>Sign-in attempts are rate-limited per account and per network address, with identical answers for unknown accounts.</li>
        <li>Refunds, voids, settings and restores need a fresh password confirmation.</li>
        <li>New staff get single-use setup links; nobody shares passwords.</li>
      </ul>

      <h2>Roles and access</h2>
      <ul>
        <li>Every request is authorised on the server by role and outlet. The interface is never the only guard.</li>
        <li>Sensitive changes are recorded in an append-only audit log.</li>
      </ul>

      <h2>Payments and integrations</h2>
      <ul>
        <li>Incoming payment and partner webhooks are verified by signature, bound to the right restaurant account and de-duplicated.</li>
        <li>Payment amounts are re-checked against the order before an order is marked paid.</li>
        <li>Integration keys are stored encrypted per restaurant and never reach the browser.</li>
        <li>Orders, payments and stock movements carry idempotency keys, so retries never double-charge or double-post.</li>
      </ul>

      <h2>The web application</h2>
      <ul>
        <li>A strict Content Security Policy, HSTS, framing protection and other security headers on every response.</li>
        <li>Cross-site request protection on every change.</li>
        <li>Input validated at every boundary; errors never expose internals.</li>
        <li>Logs redact credentials and mask email addresses and phone numbers.</li>
      </ul>

      <h2>The desktop application</h2>
      <ul>
        <li>The local server listens only on the computer itself.</li>
        <li>The app window is sandboxed, cannot run Node.js code and can only load RESTORA itself.</li>
        <li>Electron hardening: no run-as-Node, no debugging switches, and the app archive is integrity-checked at launch.</li>
        <li>The install secret is protected by the operating system&apos;s key store.</li>
      </ul>

      <h2>Known gaps</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Gap</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>No multi-factor authentication</td>
            <td>Planned for owners and managers</td>
          </tr>
          <tr>
            <td>Windows installer is not code-signed</td>
            <td>Needs a code-signing certificate; SmartScreen may warn until then</td>
          </tr>
          <tr>
            <td>Scripts in the Content Security Policy allow inline code</td>
            <td>A nonce-based policy is planned</td>
          </tr>
          <tr>
            <td>One organisation per database</td>
            <td>Database row-level security is required before hosting several businesses together</td>
          </tr>
          <tr>
            <td>No in-app erasure of guest data</td>
            <td>Handled with a documented manual procedure</td>
          </tr>
        </tbody>
      </table>
    </ProsePage>
  );
}
