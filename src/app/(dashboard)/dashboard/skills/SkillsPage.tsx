// Agent Skills: instruction files an AI agent can read to learn how to use this
// gateway. Each is one public URL; the user pastes it into their agent.
"use client";

import { Button, Icon, Panel, Tag } from "@/ui";
import { useCopyToClipboard as useCopyJs } from "@/shared/hooks/useCopyToClipboard";
import {
  SKILLS as SKILLS_JS,
  SKILLS_REPO_URL,
  getSkillBlobUrl,
  getSkillRawUrl,
} from "@/shared/constants/skills";

type Skill = {
  id: string;
  name: string;
  description: string;
  endpoint: string | null;
  icon: string;
  isEntry?: boolean;
};
const SKILLS = SKILLS_JS as Skill[];
const useCopy = useCopyJs as unknown as (ms?: number) => {
  copied: string | null;
  copy: (text: string, id?: string) => void;
};

export function SkillsPage() {
  const { copied, copy } = useCopy(2000);
  // Entry skill first; it links to all the others.
  const skills = [...SKILLS].sort((a, b) => Number(!!b.isEntry) - Number(!!a.isEntry));
  const prompt = `Read this skill and use it: ${getSkillRawUrl("regent")}`;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="font-display text-3xl tracking-tight">Agent skills</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">
          Instructions your AI agent can read to learn how to use this gateway: the address, how to
          sign in, and which endpoints exist. Give it a link and it does the rest.
        </p>
      </div>

      <Panel className="p-5">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <Icon name="bolt" size={18} className="text-accent" />
          Quickest start: paste this to your agent
        </div>
        <p className="mt-1 text-xs text-text-muted">
          The main skill links to all the others, so this one line is usually enough.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs">
            {prompt}
          </code>
          <Button
            variant="primary"
            icon={copied === "prompt" ? "check" : "content_copy"}
            onClick={() => copy(prompt, "prompt")}
            className="self-start sm:self-auto"
          >
            {copied === "prompt" ? "Copied" : "Copy"}
          </Button>
        </div>
      </Panel>

      <section className="space-y-2">
        <h2 className="font-display text-xl">All skills</h2>
        <p className="text-xs text-text-muted">
          Give an agent just one of these when it only needs a single capability.
        </p>
        <Panel className="divide-y divide-border">
          {skills.map((s) => (
            <SkillRow
              key={s.id}
              skill={s}
              copied={copied === s.id}
              onCopy={() => copy(getSkillRawUrl(s.id), s.id)}
            />
          ))}
        </Panel>
      </section>

      <a
        href={`${SKILLS_REPO_URL}/tree/master/skills`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 text-[13px] text-text-muted hover:text-text"
      >
        Browse the source and examples on GitHub
        <Icon name="open_in_new" size={14} />
      </a>
    </div>
  );
}

function SkillRow({
  skill,
  copied,
  onCopy,
}: {
  skill: Skill;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3 px-4 py-3.5 sm:flex-nowrap">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-muted">
        <Icon name={skill.icon} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-medium">{skill.name}</span>
          {skill.isEntry && <Tag tone="accent">Start here</Tag>}
          {skill.endpoint && <Tag mono>{skill.endpoint}</Tag>}
        </div>
        <p className="mt-0.5 text-xs text-text-muted">{skill.description}</p>
        <a
          href={getSkillBlobUrl(skill.id)}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-text-subtle hover:text-text"
        >
          Read it on GitHub
          <Icon name="open_in_new" size={12} />
        </a>
      </div>
      <Button
        icon={copied ? "check" : "link"}
        onClick={onCopy}
        title={getSkillRawUrl(skill.id)}
        aria-label={`Copy link to ${skill.name}`}
        className="ml-11 sm:ml-0"
      >
        {copied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}
