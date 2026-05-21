import { useState, useEffect, useRef } from "react";
import * as d3 from "d3";

const MODEL = "claude-sonnet-4-20250514";

const INGEST_SYSTEM = `You are an LLM Wiki maintainer. You maintain a personal knowledge base as structured markdown pages.

When given a source document, extract key information and integrate it into the wiki by creating or updating pages.

Return ONLY a valid JSON object (no markdown fences, no preamble) with this exact structure:
{
  "pages": [
    {
      "slug": "kebab-case-slug",
      "title": "Page Title",
      "summary": "One sentence description of this page",
      "content": "Full markdown content"
    }
  ],
  "log_entry": "Brief one-line description of what was ingested and key insights"
}

Guidelines:
- Create pages for key entities, concepts, people, technologies, ideas
- Update existing pages if a matching slug exists in current wiki (merge new info, preserve existing)
- Use [[Wikilink]] syntax inside content to link related pages (e.g. [[Machine Learning]])
- Each page content should use: # Title, ## Section headings, **bold**, bullet lists
- Include a Sources section at the bottom of each page
- Slugs must be kebab-case (e.g. "machine-learning", "alan-turing")
- A single source may produce 3-8 wiki pages
- "pages" array contains both new pages AND updated existing pages`;

const QUERY_SYSTEM = `You answer questions using the provided wiki pages.
Cite sources using [[Page Title]] notation when referencing specific pages.
Be concise but thorough. If the wiki lacks relevant info, say so clearly.`;

