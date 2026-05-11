/* global React */
const { useState, useEffect, useRef } = React;

// ──────────────────────────────── Icons (small inline) ────────────────────────────────
const Ico = {
  github: (p) => (<svg viewBox="0 0 16 16" fill="currentColor" className="ico" {...p}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.34c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.81.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>),
  npm: (p) => (<svg viewBox="0 0 16 16" fill="currentColor" className="ico" {...p}><path d="M0 5h16v6h-8v1H4v-1H0V5zm1 5h2V7h1v3h1V6H1v4zm4 0h2V7h1v3h1V7h1v3h1V6H5v4zm6 0h2V7h1v3h1V6h-4v4z"/></svg>),
  arrow: (p) => (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="ico" {...p}><path d="M3 8h10M9 4l4 4-4 4"/></svg>),
  book: (p) => (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="ico" {...p}><path d="M2 3h5a2 2 0 012 2v9a2 2 0 00-2-2H2V3zM14 3H9a2 2 0 00-2 2v9a2 2 0 012-2h5V3z"/></svg>),
  copy: (p) => (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="ico" {...p}><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M11 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h2"/></svg>),
  discord: (p) => (<svg viewBox="0 0 16 16" fill="currentColor" className="ico" {...p}><path d="M13.55 3.06A12.5 12.5 0 0010.7 2.2l-.13.25c1.04.25 1.97.65 2.9 1.25-1.2-.6-2.5-.95-3.97-1A14 14 0 005.5 3.7c.86-.55 1.85-.95 2.9-1.2L8.27 2.2A12.5 12.5 0 005.42 3.06C2.66 7.1 1.92 11.04 2.27 14.92c1.1.8 2.18 1.3 3.23 1.62.27-.36.5-.75.7-1.16-.4-.15-.77-.34-1.12-.55l.27-.2c2.1 1 4.4 1 6.48 0l.27.2c-.35.21-.72.4-1.12.55.2.4.43.8.7 1.16 1.06-.32 2.13-.81 3.23-1.62.42-4.5-.7-8.4-2.36-11.86zM6.7 12.65c-.7 0-1.27-.65-1.27-1.45 0-.8.55-1.45 1.27-1.45.72 0 1.29.66 1.27 1.45 0 .8-.55 1.45-1.27 1.45zm4.7 0c-.7 0-1.27-.65-1.27-1.45 0-.8.56-1.45 1.27-1.45.72 0 1.29.66 1.27 1.45 0 .8-.55 1.45-1.27 1.45z"/></svg>),
};

// ──────────────────────────────── Brand mark ────────────────────────────────
const BrandMark = () => (
  <span className="brand-mark" aria-hidden="true">
    <span className="on" /><span /><span className="on" />
    <span /><span className="copper" /><span />
    <span className="on" /><span /><span className="on" />
  </span>
);

// ──────────────────────────────── Nav ────────────────────────────────
const Nav = () => (
  <header className="nav">
    <div className="shell nav-inner">
      <div className="brand">
        <BrandMark />
        <span>Embark AI</span>
        <span className="brand-tag">v1.0.6</span>
      </div>
      <nav className="nav-links">
        <a href="#features">Features</a>
        <a href="#architecture">Architecture</a>
        <a href="#telemetry">Logs</a>
        <a href="#why">About</a>
        <a href="#setup">Setup</a>
        <a href="#docs">Install</a>
      </nav>
      <div className="nav-cta">
        <a className="btn" href="https://github.com/Syrthax/Embark-Ai" target="_blank" rel="noopener noreferrer"><Ico.github /> GitHub</a>
      </div>
    </div>
  </header>
);

// ──────────────────────────────── Voxel silhouette SVG ────────────────────────────────
const VoxelSilhouette = () => {
  const blocks = [];
  let x = 0;
  const seed = [3,2,4,3,5,4,3,2,3,4,5,6,5,4,3,2,3,4,4,3,2,1,2,3,4,5,4,3,2,3,4,5,6,5,4,3,2,3,2,3,4,3,2,2,3,4,5,4,3,2,3,4,3,2,2];
  const BS = 24;
  for (let i = 0; i < seed.length; i++) {
    const h = seed[i];
    for (let j = 0; j < h; j++) {
      blocks.push(
        <rect key={`${i}-${j}`} x={i*BS} y={(8-h+j)*BS} width={BS} height={BS}
          fill={j === h-1 ? "#1a3326" : (j === h-2 ? "#13261d" : "#0a1813")}
          stroke="#07090a" strokeWidth="1" />
      );
    }
  }
  return (
    <svg className="voxel-silhouette" viewBox={`0 0 ${seed.length*BS} ${8*BS}`} preserveAspectRatio="xMidYMax slice">
      {blocks}
    </svg>
  );
};

// ──────────────────────────────── Particles ────────────────────────────────
const Particles = ({ count = 28 }) => {
  const items = Array.from({ length: count }, (_, i) => ({
    left: Math.random() * 100,
    delay: Math.random() * 8,
    dur: 6 + Math.random() * 6,
    size: Math.random() > 0.7 ? 3 : 2,
    color: Math.random() > 0.85 ? 'copper' : 'emerald',
    key: i,
  }));
  return (
    <div className="particles">
      {items.map(p => (
        <span key={p.key} className="particle" style={{
          left: `${p.left}%`,
          bottom: 0,
          animationDelay: `${p.delay}s`,
          animationDuration: `${p.dur}s`,
          width: p.size, height: p.size,
          background: p.color === 'copper' ? 'var(--copper)' : 'var(--emerald)',
          boxShadow: p.color === 'copper' ? '0 0 6px var(--copper)' : '0 0 6px var(--emerald)',
        }} />
      ))}
    </div>
  );
};

// ──────────────────────────────── Typing terminal ────────────────────────────────
const HERO_LOG = [
  { ts: "14:02:11.392", lvl: "info", lt: "INFO", msg: 'task.start  goal=mine_diamond  agent="embark-7"  corr=8af2' },
  { ts: "14:02:13.118", lvl: "info", lt: "INFO", msg: 'movement.path  blocks=47  cost=12.4  arbiter=ok' },
  { ts: "14:02:18.804", lvl: "warn", lt: "WARN", msg: 'watchdog.tick  pathfinder=stalled  ttl=4200ms  esc=1' },
  { ts: "14:02:19.001", lvl: "crit", lt: "CRIT", msg: 'desync.detected  server_drift=2.31s  trigger=heartbeat' },
  { ts: "14:02:19.052", lvl: "info", lt: "ARB ", msg: 'arbiter.escalate  policy=recover_then_resume  hold=task' },
  { ts: "14:02:21.300", lvl: "ok",   lt: "OK  ", msg: 'reconnect.success  rtt=187ms  session=restored' },
  { ts: "14:02:21.412", lvl: "ok",   lt: "OK  ", msg: 'task.resume  step=4/12  state=restored  loss=0' },
  { ts: "14:02:23.910", lvl: "info", lt: "INFO", msg: 'movement.unblocked  reroute=B+2  yield_to=lava_arbiter' },
];

const HeroTerminal = () => {
  const [visible, setVisible] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setVisible(v => v < HERO_LOG.length ? v + 1 : v);
    }, 600);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="term">
      <div className="term-bar">
        <div className="term-dots"><span /><span /><span /></div>
        <span className="term-title">embark.runtime — agent://embark-7 — task:mine_diamond</span>
        <div className="term-meta">
          <span>uptime <b>14d 06h</b></span>
          <span>recover <b>23</b></span>
        </div>
      </div>
      <div className="term-body">
        {HERO_LOG.slice(0, visible).map((row, i) => (
          <div key={i} className="term-row">
            <span className="ts">{row.ts}</span>
            <span className={`lvl ${row.lvl}`}>{row.lt}</span>
            <span className="msg">{row.msg}</span>
          </div>
        ))}
        {visible < HERO_LOG.length && <div className="term-row"><span className="ts">{HERO_LOG[visible]?.ts}</span><span className="lvl info">···</span><span className="msg"><span className="cursor" /></span></div>}
      </div>
      <div className="scan" />
    </div>
  );
};

