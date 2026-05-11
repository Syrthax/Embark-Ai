/* global React */
const { useState, useEffect, useRef } = React;

// ──────────────────────────────── Features ────────────────────────────────
const FEATURES = [
  {
    id: "RT-01", title: "Recovery Arbiter",
    desc: "Centralized escalation policy. Watchdog signals fan-in here — the arbiter decides hold, retry, abort, or rebuild.",
    vis: <div className="mini-d"><span className="blk">signal</span><span className="arr">→</span><span className="blk emerald">arbiter</span><span className="arr">→</span><span className="blk copper">resume</span></div>
  },
  {
    id: "RT-02", title: "Desync Detection",
    desc: "Heartbeat drift, packet-lag thresholds and chunk-state diffs are continuously sampled. Triggers reconnect before the agent gets stuck.",
    vis: <div className="mini-d"><span className="blk">heartbeat</span><span className="arr">·</span><span className="blk">drift</span><span className="arr">·</span><span className="blk red">2.3s</span></div>
  },
  {
    id: "RT-03", title: "Autonomous Survival",
    desc: "Lava avoidance, food management, mob threat scoring and shelter heuristics. The agent stays alive through the night, unsupervised.",
    vis: <div className="mini-d"><span className="blk">threat</span><span className="arr">→</span><span className="blk copper">evade</span><span className="arr">→</span><span className="blk emerald">safe</span></div>
  },
  {
    id: "RT-04", title: "Structured Telemetry",
    desc: "Every step emits JSONL with correlation IDs, parent task spans, and recovery context. Pipe straight into Loki, Datadog, or stdout.",
    vis: <div className="mini-d"><span className="blk emerald">jsonl</span><span className="arr">→</span><span className="blk">stdout</span><span className="arr">·</span><span className="blk">loki</span></div>
  },
  {
    id: "RT-05", title: "Safe Mineflayer Wrappers",
    desc: "Promise-safe wrappers around pathfinder, dig, place, attack — with explicit timeouts and cancellation. No more stale hung handles.",
    vis: <div className="mini-d"><span className="blk">dig()</span><span className="arr">⊕</span><span className="blk emerald">timeout</span><span className="arr">⊕</span><span className="blk">cancel</span></div>
  },
  {
    id: "RT-06", title: "Runtime Watchdogs",
    desc: "Independent watchdogs per subsystem — pathfinder, combat, dig loop, server liveness — each with its own TTL and escalation ladder.",
    vis: <div className="mini-d"><span className="blk">wd₁</span><span className="blk">wd₂</span><span className="blk">wd₃</span><span className="arr">→</span><span className="blk copper">esc</span></div>
  },
  {
    id: "RT-07", title: "Goal Registry",
    desc: "Hierarchical, interruptible goals with persistence. Resume mid-task across reconnects with full state intact.",
    vis: <div className="mini-d"><span className="blk">goal</span><span className="arr">▸</span><span className="blk">subgoal</span><span className="arr">▸</span><span className="blk emerald">step 4/12</span></div>
  },
  {
    id: "RT-08", title: "Movement Controller",
    desc: "Owns the agent's body. Serializes all motion intents, prevents pathfinder thrash, yields to higher-priority recovery requests.",
    vis: <div className="mini-d"><span className="blk">intent</span><span className="arr">→</span><span className="blk emerald">ctrl</span><span className="arr">→</span><span className="blk">body</span></div>
  },
  {
    id: "RT-09", title: "Task Ownership Tokens",
    desc: "Only one task can hold the body. Tokens make conflicting intents impossible — no more two pathfinders fighting over the same step.",
    vis: <div className="mini-d"><span className="blk emerald">token</span><span className="arr">⤵</span><span className="blk">mine</span><span className="arr">·</span><span className="blk">eat</span><span className="blk red">wait</span></div>
  },
];

const FeatureCard = ({ f }) => (
  <article className="feat">
    <div className="feat-id"><span>{f.id}</span><span className="ok-dot" /></div>
    <h3>{f.title}</h3>
    <p>{f.desc}</p>
    <div className="feat-vis">{f.vis}</div>
  </article>
);

const Features = () => (
  <section className="section" id="features">
    <div className="shell">
      <div className="section-head">
        <span className="section-eyebrow">// runtime components</span>
        <h2 className="section-title">Engineered as a fleet of cooperating subsystems.</h2>
        <p className="section-sub">Each component owns a single concern and emits structured signals upstream. The runtime composes them into something that survives.</p>
      </div>
      <div className="features-grid">
        {FEATURES.map(f => <FeatureCard key={f.id} f={f} />)}
      </div>
    </div>
  </section>
);

