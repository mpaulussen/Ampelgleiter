# Flowtown-Server

Kleiner Server ohne Abhängigkeiten (Node 18 oder neuer) für fünf Aufgaben:

- **Ebene „Wir“**: Die App sendet je Ampel nur Richtung (Achtel), Zeitfenster und Wartezeit. Der Server speichert Summen je Ampel, Richtung und Zeitfenster und zeigt sie erst, wenn mindestens `K_MIN` verschiedene Personen beigetragen haben. Fahrten, Uhrzeiten, Start und Ziel kommen nie an.
- **KI-Einschätzung**: Die App schickt zusammengefasste Werte (keine Koordinaten), der Server fragt Mistral und gibt Einschätzung und Empfehlungen zurück. Anfragen werden nicht gespeichert, höchstens `KI_PER_DAY` je IP und Tag.
- **Meldungen**: `news.json` im Datenordner, von dir gepflegt. Die App zeigt nur Meldungen, die ihre eigenen Wege berühren; das prüft sie selbst.
- **Verkehrslage vor der Fahrt** (`GET /api/lage`): Stau, Störungen, Baustellen und Sperrungen für ganz Bielefeld. Quellen: Autobahn GmbH des Bundes (A2, A33, ohne Schlüssel) und HERE (Stadtstraßen, mit Schlüssel). Der Server holt höchstens alle `LAGE_MIN` Minuten neu und nur, wenn eine App fragt; alle Apps bekommen dasselbe Gesamtbild. Welche Meldungen die eigenen Wege betreffen, prüft die App auf dem Handy.
- **Ziel prüfen** (`GET /api/ort`, `GET /api/ziel`): Nur auf Knopfdruck. Die App schickt das Ziel und ihren Standort, auf etwa 1 km gerundet. Der Server fragt HERE nach der Strecke mit Verkehr (jetzt und vier spätere Abfahrtszeiten), holt Störungen entlang der Strecke (HERE, Autobahn GmbH) und vergisst die Anfrage nach 3 Minuten. Etwa acht HERE-Abfragen je Prüfung, höchstens `ZIEL_PER_DAY` Prüfungen je IP und Tag. Braucht denselben HERE-Schlüssel.

## Einrichten auf Ubuntu (songdeepdive-Server)

```bash
node --version                                   # 18 oder neuer
sudo useradd --system --home /opt/flowtown --shell /usr/sbin/nologin flowtown
sudo git clone https://github.com/mpaulussen/flowtown.git /opt/flowtown
sudo mkdir -p /var/lib/flowtown && sudo chown flowtown: /var/lib/flowtown

sudo cp /opt/flowtown/server/flowtown.env.example /etc/flowtown.env
sudo nano /etc/flowtown.env                      # Mistral-Schlüssel und SALT eintragen (openssl rand -hex 32)
sudo chmod 600 /etc/flowtown.env

sudo cp /opt/flowtown/server/flowtown.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now flowtown
systemctl status flowtown                        # „Flowtown-Server auf 127.0.0.1:8787, KI an …“
```

Falls `node` nicht unter `/usr/bin/node` liegt (zum Beispiel mit nvm): Pfad mit `which node` prüfen und in `flowtown.service` anpassen.

### Über die bestehende Domain erreichbar machen (nginx)

Den Block aus `nginx-flowtown.conf` in den `server { … }`-Block der songdeepdive-Domain (Port 443) einfügen, dann:

```bash
sudo nginx -t && sudo systemctl reload nginx
curl https://<deine-domain>/flowtown-api/api/health
```

Antwort: `{"ok":true,"ki":true,"modell":"mistral-small-latest","kMin":5}`

### In der App

„Mehr“ → „Flowtown-Server“: Adresse `https://<deine-domain>/flowtown-api` eintragen, „Verbindung prüfen“, dann die beiden Häkchen nach Wunsch setzen.

### Aktualisieren

```bash
cd /opt/flowtown && sudo git pull && sudo systemctl restart flowtown
```

### Verkehrslage einrichten

Autobahn-Meldungen laufen sofort. Für die Stadtstraßen:

1. Auf platform.here.com ein kostenloses Konto anlegen, eine App anlegen und dort einen **API Key** erzeugen.
2. Auf dem Server `sudo nano /etc/flowtown.env` und diese Zeile ergänzen (den Schlüssel nicht weitergeben):
   ```
   HERE_API_KEY=dein-schluessel
   ```
3. `sudo systemctl restart flowtown`, dann in der App unter „Mehr“ auf „Verbindung prüfen“: dort steht „Verkehrslage: Autobahn und Stadt (HERE)“.

Bei 5 Minuten Abstand sind das höchstens knapp 600 HERE-Abfragen am Tag (Fluss und Störungen), egal wie viele Leute die App nutzen. Die aktuellen Freikontingente und Nutzungsbedingungen bitte bei HERE prüfen. Weitere Autobahnen: `LAGE_ROADS=A2,A33,A30`.

### Meldungen pflegen

Vorlage: `news.example.json`. Die Datei liegt als `/var/lib/flowtown/news.json` und wird bei jeder Anfrage neu gelesen, ein Neustart ist nicht nötig. `lat`/`lon`/`radius_m` weglassen für Meldungen, die für die ganze Stadt gelten.

## Datenschutz

- Mistral: In der Mistral-Konsole prüfen, dass API-Daten nicht zum Training verwendet werden und wie lange Mistral Anfragen aufbewahrt.
- Vor einer öffentlichen Nutzung braucht die App eine Datenschutzerklärung, die Server, Mistral und die Ebene „Wir“ beschreibt.
- Verkehrslage: Der Server ruft HERE und die Autobahn-API ohne Daten der Nutzer ab; die App lädt nur das Gesamtbild.
- Daten liegen in `/var/lib/flowtown/wir.json`. Löschen setzt die Ebene „Wir“ zurück.
