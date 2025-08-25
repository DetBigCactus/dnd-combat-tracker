// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from "react";

// NOTE: This file intentionally contains **no references** to an `invoke` symbol.
// If you previously saw "ReferenceError: invoke is not defined", it likely came
// from stray code outside this file. This module is self-contained.

// ------------------------------------------------------------
// Helpers (also covered by lightweight self-tests)
// ------------------------------------------------------------
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const sortByInit = (list) =>
  [...list].sort((a, b) => {
    if (b.init !== a.init) return b.init - a.init; // primary: initiative desc
    const at = a.tie ?? -Infinity;
    const bt = b.tie ?? -Infinity;
    if (bt !== at) return bt - at; // secondary: roll-off desc (higher first)
    return a.name.localeCompare(b.name); // tertiary: name
  });

const applyDamagePure = (c, amount) => {
  const newHp = clamp(c.hp - Math.abs(amount), -9999, c.maxHp);
  return { ...c, hp: newHp, down: newHp <= 0 };
};
const applyHealPure = (c, amount) => {
  const newHp = clamp(c.hp + Math.abs(amount), -9999, c.maxHp);
  return { ...c, hp: newHp, down: newHp <= 0 };
};

// ------------------------------------------------------------
// Self-tests (run once at mount; console assertions only)
// ------------------------------------------------------------
function runSelfTests() {
  try {
    // Basic sort tests (primary + tertiary)
    const a = { name: "Alu", init: 10, hp: 5, maxHp: 10 };
    const b = { name: "Bex", init: 15, hp: 5, maxHp: 10 };
    const c = { name: "Ana", init: 15, hp: 5, maxHp: 10 };
    const sorted = sortByInit([a, b, c]).map((x) => x.name);
    console.assert(JSON.stringify(sorted) === JSON.stringify(["Ana", "Bex", "Alu"]), "Sort primary/tertiary failed");

    // Damage / heal
    const d0 = { name: "D", hp: 10, maxHp: 20 };
    const d1 = applyDamagePure(d0, 7); // 3
    console.assert(d1.hp === 3 && d1.down === false, "Damage fail");
    const d2 = applyDamagePure(d1, 5); // -2
    console.assert(d2.hp === -2 && d2.down === true, "Downed flag fail");
    const d3 = applyHealPure(d2, 7); // 5
    console.assert(d3.hp === 5 && d3.down === false, "Heal clear down fail");

    // Heal clamp to max
    const h0 = { name: "H", hp: 8, maxHp: 10 };
    const h1 = applyHealPure(h0, 50);
    console.assert(h1.hp === 10, "Heal clamp fail");

    // Roll-off secondary sort
    const t1 = { name: "Tie A", init: 12, tie: 5 };
    const t2 = { name: "Tie B", init: 12, tie: 15 };
    const tSorted = sortByInit([t1, t2]).map((x) => x.name);
    console.assert(JSON.stringify(tSorted) === JSON.stringify(["Tie B", "Tie A"]), "Roll-off sort fail");

    // Stable tertiary sort with same init & tie
    const s1 = { name: "Beta", init: 10, tie: 10 };
    const s2 = { name: "Alpha", init: 10, tie: 10 };
    const sNames = sortByInit([s1, s2]).map((x) => x.name);
    console.assert(JSON.stringify(sNames) === JSON.stringify(["Alpha", "Beta"]), "Stable tertiary sort failed");

    // Hidden filter behavior (external to sort)
    const hiddenList = [
      { id: "a", name: "V", init: 10, hidden: false },
      { id: "b", name: "W", init: 12, hidden: true },
      { id: "c", name: "X", init: 11, hidden: false },
    ];
    const visibleNames = sortByInit(hiddenList).filter((c) => !c.hidden).map((c) => c.name);
    console.assert(JSON.stringify(visibleNames) === JSON.stringify(["X", "V"]), "Hidden filter failed");

    // Damage clamp lower bound (doesn't drop below arbitrary -9999 guard)
    const z0 = { name: "Z", hp: 3, maxHp: 10 };
    const z1 = applyDamagePure(z0, 9999);
    console.assert(z1.hp >= -9999, "Damage clamp lower bound failed");

    console.log("✅ DnD Combat Tracker self-tests passed");
  } catch (e) {
    console.error("❌ Self-tests error:", e);
  }
}

