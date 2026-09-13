# Request pipelines

Open **Request Pipelines** in the dashboard to create a named pipeline. Add rules, arrange them with Up/Down, preview a sample JSON request, and save. Changes apply immediately to new requests.

Send `X-9Router-Pipeline: agentic` to select the pipeline named `agentic`. Names are case-sensitive. A missing header skips processing; an unknown name returns HTTP 400. One pipeline is selected per request.

Each rule has:

- **Regex**: a JavaScript pattern, either bare or `/pattern/flags`. Supports `gimsu`; matching is always global. Use `[\s\S]` or the `s` flag to match newlines.
- **Replace with**: empty by default, removing selected matches. Supports JavaScript replacement tokens, including `$1` and `$<name>`.
- **Depth**: the number of latest matches to preserve across all eligible text blocks. `0` replaces every match; `1` preserves the last match. Fewer matches than Depth leaves them all unchanged.

For example, create `agentic` with Regex `<internal_states>[\s\S]*?</internal_states>`, empty replacement, and Depth `1`. This removes older blocks while retaining the latest block, including when the blocks occur in different messages.

```sh
curl http://localhost:20127/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'X-9Router-Pipeline: agentic' \
  -d '{"model":"YOUR_MODEL","messages":[{"role":"user","content":"<internal_states>old</internal_states> Continue <internal_states>latest</internal_states>"}]}'
```

Rules run in order, once before routing, fallback, translation, and token-saving transforms. Each subsequent rule sees the previous rule's output. System text is scanned before conversation history, in array order. Matching is confined to individual text strings, so a tag split across content blocks does not match. Regex is suited to flat tag blocks, not nested XML.

Processing covers chat message content, system instructions, Responses input and textual tool outputs, and Gemini text parts handled through the chat router. Tool definitions, tool-call arguments, image data, signatures, and metadata are left intact. Non-chat media endpoints are outside this pipeline. The selection header is removed from headers passed to providers. Original request logs retain the original body.

Regex processing runs in an isolated worker with a one-second deadline, including worker startup. Invalid rules cannot be saved. Processing failures and timeouts return HTTP 400 without sending the request upstream. Preview runs the same engine without saving settings or contacting a provider.
