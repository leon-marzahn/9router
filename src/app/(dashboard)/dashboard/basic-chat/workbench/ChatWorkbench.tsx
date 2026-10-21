"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import {
  Button,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  Icon,
  IconButton,
  ListAddRow,
  ListGroup,
  ListRow,
  ListSkeleton,
  ModelPicker,
  Note,
  SearchInput,
  Select,
  Tag,
  WorkbenchDetail,
  WorkbenchList,
  cn,
  useListKeyboard,
} from "@/ui";
import {
  formatRelativeTime,
  textValue,
  toPickerGroups,
  type ChatMessage,
  type ChatSession,
} from "./chat";
import { useKeyboardInset, useRecentModels } from "./hooks";
import { MessageBody } from "./MessageBody";
import { useChat } from "./useChat";

function lastUserText(session: ChatSession): string {
  const latest =
    [...session.messages].reverse().find((m) => m.role === "user") || session.messages[0];
  return textValue(latest?.content) || "Empty chat";
}

const noopSubscribe = () => () => {};

/**
 * Chats live in localStorage, which the server can't see: render a skeleton until
 * hydration is done so the restored state never causes a hydration mismatch.
 */
export function ChatWorkbench() {
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  if (!hydrated)
    return (
      <div className="flex min-h-0 flex-1">
        <WorkbenchList selected={null} header={null}>
          <ListSkeleton />
        </WorkbenchList>
      </div>
    );
  return <ChatWorkbenchInner />;
}

function ChatWorkbenchInner() {
  const chat = useChat();
  const [query, setQuery] = useState("");
  const [mobileDetail, setMobileDetail] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chat.sessions;
    return chat.sessions.filter(
      (s) => s.title.toLowerCase().includes(q) || s.modelName?.toLowerCase().includes(q),
    );
  }, [chat.sessions, query]);

  const sel = chat.activeSessionId || null;
  const open = (id: string) => {
    chat.selectSession(id);
    setMobileDetail(true);
  };
  const startChat = () => {
    chat.newChat();
    setMobileDetail(true);
  };

  useListKeyboard({
    order: visible.map((s) => s.id),
    selected: sel,
    onSelect: (id) => (id ? chat.selectSession(id) : setMobileDetail(false)),
    searchRef,
  });

  const deleting = chat.sessions.find((s) => s.id === confirmDelete);

  return (
    <div className="flex min-h-0 flex-1">
      <WorkbenchList
        selected={sel}
        detailOpen={mobileDetail}
        header={
          <div className="flex items-center gap-2">
            <SearchInput
              ref={searchRef}
              shortcut="/"
              placeholder="Search chats"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1"
            />
            <Button size="sm" icon="add" disabled={!chat.activeModel} onClick={startChat}>
              New
            </Button>
          </div>
        }
        hints={[
          ["↑↓", "move"],
          ["/", "search"],
        ]}
      >
        {chat.loadingData && chat.sessions.length === 0 ? (
          <ListSkeleton />
        ) : visible.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-[12px] text-text-muted">
            {query ? "No chats match." : "No conversations yet."}
          </p>
        ) : (
          <ListGroup title="Chats" count={visible.length}>
            {visible.map((s) => (
              <ListRow
                key={s.id}
                id={s.id}
                active={s.id === sel}
                onClick={() => open(s.id)}
                leading={<Icon name="chat_bubble" size={16} className="text-text-subtle" />}
                title={s.title}
                subtitle={lastUserText(s)}
                trailing={
                  <span className="shrink-0 text-[11px] tabular-nums text-text-subtle">
                    {formatRelativeTime(s.updatedAt)}
                  </span>
                }
              />
            ))}
          </ListGroup>
        )}
        {!(chat.loadingData && chat.sessions.length === 0) && !query && (
          <ListAddRow disabled={!chat.activeModel} onClick={startChat}>
            New chat
          </ListAddRow>
        )}
      </WorkbenchList>

      <WorkbenchDetail
        detailOpen={mobileDetail}
        backLabel="All chats"
        onBack={() => setMobileDetail(false)}
      >
        {chat.currentSession ? (
          <Conversation chat={chat} onDelete={() => setConfirmDelete(chat.activeSessionId)} />
        ) : (
          <div className="mx-auto max-w-3xl space-y-3 p-4 md:p-6">
            {chat.loadError && <Note tone="danger">{chat.loadError}</Note>}
            <EmptyState
              icon="chat"
              action={
                chat.providerGroups.length === 0 && !chat.loadingData ? (
                  <Link href="/dashboard/providers">
                    <Button variant="secondary" size="sm" icon="arrow_forward">
                      Providers
                    </Button>
                  </Link>
                ) : (
                  <Button size="sm" icon="add" disabled={!chat.activeModel} onClick={chat.newChat}>
                    New chat
                  </Button>
                )
              }
            >
              {chat.loadingData
                ? "Loading models from your connected providers…"
                : chat.providerGroups.length === 0
                  ? "Connect a provider to chat with its models."
                  : "Start a chat with any model from your connected providers."}
            </EmptyState>
          </div>
        )}
      </WorkbenchDetail>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) chat.deleteChat(confirmDelete);
          setConfirmDelete(null);
        }}
        title="Delete chat?"
        message={
          <>
            <span className="font-medium text-text">{deleting?.title}</span> and its messages are
            removed from this browser. This can&apos;t be undone.
          </>
        }
        confirmText="Delete"
        confirmIcon="delete"
      />
    </div>
  );
}

