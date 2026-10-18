"use client";

import { useEffect, useState } from "react";
import useSettingsStore from "@/store/settingsStore";

export interface AuthInfo {
  displayName: string;
  loginMethod: string;
}

/** Settings flags + auth identity the frame needs. Fetched once per mount. */
export function useFrameData() {
  const [flags, setFlags] = useState<{ enableTranslator?: boolean }>({});
  const [auth, setAuth] = useState<AuthInfo>({ displayName: "", loginMethod: "" });

  useEffect(() => {
    let cancelled = false;
    (useSettingsStore as any)
      .getState()
      .fetchSettings()
      .then((data: any) => {
        if (!cancelled && data) setFlags({ enableTranslator: !!data.enableTranslator });
      });
    fetch("/api/auth/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setAuth({
          displayName:
            d.displayName || d.samlName || d.samlEmail || d.oidcName || d.oidcEmail || "",
          loginMethod: d.loginMethod || "",
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return { flags, auth };
}

export async function logout() {
  try {
    const res = await fetch("/api/auth/logout", { method: "POST" });
    if (res.ok) window.location.assign("/login");
  } catch (err) {
    console.error("Failed to logout:", err);
  }
}
