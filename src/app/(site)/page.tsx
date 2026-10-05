import Link from "next/link";
import { redirect } from "next/navigation";
import { Screen } from "@/site/components/Screen";
import { ChainStack, type ChainCard } from "@/site/components/ChainStack";
import { ScrollProgress } from "@/site/components/ScrollProgress";
import { Statement } from "@/site/components/Statement";
import { RoleSwitcher } from "@/site/components/RoleSwitcher";
import { ProductDemo } from "@/site/components/ProductDemo";
import { PlatformDownload } from "@/site/components/PlatformDownload";
import { MoreLink, SectionIntro } from "@/site/components/Section";
import { INTEGRATIONS, SOLUTIONS, STATUS_LABEL } from "@/site/content";
import { downloadState } from "@/site/release";
import { WEB_APP_PATH } from "@/site/config";
import { RestoraMark } from "@/site/components/Logo";

const WIDE = "(min-width: 1280px) 720px, (min-width: 1024px) 56vw, 100vw";

const CHAIN: ChainCard[] = [
  {
    key: "qr",
    label: "Table QR",
    title: "A guest scans the table and orders.",
    body: "Each table has its own QR code. Guests open the live menu on their phone, build a cart and place the order. Staff accept it, or the guest pays online first.",
    media: (
      <div className="s-duo">
        <Screen name="guest-menu" sizes="(min-width: 1024px) 260px, 44vw" />
        <Screen name="guest-cart" sizes="(min-width: 1024px) 260px, 44vw" />
      </div>
    ),
  },
  {
    key: "pos",
    label: "POS",
    title: "Staff order at the POS or on the floor.",
    body: "Cashiers use the POS; captains take rounds on their phone. Every order is tied to its table, covers and customer, with modifiers and discounts.",
    media: <Screen name="pos" sizes={WIDE} />,
  },
  {
    key: "kot",
    label: "KOT and KDS",
    tone: "espresso",
    title: "The kitchen gets one ticket per station.",
    body: "Sending an order creates a KOT for each station: kitchen, bakery or bar. The kitchen display moves it from new to in progress to ready, and the captain app shows it.",
    media: <Screen name="kitchen" sizes={WIDE} />,
  },
  {
    key: "pay",
    label: "Payment",
    tone: "sand",
    title: "Settle by cash, UPI, card or online.",
    body: "Split and partial payments, refunds and bills, with GST-ready invoices numbered without gaps for each financial year. Managers see the day's takings live.",
    media: (
      <div className="s-pair">
        <Screen name="finance" className="w-full" sizes={WIDE} />
        <Screen name="manager" sizes="(min-width: 1024px) 190px, 26vw" />
      </div>
    ),
  },
  {
    key: "stock",
    label: "Inventory",
    title: "Every sale draws down stock by recipe.",
    body: "When an order is settled, RESTORA consumes the ingredients in its approved recipe and writes the movement to an append-only ledger at weighted average cost.",
    media: <Screen name="ledger" sizes={WIDE} />,
  },
  {
    key: "insight",
    label: "Analytics",
    title: "The numbers come from the same records.",
    body: "Sales, menu, inventory and finance analytics read the orders, payments and stock movements the restaurant already recorded. Nothing is re-entered.",
    media: <Screen name="analytics-sales" sizes={WIDE} />,
  },
];

