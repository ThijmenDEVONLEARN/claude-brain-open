# web

De heelal-UI (alleen kijken en zoeken; verwijderen komt in M9). Gewone TypeScript op een canvas 2D, gebundeld met esbuild
en door dezelfde server geserveerd als statische bestanden (`/` en `/assets/*`). Geen React of Three.js: het ontwerp uit M7 is
een eigen perspectiefprojectie, en het samenvoegen (LOD) houdt het tekenwerk klein.

```
pnpm build:web        # schrijft apps/web/dist (app.js, style.css, index.html)
brain open            # opent de UI met het inlogcookie
```

| Bestand | Wat |
|---|---|
| `src/app.ts` | toestand, de drie lagen (groepen, subgroepen, items), menu's, zoeken, muis en toetsen |
| `src/draw.ts` | tekenhulpjes: melkweg (plaatje per groep), planetenstelsel, banen, bundels, labels |
| `src/lib.ts` | pure rekenfuncties: indelingen, banen per soort, zoomniveaus (LOD), camera. Getest. |
| `src/markdown.ts` | veilige markdown voor het zijpaneel (DOM met textContent, nooit innerHTML). Getest. |
| `src/settings.ts` | weergave-instellingen in localStorage (nooit op de server) |

Veiligheid: de pagina krijgt een CSP zonder inline scripts of externe bronnen; links in notities mogen alleen `brain:` of `https:` zijn;
afbeeldingen komen alleen uit de eigen kluis via `/api/image/:id` en alleen in het zijpaneel, nooit in het heelal.