// ── D3 graph view ─────────────────────────────────────────────────────────────
function GraphView({ pages, pageContents, onPageClick, activeSlug }) {
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const simRef = useRef(null);
  const hoverRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const [stats, setStats] = useState({ nodes: 0, links: 0, hubs: 0 });

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return;
    if (simRef.current) simRef.current.stop();
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    const w = containerRef.current.clientWidth || 800;
    const h = containerRef.current.clientHeight || 600;

    if (pages.length === 0) {
      svg.append("text").attr("x", w / 2).attr("y", h / 2).attr("text-anchor", "middle")
        .attr("fill", "#0a1e2e").attr("font-family", '"Space Mono", monospace').attr("font-size", "13px")
        .text("No pages yet — ingest a source to build the knowledge graph");
      return;
    }

    // Build edges from [[wikilinks]] in page content
    const nodeMap = new Map(pages.map(p => [p.slug, { ...p, id: p.slug }]));
    const linkSet = new Set();
    const rawLinks = [];
    for (const page of pages) {
      const content = pageContents[page.slug] || "";
      for (const m of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const tSlug = m[1].toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        if (nodeMap.has(tSlug) && tSlug !== page.slug) {
          const key = [page.slug, tSlug].sort().join("~");
          if (!linkSet.has(key)) { linkSet.add(key); rawLinks.push({ source: page.slug, target: tSlug }); }
        }
      }
    }

    const connCount = new Map(pages.map(p => [p.slug, 0]));
    for (const l of rawLinks) {
      connCount.set(l.source, (connCount.get(l.source) || 0) + 1);
      connCount.set(l.target, (connCount.get(l.target) || 0) + 1);
    }
    const nodes = [...nodeMap.values()].map(p => ({ ...p, connections: connCount.get(p.slug) || 0 }));
    setStats({ nodes: nodes.length, links: rawLinks.length, hubs: nodes.filter(n => n.connections >= 3).length });

    // SVG filters for neon glow
    const defs = svg.append("defs");
    const makeFilter = (id, dev) => {
      const f = defs.append("filter").attr("id", id).attr("x", "-60%").attr("y", "-60%").attr("width", "220%").attr("height", "220%");
      f.append("feGaussianBlur").attr("stdDeviation", dev).attr("result", "blur");
      const m = f.append("feMerge");
      m.append("feMergeNode").attr("in", "blur");
      m.append("feMergeNode").attr("in", "SourceGraphic");
    };
    makeFilter("glow-sm", 2.5);
    makeFilter("glow-md", 5);
    makeFilter("glow-lg", 9);

    const g = svg.append("g");
    const zoom = d3.zoom().scaleExtent([0.1, 6]).on("zoom", e => g.attr("transform", e.transform));
    svg.call(zoom);

    const R = d => Math.max(22, 22 + d.connections * 7);
    const stroke = d => d.id === activeSlug ? "#ff0088" : d.connections >= 4 ? "#00ff88" : d.connections >= 1 ? "#00e5ff" : "#003555";
    const filter = d => d.id === activeSlug ? "url(#glow-lg)" : d.connections >= 2 ? "url(#glow-md)" : "url(#glow-sm)";

    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(rawLinks).id(d => d.id).distance(145))
      .force("charge", d3.forceManyBody().strength(-420))
      .force("center", d3.forceCenter(w / 2, h / 2))
      .force("collision", d3.forceCollide(d => R(d) + 22));
    simRef.current = sim;

    // Links
    const linkEl = g.append("g").selectAll("line").data(rawLinks).join("line")
      .attr("stroke", "#00e5ff").attr("stroke-opacity", 0.15).attr("stroke-width", 1.5);

    // Node groups
    const nodeG = g.append("g").selectAll("g").data(nodes).join("g").style("cursor", "pointer")
      .call(d3.drag()
        .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }))
      .on("click", (e, d) => { e.stopPropagation(); onPageClick(d.id); })
      .on("mouseover", (e, d) => { hoverRef.current = d; })
      .on("mousemove", (e) => {
        if (!hoverRef.current || !containerRef.current) return;
        const r = containerRef.current.getBoundingClientRect();
        setTooltip({ x: e.clientX - r.left + 16, y: e.clientY - r.top - 10, node: hoverRef.current });
      })
      .on("mouseout", () => { hoverRef.current = null; setTooltip(null); });

    // Outer glow ring
    nodeG.append("circle").attr("r", d => R(d) + 9).attr("fill", "none")
      .attr("stroke", d => stroke(d)).attr("stroke-width", 0.5).attr("stroke-opacity", 0.28)
      .attr("filter", "url(#glow-sm)");

    // Main circle
    nodeG.append("circle").attr("r", d => R(d)).attr("fill", "#060810")
      .attr("stroke", d => stroke(d)).attr("stroke-width", d => d.id === activeSlug ? 2.5 : 1.5)
      .attr("filter", d => filter(d));

    // Label
    nodeG.append("text")
      .text(d => { const ml = d.connections >= 3 ? 14 : 11; return d.title.length > ml ? d.title.slice(0, ml - 1) + "…" : d.title; })
      .attr("text-anchor", "middle").attr("dy", "0.35em")
      .attr("fill", d => stroke(d)).attr("font-size", "9px")
      .attr("font-family", '"Space Mono", monospace')
      .attr("filter", d => d.id === activeSlug ? "url(#glow-md)" : "url(#glow-sm)")
      .attr("pointer-events", "none");

    sim.on("tick", () => {
      linkEl.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      nodeG.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    svg.on("dblclick.zoom", () => svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(w / 2, h / 2).scale(0.85).translate(-w / 2, -h / 2)));

    return () => { sim.stop(); };
  }, [pages, pageContents, activeSlug]);

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <svg ref={svgRef} style={{ width: "100%", height: "100%", display: "block" }} />

      {/* Stats HUD */}
      <div style={{ position: "absolute", top: "1rem", left: "1rem", display: "flex", gap: "0.6rem" }}>
        {[["NODES", stats.nodes, "#00e5ff"], ["LINKS", stats.links, "#00e5ff"], ["HUBS", stats.hubs, "#00ff88"]].map(([k, v, col]) => (
          <div key={k} style={{ background: "rgba(6,8,16,0.88)", border: `1px solid rgba(0,229,255,0.2)`, borderRadius: "3px", padding: "0.3rem 0.65rem", backdropFilter: "blur(8px)" }}>
            <span style={{ fontFamily: '"Space Mono", monospace', fontSize: "0.58rem", color: "#3a7090", letterSpacing: "0.1em", marginRight: "0.4rem" }}>{k}</span>
            <span style={{ fontFamily: '"Space Mono", monospace', fontSize: "0.82rem", color: col, textShadow: `0 0 8px ${col}` }}>{v}</span>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div style={{ position: "absolute", bottom: "1rem", left: "1rem", background: "rgba(6,8,16,0.88)", border: "1px solid #0a1228", borderRadius: "3px", padding: "0.6rem 0.8rem", backdropFilter: "blur(8px)" }}>
        {[["●", "#003555", "isolated"], ["●", "#00e5ff", "connected"], ["●", "#00ff88", "hub (4+)"], ["●", "#ff0088", "active"]].map(([s, col, lbl]) => (
          <div key={lbl} style={{ display: "flex", alignItems: "center", gap: "0.45rem", marginBottom: "0.18rem" }}>
            <span style={{ color: col, fontSize: "0.82rem", textShadow: col !== "#003555" ? `0 0 5px ${col}` : "none" }}>{s}</span>
            <span style={{ fontFamily: '"Space Mono", monospace', fontSize: "0.6rem", color: "#2a6080", letterSpacing: "0.05em" }}>{lbl}</span>
          </div>
        ))}
        <div style={{ fontFamily: '"Space Mono", monospace', fontSize: "0.58rem", color: "#1e4a62", marginTop: "0.35rem", borderTop: "1px solid #0a1228", paddingTop: "0.35rem" }}>drag · scroll zoom · dbl-click reset</div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div style={{ position: "absolute", left: tooltip.x, top: tooltip.y, background: "rgba(6,8,20,0.96)", border: "1px solid rgba(0,229,255,0.4)", borderRadius: "3px", padding: "0.55rem 0.8rem", fontFamily: '"Space Mono", monospace', fontSize: "11px", pointerEvents: "none", zIndex: 50, maxWidth: "190px", boxShadow: "0 0 16px rgba(0,229,255,0.2)" }}>
          <div style={{ color: "#00e5ff", marginBottom: "4px", textShadow: "0 0 6px #00e5ff" }}>{tooltip.node.title}</div>
          <div style={{ color: "#3a7898", marginBottom: "4px", lineHeight: 1.4, fontSize: "10px" }}>{tooltip.node.summary}</div>
          <div style={{ color: "#2a5878", fontSize: "10px" }}>{tooltip.node.connections} link{tooltip.node.connections !== 1 ? "s" : ""} · click to open</div>
        </div>
      )}
    </div>
  );
}

