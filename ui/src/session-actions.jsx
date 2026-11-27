import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Archive, ArrowUpRight, Check, ChevronDown, Copy, FolderKanban, LoaderCircle, MoreHorizontal, ShieldCheck, X } from "lucide-react";

// Keep clipboard activation inside the click gesture, including asynchronous preparation.
async function copyPreparedPrompt(preparation, signal) {
  const data = preparation.then(handoff => {
    signal.throwIfAborted();
    return new Blob([handoff.prompt], { type: "text/plain" });
  });
  data.catch(() => {});
  if (navigator.clipboard?.write && typeof ClipboardItem === "function") {
    return navigator.clipboard.write([new ClipboardItem({ "text/plain": data })]);
  }
  const handoff = await preparation;
  signal.throwIfAborted();
  return navigator.clipboard.writeText(handoff.prompt);
}

function ActionHint({ text, confirmed = false, align = "center", children }) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (confirmed) setDismissed(false); }, [confirmed]);
  return <span className={`session-action-hint ${dismissed ? "session-action-hint-dismissed" : ""}`} data-confirmed={confirmed || undefined} data-align={align} onFocus={() => setDismissed(false)} onMouseEnter={() => setDismissed(false)} onKeyDown={event => {
    if (event.key === "Escape" && text && !dismissed) { event.stopPropagation(); setDismissed(true); }
  }}>
    {children(text ? id : undefined)}
    {text && <span className="session-action-tooltip" id={id} role="tooltip">{text}</span>}
  </span>;
}

