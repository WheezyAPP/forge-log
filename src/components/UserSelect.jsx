import { useEffect, useRef, useState } from "react";
import { Flame, User, Plus, Pencil, Check, X, Camera, Loader } from "lucide-react";
import { fetchUsers, createUser, setCurrentUserId, renameUser, setUserAvatar } from "../lib/storage";

const COLORS = {
  bg: "#1C1E26",
  surface: "#262933",
  surfaceRaised: "#30343E",
  border: "#40465A",
  cream: "#F3F5F9",
  creamDim: "#9CA1B5",
  ember: "#4FADFF",       // primary accent — baby blue
  wisteria: "#8B93C9",    // secondary accent — soft slate periwinkle
  daemonette: "#565B72",  // muted tertiary
};

const AVATAR_PALETTE = [COLORS.ember, COLORS.wisteria, COLORS.daemonette, "#2BE6A8"];

function colorForName(name) {
  const sum = (name || "").split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  return AVATAR_PALETTE[sum % AVATAR_PALETTE.length];
}

// Resizes/crops any picked image down to a small square JPEG data URL —
// keeps the Supabase text column tiny (typically 5-15KB) with no need
// for a separate Storage bucket.
function resizeImageToDataUrl(file, size = 160, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        const scale = Math.max(size / img.width, size / img.height);
        const sw = size / scale;
        const sh = size / scale;
        const sx = (img.width - sw) / 2;
        const sy = (img.height - sh) / 2;
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Couldn't read that image."));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

// Circular avatar: shows the photo if set, otherwise a colored circle
// with the person's initial. Used both in the picker list and inline.
function Avatar({ name, avatarData, size = 40, color }) {
  const bg = color || colorForName(name);
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%", flexShrink: 0,
        background: avatarData ? "transparent" : bg,
        display: "flex", alignItems: "center", justifyContent: "center",
        overflow: "hidden", border: `1px solid ${COLORS.border}`,
      }}
    >
      {avatarData ? (
        <img src={avatarData} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <span style={{ fontSize: size * 0.42, fontWeight: 700, color: COLORS.bg }}>
          {(name || "?").trim().charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}

export default function UserSelect({ onSelect }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const [pendingAvatar, setPendingAvatar] = useState(null); // photo picked before the user exists yet
  const [uploadingId, setUploadingId] = useState(null);     // which existing user's avatar is mid-upload

  const newAvatarInputRef = useRef(null);
  const editAvatarInputRefs = useRef({});

  useEffect(() => {
    (async () => {
      const u = await fetchUsers();
      setUsers(u);
      setLoading(false);
    })();
  }, []);

  function choose(user) {
    setCurrentUserId(user.id);
    onSelect(user);
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError("");
    try {
      const user = await createUser(name);
      if (pendingAvatar) {
        try {
          await setUserAvatar(user.id, pendingAvatar);
          user.avatar_data = pendingAvatar;
        } catch {
          // Non-fatal — they can still add a photo later from the picker.
        }
      }
      choose(user);
    } catch (e) {
      setError("Couldn't create that user — check your Supabase connection.");
      setCreating(false);
    }
  }

  async function handleNewAvatarPick(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      setPendingAvatar(dataUrl);
    } catch {
      setError("Couldn't process that image — try a different photo.");
    }
  }

  async function handleExistingAvatarPick(userId, e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingId(userId);
    setError("");
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      await setUserAvatar(userId, dataUrl);
      setUsers((list) => list.map((u) => (u.id === userId ? { ...u, avatar_data: dataUrl } : u)));
    } catch {
      setError("Couldn't upload that photo — check your Supabase connection.");
    }
    setUploadingId(null);
  }

  function startEdit(u) {
    setEditingId(u.id);
    setEditDraft(u.name);
  }

  async function confirmEdit(id) {
    const trimmed = editDraft.trim();
    if (!trimmed) {
      setEditingId(null);
      return;
    }
    try {
      await renameUser(id, trimmed);
      setUsers((list) => list.map((u) => (u.id === id ? { ...u, name: trimmed } : u)));
    } catch (e) {
      setError("Couldn't rename that user — check your Supabase connection.");
    }
    setEditingId(null);
  }

  return (
    <div
      className="ft-app"
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: COLORS.bg,
        padding: 20,
      }}
    >
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "center", marginBottom: 28 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: COLORS.ember, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Flame size={20} color={COLORS.bg} />
          </div>
          <div className="ft-display" style={{ fontSize: 24, color: COLORS.cream }}>FORGE LOG</div>
        </div>

        <div
          style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 16,
            padding: 20,
          }}
        >
          <div className="ft-label" style={{ marginBottom: 14, color: COLORS.creamDim }}>Who's logging in?</div>

          {loading && <div style={{ color: COLORS.creamDim, fontSize: 13, padding: "10px 0" }}>Loading users…</div>}

          {!loading && users.length === 0 && (
            <div style={{ color: COLORS.creamDim, fontSize: 13, marginBottom: 14 }}>
              No users yet — add the first one below.
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
            {users.map((u) =>
              editingId === u.id ? (
                <div
                  key={u.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: COLORS.surfaceRaised,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 10,
                    padding: "6px 8px",
                  }}
                >
                  <input
                    className="ft-input"
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmEdit(u.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    style={{ flex: 1 }}
                  />
                  <button className="ft-btn ft-btn-ghost" style={{ padding: "6px 8px" }} onClick={() => confirmEdit(u.id)} title="Save">
                    <Check size={14} />
                  </button>
                  <button className="ft-btn ft-btn-ghost" style={{ padding: "6px 8px" }} onClick={() => setEditingId(null)} title="Cancel">
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <div
                  key={u.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    background: COLORS.surfaceRaised,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 10,
                    padding: "6px 8px 6px 8px",
                  }}
                >
                  {/* Avatar with an upload overlay */}
                  <div style={{ position: "relative", flexShrink: 0 }}>
                    <Avatar name={u.name} avatarData={u.avatar_data} size={38} color={colorForName(u.name)} />
                    <button
                      onClick={() => editAvatarInputRefs.current[u.id]?.click()}
                      title="Change photo"
                      style={{
                        position: "absolute", bottom: -2, right: -2, width: 17, height: 17,
                        borderRadius: "50%", background: COLORS.ember, border: `1.5px solid ${COLORS.surfaceRaised}`,
                        display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0,
                      }}
                    >
                      {uploadingId === u.id ? (
                        <Loader size={9} color={COLORS.bg} style={{ animation: "spin 1s linear infinite" }} />
                      ) : (
                        <Camera size={9} color={COLORS.bg} />
                      )}
                    </button>
                    <input
                      ref={(el) => (editAvatarInputRefs.current[u.id] = el)}
                      type="file"
                      accept="image/*"
                      style={{ display: "none" }}
                      onChange={(e) => handleExistingAvatarPick(u.id, e)}
                    />
                  </div>

                  <button
                    onClick={() => choose(u)}
                    style={{
                      flex: 1,
                      background: "transparent",
                      border: "none",
                      color: COLORS.cream,
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: "pointer",
                      textAlign: "left",
                      padding: "6px 0",
                    }}
                  >
                    {u.name}
                  </button>
                  <button
                    className="ft-btn ft-btn-ghost"
                    style={{ padding: "6px 8px" }}
                    onClick={() => startEdit(u)}
                    title="Rename this user"
                  >
                    <Pencil size={13} />
                  </button>
                </div>
              )
            )}
          </div>

          <div style={{ height: 1, background: COLORS.border, margin: "16px 0" }} />

          <div className="ft-label" style={{ marginBottom: 8, color: COLORS.creamDim }}>Add a new user</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* Pick a photo before the user exists — shown as a preview circle */}
            <div style={{ position: "relative", flexShrink: 0 }}>
              <div
                onClick={() => newAvatarInputRef.current?.click()}
                style={{
                  width: 38, height: 38, borderRadius: "50%", cursor: "pointer",
                  background: pendingAvatar ? "transparent" : COLORS.bg,
                  border: `1px dashed ${COLORS.border}`,
                  display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
                }}
                title="Add a profile picture"
              >
                {pendingAvatar ? (
                  <img src={pendingAvatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <Camera size={15} color={COLORS.creamDim} />
                )}
              </div>
              <input
                ref={newAvatarInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={handleNewAvatarPick}
              />
            </div>
            <input
              className="ft-input"
              placeholder="Name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              style={{ flex: 1 }}
            />
            <button
              className="ft-btn ft-btn-primary"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              style={{ opacity: creating || !newName.trim() ? 0.6 : 1 }}
            >
              <Plus size={14} /> Add
            </button>
          </div>
          {error && <div style={{ color: "#FF7A85", fontSize: 12, marginTop: 8 }}>{error}</div>}
        </div>

        <div style={{ textAlign: "center", marginTop: 14, fontSize: 11, color: COLORS.creamDim }}>
          Anyone with this link can pick any user — no passwords. Your device remembers your choice. Tap the pencil to rename, or the camera icon to add a photo.
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
