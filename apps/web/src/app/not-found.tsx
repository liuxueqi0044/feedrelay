import Link from "next/link";
import { Brand } from "@/components/ui";
export default function NotFound() {
  return <main className="auth-page"><Brand /><div className="auth-card"><span className="eyebrow">404 / A missing connection</span><h1>This page wandered off.</h1><p>Let’s get you back to your feeds.</p><Link className="button primary" href="/">Back to FeedRelay</Link></div></main>;
}
