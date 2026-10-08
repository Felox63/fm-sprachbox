# Mitwirken

Bitte vor einer größeren Änderung ein Issue zur Abstimmung eröffnen. Kleine, klar abgegrenzte Änderungen sind leichter zu prüfen als mehrere Funktionspakete gleichzeitig.

## Lokale Prüfungen

Node.js 22+ und npm installieren, anschließend:

```bash
npm ci --include=dev
npm run lint
npm run typecheck
npm run build
npm run test:unit
```

Tests müssen echte Produktionsfunktionen und registrierte Handler ausführen. Im Test kopierte Produktlogik ist kein belastbarer Regressionstest. Messenger-Anmeldung, Tray, Notifications und DPI-Verhalten separat auf Windows prüfen und nicht aus grünen Unit-Tests ableiten.

## Pull Requests

- Ziel, Änderungen, tatsächliche Prüfergebnisse und Grenzen nennen.
- Keine Profile, Cookies, QR-Codes, persönlichen Nachrichten, Schlüssel oder `.env`-Dateien committen.
- Bestehende Profilpfade und stabile Konto-IDs erhalten; Datenmigrationen benötigen Backup und Schutz vor unbekannten neueren Konfigurationsversionen.
- Sandbox, Navigation, Berechtigungen und IPC-Validierung nicht lockern.
- Keine Screenshots mit privaten Inhalten. Screenshots nur mit neutralen Testdaten.
- Abhängigkeiten und Assets mit Herkunft und Lizenz dokumentieren.
