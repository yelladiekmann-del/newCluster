# Analytics Workspace — Metriken & Berechnungslogik

## Variablen & Definitionen

| Variable | Bedeutung |
|---|---|
| **Y** | Referenzjahr (`refYear`). Standard: aktuelles Kalenderjahr. Wird für alle zeitfensterbasierten Metriken verwendet. |
| **Y−1, Y−2, Y−3** | Kalenderjahre relativ zu Y |
| **recentYear** | Das **höchste Gründungsjahr**, das im gesamten Datensatz (alle Cluster) vorkommt — nicht zwingend Y. Wird ausschließlich für „% Recently Founded" verwendet. |
| **Cluster** | Eine Gruppe von Companies, die durch das Clustering-Modell zusammengefasst wurden |
| **Companies-CSV** | Datei mit einem Eintrag pro Unternehmen (Stammdaten) |
| **Deals-CSV** | Datei mit einem Eintrag pro Finanzierungsrunde (Deal-Daten) |
| **Join** | Companies und Deals werden per `co_id` (primär) oder `company_name` (Fallback) verknüpft |

---

## Datenqualität & Parsing

Alle numerischen Felder laufen durch `safeNum()`:
- Entfernt: `$`, `€`, `£`, `,`, Leerzeichen, `%`
- Klammern `(x)` werden als negativer Wert interpretiert
- Leere Felder, `""`, `"N/A"` → `null` (nicht 0)

Alle Datumsfelder laufen durch `safeDate()`:
- ISO-Strings (`2021-03-15`)
- Numerische Jahresangaben (`2021`)
- Excel-Seriennummern (z. B. `44200`)

---

## Metriken pro Cluster

### A — Company-Level (Quelle: Companies-CSV)

---

#### Company Count
Anzahl Companies im Cluster.

---

#### Ø Mitarbeiter
Arithmetisches Mittel der Mitarbeiterzahlen aller Companies im Cluster.

Ausreißerfilter: Werte > 1.000.000 werden als Parsing-Fehler verworfen.

Null wenn kein Mitarbeiter-Mapping gesetzt.

---

#### Ø Gründungsjahr
Arithmetisches Mittel der Gründungsjahre aller Companies im Cluster, gerundet auf ganze Zahl.

Null wenn kein `year_founded`-Mapping gesetzt.

---

#### % Recently Founded
Anteil der Companies im Cluster, deren Gründungsjahr gleich `recentYear` ist — also gleich dem höchsten Gründungsjahr im gesamten Datensatz.

```
% Recently Founded = (Companies mit year_founded = recentYear) / (alle Companies im Cluster) × 100
```

**⚠ Hinweis (offener Diskussionspunkt):** Die Metrik vergleicht gegen ein einzelnes Jahr (`recentYear`), nicht gegen ein Zeitfenster. Eine Company, die ein Jahr vor dem Maximum gegründet wurde, zählt nicht. Wahrscheinlich war eine Schwelle wie „gegründet in Y−3 oder später" gemeint — bitte abstimmen.

---

#### Ø Total Raised
Arithmetisches Mittel der `total_raised`-Werte aller Companies im Cluster (Wert aus Companies-CSV, sofern gemappt).

**Fallback:** Falls `total_raised` nicht gemappt ist, aber Deals-Daten vorliegen: Pro Company werden alle Deal-Größen summiert; daraus wird der Cluster-Durchschnitt gebildet.

---

#### Total Funding (Cluster)
Summe der `total_raised`-Werte aller Companies im Cluster (gleicher Fallback wie oben).

---

### B — Deal-Level (Quelle: Deals-CSV, nur wenn hochgeladen)

---

#### Deal Count
Anzahl eindeutiger Finanzierungsrunden im Cluster.

- Falls `deal_id` gemappt: Anzahl eindeutiger IDs
- Sonst: Anzahl Zeilen im gefilterten Deals-DataFrame

---

#### Capital Mean
Arithmetisches Mittel aller Deal-Größen (`deal_size`) der Deals, die Companies des Clusters zugeordnet sind (über alle Jahre).

---

#### Capital Median
Median aller Deal-Größen der Deals im Cluster (über alle Jahre).

---

#### Mean/Median Ratio
```
Mean/Median Ratio = Capital Mean / Capital Median
```
Gerundet auf 2 Dezimalstellen.

Wert > 1: wenige sehr große Deals verzerren den Mittelwert nach oben → rechtsschiefe Verteilung (Mega-Deals dominant).
Wert ≈ 1: gleichmäßige Deal-Größenverteilung.

---

#### Total Invested (4yr)
Summe aller Deal-Größen im Cluster, bei denen `deal_date` im Fenster **[Y−3, Y]** liegt (4 Kalenderjahre inkl. Y).

```
Total Invested (4yr) = Σ deal_size  für alle Deals mit year(deal_date) ∈ {Y−3, Y−2, Y−1, Y}
```

---

#### Funding Momentum
Vergleich des Investitionsvolumens im aktuellen Zweijahresfenster mit dem vorangegangenen Zweijahresfenster.

```
recent_sum = Σ deal_size  für Deals mit year(deal_date) ∈ {Y−1, Y}
prev_sum   = Σ deal_size  für Deals mit year(deal_date) ∈ {Y−3, Y−2}

Funding Momentum = (recent_sum / prev_sum − 1) × 100  [in %]
```

