# Technischer Stand

## Release 1.2.1

Felix bestätigt die Mikrofon-Tests des Windows-Testkandidaten `1.3.0-microphone.1`. Release `1.2.1` enthält denselben geprüften Mikrofon-Funktionsstand, neu gebaut mit einheitlicher stabiler Paket- und Appversion. Die Funktionsabnahme des Testkandidaten wird nicht als erneuter Windows-Test des neu versionierten Pakets dargestellt.

- Audio-only-Media-Anfragen sind für registrierte, aktivierte Konten und deren eigene erlaubte HTTPS-Ursprünge zugelassen. Beide Permission-Handler prüfen die konkrete lebende WebContents-Zuordnung und den Hauptframe; fremde Ursprünge, Subframes und veraltete oder zerstörte Frames werden abgewiesen.
- Kein zusätzlicher Mikrofonschalter oder App-Zustimmungsdialog. Der vertrauenswürdige Messenger darf Audio anfordern; die App startet selbst keine Aufnahme. Aufnahme/Stop im Messenger und Windows-Mikrofonrechte bleiben maßgeblich. Die native `getUserMedia`-/MediaStream-Laufzeit wird nicht überschrieben.
- Kamera, gemischte Audio-/Video-Anfragen und Bildschirmfreigabe bleiben gesperrt. Mikrofon-Funktion unter Windows bestätigt; separate vollständige Sprach-/Videoanrufabnahme nicht behauptet.
- Unabhängiger read-only Review des Funktionsstands bestanden. 435 Unit-Tests in 17 Dateien sowie nativer Electron-Fake-Audio-Smoke bestanden: tatsächliche Tracks live → ended, Kamera/gemischt/deaktiviertes Konto abgewiesen und erneutes Audio zugelassen. Der Smoke nutzt kein physisches Mikrofon und ersetzt nicht die Windows-Abnahme.
- Neue Release-Build-, Paket-, Versions- und CI-Nachweise werden unter den Release-Assets veröffentlicht. Offene Sicherheits-/Dependency-Befunde und übrige Grenzen bleiben bestehen.

## Übernommener Funktionsstand aus Release 1.2.0

Felix bestätigt unter Windows die neuen Kontovarianten, die gespeicherte Kontosortierung und den Telegram-Overlay-Fix: kein Fehler mehr feststellbar. Diese Abnahme stammt aus dem getesteten Vorgänger `1.2.0-telegram-fix.1`; der reguläre Build enthält denselben Funktionsstand mit konsistenter Version und aktualisierter Dokumentation.

- Manifest, sichtbare Appversion und Release-Tag: `1.2.0`. Die Oberfläche liest die Version direkt aus dem Manifest statt aus einer zweiten fest codierten Angabe.
- Frische Lint-/Typecheck-/Build-/Test- und Paketprüfung erfolgen vor Veröffentlichung; die konkreten Auslieferungsnachweise liegen als Release-Assets bei.
- Source und Binary werden erstmals einem gemeinsamen Quelltag zugeordnet. Historische Releasearchive haben die unten beschriebenen Abweichungen.
- WhatsApp/Telegram bleiben die einzigen neuen Standardkonten. Slack, Discord und WhatsApp Business werden manuell hinzugefügt; Sitzungen sind getrennt.
- Telegram-Hintergrund-/Subframe-/Same-document-Ladeaktivität blendet die Editoransicht nicht mehr aus. Erststart, Retry, echter Mainframe-Dokumentwechsel und Fehler behalten das Overlay. Kein künstlicher Fokus-Repair.
- Optionale lokale Diagnose ist standardmäßig aus; begrenzte Kategorien statt Texte, Zeichen oder Accountdaten. Kein automatischer Upload.

## Grenzen und offene technische Themen

- **SSO/OAuth:** Popups weiterhin gesperrt, Slack-SSO nicht bestätigt. Erfolgreiche Konto-Tests sind kein Nachweis sämtlicher Loginvarianten.
- **Abhängigkeiten:** Offene Auditbefunde nicht im Rahmen dieses Releases behoben. Keine aktuelle vollständige Sicherheitsfreigabe; Details im Release-Nachweis.
- **Benachrichtigungen:** Dokumentseitige Signale, keine vollständige Serviceworker-Abdeckung. Der Punkt ist nicht persistent und kein Gesamt-Ungelesenzähler.
- **Distribution:** Keine signierte Windowsdistribution und keine automatischen Updates. Marken-/Assetprüfung offen; [Icon-Herkunft](../assets/service-icons/SOURCES.md).
- **Profile:** Geräteübergreifende Login-Übernahme nicht garantiert. Entfernen eines Kontoeintrags löscht nicht dessen Profildaten; keine Oberfläche zur endgültigen Bereinigung.
- **Kontosortierung:** Windows-Abnahme erfolgreich. Automatisierte Nachweise für reguläre Verschiebungen und Persistenz vorhanden; separater normaler Schreibfehlerpfad besitzt noch keine vollständige Runtime-Regression. Das wird nicht als behoben ausgegeben.
- Kamera und Bildschirmfreigabe sind nicht freigegeben. Die Mikrofon-Abnahme deckt die von Felix getesteten Aufnahmefälle ab, nicht jede Login- oder Anrufvariante sämtlicher optionaler Dienste.
- Der konkrete Telegram-Unterladevorgang, der den früheren Overlay-Wechsel auslöste, wurde nicht separat identifiziert. Logfolge und Windows-Abnahme bestätigen den korrigierten Fokusverlustpfad, nicht sämtliche denkbaren Ursachen.

## Historischer Release 1.1

Mehrkonten, Tray, Links, Benachrichtigungen und Neue-Nachricht-Punkt unter Windows bestätigt. Download unveränderte Alpha-4-ZIP, interne Appversion `1.1.0-alpha.4`; damaliger GitHub-Quellstand älter als Binary. Historische Sourcearchive reproduzieren diese ZIP nicht exakt.

## Historischer Release 1.0

Unveränderter Build `0.3.1-p3`: Mehrkonten und Verwaltung, noch ohne neue Tray-/Benachrichtigungs-/Linkfunktionen. Bleibt als Rückweg verfügbar.

Funktionierende Tests und Windows-Abnahme sind keine unabhängige Sicherheits- oder Markenrechtszertifizierung.
