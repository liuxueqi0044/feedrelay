import Link from "next/link";
import { Brand, Icon } from "@/components/ui";
import { Pricing } from "@/components/pricing";
import styles from "./landing.module.css";

const steps = [
  { number: "01", icon: "rss" as const, title: "Bring your sources.", text: "Paste an RSS or Atom URL. Already have a collection? Import it all with OPML.", detail: "Blogs · publications · release notes" },
  { number: "02", icon: "filter" as const, title: "Keep the good stuff.", text: "Choose the keywords you want, skip the ones you don’t, and set how often we check.", detail: "Your sources. Your rules." },
  { number: "03", icon: "telegram" as const, title: "Meet it in Telegram.", text: "Send matching updates to your private chat or a channel. Open the original when you’re ready.", detail: "One familiar place to catch up" },
];

function RelayPreview() {
  return <div className={styles.relayPreview} aria-label="Example: RSS sources filtered into a Telegram message">
    <div className={styles.previewBar}><span><i/> YOUR READING FLOW</span><span className={styles.example}>ILLUSTRATION</span></div>
    <div className={styles.previewSources}>
      <div className={styles.sourceNote}><span className={styles.rssIcon}><Icon name="rss" size={21}/></span><div><strong>Engineering notes</strong><span>RSS feed · new article</span></div><Icon name="check" size={16}/></div>
      <div className={styles.sourceNote}><span className={styles.designIcon}><Icon name="source" size={21}/></span><div><strong>Design dispatch</strong><span>Atom feed · new article</span></div><Icon name="check" size={16}/></div>
    </div>
    <div className={styles.connector}><span/><div><Icon name="filter" size={15}/> Your keyword filters <Icon name="check" size={14}/></div><span/></div>
    <div className={styles.telegramPreview}>
      <div className={styles.telegramHeader}><span className={styles.telegramIcon}><Icon name="telegram" size={23}/></span><div><strong>My reading corner</strong><span>Telegram · private chat</span></div><span className={styles.messageDot}/></div>
      <div className={styles.messageBubble}><span className={styles.messageSource}>ENGINEERING NOTES</span><h3>Build less. Make it matter.</h3><p>A field guide to small, useful tools — and the ideas that make them work.</p><span className={styles.articleLink}>Read the original <Icon name="external" size={12}/></span><div className={styles.messageTime}>Example update <Icon name="check" size={13}/><Icon name="check" size={13}/></div></div>
    </div>
    <div className={styles.previewBottom}><Icon name="route" size={15}/><span>A direct line from source to inbox.</span></div>
  </div>;
}

