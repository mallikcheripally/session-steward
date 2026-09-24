import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Bot, CalendarDays, CheckCircle2, ChevronRight, Clock3, Pause, Pencil,
  Play, Plus, RefreshCw, SlidersHorizontal, Trash2, X,
} from "lucide-react";
import CleanupScope from "./cleanup-scope.jsx";

const DEFAULT_SCHEDULE = {
  archiveStatus: "all",
  cleanupMode: "thorough",
  enabled: true,
  inactiveDays: 90,
  includeInternals: false,
  includeSupporting: false,
  maxSessions: 25,
  minimumTranscriptBytes: null,
  name: "",
  provider: "codex",
  runEveryDays: 7,
  selectionOrder: "oldest",
  workspace: null,
};

const FIELDS = Object.keys(DEFAULT_SCHEDULE);

function definitionFrom(schedule) {
  return Object.fromEntries(FIELDS.map((field) => [field, schedule[field] ?? DEFAULT_SCHEDULE[field]]));
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Schedule request failed.");
  return body;
}

function dateLabel(value) {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Not yet";
}

function lastRunLabel(run) {
  if (!run) return "No runs yet";
  if (run.status === "completed") {
    const count = run.deletedSessionCount ?? 0;
    return `${count} ${count === 1 ? "session" : "sessions"} cleaned${run.cleanupFallback ? " · standard cleanup used" : ""}`;
  }
  if (run.status === "no-unprotected-matches") return "Only kept sessions matched";
  if (run.status === "no-matches") return "No matching sessions";
  return "Needs attention";
}

function nextRunLabel(schedule, scheduler) {
  if (!schedule.enabled) return "Paused";
  if (!scheduler?.running) return "Waiting for scheduler";
  return dateLabel(schedule.nextRunAtMs);
}

function rowTimingLabel(schedule, scheduler) {
  if (!schedule.enabled) return schedule.lastRun ? `Last ${dateLabel(schedule.lastRun.atMs)}` : "No runs yet";
  return scheduler?.running ? `Next ${dateLabel(schedule.nextRunAtMs)}` : "Waiting for scheduler";
}

