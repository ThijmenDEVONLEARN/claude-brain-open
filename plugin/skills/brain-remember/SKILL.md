---
name: brain-remember
description: Use when the user says "onthoud dit", "sla dit op", "remember this", "voeg toe aan mijn brein", or when you learn something durable (a decision, a how-to, a fact about the user's work) that a later session would need. Stores it in Claude Brain without creating duplicates.
---

# Onthouden in het brein

## Eerst zoeken, dan schrijven
1. `brain_find` op het onderwerp (en op `kind:image` bij plaatjes). Bestaat het al, **vul dat aan** met `brain_write append` (of `replace_section` als iets achterhaald is) in plaats van een nieuwe notitie te maken.
2. Bestaat het niet, maak een nieuwe met `brain_write create`. De server waarschuwt als de titel op een bestaande lijkt (`! lijkt op n_...`). Neem die waarschuwing serieus: kijk wat er staat en vul dan liever aan.

## Een goede notitie
- **title:** kort en zoekbaar, zoals je het over een jaar zou intikken. Geen datum in de titel.
- **summary:** één zin, liefst onder 200 tekens: wat staat erin en waarvoor is het nuttig. Hierop kiest een latere Claude zonder de notitie te openen.
- **body:** markdown met `## kopjes`. Eén onderwerp per notitie. Kopjes zijn wat zoeken tot op sectieniveau mogelijk maakt, dus gebruik ze.
- **tags:** kleine letters, hiërarchisch met `/` (`project/claude-brain`). Kijk met `brain_map group=...` welke tags er al zijn en hergebruik die.
- **group:** kies de best passende bestaande groep (`brain_map`). Past niets, gebruik de brain-organize skill om er een te maken. Geen group opgeven plaatst de notitie in de wortel; doe dat alleen bewust.
- **links:** verwijs naar wat er al is: `links` bij `create`, of later `brain_write link` met `link_type` (`relates_to`, `depends_on`, `supersedes`, `contradicts`, `source_of`, `illustrated_by`). In de tekst kan `[tekst](brain:n_xxxxxxxx)`.

## Afbeeldingen
`brain_image` met `source` (pad) of `base64`, altijd met een beschrijving in `summary`: daarop wordt later gezocht. Link het plaatje aan de notitie waar het bij hoort.

## Niet opslaan
Wachtwoorden, API-sleutels, tokens en andere geheimen. Alles wat je leest gaat later als onderdeel van een gesprek naar de Claude-API.

## Afronden
Meld de gebruiker in één regel wat je deed: id, titel en groep. Heb je een aanname gedaan over de groep of een samenvoeging, noem die.

Bij een bewerking op een notitie die je eerder las kun je `if_rev` meegeven (de `rev` uit `brain_read`). Bij `ERROR conflict` is er intussen iets veranderd: lees opnieuw en pas aan.
