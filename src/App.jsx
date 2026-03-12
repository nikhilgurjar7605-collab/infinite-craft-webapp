import { useState, useRef, useCallback, useEffect } from "react";

const BASE_ELEMENTS = [
  { id: "earth", name: "Earth", emoji: "🌍" },
  { id: "water", name: "Water", emoji: "💧" },
  { id: "fire", name: "Fire", emoji: "🔥" },
  { id: "wind", name: "Wind", emoji: "💨" },
];

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Telegram setup
try {
  if (window.Telegram?.WebApp) {
    window.Telegram.WebApp.ready();
    window.Telegram.WebApp.expand();
  }
} catch {}

function getTgUser() {
  try { return window.Telegram?.WebApp?.initDataUnsafe?.user || null; } catch { return null; }
}

// ── Supabase ──────────────────────────────────────────────
async function supabaseFetch(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...options.headers,
      },
    });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch { return null; }
}

async function getCachedCombo(a, b) {
  const [e1, e2] = [a, b].sort();
  const data = await supabaseFetch(
    `combinations?element1=eq.${encodeURIComponent(e1)}&element2=eq.${encodeURIComponent(e2)}&select=result,emoji`
  );
  return data?.[0] || null;
}

async function saveCachedCombo(a, b, result, emoji) {
  const [e1, e2] = [a, b].sort();
  await supabaseFetch("combinations", {
    method: "POST",
    body: JSON.stringify({ element1: e1, element2: e2, result, emoji }),
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
  });
}

async function saveUserDiscovery(userId, username, elementName) {
  await supabaseFetch("users", {
    method: "POST",
    body: JSON.stringify({ telegram_id: String(userId), username }),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
  await supabaseFetch("user_elements", {
    method: "POST",
    body: JSON.stringify({ telegram_id: String(userId), element_name: elementName }),
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
  });
  const existing = await supabaseFetch(
    `first_discoveries?element_name=eq.${encodeURIComponent(elementName)}&select=telegram_id`
  );
  if (!existing || existing.length === 0) {
    await supabaseFetch("first_discoveries", {
      method: "POST",
      body: JSON.stringify({ element_name: elementName, telegram_id: String(userId), username }),
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    });
    return true;
  }
  return false;
}

async function getLeaderboard() {
  const data = await supabaseFetch("user_elements?select=telegram_id,users(username)&limit=2000");
  if (!data) return [];
  const counts = {};
  data.forEach((r) => {
    const id = r.telegram_id;
    const uname = typeof r.users === "object" ? r.users?.username : "Unknown";
    if (!counts[id]) counts[id] = { username: uname || "Unknown", count: 0 };
    counts[id].count++;
  });
  return Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 10);
}

// ── Gemini AI ─────────────────────────────────────────────
async function combineWithGemini(elem1, elem2) {
  if (!GEMINI_API_KEY) throw new Error("No Gemini API key");
  
  const prompt = `You are the Infinite Craft game. Combine "${elem1}" + "${elem2}". Reply with ONLY valid JSON, no markdown, no explanation: {"result":"ElementName","emoji":"🔥"}`;
  
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 60 },
      }),
    }
  );
  
  if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
  
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  // Extract JSON from response robustly
  const match = text.match(/\{[^}]+\}/);
  if (!match) throw new Error("Bad Gemini response: " + text);
  const parsed = JSON.parse(match[0]);
  if (!parsed.result || !parsed.emoji) throw new Error("Missing fields");
  return parsed;
}

let idCounter = 100;

