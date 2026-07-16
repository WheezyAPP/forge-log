import { useState, useEffect, useRef, useCallback } from "react";
import {
  Search, ScanLine, X, Plus, Clock, ChevronRight,
  Loader, AlertCircle, Check, Scale, ArrowLeft, Users,
} from "lucide-react";
import { searchCommunityFoods, lookupCommunityFoodByBarcode, bumpCommunityFoodUseCount } from "../lib/storage";

/* ─── Design tokens (match main app) ───────────────────────────── */
const C = {
  bg:        "#1C1E26",
  surface:   "#262933",
  raised:    "#30343E",
  border:    "#40465A",
  borderHi:  "#565B72",
  cream:     "#F3F5F9",
  creamDim:  "#9CA1B5",
  creamFaint:"#767C90",
  ember:     "#4FADFF",
  emberDim:  "rgba(79,173,255,.14)",
  mint:      "#2BE6A8",
  mintDim:   "rgba(43,230,168,.14)",
  amber:     "#8B93C9",
  amberDim:  "rgba(139,147,201,.14)",
  blue:      "#8B93C9",
};

const fmt = (n, d = 0) =>
  isNaN(n) || n == null ? "0" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

/* ─── Recent foods (localStorage) ──────────────────────────────── */
const RECENT_KEY = "forge_recent_foods";
const MAX_RECENT = 20;

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); }
  catch { return []; }
}
function saveRecent(food) {
  try {
    const existing = loadRecent().filter(f => f.id !== food.id);
    localStorage.setItem(RECENT_KEY, JSON.stringify([food, ...existing].slice(0, MAX_RECENT)));
  } catch {}
}

/* ─── API: USDA FoodData Central ─────────────────────────────────
   This is now the SOLE food database — no Open Food Facts fallback.
   USDA FDC is the authoritative US source: ~600k branded + generic
   foods with manufacturer-submitted nutrition labels and UPC data.  */

function hasUsdaKey() {
  return !!import.meta.env.VITE_USDA_API_KEY;
}

async function searchUSDA(query, signal) {
  const key = import.meta.env.VITE_USDA_API_KEY;
  if (!key) return [];

  const r = await fetch(
    `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&api_key=${key}&pageSize=12&dataType=Branded,SR%20Legacy,Foundation`,
    { signal }
  );
  const data = await r.json();

  return (data.foods || [])
    .filter(f => f.description && findNutrientVal(f, "Energy") > 0)
    .slice(0, 12)
    .map(normalizeUSDA);
}

function findNutrientVal(food, name) {
  const match = (food.foodNutrients || []).find(n =>
    n.nutrientName?.toLowerCase().includes(name.toLowerCase())
  );
  return match ? parseFloat(match.value) || 0 : 0;
}

function normalizeUSDA(f) {
  return {
    id:           `usda:${f.fdcId}`,
    name:         f.description?.trim() || "Unknown",
    brand:        f.brandOwner || f.brandName || null,
    source:       "USDA",
    cal100:       Math.round(findNutrientVal(f, "Energy")),
    protein100:   Math.round(findNutrientVal(f, "Protein") * 10) / 10,
    carbs100:     Math.round(findNutrientVal(f, "Carbohydrate") * 10) / 10,
    fat100:       Math.round(findNutrientVal(f, "Total lipid") * 10) / 10,
    servingG:     Math.round(parseFloat(f.servingSize) || 100),
    servingLabel: f.servingSize ? `${f.servingSize} ${f.servingSizeUnit || "g"}` : "100 g",
    image:        null,
    gtinUpc:      f.gtinUpc || null,
  };
}

