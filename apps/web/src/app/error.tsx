"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="auth-page"><div className="auth-card"><span className="eyebrow">Something interrupted the connection</span><h1>Let’s try that again.</h1><p>We couldn’t display this page. Your workspace is still saved.</p><button className="button primary" onClick={reset}>Try again</button><a className="text-link" href="/">Return home</a></div></main>;
}
