"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { request, type Config } from "@/lib/api";
import { Icon } from "./ui";
import styles from "./pricing.module.css";

export function Pricing() {
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => { request<Config>("/config").then(setConfig).catch(() => {}); }, []);
  return <div className={styles.grid}>
    <article className={styles.card}>
      <div className={styles.label}><h3>Free</h3><span>For your daily reading</span></div>
      <div className={styles.price}>0<span>Stars / 30 days</span></div>
      <p>A few favorite sources. A simpler way to follow them.</p>
      <ul>{["3 RSS or Atom sources", "1 Telegram destination", "200 deliveries per 30 days", "Feeds checked every 60 minutes", "Keyword filters and delivery history"].map(x => <li key={x}><Icon name="check" size={16}/>{x}</li>)}</ul>
      <Link className="button secondary" href="/dashboard">Start with Free<Icon name="arrow" size={17}/></Link>
    </article>
    <article className={`${styles.card} ${styles.featured}`}>
      <div className={styles.label}><h3>Starter</h3><span>Room for more</span></div>
      <div className={`${styles.price} ${!config?.billingEnabled ? styles.priceNote : ""}`}>{config?.billingEnabled ? <>{config.starterStars}<span>Stars / 30 days</span></> : "Pricing available at launch"}</div>
      <p>A bigger collection, with more frequent updates.</p>
      <ul>{["30 RSS or Atom sources", "3 Telegram destinations", "5,000 deliveries per 30 days", "Checks as often as every 5 minutes", "Keyword filters and delivery history"].map(x => <li key={x}><Icon name="check" size={16}/>{x}</li>)}</ul>
      <Link className="button primary" href="/dashboard?tab=billing">{config?.billingEnabled ? "Explore Starter" : "View plans in your workspace"}<Icon name="arrow" size={17}/></Link>
    </article>
  </div>;
}
