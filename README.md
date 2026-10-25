# Ampelgleiter – Prototyp

**Die grüne Welle beginnt bei dir.**
Weniger Stopps, weniger Sprit, in der Stadt und auf der Autobahn.

Eine Initiative von barrierefrAI.

Eine kleine Web-App (PWA), die beim Fahren aufzeichnet, an welchen Ampeln du hältst und wie lange. Nach der Fahrt bewertest du die Ampeln mit einem Tipp. Statistik und Karte zeigen deine persönliche Warte-Wolke, also wo und wie lange du an Ampeln wartest.

## Benutzen

1. Die App im Handy-Browser öffnen (Chrome auf Android, Safari auf dem iPhone).
2. Über das Browser-Menü **„Zum Startbildschirm hinzufügen“** wählen. Dann startet sie wie eine App.
3. Verkehrsmittel wählen, **„Fahrt starten“** tippen und den Standortzugriff erlauben.
4. Handy in die Halterung, App geöffnet lassen. Der Bildschirm bleibt während der Aufzeichnung an.
5. Am Ziel **„Fahrt beenden“** und die Ampeln bewerten.

Zum Ausprobieren ohne Fahrt: **Mehr → Testfahrt simulieren**.

## Was gespeichert wird

- Nur Halte und Durchfahrten an Ampeln: Ampelstandort, Uhrzeit, Wartezeit, Fahrtrichtung, deine Bewertung.
- Keine vollständige Strecke. Ereignisse nahe Start und Ziel werden verworfen (einstellbar).
- Alles bleibt im Browser auf deinem Gerät. Über **Mehr → Daten exportieren** kannst du die Daten als JSON oder CSV weitergeben.

## Technik

- Reines HTML, CSS und JavaScript, kein Build-Schritt.
- Ampelstandorte aus OpenStreetMap (Overpass API), Straßennamen über Nominatim, Karte mit Leaflet.
- Einschränkung als Web-App: Die Aufzeichnung läuft nur, solange die App im Vordergrund geöffnet ist. Für die Kampagnenphase ist eine native App geplant.

Ampelstandorte und Karte: © OpenStreetMap-Mitwirkende (ODbL). Leaflet: BSD-2-Clause, siehe `vendor/leaflet/LICENSE`.
