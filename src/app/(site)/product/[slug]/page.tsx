import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Screen } from "@/site/components/Screen";
import { MoreLink } from "@/site/components/Section";
import { INTEGRATIONS, MODULES, STATUS_LABEL, moduleBySlug, type Module } from "@/site/content";
import { SCREENS, type ScreenName } from "@/site/screens";

export const dynamicParams = false;
export function generateStaticParams() {
  return MODULES.map((m) => ({ slug: m.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const m = moduleBySlug((await params).slug);
  if (!m) return {};
  return { title: m.name === "POS" ? "Restaurant POS" : m.name, description: m.metaDescription, alternates: { canonical: `/product/${m.slug}` }, openGraph: { title: `${m.name} | RESTORA`, description: m.metaDescription, url: `/product/${m.slug}` } };
}

const isPhone = (n: ScreenName) => SCREENS[n].device === "phone";

export default async function ModulePage({ params }: { params: Promise<{ slug: string }> }) {
  const m = moduleBySlug((await params).slug);
  if (!m) notFound();
  const dark = m.layout === "dark";
  const [main, ...rest] = m.screens;

  return (
    <>
      {/* Header + main visual */}
      <section aria-labelledby="module-title" className={`pb-[var(--s-section)] pt-14 sm:pt-20 ${dark ? "s-dark" : ""}`}>
        <div className="s-wrap">
          <nav aria-label="Breadcrumb" className="s-small">
            <Link href="/product" className="no-underline hover:underline">
              Product
            </Link>{" "}
            <span aria-hidden>/</span> <span aria-current="page">{m.name}</span>
          </nav>
          <div className={m.layout === "phones" ? "mt-8 grid items-center gap-14 lg:grid-cols-2" : "mt-8"}>
            <div>
              <h1 id="module-title" className="s-display max-w-[15ch] !text-[clamp(2.75rem,7vw,6rem)]">
                {m.headline}
              </h1>
              <p className="s-lead mt-8 max-w-2xl">{m.lead}</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/#demo" className={`s-btn ${dark ? "s-btn-light" : "s-btn-primary"}`}>
                  See it in the demo
                </Link>
                <Link href="/download" className="s-btn s-btn-ghost">
                  Download RESTORA
                </Link>
              </div>
            </div>
            {m.layout === "phones" ? (
              <div className="flex items-end justify-center gap-4 sm:gap-6">
                {m.screens.map((s, i) => (
                  <Screen key={s} name={s} priority className={`w-[46%] max-w-[16.5rem] ${i === 0 ? "-translate-y-8" : ""}`} sizes="(min-width: 1024px) 264px, 46vw" />
                ))}
              </div>
            ) : null}
          </div>
          {m.layout !== "phones" && (
            <div className="mt-14 sm:mt-20">
              {isPhone(main) ? (
                <Screen name={main} priority className="mx-auto w-[min(18rem,72vw)]" sizes="288px" />
              ) : (
                <Screen name={main} priority className="w-full" sizes="(min-width: 1280px) 1216px, 100vw" />
              )}
              <p className="s-caption">{SCREENS[main].alt} Sample data.</p>
            </div>
          )}
        </div>
      </section>

      {/* Workflow */}
      {m.workflow && <Workflow m={m} />}

      {/* Capabilities, with the secondary screens */}
      <section aria-labelledby="cap-title" className={`s-section ${m.workflow ? "" : "s-band"}`}>
        <div className="s-wrap">
          <h2 id="cap-title" className="s-h2 s-reveal max-w-3xl">
            What it does
          </h2>
          <dl className="s-reveal mt-12 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
            {m.capabilities.map((c) => (
              <div key={c.title} className="border-t border-[color:var(--s-rule-strong)] pt-5">
                <dt className="s-h4 text-lg">{c.title}</dt>
                <dd className="s-body mt-2">{c.body}</dd>
              </div>
            ))}
          </dl>
          {m.note && <p className="s-reveal mt-12 max-w-3xl rounded-[var(--s-radius)] bg-[color:var(--s-sunken)] p-5 text-[0.9375rem]">{m.note}</p>}

          {m.slug === "integrations" && <IntegrationTable />}

          {m.layout !== "phones" && rest.length > 0 && (
            <div className={`s-reveal mt-16 grid items-start gap-8 ${rest.length > 1 ? (rest.some(isPhone) ? "lg:grid-cols-[minmax(0,8fr)_minmax(0,3fr)]" : "lg:grid-cols-2") : ""}`}>
              {rest.map((s) => (
                <figure key={s} className={isPhone(s) ? "flex flex-col items-center" : ""}>
                  {isPhone(s) ? <Screen name={s} className="w-[min(16rem,70vw)]" sizes="256px" /> : <Screen name={s} className="w-full" sizes={rest.length > 1 ? "(min-width: 1024px) 600px, 100vw" : "(min-width: 1280px) 1216px, 100vw"} />}
                  <figcaption className="s-caption max-w-xl">{SCREENS[s].alt}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Related */}
      <section aria-labelledby="related-title" className="s-section s-band">
        <div className="s-wrap">
          <h2 id="related-title" className="s-h3">
            Works with
          </h2>
          <ul className="mt-8 grid gap-x-10 sm:grid-cols-3">
            {m.related.map((slug) => {
              const r = moduleBySlug(slug)!;
              return (
                <li key={slug} className="border-t border-[color:var(--s-rule-strong)]">
                  <Link href={`/product/${slug}`} className="group block py-6 no-underline">
                    <span className="flex items-center justify-between font-display text-2xl font-semibold text-[color:var(--s-ink)]">
                      {r.name} <span className="s-accent text-xl transition-transform group-hover:translate-x-1" aria-hidden>→</span>
                    </span>
                    <span className="s-small mt-1 block">{r.summary}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="mt-14 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Link href="/download" className="s-btn s-btn-primary">
              Download RESTORA
            </Link>
            <MoreLink href="/product">All of RESTORA</MoreLink>
          </div>
        </div>
      </section>
    </>
  );
}

function Workflow({ m }: { m: Module }) {
  const w = m.workflow!;
  return (
    <section aria-labelledby="wf-title" className="s-section s-band">
      <div className="s-wrap grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-20">
        <div>
          <p className="s-eyebrow">Workflow</p>
          <h2 id="wf-title" className="s-h2 mt-4">
            {w.title}
          </h2>
        </div>
        <ol className="s-steps s-reveal">
          {w.steps.map((s) => (
            <li key={s.name}>
              <p className="text-xl font-semibold text-[color:var(--s-ink)]">{s.name}</p>
              <p className="s-body mt-1.5 max-w-2xl">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function IntegrationTable() {
  return (
    <div className="s-reveal mt-14">
      <h3 className="s-h3">Available connections</h3>
      <ul className="mt-6 grid gap-0">
        {INTEGRATIONS.map((x) => (
          <li key={x.name} className="grid gap-2 border-t border-[color:var(--s-rule)] py-5 md:grid-cols-[minmax(0,4fr)_minmax(0,3fr)_minmax(0,7fr)] md:gap-6">
            <div>
              <p className="font-semibold text-[color:var(--s-ink)]">{x.name}</p>
              <p className="s-small">{x.kind}</p>
            </div>
            <p className="flex flex-wrap gap-3">
              {x.status.map((s) => (
                <span key={s} className="s-status" data-s={s}>
                  {STATUS_LABEL[s]}
                </span>
              ))}
            </p>
            <p className="text-[0.9375rem]">{x.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
