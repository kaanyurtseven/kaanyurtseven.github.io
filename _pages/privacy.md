---
# Front-matter shell with a Markdown body: the body is the page copy
# (_includes/pages/privacy.html prints it as {{ content }}). Sources of its statements:
# - Browser storage (assets/*.js, assets/engine/ and assets/js/*.js): only localStorage
#   'ky-theme' = light | dark, written by assets/site.js when the theme control is used,
#   deleted for the system choice, read before first paint by the inline script of
#   _includes/head.html (and by shell.js and site.js). Home's Pause button (the animation
#   engine, uncertainty-field.js MOTION_KEY) writes 'ky-motion' = paused and deletes it on
#   play. No cookies, no sessionStorage, no IndexedDB. The vendored Plotly bundle reads the
#   'debug' and '*Deprecation' keys of its bundled debug and util-deprecate modules and
#   stores nothing.
# - Same-origin files only: fonts (assets/fonts/), Plotly and Leaflet (assets/vendor/), the
#   explorer data (forecast.js fetches /assets/data/<tech>.json, built from Elia Open Data by
#   the scheduled pipeline, scripts/) and the map basemap (assets/data/basemap/).
# - GitHub Docs, "What is GitHub Pages?"
#   (https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages):
#   "When a GitHub Pages site is visited, the visitor's IP address is logged and stored for
#   security purposes, regardless of whether the visitor has signed into GitHub or not."
#   It refers to the GitHub General Privacy Statement linked below.
# - Response headers of https://kaanyurtseven.com/ (GitHub Pages): no Set-Cookie.
layout: page
page_id: privacy
title: Privacy
permalink: /privacy/
lead: "This site sets no cookies, has no analytics and loads nothing from third-party servers."
description: >
  This site sets no cookies, has no analytics or tracking, makes no requests to third-party
  servers and is hosted on GitHub Pages.
---

This is a static website. It has no accounts, comments or contact forms.

## Cookies and analytics

The site sets no cookies, and I use no analytics, advertising or other tracking. I do not
record who visits or which pages they read.

## Files the pages load

Every file a page needs comes from this site, including the fonts, the scripts, the charting and map
libraries, the background of the [map]({{ '/about/' | relative_url }}#research-footprint) and
the data of the [{{ site.data.explorer.name }}]({{ site.data.explorer.url | relative_url }}). Your
browser fetches nothing from any other server. The explorer's data are built from Elia's
open data by a scheduled job and published here, so your browser never contacts Elia.

## Hosting

The site is hosted on GitHub Pages. To deliver and protect it, GitHub processes technical
data about each request, including your IP address. GitHub states that it logs and stores
the IP address of every visitor to a GitHub Pages site for security purposes. The
[GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
describes how GitHub handles these data.

## Stored in your browser

If you choose a light or dark theme, your choice is kept in your browser's local storage
under `ky-theme`, so the next page opens in the same theme. Choosing the system setting
deletes it. It stays on your device and is never sent anywhere. If you pause the animation on
the home page, that choice is kept the same way under `ky-motion`, and playing it again deletes it.
Nothing else is stored.

## Links to other sites

Links to papers, code and profiles lead to other sites, such as publishers, GitHub, ORCID,
Google Scholar and LinkedIn. They have their own privacy policies.

## Contact

For questions about this page, write to [{{ site.data.profile.email }}](mailto:{{ site.data.profile.email }}).
