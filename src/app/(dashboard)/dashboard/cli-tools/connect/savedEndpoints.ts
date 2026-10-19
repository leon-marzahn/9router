"use client";

import { useSyncExternalStore } from "react";

/**
 * Custom regent addresses the user saved, kept in this browser only (same
 * storage key the old tool cards used, so existing presets carry over).
 * Addresses only: no keys are stored here.
 */
export interface SavedEndpoint {
  name: string;
  baseUrl: string;
}

const KEY = "regent.cliToolEndpointPresets";
const LEGACY = "9router.cliToolEndpointPresets";
const EVENT = "regent:endpoint-presets-changed";
const strip = (u: string) => (u || "").replace(/\/+$/, "");

let cache: { raw: string | null; list: SavedEndpoint[] } = { raw: null, list: [] };

function read(): SavedEndpoint[] {
  try {
    const ls = window.localStorage;
    const legacy = ls.getItem(LEGACY);
    if (legacy !== null) {
      if (ls.getItem(KEY) === null) ls.setItem(KEY, legacy);
      ls.removeItem(LEGACY);
    }
    const raw = ls.getItem(KEY);
    if (raw === cache.raw) return cache.list;
    const parsed: unknown = JSON.parse(raw || "[]");
    const list = Array.isArray(parsed) ? (parsed as SavedEndpoint[]).filter((p) => p?.name && p?.baseUrl) : [];
    cache = { raw, list };
    return list;
  } catch {
    return cache.list;
  }
}

function write(list: SavedEndpoint[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: nothing is saved */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

const subscribe = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  window.addEventListener("storage", fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("storage", fn);
  };
};
const EMPTY: SavedEndpoint[] = [];

export function useSavedEndpoints() {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

/** Adds (or renames) an address; returns its name. */
export function saveEndpoint(url: string, name?: string): string | null {
  const baseUrl = strip(url.trim());
  if (!/^https?:\/\/\S+$/i.test(baseUrl)) return null;
  const list = read();
  const existing = list.find((p) => strip(p.baseUrl) === baseUrl);
  if (existing && !name) return existing.name;
  let fallback = baseUrl;
  try {
    fallback = new URL(baseUrl).host;
  } catch {
    /* keep the URL as the name */
  }
  const finalName = (name || fallback).trim();
  write([...list.filter((p) => p.name !== finalName && strip(p.baseUrl) !== baseUrl), { name: finalName, baseUrl }].sort((a, b) => a.name.localeCompare(b.name)));
  return finalName;
}

export function deleteEndpoint(name: string) {
  write(read().filter((p) => p.name !== name));
}
