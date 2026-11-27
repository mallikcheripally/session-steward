import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Archive, ArrowRight, CheckCircle2, ChevronRight, Clock3, FolderKanban, FolderSearch, HardDrive, RefreshCw, Search, Trash2, X } from "lucide-react";
import Pagination from "./pagination.jsx";

const EMPTY = { records: [], total: 0, pages: 1, allCount: 0, allBytes: 0 };
const canDelete = row => ["available", "cleanup-incomplete"].includes(row.availability);
const projectName = workspace => workspace.split(/[\\/]/u).filter(Boolean).at(-1) || workspace;
const sourceName = row => row.providerId === "codex" ? "Codex" : "Claude";
const targetName = row => row.target === "claude" ? "Claude" : "Codex";
const date = value => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const status = row => ({ missing: "Files unavailable", changed: "Folder changed", "cleanup-incomplete": "Cleanup interrupted" }[row.availability]);

export default function HandoffFiles({ api, token, formatSize, formatAge, scopeQuery = "", onClearScope }) {
  const scopeParams = new URLSearchParams(scopeQuery);
  const scopeProvider = scopeParams.get("providerId");
  const scopeSession = scopeParams.get("sessionId");
  const scoped = scopeProvider !== null || scopeSession !== null;
  const [data, setData] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [olderDays, setOlderDays] = useState("0");
  const [sort, setSort] = useState("recent");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(new Map());
  const [inspected, setInspected] = useState(null);
  const [dialogMode, setDialogMode] = useState(null);
  const [project, setProject] = useState("");
  const [importOffset, setImportOffset] = useState(0);
  const dialog = useRef(null);
  const selectPage = useRef(null);
  const projectInput = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ page, pageSize: 25, search, olderDays, sort });
      if (scoped) { query.set("providerId", scopeProvider ?? ""); query.set("sessionId", scopeSession ?? ""); }
      api(`/api/handoffs?${query}`, { signal: controller.signal }).then(result => {
        if (!controller.signal.aborted) {
          if (scoped && (result.scope?.providerId !== scopeProvider || result.scope?.sessionId !== scopeSession)) throw new Error("Restart Session Steward and refresh to view handoffs for this session.");
          setData(result); setPage(result.page);
          setInspected(current => current ? result.records.find(row => row.id === current.id) ?? current : null);
        }
      }).catch(issue => { if (issue.name !== "AbortError") setError(issue.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, page, search, olderDays, sort, revision, scoped, scopeProvider, scopeSession]);

  useEffect(() => { setSelected(new Map()); }, [search, olderDays, sort]);
  useEffect(() => {
    if (dialogMode && !dialog.current.open) {
      dialog.current.showModal();
      if (dialogMode === "import") projectInput.current?.focus();
    }
    if (!dialogMode && dialog.current.open) dialog.current.close();
  }, [dialogMode]);
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === "Escape" && !dialogMode) setInspected(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialogMode]);

  const selectable = data.records.filter(canDelete);
  const allPageSelected = selectable.length > 0 && selectable.every(row => selected.has(row.id));
  const somePageSelected = selectable.some(row => selected.has(row.id));
  const selectedBytes = [...selected.values()].reduce((sum, row) => sum + row.byteCount, 0);
  const filterActive = Boolean(scoped || search || olderDays !== "0");
  const startPage = Math.max(1, Math.min(page - 2, data.pages - 4));
  const numbers = Array.from({ length: Math.min(5, data.pages) }, (_, index) => startPage + index);

  useEffect(() => {
    if (selectPage.current) selectPage.current.indeterminate = somePageSelected && !allPageSelected;
  }, [somePageSelected, allPageSelected]);

  function toggle(row) {
    if (!selected.has(row.id) && selected.size >= 100) { setError("Select up to 100 handoffs per cleanup."); return; }
    setSelected(current => {
      const next = new Map(current);
      if (next.has(row.id)) next.delete(row.id); else next.set(row.id, row);
      return next;
    });
  }
  function togglePage() {
    setSelected(current => {
      const next = new Map(current);
      for (const row of selectable) {
        if (allPageSelected) next.delete(row.id);
        else if (next.size < 100) next.set(row.id, row);
      }
      return next;
    });
  }
  function clearFilters(event) { setSearch(""); setOlderDays("0"); setPage(1); if (scoped) onClearScope(event); }
  async function mutate(route, body) {
    return api(route, { method: "POST", headers: { "X-Session-Steward-Token": token }, body: JSON.stringify(body) });
  }
  async function remove() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await mutate("/api/handoffs/delete", { ids: [...selected.keys()] });
      const removed = new Set([...result.deletedIds, ...result.failures.filter(issue => issue.code === "NOT_LISTED").map(issue => issue.id)]);
      setSelected(current => new Map([...current].filter(([id]) => !removed.has(id))));
      setInspected(current => removed.has(current?.id) ? null : current);
      if (result.deletedIds.length) setNotice(`Deleted ${result.deletedIds.length} ${result.deletedIds.length === 1 ? "handoff" : "handoffs"} · ${formatSize(result.freedBytes)} freed.`);
      if (result.failures.length) setError(result.failures.slice(0, 3).map(item => item.message).join(" "));
      setRevision(value => value + 1);
    } catch (issue) { setError(issue.message); }
    finally { setBusy(false); setDialogMode(null); }
  }
  async function forget(row) {
    setBusy(true); setError("");
    try {
      await mutate(`/api/handoffs/${row.id}/forget`, {});
      setNotice("Removed listing. No files deleted."); setInspected(null);
      setSelected(current => new Map([...current].filter(([id]) => id !== row.id)));
      setRevision(value => value + 1);
    } catch (issue) { setError(issue.message); }
    finally { setBusy(false); }
  }
  async function findExisting(event) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await mutate("/api/handoffs/import", { workspace: project.trim(), offset: importOffset });
      setImportOffset(result.nextOffset ?? 0);
      setNotice(`Found ${result.imported} ${result.imported === 1 ? "handoff" : "handoffs"}.${result.skipped ? ` ${result.skipped} unrecognized folders skipped.` : ""}`);
      if (result.nextOffset === null) setDialogMode(null);
      setRevision(value => value + 1);
    } catch (issue) { setError(issue.message); }
    finally { setBusy(false); }
  }

  return <section className={`handoff-files ${selected.size ? "has-selection-tray" : ""}`} aria-label="Handoffs">
    {error && !dialogMode && <div className="schedule-alert schedule-alert-error" role="alert"><AlertTriangle size={16}/><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")} type="button"><X size={14}/></button></div>}
    {notice && !dialogMode && <div className="schedule-alert schedule-alert-success" role="status"><CheckCircle2 size={16}/><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice("")} type="button"><X size={14}/></button></div>}
    <div className="schedule-toolbar" aria-label="Handoff actions">
      <button aria-label="Refresh handoffs" className="icon-button refresh-button" disabled={busy || loading} onClick={() => setRevision(value => value + 1)} title="Refresh handoffs" type="button"><RefreshCw size={16} className={loading ? "animate-spin" : undefined}/></button>
      <button className="button secondary" disabled={busy} onClick={() => { setError(""); setNotice(""); setDialogMode("import"); }} type="button"><FolderSearch size={15}/>Find handoffs</button>
    </div>
    <div className={`handoff-layout ${!data.allCount ? "handoff-layout-empty" : ""}`}>
      <div className="surface handoff-collection">
        <div className="session-list-header">
          <div className="collection-heading"><h2 className="section-title">Handoffs</h2><span className="shown-count" aria-live="polite">{loading && !data.allCount ? "Loading…" : `${data.total.toLocaleString()} ${filterActive ? "shown" : data.total === 1 ? "handoff" : "handoffs"} · ${formatSize(filterActive ? data.totalBytes ?? 0 : data.allBytes)}`}</span></div>
          <label className="sort-control"><span>Sort</span><select aria-label="Sort handoffs" onChange={event => { setSort(event.target.value); setPage(1); }} value={sort}><option value="recent">Newest first</option><option value="size">Largest first</option></select></label>
        </div>
        {scoped && <div className="active-filter-row handoff-session-scope"><div className="active-filter-chips"><button className="filter-chip" aria-label="Show handoffs from all sessions" onClick={onClearScope} title={data.scope?.title || undefined} type="button"><span>Session: {data.scope?.title || (scopeProvider === "claude-code" ? "Claude session" : "Codex session")}</span><X size={12}/></button></div></div>}
        <div className="session-filters handoff-filters"><div className="filter-bar">
          <label className="field filter-search"><span><Search size={13}/>Search handoffs</span><div className="input-wrap"><Search size={16}/><input aria-label="Search handoffs" onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Name or project" value={search}/>{search && <button aria-label="Clear search" onClick={() => { setSearch(""); setPage(1); }} type="button"><X size={14}/></button>}</div></label>
          <label className="field"><span><Clock3 size={13}/>Last handed off</span><select aria-label="Handoff age" onChange={event => { setOlderDays(event.target.value); setPage(1); }} value={olderDays}><option value="0">Any time</option><option value="30">30+ days ago</option><option value="60">60+ days ago</option><option value="90">90+ days ago</option></select></label>
        </div></div>
        <div className="page-selection-row"><label className="selection-control"><input aria-label="Select handoffs on this page" aria-checked={somePageSelected && !allPageSelected ? "mixed" : allPageSelected} checked={allPageSelected} disabled={!selectable.length || busy || loading} onChange={togglePage} ref={selectPage} type="checkbox"/><span>Select this page</span></label>{(search || olderDays !== "0") && data.records.length > 0 && <button className="clear-all-filters" onClick={clearFilters} type="button">Clear filters</button>}</div>
        <div className="handoff-rows" aria-busy={loading}>
          {loading ? <div className="session-rows" aria-label="Loading handoffs">{Array.from({ length: 5 }, (_, index) => <div className="session-row session-row-skeleton" key={index}><span className="skeleton h-4 w-4 rounded"/><div><div className="skeleton h-3.5 w-3/4 rounded"/><div className="skeleton mt-2 h-3 w-1/3 rounded"/></div><span className="skeleton badge-skeleton"/></div>)}</div>
            : data.records.length ? <div className="session-rows">{data.records.map(row => <div className={`session-row handoff-row ${selected.has(row.id) ? "session-row-selected" : ""} ${inspected?.id === row.id ? "session-row-inspected" : ""}`} key={row.id}>
              <label className="session-checkbox"><input aria-label={`Select handoff ${row.title}`} checked={selected.has(row.id)} disabled={busy || !canDelete(row)} onChange={() => toggle(row)} type="checkbox"/></label>
              <div className="session-primary"><button aria-expanded={inspected?.id === row.id} className="session-open text-left" onClick={() => setInspected(row)} type="button"><span className="session-title" title={row.title}>{row.title}</span></button><div className="session-context"><span className="session-workspace" title={row.workspace}><FolderKanban size={12}/><span className="truncate">{projectName(row.workspace)}</span></span><span className="handoff-route" aria-label={`${sourceName(row)} to ${targetName(row)}`}><span aria-hidden="true">·</span>{sourceName(row)}<ArrowRight size={11}/>{targetName(row)}</span>{status(row) ? <span className="archive-tag handoff-status">{status(row)}</span> : row.partial && <span className="archive-tag">Partial</span>}</div></div>
              <div className="session-row-meta"><span className="size-badge" title="Archive size"><HardDrive size={11}/>{formatSize(row.byteCount)}</span><span className="time-badge" title={`Last handed off ${date(row.lastHandoffAtMs)}`}><Clock3 size={11}/>{formatAge(row.lastHandoffAtMs)}</span></div><button aria-label={`View handoff ${row.title}`} className="icon-button handoff-row-open" onClick={() => setInspected(row)} type="button"><ChevronRight size={16}/></button>
            </div>)}</div>
              : <div className="empty-state"><div><div className="empty-state-icon"><Archive size={19}/></div><h3>{filterActive ? "No matching handoffs" : "No handoffs yet"}</h3><p>{filterActive ? "Try another name or clear your filters." : "Continue a session in another app to create one."}</p>{filterActive && <button className="button secondary mt-4" onClick={clearFilters} type="button">Clear filters</button>}</div></div>}
        </div>
        <Pagination disabled={loading || busy} numbers={numbers} page={page} pages={data.pages} setPage={setPage}/>
      </div>
      {data.allCount > 0 && <><button aria-label="Close handoff details" className={`inspector-backdrop ${inspected ? "inspector-backdrop-open" : ""}`} onClick={() => setInspected(null)} type="button"/><aside className={`surface inspector handoff-detail ${inspected ? "inspector-open" : ""}`} aria-label="Handoff details"><div className="inspector-header"><span className="panel-label">Handoff details</span>{inspected && <button aria-label="Close handoff details" className="icon-button" onClick={() => setInspected(null)} type="button"><X size={16}/></button>}</div>
        {inspected ? <div className="inspector-content"><h2 className="inspector-title" title={inspected.title}>{inspected.title}</h2><ul className="inspector-chips"><li className="inspector-chip">{sourceName(inspected)} → {targetName(inspected)}</li>{inspected.partial && <li className="inspector-chip">Partial context</li>}</ul><dl className="inspector-details"><Detail label="Size" value={formatSize(inspected.byteCount)}/><Detail label="Last handed off" value={date(inspected.lastHandoffAtMs)}/><Detail label="Created" value={date(inspected.createdAtMs)}/><Detail label="Project" value={projectName(inspected.workspace)}/></dl><details className="handoff-location"><summary>File locations</summary><dl><Detail label="Project" value={inspected.workspace}/><Detail label="Archive" value={inspected.directory}/></dl></details>{status(inspected) && <div className="handoff-detail-status"><p>{inspected.availability === "missing" ? "The project or archive is unavailable." : inspected.availability === "changed" ? "The folder has changed. Check its location before cleanup." : "Cleanup was interrupted. Select this handoff to retry."}</p>{inspected.availability === "missing" && <button className="compact-action" disabled={busy} onClick={() => forget(inspected)} type="button">Remove listing</button>}</div>}</div>
          : <div className="inspector-empty"><div><div className="inspector-empty-icon"><Archive size={18}/></div><h2>Select a handoff</h2><p>View its details and file location.</p></div></div>}
      </aside></>}
    </div>
    {selected.size > 0 && <section className="selection-tray" aria-label="Selected handoffs"><div className="selection-tray-bar"><p className="selection-tray-summary" aria-live="polite">{selected.size} {selected.size === 1 ? "handoff" : "handoffs"} selected · {formatSize(selectedBytes)}</p><div className="selection-tray-actions"><button className="button ghost" disabled={busy} onClick={() => setSelected(new Map())} type="button">Clear</button><button className="button danger" disabled={busy || loading} onClick={() => setDialogMode("delete")} type="button"><Trash2 size={15}/>Delete {selected.size}</button></div></div></section>}
    <dialog aria-label={dialogMode === "import" ? "Find handoffs" : "Delete handoff files"} className="dialog-panel handoff-dialog" onCancel={event => { event.preventDefault(); if (!busy) setDialogMode(null); }} ref={dialog}>
      {dialogMode === "import" ? <form onSubmit={findExisting}><div className="schedule-dialog-head"><h2 className="dialog-title">Find handoffs</h2><button aria-label="Close find handoffs" className="icon-button" disabled={busy} onClick={() => setDialogMode(null)} type="button"><X size={17}/></button></div><p className="dialog-copy">Find existing handoff files in a project folder.</p><label className="field handoff-import-field"><span>Project folder</span><input aria-label="Find handoffs in project folder" autoFocus onChange={event => { setProject(event.target.value); setImportOffset(0); }} placeholder="Absolute project path" ref={projectInput} required value={project}/></label>{error && <p className="handoff-dialog-error" role="alert">{error}</p>}{importOffset > 0 && <p className="dialog-copy">More folders remain. Continue to finish scanning.</p>}<div className="schedule-dialog-actions"><button className="button ghost" disabled={busy} onClick={() => setDialogMode(null)} type="button">Cancel</button><button className="button primary" disabled={busy || !project.trim()} type="submit">{busy ? "Finding…" : importOffset ? "Continue scan" : "Find handoffs"}</button></div></form>
        : <><h2 className="dialog-title">Delete {selected.size} {selected.size === 1 ? "handoff" : "handoffs"}?</h2><p className="dialog-copy">Permanently removes {formatSize(selectedBytes)}. Chats and code stay intact. Conversations using these files will lose access to them.</p><div className="schedule-dialog-actions"><button autoFocus className="button ghost" disabled={busy} onClick={() => setDialogMode(null)} type="button">Cancel</button><button className="button danger" disabled={busy} onClick={remove} type="button">{busy ? "Deleting…" : "Delete handoff files"}</button></div></>}
    </dialog>
  </section>;
}

function Detail({ label, value, wide }) {
  return <div className={`detail-row ${wide ? "detail-row-wide" : ""}`}><dt>{label}</dt><dd>{value}</dd></div>;
}
