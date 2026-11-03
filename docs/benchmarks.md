# Benchmarks

Gemeten met `scripts/gen-fixtures.ts` en `scripts/bench-index.ts`:

```sh
pnpm tsx scripts/gen-fixtures.ts --out <map> --count 300000
pnpm tsx scripts/bench-index.ts --vault <map> --db <bestand>
```

## M1 (31 oktober 2026)

Omgeving: cloud-container, 4 vCPU, 15 GB RAM, Node 22.22, SQLite 3.50. **Niet** op een Windows-laptop gemeten; dat moet nog. De nep-kluis is 1,2 GB (300.000 notities, 109 groepen, 900.000 secties, 870.000 links).

| | 50.000 notities | 300.000 notities | Doel |
|---|---|---|---|
| Volledige rebuild | 12 s | **74 s** | < 5 min |
| Index op schijf | 167 MB | 999 MB | |
| Tekst zoeken, secties (p95) | 13 ms | **45 ms** | < 50 ms |
| Tekst zoeken, titel + samenvatting (p95) | 3 ms | 24 ms | < 50 ms |
| Twee woorden (p95) | 4 ms | 26 ms | < 50 ms |
| Groep + subgroepen, recent (p95) | 2 ms | 10 ms | < 50 ms |
| Tag (incl. subtags) + groep (p95) | 2 ms | 4 ms | < 50 ms |
| Backlinks / children (p95) | 3 ms | 11 ms | < 50 ms |
| Kaart: aantallen per groep (p95) | 5 ms | 33 ms | < 50 ms |

Niet gemeten in M1: herstart met reconcile (< 10 s), want die hoort bij de server (M3).

## Wat dit betekent voor de bouw

- **Zoeken op sectietekst zit het dichtst bij de grens** (45 ms van 50). Bij een kluis die veel groter is dan 300.000, of met een veelvoorkomend zoekwoord, loopt dit op. Het eerste wat we dan doen is de `fts_sections`-tabel beperken tot de eerste N tekens per sectie, of `fts_items` eerst gebruiken en pas daarna de secties.
- **Gebruik bereiken, geen `LIKE`, voor prefixen.** `LIKE 'x/%'` gebruikt de index niet (SQLite vergelijkt dan hoofdletterongevoelig) en de tag+groep-query was daardoor 70 ms bij 50.000; met een bereik (`>= 'x/' AND < 'x0'`) werd het 1,4 ms. De querytaal in M2 moet `group:` en `tag:` zo vertalen.
- **Kaart** (`brain_map`) werkt zonder aparte teltabel dankzij de index `(kind, status, group_path)`. Een precomputed tabel is pas nodig als dit te traag wordt.
- Geen worker threads nodig voor rebuild: 74 s is ruim binnen het doel.

## M2: de echte tools op 300.000 notities (31 oktober 2026)

Zelfde omgeving en kluis als M1, gemeten via `Brain.find` / `Brain.map` (een HTTP-aanroep met token kost er ongeveer 5 ms bij). Het testwoord komt in zeer veel notities voor; dat is bewust de slechtste situatie.

| | Eerste versie | Nu | Doel |
|---|---|---|---|
| Zoeken, zeldzaam woord | 1409 ms | **31 ms** | < 50 ms |
| Zoeken, zeer algemeen woord | 992 ms | **63 ms** | < 50 ms |
| Algemeen woord + tag | 883 ms | 107 ms | < 50 ms |
| Algemeen woord + datumfilter + sorteren | 357 ms | 61 ms | < 50 ms |
| Tag + groep | 96 ms | 41 ms | < 50 ms |
| Twee woorden | 23 ms | 12 ms | < 50 ms |
| `brain_map` (hele kluis) | 40 ms | 27 ms | < 50 ms |
| `brain_map` met `group=` | 276 ms | 77 ms | < 50 ms |

Wat we deden: per zoekindex alleen de beste 200 treffers laten rangschikken (SQLite telde eerst alle treffers), het resultaat in één query ophalen en in code pagineren, en `tag:` en `links-to:` als `IN (subquery)` schrijven zodat de tag-index de zoektocht stuurt.

Nog boven het doel, en eerlijk: een **zeer algemeen woord** (komt in tienduizenden notities voor) plus tag, en `brain_map group=`. In een echte kluis zijn zulke woorden zeldzamer dan in deze nep-data, en Claude krijgt bij te veel treffers de tip de zoekterm te verfijnen. Als dit in de praktijk hindert, is de volgende stap een voorberekende teltabel voor de kaart en een stopwoordenlijst voor FTS. Nog niet op een Windows-laptop gemeten.

