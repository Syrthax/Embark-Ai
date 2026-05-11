/* global React */
const { useState, useEffect, useRef } = React;

const Sparkline = ({ color = "var(--emerald)", seed = 1 }) => {
  const points = [];
  let v = 12;
  for (let i = 0; i < 40; i++) {
    v += (Math.sin(i * 0.4 + seed) + Math.cos(i * 0.7 + seed * 2)) * 1.5;
    v = Math.max(2, Math.min(20, v));
    points.push(`${i * (100/39)},${24 - v}`);
  }
  return (
    <svg className="kpi-spark" viewBox="0 0 100 24" preserveAspectRatio="none">
      <polyline fill="none" stroke={color} strokeWidth="1" points={points.join(" ")}
        style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
      <polyline fill={color} fillOpacity="0.08" stroke="none"
        points={`0,24 ${points.join(" ")} 100,24`} />
    </svg>
  );
};

const STREAM_TEMPLATES = [
  { lvl: "info", msg: ({c}) => `task.tick step=${Math.floor(Math.random()*12)+1}/12 corr=${c}` },
  { lvl: "info", msg: ({c}) => `movement.step blocks=${Math.floor(Math.random()*8)+1} cost=${(Math.random()*8).toFixed(2)} corr=${c}` },
  { lvl: "ok",   msg: ({c}) => `inventory.update +1 cobblestone corr=${c}` },
  { lvl: "warn", msg: ({c}) => `watchdog.tick pathfinder=slow ttl=${1500+Math.floor(Math.random()*3000)}ms corr=${c}` },
  { lvl: "info", msg: ({c}) => `threat.score mob=zombie d=${(Math.random()*8+2).toFixed(1)}m action=evade corr=${c}` },
  { lvl: "ok",   msg: ({c}) => `task.resume state=restored loss=0 corr=${c}` },
  { lvl: "crit", msg: ({c}) => `desync.detected drift=${(1+Math.random()*2).toFixed(2)}s corr=${c}` },
  { lvl: "info", msg: ({c}) => `arbiter.policy escalate=recover_then_resume corr=${c}` },
  { lvl: "ok",   msg: ({c}) => `reconnect.success rtt=${100+Math.floor(Math.random()*200)}ms corr=${c}` },
  { lvl: "info", msg: ({c}) => `goal.advance child=mine_iron parent=outfit corr=${c}` },
];
const LVL_TXT = { info: "INFO", ok: "OK  ", warn: "WARN", crit: "CRIT" };

