import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clipboard,
  Clock3,
  FileKey2,
  Fingerprint,
  Gauge,
  KeyRound,
  Layers3,
  Link2,
  ListChecks,
  LogOut,
  Menu,
  MessagesSquare,
  Network,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCcw,
  RotateCcw,
  Search,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Terminal,
  UsersRound,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { api, ApiError, hasToken, setAdminToken } from "./api";
import type {
  Agent as AgentRecord,
  Event,
  Mission,
  MissionResultReport,
  MissionSnapshot,
  Overview,
  RelayMessage,
  Session,
  Task,
} from "./types";

type View = "overview" | "missions" | "agents" | "recovery" | "integrity";

const nav: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "missions", label: "Missions", icon: Layers3 },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "recovery", label: "Recovery", icon: RotateCcw },
  { id: "integrity", label: "Integrity", icon: Fingerprint },
];

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(hasToken());
  const [view, setView] = useState<View>("overview");
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(
    null,
  );
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    if (!hasToken()) {
      setChecking(false);
      return;
    }
    api
      .authenticate()
      .then(() => setAuthenticated(true))
      .catch(() => setAdminToken(""))
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return <BootScreen />;
  }
  if (!authenticated) {
    return <Login onSuccess={() => setAuthenticated(true)} />;
  }

  const navigate = (next: View) => {
    setView(next);
    if (next !== "missions") setSelectedMissionId(null);
    setMobileNav(false);
  };

  return (
    <div className="shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <Brand />
        <nav className="nav-list" aria-label="Primary">
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "active" : ""}`}
              onClick={() => navigate(id)}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {id === "recovery" && <span className="nav-pulse" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="runtime-card">
            <div className="runtime-row">
              <span className="live-dot" />
              Runtime online
            </div>
            <span>Local control plane</span>
          </div>
          <button
            className="nav-item sign-out"
            onClick={() => {
              setAdminToken("");
              setAuthenticated(false);
            }}
          >
            <LogOut size={17} />
            Lock console
          </button>
        </div>
      </aside>
      {mobileNav && (
        <button
          className="scrim"
          onClick={() => setMobileNav(false)}
          aria-label="Close navigation"
        />
      )}
      <main className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setMobileNav(true)}
            aria-label="Open navigation"
          >
            <Menu size={20} />
          </button>
          <div>
            <span className="eyebrow">CONTROL PLANE</span>
            <h1>{nav.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <div className="command-hint">
              <Terminal size={15} />
              <span>{window.location.host}</span>
            </div>
          </div>
        </header>
        <div className="content">
          {view === "overview" && (
            <OverviewPage onOpenMissions={() => navigate("missions")} />
          )}
          {view === "missions" &&
            (selectedMissionId === null ? (
              <MissionsPage onSelect={setSelectedMissionId} />
            ) : (
              <MissionPage
                missionId={selectedMissionId}
                onBack={() => setSelectedMissionId(null)}
              />
            ))}
          {view === "agents" && <AgentsPage />}
          {view === "recovery" && <RecoveryPage />}
          {view === "integrity" && <IntegrityPage />}
        </div>
      </main>
    </div>
  );
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    setAdminToken(token.trim());
    try {
      await api.authenticate();
      onSuccess();
    } catch (caught) {
      setAdminToken("");
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not reach RelayMesh.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-glow login-glow-one" />
      <div className="login-glow login-glow-two" />
      <section className="login-card">
        <Brand large />
        <div className="login-copy">
          <span className="kicker">
            <ShieldCheck size={15} />
            LOCAL AUTHORITY REQUIRED
          </span>
          <h2>Open the control plane</h2>
          <p>
            Paste the administrator token generated when this RelayMesh runtime
            was initialized.
          </p>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="token">Administrator token</label>
          <div className="token-input">
            <KeyRound size={18} />
            <input
              id="token"
              type="password"
              autoFocus
              autoComplete="off"
              placeholder="rm_admin_••••••••"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
          {error && <div className="form-error">{error}</div>}
          <button
            className="primary-button full"
            type="submit"
            disabled={loading || token.trim().length === 0}
          >
            {loading ? <RefreshCcw className="spin" size={17} /> : <Play size={17} />}
            {loading ? "Verifying" : "Open RelayMesh"}
          </button>
        </form>
        <div className="terminal-tip">
          <Terminal size={16} />
          <code>npm run cli -- token</code>
        </div>
      </section>
    </div>
  );
}

function OverviewPage({ onOpenMissions }: { onOpenMissions: () => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    api
      .overview()
      .then(setData)
      .catch((caught) => setError(errorMessage(caught)));
  }, []);
  useEffect(refresh, [refresh]);

  if (data === null) return <PageLoader error={error} />;
  const cards = [
    {
      label: "Active missions",
      value: data.counts.activeMissions,
      detail: `${data.counts.missions} total`,
      icon: Layers3,
      tone: "violet",
    },
    {
      label: "Live sessions",
      value: data.counts.activeSessions,
      detail: "heartbeating now",
      icon: Radio,
      tone: "cyan",
    },
    {
      label: "Work in flight",
      value: data.counts.runningTasks,
      detail: `${data.counts.queuedTasks} queued`,
      icon: Activity,
      tone: "amber",
    },
    {
      label: "Recovered tasks",
      value: data.counts.recoveries,
      detail:
        data.counts.blockers > 0
          ? `${data.counts.blockers} blockers`
          : "no active blockers",
      icon: RotateCcw,
      tone: "green",
    },
  ];

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div>
          <span className="kicker">
            <Network size={15} />
            HETEROGENEOUS AGENT FABRIC
          </span>
          <h2>Work survives the model session.</h2>
          <p>
            Durable task leases, checkpoints, messages, and recovery keep
            different AI agents aligned when a context window ends or a process
            disappears.
          </p>
        </div>
        <div className="hero-signal" aria-label="Runtime topology">
          <div className="signal-core">
            <Network size={24} />
          </div>
          <span className="signal-node node-one">C</span>
          <span className="signal-node node-two">G</span>
          <span className="signal-node node-three">A</span>
          <span className="orbit orbit-one" />
          <span className="orbit orbit-two" />
        </div>
      </section>
      <section className="stat-grid">
        {cards.map(({ label, value, detail, icon: Icon, tone }) => (
          <article className="stat-card" key={label}>
            <div className={`stat-icon ${tone}`}>
              <Icon size={18} />
            </div>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
          </article>
        ))}
      </section>
      <div className="split-grid">
        <section className="panel">
          <PanelHeader
            title="Active missions"
            subtitle="Durable workspaces"
            action={
              <button className="text-button" onClick={onOpenMissions}>
                View all <ArrowUpRight size={15} />
              </button>
            }
          />
          <div className="mission-list">
            {data.missions.slice(0, 5).map((mission) => (
              <div className="mission-row" key={mission.id}>
                <StatusDot status={mission.status} />
                <div className="mission-main">
                  <strong>{mission.title}</strong>
                  <span>{truncate(mission.objective, 82)}</span>
                </div>
                <div className="mission-metrics">
                  <span>
                    <ListChecks size={14} /> {mission.taskCount ?? 0}
                  </span>
                  <span>
                    <UsersRound size={14} /> {mission.activeSessions ?? 0}
                  </span>
                </div>
              </div>
            ))}
            {data.missions.length === 0 && (
              <EmptyState
                icon={Layers3}
                title="No missions yet"
                detail="Create the first durable workspace."
              />
            )}
          </div>
        </section>
        <section className="panel">
          <PanelHeader
            title="Coordination integrity"
            subtitle="Signed event chain"
            action={
              <span className={`integrity-pill ${data.chain.valid ? "valid" : "invalid"}`}>
                {data.chain.valid ? <Check size={13} /> : <X size={13} />}
                {data.chain.valid ? "Verified" : "Broken"}
              </span>
            }
          />
          <div className="chain-summary">
            <Fingerprint size={28} />
            <div>
              <strong>{data.chain.checked} signed events</strong>
              <span className="mono">{shortHash(data.chain.headHash)}</span>
            </div>
          </div>
          <div className="event-stream compact">
            {data.recentEvents.slice(-6).reverse().map((event) => (
              <EventRow event={event} key={event.id} />
            ))}
            {data.recentEvents.length === 0 && (
              <EmptyState
                icon={Fingerprint}
                title="Chain initialized"
                detail="Events appear as agents coordinate."
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function MissionsPage({ onSelect }: { onSelect: (id: string) => void }) {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    void api
      .missions()
      .then(setMissions)
      .catch(() => setMissions([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="page-stack">
      <PageHeading
        title="Durable missions"
        detail="A mission owns the objective, work graph, messages, artifacts, and recovery history—not any single model session."
        action={
          <button className="primary-button" onClick={() => setShowCreate(true)}>
            <Plus size={17} /> New mission
          </button>
        }
      />
      {loading ? (
        <PageLoader />
      ) : (
        <section className="mission-grid">
          {missions.map((mission) => (
            <button
              className="mission-card"
              key={mission.id}
              onClick={() => onSelect(mission.id)}
            >
              <div className="mission-card-top">
                <StatusBadge status={mission.status} />
                <ChevronRight size={18} />
              </div>
              <h3>{mission.title}</h3>
              <p>{truncate(mission.objective, 160)}</p>
              <div className="mission-card-meta">
                <span>
                  <ListChecks size={14} /> {mission.taskCount ?? 0} tasks
                </span>
                <span>
                  <UsersRound size={14} /> {mission.activeSessions ?? 0} live
                </span>
              </div>
            </button>
          ))}
          {missions.length === 0 && (
            <div className="wide-empty">
              <EmptyState
                icon={Layers3}
                title="Create the first mission"
                detail="Break an objective into capability-matched work that survives every agent session."
              />
            </div>
          )}
        </section>
      )}
      {showCreate && (
        <CreateMissionModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function MissionPage({
  missionId,
  onBack,
}: {
  missionId: string;
  onBack: () => void;
}) {
  const [snapshot, setSnapshot] = useState<MissionSnapshot | null>(null);
  const [result, setResult] = useState<MissionResultReport | null>(null);
  const [tab, setTab] = useState<
    "result" | "tasks" | "sessions" | "messages" | "artifacts"
  >("result");
  const [showTask, setShowTask] = useState(false);
  const [capsuleState, setCapsuleState] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");
  const load = useCallback(() => {
    void Promise.all([
      api.mission(missionId),
      api.missionResult(missionId),
    ]).then(([nextSnapshot, nextResult]) => {
      setSnapshot(nextSnapshot);
      setResult(nextResult);
    });
  }, [missionId]);
  useEffect(load, [load]);
  if (snapshot === null) return <PageLoader />;

  const { mission } = snapshot;
  const completed = snapshot.tasks.filter((task) => task.status === "completed").length;
  const progress =
    snapshot.tasks.length === 0
      ? 0
      : Math.round((completed / snapshot.tasks.length) * 100);
  const copyCapsule = async () => {
    setCapsuleState("copying");
    try {
      const capsule = await api.missionCapsule(missionId);
      await copyText(JSON.stringify(capsule, null, 2));
      setCapsuleState("copied");
    } catch {
      setCapsuleState("failed");
    }
  };

  return (
    <div className="page-stack">
      <button className="back-button" onClick={onBack}>
        <ChevronRight size={16} /> All missions
      </button>
      <section className="mission-hero">
        <div className="mission-hero-main">
          <div className="mission-title-row">
            <StatusBadge status={mission.status} />
            <span className="mono subtle">{mission.id.slice(0, 8)}</span>
          </div>
          <h2>{mission.title}</h2>
          <p>{mission.objective}</p>
        </div>
        <div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}>
          <div>
            <strong>{progress}%</strong>
            <span>complete</span>
          </div>
        </div>
      </section>
      <section className="mission-mini-stats">
        <MiniStat icon={ListChecks} label="Tasks" value={snapshot.tasks.length} />
        <MiniStat
          icon={Radio}
          label="Live sessions"
          value={snapshot.sessions.filter((session) => session.status === "active").length}
        />
        <MiniStat icon={MessagesSquare} label="Messages" value={snapshot.messages.length} />
        <MiniStat icon={FileKey2} label="Artifacts" value={snapshot.artifacts.length} />
        <MiniStat icon={Fingerprint} label="Event head" value={`#${snapshot.eventSequence}`} />
      </section>
      <section className="panel mission-workspace">
        <div className="tab-bar">
          {(["result", "tasks", "sessions", "messages", "artifacts"] as const).map((item) => (
            <button
              className={tab === item ? "active" : ""}
              key={item}
              onClick={() => setTab(item)}
            >
              {item}
            </button>
          ))}
          {tab === "tasks" && (
            <button className="secondary-button tab-action" onClick={() => setShowTask(true)}>
              <Plus size={15} /> Add task
            </button>
          )}
        </div>
        {tab === "result" && result !== null && (
          <MissionResultView
            report={result}
            capsuleState={capsuleState}
            onCopyCapsule={() => void copyCapsule()}
          />
        )}
        {tab === "tasks" && <TaskTable tasks={snapshot.tasks} />}
        {tab === "sessions" && <SessionTable sessions={snapshot.sessions} />}
        {tab === "messages" && (
          <div className="message-grid">
            {snapshot.messages.map((message) => (
              <article className={`message-card ${message.intent}`} key={message.id}>
                <div>
                  <IntentIcon intent={message.intent} />
                  <span>{message.intent}</span>
                  <time>{relativeTime(message.createdAt)}</time>
                </div>
                <strong>{message.subject}</strong>
                <small className="mono">{message.senderSessionId.slice(0, 8)}</small>
              </article>
            ))}
            {snapshot.messages.length === 0 && (
              <EmptyState
                icon={MessagesSquare}
                title="No messages"
                detail="Agents exchange durable messages through the SDK or MCP bridge."
              />
            )}
          </div>
        )}
        {tab === "artifacts" && (
          <div className="artifact-list">
            {snapshot.artifacts.map((artifact) => (
              <div className="artifact-row" key={artifact.id}>
                <div className="artifact-icon">
                  <FileKey2 size={18} />
                </div>
                <div>
                  <strong>{artifact.name}</strong>
                  <span>{artifact.mimeType} · {formatBytes(artifact.sizeBytes)}</span>
                </div>
                <code>{shortHash(artifact.sha256)}</code>
              </div>
            ))}
            {snapshot.artifacts.length === 0 && (
              <EmptyState
                icon={FileKey2}
                title="No artifacts"
                detail="Published outputs are immutable and content-addressed."
              />
            )}
          </div>
        )}
      </section>
      {showTask && (
        <CreateTaskModal
          missionId={missionId}
          onClose={() => setShowTask(false)}
          onCreated={() => {
            setShowTask(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function MissionResultView({
  report,
  capsuleState,
  onCopyCapsule,
}: {
  report: MissionResultReport;
  capsuleState: "idle" | "copying" | "copied" | "failed";
  onCopyCapsule: () => void;
}) {
  return (
    <div className="result-view">
      <section className={`result-status ${report.ready ? "ready" : ""}`}>
        {report.ready ? <CheckCircle2 size={28} /> : <Clock3 size={28} />}
        <div>
          <strong>
            {report.ready
              ? "Final deliverable ready"
              : `${report.progress.percent}% complete`}
          </strong>
          <span>
            {report.progress.completed}/{report.progress.total} tasks ·{" "}
            {report.productivity.contributors} contributing sessions
          </span>
        </div>
        <div className="result-actions">
          <span className={`integrity-pill ${report.integrity.valid ? "valid" : "invalid"}`}>
            {report.integrity.valid ? <Check size={13} /> : <X size={13} />}
            {report.integrity.valid ? "Verified" : "Invalid chain"}
          </span>
          <button
            className="capsule-button"
            disabled={capsuleState === "copying"}
            onClick={onCopyCapsule}
          >
            {capsuleState === "copied" ? <Check size={13} /> : <Clipboard size={13} />}
            {capsuleLabel(capsuleState)}
          </button>
        </div>
      </section>
      <div className="result-metrics">
        <MiniStat
          icon={UsersRound}
          label="Contributors"
          value={report.productivity.contributors}
        />
        <MiniStat
          icon={RefreshCcw}
          label="Recoveries"
          value={report.productivity.recoveredTasks}
        />
        <MiniStat
          icon={Link2}
          label="Handoffs"
          value={report.productivity.handoffs}
        />
        <MiniStat
          icon={FileKey2}
          label="Checkpoints"
          value={report.productivity.checkpoints}
        />
      </div>
      {report.decisionTrail.length > 0 && (
        <section className="council-trail">
          <div className="council-trail-head">
            <div>
              <Sparkles size={16} />
              <span>COUNCIL DECISION TRAIL</span>
            </div>
            <small>
              Independent evidence → cross-examination → synthesis
            </small>
          </div>
          <div className="council-flow">
            {report.decisionTrail.map(({ task, depth }) => (
              <article
                className={`council-node ${depth > 0 ? "convergence" : ""}`}
                key={task.id}
              >
                <div className="council-node-top">
                  <span>{depth === 0 ? "INDEPENDENT" : "CONVERGENCE"}</span>
                  <StatusBadge status={task.status} />
                </div>
                <strong>{task.title}</strong>
                <p>{decisionSummary(task)}</p>
                <small>
                  {task.dependencies.length} inputs · depth {depth}
                </small>
              </article>
            ))}
          </div>
        </section>
      )}
      <div className="final-output-list">
        {report.finalOutputs.map(({ task, checkpoint, artifacts }) => (
          <article className="final-output" key={task.id}>
            <div className="final-output-head">
              <div>
                <span>FINAL TASK</span>
                <strong>{task.title}</strong>
              </div>
              <StatusBadge status={task.status} />
            </div>
            {task.result === null ? (
              <p>
                {checkpoint?.nextAction ||
                  "The final task has not produced a durable result yet."}
              </p>
            ) : (
              <pre>{JSON.stringify(task.result, null, 2)}</pre>
            )}
            {artifacts.length > 0 && (
              <small>{artifacts.length} content-addressed artifacts attached</small>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

function decisionSummary(task: Task): string {
  if (task.result === null) {
    return task.status === "queued"
      ? "Waiting for its dependencies."
      : "No durable result yet.";
  }
  for (const key of [
    "recommendedDecision",
    "deliverable",
    "conclusion",
    "summary",
  ]) {
    const value = task.result[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  const agreements = task.result.agreements;
  const disagreements = task.result.disagreements;
  if (Array.isArray(agreements) || Array.isArray(disagreements)) {
    return `${Array.isArray(agreements) ? agreements.length : 0} agreements · ${
      Array.isArray(disagreements) ? disagreements.length : 0
    } disagreements preserved`;
  }
  return `${Object.keys(task.result).length} structured evidence fields preserved`;
}

function capsuleLabel(
  state: "idle" | "copying" | "copied" | "failed",
): string {
  if (state === "copying") return "Sealing capsule…";
  if (state === "copied") return "Capsule copied";
  if (state === "failed") return "Copy failed";
  return "Copy context capsule";
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the local document copy path.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard is unavailable");
}

function AgentsPage() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [secret, setSecret] = useState<{ name: string; key: string } | null>(null);
  const load = useCallback(() => void api.agents().then(setAgents), []);
  useEffect(load, [load]);

  return (
    <div className="page-stack">
      <PageHeading
        title="Registered agents"
        detail="Stable identities can create short-lived sessions across different providers and models."
        action={
          <button className="primary-button" onClick={() => setShowCreate(true)}>
            <Plus size={17} /> Register agent
          </button>
        }
      />
      {secret && (
        <section className="secret-banner">
          <div>
            <KeyRound size={20} />
            <div>
              <strong>Save the key for {secret.name}</strong>
              <span>It is shown once and stored only as a hash.</span>
            </div>
          </div>
          <code>{secret.key}</code>
          <button
            className="icon-button"
            onClick={() => void navigator.clipboard.writeText(secret.key)}
            aria-label="Copy agent key"
          >
            <Clipboard size={17} />
          </button>
          <button className="icon-button" onClick={() => setSecret(null)} aria-label="Dismiss">
            <X size={17} />
          </button>
        </section>
      )}
      <section className="panel table-panel">
        <div className="data-table agent-table">
          <div className="table-header">
            <span>Identity</span>
            <span>Provider</span>
            <span>Default model</span>
            <span>Status</span>
            <span>Created</span>
          </div>
          {agents.map((agent) => (
            <div className="table-row" key={agent.id}>
              <span className="identity-cell">
                <span className="agent-avatar">{agent.name.slice(0, 2).toUpperCase()}</span>
                <span>
                  <strong>{agent.name}</strong>
                  <small>{agent.description || "No description"}</small>
                </span>
              </span>
              <span>{agent.provider}</span>
              <code>{agent.defaultModel}</code>
              <StatusBadge status={agent.status} />
              <span>{relativeTime(agent.createdAt)}</span>
            </div>
          ))}
          {agents.length === 0 && (
            <EmptyState
              icon={Bot}
              title="No agent identities"
              detail="Register Claude, Codex, Gemini, or a custom runtime."
            />
          )}
        </div>
      </section>
      {showCreate && (
        <CreateAgentModal
          onClose={() => setShowCreate(false)}
          onCreated={(result) => {
            setShowCreate(false);
            setSecret({ name: result.agent.name, key: result.agentKey });
            load();
          }}
        />
      )}
    </div>
  );
}

function RecoveryPage() {
  const [report, setReport] = useState<Awaited<ReturnType<typeof api.recover>> | null>(null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try {
      setReport(await api.recover());
    } finally {
      setRunning(false);
    }
  };
  const recovered = report?.requeuedTasks.length ?? 0;
  const clean =
    report !== null &&
    report.lostSessions.length === 0 &&
    report.expiredLeases.length === 0;

  return (
    <div className="page-stack">
      <PageHeading
        title="Crash recovery"
        detail="Detect lost sessions, expire their leases, and return checkpointed work to another compatible model."
        action={
          <button
            className="primary-button"
            onClick={() => void run()}
            disabled={running}
          >
            <RefreshCcw size={17} className={running ? "spin" : ""} />
            Run recovery sweep
          </button>
        }
      />
      <section className="recovery-diagram panel">
        <RecoveryStep icon={Radio} title="Heartbeat lost" detail="Session misses its liveness window" />
        <ChevronRight size={20} />
        <RecoveryStep icon={Pause} title="Fence old lease" detail="Late writes are rejected" />
        <ChevronRight size={20} />
        <RecoveryStep icon={FileKey2} title="Load checkpoint" detail="Recover model-independent state" />
        <ChevronRight size={20} />
        <RecoveryStep icon={Zap} title="Reassign work" detail="Any capable model can resume" />
      </section>
      {report === null ? (
        <section className="panel recovery-ready">
          <ServerCog size={34} />
          <div>
            <h3>Automatic recovery is armed</h3>
            <p>The runtime sweeps stale heartbeats and leases every five seconds.</p>
          </div>
        </section>
      ) : (
        <section className={`panel recovery-report ${clean ? "clean" : ""}`}>
          {clean ? <CheckCircle2 size={30} /> : <RotateCcw size={30} />}
          <div>
            <h3>{clean ? "No abandoned work found" : `${recovered} tasks recovered`}</h3>
            <p>
              {report.lostSessions.length} lost sessions · {report.expiredLeases.length} expired leases · {report.failedTasks.length} exhausted tasks
            </p>
          </div>
        </section>
      )}
      <section className="guardrail-grid">
        <Guardrail icon={Clock3} title="Bounded leases" detail="Ownership expires unless the active session keeps heartbeating." />
        <Guardrail icon={ShieldCheck} title="Fencing tokens" detail="A recovered task rejects stale completion attempts." />
        <Guardrail icon={FileKey2} title="Recovery capsules" detail="Checkpoints carry decisions, artifacts, and the exact next action." />
        <Guardrail icon={RefreshCcw} title="At-least-once delivery" detail="Idempotency keys make retries safe without pretending failures cannot happen." />
      </section>
    </div>
  );
}

function IntegrityPage() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [missionId, setMissionId] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  const [verification, setVerification] = useState<Awaited<ReturnType<typeof api.verify>> | null>(null);
  useEffect(() => {
    void api.missions().then((items) => {
      setMissions(items);
      if (items[0]) setMissionId(items[0].id);
    });
  }, []);
  const verify = useCallback(() => {
    if (!missionId) return;
    void Promise.all([api.events(missionId), api.verify(missionId)]).then(([nextEvents, nextVerification]) => {
      setEvents(nextEvents);
      setVerification(nextVerification);
    });
  }, [missionId]);
  useEffect(verify, [verify]);

  return (
    <div className="page-stack">
      <PageHeading
        title="Event integrity"
        detail="Every coordination mutation is hash-chained and signed with the runtime's Ed25519 key."
        action={
          <div className="select-wrap">
            <Search size={15} />
            <select value={missionId} onChange={(event) => setMissionId(event.target.value)}>
              {missions.map((mission) => <option key={mission.id} value={mission.id}>{mission.title}</option>)}
            </select>
          </div>
        }
      />
      <section className={`integrity-hero ${verification?.valid ? "verified" : "unknown"}`}>
        <div className="integrity-mark">
          {verification?.valid ? <ShieldCheck size={32} /> : <Fingerprint size={32} />}
        </div>
        <div>
          <span>CHAIN STATUS</span>
          <h2>{verification?.valid ? "Cryptographically verified" : "Select a mission"}</h2>
          <p>{verification ? `${verification.checked} events checked with no broken links or signatures.` : "No chain loaded."}</p>
        </div>
        {verification && <code>{shortHash(verification.headHash)}</code>}
      </section>
      <section className="panel">
        <PanelHeader title="Immutable event log" subtitle="Oldest to newest" />
        <div className="event-stream">
          {events.slice().reverse().map((event) => <EventRow event={event} key={event.id} detailed />)}
          {events.length === 0 && <EmptyState icon={Fingerprint} title="No events" detail="This mission has no state transitions yet." />}
        </div>
      </section>
    </div>
  );
}

function TaskTable({ tasks }: { tasks: Task[] }) {
  return (
    <div className="data-table task-table">
      <div className="table-header">
        <span>Task</span><span>State</span><span>Requirements</span><span>Attempt</span><span>Updated</span>
      </div>
      {tasks.map((task) => (
        <div className="table-row" key={task.id}>
          <span><strong>{task.title}</strong><small>{truncate(task.description, 76)}</small></span>
          <StatusBadge status={task.status} />
          <span className="capability-list">
            {task.requiredCapabilities.length === 0 ? <em>any agent</em> : task.requiredCapabilities.slice(0, 2).map((cap) => <code key={cap}>{cap}</code>)}
          </span>
          <span>{task.attempt}/{task.maxAttempts}</span>
          <span>{relativeTime(task.updatedAt)}</span>
        </div>
      ))}
      {tasks.length === 0 && <EmptyState icon={ListChecks} title="No tasks" detail="Add capability-matched work to this mission." />}
    </div>
  );
}

function SessionTable({ sessions }: { sessions: Session[] }) {
  return (
    <div className="data-table session-table">
      <div className="table-header">
        <span>Session</span><span>Model</span><span>Role</span><span>Capabilities</span><span>Liveness</span>
      </div>
      {sessions.map((session) => (
        <div className="table-row" key={session.id}>
          <span className="identity-cell"><span className="agent-avatar">{session.agentName.slice(0, 2).toUpperCase()}</span><span><strong>{session.agentName}</strong><small className="mono">{session.id.slice(0, 8)}</small></span></span>
          <code>{session.model}</code>
          <span>{session.role}</span>
          <span className="capability-list">{session.capabilities.slice(0, 2).map((cap) => <code key={cap}>{cap}</code>)}</span>
          <span><StatusBadge status={session.status} /><small>{relativeTime(session.lastHeartbeatAt)}</small></span>
        </div>
      ))}
      {sessions.length === 0 && <EmptyState icon={Radio} title="No sessions" detail="Connect an agent through the SDK or MCP bridge." />}
    </div>
  );
}

function CreateMissionModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true);
    try { await api.createMission({ title, objective }); onCreated(); } finally { setSaving(false); }
  };
  return (
    <Modal title="New durable mission" detail="The objective and work graph outlive every participating model session." onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => void submit(event)}>
        <Field label="Mission name"><input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ship recovery-safe agent runtime" /></Field>
        <Field label="Canonical objective"><textarea required rows={5} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Define the result all agents must work toward..." /></Field>
        <ModalActions saving={saving} onClose={onClose} label="Create mission" />
      </form>
    </Modal>
  );
}

function CreateTaskModal({ missionId, onClose, onCreated }: { missionId: string; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [role, setRole] = useState("");
  const [priority, setPriority] = useState(0);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true);
    try {
      await api.createTask(missionId, { title, description, priority, requiredCapabilities: splitCsv(capabilities), assignedRole: role.trim() || null, maxAttempts: 3, dependencies: [], parentTaskId: null });
      onCreated();
    } finally { setSaving(false); }
  };
  return (
    <Modal title="Add mission task" detail="Requirements ensure only a compatible agent session can claim this lease." onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => void submit(event)}>
        <Field label="Task title"><input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Verify browser recovery flow" /></Field>
        <Field label="Instructions"><textarea required rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Define the observable completion condition..." /></Field>
        <div className="form-grid">
          <Field label="Capabilities"><input value={capabilities} onChange={(event) => setCapabilities(event.target.value)} placeholder="test.browser, code.ts" /></Field>
          <Field label="Assigned role"><input value={role} onChange={(event) => setRole(event.target.value)} placeholder="reviewer (optional)" /></Field>
        </div>
        <Field label={`Priority · ${priority}`}><input type="range" min="-10" max="10" value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></Field>
        <ModalActions saving={saving} onClose={onClose} label="Add task" />
      </form>
    </Modal>
  );
}

function CreateAgentModal({ onClose, onCreated }: { onClose: () => void; onCreated: (result: Awaited<ReturnType<typeof api.createAgent>>) => void }) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true);
    try { onCreated(await api.createAgent({ name, provider, defaultModel: model, description })); } finally { setSaving(false); }
  };
  return (
    <Modal title="Register agent identity" detail="The long-lived key can join many short-lived, mission-scoped sessions." onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => void submit(event)}>
        <Field label="Display name"><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Codex Builder" /></Field>
        <div className="form-grid">
          <Field label="Provider"><input required value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="OpenAI" /></Field>
          <Field label="Default model"><input required value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-5.6" /></Field>
        </div>
        <Field label="Description"><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Code implementation and verification..." /></Field>
        <ModalActions saving={saving} onClose={onClose} label="Register agent" />
      </form>
    </Modal>
  );
}

function Modal({ title, detail, onClose, children }: { title: string; detail: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-head"><div><h2>{title}</h2><p>{detail}</p></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
      {children}
    </section>
  </div>;
}

function ModalActions({ saving, onClose, label }: { saving: boolean; onClose: () => void; label: string }) {
  return <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? <RefreshCcw className="spin" size={16} /> : <Plus size={16} />}{saving ? "Saving" : label}</button></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Brand({ large = false }: { large?: boolean }) {
  return <div className={`brand ${large ? "brand-large" : ""}`}><div className="brand-mark"><span /><span /><Network size={large ? 24 : 20} /></div><div><strong>RelayMesh</strong><span>Agent coordination fabric</span></div></div>;
}

function BootScreen() {
  return <div className="boot"><Brand large /><RefreshCcw className="spin" size={20} /></div>;
}

function PageHeading({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return <section className="page-heading"><div><h2>{title}</h2><p>{detail}</p></div>{action}</section>;
}

function PanelHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) {
  return <header className="panel-head"><div><h3>{title}</h3><span>{subtitle}</span></div>{action}</header>;
}

function PageLoader({ error = "" }: { error?: string }) {
  return <div className="page-loader">{error ? <><AlertTriangle size={22} /><span>{error}</span></> : <><RefreshCcw size={22} className="spin" /><span>Synchronizing runtime state</span></>}</div>;
}

function EmptyState({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return <div className="empty-state"><Icon size={25} /><strong>{title}</strong><span>{detail}</span></div>;
}

function MiniStat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string | number }) {
  return <div><Icon size={16} /><span>{label}</span><strong>{value}</strong></div>;
}

function RecoveryStep({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return <div className="recovery-step"><span><Icon size={19} /></span><strong>{title}</strong><small>{detail}</small></div>;
}

function Guardrail({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return <article className="guardrail"><Icon size={19} /><strong>{title}</strong><p>{detail}</p></article>;
}

function EventRow({ event, detailed = false }: { event: Event; detailed?: boolean }) {
  const Icon = event.type.includes("recover") || event.type.includes("lost") ? RotateCcw : event.type.includes("completed") ? CheckCircle2 : event.type.includes("message") ? MessagesSquare : CircleDot;
  return <div className={`event-row ${detailed ? "detailed" : ""}`}><span className="event-icon"><Icon size={14} /></span><div><strong>{humanize(event.type)}</strong><span>{event.actorType} · {relativeTime(event.createdAt)}</span></div>{detailed && <code>{shortHash(event.hash)}</code>}</div>;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${status}`}><span />{status}</span>;
}

function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot status-${status}`} />;
}

function IntentIcon({ intent }: { intent: RelayMessage["intent"] }) {
  if (intent === "blocker") return <AlertTriangle size={15} />;
  if (intent === "challenge") return <Zap size={15} />;
  if (intent === "decision") return <CheckCircle2 size={15} />;
  if (intent === "handoff") return <Link2 size={15} />;
  return <MessagesSquare size={15} />;
}

function relativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function shortHash(value: string): string {
  return value.length < 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function splitCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function humanize(value: string): string {
  return value.replaceAll(".", " ").replaceAll("_", " ");
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
