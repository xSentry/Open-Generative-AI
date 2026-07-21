# Director Studio – Vereinfachter Funktionsplan

## Grundidee

Director Studio dient dazu, wiederverwendbare visuelle Assets für KI-Videos zu erstellen und diese anschließend zu einzelnen Szenen und zusammenhängenden Videos zu kombinieren.

Der Ablauf besteht im Kern aus vier Bereichen:

```text
Characters
Objects
Locations
Videos
```

Jeder Bereich kann unabhängig genutzt werden. Die erstellten Assets stehen später im Video-Bereich zur Verfügung und können dort miteinander verbunden werden.

---

# 1. Characters

Im Character-Bereich erstellt der Nutzer konsistente Figuren.

## Character erstellen

Ein neuer Character kann erstellt werden aus:

* Textbeschreibung
* einem oder mehreren Bildern
* Textbeschreibung und Bildern kombiniert

Beispiel:

```text
Frau, etwa 30 Jahre alt, kurze dunkle Haare, schlanke Statur,
markantes Gesicht, realistische Darstellung
```

## Basis Character Sheet

Zuerst wird eine neutrale Basisversion des Characters erstellt.

Das Character Sheet enthält beispielsweise:

* Ganzkörperansicht von vorne
* Ganzkörperansicht von hinten
* optionale Seitenansicht
* neutrales Gesicht
* mehrere Close-ups des Gesichts
* verschiedene Gesichtsausdrücke
* Detailansichten wichtiger Merkmale

Die Figur trägt dabei möglichst keine charakteristische Kleidung.

Je nach Modell und Richtlinien wird verwendet:

* Unterwäsche
* eng anliegende neutrale Kleidung
* einfaches T-Shirt und Shorts
* neutraler Bodysuit

Ziel ist, Körperbau, Gesicht und Proportionen klar zu definieren, ohne den Character direkt an ein bestimmtes Outfit zu binden.

## Character speichern

Das Ergebnis wird als eigener Character gespeichert.

```text
Character: Anna
├── Basis Character Sheet
├── Gesicht
├── Körperbau
└── Referenzbilder
```

Ein Projekt kann beliebig viele Characters enthalten.

## Outfit-Variationen

Für jeden bestehenden Character können anschließend Outfit-Versionen erstellt werden.

Inputs:

* Textbeschreibung
* Outfit-Referenzbild
* Character-Referenz
* optional: bestehende Outfit-Version als Referenz
* Kombination aus allen Inputs

Beispiele:

```text
Schwarzer Business-Anzug mit weißer Bluse
```

```text
Rote Abendrobe mit goldenen Ohrringen
```

```text
Outdoor-Kleidung für starken Regen
```

Jede Outfit-Version erhält ein eigenes Character Sheet mit:

* Vorderansicht
* Rückansicht
* optionaler Seitenansicht
* Close-ups
* Outfit-Details
* Schuhen
* Accessoires

Das Basisgesicht und der Körper des Characters bleiben erhalten.

Alle sichtbaren Änderungen am Character liegen weiterhin auf dem Outfit-Layer.

Das bedeutet: Auch kleinere Zustände oder Stylingänderungen wie Flecken, beschädigte Kleidung, Make-up oder Verletzungen werden als neue Outfit-Version gespeichert, nicht als Subebene unter einem bestehenden Outfit.

Ein bestehendes Outfit kann aber optional als Input verwendet werden, um daraus eine neue Outfit-Version abzuleiten.

Der Ablauf kann damit entweder direkt vom Basis-Character ausgehen:

```text
Basis Character
→ Outfit-Version
```

Oder von einer bereits bestehenden Outfit-Version:

```text
Basis Character
+ bestehende Outfit-Version
→ neue Outfit-Version
```

Beispiel:

```text
Character: Anna
Input-Outfit: Abendball Kleid (weiß)
Neue Outfit-Version: Abendball Kleid (weiß) – Weinfleck
```

Das Ergebnis ist ein neues Character-und-Outfit-Asset für Anna mit demselben weißen Abendballkleid, aber mit Weinfleck.

Beispiele für abgeleitete Outfit-Versionen:

```text
Abendball Kleid (weiß) – Weinfleck
```

```text
Shirt gerissen
```

```text
Ölfleck auf der Hose
```

```text
Mit Krawatte
```

