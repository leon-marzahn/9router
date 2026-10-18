"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Slots {
  center: HTMLElement | null;
  actions: HTMLElement | null;
  setCenter: (el: HTMLElement | null) => void;
  setActions: (el: HTMLElement | null) => void;
}

const SlotsContext = createContext<Slots | null>(null);

export function FrameSlotsProvider({ children }: { children: ReactNode }) {
  const [center, setCenter] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  return (
    <SlotsContext.Provider value={{ center, actions, setCenter, setActions }}>
      {children}
    </SlotsContext.Provider>
  );
}

export function useFrameSlots() {
  const ctx = useContext(SlotsContext);
  if (!ctx) throw new Error("useFrameSlots must be used inside <AppFrame>");
  return ctx;
}

/** Render page content (e.g. a KPI strip) in the top bar, next to the title. */
export function TopBarContent({ children }: { children: ReactNode }) {
  const { center } = useFrameSlots();
  return center ? createPortal(children, center) : null;
}

/** Render page-level actions (buttons) at the right of the top bar. */
export function TopBarActions({ children }: { children: ReactNode }) {
  const { actions } = useFrameSlots();
  return actions ? createPortal(children, actions) : null;
}