export default function Home() {
  return <div className={styles.page}>
    <a className={styles.skipLink} href="#main">Skip to content</a>
    <header className={styles.header}><div className={styles.nav}><Brand/><nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#features">Features</a><a href="#pricing">Pricing</a></nav><Link className={styles.navCta} href="/dashboard">Open workspace<Icon name="arrow" size={17}/></Link></div></header>
    <main id="main">
      <section className={`${styles.hero} ${styles.wrap}`}>
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}><span/> LESS CHECKING. MORE READING.</div>
          <h1>The web moves.<br/>Your inbox<br/><span>keeps up.</span></h1>
          <p>Your favorite blogs, newsletters with RSS, and release notes. Filtered to what matters. Delivered straight to Telegram.</p>
          <div className={styles.heroActions}><Link className="button primary large" href="/dashboard">Connect your first feed<Icon name="arrow" size={18}/></Link><a className={styles.secondaryLink} href="#how-it-works">See how it works<Icon name="chevron" size={15}/></a></div>
          <div className={styles.heroFootnote}><span><Icon name="check" size={15}/> Free to get started</span><span><Icon name="check" size={15}/> No new reading app</span></div>
        </div>
        <RelayPreview/>
      </section>
      <div className={styles.sourceStrip}><div className={styles.wrap}><span className={styles.stripLabel}>ONE PLACE FOR YOUR</span><span><Icon name="source" size={19}/> Favorite blogs</span><span><Icon name="log" size={19}/> Release notes</span><span><Icon name="rss" size={19}/> RSS newsletters</span><span><Icon name="destination" size={19}/> Industry updates</span></div></div>
      <section className={`${styles.howSection} ${styles.wrap}`} id="how-it-works">
        <div className={styles.sectionHeading}><div><span className={styles.kicker}>01 / SET YOUR FLOW</span><h2>Three connections.<br/>A lot fewer open tabs.</h2></div><p>Stop making the rounds.<br/>Let the next good read come to you.</p></div>
        <div className={styles.steps}>{steps.map(step => <article key={step.number} className={styles.step}><div className={styles.stepTop}><span className={styles.stepIcon}><Icon name={step.icon} size={25}/></span><span>{step.number}</span></div><h3>{step.title}</h3><p>{step.text}</p><small>{step.detail}</small></article>)}</div>
      </section>
      <section className={`${styles.featureSection} ${styles.wrap}`} id="features">
        <div className={styles.sectionHeading}><div><span className={styles.kicker}>02 / KEEP THE SIGNAL</span><h2>Less noise.<br/>More on your terms.</h2></div><p>Simple controls for the things you follow.<br/>A clear record of what gets through.</p></div>
        <div className={styles.featureGrid}>
          <article className={styles.filterFeature}><div className={styles.featureText}><span className={styles.featureIcon}><Icon name="filter" size={23}/></span><h3>A feed is a start.<br/>Your rules make it yours.</h3><p>Include the keywords you care about. Exclude the rest. Match titles or full feed content, and preview before you send.</p></div><div className={styles.filterExample} aria-label="Example keyword rules"><div><span>INCLUDE</span><span className={styles.includeTag}>design</span><span className={styles.includeTag}>engineering</span></div><div><span>EXCLUDE</span><span className={styles.excludeTag}>sponsored <Icon name="close" size={11}/></span></div><div className={styles.filterResult}><Icon name="check" size={16}/> Your reading list, with a little more intention.</div></div></article>
          <article className={styles.logFeature}><span className={styles.featureIcon}><Icon name="log" size={23}/></span><h3>No mystery messages.</h3><p>See what was sent, what’s waiting, and what needs attention in your delivery log.</p><div className={styles.logExample} aria-label="Example delivery statuses"><div><span><i/> Release notes</span><span>Sent <Icon name="check" size={12}/></span></div><div><span><i/> Weekly dispatch</span><span>Pending <Icon name="clock" size={12}/></span></div></div></article>
          <article className={styles.smallFeature}><span className={styles.featureIcon}><Icon name="pause" size={23}/></span><div><h3>Your pace. Your pause button.</h3><p>Pause any route. When you’re ready, catch up on recent updates or start fresh.</p></div></article>
          <article className={styles.smallFeature}><span className={styles.featureIcon}><Icon name="download" size={23}/></span><div><h3>Your collection stays yours.</h3><p>Move feeds in or out with OPML. Your sources are always yours to take along.</p></div></article>
        </div>
      </section>
      <section className={`${styles.pricingSection} ${styles.wrap}`} id="pricing"><div className={styles.sectionHeading}><div><span className={styles.kicker}>03 / FIND YOUR PACE</span><h2>Start with a few favorites.</h2></div><p>Free gives you room to get started.<br/>Starter gives your collection room to grow.</p></div><Pricing/><p className={styles.pricingNote}>Paid plans use Telegram Stars. Check availability and the current price in your workspace before purchase.</p></section>
      <section className={styles.closing}><div className={styles.wrap}><div><span className={styles.closingLabel}><Icon name="rss" size={17}/> THE NEXT GOOD READ IS OUT THERE.</span><h2>Give it a way<br/>to find you.</h2></div><div className={styles.closingAction}><Link className="button large" href="/dashboard">Create your reading flow<Icon name="arrow" size={20}/></Link><p>Good sources. One familiar inbox.</p></div></div><span className={styles.closingDecoration} aria-hidden="true"><Icon name="rss" size={260}/></span></section>
    </main>
    <footer className={`${styles.footer} ${styles.wrap}`}><div><Brand/><p>A direct line to what matters.</p></div><nav aria-label="Footer navigation"><a href="#pricing">Plans</a><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></nav><small>© {new Date().getFullYear()} FeedRelay</small></footer>
  </div>;
}
