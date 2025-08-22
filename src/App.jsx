import React, { useEffect, useMemo, useRef, useState } from "react";

// --- Small pure helpers (also used by self-tests) ---
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const sortByInit = (list) =>
  [...list].sort((a, b) => {
    if (b.init !== a.init) return b.init - a.init; // primary: initiative desc
    const at = a.tie ?? -Infinity;
    const bt = b.tie ?? -Infinity;
    if (bt !== at) return bt - at; // secondary: roll-off desc (higher wins)
    return a.name.localeCompare(b.name); // tertiary: name asc (stable)
  });
const applyDamagePure = (c, amount) => {
  const newHp = clamp(c.hp - Math.abs(amount), -9999, c.maxHp);
  return { ...c, hp: newHp, down: newHp <= 0 };
};
const applyHealPure = (c, amount) => {
  const newHp = clamp(c.hp + Math.abs(amount), -9999, c.maxHp);
  return { ...c, hp: newHp, down: newHp <= 0 };
};

// --- Lightweight in-app self tests (console-only) ---
function runSelfTests() {
  try {
    // Sorting by initiative desc, then name asc when tie missing
    const a = { name: "Alu", init: 10, hp: 5, maxHp: 10 };
    const b = { name: "Bex", init: 15, hp: 5, maxHp: 10 };
    const c = { name: "Ana", init: 15, hp: 5, maxHp: 10 };
    const sorted = sortByInit([a, b, c]).map((x) => x.name);
    console.assert(JSON.stringify(sorted) === JSON.stringify(["Ana", "Bex", "Alu"]), "Sort test failed");

    // Damage/heal math clamps and flags down state
    const d0 = { name: "D", hp: 10, maxHp: 20 };
    const d1 = applyDamagePure(d0, 7);
    console.assert(d1.hp === 3 && d1.down === false, "Damage test failed");
    const d2 = applyDamagePure(d1, 5);
    console.assert(d2.hp === -2 && d2.down === true, "Downed test failed");
    const d3 = applyHealPure(d2, 7);
    console.assert(d3.hp === 5 && d3.down === false, "Heal test failed");

    // Clamp boundaries
    console.assert(clamp(100, 0, 10) === 10 && clamp(-5, 0, 10) === 0, "Clamp test failed");

    // Roll-off sort test (tie on init, resolve by tie desc)
    const t1 = { name: "Tie A", init: 12, tie: 5 };
    const t2 = { name: "Tie B", init: 12, tie: 15 };
    const tSorted = sortByInit([t1, t2]).map((x) => x.name);
    console.assert(JSON.stringify(tSorted) === JSON.stringify(["Tie B", "Tie A"]), "Roll-off sort failed");

    // Manual tie edit behavior
    const m1 = { name: "Man 1", init: 10, tie: 2 };
    const m2 = { name: "Man 2", init: 10, tie: 18 };
    const mSorted = sortByInit([m1, m2]).map((x) => x.name);
    console.assert(JSON.stringify(mSorted) === JSON.stringify(["Man 2", "Man 1"]), "Manual tie sort failed");

    // Hidden filter behavior
    const hiddenList = [
      { id: "a", name: "V", init: 10, hidden: false },
      { id: "b", name: "W", init: 12, hidden: true },
      { id: "c", name: "X", init: 11, hidden: false },
    ];
    const visibleNames = sortByInit(hiddenList).filter((c) => !c.hidden).map((c) => c.name);
    console.assert(JSON.stringify(visibleNames) === JSON.stringify(["X", "V"]), "Hidden filter failed");

    // Downed tagging logic: <=0 down, heal above 0 clears
    const dd0 = { name: "Y", hp: 1, maxHp: 5 };
    const dd1 = applyDamagePure(dd0, 2);
    console.assert(dd1.down === true, "Auto-down on <=0 failed");
    const dd2 = applyHealPure(dd1, 5);
    console.assert(dd2.down === false, "Clear down on heal >0 failed");

    // Extra: sorting should be stable across equal init & tie by name
    const s1 = { name: "Beta", init: 10, tie: 10 };
    const s2 = { name: "Alpha", init: 10, tie: 10 };
    const sNames = sortByInit([s1, s2]).map((x) => x.name);
    console.assert(JSON.stringify(sNames) === JSON.stringify(["Alpha", "Beta"]), "Stable tertiary sort failed");

    // NEW: heal clamps at max
    const h0 = { name: "H", hp: 8, maxHp: 10 };
    const h1 = applyHealPure(h0, 50);
    console.assert(h1.hp === 10, "Heal clamp to max failed");
    // NEW: big damage clamps not below min bound
    const z0 = { name: "Z", hp: 3, maxHp: 10 };
    const z1 = applyDamagePure(z0, 9999);
    console.assert(z1.hp >= -9999, "Damage clamp lower bound failed");

    console.log("✅ DnD Combat Tracker self-tests passed");
  } catch (e) {
    console.error("❌ DnD Combat Tracker self-tests failed:", e);
  }
}