// USDA's Branded Foods dataset carries the real UPC/GTIN submitted by the
// manufacturer to the FDA — the search endpoint indexes that field, so a
// barcode number works as a query.
async function lookupBarcodeUSDA(barcode, signal) {
  const key = import.meta.env.VITE_USDA_API_KEY;
  if (!key) return null;

  const r = await fetch(
    `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(barcode)}&api_key=${key}&pageSize=5&dataType=Branded`,
    { signal }
  );
  const data = await r.json();
  const foods = data.foods || [];

  // Match the exact barcode against gtinUpc, tolerating a leading zero
  // difference between 12-digit UPC-A and 13-digit EAN-13 encodings.
  const stripLeadingZero = (s) => (s || "").replace(/^0+/, "");
  const target = stripLeadingZero(barcode);
  const exact = foods.find(f => stripLeadingZero(f.gtinUpc) === target);
  const match = exact || foods[0];

  if (match && findNutrientVal(match, "Energy") > 0) {
    return normalizeUSDA(match);
  }
  return null;
}

/* ─── Scale nutritional values to a given gram amount ───────────── */
function scaleFood(food, grams) {
  const k = grams / 100;
  return {
    calories: Math.round(food.cal100 * k),
    protein:  Math.round(food.protein100 * k * 10) / 10,
    carbs:    Math.round(food.carbs100   * k * 10) / 10,
    fat:      Math.round(food.fat100     * k * 10) / 10,
  };
}