function stampNow(offsetSec) {
  const d = new Date(Date.now() + offsetSec*1000);
  const pad = (n,l=2) => String(n).padStart(l,'0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`;
}

const LiveLog = () => {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let i = 0;
    const init = [];
    for (let k = 0; k < 9; k++) {
      const tpl = STREAM_TEMPLATES[k % STREAM_TEMPLATES.length];
      const c = (Math.random()*0xffff | 0).toString(16).padStart(4,'0');
      init.push({ id: i++, ts: stampNow(-k*1.2), lvl: tpl.lvl, msg: tpl.msg({c}) });
    }
    setRows(init.reverse());
    const t = setInterval(() => {
      const tpl = STREAM_TEMPLATES[Math.floor(Math.random()*STREAM_TEMPLATES.length)];
      const c = (Math.random()*0xffff | 0).toString(16).padStart(4,'0');
      setRows(rs => [...rs.slice(-8), { id: ++i, ts: stampNow(0), lvl: tpl.lvl, msg: tpl.msg({c}) }]);
    }, 1400);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="term">
      <div className="term-bar">
        <div className="term-dots"><span /><span /><span /></div>
        <span className="term-title">JSONL log stream</span>
        <div className="term-meta">
          <span>tail <b>-f</b></span>
        </div>
      </div>
      <div className="term-body" style={{minHeight: 320}}>
        {rows.map(r => (
          <div key={r.id} className="term-row">
            <span className="ts">{r.ts}</span>
            <span className={`lvl ${r.lvl}`}>{LVL_TXT[r.lvl]}</span>
            <span className="msg">{r.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const KPI = ({ label, val, sub, color = "", sparkColor, seed }) => (
  <div className="kpi">
    <div className="kpi-label">{label}</div>
    <div className={`kpi-val ${color}`}>{val}</div>
    <div className="kpi-sub">{sub}</div>
    <Sparkline color={sparkColor} seed={seed} />
  </div>
);

const Telemetry = () => {
  return (
    <section className="section" id="telemetry">
      <div className="shell">
        <div className="section-head">
          <span className="section-eyebrow">// structured logs</span>
          <h2 className="section-title">Every decision the agent makes is greppable.</h2>
          <p className="section-sub">Embark emits JSONL with correlation IDs, parent task spans and recovery context. When something goes wrong overnight, you can replay exactly what the agent thought — and what it did about it.</p>
        </div>
        <LiveLog />
      </div>
    </section>
  );
};

const DEMOS = [
  { title: "Escaping Lava", tag: "RECOVERY", duration: "0:12", badge: "lava_arbiter", hint: "agent · 1080p · gif" },
  { title: "Reconnect After Desync", tag: "RUNTIME", duration: "0:18", badge: "session_restore", hint: "split-screen · before / after" },
  { title: "Autonomous Mining", tag: "TASK", duration: "0:42", badge: "mine_diamond", hint: "timelapse · 1m → 42s" },
  { title: "Combat Engagement", tag: "BEHAVIOR", duration: "0:09", badge: "threat_score", hint: "first-person · screen capture" },
  { title: "Player Follow Mode", tag: "INTENT", duration: "0:22", badge: "follow_player", hint: "third-person · escort" },
  { title: "Slash-Command Nav", tag: "CONTROL", duration: "0:14", badge: "/goto x z", hint: "chat input · agent reaction" },
];

const DemoCard = ({ d }) => (
  <div className="demo">
    <div className="demo-frame">
      <div className="badge"><span style={{width: 4, height: 4, background: 'var(--emerald)', boxShadow:'0 0 4px var(--emerald)'}} />{d.badge}</div>
      <div className="placeholder">{d.hint}</div>
      <div className="play-tri" />
      <div className="duration">{d.duration}</div>
    </div>
    <div className="demo-meta">
      <span className="demo-title">{d.title}</span>
      <span className="demo-tag">{d.tag}</span>
    </div>
  </div>
);

const Showcase = () => (
  <section className="section" id="showcase">
    <div className="shell">
      <div className="section-head">
        <span className="section-eyebrow">// recording</span>
        <h2 className="section-title">A single unscripted moment.</h2>
        <p className="section-sub">The agent was chopping wood for a planned base when a spider wandered into render distance. It dropped the wood task, switched to combat, killed the spider, and resumed chopping from the same tree — all on its own.</p>
      </div>
      <div style={{maxWidth: 920, margin: '0 auto'}}>
        <div className="demo" style={{borderRadius: 10}}>
          <div className="demo-frame demo-frame-video" style={{aspectRatio: '2 / 1', background: '#000', padding: 0}}>
            <iframe
              src="https://player.mux.com/01Qze01tWf100NYHSXM6CcWD01fkvC8NbjI9UAQypKctiYE"
              style={{position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none'}}
              allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          </div>
          <div className="demo-meta" style={{padding: '18px 22px'}}>
            <span className="demo-title">Chopping wood, interrupted by a spider</span>
            <span className="demo-tag">AUTONOMOUS</span>
          </div>
        </div>
      </div>
    </div>
  </section>
);

const PROBLEMS = [
  { t: "Pathfinder hangs silently", d: "Mineflayer's pathfinder can stall on edge geometry. No timeout — the agent just freezes." },
  { t: "Stale promises", d: "dig() / place() return promises that never resolve. The task loop hangs waiting forever." },
  { t: "Server desync drift", d: "Position drifts from the server's view. Mining the wrong block, walking into the wrong wall." },
  { t: "Lava deaths", d: "Naive pathfinders happily route through hot blocks. Agents die in minutes, not hours." },
  { t: "Watchdog conflicts", d: "Two systems each think they own the body. They fight, the agent jitters, nothing moves." },
  { t: "No recovery semantics", d: "When something breaks, the loop crashes or worse — runs in a corrupt state for days." },
];
const SOLUTIONS = [
  { t: "Bounded primitives", d: "Every action has an explicit timeout, cancellation token, and recovery path. Hangs become signals." },
  { t: "Promise-safe wrappers", d: "All Mineflayer calls go through Embark's wrappers. Stale promises are surfaced and retired." },
  { t: "Continuous drift detection", d: "Heartbeat sampling + chunk-state diffing catches desync before it corrupts task state." },
  { t: "Threat-aware movement", d: "The movement controller scores lava, mob proximity, fall damage and yields to safer plans." },
  { t: "Single-owner body", d: "Task tokens make conflicting intents impossible by construction. One controller, one body." },
  { t: "Arbiter-driven recovery", d: "Every failure becomes structured data. The arbiter decides — retry, restore, abort — never the LLM." },
];

const WhyEmbark = () => (
  <section className="section" id="why">
    <div className="shell">
      <div className="section-head">
        <span className="section-eyebrow">// what i was solving</span>
        <h2 className="section-title">A personal project about agents that don't quit.</h2>
        <p className="section-sub">I kept hitting the same wall: every Minecraft AI demo dies within minutes. Pathfinder hangs, promises stall, lava kills, the loop crashes. I wanted to see how far I could push a single agent if I took resilience seriously. This is what I ended up with.</p>
      </div>
      <div className="why-grid">
        <div className="why-col problems">
          <h3>What kept breaking <span className="badge">SYMPTOMS</span></h3>
          <div className="problem-list">
            {PROBLEMS.map((p, i) => (
              <div key={i} className="problem-item">
                <span className="ix">{String(i+1).padStart(2,'0')}</span>
                <div><h4>{p.t}</h4><p>{p.d}</p></div>
              </div>
            ))}
          </div>
        </div>
        <div className="why-col solutions">
          <h3>How Embark AI handles it <span className="badge">APPROACH</span></h3>
          <div className="solution-list">
            {SOLUTIONS.map((p, i) => (
              <div key={i} className="solution-item">
                <span className="ix">{String(i+1).padStart(2,'0')}</span>
                <div><h4>{p.t}</h4><p>{p.d}</p></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </section>
);

window.Telemetry = Telemetry;
window.Showcase = Showcase;
window.WhyEmbark = WhyEmbark;
