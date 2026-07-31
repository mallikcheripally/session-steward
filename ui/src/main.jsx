import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";

const PAGE_SIZE = 25;
const MAX_PAGE_LINKS = 7;

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
};

const age = (timestamp) => {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  return minutes < 60
    ? `${minutes}m ago`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)}h ago`
      : `${Math.floor(minutes / 1440)}d ago`;
};

const isSupportingRecord = (record) => record.displayName
  .startsWith("The following is the Codex agent history whose request action you are assessing");

function getPageNumbers(currentPage, pageCount) {
  const start = Math.max(1, Math.min(currentPage - Math.floor(MAX_PAGE_LINKS / 2), pageCount - MAX_PAGE_LINKS + 1));
  const end = Math.min(pageCount, start + MAX_PAGE_LINKS - 1);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function App() {
  const [records, setRecords] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [inspected, setInspected] = useState(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updated");
  const [internals, setInternals] = useState(false);
  const [supporting, setSupporting] = useState(false);
  const [page, setPage] = useState(1);
  const [token, setToken] = useState("");
  const [dialog, setDialog] = useState(false);
  const [scope, setScope] = useState("deep");
  const [plan, setPlan] = useState(null);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState("");
  const [compatibility, setCompatibility] = useState(null);
  const [showCompatibilityDetails, setShowCompatibilityDetails] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const compatibilityRef = useRef(null);

  const load = async ({ showRefreshNotice = false } = {}) => {
    try {
      if (showRefreshNotice) setIsRefreshing(true);
      const params = new URLSearchParams({ search, sort, includeInternals: String(internals) });
      const [result, diagnostic] = await Promise.all([
        api(`/api/sessions?${params}`),
        api("/api/compatibility"),
      ]);
      setRecords(result.records);
      setCompatibility(diagnostic);
      setSelected((current) => new Set([...current].filter((id) => result.records.some((record) => record.id === id))));
      setPage(1);
      if (showRefreshNotice) setNotice({ kind: "success", text: "Session list refreshed." });
    } catch (issue) {
      setError(issue.message);
    } finally {
      if (showRefreshNotice) setIsRefreshing(false);
    }
  };

  useEffect(() => {
    api("/api/config").then(({ mutationToken }) => setToken(mutationToken)).catch((issue) => setError(issue.message));
    api("/api/compatibility").then(setCompatibility).catch((issue) => setError(issue.message));
  }, []);
  useEffect(() => {
    const timer = setTimeout(load, 120);
    return () => clearTimeout(timer);
  }, [search, sort, internals]);
  useEffect(() => {
    if (!showCompatibilityDetails) return undefined;
    const dismiss = (event) => {
      if (event.type === "keydown" && event.key === "Escape") setShowCompatibilityDetails(false);
      if (event.type === "mousedown" && !compatibilityRef.current?.contains(event.target)) setShowCompatibilityDetails(false);
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [showCompatibilityDetails]);

  const filteredRecords = useMemo(
    () => supporting ? records : records.filter((record) => !isSupportingRecord(record)),
    [records, supporting],
  );
  const pages = Math.max(1, Math.ceil(filteredRecords.length / PAGE_SIZE));
  const visible = useMemo(
    () => filteredRecords.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filteredRecords, page],
  );
  const pageNumbers = useMemo(() => getPageNumbers(page, pages), [page, pages]);
  const allMatchingSelected = filteredRecords.length > 0 && filteredRecords.every((record) => selected.has(record.id));

  const inspect = async (id) => {
    try {
      setInspected((await api(`/api/sessions/${encodeURIComponent(id)}`)).record);
    } catch (issue) {
      setError(issue.message);
    }
  };

  const makePlan = async (nextScope = scope) => {
    try {
      const result = await api("/api/deletion-plans", {
        method: "POST",
        body: JSON.stringify({ ids: [...selected], scope: nextScope }),
      });
      setPlan(result.plan);
      setScope(nextScope);
      setError("");
    } catch (issue) {
      setError(issue.message);
    }
  };

  const openDeleteDialog = async () => {
    await makePlan();
    setDialog(true);
  };

  const remove = async () => {
    try {
      setIsDeleting(true);
      const payload = await api("/api/deletions", {
        method: "POST",
        headers: { "X-Session-Steward-Token": token },
        body: JSON.stringify({ ids: [...selected], scope }),
      });
      setDialog(false);
      setSelected(new Set());
      setInspected(null);
      setNotice(payload.verification.complete
        ? { kind: "success", text: "Cleanup completed and selected artifacts were deleted." }
        : { kind: "warning", text: "Cleanup ran, but verification found remaining artifacts. The operation backup was retained." });
      await load();
    } catch (issue) {
      setError(issue.message);
    } finally {
      setIsDeleting(false);
    }
  };

  const toggle = (id) => setSelected((current) => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleAllMatching = () => setSelected((current) => {
    const next = new Set(current);
    if (allMatchingSelected) {
      filteredRecords.forEach((record) => next.delete(record.id));
    } else {
      filteredRecords.forEach((record) => next.add(record.id));
    }
    return next;
  });

  return <main className="min-h-screen bg-[#09090b] text-zinc-100"><div className="mx-auto max-w-7xl px-5 py-8 lg:px-8">
    <header className="mb-8 flex flex-col justify-between gap-5 border-b border-white/10 pb-7 sm:flex-row sm:items-end">
      <div><div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[.18em] text-emerald-400"><Sparkles size={14}/> LOCAL SESSION CLEANUP</div><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Session Steward</h1><p className="mt-2 max-w-2xl text-sm text-zinc-400">Review local Codex sessions before you remove them.</p></div>
      <div className="flex items-center gap-2"><CompatibilityControl compatibilityRef={compatibilityRef} compatibility={compatibility} expanded={showCompatibilityDetails} onToggle={() => setShowCompatibilityDetails((current) => !current)} onClose={() => setShowCompatibilityDetails(false)}/><button disabled={isRefreshing} onClick={() => load({ showRefreshNotice: true })} className="button secondary"><RefreshCw size={16} className={isRefreshing ? "animate-spin" : undefined}/> {isRefreshing ? "Refreshing" : "Refresh"}</button></div>
    </header>
    {notice && <div className={`mb-5 flex items-center gap-3 rounded-xl border p-4 text-sm ${notice.kind === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-amber-500/30 bg-amber-500/10 text-amber-100"}`}><Check size={18}/>{notice.text}</div>}
    {error && <div className="mb-5 flex items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100"><AlertTriangle size={18}/>{error}</div>}
    <section className="mb-5 grid gap-3 rounded-2xl border border-white/10 bg-zinc-900/70 p-4 sm:grid-cols-[1fr_180px_auto]">
      <label className="field"><span><Search size={14}/> Search</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, workspace, or session ID"/></label>
      <label className="field"><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="updated">Last activity</option><option value="created">Created</option><option value="name">Name</option><option value="cwd">Workspace</option></select></label>
      <div className="mt-6 flex flex-col gap-2 text-sm text-zinc-300"><label className="flex cursor-pointer items-center gap-2"><input checked={internals} onChange={(event) => setInternals(event.target.checked)} type="checkbox" className="size-4 accent-emerald-500"/> Show subagents</label><label className="flex cursor-pointer items-center gap-2"><input checked={supporting} onChange={(event) => setSupporting(event.target.checked)} type="checkbox" className="size-4 accent-emerald-500"/> Include supporting threads</label></div>
    </section>
    <section className="grid gap-5 lg:grid-cols-[minmax(0,1.8fr)_360px]"><div className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/70">
      <div className="flex items-center justify-between border-b border-white/10 p-4"><p className="font-semibold">{filteredRecords.length} sessions <span className="font-normal text-zinc-500">· {selected.size} selected</span></p><button disabled={!selected.size} onClick={openDeleteDialog} className="button danger"><Trash2 size={16}/> Delete</button></div>
      <Pagination page={page} pages={pages} numbers={pageNumbers} setPage={setPage}/>
      <div className="flex items-center border-b border-white/5 px-4 py-3"><label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-zinc-200"><input checked={allMatchingSelected} onChange={toggleAllMatching} disabled={!filteredRecords.length} type="checkbox" className="size-4 accent-emerald-500"/>{allMatchingSelected ? "Unselect all" : "Select all"}<span className="font-normal text-zinc-500">matching sessions</span></label></div>
      <div className="divide-y divide-white/5">{visible.map((record) => <label key={record.id} className={`group grid cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto] gap-2 p-4 transition hover:bg-white/[.035] ${inspected?.id === record.id ? "bg-emerald-500/[.06]" : ""}`}><input checked={selected.has(record.id)} onChange={() => toggle(record.id)} type="checkbox" className="mt-1 size-4 accent-emerald-500"/><button onClick={(event) => { event.preventDefault(); toggle(record.id); inspect(record.id); }} className="relative -top-0.5 min-w-0 text-left"><p className="truncate font-medium text-zinc-100">{record.displayName}</p><p className="mt-1 truncate text-xs text-zinc-500"><FolderKanban className="mr-1 inline size-3"/>{record.cwd || "No workspace"}</p></button><div className="flex flex-col items-end gap-2"><span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[11px] font-medium text-emerald-200">{age(record.updatedAtMs)}</span><span className="text-[11px] text-zinc-500">{record.isSubagent ? "Subagent" : record.isPinned ? "Pinned" : record.archived ? "Archived" : "Session"}</span></div></label>)}{!visible.length && <p className="p-8 text-center text-sm text-zinc-500">No sessions match this view.</p>}</div>
      <Pagination page={page} pages={pages} numbers={pageNumbers} setPage={setPage}/>
    </div>
    <aside className="rounded-2xl border border-white/10 bg-zinc-900/70 p-5"><p className="mb-3 text-xs font-semibold tracking-[.16em] text-emerald-400">INSPECT</p>{inspected ? <><h2 className="break-words text-lg font-semibold">{inspected.displayName}</h2><dl className="mt-5 space-y-4 text-sm"><Detail label="Workspace" value={inspected.cwd || "Not recorded"}/><Detail label="Transcript" value={inspected.rolloutMissing ? "Missing" : "Available"}/><Detail label="Relationship" value={inspected.isSubagent ? "Subagent" : inspected.isFork ? "Fork" : "Primary session"}/><Detail label="Linked subagents" value={String(inspected.childThreadIds.length)}/><Detail label="Metadata source" value={inspected.titleSource}/></dl></> : <><h2 className="text-lg font-semibold">Select a session</h2><p className="mt-2 text-sm leading-6 text-zinc-500">Its local ownership details appear here before you plan a deletion.</p></>}</aside></section>
    {dialog && <div className="fixed inset-0 z-10 grid place-items-center bg-black/70 p-4"><section role="dialog" aria-modal="true" className="w-full max-w-xl rounded-2xl border border-white/10 bg-zinc-950 p-6 shadow-2xl"><p className="text-xs font-semibold tracking-[.16em] text-rose-300">DELETION PREVIEW</p><h2 className="mt-2 text-xl font-semibold">Delete local session artifacts</h2><div className="mt-5 grid gap-3 sm:grid-cols-2"><Scope checked={scope === "core"} title="Core removal" text="Registry, transcript, history, session index, logs, and linked subagents." onClick={() => makePlan("core")}/><Scope checked={scope === "deep"} title="Deep local scrub" text="Also removes verified Desktop references, memory outputs, and goal records." onClick={() => makePlan("deep")}/></div>{plan && <ul className="mt-5 space-y-2 rounded-xl border border-white/10 bg-white/[.03] p-4 text-sm text-zinc-300"><li>{plan.ids.length} sessions, including {plan.childCount} cascaded subagents</li><li>{plan.transcriptCount} transcripts and {plan.logRowCount} log rows</li>{scope === "deep" && <li>{plan.desktopStateMatchCount} Desktop references, {plan.memoryRowCount} memory outputs, {plan.goalRowCount} goal records</li>}</ul>}<p className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/[.06] p-3 text-sm leading-6 text-amber-100"><strong>Before deleting:</strong> close any active Codex sessions included in this selection. Active-session detection is unavailable, and deletion begins when you choose Delete local artifacts below.</p><div className="mt-6 flex justify-end gap-3"><button disabled={isDeleting} onClick={() => setDialog(false)} className="button secondary">Cancel</button><button disabled={isDeleting} onClick={remove} className="button danger"><ShieldCheck size={16} className={isDeleting ? "animate-spin" : undefined}/> {isDeleting ? "Deleting local artifacts" : "Delete local artifacts"}</button></div></section></div>}
  </div></main>;
}

function Pagination({ page, pages, numbers, setPage }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 px-4 py-2 text-xs text-zinc-500"><span>Page {page} of {pages}</span><div className="flex items-center gap-1"><button disabled={page === 1} onClick={() => setPage(page - 1)} className="button secondary"><ChevronLeft size={15}/> Previous</button>{numbers.map((number) => <button key={number} onClick={() => setPage(number)} aria-current={page === number ? "page" : undefined} className={`button secondary min-w-8 justify-center px-2 ${page === number ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-100" : ""}`}>{number}</button>)}<button disabled={page === pages} onClick={() => setPage(page + 1)} className="button secondary">Next <ChevronRight size={15}/></button></div></div>;
}

function CompatibilityControl({ compatibility, compatibilityRef, expanded, onToggle, onClose }) {
  if (!compatibility) return null;

  const copy = compatibility.status === "ready"
    ? { title: "Cleanup supported", text: "This installation looks compatible.", tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" }
    : compatibility.status === "newer-version"
      ? { title: "Check updates", text: "Your session storage looks familiar, but there are new local items to review.", tone: "border-amber-500/30 bg-amber-500/10 text-amber-100" }
      : { title: "Needs update", text: "This version stores some session data differently. Deep cleanup is paused until it is reviewed.", tone: "border-rose-500/30 bg-rose-500/10 text-rose-100" };
  const details = [
    ...compatibility.missing,
    ...compatibility.changed,
    ...compatibility.newlyDiscovered,
  ];

  return <div ref={compatibilityRef} className="relative"><button onClick={onToggle} aria-expanded={expanded} className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-emerald-400/50 ${copy.tone}`}><span className="size-1.5 rounded-full bg-current"/>{copy.title}</button>{expanded && <section className="absolute right-0 z-20 mt-2 w-[min(28rem,calc(100vw-2.5rem))] rounded-xl border border-white/10 bg-zinc-950 p-4 text-sm text-zinc-200 shadow-2xl"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{compatibility.status === "ready" ? "Compatibility details" : copy.title}</p><p className="mt-1 text-zinc-400">{copy.text}</p></div><button onClick={onClose} aria-label="Close compatibility details" className="rounded-md p-1 text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"><X size={16}/></button></div><div className="mt-4 border-t border-white/10 pt-4 text-zinc-400"><p>Built for ChatGPT {compatibility.builtFor.chatgptDesktop.join(", ")} and Codex {compatibility.builtFor.codexCli.join(", ")}.</p><p className="mt-1">Installed: ChatGPT {compatibility.currentVersions.chatgptDesktop || "not found"} · Codex {compatibility.currentVersions.codexCli || "not found"}.</p><ul className="mt-3 space-y-1">{details.length > 0 ? details.map((detail) => <li key={detail}>{detail}</li>) : <li>No missing, changed, or newly discovered session storage was found.</li>}</ul></div></section>}</div>;
}

const Detail = ({ label, value }) => <div className="border-b border-white/5 pb-3"><dt className="mb-1 text-[11px] font-semibold uppercase tracking-[.14em] text-zinc-500">{label}</dt><dd className="break-words text-zinc-300">{value}</dd></div>;
const Scope = ({ checked, onClick, text, title }) => <button onClick={onClick} className={`rounded-xl border p-4 text-left ${checked ? "border-emerald-400 bg-emerald-500/10" : "border-white/10 bg-white/[.02]"}`}><div className="flex items-center gap-2 font-medium">{checked && <Check size={15} className="text-emerald-300"/>}{title}</div><p className="mt-2 text-xs leading-5 text-zinc-400">{text}</p></button>;

createRoot(document.getElementById("root")).render(<App/>);
