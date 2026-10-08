# Sicherheit

## Unterstützungsstand

FM – Sprachbox ist ein experimentelles Projekt. Es gibt derzeit keine zugesicherte produktionsreife oder sicherheitsgewartete Release-Linie. Der aktuelle Entwicklungsstand enthält bekannte Probleme in der Benachrichtigungsintegration; siehe `docs/STATUS.md`.

## Eine Schwachstelle melden

Bitte keine Zugangsdaten, Cookies, QR-Codes, Chat-Inhalte oder vollständigen `data`-Ordner in öffentliche Issues hochladen. Nutze, sofern im Repository verfügbar, GitHubs private Schwachstellenmeldung; andernfalls kontaktiere den Maintainer über die im Projekt angegebene Kontaktadresse. Für normale Fehler ohne sensible Informationen können Issues verwendet werden.

## Schutzmaßnahmen und Grenzen

- Browserprofile sind voneinander getrennt; sie sind keine Garantie gegen kompromittierte Messenger-Seiten oder Betriebssysteme.
- Sandbox, Context Isolation und Web Security dürfen nicht als Workaround abgeschaltet werden.
- Lokale Login-Daten sind sensibel; das Projekt bietet keinen eigenen verschlüsselten Backup-Tresor.
- Downloads und Builds sind derzeit nicht als signierte Produktionsdistribution zugesichert.
- Messenger-Dienste können ihre Weboberflächen und Anmeldebedingungen jederzeit verändern.