export default function ScheduledCleanupPage({ onSessionsChanged, providerIcons, providers, token }) {
  const [schedules, setSchedules] = useState([]);
  const [scheduler, setScheduler] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const rowRefs = useRef([]);

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const result = await request("/api/automatic-cleanup");
      setSchedules(result.schedules);
      setSelectedId((current) => result.schedules.some((schedule) => schedule.id === current)
        ? current
        : null);
      setCursorIndex((current) => Math.min(current, Math.max(0, result.schedules.length - 1)));
      setScheduler(result.scheduler);
      setError("");
    } catch (issue) {
      setError(issue.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => refresh({ quiet: true }), 15_000);
    const onFocus = () => refresh({ quiet: true });
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const mutate = async (key, path, method, body, successMessage) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const result = await request(path, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "X-Session-Steward-Token": token },
        method,
      });
      await refresh({ quiet: true });
      setNotice(result.warning || successMessage);
      return result;
    } catch (issue) {
      setError(issue.message);
      await refresh({ quiet: true });
      return null;
    } finally {
      setBusy("");
    }
  };

  const save = async (definition, id) => {
    const result = await mutate(
      "save",
      id ? `/api/automatic-cleanup/schedules/${encodeURIComponent(id)}` : "/api/automatic-cleanup/schedules",
      id ? "PUT" : "POST",
      definition,
      id ? "Schedule updated." : "Schedule saved.",
    );
    if (result) {
      if (!id) setSelectedId(result.schedule.id);
      setEditing(null);
    }
  };

  const toggle = async (schedule) => {
    await mutate(
      schedule.id,
      `/api/automatic-cleanup/schedules/${encodeURIComponent(schedule.id)}`,
      "PUT",
      { ...definitionFrom(schedule), enabled: !schedule.enabled },
      schedule.enabled ? "Schedule paused." : "Schedule enabled.",
    );
  };

  const confirmAction = async () => {
    const action = confirmation;
    if (!action) return;
    setConfirmation(null);
    if (action.type === "stop") {
      await mutate("scheduler", "/api/automatic-cleanup/scheduler", "POST", { action: "stop" }, "Background scheduler stopped. Saved schedules remain available.");
      return;
    }
    if (action.type === "remove") {
      await mutate(action.schedule.id, `/api/automatic-cleanup/schedules/${encodeURIComponent(action.schedule.id)}`, "DELETE", undefined, "Schedule removed.");
      return;
    }
    const result = await mutate(action.schedule.id, `/api/automatic-cleanup/schedules/${encodeURIComponent(action.schedule.id)}/run`, "POST", {}, "Run finished.");
    if (result?.run) {
      setNotice(result.run.status === "failed"
        ? "The run needs attention. Check the last result below."
        : `Run finished: ${lastRunLabel(result.run)}.`);
      onSessionsChanged?.();
    }
  };

  const activeCount = schedules.filter((schedule) => schedule.enabled).length;
  const runningCount = schedules.filter((schedule) => schedule.runningSinceMs).length;
  const selected = schedules.find((schedule) => schedule.id === selectedId);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (editing || confirmation || busy || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target?.matches?.("input, select, textarea") || target?.isContentEditable) {
        if (event.key === "Escape") target.blur();
        return;
      }
      if (showShortcuts) {
        if (event.key === "Escape" || event.key === "?") {
          event.preventDefault();
          setShowShortcuts(false);
        }
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        setShowShortcuts(true);
        return;
      }
      if (event.key === "Escape") {
        setSelectedId(null);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") {
        if (!schedules.length) return;
        event.preventDefault();
        const direction = event.key === "ArrowDown" || event.key.toLowerCase() === "j" ? 1 : -1;
        const next = Math.min(schedules.length - 1, Math.max(0, cursorIndex + direction));
        setCursorIndex(next);
        rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
        return;
      }
      if ((event.key === "Enter" || event.key.toLowerCase() === "o") && schedules[cursorIndex]) {
        if (event.key === "Enter" && target?.closest?.("button, a")) return;
        event.preventDefault();
        setSelectedId(schedules[cursorIndex].id);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, confirmation, cursorIndex, editing, schedules, showShortcuts]);

  return <section aria-label="Automatic cleanup" className="schedule-page">
    {error && <div className="schedule-alert schedule-alert-error" role="alert"><AlertTriangle size={16}/><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")} type="button"><X size={14}/></button></div>}
    {notice && <div className="schedule-alert schedule-alert-success" role="status"><CheckCircle2 size={16}/><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice("")} type="button"><X size={14}/></button></div>}

    {scheduler?.supported === false && <p className="schedule-inline-warning">Background scheduling is unavailable on this system.</p>}
    <div aria-label="Schedule actions" className="schedule-toolbar">
      {(scheduler?.running || activeCount > 0) && <button className="button secondary" disabled={loading || Boolean(busy) || scheduler?.supported === false} onClick={() => scheduler?.running
          ? setConfirmation({ type: "stop" })
          : mutate("scheduler", "/api/automatic-cleanup/scheduler", "POST", { action: "start" }, "Background scheduler started.")}
      type="button">{scheduler?.running ? "Stop scheduler" : "Start scheduler"}</button>}
      <button aria-label="Refresh schedules" className="icon-button refresh-button" disabled={loading || Boolean(busy)} onClick={() => refresh()} title="Refresh schedules" type="button"><RefreshCw size={16}/></button>
      <button className="button secondary" disabled={Boolean(busy)} onClick={() => setEditing({ ...DEFAULT_SCHEDULE })} type="button"><Plus size={15}/> New schedule</button>
    </div>
    <div className={`schedule-layout ${!schedules.length ? "schedule-layout-empty" : ""}`}>
      <div className="surface schedule-collection">
        <div className="session-list-header">
          <div className="collection-heading"><h2 className="section-title">Schedules</h2><span className="shown-count">{loading ? "Loading…" : `${schedules.length} saved${schedules.length ? ` · ${activeCount} enabled` : ""}${runningCount ? ` · ${runningCount} running` : ""}${scheduler && (activeCount > 0 || scheduler.running) ? ` · Scheduler ${scheduler.running ? "running" : "stopped"}` : ""}`}</span></div>
          <p className="shortcut-hint">Press <kbd>?</kbd> for shortcuts</p>
        </div>
        {loading && !schedules.length ? <div className="schedule-list-empty">Loading schedules…</div>
          : !schedules.length ? <div className="schedule-list-empty">Create a schedule to run cleanup automatically. MCP schedules appear here too.</div>
            : <div className="session-rows">{schedules.map((schedule, index) => {
              const ProviderIcon = providerIcons[schedule.provider] || Bot;
              return <div className={`session-row schedule-row group ${cursorIndex === index ? "session-row-cursor" : ""} ${selectedId === schedule.id ? "session-row-inspected" : ""}`} key={schedule.id} ref={(node) => { rowRefs.current[index] = node; }}>
              <div className="session-primary">
                <button aria-expanded={selectedId === schedule.id} className="session-open text-left" onClick={() => { setCursorIndex(index); setSelectedId(schedule.id); }} type="button"><span className="session-title" title={schedule.name}>{schedule.name}</span></button>
                <div className="session-context"><span className="session-workspace"><ProviderIcon size={12}/><span className="truncate">{providers[schedule.provider]?.displayName || schedule.provider} · {schedule.inactiveDays}+ days inactive · every {schedule.runEveryDays} {schedule.runEveryDays === 1 ? "day" : "days"}</span></span></div>
              </div>
              <div className="session-row-meta"><span className="time-badge" title={rowTimingLabel(schedule, scheduler)}><Clock3 size={11}/>{rowTimingLabel(schedule, scheduler)}</span><span className="kind-label">{schedule.runningSinceMs ? "Running" : schedule.enabled ? "Enabled" : "Paused"}</span></div>
              <ChevronRight aria-hidden="true" className="session-row-chevron" size={16}/>
            </div>; })}</div>}
      </div>

      {schedules.length > 0 && <><button aria-label="Close schedule details" className={`inspector-backdrop ${selected ? "inspector-backdrop-open" : ""}`} onClick={() => setSelectedId(null)} type="button"/><aside aria-label="Schedule details" className={`surface inspector schedule-detail ${selected ? "inspector-open" : ""}`}>
        <div className="inspector-header"><span className="panel-label">Schedule details</span>{selected && <button aria-label="Close schedule details" className="icon-button" onClick={() => setSelectedId(null)} type="button"><X size={16}/></button>}</div>
        {selected ? <div className="inspector-content">
          <h2 className="inspector-title">{selected.name}</h2>
          <ul className="inspector-chips"><li className="inspector-chip">{providers[selected.provider]?.displayName || selected.provider}</li><li className="inspector-chip">{selected.runningSinceMs ? "Running now" : selected.enabled ? "Enabled" : "Paused"}</li></ul>
          <div className="schedule-detail-actions">
            <button className="button secondary" disabled={Boolean(busy) || Boolean(selected.runningSinceMs)} onClick={() => setConfirmation({ type: "run", schedule: selected })} type="button"><Play size={14}/> Run now</button>
            <button className="button ghost" disabled={Boolean(busy) || Boolean(selected.runningSinceMs)} onClick={() => toggle(selected)} type="button">{selected.enabled ? <Pause size={14}/> : <Play size={14}/>} {selected.enabled ? "Pause" : "Enable"}</button>
            <button className="button ghost" disabled={Boolean(busy) || Boolean(selected.runningSinceMs)} onClick={() => setEditing(selected)} type="button"><Pencil size={14}/> Edit</button>
          </div>
          <dl className="inspector-details schedule-details-grid">
            <div className="detail-row"><dt>Inactive for</dt><dd>{selected.inactiveDays}+ days</dd></div>
            <div className="detail-row"><dt>Runs every</dt><dd>{selected.runEveryDays} {selected.runEveryDays === 1 ? "day" : "days"}</dd></div>
            <div className="detail-row"><dt>Maximum per run</dt><dd>{selected.maxSessions} sessions</dd></div>
            <div className="detail-row"><dt>Cleanup mode</dt><dd>{selected.cleanupMode === "thorough" ? "Thorough" : "Standard"}</dd></div>
            <div className="detail-row"><dt>Next run</dt><dd>{nextRunLabel(selected, scheduler)}</dd></div>
            <div className="detail-row"><dt>Last run</dt><dd className={selected.lastRun?.status === "failed" ? "schedule-failed" : ""}>{lastRunLabel(selected.lastRun)}</dd>{selected.lastRun && <small>{dateLabel(selected.lastRun.atMs)}</small>}</div>
            {selected.workspace && <div className="detail-row detail-row-wide"><dt>Workspace</dt><dd>{selected.workspace}</dd></div>}
            {selected.archiveStatus !== "all" && <div className="detail-row"><dt>Sessions</dt><dd>{selected.archiveStatus === "archived" ? "Archived only" : "Active only"}</dd></div>}
            {selected.minimumTranscriptBytes && <div className="detail-row"><dt>Minimum transcript</dt><dd>{(selected.minimumTranscriptBytes / 1_048_576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB</dd></div>}
            {selected.selectionOrder !== "oldest" && <div className="detail-row"><dt>Order</dt><dd>Largest first</dd></div>}
            {selected.includeInternals && <div className="detail-row"><dt>Subagents</dt><dd>Included</dd></div>}
            {selected.includeSupporting && <div className="detail-row"><dt>Supporting sessions</dt><dd>Included</dd></div>}
          </dl>
          <div className="schedule-detail-foot"><p>Kept sessions are skipped. Each run creates a recovery backup.</p><button className="compact-action schedule-remove" disabled={Boolean(busy) || Boolean(selected.runningSinceMs)} onClick={() => setConfirmation({ type: "remove", schedule: selected })} type="button"><Trash2 size={13}/> Remove schedule</button></div>
        </div> : <div className="inspector-empty"><div><div className="inspector-empty-icon"><CalendarDays size={18}/></div><h2>Select a schedule</h2><p>Its timing, cleanup settings, and last run will appear here.</p></div></div>}
      </aside></>}
    </div>

    {editing && <ScheduleEditor key={editing.id || "new"} initial={editing} onClose={() => setEditing(null)} onSave={save} providers={providers} saving={busy === "save"}/>}
    {confirmation && <ConfirmAction action={confirmation} onClose={() => setConfirmation(null)} onConfirm={confirmAction}/>}
    {showShortcuts && <ScheduleShortcuts onClose={() => setShowShortcuts(false)}/>}
  </section>;
}

function ScheduleShortcuts({ onClose }) {
  const closeRef = useRef(null);
  const groups = [
    { label: "Navigate", shortcuts: [
      { action: "Next schedule", keys: "J / ↓" },
      { action: "Previous schedule", keys: "K / ↑" },
      { action: "Open schedule details", keys: "Enter / O" },
    ] },
    { label: "View", shortcuts: [
      { action: "Close details", keys: "Escape" },
      { action: "Show or hide shortcuts", keys: "?" },
    ] },
  ];
  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section aria-describedby="schedule-shortcut-description" aria-labelledby="schedule-shortcut-title" aria-modal="true" className="shortcut-panel" role="dialog"><div className="flex items-start justify-between gap-4"><div><p className="panel-label">Keyboard control</p><h2 className="dialog-title" id="schedule-shortcut-title">Keyboard shortcuts</h2><p className="dialog-copy" id="schedule-shortcut-description">Move through schedules and open their details.</p></div><button aria-label="Close keyboard shortcuts" className="icon-button" onClick={onClose} ref={closeRef} type="button"><X size={17}/></button></div><div className="shortcut-groups">{groups.map((group) => <section key={group.label}><h3>{group.label}</h3><dl>{group.shortcuts.map((shortcut) => <div key={shortcut.action}><dt>{shortcut.action}</dt><dd><kbd>{shortcut.keys}</kbd></dd></div>)}</dl></section>)}</div></section></div>;
}

function ScheduleEditor({ initial, onClose, onSave, providers, saving }) {
  const [values, setValues] = useState(() => ({ ...DEFAULT_SCHEDULE, ...definitionFrom(initial) }));
  const [advanced, setAdvanced] = useState(Boolean(initial.id && (initial.workspace || initial.minimumTranscriptBytes || initial.includeInternals || initial.includeSupporting || initial.archiveStatus !== "all" || initial.selectionOrder !== "oldest")));
  const [minimumMb, setMinimumMb] = useState(initial.minimumTranscriptBytes ? String(initial.minimumTranscriptBytes / 1_048_576) : "");
  const [minimumEdited, setMinimumEdited] = useState(false);
  const set = (name, value) => setValues((current) => ({ ...current, [name]: value }));

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const submit = (event) => {
    event.preventDefault();
    onSave({
      ...values,
      enabled: initial.id ? values.enabled : true,
      name: values.name.trim(),
      inactiveDays: Number(values.inactiveDays),
      runEveryDays: Number(values.runEveryDays),
      maxSessions: Number(values.maxSessions),
      minimumTranscriptBytes: minimumEdited
        ? minimumMb ? Math.round(Number(minimumMb) * 1_048_576) : null
        : initial.minimumTranscriptBytes ?? null,
      workspace: values.workspace?.trim() || null,
      includeInternals: values.provider === "codex" && values.includeInternals,
      includeSupporting: values.provider === "codex" && values.includeSupporting,
    }, initial.id);
  };

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <form aria-labelledby="schedule-form-title" aria-modal="true" className="schedule-dialog dialog-panel" onSubmit={submit} role="dialog">
      <div className="schedule-dialog-head"><div><div className="cleanup-eyebrow"><CalendarDays size={13}/> Automatic cleanup</div><h2 className="dialog-title" id="schedule-form-title">{initial.id ? "Edit schedule" : "New schedule"}</h2></div><button aria-label="Close schedule form" className="icon-button" disabled={saving} onClick={onClose} type="button"><X size={17}/></button></div>
      <p className="dialog-copy">Kept sessions are skipped. Each run creates a recovery backup.</p>
      <div className="schedule-form-grid">
        <label className="field schedule-field-wide"><span>Schedule name</span><input autoFocus maxLength={100} onChange={(event) => set("name", event.target.value)} placeholder="Old sessions" required value={values.name}/></label>
        <label className="field"><span>Provider</span><select onChange={(event) => set("provider", event.target.value)} value={values.provider}>{Object.entries(providers).map(([id, provider]) => <option key={id} value={id}>{provider.displayName}</option>)}</select></label>
        <label className="field"><span>Inactive for at least</span><div className="schedule-number-field"><input max={3650} min={1} onChange={(event) => set("inactiveDays", event.target.value)} required type="number" value={values.inactiveDays}/><span>days</span></div></label>
        <label className="field"><span>Run every</span><div className="schedule-number-field"><input max={3650} min={1} onChange={(event) => set("runEveryDays", event.target.value)} required type="number" value={values.runEveryDays}/><span>days</span></div></label>
        <label className="field"><span>Maximum per run</span><div className="schedule-number-field"><input max={100} min={1} onChange={(event) => set("maxSessions", event.target.value)} required type="number" value={values.maxSessions}/><span>sessions</span></div></label>
      </div>
      <div aria-label="Cleanup mode" className="schedule-mode" role="group"><p className="panel-label">Cleanup mode</p><div className="schedule-mode-options"><CleanupScope checked={values.cleanupMode === "standard"} onClick={() => set("cleanupMode", "standard")} text={values.provider === "claude-code" ? "Removes the selected local sessions, transcripts, history, and linked session artifacts." : "Removes the sessions, transcripts, history, logs, and linked subagents."} title="Standard cleanup"/><CleanupScope checked={values.cleanupMode === "thorough"} onClick={() => set("cleanupMode", "thorough")} text={values.provider === "claude-code" ? "Also removes recognized file checkpoints owned by these sessions. Worktrees are always kept." : "Also removes supported Desktop references, saved memory, and goals."} title="Thorough cleanup"/></div></div>
      <button aria-expanded={advanced} className="more-filters-button schedule-advanced-toggle" onClick={() => setAdvanced((current) => !current)} type="button"><SlidersHorizontal size={15}/>{advanced ? "Hide filters" : "More filters"}</button>
      {advanced && <div className="schedule-form-grid schedule-advanced-fields">
        <label className="field schedule-field-wide"><span>Workspace folder <em>optional</em></span><input onChange={(event) => set("workspace", event.target.value)} placeholder="All workspaces" value={values.workspace || ""}/></label>
        <label className="field"><span>Session status</span><select onChange={(event) => set("archiveStatus", event.target.value)} value={values.archiveStatus}><option value="all">All sessions</option><option value="active">Active only</option><option value="archived">Archived only</option></select></label>
        <label className="field"><span>Pick sessions by</span><select onChange={(event) => set("selectionOrder", event.target.value)} value={values.selectionOrder}><option value="oldest">Oldest first</option><option value="largest">Largest first</option></select></label>
        <label className="field schedule-field-wide"><span>Minimum transcript size <em>optional</em></span><div className="schedule-number-field"><input min="0.001" onChange={(event) => { setMinimumMb(event.target.value); setMinimumEdited(true); }} step="any" type="number" value={minimumMb}/><span>MB</span></div></label>
        {values.provider === "codex" && <div className="schedule-extra-toggles schedule-field-wide"><ScheduleToggle checked={values.includeInternals} onChange={(value) => set("includeInternals", value)}>Include subagent sessions</ScheduleToggle><ScheduleToggle checked={values.includeSupporting} onChange={(value) => set("includeSupporting", value)}>Include supporting sessions</ScheduleToggle></div>}
      </div>}
      <div className="schedule-dialog-actions"><button className="button ghost" disabled={saving} onClick={onClose} type="button">Cancel</button><button className="button primary" disabled={saving} type="submit">{saving ? "Saving…" : initial.id ? "Save changes" : "Create schedule"}</button></div>
    </form>
  </div>;
}

function ScheduleToggle({ checked, children, onChange }) {
  return <label className={`toggle ${checked ? "toggle-active" : ""}`}><input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox"/><span className="toggle-track"><span/></span><span className="toggle-copy">{children}</span></label>;
}

function ConfirmAction({ action, onClose, onConfirm }) {
  const isRun = action.type === "run";
  const isRemove = action.type === "remove";
  const title = isRun ? `Run ${action.schedule.name} now?` : isRemove ? `Remove ${action.schedule.name}?` : "Stop the background scheduler?";
  const copy = isRun
    ? `Session Steward will check current matches and clean up to ${action.schedule.maxSessions} sessions. Kept sessions are skipped, and a recovery backup is created.`
    : isRemove
      ? "This removes the saved rule. Previous cleanup runs and their recovery backups are not changed."
      : "Automatic runs for every enabled schedule will stop. Your schedules stay saved, and you can still run one manually.";
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div aria-labelledby="schedule-confirm-title" aria-modal="true" className="schedule-confirm dialog-panel" role="dialog"><div className="schedule-dialog-head"><h2 className="dialog-title" id="schedule-confirm-title">{title}</h2><button aria-label="Close confirmation" className="compact-action" onClick={onClose} type="button"><X size={18}/></button></div><p className="dialog-copy">{copy}</p><div className="schedule-dialog-actions"><button className="button ghost" onClick={onClose} type="button">Cancel</button><button className={isRemove ? "button danger" : "button primary"} onClick={onConfirm} type="button">{isRun ? "Run now" : isRemove ? "Remove schedule" : "Stop scheduler"}</button></div></div></div>;
}
