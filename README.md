# Indexicate

Indexicate oferă un GEO checker gratuit care verifică semnale tehnice publice de indexare, structură, metadata și securitate pentru un URL introdus de utilizator.

## Rulare locală

Instalați dependențele reproductibil și rulați suita de regresie:

```bash
npm ci --ignore-scripts
npm test
```

Funcțiile din `api/` sunt proiectate pentru runtime-ul Node.js din Vercel. Testele rulează local fără cereri către servicii interne și folosesc mock-uri pentru DNS, fetch și limiterul distribuit.

## Rate limiting distribuit

Endpointurile publice `/api/audit` și `/api/sitemap` verifică o limită Redis **înainte** de rezolvarea DNS sau orice fetch outbound. Politica implicită este o fereastră fixă de zece minute, cu maximum 12 audituri și două cereri sitemap per identificator de client pseudonimizat.

| Variabilă | Obligatorie | Rol |
|---|---:|---|
| `UPSTASH_REDIS_REST_URL` | Da | URL REST pentru instanța Redis distribuită |
| `UPSTASH_REDIS_REST_TOKEN` | Da | Token secret pentru Redis |
| `RATE_LIMIT_HMAC_SECRET` | Da | Secret pentru pseudonimizarea identificatorului de client |
| `RATE_LIMIT_AUDIT_MAX` | Nu | Valoare implicită `12` |
| `RATE_LIMIT_SITEMAP_MAX` | Nu | Valoare implicită `2` |
| `RATE_LIMIT_WINDOW_SECONDS` | Nu | Valoare implicită `600` |

Copiați `.env.example` în `.env` pentru dezvoltare locală și completați valorile reale doar în mediul local sau în setările Vercel. Nu comiteți fișiere `.env` sau secrete în GitHub.

Atunci când limita este depășită, endpointul răspunde `429` cu `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining` și `RateLimit-Reset`. Dacă providerul Redis este indisponibil sau configurarea lipsă, aplicația răspunde controlat cu `503` și nu pornește auditul costisitor. Evenimentele de blocare sunt emise ca loguri JSON fără IP brut, URL auditat sau conținutul paginii.

## Verificări automate

GitHub Actions rulează la fiecare `push` și `pull_request`. Workflow-ul instalează dependențele cu `npm ci`, verifică sintaxa modulelor API și rulează `npm test`.