Auch körper- oder stylingbezogene sichtbare Änderungen werden als Outfit-Version gespeichert:

```text
Blaues Auge
```

```text
Mit Lippenstift-Makeup
```

```text
Gips am Arm
```

Diese Outfit-Versionen sind nützlich, wenn derselbe Character über mehrere Szenen hinweg in leicht veränderten Zuständen auftreten soll.

Beispielstruktur:

```text
Character: Anna
├── Basis
├── Outfit 01 – Business
├── Outfit 02 – Evening Dress
├── Outfit 03 – Evening Dress mit Weinfleck
├── Outfit 04 – Raincoat
├── Outfit 05 – Raincoat mit Gips am Arm
├── Outfit 06 – Casual
├── Outfit 07 – Casual mit gerissenem Shirt
└── Outfit 08 – Casual mit Ölfleck auf der Hose
```

Outfit-Versionen können später gezielt in einzelnen Videos oder Szenen verwendet werden.

---

# 2. Objects

Der Object-Bereich funktioniert ähnlich wie der Character-Bereich.

Hier können alle Assets erstellt werden, die später in einer Szene vorkommen sollen.

Beispiele:

* Autos
* Flugzeuge
* Möbel
* Gemälde
* Produkte
* Maschinen
* Waffenattrappen
* technische Geräte
* Requisiten
* Tiere oder Kreaturen

## Basis-Asset erstellen

Ein Object Asset kann ebenfalls erstellt werden aus:

* Text
* Bild
* Text und Bild kombiniert

Das Basis-Sheet enthält abhängig vom Objekt:

* Vorderansicht
* Rückansicht
* Seitenansicht
* Draufsicht
* Detailansichten
* Materialdetails
* Maßstab oder Größenreferenz

Beispiel:

```text
Object: Schwarzer Sportwagen
├── Front
├── Rear
├── Side
├── Top
├── Interior
└── Detail Views
```

## Object-Variationen

Aus dem Basis-Asset können neue Zustände oder Versionen erzeugt werden.

Beispiele:

```text
Sportwagen nach frontalem Unfall
```

```text
Sportwagen mit geöffneter Fahrertür
```

```text
Sportwagen verschmutzt nach einer Fahrt durch Schlamm
```

```text
Gemälde mit Schäden nach einem Farbangriff
```

```text
Flugzeug mit beschädigtem linken Flügel
```

Die Basisform des Objekts bleibt erhalten. Nur der gewünschte Zustand wird verändert.

Beispielstruktur:

```text
Object: Sportwagen
├── Basis
├── Version 01 – Frontalschaden
├── Version 02 – Verschmutzt
├── Version 03 – Tür geöffnet
└── Version 04 – Brennend
```

Dadurch kann dasselbe Objekt über mehrere Szenen hinweg konsistent verwendet und verändert werden.

---

# 3. Locations

Im Location-Bereich erstellt der Nutzer Orte und Szenenumgebungen.

Eine Location kann erstellt werden aus:

* Textbeschreibung
* Referenzbildern
* bestehenden Bildern
* Text und Bild kombiniert

Beispiel:

```text
Moderne Villa auf einem Hügel, große Glasfront,
Infinity-Pool, minimalistisches Interior, mediterrane Umgebung
```

## Basis Location

Für jede Location werden mehrere Darstellungen erzeugt.

Beispielsweise:

* Hauptansicht der Location
* weitere Perspektiven
* Innen- oder Außenansichten
* Top-down View
* vereinfachter Grundriss
* wichtige Bereiche und Zugänge
* mögliche Kamerapositionen

Beispielstruktur:

```text
Location: Villa
├── Main Scene Image
├── Exterior View
├── Interior View
├── Top-down View
└── Floor Plan
```

Der Grundriss muss nicht technisch exakt sein. Er soll vor allem helfen, Kamerafahrten, Figurenpositionen und Bewegungen verständlich zu planen.

## Location-Variationen

Auf Basis einer bestehenden Location können Varianten erstellt werden.

Beispiele:

* Tag
* Nacht
* Sonnenuntergang
* Regen
* Schnee
* Nebel
* Stromausfall
* Feuer
* nach einer Explosion
* verlassen
* renoviert
* überfüllt

Beispiel:

