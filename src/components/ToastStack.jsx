import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { onToastsChange, dismiss } from "../lib/toast";

const KIND_STYLE = {
  error: { bg: "#3A2226", border: "#FF7A85", icon: AlertCircle, iconColor: "#FF7A85" },
  success: { bg: "#16332B", border: "#2BE6A8", icon: CheckCircle2, iconColor: "#2BE6A8" },
  info: { bg: "#1E2A3D", border: "#8B93C9", icon: Info, iconColor: "#8B93C9" },
};

export default function ToastStack() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => onToastsChange(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 84px)",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        width: "min(92vw, 420px)",
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => {
        const style = KIND_STYLE[t.kind] || KIND_STYLE.info;
        const Icon = style.icon;
        return (
          <div
            key={t.id}
            role="status"
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              background: style.bg,
              border: `1px solid ${style.border}`,
              borderRadius: 12,
              padding: "12px 14px",
              boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
              color: "#F3F5F9",
              fontSize: 13.5,
              lineHeight: 1.4,
              animation: "forge-toast-in 0.18s ease-out",
            }}
          >
            <Icon size={17} color={style.iconColor} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1 }}>{t.message}</div>
            {t.action && (
              <button
                onClick={() => { t.action.onClick(); dismiss(t.id); }}
                style={{
                  background: "none",
                  border: `1px solid ${style.border}`,
                  color: style.iconColor,
                  cursor: "pointer",
                  borderRadius: 7,
                  padding: "4px 10px",
                  fontSize: 12.5,
                  fontWeight: 700,
                  flexShrink: 0,
                  marginTop: -1,
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              style={{
                background: "none",
                border: "none",
                color: "#9CA1B5",
                cursor: "pointer",
                padding: 4,
                marginTop: -2,
                marginRight: -4,
                flexShrink: 0,
              }}
            >
              <X size={15} />
            </button>
          </div>
        );
      })}
      <style>{`
        @keyframes forge-toast-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
