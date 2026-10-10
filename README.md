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

## Review statuses

- **Matched**: Scryfall found exactly the printing the line asked for.
- **Check**: Scryfall found the card, but in a different printing (number not in that set, card not in the default set, or a fuzzy name correction). Confirm against the physical card.
- **Missing**: not found. The line is left out of the output; add the card in Bindarr by hand.

## Things to know

- **Import each list once.** Bindarr adds every line as new copies; it does not compare against what you
  already own. Importing the same list twice doubles the cards. For new cards, scan them into a separate
  list in ManaBox or TCGplayer and export only that list.
- **TCGplayer exports have no foil marker.** A printing that appears on two lines is often a normal +
  foil pair. Tick **Foil** in the review table.
- **TCGplayer-only set codes** (`PRE`, `ASDFT`, …) don't always match Scryfall's. Use **Set code fixes**
  (`PRE=PDFT, ASDFT=ADFT`) or fix the flagged rows afterwards.
- **Precons**: use the commander set's code. Cards printed elsewhere (often the basic lands) are flagged
  **Check** with the printing Scryfall chose. To track the precon as a deck, import the converted list
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
