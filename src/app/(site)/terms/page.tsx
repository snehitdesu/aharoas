import type { Metadata } from "next";
import Link from "next/link";
import { ProsePage } from "@/site/components/Prose";

export const metadata: Metadata = { title: "Terms of Service (draft)", description: "Draft RESTORA terms of service, for review.", alternates: { canonical: "/terms" }, robots: { index: false, follow: true } };

export default function TermsPage() {
  return (
    <ProsePage eyebrow="Legal" title="Terms of Service" draft intro="The terms for using the RESTORA website and software. Placeholders in brackets must be completed and reviewed.">
      <h2>1. Who we are</h2>
      <p>
        <strong>[To be completed: the legal entity that provides RESTORA, its address and contact.]</strong>
      </p>

      <h2>2. The software</h2>
      <p>
        RESTORA is restaurant management software provided as a Windows desktop application and as a web application. The current release is a release candidate; see the <Link href="/resources/release-notes">release notes</Link>.
      </p>

      <h2>3. Licence and pricing</h2>
      <p>
        <strong>[To be completed: licence grant, pricing, billing and renewal. Pricing has not been published.]</strong>
      </p>

      <h2>4. Your data</h2>
      <p>
        The restaurant owns the data it records in RESTORA and is responsible for it, including keeping the records that tax law requires. See the <Link href="/privacy">Privacy Policy</Link>.
      </p>

      <h2>5. Tax and compliance</h2>
      <p>
        RESTORA produces GST-ready records. It is not a certified GST invoicing system: it does not generate e-invoices (IRN or signed QR) and does not file returns. The restaurant remains responsible for its tax compliance and should have its setup reviewed by an accountant.
      </p>

      <h2>6. Third-party services</h2>
      <p>Payment gateways, messaging providers and printers are provided by third parties under their own terms. RESTORA is not responsible for their availability.</p>

      <h2>7. Warranty and liability</h2>
      <p>
        <strong>[To be completed with legal review: warranty, limitation of liability, support and service levels, refunds, termination, governing law and dispute resolution.]</strong>
      </p>

      <h2>8. Changes</h2>
      <p>
        <strong>[To be completed: how changes to these terms are announced.]</strong>
      </p>
    </ProsePage>
  );
}
