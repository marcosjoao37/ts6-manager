#### DISCLAIMER: 
![AI Assisted](https://img.shields.io/badge/AI%20Assisted-Project-00ADD8?style=for-the-badge&logo=dependabot&logoColor=white)

# TS6 Manager

[English](README.md) · [Français](README.fr.md) · **Deutsch** · [Español](README.es.md) · [Italiano](README.it.md)

Webbasierte Verwaltungsoberfläche für TeamSpeak-Server. Verwalten Sie virtuelle Server, Kanäle, Clients, Berechtigungen, Musik-Bots, automatisierte Abläufe und einbettbare Server-Widgets – alles im Browser. Die Oberfläche ist auf **Englisch, Französisch, Deutsch, Spanisch und Italienisch** verfügbar.

## Was diese Version ändert

Eine robuste, auf Zuverlässigkeit ausgerichtete Weiterentwicklung von [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager):

**Konten & Zugriff**
- Zwei-Faktor-Authentifizierung (TOTP) mit Einmal-Wiederherstellungscodes; Administratoren können MFA pro Benutzer erzwingen und beim nächsten Anmelden eine Passwortänderung verlangen
- Option „Vertrauenswürdiger Computer": Passwort **und** MFA auf einem gewählten Gerät für 30 Tage per widerrufbarem `httpOnly`-Cookie überspringen, mit einer Geräteliste, die vom Konto aus widerrufbar ist
- Konfigurierbares Passwortrichtlinien-System (Mindestlänge + Komplexität)

**Discord-Integration**
- Discord-Bridge: Slash-Befehle (`/play`, `/skip`, `/queue`, …), TeamSpeak-Verbindungs-/Trennbenachrichtigungen und Anwesenheitsmeldungen sowie ein Live-Serverstatistik-Panel
- Der Musik-Bot kann auch in einen Discord-Sprachkanal streamen
- Einschränkung, welche Discord-Rollen die Bot-Befehle ausführen dürfen

**Mehrsprachigkeit**
- Vollständige UI-Übersetzung in Englisch, Französisch, Deutsch, Spanisch und Italienisch, je Benutzer gespeichert

**Spotify & Journal**
- Spotify-Links werden für die Wiedergabe zu YouTube aufgelöst, konfigurierbar in der WebUI
- Verbindungsjournal für Web- und TeamSpeak-Anmeldungen mit Offline-GeoIP, sortierbaren/filterbaren Spalten und Einzel-Klick-IP-Sperren (Web und/oder TeamSpeak)

**Zuverlässigkeit**
- Selbstheilender Verbindungspool: Im UI hinzugefügte oder bearbeitete Serververbindungen funktionieren sofort – kein Backend-Neustart erforderlich
- WebQuery-Client baut seinen Transport neu auf, wenn der Keep-Alive-Socket still stirbt (Docker NAT, Server-Neustarts), mit einem Circuit Breaker, der den TS-Flood-Zähler nicht weiter belastet
- Dashboard-Antworten werden 5 Sekunden serverseitig gecacht: N offene Tabs kosten so viel wie einer
- Eine nicht entschlüsselbare Credential-Zeile bringt den Start nicht mehr zum Absturz

**Musik-Bots**
- Gestreamte Datei-Wiedergabe: erstes Audio nach ~200 ms, konstanter Speicherbedarf (zuvor wurde der gesamte Track in den RAM dekodiert – ~690 MB für einen 1-Stunden-Mix)
- Nativer Opus-Encoder (`@discordjs/opus`, ~5–10× weniger CPU) mit automatischem WASM-Fallback
- Robuste yt-dlp-Pipeline: harte Timeouts, Bereinigung veralteter Artefakte, deduplizierte parallele Downloads, vollständiges Fehler-Logging, niedrige CPU-Priorität, automatisches Update beim Container-Start
- „Laden & Abspielen" startet die Wiedergabe; Playlist-Songzahlen bleiben aktuell

**Sicherheit**
- Eingebauter sicherer Ausdrucksauswerter ersetzt das nicht mehr gewartete `expr-eval`
- Sidecar-API Bearer-Token-Authentifizierung, gehärtete Container, committete Binärdateien entfernt
- Abhängigkeiten aktualisiert, um alle Audit-Befunde zu beheben; ESLint + GitHub Actions CI

**Deployment**
- `docker compose up -d --build` baut standardmäßig aus dem Quellcode (`docker-compose.hub.yml` für die vorgelagerten Docker-Hub-Images)
- nginx/Client-Timeouts für lange YouTube-Downloads ausgelegt; stiller, sauberer Container-Start

Basiert auf der **WebQuery HTTP API** (dem ServerQuery-Ersatz in modernen TeamSpeak-Builds). Telnet wird nicht verwendet und nicht unterstützt.

![License](https://img.shields.io/badge/license-MIT-blue)

## Demnächst verfügbar

- **SSO via SAML** — Single Sign-On gegen Ihren Identity Provider (Okta, Entra ID, Keycloak, Google Workspace, …), sodass sich Benutzer mit ihrem Organisationskonto anmelden können.

## Screenshots

### Dashboard
Live-Übersicht Ihres Servers: Online-Benutzer, Kanalanzahl, Laufzeit, Ping, Bandbreitengraph und Serverauslastung auf einen Blick.

![Dashboard](docs/dashboard.png)

### Musik-Bots
Betreiben Sie mehrere Musik-Bots pro Server. Jeder Bot hat seine eigene Warteschlange, Lautstärkeregelung und Wiedergabestatus. Unterstützt Radio-Streams, YouTube und eine lokale Musikbibliothek. Benutzer im Kanal des Bots können ihn per Textbefehlen steuern (`!radio`, `!play`, `!vol`, usw.).

![Music Bots](docs/musicbots.png)

### Bot-Flow-Engine
Visueller, knotenbasierter Editor zum Erstellen automatisierter Server-Workflows. Ziehen Sie Trigger, Bedingungen und Aktionen auf die Arbeitsfläche, verbinden Sie sie und aktivieren Sie den Ablauf. Unterstützt TS3-Ereignisse, Cron-Zeitpläne, Webhooks und Chat-Befehle als Trigger.

![Flow Editor](docs/flow-editor.png)

### Flow-Vorlagen
Starten Sie schnell mit vorgefertigten Flow-Vorlagen. Deckt häufige Anwendungsfälle ab: temporäre Kanalerstellung, AFK-Mover, Inaktivitäts-Kicker, Online-Zähler und Gruppenschutz. Ein Klick zum Importieren, dann nach Bedarf anpassen.

![Flow Templates](docs/flow-templates.png)

## Funktionen

### Authentifizierung & Konten
- Einrichtungsassistent für das erste Admin-Konto (keine Standard-Anmeldedaten)
- Zwei-Faktor-Authentifizierung (TOTP), kompatibel mit jeder Authenticator-App, mit Einmal-Wiederherstellungscodes
- Administratoren können MFA pro Benutzer erzwingen und eine Passwortänderung beim nächsten Anmelden verlangen
- Option „Vertrauenswürdiger Computer": ein widerrufbares 30-Tage-Cookie, das Passwort und MFA auf dem jeweiligen Gerät überspringt; vertrauenswürdige Geräte werden aufgelistet und sind vom Konto aus widerrufbar
- Konfigurierbares Passwortrichtlinien-System (Mindestlänge + Komplexität)
- Sprachauswahl der UI pro Benutzer (Englisch, Französisch, Deutsch, Spanisch, Italienisch)

### Serververwaltung
- Dashboard mit Live-Serverstatistiken, Bandbreitengraph und Kapazitätsübersicht
- Virtuelle Serverliste mit Start-/Stopp-Steuerung
- Kanalbaum mit Drag-and-Drop-Sortierung
- Client-Liste mit Kick-, Ban-, Verschiebe- und Poke-Aktionen
- Verwaltung von Server- und Kanalgruppen
- Berechtigungseditor (Server-, Kanal-, Client- und Gruppenebene)
- Verwaltung der Banliste
- Token-/Privilegienschlüsselverwaltung
- Beschwerde-Anzeige
- Offline-Nachrichtensystem
- Server-Protokollbetrachter mit Filterung
- Kanaldatei-Browser mit Upload/Download
- Instanz-weite Einstellungen

### Musik-Bots
- Mehrere Bots pro Server, jeder mit eigenständiger Warteschlange und Wiedergabe
- Radio-Station-Streaming mit ICY-Metadaten und Live-Titelupdates
- YouTube-Wiedergabe via yt-dlp (Suche, Download, Warteschlange)
- Spotify-Link-Unterstützung (Track-/Album-/Playlist-Metadaten zu YouTube aufgelöst)
- Musikbibliotheksverwaltung (Upload, Organisation, Playlists)
- Lautstärkeregelung, Pause, Überspringen, Zurück, Zufallswiedergabe, Wiederholen
- Stereo-Audio-Unterstützung mit stabilem 20-ms-Takt
- Automatische Wiederverbindung mit exponentiellem Backoff bei Verbindungsabbruch
- Textbefehle im Kanal für freihändige Steuerung
- Verlaufsverfolgung von Musikanfragen

### Discord-Integration
- Discord-Bridge-Bot mit Slash-Befehlen: `/play`, `/stop`, `/pause`, `/skip`, `/next`, `/prev`, `/queue`, `/volume`, `/nowplaying`, `/stats`, `/join`, `/leave`
- Befehle auf ausgewählte Discord-Rollen beschränken (Admins/Owner immer erlaubt; leer = offen für alle)
- TeamSpeak-Verbindungs-/Trennbenachrichtigungen und kanalspezifische Anwesenheitsmeldungen, mit Embed- oder Nur-Text-Stil und optionalem automatischen Löschen
- Live-Serverstatistik-Panel, das in einem Discord-Kanal aktuell gehalten wird
- Der Musik-Bot kann sein Audio in einen Discord-Sprachkanal streamen
- Discord-Nachrichten-Trigger und Nachricht-senden-Aktion in der Bot-Flow-Engine verfügbar

### Video-Streaming
- Live-Video-Streaming von YouTube, Twitch oder direkten URLs in TeamSpeak-Kanäle
- WebRTC-basiert mit Go-Sidecar-Relay (Pion) für latenzarme Übertragung
- Qualitätsstufen (480p, 720p, 1080p)
- Browser-interne Vorschau mit WebRTC-Wiedergabe
- A/V-Synchronisation via RTCP Sender Reports
- Läuft als Docker-Sidecar-Container neben dem Backend

### Bot-Flow-Engine
- Visueller Flow-Editor mit Drag-and-Drop-Knotenarbeitsfläche
- Trigger: TS3-Ereignisse, Cron-Zeitpläne, Webhooks (mit Pflichtgeheimnissen), Chat-Befehle (global oder kanalspezifisch), Discord-Nachrichten
- Aktionen: Kick, Ban, Verschieben, Nachricht, Poke, Kanal erstellen/bearbeiten/löschen, HTTP-Anfragen, WebQuery-Befehle, Discord-Nachrichten
- Bedingungen, Variablen, Verzögerungen, Schleifen, Protokollierung
- Animierte Kanalnamen (rotierender Text auf einem Timer)
- Platzhaltersystem mit Filtern und Ausdrücken
- Vorgefertigte Vorlagen für häufige Automatisierungsaufgaben

### Verbindungsjournal
- Erfasst Web- und TeamSpeak-Anmeldungen mit Zeitstempel, Benutzername und IP
- Offline-GeoIP-Anreicherung (keine externen Aufrufe)
- Sortierbare Spalten und spaltenweise Filter
- Einzel-Klick-IP-Sperre aus dem Journal – für die Web-App, den TeamSpeak-Server oder beides

### Server-Widgets
- Einbettbares Server-Status-Banner für Websites und Foren
- Token-basierter öffentlicher Zugriff (keine Authentifizierung erforderlich)
- Verfügbar als Live-Seite, SVG oder PNG-Bild
- Dunkles und helles Design
- Konfigurierbar: Kanalbaum und Client-Liste ein-/ausblenden

### Sicherheit
- AES-256-GCM-Verschlüsselung für gespeicherte Anmeldedaten (API-Schlüssel, SSH-Passwörter)
- Zwei-Faktor-Authentifizierung (TOTP) mit Wiederherstellungscodes; vom Administrator pro Benutzer erzwingbar
- Konfigurierbares Passwortrichtlinien-System und erzwungene Passwortänderung beim nächsten Anmelden
- SSRF-Schutz für alle ausgehenden HTTP-Anfragen, FFmpeg-URLs und Webhook-Weiterleitungen
- Rate-Limiting auf Authentifizierungsendpunkten
- JWT-Zugriffstoken + Refresh-Token-Rotation mit Wiederverwendungserkennung
- Rollenbasierte Zugriffskontrolle (Admin / Betrachter)
- Serverspezifische Zugriffskontrolle für Mehrmandanten-Setups
- Discord-Befehlszugriff per Rolle eingeschränkt
- WebQuery-Befehlsallowlist in Bot-Flows (blockiert destruktive Befehle)
- Authentifizierte WebSocket-Verbindungen

### Einstellungen & Administration
- Benutzerverwaltung mit MFA-Erzwingung und erzwungener Passwortänderung
- Discord-, Spotify- und YouTube-Integrationseinstellungen
- yt-dlp-Cookie-Datei-Verwaltung für den Zugriff auf altersbeschränkte oder mitgliedspflichtige YouTube-Inhalte (Datei hochladen oder direkt in der UI einfügen)
- Verbindungsjournal und IP-Sperrverwaltung
- Nur für Administratoren zugängliches Einstellungspanel

## Architektur

```
┌──────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Frontend   │────▶│   Backend    │────▶│  TS Server      │
│  React SPA   │     │  Express API │     │  WebQuery HTTP  │
│  nginx :8080 │     │  Node :3001  │     │  SSH (events)   │
└──────────────┘     └──────┬───────┘     └─────────────────┘
                            │
                     ┌──────┴───────┐
                     │   SQLite     │
                     │   (Prisma)   │
                     └──────────────┘
                            │
                     ┌──────┴───────┐
                     │   Sidecar    │
                     │  Go/Pion     │
                     │  WebRTC :9800│
                     └──────────────┘

Public:  /widget/:token  ──▶  SVG / PNG / JSON (no auth)
```

**Vier Pakete** in einem pnpm-Monorepo:

| Paket | Beschreibung |
|-------|--------------|
| `@ts6/common` | Gemeinsam genutzte Typen, Konstanten, Hilfsfunktionen |
| `@ts6/backend` | Express API, WebQuery-Client, Bot-Engine, Voice-Bots, Discord-Bridge, Widgets |
| `@ts6/frontend` | React SPA mit Vite, TailwindCSS, shadcn/ui |
| `sidecar` | Go WebRTC Media-Relay (Pion) für Video-Streaming |

Das Backend vermittelt alle TeamSpeak-API-Aufrufe. Das Frontend hat niemals direkten Zugriff auf API-Schlüssel oder Server-Anmeldedaten.

## Tech Stack

**Frontend:** React 18, Vite, TailwindCSS, shadcn/ui, TanStack Query + Table, React Flow, Recharts, Zustand, react-i18next

**Backend:** Node.js, Express, Prisma (SQLite), JWT-Authentifizierung, TOTP MFA, WebQuery HTTP-Client, SSH-Ereignis-Listener, discord.js

**Voice/Audio:** Benutzerdefinierter TS3-Voice-Protokoll-Client (UDP), Opus-Kodierung, FFmpeg, yt-dlp

**Video-Streaming:** Go-Sidecar mit Pion WebRTC v4, RTCP Sender Reports für A/V-Sync

## Schnellstart (Docker)

Das Bauen aus dem Quellcode ist in diesem Fork die Standardeinstellung – `docker-compose.yml`
baut die drei Images lokal. Um stattdessen die vorgelagerten Docker-Hub-Images zu verwenden,
nutzen Sie [`docker-compose.hub.yml`](docker-compose.hub.yml) (Hinweis: diese Images enthalten
nicht die Härtungen und Bugfixes dieses Forks).

1. Repository klonen
2. Eine `.env`-Datei im Repository-Stammverzeichnis erstellen:

```env
JWT_SECRET=your-random-secret-at-least-32-characters
ENCRYPTION_KEY=another-random-secret-for-credential-encryption
SIDECAR_TOKEN=a-third-random-secret-for-the-media-sidecar
```

Sichere Werte generieren:

```bash
echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "SIDECAR_TOKEN=$(openssl rand -base64 32)" >> .env
```

3. Stack bauen und starten:

```bash
docker compose up -d --build
```

4. `http://localhost:3000/setup` öffnen und das Admin-Konto erstellen
5. Anmelden, dann die TeamSpeak-Serververbindung unter **Einstellungen → Verbindungen** hinzufügen (Host, WebQuery-Port, API-Schlüssel)

> `JWT_SECRET` ist **erforderlich** – das Backend verweigert im Produktionsbetrieb den Start ohne diesen Wert.
> `ENCRYPTION_KEY` ist **im Produktionsbetrieb erforderlich** und muss sich von `JWT_SECRET` unterscheiden. Vor dieser Anforderung verschlüsselte Werte (mit dem `JWT_SECRET`-Fallback) sind weiterhin lesbar und werden beim nächsten Speichern neu verschlüsselt.
> `SIDECAR_TOKEN` authentifiziert das Backend gegenüber der Media-Sidecar-API. Ohne diesen Wert protokolliert der Sidecar eine Warnung und akzeptiert nicht authentifizierte Anfragen (nur in einem isolierten Netzwerk akzeptabel).

### Vorgelagerte Docker-Hub-Images verwenden

```bash
docker compose -f docker-compose.hub.yml up -d
```

Die Hub-Images lauschen auf anderen internen Ports als die lokal gebauten –
mischen Sie niemals Container aus beiden Compose-Dateien im selben Stack.

### Coolify / Reverse Proxy

Verwenden Sie [`docker-compose.coolify.yml`](docker-compose.coolify.yml) als Ausgangspunkt. Wesentliche Unterschiede zur Standard-Compose-Konfiguration:

- Kein `ports`-Abschnitt – der Reverse Proxy übernimmt das Routing
- Legen Sie die Domain am **Frontend**-Dienst in Coolify fest (Port 8080 – nginx läuft ohne Root-Rechte)
- Wenn Ihr TS-Server in einem separaten Docker-Netzwerk läuft, fügen Sie es als externes Netzwerk am Backend-Dienst hinzu:

```yaml
services:
  backend:
    networks:
      - ts6-network
      - ts-server-net

networks:
  ts-server-net:
    external: true
    name: your-ts-server-network-id
```

## Entwicklung

Voraussetzungen: Node.js 20+, pnpm 9+

```bash
pnpm install
pnpm dev          # starts backend + frontend in parallel
```

Backend läuft auf `:3001`, Frontend auf `:5173` (Vite Dev-Server).

### Datenbank

Prisma mit SQLite. Beim ersten Start:

```bash
cd packages/backend
npx prisma migrate deploy
```

Die Docker-Images führen Migrationen beim Start automatisch durch.

## Umgebungsvariablen

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `JWT_SECRET` | — | **Erforderlich.** Geheimnis für JWT-Signierung. Muss im Produktionsbetrieb gesetzt sein. |
| `ENCRYPTION_KEY` | — | **Im Produktionsbetrieb erforderlich**, muss sich von `JWT_SECRET` unterscheiden. Dedizierter Schlüssel für AES-256-GCM-Credential-Verschlüsselung. In der Entwicklung fällt es auf `JWT_SECRET` zurück. |
| `PORT` | `3001` | Backend-Port |
| `DATABASE_URL` | `file:./data/ts6webui.db` | SQLite-Datenbankpfad |
| `JWT_ACCESS_EXPIRY` | `15m` | Lebensdauer des Zugriffstokens |
| `JWT_REFRESH_EXPIRY` | `7d` | Lebensdauer des Refresh-Tokens |
| `FRONTEND_URL` | `http://localhost:3000` | CORS-Ursprung |
| `MUSIC_DIR` | `/data/music` | Verzeichnis für heruntergeladene Musikdateien |
| `SIDECAR_URL` | — | Optional. Vollständige URL des WebRTC-Sidecar-Dienstes (z. B. `http://ts6-sidecar:9800`). In Docker setzen, wenn der Sidecar als separater Container läuft. |
| `SIDECAR_TOKEN` | — | Gemeinsames Geheimnis zwischen Backend und Sidecar. Der Sidecar lehnt API-Aufrufe ohne `Authorization: Bearer <token>` ab, wenn gesetzt. |
| `SIDECAR_LISTEN_ADDR` | `127.0.0.1` | Interface, an das die Sidecar-API gebunden wird (`0.0.0.0` innerhalb von Docker, vom Image gesetzt). Port 9800 niemals veröffentlichen. |
| `YT_COOKIE_FILE` | — | Optional. Pfad zu einer Netscape-Format-cookies.txt-Datei für yt-dlp. Kann auch über **Einstellungen → YouTube** in der UI verwaltet werden. |

## Umgebungsvariablen Sidecar (Video-Streaming)

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `VIDEO_QUEUE_SIZE` | `2048` | Größe der Video-RTP-Warteschlange |
| `AUDIO_QUEUE_SIZE` | `4096` | Größe der Audio-RTP-Warteschlange |
| `SYNC_PLAYOUT_BUFFER_MS` | `4` | Kleiner Playout-Puffer für die adaptive Taktlogik |
| `SYNC_VIDEO_BIAS_MS` | `4` | Optionaler zusätzlicher Holdback für Video zur Feinabstimmung der Synchronisation |
| `AUDIO_DELAY_MS` | `0` | Legacy-/manueller Audio-Delay-Option. Mit der aktuellen Taktlogik wird typischerweise 0 erwartet |
| `SIDECAR_DEBUG_LOGS` | `1` | Aktiviert ausführliches Debug-Logging für hochfrequente Laufzeitdetails |
| `VIDEO_READ_RTP_BUFFER` | `4194304` | UDP-OS-Socketpuffer für den Video-Port |
| `AUDIO_READ_RTP_BUFFER` | `1048576` | UDP-OS-Socketpuffer für den Audio-Port |
| `VIDEO_BUFSIZE` | `1M` | FFmpeg Video-Puffer |

## Musik-Bot-Textbefehle

Wenn ein Musik-Bot mit einem Kanal verbunden ist, können Benutzer in diesem Kanal ihn per Chat steuern:

| Befehl | Beschreibung |
|--------|--------------|
| `!radio` | Verfügbare Radiosender auflisten |
| `!radio <id>` | Einen Radiosender abspielen |
| `!play <url>` | Von YouTube-URL abspielen |
| `!play` | Pausierte Wiedergabe fortsetzen |
| `!stop` | Wiedergabe stoppen |
| `!pause` | Pause ein-/ausschalten |
| `!skip` / `!next` | Nächster Titel in der Warteschlange |
| `!prev` | Vorheriger Titel |
| `!vol` | Aktuelle Lautstärke anzeigen |
| `!vol <0-100>` | Lautstärke setzen |
| `!np` | Aktuellen Titel anzeigen |

## Anforderungen

- TeamSpeak-Server mit aktiviertem **WebQuery HTTP** (kein Raw-/Telnet-Modus)
- WebQuery-API-Schlüssel (generiert via `apikeyadd` oder Server-Admin-Tools)
- SSH-Zugriff auf den TS-Server (nur für Bot-Flow-Ereignis-Trigger benötigt)
- `yt-dlp` und `ffmpeg` auf dem Backend installiert (im Docker-Image enthalten)



## Lizenz

MIT
