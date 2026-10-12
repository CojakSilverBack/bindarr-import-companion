# Bindarr Import Companion

An unofficial companion page for [Bindarr](https://github.com/thenotoriousJeremy/bindarr). It converts card
lists into the text format Bindarr's **Settings → Import Backup** reads:

```
qty Name (SET) number
qty Name (SET) number *F*      <- foil
```

Paste a list, check the review table, copy the result, import it into Bindarr.

## What it reads

| Source | Example line | What happens |
|---|---|---|
| TCGplayer app (Collection → ⋮ → Share → ⋮ → Copy) | `2 Zahur, Glory's Past (Borderless) [DFT] 370` | `[SET]` becomes `(SET)`; variant labels like `(Borderless)` or `(0289)` are dropped, since the collector number already identifies the printing; `(First-Place Foil)` marks the line foil |
| Precon / plain decklist (MTGGoldfish, Arena, MTGO) | `1 Arcane Signet` | Looked up on Scryfall in the **default set** you give (e.g. `EOC`), which fills in the collector number |
| ManaBox / Moxfield | `1 Spell Pierce (DFT) 64 *F*` | Checked against Scryfall and passed through |

Section headers (`Commander`, `Deck`, `SIDEBOARD:`) and blank lines are skipped.

## Picking a set

**Default set**, **Set code fixes** and **Also look in** all suggest sets from Scryfall's full list as you type, by code
(`adft`) or by name (`edge of`). Click a suggestion, or use the arrow keys and Enter, to fill in its code.
In **Set code fixes** and **Also look in** only the entry under the cursor is completed, so `PRE=edge of`
becomes `PRE=EOE`.

When a card isn't in its set, the lookup tries, in order:

1. the set's **parent set** on Scryfall (a commander set's parent is its main set: `ECC` → `ECL`)
2. the sets in **Also look in**, left to right (e.g. `SPG` for Special Guests)
3. Scryfall's default printing

Cards found in steps 1–3 are flagged **Check** with a note saying where they came from. Basic lands
matched by name are flagged too, since a set usually has several arts of each.

## Review statuses

- **Matched**: Scryfall found exactly the printing the line asked for.
- **Check**: Scryfall found the card, but not exactly as asked: number not in that set, found in a related set or Scryfall's default printing, a basic land matched by name, a fuzzy name correction, or the same printing on several lines with the same foil setting. Confirm against the physical card.
- **Missing**: not found. The line is left out of the output; add the card in Bindarr by hand.

## Things to know

- **Import each list once.** Bindarr adds every line as new copies; it does not compare against what you
  already own. Importing the same list twice doubles the cards. For new cards, scan them into a separate
  list in ManaBox or TCGplayer and export only that list.
- **TCGplayer exports have no foil marker.** A printing that appears on two lines is often a normal +
  foil pair. Tick **Foil** in the review table.
- **TCGplayer-only set codes** (`PRE`, `ASDFT`, …) don't always match Scryfall's. Use **Set code fixes**
  (`PRE=PDFT, ASDFT=ADFT`) or fix the flagged rows afterwards.
- **Precons**: use the commander set's code. Cards printed elsewhere (often the basic lands) are looked
  for in the main set next, and flagged **Check** with where they were found. To track the precon as a deck, import the converted list
  into your collection once, then create the deck from the same list in Bindarr's Deck Builder.

## Use it

**Hosted**: GitHub Pages, from this repo (see the repo's About link once Pages is enabled).

**Docker**, next to your Bindarr:

```yaml
services:
  bindarr-import:
    image: ghcr.io/cojaksilverback/bindarr-import-companion:latest
    container_name: bindarr-import
    restart: unless-stopped
    ports:
      - "3002:8080"
```

```bash
docker run -d --name bindarr-import -p 3002:8080 ghcr.io/cojaksilverback/bindarr-import-companion:latest
```

The image is unprivileged nginx on port `8080`, with a health check at `/healthz`. Put it behind your
reverse proxy with HTTPS so the **Copy** button can use the clipboard (over plain HTTP it selects the
text instead).

**Locally**: open `index.html` in a browser. No build step.

## Privacy

Everything runs in your browser. The only outside calls are to Scryfall's public API
(`/cards/collection` and `/cards/named`) with card names, set codes and collector numbers. A
Content-Security-Policy allows nothing else. The page stays under Scryfall's published rate limits, and
caps each run at 10,000 lines.

The Docker image sends the full set of security headers (CSP, `frame-ancestors`, `nosniff`,
`Referrer-Policy`, `Permissions-Policy`). GitHub Pages can't set headers, so the hosted copy carries the
CSP and referrer policy as `<meta>` tags; it has no `frame-ancestors` or `nosniff`. The page has no login
and stores nothing, so that gap is small, but self-host the image if you want every header. Add HSTS at
your HTTPS reverse proxy.

## Future enhancements

**Save as a Bindarr CSV.** Not built yet, because Bindarr's CSV import (as of 1.8.6) can't resolve Magic
cards on its own:

- Every `.csv` goes to Bindarr's native mapper (chosen by file extension). It never looks cards up on
  Scryfall. A row only links to a real card when `Card ID` is `mtg-<scryfall id>` and Bindarr already has
  that card cached; otherwise it creates a placeholder ("Imported Set", no image, $0).
- Without a `Game` column the row defaults to Pokémon, and header names must match exactly
  (`Set ID`/`Set Code`, `Card Number`, `Printing` = `Normal` or `Holofoil`).
- The CSV does keep condition, language and purchase price, which the `.txt` import drops.

A CSV export becomes worthwhile if Bindarr's CSV import learns to resolve cards by set and collector
number (or Scryfall ID). Until then, `.txt` is the reliable path.

**Pokémon and Lorcana import lists.** This tool is currently built for Magic: The Gathering. If I find a need
for me or from other Bindarr users to add Pokémon and/or Disney Lorcana lists too. Open an
issue if you'd use it.

What it would take:

- **A game selector** that switches the parser, the card lookup and the set autocomplete per game. The
  Magic path stays as it is.
- **A card data source per game**, in place of Scryfall: a public Pokémon TCG API and a public Lorcana
  card API. Each needs its own entry in the Content-Security-Policy `connect-src`.
- **Parsers for each game's common export formats**, for example the TCGplayer app and other scanner and
  collection apps. Set codes and collector numbers are formatted differently from Magic's.
- **An output format Bindarr resolves for that game.** This is the main unknown. Bindarr's `.txt` import
  looks cards up on Scryfall, so it only covers Magic. Before building anything:
  - check how Bindarr imports Pokémon cards it can resolve to real cards (its CSV path defaults to
    Pokémon but still creates placeholders unless the card is already cached)

## Develop

```bash
node --test          # unit tests for js/core.js (Node 18+, no dependencies)
```

- `js/core.js`: parsing and formatting, no DOM or network. This is what the tests cover.
- `js/app.js`: page logic and Scryfall lookups.
- `css/style.css`: light and dark themes via `prefers-color-scheme`. System fonts only.

## Credits

Card data from [Scryfall](https://scryfall.com). This project is not affiliated with Scryfall, Bindarr,
TCGplayer, ManaBox, Moxfield or Wizards of the Coast. Magic: The Gathering is a trademark of Wizards of
the Coast.

## License

[MIT](LICENSE)
