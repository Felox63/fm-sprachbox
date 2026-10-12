# FM – Sprachbox

**Mehrere Messenger-Konten in einer portablen Windows-App. Eine Oberfläche, deine Reihenfolge.**

Ein Projekt von **Felix**, entwickelt mit Unterstützung von **KI (Hermes)**.

[**Windows herunterladen · Version 1.2.0**](https://github.com/Felox63/fm-sprachbox/releases/latest) · [Ideen & Fehler](https://github.com/Felox63/fm-sprachbox/issues) · [Mitwirken](CONTRIBUTING.md)

## Das kann die App

- WhatsApp und Telegram mit mehreren, getrennten Konten
- Slack, Discord und WhatsApp Business optional über das Dropdown hinzufügen – keine neuen Standardkonten
- Konten benennen, aktivieren, entfernen und auf der Startseite per Pfeilen sortieren; die Sidebar übernimmt die gespeicherte Reihenfolge
- Telegram-Ladeoverlay nur bei echten Dokumentwechseln statt bei Hintergrund-Ladeaktivität
- Optional im Tray weiterlaufen; Windows-Benachrichtigungen mit oder ohne Inhalt
- Neue-Nachricht-Punkt pro Konto und bestätigtes Öffnen externer Links
- Portable Nutzung ohne Installation; Daten im lokalen `data`-Ordner
- Optionale lokale Fokusdiagnose, standardmäßig aus, ohne Nachrichtentexte oder getippte Zeichen

WhatsApp Business nutzt WhatsApp Web mit eigener Kontositzung, keine Business-API. OAuth-/SSO-Popups bleiben blockiert; insbesondere Slack-SSO ist nicht bestätigt.

## Loslegen

1. Unter [Releases](https://github.com/Felox63/fm-sprachbox/releases/latest) **`FM-Sprachbox-1.2.0-win64.zip`** herunterladen.
2. Vollständig entpacken und **`FM - Sprachbox.exe`** starten.
3. Konten hinzufügen und anmelden.

**Update:** App vollständig schließen, `data` sichern und nur eine Kopie direkt neben die neue EXE übernehmen. Alten Ordner als Rückweg behalten; nicht dieselben Profile gleichzeitig öffnen.

**Links:** Telegram per Linksklick und Bestätigung; WhatsApp per Rechtsklick → „Im Browser öffnen“. WhatsApp-Benachrichtigungen zusätzlich in WhatsApp Web aktivieren.

## Roadmap

- [ ] Abhängigkeiten aktualisieren und Sicherheitsbefunde bearbeiten
- [ ] Windows-Code-Signing prüfen
- [ ] SSO-/OAuth-Anmeldungen sicher unterstützen
- [ ] Benachrichtigungsabdeckung erweitern
- [ ] Wiederherstellung und endgültige Bereinigung von Kontenprofilen vereinfachen

Ab 1.2.0 stimmen Quelltag, Paketversion und sichtbare Appversion überein. [Technischer Stand & Grenzen](docs/STATUS.md).

## Mach mit

**Beiträge sind willkommen.** Ob Fehlerbericht, Windows-Test, Verbesserungsidee, Dokumentation oder Pull Request: Hilf mit, die Sprachbox besser zu machen. Größere Änderungen bitte vorher kurz in einem Issue abstimmen.

[Entwicklung & Beiträge](CONTRIBUTING.md) · [Sicherheit](SECURITY.md) · [MIT-Lizenz](LICENSE)

<sub>Inoffizielles Projekt, nicht mit den Messenger-Anbietern verbunden. `data` enthält sensible Anmeldedaten – nicht teilen. Windows kann bei unsignierten Apps warnen.</sub>