/* ─── Barcode Scanner overlay ───────────────────────────────────── */
function BarcodeScanner({ onScan, onClose }) {
  const videoRef    = useRef(null);
  const controlsRef = useRef(null);
  const [error, setError]     = useState(null);
  const [ready, setReady]     = useState(false);
  const [detected, setDetected] = useState(null);

  useEffect(() => {
    let stopped = false;

    (async () => {
      try {
        // Dynamic import so the build doesn't fail if zxing has side-effects
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader   = new BrowserMultiFormatReader();

        // Prefer rear-facing / environment camera
        const devices  = await BrowserMultiFormatReader.listVideoInputDevices();
        const rearCam  = devices.find(d =>
          /back|rear|environment/i.test(d.label)
        ) || devices[0];

        if (!rearCam) { setError("No camera found on this device."); return; }

        setReady(true);

        controlsRef.current = await reader.decodeFromVideoDevice(
          rearCam.deviceId,
          videoRef.current,
          (result, err) => {
            if (stopped || !result) return;
            const text = result.getText();
            if (/^\d{8,14}$/.test(text)) {
              setDetected(text);
              stopped = true;
              controlsRef.current?.stop?.();
              setTimeout(() => onScan(text), 400);
            }
          }
        );
      } catch (e) {
        if (!stopped) {
          setError(
            e?.name === "NotAllowedError"
              ? "Camera permission denied. Please allow camera access and try again."
              : `Camera error: ${e?.message || "unknown"}`
          );
        }
      }
    })();

    return () => {
      stopped = true;
      try { controlsRef.current?.stop?.(); } catch {}
    };
  }, [onScan]);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.94)",
      zIndex: 1100, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: C.cream, display: "flex", alignItems: "center", gap: 8 }}>
            <ScanLine size={18} color={C.ember} /> Scan Barcode
          </div>
          <button onClick={onClose} style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: 8, color: C.creamDim, padding: "6px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            <X size={13} /> Cancel
          </button>
        </div>

        {/* Camera viewport */}
        <div style={{ position: "relative", background: "#000", borderRadius: 14, overflow: "hidden", aspectRatio: "4/3" }}>
          <video ref={videoRef} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} muted playsInline />

          {/* Scan target overlay */}
          {!error && !detected && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ width: 220, height: 120, border: `2px solid ${C.ember}`, borderRadius: 10, position: "relative" }}>
                {/* Corner highlights */}
                {[["0 auto auto 0","top left"],["0 0 auto auto","top right"],["auto auto 0 0","bottom left"],["auto 0 0 auto","bottom right"]].map(([inset, key]) => (
                  <div key={key} style={{ position: "absolute", inset, width: 16, height: 16, borderTop: key.includes("top") ? `3px solid ${C.ember}` : "none", borderBottom: key.includes("bottom") ? `3px solid ${C.ember}` : "none", borderLeft: key.includes("left") ? `3px solid ${C.ember}` : "none", borderRight: key.includes("right") ? `3px solid ${C.ember}` : "none" }} />
                ))}
                {/* Scan line animation */}
                <div style={{ position: "absolute", top: "50%", left: 4, right: 4, height: 1, background: `${C.ember}90`, boxShadow: `0 0 6px ${C.ember}` }} />
              </div>
            </div>
          )}

          {/* Loading state */}
          {!ready && !error && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, background: "rgba(0,0,0,0.6)" }}>
              <Loader size={24} color={C.ember} style={{ animation: "spin 1s linear infinite" }} />
              <div style={{ fontSize: 13, color: C.creamDim }}>Starting camera…</div>
            </div>
          )}

          {/* Detected */}
          {detected && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: `${C.mint}20` }}>
              <Check size={40} color={C.mint} />
              <div style={{ fontSize: 14, color: C.mint, marginTop: 8 }}>Barcode detected!</div>
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div style={{ marginTop: 14, background: "rgba(232,112,112,.14)", border: "1px solid rgba(232,112,112,.3)", borderRadius: 10, padding: "12px 14px", display: "flex", gap: 10, alignItems: "flex-start" }}>
            <AlertCircle size={16} color="#FF7A85" style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 13, color: "#FF7A85", lineHeight: 1.5 }}>{error}</div>
          </div>
        )}

        {/* Hint */}
        {!error && (
          <div style={{ textAlign: "center", marginTop: 14, fontSize: 12, color: C.creamDim, lineHeight: 1.5 }}>
            Point the camera at a product barcode — EAN-13, UPC-A, and UPC-E all work.
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ─── Serving size picker (shown after food is selected) ──────────── */
function ServingPicker({ food, onConfirm, onBack }) {
  const [grams, setGrams] = useState(String(food.servingG || 100));
  const g = Math.max(1, parseFloat(grams) || 1);
  const scaled = scaleFood(food, g);
  const isCommunity = food.source === "Community";

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: C.creamDim, cursor: "pointer", padding: "2px 4px", display: "flex", alignItems: "center" }}>
          <ArrowLeft size={16} />
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.cream }}>{food.name}</div>
          {food.brand && <div style={{ fontSize: 11, color: C.creamDim }}>{food.brand}</div>}
        </div>
        <div style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: isCommunity ? C.mintDim : C.emberDim, color: isCommunity ? C.mint : C.ember, textTransform: "uppercase", letterSpacing: ".05em" }}>
          {isCommunity ? "Community" : "USDA"}
        </div>
      </div>

      {/* Serving size input */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <Scale size={14} color={C.ember} />
        <span style={{ fontSize: 12, color: C.creamDim }}>Serving size:</span>
        <input
          type="number" inputMode="decimal"
          min="1"
          style={{ width: 80, background: C.raised, border: `1px solid ${C.borderHi}`, borderRadius: 6, color: C.cream, fontSize: 14, fontWeight: 600, padding: "5px 8px", outline: "none", textAlign: "center" }}
          value={grams}
          onChange={e => setGrams(e.target.value)}
          onFocus={e => e.target.select()}
          autoFocus
        />
        <span style={{ fontSize: 12, color: C.creamDim }}>g</span>
        {food.servingG !== 100 && (
          <button
            onClick={() => setGrams(String(food.servingG))}
            style={{ fontSize: 11, color: C.creamDim, background: C.raised, border: `1px solid ${C.border}`, borderRadius: 5, padding: "3px 8px", cursor: "pointer" }}
          >
            1 serving ({food.servingG}g)
          </button>
        )}
        <button
          onClick={() => setGrams("100")}
          style={{ fontSize: 11, color: C.creamDim, background: C.raised, border: `1px solid ${C.border}`, borderRadius: 5, padding: "3px 8px", cursor: "pointer" }}
        >
          100g
        </button>
      </div>

      {/* Live nutrition preview */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
        {[
          ["Calories", scaled.calories, C.ember, ""],
          ["Protein",  scaled.protein,  C.mint,  "g"],
          ["Carbs",    scaled.carbs,    C.amber, "g"],
          ["Fat",      scaled.fat,      C.blue,  "g"],
        ].map(([label, val, color, unit]) => (
          <div key={label} style={{ background: C.raised, borderRadius: 8, padding: "8px 10px", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: C.creamDim, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color }}>{fmt(val)}{unit}</div>
          </div>
        ))}
      </div>

      <button
        onClick={() => { saveRecent(food); if (isCommunity && food.rowId) bumpCommunityFoodUseCount(food.rowId); onConfirm({ food, grams: g, ...scaled }); }}
        style={{ width: "100%", background: C.ember, color: "#1a0e08", border: "none", borderRadius: 8, padding: "10px 0", fontWeight: 700, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
      >
        <Plus size={16} /> Add to Food Log
      </button>
    </div>
  );
}

/* ─── Single food result row ──────────────────────────────────────── */
function FoodRow({ food, onSelect }) {
  const isCommunity = food.source === "Community";
  return (
    <div
      onClick={() => onSelect(food)}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", cursor: "pointer", borderBottom: `1px solid ${C.border}`, transition: "background .1s" }}
      onMouseEnter={e => e.currentTarget.style.background = C.raised}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.cream, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{food.name}</div>
        <div style={{ fontSize: 11, color: C.creamDim }}>
          {food.brand ? `${food.brand} · ` : ""}
          <span style={{ fontFamily: "monospace" }}>{fmt(food.cal100)} cal</span>
          {" · "}
          <span style={{ color: C.mint }}>{fmt(food.protein100)}g pro</span>
          {" · "}
          <span style={{ color: C.amber }}>{fmt(food.carbs100)}g carb</span>
          {" per 100g"}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 4, background: isCommunity ? C.mintDim : C.emberDim, color: isCommunity ? C.mint : C.ember, textTransform: "uppercase", letterSpacing: ".05em" }}>
          {isCommunity ? "Community" : "USDA"}
        </div>
        <ChevronRight size={14} color={C.creamFaint} />
      </div>
    </div>
  );
}

