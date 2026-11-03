# Wijzigingen

## 0.1.0 (1 november 2026)

Eerste versie. Alles draait lokaal; de kluis staat in `%USERPROFILE%\ClaudeBrain\`.

- **Kluis en index** (M0, M1): markdown en afbeeldingen op schijf, SQLite FTS5-index die altijd opnieuw op te bouwen is (`brain rebuild`; 300.000 notities in ~75 s).
- **Claude-tools** (M2, M3, M4): `brain_map`, `brain_find` (eigen querytaal), `brain_read`, `brain_related`, `brain_write`, `brain_organize`, `brain_image`; token verplicht, audit log, bestandswatcher, verwijderen alleen met bevestiging.
- **Claude Code-plugin** (M5): skills en commando's, `brain`-launcher, één-stap-installatie.
- **Windows** (M6): `brain doctor`, `brain install-autostart`, `brain open`.
- **Heelal-UI** (M7, M8, M9): overzicht, groepen en items in 3D, zoeken, dashboard ("waar was ik"), logboek, live updates, verwijderen door jou (cookie plus eigen Origin).
- **Metingen** (M10): `scripts/bench-e2e.ts` en de cijfers in [docs/benchmarks.md](docs/benchmarks.md).

Nog niet gebouwd: `brain_stats`, een controle op trage queries in `brain doctor`, `brain token rotate`, een installer (.exe), verbeteringen aan de groepsweergave.
