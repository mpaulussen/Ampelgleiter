# Flowtown-Server

Kleiner Server ohne Abhängigkeiten (Node 18 oder neuer) für drei Aufgaben:

- **Ebene „Wir“**: Die App sendet je Ampel nur Richtung (Achtel), Zeitfenster und Wartezeit. Der Server speichert Summen je Ampel, Richtung und Zeitfenster und zeigt sie erst, wenn mindestens `K_MIN` verschiedene Personen beigetragen haben. Fahrten, Uhrzeiten, Start und Ziel kommen nie an.
- **KI-Einschätzung**: Die App schickt zusammengefasste Werte (keine Koordinaten), der Server fragt Mistral und gibt Einschätzung und Empfehlungen zurück. Anfragen werden nicht gespeichert, höchstens `KI_PER_DAY` je IP und Tag.
- **Meldungen**: `news.json` im Datenordner, von dir gepflegt. Die App zeigt nur Meldungen, die ihre eigenen Wege berühren; das prüft sie selbst.

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

### Meldungen pflegen

Vorlage: `news.example.json`. Die Datei liegt als `/var/lib/flowtown/news.json` und wird bei jeder Anfrage neu gelesen, ein Neustart ist nicht nötig. `lat`/`lon`/`radius_m` weglassen für Meldungen, die für die ganze Stadt gelten.

## Datenschutz

- Mistral: In der Mistral-Konsole prüfen, dass API-Daten nicht zum Training verwendet werden und wie lange Mistral Anfragen aufbewahrt.
- Vor einer öffentlichen Nutzung braucht die App eine Datenschutzerklärung, die Server, Mistral und die Ebene „Wir“ beschreibt.
- Daten liegen in `/var/lib/flowtown/wir.json`. Löschen setzt die Ebene „Wir“ zurück.
