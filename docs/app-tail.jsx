/* global React */
const { useState, useEffect, useRef } = React;

// ──────────────────────────────── Install Block ────────────────────────────────
const InstallBlock = ({ cmd, label = "COPY" }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="install-block">
      <span className="prompt">$</span>
      <span className="cmd">{cmd}</span>
      <button className="copy" onClick={() => {
        try { navigator.clipboard.writeText(cmd); } catch(e) {}
        setCopied(true); setTimeout(() => setCopied(false), 1200);
      }}>{copied ? "COPIED" : label}</button>
    </div>
  );
};

// ──────────────────────────────── Code preview ────────────────────────────────
const CodeBlock = () => (
  <div className="term">
    <div className="term-bar">
      <div className="term-dots"><span /><span /><span /></div>
      <span className="term-title">agent.ts — minimal example</span>
      <div className="term-meta"><span><b>typescript</b></span></div>
    </div>
    <div className="term-body" style={{fontSize: 12.5, lineHeight: 1.65}}>
      <div><span style={{color:'var(--copper)'}}>import</span> {'{ '}<span style={{color:'var(--emerald)'}}>createAgent</span>, <span style={{color:'var(--emerald)'}}>Goal</span>{' }'} <span style={{color:'var(--copper)'}}>from</span> <span style={{color:'var(--emerald)'}}>"embark-ai"</span>;</div>
      <div><span style={{color:'var(--copper)'}}>import</span> {'{ '}<span style={{color:'var(--emerald)'}}>ollama</span>, <span style={{color:'var(--emerald)'}}>featherless</span>{' }'} <span style={{color:'var(--copper)'}}>from</span> <span style={{color:'var(--emerald)'}}>"embark-ai/llm"</span>;</div>
      <div style={{height: 8}} />
      <div><span style={{color:'var(--copper)'}}>const</span> agent = <span style={{color:'var(--copper)'}}>await</span> <span style={{color:'var(--emerald)'}}>createAgent</span>({'{'}</div>
      <div>  host: <span style={{color:'var(--emerald)'}}>"localhost"</span>, port: <span style={{color:'var(--gold)'}}>25565</span>,</div>
      <div>  username: <span style={{color:'var(--emerald)'}}>"embark"</span>,</div>
      <div style={{height: 4}} />
      <div>  <span style={{color:'var(--text-faint)'}}>// pick one — local or cloud</span></div>
      <div>  llm: <span style={{color:'var(--emerald)'}}>ollama</span>({'{ '}model: <span style={{color:'var(--emerald)'}}>"qwen2.5-coder:14b"</span> {'}'}),</div>
      <div>  <span style={{color:'var(--text-faint)'}}>// llm: featherless({'{ '}apiKey: process.env.FW_KEY {'}'}),</span></div>
      <div style={{height: 4}} />
      <div>  recovery: <span style={{color:'var(--emerald)'}}>"resume"</span>,</div>
      <div>  logs:     <span style={{color:'var(--emerald)'}}>"jsonl"</span>,</div>
      <div>{'}'});</div>
      <div style={{height: 8}} />
      <div><span style={{color:'var(--copper)'}}>await</span> agent.<span style={{color:'var(--emerald)'}}>pursue</span>(<span style={{color:'var(--emerald)'}}>Goal</span>.chopWood({'{ '}amount: <span style={{color:'var(--gold)'}}>32</span> {'}'}));</div>
    </div>
  </div>
);

// ──────────────────────────────── Setup section (LLM + system reqs) ────────────────────────────────
const SystemReq = [
  { req: "Node.js", val: "18+", note: "" },
  { req: "Java",    val: "21+", note: "for the Minecraft server" },
  { req: "RAM",     val: "4 GB minimum", note: "8 GB recommended (bot + server)" },
  { req: "OS",      val: "macOS · Linux", note: "Windows via WSL" },
  { req: "Disk",    val: "~1 GB", note: "server + world data" },
  { req: "Minecraft", val: "Vanilla Java 1.21.4", note: "installed locally" },
];

