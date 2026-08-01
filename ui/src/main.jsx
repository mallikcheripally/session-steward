import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Archive,
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  FileText,
  FolderKanban,
  GitBranch,
  HardDrive,
  Info,
  Pin,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";

const PAGE_SIZE = 25;
const MAX_PAGE_LINKS = 5;
const PLAN_REVIEW_REQUIRED = "DELETION_PLAN_REVIEW_REQUIRED";
const ALL_WORKSPACES = "__all_workspaces__";

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "Request failed.");
    error.code = payload.code;
    throw error;
  }
  return payload;
};

const age = (timestamp) => {
  if (!timestamp) return "Unknown";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
};

const fullDate = (timestamp) => timestamp
  ? new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  : "Not recorded";

const folderName = (value) => {
  if (!value) return "No workspace recorded";
  const parts = value.replace(/[\\/]+$/u, "").split(/[\\/]/u);
  return parts.at(-1) || value;
};

const workspaceOptionLabel = ({ path: workspacePath, sessionCount }) => {
  if (!workspacePath) return `Workspace not recorded · ${sessionCount.toLocaleString()}`;
  return `${folderName(workspacePath)} — ${workspacePath} · ${sessionCount.toLocaleString()}`;
};

const fileSize = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "bytes";
  for (const nextUnit of units) {
    value /= 1024;
    unit = nextUnit;
    if (value < 1024) break;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
};

const versionStatus = (support) => ({
  "exact-supported": "tested version",
  newer: "newer than tested",
  older: "older than tested",
  unavailable: "not found",
  unrecognized: "version not recognized",
}[support?.status] || "version unavailable");