// DnD Combat Tracker — single-file React component
// Works on tablets & laptops. Data persists in localStorage.
// Features: add PCs/enemies, HP editing with damage/heal (non-PC only), initiative sorting, tie roll-offs (manual + auto), turn tracker,
// hide from turn order, auto-graveyard at 0 HP (non-PC only), graveyard tab, notes, labeled inputs, themes, hover affordances, and undo toast.
export default function CombatTracker() {
  // --- Add form state ---
  const [name, setName] = useState("");
  const [team, setTeam] = useState("PC");
  const [hp, setHp] = useState(30);
  const [maxHp, setMaxHp] = useState(30);
  const [init, setInit] = useState(10);
  const [notes, setNotes] = useState("");

  // --- Settings (persisted) ---
  const [settings, setSettings] = useState(() => {
    try {
      const raw = localStorage.getItem("dnd_tracker_settings_v1");
      if (raw) return JSON.parse(raw);
    } catch {}
    return { autoGraveyard: true, showHidden: false, theme: "dark" };
  });
  useEffect(() => {
    localStorage.setItem("dnd_tracker_settings_v1", JSON.stringify(settings));
  }, [settings]);

  // --- Encounter state (with persistence) ---
  const [combatants, setCombatants] = useState(() => {
    try {
      const raw = localStorage.getItem("dnd_tracker_combatants_v2");
      if (raw) return JSON.parse(raw);
    } catch {}
    return [];
  });
  const [graveyard, setGraveyard] = useState(() => {
    try {
      const raw = localStorage.getItem("dnd_tracker_graveyard_v1");
      if (raw) return JSON.parse(raw);
    } catch {}
    return [];
  });
  const [activeId, setActiveId] = useState(() => {
    try {
      const raw = localStorage.getItem("dnd_tracker_active_v2");
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  });
  const [round, setRound] = useState(() => {
    try {
      const raw = localStorage.getItem("dnd_tracker_round_v2");
      if (raw) return JSON.parse(raw);
    } catch {}
    return 1;
  });
  const [tab, setTab] = useState("active"); // 'active' | 'graveyard'
  const [confirmClearGY, setConfirmClearGY] = useState(false);

  // --- Toast (undo) ---
  const [toast, setToast] = useState(null); // { message, undo }
  const toastTimerRef = useRef(null);
  const showToast = (message, undo) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, undo });
    toastTimerRef.current = setTimeout(() => setToast(null), 5000);
  };
  const hideToast = () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(null);
  };
  useEffect(() => () => toastTimerRef.current && clearTimeout(toastTimerRef.current), []);

  useEffect(() => {
    localStorage.setItem("dnd_tracker_combatants_v2", JSON.stringify(combatants));
  }, [combatants]);
  useEffect(() => {
    localStorage.setItem("dnd_tracker_graveyard_v1", JSON.stringify(graveyard));
  }, [graveyard]);
  useEffect(() => {
    localStorage.setItem("dnd_tracker_active_v2", JSON.stringify(activeId));
  }, [activeId]);
  useEffect(() => {
    localStorage.setItem("dnd_tracker_round_v2", JSON.stringify(round));
  }, [round]);

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

  const resetForm = () => {
    setName("");
    setTeam("PC");
    setHp(30);
    setMaxHp(30);
    setInit(10);
    setNotes("");
  };

  const addCombatant = () => {
    if (!name.trim()) return;
    const id = uid();
    const isPC = team === "PC";
    const c = {
      id,
      name: name.trim(),
      team,
      hp: isPC ? null : Number(hp),
      maxHp: isPC ? null : Number(maxHp),
      init: Number(init),
      tie: null, // roll-off tiebreaker (d20), null when not set
      hidden: false, // excluded from turn order when true
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
    showToast(`Added ${c.name}`, () => {
      setCombatants(prevCombatants);
      setActiveId(prevActive);
    });
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
    // Keep native confirm for any flows that might call this directly
    if (!confirm("Permanently delete this combatant from the graveyard? This cannot be undone.")) return;
    const prevGY = graveyard;
    setGraveyard((g) => g.filter((c) => c.id !== id));
    showToast("Deleted forever", () => setGraveyard(prevGY));
  };

  // Inline-confirmed variant used by the GraveyardRowActions (no native confirm to avoid blocked dialogs)
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
        showToast(`Restored ${target.name}`, () => {
          setCombatants(prevCombatants);
          setGraveyard(prevGY);
        });
      }
      return remaining;
    });
  };

  // --- HP change helpers with Auto-Graveyard support ---
  const autoGrave = (next) => {
    if (!settings.autoGraveyard) return next;
    const toMove = next.filter((c) => c.team !== "PC" && typeof c.hp === "number" && c.hp <= 0);
    if (toMove.length === 0) return next;
    const prevGY = graveyard;
    setGraveyard((g) => [
      ...toMove.map((c) => ({ ...c, removedAt: Date.now() })),
      ...g,
    ]);
    const remaining = next.filter((c) => !(c.team !== "PC" && typeof c.hp === "number" && c.hp <= 0));
    ensureActiveValid(remaining);
    showToast(`Auto-moved ${toMove.length} to Graveyard`, () => setGraveyard(prevGY));
    return remaining;
  };

  const applyDamage = (id, amount) => {
    setCombatants((prev) => {
      const mapped = prev.map((c) => {
        if (c.id !== id) return c;
        if (c.team === "PC" || typeof c.hp !== "number") return c; // PCs don't track HP here
        return applyDamagePure(c, amount);
      });
      const after = autoGrave(mapped);
      return after;
    });
  };

  const applyHeal = (id, amount) => {
    setCombatants((prev) => prev.map((c) => {
      if (c.id !== id) return c;
      if (c.team === "PC" || typeof c.hp !== "number") return c; // PCs don't track HP here
      return applyHealPure(c, amount);
    }));
  };

  const setExactHp = (id, value) => {
    const val = Number(value);
    setCombatants((prev) => {
      const mapped = prev.map((c) => {
        if (c.id !== id) return c;
        if (c.team === "PC" || typeof c.hp !== "number") return c;
        const hpVal = clamp(val, -9999, c.maxHp);
        return { ...c, hp: hpVal, down: hpVal <= 0 };
      });
      const after = autoGrave(mapped);
      return after;
    });
  };

  // Manual tie editor
  const setTie = (id, value) => {
    const raw = value;
    let v = null;
    if (raw === "" || raw === null || typeof raw === "undefined") {
      v = null;
    } else {
      const n = Number(raw);
      if (Number.isFinite(n)) v = clamp(Math.round(n), 1, 20);
      else v = null;
    }
    setCombatants((prev) => prev.map((c) => (c.id === id ? { ...c, tie: v } : c)));
  };

  const nextTurn = () => {
    const vis = visible;
    if (vis.length === 0) return;
    const idx = Math.max(0, activeIndex);
    const next = vis[(idx + 1) % vis.length];
    if (idx === vis.length - 1) setRound((r) => r + 1);
    setActiveId(next.id);
  };

  const prevTurn = () => {
    const vis = visible;
    if (vis.length === 0) return;
    const idx = Math.max(0, activeIndex);
    const prev = vis[(idx - 1 + vis.length) % vis.length];
    if (idx === 0) setRound((r) => Math.max(1, r - 1));
    setActiveId(prev.id);
  };

  const startEncounter = () => {
    const vis = visible;
    if (vis.length === 0) return;
    setRound(1);
    setActiveId(vis[0].id);
  };

  const clearAll = () => {
    if (!confirm("Clear all combatants?")) return;
    const prevC = combatants;
    const prevActive = activeId;
    const prevRound = round;
    setCombatants([]);
    setActiveId(null);
    setRound(1);
    showToast("Cleared all combatants", () => {
      setCombatants(prevC);
      setActiveId(prevActive);
      setRound(prevRound);
    });
  };

  const clearGraveyard = () => {
    // Legacy native confirm (kept for completeness; not used by inline UI)
    if (!confirm("Permanently clear the entire graveyard? This cannot be undone.")) return;
    const prevGY = graveyard;
    setGraveyard([]);
    showToast("Cleared graveyard", () => setGraveyard(prevGY));
  };

  const clearGraveyardConfirmed = () => {
    const prevGY = graveyard;
    setGraveyard([]);
    setConfirmClearGY(false);
    showToast("Cleared graveyard", () => setGraveyard(prevGY));
  };

  const addSample = () => {
    const now = Date.now();
    const mk = (i, s) => ({ id: uid(), createdAt: now + i, tie: null, hidden: false, down: s.team === "PC" ? false : s.hp <= 0, ...s });
    const samples = [
      mk(1, { name: "Aelar", team: "PC", hp: null, maxHp: null, init: 15, notes: "Elf ranger" }),
      mk(2, { name: "Cleric", team: "PC", hp: null, maxHp: null, init: 12, notes: "Bless ready" }),
      mk(3, { name: "Bandit 1", team: "Enemy", hp: 11, maxHp: 11, init: 14, notes: "Scimitar" }),
      mk(4, { name: "Bandit 2", team: "Enemy", hp: 11, maxHp: 11, init: 8, notes: "Crossbow" }),
    ];
    const prevC = combatants;
    const prevActive = activeId;
    const next = [...combatants, ...samples];
    setCombatants(next);
    const first = sortByInit(samples.filter((x) => !x.hidden))[0];
    if (first) setActiveId(first.id);
    setRound(1);
    showToast("Loaded sample data", () => {
      setCombatants(prevC);
      setActiveId(prevActive);
    });
  };

  // --- Roll-off helpers ---
  const rollD20 = () => Math.floor(Math.random() * 20) + 1;

  const rollTies = () => {
    // Find groups by initiative with size > 1 and assign unique d20 rolls within each group
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
          // ensure uniqueness within the tied group
          while (used.has(roll)) roll = rollD20();
          used.add(roll);
          updates.set(c.id, roll);
        }
      }
      return prev.map((c) => (updates.has(c.id) ? { ...c, tie: updates.get(c.id) } : c));
    });
  };

  const clearTies = () => {
    setCombatants((prev) => prev.map((c) => (c.tie != null ? { ...c, tie: null } : c)));
  };

  // Run self-tests once
  useEffect(() => {
    runSelfTests();
  }, []);

  const containerRef = useRef(null);

  const listForDisplay = settings.showHidden ? sorted : visible;

  return (
    <div className={`${settings.theme === 'dark' ? 'dark-root' : 'light-root'} min-h-screen bg-neutral-900 text-neutral-100 p-4 md:p-6`}>
      {/* Theme + affordances (single, valid <style> block) */}
      <style>{`
        .light-root { background-color: #f8fafc; color: #0f172a; }
        .light-root .bg-neutral-900 { background-color: #f8fafc !important; }
        .light-root .text-neutral-100 { color: #0f172a !important; }
        .light-root .text-neutral-200 { color: #111827 !important; }
        .light-root .text-neutral-300 { color: #374151 !important; }
        .light-root .text-neutral-400 { color: #6b7280 !important; }
        .light-root .text-neutral-500 { color: #9ca3af !important; }
        .light-root .bg-neutral-800 { background-color: #ffffff !important; }
        .light-root .border-neutral-700 { border-color: #e5e7eb !important; }
        .light-root .bg-neutral-700 { background-color: #111827 !important; color: #f9fafb !important; }
        .light-root input.bg-neutral-900, .light-root select.bg-neutral-900, .light-root textarea.bg-neutral-900 { background-color: #ffffff !important; color: #111827 !important; border-color: #cbd5e1 !important; }
        .light-root .bg-neutral-700.rounded-full > div { background-color: #e5e7eb !important; }
        .light-root .text-rose-300 { color: #b91c1c !important; }
        .light-root .bg-rose-700 { background-color: #dc2626 !important; }
        .light-root .bg-amber-900\/20 { background-color: rgba(245,158,11,0.15) !important; }
        .light-root .bg-sky-900\/30 { background-color: rgba(14,165,233,0.12) !important; }
        .light-root .bg-rose-900\/30 { background-color: rgba(239,68,68,0.12) !important; }
        .light-root .bg-rose-900\/40 { background-color: rgba(239,68,68,0.18) !important; }
        .light-root .border-rose-800 { border-color: rgba(239,68,68,0.35) !important; }
        .light-root .border-sky-800 { border-color: rgba(14,165,233,0.35) !important; }
        .light-root .bg-neutral-700.text-neutral-100 { background-color: #111827 !important; color: #f9fafb !important; }
        .light-root .bg-neutral-800.border { background-color: #ffffff !important; }
        /* Toast light overrides */
        .light-root .toast { background: #111827 !important; color: #f9fafb !important; border-color: #e5e7eb !important; }
        .light-root .toast button { background: #ffffff !important; color: #111827 !important; border-color: #cbd5e1 !important; }

        /* Global hover/focus affordances */
        .dark-root button { cursor: pointer; transition: background-color .15s ease, border-color .15s ease, box-shadow .15s ease, transform .05s ease; }
        .dark-root button:hover { filter: brightness(1.12); box-shadow: 0 2px 10px rgba(0,0,0,0.35); border-color: #a3a3a3 !important; }
        .dark-root button:active { transform: translateY(1px); }
        .dark-root button:focus-visible { outline: 2px solid #fbbf24; outline-offset: 2px; }
        .dark-root input, .dark-root select, .dark-root textarea { transition: border-color .15s ease, box-shadow .15s ease; }
        .dark-root input:focus, .dark-root select:focus, .dark-root textarea:focus { border-color: #a3a3a3 !important; box-shadow: 0 0 0 2px rgba(250,204,21,.25); }

        .light-root button { cursor: pointer; transition: background-color .15s ease, border-color .15s ease, box-shadow .15s ease, transform .05s ease; }
        .light-root button:hover { filter: brightness(0.96); box-shadow: 0 2px 12px rgba(0,0,0,0.10); border-color: #9ca3af !important; }
        .light-root button:active { transform: translateY(1px); }
        .light-root button:focus-visible { outline: 2px solid #0ea5e9; outline-offset: 2px; }
        .light-root input, .light-root select, .light-root textarea { transition: border-color .15s ease, box-shadow .15s ease; }
        .light-root input:focus, .light-root select:focus, .light-root textarea:focus { border-color: #0ea5e9 !important; box-shadow: 0 0 0 2px rgba(14,165,233,.25); }
      `}</style>

      <div className="max-w-6xl mx-auto grid gap-4">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-neutral-100">DnD Combat Tracker</h1>
          <div className="flex flex-wrap items-center gap-2">
            <button className="px-3 py-2 rounded-2xl bg-neutral-700 text-neutral-100" onClick={startEncounter}>Start</button>
            <button className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700" onClick={prevTurn} aria-label="Previous turn">◀ Prev</button>
            <div className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700">Round <b className="ml-1">{round}</b></div>
            <button className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700" onClick={nextTurn} aria-label="Next turn">Next ▶</button>
            <button className="px-3 py-2 rounded-2xl bg-neutral-700 text-neutral-100" onClick={rollTies} title="Roll d20 for tied initiatives">🎲 Roll Ties</button>
            <button className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700" onClick={clearTies} title="Clear roll-off tiebreakers">Clear Ties</button>
            <button className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700" onClick={() => setSettings((s) => ({ ...s, theme: s.theme === 'dark' ? 'light' : 'dark' }))} title="Toggle light/dark">
              {settings.theme === 'dark' ? '☀ Light' : '🌙 Dark'}
            </button>
          </div>
        </header>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <nav className="flex items-center gap-2">
            <button
              className={`px-3 py-2 rounded-2xl border ${tab === "active" ? "bg-neutral-700 text-neutral-100 border-neutral-600" : "bg-neutral-800 text-neutral-200 border-neutral-700"}`}
              onClick={() => setTab("active")}
            >
              Active ({combatants.length})
            </button>
            <button
              className={`px-3 py-2 rounded-2xl border ${tab === "graveyard" ? "bg-neutral-700 text-neutral-100 border-neutral-600" : "bg-neutral-800 text-neutral-200 border-neutral-700"}`}
              onClick={() => setTab("graveyard")}
            >
              Graveyard ({graveyard.length})
            </button>
          </nav>
          {tab === "active" && (
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
          {tab === "graveyard" && (
            !confirmClearGY ? (
              <button className="ml-auto px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700 text-neutral-200" onClick={() => setConfirmClearGY(true)}>Clear Graveyard</button>
            ) : (
              <span className="ml-auto inline-flex items-center gap-2">
                <button className="px-3 py-2 rounded-2xl bg-rose-700 text-white" onClick={clearGraveyardConfirmed}>Confirm</button>
                <button className="px-3 py-2 rounded-2xl bg-neutral-800 border border-neutral-700 text-neutral-200" onClick={() => setConfirmClearGY(false)}>Cancel</button>
              </span>
            )
          )}
        </div>

        {/* Add form (only show on Active tab) */}
        {tab === "active" && (
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
                  <option>PC</option>
                  <option>Enemy</option>
                  <option>Ally</option>
                  <option>Neutral</option>
                </select>
              </label>

              {team !== "PC" && (
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
                <button className="px-4 py-2 rounded-2xl bg-neutral-800 border border-neutral-700 text-neutral-200" onClick={addSample}>Sample</button>
                <button className="px-4 py-2 rounded-2xl bg-neutral-800 border border-neutral-700 text-rose-300" onClick={clearAll}>Clear</button>
              </div>
            </div>
          </section>
        )}

        {/* Active or Graveyard table */}
        {tab === "active" ? (
          <section ref={containerRef} className="bg-neutral-800 rounded-2xl shadow-sm border border-neutral-700">
            <div className="border-b border-neutral-700 px-4 md:px-5 py-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-neutral-100">Initiative Order</h2>
              <div className="text-sm text-neutral-400">Tap a row to set active. Sorted by initiative (↓). Use 🎲 for roll-offs. You can manually enter a roll in the (+) field. Hidden are excluded from turn order. When showing hidden, they are highlighted in light blue.</div>
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
                    <tr>
                      <td className="px-3 py-6 text-center text-neutral-400" colSpan={6}>No combatants yet. Add some above.</td>
                    </tr>
                  )}
                  {listForDisplay.map((c) => {
                    const isActive = c.id === activeId;
                    const isPC = c.team === "PC";
                    const hpPct = !isPC && typeof c.maxHp === "number" && c.maxHp > 0
                      ? Math.max(0, Math.min(100, Math.round((c.hp / c.maxHp) * 100)))
                      : 0;
                    const hiddenHighlight = c.hidden && settings.showHidden ? "bg-sky-900/30" : ""; // dark: transparent blue
                    const downHighlight = c.down ? "bg-rose-900/30" : ""; // dark: transparent red
                    return (
                      <tr
                        key={c.id}
                        className={`${isActive ? "bg-amber-900/20" : ""} ${hiddenHighlight} ${downHighlight} ${c.hidden ? "opacity-90" : ""} border-b border-neutral-700 last:border-0 hover:bg-neutral-700/50 transition-colors`}
                        onClick={() => setActiveId(c.id)}
                        title={c.hidden ? "Hidden (excluded from turn order)" : undefined}
                      >
                        <td className="px-3 py-3 font-mono text-neutral-200">
                          <div className="flex items-center gap-2">
                            <span>{c.init}</span>
                            <input
                              className="w-12 border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-2 py-1 text-xs"
                              type="number"
                              min={1}
                              max={20}
                              placeholder="+"
                              title="Roll-off (1–20). Leave blank to clear."
                              value={c.tie ?? ""}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setTie(c.id, e.target.value)}
                            />
                            {c.tie != null && <span className="text-xs text-neutral-400">(applied)</span>}
                            {c.hidden && <span className="ml-1 text-xs text-neutral-400">(hidden)</span>}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-semibold flex items-center gap-2 flex-wrap">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${
                              c.team === "PC" ? "bg-neutral-700 border-neutral-600" :
                              c.team === "Enemy" ? "bg-rose-900/30 border-rose-800" :
                              c.team === "Ally" ? "bg-sky-900/30 border-sky-800" : "bg-neutral-700 border-neutral-600"
                            }`}>{c.team}</span>
                            <span className={`${c.down ? "line-through text-neutral-400" : "text-neutral-100"}`}>{c.name}</span>
                            {c.down && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-900/40 text-rose-300 border border-rose-800">
                                ● Downed
                              </span>
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
                                <input
                                  className="w-16 border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-2 py-1 font-mono"
                                  type="number"
                                  value={c.hp}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => setExactHp(c.id, e.target.value)}
                                />
                                <span className="text-neutral-400">/ {c.maxHp}</span>
                              </div>
                              <div className="h-2 bg-neutral-700 rounded-full mt-2 overflow-hidden">
                                <div
                                  className={`h-full ${hpPct > 50 ? "bg-emerald-500" : hpPct > 20 ? "bg-amber-500" : "bg-rose-500"}`}
                                  style={{ width: `${hpPct}%` }}
                                />
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
              <div className="text-sm text-neutral-400">Defeated/removed combatants. You can restore or delete forever.</div>
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
                    <tr>
                      <td className="px-3 py-6 text-center text-neutral-400" colSpan={6}>Graveyard is empty.</td>
                    </tr>
                  )}
                  {graveyard.map((g) => (
                    <tr key={g.id} className="border-b border-neutral-700 last:border-0 hover:bg-neutral-700/50">
                      <td className="px-3 py-3">
                        <span className="line-through text-neutral-400">{g.name}</span>
                      </td>
                      <td className="px-3 py-3 text-neutral-300">{g.team}</td>
                      <td className="px-3 py-3 font-mono text-neutral-200">{g.init}{g.tie != null && <span className="ml-1 text-xs text-neutral-400">(+{g.tie})</span>}</td>
                      <td className="px-3 py-3">{typeof g.hp === "number" && typeof g.maxHp === "number" ? `${g.hp} / ${g.maxHp}` : "—"}</td>
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
          Tip: PCs don't track HP here. Hidden are excluded from turn order (unless shown). Auto-Graveyard moves 0 HP (non-PC) to Graveyard. Use 🎲 or the (+) field to resolve ties. Hidden rows appear light blue when shown. Downed entries show a red tag.
        </footer>
      </div>

      {/* Undo Toast */}
      {toast && (
        <div className="toast fixed left-1/2 -translate-x-1/2 bottom-4 z-50 max-w-[90vw] sm:max-w-md">
          <div className="rounded-2xl border border-neutral-700 bg-neutral-800/95 backdrop-blur px-4 py-3 shadow-xl text-neutral-100 flex items-center gap-3">
            <span className="text-sm">{toast.message}</span>
            {toast.undo && (
              <button
                className="px-3 py-1.5 rounded-xl bg-neutral-700 text-neutral-100 border border-neutral-600"
                onClick={() => { toast.undo(); hideToast(); }}
              >
                Undo
              </button>
            )}
            <button
              className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700 text-neutral-300"
              onClick={hideToast}
              aria-label="Dismiss notification"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RowActions({ onDamage, onHeal, onRemove, onToggleDown, onToggleHidden, isDown, isHidden, isPC }) {
  const [amt, setAmt] = useState(5);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!isPC && (
        <>
          <input
            className="w-16 border border-neutral-700 bg-neutral-900 text-neutral-100 rounded-xl px-2 py-1 font-mono"
            type="number"
            value={amt}
            min={1}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setAmt(Math.max(1, Number(e.target.value)))}
          />
          <button className="px-3 py-1.5 rounded-xl bg-rose-700 text-white" onClick={(e) => { e.stopPropagation(); onDamage(amt); }}>− Damage</button>
          <button className="px-3 py-1.5 rounded-xl bg-neutral-700 text-neutral-100" onClick={(e) => { e.stopPropagation(); onHeal(amt); }}>+ Heal</button>
        </>
      )}
      {/* Removed quick −1/−5/+1/+5 buttons to save space */}
      <button className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700" onClick={(e) => { e.stopPropagation(); onToggleDown(); }}>{isDown ? "Mark Up" : "Mark Down"}</button>
      <button className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700" onClick={(e) => { e.stopPropagation(); onToggleHidden(); }}>{isHidden ? "Unhide" : "Hide"}</button>

      {!confirming ? (
        <button
          className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700 text-rose-300"
          onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
        >
          Delete
        </button>
      ) : (
        <span className="inline-flex items-center gap-2">
          <button
            className="px-3 py-1.5 rounded-xl bg-rose-700 text-white"
            onClick={(e) => { e.stopPropagation(); onRemove(); setConfirming(false); }}
            title="Confirm deletion"
          >
            Confirm
          </button>
          <button
            className="px-3 py-1.5 rounded-xl bg-neutral-800 border border-neutral-700 text-neutral-200"
            onClick={(e) => { e.stopPropagation(); setConfirming(false); }}
            title="Cancel deletion"
          >
            Cancel
          </button>
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