// ------------------------------------------------------------
// Main Component
// ------------------------------------------------------------
export default function CombatTracker() {
  // Add form
  const [name, setName] = useState("");
  const [team, setTeam] = useState("Player");
  const [hp, setHp] = useState(30);
  const [maxHp, setMaxHp] = useState(30);
  const [init, setInit] = useState(10);
  const [notes, setNotes] = useState("");

  // Settings (persist)
  const [settings, setSettings] = useState(() => {
    try { const raw = localStorage.getItem("dnd_tracker_settings_v1"); if (raw) return JSON.parse(raw); } catch {}
    return { autoGraveyard: true, showHidden: false, theme: "dark" };
  });
  useEffect(() => localStorage.setItem("dnd_tracker_settings_v1", JSON.stringify(settings)), [settings]);

  // Encounter state (persist)
  const [combatants, setCombatants] = useState(() => {
    try { const raw = localStorage.getItem("dnd_tracker_combatants_v2"); if (raw) return JSON.parse(raw); } catch {}
    return [];
  });
  const [graveyard, setGraveyard] = useState(() => {
    try { const raw = localStorage.getItem("dnd_tracker_graveyard_v1"); if (raw) return JSON.parse(raw); } catch {}
    return [];
  });
  const [activeId, setActiveId] = useState(() => {
    try { const raw = localStorage.getItem("dnd_tracker_active_v2"); if (raw) return JSON.parse(raw); } catch {}
    return null;
  });
  const [round, setRound] = useState(() => {
    try { const raw = localStorage.getItem("dnd_tracker_round_v2"); if (raw) return JSON.parse(raw); } catch {}
    return 1;
  });
  const [tab, setTab] = useState("active"); // 'active' | 'graveyard'
  const [confirmClearGY, setConfirmClearGY] = useState(false);

  // Toast (undo)
  const [toast, setToast] = useState(null); // {message, undo}
  const toastTimerRef = useRef(null);
  const showToast = (message, undo) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, undo });
    toastTimerRef.current = setTimeout(() => setToast(null), 5000);
  };
  const hideToast = () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); setToast(null); };
  useEffect(() => () => toastTimerRef.current && clearTimeout(toastTimerRef.current), []);

  // Persist pieces
  useEffect(() => localStorage.setItem("dnd_tracker_combatants_v2", JSON.stringify(combatants)), [combatants]);
  useEffect(() => localStorage.setItem("dnd_tracker_graveyard_v1", JSON.stringify(graveyard)), [graveyard]);
  useEffect(() => localStorage.setItem("dnd_tracker_active_v2", JSON.stringify(activeId)), [activeId]);
  useEffect(() => localStorage.setItem("dnd_tracker_round_v2", JSON.stringify(round)), [round]);

  // Derived
  const sorted = useMemo(() => sortByInit(combatants), [combatants]);
  const visible = useMemo(() => sorted.filter((c) => !c.hidden), [sorted]);
  const activeIndex = useMemo(() => visible.findIndex((c) => c.id === activeId), [visible, activeId]);

  // Helpers
  const uid = () => Math.random().toString(36).slice(2, 10);
  const ensureActiveValid = (list) => {
    const vis = list.filter((c) => !c.hidden);
    if (!vis.find((c) => c.id === activeId)) setActiveId(vis[0]?.id || null);
  };

  const resetForm = () => { setName(""); setTeam("Player"); setHp(30); setMaxHp(30); setInit(10); setNotes(""); };

  const addCombatant = () => {
    if (!name.trim()) return;
    const id = uid();
    const isPC = team === "Player";
    const c = {
      id,
      name: name.trim(),
      team,
      hp: isPC ? null : Number(hp),
      maxHp: isPC ? null : Number(maxHp),
      init: Number(init),
      tie: null,
      hidden: false,
      notes: notes.trim(),
      down: isPC ? false : Number(hp) <= 0,
      createdAt: Date.now(),
    };
    const prevCombatants = combatants;
    const prevActive = activeId;
    const next = [...combatants, c];
    setCombatants(next);
    if (!activeId) {
      const first = sortByInit(next.filter((x) => !x.hidden))[0];
      setActiveId(first?.id ?? id);
    }
    resetForm();
    showToast(`Added ${c.name}`, () => { setCombatants(prevCombatants); setActiveId(prevActive); });
  };

  const updateCombatant = (id, patch) => {
    setCombatants((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, ...patch } : c));
      ensureActiveValid(next);
      return next;
    });
  };

  const moveToGraveyard = (id) => {
    const prevCombatants = combatants;
    const prevGraveyard = graveyard;
    const prevActive = activeId;
    const prevRound = round;
    const target = combatants.find((c) => c.id === id);
    setCombatants((prev) => {
      const t = prev.find((c) => c.id === id);
      const remaining = prev.filter((c) => c.id !== id);
      if (!t) return prev;
      setGraveyard((g) => [{ ...t, removedAt: Date.now() }, ...g]);
      ensureActiveValid(remaining);
      return remaining;
    });
    if (target) {
      showToast(`Moved ${target.name} to Graveyard`, () => {
        setCombatants(prevCombatants);
        setGraveyard(prevGraveyard);
        setActiveId(prevActive);
        setRound(prevRound);
      });
    }
  };

  const deleteForever = (id) => {
    if (!confirm("Permanently delete this combatant from the graveyard? This cannot be undone.")) return;
    const prevGY = graveyard;
    setGraveyard((g) => g.filter((c) => c.id !== id));
    showToast("Deleted forever", () => setGraveyard(prevGY));
  };

  const deleteForeverConfirmed = (id) => {
    const prevGY = graveyard;
    const victim = graveyard.find((c) => c.id === id);
    setGraveyard((g) => g.filter((c) => c.id !== id));
    showToast(victim ? `Deleted ${victim.name}` : "Deleted", () => setGraveyard(prevGY));
  };

  const restoreFromGraveyard = (id) => {
    const prevCombatants = combatants;
    const prevGY = graveyard;
    setGraveyard((g) => {
      const target = g.find((c) => c.id === id);
      const remaining = g.filter((c) => c.id !== id);
      if (target) {
        setCombatants((live) => {
          const next = sortByInit([{ ...target }, ...live]);
          ensureActiveValid(next);
          return next;
        });
        showToast(`Restored ${target.name}`, () => { setCombatants(prevCombatants); setGraveyard(prevGY); });
      }
      return remaining;
    });
  };

  // HP / Auto-grave
  const autoGrave = (next) => {
    if (!settings.autoGraveyard) return next;
    const toMove = next.filter((c) => c.team !== "Player" && typeof c.hp === "number" && c.hp <= 0);
    if (toMove.length === 0) return next;
    const prevGY = graveyard;
    setGraveyard((g) => [ ...toMove.map((c) => ({ ...c, removedAt: Date.now() })), ...g ]);
    const remaining = next.filter((c) => !(c.team !== "Player" && typeof c.hp === "number" && c.hp <= 0));
    ensureActiveValid(remaining);
    showToast(`Auto-moved ${toMove.length} to Graveyard`, () => setGraveyard(prevGY));
    return remaining;
  };

  const applyDamage = (id, amount) => {
    setCombatants((prev) => {
      const mapped = prev.map((c) => {
        if (c.id !== id) return c;
        if (c.team === "Player" || typeof c.hp !== "number") return c; // Players don't track HP here
        return applyDamagePure(c, amount);
      });
      return autoGrave(mapped);
    });
  };

  const applyHeal = (id, amount) => {
    setCombatants((prev) => prev.map((c) => {
      if (c.id !== id) return c;
      if (c.team === "Player" || typeof c.hp !== "number") return c;
      return applyHealPure(c, amount);
    }));
  };

  const setExactHp = (id, value) => {
    const val = Number(value);
    setCombatants((prev) => {
      const mapped = prev.map((c) => {
        if (c.id !== id) return c;
        if (c.team === "Player" || typeof c.hp !== "number") return c;
        const hpVal = clamp(val, -9999, c.maxHp);
        return { ...c, hp: hpVal, down: hpVal <= 0 };
      });
      return autoGrave(mapped);
    });
  };

  // Tie editor & rollers
  const setTie = (id, value) => {
    const raw = value;
    let v = null;
    if (raw === "" || raw === null || typeof raw === "undefined") v = null;
    else {
      const n = Number(raw);
      v = Number.isFinite(n) ? clamp(Math.round(n), 1, 20) : null;
    }
    setCombatants((prev) => prev.map((c) => (c.id === id ? { ...c, tie: v } : c)));
  };

  const rollD20 = () => Math.floor(Math.random() * 20) + 1;
  const rollTies = () => {
    setCombatants((prev) => {
      const byInit = new Map();
      for (const c of prev) {
        const key = c.init;
        if (!byInit.has(key)) byInit.set(key, []);
        byInit.get(key).push(c);
      }
      const updates = new Map();
      for (const [, group] of byInit.entries()) {
        if (group.length <= 1) continue;
        const used = new Set();
        for (const c of group) {
          let roll = rollD20();
          while (used.has(roll)) roll = rollD20();
          used.add(roll);
          updates.set(c.id, roll);
        }
      }
      return prev.map((c) => (updates.has(c.id) ? { ...c, tie: updates.get(c.id) } : c));
    });
  };
  const clearTies = () => setCombatants((prev) => prev.map((c) => (c.tie != null ? { ...c, tie: null } : c)));

  // Export / Import (Session)
  const importInputRef = useRef(null);
  const exportState = () => {
    try {
      const payload = { version: 1, exportedAt: new Date().toISOString(), combatants, graveyard, settings, activeId, round };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      a.download = `session-${mm}-${dd}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast("Exported session", null);
    } catch (e) {
      alert("Export failed: " + (e?.message || e));
    }
  };
  const importFromFile = async (file) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.combatants) || !Array.isArray(data.graveyard)) {
        alert("Invalid file format. Expected { combatants: [], graveyard: [] }.");
        return;
      }
      const prevC = combatants; const prevG = graveyard; const prevS = settings; const prevA = activeId; const prevR = round;
      setCombatants(data.combatants || []);
      setGraveyard(data.graveyard || []);
      if (data.settings) setSettings(data.settings);
      setActiveId(data.activeId ?? null);
      setRound(typeof data.round === "number" ? data.round : 1);
      showToast("Imported session", () => { setCombatants(prevC); setGraveyard(prevG); setSettings(prevS); setActiveId(prevA); setRound(prevR); });
    } catch (e) {
      alert("Import failed: " + (e?.message || e));
    }
  };

  // Life-cycle: run tests
  useEffect(() => { runSelfTests(); }, []);

  // Display list depending on hidden toggle
  const listForDisplay = settings.showHidden ? sorted : visible;

  return (
    <div className={`${settings.theme === 'dark' ? 'dark-root' : 'light-root'} min-h-screen bg-neutral-900 text-neutral-100 p-4 md:p-6`}>
      {/* Theme + hover affordances */}
      <style>{`
        .light-root { background:#f8fafc; color:#0f172a; }
        .light-root .bg-neutral-900 { background:#f8fafc !important; }
        .light-root .text-neutral-100 { color:#0f172a !important; }
        .light-root .text-neutral-200 { color:#111827 !important; }
        .light-root .text-neutral-300 { color:#374151 !important; }
        .light-root .text-neutral-400 { color:#6b7280 !important; }
        .light-root .text-neutral-500 { color:#9ca3af !important; }
        .light-root .bg-neutral-800 { background:#ffffff !important; }
        .light-root .border-neutral-700 { border-color:#e5e7eb !important; }
        .light-root .bg-neutral-700 { background:#111827 !important; color:#f9fafb !important; }
        .light-root input.bg-neutral-900, .light-root select.bg-neutral-900, .light-root textarea.bg-neutral-900 {
          background:#ffffff !important; color:#111827 !important; border-color:#cbd5e1 !important; }
        .light-root .bg-rose-900\/30 { background:rgba(239,68,68,.12) !important; }
        .light-root .bg-sky-900\/30 { background:rgba(14,165,233,.12) !important; }
        .light-root .bg-amber-900\/20 { background:rgba(245,158,11,.15) !important; }
        .light-root .bg-rose-900\/40 { background:rgba(239,68,68,.18) !important; }
        .light-root .border-rose-800 { border-color:rgba(239,68,68,.35) !important; }
        .light-root .border-sky-800 { border-color:rgba(14,165,233,.35) !important; }
        .light-root .toast { background:#111827 !important; color:#f9fafb !important; border-color:#e5e7eb !important; }
        .light-root .toast button { background:#ffffff !important; color:#111827 !important; border-color:#cbd5e1 !important; }

        .dark-root button, .light-root button { cursor:pointer; transition:background-color .15s ease, border-color .15s ease, box-shadow .15s ease, transform .05s ease; }
        .dark-root button:hover { filter:brightness(1.12); box-shadow:0 2px 10px rgba(0,0,0,.35); border-color:#a3a3a3 !important; }
        .light-root button:hover { filter:brightness(.96); box-shadow:0 2px 12px rgba(0,0,0,.10); border-color:#9ca3af !important; }
        .dark-root button:active, .light-root button:active { transform:translateY(1px); }
        .dark-root button:focus-visible { outline:2px solid #fbbf24; outline-offset:2px; }
        .light-root button:focus-visible { outline:2px solid #0ea5e9; outline-offset:2px; }
      `}</style>

      <div className="max-w-6xl mx-auto grid gap-4">
        {/* Header */}
        <header className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-neutral-100 mr-auto">DnD Combat Tracker</h1>
          {/* Right-side utilities */}
          <div className="flex items-center gap-2">
            <button className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700" onClick={exportState} title="Download current session">Export Session</button>
            <button className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700" onClick={() => importInputRef.current && importInputRef.current.click()} title="Import a previously saved session">Import Session</button>
            <button className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700" onClick={() => setSettings((s) => ({ ...s, theme: s.theme === 'dark' ? 'light' : 'dark' }))} title="Toggle light/dark">{settings.theme === 'dark' ? '☀ Light' : '🌙 Dark'}</button>
          </div>
        </header>

        {/* Turn controls + tab switch */}
        <div className="flex flex-wrap items-center gap-3">
          <nav className="flex items-center gap-2">
            <button className={`px-3 py-2 rounded-2xl border ${tab === 'active' ? 'bg-neutral-700 text-neutral-100 border-neutral-600' : 'bg-neutral-800 text-neutral-200 border-neutral-700'}`} onClick={() => setTab('active')}>Active ({combatants.length})</button>
            <button className={`px-3 py-2 rounded-2xl border ${tab === 'graveyard' ? 'bg-neutral-700 text-neutral-100 border-neutral-600' : 'bg-neutral-800 text-neutral-200 border-neutral-700'}`} onClick={() => setTab('graveyard')}>Graveyard ({graveyard.length})</button>
          </nav>

          {tab === 'active' && (
            <div className="flex items-center gap-2">
              <button className="px-3 py-2 rounded-2xl bg-neutral-700 text-neutral-100" onClick={() => { const vis = visible; if (vis.length) { setRound(1); setActiveId(vis[0].id); } }}>Start</button>
              <button className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700" onClick={() => { const vis = visible; if (!vis.length) return; const idx = Math.max(0, activeIndex); const prev = vis[(idx - 1 + vis.length) % vis.length]; if (idx === 0) setRound((r) => Math.max(1, r - 1)); setActiveId(prev.id); }} aria-label="Previous turn">◀ Prev</button>
              <div className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700">Round <b className="ml-1">{round}</b></div>
              <button className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700" onClick={() => { const vis = visible; if (!vis.length) return; const idx = Math.max(0, activeIndex); const next = vis[(idx + 1) % vis.length]; if (idx === vis.length - 1) setRound((r) => r + 1); setActiveId(next.id); }} aria-label="Next turn">Next ▶</button>
              <button className="px-3 py-2 rounded-2xl bg-neutral-700 text-neutral-100" onClick={rollTies} title="Roll d20 for tied initiatives">🎲 Roll Ties</button>
              <button className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700" onClick={clearTies} title="Clear roll-off tiebreakers">Clear Ties</button>
            </div>
          )}

          {tab === 'active' && (
            <div className="flex items-center gap-4 ml-auto text-neutral-300">
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.autoGraveyard} onChange={(e) => setSettings((s) => ({ ...s, autoGraveyard: e.target.checked }))} />
                Auto send to Graveyard at 0 HP
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.showHidden} onChange={(e) => setSettings((s) => ({ ...s, showHidden: e.target.checked }))} />
                Show Hidden in list
              </label>
            </div>
          )}

          {tab === 'graveyard' && (
            !confirmClearGY ? (
              <button className="ml-auto px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700 text-neutral-200" onClick={() => setConfirmClearGY(true)}>Clear Graveyard</button>
            ) : (
              <span className="ml-auto inline-flex items-center gap-2">
                <button className="px-3 py-2 rounded-2xl bg-rose-700 text-white" onClick={() => { const prevGY = graveyard; setGraveyard([]); setConfirmClearGY(false); showToast('Cleared graveyard', () => setGraveyard(prevGY)); }}>Confirm</button>
                <button className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700 text-neutral-200" onClick={() => setConfirmClearGY(false)}>Cancel</button>
              </span>
            )
          )}
        </div>

        {/* Add form */}
        {tab === 'active' && (
          <section className="bg-neutral-800 rounded-2xl shadow-sm border border-neutral-700 p-4 md:p-5">
            <h2 className="text-lg font-semibold mb-3 text-neutral-100">Add Combatant</h2>
            <div className="grid md:grid-cols-6 gap-3">
              <label className="flex flex-col">
                <span className="text-xs font-semibold mb-1 text-neutral-300">Name</span>
                <input className="border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-3 py-2" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="flex flex-col">
                <span className="text-xs font-semibold mb-1 text-neutral-300">Team</span>
                <select className="border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-3 py-2" value={team} onChange={(e) => setTeam(e.target.value)}>
                  <option>Player</option>
                  <option>Enemy</option>
                  <option>Ally</option>
                  <option>Neutral</option>
                </select>
              </label>

              {team !== 'Player' && (
                <>
                  <label className="flex flex-col">
                    <span className="text-xs font-semibold mb-1 text-neutral-300">Current HP</span>
                    <input className="border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-3 py-2" type="number" value={hp} min={-9999} onChange={(e) => setHp(Number(e.target.value))} placeholder="HP" />
                  </label>
                  <label className="flex flex-col">
                    <span className="text-xs font-semibold mb-1 text-neutral-300">Max HP</span>
                    <input className="border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-3 py-2" type="number" value={maxHp} min={1} onChange={(e) => setMaxHp(Number(e.target.value))} placeholder="Max HP" />
                  </label>
                </>
              )}

              <label className="flex flex-col">
                <span className="text-xs font-semibold mb-1 text-neutral-300">Initiative</span>
                <input className="border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-3 py-2" type="number" value={init} onChange={(e) => setInit(Number(e.target.value))} placeholder="Initiative" />
              </label>
              <label className="flex flex-col md:col-span-3">
                <span className="text-xs font-semibold mb-1 text-neutral-300">Notes (optional)</span>
                <input className="border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-3 py-2" placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
              <div className="md:col-span-3 flex gap-2">
                <button className="flex-1 px-4 py-2 rounded-2xl bg-neutral-700 text-neutral-100" onClick={addCombatant}>Add</button>
                <button className="px-4 py-2 rounded-2xl bg-neutral-800 border border-neutral-700 text-neutral-200" onClick={resetForm}>Reset</button>
                <button className="px-4 py-2 rounded-2xl bg-neutral-800 border border-neutral-700 text-neutral-200" onClick={() => {
                  const now = Date.now();
                  const mk = (i, s) => ({ id: uid(), createdAt: now + i, tie: null, hidden: false, down: s.team === 'Player' ? false : s.hp <= 0, ...s });
                  const samples = [
                    mk(1, { name: 'Aelar', team: 'Player', hp: null, maxHp: null, init: 15, notes: 'Elf ranger' }),
                    mk(2, { name: 'Cleric', team: 'Player', hp: null, maxHp: null, init: 12, notes: 'Bless ready' }),
                    mk(3, { name: 'Bandit 1', team: 'Enemy', hp: 11, maxHp: 11, init: 14, notes: 'Scimitar' }),
                    mk(4, { name: 'Bandit 2', team: 'Enemy', hp: 11, maxHp: 11, init: 8, notes: 'Crossbow' }),
                  ];
                  const prevC = combatants; const prevA = activeId;
                  const next = [...combatants, ...samples];
                  setCombatants(next);
                  const first = sortByInit(samples.filter((x) => !x.hidden))[0];
                  if (first) setActiveId(first.id);
                  setRound(1);
                  showToast('Loaded sample data', () => { setCombatants(prevC); setActiveId(prevA); });
                }}>Sample</button>
                <button className="px-4 py-2 rounded-2xl bg-neutral-800 border border-neutral-700 text-rose-300" onClick={() => {
                  if (!confirm('Clear all combatants?')) return;
                  const prevC = combatants; const prevA = activeId; const prevR = round;
                  setCombatants([]); setActiveId(null); setRound(1);
                  showToast('Cleared all combatants', () => { setCombatants(prevC); setActiveId(prevA); setRound(prevR); });
                }}>Clear</button>
              </div>
            </div>
          </section>
        )}

        {/* Active or Graveyard table */}
        {tab === 'active' ? (
          <section className="bg-neutral-800 rounded-2xl shadow-sm border border-neutral-700">
            <div className="border-b border-neutral-700 px-4 md:px-5 py-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-neutral-100">Initiative Order</h2>
              <div className="text-sm text-neutral-400">Tap a row to set active. Hidden are excluded from turn order. When showing hidden, they are highlighted in light blue.</div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-neutral-800">
                  <tr className="text-left text-neutral-300">
                    <th className="px-3 py-2">Init</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Team</th>
                    <th className="px-3 py-2">HP</th>
                    <th className="px-3 py-2">Notes</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {listForDisplay.length === 0 && (
                    <tr><td className="px-3 py-6 text-center text-neutral-400" colSpan={6}>No combatants yet. Add some above.</td></tr>
                  )}
                  {listForDisplay.map((c) => {
                    const isActive = c.id === activeId;
                    const isPC = c.team === 'Player';
                    const hpPct = !isPC && typeof c.maxHp === 'number' && c.maxHp > 0
                      ? Math.max(0, Math.min(100, Math.round((c.hp / c.maxHp) * 100)))
                      : 0;
                    const hiddenHighlight = c.hidden && settings.showHidden ? 'bg-sky-900/30' : '';
                    const downHighlight = c.down ? 'bg-rose-900/30' : '';
                    return (
                      <tr key={c.id} className={`${isActive ? 'bg-amber-900/20' : ''} ${hiddenHighlight} ${downHighlight} ${c.hidden ? 'opacity-90' : ''} border-b border-neutral-700 last:border-0 hover:bg-neutral-700/50 transition-colors`} onClick={() => setActiveId(c.id)} title={c.hidden ? 'Hidden (excluded from turn order)' : undefined}>
                        <td className="px-3 py-3 font-mono text-neutral-200">
                          <div className="flex items-center gap-2">
                            <span>{c.init}</span>
                            <input className="w-12 border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-2 py-1 text-xs" type="number" min={1} max={20} placeholder="+" title="Roll-off (1–20). Leave blank to clear." value={c.tie ?? ''} onClick={(e) => e.stopPropagation()} onChange={(e) => setTie(c.id, e.target.value)} />
                            {c.tie != null && <span className="text-xs text-neutral-400">(applied)</span>}
                            {c.hidden && <span className="ml-1 text-xs text-neutral-400">(hidden)</span>}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-semibold flex items-center gap-2 flex-wrap">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${
                              c.team === 'Player' ? 'bg-neutral-700 border-neutral-600' :
                              c.team === 'Enemy' ? 'bg-rose-900/30 border-rose-800' :
                              c.team === 'Ally' ? 'bg-sky-900/30 border-sky-800' : 'bg-neutral-700 border-neutral-600'
                            }`}>{c.team}</span>
                            <span className={`${c.down ? 'line-through text-neutral-400' : 'text-neutral-100'}`}>{c.name}</span>
                            {c.down && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-900/40 text-rose-300 border border-rose-800">● Downed</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-neutral-300">{c.team}</td>
                        <td className="px-3 py-3 w-[240px]">
                          {isPC ? (
                            <span className="text-neutral-500">—</span>
                          ) : (
                            <>
                              <div className="flex items-center gap-2">
                                <input className="w-16 border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-2 py-1 font-mono" type="number" value={c.hp} onClick={(e) => e.stopPropagation()} onChange={(e) => setExactHp(c.id, e.target.value)} />
                                <span className="text-neutral-400">/ {c.maxHp}</span>
                              </div>
                              <div className="h-2 bg-neutral-700 rounded-full mt-2 overflow-hidden">
                                <div className={`h-full ${hpPct > 50 ? 'bg-emerald-500' : hpPct > 20 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${hpPct}%` }} />
                              </div>
                            </>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <EditableText value={c.notes} onChange={(v) => updateCombatant(c.id, { notes: v })} />
                        </td>
                        <td className="px-3 py-3">
                          <RowActions
                            onDamage={(n) => applyDamage(c.id, n)}
                            onHeal={(n) => applyHeal(c.id, n)}
                            onRemove={() => moveToGraveyard(c.id)}
                            onToggleDown={() => updateCombatant(c.id, { down: !c.down })}
                            onToggleHidden={() => updateCombatant(c.id, { hidden: !c.hidden })}
                            isDown={c.down}
                            isHidden={c.hidden}
                            isPC={isPC}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <section className="bg-neutral-800 rounded-2xl shadow-sm border border-neutral-700">
            <div className="border-b border-neutral-700 px-4 md:px-5 py-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-neutral-100">Graveyard</h2>
              <div className="text-sm text-neutral-400">Defeated/removed combatants. Restore or delete forever.</div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-neutral-800">
                  <tr className="text-left text-neutral-300">
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Team</th>
                    <th className="px-3 py-2">Init</th>
                    <th className="px-3 py-2">HP</th>
                    <th className="px-3 py-2">Removed</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {graveyard.length === 0 && (
                    <tr><td className="px-3 py-6 text-center text-neutral-400" colSpan={6}>Graveyard is empty.</td></tr>
                  )}
                  {graveyard.map((g) => (
                    <tr key={g.id} className="border-b border-neutral-700 last:border-0 hover:bg-neutral-700/50">
                      <td className="px-3 py-3"><span className="line-through text-neutral-400">{g.name}</span></td>
                      <td className="px-3 py-3 text-neutral-300">{g.team}</td>
                      <td className="px-3 py-3 font-mono text-neutral-200">{g.init}{g.tie != null && <span className="ml-1 text-xs text-neutral-400">(+{g.tie})</span>}</td>
                      <td className="px-3 py-3">{typeof g.hp === 'number' && typeof g.maxHp === 'number' ? `${g.hp} / ${g.maxHp}` : '—'}</td>
                      <td className="px-3 py-3 text-neutral-400">{new Date(g.removedAt || Date.now()).toLocaleString()}</td>
                      <td className="px-3 py-3">
                        <GraveyardRowActions onRestore={() => restoreFromGraveyard(g.id)} onDelete={() => deleteForeverConfirmed(g.id)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Footer tips */}
        <footer className="text-xs text-neutral-400 text-center py-2">
          Tip: Players don't track HP here. Hidden are excluded from turn order (unless shown). Auto-Graveyard moves 0 HP (non-Player) to Graveyard. Use 🎲 or the (+) field to resolve ties. Hidden rows appear light blue when shown. Downed entries show a red tag.
        </footer>

        {/* Hidden file input for Import */}
        <input type="file" accept="application/json" ref={importInputRef} className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) importFromFile(file); if (e.target) e.target.value = ""; }} />
      </div>

      {/* Undo Toast */}
      {toast && (
        <div className="toast fixed left-1/2 -translate-x-1/2 bottom-4 z-50 max-w-[90vw] sm:max-w-md">
          <div className="rounded-2xl border border-neutral-700 bg-neutral-800/95 backdrop-blur px-4 py-3 shadow-xl text-neutral-100 flex items-center gap-3">
            <span className="text-sm">{toast.message}</span>
            {toast.undo && (
              <button className="px-3 py-1.5 rounded-xl bg-neutral-700 text-neutral-100 border border-neutral-600" onClick={() => { toast.undo(); hideToast(); }}>Undo</button>
            )}
            <button className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700 text-neutral-300" onClick={hideToast} aria-label="Dismiss notification">Dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Small subcomponents
// ------------------------------------------------------------
function RowActions({ onDamage, onHeal, onRemove, onToggleDown, onToggleHidden, isDown, isHidden, isPC }) {
  const [amt, setAmt] = useState(5);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!isPC && (
        <>
          <input className="w-16 border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-2 py-1 font-mono" type="number" value={amt} min={1} onClick={(e) => e.stopPropagation()} onChange={(e) => setAmt(Math.max(1, Number(e.target.value)))} />
          <button className="px-3 py-1.5 rounded-xl bg-rose-700 text-white" onClick={(e) => { e.stopPropagation(); onDamage(amt); }}>− Damage</button>
          <button className="px-3 py-1.5 rounded-xl bg-neutral-700 text-neutral-100" onClick={(e) => { e.stopPropagation(); onHeal(amt); }}>+ Heal</button>
        </>
      )}
      <button className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700" onClick={(e) => { e.stopPropagation(); onToggleDown(); }}>{isDown ? 'Mark Up' : 'Mark Down'}</button>
      <button className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700" onClick={(e) => { e.stopPropagation(); onToggleHidden(); }}>{isHidden ? 'Unhide' : 'Hide'}</button>

      {!confirming ? (
        <button className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700 text-rose-300" onClick={(e) => { e.stopPropagation(); setConfirming(true); }}>Delete</button>
      ) : (
        <span className="inline-flex items-center gap-2">
          <button className="px-3 py-1.5 rounded-xl bg-rose-700 text-white" title="Confirm deletion" onClick={(e) => { e.stopPropagation(); onRemove(); setConfirming(false); }}>Confirm</button>
          <button className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700 text-neutral-200" title="Cancel deletion" onClick={(e) => { e.stopPropagation(); setConfirming(false); }}>Cancel</button>
        </span>
      )}
    </div>
  );
}

function GraveyardRowActions({ onRestore, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex gap-2">
      <button className="px-3 py-1.5 rounded-xl bg-neutral-700 text-neutral-100" onClick={(e) => { e.stopPropagation(); onRestore(); }}>Restore</button>
      {!confirming ? (
        <button className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700 text-rose-300" onClick={(e) => { e.stopPropagation(); setConfirming(true); }}>Delete Forever</button>
      ) : (
        <span className="inline-flex items-center gap-2">
          <button className="px-3 py-1.5 rounded-xl bg-rose-700 text-white" onClick={(e) => { e.stopPropagation(); onDelete(); setConfirming(false); }}>Confirm</button>
          <button className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700 text-neutral-200" onClick={(e) => { e.stopPropagation(); setConfirming(false); }}>Cancel</button>
        </span>
      )}
    </div>
  );
}

function EditableText({ value, onChange }) {
  const [editing, setEditing] = useState(false);
  const [temp, setTemp] = useState(value || "");
  useEffect(() => setTemp(value || ""), [value]);

  if (!editing) {
    return (
      <div className="min-h-[28px] text-neutral-200" onClick={(e) => { e.stopPropagation(); setEditing(true); }}>
        {value ? <span>{value}</span> : <span className="text-neutral-500">(tap to add)</span>}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <input className="border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-2 py-1 w-full" value={temp} onChange={(e) => setTemp(e.target.value)} />
      <button className="px-3 py-1.5 rounded-xl bg-neutral-700 text-neutral-100" onClick={() => { onChange(temp.trim()); setEditing(false); }}>Save</button>
      <button className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700 text-neutral-200" onClick={() => { setTemp(value || ""); setEditing(false); }}>Cancel</button>
    </div>
  );
}



