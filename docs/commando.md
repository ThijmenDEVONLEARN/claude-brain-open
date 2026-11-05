# Alle commando's

Draai `git` en `pnpm` in de map van de repo. De `brain`-commando's werken vanuit elke map.

## Bijwerken na een nieuwe versie

```powershell
cd <map met de repo>
git pull
pnpm install
pnpm build:web                    # bouwt de UI opnieuw (apps/web/dist)
brain stop                        # stopt het startscript én de server zelf
brain install-autostart           # schrijft de nieuwe start.vbs en start de server met de nieuwe code
brain doctor
```

Gaat stoppen niet: `Stop-Process -Id <pid uit brain doctor> -Force`. Het startscript start de server dan zelf binnen 5 seconden opnieuw, met de nieuwe code. Ververs de pagina met Ctrl+F5.

## `brain`

| Commando | Wat het doet |
|---|---|
| `brain serve` | start de server in dit venster (niet nodig met autostart) |
| `brain open` | opent het heelal in je browser (`http://127.0.0.1:4747/`) |
| `brain doctor` | server, autostart, kluis en index controleren (`--fix` herstelt wat veilig kan) |
| `brain install-autostart` | taak "ClaudeBrain" in de Taakplanner, start bij aanmelden |
| `brain stop` | stopt de server (en het startscript, zodat hij niet terugkomt); opnieuw starten: `schtasks /Run /TN ClaudeBrain` |
| `brain uninstall-autostart` | stopt de server en haalt die taak weer weg |
| `brain token` | toont je token |
| `brain rebuild` | bouwt de index opnieuw uit de kluis (server moet uit staan; `--vault`, `--db`) |
| `brain map [diepte]` | de kaart van het brein, zoals Claude hem ziet |
| `brain call <tool> '<json>'` | roept één MCP-tool aan, bijvoorbeeld `brain call brain_find '{"query":"intake"}'` |
| `brain mcp-stdio` | brug voor Claude Desktop (zet je niet zelf in de terminal aan) |

## Claude Code

```
/plugin install brain --marketplace ThijmenDEVONLEARN/claude-brain-open
```

Commando's in de plugin: `/brain-remember`, `/brain-find`, `/brain-group`, `/brain-review`.

## Ontwikkelen

```powershell
pnpm check                     # lint, typecheck en tests (draait ook voor elke push)
pnpm brain <commando>          # zelfde als `brain`, rechtstreeks uit de repo
pnpm tsx scripts/gen-fixtures.ts --out <map> --count 300000   # nep-kluis
$env:BRAIN_HOME="<map>"; pnpm tsx scripts/bench-e2e.ts        # eindmeting op een grote kluis
```

## In het heelal

| Actie | Doet |
|---|---|
| slepen | draaien, helemaal rond en van boven naar onder |
| Shift+slepen, rechter- of middelste muisknop, pijltjestoetsen | beeld verschuiven (Shift+pijl = sneller) |
| scrollen | in- en uitzoomen op de muis |
| dubbelklik op een stelsel | openen; op leeg = inzoomen |
| Esc | terug naar de standaardstand |
| Backspace | een laag omhoog |
| Enter | geselecteerde groep openen |
| titel van een menu slepen | menu overal neerzetten (dubbelklik op de titel zet het terug) |
| hoekje van een menu slepen | menu groter of kleiner |
| menu "Kijkhoek" | Boven, Voor, Achter, Onder, Standaard |
