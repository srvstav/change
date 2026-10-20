# change

The site for the **change** vault, a working notebook of ideas, projects and the wiki they feed. It's live at **https://srvstav.github.io/change/**.

The vault itself lives in a private repo. This repo holds only the builder and its output:

- `build.mjs` reads the vault and writes the site into `docs/`. It renders the Markdown and Jupyter notebooks, resolves `[[wikilinks]]`, and builds backlinks, search and a front page. The page set is exactly what the vault's git repo tracks, so the site can't show a file the repo doesn't hold.
- `site/` holds the stylesheet and the small script for search and the light/dark switch.
- `docs/` is what GitHub Pages serves.

## Update the site

```sh
npm install
npm run build      # VAULT=~/Documents/change by default
npm run release    # build, commit, push; Pages redeploys in about a minute
```

Commit the vault first. The builder only reads tracked files.