// ──────────────────────────────── Hero ────────────────────────────────
const Hero = () => (
  <section className="hero">
    <Particles count={26} />
    <VoxelSilhouette />
    <div className="shell hero-grid">
      <div>
        <span className="pill"><span className="dot" />Open source · MIT · v1.0.6</span>
        <h1 className="hero-headline">
          A <em>resilient</em> autonomous AI agent for Minecraft.
        </h1>
        <p className="hero-sub">
          Embark AI is a personal project exploring how to make embodied LLM agents survive
          real play — not just demos. It handles desyncs, lava deaths, watchdog timeouts and
          stale promises so an agent can chop wood, mine, fight, and recover on its own,
          for hours at a time.
        </p>
        <div className="hero-ctas">
          <a className="btn btn-primary" href="https://github.com/Syrthax/Embark-Ai" target="_blank" rel="noopener noreferrer"><Ico.github /> View on GitHub</a>
          <a className="btn" href="https://www.npmjs.com/package/embark-ai" target="_blank" rel="noopener noreferrer"><Ico.npm /> npm install embark-ai</a>
          <a className="btn btn-ghost" href="#architecture">See how it works <Ico.arrow /></a>
        </div>
        <div className="hero-meta">
          <span>◇ MIT licensed</span>
          <span>· Node 18+</span>
          <span>· Minecraft 1.21.4</span>
          <span>· self-hosted</span>
        </div>
      </div>
      <div className="hero-cluster">
        <HeroTerminal />
      </div>
    </div>
  </section>
);

window.Hero = Hero;
window.Nav = Nav;
window.Ico = Ico;
window.BrandMark = BrandMark;
