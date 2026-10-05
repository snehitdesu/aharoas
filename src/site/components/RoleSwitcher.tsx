"use client";

import { useState } from "react";
import { Screen } from "@/site/components/Screen";
import { TabList, useTabs } from "@/site/components/Tabs";
import type { ScreenName } from "@/site/screens";

const ROLES: { role: string; screen: ScreenName; title: string; body: string; points: string[] }[] = [
  {
    role: "Owner",
    screen: "dashboard",
    title: "The whole business, outlet by outlet.",
    body: "Today's sales, open orders, kitchen load, reservations, free tables, low stock and anomalies on one dashboard, with every module one click away.",
    points: ["Every outlet and module", "Analytics, finance and reports", "Settings, integrations and staff access"],
  },
  {
    role: "Manager",
    screen: "manager",
    title: "The live day in your pocket.",
    body: "The manager app shows net sales, open orders, outstanding amounts and payments by method as the day runs, with alerts and the staff on shift.",
    points: ["Live sales and payments", "Alerts and anomalies", "Approves refunds and voids"],
  },
  {
    role: "Cashier",
    screen: "pos",
    title: "Orders and payments, fast.",
    body: "The POS puts the menu, the table and the bill on one screen. Send rounds to the kitchen and take cash, UPI, card or online payments.",
    points: ["Dine-in, takeaway, delivery", "Split and partial payments", "Bills and receipts"],
  },
  {
    role: "Captain",
    screen: "captain",
    title: "Take the order at the table.",
    body: "The captain app is a phone-first table board: free and occupied tables, running totals, kitchen status and rounds, without walking back to the counter.",
    points: ["Table board", "Rounds to the kitchen", "Bill requests"],
  },
  {
    role: "Kitchen",
    screen: "kitchen",
    title: "Only what the station needs.",
    body: "The kitchen display shows each station its tickets as new, in progress and ready, with table, covers and how long each ticket has waited.",
    points: ["Tickets per station", "Accept, ready, served", "Elapsed time per ticket"],
  },
];

/** "One system. Every role." Tabs switch the real screen each role works in. */
export function RoleSwitcher() {
  const [active, setActive] = useState(0);
  const { tabProps, panelProps } = useTabs(ROLES.length, active, setActive);
  return (
    <div>
      <TabList label="Choose a role">
        {ROLES.map((r, i) => (
          <button key={r.role} {...tabProps(i)}>
            {r.role}
          </button>
        ))}
      </TabList>
      {ROLES.map((r, i) => {
        const phone = r.screen === "manager" || r.screen === "captain";
        return (
          <div key={r.role} {...panelProps(i)} className="mt-10 outline-none">
            {active === i && (
              <div className="s-fade-swap grid items-center gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
                <div>
                  <h3 className="s-h3">{r.title}</h3>
                  <p className="s-body mt-4 text-[1.0625rem]">{r.body}</p>
                  <ul className="s-ticks mt-6">
                    {r.points.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
                <div className={phone ? "flex justify-center" : ""}>
                  {phone ? (
                    <Screen name={r.screen} className="w-[min(18rem,72vw)]" sizes="288px" />
                  ) : (
                    <Screen name={r.screen} className="w-full" sizes="(min-width: 1280px) 800px, (min-width: 1024px) 64vw, 100vw" />
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
