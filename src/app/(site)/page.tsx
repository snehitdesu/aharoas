import Link from "next/link";
import { redirect } from "next/navigation";
import { Screen } from "@/site/components/Screen";
import { FlowStory, type FlowStep } from "@/site/components/FlowStory";
import { RoleSwitcher } from "@/site/components/RoleSwitcher";
import { ProductDemo } from "@/site/components/ProductDemo";
import { PlatformDownload } from "@/site/components/PlatformDownload";
import { MoreLink, SectionIntro } from "@/site/components/Section";
import { INTEGRATIONS, SOLUTIONS, STATUS_LABEL } from "@/site/content";
import { downloadState } from "@/site/release";
import { WEB_APP_PATH } from "@/site/config";

const FLOW: FlowStep[] = [
  { key: "qr", label: "Table QR", screen: "guest-cart", title: "A guest scans the table and orders.", body: "Each table has its own QR code. Guests open the live menu on their phone, build a cart and place the order. Staff accept it, or the guest pays online first." },
  { key: "pos", label: "POS", screen: "pos", title: "Staff order at the POS or on the floor.", body: "Cashiers use the POS; captains take rounds on their phone. Every order is tied to its table, covers and customer, with modifiers and discounts." },
  { key: "kot", label: "KOT and KDS", screen: "kitchen", title: "The kitchen gets one ticket per station.", body: "Sending an order creates a KOT for each station: kitchen, bakery or bar. The kitchen display moves it from new to in progress to ready, and the captain app shows it." },
  { key: "pay", label: "Payment", screen: "manager", title: "Settle by cash, UPI, card or online.", body: "Split and partial payments, refunds and bills, with GST-ready invoices numbered without gaps for each financial year. Managers see the day's takings live." },
  { key: "stock", label: "Inventory", screen: "ledger", title: "Every sale draws down stock by recipe.", body: "When an order is settled, RESTORA consumes the ingredients in its approved recipe and writes the movement to an append-only ledger at weighted average cost." },
  { key: "insight", label: "Analytics", screen: "analytics-sales", title: "The numbers come from the same records.", body: "Sales, menu, inventory and finance analytics read the orders, payments and stock movements the restaurant already recorded. Nothing is re-entered." },
];

const WHY = [
  { title: "One connected system", body: "Orders, kitchen, stock, purchasing, money and reports share one database. A sale is entered once and every module sees it." },
  { title: "Order-to-inventory connection", body: "Settled orders consume ingredients through approved, versioned recipes. Items sold without a recipe are queued, not silently ignored." },
  { title: "Finance you can reconcile", body: "Expected against counted cash, gap-free invoice numbers, gateway reconciliation and a daily close that refuses to run while orders are open." },
  { title: "Role-based by design", body: "Each role sees its own screen and permissions per outlet. Refunds, voids and settings need a fresh password confirmation." },
  { title: "Built for bad connections", body: "Orders, payments and stock movements carry idempotency keys, so a retry after a dropped connection never charges or posts twice." },
  { title: "Desktop and web", body: "Run RESTORA in the browser against your server, or install it on a Windows computer with everything stored locally." },
];

