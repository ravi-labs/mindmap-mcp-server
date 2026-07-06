/**
 * A local, read-only web UI to *see* your Mind Map.
 *
 *   npx @ravi-labs/mindmap-mcp-server dashboard   # -> http://127.0.0.1:7777
 *
 * Binds to loopback only (your machine, your eyes). Serves a single page plus a
 * small JSON API over the same local files the MCP server uses. Tabs: a
 * tier-grouped List, a Tree (🧠 → source → project → discussions), a topic Graph,
 * an Organize view (your Collections + how memory is auto-organized), Persona,
 * and an Activity console.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import express from "express";

import { readCalls } from "./calllog.js";
import {
  addToCollection,
  createCollection,
  deleteCollection,
  listCollections,
  removeFromCollection,
} from "./collections.js";
import { applyCuration, curate } from "./curate.js";
import { DATA_DIR } from "./constants.js";
import { health, makeTrace } from "./decay.js";
import { buildGraph } from "./graph.js";
import { lifecycle, provenance } from "./ledger.js";
import { exportPassport, importExport, importPassport } from "./passport.js";
import { detectTargets, syncPersona } from "./project.js";
import { importOptions, importSessions } from "./import.js";
import {
  complete,
  getSettings,
  isReady as llmReady,
  setSettings,
  status as llmStatus,
  type ProviderName,
} from "./llm.js";
import {
  allFacts,
  forgetFact,
  inferWithLLM,
  renderPersona,
  setFact,
  type PersonaCategory,
} from "./persona.js";
import { allEntries, deleteThread, getConfig, getThread, reindex, saveThread } from "./store.js";
import { getTranscript } from "./transcript.js";

const HOST = "127.0.0.1";
const PORT = parseInt(process.env.MINDMAP_UI_PORT || "7777", 10);

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mind Map</title>
<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --panel2:#1e222b; --line:#2a2f3a;
    --text:#e6e8ec; --muted:#9aa3b2; --hot:#ff6b4a; --warm:#f5c451; --cold:#5aa9e6; --accent:#7c5cff;
  }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
  header { padding:16px 22px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:22px; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; font-weight:600; }
  h1 span { color:var(--accent); }
  .score { display:flex; align-items:center; gap:10px; }
  .bar { width:150px; height:10px; border-radius:6px; background:var(--panel2); overflow:hidden; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,var(--cold),var(--accent)); }
  .counts { color:var(--muted); display:flex; gap:13px; flex-wrap:wrap; font-size:13px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:middle; }
  .syncbtn { margin-left:auto; background:var(--panel2); color:var(--text); border:1px solid var(--line); padding:6px 14px; border-radius:8px; cursor:pointer; font-size:13px; }
  .syncbtn:hover:not(:disabled) { border-color:var(--accent); }
  .syncbtn:disabled { opacity:.6; cursor:default; }
  .syncstatus { color:var(--muted); font-size:12px; min-width:0; }
  .tabs { display:flex; gap:6px; }
  .tabs button { background:var(--panel2); color:var(--muted); border:1px solid var(--line); padding:6px 14px; border-radius:8px; cursor:pointer; font-size:13px; }
  .tabs button.active { color:var(--text); border-color:var(--accent); }
  main { display:grid; grid-template-columns:minmax(320px,1fr) 1.4fr; height:calc(100vh - 63px); }
  #left { border-right:1px solid var(--line); overflow:auto; padding:16px; }
  #search { width:100%; padding:9px 12px; border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--text); margin-bottom:8px; }
  .txfilter { display:flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; margin-bottom:14px; cursor:pointer; }
  .txbadge { font-size:11px; opacity:.85; }
  .tier-h { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:16px 0 8px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:11px 13px; margin-bottom:8px; cursor:pointer; }
  .card:hover { border-color:var(--accent); }
  .card .t { font-weight:600; margin-bottom:3px; }
  .card .m { color:var(--muted); font-size:12px; }
  .badge { font-size:10px; padding:1px 7px; border-radius:20px; border:1px solid var(--line); margin-left:6px; }
  #right { overflow:auto; padding:24px 28px; }
  #detail h2 { margin:0 0 4px; }
  #detail .meta { color:var(--muted); margin-bottom:18px; }
  #detail pre { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; white-space:pre-wrap; word-wrap:break-word; }
  .tag { display:inline-block; background:var(--panel2); border:1px solid var(--line); border-radius:20px; padding:2px 10px; margin:2px 4px 2px 0; font-size:12px; color:var(--muted); }
  .empty { color:var(--muted); padding:40px; text-align:center; }
  .fullbtn { margin-top:18px; background:var(--panel2); color:var(--text); border:1px solid var(--line); padding:9px 16px; border-radius:8px; cursor:pointer; font-size:13px; }
  .fullbtn:hover { border-color:var(--accent); }
  .turn { margin:14px 0; }
  .turn .who { font-size:11px; color:var(--muted); margin-bottom:4px; }
  .turn .bubble { white-space:pre-wrap; word-wrap:break-word; border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .turn.user .bubble { background:var(--panel2); }
  .turn.assistant .bubble { background:var(--panel); }
  .md { line-height:1.6; }
  .md h1,.md h2,.md h3,.md h4 { margin:14px 0 6px; line-height:1.3; }
  .md h1 { font-size:20px; } .md h2 { font-size:17px; } .md h3 { font-size:15px; } .md h4 { font-size:14px; }
  .md p { margin:8px 0; }
  .md ul,.md ol { margin:8px 0; padding-left:22px; }
  .md li { margin:3px 0; }
  .md code { background:var(--panel2); border:1px solid var(--line); border-radius:4px; padding:1px 5px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  .md pre { background:#0b0d12; border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow:auto; margin:10px 0; }
  .md pre code { background:none; border:none; padding:0; white-space:pre; font-size:12.5px; }
  .md blockquote { border-left:3px solid var(--accent); margin:8px 0; padding:2px 0 2px 12px; color:var(--muted); }
  .md a { color:var(--accent); }
  .md hr { border:none; border-top:1px solid var(--line); margin:12px 0; }
  .md strong { color:#fff; }
  #treeWrap { display:none; grid-column:1 / -1; overflow:auto; padding:10px 0; }
  #graphWrap { display:none; grid-column:1 / -1; position:relative; }
  #gtools { position:absolute; top:12px; left:12px; right:12px; z-index:5; display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap; pointer-events:none; }
  #gtools > * { pointer-events:auto; }
  #gsearch { width:240px; padding:8px 11px; border-radius:8px; border:1px solid var(--line); background:rgba(23,26,33,.92); color:var(--text); }
  #chips { display:flex; gap:6px; flex-wrap:wrap; max-width:calc(100% - 260px); }
  .chip { font-size:12px; padding:3px 10px; border-radius:20px; border:1px solid var(--line); background:rgba(30,34,43,.92); color:var(--muted); cursor:pointer; }
  .chip.active { color:#fff; border-color:var(--accent); background:rgba(124,92,255,.25); }
  .chip.llmlabel { background:rgba(124,92,255,.12); border-color:var(--accent); color:#cfc6ff; }
  .chip.llmlabel.active { background:rgba(124,92,255,.35); color:#fff; }
  #fg { width:100%; height:calc(100vh - 63px); display:block; cursor:grab; background:radial-gradient(circle at 50% 40%, #14171d 0%, var(--bg) 70%); }
  #fg.grabbing { cursor:grabbing; }
  .gedge { stroke:#2a2f3a; }
  .gedge.rel { stroke:#7c5cff; stroke-opacity:.5; }
  .gnode { cursor:pointer; }
  .gnode text { paint-order:stroke; stroke:#0f1115; stroke-width:3px; }
  .gcat text { fill:#fff; font-weight:600; font-size:13px; }
  .gnode:not(.gcat) text { opacity:0; transition:opacity .12s; }
  .gnode:not(.gcat):hover text { opacity:1; }
  .gnode:not(.gcat):hover circle { r:7; }
  .dimmed { opacity:.06; }
  svg text { fill:var(--text); font-size:11px; }
  svg text.dim { fill:var(--muted); }
  .leaf { cursor:pointer; }
  .leaf:hover circle { stroke:var(--accent); stroke-width:2; }
  #activityWrap { display:none; grid-column:1 / -1; overflow:auto; padding:24px 30px; }
  .acthead { display:flex; align-items:baseline; gap:16px; }
  .acthead h2 { margin:0; }
  .callrow { display:flex; align-items:baseline; gap:10px; padding:7px 0; border-bottom:1px solid var(--line); font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .callrow .ct { color:var(--muted); flex:none; }
  .callrow .cn { color:var(--accent); font-weight:600; flex:none; min-width:170px; }
  .callrow .cm { color:var(--muted); flex:none; width:60px; text-align:right; }
  .callrow .ca { color:var(--text); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.8; }
  .callrow.err .cn { color:var(--hot); }
  .callrow.err .ca { color:var(--hot); }
  #personaWrap { display:none; grid-column:1 / -1; overflow:auto; padding:26px 30px; }
  #personaWrap { grid-template-columns:1.6fr 1fr; gap:30px; }
  .pcol { min-width:0; }
  .pside { border-left:1px solid var(--line); padding-left:30px; }
  .phead { display:flex; align-items:baseline; gap:14px; }
  .phead h2 { margin:0; }
  .pll { font-size:12px; color:var(--muted); }
  .pll.on { color:var(--cold); }
  .pmuted { color:var(--muted); font-size:13px; }
  .pcat { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--accent); margin:20px 0 8px; }
  .pfact { display:flex; align-items:center; gap:10px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 13px; margin-bottom:8px; }
  .pfact .ptext { flex:1; min-width:0; }
  .pfact .psrc { font-size:10px; padding:1px 8px; border-radius:20px; border:1px solid var(--line); color:var(--muted); }
  .pfact .psrc.declared { color:#fff; border-color:var(--accent); }
  .pconf { width:46px; height:6px; border-radius:4px; background:var(--panel2); overflow:hidden; flex:none; }
  .pconf > i { display:block; height:100%; background:linear-gradient(90deg,var(--cold),var(--accent)); }
  .pforget { background:none; border:none; color:var(--muted); cursor:pointer; font-size:15px; flex:none; padding:2px 4px; }
  .pforget:hover { color:var(--hot); }
  #pform input, #pform select, #llmform input, #llmform select, #passFile, #passKind { width:100%; padding:9px 11px; border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--text); margin-bottom:8px; font:inherit; }
  #pform input::placeholder, #llmform input::placeholder, #passFile::placeholder { color:var(--muted); }
  #pform select, #llmform select, #passKind { -webkit-appearance:none; appearance:none; padding-right:30px; cursor:pointer; background-color:var(--panel); background-repeat:no-repeat; background-position:right 10px center; background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8" viewBox="0 0 12 8" fill="none" stroke="%239aa3b2" stroke-width="1.6"><path d="M1 1l5 5 5-5"/></svg>'); }
  #pform select:focus, #pform input:focus, #llmform select:focus, #llmform input:focus { outline:none; border-color:var(--accent); }
  #pform .pbtn, #llmform .pbtn { width:100%; margin-top:2px; }
  .prow { display:flex; gap:8px; }
  .prow select, .prow input { flex:1; min-width:0; }
  .pbtn { background:var(--panel2); color:var(--text); border:1px solid var(--line); padding:9px 16px; border-radius:8px; cursor:pointer; font-size:13px; }
  .pbtn:hover { border-color:var(--accent); }
  .pbtn.primary { border-color:var(--accent); }
  .pbtn:disabled { opacity:.6; cursor:default; }
  .pdiv { border:none; border-top:1px solid var(--line); margin:22px 0; }
  .pempty { color:var(--muted); padding:30px 0; }
  .glass { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 14px; margin:14px 0; }
  .glass .grow { display:flex; gap:12px; padding:4px 0; font-size:13px; }
  .glass .gk { color:var(--accent); min-width:88px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; padding-top:2px; }
  .glass .gv { color:var(--text); flex:1; min-width:0; word-break:break-word; }
  .forgetrow { margin-top:18px; display:flex; align-items:center; gap:10px; }
  .forgetbtn { background:var(--panel2); color:var(--muted); border:1px solid var(--line); padding:7px 14px; border-radius:8px; cursor:pointer; font-size:13px; }
  .forgetbtn:hover { border-color:var(--hot); color:var(--hot); }
  .ptarget { display:flex; align-items:center; gap:9px; padding:7px 0; font-size:13px; border-bottom:1px solid var(--line); }
  .ptarget input { flex:none; }
  .ptarget .pt-id { font-weight:600; }
  .ptarget .pt-tag { font-size:10px; padding:1px 7px; border-radius:20px; border:1px solid var(--line); color:var(--muted); }
  .ptarget .pt-tag.on { color:var(--cold); border-color:var(--cold); }
  #organizeWrap { display:none; grid-column:1 / -1; overflow:auto; padding:26px 30px; grid-template-columns:1.6fr 1fr; gap:30px; }
  .ohead { display:flex; align-items:baseline; gap:14px; margin-bottom:4px; }
  .ohead h2 { margin:0; }
  .colcard { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:14px; }
  .colcard .colhd { display:flex; align-items:center; gap:9px; margin-bottom:8px; }
  .colcard .colnm { font-weight:600; font-size:15px; }
  .colcard .colct { color:var(--muted); font-size:12px; }
  .colcard .colpin { font-size:11px; color:var(--cold); border:1px solid var(--line); border-radius:20px; padding:1px 8px; }
  .colcard .coldel { margin-left:auto; background:none; border:none; color:var(--muted); cursor:pointer; font-size:14px; }
  .colcard .coldel:hover { color:var(--hot); }
  .colitem { display:flex; align-items:center; gap:9px; padding:6px 0; border-top:1px solid var(--line); font-size:13px; }
  .colitem .ci-t { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
  .colitem .ci-t:hover { color:var(--accent); }
  .colitem .ci-x { background:none; border:none; color:var(--muted); cursor:pointer; font-size:14px; flex:none; }
  .colitem .ci-x:hover { color:var(--hot); }
  .colitem .ci-n { color:var(--muted); font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .colcard .colempty { color:var(--muted); font-size:12.5px; padding:6px 0; border-top:1px solid var(--line); }
  .autorg { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:6px 16px 14px; margin-bottom:18px; }
  .autorg .ag { margin-top:12px; }
  .autorg .agh { font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--accent); margin-bottom:7px; }
  .obar { display:flex; height:12px; border-radius:6px; overflow:hidden; background:var(--panel2); margin-bottom:8px; }
  .obar > i { display:block; height:100%; }
  .ochips { display:flex; flex-wrap:wrap; gap:6px; }
  .ochip { font-size:12px; padding:3px 10px; border-radius:20px; border:1px solid var(--line); color:var(--muted); background:var(--panel2); }
  .ochip b { color:var(--text); font-weight:600; }
  .colbadge { font-size:10px; padding:1px 7px; border-radius:20px; border:1px solid var(--line); color:var(--muted); margin-left:6px; }
  #cform input, #cform select { width:100%; padding:9px 11px; border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--text); margin-bottom:8px; font:inherit; }
  #cform input::placeholder { color:var(--muted); }
  .curatebox { background:linear-gradient(180deg,rgba(124,92,255,.10),rgba(124,92,255,.02)); border:1px solid var(--line); border-radius:12px; padding:13px 15px; margin-bottom:18px; }
  .curatebox #curateFocus { flex:1; min-width:0; padding:9px 11px; border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--text); font:inherit; }
  .curatebox #curateFocus::placeholder { color:var(--muted); }
  #curatePanel { margin-top:12px; }
  .sug { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:10px; padding:11px 14px; margin-bottom:10px; }
  .sug .sh { display:flex; align-items:center; gap:9px; margin-bottom:4px; }
  .sug .snm { font-weight:600; }
  .sug .sct { color:var(--muted); font-size:12px; }
  .sug .sfile { margin-left:auto; }
  .sug .srat { color:var(--muted); font-size:12.5px; margin-bottom:7px; }
  .sug .sitems { font-size:12.5px; color:var(--text); }
  .sug .sitems div { padding:2px 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sug .smore { color:var(--muted); }
  .pbtn.sm { padding:5px 11px; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>🧠 Mind <span>Map</span></h1>
  <div class="score"><div class="bar"><i id="scoreBar"></i></div><strong id="scoreNum">–</strong><span style="color:var(--muted)">clean</span></div>
  <div class="counts" id="counts"></div>
  <button id="syncBtn" class="syncbtn" onclick="syncImport()" title="Import new sessions and refresh existing ones">⟳ Sync</button>
  <span id="syncStatus" class="syncstatus"></span>
  <div class="tabs">
    <button id="tabList" class="active" onclick="showTab('list')">List</button>
    <button id="tabTree" onclick="showTab('tree')">Tree</button>
    <button id="tabGraph" onclick="showTab('graph')">Graph</button>
    <button id="tabOrganize" onclick="showTab('organize')">Organize</button>
    <button id="tabPersona" onclick="showTab('persona')">Persona</button>
    <button id="tabActivity" onclick="showTab('activity')">Activity</button>
  </div>
</header>
<main>
  <div id="left">
    <input id="search" placeholder="Search memories…" oninput="render()" />
    <label class="txfilter"><input type="checkbox" id="txOnly" onchange="render()" /> 📜 with full transcript only</label>
    <label class="txfilter"><input type="checkbox" id="bsOnly" onchange="render()" /> 💡 brainstorms only</label>
    <div id="listWrap"></div>
  </div>
  <div id="right"><div id="detail" class="empty">Select a memory to view its context.</div></div>
  <div id="treeWrap"><svg id="tree"></svg></div>
  <div id="graphWrap">
    <div id="gtools">
      <input id="gsearch" placeholder="Search the graph…" oninput="applyFilter()" />
      <button id="llmLabelBtn" class="chip llmlabel" onclick="toggleLlmLabels()" title="Relabel topic clusters using your LLM (opt-in)">✨ LLM labels</button>
      <div id="chips"></div>
    </div>
    <svg id="fg"><g id="viewport"></g></svg>
  </div>
  <div id="personaWrap">
    <div class="pcol">
      <div class="phead">
        <h2>About you</h2>
        <span id="llmStatus" class="pll"></span>
      </div>
      <p class="pmuted">A profile any AI tool can read so it stops re-asking how you work. Declared facts are yours; <em>inferred</em> ones are learned from your memories.</p>
      <div id="personaFacts"></div>
    </div>
    <div class="pcol pside">
      <h3>Add a preference</h3>
      <form id="pform" onsubmit="return addFact(event)">
        <input id="pfText" placeholder="e.g. Prefers concise, code-first answers" required />
        <div class="prow">
          <select id="pfCat">
            <option value="identity">identity</option>
            <option value="stack">stack</option>
            <option value="style">style</option>
            <option value="communication">communication</option>
            <option value="constraints">constraints</option>
            <option value="workflow">workflow</option>
            <option value="goals">goals</option>
          </select>
          <select id="pfPol">
            <option value="prefer">prefer</option>
            <option value="avoid">avoid</option>
            <option value="fact">fact</option>
          </select>
        </div>
        <button type="submit" class="pbtn primary">Save preference</button>
      </form>
      <hr class="pdiv" />
      <h3>LLM <span class="pmuted" style="font-weight:400">(optional)</span></h3>
      <p class="pmuted">Plug in your own provider for richer inference. Pick it here; the API key stays in your environment — Mind Map never stores it.</p>
      <form id="llmform" onsubmit="return saveLlm(event)">
        <div class="prow">
          <select id="llmProvider" onchange="onProviderChange()">
            <option value="none">none (off)</option>
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
            <option value="google">google</option>
            <option value="ollama">ollama (local)</option>
          </select>
          <input id="llmModel" placeholder="model (blank = default)" />
        </div>
        <input id="llmBaseUrl" placeholder="base URL (ollama / self-hosted)" style="display:none" />
        <button type="submit" class="pbtn primary">Save LLM settings</button>
      </form>
      <div id="llmHint" class="pmuted" style="margin-top:10px"></div>
      <hr class="pdiv" />
      <h3>Learn from memories</h3>
      <p class="pmuted">Scan your memories for recurring signals. Uses your LLM if configured above, else a no-LLM heuristic.</p>
      <button class="pbtn" onclick="learnPersona()" id="learnBtn">✨ Learn now</button>
      <span id="learnStatus" class="pmuted"></span>

      <hr class="pdiv" />
      <h3>Sync persona → your tools</h3>
      <p class="pmuted">Write your persona into each tool's own config (Claude, Cursor, Copilot, Windsurf) so even non-MCP tools know how you work. Writes only inside a managed block.</p>
      <div id="targets"></div>
      <label class="txfilter" style="margin:8px 0"><input type="checkbox" id="projForce" /> also write tools not detected</label>
      <button class="pbtn primary" onclick="syncProjection()" id="projBtn">Write persona to selected tools</button>
      <span id="projStatus" class="pmuted"></span>

      <hr class="pdiv" />
      <h3>Memory Passport</h3>
      <p class="pmuted">Your context is yours. Export everything to a portable file, or pull conversations out of ChatGPT / Claude data exports.</p>
      <button class="pbtn" onclick="exportPassport()" id="passExportBtn">⬇ Export passport</button>
      <span id="passExportStatus" class="pmuted"></span>
      <div class="prow" style="margin-top:10px">
        <select id="passKind">
          <option value="passport">Mind Map passport</option>
          <option value="chatgpt">ChatGPT export</option>
          <option value="claude">Claude.ai export</option>
        </select>
      </div>
      <input id="passFile" placeholder="path to file (e.g. ~/Downloads/conversations.json)" />
      <button class="pbtn" onclick="importPassport()" id="passImportBtn">⬆ Import</button>
      <span id="passImportStatus" class="pmuted"></span>
    </div>
  </div>
  <div id="organizeWrap">
    <div class="pcol">
      <div class="ohead">
        <h2>Your collections</h2>
        <span class="pmuted">your layer on top of the automatic one</span>
      </div>
      <p class="pmuted">Group memories however you think — Goals, Parking Lot, Decisions, anything. Filing a memory here also <strong>protects it from decay</strong>: it won't be forgotten while it's filed. In any AI tool you can just say <em>"add this to my Goals"</em> or <em>"park this."</em></p>
      <div class="curatebox">
        <div class="prow">
          <input id="curateFocus" placeholder="Optional focus — e.g. apps I started and never finished" />
          <button class="pbtn primary" style="flex:none" onclick="runCurate()" id="curateBtn">✨ Auto-organize</button>
        </div>
        <span class="pmuted">Reads across all your sessions and proposes collections. Nothing is filed until you accept.</span>
        <div id="curatePanel"></div>
      </div>
      <div id="colList"></div>
    </div>
    <div class="pcol pside">
      <h3>New collection</h3>
      <form id="cform" onsubmit="return createCol(event)">
        <div class="prow">
          <input id="cfEmoji" placeholder="🎯" style="flex:none;width:64px;text-align:center" maxlength="2" />
          <input id="cfName" placeholder="e.g. Reading list" required />
        </div>
        <button type="submit" class="pbtn primary">Create collection</button>
      </form>
      <span id="cformStatus" class="pmuted"></span>

      <hr class="pdiv" />
      <h3>How Mind Map organizes automatically</h3>
      <p class="pmuted">This always runs underneath — no setup needed. Collections sit on top of it.</p>
      <div class="autorg" id="autorg"></div>
      <p class="pmuted">To file something: open a memory in the <a href="#" onclick="showTab('list');return false;" style="color:var(--accent)">List</a> and use “File into…”, or just tell any AI tool.</p>
    </div>
  </div>
  <div id="activityWrap">
    <div class="acthead">
      <h2>Activity</h2>
      <label class="txfilter"><input type="checkbox" id="actErrOnly" onchange="renderCalls()" /> errors only</label>
      <span id="actMeta" class="pmuted"></span>
    </div>
    <p class="pmuted">Every MCP tool call across all your tools (Claude Code, Cursor…), newest first. Redacted, from <code>~/.mindmap/calls.jsonl</code>. Auto-refreshes.</p>
    <div id="callLog"></div>
  </div>
</main>
<script>
var DATA = { health:{}, threads:[] };
var TIER = { hot:{c:'#ff6b4a',i:'🔥'}, warm:{c:'#f5c451',i:'🌤️'}, cold:{c:'#5aa9e6',i:'❄️'} };
var VIEW = 'list';

function esc(s){ return (s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

// Minimal, dependency-free Markdown renderer (escape-first, so it's XSS-safe).
function md(src){
  if(!src) return '';
  var BT=String.fromCharCode(96);
  var s=String(src).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  var blocks=[];
  var fence=new RegExp(BT+BT+BT+'([^\\n]*)\\n([\\s\\S]*?)'+BT+BT+BT,'g');
  s=s.replace(fence,function(m,lang,code){blocks.push(code);return 'MMBLK'+(blocks.length-1)+'KLB';});
  var icode=new RegExp(BT+'([^'+BT+']+)'+BT,'g');
  function inl(t){
    t=t.replace(icode,'<code>$1</code>');
    t=t.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
    t=t.replace(/(^|[^*])\\*([^*\\s][^*]*)\\*/g,'$1<em>$2</em>');
    t=t.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  }
  var L=s.split('\\n'),o=[],i=0;
  function isBlk(x){return /^MMBLK\\d+KLB$/.test(x.trim());}
  while(i<L.length){
    var ln=L[i];
    if(isBlk(ln)){o.push(ln.trim());i++;continue;}
    var h=ln.match(/^(#{1,6})\\s+(.*)$/);
    if(h){var lv=h[1].length;o.push('<h'+lv+'>'+inl(h[2])+'</h'+lv+'>');i++;continue;}
    if(/^(---|\\*\\*\\*|___)\\s*$/.test(ln)){o.push('<hr>');i++;continue;}
    if(/^>\\s?/.test(ln)){var q=[];while(i<L.length&&/^>\\s?/.test(L[i])){q.push(inl(L[i].replace(/^>\\s?/,'')));i++;}o.push('<blockquote>'+q.join('<br>')+'</blockquote>');continue;}
    if(/^\\s*[-*+]\\s+/.test(ln)){var u=[];while(i<L.length&&/^\\s*[-*+]\\s+/.test(L[i])){u.push('<li>'+inl(L[i].replace(/^\\s*[-*+]\\s+/,''))+'</li>');i++;}o.push('<ul>'+u.join('')+'</ul>');continue;}
    if(/^\\s*\\d+\\.\\s+/.test(ln)){var ol=[];while(i<L.length&&/^\\s*\\d+\\.\\s+/.test(L[i])){ol.push('<li>'+inl(L[i].replace(/^\\s*\\d+\\.\\s+/,''))+'</li>');i++;}o.push('<ol>'+ol.join('')+'</ol>');continue;}
    if(ln.trim()===''){i++;continue;}
    var p=[];
    while(i<L.length&&L[i].trim()!==''&&!isBlk(L[i])&&!/^(#{1,6})\\s|^>\\s?|^\\s*[-*+]\\s+|^\\s*\\d+\\.\\s+|^(---|\\*\\*\\*|___)\\s*$/.test(L[i])){p.push(inl(L[i]));i++;}
    o.push('<p>'+p.join('<br>')+'</p>');
  }
  var html=o.join('\\n');
  html=html.replace(/MMBLK(\\d+)KLB/g,function(m,n){return '<pre><code>'+blocks[+n]+'</code></pre>';});
  return html;
}
function projOf(t){ var skip={imported:1}; skip[t.source]=1; return (t.tags||[]).find(function(x){return !skip[x];}) || 'general'; }
function colsForId(id){ return (COLLECTIONS||[]).filter(function(c){ return (c.items||[]).some(function(it){ return (it.id||it)===id; }); }).map(function(c){ return {id:c.id,name:c.name,emoji:c.emoji}; }); }

function load(){
  fetch('/api/data').then(function(r){return r.json();}).then(function(d){
    DATA = d; var h = d.health;
    document.getElementById('scoreBar').style.width = (h.cleanlinessScore||0)+'%';
    document.getElementById('scoreNum').textContent = (h.cleanlinessScore||0)+'%';
    document.getElementById('counts').innerHTML =
      '<span><i class="dot" style="background:#ff6b4a"></i>'+h.hot+' hot</span>'+
      '<span><i class="dot" style="background:#f5c451"></i>'+h.warm+' warm</span>'+
      '<span><i class="dot" style="background:#5aa9e6"></i>'+h.cold+' cold</span>'+
      '<span>★ '+h.promoted+' promoted</span><span>'+h.total+' total</span>';
    render();
  });
}

function filtered(){
  var q = document.getElementById('search').value.toLowerCase();
  return DATA.threads.filter(function(t){
    if(!q) return true;
    return (t.title+' '+(t.trace||'')+' '+(t.tags||[]).join(' ')+' '+t.source).toLowerCase().indexOf(q)>=0;
  });
}

function render(){ if(VIEW==='graph') return; if(VIEW==='tree') renderTree(filtered()); else renderList(filtered()); }

function renderList(items){
  var wrap = document.getElementById('listWrap');
  if(document.getElementById('txOnly').checked) items = items.filter(function(t){return t.hasTranscript;});
  if(document.getElementById('bsOnly').checked) items = items.filter(function(t){return t.kind==='brainstorm';});
  if(items.length===0){ wrap.innerHTML='<div class="empty">No matching memories.</div>'; return; }
  var html='';
  ['hot','warm','cold'].forEach(function(tier){
    var g = items.filter(function(t){return t.tier===tier;});
    if(!g.length) return;
    html += '<div class="tier-h">'+TIER[tier].i+' '+tier+' ('+g.length+')</div>';
    g.forEach(function(t){
      var tx = t.hasTranscript ? ' <span class="txbadge" title="Full discussion available">📜</span>' : '';
      var bs = t.kind==='brainstorm' ? ' <span class="txbadge" title="Brainstorm">💡</span>' : '';
      var rd = t.redacted ? ' <span class="txbadge" title="Secrets masked">🔒</span>' : '';
      var cols = colsForId(t.id);
      var cb = cols.length ? ' <span class="txbadge" title="In: '+esc(cols.map(function(c){return c.name;}).join(', '))+'">'+(cols[0].emoji||'📁')+'</span>' : '';
      html += '<div class="card" data-id="'+t.id+'">'+
        '<div class="t">'+(t.status==='promoted'?'★ ':'')+esc(t.title)+
        '<span class="badge" style="border-color:'+TIER[tier].c+'">'+esc(t.source)+'</span>'+tx+bs+rd+cb+'</div>'+
        '<div class="m">'+esc(t.trace||'')+'</div></div>';
    });
  });
  wrap.innerHTML = html;
}

function open_(id){
  fetch('/api/thread/'+id).then(function(r){return r.json();}).then(function(t){
    if(!t || t.error) return;
    if(VIEW!=='list') showTab('list');
    var kp = (t.keyPoints||[]).map(function(p){return '<li>'+esc(p)+'</li>';}).join('');
    var ns = (t.nextSteps||[]).map(function(p){return '<li>'+esc(p)+'</li>';}).join('');
    var tags = (t.tags||[]).map(function(x){return '<span class="tag">#'+esc(x)+'</span>';}).join('');
    var links = (t.links||[]).length ? '<p class="meta">🔗 Linked: '+t.links.length+' discussion(s)</p>' : '';
    // Only offer "full discussion" when a transcript actually exists on disk
    // (imported Claude Code / Cursor / Copilot). Captures, Cowork, and desktop
    // sources have no transcript — showing a dead button just confuses.
    var ref = t.sourceRef || {};
    var hasTranscript = ref.kind==='claude-code-cli' || ref.kind==='cursor' || ref.kind==='copilot';
    // Glass-box: where it came from, why it's trusted, when it fades.
    var lc = t._lifecycle || {};
    var fades = lc.next ? ('→ '+lc.next.to+(lc.next.to==='cold'?' trace':'')+' in '+lc.next.inDays+'d') : (lc.tier==='cold'?'cold (trace)':lc.tier);
    var glass =
      '<div class="glass">'+
      '<div class="grow"><span class="gk">Provenance</span><span class="gv">'+esc(t._provenance||t.source)+'</span></div>'+
      '<div class="grow"><span class="gk">Trust</span><span class="gv">'+(t.accessCount||0)+'× reused'+(t.status==='promoted'?' · ★ promoted':'')+'</span></div>'+
      '<div class="grow"><span class="gk">Lifecycle</span><span class="gv">'+esc(fades)+' · last used '+(lc.lastUsedDays!=null?lc.lastUsedDays+'d ago':'—')+'</span></div>'+
      (t.workspace ? '<div class="grow"><span class="gk">Workspace</span><span class="gv">📂 '+esc(t.workspace)+'</span></div>' : '')+
      (t.redacted ? '<div class="grow"><span class="gk">Privacy</span><span class="gv">🔒 secrets masked before saving</span></div>' : '')+
      '</div>';
    // Collections this memory is filed into + a control to file it elsewhere.
    var inCols = colsForId(t.id);
    var inChips = inCols.map(function(c){ return '<span class="colbadge">'+(c.emoji||'📁')+' '+esc(c.name)+'</span>'; }).join('');
    var opts = '<option value="">File into…</option>'+
      COLLECTIONS.map(function(c){ return '<option value="'+esc(c.id)+'">'+(c.emoji?c.emoji+' ':'')+esc(c.name)+'</option>'; }).join('')+
      '<option value="__new__">＋ New collection…</option>';
    var fileRow = '<div class="glass"><div class="grow"><span class="gk">Collections</span><span class="gv">'+
      (inChips||'<span class="pmuted">none yet</span>')+
      ' <select id="fileSel_'+t.id+'" onchange="fileInto(\\''+t.id+'\\')" style="margin-left:8px;padding:3px 6px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text)">'+opts+'</select>'+
      '</span></div></div>';
    var d = document.getElementById('detail'); d.className='';
    d.innerHTML =
      '<h2>'+TIER[t.tier].i+' '+(t.kind==='brainstorm'?'💡 ':'')+esc(t.title)+'</h2>'+
      '<div class="meta">'+t.status+' · '+t.tier+' · '+esc(t.source)+' · used '+t.accessCount+'× · last '+(t.lastAccessedAt||'').slice(0,10)+'</div>'+
      '<div>'+tags+'</div>'+
      glass+fileRow+
      '<h3>Summary</h3><div class="md">'+md(t.summary||'')+'</div>'+
      (kp?'<h3>Key points</h3><ul>'+kp+'</ul>':'')+
      (ns?'<h3>Where you left off</h3><ul>'+ns+'</ul>':'')+links+
      (hasTranscript ? '<button id="fullBtn" class="fullbtn">📜 View full discussion</button><div id="transcript"></div>' : '')+
      '<div class="forgetrow"><button id="forgetBtn" class="forgetbtn" title="Archive to a one-line trace">🗑 Forget this</button>'+
      '<span id="forgetStatus" class="meta"></span></div>';
    if(hasTranscript) document.getElementById('fullBtn').onclick = function(){ loadTranscript(t.id); };
    document.getElementById('forgetBtn').onclick = function(){ forgetMemory(t.id); };
  });
}

function forgetMemory(id){
  var st=document.getElementById('forgetStatus');
  st.textContent=' archiving…';
  fetch('/api/forget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
    .then(function(r){return r.json();}).then(function(d){
      st.textContent = d.ok ? ' ✓ archived to a trace' : ' failed';
      load();
    }).catch(function(){ st.textContent=' failed'; });
}

function loadTranscript(id){
  var box=document.getElementById('transcript');
  box.innerHTML='<p class="meta">Loading full discussion…</p>';
  fetch('/api/transcript/'+id).then(function(r){return r.json();}).then(function(d){
    if(!d.available){ box.innerHTML='<p class="meta">'+esc(d.reason||'Not available.')+'</p>'; return; }
    var html='<div class="meta" style="margin:12px 0">'+d.turns.length+' turns'+(d.truncated?' (truncated)':'')+'</div>';
    d.turns.forEach(function(turn){
      html+='<div class="turn '+turn.role+'"><div class="who">'+(turn.role==='user'?'🧑 You':'🤖 Assistant')+'</div><div class="bubble md">'+md(turn.text)+'</div></div>';
    });
    box.innerHTML=html;
  }).catch(function(){ box.innerHTML='<p class="meta">Failed to load.</p>'; });
}

function renderTree(items){
  var svg = document.getElementById('tree');
  // Build hierarchy: source -> project -> [threads]
  var tree = {};
  items.forEach(function(t){
    var s=t.source, p=projOf(t);
    (tree[s]=tree[s]||{}); (tree[s][p]=tree[s][p]||[]).push(t);
  });
  var xRoot=34, xSrc=200, xProj=420, xLeaf=660, rowH=24, pad=26;
  var y=0, edges=[], nodes=[], pos={};
  var srcYs=[];
  Object.keys(tree).sort().forEach(function(s){
    var projYs=[];
    Object.keys(tree[s]).sort().forEach(function(p){
      var leafYs=[];
      tree[s][p].forEach(function(t){
        var yy = pad + (y++)*rowH;
        pos[t.id]={x:xLeaf,y:yy};
        nodes.push({x:xLeaf,y:yy,label:t.title,tier:t.tier,id:t.id,star:t.status==='promoted'});
        leafYs.push(yy);
      });
      var py = avg(leafYs);
      nodes.push({x:xProj,y:py,label:p,kind:'proj'});
      leafYs.forEach(function(ly){ edges.push([xProj,py,xLeaf,ly,'solid']); });
      projYs.push(py);
    });
    var sy = avg(projYs);
    nodes.push({x:xSrc,y:sy,label:s,kind:'src'});
    projYs.forEach(function(py){ edges.push([xSrc,sy,xProj,py,'solid']); });
    srcYs.push(sy);
  });
  var rootY = avg(srcYs) || pad;
  nodes.push({x:xRoot,y:rootY,label:'🧠',kind:'root'});
  srcYs.forEach(function(sy){ edges.push([xRoot,rootY,xSrc,sy,'solid']); });
  // dashed cross-links between related discussions
  items.forEach(function(t){ (t.links||[]).forEach(function(l){
    if(pos[t.id]&&pos[l]&&t.id<l) edges.push([pos[t.id].x,pos[t.id].y,pos[l].x,pos[l].y,'link']);
  });});

  var H = Math.max(pad*2 + y*rowH, 200);
  svg.setAttribute('width','900'); svg.setAttribute('height',String(H));
  var out='';
  edges.forEach(function(e){
    if(e[4]==='link'){
      var mx=(e[0]+e[2])/2+40;
      out += '<path d="M'+e[0]+' '+e[1]+' C '+mx+' '+e[1]+' '+mx+' '+e[3]+' '+e[2]+' '+e[3]+'" fill="none" stroke="#7c5cff" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.8"/>';
    } else {
      var cx=(e[0]+e[2])/2;
      out += '<path d="M'+e[0]+' '+e[1]+' C '+cx+' '+e[1]+' '+cx+' '+e[3]+' '+e[2]+' '+e[3]+'" fill="none" stroke="#2a2f3a" stroke-width="1.2"/>';
    }
  });
  nodes.forEach(function(n){
    if(n.kind==='root'){ out+='<text x="'+(n.x-10)+'" y="'+(n.y+5)+'" style="font-size:18px">🧠</text>'; return; }
    if(n.kind==='src'||n.kind==='proj'){
      out+='<circle cx="'+n.x+'" cy="'+n.y+'" r="4" fill="#9aa3b2"/>'+
           '<text class="dim" x="'+(n.x+8)+'" y="'+(n.y+4)+'" style="font-weight:'+(n.kind==='src'?600:400)+'">'+esc(n.label)+'</text>';
      return;
    }
    var c = (TIER[n.tier]||{}).c||'#888';
    out+='<g class="leaf" data-id="'+n.id+'">'+
      '<circle cx="'+n.x+'" cy="'+n.y+'" r="5" fill="'+c+'"/>'+
      '<text x="'+(n.x+9)+'" y="'+(n.y+4)+'">'+(n.star?'★ ':'')+esc((n.label||'').slice(0,46))+'</text></g>';
  });
  svg.innerHTML = out;
}

function avg(a){ return a.length ? a.reduce(function(x,y){return x+y;},0)/a.length : 0; }

function showTab(which){
  VIEW = which;
  document.getElementById('tabList').className = which==='list'?'active':'';
  document.getElementById('tabTree').className = which==='tree'?'active':'';
  document.getElementById('tabGraph').className = which==='graph'?'active':'';
  document.getElementById('tabOrganize').className = which==='organize'?'active':'';
  document.getElementById('tabPersona').className = which==='persona'?'active':'';
  document.getElementById('tabActivity').className = which==='activity'?'active':'';
  document.getElementById('left').style.display = which==='list'?'':'none';
  document.getElementById('right').style.display = which==='list'?'':'none';
  document.getElementById('treeWrap').style.display = which==='tree'?'block':'none';
  document.getElementById('graphWrap').style.display = which==='graph'?'block':'none';
  document.getElementById('organizeWrap').style.display = which==='organize'?'grid':'none';
  document.getElementById('personaWrap').style.display = which==='persona'?'grid':'none';
  document.getElementById('activityWrap').style.display = which==='activity'?'block':'none';
  if(which==='graph'){ if(!SIM.built) loadGraph(); }
  else if(which==='organize'){ loadOrganize(); }
  else if(which==='persona'){ loadPersona(); }
  else if(which==='activity'){ loadCalls(); }
  else render();
}

// ---- Activity console (MCP call log) --------------------------------------
var CALLS = [];
function loadCalls(){
  fetch('/api/calls').then(function(r){return r.json();}).then(function(d){ CALLS=d.calls||[]; renderCalls(); });
}
function renderCalls(){
  var box=document.getElementById('callLog'); if(!box) return;
  var errOnly=document.getElementById('actErrOnly').checked;
  var rows=CALLS.filter(function(c){ return !errOnly || !c.ok; });
  document.getElementById('actMeta').textContent = rows.length+' calls'+(errOnly?' (errors)':'');
  if(!rows.length){ box.innerHTML='<div class="empty">No tool calls logged yet. Use Mind Map in any tool and they\\'ll appear here.</div>'; return; }
  box.innerHTML = rows.map(function(c){
    var t=(c.ts||'').slice(11,19);
    return '<div class="callrow'+(c.ok?'':' err')+'">'+
      '<span class="ct">'+esc(t)+'</span>'+
      '<span class="cn">'+(c.ok?'':'⚠ ')+esc(c.tool||'?')+'</span>'+
      '<span class="cm">'+(c.ms!=null?c.ms+'ms':'')+'</span>'+
      '<span class="ca" title="'+esc(c.error||c.args||'')+'">'+esc(c.error||c.args||'')+'</span>'+
    '</div>';
  }).join('');
}

// ---- Organize view (collections + automatic organization) -----------------
var COLLECTIONS = [];
function loadCollections(cb){
  fetch('/api/collections').then(function(r){return r.json();}).then(function(d){
    COLLECTIONS = d.collections||[]; if(cb) cb();
  });
}
function loadOrganize(){ loadCollections(renderCollections); renderAutoOrg(); }

function renderCollections(){
  var box=document.getElementById('colList'); if(!box) return;
  if(!COLLECTIONS.length){ box.innerHTML='<div class="empty">No collections yet. Create one, or tell any AI tool “add this to Goals.”</div>'; return; }
  box.innerHTML = COLLECTIONS.map(function(c){
    // Handlers get c.id (slug: [a-z0-9-]) — names may contain quotes and would
    // break the inline attribute. The API slugs its input, so ids work directly.
    var items = (c.items||[]).map(function(it){
      var ws = it.workspace ? it.workspace.split('/').filter(Boolean).pop() : '';
      var sub = (it.next?'↳ next: '+esc(it.next):'') + (it.next&&ws?' · ':'') + (ws?'📂 '+esc(ws):'');
      return '<div class="colitem"><div style="flex:1;min-width:0">'+
        '<span class="ci-t" onclick="open_(\\''+esc(it.id)+'\\')" title="'+esc(it.title)+'">'+
        (TIER[it.tier]?TIER[it.tier].i+' ':'')+esc(it.title)+'</span>'+
        (sub?'<div class="ci-n">'+sub+'</div>':'')+'</div>'+
        '<button class="ci-x" title="Remove from this collection" onclick="removeFromCol(\\''+esc(c.id)+'\\',\\''+esc(it.id)+'\\')">✕</button></div>';
    }).join('');
    if(!items) items='<div class="colempty">Empty — file memories here from the List, or say “park this.”</div>';
    return '<div class="colcard"><div class="colhd">'+
      '<span style="font-size:17px">'+(c.emoji||'📁')+'</span>'+
      '<span class="colnm">'+esc(c.name)+'</span>'+
      '<span class="colct">'+(c.items?c.items.length:0)+'</span>'+
      (c.pinned?'<span class="colpin">🔒 protected</span>':'')+
      '<button class="coldel" title="Delete collection" onclick="deleteCol(\\''+esc(c.id)+'\\')">🗑</button>'+
      '</div>'+items+'</div>';
  }).join('');
}

// The automatic organization — computed client-side from what's already loaded.
function renderAutoOrg(){
  var box=document.getElementById('autorg'); if(!box) return;
  var ts=DATA.threads||[];
  function tally(keyFn){ var m={}; ts.forEach(function(t){ var k=keyFn(t)||'—'; m[k]=(m[k]||0)+1; });
    return Object.keys(m).map(function(k){return {k:k,n:m[k]};}).sort(function(a,b){return b.n-a.n;}); }
  var byTier={hot:0,warm:0,cold:0}; ts.forEach(function(t){ if(byTier[t.tier]!=null) byTier[t.tier]++; });
  var total=ts.length||1;
  var bar='<div class="obar">'+
    '<i style="width:'+(byTier.hot/total*100)+'%;background:#ff6b4a" title="hot"></i>'+
    '<i style="width:'+(byTier.warm/total*100)+'%;background:#f5c451" title="warm"></i>'+
    '<i style="width:'+(byTier.cold/total*100)+'%;background:#5aa9e6" title="cold"></i></div>';
  function chips(arr,max){ return '<div class="ochips">'+arr.slice(0,max||8).map(function(x){
    return '<span class="ochip"><b>'+esc(x.k)+'</b> '+x.n+'</span>';}).join('')+
    (arr.length>(max||8)?'<span class="ochip">+'+(arr.length-(max||8))+' more</span>':'')+'</div>'; }
  var wsFn=function(t){ var w=t.workspace||''; if(!w) return 'no workspace'; return w.split('/').filter(Boolean).pop()||w; };
  box.innerHTML =
    '<div class="ag"><div class="agh">By recency (decay tiers)</div>'+bar+
      '<div class="ochips"><span class="ochip">🔥 <b>'+byTier.hot+'</b> hot</span><span class="ochip">🌤️ <b>'+byTier.warm+'</b> warm</span><span class="ochip">❄️ <b>'+byTier.cold+'</b> cold</span></div></div>'+
    '<div class="ag"><div class="agh">By source tool</div>'+chips(tally(function(t){return t.source;}))+'</div>'+
    '<div class="ag"><div class="agh">By workspace</div>'+chips(tally(wsFn))+'</div>'+
    '<div class="ag"><div class="agh">By topic</div>'+chips(tally(function(t){return projOf(t);}))+'</div>';
}

function createCol(e){ e.preventDefault();
  var name=document.getElementById('cfName').value.trim(); if(!name) return false;
  var emoji=document.getElementById('cfEmoji').value.trim();
  fetch('/api/collections/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,emoji:emoji})})
    .then(function(r){return r.json();}).then(function(){
      document.getElementById('cfName').value=''; document.getElementById('cfEmoji').value='';
      loadCollections(renderCollections);
    });
  return false;
}
function removeFromCol(colId,id){
  fetch('/api/collections/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({collection:colId,ids:[id]})})
    .then(function(r){return r.json();}).then(function(){ loadCollections(renderCollections); load(); });
}
function deleteCol(colId){
  var c=(COLLECTIONS||[]).find(function(x){return x.id===colId;});
  if(!confirm('Delete collection "'+(c?c.name:colId)+'"? The memories themselves stay.')) return;
  fetch('/api/collections/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({collection:colId})})
    .then(function(r){return r.json();}).then(function(){ loadCollections(renderCollections); load(); });
}
function fileInto(id){
  var sel=document.getElementById('fileSel_'+id); if(!sel) return; var v=sel.value; if(!v) return;
  var body;
  if(v==='__new__'){ var name=prompt('New collection name:'); if(!name) { sel.value=''; return; } body={collection:name,ids:[id]}; }
  else body={collection:v,ids:[id]};
  fetch('/api/collections/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json();}).then(function(){ loadCollections(function(){ open_(id); load(); }); });
}

// ---- Auto-organize (curation) ---------------------------------------------
var SUGGEST = [];
var CURATE_META = { scanned:'', usedLlm:false };
function runCurate(){
  var btn=document.getElementById('curateBtn'); var panel=document.getElementById('curatePanel');
  var focus=document.getElementById('curateFocus').value.trim();
  btn.disabled=true; btn.textContent='✨ Reading your sessions…';
  panel.innerHTML='';
  fetch('/api/curate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({focus:focus})})
    .then(function(r){return r.json();}).then(function(d){
      btn.disabled=false; btn.textContent='✨ Auto-organize';
      SUGGEST=d.suggestions||[]; CURATE_META={scanned:d.scanned,usedLlm:d.usedLlm};
      renderSuggest();
    }).catch(function(){ btn.disabled=false; btn.textContent='✨ Auto-organize'; panel.innerHTML='<div class="empty">Curation failed.</div>'; });
}
function renderSuggest(){
  var d=CURATE_META;
  var panel=document.getElementById('curatePanel');
  if(!SUGGEST.length){ panel.innerHTML=''; return; }
  var head='<div class="prow" style="align-items:center;margin-bottom:10px"><span class="pmuted">Proposed from '+d.scanned+' memories'+(d.usedLlm?' · via your LLM':' · heuristic')+'</span>'+
    '<button class="pbtn primary sm" style="margin-left:auto" onclick="applyCurate(-1)">File all</button>'+
    '<button class="pbtn sm" onclick="SUGGEST=[];document.getElementById(\\'curatePanel\\').innerHTML=\\'\\'">Dismiss</button></div>';
  var cards=SUGGEST.map(function(s,i){
    var items=(s.items||[]).slice(0,6).map(function(it){return '<div>• '+esc(it.title)+'</div>';}).join('');
    var more=(s.items||[]).length>6?'<div class="smore">…and '+(s.items.length-6)+' more</div>':'';
    return '<div class="sug"><div class="sh"><span style="font-size:16px">'+(s.emoji||'📁')+'</span>'+
      '<span class="snm">'+esc(s.name)+'</span><span class="sct">'+(s.items?s.items.length:0)+'</span>'+
      '<button class="pbtn primary sm sfile" onclick="applyCurate('+i+')">File this</button></div>'+
      (s.rationale?'<div class="srat">'+esc(s.rationale)+'</div>':'')+
      '<div class="sitems">'+items+more+'</div></div>';
  }).join('');
  panel.innerHTML=head+cards;
}
function applyCurate(idx){
  var chosen = idx===-1 ? SUGGEST : [SUGGEST[idx]];
  if(!chosen.length) return;
  fetch('/api/curate/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({suggestions:chosen})})
    .then(function(r){return r.json();}).then(function(){
      if(idx===-1){ SUGGEST=[]; document.getElementById('curatePanel').innerHTML=''; }
      else { SUGGEST.splice(idx,1); renderSuggest(); }
      loadCollections(renderCollections); load();
    });
}

// ---- Persona view ---------------------------------------------------------
var PCAT_ORDER=['identity','stack','constraints','style','communication','workflow','goals'];
var LLM_KEYENV={anthropic:'ANTHROPIC_API_KEY',openai:'OPENAI_API_KEY',google:'GOOGLE_API_KEY',ollama:null,none:null};
function loadPersona(){
  fetch('/api/persona').then(function(r){return r.json();}).then(function(d){
    var ll=document.getElementById('llmStatus');
    ll.textContent = d.llm.ready ? ('LLM: '+d.llm.provider+' ✓') : ('LLM: off');
    ll.className = 'pll'+(d.llm.ready?' on':'');
    ll.title = d.llm.note||'';
    // prefill the LLM form from stored settings
    var s=d.settings||{provider:'none',model:''};
    document.getElementById('llmProvider').value=s.provider||'none';
    document.getElementById('llmModel').value=s.model||'';
    document.getElementById('llmBaseUrl').value=s.baseUrl||'';
    syncLlmForm(d.llm);
    renderPersonaFacts(d.facts||[]);
    loadProjection();
  });
}

// ---- Persona projection (write into tools) --------------------------------
function loadProjection(){
  fetch('/api/projection').then(function(r){return r.json();}).then(function(d){
    var box=document.getElementById('targets');
    box.innerHTML=(d.targets||[]).map(function(t){
      var checked = t.present || t.managed ? 'checked' : '';
      var tag = t.managed ? '<span class="pt-tag on">synced</span>' : (t.present ? '<span class="pt-tag on">detected</span>' : '<span class="pt-tag">not found</span>');
      return '<label class="ptarget"><input type="checkbox" data-tid="'+esc(t.id)+'" '+checked+'>'+
        '<span class="pt-id">'+esc(t.id)+'</span> '+tag+'</label>';
    }).join('');
  });
}
function syncProjection(){
  var ids=[]; document.querySelectorAll('#targets input[data-tid]:checked').forEach(function(c){ ids.push(c.getAttribute('data-tid')); });
  var st=document.getElementById('projStatus'), btn=document.getElementById('projBtn');
  if(!ids.length){ st.textContent=' pick at least one tool'; return; }
  btn.disabled=true; st.textContent=' writing…';
  fetch('/api/projection/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targets:ids,force:document.getElementById('projForce').checked})})
    .then(function(r){return r.json();}).then(function(d){
      btn.disabled=false;
      var wrote=(d.outcomes||[]).filter(function(o){return o.action==='created'||o.action==='updated';}).length;
      st.textContent=' ✓ wrote '+wrote+' file(s)';
      loadProjection();
      setTimeout(function(){ st.textContent=''; },6000);
    }).catch(function(){ btn.disabled=false; st.textContent=' failed'; });
}

// ---- Memory Passport ------------------------------------------------------
function exportPassport(){
  var st=document.getElementById('passExportStatus'), btn=document.getElementById('passExportBtn');
  btn.disabled=true; st.textContent=' exporting…';
  fetch('/api/passport/export').then(function(r){return r.json();}).then(function(d){
    btn.disabled=false;
    if(d.error){ st.textContent=' failed'; return; }
    st.textContent=' ✓ '+d.counts.memories+' memories + '+d.counts.persona+' facts → '+d.path;
  }).catch(function(){ btn.disabled=false; st.textContent=' failed'; });
}
function importPassport(){
  var file=document.getElementById('passFile').value.trim();
  var kind=document.getElementById('passKind').value;
  var st=document.getElementById('passImportStatus'), btn=document.getElementById('passImportBtn');
  if(!file){ st.textContent=' enter a file path'; return; }
  btn.disabled=true; st.textContent=' importing…';
  fetch('/api/passport/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:file,kind:kind})})
    .then(function(r){return r.json();}).then(function(d){
      btn.disabled=false;
      if(d.error){ st.textContent=' '+d.error; return; }
      if(d.kind==='passport'){ st.textContent=' ✓ '+d.memories.imported+' memories ('+d.memories.skippedDup+' dup), persona +'+d.persona.added; }
      else { st.textContent=' ✓ '+d.imported+' of '+d.total+' '+d.kind+' ('+d.skippedDup+' dup)'; }
      load();
    }).catch(function(){ btn.disabled=false; st.textContent=' failed'; });
}
function syncLlmForm(llm){
  var prov=document.getElementById('llmProvider').value;
  document.getElementById('llmBaseUrl').style.display = prov==='ollama' ? '' : 'none';
  var hint=document.getElementById('llmHint');
  if(prov==='none'){ hint.innerHTML='LLM features are off. Pick a provider to enable LLM-assisted inference.'; return; }
  if(prov==='ollama'){ hint.innerHTML='Local model — no API key. Make sure <code>ollama serve</code> is running.'+(llm?(' '+(llm.ready?'✓ reachable.':'')):''); return; }
  var env=LLM_KEYENV[prov];
  var ready = llm && llm.ready && llm.provider===prov;
  hint.innerHTML = ready
    ? ('✓ <code>'+env+'</code> detected — Mind Map is using your key from the environment.')
    : ('Set <code>'+env+'</code> in your environment, then <strong>restart the MCP server</strong> so it picks up the key. Mind Map never stores it.');
}
function onProviderChange(){ syncLlmForm(null); }
function saveLlm(ev){
  ev.preventDefault();
  var body={ provider:document.getElementById('llmProvider').value,
             model:document.getElementById('llmModel').value.trim(),
             baseUrl:document.getElementById('llmBaseUrl').value.trim() };
  fetch('/api/llm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json();}).then(function(d){
      var ll=document.getElementById('llmStatus');
      ll.textContent = d.llm.ready ? ('LLM: '+d.llm.provider+' ✓') : ('LLM: off');
      ll.className='pll'+(d.llm.ready?' on':''); ll.title=d.llm.note||'';
      document.getElementById('llmModel').value=(d.settings&&d.settings.model)||'';
      syncLlmForm(d.llm);
    });
  return false;
}
function renderPersonaFacts(facts){
  var box=document.getElementById('personaFacts');
  var active=facts.filter(function(f){return f.status==='active';});
  if(!active.length){ box.innerHTML='<div class="pempty">No persona facts yet. Add a preference, or click “Learn now”.</div>'; return; }
  var byCat={};
  active.forEach(function(f){ (byCat[f.category]=byCat[f.category]||[]).push(f); });
  var html='';
  PCAT_ORDER.forEach(function(cat){
    var g=byCat[cat]; if(!g) return;
    g.sort(function(a,b){return b.confidence-a.confidence;});
    html += '<div class="pcat">'+cat+'</div>';
    g.forEach(function(f){
      var pol = f.polarity==='avoid'?'⊘ ':(f.polarity==='prefer'?'✓ ':'');
      var scope = (f.scope&&f.scope.indexOf('project:')===0) ? ' <span class="psrc">'+esc(f.scope.slice(8))+'</span>' : '';
      html += '<div class="pfact">'+
        '<div class="ptext">'+pol+esc(f.text)+scope+'</div>'+
        '<span class="psrc '+esc(f.source)+'">'+esc(f.source)+'</span>'+
        '<div class="pconf" title="confidence '+Math.round(f.confidence*100)+'%"><i style="width:'+Math.round(f.confidence*100)+'%"></i></div>'+
        '<button class="pforget" title="Forget this" data-id="'+esc(f.id)+'">✕</button>'+
      '</div>';
    });
  });
  box.innerHTML=html;
  box.querySelectorAll('.pforget').forEach(function(b){
    b.addEventListener('click',function(){ forgetPersonaFact(b.getAttribute('data-id')); });
  });
}
function addFact(ev){
  ev.preventDefault();
  var text=document.getElementById('pfText').value.trim();
  if(!text) return false;
  var body={ text:text, category:document.getElementById('pfCat').value, polarity:document.getElementById('pfPol').value };
  fetch('/api/persona',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json();}).then(function(){ document.getElementById('pfText').value=''; loadPersona(); });
  return false;
}
function forgetPersonaFact(id){
  fetch('/api/persona/forget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
    .then(function(r){return r.json();}).then(function(){ loadPersona(); });
}
function learnPersona(){
  var btn=document.getElementById('learnBtn'), st=document.getElementById('learnStatus');
  btn.disabled=true; btn.textContent='✨ Learning…'; st.textContent='';
  fetch('/api/persona/learn',{method:'POST'}).then(function(r){return r.json();}).then(function(d){
    btn.disabled=false; btn.textContent='✨ Learn now';
    st.textContent='  '+(d.usedLLM?'LLM-assisted':'heuristic')+': +'+d.added+' new, '+d.updated+' refreshed';
    loadPersona();
    setTimeout(function(){ st.textContent=''; }, 8000);
  }).catch(function(){ btn.disabled=false; btn.textContent='✨ Learn now'; st.textContent='  failed'; });
}

// ---- Topic graph (force-directed) ----------------------------------------
var SVGNS='http://www.w3.org/2000/svg';
var G={categories:[],nodes:[],edges:[]};
var SIM={nodes:[],links:[],byId:{},alpha:0,raf:0,built:false};
var view={k:1,tx:0,ty:0};
var activeCat=null;

function svgEl(tag,attrs){ var e=document.createElementNS(SVGNS,tag); for(var k in attrs) e.setAttribute(k,attrs[k]); return e; }

function loadGraph(){
  LABELS=null; // raw TF-IDF labels until the user opts in again
  var lb=document.getElementById('llmLabelBtn'); if(lb){ lb.className='chip llmlabel'; lb.textContent='✨ LLM labels'; }
  fetch('/api/graph').then(function(r){return r.json();}).then(function(g){
    G=g; buildSim(); buildSvg(); renderChips(); startSim();
  });
}

function buildSim(){
  var fg=document.getElementById('fg'); var W=fg.clientWidth||1000, H=fg.clientHeight||700;
  var nodes=[], byId={};
  G.categories.forEach(function(c,i){
    var a=(i/G.categories.length)*Math.PI*2;
    var n={id:'cat:'+c.term,label:c.term,kind:'cat',x:W/2+Math.cos(a)*220,y:H/2+Math.sin(a)*180,vx:0,vy:0};
    nodes.push(n); byId[n.id]=n;
  });
  G.nodes.forEach(function(s){
    var n={id:s.id,label:s.title,kind:'node',tier:s.tier,source:s.source,cats:s.cats,terms:s.terms,
      x:W/2+(Math.random()-0.5)*400,y:H/2+(Math.random()-0.5)*400,vx:0,vy:0};
    nodes.push(n); byId[n.id]=n;
  });
  var links=[];
  G.nodes.forEach(function(s){ (s.cats||[]).forEach(function(t){ var c=byId['cat:'+t]; if(c) links.push({s:byId[s.id],t:c,w:1.4,kind:'mem'}); }); });
  G.edges.forEach(function(e){ var a=byId[e.s],b=byId[e.t]; if(a&&b) links.push({s:a,t:b,w:e.w,kind:'rel'}); });
  SIM.nodes=nodes; SIM.links=links; SIM.byId=byId; SIM.built=true;
}

function buildSvg(){
  var vp=document.getElementById('viewport'); vp.innerHTML='';
  SIM.links.forEach(function(l){ l.line=svgEl('line',{class:'gedge'+(l.kind==='rel'?' rel':''),'stroke-width':l.kind==='rel'?Math.max(0.6,l.w*2):0.8}); vp.appendChild(l.line); });
  SIM.nodes.forEach(function(n){
    var g=svgEl('g',{class:'gnode'+(n.kind==='cat'?' gcat':'')});
    if(n.kind==='cat'){
      g.appendChild(svgEl('circle',{r:7,fill:'#7c5cff'}));
      var tx=svgEl('text',{x:11,y:5}); tx.textContent=n.label; g.appendChild(tx);
    } else {
      var c=(TIER[n.tier]||{}).c||'#888';
      g.appendChild(svgEl('circle',{r:5,fill:c,'fill-opacity':0.9}));
      var t2=svgEl('text',{x:8,y:4,'font-size':10,fill:'#cfd4dd'}); t2.textContent=(n.label||'').slice(0,30); g.appendChild(t2);
    }
    g.addEventListener('mousedown',function(ev){ startDrag(ev,n); });
    n.el=g; vp.appendChild(g);
  });
  applyFilter();
}

function startSim(){ SIM.alpha=1; if(SIM.raf) cancelAnimationFrame(SIM.raf); loop(); }
function loop(){ for(var s=0;s<2;s++) tick(); paint(); if(SIM.alpha>0.02){ SIM.raf=requestAnimationFrame(loop);} }

function tick(){
  var ns=SIM.nodes, ls=SIM.links, a=SIM.alpha, n;
  var fg=document.getElementById('fg'); var CX=(fg.clientWidth||1000)/2, CY=(fg.clientHeight||700)/2;
  for(var i=0;i<ns.length;i++){ for(var j=i+1;j<ns.length;j++){
    var dx=ns[i].x-ns[j].x, dy=ns[i].y-ns[j].y; var d2=dx*dx+dy*dy||0.01; if(d2>90000) continue;
    var f=900/d2*a; var d=Math.sqrt(d2); var fx=dx/d*f, fy=dy/d*f;
    ns[i].vx+=fx; ns[i].vy+=fy; ns[j].vx-=fx; ns[j].vy-=fy;
  }}
  ls.forEach(function(l){ var dx=l.t.x-l.s.x, dy=l.t.y-l.s.y; var d=Math.sqrt(dx*dx+dy*dy)||0.01;
    var L=l.kind==='mem'?70:90; var f=(d-L)*0.015*l.w*a; var fx=dx/d*f, fy=dy/d*f;
    l.s.vx+=fx; l.s.vy+=fy; l.t.vx-=fx; l.t.vy-=fy; });
  for(i=0;i<ns.length;i++){ n=ns[i]; if(n.fixed) continue;
    n.vx+=(CX-n.x)*0.004*a; n.vy+=(CY-n.y)*0.004*a;
    n.vx*=0.85; n.vy*=0.85; n.x+=n.vx; n.y+=n.vy;
  }
  SIM.alpha*=0.985;
}

function paint(){
  SIM.links.forEach(function(l){ l.line.setAttribute('x1',l.s.x); l.line.setAttribute('y1',l.s.y); l.line.setAttribute('x2',l.t.x); l.line.setAttribute('y2',l.t.y); });
  SIM.nodes.forEach(function(n){ n.el.setAttribute('transform','translate('+n.x+','+n.y+')'); });
}

function renderChips(){
  var box=document.getElementById('chips');
  box.innerHTML=G.categories.map(function(c){ return '<span class="chip" data-cat="'+c.term+'">'+esc(labelFor(c.term))+' ('+c.count+')</span>'; }).join('');
  box.querySelectorAll('.chip').forEach(function(ch){ ch.addEventListener('click',function(){ toggleCat(ch.getAttribute('data-cat'), ch); }); });
}

// ---- Opt-in LLM cluster labels (graph). Nothing here runs until clicked. ---
var LABELS=null; // term -> LLM label, when active
function labelFor(term){ return (LABELS && LABELS[term]) ? LABELS[term] : term; }
function toggleLlmLabels(){
  var btn=document.getElementById('llmLabelBtn');
  if(LABELS){ LABELS=null; btn.className='chip llmlabel'; btn.textContent='✨ LLM labels'; applyLabels(); return; }
  btn.textContent='✨ Labeling…';
  fetch('/api/graph/relabel',{method:'POST'}).then(function(r){return r.json();}).then(function(d){
    if(!d.ok){ btn.className='chip llmlabel'; btn.textContent='⚠ enable LLM'; btn.title=d.reason||''; setTimeout(function(){ btn.textContent='✨ LLM labels'; },4000); return; }
    LABELS=d.labels||{}; btn.className='chip llmlabel active'; btn.textContent='✨ LLM labels'+(d.cached?'':' ✓'); btn.title=d.cached?'cached':'freshly generated'; applyLabels();
  }).catch(function(){ btn.className='chip llmlabel'; btn.textContent='✨ LLM labels'; });
}
function applyLabels(){
  document.querySelectorAll('#chips .chip').forEach(function(ch){
    var term=ch.getAttribute('data-cat'); var cat=null;
    for(var i=0;i<G.categories.length;i++){ if(G.categories[i].term===term){ cat=G.categories[i]; break; } }
    ch.textContent = labelFor(term)+' ('+(cat?cat.count:'')+')';
  });
  SIM.nodes.forEach(function(n){ if(n.kind==='cat'&&n.el){ var t=n.el.querySelector('text'); if(t) t.textContent=labelFor(n.label); }});
}
function toggleCat(term,ch){
  activeCat = activeCat===term ? null : term;
  document.querySelectorAll('#chips .chip').forEach(function(c){ c.className='chip'+(c.getAttribute('data-cat')===activeCat?' active':''); });
  applyFilter();
}
function applyFilter(){
  var q=(document.getElementById('gsearch').value||'').toLowerCase();
  SIM.nodes.forEach(function(n){
    var match=true;
    if(activeCat){ match = n.kind==='cat' ? n.label===activeCat : (n.cats||[]).indexOf(activeCat)>=0; }
    if(match && q){ var hay=(n.label+' '+((n.terms||[]).join(' '))+' '+(n.source||'')).toLowerCase(); match = hay.indexOf(q)>=0 || (n.kind==='cat'&&n.label.indexOf(q)>=0); }
    n.show=match; if(n.el) n.el.classList.toggle('dimmed',!match);
  });
  SIM.links.forEach(function(l){ var on=l.s.show!==false && l.t.show!==false; l.line.classList.toggle('dimmed',!on); });
}

// pan / zoom / drag
var drag=null, panning=null;
function applyView(){ document.getElementById('viewport').setAttribute('transform','translate('+view.tx+','+view.ty+') scale('+view.k+')'); }
function startDrag(ev,n){ ev.stopPropagation(); drag={n:n,moved:0,x:ev.clientX,y:ev.clientY}; n.fixed=true; }
function initGraphInput(){
  var fg=document.getElementById('fg');
  fg.addEventListener('mousedown',function(ev){ if(!drag){ panning={x:ev.clientX,y:ev.clientY,tx:view.tx,ty:view.ty}; fg.classList.add('grabbing'); } });
  window.addEventListener('mousemove',function(ev){
    if(drag){ var k=view.k; drag.n.x += (ev.clientX-drag.x)/k; drag.n.y += (ev.clientY-drag.y)/k; drag.x=ev.clientX; drag.y=ev.clientY; drag.moved++; SIM.alpha=Math.max(SIM.alpha,0.3); if(SIM.alpha&&!SIM.raf) loop(); paint(); }
    else if(panning){ view.tx=panning.tx+(ev.clientX-panning.x); view.ty=panning.ty+(ev.clientY-panning.y); applyView(); }
  });
  window.addEventListener('mouseup',function(){
    if(drag){ if(drag.moved<3){ openNode(drag.n); } drag.n.fixed=false; drag=null; }
    panning=null; fg.classList.remove('grabbing');
  });
  fg.addEventListener('wheel',function(ev){ ev.preventDefault(); var s=ev.deltaY<0?1.1:0.9; var nk=Math.min(4,Math.max(0.2,view.k*s));
    var r=fg.getBoundingClientRect(); var mx=ev.clientX-r.left, my=ev.clientY-r.top;
    view.tx = mx-(mx-view.tx)*(nk/view.k); view.ty = my-(my-view.ty)*(nk/view.k); view.k=nk; applyView(); },{passive:false});
}
function openNode(n){ if(n.kind==='cat'){ toggleCat(n.label); } else { open_(n.id); } }

function syncImport(){
  var btn=document.getElementById('syncBtn'), st=document.getElementById('syncStatus');
  btn.disabled=true; btn.textContent='⟳ Syncing…'; st.textContent='reading your sessions…';
  fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reimport:true})})
    .then(function(r){return r.json();}).then(function(d){
      btn.disabled=false; btn.textContent='⟳ Sync';
      if(d.error){ st.textContent='Sync failed'; return; }
      st.textContent='✓ imported '+d.imported+', refreshed '+d.updated;
      SIM.built=false;            // graph data is now stale — rebuild on next open
      load();                     // refresh list/tree + counts
      if(VIEW==='graph') loadGraph();
      setTimeout(function(){ st.textContent=''; }, 6000);
    }).catch(function(){ btn.disabled=false; btn.textContent='⟳ Sync'; st.textContent='Sync failed'; });
}

// Event delegation — survives innerHTML re-renders, and avoids quoting bugs.
document.getElementById('listWrap').addEventListener('click', function(e){
  var c = e.target.closest && e.target.closest('.card');
  if(c && c.dataset.id) open_(c.dataset.id);
});
document.getElementById('tree').addEventListener('click', function(e){
  var g = e.target.closest && e.target.closest('.leaf');
  if(g && g.getAttribute('data-id')) open_(g.getAttribute('data-id'));
});

initGraphInput();
load();
loadCollections();
setInterval(load, 5000);
setInterval(function(){ if(VIEW==='activity') loadCalls(); }, 3000);
</script>
</body>
</html>`;

export async function runDashboard(): Promise<void> {
  await reindex(); // refresh the index so transcript flags etc. are current
  const app = express();
  app.use(express.json());

  app.get("/", (_req, res) => res.type("html").send(PAGE));

  // Run import/reimport from the UI (loopback-only server, so no auth needed).
  app.post("/api/import", async (req, res) => {
    try {
      const reimport = req.body?.reimport !== false; // default: sync = import new + refresh existing
      const result = await importSessions(importOptions({ source: "all", reimport }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/data", async (_req, res) => {
    try {
      const cfg = await getConfig();
      const h = await health(cfg, Date.now());
      const threads = (await allEntries()).sort(
        (a, b) =>
          new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
      );
      res.json({ health: h, threads });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/calls", async (_req, res) => {
    try {
      res.json({ calls: await readCalls(200) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // --- Collections (user-organization layer) ---------------------------------
  app.get("/api/collections", async (_req, res) => {
    try {
      const cols = await listCollections();
      const entries = await allEntries();
      const meta = new Map(entries.map((e) => [e.id, e]));
      const collections = [];
      for (const c of cols) {
        const items = [];
        for (const id of c.items) {
          const e = meta.get(id);
          const t = await getThread(id);
          items.push({
            id,
            title: e?.title ?? "(forgotten)",
            tier: e?.tier ?? "cold",
            workspace: e?.workspace ?? null,
            next: t?.nextSteps?.[0] ?? null,
          });
        }
        collections.push({ id: c.id, name: c.name, emoji: c.emoji, pinned: c.pinned, items });
      }
      res.json({ collections });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/collections/create", async (req, res) => {
    try {
      const { name, emoji } = req.body ?? {};
      if (!name) return res.status(400).json({ error: "name required" });
      const c = await createCollection(String(name), emoji ? { emoji: String(emoji) } : {});
      res.json({ ok: true, collection: c });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/collections/add", async (req, res) => {
    try {
      const { collection, ids } = req.body ?? {};
      if (!collection || !Array.isArray(ids)) return res.status(400).json({ error: "collection + ids required" });
      const c = await addToCollection(String(collection), ids.map(String));
      res.json({ ok: true, collection: c });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/collections/remove", async (req, res) => {
    try {
      const { collection, ids } = req.body ?? {};
      if (!collection || !Array.isArray(ids)) return res.status(400).json({ error: "collection + ids required" });
      const c = await removeFromCollection(String(collection), ids.map(String));
      res.json({ ok: !!c, collection: c });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/collections/delete", async (req, res) => {
    try {
      const { collection } = req.body ?? {};
      if (!collection) return res.status(400).json({ error: "collection required" });
      const ok = await deleteCollection(String(collection));
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Auto-organize: propose collections from the whole corpus (preview only).
  app.post("/api/curate", async (req, res) => {
    try {
      const focus = req.body?.focus ? String(req.body.focus) : undefined;
      const r = await curate(focus ? { focus } : {});
      res.json(r);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/curate/apply", async (req, res) => {
    try {
      const suggestions = Array.isArray(req.body?.suggestions) ? req.body.suggestions : [];
      if (!suggestions.length) return res.status(400).json({ error: "suggestions required" });
      const r = await applyCuration(suggestions);
      res.json({ ok: true, ...r });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/graph", async (_req, res) => {
    try {
      const entries = await allEntries();
      res.json(buildGraph(entries));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Opt-in: relabel the TF-IDF topic clusters with the user's LLM. Deliberate
  // (button-triggered) only — never part of the default graph build. Cached by
  // cluster signature so repeated clicks don't re-bill.
  app.post("/api/graph/relabel", async (_req, res) => {
    try {
      if (!(await llmReady())) {
        res.json({ ok: false, reason: "LLM is off. Enable it in the Persona tab first." });
        return;
      }
      const g = buildGraph(await allEntries());
      if (!g.categories.length) {
        res.json({ ok: true, labels: {}, usedLLM: false });
        return;
      }
      const signature = g.categories.map((c) => c.term).sort().join("|");
      const cacheFile = path.join(DATA_DIR, "graph-labels.json");
      try {
        const cached = JSON.parse(await fs.readFile(cacheFile, "utf8")) as {
          signature: string;
          labels: Record<string, string>;
        };
        if (cached.signature === signature) {
          res.json({ ok: true, labels: cached.labels, usedLLM: false, cached: true });
          return;
        }
      } catch {
        /* no cache yet */
      }
      // Gather a few representative titles per cluster for context.
      const samples = new Map<string, string[]>();
      for (const c of g.categories) samples.set(c.term, []);
      for (const n of g.nodes) {
        for (const t of n.cats ?? []) {
          const arr = samples.get(t);
          if (arr && arr.length < 6) arr.push(n.title);
        }
      }
      const clusters = g.categories
        .map((c) => `- key "${c.term}": ${(samples.get(c.term) ?? []).map((t) => t.slice(0, 60)).join("; ")}`)
        .join("\n");
      const sys =
        "You name topic clusters from a personal knowledge graph. For each cluster key, " +
        "produce a concise 2-4 word human-readable label that captures the theme of its sample titles. " +
        "Output ONLY a JSON object mapping each original key string to its label string.";
      const out = await complete(`Clusters:\n${clusters}\n\nReturn the JSON object.`, {
        system: sys,
        maxTokens: 700,
      });
      const lo = out.indexOf("{");
      const hi = out.lastIndexOf("}");
      const labels = lo >= 0 && hi > lo ? (JSON.parse(out.slice(lo, hi + 1)) as Record<string, string>) : {};
      await fs.writeFile(cacheFile, JSON.stringify({ signature, labels }, null, 2), "utf8");
      res.json({ ok: true, labels, usedLLM: true });
    } catch (err) {
      res.json({ ok: false, reason: String(err) });
    }
  });

  // ---- Persona -------------------------------------------------------------
  app.get("/api/persona", async (_req, res) => {
    try {
      const [facts, llm, settings, rendered] = await Promise.all([
        allFacts(),
        llmStatus(),
        getSettings(),
        renderPersona({}),
      ]);
      res.json({ facts, llm, settings, rendered: rendered.text, count: rendered.count });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Set provider/model only — the API key is NEVER accepted or stored here.
  app.post("/api/llm", async (req, res) => {
    try {
      const { provider, model, baseUrl } = req.body ?? {};
      await setSettings({
        ...(provider ? { provider: provider as ProviderName } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
      res.json({ settings: await getSettings(), llm: await llmStatus() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/persona", async (req, res) => {
    try {
      const { text, category, polarity, project } = req.body ?? {};
      if (!text || !category) {
        res.status(400).json({ error: "text and category required" });
        return;
      }
      const fact = await setFact({
        text,
        category: category as PersonaCategory,
        polarity,
        scope: project ? `project:${project}` : "global",
      });
      res.json(fact);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/persona/forget", async (req, res) => {
    try {
      const { id, hard } = req.body ?? {};
      const ok = await forgetFact(id, Boolean(hard));
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/persona/learn", async (_req, res) => {
    try {
      res.json(await inferWithLLM());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/thread/:id", async (req, res) => {
    const t = await getThread(req.params.id);
    if (!t) {
      res.status(404).json({ error: "not found" });
      return;
    }
    // Glass-box: attach provenance + decay forecast alongside the raw thread.
    const cfg = await getConfig();
    const lc = lifecycle(t, cfg, Date.now());
    res.json({ ...t, _provenance: provenance(t), _lifecycle: lc });
  });

  // Glass-box: forget a memory (soft-archive to a trace, or hard delete).
  app.post("/api/forget", async (req, res) => {
    try {
      const { id, hard } = req.body ?? {};
      if (hard) {
        res.json({ ok: await deleteThread(id) });
        return;
      }
      const t = await getThread(id);
      if (!t) {
        res.json({ ok: false });
        return;
      }
      t.status = "archived";
      t.tier = "cold";
      t.trace = makeTrace(t);
      t.archivedAt = new Date().toISOString();
      t.updatedAt = t.archivedAt;
      await saveThread(t);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---- Memory Passport -----------------------------------------------------
  app.get("/api/passport/export", async (_req, res) => {
    try {
      res.json(await exportPassport());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/passport/import", async (req, res) => {
    try {
      const { file, kind } = req.body ?? {};
      if (!file) {
        res.status(400).json({ error: "file required" });
        return;
      }
      if (!kind || kind === "passport") {
        res.json({ kind: "passport", ...(await importPassport(file)) });
        return;
      }
      res.json({ kind, ...(await importExport(kind, file)) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---- Persona projection --------------------------------------------------
  app.get("/api/projection", async (_req, res) => {
    try {
      res.json({ cwd: process.cwd(), targets: await detectTargets(process.cwd()) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/projection/sync", async (req, res) => {
    try {
      const { targets, force } = req.body ?? {};
      res.json(await syncPersona({ only: targets, force: Boolean(force) }));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/transcript/:id", async (req, res) => {
    const t = await getThread(req.params.id);
    if (!t) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(await getTranscript(t));
  });

  app.listen(PORT, HOST, () => {
    console.error(`[mindmap] dashboard at http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
    console.error(`[mindmap] press Ctrl+C to stop.`);
  });
}
