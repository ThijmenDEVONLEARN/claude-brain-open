# Claude Brain: plugin voor Claude Code

Bevat de MCP-koppeling (`.mcp.json`, via `brain mcp-stdio`), vier skills en vier commando's.

| Skill | Wanneer |
|---|---|
| `brain-recall` | voordat Claude een vraag beantwoordt waar eerdere kennis bij kan helpen |
| `brain-remember` | "onthoud dit", of als Claude iets blijvends leert |
| `brain-organize` | "maak hier een groep van", verplaatsen, archiveren, verwijderen |
| `brain-review` | onderhoud: wezen, oude en dubbele notities |

Commando's: `/brain-remember`, `/brain-find`, `/brain-group`, `/brain-review`.

Installeren in Claude Code:

```
/plugin install brain --marketplace ThijmenDEVONLEARN/claude-brain-open
```

Voorwaarde: het commando `brain` staat op je PATH en de server draait. Installeren en optionele sessiehook: zie [docs/installeren.md](../docs/installeren.md).
