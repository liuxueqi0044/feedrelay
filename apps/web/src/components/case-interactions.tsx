"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import styles from "./case-interactions.module.css";

type Locale = "en" | "zh";
const contactEmail = "xueqi@xueqiliu.com";

const copy = {
  en: {
    comparisonLabel: "Compare the workspace design",
    before: "Before",
    after: "After",
    beforeAlt: "FeedRelay workspace before the redesign, with a pale green interface and dense navigation.",
    afterAlt: "FeedRelay workspace after the redesign, with clear navigation, readable status cards and a blue and white interface.",
    comparisonNote: "Actual interface screenshots using demo data. This compares the design, not business results.",
    name: "Your name",
    optional: "optional",
    idea: "What do you want to build?",
    ideaPlaceholder: "For example: a tool that collects new enquiries and reminds our team to follow up.",
    current: "How do you handle it today?",
    currentPlaceholder: "A spreadsheet, several apps, manual work — a few sentences are enough.",
    requiredMessage: "Tell us briefly what you want to build.",
    email: "Open email draft",
    copy: "Copy brief",
    copying: "Copying…",
    explanation: "Opens a draft in your email app. Review it and send it when you are ready.",
    requested: "Email draft requested. If no email app opens, copy your brief and email the address below.",
    copied: "Brief copied. Paste it into an email to the address below.",
    copyFailed: "Your browser could not copy the brief. Select and copy it from the box below.",
    draftFailed: "Your email app could not be opened. Copy your brief and email the address below.",
    manual: "Your brief — select and copy",
    direct: "Or email directly:",
    subject: "Project enquiry — FeedRelay case study",
    greeting: "Hi Xueqi,\n\nI saw the FeedRelay case study and would like to discuss a project.",
  },
  zh: {
    comparisonLabel: "查看工作台改造前后",
    before: "改造前",
    after: "改造后",
    beforeAlt: "FeedRelay 改造前的工作台：浅绿色界面，导航较密集。",
    afterAlt: "FeedRelay 改造后的工作台：清晰的导航和状态卡片，蓝白配色。",
    comparisonNote: "真实界面截图，使用演示数据。这里对比的是设计变化，不代表业务指标变化。",
    name: "怎么称呼你",
    optional: "选填",
    idea: "你想做什么产品或工具？",
    ideaPlaceholder: "例如：把新客户的咨询集中起来，并提醒团队跟进。",
    current: "你现在怎么处理这件事？",
    currentPlaceholder: "用表格、几个不同的软件，或手动处理……简单说几句就够了。",
    requiredMessage: "请简单描述一下你想做什么。",
    email: "打开邮件草稿",
    copy: "复制需求",
    copying: "正在复制…",
    explanation: "会在你的邮件应用里打开草稿。你可以检查、修改，再自行发送。",
    requested: "已请求打开邮件草稿。如果没有弹出邮件应用，可以复制需求，发送到下方邮箱。",
    copied: "需求已复制，可以粘贴到邮件中，发送到下方邮箱。",
    copyFailed: "浏览器未能复制。你可以在下方文本框里选中并手动复制。",
    draftFailed: "未能打开邮件应用。可以复制需求，发送到下方邮箱。",
    manual: "你的需求 · 可选中复制",
    direct: "也可以直接发邮件：",
    subject: "项目咨询 · FeedRelay 案例",
    greeting: "你好 Xueqi，\n\n我看到了 FeedRelay 案例，想聊聊我的项目。",
  },
} as const;

