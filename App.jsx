import { useState, useRef, useEffect, useCallback } from "react";

const BASE_ELEMENTS = [
  { id: "earth", name: "Earth", emoji: "🌍" },
  { id: "water", name: "Water", emoji: "💧" },
  { id: "fire", name: "Fire", emoji: "🔥" },
  { id: "wind", name: "Wind", emoji: "💨" },
];

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

let tgUser = null;
if (typeof window !== "undefined" && window.Telegram?.WebApp?.initDataUnsafe?.user) {
  tgUser = window.Telegram.WebApp.initDataUnsafe.user;
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}

async function supabaseFetch(path, options = {}) {
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
    if (!res.ok) return null;
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
  const data = await supabaseFetch(
    "leaderboard_view?select=username,count&order=count.desc&limit=10"
  );
  return data || [];
}

async function combineWithGemini(elem1, elem2) {
  const prompt = `You are the Infinite Craft game engine. Two elements are being combined: "${elem1}" + "${elem2}". Return ONLY a valid JSON object with exactly two fields: "result" (the new element name, 1-3 words, creative but logical) and "emoji" (single most fitting emoji). Example: {"result":"Steam","emoji":"💨"}. No explanation, no markdown, only JSON.`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 80 },
      }),
    }
  );
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{"result":"Unknown","emoji":"❓"}';
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

let idCounter = 1000;