export default function SessionActions({ api, providerId, record, token, isSavingKeep, onToggleSessionKeep, onToggleWorkspaceKeep, onViewHandoffs }) {
  const target = providerId === "codex" ? "claude" : "chatgpt";
  const targetName = target === "claude" ? "Claude" : "Codex";
  const [action, setAction] = useState(null);
  const [handoff, setHandoff] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsWorkspace, setNeedsWorkspace] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [warningsDismissed, setWarningsDismissed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const controller = useRef(null);
  const toolbar = useRef(null);
  const menu = useRef(null);
  const menuTrigger = useRef(null);
  const menuFocus = useRef("first");
  const menuId = useId();
  const sessionKept = Boolean(record.keep?.session);
  const workspaceKept = Boolean(record.keep?.workspace);
  const kept = sessionKept || workspaceKept;
  const busy = action !== null;
  const controlsBusy = busy || isSavingKeep;
  const handoffDisabled = controlsBusy || !token || record.rolloutMissing;
  const scopeQuery = `?${new URLSearchParams({ providerId, sessionId: record.id })}`;
  const keepHint = workspaceKept
    ? sessionKept ? "Kept by session and workspace rules. Use Actions to change protection." : "Kept by its workspace rule. Use Actions to change protection."
    : sessionKept ? "Remove this session’s Keep rule." : "Skip this session during Session Steward cleanup.";

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!menuOpen) return;
    const items = Array.from(menu.current.querySelectorAll('[role="menuitem"]:not([disabled])'));
    const focused = menuFocus.current === "workspace" ? menu.current.querySelector("[data-workspace-action]") : menuFocus.current === "last" ? items.at(-1) : items[0];
    focused?.focus();
    const outside = event => { if (!toolbar.current?.contains(event.target)) setMenuOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); };
  }, [menuOpen]);

  function openMenu(focus = "first") { menuFocus.current = focus; setMenuOpen(true); }
  function closeMenu() { setMenuOpen(false); menuTrigger.current?.focus(); }
  function menuKeys(event) {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); closeMenu(); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(menu.current.querySelectorAll('[role="menuitem"]:not([disabled])'));
      const current = items.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }

  async function prepare(nextAction) {
    setMenuOpen(false); setAction(nextAction); setError(""); setNotice(""); setCopied(false); setCopyFailed(false); setHandoff(null); setWarningsDismissed(false);
    const active = new AbortController();
    controller.current = active;
    const preparation = api(nextAction === "copy" ? "/api/handoffs/prepare" : "/api/handoffs", {
      method: "POST", signal: active.signal,
      headers: { "X-Session-Steward-Token": token },
      body: JSON.stringify({ providerId, id: record.id, target, launch: nextAction === "handoff", ...(needsWorkspace ? { workspace } : {}) }),
    }).then(result => result.handoff);
    const copying = nextAction === "copy" ? copyPreparedPrompt(preparation, active.signal).then(() => null, issue => issue) : null;
    try {
      const prepared = await preparation;
      if (active.signal.aborted || controller.current !== active) return;
      setHandoff(prepared);
      if (copying) {
        const issue = await copying;
        if (active.signal.aborted || controller.current !== active) return;
        if (issue) { setCopyFailed(true); setError("Clipboard access is unavailable. Copy the message below."); }
        else setCopied(true);
      } else if (!prepared.launchError) {
        setNotice(`Press Send in ${targetName} to continue.${target === "claude" ? " Claude may ask you to confirm the project folder." : ""}`);
      }
    } catch (issue) {
      if (issue.name !== "AbortError" && controller.current === active) {
        setError(issue.message);
        if (issue.code === "HANDOFF_WORKSPACE_REQUIRED") setNeedsWorkspace(true);
      }
    } finally {
      if (controller.current === active) { controller.current = null; setAction(null); }
    }
  }
  function cancel() { controller.current?.abort(); controller.current = null; setAction(null); }

  return <section className="session-actions" aria-label="Session actions">
    <div className="session-actions-toolbar" data-menu-open={menuOpen || undefined} ref={toolbar}>
      <div className="session-actions-group">
        <ActionHint align="start" text={record.rolloutMissing ? "The transcript is missing, so a handoff cannot be prepared." : `Open a new ${targetName} chat using this session’s context.`}>
          {description => <button aria-describedby={description} className="button primary session-handoff-button" disabled={handoffDisabled} onClick={() => prepare("handoff")} type="button">{action === "handoff" ? <LoaderCircle size={14} className="animate-spin"/> : <ArrowUpRight size={14}/>}Handoff to {targetName}</button>}
        </ActionHint>
        <ActionHint text={copied ? "Copied" : action === "copy" ? "Preparing handoff…" : "Copy handoff prompt"} confirmed={copied}>
          {description => <button aria-label="Copy handoff prompt" aria-describedby={description} aria-busy={action === "copy"} className="button ghost session-action-icon" disabled={handoffDisabled} onClick={() => prepare("copy")} type="button">{action === "copy" ? <LoaderCircle aria-hidden="true" size={14} className="animate-spin"/> : copied ? <Check aria-hidden="true" size={14}/> : <Copy aria-hidden="true" size={14}/>}</button>}
        </ActionHint>
      </div>
      <div className="session-actions-group session-actions-protection">
        <ActionHint align="end" text={keepHint}>
          {description => <button aria-describedby={description} aria-pressed={kept} aria-haspopup={workspaceKept ? "menu" : undefined} aria-expanded={workspaceKept ? menuOpen : undefined} aria-controls={workspaceKept ? menuId : undefined} className={`button session-keep-button ${kept ? "keep-action" : "ghost"}`} disabled={controlsBusy || !token} onClick={() => workspaceKept ? openMenu("workspace") : onToggleSessionKeep(record)} type="button">{isSavingKeep ? <LoaderCircle size={14} className="animate-spin"/> : workspaceKept ? <FolderKanban size={14}/> : <ShieldCheck size={14}/>}<span>{kept ? "Session kept" : "Keep session"}</span>{workspaceKept && <ChevronDown size={12}/>}</button>}
        </ActionHint>
        <ActionHint align="end" text={menuOpen ? null : "More session actions"}>
          {description => <button aria-label="Session actions menu" aria-describedby={description} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId} className="button ghost session-action-icon session-actions-more" disabled={controlsBusy} onClick={() => menuOpen ? closeMenu() : openMenu()} onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); openMenu(event.key === "ArrowUp" ? "last" : "first"); } }} ref={menuTrigger} type="button"><MoreHorizontal size={16}/></button>}
        </ActionHint>
      </div>
      {menuOpen && <div aria-label="Session actions" className="session-actions-menu" id={menuId} onKeyDown={menuKeys} ref={menu} role="menu">
        {workspaceKept && sessionKept && <button className="session-actions-menu-item" disabled={controlsBusy} onClick={() => { closeMenu(); onToggleSessionKeep(record); }} role="menuitem" type="button"><ShieldCheck size={15}/><span><strong>Stop keeping session</strong><small>Remove its individual rule. Workspace protection still applies.</small></span></button>}
        {record.cwd && <button className="session-actions-menu-item" data-workspace-action disabled={controlsBusy || !token} onClick={() => { closeMenu(); onToggleWorkspaceKeep(record); }} role="menuitem" type="button"><FolderKanban size={15}/><span><strong>{workspaceKept ? "Stop keeping workspace" : "Keep workspace"}</strong><small>{workspaceKept ? "Remove the workspace rule. Individually kept sessions stay kept." : "Skip cleanup for sessions in this workspace."}</small></span></button>}
        <a className="session-actions-menu-item" href={`/handoffs${scopeQuery}`} onClick={event => { setMenuOpen(false); onViewHandoffs(event, scopeQuery); }} role="menuitem"><Archive size={15}/><span><strong>View handoffs</strong><small>Only handoffs created from this session.</small></span></a>
      </div>}
    </div>
    {record.rolloutMissing && <p className="session-action-note">Transcript unavailable for handoff.</p>}
    {needsWorkspace && <label className="field session-action-workspace"><span>Current project folder</span><input onChange={event => setWorkspace(event.target.value)} placeholder={record.cwd || "Absolute local folder path"} value={workspace}/></label>}
    <div aria-live="polite" role="status">
      {busy && <p className="session-action-note">Preparing handoff… <button className="compact-action" onClick={cancel} type="button">Cancel</button></p>}
      {!busy && notice && <p className="session-action-note">{notice}</p>}
      <span className="sr-only">{copied ? "Handoff prompt copied." : ""}</span>
    </div>
    {!warningsDismissed && handoff?.warnings.length > 0 && <aside aria-atomic="true" className="session-action-warning" role="status">
      <AlertTriangle aria-hidden="true" size={16}/>
      <div><strong>Partial handoff</strong><ul>{handoff.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div>
      <button aria-label="Dismiss handoff warning" className="icon-button" onClick={() => setWarningsDismissed(true)} type="button"><X aria-hidden="true" size={14}/></button>
    </aside>}
    {(error || handoff?.launchError) && <p className="session-action-error" role="alert">{error || handoff.launchError}</p>}
    {handoff && (copyFailed || handoff.launchError) && <details className="session-action-fallback"><summary>Handoff files and prompt</summary><p>{handoff.directory}</p><textarea aria-label="Handoff prompt" readOnly value={handoff.prompt}/></details>}
  </section>;
}
