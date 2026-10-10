# Mitwirken

Danke für deine Unterstützung! Fehlerberichte, Ideen, Windows-Tests, Dokumentation und Codebeiträge sind willkommen. Größere Änderungen bitte zuerst in einem Issue abstimmen.

## Entwickeln

Node.js 22+ und npm:

```bash
npm ci --include=dev
npm run lint
npm run typecheck
npm run build
npm run test:unit
```

Der GitHub-Quellstand entspricht noch nicht vollständig dem aktuellen Download; siehe [Status](docs/STATUS.md).

## Pull Requests

- Kleine, klar abgegrenzte Änderung mit Beschreibung und tatsächlichen Testergebnissen.
- Echte Produktionspfade testen; Messenger-Funktionen zusätzlich auf Windows prüfen.
- Keine Anmeldedaten, Profile, privaten Nachrichten oder Schlüssel einchecken.
- Bestehende Konten und Profile erhalten; Sicherheitsgrenzen nicht lockern.
- Neue Assets und Abhängigkeiten mit Herkunft und Lizenz dokumentieren.

## Bei jedem Release

README, Roadmap, Downloadlink und technischen Status zusammen mit den kurzen Release-Notizen aktualisieren. Abgeschlossene Punkte aus der Roadmap entfernen. Bekannte Grenzen im technischen Status dokumentieren, nicht die Startseite damit überladen.
