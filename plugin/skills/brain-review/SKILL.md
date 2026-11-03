---
name: brain-review
description: Use when the user asks to review, clean up or maintain Claude Brain ("loop het brein na", "ruim het brein op", "onderhoud", weekly review). Finds orphans, broken files, stale or duplicate notes and proposes fixes.
---

# Onderhoud van het brein

Doe dit stap voor stap en stel veranderingen voor aan de gebruiker voordat je grote dingen doet. Niets definitief verwijderen.

1. **Overzicht:** `brain_map`, dan per grote groep `brain_map group=...`.
2. **Kapotte bestanden:** `brain_find` met `status:broken`. Die kun jij niet repareren; vertel de gebruiker welke en waarom (de reden staat erbij). Niet zelf aan de bestanden zitten.
3. **Wezen:** `brain_find` met `-has:links kind:note` (notities zonder links). Zoek bij elke een plek: link naar een verwante notitie of zet een `parent`.
4. **Oud:** `brain_find` met `updated:<2026-01-01 sort:updated` (pas de datum aan). Stel voor wat naar het archief kan; archiveer pas na akkoord, in één `brain_organize archive` met een query of ids.
5. **Dubbelen:** zoek op titelwoorden van notities die op elkaar lijken. Voeg samen door aan te vullen en de overbodige te archiveren.
6. **Samenvattingen:** lees de `outline` van notities waarvan de samenvatting (in `brain_find`) niet meer klopt en werk bij met `brain_write set_meta`.
7. **Rapport:** korte lijst met wat je deed en wat je de gebruiker voorstelt, met id's.