function getPageNumbers(currentPage, pageCount) {
  const start = Math.max(1, Math.min(currentPage - Math.floor(MAX_PAGE_LINKS / 2), pageCount - MAX_PAGE_LINKS + 1));
  const end = Math.min(pageCount, start + MAX_PAGE_LINKS - 1);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function getSessionKind(record) {
  if (record.isSubagent) return { icon: Bot, label: "Subagent" };
  if (record.isFork) return { icon: GitBranch, label: "Fork" };
  if (record.isPinned) return { icon: Pin, label: "Pinned" };
  return null;
}

function App() {
  const [records, setRecords] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [inspected, setInspected] = useState(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updated");
  const [internals, setInternals] = useState(false);
  const [supporting, setSupporting] = useState(false);
  const [inactiveDays, setInactiveDays] = useState("");
  const [archiveStatus, setArchiveStatus] = useState("all");
  const [workspace, setWorkspace] = useState(ALL_WORKSPACES);
  const [page, setPage] = useState(1);
  const [token, setToken] = useState("");
  const [providerSettings, setProviderSettings] = useState(null);
  const [providerHomeDraft, setProviderHomeDraft] = useState("");
  const [editingProviderHome, setEditingProviderHome] = useState(false);
  const [isSavingProviderHome, setIsSavingProviderHome] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [scope, setScope] = useState("deep");
  const [plan, setPlan] = useState(null);
  const [planError, setPlanError] = useState("");
  const [planNotice, setPlanNotice] = useState("");
  const [operation, setOperation] = useState(null);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState("");
  const [compatibility, setCompatibility] = useState(null);
  const [overview, setOverview] = useState(null);
  const [overviewError, setOverviewError] = useState("");
  const [showCompatibilityDetails, setShowCompatibilityDetails] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isOverviewLoading, setIsOverviewLoading] = useState(true);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const compatibilityRef = useRef(null);
  const loadSequence = useRef(0);
  const loadController = useRef(null);

  const load = async ({ queryOverrides = {} } = {}) => {
    const sequence = ++loadSequence.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const query = {
      archiveStatus,
      inactiveDays,
      internals,
      page,
      search,
      sort,
      supporting,
      workspace,
      ...queryOverrides,
    };

    try {
      setIsLoading(true);
      setError("");
      const params = new URLSearchParams({
        archiveStatus: query.archiveStatus,
        includeInternals: String(query.internals),
        includeSupporting: String(query.supporting),
        page: String(query.page),
        pageSize: String(PAGE_SIZE),
        search: query.search,
        sort: query.sort,
      });
      if (query.inactiveDays) params.set("inactiveDays", query.inactiveDays);
      if (query.workspace !== ALL_WORKSPACES) params.set("workspace", query.workspace);
      const result = await api(`/api/sessions?${params}`, { signal: controller.signal });
      if (sequence !== loadSequence.current) return;
      setRecords(result.records);
      setTotal(result.total);
      setPages(result.pageCount);
      if (result.page !== query.page) setPage(result.page);
    } catch (issue) {
      if (issue.name !== "AbortError" && sequence === loadSequence.current) setError(issue.message);
    } finally {
      if (sequence === loadSequence.current) {
        setIsLoading(false);
      }
    }
  };

  const loadOverview = async ({ refresh = false } = {}) => {
    try {
      setIsOverviewLoading(true);
      setOverviewError("");
      const suffix = refresh ? "?refresh=true" : "";
      setOverview((await api(`/api/session-overview${suffix}`)).overview);
    } catch {
      setOverviewError("Overview unavailable");
    } finally {
      setIsOverviewLoading(false);
    }
  };

  const refreshAll = async () => {
    try {
      setIsRefreshing(true);
      setError("");
      const [diagnostic] = await Promise.all([
        api("/api/compatibility"),
        load(),
        loadOverview({ refresh: true }),
      ]);
      setCompatibility(diagnostic);
    } catch (issue) {
      setError(issue.message);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    api("/api/config").then(({ mutationToken, providers }) => {
      setToken(mutationToken);
      setProviderSettings(providers.codex);
      setProviderHomeDraft(providers.codex.home);
    }).catch((issue) => setError(issue.message));
    api("/api/compatibility").then(setCompatibility).catch((issue) => setError(issue.message));
    loadOverview();
  }, []);

  useEffect(() => {
    setPage(1);
  }, [search, sort, internals, supporting, inactiveDays, archiveStatus, workspace]);

  useEffect(() => {
    setSelected(new Set());
    setInspected(null);
  }, [search, internals, supporting, inactiveDays, archiveStatus, workspace]);

  useEffect(() => {
    const timer = setTimeout(load, 120);
    return () => clearTimeout(timer);
  }, [search, sort, internals, supporting, inactiveDays, archiveStatus, workspace, page]);

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

  useEffect(() => {
    if (!dialog || isDeleting) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setDialog(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [dialog, isDeleting]);

  const pageNumbers = useMemo(() => getPageNumbers(page, pages), [page, pages]);
  const allPageSelected = records.length > 0 && records.every((record) => selected.has(record.id));
  const filterCount = Number(Boolean(search.trim()))
    + Number(internals)
    + Number(supporting)
    + Number(Boolean(inactiveDays))
    + Number(archiveStatus !== "all")
    + Number(workspace !== ALL_WORKSPACES);
  const hasActiveFilters = filterCount > 0;

  const clearFilters = () => {
    setSearch("");
    setInternals(false);
    setSupporting(false);
    setInactiveDays("");
    setArchiveStatus("all");
    setWorkspace(ALL_WORKSPACES);
  };

  const inspect = async (id) => {
    try {
      setInspected((await api(`/api/sessions/${encodeURIComponent(id)}`)).record);
      setError("");
    } catch (issue) {
      setError(issue.message);
    }
  };

  const makePlan = async (nextScope = scope, { noticeText = "" } = {}) => {
    try {
      setPlan(null);
      setPlanError("");
      setPlanNotice("");
      const result = await api("/api/deletion-plans", {
        method: "POST",
        body: JSON.stringify({ ids: [...selected], scope: nextScope }),
      });
      setPlan(result.plan);
      setOperation(null);
      setScope(nextScope);
      setError("");
      setPlanNotice(noticeText);
      return true;
    } catch (issue) {
      setPlanError(issue.message);
      setError(issue.message);
      return false;
    }
  };

  const refreshDeletionPlan = async (code) => {
    if (code !== PLAN_REVIEW_REQUIRED) return false;
    setOperation(null);
    await makePlan(scope, {
      noticeText: "Sessions changed. Review the updated cleanup details before continuing.",
    });
    return true;
  };

  const openDeleteDialog = async () => {
    try {
      setIsPlanning(true);
      const nextScope = compatibility && compatibility.status !== "ready" ? "core" : scope;
      if (await makePlan(nextScope)) setDialog(true);
    } finally {
      setIsPlanning(false);
    }
  };

  const remove = async () => {
    try {
      setIsDeleting(true);
      setError("");
      const started = await api("/api/deletions", {
        method: "POST",
        headers: { "X-Session-Steward-Token": token },
        body: JSON.stringify({ planId: plan.id }),
      });
      let current = started.operation;
      setOperation(current);

      while (["queued", "running", "restoring"].includes(current.status)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        current = (await api(`/api/deletions/${encodeURIComponent(current.id)}`)).operation;
        setOperation(current);
      }

      if (current.status === "completed") {
        setDialog(false);
        setSelected(new Set());
        setInspected(null);
        setPlan(null);
        setNotice({ kind: "success", text: "Cleanup completed and verified." });
      } else if (current.status === "cancelled") {
        setDialog(false);
        setPlan(null);
        setNotice({ kind: "warning", text: "Cleanup was cancelled before session data changed." });
      } else if (!(await refreshDeletionPlan(current.errorCode))) {
        setError(current.error || "Cleanup needs attention.");
      }
      await Promise.all([load(), loadOverview({ refresh: true })]);
    } catch (issue) {
      if (!(await refreshDeletionPlan(issue.code))) setError(issue.message);
    } finally {
      setIsDeleting(false);
    }
  };

  const cancelCleanup = async () => {
    if (!operation || operation.cancelRequested) return;
    try {
      const result = await api(`/api/deletions/${encodeURIComponent(operation.id)}`, {
        method: "DELETE",
        headers: { "X-Session-Steward-Token": token },
      });
      setOperation(result.operation);
      if (!result.cancelAccepted) {
        setNotice({ kind: "warning", text: "Cleanup is already applying changes and will finish safely." });
      }
    } catch (issue) {
      setError(issue.message);
    }
  };

  const restoreBackup = async () => {
    if (!operation) return;
    try {
      setIsDeleting(true);
      setError("");
      let current = (await api(`/api/deletions/${encodeURIComponent(operation.id)}/restore`, {
        method: "POST",
        headers: { "X-Session-Steward-Token": token },
      })).operation;
      setOperation(current);

      while (current.status === "restoring") {
        await new Promise((resolve) => setTimeout(resolve, 250));
        current = (await api(`/api/deletions/${encodeURIComponent(current.id)}`)).operation;
        setOperation(current);
      }

      if (current.status === "restored") {
        setDialog(false);
        setSelected(new Set());
        setInspected(null);
        setPlan(null);
        setNotice({ kind: "success", text: "The recovery backup was restored." });
      } else {
        setError(current.error || "The recovery backup could not be restored.");
      }
      await Promise.all([load(), loadOverview({ refresh: true })]);
    } catch (issue) {
      setError(issue.message);
    } finally {
      setIsDeleting(false);
    }
  };

  const deleteRecoveryBackup = async () => {
    if (!operation) return;
    try {
      setIsDeleting(true);
      setError("");
      const result = await api(`/api/deletions/${encodeURIComponent(operation.id)}/backup`, {
        method: "DELETE",
        headers: { "X-Session-Steward-Token": token },
      });
      setOperation(result.operation);
      setDialog(false);
      setNotice({ kind: "success", text: "The recovery backup was deleted." });
    } catch (issue) {
      setError(issue.message);
    } finally {
      setIsDeleting(false);
    }
  };

  const finishProviderHomeChange = async (provider, message) => {
    setProviderSettings(provider);
    setProviderHomeDraft(provider.home);
    setEditingProviderHome(false);
    setSelected(new Set());
    setInspected(null);
    setPlan(null);
    setOperation(null);
    setDialog(false);
    setPage(1);
    setSearch("");
    setInternals(false);
    setSupporting(false);
    setInactiveDays("");
    setArchiveStatus("all");
    setWorkspace(ALL_WORKSPACES);
    const [diagnostic] = await Promise.all([
      api("/api/compatibility"),
      load({
        queryOverrides: {
          archiveStatus: "all",
          inactiveDays: "",
          internals: false,
          page: 1,
          search: "",
          supporting: false,
          workspace: ALL_WORKSPACES,
        },
      }),
      loadOverview({ refresh: true }),
    ]);
    setCompatibility(diagnostic);
    setNotice({ kind: "success", text: message });
  };

  const saveProviderHome = async (event) => {
    event.preventDefault();
    try {
      setIsSavingProviderHome(true);
      setError("");
      const { provider } = await api("/api/settings/providers/codex", {
        method: "PUT",
        headers: { "X-Session-Steward-Token": token },
        body: JSON.stringify({ home: providerHomeDraft }),
      });
      await finishProviderHomeChange(provider, "Codex session folder updated.");
    } catch (issue) {
      setError(issue.message);
    } finally {
      setIsSavingProviderHome(false);
    }
  };

  const resetProviderHome = async () => {
    try {
      setIsSavingProviderHome(true);
      setError("");
      const { provider } = await api("/api/settings/providers/codex", {
        method: "DELETE",
        headers: { "X-Session-Steward-Token": token },
      });
      await finishProviderHomeChange(provider, "Using the default Codex session folder.");
    } catch (issue) {
      setError(issue.message);
    } finally {
      setIsSavingProviderHome(false);
    }
  };

  const toggle = (id) => setSelected((current) => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const togglePage = () => setSelected((current) => {
    const next = new Set(current);
    if (allPageSelected) records.forEach((record) => next.delete(record.id));
    else records.forEach((record) => next.add(record.id));
    return next;
  });

  return <main className="app-shell min-h-screen text-neutral-100">
    <div className="relative mx-auto max-w-[1380px] px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
      <header className="mb-5 flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3.5">
          <div className="brand-mark"><ShieldCheck size={23}/></div>
          <div>
            <p className="mb-1 text-xs font-medium text-neutral-500">Local Codex session manager</p>
            <h1 className="text-2xl font-semibold tracking-[-.035em] text-white sm:text-[1.75rem]">Session Steward</h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CompatibilityControl compatibilityRef={compatibilityRef} compatibility={compatibility} expanded={showCompatibilityDetails} onToggle={() => setShowCompatibilityDetails((current) => !current)} onClose={() => setShowCompatibilityDetails(false)}/>
          <button disabled={isRefreshing} onClick={refreshAll} className="button secondary"><RefreshCw size={15} className={isRefreshing ? "animate-spin" : undefined}/><span>{isRefreshing ? "Refreshing" : "Refresh"}</span></button>
        </div>
      </header>

      <ProviderHomeControl
        editing={editingProviderHome}
        isSaving={isSavingProviderHome}
        onCancel={() => { setEditingProviderHome(false); setProviderHomeDraft(providerSettings.home); }}
        onChange={setProviderHomeDraft}
        onEdit={() => { setProviderHomeDraft(providerSettings.home); setEditingProviderHome(true); }}
        onReset={resetProviderHome}
        onSubmit={saveProviderHome}
        provider={providerSettings}
        value={providerHomeDraft}
      />

      <div aria-live="polite">
        {notice && <Alert kind={notice.kind} onDismiss={() => setNotice(null)}>{notice.text}</Alert>}
        {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      </div>

      <Overview
        error={overviewError}
        loading={isOverviewLoading}
        overview={overview}
      />

      <section className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="surface overflow-hidden">
          <div className="session-list-header flex min-h-[60px] flex-wrap items-center justify-between gap-3 border-b border-white/[.07] px-4 py-3 sm:px-5">
            <div>
              <div className="flex items-baseline gap-2">
                <h2 className="text-base font-semibold text-white">Sessions</h2>
                <span aria-live="polite" className="text-sm tabular-nums text-neutral-500">{total.toLocaleString()} shown</span>
              </div>
            </div>
            <div className="session-list-actions flex items-center gap-2"><button disabled={!selected.size || isLoading || isPlanning} onClick={openDeleteDialog} className="button danger">{isPlanning ? <RefreshCw size={15} className="animate-spin"/> : <Trash2 size={15}/>} {isPlanning ? "Preparing" : "Delete"}</button></div>
          </div>

          <Filters
            archiveStatus={archiveStatus}
            clearFilters={clearFilters}
            filterCount={filterCount}
            inactiveDays={inactiveDays}
            internals={internals}
            overview={overview}
            search={search}
            setArchiveStatus={setArchiveStatus}
            setInactiveDays={setInactiveDays}
            setInternals={setInternals}
            setSearch={setSearch}
            setSort={setSort}
            setSupporting={setSupporting}
            setWorkspace={setWorkspace}
            sort={sort}
            supporting={supporting}
            workspace={workspace}
          />

          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/[.06] bg-white/[.012] px-4 py-2.5 sm:px-5">
            <label className="selection-control"><input checked={allPageSelected} onChange={togglePage} disabled={!records.length || isLoading} type="checkbox"/><span>Select this page</span></label>
            <span aria-hidden={selected.size === 0} aria-live="polite" className={`selection-count ${selected.size === 0 ? "selection-count-hidden" : ""}`}>{selected.size} selected</span>
          </div>

          <div className="min-h-[360px]">
            {isLoading
              ? <SessionSkeleton/>
              : records.length > 0
                ? <div className="divide-y divide-white/[.055]">{records.map((record) => <SessionRow key={record.id} inspected={inspected?.id === record.id} onInspect={inspect} onToggle={toggle} record={record} selected={selected.has(record.id)}/>)}</div>
                : <EmptyState hasActiveFilters={hasActiveFilters} onClear={clearFilters}/>
            }
          </div>

          <Pagination page={page} pages={pages} numbers={pageNumbers} setPage={setPage}/>
        </div>

        <Inspector onClose={() => setInspected(null)} record={inspected}/>
      </section>
    </div>

    {dialog && <DeletionDialog
      isDeleting={isDeleting}
      onCancelCleanup={cancelCleanup}
      onClose={() => setDialog(false)}
      onDelete={remove}
      onDeleteBackup={deleteRecoveryBackup}
      onRestore={restoreBackup}
      onScopeChange={makePlan}
      operation={operation}
      plan={plan}
      planError={planError}
      planNotice={planNotice}
      scope={scope}
    />}
  </main>;
}

function Alert({ children, kind, onDismiss }) {
  const config = kind === "error"
    ? { icon: AlertTriangle, tone: "alert-error" }
    : kind === "warning"
      ? { icon: AlertTriangle, tone: "alert-warning" }
      : { icon: CheckCircle2, tone: "alert-success" };
  const Icon = config.icon;

  return <div className={`alert ${config.tone}`}><Icon size={17}/><p>{children}</p><button type="button" onClick={onDismiss} aria-label="Dismiss message"><X size={15}/></button></div>;
}

function ProviderHomeControl({ editing, isSaving, onCancel, onChange, onEdit, onReset, onSubmit, provider, value }) {
  if (!provider) return <div className="mb-3 h-12 animate-pulse rounded-lg bg-white/[.025]"/>;
  const sourceLabel = provider.source === "startup" ? "This run" : provider.isDefault ? "Default" : "Saved";

  return <section className={`provider-context ${editing ? "provider-context-editing" : ""}`}>
    <div className="provider-context-row">
      <div className="provider-context-main">
        <div className="provider-context-heading"><HardDrive size={14}/><span className="provider-context-label">Codex home folder</span><span className="source-badge">{sourceLabel}</span>{!editing && <div className="provider-context-actions"><button disabled={isSaving} onClick={onEdit} className="compact-action">Change</button>{!provider.isDefault && <button disabled={isSaving} onClick={onReset} className="compact-action">Use default</button>}</div>}</div>
        <code title={provider.home}>{provider.home}</code>
      </div>
    </div>
    {editing && <form onSubmit={onSubmit} className="provider-context-form"><label className="field"><span>Folder path</span><input autoFocus required spellCheck="false" value={value} onChange={(event) => onChange(event.target.value)} placeholder="~/.codex"/></label><div className="mt-3 flex justify-end gap-2"><button type="button" disabled={isSaving} onClick={onCancel} className="button ghost">Cancel</button><button type="submit" disabled={isSaving || !value.trim()} className="button primary">{isSaving ? "Saving" : "Save folder"}</button></div></form>}
  </section>;
}

function Overview({ error, loading, overview }) {
  const metrics = [
    {
      icon: Database,
      label: "Total sessions",
      value: overview?.sessionCount.toLocaleString(),
    },
    {
      icon: FileText,
      label: "Sessions",
      value: overview?.primarySessionCount.toLocaleString(),
    },
    {
      icon: Bot,
      label: "Subagent sessions",
      value: overview?.subagentCount.toLocaleString(),
    },
    {
      icon: GitBranch,
      label: "Supporting sessions",
      value: overview?.supportingCount.toLocaleString(),
    },
    {
      icon: HardDrive,
      label: "Session files size",
      value: overview ? fileSize(overview.transcriptBytes) : undefined,
    },
  ];

  return <section aria-label="Session overview" className="overview-strip">
    {metrics.map(({ icon: Icon, label, value }) => <div key={label} className="overview-item">
      <Icon size={14}/>
      <div className="min-w-0">
        <p className="overview-label">{label}</p>
        {loading && !overview
          ? <div className="skeleton mt-1 h-5 w-16 rounded"/>
          : <p className="overview-value">{error && !overview ? "—" : value ?? "—"}</p>}
      </div>
    </div>)}
  </section>;
}

function Filters({
  archiveStatus,
  clearFilters,
  filterCount,
  inactiveDays,
  internals,
  overview,
  search,
  setArchiveStatus,
  setInactiveDays,
  setInternals,
  setSearch,
  setSort,
  setSupporting,
  setWorkspace,
  sort,
  supporting,
  workspace,
}) {
  return <section className="session-filters" aria-label="Session filters">
    <div className="session-filters-main">
      <div className="filter-grid">
        <label className="field"><span><Search size={13}/> Search sessions</span><div className="input-wrap"><Search size={16}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, workspace, or session ID"/>{search && <button type="button" onClick={() => setSearch("")} aria-label="Clear search"><X size={14}/></button>}</div></label>
        <label className="field"><span><FolderKanban size={13}/> Workspace</span><select value={workspace} onChange={(event) => setWorkspace(event.target.value)}><option value={ALL_WORKSPACES}>All workspaces</option>{overview?.workspaces.map((item) => <option key={item.path || "__missing__"} value={item.path}>{workspaceOptionLabel(item)}</option>)}</select></label>
        <label className="field"><span><Clock3 size={13}/> Inactive for</span><select value={inactiveDays} onChange={(event) => setInactiveDays(event.target.value)}><option value="">Any time</option><option value="30">30 days or more</option><option value="60">60 days or more</option><option value="90">90 days or more</option></select></label>
        <label className="field"><span><Archive size={13}/> Status</span><select value={archiveStatus} onChange={(event) => setArchiveStatus(event.target.value)}><option value="all">All sessions</option><option value="active">Active</option><option value="archived">Archived</option></select></label>
        <label className="field"><span>Sort by</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="updated">Last activity</option><option value="created">Created</option><option value="name">Name</option><option value="cwd">Workspace</option></select></label>
      </div>
    </div>
    <div className="filter-footer">
      <div className="flex flex-wrap gap-2"><Toggle checked={internals} onChange={setInternals}>Subagent sessions</Toggle><Toggle checked={supporting} onChange={setSupporting}>Supporting sessions</Toggle></div>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {inactiveDays && overview?.unknownActivityCount > 0 && <p className="max-w-xs text-right text-[11px] leading-4 text-neutral-500">{overview.unknownActivityCount.toLocaleString()} with unknown activity are not included.</p>}
        {filterCount > 0 && <button type="button" onClick={clearFilters} className="clear-filters"><X size={13}/> Clear filters <span>{filterCount}</span></button>}
      </div>
    </div>
  </section>;
}

function Toggle({ checked, children, onChange }) {
  return <label className={`toggle ${checked ? "toggle-active" : ""}`}><input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox"/><span className="toggle-track"><span/></span><span>{children}</span></label>;
}

function SessionRow({ inspected, onInspect, onToggle, record, selected }) {
  const kind = getSessionKind(record);
  const KindIcon = kind?.icon;

  return <div className={`session-row group ${inspected ? "session-row-inspected" : ""} ${selected ? "session-row-selected" : ""}`}>
    <label className="session-checkbox" aria-label={`Select ${record.displayName}`}><input checked={selected} onChange={() => onToggle(record.id)} type="checkbox"/></label>
    <button type="button" onClick={() => onInspect(record.id)} className="min-w-0 text-left">
      <span className="block truncate text-[14px] font-medium text-neutral-100 transition group-hover:text-white">{record.displayName}</span>
      <span className="session-workspace"><FolderKanban size={12} className="shrink-0"/><span className="truncate" title={record.cwd || undefined}>{folderName(record.cwd)}</span>{record.archived && <span className="archive-tag"><Archive size={10}/>Archived</span>}</span>
    </button>
    <div className="flex shrink-0 flex-col items-end gap-1.5">
      <span className="time-badge" title={fullDate(record.updatedAtMs)}><Clock3 size={11}/>{age(record.updatedAtMs)}</span>
      {kind && <span className="kind-label"><KindIcon size={11}/>{kind.label}</span>}
    </div>
    <ChevronRight size={16} className="hidden shrink-0 text-neutral-700 transition group-hover:translate-x-0.5 group-hover:text-neutral-400 sm:block"/>
  </div>;
}

function SessionSkeleton() {
  return <div className="divide-y divide-white/[.055]" aria-label="Loading sessions">{Array.from({ length: 6 }, (_, index) => <div key={index} className="grid grid-cols-[32px_minmax(0,1fr)_80px] items-center gap-2 px-4 py-[1.15rem] sm:px-5"><div className="skeleton size-4 rounded"/><div><div className="skeleton h-4 w-[min(75%,30rem)] rounded"/><div className="skeleton mt-2 h-3 w-[min(50%,20rem)] rounded"/></div><div className="skeleton ml-auto h-6 w-16 rounded-full"/></div>)}</div>;
}

function EmptyState({ hasActiveFilters, onClear }) {
  return <div className="grid min-h-[360px] place-items-center px-6 text-center"><div><div className="mx-auto grid size-11 place-items-center rounded-xl border border-white/[.08] bg-white/[.035] text-neutral-500"><Search size={19}/></div><h3 className="mt-4 text-sm font-semibold text-neutral-200">{hasActiveFilters ? "No sessions match these filters" : "No sessions found"}</h3><p className="mx-auto mt-1.5 max-w-sm text-xs leading-5 text-neutral-500">{hasActiveFilters ? "Adjust the filters to see more sessions." : "Session Steward did not find any sessions in this folder."}</p>{hasActiveFilters && <button type="button" onClick={onClear} className="button secondary mt-4">Clear filters</button>}</div></div>;
}

function Inspector({ onClose, record }) {
  return <><button type="button" aria-label="Close session details" onClick={onClose} className={`inspector-backdrop ${record ? "inspector-backdrop-open" : ""}`}/><aside className={`surface inspector ${record ? "inspector-open" : ""}`}>
    <div className="flex items-center justify-between border-b border-white/[.07] px-5 py-4"><p className="eyebrow">Session details</p>{record && <button type="button" onClick={onClose} aria-label="Close session details" className="icon-button lg:hidden"><X size={16}/></button>}</div>
    {record
      ? <div className="p-5"><div className="flex items-start gap-3"><div className="icon-tile"><FileText size={17}/></div><div className="min-w-0"><h2 className="break-words text-base font-normal leading-6 text-white">{record.displayName}</h2><p className="mt-1 break-all font-mono text-[10px] leading-4 text-neutral-600">{record.id}</p></div></div><dl className="mt-6 space-y-4"><Detail icon={Archive} label="Status" value={record.archived ? "Archived" : "Active"}/><Detail icon={FolderKanban} label="Workspace" value={record.cwd || "Not recorded"}/><Detail icon={Clock3} label="Last activity" value={fullDate(record.updatedAtMs)}/><Detail icon={FileText} label="Transcript" value={record.rolloutMissing ? "Missing" : "Available"}/><Detail icon={GitBranch} label="Relationship" value={record.isSubagent ? "Subagent" : record.isFork ? "Fork" : "Primary session"}/><Detail icon={Database} label="Linked subagents" value={String(record.childThreadIds.length)}/></dl></div>
      : <div className="grid min-h-[340px] place-items-center p-7 text-center"><div><div className="mx-auto grid size-12 place-items-center rounded-2xl border border-white/[.08] bg-white/[.03] text-neutral-500"><Info size={20}/></div><h2 className="mt-4 text-sm font-semibold text-neutral-300">Select a session</h2><p className="mx-auto mt-2 max-w-[230px] text-xs leading-5 text-neutral-500">Its location, activity, and linked sessions will appear here.</p></div></div>}
  </aside></>;
}

function Detail({ icon: Icon, label, value }) {
  return <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 border-b border-white/[.055] pb-4 last:border-0 last:pb-0"><Icon size={14} className="mt-0.5 text-neutral-500"/><div><dt className="text-[11px] font-semibold uppercase tracking-[.11em] text-neutral-500">{label}</dt><dd className="mt-1 break-words text-[13px] leading-5 text-neutral-300">{value}</dd></div></div>;
}

function Pagination({ page, pages, numbers, setPage }) {
  return <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-t border-white/[.07] px-4 py-2.5 sm:px-5"><span className="text-xs tabular-nums text-neutral-500">Page <strong className="font-medium text-neutral-300">{page}</strong> of {pages}</span><div className="flex items-center gap-1"><button aria-label="Previous page" disabled={page === 1} onClick={() => setPage(page - 1)} className="page-button"><ChevronLeft size={15}/></button><div className="hidden items-center gap-1 sm:flex">{numbers.map((number) => <button key={number} onClick={() => setPage(number)} aria-current={page === number ? "page" : undefined} className="page-button">{number}</button>)}</div><button aria-label="Next page" disabled={page === pages} onClick={() => setPage(page + 1)} className="page-button"><ChevronRight size={15}/></button></div></div>;
}

function CompatibilityControl({ compatibility, compatibilityRef, expanded, onToggle, onClose }) {
  if (!compatibility) return <div className="skeleton h-9 w-32 rounded-full"/>;
  const copy = compatibility.status === "ready"
    ? { title: "Cleanup supported", text: "Session Steward recognizes this Codex data.", tone: "status-ready" }
    : compatibility.status === "newer-version"
      ? { title: "Review needed", text: "New Codex session data was found and needs review.", tone: "status-warning" }
      : { title: "Update needed", text: "Deep cleanup is paused because this Codex version stores session data differently.", tone: "status-error" };
  const details = [...compatibility.missing, ...compatibility.changed, ...compatibility.newlyDiscovered];

  return <div ref={compatibilityRef} className="relative"><button onClick={onToggle} aria-expanded={expanded} className={`status-pill ${copy.tone}`}><span/>{copy.title}</button>{expanded && <section className="compatibility-popover"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold text-white">Compatibility</p><p className="mt-1 text-xs leading-5 text-neutral-400">{copy.text}</p></div><button onClick={onClose} aria-label="Close compatibility details" className="icon-button"><X size={15}/></button></div><div className="mt-4 grid gap-2 border-t border-white/[.07] pt-4"><VersionRow label="ChatGPT" support={compatibility.versionSupport?.chatgptDesktop} value={compatibility.currentVersions.chatgptDesktop}/><VersionRow label="Codex" support={compatibility.versionSupport?.codexCli} value={compatibility.currentVersions.codexCli}/></div><p className="mt-3 text-xs leading-5 text-neutral-500">Cleanup is enabled only when Session Steward recognizes the relevant session data.</p><ul className="mt-3 space-y-1.5 text-xs leading-5 text-neutral-400">{details.length > 0 ? details.map((detail) => <li key={detail} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-amber-300"/>{detail}</li>) : <li className="flex gap-2 text-neutral-500"><Check size={13} className="mt-0.5 text-emerald-400"/>No unexpected session data was found.</li>}</ul></section>}</div>;
}

function VersionRow({ label, support, value }) {
  return <div className="flex items-center justify-between gap-4 rounded-lg bg-white/[.025] px-3 py-2.5"><div><p className="text-xs font-medium text-neutral-300">{label}</p><p className="mt-0.5 font-mono text-[11px] text-neutral-500">{value || "Not found"}</p></div><span className="text-right text-[11px] text-neutral-500">{versionStatus(support)}</span></div>;
}

function DeletionDialog({ isDeleting, onCancelCleanup, onClose, onDelete, onDeleteBackup, onRestore, onScopeChange, operation, plan, planError, planNotice, scope }) {
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [confirmingBackupDelete, setConfirmingBackupDelete] = useState(false);
  const active = operation && ["queued", "running", "restoring"].includes(operation.status);
  const progress = Math.min(100, Math.max(0, Number(operation?.progress) || 0));
  const needsAttention = operation?.status === "needs-attention";
  const hasFailed = ["failed", "restore-failed"].includes(operation?.status);

  useEffect(() => {
    setConfirmingRestore(false);
    setConfirmingBackupDelete(false);
  }, [operation?.id, operation?.canDeleteBackup, operation?.canRestore]);

  const progressTone = hasFailed ? "bg-rose-400" : needsAttention ? "bg-amber-300" : operation?.status === "restored" ? "bg-sky-400" : "bg-emerald-400";
  const errorTone = needsAttention ? "text-amber-100" : "text-rose-200";

  return <div className="dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="delete-title" className="dialog-panel"><div className="flex items-start justify-between gap-4"><div><div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.16em] text-rose-300"><ShieldCheck size={13}/> Session cleanup</div><h2 id="delete-title" className="text-xl font-semibold tracking-tight text-white">{operation ? operation.message : "Review selected sessions"}</h2><p className="mt-1.5 text-sm leading-6 text-neutral-500">Session Steward creates a local backup before cleanup begins.</p></div><button disabled={active} onClick={onClose} aria-label="Close cleanup" className="icon-button"><X size={17}/></button></div>
    {!operation && <div className="mt-5 grid gap-3 sm:grid-cols-2"><Scope checked={scope === "core"} disabled={isDeleting} title="Standard cleanup" text="Removes the sessions, transcripts, history, logs, and linked subagents." onClick={() => onScopeChange("core")}/><Scope checked={scope === "deep"} disabled={isDeleting} title="Thorough cleanup" text="Also removes supported Desktop references, saved memory, and goals." onClick={() => onScopeChange("deep")}/></div>}
    {planError && <div role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-400/[.07] p-3 text-sm text-rose-100">{planError}</div>}
    {planNotice && <div role="status" className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-3 text-sm text-amber-100">{planNotice}</div>}
    {plan
      ? <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4"><Metric label="Sessions to remove" value={plan.sessionCount}/><Metric label="Files to remove" value={plan.transcriptCount}/><Metric label="Session files size" value={fileSize(plan.transcriptBytes)}/><Metric label="Records to remove" value={plan.relatedRecordCount}/></div>
      : <div className="mt-5 h-[76px] animate-pulse rounded-xl bg-white/[.025]"/>}
    {!operation && plan && <div className="mt-3 flex gap-2.5 text-xs leading-5 text-neutral-500"><HardDrive size={14} className="mt-0.5 shrink-0"/><p>About {fileSize(plan.estimatedBackupBytes)} of temporary free space is needed for a recovery backup. It is removed after cleanup is verified.</p></div>}
    {plan?.childCount > 0 && <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-neutral-400"><GitBranch size={13} className="mt-1 shrink-0 text-amber-300"/><span>{plan.childCount} linked {plan.childCount === 1 ? "session is" : "sessions are"} included.{plan.newestLinkedActivityAtMs ? ` Newest linked activity was ${age(plan.newestLinkedActivityAtMs)}.` : " Linked activity was not recorded."}</span></p>}
    {operation && <div className="mt-5 rounded-xl border border-white/[.08] bg-white/[.025] p-4"><div className="flex items-center justify-between gap-4 text-sm"><span role="status" aria-live="polite" aria-atomic="true" className="font-medium text-neutral-300">{operation.message}</span><span className="tabular-nums text-neutral-500">{progress}%</span></div><div role="progressbar" aria-label="Cleanup progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress} aria-valuetext={operation.message} className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[.07]"><div className={`h-full rounded-full transition-all ${progressTone}`} style={{ width: `${progress}%` }}/></div>{operation.error && <p className={`mt-3 text-xs leading-5 ${errorTone}`}>{operation.error}</p>}{operation.backupDeleteError && <p className="mt-3 text-xs leading-5 text-amber-100">{operation.backupDeleteError}</p>}{operation.canRestore && <div className="mt-3 space-y-2 text-xs leading-5 text-neutral-400"><p>Restore returns these sessions to their pre-cleanup state. Current files are backed up first.</p>{operation.backupDirectory && <div><p className="text-neutral-500">Recovery backup location</p><p className="break-all font-mono text-[11px] text-neutral-400">{operation.backupDirectory}</p></div>}</div>}</div>}
    {confirmingRestore && operation?.canRestore && <div role="alert" className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-4"><p className="text-sm font-semibold text-amber-100">Restore these sessions?</p><p className="mt-1.5 text-xs leading-5 text-amber-100/75">This replaces the affected Codex session data with the recovery backup. Session Steward saves the current files first.</p></div>}
    {confirmingBackupDelete && operation?.canDeleteBackup && <div role="alert" className="mt-4 rounded-xl border border-rose-300/20 bg-rose-300/[.06] p-4"><p className="text-sm font-semibold text-rose-100">Delete this recovery backup?</p><p className="mt-1.5 text-xs leading-5 text-rose-100/75">You will no longer be able to restore these sessions from this backup.</p></div>}
    {!operation && <div className="mt-5 flex gap-3 rounded-xl border border-amber-300/15 bg-amber-300/[.045] p-3.5"><AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-300"/><p className="text-xs leading-5 text-amber-100/80"><strong className="font-semibold text-amber-100">Close selected Codex sessions first.</strong> Session Steward cannot tell whether one is currently active.</p></div>}
    <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{!operation && <button disabled={isDeleting} onClick={onClose} className="button ghost">Cancel</button>}{!operation && <button disabled={isDeleting || !plan} onClick={onDelete} className="button danger min-w-40"><Trash2 size={15}/>{isDeleting ? "Starting cleanup…" : "Delete selected sessions"}</button>}{active && operation.canCancel && <button disabled={operation.cancelRequested} onClick={onCancelCleanup} className="button ghost">{operation.cancelRequested ? "Cancellation requested" : "Cancel cleanup"}</button>}{operation && !active && !confirmingRestore && !confirmingBackupDelete && <button onClick={onClose} className="button secondary">{operation.canRestore ? "Keep backup" : "Close"}</button>}{operation?.canDeleteBackup && !confirmingRestore && !confirmingBackupDelete && <button disabled={isDeleting} onClick={() => setConfirmingBackupDelete(true)} className="button ghost">Delete backup</button>}{operation?.canRestore && !confirmingRestore && !confirmingBackupDelete && <button disabled={isDeleting} onClick={() => setConfirmingRestore(true)} className="button primary">Restore backup</button>}{confirmingRestore && <button disabled={isDeleting} onClick={() => setConfirmingRestore(false)} className="button ghost">Cancel</button>}{confirmingRestore && <button disabled={isDeleting} onClick={onRestore} className="button primary">{isDeleting ? "Restoring…" : "Restore sessions"}</button>}{confirmingBackupDelete && <button disabled={isDeleting} onClick={() => setConfirmingBackupDelete(false)} className="button ghost">Cancel</button>}{confirmingBackupDelete && <button disabled={isDeleting} onClick={onDeleteBackup} className="button danger">{isDeleting ? "Deleting…" : "Delete backup"}</button>}</div>
  </section></div>;
}

function Metric({ label, value }) {
  return <div className="rounded-xl border border-white/[.07] bg-white/[.025] p-3"><p className="min-h-8 text-[10px] font-semibold uppercase leading-4 tracking-[.1em] text-neutral-600">{label}</p><p className="mt-1 truncate text-sm font-semibold tabular-nums text-neutral-200">{value}</p></div>;
}

function Scope({ checked, disabled, onClick, text, title }) {
  return <button disabled={disabled} aria-pressed={checked} onClick={onClick} className={`scope-card ${checked ? "scope-card-active" : ""}`}><div className="flex items-center justify-between gap-2"><span className="font-medium text-neutral-100">{title}</span><span className={`grid size-5 place-items-center rounded-full border ${checked ? "border-emerald-300 bg-emerald-300 text-emerald-950" : "border-white/15"}`}>{checked && <Check size={12} strokeWidth={3}/>}</span></div><p className="mt-2 text-xs leading-5 text-neutral-500">{text}</p></button>;
}

createRoot(document.getElementById("root")).render(<App/>);