export function CaseComparison({ locale }: { locale: Locale }) {
  const [view, setView] = useState<"before" | "after">("after");
  const text = copy[locale];
  const imageId = useId();

  return (
    <figure className={styles.comparison}>
      <div className={styles.comparisonHeader}>
        <div className={styles.switcher} role="group" aria-label={text.comparisonLabel}>
          {(["before", "after"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              aria-controls={imageId}
              onClick={() => setView(option)}
            >
              {text[option]}
            </button>
          ))}
        </div>
        <span className={styles.snapshotLabel} aria-live="polite">{text[view]}</span>
      </div>
      <div className={styles.imageFrame} id={imageId}>
        {/* Keep the original screenshot pixels available without image recompression. */}
        <img
          src={view === "before" ? "/case-study/dashboard-before.png" : "/case-study/dashboard-desktop.png"}
          alt={view === "before" ? text.beforeAlt : text.afterAlt}
          width={1265}
          height={712}
          loading="lazy"
        />
      </div>
      <figcaption className={styles.caption}>{text.comparisonNote}</figcaption>
    </figure>
  );
}

export function ProjectInquiry({ locale }: { locale: Locale }) {
  const text = copy[locale];
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const ideaRef = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState("");
  const [idea, setIdea] = useState("");
  const [current, setCurrent] = useState("");
  const [status, setStatus] = useState("");
  const [showManualCopy, setShowManualCopy] = useState(false);
  const [copying, setCopying] = useState(false);

  const brief = [
    text.greeting,
    name.trim() ? `${text.name}: ${name.trim()}` : "",
    `${text.idea}\n${idea.trim()}`,
    current.trim() ? `${text.current}\n${current.trim()}` : "",
  ].filter(Boolean).join("\n\n");

  function validate() {
    ideaRef.current?.setCustomValidity(idea.trim() ? "" : text.requiredMessage);
    return formRef.current?.reportValidity() ?? false;
  }

  function openDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validate()) return;
    setStatus("");
    try {
      window.location.href = `mailto:${contactEmail}?subject=${encodeURIComponent(text.subject)}&body=${encodeURIComponent(brief)}`;
      setStatus(text.requested);
    } catch {
      setStatus(text.draftFailed);
      setShowManualCopy(true);
    }
  }

  async function copyBrief() {
    if (!validate()) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(brief);
      setStatus(text.copied);
      setShowManualCopy(false);
    } catch {
      setStatus(text.copyFailed);
      setShowManualCopy(true);
    } finally {
      setCopying(false);
    }
  }

  return (
    <form className={styles.inquiry} ref={formRef} onSubmit={openDraft}>
      <div className={styles.field}>
        <label htmlFor={`${id}-name`}>{text.name} <span>({text.optional})</span></label>
        <input id={`${id}-name`} name="name" autoComplete="name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className={styles.field}>
        <label htmlFor={`${id}-idea`}>{text.idea} <span aria-hidden="true">*</span></label>
        <textarea
          ref={ideaRef}
          id={`${id}-idea`}
          name="idea"
          rows={4}
          required
          maxLength={2000}
          placeholder={text.ideaPlaceholder}
          value={idea}
          onChange={(event) => {
            event.target.setCustomValidity("");
            setIdea(event.target.value);
          }}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor={`${id}-current`}>{text.current} <span>({text.optional})</span></label>
        <textarea id={`${id}-current`} name="current" rows={3} maxLength={1000} placeholder={text.currentPlaceholder} value={current} onChange={(event) => setCurrent(event.target.value)} />
      </div>
      <div className={styles.actions}>
        <button className={styles.primary} type="submit" aria-describedby={`${id}-explanation`}>{text.email}<span aria-hidden="true">↗</span></button>
        <button className={styles.secondary} type="button" onClick={copyBrief} disabled={copying}>{copying ? text.copying : text.copy}</button>
      </div>
      <p className={styles.explanation} id={`${id}-explanation`}>{text.explanation}</p>
      <p className={styles.status} role="status" aria-live="polite">{status}</p>
      {showManualCopy && (
        <div className={styles.field}>
          <label htmlFor={`${id}-manual`}>{text.manual}</label>
          <textarea id={`${id}-manual`} rows={7} readOnly value={brief} onFocus={(event) => event.target.select()} />
        </div>
      )}
      <p className={styles.direct}>{text.direct} <a href={`mailto:${contactEmail}`}>{contactEmail}</a></p>
    </form>
  );
}