```text
Location: Villa
├── Basis – Sunny Day
├── Version 01 – Night
├── Version 02 – Heavy Rain
├── Version 03 – After Party
└── Version 04 – Fire Damage
```

## Assets in Location einbauen

Optional können bereits erstellte Assets in eine Location integriert werden.

Beispiel:

```text
Location: Villa
Characters:
- Anna, Outfit 02
- Mike, Outfit 01

Objects:
- Black Sports Car
- Red Painting
```

Dadurch kann ein konsistentes Szenenbild erzeugt werden, das später als Referenz für die Videoerstellung dient.

## Kamerafahrten und Szenenablauf

Für jede Location können unterschiedliche Kamera- und Szenenversionen erstellt werden.

Beispiel:

```text
Villa – Camera Version 01
Slow camera movement from the driveway toward the entrance
```

```text
Villa – Camera Version 02
Drone shot over the roof, descending toward the pool
```

```text
Villa – Camera Version 03
Camera follows Anna through the entrance into the living room
```

Die Kamerafahrt kann dargestellt werden als:

* eingezeichnete Linie im Grundriss
* Start- und Endpunkt
* Pfeile für die Bewegungsrichtung
* markierte Character-Positionen
* kurze Beschreibung
* zeitlicher Ablauf

Beispiel:

```text
0–2 Sekunden:
Kamera startet vor der Einfahrt.

2–5 Sekunden:
Langsame Fahrt auf die Villa zu.

5–7 Sekunden:
Anna kommt aus der Eingangstür.

7–10 Sekunden:
Kamera schwenkt nach rechts und folgt Anna.
```

---

# 4. Video

Im Video-Bereich werden Characters, Objects, Locations und Kamerafahrten miteinander kombiniert.

Der Aufbau kann ähnlich wie im bestehenden nodebasierten Workflow funktionieren.

## Video-Szene erstellen

Eine Video-Szene besteht aus mehreren verbundenen Elementen.

Beispiel:

```text
Location
Villa – Night

Camera
Villa – Camera Version 01

Characters
Anna – Outfit 02
Mike – Outfit 01

Objects
Black Sports Car – Basis

Scene Description
Anna leaves the villa and walks toward the car.
Mike watches her from the entrance.
```

Diese Elemente werden zu einer Video-Generierung verbunden.

## Nodebasierte Darstellung

Ein einfacher Aufbau könnte so aussehen:

```text
Villa – Night ───────────────┐
Anna – Evening Outfit ───────┤
Mike – Business Outfit ──────┤
Black Sports Car ────────────┼→ Scene Generator → Video Generation
Camera Movement Version 01 ──┤
Scene Description ───────────┘
```

Die Nodes enthalten keine komplizierte Produktionslogik. Sie verbinden lediglich die gewünschten Assets und Einstellungen für eine konkrete Szene.

## Szenenbeschreibung

Der Nutzer kann die Szene unterschiedlich detailliert beschreiben.

### Grobe Beschreibung

```text
Anna verlässt die Villa und geht zum Auto.
Mike beobachtet sie von der Tür aus.
```

Die KI erweitert daraus einen zeitlich strukturierten Ablauf.

```text
0–2 Sekunden:
Kamera bewegt sich langsam auf die Villa zu.

2–4 Sekunden:
Die Eingangstür öffnet sich und Anna tritt heraus.

4–7 Sekunden:
Anna geht in Richtung Auto.

7–9 Sekunden:
Mike erscheint in der Tür und sieht ihr nach.

9–10 Sekunden:
Anna erreicht das Auto.
```

### Detaillierte Beschreibung

Der Nutzer kann den Ablauf auch direkt selbst vorgeben.

```text
0–1,5 Sekunden:
Statische Aufnahme der Villa.

1,5–3 Sekunden:
Die Eingangstür öffnet sich.

3–5 Sekunden:
Anna verlässt die Villa.

5–8 Sekunden:
Die Kamera folgt Anna von der Seite.

8–10 Sekunden:
Mike tritt in den Türrahmen.
```

Die KI optimiert daraus lediglich den finalen Video-Prompt und die Modellparameter.

## Video generieren

Für jede Szene können mehrere Ergebnisse erstellt werden.

```text
Scene 01
├── Take 01
├── Take 02
├── Take 03
└── Selected Take
```

Der Nutzer wählt den besten Take aus.

---

# 5. Mehrere Szenen verbinden