// ──────────────────────────────── Architecture ────────────────────────────────
const ArchDiagram = () => {
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPulse(p => (p + 1) % 7), 1200);
    return () => clearInterval(t);
  }, []);
  // Vertical stack of nodes
  const nodes = [
    { y: 30,  label: "LLM Orchestrator", sub: "claude · gpt-4 · local", color: "iron" },
    { y: 120, label: "Action Engine", sub: "intent → primitive", color: "iron" },
    { y: 210, label: "Task Runtime", sub: "goals · ownership", color: "emerald" },
    { y: 300, label: "Recovery Arbiter", sub: "watchdog fan-in", color: "copper" },
    { y: 390, label: "Movement Controller", sub: "single body owner", color: "emerald" },
    { y: 480, label: "Mineflayer (safe wraps)", sub: "promise-safe primitives", color: "iron" },
    { y: 570, label: "Minecraft World", sub: "1.20.x · vanilla / paper", color: "iron" },
  ];
  return (
    <svg className="arch-svg-container" viewBox="0 0 720 640" preserveAspectRatio="xMidYMid meet" style={{maxHeight: 640}}>
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--emerald)" />
        </marker>
      </defs>
      {/* central column */}
      {nodes.map((n, i) => (
        <g key={i}>
          <rect x="220" y={n.y} width="280" height="64" rx="5" className={`node ${n.color}`} />
          <text x="240" y={n.y + 26} className="node-label">{n.label}</text>
          <text x="240" y={n.y + 46} className="node-sub">{n.sub}</text>
          {/* corner pins */}
          <rect x="222" y={n.y + 2} width="4" height="4" className="node-pin" />
          <rect x="494" y={n.y + 58} width="4" height="4" className={`node-pin ${n.color === 'copper' ? 'copper' : ''}`} />
        </g>
      ))}
      {/* connector lines */}
      {nodes.slice(0, -1).map((n, i) => (
        <line key={`l${i}`} x1="360" y1={n.y + 64} x2="360" y2={nodes[i+1].y}
          className={`flow-line ${pulse === i ? 'active' : ''}`} markerEnd="url(#arrowhead)" />
      ))}
      {/* pulse dot */}
      <circle r="4" className="flow-pulse"
        cx="360"
        cy={(nodes[pulse]?.y || 0) + 64 + ((nodes[pulse+1]?.y || 700) - (nodes[pulse]?.y || 0) - 64) * 0.5}
      />

      {/* Right side: watchdog cluster */}
      <g transform="translate(540, 180)">
        <text x="0" y="0" className="node-sub" style={{fill: 'var(--copper)'}}>// WATCHDOG MESH</text>
        {[
          { label: "Pathfinder WD", y: 16 },
          { label: "Combat WD", y: 56 },
          { label: "Dig Loop WD", y: 96 },
          { label: "Server WD", y: 136 },
        ].map((w, i) => (
          <g key={i}>
            <rect x="0" y={w.y} width="160" height="32" rx="3" className="node copper" />
            <text x="12" y={w.y + 20} className="node-sub" style={{fill: 'var(--text)'}}>{w.label}</text>
            <circle cx="148" cy={w.y + 16} r="3" fill="var(--copper)" style={{filter: 'drop-shadow(0 0 4px var(--copper))'}} />
            {/* line from watchdog into arbiter */}
            <line x1="0" y1={w.y + 16} x2="-40" y2={148} stroke="var(--copper)" strokeWidth="0.8" strokeDasharray="2 3" opacity="0.6" />
          </g>
        ))}
      </g>

      {/* Left side: telemetry tap */}
      <g transform="translate(20, 200)">
        <text x="0" y="0" className="node-sub" style={{fill: 'var(--emerald)'}}>// TELEMETRY</text>
        {[
          { label: "JSONL log stream", y: 16 },
          { label: "Span / Corr IDs", y: 56 },
          { label: "Metric counters", y: 96 },
          { label: "Recovery events", y: 136 },
        ].map((w, i) => (
          <g key={i}>
            <rect x="0" y={w.y} width="160" height="32" rx="3" className="node emerald" />
            <text x="12" y={w.y + 20} className="node-sub" style={{fill: 'var(--text)'}}>{w.label}</text>
            <circle cx="148" cy={w.y + 16} r="3" fill="var(--emerald)" style={{filter: 'drop-shadow(0 0 4px var(--emerald))'}} />
            <line x1="160" y1={w.y + 16} x2="200" y2={148} stroke="var(--emerald)" strokeWidth="0.8" strokeDasharray="2 3" opacity="0.6" />
          </g>
        ))}
      </g>
    </svg>
  );
};

const Architecture = () => (
  <section className="section" id="architecture">
    <div className="shell">
      <div className="section-head">
        <span className="section-eyebrow">// runtime architecture</span>
        <h2 className="section-title">A layered runtime. Every layer can fail; every layer can recover.</h2>
        <p className="section-sub">The arbiter sits between intent and execution. Watchdogs observe every subsystem and escalate to a single decision point — never to the LLM directly.</p>
      </div>
      <div className="arch-wrap">
        <ArchDiagram />
      </div>
    </div>
  </section>
);

window.Features = Features;
window.Architecture = Architecture;
