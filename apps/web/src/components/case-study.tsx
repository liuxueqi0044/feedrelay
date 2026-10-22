import Link from "next/link";
import { Icon } from "@/components/ui";
import { CaseComparison, ProjectInquiry } from "@/components/case-interactions";
import s from "./case-study.module.css";

const copy = {
  en: {
    selected: "SELECTED WORK / 01", contact: "Discuss a project", skip: "Skip to case study",
    badge: "INDEPENDENT PRODUCT · FEEDRELAY",
    title: <>From scattered updates.<br/><span>To one familiar inbox.</span></>,
    intro: "A working web product that brings website updates into Telegram. From the first visit to the last delivery, every step has a place.",
    explore: "Explore the product", transformation: "See the redesign", note: "Self-initiated project · Screenshots use demo data",
    facts: [["THE PRODUCT", "Website updates → Telegram"], ["OUR SCOPE", "Website, dashboard & workflow"], ["THE EXPERIENCE", "Desktop & mobile"]],
    heroCaption: "The working dashboard. Real interface, sample content.",
    problemLabel: "01 / THE PROBLEM", problemTitle: "Good information.\nToo many places to check.",
    problemText: "Imagine a small editorial or research team following several blogs and release feeds. Someone has to visit each source, find the relevant updates, and share the links with everyone else.",
    problemNote: "This is the use case the product was designed for; it is not a claim about a paying client.",
    oldFlow: "THE MANUAL ROUTINE", oldSteps: ["Visit each website", "Scan for relevant posts", "Copy links into chat"],
    newFlow: "WITH FEEDRELAY", newSteps: ["Choose the sources", "Set your keyword rules", "Review routed updates"],
    builtLabel: "02 / WHAT WE BUILT", builtTitle: "One product.\nA complete path through it.",
    builtIntro: "The website explains the value. The workspace lets people set it up. The delivery record shows what happened next.",
    features: [
      { icon: "source" as const, title: "A clear first impression", text: "A public website that explains the product, shows the workflow, and leads visitors into the workspace." },
      { icon: "filter" as const, title: "Controls people can use", text: "Add feeds, choose a destination, set keywords, preview a message, and pause or resume a route." },
      { icon: "log" as const, title: "A visible result", text: "Delivery history makes sent, pending, and failed updates inspectable instead of hiding the outcome." },
    ],
    redesignLabel: "03 / THE REDESIGN", redesignTitle: "Make the next action\neasier to see.",
    redesignIntro: "The original workspace already had the core functions. The redesign gives them clearer hierarchy, more readable text, and more distinct controls.",
    improvements: [["Clearer navigation", "Working tools and account settings are grouped separately."], ["More readable screens", "Stronger text contrast and spacing make status and actions easier to distinguish."], ["A proper mobile layout", "The sidebar becomes a drawer. Forms and cards adapt to a narrow screen."]],
    mobileLabel: "04 / SMALL SCREEN, SAME WORKFLOW", mobileTitle: "The phone experience\nis part of the product.",
    mobileText: "The public site, workspace, navigation, and forms adapt to a phone. You can check a route or review a delivery without reaching for a laptop.",
    mobileBullets: ["Readable cards and tap-sized controls", "A menu that opens, closes, and returns focus", "Forms checked on a narrow screen"],
    mobileCaption: "Actual mobile captures · Homepage and workspace",
    proofLabel: "05 / TRY IT YOURSELF", proofTitle: "Follow one update.\nSee the result.",
    proofIntro: "Use the demo workspace to inspect the complete path with sample content. No Telegram credentials are needed in demo mode.",
    demoSteps: [["Open the workspace", "Choose “Try the demo workspace” if the sign-in screen appears."], ["Connect the pieces", "If the workspace is empty, add the sample feed, connect a simulated private chat, and create a route. Wait for it to become Active."], ["Publish and inspect", "Click “Publish sample update”, then open Delivery logs. Inspect the message and its Sent status."]],
    demoNote: "Demo mode simulates Telegram delivery and disables payments. You can inspect the workflow without sending a real message.",
    verifiedTitle: "What we checked", verified: [["154", "automated checks passed"], ["320–1280", "px · selected layouts checked"], ["1 full flow", "source → route → simulated delivery"]],
    evidenceNote: "Local verification, 23 Oct 2026. These are implementation checks, not customer growth or revenue figures.",
    detailsTitle: "For a technical reviewer", detailsText: "Next.js and React for the interface; TypeScript services for feeds, routing, and delivery. Demo mode uses a local data store and a simulated sender. Production integration code, deployment instructions, and recovery documentation are included in the project. Real Telegram delivery, payments, and production operation require separate deployment and acceptance checks.",
    fitLabel: "06 / YOUR PROJECT", fitTitle: "Have a workflow\nworth turning into a product?",
    fitText: "This case shows the kind of work we can take on: a first web product, an internal operations tool, or a dashboard around an existing service.",
    fitPoints: [["Start with a clear finish line", "Agree on the users, main workflow, and acceptance checks before development."], ["Review working progress", "Try the core flow as it is built, then refine the details against real use."], ["Keep the work you paid for", "Plan for source code, setup instructions, and a handoff that another developer can follow."]],
    hiringTitle: "Why a project partner instead of a hire?", hiringText: "For a defined product or workflow, you can review a concrete scope and a working result before committing to an ongoing team. If you need continuous, open-ended development, hiring may still fit better.",
    inquiryLabel: "LET’S MAKE YOUR IDEA TESTABLE", inquiryTitle: "Show us the work\nyou want to simplify.", inquiryText: "Tell us who will use it, what they do today, and what a useful first version should do. We can discuss scope from there.",
    footer: "Independent product case by Xueqi Liu", portfolio: "Portfolio", source: "Project repository", product: "FeedRelay home",
  },
  zh: {
    selected: "作品案例 / 01", contact: "聊聊你的项目", skip: "跳到案例正文",
    badge: "自主开发项目 · FEEDRELAY",
    title: <>不用挨个刷网站。<br/><span>重要更新，自己送过来。</span></>,
    intro: "把网站更新自动筛选后送到 Telegram。从介绍产品，到用户设置，再到查看发送结果，我们把整个过程做成了可以亲手操作的产品。",
    explore: "打开产品体验", transformation: "查看改版对比", note: "自主开发作品 · 截图使用演示数据",
    facts: [["它解决什么", "网站更新 → Telegram 消息"], ["我们做了什么", "介绍网站、管理后台、业务流程"], ["在哪里使用", "电脑和手机"]],
    heroCaption: "真实运行的管理后台，内容为演示数据。",
    problemLabel: "01 / 从什么问题出发", problemTitle: "信息有价值，\n来回查找却很费事。",
    problemText: "设想一个需要关注行业动态的小团队：每天要打开好几个博客和产品更新网站，找出相关内容，再把链接发到群里。只要来源变多，这件事就会不断重复。",
    problemNote: "这是产品针对的使用场景，不代表已有付费客户的实际情况。",
    oldFlow: "原来的做法", oldSteps: ["逐个打开网站", "人工筛选相关内容", "复制链接到聊天里"],
    newFlow: "使用 FEEDRELAY", newSteps: ["选好需要关注的来源", "设置关键词筛选条件", "查看自动推送的结果"],
    builtLabel: "02 / 我们做了什么", builtTitle: "从看懂产品，\n到真的用起来。",
    builtIntro: "介绍页让人明白有什么用，后台让人完成设置，发送记录让人知道事情有没有办成。",
    features: [
      { icon: "source" as const, title: "让客户一眼看懂", text: "完整的产品介绍页，说明用途、使用步骤和方案，并引导用户进入产品。" },
      { icon: "filter" as const, title: "让用户自己操作", text: "添加来源、选择接收位置、设置关键词、预览消息，也能随时暂停和恢复。" },
      { icon: "log" as const, title: "让结果有据可查", text: "每条更新都有记录，可以查看已经发送、正在等待或需要处理的状态。" },
    ],
    redesignLabel: "03 / 真实改版对比", redesignTitle: "功能已经有了，\n还要让人用得明白。",
    redesignIntro: "原版后台已具备核心功能。这次改造重新整理了页面层次、文字对比和操作入口，让用户更容易找到下一步。",
    improvements: [["入口更好找", "常用操作和账户设置分组，当前页面更醒目。"], ["内容更好读", "调整文字对比、留白和状态样式，让信息与按钮容易区分。"], ["手机也能完整操作", "侧栏变成可收起的菜单，表单和卡片适应窄屏。"]],
    mobileLabel: "04 / 手机端同样完整", mobileTitle: "不是只能在\n电脑上看的作品。",
    mobileText: "介绍页、后台、导航和表单都适应手机尺寸。查看发送记录、检查规则，不必专门打开电脑。",
    mobileBullets: ["卡片文字清楚，按钮方便点击", "菜单可以展开、关闭，并支持键盘操作", "窄屏表单经过实际检查"],
    mobileCaption: "手机尺寸真实截图 · 产品首页与后台",
    proofLabel: "05 / 你可以亲手验证", proofTitle: "发一条示例更新，\n看完整个过程。",
    proofIntro: "演示工作空间提供示例内容，可以检查从来源到发送记录的整条流程。演示模式不需要你的 Telegram 凭据。",
    demoSteps: [["进入工作空间", "如果出现登录页，点击“Try the demo workspace”进入演示。"], ["连接来源和接收位置", "如果后台为空，添加内置 sample feed、连接模拟私聊，再创建一条 route，等待状态变为 Active。"], ["发布并查看结果", "点击“Publish sample update”，进入 Delivery logs，查看消息内容和 Sent 状态。"]],
    demoNote: "演示模式中的 Telegram 发送为模拟操作，支付关闭；可以体验流程，不会向真实联系人发送消息。",
    verifiedTitle: "已经完成的检查", verified: [["154 项", "自动化检查通过"], ["320–1280", "像素范围内的代表尺寸检查"], ["1 条完整流程", "来源 → 规则 → 模拟发送"]],
    evidenceNote: "2026 年 10 月 23 日本地验证。这些是产品检查结果，不是客户增长或收入数据。",
    detailsTitle: "给负责技术评估的人", detailsText: "界面使用 Next.js 和 React，业务服务使用 TypeScript。演示模式采用本地数据存储和模拟发送。项目包含正式接入代码、部署说明与恢复文档。真实 Telegram 发送、支付与正式环境运行，需要在部署后单独验收。",
    fitLabel: "06 / 这个能力能用到哪里", fitTitle: "你也有一件重复的事，\n想把它做成产品？",
    fitText: "这个案例展示了我们可以承担的项目类型：一个新产品的首版、团队内部使用的小系统，或给现有服务加一个方便操作的后台。",
    fitPoints: [["先说清做到什么程度", "开始前确定谁使用、主要操作流程是什么、怎样算完成。"], ["开发中就能上手检查", "先把核心流程做通，让你实际操作，再根据使用情况完善细节。"], ["交付后接得走", "把源码、启动说明和交接资料纳入约定，让后续开发者能接手。"]],
    hiringTitle: "为什么找项目合作方，而不是直接招人？", hiringText: "如果你眼下要完成的是一件范围明确的事，可以先看清交付内容，再通过可运行的产品验收。长期、持续而且需求开放的开发工作，招聘也可能更合适。",
    inquiryLabel: "把你的想法，变成可以验证的东西", inquiryTitle: "说说你想\n省掉哪段重复工作。", inquiryText: "告诉我们谁会使用、现在怎么做、第一版需要完成什么。我们从具体需求开始讨论。",
    footer: "Xueqi Liu 自主开发作品案例", portfolio: "个人作品集", source: "项目代码仓库", product: "FeedRelay 首页",
  },
};