// ── markdown renderer ─────────────────────────────────────────────────────────
function md(text, onLink) {
  if (!text) return null;
  const lines = text.split("\n"); const out = []; let key = 0; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("# ")) {
      out.push(<h1 key={key++} style={{ fontFamily: '"Orbitron", monospace', fontSize: "1.5rem", fontWeight: 700, color: "#b8e0f8", marginBottom: "0.3rem", textShadow: "0 0 18px rgba(0,229,255,0.15)", lineHeight: 1.3 }}>{ri(line.slice(2), onLink)}</h1>);
    } else if (line.startsWith("## ")) {
      out.push(<h2 key={key++} style={{ fontFamily: '"Space Mono", monospace', fontSize: "0.88rem", fontWeight: 700, color: "#00e5ff", marginTop: "1.5rem", marginBottom: "0.4rem", letterSpacing: "0.1em", textShadow: "0 0 8px rgba(0,229,255,0.35)" }}>{ri(line.slice(3), onLink)}</h2>);
    } else if (line.startsWith("### ")) {
      out.push(<h3 key={key++} style={{ fontFamily: '"Space Mono", monospace', fontSize: "0.8rem", fontWeight: 700, color: "#2a8aaa", marginTop: "1rem", marginBottom: "0.3rem", letterSpacing: "0.06em" }}>{ri(line.slice(4), onLink)}</h3>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      const items = [];
      while (i < lines.length && (lines[i].startsWith("- ") || lines[i].startsWith("* "))) {
        items.push(<li key={i} style={{ marginBottom: "0.28rem" }}>{ri(lines[i].slice(2), onLink)}</li>); i++;
      }
      out.push(<ul key={key++} style={{ paddingLeft: "1.5rem", margin: "0.5rem 0", color: "#4a9ab8" }}>{items}</ul>); continue;
    } else if (line.startsWith("---")) {
      out.push(<hr key={key++} style={{ border: "none", borderTop: "1px solid #0a1228", margin: "1.25rem 0" }} />);
    } else if (line.trim() === "") {
      out.push(<div key={key++} style={{ height: "0.6rem" }} />);
    } else {
      out.push(<p key={key++} style={{ margin: "0.3rem 0", lineHeight: 1.9, color: "#5aaac8" }}>{ri(line, onLink)}</p>);
    }
    i++;
  }
  return out;
}

