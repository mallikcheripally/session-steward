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
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { sessionDateGroupForSort, sessionDayLabel } from "./date-groups.mjs";
import {
  newestSessionEvents,
  SESSION_EVENT_BATCH_SIZE,
  sessionEventCoveragePercent,
  sessionEventText,
} from "./session-event-view.mjs";
import "./styles.css";

const PAGE_SIZE = 25;
const MAX_PAGE_LINKS = 5;
const PLAN_REVIEW_REQUIRED = "DELETION_PLAN_REVIEW_REQUIRED";
const SESSION_EVENT_COVERAGE_THRESHOLD = 90;
const ALL_WORKSPACES = "__all_workspaces__";

const FILTER_REGISTRY = [
  {
    defaultValue: "",
    icon: Search,
    id: "search",
    label: "Search sessions",
    placeholder: "Name, workspace, or session ID",
    placement: "primary",
    priority: 3,
    providers: ["codex", "claude-code"],
    type: "search",
  },
  {
    defaultValue: ALL_WORKSPACES,
    icon: FolderKanban,
    id: "workspace",
    label: "Workspace",
    options: "workspaces",
    placement: "primary",
    priority: 2,
    providers: ["codex", "claude-code"],
    type: "select",
  },
  {
    defaultValue: "",
    icon: Clock3,
    id: "inactiveDays",
    label: "Inactive for",
    options: [
      { label: "Any time", value: "" },
      { label: "30 days or more", value: "30" },
      { label: "60 days or more", value: "60" },
      { label: "90 days or more", value: "90" },
    ],
    placement: "primary",
    priority: 1,
    providers: ["codex", "claude-code"],
    showsUnknownActivityNote: true,
    type: "select",
  },
  {
    defaultValue: "all",
    icon: Archive,
    id: "archiveStatus",
    label: "Status",
    options: [
      { label: "All sessions", value: "all" },
      { label: "Active", value: "active" },
      { label: "Archived", value: "archived" },
    ],
    placement: "overflow",
    priority: 3,
    providers: ["codex", "claude-code"],
    type: "select",
  },
  {
    defaultValue: false,
    icon: Bot,
    id: "internals",
    label: "Subagent sessions",
    placement: "overflow",
    priority: 2,
    providers: ["codex"],
    type: "toggle",
  },
  {
    defaultValue: false,
    icon: GitBranch,
    id: "supporting",
    label: "Supporting sessions",
    placement: "overflow",
    priority: 1,
    providers: ["codex"],
    type: "toggle",
  },
];

const DEFAULT_FILTER_VALUES = Object.fromEntries(FILTER_REGISTRY.map(({ defaultValue, id }) => [id, defaultValue]));
const PROVIDER_ICONS = {
  "claude-code": AnthropicIcon,
  codex: OpenAIIcon,
};

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

const workspaceOptionLabel = ({ path: workspacePath, sessionCount, transcriptBytes }) => {
  const sessionLabel = `${sessionCount.toLocaleString()} ${sessionCount === 1 ? "session" : "sessions"}`;
  const sizeLabel = fileSize(transcriptBytes);
  if (!workspacePath) return `Workspace not recorded · ${sizeLabel} · ${sessionLabel}`;
  const parts = workspacePath.replace(/[\\/]+$/u, "").split(/[\\/]/u).filter(Boolean);
  const parent = parts.length > 1 ? ` — …/${parts.at(-2)}` : "";
  return `${folderName(workspacePath)} · ${sizeLabel} · ${sessionLabel}${parent}`;
};

const selectionRecord = ({ cwd, displayName, transcriptBytes, updatedAtMs }) => ({
  cwd,
  displayName,
  transcriptBytes,
  updatedAtMs,
});

const percentLabel = (share) => {
  const percent = share * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
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
  "exact-supported": "tested",
  newer: "not yet tested",
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
  if (record.providerId === "claude-code") return record.surface === "desktop"
    ? { icon: Bot, label: "Desktop" }
    : { icon: Database, label: "CLI" };
  if (record.isSubagent) return { icon: Bot, label: "Subagent" };
  if (record.isFork) return { icon: GitBranch, label: "Fork" };
  if (record.isPinned) return { icon: Pin, label: "Pinned" };
  return null;
}

