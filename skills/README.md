# Elizabeth's Proxy — Agent Skills

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Just **copy a link** below and paste it to your AI — it will fetch the skill and use Elizabeth's Proxy for you.

> Tip: start with the **regent** entry skill — it covers setup and links to all capability skills.

## Skills

| Capability | Copy link below and paste to your AI |
|---|---|
| **Entry / Setup** (start here) | https://raw.githubusercontent.com/leon-marzahn/9router/refs/heads/master/skills/regent/SKILL.md |
| Chat / code-gen | https://raw.githubusercontent.com/leon-marzahn/9router/refs/heads/master/skills/regent-chat/SKILL.md |
| Image generation | https://raw.githubusercontent.com/leon-marzahn/9router/refs/heads/master/skills/regent-image/SKILL.md |
| Video generation (xAI Grok Imagine) | https://raw.githubusercontent.com/leon-marzahn/9router/refs/heads/master/skills/regent-video/SKILL.md |
| Text-to-speech | https://raw.githubusercontent.com/leon-marzahn/9router/refs/heads/master/skills/regent-tts/SKILL.md |
| Speech-to-text | https://raw.githubusercontent.com/leon-marzahn/9router/refs/heads/master/skills/regent-stt/SKILL.md |
| Embeddings | https://raw.githubusercontent.com/leon-marzahn/9router/refs/heads/master/skills/regent-embeddings/SKILL.md |
| Web search | https://raw.githubusercontent.com/leon-marzahn/9router/refs/heads/master/skills/regent-web-search/SKILL.md |
| Web fetch (URL → markdown) | https://raw.githubusercontent.com/leon-marzahn/9router/refs/heads/master/skills/regent-web-fetch/SKILL.md |

## How to use

Paste to your AI (Claude, Cursor, ChatGPT, …):

```
Read this skill and use it: https://raw.githubusercontent.com/leon-marzahn/9router/refs/heads/master/skills/regent/SKILL.md
```

Then ask normally — *"generate an image of a cat"*, *"transcribe this URL"*, etc.

## Configure your shell once

```bash
export REGENT_URL="http://localhost:20128"   # local default, or your VPS / tunnel URL
export REGENT_KEY="sk-..."                   # from Dashboard → Keys (only if requireApiKey=true)
```

Verify: `curl $REGENT_URL/api/health` → `{"ok":true}`.

## Links

- Source: https://github.com/leon-marzahn/9router