const RAIL = ["Guest", "Order", "KOT", "Kitchen", "Payment", "Stock", "Books", "Numbers"];
const delay = (ms: number) => ({ "--delay": `${ms}ms` }) as React.CSSProperties;

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
      <section aria-labelledby="hero-title" className="s-hero">
        <div className="s-wrap">
          <Link href="/resources/release-notes" className="s-chip s-arrive">
            <span className="s-chip-tag s-num">{dl.version}</span>
            <span>
              <span className="hidden sm:inline">RESTORA for </span>Windows and the web
            </span>
            <span className="s-arrow" aria-hidden>
              →
            </span>
          </Link>
          <h1 id="hero-title" className="s-display s-hero-title mt-8">
            <span className="s-line">
              <span style={delay(60)}>The operating system</span>
            </span>
            <span className="s-line">
              <span style={delay(160)}>
                for restaurants<span className="s-accent">.</span>
              </span>
            </span>
          </h1>
          <div className="mt-8 grid gap-8 lg:mt-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <p className="s-lead s-arrive max-w-[34rem]" style={delay(320)}>
              Orders, kitchen, stock, purchasing, money and reports in one connected system. Enter a sale once and every part of the restaurant sees it.
            </p>
            <div className="s-arrive flex flex-wrap items-center gap-3" style={delay(420)}>
              <Link href="/download" className="s-btn s-btn-primary">
                Download RESTORA
              </Link>
              <Link href="/product" className="s-btn s-btn-ghost">
                Explore RESTORA
              </Link>
              <Link href="#demo" className="s-link ml-1 py-3">
                See it in action <span className="s-arrow" aria-hidden>→</span>
              </Link>
            </div>
          </div>
        </div>

        <ScrollProgress className="s-stage s-wrap" start={0.9} end={0} minWidth={1024}>
          <div className="s-stage-grid">
            <div className="s-layer s-layer-kitchen s-arrive hidden lg:block" style={delay(640)}>
              <Screen name="kitchen" className="w-full" sizes="(min-width: 1024px) 560px, 1px" />
            </div>
            <div className="s-layer s-layer-main s-arrive" style={delay(480)}>
              <Screen name="pos" priority className="w-full" sizes="(min-width: 1280px) 980px, (min-width: 1024px) 76vw, 100vw" />
            </div>
            <div className="s-layer s-layer-guest s-arrive hidden lg:block" style={delay(780)}>
              <Screen name="guest-cart" className="w-full" sizes="(min-width: 1024px) 180px, 1px" />
            </div>
            <div className="s-layer s-layer-captain s-arrive" style={delay(880)}>
              <Screen name="captain" className="w-full" sizes="(min-width: 1024px) 180px, 30vw" />
            </div>
          </div>
        </ScrollProgress>

        <div className="s-wrap mt-12 lg:mt-16">
          <p className="s-caption m-0">Real RESTORA screens with sample data: the POS, the kitchen display, a guest menu and the captain app.</p>
          <div className="mt-12 border-y border-[color:var(--s-rule)] py-6">
            <ol className="s-rail s-reveal" aria-label="What one order sets off">
              {RAIL.map((r, i) => (
                <li key={r} style={{ "--i": i } as React.CSSProperties}>
                  {i === 0 ? <span>{r}</span> : r}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* ---------------- Statement ---------------- */}
      <section aria-labelledby="statement-title" className="s-section">
        <div className="s-wrap">
          <h2 id="statement-title" className="s-eyebrow">
            One connected system
          </h2>
          <Statement
            className="mt-8"
            text="One order sets the whole restaurant in motion. The *kitchen* gets its ticket. The *store* records what was used. The *books* take the payment. The *manager* sees the number. Nobody types it twice."
          />
        </div>
      </section>

      {/* ---------------- The chain (signature card stack) ---------------- */}
      <section aria-labelledby="chain-title" className="pb-[var(--s-section)]">
        <div className="s-wrap">
          <SectionIntro id="chain-title" eyebrow="Follow one order" align="split" title="From the table to the numbers." lead="Six steps, six parts of RESTORA. Each one hands its work to the next, so nothing is carried across by hand." />
          <div className="mt-14 lg:mt-20">
            <ChainStack cards={CHAIN} label="How one order moves through RESTORA" />
          </div>
        </div>
      </section>

      {/* ---------------- Front of house: full-bleed POS ---------------- */}
      <section aria-labelledby="pos-title" className="s-foh s-dark">
        <div className="s-wrap">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end lg:gap-16">
            <div className="s-reveal">
              <p className="s-eyebrow">Front of house · POS</p>
              <h2 id="pos-title" className="s-display s-foh-title mt-6">
                Your floor,
                <br />
                in one view<span className="s-accent-on-dark">.</span>
              </h2>
            </div>
            <p className="s-lead s-reveal lg:pb-3">Pick a table, see who is seated and what is running, add a round and send it to the kitchen. Dine-in, takeaway and delivery from the same screen.</p>
          </div>
        </div>
        <ScrollProgress className="s-wrap s-foh-stage" start={1} end={0.6} minWidth={1024}>
          <Screen name="pos-floor" className="w-full" sizes="(min-width: 1280px) 1216px, 100vw" />
        </ScrollProgress>
        <div className="s-wrap">
          <dl className="s-facts s-reveal">
            {[
              ["Tables and covers", "Floors and tables with live free or occupied status. Occupied tables open their running order."],
              ["Orders and rounds", "Menu with variants and modifiers, rounds fired to the kitchen, discounts and open orders."],
              ["Payments", "Cash, UPI, card and online. Split and partial payments, and refunds with a manager's confirmation."],
              ["Bills and KOT printing", "Bills and receipts, and KOTs printed to network ESC/POS printers per station."],
            ].map(([t, d], i) => (
              <div key={t} style={{ "--i": i } as React.CSSProperties}>
                <dt>{t}</dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-12">
            <MoreLink href="/product/pos">Explore POS</MoreLink>
          </p>
        </div>
      </section>

      {/* ---------------- QR ordering: editorial split ---------------- */}
      <section aria-labelledby="qr-title" className="s-section overflow-hidden">
        <div className="s-wrap grid items-center gap-14 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:gap-20">
          <div className="s-qr-phones s-reveal order-2 lg:order-1">
            <Screen name="guest-menu" sizes="(min-width: 1024px) 280px, 46vw" />
            <Screen name="guest-cart" sizes="(min-width: 1024px) 280px, 46vw" />
          </div>
          <div className="order-1 lg:order-2">
            <SectionIntro id="qr-title" eyebrow="QR ordering" compact title="Every table is an ordering point." lead="Guests scan the QR code on their table and order from your live menu. The order enters the same engine as the POS, so the kitchen, the bill and the stock all see it." />
            <ol className="s-numbered s-reveal mt-10">
              {["Scan", "Menu", "Cart", "Order", "Payment"].map((s, i) => (
                <li key={s} style={{ "--i": i } as React.CSSProperties}>
                  <span className="s-num" aria-hidden>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {s}
                </li>
              ))}
            </ol>
            <p className="s-small s-reveal mt-6 max-w-lg">Payment before the order is optional and uses your payment gateway. Without it, staff accept the order and the guest pays at the end.</p>
            <p className="mt-10">
              <MoreLink href="/product/qr-ordering">Explore QR ordering</MoreLink>
            </p>
          </div>
        </div>
      </section>

      {/* ---------------- Kitchen: ticket lifecycle ---------------- */}
      <section aria-labelledby="kitchen-title" className="s-section s-band">
        <div className="s-wrap">
          <SectionIntro id="kitchen-title" eyebrow="Kitchen" align="split" title="From order to kitchen, without the chaos." lead="Every round becomes a kitchen order ticket for each station that prepares it. The kitchen display moves it along, and the floor sees each change." />
          <ScrollProgress className="s-ticket-rail" start={0.8} end={0.75} style={{ "--n": 4 } as React.CSSProperties}>
            <ol aria-label="The life of a kitchen order ticket">
              {[
                ["KOT", "One ticket per station, printed automatically if a printer is set up."],
                ["Accept", "The station takes the ticket. Each one shows table, covers and minutes waiting."],
                ["Preparing", "In progress until the dish is done."],
                ["Ready", "The captain app shows it, so food goes out hot."],
              ].map(([t, d], i) => (
                <li key={t} style={{ "--i": i } as React.CSSProperties}>
                  <span className="s-num s-ticket-rail-n">{String(i + 1).padStart(2, "0")}</span>
                  <span className="s-ticket-rail-t">{t}</span>
                  <span className="s-ticket-rail-d">{d}</span>
                </li>
              ))}
            </ol>
          </ScrollProgress>
          <div className="s-reveal mt-14">
            <Screen name="kitchen" className="w-full" sizes="(min-width: 1280px) 1216px, 100vw" />
          </div>
          <p className="mt-12">
            <MoreLink href="/product/kitchen">Explore the kitchen display</MoreLink>
          </p>
        </div>
      </section>

      {/* ---------------- Back of house: inventory, procurement, finance ---------------- */}
      <section aria-labelledby="boh-title" className="s-section">
        <div className="s-wrap">
          <div className="s-chapter s-reveal">
            <p className="s-eyebrow">Back of house</p>
            <h2 id="boh-title" className="s-display s-chapter-title mt-6">
              The stock, the purchase, the money<span className="s-accent">.</span>
            </h2>
            <p className="s-lead mt-8 max-w-2xl">What the guest never sees, kept as carefully as what they do. Recipes, purchase documents and cash all post to the same records as the sale.</p>
          </div>

          {/* Inventory */}
          <div className="s-boh-block grid items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
            <div>
              <h3 id="inventory-title" className="s-h3 s-reveal">
                <span className="s-eyebrow mb-4 block">Inventory</span>
                Know what you have. Know what you use.
              </h3>
              <p className="s-body s-reveal mt-5 text-[1.0625rem]">Recipes connect the menu to the store. Each settled sale consumes its ingredients, and every movement lands in one ledger.</p>
              <ul className="s-ticks s-reveal mt-7">
                <li>Stock on hand with reorder levels and value at weighted average cost</li>
                <li>Versioned, approved recipes and sub-recipes with plate costing</li>
                <li>Consumption on every settled sale</li>
                <li>Wastage with reasons, stock counts with variance</li>
                <li>Transfers, issues and production batches</li>
              </ul>
              <p className="mt-8">
                <MoreLink href="/product/inventory">Explore inventory</MoreLink>
              </p>
            </div>
            <div className="s-overlap s-reveal">
              <Screen name="recipes" className="s-overlap-back" sizes="(min-width: 1024px) 520px, 80vw" />
              <Screen name="inventory" className="s-overlap-front" sizes="(min-width: 1280px) 640px, (min-width: 1024px) 50vw, 90vw" />
            </div>
          </div>

          {/* Procurement */}
          <div className="s-boh-block">
            <div className="grid gap-6 lg:grid-cols-2 lg:items-end lg:gap-16">
              <h3 id="procurement-title" className="s-h3 s-reveal">
                <span className="s-eyebrow mb-4 block">Procurement</span>
                From purchase request to vendor payment.
              </h3>
              <p className="s-body s-reveal text-[1.0625rem]">One documented path for everything the restaurant buys. Each document creates the next, and receipts update stock.</p>
            </div>
            <ol className="s-slips s-reveal mt-12" aria-label="Procurement documents in order">
              {[
                ["Indent", "A department asks for materials"],
                ["Purchase order", "Sent to the vendor"],
                ["GRN", "Goods received, posted to stock"],
                ["Bill", "The vendor's bill, matched to receipts"],
                ["Vendor payment", "Settles bills, updates dues"],
              ].map(([t, d], i) => (
                <li key={t} style={{ "--i": i } as React.CSSProperties}>
                  <span className="s-num s-slip-n">{String(i + 1).padStart(2, "0")}</span>
                  <span className="s-slip-t">{t}</span>
                  <span className="s-slip-d">{d}</span>
                </li>
              ))}
            </ol>
            <div className="s-reveal mt-12 grid gap-6 lg:grid-cols-2">
              <figure>
                <Screen name="procurement-po" className="w-full" sizes="(min-width: 1024px) 600px, 100vw" />
                <figcaption className="s-caption">Purchase orders by vendor, with receipts and totals.</figcaption>
              </figure>
              <figure className="lg:mt-16">
                <Screen name="procurement-payments" className="w-full" sizes="(min-width: 1024px) 600px, 100vw" />
                <figcaption className="s-caption">Vendor dues: outstanding, overdue and paid.</figcaption>
              </figure>
            </div>
            <p className="mt-10">
              <MoreLink href="/product/procurement">Explore procurement</MoreLink>
            </p>
          </div>

          {/* Finance */}
          <div className="s-boh-block grid items-center gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16">
            <div className="s-reveal order-2 lg:order-1">
              <Screen name="finance" className="w-full" sizes="(min-width: 1280px) 720px, (min-width: 1024px) 58vw, 100vw" />
            </div>
            <div className="order-1 lg:order-2">
              <h3 id="finance-title" className="s-h3 s-reveal">
                <span className="s-eyebrow mb-4 block">Finance</span>
                From every payment to every rupee.
              </h3>
              <p className="s-body s-reveal mt-5 text-[1.0625rem]">Payments, invoices, expenses and cash in one place. Close the day against counted cash and read profit and loss for any period.</p>
              <ul className="s-ticks s-reveal mt-7">
                <li>GST-ready invoices and credit notes, numbered without gaps per financial year</li>
                <li>Payments and refunds by method, with gateway reconciliation</li>
                <li>Expenses and petty cash</li>
                <li>Cash drawer: float, expected, counted, variance</li>
                <li>Daily closing, profit and loss, vendor dues</li>
                <li>CSV and Tally XML export for your accountant</li>
              </ul>
              <p className="s-small s-reveal mt-6">GST-ready records, not certified e-invoicing: there is no IRN or GSTR filing.</p>
              <p className="mt-8">
                <MoreLink href="/product/finance">Explore finance</MoreLink>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- Analytics: data moment ---------------- */}
      <section aria-labelledby="analytics-title" className="s-section s-dark s-data">
        <div className="s-wrap">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
            <div className="lg:sticky lg:top-28 lg:self-start">
              <SectionIntro id="analytics-title" eyebrow="Analytics" compact title="Understand your restaurant." lead="Analytics read the records RESTORA already keeps, so the answers are there without a spreadsheet." />
              <p className="mt-10">
                <MoreLink href="/product/analytics">Explore analytics</MoreLink>
              </p>
            </div>
            <ol className="s-questions">
              {[
                ["What is selling?", "Best sellers by quantity and revenue."],
                ["What is moving slowly?", "Slow sellers and items with no sales."],
                ["What is being wasted?", "Wastage by material, reason and value."],
                ["What are sales doing?", "Net sales, orders and average order value by day."],
                ["What are expenses doing?", "Expenses by category in the profit and loss."],
                ["What do we owe vendors?", "Dues and overdue amounts per vendor."],
              ].map(([q, a]) => (
                <li key={q} className="s-reveal">
                  <p className="s-question">{q}</p>
                  <p className="s-answer">{a}</p>
                </li>
              ))}
            </ol>
          </div>
          <div className="s-reveal mt-20">
            <Screen name="analytics-menu" className="w-full" sizes="(min-width: 1280px) 1216px, 100vw" />
          </div>
        </div>
      </section>

      {/* ---------------- Staff ---------------- */}
      <section aria-labelledby="staff-title" className="s-section">
        <div className="s-wrap">
          <SectionIntro id="staff-title" eyebrow="Staff" align="split" title={<>One system. <br className="hidden sm:block" />Every role.</>} lead="Choose a role to see the screen that person works in." />
          <div className="s-reveal mt-12">
            <RoleSwitcher />
          </div>
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

      {/* ---------------- Solutions ---------------- */}
      <section aria-labelledby="solutions-title" className="s-section">
        <div className="s-wrap">
          <SectionIntro id="solutions-title" eyebrow="Solutions" title="Built for how your restaurant works." />
          <ul className="s-solutions s-reveal mt-12">
            {SOLUTIONS.map((s, i) => (
              <li key={s.name}>
                <span className="s-num s-solutions-n" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3>{s.name}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ul>
          <p className="mt-10">
            <MoreLink href="/solutions">See how each one uses RESTORA</MoreLink>
          </p>
        </div>
      </section>

      {/* ---------------- Why RESTORA + integrations ---------------- */}
      <section aria-labelledby="why-title" className="s-section s-band">
        <div className="s-wrap">
          <SectionIntro id="why-title" eyebrow="Why RESTORA" align="split" title="More than a billing app." lead="The decisions underneath the screens: one database, reconciled money and records that survive a dropped connection." />
          <ol className="s-principles s-reveal mt-14">
            {WHY.map((w, i) => (
              <li key={w.title}>
                <span className="s-num" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3>{w.title}</h3>
                <p>{w.body}</p>
              </li>
            ))}
          </ol>

          <div id="integrations" className="mt-24 scroll-mt-20">
            <div className="grid gap-6 lg:grid-cols-2 lg:items-end lg:gap-16">
              <h3 id="integrations-title" className="s-h3 s-reveal">
                <span className="s-eyebrow mb-4 block">Integrations</span>
                Connect RESTORA to the tools around your restaurant.
              </h3>
              <p className="s-body s-reveal text-[1.0625rem]">Every connection is labelled with its real status. Mock adapters are for testing and are refused in production.</p>
            </div>
            <div className="s-reveal mt-10 overflow-hidden rounded-[var(--s-radius)] bg-[color:var(--s-surface)] shadow-[0_0_0_1px_rgb(36_24_15/0.1)]">
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
            <p className="mt-8">
              <MoreLink href="/product/integrations">Explore integrations</MoreLink>
            </p>
          </div>
        </div>
      </section>

      {/* ---------------- Finale: download ---------------- */}
      <section aria-labelledby="download-title" className="s-section s-dark s-finale">
        <div className="s-wrap">
          <div className="s-reveal text-center">
            <RestoraMark tone="ivory" className="mx-auto h-14 w-14" />
            <h2 id="download-title" className="s-display mx-auto mt-10 max-w-[13ch]">
              Your restaurant. One operating system<span className="s-accent-on-dark">.</span>
            </h2>
            <p className="s-lead mx-auto mt-6 max-w-xl">Install RESTORA on a Windows computer, or open it in the browser.</p>
          </div>
          <div className="s-reveal s-light-island mt-16">
            <PlatformDownload {...dl} webHref={WEB_APP_PATH} compact />
          </div>
          <p className="mt-10 text-center">
            <MoreLink href="/download">Release details, checksums and requirements</MoreLink>
          </p>
        </div>
      </section>
    </>
  );
}
