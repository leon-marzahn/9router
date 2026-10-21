"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import {
  STORAGE_KEYS,
  buildUserContent,
  cloneSession,
  createId,
  dedupeModels,
  fileToDataUrl,
  getProviderLabel,
  makeSessionTitle,
  newSession,
  isChatModel,
  isChatProvider,
  normalizeLiveModel,
  parseProviderModelsPayload,
  readAssistantText,
  safeParse,
  staticModelsFor,
  textValue,
  type Attachment,
  type ChatMessage,
  type ChatModel,
  type ChatSession,
  type Connection,
  type ProviderGroup,
} from "./chat";

function readStorage(key: string): string {
  if (typeof window === "undefined") return "";
  try {
    return globalThis.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

/** State and actions of the Basic Chat page (sessions live in localStorage). */
export function useChat() {
  const [providerGroups, setProviderGroups] = useState<ProviderGroup[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const saved = safeParse<unknown>(readStorage(STORAGE_KEYS.sessions) || null, []);
    return Array.isArray(saved)
      ? (saved as ChatSession[]).map((s) => ({
          ...s,
          messages: Array.isArray(s.messages) ? s.messages : [],
        }))
      : [];
  });
  const [activeSessionId, setActiveSessionId] = useState(() =>
    readStorage(STORAGE_KEYS.activeSessionId),
  );
  const [activeProviderId, setActiveProviderId] = useState(() =>
    readStorage(STORAGE_KEYS.activeProviderId),
  );
  const [activeModelId, setActiveModelId] = useState("");
  const [draft, setDraft] = useState(() => readStorage(STORAGE_KEYS.draft));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Once models are known, reopen the saved chat (or start one). Runs from the
    // load callback with the state restored from localStorage at mount.
    const initialize = (groups: ProviderGroup[]) => {
      if (groups.length === 0) return;
      const index = new Map(groups.flatMap((g) => g.models.map((m) => [m.id, m] as const)));
      const savedProvider = groups.find((g) => g.providerId === activeProviderId) || groups[0];
      const savedModel = savedProvider.models[0];
      if (sessions.length > 0) {
        const session = sessions.find((s) => s.id === activeSessionId) || sessions[0];
        const sessionModel = (session.modelId && index.get(session.modelId)) || savedModel;
        setActiveSessionId(session.id);
        setActiveProviderId(sessionModel.providerId || savedProvider.providerId);
        setActiveModelId(sessionModel.id);
        return;
      }
      const session = newSession(savedModel);
      setSessions([session]);
      setActiveSessionId(session.id);
      setActiveProviderId(savedProvider.providerId);
      setActiveModelId(savedModel.id);
    };

    async function loadData() {
      setLoadingData(true);
      setLoadError("");
      try {
        const providersRes = await fetch("/api/providers", { cache: "no-store" });
        const providersData = await providersRes.json().catch(() => ({}));
        const connections: Connection[] = Array.isArray(providersData.connections)
          ? providersData.connections.filter(
              (c: Connection) => c?.isActive !== false && isChatProvider(c.provider || c.id),
            )
          : [];

        if (connections.length === 0) {
          if (!cancelled) {
            setProviderGroups([]);
            setLoadError("No providers connected yet.");
          }
          return;
        }

        const providerMap = new Map<string, ProviderGroup>();
        for (const connection of connections) {
          const providerId = connection.provider || connection.id;
          const providerName = getProviderLabel(connection);
          const providerType = isOpenAICompatibleProvider(providerId)
            ? "openai-compatible"
            : isAnthropicCompatibleProvider(providerId)
              ? "anthropic-compatible"
              : providerId;

          let group = providerMap.get(providerId);
          if (!group) {
            group = { providerId, providerName, providerType, connections: [], models: [] };
            providerMap.set(providerId, group);
          }
          group.connections.push(connection);
          group.models.push(...staticModelsFor(providerId, connection));
        }

        const liveResults = await Promise.all(
          connections.map(async (connection) => {
            try {
              const response = await fetch(`/api/providers/${connection.id}/models`, {
                cache: "no-store",
              });
              const data = await response.json().catch(() => ({}));
              if (!response.ok) return { connection, models: [] };
              const models = parseProviderModelsPayload(data)
                .filter(isChatModel)
                .map((model) => normalizeLiveModel(model, connection))
                .filter((m): m is ChatModel => m !== null);
              return { connection, models };
            } catch {
              return { connection, models: [] };
            }
          }),
        );

        for (const result of liveResults) {
          const group = providerMap.get(result.connection.provider || result.connection.id);
          group?.models.push(...result.models);
        }

        const normalized = Array.from(providerMap.values())
          .map((group) => ({
            ...group,
            models: dedupeModels(group.models).sort((a, b) => a.name.localeCompare(b.name)),
          }))
          .filter((group) => group.models.length > 0)
          .sort((a, b) => a.providerName.localeCompare(b.providerName));

        if (!cancelled) {
          setProviderGroups(normalized);
          initialize(normalized);
          if (normalized.length === 0) setLoadError("Providers connected but no models available.");
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(textValue((error as Error)?.message) || "Failed to load providers/models.");
          setProviderGroups([]);
        }
      } finally {
        if (!cancelled) setLoadingData(false);
      }
    }

    void loadData();
    return () => {
      cancelled = true;
    };
    // Mount-only: `initialize` reads the state restored from localStorage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const modelIndex = useMemo(() => {
    const map = new Map<string, ChatModel>();
    for (const group of providerGroups) {
      for (const model of group.models) {
        map.set(model.id, {
          ...model,
          providerId: group.providerId,
          providerName: group.providerName,
        });
      }
    }
    return map;
  }, [providerGroups]);

  const activeProviderGroup = useMemo(
    () =>
      providerGroups.find((g) => g.providerId === activeProviderId) || providerGroups[0] || null,
    [providerGroups, activeProviderId],
  );

  const activeModel = useMemo<ChatModel | null>(() => {
    if (activeModelId && modelIndex.has(activeModelId)) return modelIndex.get(activeModelId)!;
    if (activeSessionId) {
      const session = sessions.find((s) => s.id === activeSessionId);
      if (session?.modelId && modelIndex.has(session.modelId))
        return modelIndex.get(session.modelId)!;
    }
    return activeProviderGroup?.models?.[0] || null;
  }, [activeModelId, modelIndex, activeProviderGroup, sessions, activeSessionId]);

  const currentSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || null,
    [sessions, activeSessionId],
  );
  const sessionItems = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [sessions],
  );
  const canSend =
    !isSending && !!activeModel && (draft.trim().length > 0 || attachments.length > 0);

  useEffect(() => {
    try {
      globalThis.localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(sessions));
      globalThis.localStorage.setItem(STORAGE_KEYS.activeSessionId, activeSessionId);
      globalThis.localStorage.setItem(STORAGE_KEYS.activeProviderId, activeProviderId);
      globalThis.localStorage.setItem(STORAGE_KEYS.draft, draft);
    } catch {
      // Ignore storage errors.
    }
  }, [sessions, activeSessionId, activeProviderId, draft]);

  const updateSession = (sessionId: string, updater: (s: ChatSession) => ChatSession) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? updater(cloneSession(s)) : s)));
  };

  const setAssistant = (
    sessionId: string,
    messageId: string,
    patch: (m: ChatMessage) => Partial<ChatMessage>,
  ) =>
    updateSession(sessionId, (s) => ({
      ...s,
      messages: s.messages.map((m) => (m.id === messageId ? { ...m, ...patch(m) } : m)),
      updatedAt: new Date().toISOString(),
    }));

  const newChat = () => {
    if (!activeModel) return;
    const session = newSession(activeModel);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setActiveProviderId(session.providerId);
    setActiveModelId(session.modelId);
    setDraft("");
    setAttachments([]);
    setStreamingMessageId("");
  };

  const selectSession = (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    setActiveSessionId(sessionId);
    setActiveProviderId(session.providerId || activeProviderId);
    setActiveModelId(session.modelId || activeModelId);
  };

  const deleteChat = (sessionId: string) => {
    const nextSessions = sessions.filter((s) => s.id !== sessionId);
    setSessions(nextSessions);
    if (sessionId !== activeSessionId) return;
    const fallback = nextSessions[0] || null;
    setActiveSessionId(fallback?.id ?? "");
    setActiveProviderId(fallback?.providerId ?? "");
    setActiveModelId(fallback?.modelId ?? "");
  };

  /** Switch the model; a chat that already has messages forks into a new chat. */
  const selectModel = (modelId: string) => {
    const model = modelIndex.get(modelId);
    if (!model) return;
    const current = sessions.find((s) => s.id === activeSessionId);
    if (current && current.messages.length === 0) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === current.id
            ? {
                ...s,
                providerId: model.providerId,
                providerName: model.providerName,
                modelId: model.id,
                modelName: model.name,
              }
            : s,
        ),
      );
    } else {
      const session = newSession(model);
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
    }
    setActiveProviderId(model.providerId);
    setActiveModelId(model.id);
  };

  const attachFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const images = Array.from(input.files || []).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) {
      input.value = "";
      return;
    }
    const converted = await Promise.all(
      images.map(async (file) => ({
        id: createId(),
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: await fileToDataUrl(file),
      })),
    );
    setAttachments((prev) => [...prev, ...converted]);
    input.value = "";
  };

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));

  const stop = () => abortRef.current?.abort();

  const send = async () => {
    const model = activeModel || activeProviderGroup?.models?.[0] || null;
    if (!model) return;
    const userText = draft.trim();
    if (!userText && attachments.length === 0) return;

    let sessionId = activeSessionId;
    let session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      const created = newSession(model);
      session = created;
      sessionId = created.id;
      setSessions((prev) => [created, ...prev]);
      setActiveSessionId(sessionId);
    }

    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: userText,
      attachments: attachments.map(({ id, name, type, dataUrl }) => ({ id, name, type, dataUrl })),
      createdAt: new Date().toISOString(),
    };
    const assistantMessageId = createId();
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      status: "streaming",
    };

    const nextMessages = [...(session.messages || []), userMessage, assistantMessage];
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              providerId: model.providerId,
              providerName: model.providerName,
              modelId: model.id,
              modelName: model.name,
              messages: nextMessages,
              updatedAt: new Date().toISOString(),
              title: s.title === "New chat" ? makeSessionTitle(userText) : s.title,
            }
          : s,
      ),
    );
    setDraft("");
    setAttachments([]);
    setIsSending(true);
    setStreamingMessageId(assistantMessageId);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const requestMessages = nextMessages
      .filter((m) => m.id !== assistantMessageId)
      .map((m) => ({
        role: m.role,
        content: m.role === "user" ? buildUserContent(m) : m.content,
      }));

    try {
      const response = await fetch("/api/dashboard/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          model: model.requestModel || model.id,
          messages: requestMessages,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          textValue(errorData.error || errorData.message || `Request failed (${response.status})`),
        );
      }

      // A non-streamed JSON answer (or no body reader) is read in one go.
      const isJson = (response.headers.get("content-type") || "").includes("application/json");
      const reader = isJson ? null : response.body?.getReader();
      if (!reader) {
        const data = await response.json().catch(() => ({}));
        const fallbackText = textValue(
          data?.choices?.[0]?.message?.content ||
            data?.output_text ||
            data?.error ||
            data?.message ||
            "",
        );
        setAssistant(sessionId, assistantMessageId, () => ({
          content: fallbackText,
          status: "done",
        }));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const text = readAssistantText(JSON.parse(payload));
            if (!text) continue;
            assistantText += text;
            const snapshot = assistantText;
            setAssistant(sessionId, assistantMessageId, () => ({
              content: snapshot,
              status: "streaming",
            }));
          } catch {
            // Ignore malformed chunks.
          }
        }
      }

      setAssistant(sessionId, assistantMessageId, (m) => ({
        content: assistantText || m.content,
        status: "done",
      }));
      const title = makeSessionTitle(userText);
      updateSession(sessionId, (s) => ({
        ...s,
        title: s.title === "New chat" ? title : s.title,
        updatedAt: new Date().toISOString(),
      }));
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") {
        const errorText = textValue((error as Error)?.message || error);
        setAssistant(sessionId, assistantMessageId, (m) => ({
          content: m.content || `Error: ${errorText}`,
          status: "error",
        }));
        setLoadError(errorText || "Failed to send message.");
      }
    } finally {
      setIsSending(false);
      setStreamingMessageId("");
      abortRef.current = null;
    }
  };

  return {
    providerGroups,
    loadingData,
    loadError,
    sessions: sessionItems,
    currentSession,
    activeSessionId,
    activeModel,
    draft,
    setDraft,
    attachments,
    isSending,
    streamingMessageId,
    canSend,
    newChat,
    selectSession,
    deleteChat,
    selectModel,
    attachFiles,
    removeAttachment,
    stop,
    send,
  };
}