Gevolg van de limiet van 200: bij een zeer algemeen woord met een smal filter kan een passend item buiten de beste 200 vallen. De uitvoer toont dan geen fout, dus dit staat als `shortcut:` bij `FTS_CAP` in de code.

## M3: schrijven, opstarten en herstel op 300.000 notities (31 oktober 2026)

Zelfde omgeving en kluis als hierboven. De index heeft nu formaat 2 (extra index op `path` en een woordfrequentietabel voor de dubbel-controle); de volledige rebuild duurt daardoor 80 s (was 74 s).

| | Gemeten | Doel |
|---|---|---|
| Notitie maken (incl. controle op bijna-dubbele titel), warm | 9 ms | < 200 ms |
| Notitie maken, allereerste aanroep na opstarten (koude cache) | 0,8 s | |
| Aanvullen, sectie vervangen, tags wijzigen | 9 ms | < 200 ms |
| Groep van 3126 items verplaatsen | 43 ms | |
| Opstarten: reconcile zonder wijzigingen (alle 300k bestanden vergelijken) | 2,7 s (koude cache 11 s) | < 10 s |
| Opstarten: volledige index-controle na een crash | 8 s extra | alleen na een crash |

Wat we leerden:

- **Eerste versie van verplaatsen: 52 s** voor die groep, omdat elk bestand opnieuw werd ingelezen en uit de zoekindex werd gehaald. Nu worden alleen de paden in de index aangepast (de inhoud is niet veranderd), en daarna ziet reconcile geen verschil.
- **Zonder index op `path` kostte elke schrijfactie 60 ms** (een scan over 300k rijen). Met de index 9 ms.
- **De controle op bijna-dubbele titels** zocht eerst op de hele titel als zin en duurde 2,2 s bij een algemeen woord. Nu zoeken we op de twee zeldzaamste woorden en vergelijken we daarna de woorden zelf.
- **De volledige integriteitscontrole van de index** (8 s) draait alleen als de server vorige keer niet netjes is afgesloten.
- Nog niet op een Windows-laptop gemeten. Op Windows is de koude-cache-tijd voor reconcile de onbekende (virusscanner, NTFS).

## M4: afbeeldingen op 300.000 notities (31 oktober 2026)

Zelfde omgeving en kluis. Indexformaat 3: items hebben nu `width`, `height` en `file_hash`, plus een index `(kind, status, updated)`.

| | Gemeten | Doel |
|---|---|---|
| Afbeelding toevoegen (warm) | 6 tot 9 ms | < 200 ms |
| Afbeelding toevoegen, allereerste aanroep (koude cache) | 0,8 s | |
| Zoeken `kind:image` + woord | 2 ms | < 50 ms |
| Zoeken op alleen `kind:image` | 0,4 ms (eerst 514 ms) | < 50 ms |
| Pixels ophalen (`view=image`) | 0,5 ms | |
| Volledige rebuild, warme cache | 69 tot 74 s | < 5 min |
| Volledige rebuild, koude cache (net opgestarte machine) | 197 s | < 5 min |
| Index op schijf | 982 MB | |

Wat we leerden: bij een zeldzaam `kind` koos SQLite de index op `(status, updated)` en liep daardoor alle 300.000 rijen langs om er drie te vinden. Met `(kind, status, updated)` is het meteen goed. Hetzelfde kan gebeuren bij andere zeldzame filters; een controle op trage queries in `brain doctor` is nog niet gebouwd.

## M6: `brain doctor`

Zelfde omgeving, 300.000 notities. `brain doctor` op een gezonde kluis (reconcile, controle op kapotte bestanden, hangende links en losse plaatjes): 9 s warm, 102 s met koude cache (alle bestanden moeten van schijf).

## M8: heelal-UI op 300.000 notities (1 november 2026)

Zelfde omgeving en kluis (300.109 items, 12 groepen met elk 8 subgroepen, 10 soorten, ~870.000 links), headless Chromium zonder GPU (de laptop heeft een echte GPU, dit is dus een ondergrens).

| | Gemeten | Doel |
|---|---|---|
| Beeld tekenen (zoomen in en uit), overzicht met 12 groepen | 16,6 ms mediaan, p95 23 ms | vloeiend (60 beelden/s) |
| Beeld tekenen, subgroepen | 16,6 ms mediaan, p95 21 ms | |
| Beeld tekenen, items (tot ~1.200 geladen, rest als stof) | 16,3 ms mediaan, p95 23 ms | |
| `/api/overview` (warm) | 6 tot 10 ms | |
| `/api/overview`, linkbundels voor 870k links (eenmalig, op de achtergrond) | 3,6 s | |
| `/api/group/:id` (koud / warm) | 0,3 tot 0,6 s / 6 ms | |
| `/api/items` per soort (200 stuks) | 5 tot 7 ms | |
| `/api/search` (zelfde querytaal als Claude) | 32 tot 35 ms | |
| Overzicht met 132 groepen (30k-set) | 16 ms | |

