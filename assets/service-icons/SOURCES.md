# FM - Sprachbox Service-Icons

## Quellen und Verwendung

Die im Projekt enthaltenen Dienstlogos dienen ausschließlich der Identifikation
der jeweiligen Messenger innerhalb der Anwendung. Sie werden als statische
lokale SVG-Dateien verwendet, nicht über externe CDNs oder Remote-URLs eingebettet.

### Telegram-Icon

- **Quelle:** Offizielle Telegram-Website, heruntergeladen von https://telegram.org/img/t_logo.svg
- **Lizenz/Nutzung:** Markenzeichen von Telegram FZ-LLC. Nur zur Identifikation des Dienstes innerhalb der App verwendet.

### WhatsApp-Icon

- **Quelle:** Simple Icons (https://simpleicons.org/), heruntergeladen über https://cdn.simpleicons.org/whatsapp/25D366
- **Lizenz:** CC0 1.0 Universal (Simple Icons). Das WhatsApp-Logo ist Markenzeichen von Meta Platforms, Inc.; hier nur zur Identifikation des Dienstes verwendet.
- **Hinweis:** Kein offizieller Download von Meta/ whatsappbrand.com verfügbar; vor Veröffentlichung Markenrechtsprüfung und ggf. offizielle Freigabe empfohlen.

### Slack-Icon

- **Quelle:** Eigenes, lokal erstelltes SVG in Anlehnung an die Slack-Marke.
- **Lizenz/Nutzung:** Das Slack-Logo ist Markenzeichen von Slack Technologies, LLC; hier nur zur Identifikation des Dienstes innerhalb der App verwendet.

### Discord-Icon

- **Quelle:** Eigenes, lokal erstelltes SVG in Anlehnung an die Discord-Marke.
- **Lizenz/Nutzung:** Das Discord-Logo ist Markenzeichen von Discord Inc.; hier nur zur Identifikation des Dienstes innerhalb der App verwendet.

### WhatsApp Business-Icon

- **Quelle:** Eigenes, lokal erstelltes SVG zur Unterscheidung von WhatsApp Business gegenüber dem privaten WhatsApp-Icon.
- **Lizenz/Nutzung:** Das WhatsApp-Markenzeichen gehört Meta Platforms, Inc.; hier nur zur internen Differenzierung verwendet.

## Sicherheit

Alle SVGs enthalten keine Scripts, Event-Handler, externen hrefs oder eingebetteten
Remote-Ressourcen. Sie werden ausschließlich als `<img src="...">` referenziert,
nicht via `dangerouslySetInnerHTML` oder Inline-SVG injiziert.