Gerundet auf ganze Prozentzahl.
Null wenn `prev_sum = 0` (kein Funding im älteren Fenster vorhanden).

**⚠ Hinweis (offener Diskussionspunkt):** Wenn `prev_sum = 0`, aber `recent_sum > 0`, gibt die Metrik `null` zurück. Das kann ein stark wachsender Cluster sein — der Wert geht faktisch gegen +∞. Bitte abstimmen, ob hier ein explizites Signal (z. B. `"neu"`) sinnvoller wäre.

---

#### Deal Momentum
Analog zu Funding Momentum, aber auf Anzahl Deals statt Volumen.

```
recent_n = Anzahl Deals mit year(deal_date) ∈ {Y−1, Y}
prev_n   = Anzahl Deals mit year(deal_date) ∈ {Y−3, Y−2}

Deal Momentum = (recent_n / prev_n − 1) × 100  [in %]
```

Gerundet auf ganze Prozentzahl.
Null wenn `prev_n = 0`.

---

#### Avg Series Score
Numerische Bewertung der Finanzierungsreife basierend auf der Rundenbezeichnung (`series`-Spalte).

| Rundenbezeichnung | Score |
|---|---|
| Pre-Seed | 0 |
| Seed | 1 |
| Series A | 2 |
| Series B | 3 |
| Series C | 4 |
| Series D | 5 |
| Series E / F / G / Growth / Late Stage | 6 |
| IPO | 7 |

```
Avg Series Score = Σ score(deal) / Anzahl bewerteter Deals im Cluster
```

Gerundet auf 1 Dezimalstelle. Null wenn kein `series`-Mapping gesetzt.

---

### C — Kombinierte Metriken (Companies + Deals)

---

#### Marktreife
Anteil des Cluster-Fundings, der im aktuellen 4-Jahres-Fenster investiert wurde, gemessen am gesamten historischen Funding.

```
Marktreife = (Total Invested 4yr) / (Total Funding all-time) × 100  [in %]
```

Gerundet auf 1 Dezimalstelle.
Null wenn eine der Seiten fehlt.

**⚠ Achtung — Richtung:** Ein **hoher Wert** bedeutet, dass der Großteil des Fundings recent geflossen ist → **junger, emerging Markt**. Ein **niedriger Wert** bedeutet Funding ist über einen langen Zeitraum verteilt → **reifer Markt**. Der Name „Marktreife" suggeriert die Gegenrichtung. Bitte Namen oder Formel abstimmen.

---

### D — Status-Metriken (Quelle: Companies-CSV, optional)

---

#### VC Graduation Rate
Anteil der Companies im Cluster, die als „graduiert" gelten — d. h. durch Akquisition, Börsengang oder PE-Übernahme aus dem VC-Ökosystem ausgeschieden sind.

Eine Company gilt als graduiert, wenn mindestens eine der folgenden Bedingungen zutrifft:
- `ownership_status` ∈ {`acquired/merged`, `publicly held`}
- `financing_status` enthält `formerly` oder `private equity-backed`

Ausnahme: `business_status = "out of business"` oder `"bankruptcy"` → kein Grad, auch wenn ownership passt.

```
VC Graduation Rate = (graduierte Companies im Cluster) / (alle Companies im Cluster) × 100
```

Null wenn keine Status-Spalten gemappt.

---

#### Mortality Rate
Anteil der Companies im Cluster, die als insolvent/inaktiv gelten.

Eine Company gilt als „mort", wenn:
- `business_status` ∈ {`out of business`, `bankruptcy`}

```
Mortality Rate = (insolvente Companies im Cluster) / (alle Companies im Cluster) × 100
```

Null wenn `business_status` nicht gemappt.

---

### E — Konzentrations- & IP-Metriken (Quelle: Companies-CSV, optional)

---

#### HHI (Herfindahl–Hirschman Index)
Misst die Funding-Konzentration **innerhalb** des Clusters: Wie gleichmäßig ist das Kapital auf die Companies verteilt?

```
HHI = Σ (total_raised_i / Σ total_raised_cluster)²  × 10.000
```

Skala 0 – 10.000:
- **10.000**: Ein einziges Unternehmen hält 100 % des Cluster-Fundings
- **0**: Perfekt gleichmäßige Verteilung (theoretisch)
- **< 1.500**: Geringe Konzentration
- **1.500 – 2.500**: Moderate Konzentration
- **> 2.500**: Hohe Konzentration

**Hinweis:** Dies ist eine interne Cluster-Konzentrationsmessung, kein Markt-HHI im kartellrechtlichen Sinne.

Null wenn `total_raised` nicht gemappt.

---

#### Ø Patent Families
Arithmetisches Mittel der Patent-Familien aller Companies im Cluster.

Gerundet auf 1 Dezimalstelle.
Null wenn `patent_families` nicht gemappt.

---

## Rangfolge in der Tabelle

Jede Metrik erhält pro Cluster einen Rang (1 = bester Cluster). Die Richtung ist wie folgt definiert:

| Metrik | Höher ist besser? |
|---|---|
| Company Count | ja |
| Ø Mitarbeiter | ja |
| Deal Count | ja |
| Capital Mean / Median | ja |
| Total Invested 4yr | ja |
| Funding / Deal Momentum | ja |
| Avg Series Score | ja |
| VC Graduation Rate | ja |
| Mortality Rate | **nein** |
| HHI | **nein** (niedrig = besser verteilt) |
| Marktreife | kontextabhängig — bitte abstimmen |