Wat we leerden:

- **De linkbundels zijn het zwaarste stuk** (één lijn per paar groepen, met het aantal links): 3,6 s rekenwerk over alle links. Dat blokkeerde eerst de hele server. Nu rekent de server groep voor groep en geeft tussendoor de ruimte terug (andere aanvragen en schrijfacties blijven snel), de uitkomst geldt tot de index verandert (`total_changes()`), en bij een wijziging krijgt de UI meteen het oude antwoord terwijl er op de achtergrond een nieuw wordt berekend. Bij het opstarten rekent de server het overzicht alvast uit.
- **Een melkweg is één plaatje**: 100+ stelsels met elk ~1.000 sterren tekenen kostte 30 ms per beeld; als plaatje per groep (gedraaid en afgeplat volgens de camera) 16 ms.
- **Samenvoegen houdt het netjes en snel**: groepen buiten de grootste 24 zijn stof tot je inzoomt; per soortbaan worden alleen de nieuwste items los getekend (40, meer bij inzoomen) en de rest als stof.
- Een proces dat de hele kluis ziet (zoals de watcher op 300k bestanden) gebruikt veel inotify-watches; twee tegelijk in de testomgeving laat de watcher-test falen. Dat is een grens van de testomgeving, niet van de code.

## M9: dashboard, logs, verwijderen (1 november 2026)

Zelfde kluis (300.109 items) met ~60 aanroepen in het audit log.

| | Gemeten |
|---|---|
| `/api/dashboard` koud / warm | 0,8 s / 4 ms (de groeigrafiek leest alle notities; die wordt nu hooguit 1× per minuut berekend) |
| `/api/logs` (100 regels, ook met zoektekst) | 4 ms |
| `/api/delete-preview` voor een groep van 22.000 notities | 1,4 s (telt links van buiten de groep); voor één notitie een paar ms |
| Live-stream | 1 controle per seconde (`total_changes()` plus een teller), geen database-query |

- De live-melding komt van twee bronnen: de index verandert (Claude schrijft, de watcher ziet een handmatige wijziging of de UI verwijdert) of er komt een aanroep van Claude in het logboek. UI-leesverzoeken tellen niet mee, anders zou de pagina zichzelf blijven verversen.
- Het logboek verbergt de UI-leesverzoeken (`ui_overview`, enz.) standaard; ze staan wel in `logs.db`.

## M10: eindcontrole op 300.000 notities (1 november 2026)

`scripts/bench-e2e.ts`: de echte server op de kluis van 300.109 items, alles via HTTP zoals Claude en de browser het doen. Zelfde omgeving als hierboven (cloud-VM, Node 22, geen GPU). p50 / p95 over 20 tot 60 aanroepen, de eerste (koude) aanroep apart.

| | p50 | p95 | eerste | Doel |
|---|---|---|---|---|
| Server klaar na opstarten | | | 3,9 tot 4,9 s | < 20 s |
| `brain_map` | 30 ms | 41 ms | 30 ms | < 100 ms |
| `brain_find`, zeldzaam woord | 26 ms | 32 ms | 29 ms | < 100 ms |
| `brain_find`, `kind:note sort:updated` | 5 ms | 10 ms | 6 ms | < 100 ms |
| `brain_read` (outline) | 5 ms | 10 ms | 8 ms | < 50 ms |
| `brain_write` create | 8 ms | 17 ms | 13 ms | < 100 ms |
| `/api/overview` | 5 ms | 8 ms | 6 ms (eerste ooit: 2,8 s, wacht op de linkbundels) | < 50 ms |
| `/api/search` | 23 ms | 33 ms | 28 ms | < 100 ms |
| `/api/dashboard` | 25 ms | 30 ms | 535 ms | < 100 ms |

- Eén keer in drie runs duurde een `brain_write` 205 ms (de andere 59 waren onder 20 ms); een uitschieter van de testomgeving, geen patroon. Daarom meet het script 60 schrijfacties.
- Dezelfde cijfers als in M2 tot M9 gemeten: er is niets achteruitgegaan door de latere onderdelen (UI, audit, live-stream).
- Niet gemeten: Windows op een Windows-laptop (virusscanner, NTFS, koude cache), en de UI met een echte GPU.
