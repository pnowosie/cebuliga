# Wyciąg z regulaminu — blueprint

Skrót dla graczy: tylko to, co potrzebne, żeby rozegrać partię i nie stracić punktu
na formalnościach. Wariant bazowy: **system szwajcarski**. Zmiany dla kołówki
i 2kołówki — na końcu, w części „Warianty formatów".

Placeholdery `{{...}}` podmieniamy per turniej (mapowanie na `tournaments/*.json`
w części „Dla organizatora").

---

# CZĘŚĆ A — treść do publikacji

## ⚡ Najważniejsze w 30 sekundach

| | |
|---|---|
| ⌛ **Tempo** | `{{clockInfo}}` — **rapid, {{typPartii}}** |
| ♟️ **Kto wyzywa** | 👉 gracz z **białymi**, czyli **pierwszy nick** w kojarzeniu |
| 📅 **Runda** | poniedziałek → **niedziela {{deadlineGodzina}}** |
| 📋 **Kojarzenia** | `#{{kanalTurniejowy}}` oraz strona turnieju: {{cmUrl}} |
| 💬 **Umawianie się** | kanał swojej pary: `#szachownica-{{N}}` |
| 🤖 **Wyniki** | pojawiają się **same** na `#wyniki-🤖` |
| 🆘 **Problemy, wątpliwości** | `#{{kanalPomocy}}`, oznacz `@{{sedzia}}` |

👉 Na stronie turnieju w ChessManager nicki są **takie same jak na
{{platformaNazwa}}** — kojarzenia, tabelę i historię rund czytasz tam bez
tłumaczenia sobie, kto jest kim.

## ✅ Checklista — zanim wyślesz wyzwanie

1. Tempo dokładnie `{{clockInfo}}`.
2. Przełącznik **Rated / rankingowa**: {{ratedSetting}}.
3. Kolor zgodny z kojarzeniem (pierwszy nick = białe).

👉 Partia rozegrana na innych warunkach **nie jest zaliczana** — bot jej nie
zobaczy, a partię trzeba powtórzyć. Jeśli przeciwnik proponuje inne warunki —
odmów i napisz do `@{{sedzia}}`.

## 🤖 Zgłaszanie wyniku — zwykle nie musisz nic robić

👉 **Wyniki zbierane są automatycznie.** Bot sam znajduje partię i publikuje
wynik na `#wyniki-🤖` — pod warunkiem, że partia spełnia warunki turniejowe
(patrz checklista wyżej).

Zwykle wynik pojawia się szybko, najpóźniej **do końca dnia (ok. 23:00)**.
Partie grane późną nocą wpadają dopiero następnego dnia. 👉 Jeśli **następnego
dnia** wyniku wciąż nie ma — zgłoś go sam, nie czekaj dłużej na bota. Możesz też
zgłosić od razu po partii, to nigdy nie jest błąd.

Zgłaszasz **na kanale swojej szachownicy**. Może to zrobić **każdy z grających**,
podając numer rundy:

```
R3: nickBiały 1–0 nickCzarny
```

Zapis wyniku: `1–0` (wygrały białe), `0–1` (wygrały czarne), `½–½` (remis).

## 📅 Terminy — jak nie stracić punktu

- 👉 **Termin ustalcie do środy.** Zostaje wtedy zapas na przesunięcie.
- Partię trzeba rozegrać do **niedzieli {{deadlineGodzina}}**.
- 👉 **Nie dasz rady w tym tygodniu? Napisz do `@{{sedzia}}` ZAWCZASU** — przed
  końcem rundy. Zgłoszona nieobecność to nie to samo co zniknięcie bez słowa.
- Na przeciwnika czekasz **maksymalnie 15 minut** od ustalonej godziny.

## 🆘 Co robić, gdy…

**…przeciwnik nie odpowiada na umawianie się.**
Napisz na kanale swojej szachownicy i oznacz `@{{sedzia}}`. Nie czekaj z tym do
niedzieli wieczorem.

**…przeciwnik nie przyszedł na ustaloną godzinę.**
Odczekaj 15 minut, potem wpis na kanale szachownicy + zrzut rozmowy. Sędzia
przyznaje walkower — nie musisz się z nikim licytować.

**…problem techniczny kosztował Cię partię (rozłączenie, zanik prądu, misclick).**
👉 Wynik pozostaje w mocy. Powtórzenie partii jest możliwe **wyłącznie za zgodą
przeciwnika** — sędzia nie ma żadnej możliwości zweryfikowania, co się stało po
Twojej stronie, więc nie zarządzi powtórki. Możesz o nią poprosić i liczyć na
życzliwość, ale odmowa jest w pełni w porządku.

**…przeciwnik „nie da się wyzwać" albo nie widzi Twojej wiadomości.**
Sprawdźcie ustawienia kont na {{platformaNazwa}}: wyzwania/wiadomości ograniczone
do znajomych albo wyłączony czat blokują grę. To najczęstsza przyczyna
„przeciwnik mnie ignoruje".

## 🏆 Punktacja

Wygrana **1**, remis **½**, przegrana **0**. Przy równej liczbie punktów o
kolejności decyduje: {{kryteriaPomocnicze}}.

## 🚩 Fair play

👉 Jeśli na profilu zawodnika pojawi się komunikat o naruszeniu zasad platformy,
oznacza to przegraną i wykluczenie z turnieju — niezależnie od przyczyny
komunikatu.

---

📖 To tylko skrót. Pełny regulamin: {{linkDoRegulaminu}}

---

# CZĘŚĆ B — dla organizatora (nie publikujemy)

## Mapowanie placeholderów

| Placeholder | Źródło / co wpisać |
|---|---|
| `{{clockInfo}}` | `tournaments/*.json` → `clockInfo` (np. `15'+10"`) |
| `{{cmUrl}}` | `cmUrl` |
| `{{kanalTurniejowy}}` | `channel` |
| `{{platformaNazwa}}` | z `platform` (`chesscom` → chess.com, `lichess` → lichess.org) |
| `{{typPartii}}` | `gra rankingowa (Rated)` **albo** `gra NIErankingowa (Unrated)` |
| `{{ratedSetting}}` | odpowiednio: `włączony` / `WYŁĄCZONY` |
| `{{N}}` | numer szachownicy z kojarzenia — gracz podstawia sobie sam |
| `{{deadlineGodzina}}` | do ustalenia (propozycja: **niedziela 22:00**) |
| `{{sedzia}}` | nick sędziego na discordzie |
| `{{kanalPomocy}}` | kanał zgłoszeń/technicznych; jeśli nie ma osobnego — `channel` |
| `{{kryteriaPomocnicze}}` | do ustalenia (dla szwajcara zwykle: Buchholz cut-1, Buchholz, bezpośredni pojedynek) |
| `{{linkDoRegulaminu}}` | link do pełnego regulaminu |

## Pytania otwarte (założenia przyjęte w tekście)

1. **Godzina deadline'u rundy** — przyjąłem niedzielę wieczorem, brak w oryginale.
2. **Kryteria pomocnicze** — nie ma ich w żadnym regulaminie, a bez nich nie da
   się ogłosić zwycięzcy przy remisie punktowym.
3. **Kanały `#szachownica-N`** — założyłem, że to miejsce **i** do umawiania się,
   **i** do ręcznego zgłaszania wyniku. Jeśli umawianie ma iść przez DM, trzeba
   rozdzielić te dwa adresy.
4. **Częstotliwość bota** — w tekście: „zwykle szybko, najpóźniej do ok. 23:00,
   partie nocne następnego dnia". Jeśli cron ma stałą godzinę, warto podać ją
   wprost.
5. **Kanał pomocy** — czy istnieje osobny, czy wszystko idzie na kanał turniejowy.
6. **Osoba sędziego vs organizatora** — w wyciągu jest jeden adres kontaktowy;
   jeśli role są rozdzielone, dopisać który do czego.

## Warianty formatów

**Kołówka (każdy z każdym, 1 partia):**
- Sekcja „Kojarzenia" → cały terminarz znany od startu; kolejność meczów wybierasz
  sam, obowiązuje limit **min. 1 partia tygodniowo**.
- Kolory wynikają z terminarza (tabele Bergera) — publikowane razem z parami.
- Deadline tygodniowy zostaje, ale dotyczy „dowolnej zaległej partii", nie rundy.

**2kołówka (każdy z każdym, 2 partie):**
- Jak wyżej + 👉 **dwie partie z tym samym przeciwnikiem, w każdej inny kolor**.
- Do rozstrzygnięcia: czy obie partie w jednej sesji („mecz"), czy dwa osobne
  terminy — oryginalny regulamin mówi „1 mecz tygodniowo", co jest niejasne.
- Format ręcznego zgłoszenia musi rozróżniać partie, np. `R3/1:` i `R3/2:`.