export function CaseStudy({ locale }: { locale: "en" | "zh" }) {
  const c = copy[locale];
  return <div className={s.page} lang={locale === "zh" ? "zh-CN" : "en"}>
    <a className={s.skip} href="#case-main">{c.skip}</a>
    <header className={s.header}><div className={s.nav}>
      <a href="https://xueqiliu.com" className={s.wordmark}>Xueqi Liu<span>{c.selected}</span></a>
      <div className={s.navRight}><nav aria-label={locale === "zh" ? "语言" : "Language"} className={s.languages}><Link href="/case-study" hrefLang="en" lang="en" aria-current={locale === "en" ? "page" : undefined}>EN</Link><Link href="/case-study/zh" hrefLang="zh-CN" lang="zh-CN" aria-current={locale === "zh" ? "page" : undefined}>中文</Link></nav><a href="#inquiry" className={s.navCta}>{c.contact}<Icon name="arrow" size={16}/></a></div>
    </div></header>
    <main id="case-main">
      <section className={`${s.wrap} ${s.hero}`}>
        <div className={s.eyebrow}><span/>{c.badge}</div>
        <div className={s.heroGrid}><h1>{c.title}</h1><div className={s.heroAside}><p>{c.intro}</p><div className={s.actions}><Link href="/dashboard" className={s.primary}>{c.explore}<Icon name="arrow" size={17}/></Link><a href="#redesign" className={s.textLink}>{c.transformation}<Icon name="chevron" size={15}/></a></div><small>{c.note}</small></div></div>
        <figure className={s.heroImage}><div className={s.browserBar}><span><i/><i/><i/></span><span>FEEDRELAY / WORKSPACE</span><Icon name="grid" size={13}/></div><a href="/case-study/dashboard-desktop.png" target="_blank" rel="noreferrer" aria-label={locale === "zh" ? "打开完整后台截图" : "Open full dashboard screenshot"}><img src="/case-study/dashboard-desktop.png" width="1265" height="712" alt={c.heroCaption} fetchPriority="high"/></a><figcaption>{c.heroCaption}</figcaption></figure>
        <dl className={s.facts}>{c.facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </section>
      <section className={`${s.wrap} ${s.section} ${s.problem}`}>
        <div><span className={s.kicker}>{c.problemLabel}</span><h2>{c.problemTitle}</h2><p className={s.body}>{c.problemText}</p><p className={s.smallNote}>{c.problemNote}</p></div>
        <div className={s.flow}><div><span>{c.oldFlow}</span><ol>{c.oldSteps.map((step, i) => <li key={step}><b>0{i + 1}</b>{step}</li>)}</ol></div><div><span>{c.newFlow}</span><ol>{c.newSteps.map((step, i) => <li key={step}><b>0{i + 1}</b>{step}<Icon name="check" size={16}/></li>)}</ol></div></div>
      </section>
      <section className={s.built}><div className={`${s.wrap} ${s.section}`}><div className={s.sectionHeading}><div><span className={s.kicker}>{c.builtLabel}</span><h2>{c.builtTitle}</h2></div><p className={s.body}>{c.builtIntro}</p></div><div className={s.features}>{c.features.map((feature, i) => <article key={feature.title}><div className={s.featureTop}><Icon name={feature.icon} size={27}/><span>0{i + 1}</span></div><h3>{feature.title}</h3><p>{feature.text}</p></article>)}</div></div></section>
      <section id="redesign" className={`${s.wrap} ${s.section}`}><div className={s.sectionHeading}><div><span className={s.kicker}>{c.redesignLabel}</span><h2>{c.redesignTitle}</h2></div><p className={s.body}>{c.redesignIntro}</p></div><CaseComparison locale={locale}/><div className={s.improvements}>{c.improvements.map(([title, text]) => <div key={title}><h3><Icon name="check" size={17}/>{title}</h3><p>{text}</p></div>)}</div></section>
      <section className={s.mobileSection}><div className={`${s.wrap} ${s.mobileGrid}`}><div><span className={s.kicker}>{c.mobileLabel}</span><h2>{c.mobileTitle}</h2><p className={s.body}>{c.mobileText}</p><ul className={s.checkList}>{c.mobileBullets.map(item => <li key={item}><Icon name="check" size={17}/>{item}</li>)}</ul></div><figure className={s.phones}><div><a href="/case-study/homepage-mobile.png" target="_blank" rel="noreferrer"><img src="/case-study/homepage-mobile.png" width="375" height="812" loading="lazy" alt={locale === "zh" ? "FeedRelay 手机端首页截图" : "FeedRelay mobile homepage screenshot"}/></a><a href="/case-study/dashboard-mobile.png" target="_blank" rel="noreferrer"><img src="/case-study/dashboard-mobile.png" width="375" height="812" loading="lazy" alt={locale === "zh" ? "FeedRelay 手机端后台截图" : "FeedRelay mobile dashboard screenshot"}/></a></div><figcaption>{c.mobileCaption}</figcaption></figure></div></section>
      <section id="try-it" className={`${s.wrap} ${s.section}`}><div className={s.sectionHeading}><div><span className={s.kicker}>{c.proofLabel}</span><h2>{c.proofTitle}</h2></div><p className={s.body}>{c.proofIntro}</p></div><ol className={s.demoSteps}>{c.demoSteps.map(([title, text], i) => <li key={title}><span>0{i + 1}</span><h3>{title}</h3><p>{text}</p></li>)}</ol><div className={s.demoAction}><Link href="/dashboard" className={s.primary}>{c.explore}<Icon name="arrow" size={17}/></Link><p>{c.demoNote}</p></div><div className={s.evidence}><h3>{c.verifiedTitle}</h3><dl>{c.verified.map(([value, label]) => <div key={label}><dt>{value}</dt><dd>{label}</dd></div>)}</dl><p>{c.evidenceNote}</p><details><summary>{c.detailsTitle}</summary><p>{c.detailsText}</p></details></div></section>
      <section className={s.fitSection}><div className={`${s.wrap} ${s.section}`}><div className={s.sectionHeading}><div><span className={s.kicker}>{c.fitLabel}</span><h2>{c.fitTitle}</h2></div><p className={s.body}>{c.fitText}</p></div><div className={s.fitPoints}>{c.fitPoints.map(([title, text], i) => <article key={title}><span>0{i + 1}</span><h3>{title}</h3><p>{text}</p></article>)}</div><details className={s.hiring}><summary>{c.hiringTitle}</summary><p>{c.hiringText}</p></details></div></section>
      <section id="inquiry" className={`${s.wrap} ${s.section} ${s.inquiry}`}><div><span className={s.kicker}>{c.inquiryLabel}</span><h2>{c.inquiryTitle}</h2><p className={s.body}>{c.inquiryText}</p><a href="mailto:xueqi@xueqiliu.com" className={s.email}>xueqi@xueqiliu.com<Icon name="external" size={16}/></a></div><ProjectInquiry locale={locale}/></section>
    </main>
    <footer className={`${s.wrap} ${s.footer}`}><p>{c.footer}</p><nav aria-label={locale === "zh" ? "页脚链接" : "Footer links"}><Link href="/">{c.product}</Link><a href="https://xueqiliu.com">{c.portfolio}</a><a href="https://github.com/liuxueqi0044/feedrelay">{c.source}<Icon name="external" size={12}/></a></nav></footer>
  </div>;
}