function ri(text, onLink) {
  const parts = []; let rem = text; let k = 0;
  while (rem.length > 0) {
    const wm = rem.match(/\[\[([^\]]+)\]\]/); const bm = rem.match(/\*\*([^*]+)\*\*/); const im = rem.match(/(?<!\*)\*([^*]+)\*(?!\*)/);
    let best = null, bi = Infinity;
    if (wm && wm.index < bi) { best = "w"; bi = wm.index; }
    if (bm && bm.index < bi) { best = "b"; bi = bm.index; }
    if (im && im.index < bi) { best = "i"; bi = im.index; }
    if (!best) { parts.push(rem); break; }
    if (bi > 0) parts.push(rem.slice(0, bi));
    if (best === "w") {
      const lt = wm[1], sl = lt.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      parts.push(<span key={k++} onClick={() => onLink && onLink(sl, lt)} style={{ color: "#00e5ff", cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted", textDecorationColor: "#004060", textShadow: "0 0 5px rgba(0,229,255,0.35)" }}>{lt}</span>);
      rem = rem.slice(bi + wm[0].length);
    } else if (best === "b") {
      parts.push(<strong key={k++} style={{ color: "#90d8f0" }}>{bm[1]}</strong>); rem = rem.slice(bi + bm[0].length);
    } else {
      parts.push(<em key={k++}>{im[1]}</em>); rem = rem.slice(bi + im[0].length);
    }
  }
  return parts.length === 1 && typeof parts[0] === "string" ? parts[0] : parts;
}

// ── main ─────────────────────────────────────────────────────────────────────
export default function LLMWiki() {
  const [pages, setPages] = useState([]);
  const [pageContents, setPageContents] = useState({});
  const [log, setLog] = useState([]);
  const [view, setView] = useState("home");
  const [currentSlug, setCurrentSlug] = useState(null);
  const [sourceText, setSourceText] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [queryText, setQueryText] = useState("");
  const [queryResult, setQueryResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [ready, setReady] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => { loadWiki(); }, []);

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(""), 3000); }

  async function resetWiki() {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 4000);
      return;
    }
    try {
      for (const pg of pages) { try { await window.storage.delete(`wiki_page_${pg.slug}`); } catch {} }
      try { await window.storage.delete("wiki_pages"); } catch {}
      try { await window.storage.delete("wiki_log"); } catch {}
      setPages([]); setPageContents({}); setLog([]);
      setCurrentSlug(null); setView("home"); setConfirmReset(false);
      showToast("⬡ Wiki cleared");
    } catch (e) { setError(`Reset failed: ${e.message}`); }
  }

  async function loadWiki() {
    try {
      const pr = await window.storage.get("wiki_pages");
      if (pr) {
        const p = JSON.parse(pr.value); setPages(p);
        const c = {};
        for (const pg of p) { try { const cr = await window.storage.get(`wiki_page_${pg.slug}`); if (cr) c[pg.slug] = cr.value; } catch {} }
        setPageContents(c);
      }
      const lr = await window.storage.get("wiki_log");
      if (lr) setLog(JSON.parse(lr.value));
    } catch {}
    setReady(true);
  }

  async function ingest() {
    if (!sourceText.trim()) return;
    setLoading(true); setError(""); setLoadingMsg("Reading source…");
    try {
      const ctx = pages.map(p => `slug:"${p.slug}" title:"${p.title}" — ${p.summary}`).join("\n");
      const userMsg = `Current wiki:\n${ctx || "(empty)"}\n\nSource${sourceTitle ? ` — "${sourceTitle}"` : ""}:\n---\n${sourceText.trim()}\n---`;
      setLoadingMsg("Synthesizing knowledge…");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: INGEST_SYSTEM, messages: [{ role: "user", content: userMsg }] }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      const raw = (data.content.find(b => b.type === "text")?.text || "").replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim();
      const result = JSON.parse(raw);
      setLoadingMsg("Updating knowledge graph…");
      const updPages = [...pages]; const updC = { ...pageContents };
      for (const pg of result.pages || []) {
        await window.storage.set(`wiki_page_${pg.slug}`, pg.content);
        updC[pg.slug] = pg.content;
        const idx = updPages.findIndex(p => p.slug === pg.slug);
        const entry = { slug: pg.slug, title: pg.title, summary: pg.summary || "", date: new Date().toISOString().split("T")[0] };
        if (idx >= 0) updPages[idx] = entry; else updPages.push(entry);
      }
      await window.storage.set("wiki_pages", JSON.stringify(updPages));
      setPages(updPages); setPageContents(updC);
      const nl = [...log, { date: new Date().toISOString(), type: "ingest", entry: result.log_entry || `Ingested: ${sourceTitle || "source"}` }];
      await window.storage.set("wiki_log", JSON.stringify(nl)); setLog(nl);
      setSourceText(""); setSourceTitle("");
      showToast(`⬡ ${result.pages?.length || 0} pages synthesized`);
      setView("home");
    } catch (e) { setError(`Ingest failed: ${e.message}`); }
    setLoading(false); setLoadingMsg("");
  }

  async function query() {
    if (!queryText.trim()) return;
    setLoading(true); setError(""); setQueryResult(""); setLoadingMsg("Scanning knowledge graph…");
    try {
      let ctx;
      if (pages.length === 0) ctx = "(Wiki is empty.)";
      else if (pages.length <= 12) ctx = pages.map(p => `## [[${p.title}]] (slug: ${p.slug})\n${pageContents[p.slug] || "(no content)"}`).join("\n\n---\n\n");
      else ctx = "Wiki Index:\n" + pages.map(p => `- [[${p.title}]] (${p.slug}): ${p.summary}`).join("\n");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: QUERY_SYSTEM, messages: [{ role: "user", content: `Wiki:\n${ctx}\n\nQuestion: ${queryText}` }] }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      setQueryResult(data.content.find(b => b.type === "text")?.text || "");
      const nl = [...log, { date: new Date().toISOString(), type: "query", entry: queryText }];
      await window.storage.set("wiki_log", JSON.stringify(nl)); setLog(nl);
    } catch (e) { setError(`Query failed: ${e.message}`); }
    setLoading(false); setLoadingMsg("");
  }

  function openPage(slug, fallbackTitle) {
    let pg = pages.find(p => p.slug === slug);
    if (!pg && fallbackTitle) pg = pages.find(p => p.title.toLowerCase() === fallbackTitle.toLowerCase());
    if (pg) { setCurrentSlug(pg.slug); setView("page"); }
    else { setError(`[[${fallbackTitle || slug}]] doesn't exist yet.`); setTimeout(() => setError(""), 3000); }
  }

  const currentPage = pages.find(p => p.slug === currentSlug);
  const isGraph = view === "graph";

  const N = { bg: "#030408", surface: "#060810", border: "#0e1c35", cyan: "#00e5ff", green: "#00ff88", magenta: "#ff0088", text: "#4a9ab8", textBright: "#b8e0f5", textDim: "#2a6080", mono: '"Space Mono", monospace', display: '"Orbitron", monospace' };

  const navBtn = (active, col) => ({
    background: active ? "rgba(0,229,255,0.07)" : "transparent",
    border: active ? `1px solid rgba(0,229,255,0.3)` : `1px solid ${N.border}`,
    color: active ? (col || N.cyan) : N.text,
    padding: "0.28rem 0.8rem", borderRadius: "3px", cursor: "pointer",
    fontSize: "0.72rem", fontFamily: N.mono, letterSpacing: "0.08em", transition: "all 0.15s",
    textShadow: active ? `0 0 7px ${col || N.cyan}` : "none",
    boxShadow: active ? `0 0 10px rgba(0,229,255,0.1)` : "none",
  });

  if (!ready) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: N.bg }}>
      <div style={{ fontFamily: N.mono, color: N.textDim, fontSize: "0.75rem", letterSpacing: "0.15em" }}>INITIALIZING…</div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: N.bg, color: N.textBright, fontFamily: N.mono, overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.45} }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #0a1830; border-radius: 2px; }
        button:hover { opacity: 0.78 !important; }
        input:focus, textarea:focus { border-color: rgba(0,229,255,0.35) !important; box-shadow: 0 0 0 1px rgba(0,229,255,0.1) !important; outline: none; }
        .icard:hover { border-color: rgba(0,229,255,0.4) !important; box-shadow: 0 0 18px rgba(0,229,255,0.07) !important; }
        .sbrow:hover { background: rgba(0,229,255,0.035) !important; }
      `}</style>

      {loading && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(3,4,8,0.9)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 200, backdropFilter: "blur(6px)" }}>
          <div style={{ width: "26px", height: "26px", border: "1px solid #0a2040", borderTop: `1px solid ${N.cyan}`, borderRadius: "50%", animation: "spin 0.55s linear infinite", marginBottom: "0.9rem", boxShadow: `0 0 14px rgba(0,229,255,0.4)` }} />
          <div style={{ fontFamily: N.mono, color: N.cyan, fontSize: "0.75rem", letterSpacing: "0.18em", textShadow: `0 0 10px ${N.cyan}`, animation: "pulse 1.6s ease-in-out infinite" }}>{loadingMsg}</div>
        </div>
      )}

      {toast && <div style={{ position: "fixed", bottom: "1.5rem", right: "1.5rem", background: N.surface, border: `1px solid rgba(0,255,136,0.35)`, color: N.green, padding: "0.55rem 0.95rem", fontFamily: N.mono, fontSize: "0.72rem", borderRadius: "3px", zIndex: 300, boxShadow: `0 0 14px rgba(0,255,136,0.12)`, letterSpacing: "0.06em" }}>{toast}</div>}

      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", padding: "0 1.5rem", height: "46px", borderBottom: `1px solid ${N.border}`, background: N.surface, flexShrink: 0, gap: "0.45rem", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,229,255,0.012) 3px, rgba(0,229,255,0.012) 4px)", pointerEvents: "none" }} />
        <div onClick={() => setView("home")} style={{ fontFamily: N.display, fontSize: "0.82rem", fontWeight: 700, color: N.cyan, letterSpacing: "0.22em", marginRight: "auto", textShadow: `0 0 14px ${N.cyan}, 0 0 28px rgba(0,229,255,0.25)`, cursor: "pointer", userSelect: "none" }}>◈ LLM WIKI</div>
        <button style={navBtn(isGraph, N.green)} onClick={() => setView("graph")}>◈ graph</button>
        <button style={navBtn(view === "ingest")} onClick={() => setView("ingest")}>+ ingest</button>
        <button style={navBtn(view === "query")} onClick={() => setView("query")}>? query</button>
        <button style={navBtn(view === "log")} onClick={() => setView("log")}>≡ log</button>
        <div style={{ width: "1px", height: "18px", background: N.border, margin: "0 0.2rem" }} />
        <button onClick={resetWiki} style={{ background: confirmReset ? "rgba(255,0,136,0.12)" : "transparent", border: `1px solid ${confirmReset ? "rgba(255,0,136,0.5)" : N.border}`, color: confirmReset ? N.magenta : "#3a5570", padding: "0.28rem 0.7rem", borderRadius: "3px", cursor: "pointer", fontSize: "0.72rem", fontFamily: N.mono, letterSpacing: "0.06em", transition: "all 0.15s", textShadow: confirmReset ? `0 0 8px ${N.magenta}` : "none", boxShadow: confirmReset ? "0 0 10px rgba(255,0,136,0.15)" : "none" }}>
          {confirmReset ? "confirm?" : "⊘ reset"}
        </button>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar — hidden in graph view */}
        {!isGraph && (
          <aside style={{ width: "195px", borderRight: `1px solid ${N.border}`, display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0, background: N.surface }}>
            <div style={{ padding: "0.6rem 1rem 0.45rem", fontSize: "0.58rem", color: N.textDim, letterSpacing: "0.18em", textTransform: "uppercase", borderBottom: `1px solid ${N.border}` }}>pages ({pages.length})</div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {pages.length === 0
                ? <div style={{ padding: "1rem", color: N.textDim, fontSize: "0.72rem", lineHeight: 1.9 }}>no pages yet.<br />ingest a source.</div>
                : pages.map(p => {
                  const active = currentSlug === p.slug && view === "page";
                  return (
                    <div key={p.slug} className="sbrow" style={{ padding: "0.52rem 1rem 0.48rem", cursor: "pointer", background: active ? "rgba(0,229,255,0.06)" : "transparent", borderLeft: active ? `2px solid ${N.cyan}` : "2px solid transparent", transition: "all 0.1s", boxShadow: active ? "inset 0 0 24px rgba(0,229,255,0.03)" : "none" }} onClick={() => openPage(p.slug)}>
                      <div style={{ fontSize: "0.78rem", color: active ? N.cyan : N.textBright, lineHeight: 1.3, textShadow: active ? `0 0 6px ${N.cyan}` : "none" }}>{p.title}</div>
                      <div style={{ fontSize: "0.62rem", color: N.textDim, marginTop: "2px" }}>{p.date}</div>
                    </div>
                  );
                })}
            </div>
          </aside>
        )}

        {/* Main area */}
        <main style={{
          flex: 1, overflow: isGraph ? "hidden" : "auto",
          padding: isGraph ? 0 : "2rem 2.5rem 3rem", position: "relative",
          background: isGraph ? N.bg : N.bg,
          backgroundImage: !isGraph ? "linear-gradient(rgba(0,229,255,0.022) 1px, transparent 1px), linear-gradient(90deg, rgba(0,229,255,0.022) 1px, transparent 1px)" : "none",
          backgroundSize: !isGraph ? "48px 48px" : "auto",
        }}>
          {error && !isGraph && <div style={{ background: "#0e0510", border: "1px solid rgba(255,0,136,0.4)", color: "#e060a0", padding: "0.5rem 0.85rem", fontFamily: N.mono, fontSize: "0.73rem", borderRadius: "3px", marginBottom: "1rem", boxShadow: "0 0 10px rgba(255,0,136,0.08)" }}>{error}</div>}

          {/* Graph */}
          {isGraph && <GraphView pages={pages} pageContents={pageContents} onPageClick={slug => { openPage(slug); }} activeSlug={currentSlug} />}

          {/* Home — empty */}
          {view === "home" && pages.length === 0 && (
            <div style={{ maxWidth: "500px" }}>
              <div style={{ fontFamily: N.display, fontSize: "1.3rem", fontWeight: 700, color: N.textBright, marginBottom: "1rem", textShadow: "0 0 18px rgba(0,229,255,0.12)", lineHeight: 1.35 }}>Personal Knowledge Wiki</div>
              <p style={{ color: N.text, lineHeight: 2, fontSize: "0.85rem", marginBottom: "1.75rem" }}>Paste any text — articles, papers, notes — and Claude synthesizes it into a structured, interlinked wiki that compounds over time. The knowledge graph view shows all pages and their connections.</p>
              <div style={{ border: `1px solid ${N.border}`, borderRadius: "4px", padding: "0.9rem 1.1rem", marginBottom: "1.5rem", background: N.surface }}>
                {[["◈ graph", "Force-directed knowledge graph — pages as nodes, wikilinks as edges", N.green],
                  ["+ ingest", "Add a source — Claude extracts entities and creates linked pages", N.cyan],
                  ["? query", "Ask questions against your compiled knowledge base", N.cyan],
                  ["≡ log", "Chronological record of all ingests and queries", N.text]].map(([k, v, col]) => (
                  <div key={k} style={{ display: "flex", gap: "0.9rem", marginBottom: "0.6rem", alignItems: "flex-start" }}>
                    <code style={{ color: col, fontSize: "0.7rem", flexShrink: 0, paddingTop: "2px", textShadow: col !== N.text ? `0 0 5px ${col}` : "none" }}>{k}</code>
                    <span style={{ color: N.textDim, fontSize: "0.78rem", lineHeight: 1.7 }}>{v}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => setView("ingest")} style={{ background: "transparent", border: `1px solid ${N.cyan}`, color: N.cyan, padding: "0.5rem 1.2rem", fontFamily: N.mono, fontSize: "0.78rem", cursor: "pointer", borderRadius: "3px", letterSpacing: "0.08em", boxShadow: `0 0 12px rgba(0,229,255,0.13)`, textShadow: `0 0 7px ${N.cyan}` }}>
                + Ingest First Source
              </button>
            </div>
          )}

          {/* Home — index */}
          {view === "home" && pages.length > 0 && (
            <div>
              <div style={{ fontSize: "0.6rem", color: N.textDim, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: "1rem" }}>index — {pages.length} pages</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(215px, 1fr))", gap: "0.75rem" }}>
                {pages.map(p => (
                  <div key={p.slug} className="icard" onClick={() => openPage(p.slug)} style={{ border: `1px solid ${N.border}`, borderRadius: "4px", padding: "0.9rem 1.1rem", cursor: "pointer", transition: "all 0.15s", background: N.surface }}>
                    <div style={{ fontFamily: N.mono, fontSize: "0.85rem", marginBottom: "0.4rem", color: N.textBright, lineHeight: 1.3 }}>{p.title}</div>
                    <div style={{ fontSize: "0.72rem", color: N.text, lineHeight: 1.6 }}>{p.summary}</div>
                    <div style={{ fontSize: "0.62rem", color: N.textDim, marginTop: "0.45rem" }}>{p.date}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Page view */}
          {view === "page" && currentPage && (
            <div style={{ maxWidth: "680px" }}>
              <div style={{ fontSize: "0.65rem", color: N.textDim, marginBottom: "1.2rem" }}>
                <span style={{ color: N.text, cursor: "pointer" }} onClick={() => setView("home")}>index</span> /{" "}
                <span>{currentPage.slug}</span>
                <span style={{ marginLeft: "0.75rem", color: N.textDim, cursor: "pointer" }} onClick={() => { setCurrentSlug(currentPage.slug); setView("graph"); }}>◈ graph →</span>
              </div>
              <div style={{ fontFamily: N.display, fontSize: "1.5rem", fontWeight: 700, color: N.textBright, marginBottom: "0.25rem", textShadow: "0 0 18px rgba(0,229,255,0.12)", lineHeight: 1.3 }}>{currentPage.title}</div>
              <div style={{ fontSize: "0.65rem", color: N.textDim, marginBottom: "1.75rem" }}>{currentPage.date} · {currentPage.summary}</div>
              <div style={{ borderTop: `1px solid ${N.border}`, paddingTop: "1.5rem" }}>{md(pageContents[currentSlug], (s, t) => openPage(s, t))}</div>
            </div>
          )}

          {/* Ingest */}
          {view === "ingest" && (
            <div style={{ maxWidth: "630px" }}>
              <div style={{ fontFamily: N.display, fontSize: "1rem", fontWeight: 700, color: N.textBright, marginBottom: "1.5rem", textShadow: "0 0 14px rgba(0,229,255,0.12)" }}>Ingest Source</div>
              <div style={{ marginBottom: "0.85rem" }}>
                <div style={{ fontSize: "0.58rem", color: N.textDim, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "0.4rem" }}>Title (optional)</div>
                <input style={{ width: "100%", background: N.surface, border: `1px solid ${N.border}`, color: N.textBright, padding: "0.58rem 0.9rem", fontFamily: N.mono, fontSize: "0.82rem", borderRadius: "3px", boxSizing: "border-box" }} placeholder="Article name, topic…" value={sourceTitle} onChange={e => setSourceTitle(e.target.value)} />
              </div>
              <div style={{ marginBottom: "1.1rem" }}>
                <div style={{ fontSize: "0.58rem", color: N.textDim, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "0.4rem" }}>Source text</div>
                <textarea style={{ width: "100%", background: N.surface, border: `1px solid ${N.border}`, color: N.textBright, padding: "0.85rem", fontFamily: N.mono, fontSize: "0.8rem", resize: "vertical", borderRadius: "3px", outline: "none", lineHeight: 1.75, boxSizing: "border-box", minHeight: "175px" }} placeholder={"Paste any text — article, paper, notes, transcript…\n\nClaude will extract entities, create wiki pages, and weave [[wikilinks]] between them."} value={sourceText} onChange={e => setSourceText(e.target.value)} />
              </div>
              <div style={{ display: "flex", gap: "0.65rem" }}>
                <button onClick={ingest} disabled={!sourceText.trim() || loading} style={{ background: "transparent", border: `1px solid ${N.cyan}`, color: N.cyan, padding: "0.48rem 1.15rem", fontFamily: N.mono, fontSize: "0.78rem", cursor: "pointer", borderRadius: "3px", letterSpacing: "0.08em", boxShadow: `0 0 10px rgba(0,229,255,0.1)`, textShadow: `0 0 6px ${N.cyan}` }}>Synthesize into Wiki</button>
                <button onClick={() => { setSourceText(""); setView("home"); }} style={{ background: "transparent", border: `1px solid ${N.border}`, color: N.text, padding: "0.48rem 0.95rem", fontFamily: N.mono, fontSize: "0.78rem", cursor: "pointer", borderRadius: "3px" }}>Cancel</button>
              </div>
            </div>
          )}

          {/* Query */}
          {view === "query" && (
            <div style={{ maxWidth: "680px" }}>
              <div style={{ fontFamily: N.display, fontSize: "1rem", fontWeight: 700, color: N.textBright, marginBottom: "1.5rem", textShadow: "0 0 14px rgba(0,229,255,0.12)" }}>Query Wiki</div>
              <div style={{ display: "flex", gap: "0.65rem", marginBottom: "0.4rem" }}>
                <input style={{ flex: 1, background: N.surface, border: `1px solid ${N.border}`, color: N.textBright, padding: "0.58rem 0.9rem", fontFamily: N.mono, fontSize: "0.82rem", borderRadius: "3px" }} placeholder="Ask anything about your knowledge base…" value={queryText} onChange={e => setQueryText(e.target.value)} onKeyDown={e => e.key === "Enter" && query()} />
                <button onClick={query} disabled={!queryText.trim() || loading} style={{ background: "transparent", border: `1px solid ${N.cyan}`, color: N.cyan, padding: "0.48rem 1.05rem", fontFamily: N.mono, fontSize: "0.78rem", cursor: "pointer", borderRadius: "3px", flexShrink: 0, textShadow: `0 0 6px ${N.cyan}`, boxShadow: `0 0 10px rgba(0,229,255,0.1)`, letterSpacing: "0.06em" }}>Ask</button>
              </div>
              {pages.length === 0 && <div style={{ color: N.textDim, fontSize: "0.72rem", marginTop: "0.35rem" }}>wiki is empty — ingest sources first.</div>}
              {queryResult && (
                <div style={{ marginTop: "1.75rem", borderTop: `1px solid ${N.border}`, paddingTop: "1.5rem" }}>
                  <div style={{ fontSize: "0.58rem", color: N.textDim, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "1rem" }}>Answer</div>
                  {md(queryResult, (s, t) => openPage(s, t))}
                  <div style={{ marginTop: "1.25rem" }}>
                    <button onClick={() => { setSourceText(`# Query: ${queryText}\n\n${queryResult}`); setSourceTitle(`Q: ${queryText.slice(0, 60)}`); setView("ingest"); }} style={{ background: "transparent", border: `1px solid ${N.border}`, color: N.text, padding: "0.38rem 0.85rem", fontFamily: N.mono, fontSize: "0.7rem", cursor: "pointer", borderRadius: "3px", letterSpacing: "0.05em" }}>→ file as wiki page</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Log */}
          {view === "log" && (
            <div style={{ maxWidth: "650px" }}>
              <div style={{ fontFamily: N.display, fontSize: "1rem", fontWeight: 700, color: N.textBright, marginBottom: "1.5rem", textShadow: "0 0 14px rgba(0,229,255,0.12)" }}>Activity Log</div>
              {log.length === 0
                ? <div style={{ color: N.textDim, fontSize: "0.78rem" }}>no activity yet.</div>
                : [...log].reverse().map((e, i) => (
                  <div key={i} style={{ borderBottom: `1px solid ${N.border}`, padding: "0.62rem 0", display: "flex", gap: "1rem", alignItems: "flex-start" }}>
                    <div style={{ fontSize: "0.62rem", color: N.textDim, flexShrink: 0, paddingTop: "3px", minWidth: "128px" }}>{e.date.replace("T", " ").slice(0, 16)}</div>
                    <div style={{ fontSize: "0.65rem", color: e.type === "ingest" ? N.cyan : N.text, flexShrink: 0, paddingTop: "3px", minWidth: "46px", textShadow: e.type === "ingest" ? `0 0 5px ${N.cyan}` : "none" }}>{e.type}</div>
                    <div style={{ fontSize: "0.8rem", color: N.text, lineHeight: 1.55 }}>{e.entry}</div>
                  </div>
                ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