export default function App() {
  const [sidebar, setSidebar] = useState(() => {
    try {
      const s = localStorage.getItem("ic_sidebar");
      return s ? JSON.parse(s) : BASE_ELEMENTS;
    } catch { return BASE_ELEMENTS; }
  });
  const [canvasItems, setCanvasItems] = useState([]);
  const [combining, setCombining] = useState(false);
  const [toast, setToast] = useState(null);
  const [showLB, setShowLB] = useState(false);
  const [leaderboard, setLeaderboard] = useState([]);
  const [search, setSearch] = useState("");
  const [firstDiscs, setFirstDiscs] = useState(new Set());

  const dragging = useRef(null); // { type: "sidebar"|"canvas", elem?, instanceId?, ox, oy }
  const canvasRef = useRef(null);
  const tgUser = useRef(getTgUser());

  useEffect(() => {
    try { localStorage.setItem("ic_sidebar", JSON.stringify(sidebar)); } catch {}
  }, [sidebar]);

  const showToast = (msg, type = "info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const addToSidebar = useCallback((elem) => {
    setSidebar(prev => {
      if (prev.find(e => e.name.toLowerCase() === elem.name.toLowerCase())) return prev;
      return [...prev, elem];
    });
  }, []);

  const spawnItem = (elem, x, y) => {
    const id = ++idCounter;
    setCanvasItems(prev => [...prev, { ...elem, instanceId: id, x, y }]);
    return id;
  };

  // ── Drag from sidebar ──
  const onSidebarDragStart = (e, elem) => {
    dragging.current = { type: "sidebar", elem };
  };

  const onCanvasDragOver = (e) => e.preventDefault();

  const onCanvasDrop = (e) => {
    e.preventDefault();
    if (!dragging.current || dragging.current.type !== "sidebar") return;
    const rect = canvasRef.current.getBoundingClientRect();
    spawnItem(dragging.current.elem, e.clientX - rect.left - 45, e.clientY - rect.top - 18);
    dragging.current = null;
  };

  // ── Drag canvas items ──
  const onItemMouseDown = (e, instanceId) => {
    e.preventDefault();
    e.stopPropagation();
    const item = canvasItems.find(i => i.instanceId === instanceId);
    if (!item) return;
    const rect = canvasRef.current.getBoundingClientRect();
    dragging.current = {
      type: "canvas",
      instanceId,
      ox: e.clientX - rect.left - item.x,
      oy: e.clientY - rect.top - item.y,
    };
  };

  const onCanvasMouseMove = (e) => {
    if (!dragging.current || dragging.current.type !== "canvas") return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - dragging.current.ox;
    const y = e.clientY - rect.top - dragging.current.oy;
    setCanvasItems(prev =>
      prev.map(i => i.instanceId === dragging.current.instanceId ? { ...i, x, y } : i)
    );
  };

  const onCanvasMouseUp = async () => {
    if (!dragging.current || dragging.current.type !== "canvas") {
      dragging.current = null;
      return;
    }
    const draggedId = dragging.current.instanceId;
    dragging.current = null;
    if (combining) return;

    // Find overlap
    const items = canvasItems;
    const dragged = items.find(i => i.instanceId === draggedId);
    if (!dragged) return;

    const target = items.find(i =>
      i.instanceId !== draggedId &&
      Math.abs(i.x - dragged.x) < 100 &&
      Math.abs(i.y - dragged.y) < 60
    );
    if (!target) return;

    await doCombine(dragged, target);
  };

  const doCombine = async (dragged, target) => {
    setCombining(true);
    try {
      // Try cache first
      let result = await getCachedCombo(dragged.name, target.name);
      let isNew = false;

      if (!result) {
        const r = await combineWithGemini(dragged.name, target.name);
        result = r;
        isNew = true;
        await saveCachedCombo(dragged.name, target.name, result.result, result.emoji);
      }

      const newElem = {
        id: result.result.toLowerCase().replace(/\s+/g, "_") + "_" + Date.now(),
        name: result.result,
        emoji: result.emoji,
      };

      addToSidebar(newElem);

      setCanvasItems(prev => {
        const filtered = prev.filter(
          i => i.instanceId !== dragged.instanceId && i.instanceId !== target.instanceId
        );
        return [...filtered, {
          ...newElem,
          instanceId: ++idCounter,
          x: Math.round((dragged.x + target.x) / 2),
          y: Math.round((dragged.y + target.y) / 2),
        }];
      });

      // Save to Supabase if logged in via Telegram
      if (tgUser.current) {
        const firstEver = await saveUserDiscovery(
          tgUser.current.id,
          tgUser.current.username || tgUser.current.first_name,
          result.result
        );
        if (firstEver) {
          setFirstDiscs(prev => new Set([...prev, result.result]));
          showToast(`🌟 FIRST DISCOVERY! ${result.emoji} ${result.result}`, "first");
        } else {
          showToast(`${result.emoji} ${result.result}${isNew ? " ✨" : ""}`, isNew ? "new" : "info");
        }
      } else {
        showToast(`${result.emoji} ${result.result}`, isNew ? "new" : "info");
      }
    } catch (err) {
      console.error("Combine error:", err);
      showToast("⚠️ " + (err.message || "Combination failed"), "error");
    }
    setCombining(false);
  };

  const loadLeaderboard = async () => {
    setShowLB(true);
    const data = await getLeaderboard();
    setLeaderboard(data);
  };

  const clearCanvas = () => setCanvasItems([]);

  const resetGame = () => {
    if (!confirm("Reset all progress?")) return;
    setSidebar(BASE_ELEMENTS);
    setCanvasItems([]);
    setFirstDiscs(new Set());
    localStorage.removeItem("ic_sidebar");
  };

  const filtered = sidebar.filter(e =>
    e.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="app">
      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}

      <header className="hdr">
        <div className="hdr-logo">
          <span className="hdr-inf">∞</span>
          <span className="hdr-title">Infinite Craft</span>
        </div>
        <div className="hdr-right">
          {combining && <span className="mixing-badge">⚗️</span>}
          <button className="hdr-btn" onClick={loadLeaderboard} title="Leaderboard">🏆</button>
          <button className="hdr-btn" onClick={clearCanvas} title="Clear canvas">🗑️</button>
          {tgUser.current && (
            <span className="tg-user">@{tgUser.current.username || tgUser.current.first_name}</span>
          )}
        </div>
      </header>

      <div className="layout">
        {/* Canvas */}
        <div
          className="canvas"
          ref={canvasRef}
          onDragOver={onCanvasDragOver}
          onDrop={onCanvasDrop}
          onMouseMove={onCanvasMouseMove}
          onMouseUp={onCanvasMouseUp}
          onMouseLeave={() => { if (dragging.current?.type === "canvas") dragging.current = null; }}
        >
          {canvasItems.length === 0 && (
            <div className="canvas-hint">
              <div className="canvas-hint-icon">⚗️</div>
              <p>Drag elements here</p>
              <p className="canvas-hint-sub">Drop two on top of each other to combine</p>
            </div>
          )}
          {canvasItems.map(item => (
            <div
              key={item.instanceId}
              className="c-item"
              style={{ left: item.x, top: item.y }}
              onMouseDown={e => onItemMouseDown(e, item.instanceId)}
            >
              <span className="c-emoji">{item.emoji}</span>
              <span className="c-name">{item.name}</span>
            </div>
          ))}
        </div>

        {/* Sidebar */}
        <aside className="sidebar">
          <div className="sb-top">
            <input
              className="sb-search"
              placeholder="Search elements…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <div className="sb-meta">
              <span>{sidebar.length} elements</span>
            </div>
          </div>

          <div className="sb-list">
            {filtered.map(elem => (
              <div
                key={elem.id}
                className={`chip ${firstDiscs.has(elem.name) ? "chip-first" : ""}`}
                draggable
                onDragStart={e => onSidebarDragStart(e, elem)}
                onDoubleClick={() => {
                  const rect = canvasRef.current?.getBoundingClientRect();
                  if (rect) spawnItem(elem, 60 + Math.random() * (rect.width - 180), 60 + Math.random() * (rect.height - 120));
                }}
                title="Drag to canvas or double-click"
              >
                <span className="chip-em">{elem.emoji}</span>
                <span className="chip-name">{elem.name}</span>
                {firstDiscs.has(elem.name) && <span className="chip-star">★</span>}
              </div>
            ))}
          </div>

          <button className="reset-btn" onClick={resetGame}>↺ Reset Game</button>
        </aside>
      </div>

      {/* Leaderboard modal */}
      {showLB && (
        <div className="overlay" onClick={() => setShowLB(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h2>🏆 Leaderboard</h2>
              <button className="close-btn" onClick={() => setShowLB(false)}>✕</button>
            </div>
            {leaderboard.length === 0
              ? <div className="lb-empty">No players yet — be the first!</div>
              : <div className="lb-list">
                  {leaderboard.map((e, i) => (
                    <div key={i} className={`lb-row ${i < 3 ? `lb-top${i}` : ""}`}>
                      <span className="lb-pos">{["🥇","🥈","🥉"][i] ?? `#${i+1}`}</span>
                      <span className="lb-user">@{e.username}</span>
                      <span className="lb-cnt">{e.count} 🧪</span>
                    </div>
                  ))}
                </div>
            }
          </div>
        </div>
      )}
    </div>
  );
}
