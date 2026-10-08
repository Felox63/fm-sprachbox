# Entwicklungsstatus und Veröffentlichungsgate

## Gesicherter Stand

Der aktuelle Quellstand enthält die bestätigte Basis 0.3.1-p3 sowie noch nicht abgenommene Paket-4-Erweiterungen und die erste Tray-Korrektur. Er ist kein Ersatz für den bereits getesteten Release-Build. Eine historische exakte Quellzuordnung der älteren Release-ZIPs ist nicht zugesichert.

## Offene Punkte vor einem neuen freigegebenen Build

- Tray: echte registrierte Close-/before-quit-/Cleanup-Handler testen; leere Icons, Constructor-Fehler, zerstörten Tray und explizites Beenden berücksichtigen.
- Notifications: sichere funktionierende Brücke für WebContentsView statt webview-spezifischem sendToHost; Änderung der isolierten Preload-Welt allein ersetzt nicht die Notification-API der Messenger-Hauptwelt.
- Datenschutz: bei ausgeblendeten Inhalten auch fremde Absender-/Chat-Titel verbergen.
- Hintergrund: verborgenes oder minimiertes Fenster darf nicht als sichtbare Kontenansicht gelten.
- Neue-Nachricht-Indikator: tatsächliche Signale darstellen; keine erfundenen Counts.
- Links: Redirects/Subframes nicht automatisch im externen Browser öffnen; doppelte Öffnungen und Fehlerpfade prüfen.
- Reale Windows-Abnahme der neuen Funktionen nach Korrektur.

## Lokale Prüfungen der Repository-Vorbereitung

Lint, Typecheck und Build erfolgreich; 176 Unit-Tests erfolgreich. Der frische Electron-Binärdownload scheiterte auf dem Vorbereitungshost; für den erfolgreichen Testlauf wurde die bereits installierte Electron-Binärdistribution des ursprünglichen Workspaces über ELECTRON_OVERRIDE_DIST_PATH verwendet. Keine Windows-Laufzeitprüfung in diesem Schritt.

`npm audit` meldet 15 Findings (11 moderate, 2 high, 2 critical) im Entwicklungs-/Build-Abhängigkeitsbaum. Diese müssen vor öffentlicher Distribution bewertet und gezielt behoben werden. Kein unkontrolliertes `npm audit fix --force` ausgeführt.

## Vor öffentlicher Veröffentlichung

- [ ] Obige Funktionsfehler beheben und Windows-Abnahme dokumentieren.
- [ ] Quellcode und alte Git-Historie/Release-Inhalte auf private Daten prüfen.
- [ ] Markenrechte und Verwendbarkeit aller Logos/Branding-Assets klären.
- [ ] Abhängigkeiten auf bekannte Risiken prüfen; Findings bewerten.
- [ ] Öffentlichen Download und Release-Notizen bewusst freigeben; Drafts nicht ungeprüft veröffentlichen.
- [ ] Optional Code-Signing für Weitergabe einrichten.
- [ ] Repository-Sichtbarkeit ausdrücklich freigeben.

Die Dokumentation und Quellcodesicherung bereiten die Veröffentlichung vor. Sie sind keine Sicherheitszertifizierung oder automatische Freigabe zum öffentlichen Betrieb.