Nach der ersten Szene kann eine weitere Szene erstellt werden.

Beispiel:

```text
Scene 01
Anna verlässt die Villa.

Scene 02
Anna fährt mit dem Auto durch die Stadt.

Scene 03
Anna erreicht ein verlassenes Gebäude.
```

Jede Szene verwendet eigene Kombinationen aus Assets.

```text
Scene 01
├── Villa – Night
├── Anna – Evening Outfit
├── Mike – Business Outfit
└── Sports Car – Basis
```

```text
Scene 02
├── City Street – Rain
├── Anna – Evening Outfit
└── Sports Car – Basis
```

```text
Scene 03
├── Abandoned Building – Night
├── Anna – Evening Outfit
└── Sports Car – Damaged
```

## Szenen verknüpfen

Die Szenen werden in einer einfachen Reihenfolge verbunden.

```text
Scene 01 → Scene 02 → Scene 03
```

Für jede Verbindung können folgende Optionen genutzt werden:

* direkter Schnitt
* weiche Überblendung
* Fortsetzung der Bewegung
* KI-generierter Übergang
* Nutzung des letzten Frames als Referenz für die nächste Szene

Beispiel:

```text
Ende Scene 01:
Anna steigt in das Auto.

Start Scene 02:
Das Auto fährt bereits auf einer Straße.
```

Das System kann daraus optional einen kurzen Übergangsclip erzeugen.

## Multi-Szenen-Video

Die ausgewählten Videoergebnisse werden anschließend aneinandergefügt.

```text
Selected Take – Scene 01
+
Selected Take – Scene 02
+
Selected Take – Scene 03

→ Final Video
```

Zusätzlich können pro Szene passende Audioelemente ergänzt werden:

* Dialog
* Soundeffekte
* Umgebungsgeräusche
* Musik
* Voice-over

Der Schwerpunkt bleibt jedoch auf der KI-Generierung und Verbindung der Szenen.

---

# 6. Vereinfachte Projektnavigation

Innerhalb eines Director-Studio-Projekts reicht eine einfache linke Navigation.

```text
Characters
Objects
Locations
Videos
Final Video
```

## Characters

* Basis Character erstellen
* Character Sheets generieren
* Outfit-Versionen erstellen
* Character verwalten

## Objects

* Basisobjekt erstellen
* Object Sheets generieren
* Zustände und Variationen erstellen
* Objekt verwalten

## Locations

* Basis-Location erstellen
* Scene Images generieren
* Top-down View und Grundriss erstellen
* Wetter-, Zeit- und Ereignisvarianten erzeugen
* Characters und Objects einbauen
* Kamerawege definieren

## Videos

* neue Szene erstellen
* Assets auswählen
* Kameraversion auswählen
* Szenenablauf beschreiben
* Ablauf durch KI verbessern
* Video generieren
* Takes vergleichen und auswählen

## Final Video

* Szenen anordnen
* Szenen verbinden
* Übergänge wählen
* ausgewählte Takes zusammenfügen
* finales Multi-Szenen-Video erzeugen

---

# 7. Einfacher Gesamtworkflow

## Einzelner Clip

```text
Character erstellen
→ Location erstellen
→ Kameraweg erstellen
→ Assets in Video-Szene verbinden
→ Szene beschreiben
→ Video generieren
```

## Mehrere Szenen

```text
Characters erstellen
→ Objects erstellen
→ Locations erstellen
→ Scene 01 generieren
→ Scene 02 generieren
→ Scene 03 generieren
→ beste Takes auswählen
→ Szenen verbinden
→ finales Video erstellen
```

---

# 8. Kernprinzip

Director Studio besteht nicht aus vielen komplexen Produktionswerkzeugen.

Es besteht aus einer einfachen Asset- und Szenenlogik:

```text
Assets erstellen
→ Assets versionieren
→ Assets zu einer Szene verbinden
→ Szene zeitlich beschreiben
→ Video generieren
→ mehrere Szenen verbinden
```

Characters, Objects und Locations sind wiederverwendbare KI-Assets.

Videos entstehen, indem diese Assets gemeinsam mit einer Kamerafahrt und einer Szenenbeschreibung verbunden werden.

Mehrere generierte Szenen können anschließend zu einem längeren zusammenhängenden Video kombiniert werden.