type Chat = ReturnType<typeof useChat>;

function Conversation({ chat, onDelete }: { chat: Chat; onDelete: () => void }) {
  const session = chat.currentSession!;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const last = session.messages[session.messages.length - 1];
  const lastLen = textValue(last?.content).length;
  const pickerGroups = useMemo(() => toPickerGroups(chat.providerGroups), [chat.providerGroups]);
  const keys = chat.keys;
  const [recent, remember] = useRecentModels();
  const inset = useKeyboardInset();

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [session.id, session.messages.length, lastLen]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (chat.canSend) void chat.send();
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      {/* Compact header on mobile: title + delete, then key and model pickers on one full-width
          row; everything on one row with the full title on lg+. */}
      <header className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-2 gap-y-2 px-4 md:gap-x-3 lg:flex-nowrap lg:items-start md:px-6 md:pt-6">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-medium md:text-sm lg:font-display lg:text-3xl lg:font-normal lg:tracking-tight">
            {session.title}
          </h2>
          <div className="mt-1 hidden flex-wrap items-center gap-2 text-[12px] text-text-muted lg:flex">
            <Tag mono>{chat.activeModel?.requestModel ?? session.modelId}</Tag>
            <span>
              {session.messages.length} message{session.messages.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div className="order-3 flex w-full min-w-0 items-center gap-2 lg:order-2 lg:w-auto">
          <Select
            aria-label="API key"
            title="API key the chat runs as (its access list, budget and usage apply)"
            value={keys.keyId ?? ""}
            disabled={chat.isSending}
            onChange={(e) => keys.select(e.target.value)}
            className="w-2/5 min-w-0 lg:w-40"
          >
            {keys.keys.map((k) => (
              <option key={k.id} value={k.id} disabled={!k.isActive}>
                {k.name}
                {k.isActive ? "" : " (disabled)"}
              </option>
            ))}
          </Select>
          <ModelPicker
            groups={pickerGroups}
            value={chat.activeModel?.id ?? null}
            recent={recent}
            disabled={chat.providerGroups.length === 0 || chat.isSending}
            onChange={(id) => {
              chat.selectModel(id);
              remember(id);
            }}
            className="min-w-0 flex-1 lg:w-64 lg:flex-none"
          />
        </div>
        <IconButton
          icon="delete"
          label="Delete chat"
          onClick={onDelete}
          className="order-2 lg:order-3"
        />
        {keys.billsAnotherKey && (
          <p className="order-4 w-full text-[12px] text-text-muted">
            Requests are billed to and visible on this key.
          </p>
        )}
      </header>

      {chat.loadError && (
        <div className="mx-auto w-full max-w-3xl px-4 pt-3 md:px-6">
          <Note tone="danger">{chat.loadError}</Note>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-4 md:px-6 md:py-6">
        {session.messages.length === 0 && (
          <EmptyState icon="chat">
            Ask {chat.activeModel?.name ?? "a model"} anything. Enter sends, Shift+Enter adds a
            line.
          </EmptyState>
        )}
        {session.messages.map((m) => (
          <Message
            key={m.id}
            message={m}
            modelName={session.modelName || chat.activeModel?.name || "Assistant"}
            streaming={m.id === chat.streamingMessageId && m.status === "streaming"}
          />
        ))}
        <div ref={endRef} />
      </div>

      <div
        className="sticky bottom-0 bg-bg pb-3 md:pb-4"
        style={inset ? { paddingBottom: inset + 12 } : undefined}
      >
        <div className="mx-auto w-full max-w-3xl px-4 md:px-6">
          {chat.attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {chat.attachments.map((a) => (
                <span
                  key={a.id}
                  className="flex items-center gap-1 rounded-lg bg-surface-2 py-0.5 pl-2.5 pr-0.5 text-[12px]"
                >
                  <span className="max-w-48 truncate">{a.name}</span>
                  <IconButton
                    icon="close"
                    label={`Remove ${a.name}`}
                    onClick={() => chat.removeAttachment(a.id)}
                  />
                </span>
              ))}
            </div>
          )}
          <div className="rounded-2xl border border-border-strong bg-surface p-2 shadow-soft focus-within:border-accent focus-within:shadow-focus dark:border-border">
            <textarea
              aria-label="Message"
              value={chat.draft}
              onChange={(e) => chat.setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={chat.activeModel ? `Message ${chat.activeModel.name}` : "Message AI"}
              rows={2}
              className="max-h-[25dvh] w-full resize-none bg-transparent px-2 py-1 text-[14px] leading-relaxed text-text outline-none placeholder:text-text-subtle"
            />
            <div className="flex items-center gap-1">
              <IconButton
                icon="attach_file"
                label="Attach images"
                disabled={!chat.activeModel || chat.loadingData}
                onClick={() => fileInputRef.current?.click()}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => void chat.attachFiles(e)}
              />
              <span className="hidden text-[11px] text-text-subtle sm:inline">
                Enter to send · Shift+Enter for a new line
              </span>
              <div className="ml-auto flex items-center gap-1">
                {chat.isSending && (
                  <Button variant="secondary" size="sm" icon="stop" onClick={chat.stop}>
                    Stop
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  icon="arrow_upward"
                  disabled={!chat.canSend}
                  onClick={() => void chat.send()}
                >
                  Send
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Message({
  message,
  modelName,
  streaming,
}: {
  message: ChatMessage;
  modelName: string;
  streaming: boolean;
}) {
  const isUser = message.role === "user";
  const text = textValue(message.content);
  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "min-w-0",
          isUser ? "max-w-[85%] rounded-2xl bg-surface-2 px-4 py-2.5" : "w-full",
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-[12px] text-text-muted">
          <span className="font-medium text-text">{isUser ? "You" : modelName}</span>
          {message.status === "error" && <Tag tone="danger">Error</Tag>}
          {!isUser && text && !streaming && (
            <span className="ml-auto">
              <CopyButton value={text} label="Copy message" />
            </span>
          )}
        </div>
        {message.attachments?.length ? (
          <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {message.attachments.map((a) => (
              <a
                key={a.id}
                href={a.dataUrl}
                target="_blank"
                rel="noreferrer"
                className="overflow-hidden rounded-lg border border-border"
              >
                {/* oxlint-disable-next-line nextjs/no-img-element -- data: URL from the user's own upload */}
                <img
                  src={a.dataUrl}
                  alt={a.name}
                  className="h-28 w-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
              </a>
            ))}
          </div>
        ) : null}
        {isUser ? (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">{text}</p>
        ) : (
          <div className={cn(message.status === "error" && "text-danger-text")}>
            {text && <MessageBody text={text} />}
            {streaming && !text && (
              <span className="inline-block animate-pulse text-text-subtle">▋</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