export default function App() {
  const [sidebar, setSidebar] = useState(() => {
    try {
      const saved = localStorage.getItem("ic_elements");
      return saved ? JSON.parse(saved) : BASE_ELEMENTS;
    } catch { return BASE_ELEMENTS; }
  });
  const [canvasItems, setCanvasItems] = useState([]);
  const [combining, setCombining] = useState(false);
  const [notification, setNotification] = useState(null);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [leaderboard, setLeaderboard] = useState([]);
  const [search, setSearch] = useState("");
  const [firstDiscoveries, setFirstDiscoveries] = useState(new Set());
  const [sortBy, setSortBy] = useState("discoveries");
  const dragItem = useRef(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const canvasRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem("ic_elements", JSON.stringify(sidebar)); } catch {}
  }, [sidebar]);

  const notify = (msg, type = "info") => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3000);
  };

  const addToSidebar = useCallback((elem) => {
    setSidebar((prev) => {
      if (prev.find((e) => e.name.toLowerCase() === elem.name.toLowerCase())) return prev;
      return [...prev, elem];
    });
  }, []);

  const spawnOnCanvas = (elem, x, y) => {
    setCanvasItems((prev) => [...prev, { ...elem, instanceId: ++idCounter, x, y }]);
  };

  const handleSidebarDragStart = (e, elem) => {
    dragItem.current = { type: "sidebar", elem };
  };

  const handleCanvasDrop = (e) => {
    e.preventDefault();
    if (!dragItem.current || dragItem.current.type !== "sidebar") return;
    const rect = canvasRef.current.getBoundingClientRect();
    spawnOnCanvas(dragItem.current.elem, e.clientX - rect.left - 40, e.clientY - rect.top - 20);
    dragItem.current = null;
  };

  const handleItemMouseDown = (e, instanceId) => {
    e.stopPropagation();
    const item = canvasItems.find((i) => i.instanceId === instanceId);
    if (!item) return;
    const rect = canvasRef.current.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left - item.x, y: e.clientY - rect.top - item.y };
    dragItem.current = { type: "canvas", instanceId };
  };

  const handleCanvasMouseMove = (e) => {
    if (!dragItem.current || dragItem.current.type !== "canvas") return;
    const rect = canvasRef.current.getBoundingClientRect();
    setCanvasItems((prev) =>
      prev.map((i) =>
        i.instanceId === dragItem.current.instanceId
          ? { ...i, x: e.clientX - rect.left - dragOffset.current.x, y: e.clientY - rect.top - dragOffset.current.y }
          : i
      )
    );
  };

  const handleCanvasMouseUp = async () => {
    if (!dragItem.current || dragItem.current.type !== "canvas") {
      dragItem.current = null;
      return;
    }
    const draggedId = dragItem.current.instanceId;
    dragItem.current = null;

    if (combining) return;
    setCanvasItems((prev) => {
      const dragged = prev.find((i) => i.instanceId === draggedId);
      if (!dragged) return prev;
      const target = prev.find(
        (i) => i.instanceId !== draggedId && Math.abs(i.x - dragged.x) < 90 && Math.abs(i.y - dragged.y) < 60
      );
      if (!target) return prev;
      // Trigger combine async
      triggerCombine(dragged, target);
      return prev;
    });
  };

  const triggerCombine = async (dragged, target) => {
    setCombining(true);
    try {
      let result = await getCachedCombo(dragged.name, target.name);
      let isNew = false;
      if (!result) {
        const geminiResult = await combineWithGemini(dragged.name, target.name);
        result = geminiResult;
        await saveCachedCombo(dragged.name, target.name, result.result, result.emoji);
        isNew = true;
      }
      const newElem = { id: result.result.toLowerCase().replace(/\s+/g, "_"), name: result.result, emoji: result.emoji };
      addToSidebar(newElem);
      setCanvasItems((prev) => {
        const filtered = prev.filter((i) => i.instanceId !== dragged.instanceId && i.instanceId !== target.instanceId);
        return [...filtered, { ...newElem, instanceId: ++idCounter, x: (dragged.x + target.x) / 2, y: (dragged.y + target.y) / 2 }];
      });
      if (tgUser) {
        const firstEver = await saveUserDiscovery(tgUser.id, tgUser.username || tgUser.first_name, result.result);
        if (firstEver) {
          setFirstDiscoveries((prev) => new Set([...prev, result.result]));
          notify(`🌟 FIRST DISCOVERY! ${result.emoji} ${result.result}`, "first");
        } else {
          notify(`${result.emoji} ${result.result}${isNew ? " (new combo!)" : ""}`, isNew ? "new" : "info");
        }
      } else {
        notify(`${result.emoji} ${result.result}`, isNew ? "new" : "info");
      }
    } catch (err) {
      notify("⚠️ Combination failed. Check API key.", "error");
    }
    setCombining(false);
  };

  const loadLeaderboard = async () => {
    setShowLeaderboard(true);
    const data = await getLeaderboard();
    setLeaderboard(data);
  };

  const clearCanvas = () => setCanvasItems([]);
  const resetGame = () => {
    setSidebar(BASE_ELEMENTS);
    setCanvasItems([]);
    setFirstDiscoveries(new Set());
    localStorage.removeItem("ic_elements");
  };

  const filtered = [...sidebar]
    .filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sortBy === "az" ? a.name.localeCompare(b.name) : 0);

  return (
    <div className="app">
      {notification && (
        <div className={`notification notif-${notification.type}`}>{notification.msg}</div>
      )}

      <header className="header">
        <div className="logo">
          <span className="logo-inf">∞</span>
          <span>Infinite Craft</span>
        </div>
        <div className="header-right">
          {combining && <span className="combining-pill">⚗️ Mixing…</span>}
          <button className="icon-btn" onClick={loadLeaderboard} title="Leaderboard">🏆</button>
          <button className="icon-btn" onClick={clearCanvas} title="Clear canvas">🗑️</button>
          {tgUser && (
            <span className="user-pill">@{tgUser.username || tgUser.first_name}</span>
          )}
        </div>
      </header>

      <div className="game-layout">
        <div
          ref={canvasRef}
          className="canvas"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleCanvasDrop}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={() => { dragItem.current = null; }}
        >
          {canvasItems.length === 0 && (
            <div className="canvas-empty">
              <div className="canvas-empty-icon">⚗️</div>
              <p>Drag elements here</p>
              <p className="canvas-empty-sub">Drop two on top of each other to combine</p>
            </div>
          )}
          {canvasItems.map((item) => (
            <div
              key={item.instanceId}
              className="canvas-item"
              style={{ left: item.x, top: item.y }}
              onMouseDown={(e) => handleItemMouseDown(e, item.instanceId)}
            >
              <span className="ci-emoji">{item.emoji}</span>
              <span className="ci-name">{item.name}</span>
            </div>
          ))}
        </div>

        <aside className="sidebar">
          <div className="sidebar-top">
            <input
              className="search-box"
              placeholder="Search elements…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="sidebar-meta">
              <span>{sidebar.length} elements</span>
              <button className="sort-btn" onClick={() => setSortBy(s => s === "az" ? "discoveries" : "az")}>
                {sortBy === "az" ? "A→Z" : "Latest"}
              </button>
            </div>
          </div>
          <div className="sidebar-list">
            {filtered.map((elem) => (
              <div
                key={elem.id}
                className={`elem-chip ${firstDiscoveries.has(elem.name) ? "elem-first" : ""}`}
                draggable
                onDragStart={(e) => handleSidebarDragStart(e, elem)}
                onDoubleClick={() => spawnOnCanvas(elem, 100 + Math.random() * 200, 80 + Math.random() * 150)}
                title="Double-click to place, drag to canvas"
              >
                <span className="chip-emoji">{elem.emoji}</span>
                <span className="chip-name">{elem.name}</span>
                {firstDiscoveries.has(elem.name) && <span className="chip-star">★</span>}
              </div>
            ))}
          </div>
          <button className="reset-btn" onClick={resetGame}>↺ Reset Game</button>
        </aside>
      </div>

      {showLeaderboard && (
        <div className="overlay" onClick={() => setShowLeaderboard(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>🏆 Leaderboard</h2>
              <button className="close-btn" onClick={() => setShowLeaderboard(false)}>✕</button>
            </div>
            {leaderboard.length === 0 ? (
              <div className="lb-empty">No data yet — play to appear here!</div>
            ) : (
              <div className="lb-list">
                {leaderboard.map((e, i) => (
                  <div key={i} className={`lb-row ${i < 3 ? `rank-${i}` : ""}`}>
                    <span className="lb-pos">{["🥇","🥈","🥉"][i] || `#${i+1}`}</span>
                    <span className="lb-user">@{e.username}</span>
                    <span className="lb-score">{e.count} 🧪</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
