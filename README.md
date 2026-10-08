# FM – Sprachbox

**WhatsApp und Telegram in einer portablen Windows-App – mit getrennten Konten und eigenen Kontennamen.**

[Releases](https://github.com/Felox63/fm-sprachbox/releases) · [Fehler melden](https://github.com/Felox63/fm-sprachbox/issues) · [Sicherheit](SECURITY.md) · [Entwicklung](CONTRIBUTING.md)

> **Entwicklungsstand, keine Produktionsfreigabe:** Der zuletzt vom Nutzer auf Windows bestätigte Testbuild ist **0.3.1-p3**. Der aktuelle Quellstand enthält zusätzlich unfertige Paket-4-Funktionen. Insbesondere Benachrichtigungen und die Ungelesen-Anzeige sind noch nicht freigegeben. Erfolgreiche Unit-Tests ersetzen keine Windows-Laufzeitprüfung. Die Versionsnummer im Manifest bezeichnet noch die bisherige Basis und keine Freigabe des aktuellen Quellcodes.

## Funktionen des bestätigten Testbuilds

- WhatsApp Web und Telegram Web in einer gemeinsamen Oberfläche
- Mehrere Konten mit eigenen Namen und getrennten Browserprofilen
- Startseite zum Hinzufügen, Aktivieren und Deaktivieren von Konten
- Umbenennen sowie Entfernen von Konteneinträgen mit Bestätigung
- Einzelinstanz-Schutz: ein zweiter Start aktiviert das bestehende Fenster
- Anpassung der Messenger-Ansichten an Fenstergröße und Display-Skalierung
- Lokale Datenhaltung und Übernahme bestehender Daten beim Update

## Windows: starten und aktualisieren

1. Einen freigegebenen Windows-x64-Testbuild aus **Releases** auswählen. Release-Entwürfe sind nicht öffentlich verfügbar; es gibt derzeit keinen zugesicherten öffentlichen Download.
2. `FM-Sprachbox-win64.zip` in einen eigenen, beschreibbaren Ordner entpacken.
3. `FM - Sprachbox.exe` starten und die gewünschten Messenger anmelden.

**Update ohne Verlust der bisherigen Daten:**

1. App vollständig beenden – bei Tray-Builds auch den Hintergrundprozess.
2. Den gesamten `data`-Ordner separat sichern.
3. Neue ZIP in einen **neuen** Ordner entpacken und eine **Kopie** von `data` übernehmen.
4. Neue App testen; alten App-Ordner samt ursprünglichen Daten als Rückweg behalten.

Beim Entfernen eines Kontoeintrags bleiben dessen lokale Profildaten erhalten. Ein neu hinzugefügtes Konto erhält eine neue ID und verwendet diese Daten nicht automatisch wieder. Es gibt noch keine Oberfläche zur Wiederherstellung oder endgültigen Profilbereinigung.

## Datenschutz und Sicherheit

Der `data`-Ordner kann Cookies, Login-Sitzungen und weitere Messenger-Daten enthalten. **Wie Zugangsdaten behandeln:** nicht veröffentlichen, nicht an Fehlerberichte anhängen und nur geschützt sichern. Profile nur bei vollständig geschlossener App kopieren; keine Synchronisierung laufender Browserprofile über Netzlaufwerke oder Cloud-Ordner.

Ein Kopieren auf einen anderen Rechner garantiert **keine** Übernahme der Anmeldung: Windows- oder dienstseitige Bindungen können eine erneute Anmeldung erfordern. Konteneinstellungen werden nicht automatisch zwischen Geräten synchronisiert.

Die App nutzt die offiziellen Weboberflächen der Dienste. Sie ist keine zusätzliche Ende-zu-Ende-Verschlüsselungsschicht. Im Electron-Code sind Node-Integration deaktiviert sowie Context Isolation, Sandbox und Web Security aktiviert. Mikrofon, Kamera und Bildschirmfreigabe sind derzeit nicht freigegeben.

## Aktuelle Entwicklungsarbeiten

| Bereich | Status |
| --- | --- |
| Mehrkonten, Umbenennen, Entfernen, Einzelinstanz | Im Testbuild 0.3.1-p3 vom Nutzer auf Windows bestätigt |
| Externe HTTP/HTTPS-Links im Standardbrowser | Implementiert, weitere Regressionstests und Windows-Abnahme offen |
| Optionaler Tray-Modus | Fallback-Korrektur implementiert; unabhängige Review verlangt echte Lifecycle-Tests |
| Kontenbenachrichtigungen | Nicht freigegeben: Brücke und Datenschutz müssen korrigiert werden |
| Neue-Nachricht-Indikator | Noch offen; keine zuverlässigen Ungelesenzahlen zugesichert |

Der aktuelle Quellstand dient der Entwicklung und Sicherung. Bekannte offene Punkte stehen in [docs/STATUS.md](docs/STATUS.md). Keine automatischen Updates, keine signierte Produktionsdistribution und keine offizielle Unterstützung durch die Messenger-Anbieter.

## Aus dem Quellcode bauen

Voraussetzungen: **Node.js 22+**, npm und für die Laufzeitprüfung Windows x64.

```bash
npm ci --include=dev
npm run lint
npm run typecheck
npm run build
npm run test:unit
```

Build vor den Tests stellt sicher, dass auch die Tests der gebauten Preload-Dateien ausgeführt werden.

Windows-x64-Verzeichnis und ZIP erstellen:

```bash
npx electron-builder --win --x64 --dir
node scripts/zip-unpacked.mjs
npm run verify:package -- dist/FM-Sprachbox-win64.zip
```

Das Ergebnis liegt in `dist/FM-Sprachbox-win64.zip`. Eine Paketprüfung bestätigt die Struktur, nicht die Messenger-Funktion oder Anmeldung. Ein Cross-Build unter Linux ersetzt keine Windows-Abnahme. Zum lokalen Start nach dem Build: `npm run electron` (grafische Umgebung erforderlich).

## Architektur

- **Electron / TypeScript:** Main-Prozess und isolierte `WebContentsView` je Konto
- **React / Vite:** Startseite, Sidebar und Kontenverwaltung
- **Preload:** eingeschränkte IPC-Brücken zwischen Oberfläche und Main-Prozess
- **Portable Konfiguration:** `data/services.json` und separate Profile unter `data/profiles/`
- **Vitest / ESLint / TypeScript:** automatisierte Tests und statische Prüfungen

## Mitwirken und Lizenz

Siehe [CONTRIBUTING.md](CONTRIBUTING.md). Eigener Projektcode steht unter der [MIT-Lizenz](LICENSE). Drittanbieter-Komponenten und Logos unterliegen ihren jeweiligen Bedingungen; die MIT-Lizenz erteilt keine Markenrechte. Herkunft der Diensticons: [SOURCES.md](assets/service-icons/SOURCES.md).

**Inoffizielles Projekt von Felix mit Hermes als KI-Entwicklungspartner.** Keine Verbindung, Unterstützung oder Zertifizierung durch WhatsApp/Meta oder Telegram. Marken und Logos gehören ihren jeweiligen Rechteinhabern. Vor öffentlicher Distribution ist die Marken-/Asset-Nutzung gesondert zu prüfen.
