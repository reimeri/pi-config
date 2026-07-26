# Global Web Search Extension

Provider-native web search for Pi. This extension is auto-discovered globally from `~/.pi/agent/extensions/web-search/index.ts`.

## Tools

- `web_search`: Google Gemini grounding, OpenAI Responses web search, OpenAI Codex web search, or Anthropic server web search.
- `url_context`: Google Gemini URL Context for up to 20 public URLs. It is hidden when the current conversation model is not Gemini.

`web_search` sends the search execution time to the provider and returns the same UTC timestamp in its visible output and `details.searchedAt`. This gives both the search model and the calling agent an explicit reference for recent events and dates beyond a model's training cutoff.

Both tools reject non-public or non-HTTP(S) URLs, bound stream/result sizes, remove raw provider payloads from session details, and require HTTPS model endpoints except loopback development servers.

## Dedicated search model

By default `web_search` uses the current conversation model. To opt into a dedicated model, create `~/.pi/agent/web-search.json`:

```json
{
  "provider": "openai",
  "model": "gpt-5.4"
}
```

The provider/model must already exist in Pi's model registry and use one of these APIs:

- `google-generative-ai`
- `openai-responses`
- `openai-codex-responses`
- `anthropic-messages`

`url_context` intentionally ignores this file and always uses the current Gemini model.

## Security notes

- Extensions run with the user's full permissions.
- Search queries and supplied URLs are sent to the selected provider.
- Custom model base URLs receive that model's configured credentials; only trusted model/provider definitions should be used.
- OpenAI Codex and Anthropic OAuth compatibility retains the same client headers as the reference implementation.
