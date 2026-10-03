"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { request, type Config } from "@/lib/api";
import { Icon } from "./ui";

export function Pricing() {
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => { request<Config>("/config").then(setConfig).catch(() => {}); }, []);
  return <div className="pricing-grid">
    <article className="price-card"><div className="price-top"><span className="eyebrow">A little less scrolling</span><h3>Free</h3><div className="price">0 <span>Stars / 30 days</span></div><p>A thoughtful starting point for your personal reading flow.</p></div><ul>{["3 RSS or Atom sources", "1 Telegram destination", "200 deliveries per 30 days", "Feeds checked every 60 minutes", "Keyword filters and delivery history"].map(x => <li key={x}><Icon name="check" size={17}/>{x}</li>)}</ul><Link className="button secondary" href="/dashboard">Start with Free<Icon name="arrow" size={17}/></Link></article>
    <article className="price-card featured"><div className="price-top"><span className="eyebrow">Room to follow more</span><h3>Starter</h3><div className={`price ${!config?.billingEnabled ? "price-note" : ""}`}>{config?.billingEnabled ? <>{config.starterStars} <span>Stars / 30 days</span></> : <>Pricing available at launch</>}</div><p>A wider collection of sources, delivered a little sooner.</p></div><ul>{["30 RSS or Atom sources", "3 Telegram destinations", "5,000 deliveries per 30 days", "Feeds checked as often as every 5 minutes", "The same simple, focused workspace"].map(x => <li key={x}><Icon name="check" size={17}/>{x}</li>)}</ul><Link className="button primary" href="/dashboard?tab=billing">{config?.billingEnabled ? "Explore Starter" : "View plans in your workspace"}<Icon name="arrow" size={17}/></Link></article>
  </div>;
}
