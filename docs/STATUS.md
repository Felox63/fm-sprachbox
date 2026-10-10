# Technischer Stand

## Release 1.1

Mehrkonten, Tray, externe Links, Benachrichtigungen mit Datenschutz und Neue-Nachricht-Punkt sind unter Windows von Felix bestätigt. Der veröffentlichte Download ist die unveränderte, getestete Alpha-4-ZIP.

- Interne Appversion: `1.1.0-alpha.4` (Releasebezeichnung: 1.1).
- 335 automatisierte Tests; separat 25 Electron-Produktionspfadprüfpunkte. Lint, Typecheck, Build und Paketprüfung bestanden.
- SHA-256: `2063b8cb3ba7b1fd6f21031e75e3e09b3af86b8a5fa6732d9885c0e1d6821ded`.

## Grenzen und offene technische Themen

- **Quellzuordnung:** Der GitHub-Quellstand ist älter als der Download. Tags und automatische Sourcearchive reproduzieren die veröffentlichten ZIPs nicht exakt. Das wird in einem künftigen Release vereinheitlicht.
- **Abhängigkeiten:** Historische Auditprüfung meldete 15 Findings (11 moderate, 2 high, 2 critical). Nicht gezielt behoben; keine aktuelle vollständige Sicherheitsfreigabe.
- **Benachrichtigungen:** Dokumentseitige Signale, keine vollständige Serviceworker-Abdeckung. Der Punkt ist nicht persistent und kein Gesamt-Ungelesenzähler.
- **Distribution:** Keine signierte Windowsdistribution, keine automatischen Updates. Marken-/Assetprüfung offen; [Icon-Herkunft](../assets/service-icons/SOURCES.md).
- **Profile:** Geräteübergreifende Login-Übernahme nicht garantiert. Entfernen eines Kontoeintrags löscht nicht dessen Profildaten; keine Oberfläche zur endgültigen Bereinigung.
- Mikrofon, Kamera und Bildschirmfreigabe sind nicht freigegeben.

## Historischer Release 1.0

Enthält den unveränderten Build `0.3.1-p3`: Mehrkonten und Kontenverwaltung, noch ohne die neuen Tray-/Benachrichtigungs-/Linkfunktionen. Bleibt als Rückweg verfügbar.

Funktionierende Tests und Windows-Abnahme sind keine unabhängige Sicherheits- oder Markenrechtszertifizierung.