function App() {
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [configReady, setConfigReady] = useState(false);
  const [providers, setProviders] = useState({});
  const [records, setRecords] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [selectedRecords, setSelectedRecords] = useState(new Map());
  const [selectionTrayExpanded, setSelectionTrayExpanded] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [inspected, setInspected] = useState(null);
  const [filterValues, setFilterValues] = useState(DEFAULT_FILTER_VALUES);
  const [sort, setSort] = useState("updated");
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
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [showShortcutSheet, setShowShortcutSheet] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isOverviewLoading, setIsOverviewLoading] = useState(true);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isPlanRefreshing, setIsPlanRefreshing] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const compatibilityRef = useRef(null);
  const inspectController = useRef(null);
  const inspectSequence = useRef(0);
  const loadSequence = useRef(0);
  const loadController = useRef(null);
  const planSequence = useRef(0);
  const overviewSequence = useRef(0);
  const rowRefs = useRef([]);
  const searchInputRef = useRef(null);
  const selectPageRef = useRef(null);
  const shouldScrollCursor = useRef(false);
  const keyboardStateRef = useRef(null);

  const {
    archiveStatus,
    inactiveDays,
    internals,
    search,
    supporting,
    workspace,
  } = filterValues;

  const setFilter = (id, value) => setFilterValues((current) => ({ ...current, [id]: value }));

  const resetFilters = () => setFilterValues(DEFAULT_FILTER_VALUES);

  const clearSelection = () => {
    setSelected(new Set());
    setSelectedRecords(new Map());
    setSelectionTrayExpanded(false);
  };

  const closeInspector = () => {
    inspectSequence.current += 1;
    inspectController.current?.abort();
    setInspected(null);
  };

  const load = async ({ providerId = activeProviderId, queryOverrides = {} } = {}) => {
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
        provider: providerId,
        refresh: String(Boolean(query.refresh)),
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

  const loadOverview = async ({ providerId = activeProviderId, refresh = false } = {}) => {
    const sequence = ++overviewSequence.current;
    try {
      setIsOverviewLoading(true);
      setOverviewError("");
      const suffix = new URLSearchParams({ provider: providerId });
      if (refresh) suffix.set("refresh", "true");
      const nextOverview = (await api(`/api/session-overview?${suffix}`)).overview;
      if (sequence === overviewSequence.current) setOverview(nextOverview);
    } catch {
      if (sequence === overviewSequence.current) setOverviewError("Overview unavailable");
    } finally {
      if (sequence === overviewSequence.current) setIsOverviewLoading(false);
    }
  };

  const refreshAll = async () => {
    try {
      setIsRefreshing(true);
      setError("");
      const [diagnostic] = await Promise.all([
        api(`/api/compatibility?provider=${encodeURIComponent(activeProviderId)}`),
        load({ queryOverrides: { refresh: true } }),
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
    let cancelled = false;
    api("/api/config").then(({ activeProviderId: savedProviderId, mutationToken, providers: availableProviders }) => {
      if (cancelled) return;
      const providerId = availableProviders[savedProviderId] ? savedProviderId : "codex";
      const provider = availableProviders[providerId];
      setActiveProviderId(providerId);
      setToken(mutationToken);
      setProviders(availableProviders);
      setProviderSettings(provider);
      setProviderHomeDraft(provider.home);
      setConfigReady(true);
    }).catch((issue) => setError(issue.message));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!configReady || !activeProviderId) return undefined;
    let cancelled = false;
    setCompatibility(null);
    setOverview(null);
    api(`/api/compatibility?provider=${encodeURIComponent(activeProviderId)}`)
      .then((diagnostic) => {
        if (!cancelled) setCompatibility(diagnostic);
      })
      .catch((issue) => {
        if (!cancelled) setError(issue.message);
      });
    loadOverview({ providerId: activeProviderId });
    return () => {
      cancelled = true;
    };
  }, [activeProviderId, configReady]);

  useEffect(() => {
    setPage(1);
  }, [search, sort, internals, supporting, inactiveDays, archiveStatus, workspace]);

  useEffect(() => {
    clearSelection();
    closeInspector();
  }, [search, internals, supporting, inactiveDays, archiveStatus, workspace]);

  useEffect(() => {
    setCursorIndex(0);
  }, [activeProviderId, search, sort, internals, supporting, inactiveDays, archiveStatus, workspace, page]);

  useEffect(() => {
    setCursorIndex((current) => records.length > 0
      ? Math.min(current, records.length - 1)
      : 0);
  }, [records]);

  useEffect(() => {
    if (!shouldScrollCursor.current) return;
    rowRefs.current[cursorIndex]?.scrollIntoView({ block: "nearest" });
    shouldScrollCursor.current = false;
  }, [cursorIndex, records]);

  useEffect(() => {
    if (!configReady || !activeProviderId) return undefined;
    const timer = setTimeout(load, 120);
    return () => clearTimeout(timer);
  }, [activeProviderId, archiveStatus, configReady, inactiveDays, internals, page, search, sort, supporting, workspace]);

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
  const somePageSelected = records.some((record) => selected.has(record.id));
  const availableFilters = FILTER_REGISTRY.filter(({ providers: supportedProviders }) => supportedProviders.includes(activeProviderId));
  const activeFilters = availableFilters.filter(({ defaultValue, id }) => filterValues[id] !== defaultValue);
  const filterCount = activeFilters.length;
  const hasActiveFilters = filterCount > 0;

  useEffect(() => {
    if (selectPageRef.current) {
      selectPageRef.current.indeterminate = somePageSelected && !allPageSelected;
    }
  }, [allPageSelected, somePageSelected]);

  useEffect(() => {
    if (selected.size === 0) setSelectionTrayExpanded(false);
  }, [selected]);

  const clearFilters = resetFilters;

  const inspect = async (id) => {
    const sequence = ++inspectSequence.current;
    inspectController.current?.abort();
    const controller = new AbortController();
    inspectController.current = controller;
    const localRecord = records.find((record) => record.id === id);
    if (localRecord) setInspected(localRecord);
    else setInspected(null);
    try {
      const record = (await api(
        `/api/sessions/${encodeURIComponent(id)}?provider=${encodeURIComponent(activeProviderId)}`,
        { signal: controller.signal },
      )).record;
      if (sequence !== inspectSequence.current) return;
      setInspected(record);
      setError("");
    } catch (issue) {
      if (issue.name !== "AbortError" && sequence === inspectSequence.current) setError(issue.message);
    }
  };

  const makePlan = async (nextScope = scope, { noticeText = "", preservePlan = false } = {}) => {
    const requestSequence = ++planSequence.current;
    const previousScope = scope;
    try {
      if (!preservePlan) setPlan(null);
      if (preservePlan) {
        setScope(nextScope);
        setIsPlanRefreshing(true);
      }
      setPlanError("");
      setPlanNotice("");
      const result = await api("/api/deletion-plans", {
        method: "POST",
        body: JSON.stringify({ ids: [...selected], providerId: activeProviderId, scope: nextScope }),
      });
      if (requestSequence !== planSequence.current) return false;
      setPlan(result.plan);
      setOperation(null);
      setScope(nextScope);
      setError("");
      setPlanNotice(noticeText);
      return true;
    } catch (issue) {
      if (requestSequence !== planSequence.current) return false;
      if (preservePlan) setScope(previousScope);
      setPlanError(issue.message);
      setError(issue.message);
      return false;
    } finally {
      if (requestSequence === planSequence.current) setIsPlanRefreshing(false);
    }
  };

  const changeCleanupScope = (nextScope) => {
    if (nextScope === scope || isPlanRefreshing) return;
    makePlan(nextScope, { preservePlan: true });
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
      const nextScope = compatibility?.status === "unsupported" ? "core" : scope;
      if (await makePlan(nextScope)) setDialog(true);
    } finally {
      setIsPlanning(false);
    }
  };

  const remove = async () => {
    const plannedTranscriptBytes = plan?.transcriptBytes;
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
        const result = current.result || {};
        const backupSummary = result.recoveryBackupDeleted === true
          ? "backup verified and removed"
          : `backup kept${current.backupDirectory ? ` at ${current.backupDirectory}` : ""}`;
        const sessionCount = Number(result.deletedSessionCount) || 0;
        const transcriptCount = Number(result.deletedTranscriptCount) || 0;
        setDialog(false);
        clearSelection();
        closeInspector();
        setPlan(null);
        const unrecognizedCount = Number(current.result.unrecognizedLocationCount) || 0;
        const unrecognizedVerb = unrecognizedCount === 1 ? "was" : "were";
        const unrecognized = unrecognizedCount > 0
          ? ` ${unrecognizedCount.toLocaleString()} ${unrecognizedCount === 1 ? "location" : "locations"} in your Claude folder ${unrecognizedVerb} not recognized and ${unrecognizedVerb} not examined.`
          : "";
        setNotice({
          kind: "success",
          text: `Deleted ${sessionCount.toLocaleString()} ${sessionCount === 1 ? "session" : "sessions"} and ${transcriptCount.toLocaleString()} ${transcriptCount === 1 ? "file" : "files"} · ${fileSize(plannedTranscriptBytes)} freed · ${backupSummary}.${unrecognized}`,
        });
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
        clearSelection();
        closeInspector();
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
    setProviders((current) => ({ ...current, [activeProviderId]: provider }));
    setProviderSettings(provider);
    setProviderHomeDraft(provider.home);
    setEditingProviderHome(false);
    clearSelection();
    closeInspector();
    setPlan(null);
    setOperation(null);
    setDialog(false);
    setPage(1);
    resetFilters();
    const [diagnostic] = await Promise.all([
      api(`/api/compatibility?provider=${encodeURIComponent(activeProviderId)}`),
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
      const { provider } = await api(`/api/settings/providers/${encodeURIComponent(activeProviderId)}`, {
        method: "PUT",
        headers: { "X-Session-Steward-Token": token },
        body: JSON.stringify({ home: providerHomeDraft }),
      });
      await finishProviderHomeChange(provider, `${provider.displayName} session folder updated.`);
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
      const { provider } = await api(`/api/settings/providers/${encodeURIComponent(activeProviderId)}`, {
        method: "DELETE",
        headers: { "X-Session-Steward-Token": token },
      });
      await finishProviderHomeChange(provider, `Using the default ${provider.displayName} session folder.`);
    } catch (issue) {
      setError(issue.message);
    } finally {
      setIsSavingProviderHome(false);
    }
  };

  const selectRecords = (nextRecords) => {
    setSelected((current) => {
      const next = new Set(current);
      nextRecords.forEach(({ id }) => next.add(id));
      return next;
    });
    setSelectedRecords((current) => {
      const next = new Map(current);
      nextRecords.forEach((record) => next.set(record.id, selectionRecord(record)));
      return next;
    });
  };

  const toggle = (record) => {
    const nextSelected = !selected.has(record.id);
    setSelected((current) => {
      const next = new Set(current);
      nextSelected ? next.add(record.id) : next.delete(record.id);
      return next;
    });
    setSelectedRecords((current) => {
      const next = new Map(current);
      nextSelected
        ? next.set(record.id, selectionRecord(record))
        : next.delete(record.id);
      return next;
    });
  };

  const togglePage = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allPageSelected) records.forEach((record) => next.delete(record.id));
      else records.forEach((record) => next.add(record.id));
      return next;
    });
    setSelectedRecords((current) => {
      const next = new Map(current);
      if (allPageSelected) records.forEach((record) => next.delete(record.id));
      else records.forEach((record) => next.set(record.id, selectionRecord(record)));
      return next;
    });
  };

  const moveCursor = (offset, { selectMoved = false } = {}) => {
    if (records.length === 0) return;
    const nextIndex = Math.min(records.length - 1, Math.max(0, cursorIndex + offset));
    if (nextIndex === cursorIndex) return;
    shouldScrollCursor.current = true;
    setCursorIndex(nextIndex);
    if (selectMoved) selectRecords([records[cursorIndex], records[nextIndex]]);
  };

  const removeSelectedRecord = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setSelectedRecords((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  };

  const switchProvider = (providerId) => {
    if (providerId === activeProviderId || isDeleting || isPlanning) return;
    const provider = providers[providerId];
    setActiveProviderId(providerId);
    setProviderSettings(provider);
    setProviderHomeDraft(provider.home);
    setEditingProviderHome(false);
    clearSelection();
    closeInspector();
    setPlan(null);
    setOperation(null);
    setDialog(false);
    setPage(1);
    resetFilters();
    setOverview(null);
    setCompatibility(null);
    api("/api/settings/active-provider", {
      body: JSON.stringify({ providerId }),
      headers: { "X-Session-Steward-Token": token },
      method: "PUT",
    }).catch(() => {});
  };

  keyboardStateRef.current = {
    clearSelection,
    closeInspector,
    cursorIndex,
    dialog,
    inspect,
    inspected,
    isDeleting,
    isPlanning,
    isSavingProviderHome,
    moveCursor,
    openDeleteDialog,
    page,
    pages,
    records,
    selected,
    showCompatibilityDetails,
    showShortcutSheet,
    toggle,
    togglePage,
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      const state = keyboardStateRef.current;
      if (state.dialog) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (state.isDeleting || state.isPlanning || state.isSavingProviderHome) return;

      const target = event.target;
      const editable = target?.matches?.("input, select, textarea") || target?.isContentEditable;

      if (editable) {
        if (event.key === "Escape") target.blur();
        return;
      }

      if (state.showShortcutSheet) {
        if (event.key === "Escape" || event.key === "?") {
          event.preventDefault();
          setShowShortcutSheet(false);
        }
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        setShowCompatibilityDetails(false);
        setShowShortcutSheet(true);
        return;
      }

      if (event.key === "Escape") {
        if (state.showCompatibilityDetails) setShowCompatibilityDetails(false);
        else if (state.inspected) state.closeInspector();
        else if (state.selected.size > 0) state.clearSelection();
        return;
      }

      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      const key = event.key.toLowerCase();

      if (event.shiftKey && (key === "j" || key === "k")) {
        event.preventDefault();
        state.moveCursor(key === "j" ? 1 : -1, { selectMoved: true });
        return;
      }

      if (key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        state.moveCursor(1);
        return;
      }

      if (key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        state.moveCursor(-1);
        return;
      }

      const cursorRecord = state.records[state.cursorIndex];

      if (key === "x" && cursorRecord) {
        event.preventDefault();
        state.toggle(cursorRecord);
      } else if (key === "a" && state.records.length > 0) {
        event.preventDefault();
        state.togglePage();
      } else if ((event.key === "Enter" || key === "o") && cursorRecord) {
        if (event.key === "Enter" && target?.closest?.("button, a")) return;
        event.preventDefault();
        state.inspect(cursorRecord.id);
      } else if (event.key === "[" && state.page > 1) {
        event.preventDefault();
        setPage(state.page - 1);
      } else if (event.key === "]" && state.page < state.pages) {
        event.preventDefault();
        setPage(state.page + 1);
      } else if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        if (state.selected.size > 0) state.openDeleteDialog();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const activeProviderName = providerSettings?.displayName || "Codex";

  return <main className="app-shell min-h-screen text-primary">
    <div className={`relative mx-auto max-w-[1380px] px-4 py-5 sm:px-6 sm:py-8 lg:px-8 ${selected.size > 0 ? "has-selection-tray" : ""} ${selectionTrayExpanded ? "has-selection-tray-expanded" : ""}`}>
      <header className="mb-5 flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3.5">
          <div className="brand-mark"><ShieldCheck size={23}/></div>
          <div>
            <p className="brand-kicker">Local AI Session Manager</p>
            <h1 className="brand-title">Session Steward</h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="provider-switch" aria-label="Session provider">{Object.entries(providers).map(([id, provider]) => {
            const ProviderIcon = PROVIDER_ICONS[id];
            return <button key={id} type="button" disabled={isDeleting || isPlanning} aria-pressed={activeProviderId === id} onClick={() => switchProvider(id)}><ProviderIcon size={14}/><span>{provider.displayName}</span></button>;
          })}</div>
          <button disabled={isRefreshing} onClick={refreshAll} className="icon-button refresh-button" aria-label={isRefreshing ? "Refreshing sessions" : "Refresh sessions"} title="Refresh sessions"><RefreshCw size={16} className={isRefreshing ? "animate-spin" : undefined}/></button>
          <CompatibilityControl compatibilityRef={compatibilityRef} compatibility={compatibility} expanded={showCompatibilityDetails} onToggle={() => setShowCompatibilityDetails((current) => !current)} onClose={() => setShowCompatibilityDetails(false)}/>
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

      {configReady && <Overview
        error={overviewError}
        loading={isOverviewLoading}
        overview={overview}
        providerId={activeProviderId}
      />}

      <section className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_420px] 2xl:grid-cols-[minmax(0,1fr)_480px]">
        <div className="surface overflow-hidden">
          <div className="session-list-header">
            <div>
              <div className="flex items-baseline gap-2">
                <h2 className="section-title">Sessions</h2>
                <span aria-live="polite" className="shown-count">{total.toLocaleString()} shown</span>
              </div>
            </div>
            <div className="session-list-tools"><SortControl onChange={setSort} value={sort}/><p className="shortcut-hint">Press <kbd>?</kbd> for shortcuts</p></div>
          </div>

          <Filters
            activeFilters={activeFilters}
            clearFilters={clearFilters}
            filters={availableFilters}
            overview={overview}
            searchInputRef={searchInputRef}
            setFilter={setFilter}
            setShowMoreFilters={setShowMoreFilters}
            showMoreFilters={showMoreFilters}
            values={filterValues}
          />

          <div className="page-selection-row">
            <label className="selection-control"><input ref={selectPageRef} aria-checked={somePageSelected && !allPageSelected ? "mixed" : allPageSelected} checked={allPageSelected} onChange={togglePage} disabled={!records.length || isLoading} type="checkbox"/><span>Select this page</span></label>
          </div>

          <div className="min-h-[360px]">
            {isLoading
              ? <SessionSkeleton/>
              : records.length > 0
                ? <SessionRows cursorIndex={cursorIndex} inspectedId={inspected?.id} onInspect={inspect} onToggle={toggle} records={records} rowRefs={rowRefs} selected={selected} sort={sort}/>
                : <EmptyState hasActiveFilters={hasActiveFilters} onClear={clearFilters}/>
            }
          </div>

          <Pagination page={page} pages={pages} numbers={pageNumbers} setPage={setPage}/>
        </div>

        <Inspector key={`${activeProviderId}:${inspected?.id ?? "empty"}`} onClose={closeInspector} onOpenSession={inspect} providerId={activeProviderId} record={inspected}/>
      </section>
    </div>

    {selected.size > 0 && <SelectionTray
      expanded={selectionTrayExpanded}
      isLoading={isLoading}
      isPlanning={isPlanning}
      onClear={clearSelection}
      onDelete={openDeleteDialog}
      onRemove={removeSelectedRecord}
      onToggle={() => setSelectionTrayExpanded((current) => !current)}
      records={selectedRecords}
      selectedCount={selected.size}
    />}

    {showShortcutSheet && <ShortcutSheet onClose={() => setShowShortcutSheet(false)}/>}

    {dialog && <DeletionDialog
      isDeleting={isDeleting}
      isPlanRefreshing={isPlanRefreshing}
      onCancelCleanup={cancelCleanup}
      onClose={() => setDialog(false)}
      onDelete={remove}
      onDeleteBackup={deleteRecoveryBackup}
      onRestore={restoreBackup}
      onScopeChange={changeCleanupScope}
      operation={operation}
      plan={plan}
      planError={planError}
      planNotice={planNotice}
      scope={scope}
      providerId={activeProviderId}
      providerName={activeProviderName}
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
  if (!provider) return <div className="provider-context-placeholder skeleton"/>;
  const sourceLabel = provider.source === "startup" ? "This run" : provider.isDefault ? "Default" : "Saved";

  return <section className={`provider-context ${editing ? "provider-context-editing" : ""}`}>
    <div className="provider-context-row">
      <div className="provider-context-main">
        <div className="provider-context-heading"><HardDrive size={14}/><span className="provider-context-label">{provider.homeLabel}</span><span className="source-badge">{sourceLabel}</span>{!editing && <div className="provider-context-actions"><button disabled={isSaving} onClick={onEdit} className="compact-action">Change</button>{!provider.isDefault && <button disabled={isSaving} onClick={onReset} className="compact-action">Use default</button>}</div>}</div>
        <code title={provider.home}>{provider.home}</code>
      </div>
    </div>
    {editing && <form onSubmit={onSubmit} className="provider-context-form"><label className="field"><span>Folder path</span><input autoFocus required spellCheck="false" value={value} onChange={(event) => onChange(event.target.value)} placeholder={provider.homePlaceholder}/></label><div className="mt-3 flex justify-end gap-2"><button type="button" disabled={isSaving} onClick={onCancel} className="button ghost">Cancel</button><button type="submit" disabled={isSaving || !value.trim()} className="button primary">{isSaving ? "Saving" : "Save folder"}</button></div></form>}
  </section>;
}

function Overview({ error, loading, overview, providerId }) {
  const metrics = providerId === "claude-code" ? [
    { icon: HardDrive, label: "On disk", primary: true, value: overview ? fileSize(overview.transcriptBytes) : undefined },
    { icon: Database, label: "All sessions", value: overview?.sessionCount.toLocaleString() },
    { icon: FileText, label: "CLI sessions", value: overview?.cliSessionCount?.toLocaleString() },
    { icon: Bot, label: "Desktop sessions", value: overview?.desktopSessionCount?.toLocaleString() },
  ] : [
    {
      icon: HardDrive,
      label: "On disk",
      primary: true,
      value: overview ? fileSize(overview.transcriptBytes) : undefined,
    },
    {
      icon: Database,
      label: "All sessions",
      value: overview?.sessionCount.toLocaleString(),
    },
    {
      icon: FileText,
      label: "Primary sessions",
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
  ];

  return <section aria-label="Session overview" className="overview-strip" style={{ "--overview-columns": metrics.length }}>
    {metrics.map(({ icon: Icon, label, primary, value }) => <div key={label} className={`overview-item ${primary ? "overview-item-primary" : ""}`}>
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

function filterOptions(filter, overview) {
  if (filter.options === "workspaces") {
    return [
      { label: "All workspaces", value: ALL_WORKSPACES },
      ...(overview?.workspaces || []).map((item) => ({
        label: workspaceOptionLabel(item),
        title: item.path || "Workspace not recorded",
        value: item.path,
      })),
    ];
  }
  return filter.options || [];
}

function filterValueLabel(filter, overview, value) {
  if (filter.type === "search") return value;
  if (filter.type === "toggle") return filter.label;
  return filterOptions(filter, overview).find((option) => option.value === value)?.label || value;
}

function filterChipLabel(filter, overview, value) {
  return filter.type === "toggle"
    ? filter.label
    : `${filter.label}: ${filterValueLabel(filter, overview, value)}`;
}

function Filters({ activeFilters, clearFilters, filters, overview, searchInputRef, setFilter, setShowMoreFilters, showMoreFilters, values }) {
  const primaryFilters = filters.filter(({ placement }) => placement === "primary").sort((a, b) => b.priority - a.priority);
  const overflowFilters = filters.filter(({ placement }) => placement === "overflow").sort((a, b) => b.priority - a.priority);
  const activeOverflowCount = overflowFilters.filter(({ defaultValue, id }) => values[id] !== defaultValue).length;
  const searchFilter = primaryFilters.find(({ type }) => type === "search");
  const demotableFilters = primaryFilters.filter(({ type }) => type !== "search");

  return <section className="session-filters" aria-label="Session filters">
    <div className="filter-bar">
      {searchFilter && <FilterControl filter={searchFilter} inputRef={searchInputRef} onChange={setFilter} options={filterOptions(searchFilter, overview)} value={values[searchFilter.id]}/>}
      <div className="filter-primary-controls">{demotableFilters.map((filter) => <FilterControl key={filter.id} className={`filter-priority-${filter.priority}`} filter={filter} onChange={setFilter} options={filterOptions(filter, overview)} value={values[filter.id]}/>)}</div>
      <div className="more-filters-wrap">
        <button type="button" aria-label="More filters" aria-expanded={showMoreFilters} onClick={() => setShowMoreFilters((current) => !current)} className={`more-filters-button ${activeOverflowCount > 0 ? "more-filters-active" : ""}`}><SlidersHorizontal size={15}/><span>More filters</span>{activeOverflowCount > 0 && <strong>{activeOverflowCount}</strong>}</button>
      </div>
    </div>
    {showMoreFilters && <div className="more-filters-row">
      <div className="filter-overflow-primary">{demotableFilters.map((filter) => <FilterControl key={filter.id} className={`filter-priority-${filter.priority}`} filter={filter} onChange={setFilter} options={filterOptions(filter, overview)} value={values[filter.id]}/>)}</div>
      <div className="filter-overflow-controls">{overflowFilters.map((filter) => <FilterControl key={filter.id} filter={filter} onChange={setFilter} options={filterOptions(filter, overview)} value={values[filter.id]}/>)}</div>
    </div>}
    <ActiveFilterRow activeFilters={activeFilters} clearFilters={clearFilters} overview={overview} setFilter={setFilter} values={values}/>
    {activeFilters.some(({ showsUnknownActivityNote }) => showsUnknownActivityNote) && overview?.unknownActivityCount > 0 && <p className="unknown-activity-note">{overview.unknownActivityCount.toLocaleString()} sessions with unknown activity are not included.</p>}
  </section>;
}

function FilterControl({ className = "", filter, inputRef, onChange, options, value }) {
  const Icon = filter.icon;
  if (filter.type === "toggle") {
    return <Toggle checked={value} className={className} onChange={(checked) => onChange(filter.id, checked)}><Icon size={13}/><span>{filter.label}</span></Toggle>;
  }
  if (filter.type === "search") {
    return <label className={`field filter-search ${className}`}><span><Icon size={13}/>{filter.label}</span><div className="input-wrap"><Search size={16}/><input ref={inputRef} value={value} onChange={(event) => onChange(filter.id, event.target.value)} placeholder={filter.placeholder}/>{value && <button type="button" onClick={() => onChange(filter.id, filter.defaultValue)} aria-label="Clear search"><X size={14}/></button>}</div></label>;
  }
  return <label className={`field filter-select ${className}`}><span><Icon size={13}/>{filter.label}</span><select value={value} onChange={(event) => onChange(filter.id, event.target.value)}>{options.map((option) => <option key={option.value || "__default__"} title={option.title} value={option.value}>{option.label}</option>)}</select></label>;
}

function SortControl({ onChange, value }) {
  return <label className="sort-control"><span>Sort</span><select aria-label="Sort sessions" value={value} onChange={(event) => onChange(event.target.value)}><option value="updated">Last activity</option><option value="created">Created</option><option value="name">Name</option><option value="cwd">Workspace</option><option value="size">Largest first</option></select></label>;
}

function Toggle({ checked, children, className = "", onChange }) {
  return <label className={`toggle ${className} ${checked ? "toggle-active" : ""}`}><input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox"/><span className="toggle-track"><span/></span><span className="toggle-copy">{children}</span></label>;
}

function SessionRow({ cursor, inspected, onInspect, onToggle, record, rowRef, selected }) {
  const kind = getSessionKind(record);
  const KindIcon = kind?.icon;

  return <div ref={rowRef} className={`session-row group ${cursor ? "session-row-cursor" : ""} ${inspected ? "session-row-inspected" : ""} ${selected ? "session-row-selected" : ""}`}>
    <label className="session-checkbox" aria-label={`Select ${record.displayName}`}><input checked={selected} onChange={() => onToggle(record)} type="checkbox"/></label>
    <button type="button" onClick={() => onInspect(record.id)} className="min-w-0 text-left">
      <span className="session-title" title={record.displayName}>{record.displayName}</span>
      <span className="session-workspace"><FolderKanban size={12} className="shrink-0"/><span className="truncate" title={record.cwd || undefined}>{folderName(record.cwd)}</span>{record.archived && <span className="archive-tag"><Archive size={10}/>Archived</span>}</span>
    </button>
    <div className="session-row-meta">
      {Number.isFinite(record.transcriptBytes) && <span aria-label={`Transcript ${fileSize(record.transcriptBytes)}`} className="size-badge" title="Transcript"><HardDrive size={11}/>{fileSize(record.transcriptBytes)}</span>}
      <span className="time-badge" title={fullDate(record.updatedAtMs)}><Clock3 size={11}/>{age(record.updatedAtMs)}</span>
      {kind && <span className="kind-label"><KindIcon size={11}/>{kind.label}</span>}
    </div>
    <ChevronRight size={16} className="session-row-chevron"/>
  </div>;
}

function SessionRows({ cursorIndex, inspectedId, onInspect, onToggle, records, rowRefs, selected, sort }) {
  const renderTime = Date.now();
  let previousGroup = null;

  return <div className="session-rows">{records.map((record, index) => {
    const group = sessionDateGroupForSort(record, sort, renderTime);
    const showGroup = Boolean(group) && group !== previousGroup;
    previousGroup = group;

    return <div className={`session-row-block ${showGroup ? "session-row-block-grouped" : ""}`} key={record.id}>
      {showGroup && <div aria-label={group} className="date-separator" role="separator"><span>{group}</span><span aria-hidden="true" className="date-separator-line"/></div>}
      <SessionRow cursor={cursorIndex === index} inspected={inspectedId === record.id} onInspect={onInspect} onToggle={onToggle} record={record} rowRef={(node) => { rowRefs.current[index] = node; }} selected={selected.has(record.id)}/>
    </div>;
  })}</div>;
}

function ActiveFilterRow({ activeFilters, clearFilters, overview, setFilter, values }) {
  const [displayedFilters, setDisplayedFilters] = useState(() => activeFilters.map((filter) => ({
    exiting: false,
    filter,
    value: values[filter.id],
  })));

  useEffect(() => {
    const activeIds = new Set(activeFilters.map(({ id }) => id));
    setDisplayedFilters((current) => [
      ...activeFilters.map((filter) => ({
        exiting: false,
        filter,
        value: values[filter.id],
      })),
      ...current
        .filter(({ filter }) => !activeIds.has(filter.id))
        .map((item) => ({ ...item, exiting: true })),
    ]);
  }, [activeFilters, values]);

  useEffect(() => {
    if (!displayedFilters.some(({ exiting }) => exiting)) return undefined;
    const timer = setTimeout(() => {
      setDisplayedFilters((current) => current.filter(({ exiting }) => !exiting));
    }, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 140);
    return () => clearTimeout(timer);
  }, [displayedFilters]);

  if (displayedFilters.length === 0) return null;

  return <div className={`active-filter-row ${activeFilters.length === 0 ? "active-filter-row-clearing" : ""}`}>
    <div className="active-filter-chips">{displayedFilters.map(({ exiting, filter, value }) => <button aria-hidden={exiting || undefined} className={`filter-chip ${exiting ? "filter-chip-exiting" : ""}`} disabled={exiting} key={filter.id} onClick={() => setFilter(filter.id, filter.defaultValue)} tabIndex={exiting ? -1 : undefined} type="button"><span>{filterChipLabel(filter, overview, value)}</span><X size={12}/></button>)}</div>
    {activeFilters.length > 1 && <button className="clear-all-filters" onClick={clearFilters} type="button">Clear all</button>}
  </div>;
}

function SelectionTray({ expanded, isLoading, isPlanning, onClear, onDelete, onRemove, onToggle, records, selectedCount }) {
  const entries = [...records.entries()];
  const transcriptBytes = entries.reduce((sum, [, record]) => Number.isFinite(record.transcriptBytes)
    ? sum + record.transcriptBytes
    : sum, 0);
  const withoutTranscript = entries.filter(([, record]) => record.transcriptBytes === null).length;
  const summary = `${selectedCount.toLocaleString()} ${selectedCount === 1 ? "session" : "sessions"} selected · ${fileSize(transcriptBytes)}${withoutTranscript > 0 ? ` · ${withoutTranscript.toLocaleString()} without a transcript` : ""}`;

  return <section aria-label="Selected sessions" className={`selection-tray ${expanded ? "selection-tray-expanded" : ""}`}>
    {expanded && <div className="selection-tray-review">
      <div className="selection-tray-review-heading"><div><p className="selection-tray-heading">Selected sessions</p><p className="selection-tray-copy">Review selections from every page.</p></div><span className="selection-tray-count" key={selectedCount}>{selectedCount.toLocaleString()}</span></div>
      <div className="selection-tray-records">{entries.map(([id, record]) => <div key={id} className="selection-tray-record"><div className="min-w-0"><p className="selection-tray-title">{record.displayName}</p><p className="selection-tray-meta"><FolderKanban size={11}/><span className="truncate">{folderName(record.cwd)}</span><span aria-hidden="true">·</span><HardDrive size={11}/><span>{Number.isFinite(record.transcriptBytes) ? fileSize(record.transcriptBytes) : "No transcript"}</span></p></div><button type="button" onClick={() => onRemove(id)} aria-label={`Remove ${record.displayName} from selection`} className="icon-button"><X size={15}/></button></div>)}</div>
    </div>}
    <div className="selection-tray-bar">
      <p aria-live="polite" className="selection-tray-summary"><span className="selection-tray-summary-value" key={summary}>{summary}</span></p>
      <div className="selection-tray-actions"><button type="button" aria-expanded={expanded} onClick={onToggle} className="button secondary">{expanded ? "Hide review" : "Review"}</button><button type="button" onClick={onClear} className="button ghost">Clear</button><button type="button" disabled={isLoading || isPlanning} onClick={onDelete} className="button danger">{isPlanning ? <RefreshCw size={15} className="animate-spin"/> : <Trash2 size={15}/>} {isPlanning ? "Preparing" : "Delete"}</button></div>
    </div>
  </section>;
}

function ShortcutSheet({ onClose }) {
  const closeRef = useRef(null);
  const groups = [
    {
      label: "Navigate",
      shortcuts: [
        { action: "Next session", keys: "J / ↓" },
        { action: "Previous session", keys: "K / ↑" },
        { action: "Open session details", keys: "Enter / O" },
        { action: "Focus search", keys: "/" },
        { action: "Previous or next page", keys: "[ / ]" },
      ],
    },
    {
      label: "Select",
      shortcuts: [
        { action: "Toggle cursor session", keys: "X" },
        { action: "Move and select", keys: "Shift + J / K" },
        { action: "Toggle this page", keys: "A" },
        { action: "Close details or clear selection", keys: "Escape" },
      ],
    },
    {
      label: "Act",
      shortcuts: [
        { action: "Review cleanup", keys: "Backspace / Delete" },
        { action: "Show or hide shortcuts", keys: "?" },
      ],
    },
  ];

  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" aria-labelledby="shortcut-title" aria-describedby="shortcut-description" className="shortcut-panel"><div className="flex items-start justify-between gap-4"><div><p className="panel-label">Keyboard control</p><h2 id="shortcut-title" className="dialog-title">Keyboard shortcuts</h2><p id="shortcut-description" className="dialog-copy">Review and select sessions without leaving the keyboard.</p></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close keyboard shortcuts" className="icon-button"><X size={17}/></button></div><div className="shortcut-groups">{groups.map((group) => <section key={group.label}><h3>{group.label}</h3><dl>{group.shortcuts.map((shortcut) => <div key={shortcut.action}><dt>{shortcut.action}</dt><dd><kbd>{shortcut.keys}</kbd></dd></div>)}</dl></section>)}</div></section></div>;
}

function SessionSkeleton() {
  return <div className="session-rows" aria-label="Loading sessions">{Array.from({ length: 6 }, (_, index) => <div key={index} className="session-row session-row-skeleton"><div className="skeleton size-4 rounded"/><div className="min-w-0"><div className="skeleton h-3.5 w-[min(75%,30rem)] rounded"/><div className="skeleton mt-1.5 h-3 w-[min(50%,20rem)] rounded"/></div><div className="session-row-meta"><div className="skeleton badge-skeleton"/><div className="skeleton badge-skeleton"/><div className="skeleton badge-skeleton kind-skeleton"/></div><div/></div>)}</div>;
}

function EmptyState({ hasActiveFilters, onClear }) {
  return <div className="empty-state"><div><div className="empty-state-icon"><Search size={19}/></div><h3>{hasActiveFilters ? "No sessions match these filters" : "No sessions found"}</h3><p>{hasActiveFilters ? "Adjust the filters to see more sessions." : "Session Steward did not find any sessions in this folder."}</p>{hasActiveFilters && <button type="button" onClick={onClear} className="button secondary mt-4">Clear filters</button>}</div></div>;
}

function Inspector({ onClose, onOpenSession, providerId, record }) {
  const relatedIds = record ? [...new Set([
    record.parentThreadId,
    record.forkedFromId,
    ...(record.childThreadIds ?? []),
  ].filter((id) => id && id !== record.id))] : [];

  return <><button type="button" aria-label="Close session details" onClick={onClose} className={`inspector-backdrop ${record ? "inspector-backdrop-open" : ""}`}/><aside className={`surface inspector ${record ? "inspector-open" : ""}`}>
    <div className="inspector-header"><p className="panel-label">Session details</p>{record && <button type="button" onClick={onClose} aria-label="Close session details" className="icon-button lg:hidden"><X size={16}/></button>}</div>
    {record
      ? <div><div className="inspector-content"><div className="min-w-0"><h2 className="inspector-title">{record.displayName}</h2><p className="inspector-id">{record.id}</p></div><ul aria-label="Session labels" className="inspector-chips">{[
        record.archived ? "Archived" : "Active",
        // The provider toggle already names the provider, so the chip stays short
        record.isSubagent ? "Subagent" : record.isFork ? "Fork" : "Primary session",
        ...(record.surface ? [record.surface === "desktop" ? "Claude Desktop" : "Claude Code CLI"] : []),
      ].map((chip) => <li className="inspector-chip" key={chip}>{chip}</li>)}</ul><dl className="inspector-details"><Detail label="Last activity" value={fullDate(record.updatedAtMs)}/><Detail label="Transcript" value={record.rolloutMissing ? "Missing" : Number.isFinite(record.transcriptBytes) ? `Available · ${fileSize(record.transcriptBytes)}` : "Available"}/><Detail label="Workspace" value={record.cwd || "Not recorded"} wide/></dl></div><InspectorTabs key={record.id} onOpenSession={onOpenSession} providerId={providerId} record={record} relatedIds={relatedIds}/></div>
      : <div className="inspector-empty"><div><div className="inspector-empty-icon"><Info size={18}/></div><h2>Select a session</h2><p>Its location, activity, and linked sessions will appear here.</p></div></div>}
  </aside></>;
}

const INSPECTOR_TABS = [
  { id: "timeline", label: "Timeline" },
  { id: "related", label: "Related" },
];

function InspectorTabs({ onOpenSession, providerId, record, relatedIds }) {
  const [selectedTab, setSelectedTab] = useState("timeline");
  const tabRefs = useRef(new Map());

  function moveFocus(event) {
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (offset === 0) return;
    event.preventDefault();
    const index = INSPECTOR_TABS.findIndex(({ id }) => id === selectedTab);
    const next = INSPECTOR_TABS[(index + offset + INSPECTOR_TABS.length) % INSPECTOR_TABS.length];
    setSelectedTab(next.id);
    tabRefs.current.get(next.id)?.focus();
  }

  return <><div className="inspector-tabs" role="tablist" aria-label="Session details sections" onKeyDown={moveFocus}>{INSPECTOR_TABS.map(({ id, label }) => <button
    aria-controls={`inspector-panel-${id}`}
    aria-label={id === "related" ? `Related, ${relatedIds.length.toLocaleString()} linked ${relatedIds.length === 1 ? "session" : "sessions"}` : label}
    aria-selected={selectedTab === id}
    id={`inspector-tab-${id}`}
    key={id}
    onClick={() => setSelectedTab(id)}
    ref={(node) => { if (node) tabRefs.current.set(id, node); else tabRefs.current.delete(id); }}
    role="tab"
    tabIndex={selectedTab === id ? 0 : -1}
    type="button"
  >{label}{id === "related" && <span className="inspector-tab-count">{relatedIds.length.toLocaleString()}</span>}</button>)}</div>
    <div aria-labelledby="inspector-tab-timeline" className="inspector-tabpanel" hidden={selectedTab !== "timeline"} id="inspector-panel-timeline" role="tabpanel" tabIndex={0}>
      <SessionTimeline providerId={providerId} record={record}/>
    </div>
    <div aria-labelledby="inspector-tab-related" className="inspector-tabpanel" hidden={selectedTab !== "related"} id="inspector-panel-related" role="tabpanel" tabIndex={0}>
      <RelatedSessions ids={relatedIds} onOpenSession={onOpenSession} providerId={providerId}/>
    </div></>;
}

function RelatedSessions({ ids, onOpenSession, providerId }) {
  const [records, setRecords] = useState({});
  const [visibleCount, setVisibleCount] = useState(20);
  const visibleIds = ids.slice(0, visibleCount);
  const visibleKey = visibleIds.join("\u0000");

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    Promise.all(visibleIds.map(async (id) => {
      try {
        const result = await api(`/api/sessions/${encodeURIComponent(id)}?provider=${encodeURIComponent(providerId)}`, {
          signal: controller.signal,
        });
        return [id, result.record];
      } catch (error) {
        if (error.name === "AbortError") throw error;
        return [id, null];
      }
    })).then((entries) => {
      if (current) setRecords(Object.fromEntries(entries));
    }).catch((error) => {
      if (error.name !== "AbortError") setRecords({});
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [providerId, visibleKey]);

  if (ids.length === 0) {
    return <section className="related-sessions"><div className="timeline-empty"><GitBranch size={18}/><h3>No linked sessions</h3><p>This session has no parent, fork, or subagent sessions.</p></div></section>;
  }

  return <section className="related-sessions"><div className="timeline-heading"><div><p className="panel-label">Related sessions</p><p>{ids.length.toLocaleString()} linked {ids.length === 1 ? "session" : "sessions"}</p></div></div><div className="related-session-list">{visibleIds.map((id) => {
    const related = records[id];
    return <button key={id} type="button" onClick={() => onOpenSession(id)}><GitBranch size={13}/><span className="related-session-copy"><strong>{related?.displayName || "Loading session details"}</strong>{related && <small>{Number.isFinite(related.transcriptBytes) ? fileSize(related.transcriptBytes) : "Size not recorded"} · {age(related.updatedAtMs)}</small>}<code>{id}</code></span><ChevronRight size={13}/></button>;
  })}</div>{visibleCount < ids.length && <button type="button" onClick={() => setVisibleCount((current) => current + 20)} className="timeline-more">View more related sessions</button>}</section>;
}

// Fixed slot order: colour follows the segment, never its rank, and this order
// is what the palette was validated against for colour-blind separation.
const COMPOSITION_SEGMENTS = [
  { key: "toolOutput", label: "Tool output" },
  { key: "largeRecords", label: "Large records" },
  { key: "compaction", label: "Compaction history" },
  { key: "attachments", label: "Attachments" },
  { key: "messages", label: "Messages" },
  { key: "edits", label: "File edits" },
  { key: "reasoning", label: "Reasoning" },
  { key: "other", label: "Other" },
];

function TranscriptComposition({ composition }) {
  const [active, setActive] = useState(null);
  if (!composition || composition.total === 0) return null;

  const present = COMPOSITION_SEGMENTS
    .map((segment) => ({
      ...segment,
      bytes: composition[segment.key],
      share: composition[segment.key] / composition.total,
    }))
    .filter(({ bytes }) => bytes > 0);
  if (present.length === 0) return null;

  const ranked = [...present].sort((left, right) => right.bytes - left.bytes);
  const describe = ({ bytes, label, share }) => `${label} — ${fileSize(bytes)} (${percentLabel(share)})`;

  return <section className="composition">
    <div className="composition-heading"><p className="panel-label">Where the space goes</p><p>{fileSize(composition.total)}</p></div>
    <div aria-hidden="true" className="composition-bar" onMouseLeave={() => setActive(null)}>{present.map((segment) => <span
      className={`composition-segment ${active && active !== segment.key ? "composition-segment-muted" : ""}`}
      key={segment.key}
      onMouseEnter={() => setActive(segment.key)}
      style={{ background: `var(--segment-${segment.key})`, flexGrow: segment.bytes }}
      title={describe(segment)}
    />)}</div>
    <dl className="composition-legend">{ranked.map((segment) => <div
      className={`composition-legend-row ${active && active !== segment.key ? "composition-segment-muted" : ""}`}
      key={segment.key}
      onMouseEnter={() => setActive(segment.key)}
      onMouseLeave={() => setActive(null)}
    >
      <dt><span aria-hidden="true" className="composition-swatch" style={{ background: `var(--segment-${segment.key})` }}/>{segment.label}</dt>
      <dd>{fileSize(segment.bytes)}<span>{percentLabel(segment.share)}</span></dd>
    </div>)}</dl>
  </section>;
}

function SessionTimeline({ providerId, record }) {
  const [eventLimit, setEventLimit] = useState(SESSION_EVENT_BATCH_SIZE);
  const [eventsError, setEventsError] = useState("");
  const [isLoadingEvents, setIsLoadingEvents] = useState(true);
  const [requestVersion, setRequestVersion] = useState(0);
  const [result, setResult] = useState(null);
  const [showInjected, setShowInjected] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setIsLoadingEvents(true);
    setEventsError("");
    const params = new URLSearchParams({
      id: record.id,
      limit: String(eventLimit),
      provider: providerId,
    });
    api(`/api/session-events?${params}`, { signal: controller.signal })
      .then((nextResult) => {
        if (current) setResult(nextResult);
      })
      .catch((issue) => {
        if (current && issue.name !== "AbortError") setEventsError(issue.message);
      })
      .finally(() => {
        if (current) setIsLoadingEvents(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [eventLimit, providerId, record.id, requestVersion]);

  const events = result ? newestSessionEvents(result.events) : [];
  const injectedCount = events.filter((event) => event.kind === "ask" && event.injected).length;
  const displayedEvents = showInjected
    ? events
    : events.filter((event) => event.kind !== "ask" || !event.injected);
  const canShowMore = result
    && result.events.length >= eventLimit
    && eventLimit < 1_000;
  const coveragePercent = result ? sessionEventCoveragePercent(result.coverage) : null;
  const showSummary = result && !result.reason && result.window.complete;
  const allEventsShown = result && result.events.length < eventLimit;
  const renderTime = Date.now();
  let previousEventDay = null;
  const timelineEvents = displayedEvents.flatMap((event) => {
    const label = sessionDayLabel(event.atMs, renderTime);
    const showDay = Boolean(label) && label !== previousEventDay;
    if (label) previousEventDay = label;
    const renderedEvent = <SessionEvent event={event} key={`${event.sequence}:${event.kind}`}/>;
    if (!showDay) return [renderedEvent];
    return [
      <div aria-label={label} className="date-separator" key={`day:${event.sequence}:${label}`} role="separator"><span>{label}</span><span aria-hidden="true" className="date-separator-line"/></div>,
      renderedEvent,
    ];
  });

  return <section className="session-timeline" aria-busy={isLoadingEvents}>{showSummary
    ? <dl className="timeline-stats">{[
      ["Asks", result.summary.asks],
      ["Edits", result.summary.edits],
      ["Commands", result.summary.commands],
    ].map(([label, count]) => <div className="timeline-stat" key={label}><dt className="overview-label">{label}</dt><dd className="overview-value">{count.toLocaleString()}</dd></div>)}</dl>
    : null}{showSummary ? <TranscriptComposition composition={result.composition}/>
    : <div className="timeline-heading"><div><p className="panel-label">Session activity</p><p>What happened in this session</p></div></div>}<div className="timeline-region">
    {!result && isLoadingEvents && <div className="timeline-initial-loading" role="status"><RefreshCw size={16} className="animate-spin"/><span>Reading session activity</span></div>}
    {eventsError && <div className="timeline-empty"><AlertTriangle size={18}/><h3>Timeline unavailable</h3><p>{eventsError}</p><button type="button" onClick={() => setRequestVersion((current) => current + 1)} className="button secondary">Try again</button></div>}
    {result?.reason && <><SessionTimelineEmpty reason={result.reason}/><CoverageSummary coverage={result.coverage}/></>}
    {result && !result.reason && <>
      {coveragePercent < SESSION_EVENT_COVERAGE_THRESHOLD && <div className="timeline-coverage-notice" role="status"><Info size={15}/><div><strong>Some session activity could not be shown</strong><p>{coveragePercent}% recognized · {result.coverage.unmapped.toLocaleString()} unmapped · {result.coverage.unparseable.toLocaleString()} unparseable · {result.coverage.oversized.toLocaleString()} oversized</p>{result.coverage.unmappedTypes.length > 0 && <p>Not understood: {result.coverage.unmappedTypes.map(({ count, type }) => `${type} (${count.toLocaleString()})`).join(", ")}</p>}</div></div>}
      {injectedCount > 0 && <button type="button" aria-expanded={showInjected} onClick={() => setShowInjected((current) => !current)} className="injected-events-toggle">{showInjected ? "Hide" : "Show"} {injectedCount.toLocaleString()} injected context {injectedCount === 1 ? "event" : "events"}</button>}
      <p className="timeline-window-note">{allEventsShown ? `All ${result.events.length.toLocaleString()} events` : `Newest ${result.events.length.toLocaleString()} events`}</p>
      <div className="timeline-events">{timelineEvents}</div>
      {displayedEvents.length === 0 && injectedCount > 0 && <p className="timeline-quiet-empty">Only injected context was found in this batch.</p>}
      {canShowMore && <button type="button" aria-label={`Show ${SESSION_EVENT_BATCH_SIZE} more session events`} disabled={isLoadingEvents} onClick={() => setEventLimit((current) => Math.min(1_000, current + SESSION_EVENT_BATCH_SIZE))} className="timeline-more">{isLoadingEvents ? "Reading more activity…" : "Show more"}</button>}
      {coveragePercent >= SESSION_EVENT_COVERAGE_THRESHOLD && <CoverageSummary coverage={result.coverage}/>}
    </>}
  </div></section>;
}

function CoverageSummary({ coverage }) {
  const percent = sessionEventCoveragePercent(coverage);
  return <div className="timeline-coverage"><p>{percent}% recognized · {coverage.skipped.toLocaleString()} deliberately skipped{coverage.unmapped > 0 ? ` · ${coverage.unmapped.toLocaleString()} unmapped` : ""}{coverage.unparseable > 0 ? ` · ${coverage.unparseable.toLocaleString()} unparseable` : ""}{coverage.oversized > 0 ? ` · ${coverage.oversized.toLocaleString()} oversized` : ""}</p>{coverage.unmappedTypes.length > 0 && <p>Not understood: {coverage.unmappedTypes.map(({ count, type }) => `${type} (${count.toLocaleString()})`).join(", ")}</p>}</div>;
}

function SessionTimelineEmpty({ reason }) {
  const copy = {
    "no-recognized-events": {
      text: "The transcript exists, but Session Steward could not identify readable activity in it.",
      title: "No recognized activity",
    },
    "no-transcript-path": {
      text: "This session has no transcript location recorded.",
      title: "No transcript was recorded",
    },
    "transcript-missing": {
      text: "The transcript file is no longer available. The session metadata above is still intact.",
      title: "Transcript file is missing",
    },
  }[reason];

  return <div className="timeline-empty"><FileText size={18}/><h3>{copy.title}</h3><p>{copy.text}</p></div>;
}

function SessionEvent({ event }) {
  const failed = event.failed === true || event.applied === false;
  const eventDate = event.atMs ? new Date(event.atMs) : null;
  const eventDateTime = eventDate?.toISOString();
  const eventTitle = eventDate?.toLocaleString([], { dateStyle: "full", timeStyle: "long" });
  const eventTime = eventDate?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) ?? "Time not recorded";
  return <article className={`timeline-event timeline-event-${event.kind} ${failed ? "timeline-event-failed" : ""} ${event.injected ? "timeline-event-injected" : ""}`}><header><span>{event.kind}</span><time dateTime={eventDateTime} title={eventTitle}>{eventTime}</time></header><SessionEventBody event={event}/></article>;
}

function SessionEventBody({ event }) {
  if (["ask", "said", "summary"].includes(event.kind)) {
    return <ExpandableEventText actionLabel={event.kind === "summary" ? "summary" : "message"} value={event.text}/>;
  }
  if (event.kind === "edit") {
    const changeSummary = Number.isInteger(event.added) && Number.isInteger(event.removed)
      ? `+${event.added}/-${event.removed}`
      : "Changes not counted";
    const outcome = event.applied === true ? "Applied" : event.applied === false ? "Not applied" : "Outcome not recorded";
    return <><ScrollableEventText label="file paths" value={event.files.length > 0 ? event.files.join(" · ") : "File path not recorded"}/><p className="timeline-event-meta">{changeSummary} · {outcome}</p></>;
  }
  if (event.kind === "ran") {
    return <><ScrollableEventText label="command" value={event.command || (event.unextracted ? "Command details could not be read" : "Command not recorded")}/>{event.failed === true && <ExpandableEventText actionLabel="output" value={event.error || "Command failed."}/>}<p className="timeline-event-meta">{event.failed === true ? "Failed" : event.failed === false ? "Completed" : "Outcome not recorded"}</p>{event.workdir && <div className="timeline-secondary-value"><span>Working folder</span><ScrollableEventText label="working folder" value={event.workdir}/></div>}</>;
  }
  if (event.kind === "decided") {
    return <><ExpandableEventText actionLabel="question" value={event.question}/>{event.answer && <div className="timeline-secondary-value"><span>Answer</span><ExpandableEventText actionLabel="answer" value={event.answer}/></div>}</>;
  }
  const statuses = new Map();
  for (const step of event.steps) statuses.set(step.status, (statuses.get(step.status) ?? 0) + 1);
  return <p className="timeline-plan-summary">{[...statuses].map(([status, count]) => `${count} ${status.replaceAll("_", " ")}`).join(" · ") || "No steps recorded"}</p>;
}

function ExpandableEventText({ actionLabel, value }) {
  const [expanded, setExpanded] = useState(false);
  const display = sessionEventText(value, expanded);
  return <div className="timeline-event-copy"><p>{display.text}</p>{display.expandable && <button type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? "Show less" : `Show full ${actionLabel}`}</button>}{expanded && display.capped && <span>Showing the first 2,000 characters.</span>}</div>;
}

function ScrollableEventText({ label, value }) {
  const [expanded, setExpanded] = useState(false);
  const display = sessionEventText(value, expanded);
  return <div className="timeline-scroll-copy"><div tabIndex={0}>{display.text}</div>{display.expandable && <button type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? "Show less" : `Show full ${label}`}</button>}</div>;
}

function Detail({ label, value, wide = false }) {
  return <div className={`detail-row${wide ? " detail-row-wide" : ""}`}><dt>{label}</dt><dd>{value}</dd></div>;
}

function Pagination({ page, pages, numbers, setPage }) {
  return <div className="pagination"><span>Page <strong>{page}</strong> of {pages}</span><div className="flex items-center gap-1"><button aria-label="Previous page" disabled={page === 1} onClick={() => setPage(page - 1)} className="page-button"><ChevronLeft size={15}/></button><div className="hidden items-center gap-1 sm:flex">{numbers.map((number) => <button key={number} onClick={() => setPage(number)} aria-current={page === number ? "page" : undefined} className="page-button">{number}</button>)}</div><button aria-label="Next page" disabled={page === pages} onClick={() => setPage(page + 1)} className="page-button"><ChevronRight size={15}/></button></div></div>;
}

function CompatibilityControl({ compatibility, compatibilityRef, expanded, onToggle, onClose }) {
  if (!compatibility) return <div className="skeleton h-9 w-32 rounded-full"/>;
  const providerName = compatibility.providerId === "claude-code" ? "Claude Code" : "Codex";
  const copy = compatibility.status === "ready"
    ? { title: "Cleanup supported", text: `Session Steward recognizes this ${providerName} data.`, tone: "status-ready" }
    : compatibility.status === "partial"
      ? { title: "Cleanup available", text: `Recognized ${providerName} session data can be cleaned. The details below are left unchanged.`, tone: "status-partial" }
      : { title: "Update needed", text: `Thorough cleanup is paused because some ${providerName} session data is stored in a way Session Steward does not recognize yet.`, tone: "status-error" };
  const details = [
    ...compatibility.missing,
    ...compatibility.changed,
    ...(compatibility.providerId === "claude-code" ? compatibility.unrecognized : compatibility.newlyDiscovered),
  ];

  return <div ref={compatibilityRef} className="relative"><button onClick={onToggle} aria-expanded={expanded} className={`status-pill ${copy.tone}`}><span/>{copy.title}</button>{expanded && <section className="compatibility-popover"><div className="flex items-start justify-between gap-3"><div><p className="popover-title">Compatibility</p><p className="popover-copy">{copy.text}</p></div><button onClick={onClose} aria-label="Close compatibility details" className="icon-button"><X size={15}/></button></div><div className="version-list">{compatibility.providerId === "claude-code" ? <><VersionRow label="Claude Code CLI" support={compatibility.versionSupport?.claudeCli} value={compatibility.currentVersions.claudeCli}/><VersionRow label="Claude Desktop" support={compatibility.versionSupport?.claudeDesktop} value={compatibility.currentVersions.claudeDesktop}/></> : <><VersionRow label="ChatGPT" support={compatibility.versionSupport?.chatgptDesktop} value={compatibility.currentVersions.chatgptDesktop}/><VersionRow label="Codex" support={compatibility.versionSupport?.codexCli} value={compatibility.currentVersions.codexCli}/></>}</div><p className="compatibility-note">Cleanup depends on the session data Session Steward finds, not on the version you have installed. A newer version on its own does not affect cleanup.</p><ul className="compatibility-details">{details.length > 0 ? details.map((detail) => <li key={detail}><span className={`semantic-dot ${compatibility.status === "partial" ? "info-dot" : "warning-dot"}`}/>{detail}</li>) : <li><Check size={13} className="success-icon"/>No unexpected session data was found.</li>}</ul></section>}</div>;
}

function VersionRow({ label, support, value }) {
  return <div className="version-row"><div><p>{label}</p><code>{value || "Not found"}</code></div><span>{versionStatus(support)}</span></div>;
}

function DeletionDialog({ isDeleting, isPlanRefreshing, onCancelCleanup, onClose, onDelete, onDeleteBackup, onRestore, onScopeChange, operation, plan, planError, planNotice, providerId, providerName, scope }) {
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

  const progressTone = hasFailed ? "progress-danger" : needsAttention ? "progress-warning" : operation?.status === "restored" ? "progress-info" : "progress-success";
  const errorTone = needsAttention ? "message-warning" : "message-danger";

  return <div className="dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="delete-title" className="dialog-panel"><div className="flex items-start justify-between gap-4"><div><div className="cleanup-eyebrow"><ShieldCheck size={13}/> Session cleanup</div><h2 id="delete-title" className="dialog-title">{operation ? operation.message : "Review selected sessions"}</h2><p className="dialog-copy">Session Steward creates a local backup before cleanup begins.</p></div><button disabled={active} onClick={onClose} aria-label="Close cleanup" className="icon-button"><X size={17}/></button></div>
    {!operation && <div className="mt-5 grid gap-3 sm:grid-cols-2"><Scope checked={scope === "core"} disabled={isDeleting || isPlanRefreshing} title="Standard cleanup" text={providerId === "claude-code" ? "Removes the selected local sessions, transcripts, history, and linked session artifacts." : "Removes the sessions, transcripts, history, logs, and linked subagents."} onClick={() => onScopeChange("core")}/><Scope checked={scope === "deep"} disabled={isDeleting || isPlanRefreshing} title="Thorough cleanup" text={providerId === "claude-code" ? "Also removes recognized file checkpoints owned by these sessions. Worktrees are always kept." : "Also removes supported Desktop references, saved memory, and goals."} onClick={() => onScopeChange("deep")}/></div>}
    {planError && <div role="alert" className="dialog-message message-danger">{planError}</div>}
    {planNotice && <div role="status" className="dialog-message message-warning">{planNotice}</div>}
    <div className="dialog-plan-region" aria-busy={isPlanRefreshing}>
      {plan
        ? <><div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4"><Metric label="Sessions to remove" value={plan.sessionCount}/><Metric label="Files to remove" value={plan.transcriptCount}/><Metric label="Session files size" value={fileSize(plan.transcriptBytes)}/><Metric label="Records to remove" value={plan.relatedRecordCount}/></div>
          {!operation && <div className="dialog-note"><HardDrive size={14}/><p>About {fileSize(plan.estimatedBackupBytes)} of temporary free space is needed for a recovery backup. It is removed after cleanup is verified.</p></div>}
          {plan.childCount > 0 && <p className="dialog-information"><GitBranch size={13}/><span>{plan.childCount} linked {plan.childCount === 1 ? "session is" : "sessions are"} included.{plan.newestLinkedActivityAtMs ? ` Newest linked activity was ${age(plan.newestLinkedActivityAtMs)}.` : " Linked activity was not recorded."}</span></p>}
          {plan.warnings?.map((warning) => <p key={warning} className="dialog-information"><AlertTriangle size={13}/><span>{warning}</span></p>)}</>
        : <div className="metric-skeleton skeleton"/>}
      {isPlanRefreshing && <div className="dialog-plan-loading" role="status"><RefreshCw size={16} className="animate-spin"/><span>Updating cleanup details</span></div>}
    </div>
    {operation && <div className="operation-panel"><div className="operation-heading"><span role="status" aria-live="polite" aria-atomic="true">{operation.message}</span><span>{progress}%</span></div><div role="progressbar" aria-label="Cleanup progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress} aria-valuetext={operation.message} className="progress-track"><div className={`progress-value ${progressTone}`} style={{ width: `${progress}%` }}/></div>{operation.error && <p className={`operation-error ${errorTone}`}>{operation.error}</p>}{operation.backupDeleteError && <p className="operation-error message-warning">{operation.backupDeleteError}</p>}{operation.canRestore && <div className="restore-copy"><p>Restore returns these sessions to their pre-cleanup state. Current files are backed up first.</p>{operation.backupDirectory && <div><p>Recovery backup location</p><code>{operation.backupDirectory}</code></div>}</div>}</div>}
    {confirmingRestore && operation?.canRestore && <div role="alert" className="dialog-confirmation message-warning"><p>Restore these sessions?</p><span>This replaces the affected {providerName} session data with the recovery backup. Session Steward saves the current files first.</span></div>}
    {confirmingBackupDelete && operation?.canDeleteBackup && <div role="alert" className="dialog-confirmation message-danger"><p>Delete this recovery backup?</p><span>You will no longer be able to restore these sessions from this backup.</span></div>}
    {!operation && <div className="dialog-information close-session-note"><AlertTriangle size={17}/><p><strong>Close selected {providerName} sessions first.</strong> Session Steward blocks sessions it can identify as running; closing them also prevents last-second changes.</p></div>}
    <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{!operation && <button disabled={isDeleting} onClick={onClose} className="button ghost">Cancel</button>}{!operation && <button disabled={isDeleting || isPlanRefreshing || !plan} onClick={onDelete} className="button danger min-w-40"><Trash2 size={15}/>{isDeleting ? "Starting cleanup…" : "Delete selected sessions"}</button>}{active && operation.canCancel && <button disabled={operation.cancelRequested} onClick={onCancelCleanup} className="button ghost">{operation.cancelRequested ? "Cancellation requested" : "Cancel cleanup"}</button>}{operation && !active && !confirmingRestore && !confirmingBackupDelete && <button onClick={onClose} className="button secondary">{operation.canRestore ? "Keep backup" : "Close"}</button>}{operation?.canDeleteBackup && !confirmingRestore && !confirmingBackupDelete && <button disabled={isDeleting} onClick={() => setConfirmingBackupDelete(true)} className="button ghost">Delete backup</button>}{operation?.canRestore && !confirmingRestore && !confirmingBackupDelete && <button disabled={isDeleting} onClick={() => setConfirmingRestore(true)} className="button primary">Restore backup</button>}{confirmingRestore && <button disabled={isDeleting} onClick={() => setConfirmingRestore(false)} className="button ghost">Cancel</button>}{confirmingRestore && <button disabled={isDeleting} onClick={onRestore} className="button primary">{isDeleting ? "Restoring…" : "Restore sessions"}</button>}{confirmingBackupDelete && <button disabled={isDeleting} onClick={() => setConfirmingBackupDelete(false)} className="button ghost">Cancel</button>}{confirmingBackupDelete && <button disabled={isDeleting} onClick={onDeleteBackup} className="button danger">{isDeleting ? "Deleting…" : "Delete backup"}</button>}</div>
  </section></div>;
}

function Metric({ label, value }) {
  return <div className="metric"><p>{label}</p><strong>{value}</strong></div>;
}

function Scope({ checked, disabled, onClick, text, title }) {
  return <button disabled={disabled} aria-pressed={checked} onClick={onClick} className={`scope-card ${checked ? "scope-card-active" : ""}`}><div className="scope-heading"><span>{title}</span><span className="scope-check">{checked && <Check size={12} strokeWidth={3}/>}</span></div><p>{text}</p></button>;
}

function AnthropicIcon({ size }) {
  return <svg aria-hidden="true" className="provider-icon" height={size} viewBox="0 0 24 24" width={size} xmlns="http://www.w3.org/2000/svg"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" fill="currentColor"/></svg>;
}

function OpenAIIcon({ size }) {
  return <svg aria-hidden="true" className="provider-icon" height={size} viewBox="0 0 20 20" width={size} xmlns="http://www.w3.org/2000/svg"><path d="M11.248 18.25q-.825 0-1.568-.314a4.3 4.3 0 0 1-1.32-.874 4 4 0 0 1-1.304.214 4 4 0 0 1-2.046-.544 4.27 4.27 0 0 1-1.518-1.485 4 4 0 0 1-.56-2.095q0-.48.131-1.04A4.4 4.4 0 0 1 2.04 10.71a4.07 4.07 0 0 1 .017-3.4 4.2 4.2 0 0 1 1.056-1.418 3.8 3.8 0 0 1 1.6-.842 3.9 3.9 0 0 1 .76-1.683q.593-.759 1.451-1.188a4.04 4.04 0 0 1 1.832-.429q.825 0 1.567.313.742.314 1.32.875a4 4 0 0 1 1.304-.215q1.106 0 2.046.545a4.14 4.14 0 0 1 1.501 1.485q.578.941.578 2.095 0 .48-.132 1.04.66.61 1.023 1.419.363.792.363 1.666 0 .892-.38 1.717a4.3 4.3 0 0 1-1.072 1.435 3.8 3.8 0 0 1-1.584.825 3.8 3.8 0 0 1-.775 1.683 4.06 4.06 0 0 1-1.436 1.188 4.04 4.04 0 0 1-1.832.429m-4.076-2.062q.825 0 1.435-.347l3.103-1.782a.36.36 0 0 0 .164-.313v-1.42L7.881 14.62a.67.67 0 0 1-.726 0l-3.118-1.798a.5.5 0 0 1-.017.115v.198q0 .841.396 1.551.413.693 1.139 1.089a3.2 3.2 0 0 0 1.617.412m.165-2.69a.4.4 0 0 0 .181.05q.083 0 .165-.05l1.238-.71-3.977-2.31a.7.7 0 0 1-.363-.643v-3.58q-.825.362-1.32 1.122a2.9 2.9 0 0 0-.495 1.65q0 .809.413 1.55.412.743 1.072 1.123zm3.91 3.663q.875 0 1.585-.396a2.96 2.96 0 0 0 1.534-2.64v-3.564a.32.32 0 0 0-.165-.297l-1.254-.726v4.604a.7.7 0 0 1-.363.643l-3.119 1.799a3 3 0 0 0 1.783.577m.627-6.039V8.878L10.01 7.822 8.129 8.878v2.244l1.881 1.056zM7.057 5.859a.7.7 0 0 1 .363-.644l3.119-1.798a3 3 0 0 0-1.782-.578q-.874 0-1.584.396A2.96 2.96 0 0 0 6.05 4.324a3.07 3.07 0 0 0-.396 1.551v3.547q0 .199.165.314l1.237.726zm8.383 7.887q.825-.364 1.303-1.123.495-.758.495-1.65a3.15 3.15 0 0 0-.412-1.55q-.413-.743-1.073-1.123l-3.086-1.782q-.099-.065-.181-.049a.3.3 0 0 0-.165.05l-1.238.692 3.993 2.327a.6.6 0 0 1 .264.264.64.64 0 0 1 .1.363zm-3.317-8.382a.63.63 0 0 1 .726 0l3.135 1.831v-.297q0-.792-.396-1.501a2.86 2.86 0 0 0-1.105-1.155q-.71-.43-1.65-.43-.825 0-1.436.347L8.294 5.941a.36.36 0 0 0-.165.314v1.418z" fill="currentColor"/></svg>;
}

createRoot(document.getElementById("root")).render(<App/>);