const OllamaModels = [
  { ram: "< 4 GB",  model: "llama3.2:1b",        size: "1.3 GB" },
  { ram: "4–8 GB",  model: "llama3.2",           size: "2.0 GB" },
  { ram: "16 GB",   model: "qwen2.5-coder:14b",  size: "9 GB", recommended: true },
  { ram: "32 GB+",  model: "qwen2.5:32b",        size: "20 GB" },
];

const Setup = () => (
  <section className="section" id="setup">
    <div className="shell">
      <div className="section-head">
        <span className="section-eyebrow">// runs anywhere</span>
        <h2 className="section-title">Bring your own model. Local or cloud.</h2>
        <p className="section-sub">Embark AI doesn't ship its own model. It plugs into whatever you already run — Ollama on your machine, or Featherless if you'd rather not host the weights yourself.</p>
      </div>

      <div className="setup-grid">
        {/* Ollama */}
        <div className="setup-card">
          <div className="setup-head">
            <div className="setup-badge emerald">LOCAL</div>
            <h3>Ollama</h3>
            <p>Run any Ollama-installed model on your machine. No keys, no quotas. Embark talks to <code>localhost:11434</code> out of the box.</p>
          </div>
          <table className="reqtable">
            <thead><tr><th>RAM available</th><th>Recommended model</th><th>Size</th></tr></thead>
            <tbody>
              {OllamaModels.map((m, i) => (
                <tr key={i} className={m.recommended ? "rec" : ""}>
                  <td>{m.ram}</td>
                  <td><code>{m.model}</code>{m.recommended && <span className="rec-pin">recommended</span>}</td>
                  <td className="num">{m.size}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <InstallBlock cmd="ollama pull qwen2.5-coder:14b" />
        </div>

        {/* Featherless */}
        <div className="setup-card">
          <div className="setup-head">
            <div className="setup-badge copper">CLOUD</div>
            <h3>Featherless AI</h3>
            <p>Drop in an API key from <code>featherless.ai</code> and Embark routes inference through them. No GPU on your box, no model download.</p>
          </div>
          <ul className="bullet-list">
            <li><span className="b-key">API key</span><span className="b-val">format <code>rc_xxx</code></span></li>
            <li><span className="b-key">Local GPU</span><span className="b-val">not required</span></li>
            <li><span className="b-key">Model download</span><span className="b-val">none</span></li>
            <li><span className="b-key">Bring your own</span><span className="b-val">any model Featherless hosts</span></li>
          </ul>
          <InstallBlock cmd="export FEATHERLESS_API_KEY=rc_xxxxxxxx" />
        </div>

        {/* System reqs */}
        <div className="setup-card wide">
          <div className="setup-head">
            <div className="setup-badge iron">HOST</div>
            <h3>System Requirements</h3>
            <p>Embark AI is self-hosted software. You run it on your machine alongside a vanilla Minecraft server.</p>
          </div>
          <table className="reqtable">
            <thead><tr><th>Requirement</th><th>Minimum</th><th>Note</th></tr></thead>
            <tbody>
              {SystemReq.map((r, i) => (
                <tr key={i}>
                  <td>{r.req}</td>
                  <td><code>{r.val}</code></td>
                  <td className="muted">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
);

// ──────────────────────────────── Open Source ────────────────────────────────
const OpenSource = () => (
  <section className="section" id="docs">
    <div className="shell">
      <div className="section-head">
        <span className="section-eyebrow">// install</span>
        <h2 className="section-title">Two commands. Self-hosted. MIT.</h2>
        <p className="section-sub">Embark AI is a single npm package. Install it next to your Minecraft server, point it at a model, and run.</p>
      </div>

      <div className="os-grid">
        <div className="os-card">
          <h3>Get started</h3>
          <p>Make sure you have a vanilla Java Edition 1.21.4 server running, Node 18+ installed, and either Ollama up or a Featherless key in your env.</p>
          <InstallBlock cmd="npm install embark-ai" />
          <InstallBlock cmd="npx embark-ai" />
          <CodeBlock />
        </div>

        <div style={{display: 'flex', flexDirection: 'column', gap: 16}}>
          <div className="os-card">
            <h3>Why this is open source</h3>
            <p>Embark AI is something I built for myself. I'm sharing it because the hard parts — the recovery logic, the watchdogs, the bounded primitives — are useful to anyone trying to run an LLM agent in a game world for more than five minutes.</p>
            <p>If you fork it, improve it, or just file a thoughtful issue, that's the contribution loop. No roadmap committee, no Slack, no Discord. Just a repo.</p>
          </div>
          <div className="os-card">
            <h3>Take a look</h3>
            <div style={{display: 'flex', gap: 10, flexWrap: 'wrap'}}>
              <a className="btn btn-primary" href="https://github.com/Syrthax/Embark-Ai" target="_blank" rel="noopener noreferrer"><Ico.github /> View on GitHub</a>
              <a className="btn" href="https://www.npmjs.com/package/embark-ai" target="_blank" rel="noopener noreferrer"><Ico.npm /> npm</a>
              <a className="btn btn-ghost" href="https://github.com/Syrthax/Embark-Ai#readme" target="_blank" rel="noopener noreferrer"><Ico.book /> Read the docs</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
);

// ──────────────────────────────── Footer ────────────────────────────────
const Footer = () => (
  <footer className="footer">
    <div className="shell">
      <div className="footer-grid">
        <div>
          <div className="brand" style={{marginBottom: 14}}>
            <BrandMark />
            <span>Embark AI</span>
            <span className="brand-tag">v1.0.6</span>
          </div>
          <p style={{color: 'var(--text-muted)', fontSize: 14, maxWidth: '34ch', lineHeight: 1.6, margin: 0}}>
            A resilient autonomous AI agent for Minecraft. Self-hosted, MIT-licensed, plugs into your own LLM.
          </p>
          <div style={{marginTop: 16, display: 'flex', gap: 10}}>
            <a className="btn" href="https://github.com/Syrthax/Embark-Ai" target="_blank" rel="noopener noreferrer"><Ico.github /></a>
            <a className="btn" href="https://www.npmjs.com/package/embark-ai" target="_blank" rel="noopener noreferrer"><Ico.npm /></a>
          </div>
        </div>
        <div>
          <h5>Project</h5>
          <ul>
            <li><a href="#features">Features</a></li>
            <li><a href="#architecture">Architecture</a></li>
            <li><a href="#telemetry">Logs</a></li>
            <li><a href="#why">About</a></li>
          </ul>
        </div>
        <div>
          <h5>Setup</h5>
          <ul>
            <li><a href="#setup">LLM options</a></li>
            <li><a href="#setup">System requirements</a></li>
            <li><a href="#docs">Install</a></li>
            <li><a href="https://github.com/Syrthax/Embark-Ai#readme" target="_blank" rel="noopener noreferrer">Documentation</a></li>
          </ul>
        </div>
        <div>
          <h5>Code</h5>
          <ul>
            <li><a href="https://github.com/Syrthax/Embark-Ai" target="_blank" rel="noopener noreferrer">GitHub</a></li>
            <li><a href="https://www.npmjs.com/package/embark-ai" target="_blank" rel="noopener noreferrer">npm</a></li>
            <li><a href="https://github.com/Syrthax/Embark-Ai/releases" target="_blank" rel="noopener noreferrer">Changelog</a></li>
            <li><a href="https://github.com/Syrthax/Embark-Ai/issues" target="_blank" rel="noopener noreferrer">Issues</a></li>
          </ul>
        </div>
        <div>
          <h5>Legal</h5>
          <ul>
            <li><a href="https://github.com/Syrthax/Embark-Ai/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a></li>
            <li><a href="https://github.com/Syrthax/Embark-Ai/blob/main/CODE_OF_CONDUCT.md" target="_blank" rel="noopener noreferrer">Code of Conduct</a></li>
            <li><a href="https://github.com/Syrthax/Embark-Ai/security" target="_blank" rel="noopener noreferrer">Security</a></li>
            <li><a href="https://www.minecraft.net" target="_blank" rel="noopener noreferrer">Not affiliated with Mojang</a></li>
          </ul>
        </div>
      </div>
      <div className="footer-base">
        <span>// embark-ai · v1.0.6 · MIT · a personal project</span>
        <span>© 2026 — built to survive the night</span>
      </div>
    </div>
  </footer>
);

window.Setup = Setup;
window.OpenSource = OpenSource;
window.Footer = Footer;
