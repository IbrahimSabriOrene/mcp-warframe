# Warframe Guide MCP

Personal read-only MCP server by Ibrahim Sabri Örene for wiki lookup and game guidance. Zero runtime dependencies; Node.js 18+; stdio transport.

## Capabilities

Wiki search, page/section retrieval, outlines, related pages, fuzzy term resolution, glossary and UI-label lookup, progression paths and an optional timestamped guide index. Screenshot workflows accept extracted text; the server does not itself perform image OCR.

```sh
node server.js
```

Register `node /absolute/path/to/mcp-warframe/server.js` with your MCP client. The wiki client uses `https://wiki.warframe.com/api.php` by default, with an in-memory cache and request pacing. `WARFRAME_WIKI_API`, `WARFRAME_WIKI_UA` and `WARFRAME_WIKI_TTL` are configurable.

## Optional guide transcript

No third-party video transcript is distributed. To use `warframe_guide`, set `WARFRAME_GUIDE_TRANSCRIPT` to a Markdown transcript you have permission to use, with headings like `## [01:20] Chapter title`. Without one, guide search reports unavailable while wiki/glossary tools remain usable.

`node test/smoke.js` is the original live-wiki smoke suite. It requires internet access and a separately supplied guide corpus for transcript-specific checks; it is not a clean-clone offline acceptance test.

Authored glossary/UI/progression lookup tables are included; downloaded article bodies, private game data and full third-party transcripts are excluded. Warframe and its wiki belong to their respective owners; this is an independent tool. No new license grant has been selected for this source release.
