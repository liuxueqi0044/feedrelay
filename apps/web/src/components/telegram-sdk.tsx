"use client";
import Script from "next/script";
export function TelegramSdk() {
  return <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" onLoad={() => window.dispatchEvent(new Event("feedrelay:telegram-ready"))}/>;
}