/* ─── Main FoodSearch component ───────────────────────────────────── */
export default function FoodSearch({ onFoodAdded }) {
  const [query,        setQuery]        = useState("");
  const [results,      setResults]      = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState(null);
  const [selected,     setSelected]     = useState(null);   // food picked, awaiting serving
  const [scanning,     setScanning]     = useState(false);
  const [barcodeMsg,   setBarcodeMsg]   = useState(null);   // e.g. "product not found"
  const [recent,       setRecentState]  = useState(() => loadRecent());
  const abortRef = useRef(null);

  /* Debounced search */
  useEffect(() => {
    if (!query.trim()) { setResults([]); setError(null); return; }
    const timer = setTimeout(() => runSearch(query), 380);
    return () => clearTimeout(timer);
  }, [query]);

  async function runSearch(q) {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const [communityRes, usdaRes] = await Promise.all([
        searchCommunityFoods(q).catch(() => []),
        hasUsdaKey() ? searchUSDA(q, ctrl.signal) : Promise.resolve([]),
      ]);
      if (ctrl.signal.aborted) return;
      // Community results first — a specific contributed food is usually
      // a more precise match for what someone actually eats than a
      // generic branded item, and surfacing them helps the database grow.
      setResults([...communityRes, ...usdaRes]);
    } catch (e) {
      if (e?.name !== "AbortError") setError("Search failed — check your connection.");
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }

  const handleScan = useCallback(async (barcode) => {
    setScanning(false);
    setLoading(true);
    setBarcodeMsg(null);
    try {
      const usdaFood = hasUsdaKey() ? await lookupBarcodeUSDA(barcode) : null;
      if (usdaFood) {
        setSelected(usdaFood);
        return;
      }
      const communityFood = await lookupCommunityFoodByBarcode(barcode);
      if (communityFood) {
        setSelected(communityFood);
        return;
      }
      setBarcodeMsg(`No product found for barcode ${barcode}. Try searching by name, or add it yourself from the Food Log so it's there next time.`);
    } catch {
      setBarcodeMsg("Barcode lookup failed — check your connection.");
    } finally {
      setLoading(false);
    }
  }, []);

  function handleFoodSelected(food) {
    setSelected(food);
    setResults([]);
    setQuery("");
  }

  function handleServingConfirmed({ food, grams, calories, protein, carbs, fat }) {
    const label = food.brand ? `${food.name} (${food.brand})` : food.name;
    onFoodAdded({ label, calories, protein, carbs, fat });
    setSelected(null);
    setRecentState(loadRecent());
  }

  const showRecent  = !query.trim() && !selected && recent.length > 0;
  const showResults = !selected && (results.length > 0 || loading || error || barcodeMsg);

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Scanner overlay */}
      {scanning && (
        <BarcodeScanner
          onScan={handleScan}
          onClose={() => setScanning(false)}
        />
      )}

      {/* Search bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: barcodeMsg ? 8 : 0 }}>
        <div style={{ flex: 1, position: "relative" }}>
          <Search size={15} color={C.creamFaint} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
          <input
            type="text"
            className="ft-input"
            placeholder="Search food by name… (e.g. chicken breast, greek yogurt)"
            value={query}
            onChange={e => { setQuery(e.target.value); setSelected(null); setBarcodeMsg(null); }}
            style={{ paddingLeft: 32, fontSize: 14 }}
          />
          {(query || loading) && (
            <button
              onClick={() => { setQuery(""); setResults([]); setError(null); abortRef.current?.abort(); }}
              style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: C.creamFaint, display: "flex" }}
            >
              {loading ? <Loader size={15} style={{ animation: "spin 1s linear infinite" }} /> : <X size={15} />}
            </button>
          )}
        </div>
        <button
          className="ft-btn ft-btn-ghost"
          onClick={() => { setScanning(true); setBarcodeMsg(null); }}
          style={{ display: "flex", alignItems: "center", gap: 5, padding: "0 14px", whiteSpace: "nowrap", border: `1px solid ${C.borderHi}` }}
          title="Scan a product barcode"
        >
          <ScanLine size={16} color={C.ember} /> Scan
        </button>
      </div>

      {/* Barcode error message */}
      {barcodeMsg && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#FF7A85", display: "flex", gap: 6, alignItems: "flex-start" }}>
          <AlertCircle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
          {barcodeMsg}
        </div>
      )}

      {/* Serving picker after a food is selected */}
      {selected && (
        <div style={{ marginTop: 10 }}>
          <ServingPicker
            food={selected}
            onConfirm={handleServingConfirmed}
            onBack={() => setSelected(null)}
          />
        </div>
      )}

      {/* Search results */}
      {showResults && !selected && (
        <div style={{ marginTop: 8, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          {error && (
            <div style={{ padding: "12px 14px", fontSize: 12, color: "#FF7A85", display: "flex", gap: 6 }}>
              <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              {error}
            </div>
          )}
          {!hasUsdaKey() && !error && (
            <div style={{ padding: "8px 14px", fontSize: 11, color: C.creamDim, borderBottom: results.length ? `1px solid ${C.border}` : "none" }}>
              USDA database not configured (missing VITE_USDA_API_KEY) — showing community-contributed foods only.
            </div>
          )}
          {!error && results.length === 0 && !loading && query.trim() && (
            <div style={{ padding: "14px", fontSize: 13, color: C.creamDim, textAlign: "center" }}>
              No results for "{query}" — try a different name or scan the barcode.
            </div>
          )}
          {results.map(f => <FoodRow key={f.id} food={f} onSelect={handleFoodSelected} />)}
        </div>
      )}

      {/* Recent foods */}
      {showRecent && !selected && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, color: C.creamFaint, letterSpacing: ".08em", textTransform: "uppercase", fontWeight: 700, marginBottom: 6, display: "flex", alignItems: "center", gap: 5 }}>
            <Clock size={11} /> Recently added
          </div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
            {recent.slice(0, 6).map(f => <FoodRow key={f.id} food={f} onSelect={handleFoodSelected} />)}
          </div>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
