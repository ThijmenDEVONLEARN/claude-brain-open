---
name: brain-organize
description: Use when the user says "maak hier een aparte groep van", "verplaats", "archiveer", "ruim op", "hernoem de groep", "voeg groepen samen", or asks to delete something in Claude Brain. Creates groups, moves and archives items, and handles deletion safely.
---

# Organiseren

Een groep is een map in de kluis: een groep is een sterrenstelsel, een subgroep een planeet.

## Groep maken
`brain_organize create_group` met `title`, een goede `summary` (daarmee ziet Claude via `brain_map` waar iets staat) en eventueel `to` voor de bovenliggende groep. Verplaats daarna de juiste items erheen.

## Verplaatsen
`brain_organize move` met `ids` of met een `query`, en `to` (groep-id of pad zoals `werk/klanten`).
- **Bij een query: kijk eerst wat hij raakt.** Draai dezelfde query in `brain_find`, controleer aantal en titels, en verplaats dan pas. Maximaal 500 per aanroep.
- Groepen verplaatsen kan ook (`ids` met een `g_...`), alles erin gaat mee.

## Hernoemen en samenvoegen
- `rename_group` met `id` en `title` (de map krijgt de nieuwe naam).
- `merge` met `from` en `to`: alles uit `from` gaat naar `to` en de lege groep verdwijnt. Bij een naamsbotsing gebeurt er niets; hernoem eerst.
- Twee notities samenvoegen: `append` de inhoud van de ene aan de andere, link/verwijs, en archiveer de ene. Verwijder niet.

## Archiveren
`archive` en `restore` met `ids` of `query`. Archief blijft doorzoekbaar met `status:archived` maar zit niet meer in de weg. Een hele groep archiveren archiveert alles erin. **Archiveren is de standaardmanier om iets uit beeld te halen.**

## Verwijderen
- **Verwijder nooit uit jezelf.** Alleen als de gebruiker het uitdrukkelijk vraagt ("verwijder n_...", "gooi die groep weg"). Het is definitief: er is geen prullenbak.
- `delete` zonder `confirm` toont wat er weg zou gaan. Laat dat aan de gebruiker zien als de vraag niet heel precies was (bij een groep: hoeveel items).
- Pas dan `delete` met `confirm` met exact dezelfde id's. Alleen met `ids`, nooit met een query.
- Twijfel je tussen archiveren en verwijderen, archiveer en vraag.
