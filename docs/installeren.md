# Installeren (Windows 11)

Een installer (één .exe) komt later; nu installeer je met git en pnpm.

## 1. Programma

Vereist: Node 24 (22.12 of nieuwer werkt ook) en pnpm.

```powershell
git clone https://github.com/ThijmenDEVONLEARN/claude-brain-open.git
cd claude-brain-open
pnpm install
pnpm build:web              # bouwt de heelal-UI (apps/web/dist); opnieuw na elke update van de repo
pnpm setup            # eenmalig; open daarna een nieuw terminalvenster
cd apps\server
pnpm link --global    # maakt het commando `brain`
```

Controleer: `brain token` moet een lange hex-tekst tonen. De map `%USERPROFILE%\ClaudeBrain\` (kluis, data, logs, config, token) wordt zelf aangemaakt.

## 2. Server starten

```powershell
brain serve
```

Voor een test is dit genoeg; laat het venster open staan. Voor dagelijks gebruik zet je autostart aan:

```powershell
brain install-autostart     # taak "ClaudeBrain" in de Taakplanner; start meteen
brain doctor                # server draait? autostart ingesteld? kluis en index in orde?
brain open                  # opent http://127.0.0.1:4747/ in je browser
brain uninstall-autostart   # haalt de taak weer weg
```

De taak start bij het aanmelden van jouw account, zonder venster en zonder adminrechten, en start de server zelf opnieuw als hij onverwacht stopt (na 5 seconden; bij herhaald stoppen steeds iets langer, tot 1 minuut). Stoppen doe je met `brain stop` (stopt startscript en server) of `brain uninstall-autostart`; een losse `Stop-Process` op de server zorgt er dus voor dat hij zichzelf weer start, en `schtasks /End` sluit alleen het startscript af en laat de server draaien. Uitvoer komt in `%USERPROFILE%\ClaudeBrain\logs\server.log`. De taak wijst naar de plek waar je de repo hebt staan: verplaats je de map, draai dan `brain install-autostart` opnieuw.

`brain doctor` past nooit een bestand van jou aan. Hij meldt kapotte bestanden, links en parents die nergens heen wijzen, afbeeldingen zonder sidecar of zonder bestand, en een index die achterliep. Draait de server niet, dan werkt hij de index bij en maakt `brain doctor --fix` een sidecar bij losse plaatjes; draait de server wel, dan kijkt hij alleen.

## 3. Claude Code

Eén commando (Claude Code 2.1.275 of nieuwer):

```
/plugin install brain --marketplace ThijmenDEVONLEARN/claude-brain-open
```

Bij een oudere versie in twee stappen: `/plugin marketplace add ThijmenDEVONLEARN/claude-brain-open` en `/plugin install brain@claude-brain`.

Daarna werken de skills en `/brain-remember`, `/brain-find`, `/brain-group`, `/brain-review`. Wil je de leestools zonder toestemmingsvraag, zet ze dan op "altijd toestaan" in de permissies van Claude Code.

## 4. Claude Desktop

Voeg dit toe aan `claude_desktop_config.json` (Instellingen, Ontwikkelaar, Config bewerken) en herstart Claude Desktop:

```json
{
  "mcpServers": {
    "claude-brain": { "command": "brain", "args": ["mcp-stdio"] }
  }
}
```

De brug leest het token zelf uit `%USERPROFILE%\ClaudeBrain\.token`. Draait de server niet, dan krijgt Claude de melding "Claude Brain draait niet. Start de server met: brain serve".

## Optioneel: een kleine kaart aan het begin van elke sessie

`brain map 1` print de groepen met aantallen (ongeveer 300 tot 800 tokens). Zet die in elke Claude Code-sessie met een `SessionStart`-hook: kopieer de inhoud van [plugin/optional/session-start-hook.json](../plugin/optional/session-start-hook.json) naar je `~/.claude/settings.json`. Draait de server niet, dan print het commando niets en start de sessie gewoon.

Meer detail per groep: `brain map 2`.

## Instellingen (`%USERPROFILE%\ClaudeBrain\config.json`)

| Sleutel | Standaard | Betekenis |
|---|---|---|
| `port` | `4747` | poort van de server (alleen 127.0.0.1) |
| `imageRoots` | je gebruikersmap | mappen waaruit `brain_image` bronbestanden mag lezen |
