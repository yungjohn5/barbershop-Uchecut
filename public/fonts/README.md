# Fonts

Self-hosted copies of Google Fonts, latin and latin-ext subsets (WOFF2). The `@font-face`
rules live at the top of `src/styles/input.css`.

| Family | Files | License |
| --- | --- | --- |
| Inter (variable, 400–900) | `inter-latin.woff2`, `inter-latin-ext.woff2` | SIL Open Font License 1.1 |
| Gloock | `gloock-latin.woff2`, `gloock-latin-ext.woff2` | SIL Open Font License 1.1 |
| DM Serif Display (regular + italic) | `dm-serif-display-*.woff2` | SIL Open Font License 1.1 |

Self-hosting removes a render-blocking third-party stylesheet and keeps the CSP to `'self'`.
The OFL allows bundling these files with the site.

`inter-naira.woff2` and `gloock-naira.woff2` hold only ₦ (U+20A6), cut from the latin-ext files with
fontTools (`pyftsubset <file> --unicodes=U+20A6 --flavor=woff2`). Prices then load ~2 KB instead of
the 85 KB latin-ext file, which still loads for accented letters (e.g. Yoruba ẹ, ọ, ṣ).