export default function HomePage() {
  // The desktop app serves this same build and opens "/": it goes straight to the operator app.
  if (process.env.AHAROS_STANDALONE === "1" || process.env.AHAROS_DESKTOP === "1") redirect("/dashboard");
  const dl = downloadState();

  return (
    <>
      {/* ---------------- Hero ---------------- */}
      <section aria-labelledby="hero-title" className="relative pt-14 sm:pt-20 lg:pt-24">
        <div className="s-wrap">
          <p className="s-eyebrow">Restaurant management software</p>
          <h1 id="hero-title" className="s-display mt-5">
            The operating system <br className="hidden lg:block" />
            for restaurants<span className="s-accent">.</span>
          </h1>
          <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <p className="s-lead max-w-[36rem]">Run orders, kitchen, inventory, procurement, finance, payments and analytics from one connected system.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/product" className="s-btn s-btn-primary">
                Explore RESTORA
              </Link>
              <Link href="/download" className="s-btn s-btn-ghost">
                Download RESTORA
              </Link>
              <Link href="#demo" className="s-link ml-1 py-3">
                See RESTORA in action <span className="s-arrow" aria-hidden>→</span>
              </Link>
            </div>
          </div>
        </div>

        <div className="s-wrap mt-14 sm:mt-20">
          <div className="relative pb-[12%] sm:pb-[6%]">
            <Screen name="pos" priority className="w-full" sizes="(min-width: 1280px) 1216px, 100vw" />
            <Screen name="captain" priority className="absolute bottom-0 right-[3%] w-[30%] max-w-[15.5rem] sm:right-[4%] sm:w-[19%]" sizes="(min-width: 1280px) 248px, 30vw" />
          </div>
          <p className="s-caption">The RESTORA POS and the captain app, showing sample data.</p>
        </div>
      </section>

      {/* ---------------- The restaurant runs through RESTORA ---------------- */}
      <section aria-labelledby="flow-title" className="s-section">
        <div className="s-wrap">
          <SectionIntro id="flow-title" eyebrow="One connected system" title="The restaurant runs through RESTORA." lead="Follow one order from the table to the numbers. Each step is a part of RESTORA, and each one hands its work to the next." />
          <div className="mt-12 lg:mt-4">
            <FlowStory steps={FLOW} />
          </div>
        </div>
      </section>

      {/* ---------------- POS ---------------- */}
      <section aria-labelledby="pos-title" className="s-section s-band">
        <div className="s-wrap">
          <SectionIntro id="pos-title" eyebrow="POS" align="split" title="Your restaurant floor. In one view." lead="Pick a table, see who is seated and what is running, add a round and send it to the kitchen. Dine-in, takeaway and delivery from the same screen." />
          <div className="s-reveal mx-auto mt-14 max-w-5xl">
            <Screen name="pos-floor" className="w-full" sizes="(min-width: 1024px) 1024px, 100vw" />
          </div>
          <dl className="s-reveal mt-14 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Tables and covers", "Floors and tables with live free or occupied status. Occupied tables open their running order."],
              ["Orders and rounds", "Menu with variants and modifiers, rounds fired to the kitchen, discounts and open orders."],
              ["Payments", "Cash, UPI, card and online. Split and partial payments, and refunds with a manager's confirmation."],
              ["Bills and KOT printing", "Bills and receipts, and KOTs printed to network ESC/POS printers per station."],
            ].map(([t, d]) => (
              <div key={t} className="border-t border-[color:var(--s-rule-strong)] pt-5">
                <dt className="s-h4">{t}</dt>
                <dd className="s-body mt-2 text-[color:var(--s-muted)]">{d}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-12">
            <MoreLink href="/product/pos">Explore POS</MoreLink>
          </p>
        </div>
      </section>

      {/* ---------------- QR ordering ---------------- */}
      <section aria-labelledby="qr-title" className="s-section overflow-hidden">
        <div className="s-wrap grid items-center gap-14 lg:grid-cols-2 lg:gap-20">
          <div>
            <SectionIntro id="qr-title" eyebrow="QR ordering" compact title="Turn every table into an ordering point." lead="Guests scan the QR code on their table and order from your live menu. The order enters the same engine as the POS, so the kitchen, the bill and the stock all see it." />
            <ol className="s-reveal mt-10 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-5">
              {["Scan", "Menu", "Cart", "Order", "Payment"].map((s, i) => (
                <li key={s} className="border-t-2 border-[color:var(--s-ink)] pt-3">
                  <span className="s-small s-num block">{String(i + 1).padStart(2, "0")}</span>
                  <span className="font-semibold text-[color:var(--s-ink)]">{s}</span>
                </li>
              ))}
            </ol>
            <p className="s-small s-reveal mt-6 max-w-lg">Payment before the order is optional and uses your payment gateway. Without it, staff accept the order and the guest pays at the end.</p>
            <p className="mt-10">
              <MoreLink href="/product/qr-ordering">Explore QR ordering</MoreLink>
            </p>
          </div>
          <div className="s-reveal flex items-end justify-center gap-4 sm:gap-6">
            <Screen name="guest-menu" className="w-[46%] max-w-[16rem] -translate-y-8" sizes="(min-width: 1024px) 256px, 46vw" />
            <Screen name="guest-cart" className="w-[46%] max-w-[16rem]" sizes="(min-width: 1024px) 256px, 46vw" />
          </div>
        </div>
      </section>

      {/* ---------------- Kitchen ---------------- */}
      <section aria-labelledby="kitchen-title" className="s-section s-dark">
        <div className="s-wrap">
          <SectionIntro id="kitchen-title" eyebrow="Kitchen" align="split" title="From order to kitchen, without the chaos." lead="Every round becomes a kitchen order ticket for each station that prepares it. The kitchen display moves it along, and the floor sees each change." />
          <div className="s-reveal mt-14">
            <Screen name="kitchen" className="w-full" sizes="(min-width: 1280px) 1216px, 100vw" />
          </div>
          <ol className="s-reveal mt-12 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["KOT", "One ticket per station, printed automatically if a printer is set up."],
              ["Accept", "The station takes the ticket. Each one shows table, covers and minutes waiting."],
              ["Preparing", "In progress until the dish is done."],
              ["Ready", "The captain app shows it, so food goes out hot."],
            ].map(([t, d], i) => (
              <li key={t} className="border-t border-[rgb(247_241_230/0.18)] pt-4">
                <p className="s-num text-sm text-[#f0b39a]">{String(i + 1).padStart(2, "0")}</p>
                <p className="mt-1 text-lg font-semibold text-[color:var(--s-on-dark)]">{t}</p>
                <p className="mt-1.5">{d}</p>
              </li>
            ))}
          </ol>
          <p className="mt-12">
            <MoreLink href="/product/kitchen">Explore the kitchen display</MoreLink>
          </p>
        </div>
      </section>

      {/* ---------------- Inventory ---------------- */}
      <section aria-labelledby="inventory-title" className="s-section">
        <div className="s-wrap grid items-center gap-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
          <div>
            <SectionIntro id="inventory-title" eyebrow="Inventory" compact title={<>Know what you have. <br />Know what you use.</>} />
            <p className="s-lead s-reveal mt-6">Recipes connect the menu to the store. Each settled sale consumes its ingredients, and every movement lands in one ledger.</p>
            <ul className="s-ticks s-reveal mt-8">
              <li>Stock on hand with reorder levels and value at weighted average cost</li>
              <li>Versioned, approved recipes and sub-recipes with plate costing</li>
              <li>Consumption on every settled sale</li>
              <li>Wastage with reasons, stock counts with variance</li>
              <li>Transfers, issues and production batches</li>
            </ul>
            <p className="mt-10">
              <MoreLink href="/product/inventory">Explore inventory</MoreLink>
            </p>
          </div>
          <div className="s-reveal">
            <Screen name="inventory" className="w-full" sizes="(min-width: 1280px) 720px, (min-width: 1024px) 58vw, 100vw" />
          </div>
        </div>
      </section>

      {/* ---------------- Procurement ---------------- */}
      <section aria-labelledby="procurement-title" className="s-section s-band">
        <div className="s-wrap">
          <SectionIntro id="procurement-title" eyebrow="Procurement" title="From purchase request to vendor payment." lead="One documented path for everything the restaurant buys. Each document creates the next, and receipts update stock." />
          <ol className="s-reveal mt-12 grid grid-cols-1 overflow-hidden rounded-[var(--s-radius)] bg-[color:var(--s-surface)] shadow-[0_0_0_1px_rgb(36_24_15/0.1)] sm:grid-cols-5">
            {[
              ["Indent", "A department asks for materials"],
              ["Purchase order", "Sent to the vendor"],
              ["GRN", "Goods received, posted to stock"],
              ["Bill", "The vendor's bill, matched to receipts"],
              ["Vendor payment", "Settles bills, updates dues"],
            ].map(([t, d], i) => (
              <li key={t} className="border-b border-[color:var(--s-rule)] p-5 last:border-0 sm:border-b-0 sm:border-r">
                <p className="s-num text-sm font-semibold text-[color:var(--s-accent-ink)]">{String(i + 1).padStart(2, "0")}</p>
                <p className="mt-1 text-lg font-semibold text-[color:var(--s-ink)]">{t}</p>
                <p className="s-small mt-1">{d}</p>
              </li>
            ))}
          </ol>
          <div className="s-reveal mt-10 grid gap-6 lg:grid-cols-2">
            <figure>
              <Screen name="procurement-po" className="w-full" sizes="(min-width: 1024px) 600px, 100vw" />
              <figcaption className="s-caption">Purchase orders by vendor, with receipts and totals.</figcaption>
            </figure>
            <figure>
              <Screen name="procurement-payments" className="w-full" sizes="(min-width: 1024px) 600px, 100vw" />
              <figcaption className="s-caption">Vendor dues: outstanding, overdue and paid.</figcaption>
            </figure>
          </div>
          <p className="mt-12">
            <MoreLink href="/product/procurement">Explore procurement</MoreLink>
          </p>
        </div>
      </section>

      {/* ---------------- Finance ---------------- */}
      <section aria-labelledby="finance-title" className="s-section">
        <div className="s-wrap grid items-center gap-14 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16">
          <div className="s-reveal order-2 lg:order-1">
            <Screen name="finance" className="w-full" sizes="(min-width: 1280px) 720px, (min-width: 1024px) 58vw, 100vw" />
          </div>
          <div className="order-1 lg:order-2">
            <SectionIntro id="finance-title" eyebrow="Finance" compact title="From every payment to every rupee." />
            <p className="s-lead s-reveal mt-6">Payments, invoices, expenses and cash in one place. Close the day against counted cash and read profit and loss for any period.</p>
            <ul className="s-ticks s-reveal mt-8">
              <li>GST-ready invoices and credit notes, numbered without gaps per financial year</li>
              <li>Payments and refunds by method, with gateway reconciliation</li>
              <li>Expenses and petty cash</li>
              <li>Cash drawer: float, expected, counted, variance</li>
              <li>Daily closing, profit and loss, vendor dues</li>
              <li>CSV and Tally XML export for your accountant</li>
            </ul>
            <p className="s-small s-reveal mt-6">GST-ready records, not certified e-invoicing: there is no IRN or GSTR filing.</p>
            <p className="mt-10">
              <MoreLink href="/product/finance">Explore finance</MoreLink>
            </p>
          </div>
        </div>
      </section>

      {/* ---------------- Analytics ---------------- */}
      <section aria-labelledby="analytics-title" className="s-section s-band">
        <div className="s-wrap">
          <SectionIntro id="analytics-title" eyebrow="Analytics" align="split" title="Understand your restaurant." lead="Analytics read the records RESTORA already keeps, so the answers are there without a spreadsheet." />
          <ul className="s-reveal mt-12 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["What is selling?", "Best sellers by quantity and revenue."],
              ["What is moving slowly?", "Slow sellers and items with no sales."],
              ["What is being wasted?", "Wastage by material, reason and value."],
              ["What are sales doing?", "Net sales, orders and average order value by day."],
              ["What are expenses doing?", "Expenses by category in the profit and loss."],
              ["What do we owe vendors?", "Dues and overdue amounts per vendor."],
            ].map(([q, a]) => (
              <li key={q} className="border-t border-[color:var(--s-rule-strong)] pt-4">
                <p className="font-display text-xl font-semibold text-[color:var(--s-ink)]">{q}</p>
                <p className="s-small mt-1">{a}</p>
              </li>
            ))}
          </ul>
          <div className="s-reveal mt-14">
            <Screen name="analytics-menu" className="w-full" sizes="(min-width: 1280px) 1216px, 100vw" />
          </div>
          <p className="mt-12">
            <MoreLink href="/product/analytics">Explore analytics</MoreLink>
          </p>
        </div>
      </section>

      {/* ---------------- Staff ---------------- */}
      <section aria-labelledby="staff-title" className="s-section">
        <div className="s-wrap">
          <SectionIntro id="staff-title" eyebrow="Staff" title={<>One system. <br className="hidden sm:block" />Every role.</>} lead="Choose a role to see the screen that person works in." />
          <div className="s-reveal mt-12">
            <RoleSwitcher />
          </div>
        </div>
      </section>

      {/* ---------------- Integrations ---------------- */}
      <section aria-labelledby="integrations-title" className="s-section s-band">
        <div className="s-wrap">
          <SectionIntro id="integrations-title" eyebrow="Integrations" align="split" title="Connect RESTORA to the tools around your restaurant." lead="Every connection is labelled with its real status. Mock adapters are for testing and are refused in production." />
          <div className="s-reveal mt-12 overflow-hidden rounded-[var(--s-radius)] bg-[color:var(--s-surface)] shadow-[0_0_0_1px_rgb(36_24_15/0.1)]">
            <table className="w-full text-left">
              <caption className="sr-only">RESTORA integrations and their status</caption>
              <thead className="hidden text-sm text-[color:var(--s-muted)] md:table-header-group">
                <tr className="border-b border-[color:var(--s-rule)]">
                  <th scope="col" className="px-6 py-3 font-medium">Integration</th>
                  <th scope="col" className="px-6 py-3 font-medium">Status</th>
                  <th scope="col" className="px-6 py-3 font-medium">What it does today</th>
                </tr>
              </thead>
              <tbody>
                {INTEGRATIONS.map((x) => (
                  <tr key={x.name} className="block border-b border-[color:var(--s-rule)] px-6 py-5 last:border-0 md:table-row md:p-0">
                    <th scope="row" className="block font-normal md:table-cell md:px-6 md:py-5 md:align-top">
                      <span className="block font-semibold text-[color:var(--s-ink)]">{x.name}</span>
                      <span className="s-small">{x.kind}</span>
                    </th>
                    <td className="mt-2 flex flex-wrap gap-3 md:table-cell md:px-6 md:py-5 md:align-top">
                      {x.status.map((s) => (
                        <span key={s} className="s-status mr-3" data-s={s}>
                          {STATUS_LABEL[s]}
                        </span>
                      ))}
                    </td>
                    <td className="mt-2 block text-[0.9375rem] md:table-cell md:px-6 md:py-5 md:align-top">{x.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="s-small s-reveal mt-5">Live: works with real accounts or devices. Sandbox: test credentials. Mock: simulated, for testing only. Coming later: not available yet.</p>
          <p className="mt-10">
            <MoreLink href="/product/integrations">Explore integrations</MoreLink>
          </p>
        </div>
      </section>

      {/* ---------------- Restaurant types ---------------- */}
      <section aria-labelledby="solutions-title" className="s-section">
        <div className="s-wrap">
          <SectionIntro id="solutions-title" eyebrow="Solutions" title="Built for how your restaurant works." />
          <ul className="s-reveal mt-12">
            {SOLUTIONS.map((s) => (
              <li key={s.name} className="grid gap-3 border-t border-[color:var(--s-rule-strong)] py-7 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-10">
                <h3 className="font-display text-2xl font-semibold leading-tight text-[color:var(--s-ink)] sm:text-3xl">{s.name}</h3>
                <p className="s-body text-[1.0625rem]">{s.body}</p>
              </li>
            ))}
          </ul>
          <p className="mt-8">
            <MoreLink href="/solutions">See how each one uses RESTORA</MoreLink>
          </p>
        </div>
      </section>

      {/* ---------------- Interactive demo ---------------- */}
      <section id="demo" aria-labelledby="demo-title" className="s-section s-band scroll-mt-16">
        <div className="s-wrap">
          <SectionIntro id="demo-title" eyebrow="Interactive demonstration" align="split" title="See RESTORA in action." lead="Order as a guest, cook it as the kitchen, take the payment as the cashier, then read the numbers as the manager." />
          <div className="s-reveal mt-12">
            <ProductDemo />
          </div>
        </div>
      </section>

      {/* ---------------- Why RESTORA ---------------- */}
      <section aria-labelledby="why-title" className="s-section">
        <div className="s-wrap">
          <SectionIntro id="why-title" eyebrow="Why RESTORA" title="More than a billing app." />
          <ol className="s-reveal mt-12 grid gap-x-12 gap-y-10 md:grid-cols-2 lg:grid-cols-3">
            {WHY.map((w, i) => (
              <li key={w.title}>
                <p className="s-num font-display text-5xl font-semibold text-[color:var(--s-accent)]">{String(i + 1).padStart(2, "0")}</p>
                <h3 className="s-h4 mt-4 text-xl">{w.title}</h3>
                <p className="s-body mt-2">{w.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------------- Download ---------------- */}
      <section aria-labelledby="download-title" className="s-section s-band">
        <div className="s-wrap">
          <SectionIntro id="download-title" eyebrow="Download" align="split" title="Get RESTORA." lead="Bring the restaurant operating system to your desktop, or open it in the browser." />
          <div className="s-reveal mt-12">
            <PlatformDownload {...dl} webHref={WEB_APP_PATH} compact />
          </div>
          <p className="mt-10">
            <MoreLink href="/download">Release details, checksums and requirements</MoreLink>
          </p>
        </div>
      </section>

      {/* ---------------- Resources ---------------- */}
      <section aria-labelledby="resources-title" className="s-section">
        <div className="s-wrap">
          <SectionIntro id="resources-title" eyebrow="Resources" title="Learn more." />
          <ul className="s-reveal mt-10 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["/resources/release-notes", "Release notes", `What is in RESTORA ${dl.version}, and its known limits.`],
              ["/download#requirements", "System requirements", "What the desktop app and web app need."],
              ["/security", "Security", "How RESTORA protects accounts, payments and data."],
              ["/resources", "All resources", "Guides, product pages and legal documents."],
            ].map(([href, t, d]) => (
              <li key={href} className="border-t border-[color:var(--s-rule-strong)]">
                <Link href={href} className="group block py-6 no-underline">
                  <span className="flex items-center justify-between text-lg font-semibold text-[color:var(--s-ink)]">
                    {t} <span className="s-accent transition-transform group-hover:translate-x-1" aria-hidden>→</span>
                  </span>
                  <span className="s-small mt-1 block">{d}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------------- Closing CTA ---------------- */}
      <section aria-labelledby="cta-title" className="s-section s-dark">
        <div className="s-wrap text-center">
          <h2 id="cta-title" className="s-display mx-auto max-w-[14ch]">
            Your restaurant. One operating system.
          </h2>
          <p className="s-lead mx-auto mt-6 max-w-xl">Run the day with RESTORA.</p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Link href="/download" className="s-btn s-btn-light">
              Download RESTORA
            </Link>
            <Link href="/product" className="s-btn s-btn-ghost">
              Explore the product
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
