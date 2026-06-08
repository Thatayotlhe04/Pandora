# Pandora Landing Page

Static landing page for Pandora. It can be deployed from `site/` by the GitHub
Pages workflow after the repository's Pages source is enabled for GitHub Actions.

Preview locally:

```bash
python3 -m http.server 4173 --directory site
```

Open `http://localhost:4173`.

Deploy:

1. In GitHub repo settings, enable Pages with source "GitHub Actions".
2. Run `.github/workflows/pages.yml` from the Actions tab.
