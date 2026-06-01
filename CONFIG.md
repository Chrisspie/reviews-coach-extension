# Konfiguracja rozszerzenia

Rozszerzenie korzysta z generatora konfiguracji. Nie edytujesz juz recznie `config.json` ani `manifest.json` w katalogu rozszerzenia. Zamiast tego ustawiasz wartosci w plikach `.env`, a build tworzy gotowy pakiet w `dist/`.

## Pliki `.env`

- `.env.extension.local` - konfiguracja lokalna
- `.env.extension.prod` - konfiguracja produkcyjna
- `.env.extension.example` - szablon dla nowych srodowisk

Obslugiwane zmienne:

```dotenv
EXTENSION_PROXY_BASE=https://proxy.twojadomena.com
EXTENSION_UPGRADE_URL=https://twojadomena.com/#plany
EXTENSION_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
EXTENSION_LICENSE_KEY=
EXTENSION_NAME_PREFIX=
```

Pole `EXTENSION_LICENSE_KEY` jest opcjonalne. Jesli je ustawisz, rozszerzenie wysle `licenseKey` do `/api/extension/session` i pominie logowanie magic link.

Pole `EXTENSION_NAME_PREFIX` jest opcjonalne. Jesli je ustawisz, build dopisze prefix do nazwy rozszerzenia w kazdym locale, np. `EXTENSION_NAME_PREFIX="DEV - "` dla lokalnego builda.

## Build

1. Ustaw wartosci w odpowiednim pliku `.env.extension.*`.
2. Uruchom `npm run build:extension:local` albo `npm run build:extension:prod`.
3. Zaladuj rozszerzenie z katalogu `dist/local` albo `dist/prod`.

Build generuje:

- `config.json` z `proxyBase`, `upgradeUrl`, `licenseKey` i `googleClientId`
- `manifest.json` z poprawnym `host_permissions` dla backendu

## Po nowym produkcyjnym buildzie / zmianie Chrome Extension ID

Jesli nowy produkcyjny build ma inne Chrome Extension ID niz poprzedni build, trzeba zaktualizowac dwa miejsca zanim logowanie Google zacznie dzialac:

1. Google Cloud Console, OAuth client uzywany przez wtyczke:
   - dodaj `Authorized redirect URI`:
     `https://<CHROME_EXTENSION_ID>.chromiumapp.org/provider_cb`
   - upewnij sie, ze `EXTENSION_GOOGLE_CLIENT_ID` w `.env.extension.prod` wskazuje na OAuth client, w ktorym dodales ten redirect URI.

2. Backend w Azure App Service, zmienne srodowiskowe:
   - ustaw `EXTENSION_ID=<CHROME_EXTENSION_ID>`
   - upewnij sie, ze `GOOGLE_CLIENT_IDS` zawiera `EXTENSION_GOOGLE_CLIENT_ID` z produkcyjnego builda
   - jesli `CORS_ORIGINS` jest ustawione recznie, dodaj tez `chrome-extension://<CHROME_EXTENSION_ID>` albo polegaj na `EXTENSION_ID`, bo backend sam dodaje ten origin do CORS.

Po zmianie env vars w Azure zrestartuj backend. Objawem brakujacego `EXTENSION_ID` albo originu CORS jest blad w konsoli wtyczki podobny do:

```text
Proxy auth HTTP 403
Invalid CORS request
POST /api/extension/session
```
